// 캔버스 렌더링 (월드 + 미니맵). 상태는 main.js가 보간해서 넘겨준다.
// 화풍: 밝고 선명한 협곡 스타일 — 굵은 외곽선, 부드러운 음영, 발광 이펙트.
// 수백 마리 몹과 지형 장식은 미리 그린 스프라이트로 찍어 성능을 유지한다.
import {
  MAP_W, MAP_H, CENTER, BOSS_ARENA_R, SPAWNS, SLOT_COLORS, CLASSES, CLASS_IDS, MOBS, MOB_TYPE_IDS,
  OBJECTS, OBJ_TYPE_IDS, ITEMS, ITEM_IDS, STATUS_BITS, PROJ_KINDS, BOSS, OBJECT_SPOTS, PLAYER_RADIUS, STATUSES,
} from '../shared/defs.js';

const TAU = Math.PI * 2;
const FONT = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';
const OUTLINE = '#1b1410';
const RIVER_R = 1250;      // 중앙을 감싸는 강 반지름
const RIVER_W = 210;
let TS = 1;                // 줌과 무관하게 글자/체력바 크기를 유지하기 위한 배율

// ───────────────────────── 유틸 ─────────────────────────
function rng(seed) { // mulberry32
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
// 중심 기준 좌표계로 그리는 스프라이트 (해상도 scale배)
function sprite(w, h, draw, scale = 2) {
  const c = makeCanvas(w * scale, h * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale); g.translate(w / 2, h / 2);
  draw(g);
  c.w = w; c.h = h;
  return c;
}
function blit(ctx, spr, x, y, sc = 1) { ctx.drawImage(spr, x - spr.w * sc / 2, y - spr.h * sc / 2, spr.w * sc, spr.h * sc); }
function shade(hex, amt) { // amt: -1(검정)~1(흰색)
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = n >> 8 & 255, b = n & 255;
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `rgb(${r},${g},${b})`;
}
// 왼쪽 위에서 빛을 받는 둥근 몸통
function ball(g, x, y, r, color, outline = OUTLINE, lw = 2.2) {
  const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  grd.addColorStop(0, shade(color, 0.35)); grd.addColorStop(0.55, color); grd.addColorStop(1, shade(color, -0.35));
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = grd; g.fill();
  if (outline) { g.lineWidth = lw; g.strokeStyle = outline; g.stroke(); }
}
function eye(g, x, y, r, iris = '#1b1410', white = '#fff') {
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = white; g.fill();
  g.beginPath(); g.arc(x + r * 0.2, y + r * 0.1, r * 0.55, 0, TAU); g.fillStyle = iris; g.fill();
  g.beginPath(); g.arc(x - r * 0.15, y - r * 0.3, r * 0.22, 0, TAU); g.fillStyle = '#fff'; g.fill();
}
function glowSprite(color, r) {
  return sprite(r * 2, r * 2, g => {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
    grd.addColorStop(0, color); grd.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.45)')); grd.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = grd; g.fillRect(-r, -r, r * 2, r * 2);
  }, 1);
}
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, l = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

// ───────────────────────── 지형 레이아웃 (결정적) ─────────────────────────
const LANES = [
  ...SPAWNS.map(sp => [sp, CENTER]),                       // 귀퉁이 → 중앙
  [SPAWNS[0], SPAWNS[1]], [SPAWNS[1], SPAWNS[3]], [SPAWNS[3], SPAWNS[2]], [SPAWNS[2], SPAWNS[0]], // 외곽 순환
  ...OBJECT_SPOTS.filter(s => s.tier === 1).map(s => [s, { // 외곽 길 → 가장자리 오브젝트
    x: s.x === MAP_W / 2 ? s.x : (s.x < CENTER.x ? SPAWNS[0].x : SPAWNS[1].x),
    y: s.y === MAP_H / 2 ? s.y : (s.y < CENTER.y ? SPAWNS[0].y : SPAWNS[2].y),
  }]),
];
const BASES = SPAWNS.map((sp, i) => {
  const dx = Math.sign(sp.x - CENTER.x), dy = Math.sign(sp.y - CENTER.y);
  return { x: sp.x, y: sp.y, cx: sp.x + dx * 150, cy: sp.y + dy * 150, color: SLOT_COLORS[i] };
});
const BRIDGES = SPAWNS.map(sp => {
  const a = Math.atan2(sp.y - CENTER.y, sp.x - CENTER.x);
  return { x: CENTER.x + Math.cos(a) * RIVER_R, y: CENTER.y + Math.sin(a) * RIVER_R, a };
});
function nearFeature(x, y, pad) {
  for (const [a, b] of LANES) if (segDist(x, y, a.x, a.y, b.x, b.y) < 110 + pad) return true;
  const dc = Math.hypot(x - CENTER.x, y - CENTER.y);
  if (Math.abs(dc - RIVER_R) < RIVER_W / 2 + 40 + pad) return true;
  if (dc < BOSS_ARENA_R + 180 + pad) return true;
  for (const s of OBJECT_SPOTS) if (Math.hypot(x - s.x, y - s.y) < 210 + pad) return true;
  for (const s of SPAWNS) if (Math.hypot(x - s.x, y - s.y) < 300 + pad) return true;
  return false;
}
// 장식물: 나무 / 덤불 / 바위 — 400 단위 버킷으로 컬링
const DECO_CELL = 400;
const deco = new Map();
function addDeco(d) {
  const k = Math.floor(d.x / DECO_CELL) * 1000 + Math.floor(d.y / DECO_CELL);
  if (!deco.has(k)) deco.set(k, []);
  deco.get(k).push(d);
}
(() => {
  const R = rng(20261030);
  const placed = [];
  const spaced = (x, y, min) => placed.every(p => (p.x - x) ** 2 + (p.y - y) ** 2 > min * min);
  // 나무는 덩어리(숲)로 모으고 사이사이 빈터를 남긴다
  const groves = Array.from({ length: 70 }, () => ({ x: R() * MAP_W, y: R() * MAP_H, r: 140 + R() * 220 }));
  for (let i = 0; i < 9000 && placed.length < 430; i++) {
    const gv = groves[Math.floor(R() * groves.length)];
    const a = R() * TAU, dist = Math.sqrt(R()) * gv.r;
    const x = gv.x + Math.cos(a) * dist, y = gv.y + Math.sin(a) * dist;
    if (x < 60 || y < 60 || x > MAP_W - 60 || y > MAP_H - 60) continue;
    if (nearFeature(x, y, 30) || !spaced(x, y, 105)) continue;
    const d = { x, y, kind: 'tree', v: Math.floor(R() * 4), s: 0.85 + R() * 0.35 };
    placed.push(d); addDeco(d);
  }
  for (let i = 0; i < 1100; i++) {
    const x = 40 + R() * (MAP_W - 80), y = 40 + R() * (MAP_H - 80);
    if (nearFeature(x, y, -60)) continue;
    const kind = R() < 0.6 ? 'bush' : 'rock';
    addDeco({ x, y, kind, v: Math.floor(R() * 3), s: 0.7 + R() * 0.5 });
  }
  // 맵 바깥 숲 경계
  for (let t = -100; t <= MAP_W + 100; t += 75) {
    for (const [x, y] of [[t, -55], [t, MAP_H + 55], [-55, t], [MAP_W + 55, t]]) {
      addDeco({ x: x + (R() - 0.5) * 30, y: y + (R() - 0.5) * 30, kind: 'tree', v: Math.floor(R() * 4), s: 1.1 + R() * 0.3, dark: true });
    }
  }
})();

// ───────────────────────── 텍스처/스프라이트 ─────────────────────────
let TILES = null;
const PATS = new WeakMap(); // 컨텍스트별 패턴 캐시
function pat(g, name) {
  let m = PATS.get(g);
  if (!m) { m = {}; PATS.set(g, m); }
  return m[name] || (m[name] = g.createPattern(textures()[name], 'repeat'));
}
function textures() {
  if (TILES) return TILES;
  const R = rng(7);
  // 잔디
  const grass = makeCanvas(256, 256), gg = grass.getContext('2d');
  gg.fillStyle = '#5a9a3e'; gg.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 40; i++) {
    const x = R() * 256, y = R() * 256, r = 20 + R() * 40;
    const grd = gg.createRadialGradient(x, y, 0, x, y, r);
    const c = R() < 0.5 ? '72,130,48' : '112,170,70';
    grd.addColorStop(0, `rgba(${c},0.35)`); grd.addColorStop(1, `rgba(${c},0)`);
    gg.fillStyle = grd;
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { gg.save(); gg.translate(ox, oy); gg.fillRect(x - r, y - r, r * 2, r * 2); gg.restore(); }
  }
  gg.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const x = R() * 256, y = R() * 256, l = 3 + R() * 5, a = -Math.PI / 2 + (R() - 0.5) * 0.9;
    gg.strokeStyle = R() < 0.5 ? 'rgba(130,190,80,0.7)' : 'rgba(60,110,40,0.6)'; gg.lineWidth = 1.3;
    gg.beginPath(); gg.moveTo(x, y); gg.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); gg.stroke();
  }
  for (let i = 0; i < 10; i++) {
    gg.fillStyle = ['#fff8e1', '#ffe082', '#f8bbd0', '#e1bee7'][Math.floor(R() * 4)];
    const x = R() * 256, y = R() * 256;
    for (let k = 0; k < 4; k++) { gg.beginPath(); gg.arc(x + Math.cos(k * 1.57) * 2, y + Math.sin(k * 1.57) * 2, 1.6, 0, TAU); gg.fill(); }
  }
  // 흙길
  const dirt = makeCanvas(128, 128), dg = dirt.getContext('2d');
  dg.fillStyle = '#b48e5a'; dg.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 160; i++) {
    dg.fillStyle = R() < 0.5 ? 'rgba(140,105,62,0.55)' : 'rgba(210,180,130,0.45)';
    dg.beginPath(); dg.ellipse(R() * 128, R() * 128, 1 + R() * 3, 1 + R() * 2, R() * 3, 0, TAU); dg.fill();
  }
  // 돌바닥 (보스 둥지 / 기지)
  const stone = (base, mortar) => {
    const c = makeCanvas(128, 128), sg = c.getContext('2d');
    sg.fillStyle = mortar; sg.fillRect(0, 0, 128, 128);
    for (let row = 0; row < 4; row++) for (let col = -1; col < 3; col++) {
      const x = col * 64 + (row % 2) * 32 + 2, y = row * 32 + 2;
      sg.fillStyle = shade(base, (R() - 0.5) * 0.18);
      sg.beginPath(); sg.roundRect(x, y, 60, 28, 5); sg.fill();
      sg.fillStyle = 'rgba(255,255,255,0.08)'; sg.fillRect(x + 3, y + 2, 54, 4);
    }
    return c;
  };
  TILES = { grass, dirt, arena: stone('#6b5a86', '#3a2d4f'), base: stone('#9aa3ad', '#5d646d') };
  return TILES;
}

