// RT Systems Companion: the Pocket OS, running.
//
// This worker runs fengari (Lua in JavaScript, fengari.js) with
// rt/shim.lua -- a CraftOS for the phone -- and the real rt_pocket.lua on
// top. It holds the pocket's files (the release's, fetched from the relay
// as they're needed, under the phone's own, kept in IndexedDB), its
// timers, its one connection to the server (the relay's /phone) and its
// screen: 156 x 180 pixels in CC: Graphics' palette, sent to the page
// (app.js) as a picture after each event that changed it.
//
// From the page: {go: true}, {ev: [name, ...]} (taps, keys, typing),
//   {wake: true} (the app came back to the front).
// To the page:  {frame: RGBA buffer}, {state: "online" | "offline" | ...},
//   {keyboard: true | false}, {stopped: why}.
'use strict';
importScripts('fengari.js');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = self.fengari;

// (26 cells wide, as a pocket; as many rows as the page says fit)
const W = 26;
let H = 20, PW = W * 6, PH = H * 9;
let fb = new Uint8Array(PW * PH).fill(15);
const palette = new Uint8Array(256 * 3);
let mode = 0, dirty = true, L = null, stopped = null;
const text = [];        // mode 0: {t, f, b} per row
function sizeTo(rows) {
  H = Math.max(20, Math.min(40, rows | 0)); PH = H * 9;
  fb = new Uint8Array(PW * PH).fill(15);
  text.length = 0;
  for (let y = 0; y < H; y++) text.push({t: new Uint8Array(W).fill(32), f: '0'.repeat(W), b: 'f'.repeat(W)});
}
sizeTo(20);
const BASE16 = [0xF0F0F0, 0xF2B233, 0xE57FD8, 0x99B2F2, 0xDEDE6C, 0x7FCC19, 0xF2B2CC, 0x4C4C4C,
  0x999999, 0x4C99B2, 0xB266E5, 0x3366CC, 0x7F664C, 0x57A64E, 0xCC4C4C, 0x111111];
for (let i = 0; i < 256; i++) { const v = BASE16[i < 16 ? i : 15]; palette[i * 3] = v >> 16; palette[i * 3 + 1] = (v >> 8) & 255; palette[i * 3 + 2] = v & 255; }
const started = Date.now();

// ---------------------------------------------------------------- files
// The release's files: manifest.json lists them (path -> a fingerprint of
// what's in it: the file's address carries it, so an unchanged file stays
// saved on the phone from one release to the next); each is
// fetched once, as it's first read. The phone's own files (saved
// settings, the saved login, what the pocket's updater downloads) sit on
// top, in IndexedDB; a deleted one is a tombstone (null).
let manifest = {build: 0, files: {}};
const baseDirs = new Set(['']);
const fetched = new Map();
const mine = new Map();
let db = null;

