/* NanoHive ABS - hobesman fork: read-along reader v0.1 */

// A full-screen reader for EPUB 3 "readaloud" books (Media Overlays, as made by
// Storyteller): plays the book's own audio and highlights each sentence as it
// is read, turning pages to follow. Progress goes to Audiobookshelf, not
// Storyteller: the ebook position (ebookLocation/ebookProgress), the audiobook
// position (currentTime, mapped onto the ABS audiobook's timeline) and a real
// ABS listening session, so stats and "continue listening" stay right.
//
// Rendering is foliate-js (./foliate/, MIT, unmodified). The EPUB is read from
// ABS with HTTP range requests, so a multi-hundred-MB readaloud is never
// downloaded whole: only the zip index, the chapters being read and the audio
// files being played.
//
// Loaded on demand by theme/custom.js: import('/_nh/reader/readalong.js').

import './foliate/view.js'
import { EPUB } from './foliate/epub.js'
import { configure, ZipReader, TextWriter, BlobWriter } from './foliate/vendor/zip.js'

configure({ useWebWorkers: false })

// ---------------------------------------------------------------------------
// ABS access
// ---------------------------------------------------------------------------
const token = () => (window.__nhFork && window.__nhFork.token()) || ''
const authHeaders = (json) => {
  const h = {}
  const t = token()
  if (t) h.Authorization = 'Bearer ' + t
  if (json) h['Content-Type'] = 'application/json'
  return h
}
async function api(path, { method = 'GET', body, keepalive } = {}) {
  const r = await fetch(path, {
    method, keepalive, credentials: 'include',
    headers: authHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw Object.assign(new Error(method + ' ' + path + ' -> ' + r.status), { status: r.status })
  const text = await r.text()
  try { return text ? JSON.parse(text) : null } catch (e) { return text }
}

// ---------------------------------------------------------------------------
// Zip over HTTP range requests (zip.js custom reader: size + readUint8Array)
// ---------------------------------------------------------------------------
const BLOCK = 1 << 18 // 256 KiB read-ahead blocks for the small reads (zip index, XHTML, SMIL)
const MAX_BLOCKS = 64 // ~16 MiB block cache

class RangeReader {
  constructor(url) {
    this.url = url
    this.size = 0
    this.initialized = false
    this.blocks = new Map()
    this.chunkSize = 2 << 20 // 2 MiB per request when streaming an entry
  }
  async init() {
    const r = await fetch(this.url, { headers: { ...authHeaders(), Range: 'bytes=0-0' }, credentials: 'include' })
    if (r.status === 206) {
      const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '')
      await r.arrayBuffer()
      if (!m) throw new Error('No Content-Range from server')
      this.size = Number(m[1])
    } else if (r.ok) {
      // Server ignored Range: fall back to the whole file in memory.
      this.blob = await r.blob()
      this.size = this.blob.size
    } else {
      throw Object.assign(new Error('Could not open the book (' + r.status + ')'), { status: r.status })
    }
    this.initialized = true
  }
  async #range(start, end) { // inclusive end
    const r = await fetch(this.url, { headers: { ...authHeaders(), Range: `bytes=${start}-${end}` }, credentials: 'include' })
    if (r.status !== 206 && !(r.ok && start === 0 && end >= this.size - 1)) throw new Error('Range request failed (' + r.status + ')')
    return new Uint8Array(await r.arrayBuffer())
  }
  // zip.js reads entry data through this stream (its Reader base class is not
  // exported by the bundled build, so this mirrors it). zip.js sets offset and
  // size on the returned object before reading.
  get readable() {
    const reader = this
    const chunkSize = this.chunkSize
    const readable = new ReadableStream({
      start() { this.chunkOffset = 0 },
      async pull(controller) {
        const { offset = 0, size } = readable
        const { chunkOffset } = this
        if (chunkOffset >= size) { controller.close(); return }
        controller.enqueue(await reader.readUint8Array(offset + chunkOffset, Math.min(chunkSize, size - chunkOffset)))
        if (chunkOffset + chunkSize >= size) controller.close()
        else this.chunkOffset += chunkSize
      },
    })
    return readable
  }
  async readUint8Array(index, length) {
    if (length <= 0) return new Uint8Array(0)
    if (this.blob) return new Uint8Array(await this.blob.slice(index, index + length).arrayBuffer())
    // Big reads (audio) go straight to the server, uncached.
    if (length > BLOCK) return this.#range(index, index + length - 1)
    const first = Math.floor(index / BLOCK)
    const last = Math.floor((index + length - 1) / BLOCK)
    const missing = []
    for (let b = first; b <= last; b++) if (!this.blocks.has(b)) missing.push(b)
    if (missing.length) {
      const lo = missing[0] * BLOCK
      const hi = Math.min(this.size, (missing[missing.length - 1] + 1) * BLOCK) - 1
      const data = await this.#range(lo, hi)
      for (let b = missing[0]; b <= missing[missing.length - 1]; b++) {
        const s = b * BLOCK - lo
        this.blocks.set(b, data.subarray(s, Math.min(data.length, s + BLOCK)))
      }
      while (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value)
    }
    const out = new Uint8Array(length)
    let pos = 0
    for (let b = first; b <= last; b++) {
      const block = this.blocks.get(b)
      this.blocks.delete(b); this.blocks.set(b, block) // LRU touch
      const from = b === first ? index - b * BLOCK : 0
      const to = Math.min(block.length, index + length - b * BLOCK)
      out.set(block.subarray(from, to), pos)
      pos += to - from
    }
    return out
  }
}

async function makeLoader(url) {
  const zip = new ZipReader(new RangeReader(url))
  const entries = await zip.getEntries()
  const map = new Map(entries.map((e) => [e.filename, e]))
  const load = (f) => (name, ...args) => (map.has(name) ? f(map.get(name), ...args) : null)
  return {
    entries,
    loadText: load((e) => e.getData(new TextWriter())),
    loadBlob: load((e, type) => e.getData(new BlobWriter(type))),
    getSize: (name) => map.get(name)?.uncompressedSize ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Media overlays -> one flat, ordered list of sentence clips
// ---------------------------------------------------------------------------
function parseClock(v) {
  if (!v) return 0
  v = String(v).trim()
  const m = /^(\d+(?:\.\d+)?)\s*(h|min|s|ms)?$/.exec(v)
  if (m) {
    const n = Number(m[1])
    return m[2] === 'h' ? n * 3600 : m[2] === 'min' ? n * 60 : m[2] === 'ms' ? n / 1000 : n
  }
  return v.split(':').map(Number).reduce((a, p) => a * 60 + (isNaN(p) ? 0 : p), 0)
}
// Resolve an href against the zip path of the file it appears in, keeping any #fragment.
const resolvePath = (rel, base) => {
  try {
    const u = new URL(rel, 'https://x/' + base)
    return decodeURIComponent(u.pathname.slice(1)) + (u.hash ? decodeURIComponent(u.hash) : '')
  } catch (e) { return rel }
}

async function loadTimeline(book, loader) {
  const files = [] // { src, est (last clipEnd), dur (real, once loaded) }
  const fileIdx = new Map()
  const perSection = await mapLimit(book.sections, 6, async (section, si) => {
    const mo = section.mediaOverlay
    if (!mo) return []
    const xml = await loader.loadText(mo.href)
    if (!xml) return []
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const out = []
    for (const par of doc.getElementsByTagNameNS('*', 'par')) {
      const t = par.getElementsByTagNameNS('*', 'text')[0]
      const a = par.getElementsByTagNameNS('*', 'audio')[0]
      if (!t || !a || !t.getAttribute('src') || !a.getAttribute('src')) continue
      const [href, id] = resolvePath(t.getAttribute('src'), mo.href).split('#')
      out.push({ si, href, id: id || '', src: resolvePath(a.getAttribute('src'), mo.href),
        begin: parseClock(a.getAttribute('clipBegin')), end: parseClock(a.getAttribute('clipEnd')) })
    }
    return out
  })
  const clips = []
  for (const list of perSection) for (const c of list) {
    if (!fileIdx.has(c.src)) { fileIdx.set(c.src, files.length); files.push({ src: c.src, est: 0, dur: null }) }
    c.file = fileIdx.get(c.src)
    c.i = clips.length
    if (!c.end || c.end < c.begin) c.end = c.begin
    files[c.file].est = Math.max(files[c.file].est, c.end)
    clips.push(c)
  }
  return { clips, files }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i], i) }
  }))
  return out
}

