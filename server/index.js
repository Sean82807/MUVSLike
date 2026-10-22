// HTTP 정적 파일 + WebSocket 게임 서버 (방 1개)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { TICK_RATE } from '../shared/defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 3000;
const MAX_CLIENTS = +process.env.MAX_CLIENTS || 40; // 서버 전체 동시 접속 제한
const MAX_ROOMS = +process.env.MAX_ROOMS || 4;       // 동시에 열 수 있는 방 수 (무료 호스팅 CPU 고려)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ───────────────────────── HTTP ─────────────────────────
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
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

// ───────────────────────── 접속자/방 목록 ─────────────────────────
const clients = new Map(); // cid -> { id, ws, name, room, slot, spectate }
const rooms = new Map();   // code -> Room
let nextCid = 1;
let roomsDirty = false;

const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const sendError = (c, text) => send(c, { t: 'error', text });

function uniqueName(raw) {
  const base = String(raw || '').replace(/[<>]/g, '').trim().slice(0, 12) || '플레이어';
  const taken = new Set([...clients.values()].map(c => c.name));
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}${n++}`;
  return name;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
function newRoomCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
const normCode = v => String(v || '').trim().toUpperCase().slice(0, 8);

function roomList() {
  const list = [...rooms.values()].filter(r => !r.isPrivate).sort((a, b) => a.createdAt - b.createdAt).map(r => r.summary());
  return { t: 'rooms', rooms: list, full: rooms.size >= MAX_ROOMS };
}
// 방 목록 화면에 있는 사람들에게 변경 사항 전달 (최대 초당 2회)
setInterval(() => {
  if (!roomsDirty) return;
  roomsDirty = false;
  const msg = JSON.stringify(roomList());
  for (const c of clients.values()) if (c.name && !c.room) send(c, msg);
}, 500);

const roomHooks = {
  onChange: () => { roomsDirty = true; },
  onEmpty: room => { rooms.delete(room.id); roomsDirty = true; console.log(`방 닫힘 ${room.id} (남은 방 ${rooms.size})`); },
};

function enterRoom(c, code) {
  const room = rooms.get(normCode(code));
  if (!room) { sendError(c, '방을 찾을 수 없습니다. 코드를 확인해주세요.'); send(c, roomList()); return; }
  if (c.room) c.room.leave(c);
  room.join(c);
}

function onMessage(c, msg) {
  switch (msg.t) {
    case 'hello': { // 닉네임 등록 → 방 목록 (초대 코드가 있으면 바로 입장)
      if (c.name) break;
      c.name = uniqueName(msg.name);
      send(c, { t: 'welcome', id: c.id, name: c.name });
      if (msg.room && rooms.has(normCode(msg.room))) enterRoom(c, msg.room);
      else {
        if (msg.room) sendError(c, '초대받은 방이 없거나 이미 닫혔습니다.');
        send(c, roomList());
      }
      break;
    }
    case 'list':
      if (!c.room) send(c, roomList());
      break;
    case 'create': {
      if (rooms.size >= MAX_ROOMS) { sendError(c, `방은 최대 ${MAX_ROOMS}개까지 열 수 있습니다. 다른 방에 참여해주세요.`); send(c, roomList()); break; }
      const name = String(msg.name || '').replace(/[<>]/g, '').trim().slice(0, 20) || `${c.name}의 방`;
      const room = new Room(newRoomCode(), name, !!msg.private, roomHooks);
      rooms.set(room.id, room);
      console.log(`방 생성 ${room.id} "${name}" by ${c.name} (총 ${rooms.size})`);
      if (c.room) c.room.leave(c);
      room.join(c);
      break;
    }
    case 'enter':
      enterRoom(c, msg.id);
      break;
    case 'leave':
      if (c.room) { c.room.leave(c); send(c, { t: 'left' }); send(c, roomList()); }
      break;
    case 'ping':
      send(c, { t: 'pong', c: msg.c });
      break;
    default:
      if (c.room) c.room.handle(c, msg);
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'server full'); return; }
  const c = { id: nextCid++, ws, name: '', room: null, slot: -1, spectate: 0 };
  clients.set(c.id, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (!c.name && msg.t !== 'hello' && msg.t !== 'ping') return;
    try { onMessage(c, msg); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => {
    if (c.room) c.room.leave(c);
    clients.delete(c.id);
  });
});

// 응답 없는(끊긴) 연결 정리 — 인터넷 환경에서 유령 접속이 슬롯을 차지하지 않도록
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

// ───────────────────────── 게임 루프 (모든 방) ─────────────────────────
let lastTime = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  for (const room of rooms.values()) room.update(dt);
}, 1000 / TICK_RATE / 2);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MUVSLike 서버 실행 중: http://localhost:${PORT} (최대 방 ${MAX_ROOMS}개, 접속 ${MAX_CLIENTS}명)`);
});