// 나무/덤불/바위
const TREE_COLORS = [['#2f7a3a', '#47a14a'], ['#2a6e45', '#3f9a5c'], ['#3b7d2e', '#5ca640'], ['#285f33', '#3d8a47']];
const SPR = {};
function decoSprites() {
  if (SPR.tree) return;
  SPR.tree = TREE_COLORS.map(([dark, light], v) => sprite(170, 170, g => {
    const R = rng(100 + v);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(12, 16, 62, 52, 0, 0, TAU); g.fill();
    const blobs = Array.from({ length: 6 }, (_, i) => [Math.cos(i * 1.05 + R()) * 28, Math.sin(i * 1.05 + R()) * 26, 30 + R() * 10]);
    g.fillStyle = shade(dark, -0.35);
    for (const [x, y, r] of blobs) { g.beginPath(); g.arc(x, y, r + 3, 0, TAU); g.fill(); }
    for (const [x, y, r] of blobs) ball(g, x, y, r, dark, null);
    g.fillStyle = light;
    for (const [x, y, r] of blobs) { g.beginPath(); g.arc(x - r * 0.25, y - r * 0.3, r * 0.5, 0, TAU); g.fill(); }
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (const [x, y, r] of blobs) { g.beginPath(); g.arc(x - r * 0.35, y - r * 0.45, r * 0.22, 0, TAU); g.fill(); }
  }));
  SPR.darkTree = TREE_COLORS.map((_, v) => sprite(170, 170, g => { g.drawImage(SPR.tree[v], -85, -85, 170, 170); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(10,30,15,0.45)'; g.fillRect(-85, -85, 170, 170); }));
  SPR.bush = [0, 1, 2].map(v => sprite(70, 60, g => {
    const R = rng(200 + v);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.beginPath(); g.ellipse(4, 10, 28, 16, 0, 0, TAU); g.fill();
    for (let i = 0; i < 4; i++) ball(g, (i - 1.5) * 12, (R() - 0.5) * 8, 13 + R() * 4, i % 2 ? '#3f8f3a' : '#4fa244', '#22521f', 1.6);
    if (v === 2) { g.fillStyle = '#ff8a80'; for (let i = 0; i < 4; i++) { g.beginPath(); g.arc((R() - 0.5) * 36, (R() - 0.5) * 16, 2.4, 0, TAU); g.fill(); } }
  }));
  SPR.rock = [0, 1, 2].map(v => sprite(56, 46, g => {
    const R = rng(300 + v);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(4, 8, 22, 12, 0, 0, TAU); g.fill();
    g.beginPath();
    for (let i = 0; i < 7; i++) { const a = i / 7 * TAU, r = 15 + R() * 6; i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.8) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r * 0.8); }
    g.closePath();
    const grd = g.createLinearGradient(-15, -15, 15, 15); grd.addColorStop(0, '#c5cad1'); grd.addColorStop(1, '#6f767f');
    g.fillStyle = grd; g.fill(); g.lineWidth = 2; g.strokeStyle = '#3c4148'; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.ellipse(-5, -6, 6, 3, -0.5, 0, TAU); g.fill();
  }));
}

// 몹 스프라이트 (귀엽고 둥근 형태)
const MOB_SPR = {};
function mobSprite(type, frame = 0) {
  const key = type + frame;
  if (MOB_SPR[key]) return MOB_SPR[key];
  const def = MOBS[type], r = def.r;
  const size = type === 'bat' ? r * 4.2 : r * 2.8;
  MOB_SPR[key] = sprite(size, size, g => {
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.beginPath(); g.ellipse(0, r * 0.85, r * 0.9, r * 0.35, 0, 0, TAU); g.fill();
    if (type === 'zombie') {
      ball(g, -r * 0.85, r * 0.25, r * 0.35, '#5f8a45'); ball(g, r * 0.85, r * 0.25, r * 0.35, '#5f8a45');
      ball(g, 0, 0, r, '#7cab55');
      g.fillStyle = 'rgba(60,90,40,0.6)'; g.beginPath(); g.ellipse(r * 0.2, r * 0.45, r * 0.35, r * 0.2, 0, 0, TAU); g.fill();
      eye(g, -r * 0.35, -r * 0.15, r * 0.27, '#b71c1c', '#fffde7'); eye(g, r * 0.35, -r * 0.2, r * 0.22, '#b71c1c', '#fffde7');
      g.strokeStyle = OUTLINE; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-r * 0.3, r * 0.35); g.lineTo(-r * 0.1, r * 0.28); g.lineTo(r * 0.1, r * 0.38); g.lineTo(r * 0.3, r * 0.3); g.stroke();
    } else if (type === 'bat') {
      const flap = [0.15, -0.35, 0.5][frame];
      for (const sx of [-1, 1]) {
        g.beginPath(); g.moveTo(sx * r * 0.6, -r * 0.1);
        g.quadraticCurveTo(sx * r * 1.6, -r * (0.9 + flap), sx * r * 2.0, -r * (0.1 + flap));
        g.quadraticCurveTo(sx * r * 1.5, r * 0.1, sx * r * 1.2, r * 0.5);
        g.quadraticCurveTo(sx * r * 0.9, r * 0.2, sx * r * 0.5, r * 0.45);
        g.closePath(); g.fillStyle = '#7e57c2'; g.fill(); g.lineWidth = 2; g.strokeStyle = OUTLINE; g.stroke();
      }
      for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * r * 0.25, -r * 0.6); g.lineTo(sx * r * 0.6, -r * 1.25); g.lineTo(sx * r * 0.7, -r * 0.45); g.fillStyle = '#673ab7'; g.fill(); g.stroke(); }
      ball(g, 0, 0, r * 0.85, '#9575cd');
      eye(g, -r * 0.3, -r * 0.12, r * 0.24, '#d50000', '#fff59d'); eye(g, r * 0.3, -r * 0.12, r * 0.24, '#d50000', '#fff59d');
      g.fillStyle = '#fff'; for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * r * 0.18, r * 0.25); g.lineTo(sx * r * 0.1, r * 0.48); g.lineTo(sx * r * 0.02, r * 0.25); g.fill(); }
    } else if (type === 'skeleton' || type === 'archer') {
      if (type === 'archer') {
        g.strokeStyle = '#8d6e63'; g.lineWidth = 3; g.beginPath(); g.arc(r * 0.9, 0, r * 0.95, -1.1, 1.1); g.stroke();
        g.strokeStyle = '#eeeeee'; g.lineWidth = 1; g.beginPath(); g.moveTo(r * 0.9 + Math.cos(-1.1) * r * 0.95, Math.sin(-1.1) * r * 0.95); g.lineTo(r * 0.9 + Math.cos(1.1) * r * 0.95, Math.sin(1.1) * r * 0.95); g.stroke();
        ball(g, 0, r * 0.1, r * 1.0, '#6d4c41');
      }
      ball(g, 0, -r * 0.05, r * 0.88, '#eee8dc');
      g.fillStyle = '#3e2723';
      for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * r * 0.33, -r * 0.15, r * 0.24, r * 0.28, 0, 0, TAU); g.fill(); }
      g.fillStyle = '#ff5252'; for (const sx of [-1, 1]) { g.beginPath(); g.arc(sx * r * 0.33, -r * 0.12, r * 0.09, 0, TAU); g.fill(); }
      g.beginPath(); g.moveTo(0, r * 0.08); g.lineTo(-r * 0.08, r * 0.25); g.lineTo(r * 0.08, r * 0.25); g.fillStyle = '#3e2723'; g.fill();
      g.strokeStyle = '#5d4037'; g.lineWidth = 1.4;
      for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(i * r * 0.13, r * 0.42); g.lineTo(i * r * 0.13, r * 0.62); g.stroke(); }
      if (type === 'archer') { g.fillStyle = '#5d4037'; g.beginPath(); g.arc(0, -r * 0.35, r * 0.95, Math.PI * 1.05, Math.PI * 1.95); g.fill(); }
    } else if (type === 'brute') {
      ball(g, -r * 0.95, r * 0.15, r * 0.4, '#b0764a'); ball(g, r * 0.95, r * 0.15, r * 0.4, '#b0764a');
      ball(g, 0, 0, r, '#d08b52', OUTLINE, 3);
      g.fillStyle = 'rgba(120,70,40,0.35)'; g.beginPath(); g.ellipse(0, r * 0.4, r * 0.6, r * 0.35, 0, 0, TAU); g.fill();
      for (const sx of [-1, 1]) {
        g.beginPath(); g.moveTo(sx * r * 0.45, -r * 0.7); g.quadraticCurveTo(sx * r * 0.9, -r * 1.25, sx * r * 0.95, -r * 0.75);
        g.lineTo(sx * r * 0.7, -r * 0.6); g.closePath(); g.fillStyle = '#efe6d0'; g.fill(); g.lineWidth = 2; g.strokeStyle = OUTLINE; g.stroke();
      }
      eye(g, -r * 0.3, -r * 0.2, r * 0.18, '#d50000', '#ffee58'); eye(g, r * 0.3, -r * 0.2, r * 0.18, '#d50000', '#ffee58');
      g.strokeStyle = OUTLINE; g.lineWidth = 3;
      for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * r * 0.55, -r * 0.45); g.lineTo(sx * r * 0.12, -r * 0.3); g.stroke(); }
      g.fillStyle = '#fffde7';
      for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * r * 0.32, r * 0.25); g.lineTo(sx * r * 0.22, r * 0.62); g.lineTo(sx * r * 0.12, r * 0.25); g.fill(); g.lineWidth = 1.2; g.stroke(); }
    }
  }, 2);
  return MOB_SPR[key];
}

