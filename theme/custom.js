/* NanoHive ABS - hobesman fork customizations */

// Fork-only additions live here, not in the upstream theme files, so the daily
// upstream merge rarely conflicts. Injected after book-details.js by the
// '</html>' sub_filter in default.conf.template.

(function () {
  'use strict';

  // ==========================================
  // Readaloud badge: a speaker icon on the corner of the book page's Read
  // button when the item has an ebook file with "readaloud" in its filename.
  // Absolutely positioned inside the button, so the action row's layout (and
  // where it wraps) is unchanged.
  // ==========================================
  const css = `
    #nh-readaloud-badge {
        position: absolute; top: -9px; right: -9px; z-index: 2;
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border-radius: 50%;
        color: var(--nh-amber, #e0c27a) !important;
        background: var(--nh-canvas, #14110d) !important;
        border: 1.5px solid var(--nh-amber, #e0c27a) !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.45);
        cursor: help;
    }
    #nh-readaloud-badge svg { width: 15px; height: 15px; }
    /* core.js forces dark text on everything in the Read button
       (body #page-wrapper #item-page-wrapper button.abs-btn.bg-info *),
       so the badge's colors need a more specific selector to win. */
    body #page-wrapper #item-page-wrapper #nh-readaloud-badge,
    body #page-wrapper #item-page-wrapper #nh-readaloud-badge * {
        color: var(--nh-amber, #e0c27a) !important;
    }
  `;
  const style = document.createElement('style');
  style.id = 'nh-custom-css';
  style.textContent = css;
  document.head.appendChild(style);

  // Inline SVG rather than a material-symbols ligature: ligatures do not always
  // substitute in injected markup (see NH_SA_CHEV in enhancements.js).
  const SPEAKER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/>'
    + '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

  const READALOUD_RE = /readaloud/i;
  const cache = {}; // itemId -> filename string, '' (none) or 'pending'

  function token() {
    if (window.__NH_TOKEN) return window.__NH_TOKEN;
    try {
      const st = window.$nuxt && window.$nuxt.$store;
      const t = st && (st.getters['user/getToken'] || (st.state.user.user && (st.state.user.user.accessToken || st.state.user.user.token)));
      if (t) return t;
    } catch (e) {}
    try { return localStorage.getItem('token') || ''; } catch (e) { return ''; }
  }

  window.__nhFork = { token: token };

  function readaloudFile(item) {
    const names = [];
    ((item && item.libraryFiles) || []).forEach((f) => {
      if (f && f.fileType === 'ebook' && f.metadata) names.push(f.metadata.filename || '');
    });
    const ef = item && item.media && item.media.ebookFile;
    if (ef && ef.metadata) names.push(ef.metadata.filename || '');
    return names.find((n) => READALOUD_RE.test(n)) || '';
  }

  function lookup(itemId) {
    cache[itemId] = 'pending';
    const t = token();
    fetch('/api/items/' + encodeURIComponent(itemId) + '?expanded=1', {
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((item) => { cache[itemId] = readaloudFile(item); tick(); })
      .catch(() => { // no badge for now; try again in 15s
        cache[itemId] = '';
        setTimeout(() => { if (cache[itemId] === '') delete cache[itemId]; }, 15000);
      });
  }

  // The Read button in the action row (the same row book-details.js anchors the
  // ratings under). ABS only shows it when the item has a primary ebook.
  // Matched by its label (localized via ABS's strings), then by ABS's
  // bg-info class.
  function findReadButton() {
    const row = document.querySelector('#item-page-wrapper .flex.items-center.justify-center.md\\:justify-start.pt-4')
      || document.querySelector('#item-page-wrapper [class*="pt-4 flex"]');
    if (!row) return null;
    const btns = Array.from(row.querySelectorAll(':scope > button'));
    const s = (window.$nuxt && window.$nuxt.$strings) || {};
    const labels = [s.ButtonRead, 'Read']
      .filter(Boolean).map((x) => x.toLowerCase());
    const label = (b) => Array.from(b.childNodes)
      .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim().toLowerCase();
    return btns.find((b) => labels.includes(label(b)))
      || btns.find((b) => b.classList.contains('bg-info'))
      || null;
  }

  function tick() {
    const m = window.location.pathname.match(/\/item\/([^/?#]+)/);
    const itemId = m ? m[1] : null;
    let badge = document.getElementById('nh-readaloud-badge');

    const file = itemId ? cache[itemId] : '';
    if (itemId && file === undefined) lookup(itemId);
    const btn = itemId && file && file !== 'pending' ? findReadButton() : null;

    if (!btn) {
      if (badge) badge.remove();
      return;
    }
    if (badge && badge.dataset.item === itemId && badge.parentElement === btn) return;

    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'nh-readaloud-badge';
      badge.setAttribute('role', 'img');
      badge.innerHTML = SPEAKER_SVG;
      // It sits inside the Read button: a click on it should not open the reader.
      badge.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    }
    badge.dataset.item = itemId;
    badge.title = 'Readaloud ebook: ' + file;
    badge.setAttribute('aria-label', badge.title);
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    btn.appendChild(badge);
  }

  let queued = false;
  function queueTick() {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; try { tick(); } catch (e) {} }, 80);
  }
  try {
    new MutationObserver(queueTick).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(queueTick, 1000);
})();

(function () {
  'use strict';

  // ==========================================
  // Request book: a top-bar button opening a ReadMeABook search. Requesting a
  // result first runs a fuzzy search of the ABS library and asks the user to
  // confirm the book is not already there; only then is it sent to RMAB.
  // RMAB is reached through the /_nh/rmab/* bridge (fork/nh-fork.locations.template),
  // which adds the RMAB token server side. The button only appears when that
  // bridge is configured (NH_RMAB_URL).
  // ==========================================
  const css = `
    #nh-rq-btn {
        display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
        margin: 0 8px 0 4px; border-radius: 999px; cursor: pointer; white-space: nowrap;
        border: 1px solid var(--nh-hairline-lit, rgba(255,255,255,0.14));
        background: var(--nh-raised, #221e1a); color: var(--nh-text-2, #d8cfc2);
        font-family: var(--nh-sans, system-ui); font-size: 0.85rem; flex-shrink: 0;
        transition: border-color .15s ease, color .15s ease;
    }
    #nh-rq-btn:hover { border-color: var(--nh-amber, #e0c27a); color: var(--nh-text-1, #f4eee2); }
    #nh-rq-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
    @media (max-width: 767px) { #nh-rq-btn { padding: 0 8px; margin: 0 4px; } #nh-rq-btn .nh-rq-btn-label { display: none; } }

    #nh-rq { position: fixed; inset: 0; z-index: 600; display: flex; justify-content: center; align-items: flex-start; padding-top: 8vh; font-family: var(--nh-sans, system-ui); }
    #nh-rq .nh-rq-bg { position: absolute; inset: 0; background: rgba(10,8,6,0.6); backdrop-filter: blur(3px); }
    #nh-rq .nh-rq-box { position: relative; width: min(94vw, 640px); max-height: 82vh; display: flex; flex-direction: column; background: var(--nh-raised, #221e1a); border: 1px solid var(--nh-hairline-lit, rgba(255,255,255,0.14)); border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,0.6); color: var(--nh-text-2, #d8cfc2); }
    #nh-rq .nh-rq-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px; }
    #nh-rq .nh-rq-title { font-family: var(--nh-serif, Georgia, serif); font-size: 1.25rem; color: var(--nh-text-1, #f4eee2); flex: 1; }
    #nh-rq .nh-rq-x { background: none; border: none; color: var(--nh-muted-2, #8a8075); font-size: 1.5rem; line-height: 1; cursor: pointer; padding: 2px 6px; }
    #nh-rq .nh-rq-x:hover { color: var(--nh-text-1, #f4eee2); }
    #nh-rq .nh-rq-search { position: relative; margin: 0 18px 12px; }
    #nh-rq .nh-rq-search svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); width: 17px; height: 17px; color: var(--nh-muted-2, #8a8075); pointer-events: none; }
    #nh-rq .nh-rq-search input { width: 100%; box-sizing: border-box; padding: 10px 14px 10px 40px; border-radius: 999px; border: 1px solid var(--nh-hairline-lit, rgba(255,255,255,0.14)); background: rgba(0,0,0,0.25); color: var(--nh-text-1, #f4eee2); font-size: 0.95rem; }
    #nh-rq .nh-rq-search input:focus { outline: none; border-color: var(--nh-amber, #e0c27a); }
    #nh-rq .nh-rq-body { overflow-y: auto; padding: 0 18px 14px; }
    #nh-rq .nh-rq-msg { color: var(--nh-muted-2, #8a8075); font-size: 0.9rem; padding: 14px 2px; }
    #nh-rq .nh-rq-msg.nh-rq-err { color: #e08a7a; }
    #nh-rq .nh-rq-row { display: flex; gap: 12px; align-items: center; padding: 10px 2px; border-top: 1px solid var(--nh-hairline, rgba(255,255,255,0.06)); }
    #nh-rq .nh-rq-cover { width: 54px; height: 54px; flex-shrink: 0; border-radius: 6px; object-fit: cover; background: rgba(255,255,255,0.05); }
    #nh-rq .nh-rq-info { flex: 1; min-width: 0; }
    #nh-rq .nh-rq-t { color: var(--nh-text-1, #f4eee2); font-size: 0.95rem; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    #nh-rq .nh-rq-sub { color: var(--nh-muted-2, #8a8075); font-size: 0.8rem; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #nh-rq .nh-rq-act { flex-shrink: 0; }
    #nh-rq .nh-rq-go { padding: 7px 14px; border-radius: 8px; border: none; cursor: pointer; background: var(--nh-amber, #e0c27a); color: #14110d; font-weight: 600; font-size: 0.85rem; }
    #nh-rq .nh-rq-go:hover { filter: brightness(1.08); }
    #nh-rq .nh-rq-go:disabled { cursor: default; filter: none; opacity: 0.55; }
    #nh-rq .nh-rq-ghost { padding: 7px 14px; border-radius: 8px; cursor: pointer; background: none; border: 1px solid var(--nh-hairline-lit, rgba(255,255,255,0.14)); color: var(--nh-text-2, #d8cfc2); font-size: 0.85rem; }
    #nh-rq .nh-rq-ghost:hover { border-color: var(--nh-text-2, #d8cfc2); }
    #nh-rq .nh-rq-chip { display: inline-block; padding: 5px 10px; border-radius: 999px; font-size: 0.78rem; background: rgba(255,255,255,0.06); color: var(--nh-text-2, #d8cfc2); white-space: nowrap; }
    #nh-rq .nh-rq-chip.nh-rq-ok { background: rgba(124,184,124,0.16); color: #a8d8a0; }
    #nh-rq .nh-rq-more { display: block; margin: 12px auto 0; }
    #nh-rq .nh-rq-confirm { padding: 4px 18px 16px; overflow-y: auto; }
    #nh-rq .nh-rq-pick { display: flex; gap: 12px; align-items: center; padding: 4px 0 12px; }
    #nh-rq .nh-rq-q { color: var(--nh-text-1, #f4eee2); font-size: 0.95rem; margin: 6px 0 8px; }
    #nh-rq .nh-rq-lib { background: rgba(0,0,0,0.18); border-radius: 10px; padding: 2px 12px; }
    #nh-rq .nh-rq-lib .nh-rq-row:first-child { border-top: none; }
    #nh-rq .nh-rq-lib a { color: inherit; text-decoration: none; }
    #nh-rq .nh-rq-lib a:hover .nh-rq-t { text-decoration: underline; }
    #nh-rq .nh-rq-score { font-size: 0.75rem; color: var(--nh-amber, #e0c27a); margin-top: 3px; }
    #nh-rq .nh-rq-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
  `;
  const style = document.createElement('style');
  style.id = 'nh-custom-rq-css';
  style.textContent = css;
  document.head.appendChild(style);

  const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M12 7v6M9 10h6"/></svg>';
  const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  const token = () => (window.__nhFork && window.__nhFork.token()) || '';
  const authHeaders = (json) => {
    const h = {}; const t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getJSON = (url) => fetch(url, { headers: authHeaders(false), credentials: 'include' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

  // ---- Is the bridge configured? (404 = no NH_RMAB_URL, keep the button hidden) ----
  let enabled = null; // null unknown, 'pending', true, false
  function checkEnabled() {
    if (enabled !== null || !token()) return;
    enabled = 'pending';
    fetch('/_nh/rmab/enabled', { headers: authHeaders(false), credentials: 'include' })
      .then((r) => { enabled = r.status === 200; if (r.status === 401) enabled = null; })
      .catch(() => { enabled = null; });
  }

  // ---- Top-bar button, right after ABS's search box ----
  function placeButton() {
    checkEnabled();
    const appbar = document.getElementById('appbar');
    let btn = document.getElementById('nh-rq-btn');
    if (enabled !== true || !appbar) { if (btn) btn.remove(); return; }
    // The search box's block in the appbar row (the row is the element that
    // also holds ABS's flex-grow spacer).
    let anchor = appbar.querySelector('form');
    while (anchor && anchor.parentElement && anchor.parentElement !== appbar && !anchor.parentElement.querySelector(':scope > .grow')) anchor = anchor.parentElement;
    if (!anchor || !anchor.parentElement || anchor.parentElement === appbar) { if (btn) btn.remove(); return; }
    if (btn && btn.previousElementSibling === anchor) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'nh-rq-btn';
      btn.title = 'Request a book';
      btn.innerHTML = ICON_PLUS + '<span class="nh-rq-btn-label">Request book</span>';
      btn.addEventListener('click', openPanel);
    }
    anchor.insertAdjacentElement('afterend', btn);
  }

  // ---- Panel ----
  const S = { q: '', page: 1, results: [], hasMore: false, loading: false, error: '', seq: 0, confirm: null };

  function openPanel() {
    if (document.getElementById('nh-rq')) return;
    const el = document.createElement('div');
    el.id = 'nh-rq';
    el.innerHTML = `
      <div class="nh-rq-bg"></div>
      <div class="nh-rq-box" role="dialog" aria-label="Request a book">
        <div class="nh-rq-head"><div class="nh-rq-title">Request a book</div><button type="button" class="nh-rq-x" aria-label="Close">×</button></div>
        <div class="nh-rq-search">${ICON_SEARCH}<input type="search" placeholder="Search by title or author" autocomplete="off"></div>
        <div class="nh-rq-body"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.nh-rq-bg').addEventListener('click', closePanel);
    el.querySelector('.nh-rq-x').addEventListener('click', closePanel);
    const input = el.querySelector('input');
    input.value = S.q;
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => search(input.value, 1), 450); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); search(input.value, 1); } });
    document.addEventListener('keydown', onKey);
    S.confirm = null;
    render();
    setTimeout(() => input.focus(), 30);
  }
  function closePanel() {
    const el = document.getElementById('nh-rq');
    if (el) el.remove();
    document.removeEventListener('keydown', onKey);
    S.confirm = null;
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (S.confirm && !S.confirm.sending) { S.confirm = null; render(); } else closePanel();
  }

  function search(q, page) {
    q = (q || '').trim();
    S.q = q;
    if (q.length < 2) { S.results = []; S.hasMore = false; S.error = ''; S.loading = false; render(); return; }
    const seq = ++S.seq;
    S.loading = true; S.error = '';
    if (page === 1) S.results = [];
    render();
    getJSON('/_nh/rmab/search?q=' + encodeURIComponent(q) + '&page=' + page)
      .then((d) => {
        if (seq !== S.seq) return;
        S.page = page;
        S.results = (page === 1 ? [] : S.results).concat((d && d.results) || []);
        S.hasMore = !!(d && d.hasMore);
        S.loading = false; render();
      })
      .catch((st) => {
        if (seq !== S.seq) return;
        S.loading = false;
        S.error = st === 404 ? 'Book requests are not set up on this server.' : 'Search failed' + (typeof st === 'number' ? ' (' + st + ')' : '') + '. Is ReadMeABook running?';
        render();
      });
  }

  const fmtLen = (m) => (m ? (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60 ? (m % 60) + 'm' : '') : '');
  const year = (d) => (d ? String(d).slice(0, 4) : '');
  function subLine(b) {
    const parts = [b.author];
    if (b.narrator) parts.push('Narrated by ' + b.narrator);
    const len = fmtLen(b.durationMinutes); if (len) parts.push(len.trim());
    const y = year(b.releaseDate); if (y) parts.push(y);
    return parts.filter(Boolean).join(' · ');
  }
  function seriesLine(b) {
    return b.series ? b.series + (b.seriesPart ? ' #' + b.seriesPart : '') : '';
  }

  function statusFor(b) {
    if (b._nhRequested) return '<span class="nh-rq-chip nh-rq-ok">Requested</span>';
    if (b.isAvailable) return '<span class="nh-rq-chip nh-rq-ok">In library</span>';
    if (b.isRequested) return '<span class="nh-rq-chip">' + esc(prettyStatus(b.requestStatus)) + '</span>';
    return '';
  }
  function prettyStatus(s) {
    if (!s) return 'Requested';
    if (s === 'available' || s === 'downloaded') return 'In library';
    if (s === 'awaiting_approval') return 'Awaiting approval';
    if (s === 'failed') return 'Request failed';
    return 'Requested · ' + s.replace(/_/g, ' ');
  }

  function render() {
    const el = document.getElementById('nh-rq');
    if (!el) return;
    const body = el.querySelector('.nh-rq-body');
    const searchBox = el.querySelector('.nh-rq-search');
    if (S.confirm) { searchBox.style.display = 'none'; body.innerHTML = renderConfirm(); wireConfirm(body); coverFallback(body); return; }
    searchBox.style.display = '';
    let h = '';
    if (S.error) h += `<div class="nh-rq-msg nh-rq-err">${esc(S.error)}</div>`;
    else if (!S.q || S.q.length < 2) h += '<div class="nh-rq-msg">Search for an audiobook to request. Ebooks follow automatically when ReadMeABook is set up for them.</div>';
    else if (!S.loading && !S.results.length) h += '<div class="nh-rq-msg">No results.</div>';
    S.results.forEach((b, i) => {
      const st = statusFor(b);
      const ser = seriesLine(b);
      h += `<div class="nh-rq-row">
        ${b.coverArtUrl ? `<img class="nh-rq-cover" src="${esc(b.coverArtUrl)}" alt="" loading="lazy">` : '<div class="nh-rq-cover"></div>'}
        <div class="nh-rq-info"><div class="nh-rq-t">${esc(b.title)}</div>
          ${ser ? `<div class="nh-rq-sub">${esc(ser)}</div>` : ''}
          <div class="nh-rq-sub">${esc(subLine(b))}</div></div>
        <div class="nh-rq-act">${st || `<button type="button" class="nh-rq-go" data-i="${i}">Request</button>`}</div>
      </div>`;
    });
    if (S.loading) h += '<div class="nh-rq-msg">Searching…</div>';
    else if (S.hasMore) h += '<button type="button" class="nh-rq-ghost nh-rq-more">More results</button>';
    body.innerHTML = h;
    coverFallback(body);
    body.querySelectorAll('.nh-rq-go').forEach((b) => b.addEventListener('click', () => startConfirm(S.results[+b.dataset.i])));
    const more = body.querySelector('.nh-rq-more');
    if (more) more.addEventListener('click', () => search(S.q, S.page + 1));
  }

  // A cover that fails to load becomes the empty placeholder box.
  function coverFallback(root) {
    root.querySelectorAll('img.nh-rq-cover').forEach((img) => img.addEventListener('error', () => {
      const d = document.createElement('div'); d.className = 'nh-rq-cover'; img.replaceWith(d);
    }, { once: true }));
  }

  // ---- Confirm step: fuzzy library check, then request ----
  function startConfirm(book) {
    S.confirm = { book, matches: null, error: '', sending: false, done: '' };
    render();
    const c = S.confirm;
    findInLibrary(book)
      .then((m) => { c.matches = m; })
      .catch(() => { c.matches = []; c.libError = true; })
      .then(() => { if (S.confirm === c) render(); });
  }

  function renderConfirm() {
    const c = S.confirm; const b = c.book;
    let h = `<div class="nh-rq-confirm"><div class="nh-rq-pick">
      ${b.coverArtUrl ? `<img class="nh-rq-cover" src="${esc(b.coverArtUrl)}" alt="">` : '<div class="nh-rq-cover"></div>'}
      <div class="nh-rq-info"><div class="nh-rq-t">${esc(b.title)}</div><div class="nh-rq-sub">${esc(subLine(b))}</div></div></div>`;
    if (c.done) {
      h += `<div class="nh-rq-msg">${esc(c.done)}</div><div class="nh-rq-btns"><button type="button" class="nh-rq-go nh-rq-back">Done</button></div></div>`;
      return h;
    }
    if (c.matches === null) {
      h += '<div class="nh-rq-msg">Checking your library for this book…</div>';
    } else if (c.matches.length) {
      h += '<div class="nh-rq-q">These books in your library look similar. Make sure it isn’t one of them:</div><div class="nh-rq-lib">';
      c.matches.forEach((m) => {
        const md = (m.item.media && m.item.media.metadata) || {};
        h += `<a class="nh-rq-row" href="${esc(itemHref(m.item.id))}" target="_blank" rel="noopener">
          <img class="nh-rq-cover" src="/api/items/${encodeURIComponent(m.item.id)}/cover?width=120" alt="" loading="lazy">
          <div class="nh-rq-info"><div class="nh-rq-t">${esc(md.title || '')}</div>
            <div class="nh-rq-sub">${esc(md.authorName || ((md.authors || []).map((a) => a.name).join(', ')))}${md.seriesName ? ' · ' + esc(md.seriesName) : ''}</div>
            <div class="nh-rq-score">${m.score >= 0.85 ? 'Very likely the same book' : 'Possible match'}</div></div></a>`;
      });
      h += '</div>';
    } else {
      h += `<div class="nh-rq-msg">${c.libError ? 'Could not search your library, so it was not checked.' : 'Nothing similar found in your library.'}</div>`;
    }
    if (c.error) h += `<div class="nh-rq-msg nh-rq-err">${esc(c.error)}</div>`;
    const ready = c.matches !== null && !c.sending;
    h += `<div class="nh-rq-btns"><button type="button" class="nh-rq-ghost nh-rq-back"${c.sending ? ' disabled' : ''}>Cancel</button>
      <button type="button" class="nh-rq-go nh-rq-send"${ready ? '' : ' disabled'}>${c.sending ? 'Requesting…' : (c.matches && c.matches.length ? 'Not in my library, request it' : 'Confirm request')}</button></div></div>`;
    return h;
  }

  function itemHref(id) {
    const base = (window.$nuxt && window.$nuxt.$router && window.$nuxt.$router.options && window.$nuxt.$router.options.base) || '/';
    return base.replace(/\/?$/, '/') + 'item/' + encodeURIComponent(id);
  }

  function wireConfirm(body) {
    const back = body.querySelector('.nh-rq-back');
    if (back) back.addEventListener('click', () => { S.confirm = null; render(); });
    const send = body.querySelector('.nh-rq-send');
    if (send) send.addEventListener('click', submit);
  }

  function submit() {
    const c = S.confirm; if (!c || c.sending) return;
    const b = c.book;
    c.sending = true; c.error = ''; render();
    const audiobook = { asin: b.asin, title: b.title, author: b.author };
    ['narrator', 'description', 'coverArtUrl', 'releaseDate'].forEach((k) => { if (b[k]) audiobook[k] = String(b[k]); });
    if (typeof b.durationMinutes === 'number') audiobook.durationMinutes = b.durationMinutes;
    fetch('/_nh/rmab/request', { method: 'POST', headers: authHeaders(true), credentials: 'include', body: JSON.stringify({ audiobook }) })
      .then((r) => r.json().catch(() => ({})).then((d) => ({ status: r.status, d })))
      .then(({ status, d }) => {
        if (S.confirm !== c) return;
        c.sending = false;
        if (status === 201) {
          b._nhRequested = true;
          const st = d && d.request && d.request.status;
          c.done = st === 'awaiting_approval' ? 'Requested. It will download once an admin approves it.' : 'Requested. ReadMeABook is on it.';
        } else if (status === 409) {
          b._nhRequested = true;
          c.done = (d && d.message) || 'Already requested or already in the library.';
        } else {
          c.error = ((d && d.message) || 'The request failed') + ' (' + status + ').';
        }
        render();
      })
      .catch(() => { if (S.confirm !== c) return; c.sending = false; c.error = 'Could not reach ReadMeABook.'; render(); });
  }

  // ---- Fuzzy library search ----
  // Candidates come from ABS's own search (title, the title's longest word, the
  // ASIN) plus every book by an author whose name matches; each is then scored
  // on normalized title and author similarity.
  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'at', 'by', 'with', 'from', 'book', 'novel', 'part', 'volume', 'vol', 'unabridged', 'abridged', 'edition']);
  function norm(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/\((?:un)?abridged\)|\[(?:un)?abridged\]/g, ' ').replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function baseTitle(t) {
    return norm(String(t || '').replace(/\s*[:(\[].*$/, '').replace(/,\s*(book|volume|vol\.?|part)\s+\w+\s*$/i, '')) || norm(t);
  }
  const words = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w));
  function bigrams(s) {
    const x = s.replace(/ /g, ''); const out = new Map();
    for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
    return out;
  }
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a); const B = bigrams(b);
    let inter = 0; let total = 0;
    A.forEach((n, g) => { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); });
    B.forEach((n) => { total += n; });
    return total ? (2 * inter) / total : 0;
  }
  function titleSim(qTitle, itemTitle, itemSub) {
    const qa = baseTitle(qTitle); const ia = baseTitle(itemTitle);
    const full = norm(itemTitle + ' ' + (itemSub || ''));
    let s = Math.max(dice(qa, ia), dice(norm(qTitle), full));
    const qw = words(qa); const iw = new Set(words(ia));
    if (qw.length && qw.every((w) => iw.has(w))) s = Math.max(s, 0.9);
    if (ia && qa && (ia.includes(qa) || qa.includes(ia)) && Math.min(qa.length, ia.length) >= 4) s = Math.max(s, 0.85);
    return s;
  }
  function authorSim(qAuthor, names) {
    const q = words(qAuthor).filter((w) => w.length > 1);
    if (!q.length || !names.length) return 0;
    let best = 0;
    names.forEach((n) => {
      const w = new Set(words(n));
      const shared = q.filter((x) => w.has(x)).length;
      best = Math.max(best, shared / Math.max(1, Math.min(q.length, w.size)), dice(norm(qAuthor), norm(n)) * 0.9);
    });
    return Math.min(1, best);
  }
  function itemAuthors(it) {
    const md = (it.media && it.media.metadata) || {};
    const list = (md.authors || []).map((a) => a.name).filter(Boolean);
    if (!list.length && md.authorName) list.push(...md.authorName.split(/,\s*|\s+&\s+/));
    return list;
  }

  let libsCache = null;
  function bookLibraries() {
    if (!libsCache) {
      libsCache = getJSON('/api/libraries').then((d) => ((d && d.libraries) || d || []).filter((l) => (l.mediaType || 'book') === 'book'));
      libsCache.catch(() => { libsCache = null; });
    }
    return libsCache;
  }

  function findInLibrary(book) {
    const title = baseTitle(book.title);
    const longest = words(title).sort((a, b) => b.length - a.length)[0] || '';
    const authorWords = words(book.author || '').filter((w) => w.length > 2);
    const lastName = authorWords[authorWords.length - 1] || '';
    const queries = [title, longest.length >= 4 && longest !== title ? longest : '', book.asin || '', lastName].filter(Boolean);
    const found = new Map(); // item id -> libraryItem
    const authorIds = new Set();
    return bookLibraries().then((libs) => Promise.all(libs.map((lib) => Promise.all(queries.map((q) =>
      getJSON('/api/libraries/' + lib.id + '/search?limit=25&q=' + encodeURIComponent(q))
        .then((d) => {
          ((d && d.book) || []).forEach((r) => { if (r.libraryItem) found.set(r.libraryItem.id, r.libraryItem); });
          ((d && d.series) || []).forEach((s) => (s.books || []).forEach((it) => found.set(it.id, it)));
          ((d && d.authors) || []).forEach((a) => { if (authorSim(book.author, [a.name]) >= 0.6) authorIds.add(a.id); });
        })
        .catch(() => {})
    )))))
      .then(() => Promise.all(Array.from(authorIds).slice(0, 6).map((id) =>
        getJSON('/api/authors/' + id + '?include=items')
          .then((a) => ((a && a.libraryItems) || []).forEach((it) => found.set(it.id, it)))
          .catch(() => {}))))
      .then(() => {
        const out = [];
        found.forEach((it) => {
          const md = (it.media && it.media.metadata) || {};
          const ts = titleSim(book.title, md.title || '', md.subtitle || '');
          const as = authorSim(book.author, itemAuthors(it));
          const asinHit = book.asin && md.asin && md.asin.toUpperCase() === book.asin.toUpperCase();
          const score = asinHit ? 1 : 0.75 * ts + 0.25 * as;
          if (asinHit || ts >= 0.75 || score >= 0.6) out.push({ item: it, score });
        });
        return out.sort((a, b) => b.score - a.score).slice(0, 6);
      });
  }

  // ---- Keep the button in place across Vue re-renders ----
  let queued = false;
  function queueTick() {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; try { placeButton(); } catch (e) {} }, 120);
  }
  try {
    new MutationObserver(queueTick).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(queueTick, 1500);
})();
