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