const GLOW = {};
function glow(name, color, r) { return GLOW[name] || (GLOW[name] = glowSprite(color, r)); }

// ───────────────────────── 파티클 ─────────────────────────
const parts = [];
let lastPartT = 0;
function emit(x, y, n, color, speed, life, size, opts = {}) {
  for (let i = 0; i < n && parts.length < 900; i++) {
    const a = opts.dir !== undefined ? opts.dir + (Math.random() - 0.5) * (opts.spread || 1) : Math.random() * TAU;
    const sp = speed * (0.4 + Math.random() * 0.8);
    parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opts.up || 0), life, max: life, size: size * (0.6 + Math.random() * 0.8), color, g: opts.g || 0, drag: opts.drag || 0.9 });
  }
}
function stepParticles(now) {
  const dt = Math.min(0.05, Math.max(0, now - lastPartT));
  lastPartT = now;
  let w = 0;
  for (const p of parts) {
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vx *= Math.pow(p.drag, dt * 30); p.vy = p.vy * Math.pow(p.drag, dt * 30) + p.g * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    parts[w++] = p;
  }
  parts.length = w;
}
function drawParticles(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    const k = p.life / p.max;
    ctx.globalAlpha = Math.min(1, k * 1.5);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// ───────────────────────── 메인 ─────────────────────────
export function drawWorld(ctx, W, H, v, cam, fx, now, myId, dpr = 1) {
  const s = cam.s;
  TS = Math.min(3, dpr / s); // 글자는 CSS 픽셀 기준 크기 유지
  decoSprites();
  stepParticles(now);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#16321d';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, W / 2 - cam.x * s, H / 2 - cam.y * s);

  const vx0 = cam.x - W / 2 / s, vy0 = cam.y - H / 2 / s, vx1 = cam.x + W / 2 / s, vy1 = cam.y + H / 2 / s;
  const vis = (x, y, pad = 60) => x > vx0 - pad && x < vx1 + pad && y > vy0 - pad && y < vy1 + pad;

  drawGroundChunks(ctx, vx0, vy0, vx1, vy1, s);
  drawGroundDynamic(ctx, vx0, vy0, vx1, vy1, v, now);

  // 위험 장판 (적: 빨강, 아군 스킬: 주황)
  for (const h of v.hz) {
    if (!vis(h.x, h.y, h.r)) continue;
    const prog = 1 - h.t / h.total, enemy = h.team === 1;
    const c = enemy ? '255,60,60' : '255,170,40';
    ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU);
    ctx.fillStyle = `rgba(${c},0.14)`; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = `rgba(${c},0.9)`; ctx.stroke();
    ctx.beginPath(); ctx.arc(h.x, h.y, Math.max(0, h.r * prog), 0, TAU);
    ctx.fillStyle = `rgba(${c},0.28)`; ctx.fill();
  }

  // 픽업
  for (const g of v.g) {
    if (!vis(g.x, g.y)) continue;
    const type = ITEM_IDS[g.type];
    if (type === 'gem') drawGem(ctx, g, now);
    else drawItem(ctx, g, type, now);
  }

  // 몬스터
  for (const m of v.m) {
    if (!vis(m.x, m.y)) continue;
    drawMob(ctx, m, MOB_TYPE_IDS[m.type], now);
  }

  // 오브젝트
  for (const o of v.o) {
    if (!o.alive || !vis(o.x, o.y, 160)) continue;
    drawObject(ctx, o, now);
  }

  // 보스
  const b = v.b;
  if (b && b.hp > 0 && vis(b.x, b.y, 260)) drawBoss(ctx, b, now);

  // 플레이어
  for (const p of v.p) {
    if (p.dead || !vis(p.x, p.y, 200)) continue;
    drawPlayer(ctx, p, now, p.id === myId, v.time);
  }

  // 투사체
  ctx.save();
  for (const pr of v.pr) if (vis(pr.x, pr.y)) drawProj(ctx, pr, now);
  ctx.restore();

  // 효과
  drawFx(ctx, fx, now);
  drawParticles(ctx);

  // 이름/체력바 (최상단)
  for (const o of v.o) {
    if (!o.alive || !vis(o.x, o.y, 160)) continue;
    const def = OBJECTS[OBJ_TYPE_IDS[o.type]], r = def.r * (o.tier === 2 ? 1.12 : 1);
    unitBar(ctx, o.x, o.y - r - 26, 96, 9, o.hp / o.maxHp, '#f0b232', null, o.maxHp);
    label(ctx, `${o.tier === 2 ? '★ ' : ''}${def.name}`, o.x, o.y - r - 26 - 14 * TS, 13, o.tier === 2 ? '#f0e6d2' : '#cdbe91');
  }
  for (const p of v.p) {
    if (p.dead || !vis(p.x, p.y, 200)) continue;
    const info = p.info || {};
    const me = p.id === myId;
    const by = p.y - PLAYER_RADIUS - 30;
    unitBar(ctx, p.x, by, 72, 9, p.hp / p.maxHp, me ? '#3fd16c' : '#e84057', p.level, p.maxHp);
    label(ctx, info.name || '?', p.x, by - 13 * TS, 12, info.color || '#fff');
    if (p.bounty) label(ctx, `💰 현상금 ★${p.bounty}`, p.x, by - 28 * TS, 12, '#f0b232');
  }

  // 화면 가장자리 비네트 (화면 크기별로 한 번만 그려 둠)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(vignette(W, H), 0, 0);
}

let VIG = null;
function vignette(W, H) {
  if (VIG && VIG.width === W && VIG.height === H) return VIG;
  VIG = makeCanvas(W, H);
  const g = VIG.getContext('2d');
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,10,20,0)'); vg.addColorStop(1, 'rgba(0,10,20,0.38)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return VIG;
}

// ───────────────────────── 지형 청크 캐시 ─────────────────────────
// 움직이지 않는 지형(잔디·길·강·광장·나무·바위)은 600×600 단위 조각으로 미리 그려 두고 찍기만 한다.
const CHUNK = 600, CHUNK_MAX = 30;
const chunks = new Map();
let chunkScale = 0, chunkTick = 0;
function drawGroundChunks(ctx, x0, y0, x1, y1, camScale) {
  const scale = Math.min(1, Math.max(0.4, Math.round(camScale * 4) / 4));
  if (scale !== chunkScale) { chunks.clear(); chunkScale = scale; }
  chunkTick++;
  let built = 0;
  const cx0 = Math.floor(x0 / CHUNK), cx1 = Math.floor(x1 / CHUNK), cy0 = Math.floor(y0 / CHUNK), cy1 = Math.floor(y1 / CHUNK);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const key = cx * 1000 + cy;
    let ch = chunks.get(key);
    if (!ch && built < 3) { ch = buildChunk(cx, cy, scale); chunks.set(key, ch); built++; }
    if (ch) { ch.used = chunkTick; ctx.drawImage(ch.c, cx * CHUNK, cy * CHUNK, CHUNK, CHUNK); }
    else { ctx.fillStyle = '#5a9a3e'; ctx.fillRect(cx * CHUNK, cy * CHUNK, CHUNK, CHUNK); } // 아직 안 만들어진 조각
  }
  if (chunks.size > CHUNK_MAX) {
    const old = [...chunks.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, chunks.size - CHUNK_MAX);
    for (const [k] of old) chunks.delete(k);
  }
}
function buildChunk(cx, cy, scale) {
  const px = Math.ceil(CHUNK * scale);
  const c = makeCanvas(px, px), g = c.getContext('2d');
  g.setTransform(scale, 0, 0, scale, -cx * CHUNK * scale, -cy * CHUNK * scale);
  const x0 = cx * CHUNK, y0 = cy * CHUNK, x1 = x0 + CHUNK, y1 = y0 + CHUNK;
  g.fillStyle = '#16321d'; g.fillRect(x0, y0, CHUNK, CHUNK);
  drawGroundStatic(g, x0, y0, x1, y1);
  drawDeco(g, x0, y0, x1, y1, ['bush', 'rock']);
  drawDeco(g, x0, y0, x1, y1, ['tree']);
  return { c, used: chunkTick };
}

// ───────────────────────── 지형 ─────────────────────────
function near(x, y, x0, y0, x1, y1, pad) { return x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad; }

