/* NanoHive ABS - hobesman fork customizations */

// Fork-only additions live here, not in the upstream theme files, so the daily
// upstream merge rarely conflicts. Injected after book-details.js by the
// '</html>' sub_filter in default.conf.template.

(function () {
  'use strict';

  // ==========================================
  // Readaloud badge: a speaker icon on the corner of the book page's Read
  // button when the item has an ebook file with "readaloud" in its filename.
  // Clicking it opens the read-along reader.
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
        cursor: pointer; transition: transform .15s ease;
    }
    #nh-readaloud-badge svg { width: 15px; height: 15px; }
    #nh-readaloud-badge:hover { transform: scale(1.15); }
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
  const cache = {}; // itemId -> readaloudFile() result, '' (none) or 'pending'

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

  // -> { name, ino, primary } for the readaloud ebook, or '' when there is none.
  function readaloudFile(item) {
    const files = [];
    ((item && item.libraryFiles) || []).forEach((f) => {
      if (f && f.fileType === 'ebook' && f.metadata) files.push({ name: f.metadata.filename || '', ino: f.ino });
    });
    const ef = item && item.media && item.media.ebookFile;
    if (ef && ef.metadata) files.push({ name: ef.metadata.filename || '', ino: ef.ino });
    const hit = files.find((f) => READALOUD_RE.test(f.name));
    if (!hit) return '';
    const md = (item.media && item.media.metadata) || {};
    return { name: hit.name, ino: hit.ino, primary: !!(ef && String(ef.ino) === String(hit.ino)),
      title: md.title || '', author: md.authorName || '' };
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
      badge.setAttribute('role', 'button');
      badge.tabIndex = 0;
      badge.innerHTML = SPEAKER_SVG;
      // It sits inside the Read button: its click opens the read-along reader
      // (theme/reader/readalong.js, loaded on first use), not ABS's reader.
      const go = (e) => {
        e.stopPropagation(); e.preventDefault();
        const f = cache[badge.dataset.item];
        if (!f || !f.ino) return;
        import('/_nh/reader/readalong.js')
          .then((m) => m.open({ itemId: badge.dataset.item, ino: f.ino, primary: f.primary, title: f.title, author: f.author }))
          .catch((er) => { console.error('[nh-readalong]', er); alert('Could not open the read-along reader.'); });
      };
      badge.addEventListener('click', go);
      badge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    }
    badge.dataset.item = itemId;
    badge.title = 'Read along (' + file.name + ')';
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
  // Request a book: a top-bar button opening a ReadMeABook search. Requesting a
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
      btn.innerHTML = ICON_PLUS + '<span class="nh-rq-btn-label">Request a book</span>';
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

(function () {
  'use strict';

  // ==========================================
  // Readaloud index for the Format filter ("Readaloud" value).
  // The shared list lives on the server (fork/nh-fork.js, /_nh/api/readaloud):
  // { itemId: { u: updatedAt, n: numFiles, r: 0|1 } }. When the Filter & Sort
  // menu downloads a library's item list, that same response is read here (no
  // extra download) and books the list doesn't know yet, or that changed since,
  // are sent to the server to be checked against ABS, 20 at a time.
  // enhancements.js asks window.__nhForkFormats(item) for extra format values
  // and re-renders when window.__nhForkSig() changes (two marked fork hooks).
  // ==========================================
  const BATCH = 20;
  const RA = { map: null, at: 0, sig: '', loading: null, queue: [], queued: new Set(), skip: new Set(), running: false, bumpTimer: null };

  window.__nhForkFormats = (li) => (RA.map && li && RA.map[li.id] && RA.map[li.id].r ? ['Readaloud'] : []);
  window.__nhForkSig = () => RA.sig;

  const token = () => (window.__nhFork && window.__nhFork.token()) || '';
  const headers = (json) => {
    const h = {}; const t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };

  // Re-render the filtered shelf, at most every 3 s while a build is running.
  function bump(now) {
    clearTimeout(RA.bumpTimer);
    const go = () => { RA.sig = String(Date.now()); };
    if (now) go(); else RA.bumpTimer = setTimeout(go, 3000);
  }

  // The shared index; re-read when older than a minute (other people's
  // checks land there too). Entries checked in this tab are kept on refresh.
  function loadIndex() {
    if (RA.loading && Date.now() - RA.at < 60000) return RA.loading;
    RA.at = Date.now();
    RA.loading = fetch('/_nh/api/readaloud', { headers: headers(false), credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => { RA.map = Object.assign((j && j.items) || {}, RA.mine); bump(true); return RA.map; })
      .catch(() => { RA.loading = null; return RA.map; });
    return RA.loading;
  }
  RA.mine = {};
  // Load it as soon as there is a session, so it is ready before the Filter &
  // sort panel is opened (the panel lists its values when it opens).
  (function early(tries) {
    if (token()) loadIndex();
    else if (tries < 40) setTimeout(() => early(tries + 1), 500);
  })(0);

  function stale(li, map) {
    const e = map[li.id];
    return !e || e.u !== li.updatedAt || (typeof li.numFiles === 'number' && e.n !== li.numFiles);
  }

  function onItemList(results) {
    loadIndex().then((map) => {
      if (!map) return;
      results.forEach((li) => {
        if (!li || !li.id || li.mediaType === 'podcast' || RA.queued.has(li.id) || RA.skip.has(li.id)) return;
        if (stale(li, map)) { RA.queued.add(li.id); RA.queue.push(li.id); }
      });
      run();
    });
  }

  async function check(ids) {
    const r = await fetch('/_nh/api/readaloud', { method: 'POST', headers: headers(true), credentials: 'include', body: JSON.stringify({ ids }) });
    if (!r.ok) throw Object.assign(new Error('readaloud check ' + r.status), { status: r.status });
    return ((await r.json()) || {}).items || {};
  }

  async function run() {
    if (RA.running) return;
    RA.running = true;
    try {
      while (RA.queue.length) {
        const ids = RA.queue.splice(0, BATCH);
        try {
          const got = await check(ids);
          Object.assign(RA.map, got); Object.assign(RA.mine, got);
        } catch (e) {
          if (e.status === 502 && ids.length > 1) {
            // ABS refused the batch (e.g. one book this user can't access): check one by one.
            for (const id of ids) {
              try { const got = await check([id]); Object.assign(RA.map, got); Object.assign(RA.mine, got); } catch (er) { RA.skip.add(id); }
            }
          } else {
            ids.forEach((id) => RA.queued.delete(id)); // network trouble: try again next time
            break;
          }
        }
        ids.forEach((id) => RA.queued.delete(id));
        bump(false);
        await new Promise((res) => setTimeout(res, 150)); // stay gentle on ABS
      }
    } finally {
      RA.running = false;
      bump(true);
    }
  }

  // Watch for the menu's full item-list download (items?limit=0).
  const LIST_RE = /\/api\/libraries\/[^/?#]+\/items\?(?:[^#]*&)?limit=0(?:&|$)/;
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (LIST_RE.test(url)) {
        p.then((res) => {
          if (!res || !res.ok) return;
          res.clone().json().then((j) => { if (j && Array.isArray(j.results)) onItemList(j.results); }).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };
})();

(function () {
  'use strict';

  // ==========================================
  // Search bar: close matches when there are few exact ones.
  // ABS's library search only finds the query as one exact substring, so a
  // missing word, a different word order or a typo finds nothing. When the
  // theme's global search (enhancements.js, nhGsRun) has fewer than MIN_EXACT
  // book hits, it calls window.__nhForkGsMore (a marked fork hook). This asks
  // ABS about each significant word on its own (and the first letters of long
  // words, so a typo later in the word still hits), scores what comes back
  // against the whole query and appends the good ones under "Similar matches".
  // Books also come in through a matching series (its books) or a matching
  // narrator (the books they read), with the reason shown under the author.
  // ==========================================
  const MIN_EXACT = 5;

  // The server adds similar matches to searches that find nothing (for the
  // apps; fork/nh-fork.js). This search bar does its own, with labels, so its
  // searches ask the server not to.
  const SEARCH_RE = /\/api\/libraries\/[^/?#]+\/search\?/;
  const fetch0 = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (SEARCH_RE.test(url)) {
        init = Object.assign({}, init);
        const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || undefined);
        h.set('X-NH-No-Fuzzy', '1');
        init.headers = h;
      }
    } catch (e) {}
    return fetch0.call(this, input, init);
  };
  const MAX_BOOKS = 8, MAX_OTHER = 4;
  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'at', 'by', 'with', 'from', 'de', 'la', 'le', 'el', 'der', 'die', 'das']);

  const norm = (s) => {
    s = String(s || '').toLowerCase();
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.replace(/[^a-z0-9]+/g, ' ').trim();
  };
  const words = (s) => norm(s).split(' ').filter(Boolean);

  // Edit distance, stopping early once it exceeds `max`.
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
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
  // How well one query word matches a word list: 1 exact or as a prefix of 3+
  // letters, 0.8 within one or two typos, else 0.
  function wordHit(q, list) {
    let best = 0;
    for (const w of list) {
      if (w === q) return 1;
      if (q.length >= 3 && w.startsWith(q)) best = Math.max(best, 0.95);
      else if (q.length >= 4) {
        const max = q.length >= 8 ? 2 : 1;
        if (lev(q, w, max) <= max) best = Math.max(best, 0.8);
        else if (w.length > q.length && lev(q, w.slice(0, q.length), max) <= max) best = Math.max(best, 0.7);
      }
    }
    return best;
  }
  function bigrams(s) {
    const x = s.replace(/ /g, ''); const m = new Map();
    for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  }
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0, tot = 0;
    A.forEach((n, g) => { tot += n; if (B.has(g)) inter += Math.min(n, B.get(g)); });
    B.forEach((n) => { tot += n; });
    return tot ? (2 * inter) / tot : 0;
  }
  // 0..1: share of the query's words found (fuzzily) in the text, plus how
  // alike the query and the main field are as a whole.
  function score(qWords, qNorm, main, extra) {
    const list = words(main + ' ' + (extra || ''));
    if (!qWords.length || !list.length) return 0;
    const cover = qWords.reduce((a, w) => a + wordHit(w, list), 0) / qWords.length;
    return 0.75 * cover + 0.25 * dice(qNorm, norm(main));
  }

  function queryTerms(qWords) {
    const sig = qWords.filter((w) => w.length >= 3 && !STOP.has(w)).sort((a, b) => b.length - a.length).slice(0, 3);
    const terms = [];
    // The word, plus its first letters so a typo later in the word still finds it.
    sig.forEach((w) => { terms.push(w); if (w.length >= 6) terms.push(w.slice(0, 4)); else if (w.length >= 4) terms.push(w.slice(0, 3)); });
    return Array.from(new Set(terms)).slice(0, 5);
  }

  window.__nhForkGsMore = function (q, exact, libs, tok) {
    if (!exact || exact.books.length >= MIN_EXACT || !libs || !libs.length) return Promise.resolve(null);
    // While this runs the panel says so (instead of a bare "No results").
    GS.awaiting = 0;
    GS.pending = q;
    refreshPanel();
    return findMore(q, exact, libs, tok).finally(() => {
      if (GS.pending === q) { GS.pending = null; refreshPanel(); }
    });
  };
  async function findMore(q, exact, libs, tok) {
    const qNorm = norm(q);
    const all = words(q);
    const qWords = all.filter((w) => !STOP.has(w)).length ? all.filter((w) => !STOP.has(w)) : all;
    const terms = queryTerms(all);
    if (!terms.length) return null;
    const h = { Authorization: 'Bearer ' + tok };
    const res = await Promise.all(libs.flatMap((lib) => terms.map((t) =>
      fetch('/api/libraries/' + lib.id + '/search?q=' + encodeURIComponent(t) + '&limit=25', { headers: h, credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((j) => ({ lib, j })))));

    // Candidates, keyed like the exact list (normalized title|author and names).
    const bookKey = (title, author) => norm(title) + '|' + norm(author);
    const have = {
      books: new Set(exact.books.map((b) => bookKey(b.title, b.author))),
      series: new Set(exact.series.map((s) => norm(s.name))),
      authors: new Set(exact.authors.map((a) => norm(a.name))),
    };
    const books = new Map(), series = new Map(), authors = new Map();
    // A book candidate; `via` (series or narrator match) scores it and is
    // shown next to the author so it is clear why the book is listed.
    // Books inside series results come without authors, so rows are also
    // tracked by item id: the same book from two paths is one row.
    const exactIds = new Set(exact.books.flatMap((b) => b.copies.map((c) => c.itemId)));
    const byItem = new Map();
    const addBook = (li, lib, via) => {
      if (!li || exactIds.has(li.id)) return;
      const md = (li.media && li.media.metadata) || {};
      const author = md.authorName || md.author || (md.authors || []).map((a) => a && a.name).filter(Boolean).join(', ');
      if (author && have.books.has(bookKey(md.title, author))) return;
      const sc = via ? via.s * 0.95
        : score(qWords, qNorm, (md.title || '') + ' ' + (md.subtitle || ''), author + ' ' + (md.seriesName || '') + ' ' + (md.narratorName || ''));
      let row = byItem.get(li.id) || (author && books.get(bookKey(md.title, author)));
      if (!row) {
        row = { title: md.title || '?', author: '', copies: [], _s: -1, _a: author, _via: '' };
        books.set(author ? bookKey(md.title, author) : 'id:' + li.id, row);
      }
      byItem.set(li.id, row);
      if (author && !row._a) row._a = author;
      if (sc > row._s) { row._s = sc; row._via = via ? via.note : ''; }
      row.author = [row._a, row._via].filter(Boolean).join(' · ');
      if (!row.copies.some((c) => c.itemId === li.id)) row.copies.push({ itemId: li.id, lib });
    };
    const narrators = new Map(); // normalized name -> { name, s, libs: Set }
    res.forEach(({ lib, j }) => {
      if (!j) return;
      (j.book || []).concat(j.podcast || []).forEach((b) => addBook(b.libraryItem, lib));
      (j.series || []).forEach((s) => {
        const se = s.series || s;
        if (!se || !se.name) return;
        const key = norm(se.name);
        const sc = have.series.has(key) ? 1 : score(qWords, qNorm, se.name);
        // The books of a matching series (also of one already listed as an exact hit).
        if (sc >= 0.6) (s.books || []).forEach((li) => addBook(li, lib, { s: sc, note: se.name }));
        if (have.series.has(key)) return;
        let row = series.get(key);
        if (!row) { row = { name: se.name, copies: [], _s: sc }; series.set(key, row); }
        if (!row.copies.some((c) => c.seriesId === se.id)) row.copies.push({ seriesId: se.id, lib });
      });
      (j.narrators || []).forEach((n) => {
        if (!n || !n.name) return;
        const key = norm(n.name);
        let row = narrators.get(key);
        if (!row) { row = { name: n.name, s: score(qWords, qNorm, n.name), libs: new Set() }; narrators.set(key, row); }
        row.libs.add(lib);
      });
      (j.authors || []).forEach((a) => {
        if (!a || !a.name) return;
        const key = norm(a.name);
        if (have.authors.has(key)) return;
        let row = authors.get(key);
        if (!row) { row = { name: a.name, copies: [], _s: score(qWords, qNorm, a.name) }; authors.set(key, row); }
        if (!row.copies.some((c) => c.authorId === a.id)) row.copies.push({ authorId: a.id, lib });
      });
    });
    // Books read by a matching narrator (ABS's search names narrators but not
    // their books; the library's narrator filter lists them).
    const b64 = (x) => btoa(unescape(encodeURIComponent(x)));
    const topNarrators = Array.from(narrators.values()).filter((n) => n.s >= 0.6).sort((a, b) => b.s - a.s).slice(0, 2);
    await Promise.all(topNarrators.flatMap((n) => Array.from(n.libs).map((lib) =>
      fetch('/api/libraries/' + lib.id + '/items?limit=6&filter=' + encodeURIComponent('narrators.' + b64(n.name)), { headers: h, credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((d) => ((d && d.results) || []).forEach((li) => addBook(li, lib, { s: n.s, note: 'read by ' + n.name }))))));

    // Keep the good ones: most of the words found, or very alike overall.
    const pick = (m, max) => Array.from(m.values()).filter((r) => r._s >= 0.6).sort((a, b) => b._s - a._s).slice(0, max);
    const more = {
      books: pick(books, Math.max(0, MAX_BOOKS - exact.books.length)),
      series: pick(series, MAX_OTHER),
      authors: pick(authors, MAX_OTHER),
    };
    if (!more.books.length && !more.series.length && !more.authors.length) return null;
    // Tell the panel decorator below where the close matches start.
    GS.split = { books: exact.books.length, series: exact.series.length, authors: exact.authors.length };
    GS.counts = { books: more.books.length, series: more.series.length, authors: more.authors.length };
    return { books: exact.books.concat(more.books), series: exact.series.concat(more.series), authors: exact.authors.concat(more.authors) };
  }

  // Label the close matches in the results panel: a "Similar matches" divider
  // in each section where they start. The panel is rebuilt on every render, so
  // this re-applies itself; GS.split is cleared when a new search starts.
  // awaiting: typed, the exact search hasn't answered yet (timestamp)
  const GS = { split: null, counts: null, pending: null, awaiting: 0 };
  const css = document.createElement('style');
  css.textContent = `
    #nh-gs-panel .nh-gs-similar { padding: 6px 14px 2px; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--nh-muted-2, #8a8075); opacity: .85; font-style: italic; }
  `;
  document.head.appendChild(css);
  function decorate(panel) {
    // Similar search still running: say so.
    const msg = panel.querySelector(':scope > .nh-gs-msg');
    const line = panel.querySelector('.nh-gs-pending');
    // The theme draws an empty result list during its typing pause, before
    // any search has run: that is "searching", not "no results".
    if (!GS.pending && GS.awaiting && Date.now() - GS.awaiting < 8000) {
      if (msg && !msg.dataset.nhOrig && !panel.querySelector('.nh-gs-row') && !/…$/.test(msg.textContent)) {
        msg.dataset.nhOrig = msg.textContent;
        msg.textContent = 'Searching…';
      }
      return;
    }
    if (GS.pending) {
      if (msg && !panel.querySelector('.nh-gs-row') && msg.textContent !== 'No exact matches. Searching for similar results…') {
        if (!msg.dataset.nhOrig) msg.dataset.nhOrig = msg.textContent;
        msg.textContent = 'No exact matches. Searching for similar results…';
      } else if (!msg && !line) {
        const d = document.createElement('div');
        d.className = 'nh-gs-similar nh-gs-pending';
        d.textContent = 'Searching for similar matches…';
        panel.appendChild(d);
      }
    } else {
      if (msg && msg.dataset.nhOrig) { msg.textContent = msg.dataset.nhOrig; delete msg.dataset.nhOrig; }
      if (line) line.remove();
    }
    if (!GS.split || panel.querySelector('.nh-gs-simlabel')) return;
    const order = ['books', 'series', 'authors'].filter((k) => GS.split[k] + GS.counts[k] > 0);
    let sec = -1, inSec = 0;
    for (const el of Array.from(panel.children)) {
      if (el.classList.contains('nh-gs-head')) { sec++; inSec = 0; continue; }
      if (!el.classList.contains('nh-gs-row')) continue;
      const k = order[sec];
      if (k && GS.counts[k] && inSec === GS.split[k]) {
        const d = document.createElement('div');
        d.className = 'nh-gs-similar nh-gs-simlabel';
        d.textContent = GS.split[k] ? 'Similar matches' : 'No exact matches. Similar:';
        el.before(d);
      }
      inSec++;
    }
  }
  function refreshPanel() {
    const panel = document.getElementById('nh-gs-panel');
    if (panel) decorate(panel);
  }
  try {
    new MutationObserver(() => {
      const panel = document.getElementById('nh-gs-panel');
      if (panel) decorate(panel);
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  // A new search clears the labels until its own close matches arrive.
  document.addEventListener('input', (e) => {
    if (e.target && e.target.closest && e.target.closest('#appbar form[role="search"]')) {
      GS.split = null; GS.counts = null; GS.pending = null;
      GS.awaiting = (e.target.value || '').trim().length >= 2 ? Date.now() : 0;
    }
  }, true);
})();

(function () {
  'use strict';

  // ==========================================
  // Load-timing report (troubleshooting slow page loads). Off by default.
  // Turn on: open any NanoHive page with ?nhtiming=1 added to the address
  // (remembered in this browser; ?nhtiming=0 turns it off again), or in the
  // console: localStorage.setItem('nh-timing', '1'). Each page load and
  // navigation prints a report to the console and keeps it in
  // window.__nhTiming (copy(__nhTiming) copies it all).
  // ==========================================
  let on = false;
  try {
    const m = /[?&]nhtiming(?:=([01]))?(?:&|$)/.exec(location.search);
    if (m) {
      if (m[1] === '0') localStorage.removeItem('nh-timing');
      else localStorage.setItem('nh-timing', '1');
    }
    on = localStorage.getItem('nh-timing') === '1';
  } catch (e) {
    on = /[?&]nhtiming(?:=1)?(?:&|$)/.test(location.search); // storage blocked: this load only
  }
  if (!on) return;
  try { console.info('[NanoHive timing] on. Turn off with ?nhtiming=0'); } catch (e) {}

  const ms = (x) => Math.round(x);
  const reports = window.__nhTiming = [];
  let longTasks = 0, longTaskCount = 0;
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { longTasks += e.duration; longTaskCount++; }))
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}

  // When the theme's covers lift: the boot veil (html.nh-ready) and the page
  // mask (body.nh-page-ready / nh-series-ready).
  let nav = { kind: 'full load', path: location.pathname, start: 0, veil: null, page: null, resFrom: 0 };
  const seen = () => {
    const now = performance.now();
    if (nav.veil == null && document.documentElement.classList.contains('nh-ready')) nav.veil = now;
    const b = document.body;
    if (b && nav.page == null && (b.classList.contains('nh-page-ready') || b.classList.contains('nh-series-ready'))) {
      nav.page = now;
      const n = nav;
      setTimeout(() => report(n), 3000); // let trailing requests land
    }
  };
  new MutationObserver(seen).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
  // Page mask never lifts: report anyway after 10 s.
  setTimeout(() => { if (nav.page == null && nav.kind === 'full load') report(nav, true); }, 10000);

  // In-app navigations (ABS is a single-page app).
  const wrap = (k) => {
    const orig = history[k];
    history[k] = function () {
      const before = location.pathname;
      const r = orig.apply(this, arguments);
      // ABS adjusts the URL while it boots: still part of the full load.
      if (location.pathname !== before && nav.kind === 'full load' && nav.page == null) nav.path = location.pathname;
      else if (location.pathname !== before) {
        nav = { kind: 'in-app', path: location.pathname, start: performance.now(), veil: 'n/a', page: null, resFrom: performance.now() };
        setTimeout(() => { if (nav.page == null) { const n = nav; report(n, true); } }, 10000);
      }
      return r;
    };
  };
  wrap('pushState'); wrap('replaceState');

  function report(n, timedOut) {
    if (n.reported) return;
    n.reported = true;
    const out = { page: n.path, kind: n.kind };
    if (n.kind === 'full load') {
      const d = performance.getEntriesByType('navigation')[0];
      if (d) {
        out.htmlFirstByte = ms(d.responseStart);
        out.htmlDone = ms(d.responseEnd);
        out.htmlBytesOnWire = d.transferSize;
        out.htmlBytes = d.decodedBodySize;
        out.htmlCompressed = d.encodedBodySize > 0 && d.encodedBodySize < d.decodedBodySize * 0.8;
        out.domReady = ms(d.domContentLoadedEventEnd);
        out.loadEvent = ms(d.loadEventEnd);
      }
      out.veilLifted = n.veil == null ? 'not yet' : ms(n.veil);
    }
    out.pageShown = n.page == null ? (timedOut ? 'NOT within 10 s' : 'not yet') : ms(n.page - n.start);
    out.longTasksMs = ms(longTasks);
    out.longTaskCount = longTaskCount;
    const res = performance.getEntriesByType('resource').filter((r) => r.startTime >= n.resFrom);
    out.requests = res.length;
    out.slowest = res.slice().sort((a, b) => b.duration - a.duration).slice(0, 12).map((r) => ({
      url: r.name.replace(location.origin, '').slice(0, 110),
      startedAt: ms(r.startTime - n.start),
      took: ms(r.duration),
      kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024),
    }));
    reports.push(out);
    try {
      console.groupCollapsed('%c[NanoHive timing] ' + out.page + ' (' + out.kind + '): shown after ' + out.pageShown + ' ms', 'color:#e0c27a');
      const head = Object.assign({}, out); delete head.slowest;
      console.table(head);
      console.table(out.slowest);
      console.groupEnd();
    } catch (e) {}
  }
})();
