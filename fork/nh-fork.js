/* NanoHive ABS - hobesman fork: server-side helpers (nginx njs module)

   Readaloud index (the "Readaloud" value of the Format filter):
   which books have an ebook file with "readaloud" in its filename. ABS's
   library list does not carry file names, so each book's full record has to
   be read once; this keeps the answer for everyone in one small shared file
   and re-reads a book only when ABS says it changed.

   Storage: /data/nh/readaloud.json
     { "v": 1, "items": { "<libraryItemId>": { "u": <updatedAt>, "n": <numFiles>, "r": 0|1 } } }

   Endpoints (fork/nh-fork.locations.template), signed-in ABS users only:
     GET  /_nh/api/readaloud              -> the whole index
     POST /_nh/api/readaloud { ids: [] }  -> (re)check up to 20 books, returns
                                             their new entries
   The caller only names WHICH books to check. The answer comes from ABS
   itself (POST /api/items/batch/get, made with the caller's own token, so
   ABS's library permissions apply), never from the caller, so nobody can
   write a wrong entry.

   Like the upstream stores, the read-modify-write is not locked across
   workers; writes are atomic (tmp + rename), so the worst case is a lost
   entry that the next visit simply checks again. */

import fs from 'fs';

const DATA = '/data/nh/readaloud.json';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const READALOUD_RE = /readaloud/i;
const MAX_IDS = 20;

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA));
    if (s && typeof s === 'object' && s.items && typeof s.items === 'object') return s;
  } catch (e) {}
  return { v: 1, items: {} };
}

function writeStore(store) {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA);
}

function send(r, status, obj) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.headersOut['X-Content-Type-Options'] = 'nosniff';
  r.return(status, JSON.stringify(obj));
}

function entryFor(li) {
  const files = li.libraryFiles || [];
  const hit = files.some(function (f) {
    return f && f.fileType === 'ebook' && READALOUD_RE.test((f.metadata && f.metadata.filename) || '');
  });
  return {
    u: Number(li.updatedAt) || 0,
    n: typeof li.numFiles === 'number' ? li.numFiles : files.length,
    r: hit ? 1 : 0
  };
}

async function readaloud(r) {
  if (r.method === 'GET') return send(r, 200, readStore());
  if (r.method !== 'POST') return send(r, 405, { error: 'method not allowed' });

  let body = null;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) {}
  const ids = ((body && Array.isArray(body.ids)) ? body.ids : [])
    .filter(function (id) { return typeof id === 'string' && ID_RE.test(id); })
    .slice(0, MAX_IDS);
  if (!ids.length) return send(r, 400, { error: 'ids required' });

  let res;
  try {
    res = await r.subrequest('/_nh/int/abs-batch', {
      method: 'POST',
      body: JSON.stringify({ libraryItemIds: ids })
    });
  } catch (e) {
    return send(r, 502, { error: 'ABS unreachable' });
  }
  if (res.status !== 200) return send(r, 502, { error: 'ABS answered ' + res.status });

  let items = [];
  try { items = JSON.parse(res.responseText || '{}').libraryItems || []; } catch (e) {
    return send(r, 502, { error: 'bad ABS answer' });
  }
  const store = readStore();
  const out = {};
  items.forEach(function (li) {
    if (!li || !ID_RE.test(String(li.id || ''))) return;
    const e = entryFor(li);
    store.items[li.id] = e;
    out[li.id] = e;
  });
  try { writeStore(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { items: out });
}

/* ---------------------------------------------------------------------------
   Similar matches for searches that find nothing (apps included).

   Every search an app (or ABS's own web UI) makes through this proxy,
   GET /api/libraries/<id>/search?q=..., is handed to ABS unchanged. Only when
   ABS finds nothing at all is it answered here instead: ABS is asked about each
   significant word of the query on its own (plus the first letters of a word,
   so a typo later in it still finds candidates), the books, series, authors
   and narrators that come back are scored against the whole query (words in
   any order, missing words, 1-2 letter typos), and the good ones are returned
   in ABS's own search format, so any app shows them as ordinary results.
   Books of a matching series and of a matching narrator are included.
   The books are sent as full records (as ABS's search does), fetched in one
   batch. A search that finds anything is passed straight through, untouched.

   The theme's own search bar does its own similar matching with labels, so
   it sends X-NH-No-Fuzzy and is passed through as-is.
   This njs build has no Map/Set/flatMap/String.normalize: plain objects and
   a small accent table instead.
   --------------------------------------------------------------------------- */