// 정적 지형 (청크에 한 번만 그림)
function drawGroundStatic(ctx, x0, y0, x1, y1) {
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(MAP_W, x1), cy1 = Math.min(MAP_H, y1);
  if (cx1 > cx0 && cy1 > cy0) { ctx.fillStyle = pat(ctx, 'grass'); ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0); }
  // 강
  const dc = Math.hypot((x0 + x1) / 2 - CENTER.x, (y0 + y1) / 2 - CENTER.y);
  if (Math.abs(dc - RIVER_R) < Math.hypot(x1 - x0, y1 - y0) / 2 + RIVER_W) {
    ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, RIVER_R, 0, TAU);
    ctx.lineWidth = RIVER_W + 60; ctx.strokeStyle = '#cdb98a'; ctx.stroke();
    ctx.lineWidth = RIVER_W + 20; ctx.strokeStyle = '#2a7fb0'; ctx.stroke();
    ctx.lineWidth = RIVER_W - 30; ctx.strokeStyle = '#3aa0d6'; ctx.stroke();
  }
  // 흙길
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const [a, b] of LANES) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  ctx.lineWidth = 230; ctx.strokeStyle = 'rgba(70,95,40,0.55)'; ctx.stroke();
  ctx.lineWidth = 200; ctx.strokeStyle = '#8f6c40'; ctx.stroke();
  ctx.lineWidth = 180; ctx.strokeStyle = pat(ctx, 'dirt'); ctx.stroke();
  // 다리
  for (const br of BRIDGES) {
    if (!near(br.x, br.y, x0, y0, x1, y1, 300)) continue;
    ctx.save(); ctx.translate(br.x, br.y); ctx.rotate(br.a);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-RIVER_W / 2 - 40 + 8, -95 + 10, RIVER_W + 80, 190);
    ctx.fillStyle = '#8d6e4c'; ctx.fillRect(-RIVER_W / 2 - 40, -95, RIVER_W + 80, 190);
    ctx.strokeStyle = '#5d432b'; ctx.lineWidth = 3;
    for (let px = -RIVER_W / 2 - 40; px <= RIVER_W / 2 + 40; px += 22) { ctx.beginPath(); ctx.moveTo(px, -95); ctx.lineTo(px, 95); ctx.stroke(); }
    ctx.fillStyle = '#6d4c33'; ctx.fillRect(-RIVER_W / 2 - 46, -105, RIVER_W + 92, 14); ctx.fillRect(-RIVER_W / 2 - 46, 91, RIVER_W + 92, 14);
    ctx.restore();
  }
  // 시작 기지 광장
  for (const bs of BASES) {
    if (!near(bs.x, bs.y, x0, y0, x1, y1, 300)) continue;
    ctx.beginPath(); ctx.arc(bs.x, bs.y, 250, 0, TAU);
    ctx.fillStyle = pat(ctx, 'base'); ctx.fill();
    ctx.lineWidth = 14; ctx.strokeStyle = '#4b525b'; ctx.stroke();
    ctx.lineWidth = 4; ctx.strokeStyle = bs.color; ctx.globalAlpha = 0.7; ctx.stroke(); ctx.globalAlpha = 1;
  }
  // 보스 둥지 바닥
  const ar = BOSS_ARENA_R + 90;
  if (near(CENTER.x, CENTER.y, x0, y0, x1, y1, ar + 80)) {
    ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, ar + 40, 0, TAU); ctx.fillStyle = '#3b2f2a'; ctx.fill();
    ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, ar, 0, TAU); ctx.fillStyle = pat(ctx, 'arena'); ctx.fill();
    const grd = ctx.createRadialGradient(CENTER.x, CENTER.y, 50, CENTER.x, CENTER.y, ar);
    grd.addColorStop(0, 'rgba(170,80,255,0.35)'); grd.addColorStop(0.7, 'rgba(90,30,140,0.12)'); grd.addColorStop(1, 'rgba(20,0,40,0.45)');
    ctx.fillStyle = grd; ctx.fill();
    for (let i = 0; i < 28; i++) {
      const a = i / 28 * TAU;
      blit(ctx, SPR.rock[i % 3], CENTER.x + Math.cos(a) * (ar + 30), CENTER.y + Math.sin(a) * (ar + 30), 1.3);
    }
  }
  // 오브젝트 둥지
  OBJECT_SPOTS.forEach((sp, i) => {
    if (!near(sp.x, sp.y, x0, y0, x1, y1, 260)) return;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 170, 0, TAU); ctx.fillStyle = pat(ctx, 'dirt'); ctx.fill();
    const pg = ctx.createRadialGradient(sp.x, sp.y, 40, sp.x, sp.y, 170);
    pg.addColorStop(0, 'rgba(60,35,20,0.15)'); pg.addColorStop(1, 'rgba(50,30,15,0.55)');
    ctx.fillStyle = pg; ctx.fill();
    for (let k = 0; k < 14; k++) {
      const a = k / 14 * TAU + i;
      blit(ctx, SPR.rock[(k + i) % 3], sp.x + Math.cos(a) * 178, sp.y + Math.sin(a) * 178, sp.tier === 2 ? 1.15 : 0.95);
    }
    if (sp.tier === 2) { ctx.beginPath(); ctx.arc(sp.x, sp.y, 150, 0, TAU); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(240,178,50,0.6)'; ctx.stroke(); }
  });
  // 맵 경계 (숲 그늘)
  ctx.lineWidth = 30; ctx.strokeStyle = 'rgba(10,30,15,0.5)'; ctx.strokeRect(-15, -15, MAP_W + 30, MAP_H + 30);
}

// 움직이는 지형 요소 (매 프레임)
function drawGroundDynamic(ctx, x0, y0, x1, y1, v, now) {
  // 강물 반짝임
  const dc = Math.hypot((x0 + x1) / 2 - CENTER.x, (y0 + y1) / 2 - CENTER.y);
  if (Math.abs(dc - RIVER_R) < Math.hypot(x1 - x0, y1 - y0) / 2 + RIVER_W) {
    ctx.setLineDash([60, 140]); ctx.lineDashOffset = -now * 40;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(220,245,255,0.45)';
    for (const off of [-50, 0, 50]) { ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, RIVER_R + off, 0, TAU); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  // 기지: 회전하는 문양 + 수정
  for (const bs of BASES) {
    if (!near(bs.x, bs.y, x0, y0, x1, y1, 300)) continue;
    ctx.beginPath(); ctx.arc(bs.x, bs.y, 120, 0, TAU);
    ctx.lineWidth = 3; ctx.strokeStyle = bs.color; ctx.setLineDash([18, 12]); ctx.lineDashOffset = now * 10; ctx.stroke(); ctx.setLineDash([]);
    drawCrystal(ctx, bs.cx, bs.cy, bs.color, now);
  }
  // 보스 둥지 룬 원
  if (near(CENTER.x, CENTER.y, x0, y0, x1, y1, BOSS_ARENA_R + 100)) {
    ctx.save(); ctx.translate(CENTER.x, CENTER.y); ctx.rotate(now * 0.08);
    ctx.strokeStyle = 'rgba(200,150,255,0.45)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(0, 0, BOSS_ARENA_R - 40, 0, TAU); ctx.stroke();
    ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, BOSS_ARENA_R - 80, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(220,180,255,0.5)';
    for (let i = 0; i < 12; i++) { ctx.save(); ctx.rotate(i * TAU / 12); ctx.translate(BOSS_ARENA_R - 60, 0); ctx.rotate(Math.PI / 4); ctx.fillRect(-8, -8, 16, 16); ctx.restore(); }
    ctx.restore();
  }
  // 오브젝트 재등장 타이머
  v.o.forEach((o, i) => {
    const sp = OBJECT_SPOTS[i];
    if (!sp || o.alive || !near(sp.x, sp.y, x0, y0, x1, y1, 200)) return;
    ctx.save(); ctx.globalAlpha = 0.85;
    label(ctx, `${OBJECTS[OBJ_TYPE_IDS[o.type]].name}`, sp.x, sp.y - 10 * TS, 14, '#cdbe91');
    label(ctx, `재등장 ${o.respawn}s`, sp.x, sp.y + 8 * TS, 12, '#f0e6d2');
    ctx.restore();
  });
}

function drawCrystal(ctx, x, y, color, now) {
  const bob = Math.sin(now * 2) * 6;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(x + 8, y + 40, 44, 16, 0, 0, TAU); ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  blit(ctx, glow('crys' + color, hexA(color, 0.9), 90), x, y - 10 + bob);
  ctx.restore();
  ctx.save(); ctx.translate(x, y - 20 + bob);
  const grd = ctx.createLinearGradient(-30, -60, 30, 40);
  grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.35, color); grd.addColorStop(1, shade(color, -0.5));
  ctx.beginPath(); ctx.moveTo(0, -62); ctx.lineTo(28, -8); ctx.lineTo(0, 40); ctx.lineTo(-28, -8); ctx.closePath();
  ctx.fillStyle = grd; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -62); ctx.lineTo(0, 40); ctx.moveTo(-28, -8); ctx.lineTo(28, -8);
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke();
  ctx.restore();
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; }

function drawDeco(ctx, x0, y0, x1, y1, kinds) {
  const cx0 = Math.floor((x0 - 120) / DECO_CELL), cx1 = Math.floor((x1 + 120) / DECO_CELL);
  const cy0 = Math.floor((y0 - 120) / DECO_CELL), cy1 = Math.floor((y1 + 120) / DECO_CELL);
  const trees = kinds.includes('tree');
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const arr = deco.get(cx * 1000 + cy);
    if (!arr) continue;
    for (const d of arr) {
      if (!kinds.includes(d.kind)) continue;
      if (d.x < x0 - 120 || d.x > x1 + 120 || d.y < y0 - 120 || d.y > y1 + 120) continue;
      if (trees) blit(ctx, d.dark ? SPR.darkTree[d.v] : SPR.tree[d.v], d.x, d.y, d.s);
      else blit(ctx, d.kind === 'bush' ? SPR.bush[d.v] : SPR.rock[d.v], d.x, d.y, d.s);
    }
  }
}

