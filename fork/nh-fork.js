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

export default { readaloud };