// Global EPUB-audio timeline: each audio file starts where the previous one
// ended. Real durations are learned as files load (and remembered per book);
// until then a file "lasts" until its last sentence, plus an even share of
// whatever the book's declared total (media:duration) says is unaccounted for.
class Timeline {
  constructor(files, declaredTotal, storeKey) {
    this.files = files
    this.declared = declaredTotal || 0
    this.storeKey = storeKey
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) || 'null')
      if (saved && saved.length === files.length) saved.forEach((d, i) => { if (d > 0) files[i].dur = d })
    } catch (e) {}
    this.recompute()
  }
  setDuration(i, d) {
    if (!(d > 0) || !isFinite(d) || Math.abs((this.files[i].dur || 0) - d) < 0.01) return
    this.files[i].dur = d
    try { localStorage.setItem(this.storeKey, JSON.stringify(this.files.map((f) => f.dur || 0))) } catch (e) {}
    this.recompute()
  }
  recompute() {
    const known = this.files.filter((f) => f.dur)
    const unknown = this.files.filter((f) => !f.dur)
    const knownSum = known.reduce((a, f) => a + f.dur, 0)
    const estSum = unknown.reduce((a, f) => a + f.est, 0)
    const slack = this.declared && unknown.length ? Math.max(0, (this.declared - knownSum - estSum) / unknown.length) : 0
    let t = 0
    this.offsets = this.files.map((f) => { const o = t; t += f.dur || f.est + slack; return o })
    this.total = t
  }
  durOf(i) { return (i + 1 < this.offsets.length ? this.offsets[i + 1] : this.total) - this.offsets[i] }
}

// ---------------------------------------------------------------------------
// Audio player: one <audio> element for the whole book (lock-screen controls
// and background play work best with a single element).
// ---------------------------------------------------------------------------
class Player extends EventTarget {
  constructor(loader, timeline, clips) {
    super()
    this.loader = loader
    this.tl = timeline
    this.clips = clips
    this.audio = new Audio()
    this.audio.preload = 'auto'
    this.fileIndex = -1
    this.clipIndex = -1
    this.parked = null // global EPUB time to start from on the next play (reading without audio)
    this.urls = new Map() // file index -> object URL (current + prefetched)
    this.rate = 1
    this.byFile = new Map()
    for (const c of clips) {
      if (!this.byFile.has(c.file)) this.byFile.set(c.file, [])
      this.byFile.get(c.file).push(c)
    }
    this.audio.addEventListener('timeupdate', () => this.#onTime())
    this.audio.addEventListener('ended', () => this.#onEnded())
    this.audio.addEventListener('play', () => this.#emit('state'))
    this.audio.addEventListener('pause', () => this.#emit('state'))
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.fileIndex >= 0) this.tl.setDuration(this.fileIndex, this.audio.duration)
    })
  }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })) }
  get playing() { return !this.audio.paused }
  get clip() { return this.clips[this.clipIndex] || null }
  globalTime() {
    if (this.parked != null) return this.parked
    if (this.fileIndex < 0) return this.clip ? this.clipStart(this.clip) : 0
    return this.tl.offsets[this.fileIndex] + (this.audio.currentTime || 0)
  }
  clipStart(c) { return this.tl.offsets[c.file] + c.begin }
  clipAtGlobal(T) {
    let lo = 0, hi = this.clips.length - 1, best = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.clipStart(this.clips[mid]) <= T + 0.01) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    return this.clips[best]
  }
  async #url(i) {
    if (this.urls.has(i)) return this.urls.get(i)
    const p = (async () => {
      const f = this.tl.files[i]
      const blob = await this.loader.loadBlob(f.src, mimeOf(f.src))
      if (!blob) throw new Error('Missing audio ' + f.src)
      return URL.createObjectURL(blob)
    })()
    this.urls.set(i, p)
    p.catch(() => this.urls.delete(i))
    return p
  }
  #trimCache() {
    for (const [i, p] of this.urls) {
      if (i !== this.fileIndex && i !== this.fileIndex + 1) {
        this.urls.delete(i)
        p.then((u) => URL.revokeObjectURL(u)).catch(() => {})
      }
    }
  }
  #loadingFile = false
  async #load(i) {
    if (this.fileIndex === i && this.audio.src) return
    this.#loadingFile = true
    this.#emit('loading', true)
    try {
      const url = await this.#url(i)
      this.fileIndex = i
      this.audio.src = url
      this.audio.playbackRate = this.rate
      await new Promise((res, rej) => {
        const ok = () => { cleanup(); res() }
        const bad = () => { cleanup(); rej(new Error('Audio failed to load')) }
        const cleanup = () => { this.audio.removeEventListener('loadedmetadata', ok); this.audio.removeEventListener('error', bad) }
        this.audio.addEventListener('loadedmetadata', ok)
        this.audio.addEventListener('error', bad)
      })
      this.#trimCache()
    } finally {
      this.#loadingFile = false
      this.#emit('loading', false)
    }
  }
  // Seek to a clip (or a time inside a file) and optionally play.
  async seekClip(ci, play = this.playing) {
    const c = this.clips[ci]
    if (!c) return
    await this.seekFile(c.file, c.begin, play, ci)
  }
  async seekFile(fi, t, play = this.playing, ci) {
    const wasPlaying = play
    this.parked = null
    await this.#load(fi)
    this.audio.currentTime = Math.max(0, t)
    this.audio.playbackRate = this.rate
    this.#setClip(ci != null ? ci : this.#clipAt(fi, t))
    if (wasPlaying) await this.audio.play().catch((e) => this.#emit('error', e))
  }
  async seekGlobal(T, play = this.playing) {
    const offs = this.tl.offsets
    let fi = 0
    while (fi + 1 < offs.length && offs[fi + 1] <= T) fi++
    await this.seekFile(fi, Math.min(T - offs[fi], this.tl.durOf(fi)), play)
  }
  // Move the position without loading audio (reading silently): the next
  // play starts there.
  park(T) {
    if (this.playing) return
    this.parked = Math.max(0, T)
    this.#setClip(this.clipAtGlobal(this.parked).i)
    this.#emit('time')
  }
  async play() {
    if (this.parked != null || this.fileIndex < 0 || !this.audio.src) {
      const T = this.parked != null ? this.parked : this.clip ? this.clipStart(this.clip) : 0
      return this.seekGlobal(T, true)
    }
    await this.audio.play().catch((e) => this.#emit('error', e))
  }
  pause() { this.audio.pause() }
  get loadingFile() { return this.#loadingFile }
  setRate(r) { this.rate = r; this.audio.playbackRate = r }
  prev() {
    const c = this.clip
    if (!c) return
    // Within the first second of a sentence go to the previous one, else restart this one.
    const into = this.fileIndex === c.file ? this.audio.currentTime - c.begin : 0
    this.seekClip(into > 1 || c.i === 0 ? c.i : c.i - 1)
  }
  next() { const c = this.clip; if (c && c.i + 1 < this.clips.length) this.seekClip(c.i + 1) }
  #clipAt(fi, t) {
    const list = this.byFile.get(fi) || []
    let best = list[0]
    for (const c of list) { if (c.begin <= t + 0.01) best = c; else break }
    return best ? best.i : this.clipIndex
  }
  #setClip(ci) {
    if (ci === this.clipIndex) return
    this.clipIndex = ci
    this.#emit('clip', this.clips[ci])
  }
  #onTime() {
    if (this.fileIndex < 0) return
    const t = this.audio.currentTime
    const ci = this.#clipAt(this.fileIndex, t)
    if (ci !== this.clipIndex) this.#setClip(ci)
    // Fetch the next audio file during the last 45 s of this one.
    const d = this.audio.duration
    if (d && d - t < 45 && this.fileIndex + 1 < this.tl.files.length) this.#url(this.fileIndex + 1).catch(() => {})
    this.#emit('time')
  }
  async #onEnded() {
    if (this.fileIndex + 1 < this.tl.files.length) {
      await this.seekFile(this.fileIndex + 1, 0, true).catch((e) => this.#emit('error', e))
    } else {
      this.#emit('finished')
    }
  }
  destroy() {
    this.audio.pause()
    this.audio.removeAttribute('src')
    for (const p of this.urls.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {})
    this.urls.clear()
  }
}
const mimeOf = (p) => {
  const ext = (p.split('.').pop() || '').toLowerCase()
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm' }[ext] || 'audio/mpeg'
}

