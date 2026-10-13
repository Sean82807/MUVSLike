import {
  MAP_W, MAP_H, CLASSES, CLASS_IDS, SKILLS, WEAPONS, PASSIVES, RELICS, ITEMS, ITEM_IDS, OBJECTS, OBJ_TYPE_IDS,
  BOSS, STATUS_BITS, PLAYER_RADIUS, SLOT_COLORS, WEAPON_MAX_LV,
} from '../shared/defs.js';
import { drawWorld, drawMinimap, fmtTime } from './render.js';

const $ = id => document.getElementById(id);
const INTERP = 0.11;     // 보간 지연(초)
const TARGET_MODES = ['auto', 'monster', 'player'];
const TARGET_LABEL = { auto: '타겟: 자동', monster: '타겟: 몬스터', player: '타겟: 플레이어' };

const S = {
  ws: null, cid: 0, name: '', lobby: null, inGame: false,
  roster: new Map(), you: 0,
  snaps: [], offset: null, me: null, latest: null,
  fx: [], pred: { x: 0, y: 0, valid: false }, hist: [], seq: 0,
  keys: new Set(), mouse: { x: 0, y: 0 }, cam: { x: MAP_W / 2, y: MAP_H / 2, s: 1 },
  spectate: 0, lastPick: 0, ping: 0, feed: [], choiceKey: '',
};

// ───────────────────────── 네트워크 ─────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    send({ t: 'join', name: S.name });
    setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);
  };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    $('joinErr').textContent = '서버와 연결이 끊어졌습니다. 새로고침 해주세요.';
    show('join');
  };
}
const send = m => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); };

function onMessage(m) {
  switch (m.t) {
    case 'welcome': S.cid = m.id; S.name = m.name; break;
    case 'lobby': S.lobby = m; renderLobby(); break;
    case 'start':
      S.inGame = true; S.you = m.you; S.snaps = []; S.offset = null; S.fx = []; S.pred.valid = false; S.hist = [];
      S.feed = []; S.choiceKey = ''; S.me = null;
      setRoster(m.roster);
      show('game');
      break;
    case 'roster': setRoster(m.roster); break;
    case 's': onSnapshot(m); break;
    case 'over': showOver(m); break;
    case 'chat': addFeed(`${m.name}: ${m.text}`, 'chat'); break;
    case 'pong': S.ping = Math.round(performance.now() - m.c); break;
  }
}

function setRoster(list) {
  S.roster.clear();
  for (const r of list) S.roster.set(r.id, r);
}

// ───────────────────────── 화면 전환 ─────────────────────────
function show(which) {
  $('join').classList.toggle('hidden', which !== 'join');
  $('lobby').classList.toggle('hidden', which !== 'lobby');
  $('over').classList.toggle('hidden', which !== 'over');
  $('hud').classList.toggle('hidden', which !== 'game');
}

$('nameInput').value = localStorage.getItem('muvs-name') || '';
$('joinBtn').onclick = () => {
  S.name = $('nameInput').value.trim() || '플레이어';
  try { localStorage.setItem('muvs-name', S.name); } catch {}
  connect();
};
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').focus();

