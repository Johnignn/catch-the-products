// Catch the Products – joc live pentru meeting (fără dependențe, doar Node.js)
// Pornire:  node server.js     (opțional: PORT=3000 HOST_KEY=parola DURATION=30 RULES=10 node server.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const QRCode = require('./lib/qrcode'), QRLevel = require('./lib/qrcode/QRErrorCorrectLevel');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'start2026';
const DURATION = +(process.env.DURATION || 30);          // secunde de joc
const COUNTDOWN = +(process.env.RULES || 10) * 1000;     // ms cu regulile pe ecran
const GRACE = 3000;                                      // ms acceptare scoruri finale
const MAX_PER_SEC = 90;                                  // plafon anti-trișat (puncte/secundă)
const TOP_N = 100;                                       // câți jucători primește ecranul de host

let state = { phase: 'lobby', startAt: 0, endAt: 0, game: 0 };
const players = new Map();          // id -> {name, score, ts, joined}
const playerStreams = new Set(), hostStreams = new Set();
const history = [];                 // clasamentele rundelor terminate (cât timp serverul rulează)
let timers = [];

const now = () => Date.now();
const pub = () => ({ phase: state.phase, startAt: state.startAt, endAt: state.endAt, game: state.game, now: now(), count: players.size, duration: DURATION });
const board = () => [...players.values()]
  .sort((a, b) => b.score - a.score || (a.ts || Infinity) - (b.ts || Infinity))
  .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));

function sse(res, obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} }
function toPlayers() { const s = pub(); playerStreams.forEach(r => sse(r, s)); }
function hostState() {
  const recent = [...players.values()].sort((a, b) => b.joined - a.joined).slice(0, 60).map(p => p.name);
  return { ...pub(), top: board().slice(0, TOP_N), recent };
}
function toHosts() { const s = hostState(); hostStreams.forEach(r => sse(r, s)); }
setInterval(toHosts, 1000);
setInterval(() => { [...playerStreams, ...hostStreams].forEach(r => { try { r.write(': ping\n\n'); } catch (e) {} }); }, 15000);

function setPhase(p) { state.phase = p; toPlayers(); toHosts(); }

function startGame() {
  if (state.phase === 'countdown' || state.phase === 'playing') return;
  timers.forEach(clearTimeout); timers = [];
  players.forEach(p => { p.score = 0; p.ts = 0; });
  state.game++;
  state.startAt = now() + COUNTDOWN;
  state.endAt = state.startAt + DURATION * 1000;
  setPhase('countdown');
  timers.push(setTimeout(() => setPhase('playing'), COUNTDOWN));
  timers.push(setTimeout(() => {
    history.push({ game: state.game, at: new Date().toISOString(), board: board() });
    setPhase('ended');
  }, COUNTDOWN + DURATION * 1000 + GRACE));
}
function reset(clearPlayers) {
  timers.forEach(clearTimeout); timers = [];
  if (clearPlayers) players.clear(); else players.forEach(p => { p.score = 0; p.ts = 0; });
  state.startAt = state.endAt = 0;
  setPhase('lobby');
}

// ---------- QR code cu link-ul jocului ----------
function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/?$/, '/');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}/`;
}
function qrSvg(text) {
  const q = new QRCode(-1, QRLevel.M); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function cleanName(n) {
  n = String(n || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!n) return null;
  const taken = new Set([...players.values()].map(p => p.name.toLowerCase()));
  let name = n, i = 2;
  while (taken.has(name.toLowerCase())) name = `${n} (${i++})`;
  return name;
}
function body(req) {
  return new Promise(res => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 2000) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function file(res, f) {
  fs.readFile(path.join(__dirname, 'public', f), (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d);
  });
}
function stream(req, res, set, first) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  set.add(res); sse(res, first);
  req.on('close', () => set.delete(res));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  const isHost = u.searchParams.get('key') === HOST_KEY;

  if (req.method === 'GET' && p === '/ping') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && p === '/') return file(res, 'player.html');
  if (req.method === 'GET' && p === '/host') return file(res, 'host.html');            // parola se cere în pagină
  if (req.method === 'GET' && p === '/qr.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return res.end(qrSvg(publicUrl(req))); }
  if (req.method === 'GET' && p === '/qr') return file(res, 'qr.html');
  if (req.method === 'GET' && p === '/host/check') return json(res, isHost ? 200 : 403, { ok: isHost });
  if (req.method === 'GET' && p === '/events') return stream(req, res, playerStreams, pub());
  if (req.method === 'GET' && p === '/host/events') return isHost ? stream(req, res, hostStreams, hostState()) : (res.writeHead(403), res.end());

  if (req.method === 'GET' && p === '/host/results') {
    if (!isHost) return json(res, 403, {});
    const g = +u.searchParams.get('game');
    const h = g ? history.find(x => x.game === g) : history[history.length - 1];
    if (h) return json(res, 200, h);
    return json(res, 200, { game: state.game, at: new Date().toISOString(), board: board(), live: true });
  }

  if (req.method === 'POST' && p === '/join') {
    const b = await body(req);
    if (b.id && players.has(b.id)) return json(res, 200, { id: b.id, name: players.get(b.id).name });
    if (b.id && !b.name) return json(res, 404, { error: 'Sesiune expirată' });
    if (state.phase === 'countdown' || state.phase === 'playing') return json(res, 409, { error: 'Runda e în desfășurare. Intră la runda următoare!' });
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'Scrie un nume.' });
    const id = crypto.randomBytes(9).toString('hex');
    players.set(id, { name, score: 0, ts: 0, joined: now() });
    toPlayers();
    return json(res, 200, { id, name });
  }

  if (req.method === 'POST' && p === '/score') {
    const b = await body(req), pl = players.get(b.id);
    if (!pl || b.game !== state.game) return json(res, 400, { ok: false });
    const t = now();
    if (t < state.startAt || t > state.endAt + GRACE) return json(res, 409, { ok: false });
    const elapsed = (Math.min(t, state.endAt) - state.startAt) / 1000;
    const s = Math.max(0, Math.min(Math.round(elapsed * MAX_PER_SEC + 60), Math.round(+b.score || 0)));
    if (s !== pl.score) { pl.score = s; pl.ts = t; }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/me') {
    const pl = players.get(u.searchParams.get('id'));
    if (!pl) return json(res, 404, {});
    const all = board(), r = all.find(x => x.name === pl.name);
    return json(res, 200, { name: pl.name, score: pl.score, rank: r ? r.rank : null, total: all.length });
  }

  if (req.method === 'POST' && p.startsWith('/host/')) {
    if (!isHost) return json(res, 403, {});
    if (p === '/host/start') startGame();
    else if (p === '/host/reset') reset(false);
    else if (p === '/host/clear') reset(true);
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  console.log(`\n🎯 Catch the Products pornit`);
  console.log(`   Participanți:  http://localhost:${PORT}/`);
  console.log(`   Host (ecran):  http://localhost:${PORT}/host   (parola: ${HOST_KEY})\n`);
});