// ───────────────────────── 픽업 ─────────────────────────
function drawGem(ctx, g, now) {
  const val = g.v / 10;
  const [c, gl] = val >= 20 ? ['#ff4f6e', 'rgba(255,80,110,0.9)'] : val >= 6 ? ['#52f2a4', 'rgba(80,240,160,0.9)'] : val >= 2 ? ['#4ad8ff', 'rgba(70,210,255,0.9)'] : ['#8fb4ff', 'rgba(140,180,255,0.9)'];
  const r = Math.min(5 + Math.sqrt(val) * 1.4, 13);
  const bob = Math.sin(now * 3 + g.id) * 2;
  if (val >= 2) { // 가장 흔한 작은 보석은 발광 생략 (성능)
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6;
    blit(ctx, glow('gem' + c, gl, 24), g.x, g.y + bob, r / 8);
    ctx.restore();
  }
  ctx.beginPath(); ctx.moveTo(g.x, g.y - r + bob); ctx.lineTo(g.x + r * 0.65, g.y + bob); ctx.lineTo(g.x, g.y + r + bob); ctx.lineTo(g.x - r * 0.65, g.y + bob); ctx.closePath();
  ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(10,20,40,0.8)'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(g.x, g.y - r + bob); ctx.lineTo(g.x + r * 0.65, g.y + bob); ctx.lineTo(g.x, g.y + bob); ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();
}
const ITEM_GLYPH = { meat: '🍖', magnet: '🧲', bomb: '💣', chest: '🎁' };
function drawItem(ctx, g, type, now) {
  const it = ITEMS[type];
  const bob = Math.sin(now * 4 + g.id) * 4;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(g.x, g.y + 16, 14, 5, 0, 0, TAU); ctx.fill();
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.7;
  blit(ctx, glow('item' + type, hexA(it.color, 0.9), 34), g.x, g.y + bob);
  ctx.restore();
  ctx.beginPath(); ctx.arc(g.x, g.y + bob, 15, 0, TAU);
  ctx.fillStyle = '#0a1428'; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = '#c8aa6e'; ctx.stroke();
  ctx.font = `18px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ITEM_GLYPH[type], g.x, g.y + bob + 1);
}

// ───────────────────────── 유닛 ─────────────────────────
function drawMob(ctx, m, type, now) {
  const def = MOBS[type];
  const frame = type === 'bat' ? Math.floor((now * 10 + m.id) % 3) : 0;
  const bounce = type === 'bat' ? Math.sin(now * 6 + m.id) * 3 : Math.abs(Math.sin(now * 7 + m.id)) * -2;
  blit(ctx, mobSprite(type, frame), m.x, m.y + bounce);
  if (m.flags & STATUS_BITS.freeze) {
    ctx.beginPath(); ctx.arc(m.x, m.y, def.r * 1.05, 0, TAU);
    ctx.fillStyle = 'rgba(190,235,255,0.6)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#e1f5fe'; ctx.stroke();
  }
  statusRing(ctx, m.x, m.y, def.r, m.flags, now);
  if (m.hp < 100) {
    const w = def.r * 2.2, y = m.y - def.r - 9;
    ctx.fillStyle = '#010a13'; ctx.fillRect(m.x - w / 2 - 1, y - 1, w + 2, 5);
    ctx.fillStyle = '#e84057'; ctx.fillRect(m.x - w / 2, y, w * m.hp / 100, 3);
  }
}

function drawObject(ctx, o, now) {
  const type = OBJ_TYPE_IDS[o.type], def = OBJECTS[type];
  const r = def.r * (o.tier === 2 ? 1.12 : 1);
  const x = o.x, y = o.y + Math.sin(now * 2 + o.id) * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(o.x + 6, o.y + r * 0.85, r * 1.05, r * 0.4, 0, 0, TAU); ctx.fill();
  if (o.tier === 2) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5;
    blit(ctx, glow('elite', 'rgba(255,200,60,0.9)', 120), x, y, r / 55);
    ctx.restore();
  }
  if (type === 'golem') {
    ctx.save(); ctx.translate(x, y);
    const pts = [[-1, -0.6], [-0.3, -1.05], [0.55, -0.9], [1.05, -0.2], [0.8, 0.75], [0, 1.05], [-0.85, 0.7], [-1.1, 0.05]];
    ctx.beginPath(); pts.forEach(([a, b], i) => i ? ctx.lineTo(a * r, b * r) : ctx.moveTo(a * r, b * r)); ctx.closePath();
    const grd = ctx.createLinearGradient(-r, -r, r, r); grd.addColorStop(0, '#a9b8c6'); grd.addColorStop(1, '#4d5a68');
    ctx.fillStyle = grd; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = OUTLINE; ctx.stroke();
    for (const sx of [-1, 1]) ball(ctx, sx * r * 1.05, r * 0.25, r * 0.38, '#7d8b99', OUTLINE, 3);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(80,230,255,${0.6 + Math.sin(now * 4) * 0.3})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-r * 0.5, r * 0.1); ctx.lineTo(-r * 0.1, r * 0.35); ctx.lineTo(r * 0.2, r * 0.15); ctx.lineTo(r * 0.55, r * 0.5); ctx.stroke();
    ctx.fillStyle = '#7ef9ff';
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * r * 0.32, -r * 0.35, r * 0.13, r * 0.08, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
  } else if (type === 'wyvern') {
    ctx.save(); ctx.translate(x, y);
    const flap = Math.sin(now * 5 + o.id) * 0.25;
    for (const sx of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(sx * r * 0.4, -r * 0.2);
      ctx.quadraticCurveTo(sx * r * 1.6, -r * (1.2 + flap), sx * r * 2.3, -r * (0.2 + flap));
      ctx.lineTo(sx * r * 1.7, r * 0.15); ctx.lineTo(sx * r * 1.3, -r * 0.05); ctx.lineTo(sx * r * 1.0, r * 0.4); ctx.lineTo(sx * r * 0.5, r * 0.3);
      ctx.closePath(); ctx.fillStyle = '#e85a3c'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.strokeStyle = 'rgba(120,20,10,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx * r * 0.5, -r * 0.1); ctx.lineTo(sx * r * 1.7, r * 0.1); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, r * 0.6); ctx.quadraticCurveTo(r * 0.3, r * 1.3, 0, r * 1.7); ctx.lineWidth = r * 0.3; ctx.strokeStyle = '#c0392b'; ctx.lineCap = 'round'; ctx.stroke();
    ball(ctx, 0, 0, r * 0.75, '#e74c3c', OUTLINE, 3);
    ball(ctx, 0, -r * 0.7, r * 0.42, '#f0624d', OUTLINE, 3);
    ctx.fillStyle = '#fff3c4'; for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sx * r * 0.2, -r * 1.0); ctx.lineTo(sx * r * 0.35, -r * 1.35); ctx.lineTo(sx * r * 0.38, -r * 0.92); ctx.fill(); }
    ctx.fillStyle = '#ffeb3b'; for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * r * 0.17, -r * 0.78, r * 0.09, r * 0.06, sx * 0.4, 0, TAU); ctx.fill(); }
    ctx.restore();
  } else { // lich
    ctx.save(); ctx.translate(x, y);
    ctx.globalCompositeOperation = 'lighter';
    blit(ctx, glow('lich', 'rgba(160,90,255,0.8)', 90), 0, 0, r / 40);
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.moveTo(0, -r * 0.9); ctx.bezierCurveTo(r * 1.2, -r * 0.6, r * 1.1, r * 0.9, r * 0.6, r * 1.1);
    ctx.lineTo(0, r * 0.85); ctx.lineTo(-r * 0.6, r * 1.1); ctx.bezierCurveTo(-r * 1.1, r * 0.9, -r * 1.2, -r * 0.6, 0, -r * 0.9);
    const grd = ctx.createLinearGradient(0, -r, 0, r); grd.addColorStop(0, '#7e57c2'); grd.addColorStop(1, '#311b92');
    ctx.fillStyle = grd; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ball(ctx, 0, -r * 0.25, r * 0.45, '#ece6d6', OUTLINE, 2.5);
    ctx.fillStyle = '#2b1b1b'; for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * r * 0.17, -r * 0.3, r * 0.12, r * 0.14, 0, 0, TAU); ctx.fill(); }
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#76ff03'; for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(sx * r * 0.17, -r * 0.28, r * 0.07, 0, TAU); ctx.fill(); }
    for (let i = 0; i < 3; i++) {
      const a = now * 1.6 + i * TAU / 3;
      blit(ctx, glow('lorb', 'rgba(120,255,120,0.9)', 16), Math.cos(a) * r * 1.35, Math.sin(a) * r * 1.0, 1);
    }
    ctx.restore();
  }
  statusRing(ctx, o.x, o.y, r, o.flags, now);
}

function drawBoss(ctx, b, now) {
  const sealed = b.seal > 0, r = BOSS.r;
  const pulse = 1 + Math.sin(now * 2.5) * 0.03;
  ctx.save();
  ctx.globalAlpha = sealed ? 0.6 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(b.x + 10, b.y + r * 0.9, r * 1.2, r * 0.45, 0, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  blit(ctx, glow(b.enraged ? 'bossR' : 'boss', b.enraged ? 'rgba(255,40,80,0.8)' : 'rgba(170,60,255,0.75)', 160), b.x, b.y, 1.3 * pulse);
  ctx.globalCompositeOperation = 'source-over';
  ctx.translate(b.x, b.y);
  // 촉수
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU + 0.2, wob = Math.sin(now * 2 + i) * 0.25;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
    ctx.quadraticCurveTo(Math.cos(a + wob) * r * 1.35, Math.sin(a + wob) * r * 1.35, Math.cos(a + wob * 2) * r * 1.65, Math.sin(a + wob * 2) * r * 1.65);
    ctx.lineWidth = 16; ctx.lineCap = 'round'; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.lineWidth = 11; ctx.strokeStyle = b.enraged ? '#8e1b4a' : '#4a2a86'; ctx.stroke();
  }
  // 등가시
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU;
    ctx.beginPath(); ctx.moveTo(Math.cos(a - 0.12) * r * 0.9, Math.sin(a - 0.12) * r * 0.9);
    ctx.lineTo(Math.cos(a) * r * 1.22 * pulse, Math.sin(a) * r * 1.22 * pulse); ctx.lineTo(Math.cos(a + 0.12) * r * 0.9, Math.sin(a + 0.12) * r * 0.9);
    ctx.fillStyle = '#d9c7ff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }
  ball(ctx, 0, 0, r * pulse, b.enraged ? '#b0285e' : '#6a3fb5', OUTLINE, 4);
  ctx.fillStyle = 'rgba(30,0,40,0.35)'; ctx.beginPath(); ctx.ellipse(0, r * 0.25, r * 0.7, r * 0.5, 0, 0, TAU); ctx.fill();
  // 입
  ctx.beginPath(); ctx.ellipse(0, r * 0.32, r * 0.45, r * 0.22, 0, 0, TAU); ctx.fillStyle = '#1a0010'; ctx.fill();
  ctx.fillStyle = '#fff6e0';
  for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.12 - 6, r * 0.14); ctx.lineTo(i * r * 0.12, r * 0.3); ctx.lineTo(i * r * 0.12 + 6, r * 0.14); ctx.fill(); }
  // 눈 (5개)
  ctx.globalCompositeOperation = 'lighter';
  const eyeC = b.enraged ? '#ffee58' : '#ff5a8a';
  for (const [ex, ey, er] of [[-0.32, -0.25, 0.13], [0.32, -0.25, 0.13], [0, -0.45, 0.1], [-0.55, -0.02, 0.08], [0.55, -0.02, 0.08]]) {
    ctx.fillStyle = eyeC; ctx.beginPath(); ctx.arc(ex * r, ey * r, er * r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex * r, ey * r, er * r * 0.35, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  if (sealed) {
    ctx.save(); ctx.translate(b.x, b.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(140,220,255,0.6)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, r + 40, 0, TAU); ctx.stroke();
    ctx.rotate(now * 0.6);
    ctx.setLineDash([24, 16]); ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(200,240,255,0.7)';
    ctx.beginPath(); ctx.arc(0, 0, r + 26, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    label(ctx, `봉인 — ${fmtTime(b.seal)} 후 해제`, b.x, b.y + r + 62, 16, '#a8e6ff');
  }
  statusRing(ctx, b.x, b.y, r, b.flags, now);
  label(ctx, BOSS.name, b.x, b.y - r - 48, 18, '#e8d4ff');
}

const CLASS_STATUS_KEYS = Object.keys(STATUSES);
function statusRing(ctx, x, y, r, f, now) {
  if (!f) return;
  // 클래스 상태이상: 몸 둘레를 상태 수만큼 나눈 회전하는 색 띠
  const on = CLASS_STATUS_KEYS.filter(k => f & STATUS_BITS[k]);
  if (on.length) {
    const seg = TAU / on.length, base = now * 2;
    ctx.lineWidth = 3;
    on.forEach((k, i) => {
      ctx.beginPath(); ctx.arc(x, y, r + 4, base + i * seg, base + (i + 1) * seg - (on.length > 1 ? 0.18 : 0));
      ctx.strokeStyle = STATUSES[k].color; ctx.stroke();
    });
  }
  if ((f & STATUS_BITS.slow) && !(f & STATUS_BITS.frost)) { ctx.beginPath(); ctx.arc(x, y, r + 7, 0, TAU); ctx.strokeStyle = 'rgba(79,195,247,0.6)'; ctx.lineWidth = 1.5; ctx.stroke(); }
  if (f & STATUS_BITS.mark) { // 빛의 인장: 머리 위 회전하는 금색 마름모
    const s = 5 + Math.sin(now * 8) * 1.2, my = y - r - 17;
    ctx.save(); ctx.translate(x, my); ctx.rotate(now * 3);
    ctx.fillStyle = '#fff59d'; ctx.strokeStyle = '#f9a825'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  if (f & (STATUS_BITS.stun | STATUS_BITS.freeze)) {
    ctx.fillStyle = '#ffee58';
    for (let i = 0; i < 3; i++) {
      const a = now * 5 + i * TAU / 3;
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.8, y - r - 4 + Math.sin(a) * 3, 3, 0, TAU); ctx.fill();
    }
  }
}

// ───────────────────────── 챔피언 ─────────────────────────
// 로컬 좌표: +x = 바라보는 방향, +y = 오른손 쪽
export function drawChampion(g, clsId, now = 0) {
  const R = PLAYER_RADIUS;
  const breathe = Math.sin(now * 4) * 0.6;
  switch (clsId) {
    case 'warrior': {
      ball(g, -6, 0, R * 0.95, '#b23a32');                           // 망토/몸
      ball(g, 0, -14, 7, '#9eaab6'); ball(g, 0, 14, 7, '#9eaab6');   // 견갑
      // 대검
      g.lineCap = 'round';
      g.strokeStyle = OUTLINE; g.lineWidth = 8; g.beginPath(); g.moveTo(4, 15); g.lineTo(40, 15); g.stroke();
      g.strokeStyle = '#e8eef2'; g.lineWidth = 5; g.beginPath(); g.moveTo(5, 15); g.lineTo(39, 15); g.stroke();
      g.strokeStyle = '#d9a43a'; g.lineWidth = 4; g.beginPath(); g.moveTo(8, 8); g.lineTo(8, 22); g.stroke();
      ball(g, 0, 0, 10 + breathe * 0.2, '#c7d0d8');                  // 투구
      g.fillStyle = '#f2ead8';
      for (const sy of [-1, 1]) { g.beginPath(); g.moveTo(-2, sy * 7); g.quadraticCurveTo(-12, sy * 16, -16, sy * 10); g.lineTo(-5, sy * 4); g.closePath(); g.fill(); g.lineWidth = 1.6; g.strokeStyle = OUTLINE; g.stroke(); }
      g.fillStyle = '#20252b'; g.fillRect(4, -5, 3, 10);
      break;
    }
    case 'rifleman': {
      ball(g, -6, 0, R * 0.92, '#7a5236');
      g.lineCap = 'round';
      g.strokeStyle = OUTLINE; g.lineWidth = 7; g.beginPath(); g.moveTo(-8, 11); g.lineTo(42, 11); g.stroke();
      g.strokeStyle = '#3a4650'; g.lineWidth = 4; g.beginPath(); g.moveTo(4, 11); g.lineTo(41, 11); g.stroke();
      g.strokeStyle = '#9c6b45'; g.lineWidth = 6; g.beginPath(); g.moveTo(-8, 11); g.lineTo(6, 11); g.stroke();
      ball(g, 0, 0, 14, '#5b3f2c');                                   // 챙
      ball(g, -1, 0, 8, '#6f4c35');                                   // 모자 윗부분
      g.strokeStyle = '#c8aa6e'; g.lineWidth = 2; g.beginPath(); g.arc(-1, 0, 8, 0, TAU); g.stroke();
      break;
    }
    case 'mage': {
      ball(g, -6, 0, R, '#5b3aa8');
      g.lineCap = 'round';
      g.strokeStyle = OUTLINE; g.lineWidth = 6; g.beginPath(); g.moveTo(-14, 14); g.lineTo(32, 14); g.stroke();
      g.strokeStyle = '#8d5a33'; g.lineWidth = 3.5; g.beginPath(); g.moveTo(-13, 14); g.lineTo(31, 14); g.stroke();
      g.save(); g.globalCompositeOperation = 'lighter';
      blit(g, glow('orbM', 'rgba(190,120,255,0.95)', 20), 35, 14, 1 + breathe * 0.05);
      g.restore();
      ball(g, 35, 14, 5.5, '#d5b8ff');
      ball(g, 0, 0, 13, '#4527a0');                                   // 모자 챙
      ball(g, 3, 0, 7, '#6a49c8');                                    // 뾰족한 끝
      g.fillStyle = '#ffd54f'; g.beginPath(); g.arc(-4, -4, 2.2, 0, TAU); g.fill();
      break;
    }
    case 'spellblade': {
      ball(g, -6, 0, R * 0.95, '#1d7f74');
      ball(g, 0, -13, 6.5, '#2fa596'); ball(g, 0, 13, 6.5, '#2fa596');
      g.lineCap = 'round';
      g.save(); g.globalCompositeOperation = 'lighter';
      g.strokeStyle = 'rgba(80,240,255,0.55)'; g.lineWidth = 12; g.beginPath(); g.moveTo(8, 15); g.lineTo(38, 15); g.stroke();
      g.restore();
      g.strokeStyle = OUTLINE; g.lineWidth = 6; g.beginPath(); g.moveTo(5, 15); g.lineTo(38, 15); g.stroke();
      g.strokeStyle = '#b8fbff'; g.lineWidth = 3.5; g.beginPath(); g.moveTo(6, 15); g.lineTo(37, 15); g.stroke();
      ball(g, 0, 0, 10, '#164f4a');                                   // 두건
      g.fillStyle = '#7ff6ff'; g.beginPath(); g.ellipse(6, -3, 1.6, 1.2, 0, 0, TAU); g.ellipse(6, 3, 1.6, 1.2, 0, 0, TAU); g.fill();
      break;
    }
    case 'assassin': {
      ball(g, -6, 0, R * 0.9, '#3a4452');
      g.lineCap = 'round';
      for (const sy of [-1, 1]) {
        g.strokeStyle = OUTLINE; g.lineWidth = 5; g.beginPath(); g.moveTo(4, sy * 13); g.lineTo(24, sy * 13); g.stroke();
        g.strokeStyle = '#dfe6ea'; g.lineWidth = 2.6; g.beginPath(); g.moveTo(8, sy * 13); g.lineTo(23, sy * 13); g.stroke();
      }
      ball(g, 0, 0, 10, '#232a33');
      g.fillStyle = '#ff4060'; g.fillRect(5, -5, 2.4, 10);
      break;
    }
    case 'paladin': {
      ball(g, -6, 0, R, '#e9e4d6');
      g.fillStyle = '#c62828'; g.beginPath(); g.ellipse(-12, 0, 6, 12, 0, 0, TAU); g.fill();
      ball(g, 6, -14, 9, '#2f5fa8', OUTLINE, 2.2);                    // 방패
      g.strokeStyle = '#f0c040'; g.lineWidth = 2; g.beginPath(); g.arc(6, -14, 9, 0, TAU); g.stroke();
      g.beginPath(); g.moveTo(6, -19); g.lineTo(6, -9); g.moveTo(1, -14); g.lineTo(11, -14); g.stroke();
      g.lineCap = 'round';
      g.strokeStyle = OUTLINE; g.lineWidth = 5; g.beginPath(); g.moveTo(-2, 14); g.lineTo(28, 14); g.stroke();
      g.strokeStyle = '#8d6e4c'; g.lineWidth = 3; g.beginPath(); g.moveTo(-1, 14); g.lineTo(27, 14); g.stroke();
      g.fillStyle = '#b8c2cc'; g.beginPath(); g.roundRect(24, 7, 11, 14, 2); g.fill(); g.lineWidth = 2; g.strokeStyle = OUTLINE; g.stroke();
      ball(g, 0, 0, 10, '#f2c94c');                                   // 금빛 투구
      g.fillStyle = '#c62828'; g.beginPath(); g.ellipse(-6, 0, 7, 2.5, 0, 0, TAU); g.fill();
      break;
    }
  }
}

// 초상화 (HUD/로비용) — dataURL 캐시
const PORTRAITS = {};
export function classPortrait(clsId, size = 64) {
  const key = clsId + size;
  if (PORTRAITS[key]) return PORTRAITS[key];
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const grd = g.createRadialGradient(size * 0.4, size * 0.35, 2, size / 2, size / 2, size * 0.7);
  grd.addColorStop(0, shade(CLASSES[clsId].color, 0.15)); grd.addColorStop(1, '#0a1428');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  g.translate(size / 2 - size * 0.08, size / 2); g.scale(size / 64, size / 64); g.rotate(-Math.PI / 2 + 0.5);
  drawChampion(g, clsId);
  return (PORTRAITS[key] = c.toDataURL());
}

function drawPlayer(ctx, p, now, isMe, serverTime) {
  const info = p.info || {};
  const clsId = CLASS_IDS[p.cls];
  const r = PLAYER_RADIUS, color = info.color || '#fff';
  const f = p.flags;
  // 오라
  if (p.aura) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.aura, 0, TAU);
    ctx.fillStyle = 'rgba(255,220,90,0.06)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,220,90,${0.3 + Math.sin(now * 5) * 0.12})`; ctx.stroke();
    ctx.restore();
  }
  // 발밑 선택 링 (팀 색)
  ctx.save();
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, r + 10, (r + 10) * 0.75, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
  ctx.lineWidth = isMe ? 3.5 : 2.5; ctx.strokeStyle = color; ctx.globalAlpha = isMe ? 1 : 0.85; ctx.stroke();
  if (isMe) { ctx.globalAlpha = 0.35; ctx.lineWidth = 8; ctx.stroke(); }
  ctx.restore();
  // 회전 칼날
  if (p.orb) {
    const rot = p.orbRot / 100;
    for (let i = 0; i < p.orb; i++) {
      const a = serverTime * rot + i * TAU / p.orb;
      const bx = p.x + Math.cos(a) * p.orbR, by = p.y + Math.sin(a) * p.orbR;
      ctx.save(); ctx.translate(bx, by); ctx.rotate(a + Math.PI / 2);
      ctx.globalCompositeOperation = 'lighter'; blit(ctx, glow('orbit', 'rgba(200,230,255,0.7)', 20), 0, 0); ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(7, 0); ctx.lineTo(0, 16); ctx.lineTo(-7, 0); ctx.closePath();
      ctx.fillStyle = '#eef3f7'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.restore();
    }
  }
  if (f & STATUS_BITS.whirl) {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(now * 18); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,120,90,0.75)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(0, 0, 70 + i * 30, i * 2, i * 2 + 1.4); ctx.stroke(); }
    ctx.restore();
  }
  ctx.save();
  if (f & STATUS_BITS.invuln) ctx.globalAlpha = 0.5 + Math.sin(now * 30) * 0.25;
  ctx.translate(p.x, p.y);
  ctx.rotate(p.face / 100);
  drawChampion(ctx, clsId, now);
  ctx.restore();
  if (f & STATUS_BITS.shield) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    blit(ctx, glow('shield', 'rgba(255,230,120,0.7)', 40), p.x, p.y, 1.1);
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 12, 0, TAU); ctx.lineWidth = 3; ctx.strokeStyle = '#ffe082'; ctx.stroke();
    ctx.restore();
  }
  if (f & STATUS_BITS.crit) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 6, 0, TAU);
    ctx.lineWidth = 2.5; ctx.strokeStyle = `rgba(255,70,70,${0.5 + Math.sin(now * 15) * 0.4})`; ctx.stroke();
  }
  statusRing(ctx, p.x, p.y, r, f & ~(STATUS_BITS.invuln | STATUS_BITS.shield | STATUS_BITS.whirl | STATUS_BITS.crit), now);
}

