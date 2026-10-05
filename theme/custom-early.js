/* hobesman fork: request caches that must be in place before the theme starts.
 * Injected at the top of <head> (the '<head>' sub_filter in
 * default.conf.template), ahead of core.js and enhancements.js.
 * theme/custom.js loads at the very end of the page; on a big page the browser
 * can run enhancements.js's first ticks before it gets there, so a fetch
 * wrapper installed from custom.js could miss the theme's first requests
 * (seen in the field: the series badge request went straight to ABS on a
 * full load and held up ABS's own startup requests for 7 s).
 * Wrappers installed here sit innermost: core.js (auth sniffing) and
 * custom.js (Readaloud index watcher) see every request, cached or not. */

(function () {
  'use strict';

  // ==========================================
  // Series badge data: cached, and never fetched during page load.
  // The theme's series completion badge (enhancements.js, nhSpEnsureMap) asks
  // ABS for EVERY series with all its books (series?limit=100000&page=0) on
  // each full page load. On a big library that takes ABS seconds (and ABS
  // answers one thing at a time, so the requests the page needs to appear
  // wait behind it), and the browser then spends seconds parsing megabytes.
  // The badge only uses series id -> book ids, which rarely changes, so that
  // request is answered here from a slim per-library copy kept in this
  // browser; the copy is refreshed in the background once the page is showing,
  // at most every 6 hours. The first time (no copy yet) the request is held
  // until the page is showing, so the badges appear a moment later instead of
  // the whole page waiting for them.
  // ==========================================
  const RE = /\/api\/libraries\/([^/?#]+)\/series\?limit=100000&page=0$/;
  const TTL = 6 * 3600 * 1000;
  const key = (lib) => 'nh-spmap:' + lib;
  function readCache(lib) {
    try {
      const c = JSON.parse(localStorage.getItem(key(lib)) || 'null');
      return c && Array.isArray(c.results) ? c : null;
    } catch (e) { return null; }
  }
  function writeCache(lib, results) {
    try { localStorage.setItem(key(lib), JSON.stringify({ at: Date.now(), results })); } catch (e) {}
  }
  const slim = (d) => ((d && d.results) || []).filter((s) => s && s.id).map((s) => ({
    id: s.id,
    books: (s.books || []).map((b) => ({ id: b.id || b.libraryItemId })).filter((b) => b.id),
  }));
  const respond = (results) => new Response(JSON.stringify({ results, total: results.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  // Resolves once the theme has shown the page (or after 8 s regardless).
  function pageShown() {
    return new Promise((res) => {
      const ok = () => document.body && (document.body.classList.contains('nh-page-ready') || document.body.classList.contains('nh-series-ready'));
      if (ok()) return res();
      const t0 = Date.now();
      const iv = setInterval(() => { if (ok() || Date.now() - t0 > 8000) { clearInterval(iv); res(); } }, 200);
    });
  }
  const refreshing = {};
  function refresh(f0, input, init, lib) {
    if (!refreshing[lib]) {
      refreshing[lib] = pageShown()
        .then(() => f0(input, init))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('series ' + r.status))))
        .then((d) => { const s = slim(d); writeCache(lib, s); return s; })
        .finally(() => { delete refreshing[lib]; });
    }
    return refreshing[lib];
  }
  const f0 = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const m = RE.exec(url.split('#')[0]);
    if (!m) return f0.apply(this, arguments);
    const lib = m[1];
    const c = readCache(lib);
    if (c) {
      if (Date.now() - c.at > TTL) refresh(f0, input, init, lib).catch(() => {});
      return Promise.resolve(respond(c.results));
    }
    return refresh(f0, input, init, lib).then(respond);
  };
})();

(function () {
  'use strict';

  // ==========================================
  // Filter & sort: the library's book list, cached in this browser.
  // The panel needs the whole library's list (items?limit=0, or the series
  // list on the series page) before it can show anything, and the theme
  // forgets it whenever you leave the library page. On a big library ABS takes
  // seconds to produce it, so every return to the library meant a long wait.
  // The list is kept here (in memory, and in IndexedDB across reloads, per user
  // and per exact request), answered at once, and refreshed in the background:
  // when ABS reports a change (its live socket events), and otherwise when the
  // copy is over 2 minutes old as the panel asks for it, or over 10 minutes old
  // when it is loaded ahead. A fresher copy replaces the one on screen
  // (enhancements.js hook window.__nhForkLf.fresh). Once the page is showing,
  // the list is also loaded ahead (window.__nhForkLf.warm), so the panel opens
  // straight away even the first time.
  // Installed before the Readaloud index's watcher, which still sees every list.
  // ==========================================
  const RE = /\/api\/libraries\/[^/?#]+\/(?:items\?(?:[^#]*&)?limit=0(?:&|$)|series\?limit=100000&filter=)/;
  const AGE_OPEN = 2 * 60 * 1000;
  const AGE_AHEAD = 10 * 60 * 1000;
  const KEEP = 8; // stored lists (one per user + filter/sort combination)
  const DIR = 'nh-lfc-keys';
  const mem = {};
  const inflight = {};
  let dirtyAll = 0, dirtyProgress = 0;
  let ahead = false;

  const userId = () => {
    try { const u = window.$nuxt.$store.state.user.user; return (u && u.id) || ''; } catch (e) { return ''; }
  };
  const shown = () => document.body && (document.body.classList.contains('nh-page-ready') || document.body.classList.contains('nh-series-ready'));
  function pageShown() {
    return new Promise((res) => {
      if (shown()) return res();
      const t0 = Date.now();
      const iv = setInterval(() => { if (shown() || Date.now() - t0 > 8000) { clearInterval(iv); res(); } }, 200);
    });
  }

  // ---- IndexedDB (best effort: without it, the memory copy still works) ----
  let dbP = null;
  function db() {
    if (!dbP) {
      dbP = new Promise((res) => {
        try {
          const rq = indexedDB.open('nh-fork', 1);
          rq.onupgradeneeded = () => rq.result.createObjectStore('lists');
          rq.onsuccess = () => res(rq.result);
          rq.onerror = rq.onblocked = () => res(null);
        } catch (e) { res(null); }
      });
    }
    return dbP;
  }
  function store(mode, fn) {
    return db().then((d) => d && new Promise((res) => {
      try {
        const tx = d.transaction('lists', mode);
        const rq = fn(tx.objectStore('lists'));
        tx.oncomplete = () => res(rq ? rq.result : null);
        tx.onerror = tx.onabort = () => res(null);
      } catch (e) { res(null); }
    }));
  }
  function save(k, e) {
    store('readwrite', (s) => s.put(e, k));
    // Remember which lists are stored; drop the least recently used beyond KEEP.
    let dir = [];
    try { dir = JSON.parse(localStorage.getItem(DIR) || '[]'); } catch (er) {}
    dir = [k].concat(dir.filter((x) => x !== k));
    const gone = dir.slice(KEEP);
    try { localStorage.setItem(DIR, JSON.stringify(dir.slice(0, KEEP))); } catch (er) {}
    gone.forEach((g) => store('readwrite', (s) => s.delete(g)));
  }
  function lookup(k) {
    if (mem[k]) return Promise.resolve(mem[k]);
    return store('readonly', (s) => s.get(k)).then((e) => {
      if (e && typeof e.text === 'string' && !mem[k]) mem[k] = e;
      return mem[k] || null;
    });
  }

  // ---- ABS's live events mark the stored lists out of date ----
  (function socket(tries) {
    let s = null;
    try { s = window.$nuxt && window.$nuxt.$root && window.$nuxt.$root.socket; } catch (e) {}
    if (!s || typeof s.on !== 'function') { if (tries < 60) setTimeout(() => socket(tries + 1), 2000); return; }
    ['item_added', 'item_updated', 'item_removed', 'items_added', 'items_updated'].forEach((ev) => s.on(ev, () => { dirtyAll = Date.now(); }));
    // Progress only shapes lists filtered or sorted by it.
    s.on('user_item_progress_updated', () => { dirtyProgress = Date.now(); });
  })(0);
  const dirty = (k, e) => e.at < dirtyAll || (e.at < dirtyProgress && k.indexOf('progress') >= 0);

  const respond = (text) => new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });

  // One download per list at a time; resolves { text } or { res } (not ok).
  function load(f0, k, input, init) {
    if (!inflight[k]) {
      inflight[k] = f0(input, init).then((r) => {
        if (!r.ok) return { res: r };
        return r.text().then((text) => {
          const e = { text, at: Date.now() };
          mem[k] = e;
          save(k, e);
          return { text };
        });
      }).finally(() => { delete inflight[k]; });
    }
    return inflight[k];
  }
  function refresh(f0, k, url, input, init, old) {
    if (inflight[k]) return;
    pageShown().then(() => load(f0, k, input, init)).then((x) => {
      if (!x || x.text === undefined || x.text === old.text) return;
      const j = JSON.parse(x.text);
      if (j && Array.isArray(j.results) && window.__nhForkLf) window.__nhForkLf.fresh(url, j.results);
    }).catch(() => {});
  }

  const f0 = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    const uid = method === 'GET' && RE.test(url) ? userId() : '';
    if (!uid) return f0.apply(this, arguments);
    const k = uid + '|' + url.replace(/^https?:\/\/[^/]+/, '');
    const isAhead = ahead;
    return lookup(k).then((e) => {
      if (e) {
        if (dirty(k, e) || Date.now() - e.at > (isAhead ? AGE_AHEAD : AGE_OPEN)) refresh(f0, k, url, input, init, e);
        return respond(e.text);
      }
      return load(f0, k, input, init).then((x) => (x.text !== undefined ? respond(x.text) : x.res.clone()));
    });
  };

  // Load the list ahead once the library page is showing (also after in-app
  // navigation back to it). A no-op while the theme already holds it.
  setInterval(() => {
    if (!shown() || !/\/library\/[^/]+\/bookshelf(\/series)?\/?$/.test(location.pathname) || !window.__nhForkLf) return;
    ahead = true;
    try { window.__nhForkLf.warm(); } catch (e) {} finally { ahead = false; }
  }, 1500);
})();
