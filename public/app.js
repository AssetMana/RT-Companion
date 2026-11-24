// RT Systems Companion: the page around the Pocket OS.
// The pocket itself runs in worker.js; this shows its screen (a pocket's
// 156 pixels wide, and as tall as the phone has room for, scaled up crisp
// to the phone's width), turns touches into its clicks, drags and
// releases (in the pocket's own pixels, as CC: Graphics gives them), the
// phone's keyboard into its typing, and its sounds into the speaker's.
'use strict';
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const kbd = document.getElementById('kbd');
const PW = 156;
let PH = 180, rows = 20;
let worker = null;

function setStatus(text, bad) { statusEl.textContent = text; statusEl.className = bad ? 'bad' : ''; }
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }

// ---------------------------------------------------------------- the size
// "tall" (to start with): as many rows as fit above the buttons, 20 to 40;
// "pocket": a pocket's own 20 -- every app exactly as in game
function fitRows() {
  if (store('rt-size') === 'pocket') return 20;
  const w = Math.min(window.innerWidth, 560);
  const scale = w / PW;
  const bar = document.getElementById('bar').getBoundingClientRect().height || 50;
  const top = parseFloat(getComputedStyle(document.getElementById('wrap')).paddingTop) || 0;
  const bottom = parseFloat(getComputedStyle(document.getElementById('wrap')).paddingBottom) || 0;
  const room = window.innerHeight - top - bottom - bar - 8;
  return Math.max(20, Math.min(40, Math.floor(room / (scale * 9))));
}
function sizeCanvas() {
  PH = rows * 9;
  canvas.height = PH;
  canvas.style.aspectRatio = PW + ' / ' + PH;
}

function start() {
  document.getElementById('stopped').style.display = 'none';
  setStatus('Starting...');
  rows = fitRows();
  sizeCanvas();
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.frame) {
      const px = new Uint8ClampedArray(m.frame);
      ctx.putImageData(new ImageData(px, m.w, m.h), 0, 0); window.__frames = (window.__frames || 0) + 1;
      topColor(px, m.w);
    }
    if (m.state === 'online') setStatus('');
    else if (m.state === 'offline') setStatus('The RT Systems server is offline. It comes back when the Minecraft server does.', true);
    else if (m.state === 'connecting') setStatus('Connecting...');
    if (m.sound) play(m.sound[0], m.sound[1], m.sound[2]);
    if (m.pushResult) alertsAnswered(m.pushResult);
    if (m.awake !== undefined) stayAwake(m.awake);
    if (m.calendar) askCalendar(m.calendar);
    if (m.share) askShare(m.share);
    if (typeof m.badge === 'number' && navigator.setAppBadge) (m.badge > 0 ? navigator.setAppBadge(m.badge) : navigator.clearAppBadge()).catch(() => {});
    if (m.stopped) {
      setStatus('');
      document.getElementById('why').textContent = 'The Pocket OS stopped: ' + m.stopped;
      document.getElementById('stopped').style.display = 'block';
    }
  };
  worker.postMessage({go: true, rows});
  // (opened by tapping an alert: the pocket opens on it)
  const h = /^#open=(.*)$/.exec(location.hash || '');
  // (a link -- shared, or from an alert opened cold: kept until after logging in)
  if (h) { try { const o = JSON.parse(decodeURIComponent(h[1])); o.link = true; worker.postMessage({open: o}); } catch (e) { /* not ours */ } history.replaceState(null, '', location.pathname); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.open && worker) worker.postMessage({open: e.data.open}); });