// ───────────────────────── 로비 ─────────────────────────
function renderLobby() {
  const L = S.lobby;
  if (!L) return;
  // 게임 중에는 화면 유지, 결과 화면은 로비 복귀 전까지 유지
  if (L.state === 'lobby') { S.inGame = false; show('lobby'); }
  else if (!S.inGame && $('over').classList.contains('hidden')) show('lobby');

  $('lobbyState').textContent = { lobby: '대기 중', playing: '게임 진행 중', over: '게임 종료' }[L.state];
  const isHost = L.hostId === S.cid;
  const mySlot = L.slots.find(s => s.cid === S.cid);

  const slotsEl = $('slots');
  slotsEl.innerHTML = '';
  for (const s of L.slots) {
    const div = document.createElement('div');
    div.className = 'slot' + (s.cid === S.cid ? ' me' : '');
    const cls = CLASSES[s.cls];
    div.innerHTML = `<span class="dot" style="background:${SLOT_COLORS[s.i]}"></span>
      <span class="nm">${esc(s.name)} ${s.type === 'bot' ? '<span class="tag">AI</span>' : ''}${s.cid === L.hostId ? '<span class="tag good">방장</span>' : ''}</span>`;
    if (s.type === 'bot' && isHost && L.state === 'lobby') {
      const sel = document.createElement('select');
      sel.innerHTML = CLASS_IDS.map(id => `<option value="${id}" ${id === s.cls ? 'selected' : ''}>${CLASSES[id].icon} ${CLASSES[id].name}</option>`).join('')
        + '<option value="random">🎲 무작위</option>';
      sel.onchange = () => send({ t: 'botcls', slot: s.i, cls: sel.value });
      div.appendChild(sel);
    } else {
      div.insertAdjacentHTML('beforeend', `<span>${cls.icon} ${cls.name}</span>`);
    }
    if (s.type === 'bot' && L.state === 'lobby' && s.cid !== S.cid) {
      const b = document.createElement('button');
      b.className = 'small'; b.textContent = mySlot ? '이동' : '참가';
      b.onclick = () => send({ t: 'slot', slot: s.i });
      div.appendChild(b);
    }
    slotsEl.appendChild(div);
  }
  $('spectators').textContent = L.spectators.length ? '관전자: ' + L.spectators.map(s => s.name).join(', ') : '';
  $('specBtn').classList.toggle('hidden', !mySlot || L.state !== 'lobby');

  const clsEl = $('classes');
  clsEl.innerHTML = '';
  for (const id of CLASS_IDS) {
    const c = CLASSES[id];
    const card = document.createElement('div');
    card.className = 'cls-card' + (mySlot && mySlot.cls === id ? ' sel' : '');
    card.innerHTML = `<div class="ic">${c.icon}</div><div class="nm" style="color:${c.color}">${c.name}</div>
      <div class="st">체력 ${c.hp} · 방어 ${c.armor} · 속도 ${c.speed}</div>
      <div class="ds">${c.desc}</div>
      <div class="st">무기: ${WEAPONS[c.weapon].name} · 스킬: ${SKILLS[c.skill].name}</div>`;
    card.title = SKILLS[c.skill].desc;
    card.onclick = () => { if (mySlot && L.state === 'lobby') send({ t: 'cls', cls: id }); };
    clsEl.appendChild(card);
  }

  $('hostPanel').classList.toggle('hidden', !isHost || L.state !== 'lobby');
  $('waitHost').classList.toggle('hidden', isHost || L.state !== 'lobby');
  if (isHost && document.activeElement?.tagName !== 'INPUT') {
    $('setRespawn').checked = L.settings.respawn;
    $('setGrace').value = L.settings.pvpGrace;
    $('setUnseal').value = Math.round(L.settings.bossUnseal / 60);
  }
}
const sendSettings = () => send({ t: 'settings', settings: {
  respawn: $('setRespawn').checked, pvpGrace: +$('setGrace').value, bossUnseal: +$('setUnseal').value * 60,
} });
$('setRespawn').onchange = sendSettings;
$('setGrace').onchange = sendSettings;
$('setUnseal').onchange = sendSettings;
$('startBtn').onclick = () => send({ t: 'start' });
$('specBtn').onclick = () => send({ t: 'spectate' });
$('lobbyBtn').onclick = () => send({ t: 'lobby' });

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ───────────────────────── 스냅샷 ─────────────────────────
function parseSnap(s) {
  const P = new Map(), M = new Map(), PR = new Map();
  for (const a of s.p) P.set(a[0], { id: a[0], x: a[1], y: a[2], hp: a[3], maxHp: a[4], cls: a[5], level: a[6], dead: a[7] & 1, flags: a[7] >> 1, face: a[8], aura: a[9], orb: a[10], orbR: a[11], orbRot: a[12] });
  for (const a of s.m) M.set(a[0], { id: a[0], type: a[1], x: a[2], y: a[3], hp: a[4], flags: a[5] });
  for (const a of s.pr) PR.set(a[0], { id: a[0], kind: a[1], x: a[2], y: a[3], r: a[4], team: a[5], ang: a[6] });
  const O = s.o.map(a => ({ id: a[0], type: a[1], x: a[2], y: a[3], hp: a[4], maxHp: a[5], alive: a[6], respawn: a[7], flags: a[8], tier: a[9] }));
  const G = s.g.map(a => ({ id: a[0], type: a[1], x: a[2], y: a[3], v: a[4] }));
  const HZ = s.hz.map(a => ({ id: a[0], x: a[1], y: a[2], r: a[3], t: a[4] / 100, total: a[5] / 100, team: a[6], kind: a[7] }));
  const b = s.b;
  const B = { x: b[0], y: b[1], hp: b[2], maxHp: b[3], flags: b[4], enraged: b[5], dash: b[6], seal: b[7] };
  return { time: s.time, P, M, PR, O, G, HZ, B, raw: s };
}

