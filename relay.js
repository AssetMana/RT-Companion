#!/usr/bin/env node
// RT Systems Companion relay.
//
// Runs beside the Minecraft server (an AMP instance of its own: see
// companion/amp/), and does two things:
//   * serves the phone app (companion/public/) over HTTP -- Cloudflare
//     puts HTTPS in front of it;
//   * carries requests between phones and the RT Systems server. The RT
//     server connects OUT to /rt-link (CC's http.websocket) and proves it
//     is ours with the link key; each phone connects to /phone. A phone's
//     request goes down the link tagged with its session number, and the
//     answer comes back to that phone alone.
//
// It keeps nothing: no accounts, no passwords, no game data. Every rule
// (what a phone may ask, admin accounts in game only) is the RT server's
// own (systems/companion.lua), so a relay that misbehaved still couldn't
// reach an admin tool.
//
// No packages to install: Node 18 or newer, nothing else.
//
// Settings (environment variables; AMP's settings page sets them):
//   RT_PORT        port to listen on (default 8473)
//   RT_BIND        address to listen on (default 0.0.0.0)
//   RT_LINK_KEY    the link key from Admin > Companion (16+ characters)
//   RT_MAX_PHONES  phones at once (default 200)
//   RT_PER_IP      phones at once from one address (default 6)
//   RT_JOINS       new phone connections a minute from one address (default 20)
//   RT_CONTACT     a contact for phone alerts (mailto: or https:), told to
//                  the push services with each alert (default mailto:admin@localhost)
//   RT_DATA        where the relay keeps its alert keys (default: beside relay.js)
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.3.0';
const PORT = parseInt(process.env.RT_PORT || '8473', 10);
const BIND = process.env.RT_BIND || '0.0.0.0';
const LINK_KEY = process.env.RT_LINK_KEY || '';
const MAX_PHONES = parseInt(process.env.RT_MAX_PHONES || '200', 10);
const PER_IP = parseInt(process.env.RT_PER_IP || '6', 10);
const PUBLIC = path.join(__dirname, 'public');
const MAX_MSG = 64 * 1024;           // a phone's request, at most
const MAX_LINK_MSG = 1024 * 1024;    // the server's answers can be bigger
const RATE = 40;                      // a phone's requests a second, at most
const JOINS = parseInt(process.env.RT_JOINS || '20', 10);
const FLOOD_SECONDS = 3;              // a phone over RATE this many seconds running is closed

const CONTACT = process.env.RT_CONTACT || 'mailto:admin@localhost';
const DATA = process.env.RT_DATA || __dirname;

function log(...a) { console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a); }

// ---------------------------------------------------------------- websockets
// A small RFC 6455 server side: text frames, fragments, ping/pong, close.
function accept(req, socket, maxLen, onText, onClose) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const acceptKey = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n');
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), parts = [], partsLen = 0, closed = false;
  const conn = {
    alive: true,
    send(text) {
      if (closed) return;
      const data = Buffer.from(text, 'utf8');
      let head;
      if (data.length < 126) { head = Buffer.from([0x81, data.length]); }
      else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
      socket.write(Buffer.concat([head, data]));
    },
    ping() { if (!closed) socket.write(Buffer.from([0x89, 0])); },
    close(code) {
      if (closed) return;
      closed = true;
      const b = Buffer.alloc(4); b[0] = 0x88; b[1] = 2; b.writeUInt16BE(code || 1000, 2);
      try { socket.end(b); } catch (e) { /* gone already */ }
      onClose();
    },
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(maxLen)) { conn.close(1009); return; } len = Number(big); at = 10; }
      if (len > maxLen || partsLen + len > maxLen) { conn.close(1009); return; }
      if (buf.length < at + (masked ? 4 : 0) + len) return;
      let payload;
      if (masked) {
        const mask = buf.subarray(at, at + 4); at += 4;
        payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = buf[at + i] ^ mask[i & 3];
      } else payload = Buffer.from(buf.subarray(at, at + len));
      buf = buf.subarray(at + len);
      conn.alive = true;
      if (op === 0x8) { conn.close(1000); return; }
      if (op === 0x9) { // ping: pong
        const h = Buffer.from([0x8a, payload.length]);
        if (payload.length < 126) socket.write(Buffer.concat([h, payload]));
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0 || op === 0x2) {
        parts.push(payload); partsLen += payload.length;
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = []; partsLen = 0;
          try { onText(text); } catch (e) { log('message error:', e.message); }
        }
      }
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => { if (!closed) { closed = true; onClose(); } });
  return conn;
}

// ---------------------------------------------------------------- the link and the phones
let link = null;                  // the RT server's connection (once it said hello)
const parts = new Map();          // a big answer's pieces, by its number
const phones = new Map();         // sid -> {conn, ip, tokens, last}
const perIp = new Map();
let nextSid = 1;

// JSON with everything past ASCII escaped (\u00XX): CC's strings are bytes,
// and this way each byte arrives as itself at both ends
function out(x) { return JSON.stringify(x).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }

function sameKey(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- the hour's numbers (AMP's console)
const hour = {requests: 0, refused: 0, peak: 0, pushes: 0, pushFails: 0};
function summary() {
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  const line = 'past hour: ' + n(hour.requests, 'request', 'requests') + ', ' + hour.refused + ' refused, at most ' + n(hour.peak, 'phone', 'phones') +
    ' at once, ' + n(hour.pushes, 'alert', 'alerts') + ' sent' + (hour.pushFails ? ' (' + hour.pushFails + ' failed)' : '') + '; ' + (link ? 'linked' : 'NOT linked');
  Object.assign(hour, {requests: 0, refused: 0, peak: phones.size, pushes: 0, pushFails: 0});
  return line;
}
setInterval(() => log(summary()), 3600000).unref();

// ---------------------------------------------------------------- phone alerts (Web Push: RFC 8291 and 8292)
// The RT server says who gets what; the relay encrypts it for that phone
// and hands it to the phone's own push service (Apple's, Google's,
// Mozilla's). Its keys (VAPID) are made once and kept in vapid.json.
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
let vapid;
function vapidKeys() {
  if (vapid) return vapid;
  const file = path.join(DATA, 'vapid.json');
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); vapid = {priv: crypto.createPrivateKey({key: j.jwk, format: 'jwk'}), pub: j.pub}; return vapid; } catch (e) { /* made below */ }
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = publicKey.export({format: 'jwk'});
  const pub = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  try { fs.writeFileSync(file, JSON.stringify({jwk: privateKey.export({format: 'jwk'}), pub}), {mode: 0o600}); } catch (e) { log('could not keep the alert keys: ' + e.message); }
  vapid = {priv: privateKey, pub};
  return vapid;
}
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const PUSH_TEST = process.env.RT_PUSH_TEST_HOST || '';
function pushHostOk(u) {
  let x; try { x = new URL(u); } catch (e) { return false; }
  const h = x.hostname.toLowerCase();
  if (PUSH_TEST && x.host === PUSH_TEST) return true;
  return x.protocol === 'https:' && PUSH_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// the message, encrypted for one phone (aes128gcm, one record)
function encrypt(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPub.length;
  return Buffer.concat([head, asPub, body]);
}
function vapidHeader(endpoint) {
  const k = vapidKeys();
  const aud = new URL(endpoint).origin;
  const data = b64u(JSON.stringify({typ: 'JWT', alg: 'ES256'})) + '.' + b64u(JSON.stringify({aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT}));
  const sig = crypto.sign('sha256', Buffer.from(data), {key: k.priv, dsaEncoding: 'ieee-p1363'});
  return 'vapid t=' + data + '.' + b64u(sig) + ', k=' + k.pub;
}
async function sendPush(sub, payload) {
  if (!sub || typeof sub.endpoint !== 'string' || !pushHostOk(sub.endpoint) || !sub.keys) return;
  let status = 0;
  try {
    const res = await fetch(sub.endpoint, {method: 'POST', body: encrypt(sub, JSON.stringify(payload).slice(0, 3000)),
      headers: {'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': '3600', 'Urgency': 'normal', 'Authorization': vapidHeader(sub.endpoint)}});
    status = res.status;
  } catch (e) { status = -1; }
  if (status >= 200 && status < 300) { hour.pushes++; return; }
  hour.pushFails++;
  // (gone: the phone turned alerts off or was reset -- the RT server forgets it)
  if ((status === 404 || status === 410) && link) link.send(JSON.stringify({op: 'push_gone', endpoint: sub.endpoint}));
}

function onLink(req, socket) {
  let proven = false;
  const conn = accept(req, socket, MAX_LINK_MSG, (text) => {
    let t; try { t = JSON.parse(text); } catch (e) { return; }
    if (!proven) {
      if (t.op === 'hello' && LINK_KEY.length >= 16 && sameKey(t.key, LINK_KEY)) {
        proven = true;
        if (link && link !== conn) link.close(1000);
        link = conn;
        conn.send(JSON.stringify({op: 'hello', relay: VERSION}));
        log('RT server linked (build ' + t.build + ')');
        for (const p of phones.values()) p.conn.send(JSON.stringify({type: 'rt_online'}));
      } else { log('link refused: wrong key'); conn.close(1008); }
      return;
    }
    // (a big answer comes in pieces: put back together, then as one)
    if (t.op === 'part' && typeof t.data === 'string' && t.n > 1 && t.n < 2000) {
      const p = parts.get(t.id) || {got: 0, bits: new Array(t.n)};
      if (p.bits[t.i - 1] === undefined) { p.bits[t.i - 1] = t.data; p.got++; }
      parts.set(t.id, p);
      if (p.got < t.n) return;
      parts.delete(t.id);
      try { t = JSON.parse(p.bits.join('')); } catch (e) { return; }
    }
    if (t.op === 'push' && t.sub && t.payload) { sendPush(t.sub, t.payload); return; }
    if (t.op === 'res' && phones.has(t.sid) && t.msg && typeof t.msg === 'object') {
      if (t.msg.ok === false && t.msg.type === 'error') hour.refused++;
      phones.get(t.sid).conn.send(out(t.msg));
    }
  }, () => {
    if (link === conn) {
      link = null; parts.clear(); log('RT server link closed');
      for (const p of phones.values()) p.conn.send(JSON.stringify({type: 'rt_offline'}));
    }
  });
  // (it must say hello within ten seconds)
  setTimeout(() => { if (conn && !proven) conn.close(1008); }, 10000);
}

// (behind Cloudflare: the visitor's own address -- believed only when the
// connection comes from this machine or the home network, where
// cloudflared runs; anyone reaching the port directly can't pick one)
function trustedPeer(a) {
  a = String(a || '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd]/i.test(a);
}
function clientIp(req) {
  const peer = req.socket.remoteAddress || '?';
  const cf = req.headers['cf-connecting-ip'];
  return String(cf && trustedPeer(peer) ? cf : peer);
}

// (new phone connections a minute, per address: reconnecting over and
// over is refused for the rest of the minute)
const joins = new Map();
function tooManyJoins(ip) {
  const now = Date.now();
  let j = joins.get(ip);
  if (!j || now - j.at >= 60000) { j = {at: now, n: 0}; joins.set(ip, j); }
  return ++j.n > JOINS;
}
setInterval(() => { const now = Date.now(); for (const [ip, j] of joins) if (now - j.at >= 60000) joins.delete(ip); }, 60000).unref();

function onPhone(req, socket) {
  const ip = clientIp(req);
  if (phones.size >= MAX_PHONES || (perIp.get(ip) || 0) >= PER_IP || tooManyJoins(ip)) { socket.destroy(); return; }
  let sid = nextSid;
  while (phones.has(sid)) sid = sid % 999999 + 1;
  nextSid = sid % 999999 + 1;
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  let window = Date.now(), count = 0, overs = 0, flooded = false;
  const conn = accept(req, socket, MAX_MSG, (text) => {
    // (too fast: dropped; too fast for FLOOD_SECONDS running: closed)
    const now = Date.now();
    if (now - window >= 1000) { overs = count > RATE ? overs + 1 : 0; window = now; count = 0; }
    if (overs >= FLOOD_SECONDS) { if (!flooded) { flooded = true; log('phone closed: flooding (' + ip + ')'); conn.close(1008); } return; }
    if (++count > RATE) return;
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    hour.requests++;
    if (!link) { conn.send(JSON.stringify({type: 'error', ok: false, offline: true, error: 'The RT Systems server is offline.', _rid: msg._rid})); return; }
    link.send(out({op: 'req', sid, msg}));
  }, () => {
    phones.delete(sid);
    const n = (perIp.get(ip) || 1) - 1;
    if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    if (link) link.send(JSON.stringify({op: 'bye', sid}));
  });
  if (conn) { phones.set(sid, {conn, ip}); hour.peak = Math.max(hour.peak, phones.size); }
}

// ---------------------------------------------------------------- the phone app's files
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.lua': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.ico': 'image/x-icon'};

function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  // (the alert key the phone's browser needs to sign up for alerts)
  if (url.pathname === '/push-key') {
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify({key: vapidKeys().pub}));
    return;
  }
  if (url.pathname === '/healthz') {
    // (anyone: that it's up; with the link key in X-RT-Key -- the RT
    // server's Check sends it -- whether it's linked and how many phones)
    const full = LINK_KEY.length >= 16 && sameKey(req.headers['x-rt-key'] || '', LINK_KEY);
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(full ? {ok: true, linked: !!link, phones: phones.size, relay: VERSION} : {ok: true}));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type': 'text/plain'}); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // (the pocket's files carry their release in their address: kept a
      // year; the list of them, the page and sw.js: asked for each time)
      'Cache-Control': rel === '/index.html' || rel.endsWith('.webmanifest') || rel === '/sw.js' || rel === '/pocket/manifest.json' ? 'no-cache'
        : (rel.startsWith('/pocket/') && url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300'),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(data);
  });
}

const server = http.createServer(serve);
server.on('upgrade', (req, socket) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/rt-link') onLink(req, socket);
  else if (p === '/phone') onPhone(req, socket);
  else socket.destroy();
});

// (a ping every 30 seconds keeps Cloudflare from closing quiet connections;
// one that didn't answer the last is closed)
setInterval(() => {
  const all = [...phones.values()].map((p) => p.conn);
  if (link) all.push(link);
  for (const c of all) { if (!c.alive) { c.close(1001); continue; } c.alive = false; c.ping(); }
}, 30000).unref();

if (LINK_KEY.length < 16) log('WARNING: no link key set (RT_LINK_KEY, 16+ characters): the RT server cannot link yet.');
server.listen(PORT, BIND, () => log('RT Companion relay ' + VERSION + ' listening on ' + BIND + ':' + PORT));

function stop() { log('stopping'); for (const p of phones.values()) p.conn.close(1001); if (link) link.close(1001); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
module.exports = {server, summary, encrypt, vapidKeys};