function openDb() {
  return new Promise((res) => {
    const r = indexedDB.open('rt-companion', 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
      // (the app's own notes, apart from the pocket's files: which files a start reads)
      if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
}
function loadMine() {
  return new Promise((res) => {
    if (!db) return res();
    const tx = db.transaction('files', 'readonly');
    const st = tx.objectStore('files');
    const req = st.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { mine.set(c.key, c.value); c.continue(); } else res();
    };
    req.onerror = () => res();
  });
}
function keep(path, value) {
  mine.set(path, value);
  if (!db) return;
  try { db.transaction('files', 'readwrite').objectStore('files').put(value, path); } catch (e) { /* a full disk: kept for now */ }
}
const strip = (p) => p.replace(/^\/+/, '');
function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function isMineDir(p) { return mine.get(p + '/') === 'dir'; }
function exists(p) {
  if (p === '') return true;
  const m = mine.get(p);
  if (m === null) return false;
  if (m !== undefined || isMineDir(p)) return true;
  if (manifest.files[p] !== undefined || baseDirs.has(p)) return true;
  for (const k of mine.keys()) if (k.startsWith(p + '/') && mine.get(k) !== null) return true;
  return false;
}
function isDir(p) {
  if (p === '') return true;
  if (mine.get(p) === null) return false;
  if (isMineDir(p) || baseDirs.has(p)) return true;
  for (const k of mine.keys()) if (k.startsWith(p + '/') && mine.get(k) !== null) return true;
  return false;
}
// ---------------------------------------------------------------- a faster start
// The pocket reads a few dozen files as it starts. They're fetched
// several at once, ahead of being asked for: the ones the last start read
// (kept in the "meta" store), or on a first start the pocket's own and
// the handful of lib/ files every start needs. Only those: the rest still
// come one by one, when first read, so a new release costs no more data.
const SEED_LIB = ['updater', 'hires', 'hires_font', 'hires_palette', 'appstyle', 'motion', 'icons', 'pixels', 'gpsfix', 'sound', 'version', 'hires_icons'];
const readAtStart = new Set();
let startedAt = 0;
function metaGet(k) {
  return new Promise((res) => {
    if (!db || !db.objectStoreNames.contains('meta')) return res(null);
    try { const q = db.transaction('meta', 'readonly').objectStore('meta').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); }
  });
}
function metaPut(k, v) { try { if (db && db.objectStoreNames.contains('meta')) db.transaction('meta', 'readwrite').objectStore('meta').put(v, k); } catch (e) { /* only a speed-up */ } }
function fileUrl(p) {
  const v = typeof manifest.files[p] === 'string' ? manifest.files[p] : manifest.build;
  return 'pocket/' + p.split('/').map(encodeURIComponent).join('/') + '?v=' + v;
}
async function prefetch() {
  let want = await metaGet('startFiles');
  if (!Array.isArray(want) || !want.length) {
    want = Object.keys(manifest.files).filter((p) => p === 'rt_pocket.lua' || p.startsWith('pocket/') || SEED_LIB.some((n) => p === 'lib/' + n + '.lua'));
  }
  const queue = want.filter((p) => manifest.files[p] !== undefined && !fetched.has(p) && !(mine.get(p) instanceof Uint8Array));
  const one = async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        const r = await fetch(fileUrl(p));
        if (r.ok && !fetched.has(p)) fetched.set(p, new Uint8Array(await r.arrayBuffer()));
      } catch (e) { /* read() fetches it when asked */ }
    }
  };
  await Promise.all([one(), one(), one(), one(), one(), one()]);
  postMessage({prefetched: want.length});
}
// (what this start read, for the next: noted a minute in)
function noteStartRead(p) { if (startedAt && Date.now() - startedAt < 60000) readAtStart.add(p); }
setInterval(() => { if (startedAt && Date.now() - startedAt >= 60000 && readAtStart.size) { metaPut('startFiles', [...readAtStart]); readAtStart.clear(); startedAt = 0; } }, 5000);
function read(p) {
  const m = mine.get(p);
  if (m === null) return null;
  if (m instanceof Uint8Array) return m;
  if (manifest.files[p] === undefined) return null;
  noteStartRead(p);
  if (fetched.has(p)) return fetched.get(p);
  const x = new XMLHttpRequest();
  x.open('GET', fileUrl(p), false);
  x.responseType = 'arraybuffer';
  try { x.send(); } catch (e) { return null; }
  if (x.status !== 200) return null;
  const data = new Uint8Array(x.response);
  fetched.set(p, data);
  return data;
}
function list(p) {
  const out = new Set();
  const pre = p === '' ? '' : p + '/';
  const add = (k) => {
    if (!k.startsWith(pre)) return;
    const rest = k.slice(pre.length).replace(/\/$/, '');
    const name = rest.split('/')[0];
    if (name) out.add(name);
  };
  for (const k of Object.keys(manifest.files)) add(k);
  for (const d of baseDirs) add(d);
  for (const [k, v] of mine) if (v !== null) add(k);
  for (const name of [...out]) { const full = pre + name; if (mine.get(full) === null && !isDir(full)) out.delete(name); }
  return [...out];
}
function remove(p) {
  for (const k of [...Object.keys(manifest.files), ...mine.keys()]) {
    if (k === p || k.startsWith(p + '/')) keep(k.replace(/\/$/, ''), null);
  }
  if (isMineDir(p)) keep(p + '/', null);
}