function onSnapshot(s) {
  const now = performance.now() / 1000;
  const snap = parseSnap(s);
  const est = now - s.time;
  if (S.offset === null || est < S.offset) S.offset = est;
  else S.offset += (est - S.offset) * 0.02;
  S.snaps.push(snap);
  while (S.snaps.length > 30) S.snaps.shift();
  S.latest = snap;
  if (s.me) S.me = s.me;
  if (s.feed) for (const f of s.feed) addFeed(f.text, f.kind);
  spawnFx(s.fx, now + INTERP);
  reconcile(snap);
}

function spawnFx(list, at) {
  for (const f of list) {
    const [type, x, y] = f;
    switch (type) {
      case 'd': S.fx.push({ type: 'text', x: x + (Math.random() - 0.5) * 16, y, at, dur: 0.7, text: String(f[3]),
        size: f[4] ? 19 : 14, color: f[5] ? '#ff5252' : f[4] ? '#ffeb3b' : '#ffffff' }); break;
      case 'h': S.fx.push({ type: 'text', x, y, at, dur: 0.8, text: '+' + f[3], size: 14, color: '#69f0ae' }); break;
      case 'lvl': S.fx.push({ type: 'text', x, y: y - 30, at, dur: 1.2, text: 'LEVEL UP!', size: 22, color: '#ffd54f' }); break;
      case 'item': {
        const it = ITEMS[ITEM_IDS[f[3]]];
        S.fx.push({ type: 'text', x, y: y - 30, at, dur: 1.2, text: it ? it.name : '', size: 18, color: it ? it.color : '#fff' });
        break;
      }
      case 'arc': S.fx.push({ type, x, y, a: f[3] / 100, r: f[4], w: f[5] / 100, cls: f[6], at, dur: 0.18 }); break;
      case 'boom': S.fx.push({ type, x, y, r: f[3], kind: f[4], at, dur: 0.4 }); break;
      case 'nova': S.fx.push({ type, x, y, r: f[3], kind: f[4], at, dur: 0.35 }); break;
      case 'bolt': S.fx.push({ type, x, y, at, dur: 0.3, seed: Math.random() * 100 }); break;
      case 'line': S.fx.push({ type, x, y, x2: f[3], y2: f[4], kind: f[5], at, dur: 0.35 }); break;
      case 'skill': S.fx.push({ type, x, y, at, dur: 0.4 }); break;
      case 'die': S.fx.push({ type, x, y, at, dur: 1.5 }); break;
    }
  }
}