const FZ_STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, in: 1, on: 1, to: 1, for: 1, at: 1, by: 1, with: 1, from: 1, de: 1, la: 1, le: 1, el: 1, der: 1, die: 1, das: 1 };
const FZ_MIN = 0.6;
const FZ_ACCENTS = [[/[àáâãäåā]/g, 'a'], [/[çćč]/g, 'c'], [/[èéêëēė]/g, 'e'], [/[ìíîïī]/g, 'i'], [/[ñń]/g, 'n'],
  [/[òóôõöøō]/g, 'o'], [/[ùúûüū]/g, 'u'], [/[ýÿ]/g, 'y'], [/[žźż]/g, 'z'], [/[šś]/g, 's'], [/ß/g, 'ss'], [/ł/g, 'l']];

function fzNorm(s) {
  s = String(s || '').toLowerCase();
  for (let i = 0; i < FZ_ACCENTS.length; i++) s = s.replace(FZ_ACCENTS[i][0], FZ_ACCENTS[i][1]);
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}
function fzWords(s) { const n = fzNorm(s); return n ? n.split(' ') : []; }

function fzLev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function fzWordHit(q, list) {
  let best = 0;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (w === q) return 1;
    if (q.length >= 3 && w.indexOf(q) === 0) best = Math.max(best, 0.95);
    else if (q.length >= 4) {
      const max = q.length >= 8 ? 2 : 1;
      if (fzLev(q, w, max) <= max) best = Math.max(best, 0.8);
      else if (w.length > q.length && fzLev(q, w.slice(0, q.length), max) <= max) best = Math.max(best, 0.7);
    }
  }
  return best;
}
function fzBigrams(s) {
  const x = s.replace(/ /g, '');
  const m = {};
  for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); m[g] = (m[g] || 0) + 1; }
  return m;
}
function fzDice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = fzBigrams(a), B = fzBigrams(b);
  let inter = 0, tot = 0;
  Object.keys(A).forEach(function (g) { tot += A[g]; if (B[g]) inter += Math.min(A[g], B[g]); });
  Object.keys(B).forEach(function (g) { tot += B[g]; });
  return tot ? (2 * inter) / tot : 0;
}
function fzScore(qWords, qNorm, main, extra) {
  const list = fzWords(main + ' ' + (extra || ''));
  if (!qWords.length || !list.length) return 0;
  let cover = 0;
  qWords.forEach(function (w) { cover += fzWordHit(w, list); });
  return 0.75 * (cover / qWords.length) + 0.25 * fzDice(qNorm, fzNorm(main));
}
function fzTerms(all) {
  const sig = all.filter(function (w) { return w.length >= 3 && !FZ_STOP[w]; })
    .sort(function (a, b) { return b.length - a.length; }).slice(0, 3);
  const out = [];
  const add = function (t) { if (out.indexOf(t) < 0) out.push(t); };
  sig.forEach(function (w) { add(w); if (w.length >= 6) add(w.slice(0, 4)); else if (w.length >= 4) add(w.slice(0, 3)); });
  return out.slice(0, 5);
}
function fzIsEmpty(j) {
  const keys = ['book', 'podcast', 'series', 'authors', 'narrators', 'tags', 'genres'];
  for (let i = 0; i < keys.length; i++) if (j[keys[i]] && j[keys[i]].length) return false;
  return true;
}
function fzAuthorOf(md) {
  return md.authorName || md.author || (md.authors || []).map(function (a) { return a && a.name; }).filter(Boolean).join(', ');
}

function passThrough(r, res) {
  const ct = res.headersOut['Content-Type'];
  if (ct) r.headersOut['Content-Type'] = ct;
  r.return(res.status, res.responseText);
}