function send(ev) { if (worker) worker.postMessage({ev}); }
// (the phone's status bar takes the color of the pocket's top row, as an
// app's does: the band behind it, and the browser's own color on Android)
const band = document.getElementById('topband'), themeMeta = document.querySelector('meta[name="theme-color"]');
let lastTop = '';
function topColor(px, w) {
  const i = (w * 1 + (w >> 1)) * 4;
  const c = '#' + [px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  if (c === lastTop) return;
  lastTop = c;
  band.style.background = c;
  if (themeMeta) themeMeta.setAttribute('content', c);
  window.__top = c;
}

// ---------------------------------------------------------------- touches
// (in the pocket's pixels, 0-based, as CC: Graphics hands them to it)
function at(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) * PW / r.width), y = Math.floor((e.clientY - r.top) * PH / r.height);
  return [Math.max(0, Math.min(PW - 1, x)), Math.max(0, Math.min(PH - 1, y))];
}
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  unlockAudio();
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = at(e);
  down = {x, y};
  send(['mouse_click', 1, x, y]);
});
canvas.addEventListener('pointermove', (e) => {
  if (!down) return;
  const [x, y] = at(e);
  if (x === down.x && y === down.y) return;
  down = {x, y};
  send(['mouse_drag', 1, x, y]);
});
function release(e) {
  if (!down) return;
  const [x, y] = at(e);
  down = null;
  send(['mouse_up', 1, x, y]);
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
// (a mouse wheel, on a computer's browser: the pocket's scroll)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [x, y] = at(e);
  send(['mouse_scroll', e.deltaY > 0 ? 1 : -1, x, y]);
}, {passive: false});

// ---------------------------------------------------------------- typing
// A hidden text box takes the phone's keyboard; what's typed goes in as
// the pocket's char events, Return and Delete as its keys. While the
// keyboard is up the screen slides up by as much, so the bottom of the
// pocket -- where a message is typed -- stays in sight.
const KEY = {Enter: 28, Backspace: 14, Tab: 15, ArrowUp: 200, ArrowDown: 208, ArrowLeft: 203, ArrowRight: 205, Delete: 211, Home: 199, End: 207, Escape: 1};
function showKeyboard() { unlockAudio(); kbd.value = ''; kbd.focus(); }
const kbBtn = document.getElementById('kbBtn');
// (while the keyboard is up the button is Done: the keyboard goes; a
// press on it doesn't take the focus first, so the keyboard stays until then)
kbBtn.addEventListener('pointerdown', (e) => { if (document.activeElement === kbd) e.preventDefault(); });
kbBtn.addEventListener('click', () => { if (document.activeElement === kbd) kbd.blur(); else showKeyboard(); });
kbd.addEventListener('focus', () => { document.body.classList.add('typing'); kbBtn.textContent = 'Done'; });
kbd.addEventListener('blur', () => { document.body.classList.remove('typing'); kbBtn.textContent = 'Keyboard'; });
// Paste: the phone's clipboard into the pocket's text box, as CC's own
// paste (one line; the phone asks the first time)
const pasteBtn = document.getElementById('pasteBtn');
pasteBtn.addEventListener('pointerdown', (e) => e.preventDefault());
pasteBtn.addEventListener('click', async () => {
  try {
    const t = (await navigator.clipboard.readText() || '').split(/\r?\n/)[0];
    let s = '';
    for (const ch of t) { const c = ch.charCodeAt(0); if (c >= 32 && c < 256) s += ch; }
    if (s) send(['paste', s.slice(0, 512)]);
  } catch (e) { note('The phone didn\'t allow pasting here.'); }
});
kbd.addEventListener('keydown', (e) => {
  if (KEY[e.key] !== undefined) { e.preventDefault(); send(['key', KEY[e.key], false]); send(['key_up', KEY[e.key]]); }
});
kbd.addEventListener('input', () => {
  const t = kbd.value;
  kbd.value = '';
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c < 256) send(['char', ch]);
  }
});
document.addEventListener('keydown', (e) => {
  if (document.activeElement === kbd) return;
  if (KEY[e.key] !== undefined) { e.preventDefault(); send(['key', KEY[e.key], false]); return; }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send(['char', e.key]);
});
function keyboardShift() {
  const vv = window.visualViewport;
  if (!vv) return;
  const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const r = canvas.getBoundingClientRect();
  // (only as far as needed: the screen's bottom just above the keyboard)
  const need = covered > 60 ? Math.max(0, r.height + (parseFloat(getComputedStyle(document.getElementById('wrap')).paddingTop) || 0) - (window.innerHeight - covered)) : 0;
  stage.style.transform = need > 0 ? 'translateY(' + (-need) + 'px)' : '';
}
if (window.visualViewport) { visualViewport.addEventListener('resize', keyboardShift); visualViewport.addEventListener('scroll', keyboardShift); }
kbd.addEventListener('blur', () => { stage.style.transform = ''; });