// 내 캐릭터 예측 보정
function reconcile(snap) {
  const mp = snap.P.get(S.you);
  if (!mp || !S.me) { S.pred.valid = false; return; }
  if (mp.dead || S.me.bot) { S.pred.valid = false; S.hist = []; return; }
  if (!S.pred.valid) { S.pred.x = mp.x; S.pred.y = mp.y; S.pred.valid = true; S.hist = []; return; }
  const seq = S.me.seq;
  const h = S.hist.find(e => e.seq === seq);
  S.hist = S.hist.filter(e => e.seq > seq);
  if (h) {
    const ex = mp.x - h.x, ey = mp.y - h.y;
    const k = Math.hypot(ex, ey) > 150 ? 1 : 0.3;
    S.pred.x += ex * k; S.pred.y += ey * k;
    for (const e of S.hist) { e.x += ex * k; e.y += ey * k; }
  } else {
    S.pred.x += (mp.x - S.pred.x) * 0.2; S.pred.y += (mp.y - S.pred.y) * 0.2;
  }
}

// ───────────────────────── 입력 ─────────────────────────
const canvas = $('game');
const ctx = canvas.getContext('2d');
const mctx = $('minimap').getContext('2d');
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.width = Math.round(innerWidth * dpr);
  H = canvas.height = Math.round(innerHeight * dpr);
}
addEventListener('resize', resize);
resize();

const chat = $('chatInput');
function moveVec() {
  if (document.activeElement === chat) return [0, 0];
  const k = S.keys;
  let x = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
  let y = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
  const l = Math.hypot(x, y);
  if (l) { x /= l; y /= l; }
  return [x, y];
}
function aimWorld() {
  const c = S.cam;
  return [c.x + (S.mouse.x * dpr - W / 2) / c.s, c.y + (S.mouse.y * dpr - H / 2) / c.s];
}
const playing = () => S.inGame && S.me && !S.me.dead && !S.me.bot;

function useSkill() {
  if (!playing()) return;
  const [ax, ay] = aimWorld();
  send({ t: 'skill', ax: Math.round(ax), ay: Math.round(ay) });
}
function pick(i) {
  if (!S.inGame || !S.me || !S.me.opt || !S.me.opt[i]) return;
  const now = performance.now();
  if (now - S.lastPick < 250) return;
  S.lastPick = now;
  send({ t: 'pick', i });
}