// ---------------------------------------------------------------- the server, through the relay
let ws = null, wsOpen = false, outbox = [], backoff = 1000, retryTimer = null;
// (the app back on screen: reconnect now, not after the back-off wait)
function wake() {
  if (wsOpen || (ws && ws.readyState === 0)) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  backoff = 1000;
  connect();
}
function connect() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/phone';
  retryTimer = null;
  try { ws = new WebSocket(url); } catch (e) { retryTimer = setTimeout(connect, backoff); return; }
  ws.onopen = () => {
    wsOpen = true; backoff = 1000;
    postMessage({state: 'online'});
    for (const m of outbox.splice(0)) ws.send(m);
  };
  ws.onmessage = (e) => {
    let t = e.data;
    if (typeof t !== 'string') return;
    if (t.indexOf('"type":"rt_offline"') >= 0) { postMessage({state: 'offline'}); return; }
    if (t.indexOf('"type":"rt_online"') >= 0) { postMessage({state: 'online'}); return; }
    // (alerts: the page's own question, answered to the page)
    if (t.indexOf('"type":"push_result"') >= 0) { try { postMessage({pushResult: JSON.parse(t)}); } catch (err) { /* not for us */ } return; }
    // (every character past ASCII as \u00XX: each arrives as one byte)
    t = t.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    callLua('rt_message', [t]);
  };
  ws.onclose = () => {
    wsOpen = false; ws = null;
    postMessage({state: 'connecting'});
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

// ---------------------------------------------------------------- Lua
const timers = new Map();
function luaStr(L, i) { const s = lua.lua_tolstring(L, i); return s ? to_jsstring(s) : null; }
function luaBytes(L, i) { return lua.lua_tolstring(L, i); }
function reg(name, fn) { lua.lua_pushjsfunction(L, fn); lua.lua_setglobal(L, to_luastring(name)); }

function hostFns() {
  reg('host_fs', (L) => {
    const op = luaStr(L, 1);
    const p = strip(luaStr(L, 2) || '');
    switch (op) {
      case 'exists': lua.lua_pushboolean(L, exists(p)); return 1;
      case 'isDir': lua.lua_pushboolean(L, isDir(p)); return 1;
      case 'makeDir': { let d = p; while (d && !isDir(d)) { keep(d + '/', 'dir'); d = dirOf(d); } return 0; }
      case 'delete': remove(p); return 0;
      case 'list': lua.lua_pushstring(L, to_luastring(list(p).join('\n'))); return 1;
      case 'size': { const d = read(p); lua.lua_pushinteger(L, d ? d.length : 0); return 1; }
      case 'read': { const d = read(p); if (d) lua.lua_pushstring(L, d); else lua.lua_pushnil(L); return 1; }
      case 'write': {
        const data = luaBytes(L, 3) || new Uint8Array(0);
        let d = dirOf(p); while (d && !isDir(d)) { keep(d + '/', 'dir'); d = dirOf(d); }
        keep(p, new Uint8Array(data));
        return 0;
      }
      case 'find': {
        const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
        const all = new Set([...Object.keys(manifest.files), ...[...mine.keys()].filter((k) => mine.get(k) !== null)]);
        lua.lua_pushstring(L, to_luastring([...all].filter((k) => re.test(k)).join('\n')));
        return 1;
      }
    }
    return 0;
  });
  reg('host_send', (L) => {
    const s = luaStr(L, 1);
    if (wsOpen) ws.send(s); else { outbox.push(s); if (outbox.length > 50) outbox.shift(); }
    return 0;
  });
  reg('host_timer', (L) => {
    const id = lua.lua_tointeger(L, 1), secs = lua.lua_tonumber(L, 2);
    timers.set(id, setTimeout(() => { timers.delete(id); post(['timer', id]); }, Math.max(0, secs * 1000)));
    return 0;
  });
  reg('host_cancel', (L) => { const id = lua.lua_tointeger(L, 1); clearTimeout(timers.get(id)); timers.delete(id); return 0; });
  reg('host_draw', (L) => {
    const x0 = lua.lua_tointeger(L, 1), y0 = lua.lua_tointeger(L, 2);
    const n = lua.lua_rawlen(L, 3);
    for (let i = 1; i <= n; i++) {
      lua.lua_rawgeti(L, 3, i);
      const row = lua.lua_tolstring(L, -1);
      lua.lua_pop(L, 1);
      const y = y0 + i - 1;
      if (!row || y < 0 || y >= PH) continue;
      let a = 0, x = x0;
      if (x < 0) { a = -x; x = 0; }
      const len = Math.min(row.length - a, PW - x);
      if (len > 0) fb.set(row.subarray(a, a + len), y * PW + x);
    }
    dirty = true;
    return 0;
  });
  reg('host_palette', (L) => {
    const i = lua.lua_tointeger(L, 1);
    if (i >= 0 && i < 256) {
      palette[i * 3] = Math.round(lua.lua_tonumber(L, 2) * 255);
      palette[i * 3 + 1] = Math.round(lua.lua_tonumber(L, 3) * 255);
      palette[i * 3 + 2] = Math.round(lua.lua_tonumber(L, 4) * 255);
      dirty = true;
    }
    return 0;
  });
  reg('host_mode', (L) => { mode = lua.lua_tointeger(L, 1); dirty = true; return 0; });
  reg('host_text', (L) => {
    const y = lua.lua_tointeger(L, 1) - 1;
    if (y >= 0 && y < H) { text[y] = {t: luaBytes(L, 2), f: luaStr(L, 3), b: luaStr(L, 4)}; dirty = true; }
    return 0;
  });
  // (a number, not an integer: fengari's integers are 32-bit, and milliseconds since 1970 aren't)
  reg('host_sound', (L) => { postMessage({sound: [luaStr(L, 1), lua.lua_tonumber(L, 2), lua.lua_tonumber(L, 3)]}); return 0; });
  reg('host_size', (L) => { lua.lua_pushinteger(L, W); lua.lua_pushinteger(L, H); return 2; });
  // (this phone's own id: random, made once, kept with the pocket's files --
  // the server asks the player in game before a new phone may sign in)
  reg('host_device', (L) => {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    lua.lua_pushstring(L, to_luastring([...b].map((x) => x.toString(16).padStart(2, '0')).join('')));
    return 1;
  });
  // (what kind of phone, in a word or two, for the in-game notice: "An
  // iPhone wants to sign in as you")
  reg('host_kind', (L) => {
    const ua = String((self.navigator && navigator.userAgent) || '');
    const k = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) ? 'iPad'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : 'phone';
    lua.lua_pushstring(L, to_luastring(k));
    return 1;
  });
  reg('host_share', (L) => { try { postMessage({share: JSON.parse(luaStr(L, 1))}); } catch (e) { /* not ours */ } return 0; });
  reg('host_calendar', (L) => { try { postMessage({calendar: JSON.parse(luaStr(L, 1))}); } catch (e) { /* not an event */ } return 0; });
  reg('host_awake', (L) => { postMessage({awake: lua.lua_toboolean(L, 1)}); return 0; });
  let lastBadge = -1;
  reg('host_badge', (L) => { const n = lua.lua_tonumber(L, 1) | 0; if (n !== lastBadge) { lastBadge = n; postMessage({badge: n}); } return 0; });
  reg('host_epoch', (L) => { lua.lua_pushnumber(L, Date.now()); return 1; });
  reg('host_clock', (L) => { lua.lua_pushnumber(L, (Date.now() - started) / 1000); return 1; });
  reg('host_log', (L) => { console.log('[pocket]', luaStr(L, 1)); return 0; });
  reg('host_keyboard', (L) => { postMessage({keyboard: lua.lua_toboolean(L, 1)}); return 0; });
}