async function search(r) {
  const lib = r.variables.nh_lib;
  const absApi = function (path, args) {
    return r.subrequest('/_nh/int/abs-api/' + path, { args: args || '', method: 'GET' });
  };
  let res;
  try { res = await absApi('libraries/' + lib + '/search', r.variables.args); } catch (e) {
    return r.return(502, 'search unavailable');
  }
  if (res.status !== 200 || r.headersIn['X-NH-No-Fuzzy']) return passThrough(r, res);
  let exact;
  try { exact = JSON.parse(res.responseText); } catch (e) { return passThrough(r, res); }
  const q = String((r.args && r.args.q) || '').trim();
  if (!exact || !fzIsEmpty(exact) || q.length < 2) return passThrough(r, res);

  const limit = Math.max(1, Math.min(50, parseInt((r.args && r.args.limit) || '12', 10) || 12));
  const qNorm = fzNorm(q);
  const all = fzWords(q);
  const sig = all.filter(function (w) { return !FZ_STOP[w]; });
  const qWords = sig.length ? sig : all;
  const terms = fzTerms(all);
  if (!terms.length) return passThrough(r, res);

  let answers = [];
  try {
    answers = await Promise.all(terms.map(function (t) {
      return absApi('libraries/' + lib + '/search', 'q=' + encodeURIComponent(t) + '&limit=25')
        .then(function (x) { try { return x.status === 200 ? JSON.parse(x.responseText) : null; } catch (e) { return null; } })
        .catch(function () { return null; });
    }));
  } catch (e) { return passThrough(r, res); }

  // Candidates. Books are keyed by item id (books inside series results come
  // without authors, so title|author can't be the key for those).
  const books = {}, series = {}, authors = {}, narrators = {};
  const addBook = function (li, via) {
    if (!li || !li.id) return;
    const md = (li.media && li.media.metadata) || {};
    const sc = via ? via * 0.95
      : fzScore(qWords, qNorm, (md.title || '') + ' ' + (md.subtitle || ''),
        fzAuthorOf(md) + ' ' + (md.seriesName || '') + ' ' + (md.narratorName || ''));
    const cur = books[li.id];
    if (!cur) { books[li.id] = { s: sc, li: li }; return; }
    if (sc > cur.s) cur.s = sc;
    // Keep the copy of the record that has the authors.
    if (!fzAuthorOf((cur.li.media && cur.li.media.metadata) || {}) && fzAuthorOf(md)) cur.li = li;
  };
  answers.forEach(function (j) {
    if (!j) return;
    (j.book || []).concat(j.podcast || []).forEach(function (b) { addBook(b.libraryItem); });
    (j.series || []).forEach(function (s) {
      const se = s.series || s;
      if (!se || !se.name) return;
      const sc = fzScore(qWords, qNorm, se.name);
      if (!series[se.id] || sc > series[se.id].s) series[se.id] = { s: sc, v: s };
      if (sc >= FZ_MIN) (s.books || []).forEach(function (li) { addBook(li, sc); });
    });
    (j.authors || []).forEach(function (a) {
      if (!a || !a.name) return;
      const sc = fzScore(qWords, qNorm, a.name);
      if (!authors[a.id] || sc > authors[a.id].s) authors[a.id] = { s: sc, v: a };
    });
    (j.narrators || []).forEach(function (n) {
      if (!n || !n.name) return;
      const k = fzNorm(n.name);
      if (!narrators[k]) narrators[k] = { s: fzScore(qWords, qNorm, n.name), v: n };
    });
  });

  // Books read by the best matching narrators (search names them, the
  // library's narrator filter lists their books).
  const topNarr = Object.keys(narrators).map(function (k) { return narrators[k]; })
    .filter(function (n) { return n.s >= FZ_MIN; })
    .sort(function (a, b) { return b.s - a.s; }).slice(0, 2);
  try {
    await Promise.all(topNarr.map(function (n) {
      const filter = 'narrators.' + Buffer.from(n.v.name).toString('base64');
      return absApi('libraries/' + lib + '/items', 'limit=10&filter=' + encodeURIComponent(filter))
        .then(function (x) {
          if (x.status !== 200) return;
          (JSON.parse(x.responseText).results || []).forEach(function (li) { addBook(li, n.s); });
        }).catch(function () {});
    }));
  } catch (e) {}

  const best = function (obj, max) {
    return Object.keys(obj).map(function (k) { return obj[k]; })
      .filter(function (x) { return x.s >= FZ_MIN; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, max);
  };
  // The chosen books as full records, exactly the shape ABS's own search
  // returns (books reached through a narrator or series come in shorter
  // forms, and apps may rely on the full one). Order is kept; a book ABS
  // won't return in full is left out rather than sent incomplete.
  const chosen = best(books, limit);
  let full = {};
  if (chosen.length) {
    try {
      const x = await r.subrequest('/_nh/int/abs-batch', {
        method: 'POST',
        body: JSON.stringify({ libraryItemIds: chosen.map(function (c) { return c.li.id; }) })
      });
      if (x.status === 200) (JSON.parse(x.responseText).libraryItems || []).forEach(function (li) { full[li.id] = li; });
    } catch (e) {}
  }
  const out = {
    book: chosen.filter(function (c) { return full[c.li.id]; })
      .map(function (c) { return { libraryItem: full[c.li.id] }; }),
    podcast: [],
    narrators: topNarr.map(function (n) { return n.v; }),
    tags: [],
    genres: [],
    series: best(series, Math.min(limit, 5)).map(function (x) { return x.v; }),
    authors: best(authors, Math.min(limit, 5)).map(function (x) { return x.v; })
  };
  if (fzIsEmpty(out)) return passThrough(r, res);
  r.headersOut['Content-Type'] = 'application/json; charset=utf-8';
  r.headersOut['X-NH-Similar'] = '1';
  r.return(200, JSON.stringify(out));
}

export default { readaloud, search };