addEventListener('keydown', e => {
  if (!S.inGame) return;
  const key = e.key.toLowerCase();
  if (document.activeElement === chat) {
    if (e.key === 'Enter') {
      const text = chat.value.trim();
      if (text) send({ t: 'chat', text });
      chat.value = ''; chat.blur(); chat.classList.add('hidden');
    } else if (e.key === 'Escape') { chat.value = ''; chat.blur(); chat.classList.add('hidden'); }
    return;
  }
  if (e.key === 'Enter') { chat.classList.remove('hidden'); chat.focus(); S.keys.clear(); e.preventDefault(); return; }
  if (key === ' ') { useSkill(); e.preventDefault(); return; }
  if (key === '1' || key === '2' || key === '3') { pick(+key - 1); return; }
  if (key === 'q' && S.me) {
    const next = TARGET_MODES[(TARGET_MODES.indexOf(S.me.tm) + 1) % TARGET_MODES.length];
    send({ t: 'tm', mode: next });
    return;
  }
  if (e.key === 'Tab') { e.preventDefault(); cycleSpectate(); return; }
  S.keys.add(key);
});
addEventListener('keyup', e => S.keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => S.keys.clear());
addEventListener('mousemove', e => { S.mouse.x = e.clientX; S.mouse.y = e.clientY; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => { if (e.button === 2) useSkill(); });

function cycleSpectate() {
  if (!S.latest) return;
  const alive = [...S.latest.P.values()].filter(p => !p.dead && p.id !== S.you);
  if (!alive.length) return;
  const idx = alive.findIndex(p => p.id === S.spectate);
  S.spectate = alive[(idx + 1) % alive.length].id;
  send({ t: 'spec', id: S.spectate });
}

setInterval(() => {
  if (!playing()) return;
  const [mx, my] = moveVec();
  const [ax, ay] = aimWorld();
  S.seq++;
  S.hist.push({ seq: S.seq, x: S.pred.x, y: S.pred.y });
  if (S.hist.length > 90) S.hist.shift();
  send({ t: 'input', mx, my, ax: Math.round(ax), ay: Math.round(ay), seq: S.seq });
}, 1000 / 30);

// ───────────────────────── 렌더 루프 ─────────────────────────
function lerpMap(A, B, alpha) {
  const out = [];
  for (const b of B.values()) {
    const a = A && A.get(b.id);
    if (a) out.push({ ...b, x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha });
    else out.push(b);
  }
  return out;
}

function viewState(now) {
  const snaps = S.snaps;
  if (!snaps.length) return null;
  const rt = now - S.offset - INTERP;
  let a = snaps[0], b = snaps[0];
  for (let i = 0; i < snaps.length; i++) {
    if (snaps[i].time <= rt) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; }
  }
  if (rt < snaps[0].time) { a = b = snaps[0]; }
  const span = b.time - a.time;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (rt - a.time) / span)) : 0;
  const v = {
    time: a.time + span * alpha,
    p: lerpMap(a.P, b.P, alpha),
    m: lerpMap(a.M, b.M, alpha),
    pr: lerpMap(a.PR, b.PR, alpha),
    o: b.O.map((o, i) => { const ao = a.O[i]; return ao && ao.alive && o.alive ? { ...o, x: ao.x + (o.x - ao.x) * alpha, y: ao.y + (o.y - ao.y) * alpha } : o; }),
    g: b.G,
    hz: b.HZ.map(h => ({ ...h, t: Math.max(0, h.t - Math.max(0, rt - b.time)) })),
    b: { ...b.B, x: a.B.x + (b.B.x - a.B.x) * alpha, y: a.B.y + (b.B.y - a.B.y) * alpha },
    view: b.raw.view,
  };
  for (const p of v.p) {
    p.info = S.roster.get(p.id);
    if (p.id === S.you && S.pred.valid) { p.x = S.pred.x; p.y = S.pred.y; }
  }
  return v;
}

function predict(dt) {
  if (!S.pred.valid || !playing() || !S.latest) return;
  const mp = S.latest.P.get(S.you);
  if (!mp) return;
  const f = mp.flags;
  if (f & (STATUS_BITS.stun | STATUS_BITS.freeze)) return;
  const [mx, my] = moveVec();
  const sp = S.me.st.speed * (f & STATUS_BITS.slow ? 0.6 : 1) * (f & STATUS_BITS.whirl ? 0.85 : 1);
  S.pred.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, S.pred.x + mx * sp * dt));
  S.pred.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, S.pred.y + my * sp * dt));
  const pushOut = (x, y, r) => {
    const dx = S.pred.x - x, dy = S.pred.y - y, min = r + PLAYER_RADIUS, d = Math.hypot(dx, dy);
    if (d < min && d > 0) { S.pred.x = x + dx / d * min; S.pred.y = y + dy / d * min; }
  };
  const B = S.latest.B;
  if (B.hp > 0) pushOut(B.x, B.y, BOSS.r);
  for (const o of S.latest.O) if (o.alive) pushOut(o.x, o.y, OBJECTS[OBJ_TYPE_IDS[o.type]].r * (o.tier === 2 ? 1.12 : 1));
}