// a Lua global function, called with strings and numbers -> its first result
function callLua(name, args) {
  if (stopped) return;
  lua.lua_getglobal(L, to_luastring(name));
  for (const a of args) {
    if (typeof a === 'number') { if (Number.isInteger(a)) lua.lua_pushinteger(L, a); else lua.lua_pushnumber(L, a); }
    else if (typeof a === 'boolean') lua.lua_pushboolean(L, a);
    else if (a === null || a === undefined) lua.lua_pushnil(L);
    else lua.lua_pushstring(L, to_luastring(String(a)));
  }
  const st = lua.lua_pcall(L, args.length, 1, 0);
  let why = null;
  if (st !== 0) why = luaStr(L, -1);
  else if (!lua.lua_isnil(L, -1)) why = luaStr(L, -1);
  lua.lua_pop(L, 1);
  if (why) { stopped = why; postMessage({stopped: why}); }
  present();
}

// events come in faster than they're run: one at a time, in order
const pending = [];
let pumping = false;
function post(ev) { pending.push(ev); if (!pumping) { pumping = true; setTimeout(pump, 0); } }
function pump() {
  const until = Date.now() + 40;
  while (pending.length && Date.now() < until) callLua('rt_event', pending.shift());
  if (pending.length) setTimeout(pump, 0); else pumping = false;
}

// ---------------------------------------------------------------- the picture
let font = null;
function loadFont() {
  const src = read('lib/hires_font.lua');
  if (!src) return;
  const s = new TextDecoder('latin1').decode(src);
  const alpha = (s.match(/alphabet\s*=\s*"([^"]*)"/) || [])[1];
  const dataPart = s.slice(s.indexOf('data ='));
  const data = (dataPart.match(/"([^"]*)"/g) || []).map((q) => q.slice(1, -1)).join('');
  if (!alpha || !data) return;
  const val = {};
  for (let i = 0; i < alpha.length; i++) val[alpha.charCodeAt(i)] = i;
  font = {val, data};
}
function present() {
  if (!dirty) return;
  dirty = false;
  const rgba = new Uint8ClampedArray(PW * PH * 4);
  if (mode !== 0) {
    for (let i = 0, n = PW * PH; i < n; i++) {
      const c = fb[i] * 3, o = i * 4;
      rgba[o] = palette[c]; rgba[o + 1] = palette[c + 1]; rgba[o + 2] = palette[c + 2]; rgba[o + 3] = 255;
    }
  } else {
    if (!font) loadFont();
    for (let cy = 0; cy < H; cy++) {
      const row = text[cy];
      for (let cx = 0; cx < W; cx++) {
        const ch = row.t[cx] || 32;
        const f = parseInt(row.f[cx] || '0', 16), b = parseInt(row.b[cx] || 'f', 16);
        for (let r = 0; r < 9; r++) {
          const bits = font ? (font.val[font.data.charCodeAt(ch * 9 + r)] || 0) : 0;
          for (let c = 0; c < 6; c++) {
            const on = (bits >> (5 - c)) & 1;
            const p = (on ? f : b) * 3, o = ((cy * 9 + r) * PW + cx * 6 + c) * 4;
            rgba[o] = palette[p]; rgba[o + 1] = palette[p + 1]; rgba[o + 2] = palette[p + 2]; rgba[o + 3] = 255;
          }
        }
      }
    }
  }
  postMessage({frame: rgba.buffer, w: PW, h: PH}, [rgba.buffer]);
}