// ---------------------------------------------------------------------------
// ABS progress + listening session
// ---------------------------------------------------------------------------
class AbsSync {
  constructor({ itemId, absDuration, writeCfi }) {
    this.itemId = itemId
    this.duration = absDuration
    this.writeCfi = writeCfi // only when the readaloud is the item's primary ebook
    this.session = null
    this.sessionStarting = null
    this.listened = 0 // seconds actually listened since the last session sync
    this.lastTick = 0
    this.pendingEbook = null
    this.ebookTimer = null
    this.lastSyncAt = 0
  }
  async progress() {
    try { return await api('/api/me/progress/' + this.itemId) } catch (e) { return null }
  }
  // Wall-clock listening time, as ABS's own players count it.
  tick(playing) {
    const now = performance.now()
    if (playing && this.lastTick) this.listened += Math.min(5, (now - this.lastTick) / 1000)
    this.lastTick = playing ? now : 0
  }
  async ensureSession() {
    if (this.session) return this.session
    if (!this.sessionStarting) {
      this.sessionStarting = api('/api/items/' + this.itemId + '/play', {
        method: 'POST',
        body: {
          deviceInfo: { clientName: 'NanoHive Read-Along', clientVersion: '0.1', deviceId: deviceId() },
          forceDirectPlay: true, forceTranscode: false, mediaPlayer: 'nh-readalong',
          supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm'],
        },
      }).then((s) => { this.session = s && s.id ? s.id : null; return this.session })
        .catch(() => null)
        .finally(() => { this.sessionStarting = null })
    }
    return this.sessionStarting
  }
  async syncListening(absTime, { force, keepalive } = {}) {
    if (!this.session) return
    const now = Date.now()
    if (!force && now - this.lastSyncAt < 15000) return
    this.lastSyncAt = now
    const timeListened = Math.round(this.listened * 10) / 10
    this.listened = 0
    try {
      await api('/api/session/' + this.session + '/sync', { method: 'POST', keepalive, body: { currentTime: absTime, timeListened, duration: this.duration } })
    } catch (e) {
      this.listened += timeListened
      if (e.status === 404) this.session = null // session closed server side; a new one starts on next play
    }
  }
  async closeSession(absTime, keepalive) {
    if (!this.session) return
    const id = this.session
    this.session = null
    const timeListened = Math.round(this.listened * 10) / 10
    this.listened = 0
    try { await api('/api/session/' + id + '/close', { method: 'POST', keepalive, body: { currentTime: absTime, timeListened, duration: this.duration } }) } catch (e) {}
  }
  // Reading position. Also moves the audiobook position to the same sentence,
  // so the ABS apps resume listening where reading stopped (not while a
  // session is open: the session sync owns currentTime then).
  saveReading({ cfi, fraction, absTime, paused }, immediate) {
    this.pendingEbook = { cfi, fraction, absTime, paused }
    clearTimeout(this.ebookTimer)
    const run = () => this.flushReading()
    if (immediate) return run()
    this.ebookTimer = setTimeout(run, 2500)
  }
  async flushReading(keepalive) {
    clearTimeout(this.ebookTimer)
    const p = this.pendingEbook
    if (!p) return
    this.pendingEbook = null
    const body = { ebookProgress: clamp01(p.fraction) }
    if (this.writeCfi && p.cfi) body.ebookLocation = p.cfi
    if (!this.session && p.absTime != null) {
      body.currentTime = p.absTime
      body.duration = this.duration
      body.progress = this.duration ? clamp01(p.absTime / this.duration) : 0
    }
    const jobs = [api('/api/me/progress/' + this.itemId, { method: 'PATCH', keepalive, body }).catch(() => {})]
    // Paused with a session open: the session owns currentTime, so move it there.
    if (this.session && p.paused && p.absTime != null && !keepalive) jobs.push(this.syncListening(p.absTime, { force: true }))
    await Promise.all(jobs)
    return body
  }
}
// Section (spine) index of a foliate 'relocate' location.
const secIdx = (loc) => (loc ? (loc.index != null ? loc.index : loc.section ? loc.section.current : -1) : -1)
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
function deviceId() {
  try {
    let id = localStorage.getItem('nh-ra-device')
    if (!id) { id = 'nh-ra-' + Math.random().toString(36).slice(2, 12); localStorage.setItem('nh-ra-device', id) }
    return id
  } catch (e) { return 'nh-ra-browser' }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const THEMES = {
  dark: { bg: '#14110d', fg: '#e8e0d4', link: '#e0c27a', hl: 'rgba(224,194,122,0.32)' },
  sepia: { bg: '#f4ecd8', fg: '#433422', link: '#8a5a1c', hl: 'rgba(214,160,60,0.35)' },
  light: { bg: '#ffffff', fg: '#1b1b1b', link: '#7a4f12', hl: 'rgba(240,190,60,0.40)' },
}
const RATES = [0.75, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2, 2.5, 3] // presets in the speed picker
const RATE_MIN = 0.5, RATE_MAX = 3, RATE_STEP = 0.05
const clampRate = (r) => Number((Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, Number(r) || 1)) / RATE_STEP) * RATE_STEP).toFixed(2))
const fmtRate = (r) => (Math.round(r * 100) / 100).toString() + '×'
const prefs = (() => {
  let p = {}
  try { p = JSON.parse(localStorage.getItem('nh-ra-prefs') || '{}') } catch (e) {}
  return {
    theme: THEMES[p.theme] ? p.theme : 'dark',
    size: p.size > 0 ? p.size : 1,
    rate: p.rate >= RATE_MIN && p.rate <= RATE_MAX ? clampRate(p.rate) : 1,
    save() { try { localStorage.setItem('nh-ra-prefs', JSON.stringify({ theme: this.theme, size: this.size, rate: this.rate })) } catch (e) {} },
  }
})()

