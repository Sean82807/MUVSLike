// HTTP 정적 파일 + WebSocket 게임 서버 (방 1개)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, DT } from './game.js';
import { TICK_RATE, SNAPSHOT_EVERY, CLASS_IDS, CLASSES, DEFAULT_SETTINGS } from '../shared/defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ───────────────────────── HTTP ─────────────────────────
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/client/index.html';
  if (!url.startsWith('/client/') && !url.startsWith('/shared/')) { res.writeHead(404); res.end('not found'); return; }
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ───────────────────────── 로비/방 상태 ─────────────────────────
const clients = new Map(); // cid -> { id, ws, name, slot, spectate }
let nextCid = 1;
let hostId = 0;
let state = 'lobby'; // lobby | playing | over
let settings = { ...DEFAULT_SETTINGS };
let game = null;
let overTimer = null;
const slots = [0, 1, 2, 3].map(i => ({ type: 'bot', cid: 0, name: `AI ${i + 1}`, cls: CLASS_IDS[i] }));

const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of clients.values()) send(c, s); };

function lobbyState() {
  return {
    t: 'lobby', state, hostId, settings,
    slots: slots.map((s, i) => ({ i, type: s.type, name: s.name, cls: s.cls, cid: s.cid })),
    spectators: [...clients.values()].filter(c => c.slot < 0).map(c => ({ id: c.id, name: c.name })),
  };
}
const broadcastLobby = () => broadcast(lobbyState());