// ---------------------------------------------------------------- starting
let openLater = null;
// this phone's id, from the pocket's side (rt/shim.lua keeps it)
function phoneId() {
  if (!L || stopped) return null;
  lua.lua_getglobal(L, to_luastring('rt_phone_id'));
  if (lua.lua_pcall(L, 0, 1, 0) !== 0) { lua.lua_pop(L, 1); return null; }
  const id = luaStr(L, -1); lua.lua_pop(L, 1);
  return id;
}
onmessage = (e) => {
  const m = e.data;
  if (m.ev) post(m.ev);
  else if (m.wake) wake();
  else if (m.open) {
    // (an alert tapped: told to the pocket once it's running)
    if (L && !stopped) { callLua('rt_open', [m.open.kind, m.open.text, m.open.ref, !!m.open.link]); post(['rt_open_notice']); } else openLater = m.open;
  }
  else if (m.pushPause) {
    const msg = JSON.stringify({type: 'push_pause', resume: m.pushPause === 'resume' || undefined, until: m.pushPause === 'morning' ? 'morning' : undefined, _phone: phoneId()});
    if (wsOpen) ws.send(msg); else { outbox.push(msg); if (outbox.length > 50) outbox.shift(); }
  }
  else if (m.pushTest) {
    const msg = JSON.stringify({type: 'push_test', _phone: phoneId()});
    if (wsOpen) ws.send(msg); else { outbox.push(msg); if (outbox.length > 50) outbox.shift(); }
  }
  else if (m.push !== undefined) {
    // (alerts on or off: the page signed up with the phone's push service)
    const msg = JSON.stringify(m.push ? {type: 'push_subscribe', sub: m.push, only: m.only || undefined, groups: m.groups, tz: m.tz, keep: m.keep, _phone: phoneId()} : {type: 'push_unsubscribe', _phone: phoneId()});
    if (wsOpen) ws.send(msg); else { outbox.push(msg); if (outbox.length > 50) outbox.shift(); }
  }
  else if (m.go) { sizeTo(m.rows || 20); start(); }
};
async function start() {
  try {
    const r = await fetch('pocket/manifest.json', {cache: 'no-cache'});
    manifest = await r.json();
  } catch (e) { postMessage({stopped: 'The companion couldn\'t load its files.'}); return; }
  for (const p of Object.keys(manifest.files)) { let d = dirOf(p); while (d && !baseDirs.has(d)) { baseDirs.add(d); d = dirOf(d); } }
  db = await openDb();
  await loadMine();
  startedAt = Date.now();
  // (the start's files, several at once; the Lua below waits on the
  // first of them while the rest arrive)
  const ahead = prefetch();
  await Promise.race([ahead, new Promise((r) => setTimeout(r, 4000))]);
  L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  hostFns();
  // (CC has none of these)
  for (const g of ['collectgarbage', 'io']) { lua.lua_pushnil(L); lua.lua_setglobal(L, to_luastring(g)); }
  const shim = await (await fetch('rt/shim.lua?v=' + manifest.build)).text();
  if (lauxlib.luaL_loadbuffer(L, to_luastring(shim), null, to_luastring('@shim.lua')) !== 0 || lua.lua_pcall(L, 0, 0, 0) !== 0) {
    postMessage({stopped: 'shim: ' + luaStr(L, -1)}); return;
  }
  connect();
  postMessage({state: 'starting', build: manifest.build});
  callLua('rt_boot', []);
  if (openLater) { const o = openLater; openLater = null; callLua('rt_open', [o.kind, o.text, o.ref, !!o.link]); post(['rt_open_notice']); }
}