// ---------------------------------------------------------------- Back, Size
// (Back: the pocket's own gesture, a swipe in from the left edge)
document.getElementById('backBtn').addEventListener('click', () => {
  const y = Math.floor(PH / 2);
  send(['mouse_click', 1, 0, y]);
  send(['mouse_drag', 1, 30, y]);
  send(['mouse_drag', 1, 70, y]);
  send(['mouse_up', 1, 70, y]);
});
// (the phone's own Back -- Android's button or gesture -- is the pocket's
// Back too, not leaving the app: an entry in the history it can go back to)
function pocketBack() { document.getElementById('backBtn').click(); }
try { history.replaceState({rt: 'base'}, ''); history.pushState({rt: 'app'}, ''); } catch (e) { /* no history here */ }
window.addEventListener('popstate', () => { pocketBack(); try { history.pushState({rt: 'app'}, ''); } catch (e) { /* as above */ } });
// (Size: the phone's height, or a pocket's own -- the Pocket OS starts again)
function sizeLabel() { document.getElementById('sizeBtn').textContent = store('rt-size') === 'pocket' ? 'Phone size' : 'Pocket size'; }
document.getElementById('sizeBtn').addEventListener('click', () => {
  store('rt-size', store('rt-size') === 'pocket' ? 'tall' : 'pocket');
  sizeLabel();
  if (worker) worker.terminate();
  start();
});
sizeLabel();
document.getElementById('restart').addEventListener('click', () => { if (worker) worker.terminate(); start(); });

// ---------------------------------------------------------------- sounds
// The pocket asks for Minecraft's sounds by name (CC: Graphics); here
// they're made, short and simple: a note block's instruments at their
// pitch, and a few others by what they are.
let audio = null;
function unlockAudio() {
  if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; } }
  if (audio && audio.state === 'suspended') audio.resume();
}
const INSTR = {harp: ['triangle', 1, 0.5], bell: ['sine', 4, 1.2], chime: ['sine', 4, 1.0], pling: ['square', 1, 0.35], bit: ['square', 1, 0.25],
  bass: ['triangle', 0.25, 0.4], guitar: ['sawtooth', 0.5, 0.4], flute: ['sine', 2, 0.6], xylophone: ['triangle', 4, 0.3],
  iron_xylophone: ['triangle', 1, 0.5], cow_bell: ['square', 2, 0.3], didgeridoo: ['sawtooth', 0.25, 0.6], banjo: ['sawtooth', 1, 0.3]};