const ICONS = {
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  toc: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  aa: '<path d="M3 19 8.5 5h1L15 19M5 14h7"/><path d="M15.5 19l3-7.5h.5l3 7.5M16.6 16.5h4.3"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M6 6v12"/><path d="M18 6.5v11L9 12z" fill="currentColor"/>',
  next: '<path d="M18 6v12"/><path d="M6 6.5v11l9-5.5z" fill="currentColor"/>',
  left: '<path d="M15 5 8 12l7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
}
const svg = (name, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0')
}

const CSS = `
#nh-ra { position: fixed; inset: 0; z-index: 3000; display: flex; flex-direction: column; background: var(--ra-bg); color: var(--ra-fg); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
#nh-ra button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
#nh-ra .ra-head { display: flex; align-items: center; gap: 6px; height: 54px; padding: 0 10px; flex-shrink: 0; }
#nh-ra .ra-ib { width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; opacity: .8; }
#nh-ra .ra-ib:hover { opacity: 1; background: color-mix(in srgb, var(--ra-fg) 9%, transparent); }
#nh-ra .ra-title { flex: 1; min-width: 0; text-align: center; line-height: 1.2; }
#nh-ra .ra-title b { display: block; font-weight: 600; font-size: .95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#nh-ra .ra-title span { display: block; font-size: .78rem; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#nh-ra .ra-main { position: relative; flex: 1; min-height: 0; }
#nh-ra foliate-view { position: absolute; inset: 0; }
#nh-ra .ra-turn { position: absolute; top: 0; bottom: 0; width: 56px; z-index: 2; display: flex; align-items: center; justify-content: center; opacity: .0; transition: opacity .15s; }
#nh-ra .ra-turn:hover { opacity: .7; }
#nh-ra .ra-turn.l { left: 0; } #nh-ra .ra-turn.r { right: 0; }
#nh-ra .ra-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; opacity: .8; z-index: 3; }
#nh-ra .ra-foot { flex-shrink: 0; padding: 6px 16px calc(12px + env(safe-area-inset-bottom)); }
#nh-ra .ra-seek { display: flex; align-items: center; gap: 10px; font-size: .78rem; font-variant-numeric: tabular-nums; opacity: .85; }
#nh-ra .ra-seek input { flex: 1; accent-color: var(--ra-link); }
#nh-ra .ra-ctl { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 4px; }
#nh-ra .ra-play { width: 56px; height: 56px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--ra-link) !important; color: var(--ra-bg) !important; }
#nh-ra .ra-play.busy { opacity: .6; }
#nh-ra .ra-rate { min-width: 56px; height: 34px; border-radius: 17px; border: 1px solid color-mix(in srgb, var(--ra-fg) 25%, transparent) !important; font-size: .85rem; font-variant-numeric: tabular-nums; }
#nh-ra .ra-chap { min-width: 56px; font-size: .78rem; opacity: .65; text-align: center; white-space: nowrap; }
#nh-ra .ra-panel { position: absolute; top: 54px; bottom: 0; width: min(360px, 92vw); z-index: 5; background: var(--ra-bg); border: 1px solid color-mix(in srgb, var(--ra-fg) 14%, transparent); box-shadow: 0 10px 40px rgba(0,0,0,.35); overflow-y: auto; padding: 10px 0; }
#nh-ra .ra-panel.left { left: 0; } #nh-ra .ra-panel.right { right: 8px; top: 58px; bottom: auto; padding: 12px 16px 0; border-radius: 12px; }
#nh-ra .ra-toc button { display: block; width: 100%; text-align: left; padding: 9px 18px; font-size: .92rem; }
#nh-ra .ra-toc button:hover, #nh-ra .ra-toc button.cur { background: color-mix(in srgb, var(--ra-fg) 9%, transparent); }
#nh-ra .ra-toc button.cur { color: var(--ra-link); }
#nh-ra .ra-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 10px 0 18px; }
#nh-ra .ra-row > span { font-size: .85rem; opacity: .7; }
#nh-ra .ra-seg { display: flex; gap: 6px; }
#nh-ra .ra-seg button { padding: 7px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--ra-fg) 22%, transparent) !important; font-size: .85rem; }
#nh-ra .ra-seg button.on { border-color: var(--ra-link) !important; color: var(--ra-link); }
#nh-ra .ra-err { color: #d9776a; }
#nh-ra .ra-panel.ra-speed { top: auto; bottom: 10px; left: 50%; right: auto; transform: translateX(-50%); width: min(340px, 92vw); padding: 14px 16px 16px; border-radius: 14px; overflow: visible; }
#nh-ra .ra-speed-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
#nh-ra .ra-speed-head span { font-size: .85rem; opacity: .7; }
#nh-ra .ra-speed-head b { font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; }
#nh-ra .ra-presets { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
#nh-ra .ra-presets button { height: 34px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--ra-fg) 22%, transparent) !important; font-size: .85rem; font-variant-numeric: tabular-nums; }
#nh-ra .ra-presets button:hover { border-color: color-mix(in srgb, var(--ra-fg) 50%, transparent) !important; }
#nh-ra .ra-presets button.on { border-color: var(--ra-link) !important; color: var(--ra-link); font-weight: 600; }
#nh-ra .ra-fine { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
#nh-ra .ra-fine input { flex: 1; accent-color: var(--ra-link); }
#nh-ra .ra-fine button { width: 34px; height: 34px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--ra-fg) 22%, transparent) !important; font-size: 1.1rem; line-height: 1; }
@media (max-width: 640px) { #nh-ra .ra-turn { display: none; } #nh-ra .ra-ctl { gap: 8px; } }
`

let current = null