// ───────────────────────── 투사체 ─────────────────────────
const PROJ = {
  bullet:   { core: '#fffbe0', glow: 'rgba(255,220,120,0.9)', len: 22, w: 3.5, gr: 10 },
  dagger:   { core: '#eef3f7', glow: 'rgba(170,220,255,0.7)', len: 16, w: 3, gr: 9, dagger: true },
  fireball: { core: '#fff3c0', glow: 'rgba(255,120,40,0.95)', gr: 34, ball: '#ff8a3d' },
  wave:     { core: '#d8ffff', glow: 'rgba(60,230,255,0.8)', wave: true },
  missile:  { core: '#cfd8dc', glow: 'rgba(255,140,60,0.9)', len: 12, w: 5, gr: 14 },
  mbolt:    { core: '#e7d6ff', glow: 'rgba(170,90,255,0.95)', gr: 22, ball: '#b388ff' },
  arrow:    { core: '#efe6d8', glow: null, len: 18, w: 2.5 },
  rock:     { core: '#8d7a68', glow: null, rock: true },
  fire:     { core: '#ffe0a0', glow: 'rgba(255,90,30,0.95)', gr: 26, ball: '#ff6d2e' },
  grenade:  { core: '#6b8e23', glow: null, ball: '#6b8e23' },
  boss:     { core: '#ffd6ff', glow: 'rgba(230,60,255,0.95)', gr: 24, ball: '#e040fb' },
};
function drawProj(ctx, pr, now) {
  const st = PROJ[PROJ_KINDS[pr.kind]] || PROJ.bullet;
  const a = pr.ang / 100, ca = Math.cos(a), sa = Math.sin(a);
  if (st.glow && st.gr) {
    ctx.globalCompositeOperation = 'lighter';
    blit(ctx, glow('p' + st.glow, st.glow, st.gr), pr.x, pr.y, Math.max(1, pr.r / 10));
    ctx.globalCompositeOperation = 'source-over';
  }
  if (st.wave) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = st.glow; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(pr.x - ca * pr.r, pr.y - sa * pr.r, pr.r * 1.4, a - 0.9, a + 0.9); ctx.stroke();
    ctx.strokeStyle = st.core; ctx.lineWidth = 4; ctx.stroke();
    ctx.restore();
  } else if (st.len) {
    ctx.lineCap = 'round';
    if (st.glow) {
      ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = st.glow; ctx.lineWidth = st.w * 2.5;
      ctx.beginPath(); ctx.moveTo(pr.x - ca * st.len * 1.6, pr.y - sa * st.len * 1.6); ctx.lineTo(pr.x, pr.y); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = st.core; ctx.lineWidth = st.w;
    ctx.beginPath(); ctx.moveTo(pr.x - ca * st.len, pr.y - sa * st.len); ctx.lineTo(pr.x, pr.y); ctx.stroke();
  } else if (st.rock) {
    ball(ctx, pr.x, pr.y, pr.r, '#8d7a68', OUTLINE, 2);
  } else {
    if (st.ball) ball(ctx, pr.x, pr.y, pr.r * 0.85, st.ball, pr.team === 1 ? OUTLINE : null, 1.5);
    ctx.beginPath(); ctx.arc(pr.x - pr.r * 0.2, pr.y - pr.r * 0.2, pr.r * 0.4, 0, TAU); ctx.fillStyle = st.core; ctx.fill();
  }
}