function uniqueName(raw) {
  let base = String(raw || '').replace(/[<>]/g, '').trim().slice(0, 12) || '플레이어';
  const taken = new Set([...clients.values()].map(c => c.name));
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}${n++}`;
  return name;
}

function pickHost() {
  if (clients.has(hostId)) return;
  const first = [...clients.values()].find(c => c.slot >= 0) || clients.values().next().value;
  hostId = first ? first.id : 0;
}

function freeSlotFor(c) {
  if (state !== 'lobby') return -1;
  return slots.findIndex(s => s.type === 'bot');
}

function takeSlot(c, i) {
  const s = slots[i];
  s.type = 'human'; s.cid = c.id; s.name = c.name;
  c.slot = i;
}

function releaseSlot(c) {
  if (c.slot < 0) return;
  const s = slots[c.slot];
  s.type = 'bot'; s.cid = 0; s.name = `AI ${c.slot + 1}`;
  if (game) {
    const p = game.players[c.slot];
    game.setBot(p, true);
    game.pushFeed(`${c.name} 님이 나갔습니다 — AI가 이어서 플레이합니다`, 'info');
  }
  c.slot = -1;
}

function startGame() {
  if (overTimer) { clearTimeout(overTimer); overTimer = null; }
  game = new Game(slots.map(s => ({ name: s.name, cls: s.cls, isBot: s.type === 'bot' })), settings);
  state = 'playing';
  tickAcc = 0; lastTime = performance.now(); tickCount = 0;
  for (const c of clients.values()) sendStart(c);
  broadcastLobby();
}

function sendStart(c) {
  const p = c.slot >= 0 && game ? game.players[c.slot] : null;
  send(c, { t: 'start', roster: game.roster(), you: p ? p.id : 0, settings: game.settings });
}

function backToLobby() {
  if (overTimer) { clearTimeout(overTimer); overTimer = null; }
  game = null;
  state = 'lobby';
  // 남아있는 관전자에게 빈 슬롯 배정
  for (const c of clients.values()) {
    if (c.slot < 0) { const i = freeSlotFor(c); if (i >= 0) takeSlot(c, i); }
  }
  broadcastLobby();
}

// ───────────────────────── 메시지 ─────────────────────────
function onMessage(c, msg) {
  const isHost = c.id === hostId;
  switch (msg.t) {
    case 'join': {
      if (c.name) break;
      c.name = uniqueName(msg.name);
      const i = freeSlotFor(c);
      if (i >= 0) takeSlot(c, i);
      pickHost();
      send(c, { t: 'welcome', id: c.id, name: c.name });
      broadcastLobby();
      if (state === 'playing' && game) sendStart(c);
      break;
    }
    case 'cls':
      if (state === 'lobby' && c.slot >= 0 && CLASSES[msg.cls]) { slots[c.slot].cls = msg.cls; broadcastLobby(); }
      break;
    case 'botcls':
      if (isHost && state === 'lobby' && slots[msg.slot] && slots[msg.slot].type === 'bot') {
        slots[msg.slot].cls = CLASSES[msg.cls] ? msg.cls : CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];
        broadcastLobby();
      }
      break;
    case 'settings':
      if (isHost && state === 'lobby') {
        const s = msg.settings || {};
        if (typeof s.respawn === 'boolean') settings.respawn = s.respawn;
        if (Number.isFinite(+s.pvpGrace)) settings.pvpGrace = Math.max(0, Math.min(600, +s.pvpGrace));
        if (Number.isFinite(+s.bossUnseal)) settings.bossUnseal = Math.max(0, Math.min(3600, +s.bossUnseal));
        broadcastLobby();
      }
      break;
    case 'slot': // 로비에서 다른 빈(AI) 슬롯으로 이동
      if (state === 'lobby' && slots[msg.slot] && slots[msg.slot].type === 'bot') {
        const cls = c.slot >= 0 ? slots[c.slot].cls : slots[msg.slot].cls;
        if (c.slot >= 0) releaseSlot(c);
        takeSlot(c, msg.slot);
        slots[msg.slot].cls = cls;
        broadcastLobby();
      }
      break;
    case 'spectate': // 로비에서 관전자로 전환
      if (state === 'lobby' && c.slot >= 0) { releaseSlot(c); broadcastLobby(); }
      break;
    case 'start':
      if (isHost && state === 'lobby') startGame();
      break;
    case 'lobby':
      if (isHost && state === 'over') backToLobby();
      break;
    case 'takeover': // 게임 중 관전자가 AI 플레이어를 인수
      if (game && state === 'playing' && c.slot < 0 && slots[msg.slot] && slots[msg.slot].type === 'bot') {
        takeSlot(c, msg.slot);
        const p = game.players[msg.slot];
        game.setBot(p, false);
        p.name = c.name;
        game.pushFeed(`${c.name} 님이 ${msg.slot + 1}번 플레이어를 인수했습니다`, 'info');
        broadcast({ t: 'roster', roster: game.roster() });
        sendStart(c);
        broadcastLobby();
      }
      break;
    case 'input':
      if (game && c.slot >= 0) game.setInput(game.players[c.slot], msg);
      break;
    case 'skill':
      if (game && c.slot >= 0) {
        const p = game.players[c.slot];
        game.setInput(p, { mx: p.moveX, my: p.moveY, ax: msg.ax, ay: msg.ay });
        game.useSkill(p);
      }
      break;
    case 'pick':
      if (game && c.slot >= 0) game.pick(game.players[c.slot], msg.i | 0);
      break;
    case 'tm':
      if (game && c.slot >= 0) game.setTargetMode(game.players[c.slot], msg.mode);
      break;
    case 'spec':
      c.spectate = msg.id | 0;
      break;
    case 'chat': {
      const text = String(msg.text || '').replace(/[<>]/g, '').trim().slice(0, 120);
      if (text) broadcast({ t: 'chat', name: c.name, text });
      break;
    }
    case 'ping':
      send(c, { t: 'pong', c: msg.c });
      break;
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  const c = { id: nextCid++, ws, name: '', slot: -1, spectate: 0 };
  clients.set(c.id, c);
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (!c.name && msg.t !== 'join' && msg.t !== 'ping') return;
    try { onMessage(c, msg); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => {
    releaseSlot(c);
    clients.delete(c.id);
    pickHost();
    if (clients.size === 0 && state !== 'lobby') { backToLobby(); return; } // 아무도 없으면 방 초기화
    if (game && state === 'playing') broadcast({ t: 'roster', roster: game.roster() });
    broadcastLobby();
  });
});

// ───────────────────────── 게임 루프 ─────────────────────────
let lastTime = performance.now(), tickAcc = 0, tickCount = 0;
setInterval(() => {
  const now = performance.now();
  tickAcc += (now - lastTime) / 1000;
  lastTime = now;
  if (!game || state !== 'playing') { tickAcc = 0; return; }
  let steps = 0;
  while (tickAcc >= DT && steps < 5) {
    tickAcc -= DT; steps++;
    try { game.step(); } catch (e) { console.error('step error', e); }
    tickCount++;
    if (tickCount % SNAPSHOT_EVERY === 0) sendSnapshots();
    if (game.over) { endGame(); return; }
  }
  if (steps === 5) tickAcc = 0;
}, 1000 / TICK_RATE / 2);

function sendSnapshots() {
  const shared = game.buildShared();
  for (const c of clients.values()) {
    if (!c.name || c.ws.readyState !== 1) continue;
    if (c.ws.bufferedAmount > 512 * 1024) continue; // 느린 클라이언트는 프레임 스킵
    const me = c.slot >= 0 ? game.players[c.slot] : null;
    const spec = game.players.find(p => p.id === c.spectate && !p.dead);
    let viewer = me;
    if (!me) viewer = spec || game.players.find(p => !p.dead) || game.players[0];
    else if (me.dead && spec) viewer = spec;
    send(c, game.snapshotFor(shared, viewer, me));
  }
  game.fx.length = 0;
}

function endGame() {
  sendSnapshots();
  state = 'over';
  broadcast({ t: 'over', winnerId: game.over.winnerId, time: game.over.time, results: game.results() });
  broadcastLobby();
  overTimer = setTimeout(() => { if (state === 'over') backToLobby(); }, 30000);
}

server.listen(PORT, () => {
  console.log(`MUVSLike 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 네트워크의 친구는 http://<이 PC의 IP>:' + PORT + ' 로 접속하세요.');
});