let lastFrame = performance.now() / 1000, lastHud = 0, lastMini = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - lastFrame);
  lastFrame = now;
  if (!S.inGame || !S.snaps.length) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0d0f14'; ctx.fillRect(0, 0, W, H);
    return;
  }
  predict(dt);
  const v = viewState(now);
  if (!v) return;
  const focus = v.p.find(p => p.id === v.view) || v.p.find(p => p.id === S.you);
  S.cam.s = Math.max(W / 1750, H / 1150);
  if (focus) {
    // 맵 가장자리에서는 카메라를 맵 안쪽으로 고정
    const hw = W / 2 / S.cam.s, hh = H / 2 / S.cam.s;
    const tx = MAP_W > hw * 2 ? Math.max(hw - 60, Math.min(MAP_W - hw + 60, focus.x)) : MAP_W / 2;
    const ty = MAP_H > hh * 2 ? Math.max(hh - 60, Math.min(MAP_H - hh + 60, focus.y)) : MAP_H / 2;
    S.cam.x += (tx - S.cam.x) * Math.min(1, dt * 12);
    S.cam.y += (ty - S.cam.y) * Math.min(1, dt * 12);
    if (Math.hypot(tx - S.cam.x, ty - S.cam.y) > 600) { S.cam.x = tx; S.cam.y = ty; }
  }
  S.fx = S.fx.filter(e => now - e.at < e.dur);
  drawWorld(ctx, W, H, v, S.cam, S.fx, now, S.you);
  if (now - lastMini > 0.2) { lastMini = now; drawMinimap(mctx, v, v.view, S.cam, W / S.cam.s, H / S.cam.s); }
  if (now - lastHud > 0.1) { lastHud = now; updateHud(v); }
}
requestAnimationFrame(frame);

// ───────────────────────── HUD ─────────────────────────
function addFeed(text, kind = 'info') {
  S.feed.push({ text, kind, at: performance.now() });
  if (S.feed.length > 8) S.feed.shift();
  renderFeed();
}
function renderFeed() {
  const now = performance.now();
  S.feed = S.feed.filter(f => now - f.at < 10000);
  $('feed').innerHTML = S.feed.map(f => `<div class="${f.kind}" style="opacity:${Math.min(1, (10000 - (now - f.at)) / 2000)}">${esc(f.text)}</div>`).join('');
}

function optionInfo(o, me) {
  if (o.k === 'w') {
    const w = WEAPONS[o.id];
    if (o.lv === 1) return { t: w.name, lv: '새 무기', d: w.desc, cls: 'new' };
    const notes = ['피해 +22%'];
    const cnt = (w.cntLv || [3, 5]);
    if (cnt.includes(o.lv) && w.kind !== 'arc' && w.kind !== 'aura' && w.kind !== 'nova') notes.push('개수 +1');
    if (w.pierceLv && o.lv % 3 === 0) notes.push('관통 +1');
    if (w.kind === 'arc' || w.kind === 'aura' || w.kind === 'nova' || w.kind === 'orbit') notes.push('범위 +6%');
    return { t: w.name, lv: `Lv ${o.lv - 1} → ${o.lv}${o.lv === WEAPON_MAX_LV ? ' (MAX)' : ''}`, d: notes.join(', ') };
  }
  if (o.k === 'p') {
    const p = PASSIVES[o.id];
    return { t: p.name, lv: o.lv === 1 ? '새 패시브' : `Lv ${o.lv - 1} → ${o.lv}`, d: p.desc, cls: o.lv === 1 ? 'new' : '' };
  }
  if (o.k === 'r') {
    const r = RELICS[o.id];
    const have = me.re[o.id] || 0;
    return { t: r.name, lv: have ? `강화 아이템 (보유 ${have})` : '강화 아이템', d: r.desc, cls: 'relic' };
  }
  if (o.k === 'heal') return { t: '응급 처치', lv: '', d: '체력 50% 회복' };
  return { t: '지식', lv: '', d: '경험치 획득' };
}

