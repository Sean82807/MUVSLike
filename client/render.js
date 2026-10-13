// 캔버스 렌더링 (월드 + 미니맵). 상태는 main.js가 보간해서 넘겨준다.
import {
  MAP_W, MAP_H, CENTER, BOSS_ARENA_R, SPAWNS, SLOT_COLORS, CLASSES, CLASS_IDS, MOBS, MOB_TYPE_IDS,
  OBJECTS, OBJ_TYPE_IDS, ITEMS, ITEM_IDS, STATUS_BITS, PROJ_KINDS, BOSS, OBJECT_SPOTS, PLAYER_RADIUS,
} from '../shared/defs.js';

const TAU = Math.PI * 2;
const PROJ_STYLE = {
  bullet:   { c: '#fff59d', len: 16, w: 3 },
  dagger:   { c: '#cfd8dc', len: 14, w: 3 },
  fireball: { c: '#ff7043', glow: '#ffab40' },
  wave:     { c: '#4dd0e1', wave: true },
  missile:  { c: '#b0bec5', len: 12, w: 4, glow: '#ff8a65' },
  mbolt:    { c: '#b388ff', glow: '#7c4dff' },
  arrow:    { c: '#d7ccc8', len: 14, w: 2 },
  rock:     { c: '#8d6e63' },
  fire:     { c: '#ff5722', glow: '#ffc107' },
  grenade:  { c: '#558b2f' },
  boss:     { c: '#e040fb', glow: '#6a1b9a' },
};
const MOB_SHAPES = { zombie: 'circle', bat: 'bat', skeleton: 'square', archer: 'tri', brute: 'circle' };
let TS = 1; // 줌과 무관하게 글자 크기를 유지하기 위한 배율