export async function open(opts) {
  if (current) return
  const ui = new ReaderUI(opts)
  current = ui
  try { await ui.start() } catch (e) { ui.fail(e) }
}

// Stop whatever else is playing in this window before the reader starts, so
// two books (or the same book twice) never play at once. ABS's own player is
// closed properly (its closePlayer syncs the position and ends its session),
// so the reader then resumes from where it stopped. Returns true if anything
// was stopped.
function stopOtherPlayback() {
  let stopped = false
  try {
    const find = (vm, depth) => {
      if (!vm || depth > 60) return null
      if (vm.playerHandler && typeof vm.closePlayer === 'function') return vm
      for (const c of vm.$children || []) { const hit = find(c, depth + 1); if (hit) return hit }
      return null
    }
    const absPlayer = window.$nuxt && find(window.$nuxt.$root, 0)
    if (absPlayer && absPlayer.playerHandler.libraryItem) { absPlayer.closePlayer(); stopped = true }
  } catch (e) { console.warn('[nh-readalong] could not close the ABS player', e) }
  if (!stopped) { try { window.$nuxt.$eventBus.$emit('pause-item') } catch (e) {} }
  // Anything else still playing in the page (another tab of ABS is not ours to stop).
  document.querySelectorAll('audio, video').forEach((m) => {
    if (!m.paused && !(current && current.player && m === current.player.audio)) { try { m.pause(); stopped = true } catch (e) {} }
  })
  return stopped
}

class ReaderUI {
  constructor({ itemId, ino, title, author, primary, coverUrl }) {
    this.itemId = itemId
    this.ino = ino
    this.title = title || ''
    this.author = author || ''
    this.primary = !!primary
    this.coverUrl = coverUrl
    this.followPausedUntil = 0 // following the audio is paused (ms timestamp) after a manual page turn
    this.lastRelocate = null
    this.onKey = (e) => this.#key(e)
    this.onHide = () => this.#flush(true)
  }