function updateHud(v) {
  const me = S.me;
  const isPlayer = !!me;
  $('me').classList.toggle('hidden', !isPlayer);
  if (me) {
    const info = S.roster.get(me.id) || {};
    const myP = v.p.find(p => p.id === me.id);
    const cls = CLASSES[info.cls] || CLASSES[CLASS_IDS[myP ? myP.cls : 0]];
    $('meIcon').textContent = cls.icon;
    $('meIcon').style.background = info.color || '#fff';
    $('meName').textContent = `${info.name || ''} · ${cls.name}`;
    $('meLevel').textContent = `Lv ${me.level}`;
    $('hpFill').style.width = `${Math.max(0, me.hp / me.maxHp * 100)}%`;
    $('hpText').textContent = `${Math.max(0, me.hp)} / ${me.maxHp}`;
    $('xpFill').style.width = `${me.xp / me.xpNext * 100}%`;
    $('xpText').textContent = `${me.xp} / ${me.xpNext}`;
    const sk = SKILLS[cls.skill];
    $('skillName').textContent = `[Space] ${sk.name} `;
    $('skillCd').textContent = me.sk > 0 ? `${me.sk.toFixed(1)}s` : '준비';
    $('skillBox').classList.toggle('cd', me.sk > 0);
    $('skillBox').title = sk.desc;
    $('targetMode').textContent = TARGET_LABEL[me.tm] + ' [Q]';
    const lo = [];
    for (const [id, lv] of me.w) lo.push(`<span class="it w" title="${esc(WEAPONS[id].desc)}">${WEAPONS[id].name} ${lv}</span>`);
    for (const id in me.pa) lo.push(`<span class="it" title="${esc(PASSIVES[id].desc)}">${PASSIVES[id].name} ${me.pa[id]}</span>`);
    for (const id in me.re) if (me.re[id] > 0) lo.push(`<span class="it r" title="${esc(RELICS[id].desc)}">${RELICS[id].name}${me.re[id] > 1 ? ' x' + me.re[id] : ''}</span>`);
    $('loadout').innerHTML = lo.join('');
    $('statLine').textContent = `피해 ${me.st.might}% · 방어 ${me.st.armor} · 이속 ${me.st.speed} · 치명 ${me.st.crit}% · 쿨감 ${me.st.cd}% · 흡혈 ${me.st.ls}%`;

    // 선택지 (게임은 계속 진행됨)
    const key = me.opt ? `${me.ch}|${me.ct}|${JSON.stringify(me.opt)}` : '';
    if (key !== S.choiceKey) {
      S.choiceKey = key;
      $('choices').classList.toggle('hidden', !me.opt);
      if (me.opt) {
        $('choiceTitle').textContent = (me.ct === 'relic' ? '★ 강화 아이템 선택' : '▲ 레벨업! 성장 선택') + (me.ch > 1 ? ` (+${me.ch - 1}개 대기)` : '') + ' — 1 / 2 / 3';
        const cards = $('choiceCards');
        cards.innerHTML = '';
        me.opt.forEach((o, i) => {
          const inf = optionInfo(o, me);
          const c = document.createElement('div');
          c.className = 'card ' + (inf.cls || '');
          c.innerHTML = `<div><span class="k">${i + 1}</span><span class="t">${esc(inf.t)}</span></div><div class="lv">${esc(inf.lv)}</div><div class="d">${esc(inf.d)}</div>`;
          c.onclick = () => pick(i);
          cards.appendChild(c);
        });
      }
    }

    const dm = $('deathMsg');
    if (me.dead) {
      dm.classList.remove('hidden');
      const respawn = S.lobby && S.lobby.settings.respawn;
      dm.innerHTML = respawn ? `사망 — ${me.rt}초 후 부활<small>Tab: 다른 플레이어 관전</small>` : `사망 — 관전 중<small>Tab: 관전 대상 변경</small>`;
    } else dm.classList.add('hidden');
  } else {
    $('choices').classList.add('hidden');
    $('deathMsg').classList.remove('hidden');
    $('deathMsg').innerHTML = '관전 중<small>Tab: 관전 대상 변경</small>';
  }

  // 상단
  const raw = S.latest.raw;
  $('clock').textContent = fmtTime(raw.time);
  const pvp = $('pvpState');
  pvp.textContent = raw.pvp ? 'PvP 활성' : `PvP 금지 ${raw.grace}s`;
  pvp.className = 'tag ' + (raw.pvp ? 'bad' : 'good');
  $('mobMult').textContent = `몹 공격력 x${raw.mult.toFixed(2)}`;
  const B = v.b;
  if (B.seal > 0) {
    $('bossFill').style.width = '100%';
    $('bossText').textContent = `${BOSS.name} — 봉인 해제까지 ${fmtTime(B.seal)}`;
  } else {
    $('bossFill').style.width = `${B.hp / B.maxHp * 100}%`;
    $('bossText').textContent = `${BOSS.name}${B.enraged ? ' (분노)' : ''} — ${B.hp.toLocaleString()} / ${B.maxHp.toLocaleString()}`;
  }

  // 점수판
  const rows = raw.sb.slice().sort((a, b) => b[1] - a[1]).map(r => {
    const info = S.roster.get(r[0]) || {};
    const cls = CLASSES[info.cls] || {};
    const status = r[6] >= 0 ? `💀${r[6] || ''}` : '';
    return `<tr class="${r[6] >= 0 ? 'dead' : ''}"><td><span class="dot" style="background:${info.color}"></span>${esc(info.name || '?')}${info.isBot ? ' <span class="muted">AI</span>' : ''}</td>
      <td>${cls.icon || ''}</td><td>Lv${r[1]}</td><td title="플레이어 처치/사망">⚔${r[2]}/${r[3]}</td><td title="오브젝트 사냥">★${r[4]}</td><td>${status}</td></tr>`;
  });
  $('score').innerHTML = rows.join('');
  renderFeed();

  // 관전자: AI 인수
  const L = S.lobby;
  const to = $('takeover');
  if (!me && L && L.state === 'playing') {
    const bots = L.slots.filter(s => s.type === 'bot');
    to.classList.toggle('hidden', !bots.length);
    const html = '<div class="small">AI 플레이어 인수:</div>' + bots.map(s => `<button class="small" data-slot="${s.i}">${s.i + 1}번 ${CLASSES[s.cls].icon}</button>`).join('');
    if (to.dataset.html !== html) {
      to.dataset.html = html;
      to.innerHTML = html;
      to.querySelectorAll('button').forEach(b => b.onclick = () => send({ t: 'takeover', slot: +b.dataset.slot }));
    }
  } else to.classList.add('hidden');

  $('net').textContent = `ping ${S.ping}ms`;
}