export function drawWorld(ctx, W, H, v, cam, fx, now, myId) {
  const s = cam.s;
  TS = Math.min(2, 1 / s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, W / 2 - cam.x * s, H / 2 - cam.y * s);

  const vx0 = cam.x - W / 2 / s, vy0 = cam.y - H / 2 / s, vx1 = cam.x + W / 2 / s, vy1 = cam.y + H / 2 / s;
  const vis = (x, y, pad = 60) => x > vx0 - pad && x < vx1 + pad && y > vy0 - pad && y < vy1 + pad;

  drawGround(ctx, vx0, vy0, vx1, vy1, v);

  // 위험 장판
  for (const h of v.hz) {
    const prog = 1 - h.t / h.total;
    const enemy = h.team === 1;
    ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU);
    ctx.fillStyle = enemy ? 'rgba(229,57,53,0.12)' : 'rgba(255,167,38,0.12)';
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = enemy ? 'rgba(255,82,82,0.8)' : 'rgba(255,193,7,0.8)';
    ctx.stroke();
    ctx.beginPath(); ctx.arc(h.x, h.y, Math.max(0, h.r * prog), 0, TAU);
    ctx.fillStyle = enemy ? 'rgba(229,57,53,0.25)' : 'rgba(255,152,0,0.3)';
    ctx.fill();
  }

  // 픽업
  for (const g of v.g) {
    if (!vis(g.x, g.y)) continue;
    const type = ITEM_IDS[g.type];
    if (type === 'gem') {
      const val = g.v / 10;
      const c = val >= 20 ? '#ff5252' : val >= 6 ? '#69f0ae' : val >= 2 ? '#40c4ff' : '#82b1ff';
      const r = Math.min(4 + Math.sqrt(val) * 1.3, 12);
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.moveTo(g.x, g.y - r); ctx.lineTo(g.x + r * 0.7, g.y); ctx.lineTo(g.x, g.y + r); ctx.lineTo(g.x - r * 0.7, g.y); ctx.closePath(); ctx.fill();
    } else {
      const it = ITEMS[type];
      const bob = Math.sin(now * 4 + g.id) * 3;
      ctx.beginPath(); ctx.arc(g.x, g.y + bob, 13, 0, TAU);
      ctx.fillStyle = it.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = type === 'chest' ? '#111' : '#fff';
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText({ meat: '♥', magnet: 'U', bomb: '✹', chest: '★' }[type], g.x, g.y + bob + 1);
    }
  }

  // 몬스터
  for (const m of v.m) {
    if (!vis(m.x, m.y)) continue;
    const type = MOB_TYPE_IDS[m.type], def = MOBS[type];
    drawMob(ctx, m, type, def, now);
  }

  // 오브젝트
  for (const o of v.o) {
    const type = OBJ_TYPE_IDS[o.type], def = OBJECTS[type];
    if (!o.alive) continue;
    if (!vis(o.x, o.y, 120)) continue;
    const r = def.r * (o.tier === 2 ? 1.12 : 1);
    ctx.save();
    ctx.shadowColor = def.color; ctx.shadowBlur = 25;
    ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, TAU);
    ctx.fillStyle = def.color; ctx.fill();
    ctx.restore();
    ctx.lineWidth = o.tier === 2 ? 5 : 3; ctx.strokeStyle = o.tier === 2 ? '#ffd54f' : '#eeeeee'; ctx.stroke();
    drawObjectFace(ctx, type, o.x, o.y, r, now);
    statusRing(ctx, o.x, o.y, r, o.flags, now);
    hpBar(ctx, o.x, o.y - r - 16, r * 2.2, 7, o.hp / o.maxHp, '#ffb300');
    label(ctx, `${def.name}${o.tier === 2 ? ' ★' : ''}`, o.x, o.y - r - 24, 14, '#ffe082');
  }

  // 보스
  const b = v.b;
  if (b && b.hp > 0 && vis(b.x, b.y, 200)) {
    const sealed = b.seal > 0;
    const pulse = 1 + Math.sin(now * 3) * 0.03;
    ctx.save();
    ctx.globalAlpha = sealed ? 0.55 : 1;
    ctx.shadowColor = b.enraged ? '#ff1744' : '#7c4dff'; ctx.shadowBlur = 40;
    ctx.beginPath(); ctx.arc(b.x, b.y, BOSS.r * pulse, 0, TAU);
    const grd = ctx.createRadialGradient(b.x, b.y, 10, b.x, b.y, BOSS.r);
    grd.addColorStop(0, b.enraged ? '#d50000' : '#7c4dff'); grd.addColorStop(1, BOSS.color);
    ctx.fillStyle = grd; ctx.fill();
    ctx.restore();
    // 눈
    ctx.fillStyle = b.enraged ? '#ffeb3b' : '#ff5252';
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(b.x + sx * 24, b.y - 12, 9, 0, TAU); ctx.fill(); }
    // 뿔
    ctx.fillStyle = '#1a0033';
    for (const sx of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(b.x + sx * 40, b.y - 55); ctx.lineTo(b.x + sx * 70, b.y - 110); ctx.lineTo(b.x + sx * 20, b.y - 70); ctx.closePath(); ctx.fill();
    }
    if (sealed) {
      ctx.strokeStyle = '#b0bec5'; ctx.lineWidth = 6; ctx.setLineDash([14, 8]);
      ctx.beginPath(); ctx.arc(b.x, b.y, BOSS.r + 22, now * 0.5, now * 0.5 + TAU); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `봉인됨 — ${fmtTime(b.seal)} 후 해제`, b.x, b.y + BOSS.r + 40, 18, '#cfd8dc');
    }
    statusRing(ctx, b.x, b.y, BOSS.r, b.flags, now);
    label(ctx, BOSS.name, b.x, b.y - BOSS.r - 26, 18, '#e1bee7');
  }

  // 플레이어
  for (const p of v.p) {
    if (p.dead || !vis(p.x, p.y, 200)) continue;
    drawPlayer(ctx, p, now, p.id === myId, v.time);
  }

  // 투사체
  for (const pr of v.pr) {
    if (!vis(pr.x, pr.y)) continue;
    drawProj(ctx, pr, now);
  }

  // 효과
  drawFx(ctx, fx, now);

  // 플레이어 이름/체력 (최상단)
  for (const p of v.p) {
    if (p.dead || !vis(p.x, p.y, 200)) continue;
    const info = p.info || {};
    hpBar(ctx, p.x, p.y - PLAYER_RADIUS - 12, 46, 6, p.hp / p.maxHp, p.id === myId ? '#66bb6a' : '#ef5350');
    label(ctx, `${info.name || '?'}  Lv${p.level}`, p.x, p.y - PLAYER_RADIUS - 20, 13, info.color || '#fff');
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawGround(ctx, x0, y0, x1, y1, v) {
  // 맵 영역
  ctx.fillStyle = '#14181f';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  // 중앙으로 갈수록 붉게 (위험 지역)
  const grd = ctx.createRadialGradient(CENTER.x, CENTER.y, 200, CENTER.x, CENTER.y, 4300);
  grd.addColorStop(0, 'rgba(120,20,40,0.55)');
  grd.addColorStop(0.35, 'rgba(70,20,50,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(Math.max(0, x0), Math.max(0, y0), Math.min(MAP_W, x1) - Math.max(0, x0), Math.min(MAP_H, y1) - Math.max(0, y0));
  // 격자
  const step = 100;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.max(0, Math.floor(x0 / step) * step); x <= Math.min(MAP_W, x1); x += step) { ctx.moveTo(x, Math.max(0, y0)); ctx.lineTo(x, Math.min(MAP_H, y1)); }
  for (let y = Math.max(0, Math.floor(y0 / step) * step); y <= Math.min(MAP_H, y1); y += step) { ctx.moveTo(Math.max(0, x0), y); ctx.lineTo(Math.min(MAP_W, x1), y); }
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.stroke();
  // 경계
  ctx.lineWidth = 8; ctx.strokeStyle = '#3e2723';
  ctx.strokeRect(0, 0, MAP_W, MAP_H);
  // 시작 지점
  SPAWNS.forEach((sp, i) => {
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 160, 0, TAU);
    ctx.fillStyle = SLOT_COLORS[i] + '18'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = SLOT_COLORS[i] + '66'; ctx.stroke();
  });
  // 보스 아레나
  ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, BOSS_ARENA_R, 0, TAU);
  ctx.setLineDash([20, 14]); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(206,147,216,0.35)'; ctx.stroke(); ctx.setLineDash([]);
  // 오브젝트 둥지 + 재생성 타이머
  for (const o of v.o) {
    const spot = OBJECT_SPOTS[v.o.indexOf(o)];
    if (!spot) continue;
    ctx.beginPath(); ctx.arc(spot.x, spot.y, 90, 0, TAU);
    ctx.fillStyle = 'rgba(255,213,79,0.05)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,213,79,0.18)'; ctx.stroke();
    if (!o.alive) label(ctx, `${OBJECTS[OBJ_TYPE_IDS[o.type]].name} 재등장 ${o.respawn}s`, spot.x, spot.y, 14, 'rgba(255,224,130,0.7)');
  }
}