  // ---- shell ----
  #mount() {
    if (!document.getElementById('nh-ra-css')) {
      const s = document.createElement('style')
      s.id = 'nh-ra-css'
      s.textContent = CSS
      document.head.appendChild(s)
    }
    const el = document.createElement('div')
    el.id = 'nh-ra'
    el.innerHTML = `
      <div class="ra-head">
        <button class="ra-ib" data-a="close" title="Close (Esc)">${svg('close')}</button>
        <button class="ra-ib" data-a="toc" title="Contents">${svg('toc')}</button>
        <div class="ra-title"><b>${esc(this.title)}</b><span class="ra-sub">${esc(this.author)}</span></div>
        <button class="ra-ib" data-a="aa" title="Text settings">${svg('aa')}</button>
        <span style="width:40px"></span>
      </div>
      <div class="ra-main">
        <button class="ra-turn l" data-a="left" title="Previous page">${svg('left', 28)}</button>
        <button class="ra-turn r" data-a="right" title="Next page">${svg('right', 28)}</button>
        <div class="ra-msg">Opening the book…</div>
      </div>
      <div class="ra-foot">
        <div class="ra-seek"><span class="ra-t0">0:00</span><input type="range" min="0" max="1000" value="0" aria-label="Position"><span class="ra-t1">0:00</span></div>
        <div class="ra-ctl">
          <span class="ra-chap"></span>
          <button class="ra-ib" data-a="prev" title="Previous sentence">${svg('prev')}</button>
          <button class="ra-play" data-a="play" title="Play (Space)">${svg('play', 26)}</button>
          <button class="ra-ib" data-a="next" title="Next sentence">${svg('next')}</button>
          <button class="ra-rate" data-a="rate" title="Speed">1×</button>
        </div>
      </div>`
    document.body.appendChild(el)
    this.el = el
    this.$ = (s) => el.querySelector(s)
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]')
      // A click outside an open panel (other than its own button) closes it.
      if (this.panel && !e.target.closest('.ra-panel') && !(b && ['toc', 'aa', 'rate'].includes(b.dataset.a))) this.#togglePanel(null)
      if (b && el.contains(b)) this.#action(b.dataset.a, b)
    })
    const seek = this.$('.ra-seek input')
    seek.addEventListener('input', () => { this.seeking = true; this.$('.ra-t0').textContent = fmt(seek.value / 1000 * this.absDuration) })
    seek.addEventListener('change', () => {
      this.seeking = false
      const T = (seek.value / 1000) * this.absDuration
      this.player.seekGlobal(this.toEpub(T)).catch((e) => this.#toast(e))
    })
    document.addEventListener('keydown', this.onKey)
    window.addEventListener('pagehide', this.onHide)
    document.documentElement.style.overflow = 'hidden'
    this.#applyTheme()
  }

  fail(e) {
    console.error('[nh-readalong]', e)
    const m = this.el && this.$('.ra-msg')
    if (m) { m.style.display = ''; m.innerHTML = `<div class="ra-err">${esc(e && e.message ? e.message : e)}</div>` }
  }
  #toast(e) { console.warn('[nh-readalong]', e) }

  async start() {
    this.#mount()
    // Give a closed ABS player a moment to send its final position first.
    if (stopOtherPlayback()) await new Promise((r) => setTimeout(r, 900))
    const [item, progress] = await Promise.all([
      api('/api/items/' + this.itemId + '?expanded=1'),
      api('/api/me/progress/' + this.itemId).catch(() => null),
    ])
    const md = (item.media && item.media.metadata) || {}
    this.title = this.title || md.title || ''
    this.author = this.author || md.authorName || (md.authors || []).map((a) => a.name).join(', ')
    this.$('.ra-title b').textContent = this.title
    this.$('.ra-sub').textContent = this.author
    this.absDuration = item.media.duration || 0
    const primaryIno = item.media.ebookFile && item.media.ebookFile.ino
    this.primary = primaryIno ? String(primaryIno) === String(this.ino) : this.primary

    const loader = await makeLoader('/api/items/' + this.itemId + '/file/' + this.ino)
    const book = await new EPUB(loader).init()
    this.book = book
    const { clips, files } = await loadTimeline(book, loader)
    if (!clips.length) throw new Error('This EPUB has no read-along audio (no media overlays found).')
    this.clips = clips
    this.clipById = new Map(clips.map((c) => [c.si + '#' + c.id, c]))
    this.tl = new Timeline(files, book.media && book.media.duration, 'nh-ra-dur:' + this.itemId + ':' + this.ino)
    if (!this.absDuration) this.absDuration = this.tl.total
    this.player = new Player(loader, this.tl, clips)
    this.player.setRate(prefs.rate)
    this.sync = new AbsSync({ itemId: this.itemId, absDuration: this.absDuration, writeCfi: this.primary })
    this.#wirePlayer()

    const view = document.createElement('foliate-view')
    this.view = view
    this.$('.ra-main').prepend(view)
    view.addEventListener('load', (e) => this.#onDocLoad(e.detail))
    view.addEventListener('relocate', (e) => this.#onRelocate(e.detail))
    await view.open(book)
    const r = view.renderer
    r.addEventListener('relocate', (e) => { this.lastReason = e.detail && e.detail.reason })
    r.setAttribute('flow', 'paginated')
    r.setAttribute('gap', '6%')
    r.setAttribute('margin', '40px')
    r.setAttribute('max-inline-size', '720px')
    r.setAttribute('max-column-count', '2')
    this.#applyTheme()

    await this.#resume(progress)
    this.#parkOnPage()
    this.$('.ra-msg').style.display = 'none'
    this.#media()
    this.#renderTime()
    this.ticker = setInterval(() => this.#tick(), 1000)
  }

  // ---- position mapping: EPUB audio timeline <-> ABS audiobook timeline ----
  toAbs(T) { return this.tl.total ? (T * this.absDuration) / this.tl.total : T }
  toEpub(t) { return this.absDuration ? (t * this.tl.total) / this.absDuration : t }

  // Where to open: whichever position moved last. Our own writes are
  // remembered locally, so a change made elsewhere (the ABS app's audio
  // position, or ABS's own ebook reader) is recognised as newer.
  async #resume(p) {
    const key = 'nh-ra-last:' + this.itemId
    let mine = null
    try { mine = JSON.parse(localStorage.getItem(key) || 'null') } catch (e) {}
    this.lastKey = key
    const absT = p && p.currentTime > 0 ? p.currentTime : null
    const loc = p && p.ebookLocation
    const frac = p && p.ebookProgress
    const audioMovedElsewhere = absT != null && (!mine || Math.abs(absT - (mine.t || 0)) > 3)
    const ebookMovedElsewhere = (this.primary && loc && (!mine || loc !== mine.cfi)) ||
      (!this.primary && frac != null && (!mine || Math.abs(frac - (mine.f || 0)) > 0.002))
    if (audioMovedElsewhere && (!ebookMovedElsewhere || !mine || (p.lastUpdate || 0) > (mine.at || 0))) {
      this.player.park(this.toEpub(absT))
      await this.#showClip(this.player.clip, true)
      return
    }
    if (ebookMovedElsewhere) {
      if (this.primary && loc) { try { await this.view.goTo(loc); return } catch (e) {} }
      if (frac != null) { await this.view.goToFraction(frac); return }
    }
    if (mine && mine.cfi) { try { await this.view.goTo(mine.cfi); return } catch (e) {} }
    if (absT != null) {
      this.player.park(this.toEpub(absT))
      await this.#showClip(this.player.clip, true)
      return
    }
    await this.view.goTo(this.clips[0].href).catch(() => this.view.renderer.next())
  }

  // ---- player <-> page ----
  #wirePlayer() {
    const p = this.player
    p.addEventListener('clip', (e) => {
      const c = e.detail
      this.#highlight(c)
      this.#follow()
      this.#renderChapter()
    })
    p.addEventListener('state', () => {
      this.$('.ra-play').innerHTML = svg(p.playing ? 'pause' : 'play', 26)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p.playing ? 'playing' : 'paused'
      this.sync.tick(p.playing)
      if (p.playing) this.sync.ensureSession()
      else if (!p.loadingFile && !p.audio.ended) { this.sync.syncListening(this.toAbs(p.globalTime()), { force: true }); this.#saveReading(true) }
    })
    p.addEventListener('loading', (e) => this.$('.ra-play').classList.toggle('busy', !!e.detail))
    p.addEventListener('time', () => { this.#renderTime(); this.#follow() })
    p.addEventListener('error', (e) => this.#toast(e.detail))
    p.addEventListener('finished', () => {
      this.sync.syncListening(this.absDuration, { force: true })
    })
  }
  // Navigate by section index + element id (not by href: foliate and the SMIL
  // can spell the same path differently).
  async #showClip(c, force) {
    if (!c) return
    if (!force && this.#isVisible(c)) return
    await this.#nav(() => this.view.renderer.goTo({ index: c.si, anchor: c.id ? (doc) => doc.getElementById(c.id) || 0 : 0 }))
  }
  async #nav(fn) {
    this.programmatic = true
    this.navBusy = true
    try { await fn() } finally { this.programmatic = false; this.navBusy = false }
  }
  // Keep the narrated text on screen while playing: go to a sentence that is
  // off the page, and turn the page part-way through a sentence that runs
  // onto the next one, once the audio reaches the part on the next page.
  #follow() {
    const p = this.player
    const c = p && p.clip
    if (!c || !this.view || this.navBusy || Date.now() < this.followPausedUntil) return
    if (!this.#isVisible(c)) {
      // Already turned past this sentence's first part: don't go back to it.
      if (this.turnedFor === c.i && p.playing) return
      // Paused, only follow an explicit move (previous/next sentence); a page
      // the reader turned to stays put.
      if (p.playing || this.followOnce || !this.lastRelocate) this.#showClip(c).catch(() => {})
      this.followOnce = false
      return
    }
    this.followOnce = false
    if (!p.playing || p.fileIndex !== c.file || !(c.end > c.begin)) return
    if (this.turnedFor === c.i) return
    const shown = this.#shownFraction(c)
    if (shown >= 1) return
    const heard = (p.audio.currentTime - c.begin) / (c.end - c.begin)
    if (heard >= shown) {
      this.turnedFor = c.i
      this.#nav(() => this.view.renderer.next()).catch(() => {})
    }
  }
  // Share of a sentence's text, from its start, that is on the current page
  // (1 when it ends on this page; 0 when it starts after it).
  #shownFraction(c) {
    const loc = this.lastRelocate
    const doc = this.#docFor(c.si)
    const el = doc && c.id && doc.getElementById(c.id)
    if (!el || !loc || !loc.range) return 1
    try {
      const all = doc.createRange()
      all.selectNodeContents(el)
      const vis = loc.range
      if (vis.compareBoundaryPoints(Range.END_TO_END, all) >= 0) return 1
      // START_TO_END compares the page's end with the sentence's start.
      if (vis.compareBoundaryPoints(Range.START_TO_END, all) <= 0) return 0
      const total = all.toString().length
      if (!total) return 1
      const part = all.cloneRange()
      part.setEnd(vis.endContainer, vis.endOffset)
      const shown = part.toString().length
      // foliate's visible range can stop a character or two short of the end
      // of the page; only a real run-on (a word or more) counts.
      if (total - shown <= 4) return 1
      return shown / total
    } catch (e) { return 1 }
  }
  #docFor(index) {
    const hit = (this.view.renderer.getContents() || []).find((x) => x.index === index)
    return hit && hit.doc
  }
  #isVisible(c) {
    const loc = this.lastRelocate
    if (!loc || !loc.range || secIdx(loc) !== c.si) return false
    const doc = this.#docFor(c.si)
    const el = doc && c.id && doc.getElementById(c.id)
    if (!el) return false
    try { return loc.range.intersectsNode(el) } catch (e) { return false }
  }
  #highlight(c) {
    if (this.hlEl) {
      this.hlEl.classList.remove('nh-ra-hl')
      if (this.activeClass) this.hlEl.classList.remove(this.activeClass)
    }
    this.hlEl = null
    if (!c || !c.id) return
    const doc = this.#docFor(c.si)
    const el = doc && doc.getElementById(c.id)
    if (!el) return
    el.classList.add('nh-ra-hl')
    this.activeClass = this.book.media && this.book.media.activeClass
    if (this.activeClass) el.classList.add(this.activeClass)
    this.hlEl = el
  }
  #onDocLoad({ doc, index }) {
    const st = doc.createElement('style')
    st.id = 'nh-ra-doc'
    st.textContent = this.#docCss()
    doc.head.appendChild(st)
    doc.addEventListener('keydown', this.onKey)
    // Tap a sentence to read from there (a tap that closes an open panel doesn't).
    doc.addEventListener('click', (e) => {
      if (this.panel) { this.#togglePanel(null); return }
      const sel = doc.getSelection && doc.getSelection()
      if (sel && !sel.isCollapsed) return
      if (e.target.closest && e.target.closest('a[href]')) return
      for (let n = e.target; n && n.nodeType === 1; n = n.parentElement) {
        if (!n.id) continue
        const c = this.clipById.get(index + '#' + n.id)
        if (c) { this.followPausedUntil = 0; this.player.seekClip(c.i, true).catch((er) => this.#toast(er)); return }
      }
    })
    const c = this.player && this.player.clip
    if (c && c.si === index) this.#highlight(c)
  }
  #onRelocate(loc) {
    this.lastRelocate = loc
    this.#renderChapter(loc)
    const programmatic = this.programmatic
    // The renderer's own relocate event (which carries the reason) is handled
    // after this one, so decide once it has been seen.
    setTimeout(() => {
      const byUser = !programmatic && ['page', 'snap', 'scroll'].includes(this.lastReason)
      if (byUser) {
        if (this.player.playing) {
          // Reading ahead or back while it plays: let them look for a while,
          // then the page follows the narration again.
          const c = this.player.clip
          if (c && !this.#isVisible(c)) this.followPausedUntil = Date.now() + 10000
        } else {
          // Paused: the audio moves to the page they turned to.
          this.#parkOnPage(loc)
        }
      }
      this.#saveReading()
    }, 0)
  }
  // While paused, make the audio start at the page shown (unless the current
  // sentence is already on it).
  #parkOnPage(loc = this.lastRelocate) {
    if (this.player.playing) return
    const first = this.#firstVisibleClip(loc)
    if (first && (!this.player.clip || !this.#isVisible(this.player.clip))) this.player.park(this.player.clipStart(first))
  }
  #firstVisibleClip(loc) {
    if (!loc || !loc.range) return null
    const doc = this.#docFor(secIdx(loc))
    if (!doc) return null
    for (const c of this.clips) {
      if (c.si < secIdx(loc)) continue
      if (c.si > secIdx(loc)) return c // nothing read aloud on this page: the next sentence that is
      const el = c.id && doc.getElementById(c.id)
      if (el) { try { if (loc.range.intersectsNode(el)) return c } catch (e) {} }
    }
    return null
  }
  #saveReading(immediate) {
    const loc = this.lastRelocate
    if (!loc || !this.sync) return
    const c = this.player.clip
    const absTime = c ? this.toAbs(this.player.globalTime()) : null
    this.sync.saveReading({ cfi: loc.cfi, fraction: loc.fraction, absTime, paused: !this.player.playing }, immediate)
    try {
      localStorage.setItem(this.lastKey, JSON.stringify({
        cfi: loc.cfi, f: clamp01(loc.fraction),
        t: absTime != null ? absTime : undefined, at: Date.now(),
      }))
    } catch (e) {}
  }
  #tick() {
    const p = this.player
    this.sync.tick(p.playing)
    if (p.playing) {
      const absT = this.toAbs(p.globalTime())
      this.sync.syncListening(absT)
      try {
        const mine = JSON.parse(localStorage.getItem(this.lastKey) || '{}')
        mine.t = absT; mine.at = Date.now()
        localStorage.setItem(this.lastKey, JSON.stringify(mine))
      } catch (e) {}
    }
  }
  async #flush(keepalive) {
    const p = this.player
    if (!p || !this.sync) return
    const absT = this.toAbs(p.globalTime())
    this.sync.tick(p.playing)
    await Promise.all([
      this.sync.closeSession(absT, keepalive),
      this.sync.flushReading(keepalive),
    ])
  }

  // ---- controls ----
  #action(a, b) {
    const p = this.player
    switch (a) {
      case 'close': return this.close()
      case 'left': return this.view && this.view.goLeft()
      case 'right': return this.view && this.view.goRight()
      case 'play':
        if (!p) return
        if (p.playing) return p.pause()
        this.followPausedUntil = 0
        if (!p.clip || (!this.#isVisible(p.clip) && this.lastRelocate)) {
          const first = this.#firstVisibleClip(this.lastRelocate)
          if (first) return p.seekClip(first.i, true).catch((e) => this.#toast(e))
        }
        return p.play()
      case 'prev': this.followPausedUntil = 0; this.followOnce = true; return p && p.prev()
      case 'next': this.followPausedUntil = 0; this.followOnce = true; return p && p.next()
      case 'rate': return this.#togglePanel('speed')
      case 'setrate': this.#setRate(b.dataset.v); return this.#togglePanel(null)
      case 'raterel': this.#setRate(prefs.rate + Number(b.dataset.v)); return this.#syncSpeedPanel()
      case 'toc': return this.#togglePanel('toc')
      case 'aa': return this.#togglePanel('aa')
      case 'theme': prefs.theme = b.dataset.v; prefs.save(); this.#applyTheme(); return this.#togglePanel('aa', true)
      case 'size': prefs.size = Math.max(0.7, Math.min(2.2, Math.round((prefs.size + Number(b.dataset.v)) * 10) / 10)); prefs.save(); this.#applyTheme(); return this.#togglePanel('aa', true)
      case 'goto': {
        this.#togglePanel(null)
        const href = b.dataset.href
        this.followPausedUntil = 0
        return this.view.goTo(href).then(() => {
          const res = this.view.resolveNavigation(href)
          const c = res && this.clips.find((x) => x.si >= res.index)
          if (c && p.playing) p.seekClip(c.i, true)
          else if (c) p.park(p.clipStart(c))
        }).catch((e) => this.#toast(e))
      }
    }
  }
  #key(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range') return
    if (e.key === 'Escape') { if (this.panel) this.#togglePanel(null); else this.close(); e.preventDefault() }
    else if (e.key === ' ' || e.key === 'k') { this.#action('play'); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { this.view && this.view.goLeft(); e.preventDefault() }
    else if (e.key === 'ArrowRight') { this.view && this.view.goRight(); e.preventDefault() }
    else if (e.key === 'ArrowUp' || e.key === 'j') { this.#action('prev'); e.preventDefault() }
    else if (e.key === 'ArrowDown' || e.key === 'l') { this.#action('next'); e.preventDefault() }
  }
  #togglePanel(kind, keep) {
    const old = this.el.querySelector('.ra-panel')
    const same = this.panel === kind
    if (old) old.remove()
    this.panel = null
    if (!kind || (same && !keep)) return
    const d = document.createElement('div')
    this.panel = kind
    if (kind === 'toc') {
      d.className = 'ra-panel left ra-toc'
      const cur = this.lastRelocate && this.lastRelocate.tocItem && this.lastRelocate.tocItem.href
      const walk = (items, depth) => (items || []).map((t) =>
        `<button data-a="goto" data-href="${esc(t.href)}" class="${t.href === cur ? 'cur' : ''}" style="padding-left:${18 + depth * 16}px">${esc(t.label || '')}</button>` + walk(t.subitems, depth + 1)).join('')
      d.innerHTML = walk(this.book.toc, 0) || '<div style="padding:12px 18px;opacity:.7">No table of contents.</div>'
    } else if (kind === 'speed') {
      d.className = 'ra-panel ra-speed'
      d.setAttribute('role', 'dialog')
      d.setAttribute('aria-label', 'Playback speed')
      d.innerHTML = `
        <div class="ra-speed-head"><span>Playback speed</span><b></b></div>
        <div class="ra-presets">${RATES.map((r) => `<button data-a="setrate" data-v="${r}">${fmtRate(r)}</button>`).join('')}</div>
        <div class="ra-fine">
          <button data-a="raterel" data-v="-${RATE_STEP}" title="Slower" aria-label="Slower">−</button>
          <input type="range" min="${RATE_MIN}" max="${RATE_MAX}" step="${RATE_STEP}" aria-label="Speed">
          <button data-a="raterel" data-v="${RATE_STEP}" title="Faster" aria-label="Faster">+</button>
        </div>`
      d.querySelector('.ra-fine input').addEventListener('input', (e) => { this.#setRate(e.target.value); this.#syncSpeedPanel() })
    } else {
      d.className = 'ra-panel right'
      const th = (k, label) => `<button data-a="theme" data-v="${k}" class="${prefs.theme === k ? 'on' : ''}">${label}</button>`
      d.innerHTML = `
        <div class="ra-row"><span>Theme</span><div class="ra-seg">${th('dark', 'Dark')}${th('sepia', 'Sepia')}${th('light', 'Light')}</div></div>
        <div class="ra-row"><span>Text size</span><div class="ra-seg"><button data-a="size" data-v="-0.1">A−</button><button disabled style="opacity:.7">${Math.round(prefs.size * 100)}%</button><button data-a="size" data-v="0.1">A+</button></div></div>`
    }
    this.$('.ra-main').appendChild(d)
    if (kind === 'speed') this.#syncSpeedPanel()
  }
  #setRate(r) {
    prefs.rate = clampRate(r)
    prefs.save()
    if (this.player) this.player.setRate(prefs.rate)
    this.#renderRate()
    this.#renderTime()
  }
  #syncSpeedPanel() {
    const d = this.el.querySelector('.ra-speed')
    if (!d) return
    d.querySelector('.ra-speed-head b').textContent = fmtRate(prefs.rate)
    d.querySelectorAll('.ra-presets button').forEach((x) => x.classList.toggle('on', Math.abs(Number(x.dataset.v) - prefs.rate) < 0.001))
    const r = d.querySelector('.ra-fine input')
    if (document.activeElement !== r) r.value = prefs.rate
  }

  // ---- rendering ----
  #docCss() {
    const t = THEMES[prefs.theme]
    return `
      html { color-scheme: ${prefs.theme === 'dark' ? 'dark' : 'light'}; }
      html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
      body { font-size: ${Math.round(prefs.size * 100)}% !important; line-height: 1.55; }
      a, a:link, a:visited { color: ${t.link} !important; }
      .nh-ra-hl, .-epub-media-overlay-active { background: ${t.hl} !important; border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      [id] { cursor: default; }`
  }
  #applyTheme() {
    const t = THEMES[prefs.theme]
    if (this.el) {
      this.el.style.setProperty('--ra-bg', t.bg)
      this.el.style.setProperty('--ra-fg', t.fg)
      this.el.style.setProperty('--ra-link', t.link)
    }
    if (this.view && this.view.renderer) {
      for (const { doc } of this.view.renderer.getContents() || []) {
        const st = doc && doc.getElementById('nh-ra-doc')
        if (st) st.textContent = this.#docCss()
      }
      try { this.view.renderer.setStyles && this.view.renderer.setStyles(this.#docCss()) } catch (e) {}
    }
    this.#renderRate()
  }
  #renderRate() {
    const b = this.el && this.$('.ra-rate')
    if (b) b.textContent = fmtRate(prefs.rate)
  }
  #renderTime() {
    if (!this.player || this.seeking) return
    const p = this.player
    const absT = this.toAbs(p.globalTime())
    this.$('.ra-t0').textContent = fmt(absT)
    this.$('.ra-t1').textContent = '-' + fmt(Math.max(0, this.absDuration - absT) / (prefs.rate || 1))
    this.$('.ra-seek input').value = this.absDuration ? Math.round((absT / this.absDuration) * 1000) : 0
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && this.absDuration) {
      try { navigator.mediaSession.setPositionState({ duration: this.absDuration, position: Math.min(absT, this.absDuration), playbackRate: prefs.rate }) } catch (e) {}
    }
  }
  #renderChapter(loc) {
    loc = loc || this.lastRelocate
    const label = loc && loc.tocItem && loc.tocItem.label
    const el = this.$('.ra-chap')
    if (el) el.textContent = loc && loc.fraction != null ? Math.round(loc.fraction * 100) + '%' : ''
    if (label) this.$('.ra-sub').textContent = label
  }
  #media() {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    try {
      ms.metadata = new MediaMetadata({
        title: this.title, artist: this.author, album: 'Read-along',
        artwork: [{ src: '/api/items/' + this.itemId + '/cover?width=512', sizes: '512x512' }],
      })
    } catch (e) {}
    const set = (a, f) => { try { ms.setActionHandler(a, f) } catch (e) {} }
    set('play', () => this.player.play())
    set('pause', () => this.player.pause())
    set('previoustrack', () => this.player.prev())
    set('nexttrack', () => this.player.next())
    set('seekbackward', (d) => this.player.seekGlobal(Math.max(0, this.player.globalTime() - (d.seekOffset || 15))))
    set('seekforward', (d) => this.player.seekGlobal(this.player.globalTime() + (d.seekOffset || 30)))
    set('seekto', (d) => this.player.seekGlobal(this.toEpub(d.seekTime)))
  }

  async close() {
    if (this.closing) return
    this.closing = true
    clearInterval(this.ticker)
    if (this.player) this.player.pause()
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('pagehide', this.onHide)
    try { await this.#flush(false) } catch (e) {}
    if (this.player) this.player.destroy()
    if ('mediaSession' in navigator) {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']) {
        try { navigator.mediaSession.setActionHandler(a, null) } catch (e) {}
      }
      try { navigator.mediaSession.metadata = null } catch (e) {}
    }
    try { this.view && this.view.close() } catch (e) {}
    if (this.el) this.el.remove()
    document.documentElement.style.overflow = ''
    current = null
  }
}

// The open reader, for debugging from the console:
// (await import('/_nh/reader/readalong.js')).debug()
export const debug = () => current