// ───────────────────────── 결과 ─────────────────────────
function showOver(m) {
  S.inGame = false;
  const winner = m.results.find(r => r.id === m.winnerId);
  $('overTitle').textContent = winner ? `🏆 ${winner.name} (${CLASSES[winner.cls].name}) 승리! — ${fmtTime(m.time)}` : `보스의 승리… — ${fmtTime(m.time)}`;
  const rows = m.results.slice().sort((a, b) => (b.id === m.winnerId) - (a.id === m.winnerId) || b.level - a.level);
  $('results').innerHTML = '<tr><th>플레이어</th><th>클래스</th><th>레벨</th><th>플레이어 처치</th><th>사망</th><th>오브젝트</th><th>몬스터</th><th>총 피해량</th></tr>'
    + rows.map(r => `<tr class="${r.id === m.winnerId ? 'win' : ''}"><td>${esc(r.name)}${r.isBot ? ' (AI)' : ''}</td><td>${CLASSES[r.cls].icon} ${CLASSES[r.cls].name}</td>
      <td>${r.level}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.objKills}</td><td>${r.mobKills}</td><td>${r.dmg.toLocaleString()}</td></tr>`).join('');
  $('lobbyBtn').classList.toggle('hidden', !S.lobby || S.lobby.hostId !== S.cid);
  show('over');
}