function drawMob(ctx, m, type, def, now) {
  const r = def.r;
  ctx.fillStyle = m.flags & STATUS_BITS.freeze ? '#b3e5fc' : def.color;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2;
  const shape = MOB_SHAPES[type];
  ctx.beginPath();
  if (shape === 'square') ctx.rect(m.x - r, m.y - r, r * 2, r * 2);
  else if (shape === 'tri') { ctx.moveTo(m.x, m.y - r * 1.2); ctx.lineTo(m.x + r, m.y + r * 0.8); ctx.lineTo(m.x - r, m.y + r * 0.8); ctx.closePath(); }
  else if (shape === 'bat') {
    const f = Math.sin(now * 18 + m.id) * 0.5;
    ctx.moveTo(m.x - r * 1.6, m.y - r * f); ctx.lineTo(m.x, m.y + r * 0.6); ctx.lineTo(m.x + r * 1.6, m.y - r * f); ctx.lineTo(m.x, m.y - r * 0.5); ctx.closePath();
  } else ctx.arc(m.x, m.y, r, 0, TAU);
  ctx.fill(); ctx.stroke();
  // 눈
  ctx.fillStyle = type === 'brute' ? '#ffeb3b' : '#b71c1c';
  ctx.fillRect(m.x - r * 0.4, m.y - r * 0.25, 3, 3);
  ctx.fillRect(m.x + r * 0.4 - 3, m.y - r * 0.25, 3, 3);
  statusRing(ctx, m.x, m.y, r, m.flags, now);
  if (m.hp < 100) hpBar(ctx, m.x, m.y - r - 6, r * 2, 3, m.hp / 100, '#e53935');
}