// ───────────────────────── 효과 ─────────────────────────
const FX_COLORS = ['#ff8a50', '#aed581', '#ffd54f', '#ffffff', '#ff5252', '#fff59d'];
function drawFx(ctx, fx, now) {
  for (const e of fx) {
    const t = (now - e.at) / e.dur;
    if (t < 0 || t > 1) continue;
    if (!e.emitted) { e.emitted = true; emitFor(e); }
    const k = 1 - t;
    switch (e.type) {
      case 'arc': {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const cls = CLASS_IDS[e.cls];
        const c = cls === 'spellblade' ? '80,230,255' : cls === 'warrior' ? '255,190,140' : '255,255,255';
        const grd = ctx.createRadialGradient(e.x, e.y, e.r * 0.3, e.x, e.y, e.r);
        grd.addColorStop(0, `rgba(${c},0)`); grd.addColorStop(0.8, `rgba(${c},${0.55 * k})`); grd.addColorStop(1, `rgba(${c},${0.9 * k})`);
        ctx.fillStyle = grd;
        const sweep = e.w * (0.3 + 0.7 * Math.min(1, t * 3));
        ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.arc(e.x, e.y, e.r, e.a - e.w / 2, e.a - e.w / 2 + sweep); ctx.closePath(); ctx.fill();
        ctx.restore();
        break;
      }
      case 'boom': {
        const col = FX_COLORS[e.kind] || '#fff';
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const rr = e.r * (0.35 + 0.65 * Math.sqrt(t));
        const grd = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rr);
        grd.addColorStop(0, hexA(toHex(col), 0.6 * k)); grd.addColorStop(0.7, hexA(toHex(col), 0.25 * k)); grd.addColorStop(1, hexA(toHex(col), 0));
        ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(e.x, e.y, rr, 0, TAU); ctx.fill();
        ctx.lineWidth = 5 * k + 1; ctx.strokeStyle = hexA(toHex(col), 0.9 * k); ctx.stroke();
        ctx.restore();
        break;
      }
      case 'nova': {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.25 + 0.75 * t), 0, TAU);
        ctx.lineWidth = 10 * k + 2;
        ctx.strokeStyle = e.kind === 1 ? `rgba(255,90,70,${k})` : e.kind === 2 ? `rgba(225,250,255,${k})` : `rgba(120,215,255,${k})`;
        ctx.stroke(); ctx.restore();
        break;
      }
      case 'bolt': {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.lineJoin = 'round';
        const path = () => { ctx.beginPath(); ctx.moveTo(e.x + 20, e.y - 420); let y = e.y - 420; while (y < e.y) { y += 46; ctx.lineTo(e.x + (y < e.y ? Math.sin(y * 13.7 + e.seed) * 24 : 0), Math.min(y, e.y)); } };
        path(); ctx.strokeStyle = `rgba(150,200,255,${0.5 * k})`; ctx.lineWidth = 14; ctx.stroke();
        path(); ctx.strokeStyle = `rgba(255,255,230,${k})`; ctx.lineWidth = 4; ctx.stroke();
        ctx.restore();
        break;
      }
      case 'line': {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = e.kind === 1 ? `rgba(160,170,190,${k})` : e.kind === 2 ? `rgba(156,220,101,${k})` : `rgba(80,230,255,${k})`;
        ctx.lineWidth = (e.kind === 2 ? 5 : 18) * k + 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x2, e.y2); ctx.stroke();
        ctx.restore();
        break;
      }
      case 'skill':
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.arc(e.x, e.y, 30 + 60 * t, 0, TAU);
        ctx.lineWidth = 4 * k + 1; ctx.strokeStyle = `rgba(255,240,200,${0.8 * k})`; ctx.stroke();
        ctx.restore();
        break;
      case 'die':
        label(ctx, '💀', e.x, e.y - 30 * t, 30, `rgba(255,255,255,${k})`);
        break;
      case 'text': {
        ctx.save();
        ctx.globalAlpha = Math.min(1, k * 2.5);
        const pop = t < 0.15 ? 1 + (0.15 - t) * 3 : 1;
        label(ctx, e.text, e.x, e.y - 46 * t, e.size * pop, e.color, true);
        ctx.restore();
        break;
      }
    }
  }
}
function toHex(c) { return c.length === 7 ? c : '#ffffff'; }
function emitFor(e) {
  switch (e.type) {
    case 'boom': emit(e.x, e.y, Math.min(26, 8 + e.r / 10), FX_COLORS[e.kind] || '#fff', e.r * 2.2, 0.55, 4); break;
    case 'nova': emit(e.x, e.y, 18, e.kind === 1 ? '#ff7a6a' : '#cdf3ff', e.r * 2.4, 0.45, 3.5); break;
    case 'bolt': emit(e.x, e.y, 14, '#fff7b0', 260, 0.4, 3); break;
    case 'skill': emit(e.x, e.y, 14, '#ffe9b0', 180, 0.6, 3.5, { up: 60 }); break;
    case 'die': emit(e.x, e.y, 24, '#c8c8d8', 200, 0.9, 5, { drag: 0.85 }); break;
    case 'text':
      if (e.text === 'LEVEL UP!') emit(e.x, e.y + 30, 30, '#ffd86b', 120, 1.1, 4, { up: 160, g: -40, dir: -Math.PI / 2, spread: 1.2 });
      else if (e.color === '#ffeb3b') emit(e.x, e.y + 6, 6, '#ffe36b', 160, 0.35, 2.5);
      break;
  }
}

