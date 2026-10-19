/* TONYDocs Drive sync engine (Phase 5)
   Google popup OAuth (GIS token client) + bidirectional sync into a TONYDocs Drive folder.
   One Drive file per local file, matched by appProperties.tonydocsId.
   Docs/sheets/slides/folders sync as JSON, PDFs as raw bytes.
   Last-write-wins with local conflict copies. Drive-side deletes never delete local data.
   Token lives in memory only. HTTP layer takes an injectable fetch so tests can mock Drive. */
window.TONYDrive = (function () {
  'use strict';

  var FOLDER_NAME = 'TONYDocs';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var API = 'https://www.googleapis.com/drive/v3/files';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota';

  var CLIENT_KEY = 'tonydocs-drive-clientid';
  var ACCOUNT_KEY = 'tonydocs-drive-account';
  var TOKEN_KEY = 'tonydocs-drive-token';
  var AUTO_KEY = 'tonydocs-drive-auto';
  var META_KEY = 'tonydocs-drive-meta';
  var LAST_KEY = 'tonydocs-drive-last';

  var token = null;
  var tokenExp = 0;
  var email = '';
  /* Office-format provider (registered by app.js): {build(file)->{body,ctype,ext,mime}, parse(driveFile, bytes)->record}.
     When absent (or on build failure) sync falls back to readable HTML snapshots. */
  var contentProvider = null;
  function setContentProvider(p) {
    try {
      if (p && typeof p.build === 'function' && typeof p.parse === 'function') contentProvider = p;
      else contentProvider = null;
    } catch (e) { contentProvider = null; }
  }

  /* ---------- tiny storage ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function getClientId() { return (lsGet(CLIENT_KEY) || '').trim(); }
  function setClientId(v) { lsSet(CLIENT_KEY, String(v || '').trim()); }
  function getAuto() { return lsGet(AUTO_KEY) === '1'; }
  function setAuto(on) { lsSet(AUTO_KEY, on ? '1' : '0'); }
  function getAccount() { try { return JSON.parse(lsGet(ACCOUNT_KEY) || 'null'); } catch (e) { return null; } }
  function getProfile() { var p = getAccount(); return (p && typeof p === 'object') ? p : null; }
  /* Merge + persist the Google profile (photo/name/email). Old {email} records keep working. */
  function setProfile(p) {
    try {
      var cur = getProfile() || {};
      var merged = {
        email: String((p && p.email) || cur.email || ''),
        name: String((p && p.name) || cur.name || ''),
        photo: String((p && p.photo) || cur.photo || '')
      };
      lsSet(ACCOUNT_KEY, JSON.stringify(merged));
      if (merged.email) email = merged.email;
      return merged;
    } catch (e) { return null; }
  }
  /* Live account info + quota (needs a live session). */
  async function fetchAbout(fetchImpl) {
    if (!isConnected()) { var e = new Error('auth-expired'); e.driveAuth = true; throw e; }
    return driveAbout(token, fetchImpl);
  }
  function getLastSync() { var n = Number(lsGet(LAST_KEY) || 0); return isFinite(n) ? n : 0; }
  function setLastSync(t) { lsSet(LAST_KEY, String(t || 0)); }
  function kvFolder() {
    try {
      var r = window.root || globalThis.root;
      if (r && r.kv && r.kv.tonydocs) return r.kv.tonydocs;
    } catch (e) {}
    return null;
  }
  function normMeta(m) {
    m = (m && typeof m === 'object') ? m : {};
    if (!m.byId || typeof m.byId !== 'object') m.byId = {};
    if (!m.lastSyncAt) m.lastSyncAt = 0;
    return m;
  }
  async function loadMeta() {
    try {
      var f = kvFolder();
      if (f) { var m = await f.get('drive-meta'); if (m && typeof m === 'object') return normMeta(m); }
    } catch (e) {}
    try {
      var raw = lsGet(META_KEY);
      if (raw) return normMeta(JSON.parse(raw));
    } catch (e) {}
    return normMeta(null);
  }
  async function saveMeta(meta) {
    try { var f = kvFolder(); if (f) await f.set('drive-meta', meta); } catch (e) {}
    try { lsSet(META_KEY, JSON.stringify(meta)); } catch (e) {}
  }
  (function restoreEmail() {
    try {
      var a = getAccount();
      if (a && a.email) email = a.email;
    } catch (e) {}
  })();

  /* ---------- auth (popup via GIS) ---------- */
  var gisPromise = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve(true);
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; rej(new Error('gis-timeout')); } }, 20000);
      s.onload = function () { if (!done) { done = true; clearTimeout(timer); res(true); } };
      s.onerror = function () { if (!done) { done = true; clearTimeout(timer); gisPromise = null; rej(new Error('gis-load')); } };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  function requestToken(clientId, interactive, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function done(fn, arg) { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } }
      function fail(err) { done(reject, err); }
      function ok(resp) { done(resolve, resp); }
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('auth-timeout')); }
      }, timeoutMs || 180000);
      var tc;
      function detailStr(prefix, obj) {
        var parts = [prefix];
        try {
          if (obj) {
            ['error', 'error_description', 'message', 'type', 'code'].forEach(function (k) {
              if (obj[k] != null && String(obj[k])) parts.push(k + '=' + String(obj[k]));
            });
            var s = JSON.stringify(obj);
            if (s && s.length < 500) parts.push(s);
          }
        } catch (e) {}
        return parts.join(' ');
      }
      try {
        tc = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: function (resp) {
            if (resp && resp.access_token) ok(resp);
            else fail(new Error(detailStr('auth-denied', resp)));
          },
          error_callback: function (err) {
            fail(new Error(detailStr('auth-error', err)));
          }
        });
      } catch (e) { fail(new Error(detailStr('gis-init', e))); return; }
      try {
        tc.requestAccessToken({ prompt: interactive ? '' : 'none' });
      } catch (e) { fail(new Error(detailStr('popup-blocked', e))); }
    });
  }
  async function driveAbout(tok, fetchImpl) {
    var res = await gfetch(ABOUT, { token: tok, fetchImpl: fetchImpl });
    return res.json();
  }
  async function connect(opts) {
    opts = opts || {};
    var clientId = getClientId();
    if (!clientId) throw new Error('no-client-id');
    await loadGis();
    var resp = await requestToken(clientId, opts.interactive !== false);
    token = resp.access_token;
    tokenExp = Date.now() + ((Number(resp.expires_in) || 3600) * 1000);
    saveToken();
    var prof = { email: '', name: '', photo: '' };
    var quota = null;
    try {
      var about = await driveAbout(token, opts.fetchImpl);
      var u = (about && about.user) || {};
      prof.email = u.emailAddress || '';
      prof.name = u.displayName || '';
      prof.photo = u.photoLink || '';
      var sq = about && about.storageQuota;
      if (sq) quota = { limit: sq.limit != null ? Number(sq.limit) : null, usage: sq.usage != null ? Number(sq.usage) : 0 };
    } catch (e) {}
    if (prof.email) setProfile(prof);
    return { email: email, name: prof.name, photo: prof.photo, quota: quota };
  }
  function disconnect() {
    try {
      if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
        window.google.accounts.oauth2.revoke(token, function () {});
      }
    } catch (e) {}
    token = null;
    tokenExp = 0;
    lsDel(TOKEN_KEY);
  }
  function getToken() { return isConnected() ? token : null; }
  function saveToken() {
    try {
      if (token && tokenExp) lsSet(TOKEN_KEY, JSON.stringify({ t: token, exp: tokenExp }));
      else lsDel(TOKEN_KEY);
    } catch (e) {}
  }
  /* Restore a still-valid token saved on this device. No popup, no network. */
  function restore() {
    if (isConnected()) return true;
    try {
      var raw = lsGet(TOKEN_KEY);
      if (!raw) return false;
      var j = JSON.parse(raw);
      if (!j || !j.t || !j.exp || j.exp - 60000 <= Date.now()) { lsDel(TOKEN_KEY); return false; }
      token = j.t;
      tokenExp = j.exp;
      var a = getAccount();
      if (a && a.email) email = a.email;
      return true;
    } catch (e) { return false; }
  }
  function isConnected() { return !!token && Date.now() < tokenExp - 60000; }
  function getEmail() { return email; }
  function tokenSecsLeft() { return token ? Math.max(0, Math.round((tokenExp - Date.now()) / 1000)) : 0; }
  function isAuthError(e) { return !!e && (e.driveAuth === true || e.message === 'auth-expired'); }

  /* ---------- authed HTTP ---------- */
  async function gfetch(url, o) {
    o = o || {};
    var impl = o.fetchImpl || fetch;
    var headers = o.headers || {};
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    var res;
    try {
      res = await impl(url, { method: o.method || 'GET', headers: headers, body: o.body });
    } catch (e) {
      var ne = new Error('network');
      ne.driveNet = true;
      throw ne;
    }
    if (res.status === 401) {
      var ae = new Error('auth-expired');
      ae.driveAuth = true;
      ae.status = 401;
      throw ae;
    }
    if (!res.ok) {
      var err = new Error('drive-http-' + res.status);
      err.status = res.status;
      try { err.body = await res.text(); } catch (e) {}
      throw err;
    }
    return res;
  }
  function createClient(tok, fetchImpl) {
    function call(url, opts) {
      opts = opts || {};
      opts.token = tok;
      opts.fetchImpl = fetchImpl;
      return gfetch(url, opts);
    }
    return {
      async list(q) {
        var out = [], pageToken = null;
        for (var i = 0; i < 50; i++) {
          var url = API + '?q=' + encodeURIComponent(q) +
            '&fields=files(id,name,mimeType,parents,modifiedTime,createdTime,trashed,appProperties,size),nextPageToken&pageSize=1000' +
            (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
          var j = await (await call(url)).json();
          (j.files || []).forEach(function (f) { out.push(f); });
          pageToken = j.nextPageToken;
          if (!pageToken) break;
        }
        return out;
      },
      async createMeta(metaObj) {
        var res = await call(API + '?fields=id', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(metaObj)
        });
        return (await res.json()).id;
      },
      async uploadMedia(id, body, contentType) {
        await call(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media', {
          method: 'PATCH',
          headers: { 'Content-Type': contentType },
          body: body
        });
      },
      async getMeta(id) {
        var res = await call(API + '/' + encodeURIComponent(id) + '?fields=id,modifiedTime');
        return res.json();
      },
      async download(id) {
        return call(API + '/' + encodeURIComponent(id) + '?alt=media');
      },
      async patchMeta(id, patch) {
        var res = await call(API + '/' + encodeURIComponent(id) + '?fields=id,modifiedTime', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        });
        return res.json();
      },
      async trash(id) {
        await call(API + '/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashed: true })
        });
      },
      async about() {
        return (await call(ABOUT)).json();
      }
    };
  }

  /* ---------- serialization ---------- */
  var OFFICE_MIME = {
    doc: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    slide: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  var OFFICE_EXT = { doc: '.docx', sheet: '.xlsx', slide: '.pptx' };
  var KNOWN_EXT_RE = /\.(docx|xlsx|pptx|html?|json|pdf)$/i;
  /* Preferred Drive upload target for a file (office formats preview natively). */
  function officeTarget(f) {
    if (!f || (f.type !== 'doc' && f.type !== 'sheet' && f.type !== 'slide')) return null;
    var kind = f.type === 'doc' ? 'doc' : f.type === 'sheet' ? 'sheet' : 'slide';
    return { ext: OFFICE_EXT[kind], mime: OFFICE_MIME[kind] };
  }
  function baseNameFor(f) {
    var n = String((f && f.name) || 'Untitled').trim() || 'Untitled';
    return n.replace(KNOWN_EXT_RE, '');
  }
  function driveNameFor(f) {
    var n = String((f && f.name) || 'Untitled').trim() || 'Untitled';
    if (f.type === 'pdf' && !/\.pdf$/i.test(n)) n += '.pdf';
    // Docs/sheets/slides sync as real Office files so Drive previews them as
    // actual documents. The full-fidelity record is embedded inside for lossless sync.
    var t = officeTarget(f);
    if (t) {
      n = n.replace(KNOWN_EXT_RE, '');
      n += t.ext;
    }
    return n;
  }
  function stripDriveExt(n) {
    return String(n || '').replace(KNOWN_EXT_RE, '');
  }
  function appPropsFor(f) {
    return {
      tonydocsId: f.id,
      tonydocsType: f.type,
      tonydocsUpdatedAt: String(f.updatedAt || 0),
      tonydocsParent: f.parentId || '',
      tonydocsName: String(f.name || '')
    };
  }
  function recordToJson(f) {
    var rec = { id: f.id, name: f.name, type: f.type, parentId: f.parentId || null, createdAt: f.createdAt || 0, updatedAt: f.updatedAt || 0 };
    if (f.type === 'doc') rec.contentHTML = f.contentHTML || '';
    if (f.type === 'sheet' && f.grid) rec.grid = f.grid;
    if (f.type === 'slide' && f.deck) rec.deck = f.deck;
    return JSON.stringify({ kind: 'tonydocs-file-v1', file: rec });
  }
  function jsonToRecord(text) {
    return parseDriveContent(text);
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function rcAddr(r, c) {
    var n = c, s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s + (r + 1);
  }
  function sheetPreviewTable(grid) {
    var cells = (grid && grid.cells && typeof grid.cells === 'object') ? grid.cells : {};
    var keys = Object.keys(cells);
    if (!keys.length) return '<p><i>Empty spreadsheet.</i></p>';
    var maxR = 0, maxC = 0, seen = false;
    keys.forEach(function (k) {
      var m = /^([A-Z]+)(\d+)$/.exec(String(k).toUpperCase());
      if (!m) return;
      var letters = m[1], row = parseInt(m[2], 10) - 1, col = 0;
      for (var i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
      col -= 1;
      if (row < 0 || col < 0 || row > 199 || col > 51) return;
      seen = true;
      if (row > maxR) maxR = row;
      if (col > maxC) maxC = col;
    });
    if (!seen) return '<p><i>Empty spreadsheet.</i></p>';
    maxR = Math.min(maxR, 99);
    maxC = Math.min(maxC, 25);
    var h = '<table><tbody>';
    for (var r = 0; r <= maxR; r++) {
      h += '<tr>';
      for (var c = 0; c <= maxC; c++) {
        var cell = cells[rcAddr(r, c)] || cells[String.fromCharCode(65 + c) + (r + 1)];
        var raw = cell ? String(cell.raw == null ? '' : cell.raw) : '';
        h += '<td>' + escHtml(raw) + '</td>';
      }
      h += '</tr>';
    }
    return h + '</tbody></table><p style="color:#666;font-size:12px">Preview shows stored values. Open in TONYDocs for live formulas.</p>';
  }
  function slidePreviewBody(deck) {
    var slides = (deck && Array.isArray(deck.slides)) ? deck.slides : [];
    if (!slides.length) return '<p><i>Empty slideshow.</i></p>';
    return slides.map(function (s, i) {
      var t = s.title || 'Untitled';
      var inner = '<h2>' + t + '</h2>' + (s.sub || '') + (s.body || '');
      if (s.left || s.right) inner += '<div style="display:flex;gap:16px"><div style="flex:1">' + (s.left || '') + '</div><div style="flex:1">' + (s.right || '') + '</div></div>';
      return '<section style="border:1px solid #ccc;border-radius:8px;padding:16px;margin:16px 0"><div style="color:#666;font-size:12px">Slide ' + (i + 1) + '</div>' + inner + '</section>';
    }).join('');
  }
  /* Readable HTML snapshot with the lossless JSON record embedded.
     Drive previews this as a real document; sync restores from the embed. */
  function recordToHtml(f) {
    var rec = { id: f.id, name: f.name, type: f.type, parentId: f.parentId || null, createdAt: f.createdAt || 0, updatedAt: f.updatedAt || 0 };
    if (f.type === 'doc') rec.contentHTML = f.contentHTML || '';
    if (f.type === 'sheet' && f.grid) rec.grid = f.grid;
    if (f.type === 'slide' && f.deck) rec.deck = f.deck;
    var json = JSON.stringify({ kind: 'tonydocs-file-v1', file: rec });
    var safeJson = json.replace(/<\/script/gi, '<\\/script');
    var title = String(f.name || 'Untitled');
    var body = '';
    if (f.type === 'doc') body = rec.contentHTML || '<p><br></p>';
    else if (f.type === 'sheet') body = '<h1>' + escHtml(title) + '</h1>' + sheetPreviewTable(rec.grid);
    else if (f.type === 'slide') body = '<h1>' + escHtml(title) + '</h1>' + slidePreviewBody(rec.deck);
    else body = '<h1>' + escHtml(title) + '</h1>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      escHtml(title) + ' — TONYDocs</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:40px auto;padding:0 16px;color:#111;line-height:1.5}' +
      'table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #999;padding:6px 10px;vertical-align:top}' +
      'img{max-width:100%;height:auto}pre{background:#f4f4f4;padding:12px;overflow:auto;border-radius:8px}' +
      '.tony-note{background:#f1f5ff;border:1px solid #c9d6ff;border-radius:8px;padding:8px 12px;color:#33415e;font-size:12px;margin-bottom:20px}' +
      '</style></head><body><div class="tony-note">Readable preview of a TONYDocs file. Open it in TONYDocs to edit — sync restores it exactly.</div><main>' +
      body + '</main><script id="tonydocs-record" type="application/json">' + safeJson + '<\/script></body></html>';
  }
  /* Reads both formats: legacy raw-JSON files and current .html snapshots. */
  function parseDriveContent(text) {
    var s = String(text == null ? '' : text);
    var t = s.trim();
    if (t.charAt(0) === '{') {
      var j = JSON.parse(t);
      if (!j || j.kind !== 'tonydocs-file-v1' || !j.file) throw new Error('bad-record');
      if (!j.file.id || !j.file.type) throw new Error('bad-record');
      return j.file;
    }
    var m = s.match(/<script[^>]*id=["']tonydocs-record["'][^>]*>([\s\S]*?)<\/script\s*>/i);
    if (m) {
      var j2 = JSON.parse(m[1]);
      if (!j2 || j2.kind !== 'tonydocs-file-v1' || !j2.file) throw new Error('bad-record');
      if (!j2.file.id || !j2.file.type) throw new Error('bad-record');
      return j2.file;
    }
    throw new Error('bad-record');
  }
  function rid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
  }

  /* ---------- sync engine ---------- */
  async function syncAll(store, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var report = { pushed: [], pulled: [], conflicts: [], trashed: [], errors: [] };
    if (!opts.token) throw new Error('no-token');
    var client = createClient(opts.token, opts.fetchImpl);
    var files = store.files;
    var meta = normMeta(store.meta);
    store.meta = meta;
    function byId(id) {
      for (var i = 0; i < files.length; i++) if (files[i].id === id) return files[i];
      return null;
    }
    function heal(f) { if (store.heal) { try { store.heal(f); } catch (e) {} } }
    function uniqueName(name, parentId) {
      if (!store.nameTaken || !store.nameTaken(name, parentId)) return name;
      var base = name, i = 2;
      while (store.nameTaken(base + ' ' + i, parentId)) i++;
      return base + ' ' + i;
    }

    // 1. app folder
    log('Finding TONYDocs folder on Drive...');
    var roots = await client.list("mimeType='application/vnd.google-apps.folder' and name='" + FOLDER_NAME + "' and 'root' in parents and trashed=false");
    var rootId = null;
    for (var ri = 0; ri < roots.length; ri++) {
      if (roots[ri].appProperties && roots[ri].appProperties.tonydocsRoot === '1') { rootId = roots[ri].id; break; }
    }
    if (!rootId) {
      if (roots.length) { rootId = roots[0].id; log('Reusing existing TONYDocs folder.'); }
      else {
        rootId = await client.createMeta({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: ['root'], appProperties: { tonydocsRoot: '1' } });
        log('Created TONYDocs folder.');
      }
    }

    // 2. recursive listing
    async function listTree(folderId, out) {
      var kids = await client.list("'" + folderId + "' in parents and trashed=false");
      for (var i = 0; i < kids.length; i++) {
        out.push(kids[i]);
        if (kids[i].mimeType === 'application/vnd.google-apps.folder') await listTree(kids[i].id, out);
      }
      return out;
    }
    log('Listing Drive files...');
    var tree = await listTree(rootId, []);
    var driveByTonyId = {};
    var seenDriveIds = {};
    tree.forEach(function (d) {
      seenDriveIds[d.id] = true;
      var tid = d.appProperties && d.appProperties.tonydocsId;
      if (tid) driveByTonyId[tid] = d;
    });
    var localByDriveId = {};
    function rebuildReverse() {
      localByDriveId = {};
      Object.keys(meta.byId).forEach(function (lid) {
        var e = meta.byId[lid];
        if (e && e.driveId) localByDriveId[e.driveId] = lid;
      });
    }
    rebuildReverse();

    // adopt: local files whose Drive twin exists but was never linked
    files.forEach(function (f) {
      var e = meta.byId[f.id];
      if ((!e || !e.driveId) && driveByTonyId[f.id]) {
        meta.byId[f.id] = { driveId: driveByTonyId[f.id].id, driveModifiedTime: driveByTonyId[f.id].modifiedTime, localUpdatedAt: f.updatedAt || 0, name: f.name };
      }
    });
    rebuildReverse();

    var folderDriveCache = {};
    function driveFolderFor(localParentId) {
      if (!localParentId) return rootId;
      if (folderDriveCache[localParentId]) return folderDriveCache[localParentId];
      var e = meta.byId[localParentId];
      if (e && e.driveId && seenDriveIds[e.driveId]) { folderDriveCache[localParentId] = e.driveId; return e.driveId; }
      return null;
    }
    function localParentFor(driveParentId) {
      if (!driveParentId || driveParentId === rootId) return null;
      if (localByDriveId[driveParentId] !== undefined) return localByDriveId[driveParentId];
      return undefined;
    }
    async function contentFor(f) {
      if (f.type === 'pdf') {
        var bytes = (f.data && f.data.length) ? (f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)) : null;
        return { body: bytes, ctype: 'application/pdf', ext: '.pdf', mime: 'application/pdf' };
      }
      if (contentProvider) {
        try {
          var c = await contentProvider.build(f);
          if (c && c.body && c.ext && c.mime) return { body: c.body, ctype: c.ctype || c.mime, ext: c.ext, mime: c.mime };
        } catch (e) {}
      }
      return { body: recordToHtml(f), ctype: 'text/html; charset=utf-8', ext: '.html', mime: 'text/html' };
    }
    async function stampMeta(localId, driveId) {
      var fresh = null;
      try { fresh = await client.getMeta(driveId); } catch (e) { fresh = null; }
      var f = byId(localId);
      meta.byId[localId] = {
        driveId: driveId,
        driveModifiedTime: (fresh && fresh.modifiedTime) || null,
        localUpdatedAt: (f && f.updatedAt) || 0,
        driveGone: false,
        name: (f && f.name) || ''
      };
      rebuildReverse();
    }
    function driveChanged(df, me) {
      return !!(df && me && me.driveModifiedTime && df.modifiedTime && df.modifiedTime !== me.driveModifiedTime);
    }
    function localChanged(f, me) {
      return !me || me.localUpdatedAt == null || (f.updatedAt || 0) > me.localUpdatedAt;
    }

    // ---- folders: push first (parents before children) ----
    function folderDepth(f) {
      var d = 0, cur = f;
      while (cur && cur.parentId) { d++; cur = byId(cur.parentId); if (d > 50) break; }
      return d;
    }
    var folders = files.filter(function (f) { return f.type === 'folder'; })
      .sort(function (a, b) { return folderDepth(a) - folderDepth(b); });
    for (var fi = 0; fi < folders.length; fi++) {
      (function (fol) {
        var df = driveByTonyId[fol.id] || null;
        var me = meta.byId[fol.id] || null;
        if (me && me.driveId && !seenDriveIds[me.driveId] && !df) {
          me.driveGone = true; me.driveId = null; me.driveModifiedTime = null;
        }
        if (!df) {
          if (me && me.driveGone && !((fol.updatedAt || 0) > (me.localUpdatedAt || 0))) { me.localUpdatedAt = fol.updatedAt || 0; return; }
        }
      })(folders[fi]);
    }
    for (var fj = 0; fj < folders.length; fj++) {
      var fol = folders[fj];
      var df2 = driveByTonyId[fol.id] || null;
      var me2 = meta.byId[fol.id] || {};
      if (!df2) {
        var pid = driveFolderFor(fol.parentId) || rootId;
        var nid = await client.createMeta({ name: fol.name, mimeType: 'application/vnd.google-apps.folder', parents: [pid], appProperties: appPropsFor(fol) });
        driveByTonyId[fol.id] = { id: nid, name: fol.name, mimeType: 'application/vnd.google-apps.folder', parents: [pid], modifiedTime: null, appProperties: appPropsFor(fol) };
        seenDriveIds[nid] = true;
        folderDriveCache[fol.id] = nid;
        await stampMeta(fol.id, nid);
        report.pushed.push(fol.name);
        log('Uploaded folder ' + fol.name);
      } else {
        var lc = localChanged(fol, me2);
        var dc = driveChanged(df2, me2);
        var driveName = df2.name || '';
        if (lc && !dc) {
          if (driveName !== fol.name || JSON.stringify(df2.appProperties || {}) !== JSON.stringify(appPropsFor(fol))) {
            await client.patchMeta(df2.id, { name: fol.name, appProperties: appPropsFor(fol) });
          }
          await stampMeta(fol.id, df2.id);
          folderDriveCache[fol.id] = df2.id;
          report.pushed.push(fol.name);
          log('Updated folder ' + fol.name);
        } else if (!lc && dc) {
          fol.name = driveName || fol.name;
          fol.updatedAt = Date.parse(df2.modifiedTime) || fol.updatedAt || Date.now();
          var lp = localParentFor((df2.parents || [])[0]);
          if (lp !== undefined) fol.parentId = lp;
          await stampMeta(fol.id, df2.id);
          folderDriveCache[fol.id] = df2.id;
          report.pulled.push(fol.name);
          log('Downloaded folder rename ' + fol.name);
        } else if (lc && dc) {
          var driveMs = Date.parse(df2.modifiedTime) || 0;
          if ((fol.updatedAt || 0) >= driveMs) {
            await client.patchMeta(df2.id, { name: fol.name, appProperties: appPropsFor(fol) });
            await stampMeta(fol.id, df2.id);
            report.pushed.push(fol.name);
          } else {
            fol.name = driveName || fol.name;
            fol.updatedAt = driveMs || fol.updatedAt || Date.now();
            await stampMeta(fol.id, df2.id);
            report.pulled.push(fol.name);
          }
          folderDriveCache[fol.id] = df2.id;
          log('Resolved folder conflict on ' + fol.name);
          report.conflicts.push(fol.name);
        } else {
          folderDriveCache[fol.id] = df2.id;
          me2.driveModifiedTime = df2.modifiedTime;
          me2.localUpdatedAt = fol.updatedAt || 0;
          me2.name = fol.name;
        }
      }
    }
    // pull brand-new Drive folders (parents already first in tree order)
    for (var ti = 0; ti < tree.length; ti++) {
      (function (d) {
        if (d.mimeType !== 'application/vnd.google-apps.folder') return;
        var tid = d.appProperties && d.appProperties.tonydocsId;
        if (!tid || byId(tid)) return;
        // Locally deleted folders (still in drive-meta) go to the trash step,
        // never resurrect here — same rule as for files below.
        var knownDelF = meta.byId[tid];
        if (knownDelF && knownDelF.driveId) return;
        if (d.id === rootId) return;
        var lp = localParentFor((d.parents || [])[0]);
        if (lp === undefined) lp = null;
        var nm = uniqueName((d.appProperties && d.appProperties.tonydocsName) || d.name || 'Folder', lp);
        var rec = { id: tid, name: nm, type: 'folder', parentId: lp, createdAt: Date.parse(d.createdTime) || Date.now(), updatedAt: Date.parse(d.modifiedTime) || Date.now() };
        files.push(rec);
        heal(rec);
        meta.byId[tid] = { driveId: d.id, driveModifiedTime: d.modifiedTime, localUpdatedAt: rec.updatedAt, name: nm };
        localByDriveId[d.id] = tid;
        folderDriveCache[tid] = d.id;
        report.pulled.push(nm);
        log('Downloaded new folder ' + nm);
      })(tree[ti]);
    }

    // ---- files ----
    async function pushFile(f, existing) {
      var parentDrive = driveFolderFor(f.parentId) || rootId;
      var c = await contentFor(f);
      if (f.type === 'pdf' && !c.body) throw new Error('pdf-no-data:' + f.name);
      var upName = baseNameFor(f) + c.ext;
      if (!existing) {
        var created = await client.createMeta({
          name: upName,
          mimeType: c.mime,
          parents: [parentDrive],
          appProperties: appPropsFor(f)
        });
        await client.uploadMedia(created, c.body, c.ctype);
        driveByTonyId[f.id] = { id: created, modifiedTime: null };
        seenDriveIds[created] = true;
        await stampMeta(f.id, created);
      } else {
        // mimeType is included so legacy files migrate to the Office formats.
        var patch = { name: upName, mimeType: c.mime, appProperties: appPropsFor(f) };
        await client.patchMeta(existing.id, patch);
        await client.uploadMedia(existing.id, c.body, c.ctype);
        await stampMeta(f.id, existing.id);
      }
    }
    function conflictCopy(f) {
      var n = uniqueName(f.name + ' (conflict copy)', f.parentId);
      var cp = { id: rid(), name: n, type: f.type, parentId: f.parentId, createdAt: f.createdAt || Date.now(), updatedAt: Date.now() };
      if (f.type === 'doc') cp.contentHTML = f.contentHTML || '';
      if (f.type === 'sheet' && f.grid) cp.grid = JSON.parse(JSON.stringify(f.grid));
      if (f.type === 'slide' && f.deck) cp.deck = JSON.parse(JSON.stringify(f.deck));
      if (f.type === 'pdf' && f.data && f.data.length) {
        cp.data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
        cp.size = f.size || cp.data.length;
      }
      files.push(cp);
      heal(cp);
      return cp;
    }
    async function applyDrive(f, isNew, d) {
      var props = d.appProperties || {};
      var lp = localParentFor((d.parents || [])[0]);
      if (lp === undefined) lp = isNew ? null : f.parentId;
      var dtype = props.tonydocsType || f.type;
      if (dtype === 'pdf') {
        var buf = await (await client.download(d.id)).arrayBuffer();
        var bytes = new Uint8Array(buf);
        var nm = props.tonydocsName || String(d.name || 'PDF').replace(/\.pdf$/i, '');
        if (isNew) {
          var rec = { id: props.tonydocsId || rid(), name: uniqueName(nm, lp), type: 'pdf', parentId: lp, createdAt: Date.parse(d.createdTime) || Date.now(), updatedAt: Date.parse(d.modifiedTime) || Date.now(), size: bytes.length, data: bytes };
          files.push(rec);
          heal(rec);
          f = rec;
        } else {
          f.name = nm;
          f.parentId = lp;
          f.size = bytes.length;
          f.data = bytes;
          delete f.missing;
          f.updatedAt = Date.parse(d.modifiedTime) || f.updatedAt || Date.now();
        }
      } else {
        var rec2;
        if (contentProvider) {
          var buf = await (await client.download(d.id)).arrayBuffer();
          rec2 = await contentProvider.parse(d, buf instanceof Uint8Array ? buf : new Uint8Array(buf));
        } else {
          var text = await (await client.download(d.id)).text();
          rec2 = parseDriveContent(text);
        }
        if (isNew) {
          var nw = { id: rec2.id, name: uniqueName(rec2.name || 'Untitled', lp), type: rec2.type, parentId: lp, createdAt: rec2.createdAt || Date.now(), updatedAt: Date.parse(d.modifiedTime) || rec2.updatedAt || Date.now() };
          if (rec2.type === 'doc') nw.contentHTML = rec2.contentHTML || '';
          if (rec2.type === 'sheet') nw.grid = rec2.grid;
          if (rec2.type === 'slide') nw.deck = rec2.deck;
          files.push(nw);
          heal(nw);
          f = nw;
        } else {
          // Local names stay extensionless: "Test Docs" on Drive is "Test Docs.docx".
          // Embedded record is the source of truth; a Drive-side rename is detected
          // by comparing the stripped Drive name against the last-synced name.
          var driveBase = stripDriveExt(d.name);
          if (dtype !== 'pdf' && props.tonydocsName && driveBase === props.tonydocsName) f.name = rec2.name || f.name;
          else if (dtype !== 'pdf' && driveBase) f.name = driveBase;
          else f.name = rec2.name || f.name;
          f.parentId = lp;
          if (rec2.type === 'doc') f.contentHTML = rec2.contentHTML || '';
          if (rec2.type === 'sheet') { f.grid = rec2.grid; }
          if (rec2.type === 'slide') { f.deck = rec2.deck; }
          f.updatedAt = Date.parse(d.modifiedTime) || rec2.updatedAt || f.updatedAt || Date.now();
          heal(f);
        }
      }
      meta.byId[f.id] = { driveId: d.id, driveModifiedTime: d.modifiedTime, localUpdatedAt: f.updatedAt || 0, name: f.name };
      rebuildReverse();
      return f;
    }

    var dataFiles = files.filter(function (f) { return f.type !== 'folder'; });
    for (var qi = 0; qi < dataFiles.length; qi++) {
      var f = dataFiles[qi];
      var me = meta.byId[f.id] || {};
      var df = driveByTonyId[f.id] || null;
      if (!df && me.driveId && !seenDriveIds[me.driveId]) {
        me.driveGone = true; me.driveId = null; me.driveModifiedTime = null;
        meta.byId[f.id] = me;
      }
      if (!df) {
        if (me.driveGone && !((f.updatedAt || 0) > (me.localUpdatedAt || 0))) {
          me.localUpdatedAt = f.updatedAt || 0;
          meta.byId[f.id] = me;
          continue;
        }
        try {
          await pushFile(f, null);
          report.pushed.push(f.name);
          log('Uploaded ' + f.name);
        } catch (e) {
          report.errors.push(f.name + ': ' + (e.message || e));
          log('Failed ' + f.name + ' (' + (e.message || e) + ')');
        }
        continue;
      }
      var lcc = localChanged(f, me);
      var dcc = driveChanged(df, me);
      if (lcc && !dcc) {
        try {
          await pushFile(f, df);
          report.pushed.push(f.name);
          log('Uploaded ' + f.name);
        } catch (e) {
          report.errors.push(f.name + ': ' + (e.message || e));
          log('Failed ' + f.name + ' (' + (e.message || e) + ')');
        }
      } else if (!lcc && dcc) {
        try {
          await applyDrive(f, false, df);
          report.pulled.push(f.name);
          log('Downloaded ' + f.name);
        } catch (e) {
          report.errors.push(f.name + ': ' + (e.message || e));
          log('Failed ' + f.name + ' (' + (e.message || e) + ')');
        }
      } else if (lcc && dcc) {
        var driveMs = Date.parse(df.modifiedTime) || 0;
        if (Math.abs((f.updatedAt || 0) - driveMs) < 1000) {
          try {
            await pushFile(f, df);
            report.pushed.push(f.name);
          } catch (e) { report.errors.push(f.name + ': ' + (e.message || e)); }
        } else if ((f.updatedAt || 0) > driveMs) {
          try {
            await pushFile(f, df);
            report.pushed.push(f.name);
            log('Kept newer local ' + f.name);
          } catch (e) { report.errors.push(f.name + ': ' + (e.message || e)); }
        } else {
          try {
            conflictCopy(f);
            await applyDrive(f, false, df);
            report.conflicts.push(f.name);
            report.pulled.push(f.name);
            log('Conflict on ' + f.name + ' — kept Drive version, saved local as conflict copy');
          } catch (e) { report.errors.push(f.name + ': ' + (e.message || e)); }
        }
      } else {
        // Migrate legacy files (raw JSON, or interim HTML snapshots) to the
        // Office formats even when nothing changed. HTML-fallback files only
        // migrate once the provider is available, to avoid flip-flopping.
        var tgt = officeTarget(f);
        var dfName = String(df.name || '');
        var isLegacy = (df.mimeType && df.mimeType.indexOf('json') !== -1) || !KNOWN_EXT_RE.test(dfName);
        var isHtml = /\.html?$/i.test(dfName);
        var matchesTarget = !!tgt && dfName.toLowerCase().endsWith(tgt.ext) && df.mimeType === tgt.mime;
        var needsUpgrade = !!tgt && !matchesTarget && (isLegacy || (isHtml && !!contentProvider));
        if (needsUpgrade) {
          try {
            await pushFile(f, df);
            report.pushed.push(f.name);
            log('Upgraded preview for ' + f.name + ' (' + tgt.ext + ')');
          } catch (e) {
            report.errors.push(f.name + ': ' + (e.message || e));
            log('Failed ' + f.name + ' (' + (e.message || e) + ')');
          }
        } else {
          me.driveModifiedTime = df.modifiedTime;
          me.localUpdatedAt = f.updatedAt || 0;
          me.name = f.name;
          if (!me.driveId) me.driveId = df.id;
          meta.byId[f.id] = me;
        }
      }
    }
    // pull brand-new Drive files
    for (var pk = 0; pk < tree.length; pk++) {
      var dd = tree[pk];
      if (dd.mimeType === 'application/vnd.google-apps.folder') continue;
      var tidd = dd.appProperties && dd.appProperties.tonydocsId;
      if (!tidd || byId(tidd)) continue;
      // A Drive file we knew (drive-meta entry) but with no local record is a
      // local delete — it must fall through to the trash step below, never
      // resurrect here. Only truly unknown files (other devices) get pulled.
      var knownDel = meta.byId[tidd];
      if (knownDel && knownDel.driveId) continue;
      try {
        var made = await applyDrive({ id: tidd, type: (dd.appProperties && dd.appProperties.tonydocsType) || 'doc' }, true, dd);
        report.pulled.push(made.name);
        log('Downloaded new file ' + made.name);
      } catch (e) {
        report.errors.push((dd.name || 'file') + ': ' + (e.message || e));
        log('Failed download ' + (dd.name || 'file'));
      }
    }
    // deletions: local gone -> trash on Drive
    var trashTargets = [];
    Object.keys(meta.byId).forEach(function (lid) {
      var e = meta.byId[lid];
      if (e && e.driveId && !byId(lid)) trashTargets.push({ lid: lid, driveId: e.driveId, name: e.name || 'file' });
    });
    for (var di = 0; di < trashTargets.length; di++) {
      (function (t) {
        if (seenDriveIds[t.driveId]) {
          client.trash(t.driveId).then(function () {}, function () {});
          report.trashed.push(t.name);
          log('Trashed on Drive: ' + t.name);
        }
        delete meta.byId[t.lid];
      })(trashTargets[di]);
    }
    meta.lastSyncAt = Date.now();
    return report;
  }

  return {
    getClientId: getClientId,
    setClientId: setClientId,
    getAuto: getAuto,
    setAuto: setAuto,
    getAccount: getAccount,
    getProfile: getProfile,
    setProfile: setProfile,
    fetchAbout: fetchAbout,
    getLastSync: getLastSync,
    setLastSync: setLastSync,
    loadMeta: loadMeta,
    saveMeta: saveMeta,
    loadGis: loadGis,
    connect: connect,
    disconnect: disconnect,
    restore: restore,
    getToken: getToken,
    isConnected: isConnected,
    getEmail: getEmail,
    tokenSecsLeft: tokenSecsLeft,
    isAuthError: isAuthError,
    syncAll: syncAll,
    recordToJson: recordToJson,
    jsonToRecord: jsonToRecord,
    recordToHtml: recordToHtml,
    parseDriveContent: parseDriveContent,
    driveNameFor: driveNameFor,
    appPropsFor: appPropsFor,
    officeTarget: officeTarget,
    setContentProvider: setContentProvider,
    folderName: FOLDER_NAME,
    scope: SCOPE
  };
})();