function drawObjectFace(ctx, type, x, y, r, now) {
  ctx.fillStyle = '#111';
  ctx.font = `bold ${Math.round(r * 0.9)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText({ golem: '◆', wyvern: '▲', lich: '☠' }[type], x, y + 2);
  if (type === 'wyvern') {
    const f = Math.sin(now * 6) * 0.3;
    ctx.fillStyle = 'rgba(192,57,43,0.6)';
    for (const sx of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(x + sx * r * 0.6, y); ctx.lineTo(x + sx * r * 2, y - r * (0.6 + f)); ctx.lineTo(x + sx * r * 1.6, y + r * 0.4); ctx.closePath(); ctx.fill();
    }
  }
}

function statusRing(ctx, x, y, r, f, now) {
  if (!f) return;
  if (f & STATUS_BITS.burn) { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, TAU); ctx.strokeStyle = 'rgba(255,112,67,0.9)'; ctx.lineWidth = 2; ctx.stroke(); }
  if (f & STATUS_BITS.slow) { ctx.beginPath(); ctx.arc(x, y, r + 6, 0, TAU); ctx.strokeStyle = 'rgba(79,195,247,0.8)'; ctx.lineWidth = 2; ctx.stroke(); }
  if (f & (STATUS_BITS.stun | STATUS_BITS.freeze)) {
    ctx.fillStyle = '#ffee58';
    for (let i = 0; i < 3; i++) {
      const a = now * 5 + i * TAU / 3;
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.8, y - r - 4 + Math.sin(a) * 3, 3, 0, TAU); ctx.fill();
    }
  }
}

function drawPlayer(ctx, p, now, isMe, serverTime) {
  const info = p.info || {};
  const cls = CLASSES[CLASS_IDS[p.cls]];
  const r = PLAYER_RADIUS;
  // 오라
  if (p.aura) {
    ctx.beginPath(); ctx.arc(p.x, p.y, p.aura, 0, TAU);
    ctx.fillStyle = 'rgba(255,235,59,0.07)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,235,59,${0.25 + Math.sin(now * 6) * 0.1})`; ctx.stroke();
  }
  // 회전 칼날
  if (p.orb) {
    const rot = p.orbRot / 100;
    for (let i = 0; i < p.orb; i++) {
      const a = serverTime * rot + i * TAU / p.orb;
      const bx = p.x + Math.cos(a) * p.orbR, by = p.y + Math.sin(a) * p.orbR;
      ctx.save(); ctx.translate(bx, by); ctx.rotate(a + Math.PI / 2);
      ctx.fillStyle = '#e0e0e0'; ctx.strokeStyle = '#90a4ae'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(6, 0); ctx.lineTo(0, 14); ctx.lineTo(-6, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }
  const f = p.flags;
  if (f & STATUS_BITS.whirl) {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(now * 18);
    ctx.strokeStyle = 'rgba(255,82,82,0.8)'; ctx.lineWidth = 5;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(0, 0, 70 + i * 30, i * 2, i * 2 + 1.4); ctx.stroke(); }
    ctx.restore();
  }
  ctx.save();
  if (f & STATUS_BITS.invuln) ctx.globalAlpha = 0.45 + Math.sin(now * 30) * 0.25;
  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + r * 0.8, r, r * 0.4, 0, 0, TAU); ctx.fill();
  // 몸
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fillStyle = cls.color; ctx.fill();
  ctx.lineWidth = isMe ? 4 : 3; ctx.strokeStyle = info.color || '#fff'; ctx.stroke();
  // 바라보는 방향
  const fa = p.face / 100;
  ctx.beginPath(); ctx.moveTo(p.x + Math.cos(fa) * (r + 9), p.y + Math.sin(fa) * (r + 9));
  ctx.lineTo(p.x + Math.cos(fa + 2.5) * r * 0.7 + Math.cos(fa) * r * 0.7, p.y + Math.sin(fa + 2.5) * r * 0.7 + Math.sin(fa) * r * 0.7);
  ctx.lineTo(p.x + Math.cos(fa - 2.5) * r * 0.7 + Math.cos(fa) * r * 0.7, p.y + Math.sin(fa - 2.5) * r * 0.7 + Math.sin(fa) * r * 0.7);
  ctx.closePath(); ctx.fillStyle = info.color || '#fff'; ctx.fill();
  ctx.fillStyle = '#111'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(cls.icon, p.x, p.y + 1);
  ctx.restore();
  if (f & STATUS_BITS.shield) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 10, 0, TAU);
    ctx.fillStyle = 'rgba(255,241,118,0.2)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff176'; ctx.stroke();
  }
  if (f & STATUS_BITS.crit) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, TAU);
    ctx.lineWidth = 2; ctx.strokeStyle = `rgba(244,67,54,${0.5 + Math.sin(now * 15) * 0.4})`; ctx.stroke();
  }
  statusRing(ctx, p.x, p.y, r, f & ~(STATUS_BITS.invuln | STATUS_BITS.shield | STATUS_BITS.whirl | STATUS_BITS.crit), now);
}