// ───────────────────────── 체력바/글자 ─────────────────────────
// 검은 테두리 + 칸 눈금 + 왼쪽 레벨 칸
function unitBar(ctx, x, y, w, h, frac, color, level, maxHp) {
  frac = Math.max(0, Math.min(1, frac));
  w *= TS; h *= TS;
  const lw = level ? h * 1.9 : 0;
  const bx = x - w / 2 + lw / 2, by = y - h / 2;
  ctx.fillStyle = '#010a13';
  ctx.fillRect(bx - w / 2 - lw / 2 - 2 * TS, by - 2 * TS, w + 4 * TS, h + 4 * TS);
  const inner = w - lw;
  const x0 = bx - w / 2 + lw / 2;
  const grd = ctx.createLinearGradient(0, by, 0, by + h);
  grd.addColorStop(0, shade(rgbHex(color), 0.25)); grd.addColorStop(1, shade(rgbHex(color), -0.25));
  ctx.fillStyle = '#1e2328'; ctx.fillRect(x0, by, inner, h);
  ctx.fillStyle = grd; ctx.fillRect(x0, by, inner * frac, h);
  // 100 체력마다 눈금
  if (maxHp > 0) {
    const step = maxHp > 3000 ? 1000 : 100;
    ctx.fillStyle = 'rgba(1,10,19,0.75)';
    for (let v = step; v < maxHp; v += step) ctx.fillRect(x0 + inner * v / maxHp, by, Math.max(1, TS * (v % (step * 10) ? 0.8 : 1.6)), h * (v % (step * 10) ? 0.55 : 1));
  }
  if (level) {
    const lx = x - w / 2 - 2 * TS;
    ctx.fillStyle = '#1e2328'; ctx.fillRect(lx, by - 2 * TS, lw + 2 * TS, h + 4 * TS);
    ctx.strokeStyle = '#785a28'; ctx.lineWidth = TS; ctx.strokeRect(lx + 0.5 * TS, by - 1.5 * TS, lw + TS, h + 3 * TS);
    ctx.font = `bold ${Math.round(h * 0.95)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f0e6d2'; ctx.fillText(level, lx + lw / 2 + TS, by + h / 2 + 0.5 * TS);
  }
}
function rgbHex(c) { return c.startsWith('#') ? c : '#ffffff'; }

function label(ctx, text, x, y, size, color, italic = false) {
  ctx.font = `${italic ? 'italic ' : ''}800 ${Math.round(size * TS)}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5 * TS; ctx.strokeStyle = 'rgba(1,10,19,0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// ───────────────────────── 미니맵 ─────────────────────────
let miniBg = null;
function minimapBackground(size) {
  if (miniBg && miniBg.width === size) return miniBg;
  const c = makeCanvas(size, size), g = c.getContext('2d'), S = size / MAP_W;
  g.fillStyle = '#2f5a2a'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#244a22';
  for (const arr of deco.values()) for (const d of arr) if (d.kind === 'tree' && !d.dark) { g.beginPath(); g.arc(d.x * S, d.y * S, 2.2, 0, TAU); g.fill(); }
  g.beginPath(); g.arc(CENTER.x * S, CENTER.y * S, RIVER_R * S, 0, TAU); g.lineWidth = RIVER_W * S; g.strokeStyle = '#2f86b8'; g.stroke();
  g.lineCap = 'round'; g.beginPath();
  for (const [a, b] of LANES) { g.moveTo(a.x * S, a.y * S); g.lineTo(b.x * S, b.y * S); }
  g.lineWidth = 180 * S; g.strokeStyle = '#a88a5c'; g.stroke();
  g.beginPath(); g.arc(CENTER.x * S, CENTER.y * S, (BOSS_ARENA_R + 90) * S, 0, TAU); g.fillStyle = '#4a3a63'; g.fill();
  for (const bs of BASES) { g.beginPath(); g.arc(bs.x * S, bs.y * S, 250 * S, 0, TAU); g.fillStyle = '#7d858e'; g.fill(); g.lineWidth = 2; g.strokeStyle = bs.color; g.stroke(); }
  for (const sp of OBJECT_SPOTS) { g.beginPath(); g.arc(sp.x * S, sp.y * S, 170 * S, 0, TAU); g.fillStyle = '#6b5a47'; g.fill(); }
  return (miniBg = c);
}

export function drawMinimap(mctx, v, viewId, cam, viewW, viewH) {
  const size = mctx.canvas.width, S = size / MAP_W;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.drawImage(minimapBackground(size), 0, 0);
  // 시야
  mctx.strokeStyle = 'rgba(240,230,210,0.85)'; mctx.lineWidth = 1.2;
  mctx.strokeRect((cam.x - viewW / 2) * S, (cam.y - viewH / 2) * S, viewW * S, viewH * S);
  // 오브젝트
  v.o.forEach((o, i) => {
    const sp = OBJECT_SPOTS[i];
    const x = (o.alive ? o.x : sp.x) * S, y = (o.alive ? o.y : sp.y) * S;
    mctx.beginPath(); mctx.arc(x, y, o.tier === 2 ? 5 : 4, 0, TAU);
    mctx.fillStyle = o.alive ? (o.tier === 2 ? '#f0b232' : '#cdbe91') : 'rgba(205,190,145,0.25)'; mctx.fill();
    if (o.alive) { mctx.lineWidth = 1.2; mctx.strokeStyle = '#010a13'; mctx.stroke(); }
  });
  // 보스
  if (v.b && v.b.hp > 0) {
    mctx.beginPath(); mctx.arc(v.b.x * S, v.b.y * S, 8, 0, TAU);
    mctx.fillStyle = v.b.seal > 0 ? '#7a5aa8' : '#d34cff'; mctx.fill();
    mctx.lineWidth = 2; mctx.strokeStyle = '#c8aa6e'; mctx.stroke();
  }
  // 플레이어
  for (const p of v.p) {
    if (p.dead) continue;
    const info = p.info || {};
    const x = p.x * S, y = p.y * S;
    mctx.beginPath(); mctx.arc(x, y, p.id === viewId ? 6 : 5, 0, TAU);
    mctx.fillStyle = info.color || '#fff'; mctx.fill();
    mctx.lineWidth = 2; mctx.strokeStyle = p.id === viewId ? '#fff' : '#010a13'; mctx.stroke();
    if (p.bounty) { mctx.strokeStyle = '#f0b232'; mctx.lineWidth = 2; mctx.beginPath(); mctx.arc(x, y, 9, 0, TAU); mctx.stroke(); }
  }
}