function tone(type, freq, vol, dur, when, slide) {
  const t = audio.currentTime + (when || 0);
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(vol, dur, low) {
  const n = Math.floor(audio.sampleRate * dur), b = audio.createBuffer(1, n, audio.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = audio.createBufferSource(), g = audio.createGain(), f = audio.createBiquadFilter();
  f.type = low ? 'lowpass' : 'highpass'; f.frequency.value = low ? 400 : 3000;
  s.buffer = b; g.gain.value = vol; s.connect(f); f.connect(g); g.connect(audio.destination); s.start();
}
function play(name, vol, pitch) {
  if (!audio || audio.state !== 'running') return;
  vol = Math.max(0, Math.min(1, vol || 0.6)) * 0.5; pitch = pitch || 1;
  const nb = /^block\.note_block\.(\w+)$/.exec(name);
  if (nb) {
    const inst = nb[1];
    if (inst === 'hat' || inst === 'snare') return noise(vol * 0.6, 0.06);
    if (inst === 'basedrum') return tone('sine', 90 * pitch, vol, 0.15, 0, 0.5);
    const [type, mult, dur] = INSTR[inst] || INSTR.harp;
    return tone(type, 369.99 * mult * pitch, vol, dur);   // (F#4: a note block's middle)
  }
  if (/levelup/.test(name)) { [0, 0.09, 0.18].forEach((w, i) => tone('triangle', 523 * pitch * [1, 1.26, 1.5][i], vol, 0.25, w)); return; }
  if (/experience_orb|pickup/.test(name)) return tone('triangle', 880 * pitch, vol, 0.12, 0, 1.5);
  if (/explode/.test(name)) return noise(vol, 0.5, true);
  if (/page_turn|place|hit|break|fall|splash|sweep/.test(name)) return noise(vol * 0.5, 0.08, /place|break|fall/.test(name));
  if (/click/.test(name)) return tone('square', 1200 * pitch, vol * 0.3, 0.03);
  tone('triangle', 600 * pitch, vol * 0.6, 0.12);
}

// ---------------------------------------------------------------- the phone's calendar
// An event from the pocket's Events: a card asks, and Add hands the phone
// an .ics file (its share sheet, or the file itself) -- the phone's
// Calendar takes it from there. Phones want a tap before they take a file.
const calSheet = document.getElementById('calSheet');
let calEvent = null;
function icsText(ev) {
  // (several: one calendar with each of them)
  if (Array.isArray(ev.events)) {
    const one = ev.events.map((e) => icsText(e).split('\r\n'));
    const body = one.map((lines) => lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT') + 1).join('\r\n'));
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RT Systems//RT Pocket//EN'].concat(body, ['END:VCALENDAR']).join('\r\n') + '\r\n';
  }
  const t = (s) => new Date(s * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
  const end = ev.finish && ev.finish > ev.start ? ev.finish : ev.start + 3600;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RT Systems//RT Pocket//EN', 'BEGIN:VEVENT',
    'UID:rt-event-' + (ev.id || ev.start) + '@' + location.host, 'DTSTAMP:' + t(Date.now() / 1000), 'DTSTART:' + t(ev.start), 'DTEND:' + t(end),
    'SUMMARY:' + esc(ev.title), ev.place ? 'LOCATION:' + esc(ev.place) : null, ev.desc ? 'DESCRIPTION:' + esc(ev.desc) : null,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(ev.title), 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n') + '\r\n';
}
window.__icsText = icsText; // (the tests)
function askCalendar(ev) {
  calEvent = ev;
  if (Array.isArray(ev.events)) {
    document.getElementById('calTitle').textContent = ev.events.length === 1 ? (ev.events[0].title || 'Event') : ev.events.length + ' events this week';
    document.getElementById('calWhen').textContent = ev.events.map((e) => e.title).slice(0, 3).join(', ') + (ev.events.length > 3 ? ', ...' : '');
    calSheet.style.display = 'block';
    return;
  }
  document.getElementById('calTitle').textContent = ev.title || 'Event';
  const d = new Date(ev.start * 1000);
  document.getElementById('calWhen').textContent = d.toLocaleString('en-US', {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
    + (ev.place ? ' \u00b7 ' + ev.place : '');
  calSheet.style.display = 'block';
}
window.__askCalendar = askCalendar; // (the tests)
document.getElementById('calCancel').addEventListener('click', () => { calSheet.style.display = 'none'; });
document.getElementById('calAdd').addEventListener('click', async () => {
  calSheet.style.display = 'none';
  if (!calEvent) return;
  const name = (calEvent.events ? 'my week' : (calEvent.title || 'event')).replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'event';
  const file = new File([icsText(calEvent)], name + '.ics', {type: 'text/calendar'});
  try {
    if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: calEvent.title}); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});

// ---------------------------------------------------------------- sharing
// An event from the pocket: a link that opens RT Pocket on it, through
// the phone's share sheet (or copied, where there's none). Phones want a
// tap before they share, so a card asks first.
const shareSheet = document.getElementById('shareSheet');
let shareWhat = null;
function shareUrl(s) { return location.origin + '/#open=' + encodeURIComponent(JSON.stringify(s.open)); }
function askShare(s) {
  shareWhat = s;
  document.getElementById('shareTitle').textContent = s.title || '';
  shareSheet.style.display = 'block';
}
window.__askShare = askShare; window.__shareUrl = shareUrl; // (the tests)
document.getElementById('shareCancel').addEventListener('click', () => { shareSheet.style.display = 'none'; });
document.getElementById('shareGo').addEventListener('click', async () => {
  shareSheet.style.display = 'none';
  if (!shareWhat) return;
  const url = shareUrl(shareWhat);
  try {
    if (navigator.share) { await navigator.share({title: shareWhat.title, text: shareWhat.text, url}); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText((shareWhat.text ? shareWhat.text + ' ' : '') + url); note('Link copied: paste it to a friend.'); }
  catch (e) { note('This phone couldn\'t share it.'); }
});

// ---------------------------------------------------------------- awake
// (a pocket game open: the screen stays on -- the phone dims it again
// when the game closes or the app goes to the background)
let wake = null, wantAwake = false;
async function stayAwake(on) {
  wantAwake = !!on;
  try {
    if (wantAwake && !wake && navigator.wakeLock && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!wantAwake && wake) { await wake.release(); wake = null; }
  } catch (e) { wake = null; }
  window.__awake = !!wake;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (wantAwake) stayAwake(true);
  // (back from another app: the link to the server again at once)
  if (worker) worker.postMessage({wake: true});
});

// ---------------------------------------------------------------- Alerts
// Notices when the app is closed: the phone's own push service brings
// them (the relay sends; the RT server says what, only while you're away
// from the game and the app). On an iPhone, only once it's on the Home
// Screen (iOS 16.4 or newer); the button shows only where they work.
const alertsBtn = document.getElementById('alertsBtn');
const canAlert = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let alertsWanted = null;
// (one word, so the buttons stay on one line: lit blue while they're on)
function alertsLabel() {
  const on = !!store('rt-alerts');
  // (paused for the hour: says so, and goes back by itself when it's up)
  const left = Number(store('rt-alerts-paused') || 0) - Date.now();
  alertsBtn.textContent = on && left > 0 ? 'Paused' : 'Alerts';
  if (on && left > 0) setTimeout(alertsLabel, Math.min(left + 500, 3600 * 1000 + 500)); alertsBtn.classList.toggle('on', on); alertsBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
function note(text) { setStatus(text); setTimeout(() => setStatus(''), 5000); }
function alertsAnswered(r) {
  // (paused for an hour, or going again)
  if (r.paused !== undefined) {
    store('rt-alerts-paused', r.paused ? String(r.pausedUntil * 1000) : null);
    alertsLabel();
    note(r.paused ? 'Alerts paused until ' + new Date(r.pausedUntil * 1000).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}) + '.' : 'Alerts back on.');
    return;
  }
  // (what the server has for this phone -- it may have been set in game)
  if (r.ok && r.only) {
    store('rt-alerts-mode', r.only === 'all' ? null : r.only);
    if (r.only === 'custom' && Array.isArray(r.groups)) store('rt-alerts-groups', JSON.stringify(r.groups));
    store('rt-alerts-paused', r.pauseEnds ? String(r.pauseEnds * 1000) : null);
  }
  if (r.test) { note(r.ok ? 'Test alert sent: it shows in a moment.' : (r.error || 'That didn\'t work.')); return; }
  if (alertsWanted === null) return;
  if (r.ok) {
    store('rt-alerts', alertsWanted ? store('rt-alerts') || 'on' : null);
    note(!alertsWanted ? 'Alerts off.' : store('rt-alerts-mode') === 'custom' ? 'Alerts on: the ones you ticked, while you\'re away.' : store('rt-alerts-mode') === 'chat' ? 'Alerts on: messages and mail come to this phone while you\'re away.' : 'Alerts on: your notices come to this phone while you\'re away.');
  }
  else { if (alertsWanted) store('rt-alerts', null); note(r.error || 'That didn\'t work.'); }
  alertsWanted = null;
  alertsLabel();
}
// (Custom alerts: the groups ticked, kept on the phone)
function ticked() { try { return JSON.parse(store('rt-alerts-groups') || '["chat","mail","money","events"]'); } catch (e) { return ['chat', 'mail']; } }
async function subscribe(quiet) {
  const reg = await navigator.serviceWorker.ready;
  const key = (await fetch('push-key', {cache: 'no-store'}).then((r) => r.json())).key;
  let sub = await reg.pushManager.getSubscription();
  // (the relay's key changed: sign up again with the new one)
  if (sub && store('rt-alerts') && store('rt-alerts') !== key) { await sub.unsubscribe(); sub = null; }
  if (!sub) {
    const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: raw});
  }
  store('rt-alerts', key);
  alertsWanted = quiet ? null : true;
  // (tz: the phone's own time zone, for the morning summary's hour)
  const mode = store('rt-alerts-mode');
  // (quiet: renewing at the start -- the server keeps what's set for this phone)
  if (worker) worker.postMessage({push: sub.toJSON(), only: mode === 'chat' || mode === 'custom' ? mode : null,
    groups: mode === 'custom' ? ticked() : undefined, tz: -new Date().getTimezoneOffset(), keep: quiet || undefined});
}
if (canAlert) {
  alertsBtn.style.display = '';
  alertsLabel();
  // (on: a menu -- everything, messages and mail only, or off)
  const menu = document.getElementById('alertsMenu');
  function menuShow(on) {
    menu.style.display = on ? 'block' : 'none';
    const paused = Number(store('rt-alerts-paused') || 0) > Date.now();
    document.getElementById('alertsPause').textContent = paused ? 'Resume alerts' : 'Pause for an hour';
    document.getElementById('alertsMorning').style.display = paused ? 'none' : '';
    for (const b of menu.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === (store('rt-alerts-mode') || 'all'));
  }
  // Custom: the groups ticked (kept on the phone; the server keeps them too)
  const GROUPS = [['chat', 'Messages'], ['mail', 'Mail'], ['money', 'Money'], ['events', 'Events'], ['market', 'Market'], ['friends', 'Friends'], ['games', 'Games']];
  const custom = document.getElementById('customSheet');
  function customShow() {
    const on = ticked();
    document.getElementById('groups').innerHTML = GROUPS.map(([id, label]) =>
      '<label><input type="checkbox" value="' + id + '"' + (on.includes(id) ? ' checked' : '') + '>' + label + '</label>').join('');
    custom.style.display = 'block';
  }
  async function turnOff() {
    alertsWanted = false;
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    store('rt-alerts', null);
    if (worker) worker.postMessage({push: null});
    alertsLabel();
  }
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    menuShow(false);
    try {
      if (b.dataset.mode === 'custom') { customShow(); return; }
      if (b.dataset.mode) { store('rt-alerts-mode', b.dataset.mode === 'chat' ? 'chat' : null); await subscribe(false); }
      else if (b.id === 'alertsOff') await turnOff();
      else if (b.id === 'alertsMorning') { if (worker) worker.postMessage({pushPause: 'morning'}); }
      else if (b.id === 'alertsPause') { if (worker) worker.postMessage({pushPause: Number(store('rt-alerts-paused') || 0) > Date.now() ? 'resume' : 'pause'}); }
      else if (b.id === 'alertsTest') { alertsWanted = null; if (worker) worker.postMessage({pushTest: true}); }
    } catch (err) { note('That didn\'t work here.'); }
  });
  document.getElementById('customCancel').addEventListener('click', () => { custom.style.display = 'none'; });
  document.getElementById('customSave').addEventListener('click', async () => {
    const on = [...document.querySelectorAll('#groups input:checked')].map((i) => i.value);
    custom.style.display = 'none';
    store('rt-alerts-groups', JSON.stringify(on));
    store('rt-alerts-mode', 'custom');
    try { await subscribe(false); } catch (e) { note('That didn\'t work here.'); }
  });
  window.__customShow = customShow; // (the tests)
  alertsBtn.addEventListener('click', async () => {
    try {
      if (store('rt-alerts')) { menuShow(true); return; }
      const ok = await Notification.requestPermission();
      if (ok !== 'granted') { note('Alerts are off in this phone\'s settings for this app.'); return; }
      await subscribe(false);
    } catch (e) { note('Alerts couldn\'t be turned on here.'); }
  });
  // (kept up to date with the server each start, once you're likely logged in)
  if (store('rt-alerts') && Notification.permission === 'granted') setTimeout(() => subscribe(true).catch(() => {}), 15000);
}

// ---------------------------------------------------------------- Add to Home Screen
// (once, in the phone's browser -- not once it's opened from the Home Screen)
(function hint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (standalone || !mobile || store('rt-hint') === 'seen') return;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  document.getElementById('hintText').textContent = ios
    ? 'Tap the Share button, then "Add to Home Screen". It opens full screen, like an app.'
    : 'Open the browser\'s menu (⋮), then "Add to Home screen" or "Install app". It opens full screen, like an app.';
  document.getElementById('hint').style.display = 'block';
  document.getElementById('hintOk').addEventListener('click', () => { store('rt-hint', 'seen'); document.getElementById('hint').style.display = 'none'; });
})();

// ---------------------------------------------------------------- opening fast
// (the app's files and the pocket's, kept on the phone: sw.js)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