function drawProj(ctx, pr, now) {
  const kind = PROJ_KINDS[pr.kind];
  const st = PROJ_STYLE[kind] || { c: '#fff' };
  const a = pr.ang / 100;
  ctx.save();
  if (st.glow) { ctx.shadowColor = st.glow; ctx.shadowBlur = 14; }
  if (st.len) {
    ctx.strokeStyle = st.c; ctx.lineWidth = st.w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pr.x - Math.cos(a) * st.len, pr.y - Math.sin(a) * st.len); ctx.lineTo(pr.x, pr.y); ctx.stroke();
  } else if (st.wave) {
    ctx.strokeStyle = st.c; ctx.lineWidth = 6; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(pr.x - Math.cos(a) * pr.r, pr.y - Math.sin(a) * pr.r, pr.r * 1.4, a - 0.9, a + 0.9); ctx.stroke();
  } else {
    ctx.fillStyle = st.c;
    ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.r, 0, TAU); ctx.fill();
    if (pr.team === 1) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke(); }
  }
  ctx.restore();
}

function drawFx(ctx, fx, now) {
  for (const e of fx) {
    const t = (now - e.at) / e.dur;
    if (t < 0 || t > 1) continue;
    const k = 1 - t;
    switch (e.type) {
      case 'arc': {
        ctx.save();
        ctx.globalAlpha = k * 0.85;
        const cls = CLASS_IDS[e.cls];
        ctx.fillStyle = cls === 'spellblade' ? 'rgba(77,208,225,0.5)' : 'rgba(255,255,255,0.45)';
        ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.arc(e.x, e.y, e.r * (0.7 + 0.3 * t), e.a - e.w / 2, e.a + e.w / 2); ctx.closePath(); ctx.fill();
        ctx.restore();
        break;
      }
      case 'boom': {
        const col = ['255,138,101', '174,213,129', '255,213,79', '255,255,255', '255,82,82'][e.kind] || '255,255,255';
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * t), 0, TAU);
        ctx.fillStyle = `rgba(${col},${0.35 * k})`; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = `rgba(${col},${0.8 * k})`; ctx.stroke();
        break;
      }
      case 'nova': {
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.3 + 0.7 * t), 0, TAU);
        ctx.lineWidth = 6 * k + 1; ctx.strokeStyle = e.kind === 1 ? `rgba(255,82,82,${k})` : `rgba(129,212,250,${k})`; ctx.stroke();
        break;
      }
      case 'bolt': {
        ctx.save();
        ctx.strokeStyle = `rgba(255,255,141,${k})`; ctx.lineWidth = 4; ctx.shadowColor = '#fff59d'; ctx.shadowBlur = 20;
        ctx.beginPath(); ctx.moveTo(e.x + 20, e.y - 400);
        let y = e.y - 400;
        while (y < e.y) { y += 50; ctx.lineTo(e.x + (y < e.y ? (Math.sin(y * 13.7 + e.seed) * 22) : 0), Math.min(y, e.y)); }
        ctx.stroke(); ctx.restore();
        break;
      }
      case 'line': {
        ctx.strokeStyle = e.kind === 1 ? `rgba(120,144,156,${k})` : `rgba(77,208,225,${k})`; ctx.lineWidth = 14 * k + 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x2, e.y2); ctx.stroke();
        break;
      }
      case 'skill':
        ctx.beginPath(); ctx.arc(e.x, e.y, 30 + 50 * t, 0, TAU);
        ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,255,255,${0.6 * k})`; ctx.stroke();
        break;
      case 'die':
        label(ctx, '✝', e.x, e.y - 30 * t, 36, `rgba(255,255,255,${k})`);
        break;
      case 'text':
        ctx.globalAlpha = Math.min(1, k * 2);
        label(ctx, e.text, e.x, e.y - 40 * t, e.size, e.color);
        ctx.globalAlpha = 1;
        break;
    }
  }
}

function hpBar(ctx, x, y, w, h, frac, color) {
  frac = Math.max(0, Math.min(1, frac));
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, y, w * frac, h);
}

function label(ctx, text, x, y, size, color) {
  ctx.font = `bold ${Math.round(size * TS)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * TS; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function drawMinimap(mctx, v, viewId, cam, viewW, viewH) {
  const S = mctx.canvas.width / MAP_W;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mctx.canvas.width, mctx.canvas.height);
  const grd = mctx.createRadialGradient(CENTER.x * S, CENTER.y * S, 2, CENTER.x * S, CENTER.y * S, 110);
  grd.addColorStop(0, 'rgba(140,30,60,0.6)'); grd.addColorStop(1, 'rgba(20,24,31,0.2)');
  mctx.fillStyle = grd; mctx.fillRect(0, 0, MAP_W * S, MAP_H * S);
  // 시야
  mctx.strokeStyle = 'rgba(255,255,255,0.4)'; mctx.lineWidth = 1;
  mctx.strokeRect((cam.x - viewW / 2) * S, (cam.y - viewH / 2) * S, viewW * S, viewH * S);
  // 오브젝트
  v.o.forEach((o, i) => {
    const spot = OBJECT_SPOTS[i];
    mctx.fillStyle = o.alive ? (o.tier === 2 ? '#ffb300' : '#ffe082') : 'rgba(255,224,130,0.25)';
    mctx.beginPath(); mctx.arc((o.alive ? o.x : spot.x) * S, (o.alive ? o.y : spot.y) * S, o.tier === 2 ? 5 : 4, 0, TAU); mctx.fill();
  });
  // 보스
  if (v.b && v.b.hp > 0) {
    mctx.fillStyle = v.b.seal > 0 ? '#9575cd' : '#e040fb';
    mctx.beginPath(); mctx.arc(v.b.x * S, v.b.y * S, 7, 0, TAU); mctx.fill();
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 1; mctx.stroke();
  }
  // 플레이어
  for (const p of v.p) {
    if (p.dead) continue;
    const info = p.info || {};
    mctx.fillStyle = info.color || '#fff';
    mctx.beginPath(); mctx.arc(p.x * S, p.y * S, p.id === viewId ? 5 : 4, 0, TAU); mctx.fill();
    if (p.id === viewId) { mctx.strokeStyle = '#fff'; mctx.lineWidth = 2; mctx.stroke(); }
  }
}
