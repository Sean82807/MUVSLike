// 권위 서버 게임 시뮬레이션. 네트워크와 무관하게 step()만 호출하면 진행된다.
import {
  TICK_RATE, MAP_W, MAP_H, CENTER, BOSS_ARENA_R, SPAWNS, SLOT_COLORS, PLAYER_RADIUS,
  PVP_DAMAGE_MULT, DEATH_ATK_BONUS, ARMOR_K, MAX_WEAPONS, BASE_MAGNET, DEFAULT_SETTINGS,
  CLASSES, CLASS_IDS, SKILLS, WEAPONS, WEAPON_MAX_LV, GENERIC_WEAPONS, PASSIVES, RELICS,
  MOBS, OBJECTS, OBJECT_SPOTS, OBJECT_RESPAWN, BOSS, ITEMS, ITEM_DROP_CHANCE, xpToNext,
  MOB_TYPE_IDS, OBJ_TYPE_IDS, ITEM_IDS, STATUS_BITS, PROJ_KINDS,
} from '../shared/defs.js';
import { BotBrain } from './ai.js';

export const DT = 1 / TICK_RATE;
const TAU = Math.PI * 2;
const MAX_CORNER_DIST = Math.hypot(CENTER.x - SPAWNS[0].x, CENTER.y - SPAWNS[0].y);
const GLOBAL_MOB_CAP = 650;
const DESPAWN_DIST = 1700;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const d2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
function weightedPick(arr, wf) {
  let total = 0; for (const a of arr) total += wf(a);
  let r = Math.random() * total;
  for (const a of arr) { r -= wf(a); if (r <= 0) return a; }
  return arr[arr.length - 1];
}
function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l = vx * vx + vy * vy || 1;
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / l, 0, 1);
  return d2(px, py, ax + vx * t, ay + vy * t);
}

// 몹 전용 공간 해시
class Grid {
  constructor(cell) { this.cell = cell; this.cells = new Map(); }
  clear() { this.cells.clear(); }
  key(cx, cy) { return cx * 4096 + cy; }
  insert(e) {
    const k = this.key(Math.floor(e.x / this.cell), Math.floor(e.y / this.cell));
    let c = this.cells.get(k);
    if (!c) { c = []; this.cells.set(k, c); }
    c.push(e);
  }
  query(x, y, r, fn) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const arr = this.cells.get(this.key(cx, cy));
      if (arr) for (let i = 0; i < arr.length; i++) fn(arr[i]);
    }
  }
}

export class Game {
  /**
   * @param {Array<{name:string, cls:string, isBot:boolean}>} slots 4개 슬롯
   * @param {object} settings
   */
  constructor(slots, settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.nextId = 1;
    this.time = 0;
    this.tick = 0;
    this.totalDeaths = 0;
    this.mobAtkMult = 1;
    this.players = [];
    this.mobs = [];
    this.projectiles = [];
    this.pickups = [];
    this.gemCells = new Map();
    this.hazards = [];
    this.objects = [];
    this.fx = [];
    this.feed = [];
    this.grid = new Grid(80);
    this.over = null;
    this.lastWaveMinute = 0;

    slots.forEach((s, i) => this.players.push(this.makePlayer(i, s)));
    for (const spot of OBJECT_SPOTS) this.objects.push(this.makeObject(spot));
    this.boss = this.makeBoss();
    this.pushFeed('게임 시작! 중앙의 ' + BOSS.name + '을(를) 처치하는 플레이어가 승리합니다.');
    this.pushFeed(`처음 ${this.settings.pvpGrace}초 동안은 PvP가 비활성화됩니다.`);
  }

  id() { return this.nextId++; }
  get minutes() { return this.time / 60; }
  pvpActive() { return this.time >= this.settings.pvpGrace; }
  bossSealed() { return this.time < this.settings.bossUnseal; }
  pushFeed(text, kind = 'info') { this.feed.push({ text, kind }); }
  monsterDmgMult() { return this.mobAtkMult * (1 + this.minutes * 0.035); }

  // ───────────────────────── 생성 ─────────────────────────
  makePlayer(slot, s) {
    const cls = CLASSES[s.cls] ? s.cls : CLASS_IDS[slot % CLASS_IDS.length];
    const sp = SPAWNS[slot];
    const p = {
      kind: 'player', id: this.id(), slot, name: s.name || `P${slot + 1}`, cls, isBot: !!s.isBot,
      color: SLOT_COLORS[slot],
      x: sp.x, y: sp.y, r: PLAYER_RADIUS, face: 0,
      moveX: 0, moveY: 0, aimX: CENTER.x, aimY: CENTER.y, inputSeq: 0,
      hp: 1, level: 1, xp: 0,
      weapons: [{ id: CLASSES[cls].weapon, lv: 1, t: 0.5, hits: new Map() }],
      passives: {}, relics: {}, choices: [], skillT: 0,
      status: {}, invuln: 3, shield: 0, whirl: 0, whirlT: 0, critBuff: 0, kbx: 0, kby: 0,
      dead: false, respawnT: 0,
      kills: 0, mobKills: 0, objKills: 0, deaths: 0, dmgDealt: 0, dmgBy: {},
      lastPlayerHit: null, targetMode: 'auto', spawnAcc: 0, nearMobs: 0,
      stats: null, bot: null,
    };
    this.recalc(p);
    p.hp = p.stats.maxHp;
    if (p.isBot) p.bot = new BotBrain(this, p);
    return p;
  }

  setBot(p, isBot) {
    p.isBot = isBot;
    p.bot = isBot ? new BotBrain(this, p) : null;
    if (!isBot) { p.moveX = 0; p.moveY = 0; }
  }

  makeObject(spot) {
    const def = OBJECTS[spot.type];
    const o = {
      kind: 'object', id: this.id(), type: spot.type, tier: spot.tier,
      home: { x: spot.x, y: spot.y }, x: spot.x, y: spot.y, r: def.r * (spot.tier === 2 ? 1.12 : 1),
      hp: 0, maxHp: 0, alive: true, respawnT: 0, target: null, status: {},
      t1: rand(1, 2), t2: rand(3, 5), t3: rand(5, 8), dashT: 0, dvx: 0, dvy: 0, contactT: 0, lastHitBy: null,
    };
    this.resetObjectHp(o);
    return o;
  }

  resetObjectHp(o) {
    const def = OBJECTS[o.type];
    o.maxHp = Math.round(def.hp * (o.tier === 2 ? 1.6 : 1) * (1 + this.minutes * 0.14));
    o.hp = o.maxHp;
  }

  makeBoss() {
    return {
      kind: 'boss', id: this.id(), x: CENTER.x, y: CENTER.y, r: BOSS.r,
      hp: BOSS.hp, maxHp: BOSS.hp, status: {}, target: null, patternT: 4, patIdx: 0,
      dashT: 0, dvx: 0, dvy: 0, spiralT: 0, spiralA: 0, spiralCd: 0, contactT: 0, enraged: false,
    };
  }

  spawnMob(type, x, y, opts = {}) {
    const def = MOBS[type];
    const zone = 1 - clamp(Math.hypot(x - CENTER.x, y - CENTER.y) / MAX_CORNER_DIST, 0, 1);
    const m = this.minutes;
    const hpMult = (1 + m * 0.3 + m * m * 0.012) * (1 + zone * 1.0) * (opts.hpMult || 1);
    const mob = {
      kind: 'mob', id: this.id(), type, x: clamp(x, 20, MAP_W - 20), y: clamp(y, 20, MAP_H - 20), r: def.r,
      hp: def.hp * hpMult, maxHp: def.hp * hpMult, status: {}, dead: false,
      speed: def.speed * rand(0.9, 1.1) * (1 + Math.min(m * 0.02, 0.3)),
      xp: def.xp * (1 + zone * 0.9), atkT: rand(0, 0.5), shootT: rand(1, 2.5), kbx: 0, kby: 0,
      target: null, summoned: !!opts.summoned,
    };
    this.mobs.push(mob);
    return mob;
  }

  // ───────────────────────── 스탯 ─────────────────────────
  recalc(p) {
    const c = CLASSES[p.cls], pv = p.passives, n = id => p.relics[id] || 0, lv = id => pv[id] || 0;
    const prevMax = p.stats ? p.stats.maxHp : 0;
    p.stats = {
      might: (1 + 0.12 * lv('might')) * (1 + 0.25 * n('dragonHeart')),
      armor: c.armor + 4 * lv('armor') + 12 * n('aegis'),
      maxHp: Math.round(c.hp * (1 + 0.18 * lv('vitality') + 0.2 * n('dragonHeart') + 0.45 * n('titanBelt')) + (p.level - 1) * 4),
      regen: 0.7 * lv('regen') + 0.15,
      speed: c.speed * (1 + 0.08 * lv('swift') + 0.18 * n('stormBoots')),
      cdMult: Math.max(0.35, (1 - 0.07 * lv('haste')) * Math.pow(0.82, n('berserker'))),
      area: 1 + 0.1 * lv('area') + 0.15 * n('prismOrb'),
      amount: lv('multi') + n('prismOrb'),
      magnet: BASE_MAGNET * (1 + 0.35 * lv('magnet')),
      crit: c.crit + 0.06 * lv('precision') + 0.1 * n('luckyClover'),
      critMult: 2 + 0.5 * n('luckyClover'),
      lifesteal: 0.02 * lv('vampire') + 0.05 * n('vampFang'),
      xpMult: 1 + 0.4 * n('greedCrown'),
      bossDmg: 1 + 0.4 * n('executioner'),
      pvpDmg: 1 + 0.3 * n('hunterMark'),
      skillCd: Math.pow(0.65, n('manaCrystal')),
      thorns: 0.35 * n('thornMail'),
    };
    if (prevMax && p.stats.maxHp > prevMax && !p.dead) p.hp += p.stats.maxHp - prevMax;
    p.hp = Math.min(p.hp, p.stats.maxHp);
  }

  weaponStats(p, w) {
    const d = WEAPONS[w.id], s = p.stats, lv = w.lv;
    const lvBonus = (d.cntLv || [3, 5]).filter(l => lv >= l).length;
    const areaMult = s.area * (1 + 0.06 * (lv - 1));
    return {
      d,
      id: w.id,
      dmg: d.dmg * (1 + 0.22 * (lv - 1)) * s.might,
      cd: (d.cd || 1) * (1 - 0.04 * (lv - 1)) * s.cdMult,
      count: (d.count || 1) + lvBonus + s.amount,
      pierce: (d.pierce || 0) + (d.pierceLv ? Math.floor(lv / 3) : 0),
      range: (d.range || 0) * (d.kind === 'arc' ? areaMult : 1),
      radius: (d.radius || 0) * areaMult * (d.kind === 'aura' || d.kind === 'nova' ? (1 + 0.1 * s.amount) : 1),
      explode: (d.explode || 0) * areaMult,
      areaMult,
      lv,
    };
  }

  // ───────────────────────── 적 탐색 ─────────────────────────
  canPvp(a, b) {
    return a !== b && this.pvpActive() && !b.dead && b.invuln <= 0;
  }

  // 플레이어 p 기준으로 (x,y) 반경 r 내의 적 유닛
  enemiesNear(p, x, y, r) {
    const out = [];
    this.grid.query(x, y, r + 30, m => {
      if (!m.dead && d2(x, y, m.x, m.y) <= (r + m.r) * (r + m.r)) out.push(m);
    });
    for (const o of this.objects) if (o.alive && d2(x, y, o.x, o.y) <= (r + o.r) ** 2) out.push(o);
    const b = this.boss;
    if (b.hp > 0 && !this.bossSealed() && d2(x, y, b.x, b.y) <= (r + b.r) ** 2) out.push(b);
    for (const q of this.players) if (this.canPvp(p, q) && d2(x, y, q.x, q.y) <= (r + q.r) ** 2) out.push(q);
    return out;
  }

  findTargets(p, range, n = 1) {
    const list = this.enemiesNear(p, p.x, p.y, range);
    if (!list.length) return list;
    for (const u of list) u._d = d2(p.x, p.y, u.x, u.y);
    list.sort((a, b) => a._d - b._d);
    if (p.targetMode !== 'auto') {
      const wantPlayer = p.targetMode === 'player';
      const pref = list.filter(u => (u.kind === 'player') === wantPlayer);
      if (pref.length) return pref.concat(list.filter(u => (u.kind === 'player') !== wantPlayer)).slice(0, n);
    }
    return list.slice(0, n);
  }

  // ───────────────────────── 피해/상태 ─────────────────────────
  hurt(t, amount, src, o = {}) {
    if (t.kind === 'object' ? !t.alive : (t.dead || t.hp <= 0)) return 0;
    if (t.kind === 'boss' && this.bossSealed()) return 0;
    let dmg = amount, crit = false;
    const sp = src && src.kind === 'player' ? src : null;
    if (sp) {
      if (t.kind === 'player') {
        if (!this.canPvp(sp, t)) return 0;
        dmg *= PVP_DAMAGE_MULT * sp.stats.pvpDmg;
      }
      if (t.kind === 'object' || t.kind === 'boss') dmg *= sp.stats.bossDmg;
      if (!o.noCrit) {
        const c = sp.critBuff > 0 ? 1 : sp.stats.crit;
        if (Math.random() < c) { dmg *= sp.stats.critMult; crit = true; }
      }
    }
    if (t.kind === 'player') {
      if (t.invuln > 0 || t.shield > 0) return 0;
      if (o.melee && src && src.kind !== 'player' && t.stats.thorns > 0) {
        this.hurt(src, dmg * t.stats.thorns * t.stats.might, t, { noCrit: true, noSteal: true });
      }
      dmg *= ARMOR_K / (ARMOR_K + t.stats.armor);
      if (t.whirl > 0) dmg *= 0.7;
      if (sp) t.lastPlayerHit = { id: sp.id, t: this.time };
    } else if (sp && (t.kind === 'object' || t.kind === 'boss')) {
      if (!t.target || t.target.dead || Math.random() < 0.08) t.target = sp;
    }
    t.hp -= dmg;
    if (sp) {
      t.lastHitBy = sp.id;
      sp.dmgDealt += dmg;
      const k = o.wid || 'etc';
      sp.dmgBy[k] = (sp.dmgBy[k] || 0) + dmg;
      if (sp.stats.lifesteal > 0 && !o.noSteal) this.heal(sp, dmg * sp.stats.lifesteal, true);
    }
    if (o.status) this.applyStatus(t, o.status, sp);
    if (o.kb && t.kind !== 'object' && t.kind !== 'boss') {
      const k = t.kind === 'player' ? o.kb.f * 0.4 : o.kb.f;
      t.kbx += o.kb.x * k * 6; t.kby += o.kb.y * k * 6;
    }
    if (dmg >= 0.5 && (sp || t.kind === 'player')) {
      this.fx.push(['d', Math.round(t.x), Math.round(t.y - t.r), Math.round(dmg), crit ? 1 : 0, sp ? sp.id : 0, t.id]);
    }
    if (t.hp <= 0) this.kill(t, src);
    return dmg;
  }

  heal(p, amt, quiet = false) {
    if (p.dead || amt <= 0) return;
    const before = p.hp;
    p.hp = Math.min(p.stats.maxHp, p.hp + amt);
    const got = p.hp - before;
    if (!quiet && got >= 2) this.fx.push(['h', Math.round(p.x), Math.round(p.y - p.r), Math.round(got), p.id]);
  }

  applyStatus(t, st, sp) {
    const res = t.kind === 'boss' ? 0.3 : t.kind === 'object' ? 0.5 : t.kind === 'player' ? 0.6 : 1;
    for (const k in st) {
      if ((k === 'stun' || k === 'freeze') && t.kind === 'boss') continue;
      const s = st[k], dur = s.t * res, cur = t.status[k];
      if (k === 'burn') {
        const dps = s.dps * (sp ? sp.stats.might : this.monsterDmgMult());
        t.status.burn = { t: Math.max(cur ? cur.t : 0, dur), dps: Math.max(cur ? cur.dps : 0, dps), src: sp ? sp.id : 0, acc: cur ? cur.acc : 0 };
      } else if (k === 'slow') {
        const amt = t.kind === 'boss' ? s.amt * 0.5 : s.amt;
        t.status.slow = { t: Math.max(cur ? cur.t : 0, dur), amt: Math.max(cur ? cur.amt : 0, amt) };
      } else {
        t.status[k] = { t: Math.max(cur ? cur.t : 0, dur) };
      }
    }
  }

  tickStatus(u) {
    const st = u.status;
    for (const k in st) {
      const s = st[k];
      s.t -= DT;
      if (k === 'burn') {
        s.acc += DT;
        if (s.acc >= 0.5) {
          s.acc -= 0.5;
          const src = s.src ? this.players.find(p => p.id === s.src) : null;
          this.hurt(u, s.dps * 0.5, src || null, { noCrit: true, noSteal: true, wid: 'burn' });
        }
      }
      if (s.t <= 0) delete st[k];
    }
  }

  isDisabled(u) { return !!(u.status.stun || u.status.freeze); }
  slowMult(u) { return u.status.slow ? 1 - u.status.slow.amt : 1; }

  statusFlags(u) {
    let f = 0;
    const s = u.status;
    if (s.burn) f |= STATUS_BITS.burn;
    if (s.slow) f |= STATUS_BITS.slow;
    if (s.stun) f |= STATUS_BITS.stun;
    if (s.freeze) f |= STATUS_BITS.freeze;
    if (u.kind === 'player') {
      if (u.invuln > 0) f |= STATUS_BITS.invuln;
      if (u.shield > 0) f |= STATUS_BITS.shield;
      if (u.whirl > 0) f |= STATUS_BITS.whirl;
      if (u.critBuff > 0) f |= STATUS_BITS.crit;
    }
    return f;
  }

  // ───────────────────────── 처치 ─────────────────────────
  kill(t, src) {
    const sp = src && src.kind === 'player' ? src : null;
    if (t.kind === 'mob') {
      t.dead = true;
      if (sp) sp.mobKills++;
      this.dropGem(t.x, t.y, t.xp);
      const dropChance = (MOBS[t.type].drop || 0) + ITEM_DROP_CHANCE;
      if (!t.summoned && Math.random() < dropChance) {
        const it = weightedPick(['meat', 'magnet', 'bomb', 'chest'], k => ({ meat: 5, magnet: 2, bomb: 2, chest: 1.6 })[k]);
        this.pickups.push({ id: this.id(), type: it, x: t.x, y: t.y, v: 0, moving: null });
      }
    } else if (t.kind === 'object') {
      t.alive = false; t.hp = 0; t.respawnT = OBJECT_RESPAWN; t.target = null; t.status = {};
      this.fx.push(['boom', Math.round(t.x), Math.round(t.y), Math.round(t.r * 2.4), 2]);
      const killer = sp || this.players.find(p => p.id === t.lastHitBy);
      const def = OBJECTS[t.type];
      if (killer && !killer.dead) {
        killer.objKills++;
        this.gainXp(killer, def.xp * t.tier * (1 + this.minutes * 0.12));
        killer.choices.push({ type: 'relic', options: null });
        this.ensureOptions(killer);
        this.pushFeed(`${killer.name} 님이 ${def.name}${t.tier === 2 ? '(강)' : ''} 사냥 성공! 강화 아이템 획득`, 'object');
      } else {
        this.pushFeed(`${def.name} 처치됨`, 'object');
      }
    } else if (t.kind === 'boss') {
      t.hp = 0;
      const killer = sp || this.players.find(p => p.id === t.lastHitBy);
      this.fx.push(['boom', Math.round(t.x), Math.round(t.y), 400, 2]);
      this.pushFeed(`${killer ? killer.name : '???'} 님이 ${BOSS.name}을(를) 처치했습니다!`, 'win');
      this.over = { winnerId: killer ? killer.id : null, time: this.time };
    } else if (t.kind === 'player') {
      this.playerDie(t, src);
    }
  }

  playerDie(p, src) {
    if ((p.relics.phoenix || 0) > 0) {
      p.relics.phoenix--;
      this.recalc(p);
      p.hp = p.stats.maxHp * 0.5;
      p.invuln = 2.5;
      p.status = {};
      this.fx.push(['boom', Math.round(p.x), Math.round(p.y), 140, 3]);
      this.pushFeed(`${p.name} 님이 불사조 깃털로 부활했습니다!`, 'info');
      return;
    }
    p.dead = true; p.hp = 0; p.status = {}; p.whirl = 0; p.shield = 0; p.critBuff = 0;
    p.deaths++;
    this.totalDeaths++;
    this.mobAtkMult = 1 + DEATH_ATK_BONUS * this.totalDeaths;
    this.fx.push(['die', Math.round(p.x), Math.round(p.y), p.slot]);

    let killer = src && src.kind === 'player' ? src : null;
    if (!killer && p.lastPlayerHit && this.time - p.lastPlayerHit.t < 4) {
      killer = this.players.find(q => q.id === p.lastPlayerHit.id) || null;
    }
    if (killer && killer !== p && !killer.dead) {
      killer.kills++;
      this.gainXp(killer, 12 * p.level);
      killer.choices.push({ type: 'relic', options: null });
      this.ensureOptions(killer);
      this.pushFeed(`${killer.name} ⚔ ${p.name} — 플레이어 처치! 강화 아이템 획득`, 'pvp');
    } else {
      this.pushFeed(`${p.name} 님이 사망했습니다`, 'death');
    }
    this.pushFeed(`몬스터 공격력 상승! (x${this.mobAtkMult.toFixed(2)})`, 'warn');

    if (this.settings.respawn) {
      p.respawnT = 8 + 4 * Math.min(p.deaths - 1, 5);
    } else if (this.players.every(q => q.dead)) {
      this.pushFeed('모든 플레이어가 사망했습니다. 보스의 승리!', 'win');
      this.over = { winnerId: null, time: this.time };
    }
  }

  respawn(p) {
    const sp = SPAWNS[p.slot];
    p.x = sp.x; p.y = sp.y;
    p.dead = false;
    p.hp = p.stats.maxHp;
    p.invuln = 3;
    p.kbx = p.kby = 0;
    this.pushFeed(`${p.name} 님이 부활했습니다`, 'info');
  }

  // ───────────────────────── 경험치/선택 ─────────────────────────
  dropGem(x, y, v) {
    const key = Math.floor(x / 48) * 4096 + Math.floor(y / 48);
    const g = this.gemCells.get(key);
    if (g && !g.moving && !g.taken) { g.v += v; return; }
    const gem = { id: this.id(), type: 'gem', x, y, v, moving: null, key };
    this.gemCells.set(key, gem);
    this.pickups.push(gem);
  }

  gainXp(p, v) {
    if (p.dead) return;
    p.xp += v * p.stats.xpMult;
    let need = xpToNext(p.level);
    while (p.xp >= need) {
      p.xp -= need;
      p.level++;
      this.recalc(p);
      this.heal(p, p.stats.maxHp * 0.08, true);
      p.choices.push({ type: 'level', options: null });
      this.fx.push(['lvl', Math.round(p.x), Math.round(p.y), p.id]);
      need = xpToNext(p.level);
    }
    this.ensureOptions(p);
  }

  ensureOptions(p) {
    const c = p.choices[0];
    if (!c || c.options) return;
    c.options = c.type === 'relic' ? this.relicOptions(p) : this.levelOptions(p);
  }

  levelOptions(p) {
    const pool = [];
    for (const w of p.weapons) if (w.lv < WEAPON_MAX_LV) pool.push({ k: 'w', id: w.id, lv: w.lv + 1, wt: 3 });
    if (p.weapons.length < MAX_WEAPONS) {
      for (const g of GENERIC_WEAPONS) if (!p.weapons.some(w => w.id === g)) pool.push({ k: 'w', id: g, lv: 1, wt: 1.6 });
    }
    for (const id in PASSIVES) {
      const cur = p.passives[id] || 0;
      if (cur < PASSIVES[id].max) pool.push({ k: 'p', id, lv: cur + 1, wt: cur > 0 ? 2.2 : 1.4 });
    }
    const opts = [];
    while (opts.length < 3 && pool.length) {
      const o = weightedPick(pool, x => x.wt);
      pool.splice(pool.indexOf(o), 1);
      opts.push({ k: o.k, id: o.id, lv: o.lv });
    }
    if (opts.length < 3) opts.push({ k: 'heal', id: 'heal', lv: 0 });
    if (opts.length < 3) opts.push({ k: 'xp', id: 'xp', lv: 0 });
    return opts;
  }

  relicOptions() {
    const ids = Object.keys(RELICS);
    const opts = [];
    while (opts.length < 3) {
      const id = ids.splice(Math.floor(Math.random() * ids.length), 1)[0];
      opts.push({ k: 'r', id, lv: 0 });
    }
    return opts;
  }

  pick(p, idx) {
    this.ensureOptions(p);
    const c = p.choices[0];
    if (!c || !c.options || !c.options[idx]) return false;
    const o = c.options[idx];
    if (o.k === 'w') {
      const w = p.weapons.find(x => x.id === o.id);
      if (w) w.lv = Math.min(WEAPON_MAX_LV, w.lv + 1);
      else if (p.weapons.length < MAX_WEAPONS) p.weapons.push({ id: o.id, lv: 1, t: 0.2, hits: new Map() });
    } else if (o.k === 'p') {
      p.passives[o.id] = Math.min(PASSIVES[o.id].max, (p.passives[o.id] || 0) + 1);
    } else if (o.k === 'r') {
      p.relics[o.id] = (p.relics[o.id] || 0) + 1;
    } else if (o.k === 'heal') {
      this.heal(p, p.stats.maxHp * 0.5);
    } else if (o.k === 'xp') {
      p.xp += xpToNext(p.level) * 0.3;
    }
    p.choices.shift();
    this.recalc(p);
    this.ensureOptions(p);
    return true;
  }

  // ───────────────────────── 입력 ─────────────────────────
  setInput(p, inp) {
    const num = v => (Number.isFinite(+v) ? +v : 0);
    let mx = clamp(num(inp.mx), -1, 1), my = clamp(num(inp.my), -1, 1);
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    p.moveX = mx; p.moveY = my;
    if (Number.isFinite(+inp.ax) && Number.isFinite(+inp.ay)) {
      p.aimX = clamp(+inp.ax, -1000, MAP_W + 1000); p.aimY = clamp(+inp.ay, -1000, MAP_H + 1000);
    }
    if (Number.isFinite(inp.seq)) p.inputSeq = inp.seq;
  }

  setTargetMode(p, mode) {
    if (mode === 'auto' || mode === 'monster' || mode === 'player') p.targetMode = mode;
  }

  // ───────────────────────── 스킬 ─────────────────────────
  useSkill(p) {
    if (p.dead || p.skillT > 0 || this.isDisabled(p)) return false;
    const sk = CLASSES[p.cls].skill;
    let dx = p.aimX - p.x, dy = p.aimY - p.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1) { dx = Math.cos(p.face); dy = Math.sin(p.face); dist = 1; }
    const ux = dx / dist, uy = dy / dist;
    const s = p.stats;
    switch (sk) {
      case 'whirlwind':
        p.whirl = 2.5; p.whirlT = 0;
        break;
      case 'grenade': {
        const d = Math.min(dist, 540), sp = 620;
        this.projectiles.push({
          id: this.id(), team: 'p', owner: p, x: p.x, y: p.y, vx: ux * sp, vy: uy * sp, r: 9,
          dmg: 120 * s.might, pierce: 0, life: d / sp, hit: new Set(), kind: 'grenade',
          explode: 155 * s.area, noHit: true, kb: 140, wid: 'skill',
        });
        break;
      }
      case 'meteor': {
        const d = Math.min(dist, 640);
        this.hazards.push({
          id: this.id(), x: p.x + ux * d, y: p.y + uy * d, r: 190 * s.area, t: 0.9, total: 0.9,
          dmg: 250 * s.might, team: 'p', owner: p, status: { burn: { t: 4, dps: 16 }, stun: { t: 1.1 } }, kind: 1,
        });
        break;
      }
      case 'blink': {
        const d = Math.min(dist, 370);
        const ex = clamp(p.x + ux * d, p.r, MAP_W - p.r), ey = clamp(p.y + uy * d, p.r, MAP_H - p.r);
        this.pathStrike(p, p.x, p.y, ex, ey, 55, 125 * s.might, { slow: { t: 1.5, amt: 0.5 } });
        this.fx.push(['line', Math.round(p.x), Math.round(p.y), Math.round(ex), Math.round(ey), 0]);
        p.x = ex; p.y = ey; p.invuln = Math.max(p.invuln, 0.25);
        break;
      }
      case 'shadowstep': {
        const d = Math.min(dist, 280);
        const ex = clamp(p.x + ux * d, p.r, MAP_W - p.r), ey = clamp(p.y + uy * d, p.r, MAP_H - p.r);
        this.pathStrike(p, p.x, p.y, ex, ey, 40, 70 * s.might, null);
        this.fx.push(['line', Math.round(p.x), Math.round(p.y), Math.round(ex), Math.round(ey), 1]);
        p.x = ex; p.y = ey; p.invuln = Math.max(p.invuln, 0.35); p.critBuff = 3;
        break;
      }
      case 'divineShield':
        p.shield = 2.5;
        this.heal(p, p.stats.maxHp * 0.25);
        break;
    }
    p.skillT = SKILLS[sk].cd * s.skillCd;
    this.fx.push(['skill', Math.round(p.x), Math.round(p.y), p.id, CLASS_IDS.indexOf(p.cls)]);
    return true;
  }

  pathStrike(p, ax, ay, bx, by, w, dmg, status) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const half = Math.hypot(bx - ax, by - ay) / 2 + w;
    for (const u of this.enemiesNear(p, mx, my, half)) {
      if (segDist2(u.x, u.y, ax, ay, bx, by) <= (w + u.r) ** 2) this.hurt(u, dmg, p, { status, wid: 'skill' });
    }
  }

  // ───────────────────────── 메인 루프 ─────────────────────────
  step() {
    if (this.over) return;
    this.time += DT;
    this.tick++;

    // 몹 그리드 (이전 위치 기준, 플레이어 공격 판정용)
    this.grid.clear();
    for (const m of this.mobs) if (!m.dead) this.grid.insert(m);

    for (const p of this.players) this.updatePlayer(p);
    this.updateProjectiles();
    this.updateHazards();
    this.updateMobs();
    for (const o of this.objects) this.updateObject(o);
    this.updateBoss();
    this.updatePickups();
    this.spawnLogic();

    if (this.mobs.some(m => m.dead)) this.mobs = this.mobs.filter(m => !m.dead);
  }

  updatePlayer(p) {
    if (p.dead) {
      if (this.settings.respawn) {
        p.respawnT -= DT;
        if (p.respawnT <= 0) this.respawn(p);
      }
      return;
    }
    if (p.bot) p.bot.update(DT);

    p.invuln = Math.max(0, p.invuln - DT);
    p.shield = Math.max(0, p.shield - DT);
    p.critBuff = Math.max(0, p.critBuff - DT);
    p.skillT = Math.max(0, p.skillT - DT);
    this.tickStatus(p);
    if (p.dead) return;

    // 이동
    if (!this.isDisabled(p)) {
      const sp = p.stats.speed * this.slowMult(p) * (p.whirl > 0 ? 0.85 : 1);
      p.x += p.moveX * sp * DT;
      p.y += p.moveY * sp * DT;
      if (p.moveX || p.moveY) p.face = Math.atan2(p.moveY, p.moveX);
    }
    p.x += p.kbx * DT; p.y += p.kby * DT;
    p.kbx *= 0.82; p.kby *= 0.82;
    p.x = clamp(p.x, p.r, MAP_W - p.r);
    p.y = clamp(p.y, p.r, MAP_H - p.r);
    this.pushOut(p, this.boss.hp > 0 ? this.boss : null);
    for (const o of this.objects) if (o.alive) this.pushOut(p, o);

    // 재생
    if (p.hp < p.stats.maxHp) this.heal(p, p.stats.regen * DT, true);

    // 회오리
    if (p.whirl > 0) {
      p.whirl -= DT;
      p.whirlT -= DT;
      if (p.whirlT <= 0) {
        p.whirlT = 0.25;
        const r = 165 * p.stats.area;
        for (const u of this.enemiesNear(p, p.x, p.y, r)) {
          const a = Math.atan2(u.y - p.y, u.x - p.x);
          this.hurt(u, 24 * p.stats.might, p, { kb: { x: Math.cos(a), y: Math.sin(a), f: 18 }, wid: 'skill' });
        }
        this.fx.push(['nova', Math.round(p.x), Math.round(p.y), Math.round(r), 1]);
      }
    }

    this.fireWeapons(p);
  }

  pushOut(p, u) {
    if (!u) return;
    const dx = p.x - u.x, dy = p.y - u.y;
    const min = p.r + u.r;
    const dd = dx * dx + dy * dy;
    if (dd < min * min) {
      const d = Math.sqrt(dd) || 1;
      p.x = u.x + dx / d * min;
      p.y = u.y + dy / d * min;
    }
  }

  fireWeapons(p) {
    for (const w of p.weapons) {
      const ws = this.weaponStats(p, w);
      const d = ws.d;
      if (d.kind === 'orbit') { this.updateOrbit(p, w, ws); continue; }
      w.t -= DT;
      if (w.t > 0) continue;
      let fired = true;
      switch (d.kind) {
        case 'arc': fired = this.fireArc(p, ws); break;
        case 'proj': fired = this.fireProj(p, ws, d.id === 'daggers' ? 'dagger' : 'bullet'); break;
        case 'aoeproj': fired = this.fireAoeProj(p, ws); break;
        case 'aura': fired = this.fireAura(p, ws); break;
        case 'strike': fired = this.fireStrike(p, ws); break;
        case 'homing': fired = this.fireHoming(p, ws); break;
        case 'nova': fired = this.fireNova(p, ws); break;
      }
      w.t = fired ? ws.cd : 0.1;
    }
  }

  fireArc(p, ws) {
    const range = ws.range;
    const targets = this.findTargets(p, range + 25, ws.count);
    if (!targets.length) return false;
    const done = [];
    for (const t of targets) {
      const a = Math.atan2(t.y - p.y, t.x - p.x);
      if (done.some(x => Math.abs(angDiff(x, a)) < 0.6)) continue;
      done.push(a);
      for (const u of this.enemiesNear(p, p.x, p.y, range)) {
        const ua = Math.atan2(u.y - p.y, u.x - p.x);
        const dist = Math.sqrt(d2(p.x, p.y, u.x, u.y));
        if (dist > u.r + 10 && Math.abs(angDiff(ua, a)) > ws.d.arc / 2 + Math.atan2(u.r, dist)) continue;
        this.hurt(u, ws.dmg, p, { kb: { x: Math.cos(ua), y: Math.sin(ua), f: ws.d.kb || 0 }, status: ws.d.status, melee: true, wid: ws.id });
      }
      this.fx.push(['arc', Math.round(p.x), Math.round(p.y), Math.round(a * 100), Math.round(range), Math.round(ws.d.arc * 100), CLASS_IDS.indexOf(p.cls)]);
      if (ws.d.wave) {
        const spd = 640;
        this.projectiles.push({
          id: this.id(), team: 'p', owner: p, x: p.x, y: p.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
          r: 26 * ws.areaMult, dmg: ws.dmg * 0.6, pierce: 99, life: 0.38 + 0.03 * ws.lv, hit: new Set(), kind: 'wave',
          status: ws.d.status, wid: ws.id,
        });
      }
    }
    p.face = done[0];
    return true;
  }

  fireProj(p, ws, kind) {
    const [t] = this.findTargets(p, ws.d.range);
    if (!t) return false;
    const base = Math.atan2(t.y - p.y, t.x - p.x);
    const n = ws.count, spr = ws.d.spread;
    for (let i = 0; i < n; i++) {
      const a = base + (i - (n - 1) / 2) * spr;
      this.projectiles.push({
        id: this.id(), team: 'p', owner: p, x: p.x, y: p.y, vx: Math.cos(a) * ws.d.speed, vy: Math.sin(a) * ws.d.speed,
        r: ws.d.r, dmg: ws.dmg, pierce: ws.pierce, life: ws.d.life, hit: new Set(), kind, wid: ws.id,
      });
    }
    p.face = base;
    return true;
  }

  fireAoeProj(p, ws) {
    const ts = this.findTargets(p, ws.d.range, ws.count);
    if (!ts.length) return false;
    for (let i = 0; i < ws.count; i++) {
      const t = ts[i % ts.length];
      const a = Math.atan2(t.y - p.y, t.x - p.x) + (i >= ts.length ? (i - ts.length + 1) * 0.25 : 0);
      this.projectiles.push({
        id: this.id(), team: 'p', owner: p, x: p.x, y: p.y, vx: Math.cos(a) * ws.d.speed, vy: Math.sin(a) * ws.d.speed,
        r: ws.d.r, dmg: ws.dmg, pierce: 0, life: ws.d.life, hit: new Set(), kind: 'fireball',
        explode: ws.explode, status: ws.d.status, wid: ws.id,
      });
      if (i === 0) p.face = a;
    }
    return true;
  }

  fireAura(p, ws) {
    const list = this.enemiesNear(p, p.x, p.y, ws.radius);
    let hits = 0;
    for (const u of list) { this.hurt(u, ws.dmg, p, { wid: ws.id }); hits++; }
    if (hits && ws.d.heal) this.heal(p, Math.min(hits, 6) * ws.d.heal * (1 + 0.15 * (ws.lv - 1)), true);
    return true;
  }

  fireStrike(p, ws) {
    const cands = this.enemiesNear(p, p.x, p.y, ws.d.range);
    if (!cands.length) return false;
    for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
    for (let i = 0; i < ws.count && i < cands.length; i++) {
      const u = cands[i];
      this.fx.push(['bolt', Math.round(u.x), Math.round(u.y)]);
      for (const v of this.enemiesNear(p, u.x, u.y, 40 * ws.areaMult)) this.hurt(v, ws.dmg, p, { status: ws.d.status, wid: ws.id });
    }
    return true;
  }

  fireHoming(p, ws) {
    const [t] = this.findTargets(p, ws.d.range);
    if (!t) return false;
    const base = Math.atan2(t.y - p.y, t.x - p.x);
    for (let i = 0; i < ws.count; i++) {
      const a = base + (i - (ws.count - 1) / 2) * 0.5;
      this.projectiles.push({
        id: this.id(), team: 'p', owner: p, x: p.x, y: p.y, vx: Math.cos(a) * ws.d.speed, vy: Math.sin(a) * ws.d.speed,
        r: ws.d.r, dmg: ws.dmg, pierce: 0, life: ws.d.life, hit: new Set(), kind: 'missile', homing: t, retarget: 0, wid: ws.id,
      });
    }
    return true;
  }

  fireNova(p, ws) {
    const list = this.enemiesNear(p, p.x, p.y, ws.radius);
    if (!list.length) return false;
    for (const u of list) this.hurt(u, ws.dmg, p, { status: ws.d.status, wid: ws.id });
    this.fx.push(['nova', Math.round(p.x), Math.round(p.y), Math.round(ws.radius), 0]);
    return true;
  }

  orbitParams(p, w) {
    const ws = this.weaponStats(p, w);
    return { count: ws.count, radius: ws.d.radius * ws.areaMult, rot: ws.d.rot * (1 + 0.05 * (ws.lv - 1)), ws };
  }

  updateOrbit(p, w, ws) {
    const count = ws.count, radius = ws.d.radius * ws.areaMult, rot = ws.d.rot * (1 + 0.05 * (ws.lv - 1));
    const br = 14 * ws.areaMult;
    for (let i = 0; i < count; i++) {
      const a = this.time * rot + i * TAU / count;
      const bx = p.x + Math.cos(a) * radius, by = p.y + Math.sin(a) * radius;
      for (const u of this.enemiesNear(p, bx, by, br)) {
        const next = w.hits.get(u.id) || 0;
        if (this.time < next) continue;
        w.hits.set(u.id, this.time + ws.d.hitCd);
        this.hurt(u, ws.dmg, p, { kb: { x: Math.cos(a), y: Math.sin(a), f: 10 }, wid: ws.id });
      }
    }
    if (this.tick % 150 === 0) for (const [k, v] of w.hits) if (v < this.time) w.hits.delete(k);
  }

  // ───────────────────────── 투사체 ─────────────────────────
  explode(pr) {
    const p = pr.owner;
    for (const u of this.enemiesNear(p, pr.x, pr.y, pr.explode)) {
      const a = Math.atan2(u.y - pr.y, u.x - pr.x);
      this.hurt(u, pr.dmg, p, { status: pr.status, kb: pr.kb ? { x: Math.cos(a), y: Math.sin(a), f: pr.kb } : null, wid: pr.wid });
    }
    this.fx.push(['boom', Math.round(pr.x), Math.round(pr.y), Math.round(pr.explode), pr.kind === 'grenade' ? 1 : 0]);
  }

  updateProjectiles() {
    const keep = [];
    for (const pr of this.projectiles) {
      if (pr.homing) {
        pr.retarget -= DT;
        if (pr.retarget <= 0 || pr.homing.dead || pr.homing.hp <= 0 || (pr.homing.kind === 'object' && !pr.homing.alive)) {
          pr.retarget = 0.25;
          const owner = pr.owner;
          const list = this.enemiesNear(owner, pr.x, pr.y, 450);
          let best = null, bd = Infinity;
          for (const u of list) { const dd = d2(pr.x, pr.y, u.x, u.y); if (dd < bd) { bd = dd; best = u; } }
          if (best) pr.homing = best;
        }
        const t = pr.homing;
        if (t && !t.dead && t.hp > 0) {
          const sp = Math.hypot(pr.vx, pr.vy);
          const want = Math.atan2(t.y - pr.y, t.x - pr.x);
          const cur = Math.atan2(pr.vy, pr.vx);
          const na = cur + clamp(angDiff(want, cur), -7 * DT, 7 * DT);
          pr.vx = Math.cos(na) * sp; pr.vy = Math.sin(na) * sp;
        }
      }
      pr.x += pr.vx * DT; pr.y += pr.vy * DT;
      pr.life -= DT;
      let alive = pr.life > 0 && pr.x > -50 && pr.y > -50 && pr.x < MAP_W + 50 && pr.y < MAP_H + 50;

      if (alive && pr.team === 'p' && !pr.noHit) {
        const list = this.enemiesNear(pr.owner, pr.x, pr.y, pr.r);
        for (const u of list) {
          if (pr.hit.has(u.id)) continue;
          if (pr.explode) { this.explode(pr); alive = false; pr.exploded = true; break; }
          pr.hit.add(u.id);
          const a = Math.atan2(pr.vy, pr.vx);
          this.hurt(u, pr.dmg, pr.owner, { status: pr.status, kb: { x: Math.cos(a), y: Math.sin(a), f: 8 }, wid: pr.wid });
          if (pr.pierce-- <= 0) { alive = false; break; }
        }
      } else if (alive && pr.team === 'm') {
        for (const q of this.players) {
          if (q.dead || d2(pr.x, pr.y, q.x, q.y) > (pr.r + q.r) ** 2) continue;
          this.hurt(q, pr.dmg, pr.owner, { status: pr.status });
          alive = false;
          break;
        }
      }
      if (!alive && pr.explode && !pr.exploded && pr.team === 'p') this.explode(pr);
      if (alive) keep.push(pr);
    }
    this.projectiles = keep;
  }

  monsterShot(owner, x, y, ang, speed, dmg, kind, r = 8, life = 3, status = null) {
    this.projectiles.push({
      id: this.id(), team: 'm', owner, x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      r, dmg, pierce: 0, life, hit: null, kind, status,
    });
  }

  updateHazards() {
    const keep = [];
    for (const h of this.hazards) {
      h.t -= DT;
      if (h.t > 0) { keep.push(h); continue; }
      if (h.team === 'p') {
        for (const u of this.enemiesNear(h.owner, h.x, h.y, h.r)) {
          const a = Math.atan2(u.y - h.y, u.x - h.x);
          this.hurt(u, h.dmg, h.owner, { status: h.status, kb: { x: Math.cos(a), y: Math.sin(a), f: 60 }, wid: 'skill' });
        }
      } else {
        for (const q of this.players) {
          if (q.dead || d2(h.x, h.y, q.x, q.y) > (h.r + q.r) ** 2) continue;
          this.hurt(q, h.dmg, h.owner, { status: h.status });
        }
      }
      this.fx.push(['boom', Math.round(h.x), Math.round(h.y), Math.round(h.r), h.team === 'p' ? 2 : 4]);
    }
    this.hazards = keep;
  }

  // ───────────────────────── 몬스터 ─────────────────────────
  nearestPlayer(x, y, maxD = Infinity) {
    let best = null, bd = maxD * maxD;
    for (const q of this.players) {
      if (q.dead) continue;
      const dd = d2(x, y, q.x, q.y);
      if (dd < bd) { bd = dd; best = q; }
    }
    return best;
  }

  updateMobs() {
    const dm = this.monsterDmgMult();
    for (const q of this.players) q.nearMobs = 0;
    for (const m of this.mobs) {
      if (m.dead) continue;
      this.tickStatus(m);
      if (m.dead) continue;
      const t = this.nearestPlayer(m.x, m.y, DESPAWN_DIST);
      if (!t) { m.dead = true; continue; } // 아무도 근처에 없으면 소멸
      t.nearMobs++;
      const dx = t.x - m.x, dy = t.y - m.y;
      const dist = Math.hypot(dx, dy) || 1;
      const def = MOBS[m.type];
      if (!this.isDisabled(m)) {
        let sp = m.speed * this.slowMult(m);
        let ux = dx / dist, uy = dy / dist;
        if (def.ranged) {
          if (dist < def.ranged.range * 0.6) { ux = -ux; uy = -uy; }
          else if (dist < def.ranged.range) sp = 0;
          m.shootT -= DT;
          if (m.shootT <= 0 && dist < def.ranged.range * 1.1) {
            m.shootT = def.ranged.cd;
            this.monsterShot(m, m.x, m.y, Math.atan2(dy, dx), def.ranged.speed, def.dmg * dm, 'arrow', 6, 2);
          }
        }
        m.x += ux * sp * DT; m.y += uy * sp * DT;
      }
      m.x += m.kbx * DT; m.y += m.kby * DT;
      m.kbx *= 0.8; m.kby *= 0.8;
      m.x = clamp(m.x, m.r, MAP_W - m.r); m.y = clamp(m.y, m.r, MAP_H - m.r);

      m.atkT -= DT;
      if (m.atkT <= 0 && !this.isDisabled(m)) {
        for (const q of this.players) {
          if (q.dead || d2(m.x, m.y, q.x, q.y) > (m.r + q.r + 2) ** 2) continue;
          this.hurt(q, def.dmg * dm, m, { melee: true });
          m.atkT = 0.9;
          break;
        }
      }
    }
    // 몹끼리 겹침 해소
    this.grid.clear();
    for (const m of this.mobs) if (!m.dead) this.grid.insert(m);
    for (const m of this.mobs) {
      if (m.dead) continue;
      this.grid.query(m.x, m.y, m.r * 2, o => {
        if (o === m || o.dead) return;
        const dx = m.x - o.x, dy = m.y - o.y, min = m.r + o.r;
        const dd = dx * dx + dy * dy;
        if (dd < min * min && dd > 0.01) {
          const d = Math.sqrt(dd), push = (min - d) * 0.25;
          m.x += dx / d * push; m.y += dy / d * push;
        }
      });
    }
  }

  spawnLogic() {
    const min = this.minutes;
    // 분 단위 웨이브: 각 플레이어 주변에 몹 무리 포위
    const wm = Math.floor(min);
    if (wm > this.lastWaveMinute) {
      this.lastWaveMinute = wm;
      this.pushFeed(`${wm}분 경과 — 몬스터 무리가 몰려옵니다!`, 'warn');
      for (const p of this.players) {
        if (p.dead) continue;
        const n = Math.min(14 + wm * 3, 40);
        const type = wm < 3 ? 'bat' : wm < 6 ? 'zombie' : 'skeleton';
        for (let i = 0; i < n; i++) {
          const a = i * TAU / n;
          this.spawnMob(type, p.x + Math.cos(a) * 620, p.y + Math.sin(a) * 620);
        }
      }
    }
    if (this.mobs.length >= GLOBAL_MOB_CAP) return;
    const rate = Math.min(1.4 + min * 0.5, 7);
    const cap = Math.min(70 + min * 12, 180);
    for (const p of this.players) {
      if (p.dead) continue;
      p.spawnAcc += rate * DT;
      while (p.spawnAcc >= 1) {
        p.spawnAcc -= 1;
        if (p.nearMobs >= cap || this.mobs.length >= GLOBAL_MOB_CAP) { p.spawnAcc = 0; break; }
        const a = Math.random() * TAU, dist = rand(720, 950);
        let x = p.x + Math.cos(a) * dist, y = p.y + Math.sin(a) * dist;
        // 맵 밖이면 플레이어 기준으로 반사 (귀퉁이에서도 사방에서 몰려오도록)
        if (x < 20 || x > MAP_W - 20) x = 2 * p.x - x;
        if (y < 20 || y > MAP_H - 20) y = 2 * p.y - y;
        if (x < 20 || y < 20 || x > MAP_W - 20 || y > MAP_H - 20) continue;
        if (d2(x, y, CENTER.x, CENTER.y) < (BOSS_ARENA_R + 100) ** 2) continue;
        const zone = 1 - clamp(Math.hypot(x - CENTER.x, y - CENTER.y) / MAX_CORNER_DIST, 0, 1);
        const type = weightedPick(MOB_TYPE_IDS, k => ({
          zombie: 5,
          bat: min < 8 ? 3 : 1.5,
          skeleton: min >= 1 ? 2 + zone * 4 : zone > 0.4 ? 1 : 0,
          archer: min >= 2 ? 1.5 + zone * 1.5 : 0,
          brute: min >= 4 ? 0.3 + zone * 1.2 + min * 0.03 : zone > 0.5 ? 0.3 : 0,
        })[k]);
        this.spawnMob(type, x, y);
        p.nearMobs++;
      }
    }
  }

  // ───────────────────────── 오브젝트 ─────────────────────────
  updateObject(o) {
    if (!o.alive) {
      o.respawnT -= DT;
      if (o.respawnT <= 0) {
        o.alive = true; o.x = o.home.x; o.y = o.home.y; o.target = null; o.status = {};
        this.resetObjectHp(o);
        this.pushFeed(`${OBJECTS[o.type].name}${o.tier === 2 ? '(강)' : ''}이(가) 다시 나타났습니다`, 'object');
      }
      return;
    }
    this.tickStatus(o);
    if (!o.alive) return;
    const def = OBJECTS[o.type];
    const dm = this.monsterDmgMult() * (o.tier === 2 ? 1.3 : 1);

    // 타겟 관리 (리쉬)
    if (o.target && (o.target.dead || d2(o.target.x, o.target.y, o.home.x, o.home.y) > 780 * 780)) o.target = null;
    if (!o.target) {
      const q = this.nearestPlayer(o.x, o.y, 400);
      if (q) o.target = q;
    }
    const t = o.target;
    const disabled = this.isDisabled(o);

    if (!t) {
      const dh = Math.hypot(o.home.x - o.x, o.home.y - o.y);
      if (dh > 5) {
        const sp = def.speed * 2;
        o.x += (o.home.x - o.x) / dh * Math.min(sp * DT, dh);
        o.y += (o.home.y - o.y) / dh * Math.min(sp * DT, dh);
      }
      o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.05 * DT);
      return;
    }

    const dx = t.x - o.x, dy = t.y - o.y, dist = Math.hypot(dx, dy) || 1, ang = Math.atan2(dy, dx);
    if (o.dashT > 0) {
      o.dashT -= DT;
      o.x += o.dvx * DT; o.y += o.dvy * DT;
    } else if (!disabled) {
      const keep = o.type === 'lich' ? 260 : o.r + t.r + 10;
      const sp = def.speed * this.slowMult(o);
      if (dist > keep) { o.x += dx / dist * sp * DT; o.y += dy / dist * sp * DT; }
      else if (o.type === 'lich' && dist < keep - 60) { o.x -= dx / dist * sp * DT; o.y -= dy / dist * sp * DT; }
    }
    // 리쉬 반경 제한
    const hx = o.x - o.home.x, hy = o.y - o.home.y, hd = Math.hypot(hx, hy);
    if (hd > 560) { o.x = o.home.x + hx / hd * 560; o.y = o.home.y + hy / hd * 560; }

    if (!disabled) {
      o.t1 -= DT; o.t2 -= DT; o.t3 -= DT;
      if (o.type === 'golem') {
        if (o.t1 <= 0) { // 바위 투척
          o.t1 = 2.2;
          this.monsterShot(o, o.x, o.y, ang, 380, def.dmg * dm * 0.9, 'rock', 15, 2.5);
        }
        if (o.t2 <= 0 && dist < 260) { // 내려찍기
          o.t2 = 3.6;
          this.hazards.push({ id: this.id(), x: o.x, y: o.y, r: 200, t: 0.9, total: 0.9, dmg: def.dmg * dm * 1.6, team: 'm', owner: o, status: { stun: { t: 0.8 } }, kind: 0 });
        }
      } else if (o.type === 'wyvern') {
        if (o.t1 <= 0 && dist < 520) { // 화염 숨결
          o.t1 = 2.0;
          for (let i = -2; i <= 2; i++) this.monsterShot(o, o.x, o.y, ang + i * 0.17, 340, def.dmg * dm * 0.8, 'fire', 11, 1.8, { burn: { t: 2, dps: 6 } });
        }
        if (o.t2 <= 0 && dist < 600 && dist > 120) { // 급강하 돌진
          o.t2 = 6.5;
          o.dashT = 0.55; o.dvx = Math.cos(ang) * 650; o.dvy = Math.sin(ang) * 650;
        }
      } else if (o.type === 'lich') {
        if (o.t1 <= 0) { // 방사형 마탄
          o.t1 = 2.6;
          const n = 12, off = Math.random() * TAU;
          for (let i = 0; i < n; i++) this.monsterShot(o, o.x, o.y, off + i * TAU / n, 260, def.dmg * dm * 0.8, 'mbolt', 9, 3, { slow: { t: 1, amt: 0.3 } });
        }
        if (o.t2 <= 0) { // 저주 장판
          o.t2 = 4;
          this.hazards.push({ id: this.id(), x: t.x, y: t.y, r: 115, t: 1.1, total: 1.1, dmg: def.dmg * dm * 1.5, team: 'm', owner: o, status: { slow: { t: 2, amt: 0.4 } }, kind: 0 });
        }
        if (o.t3 <= 0) { // 해골 소환
          o.t3 = 12;
          for (let i = 0; i < 4; i++) {
            const a = i * TAU / 4;
            this.spawnMob('skeleton', o.x + Math.cos(a) * 70, o.y + Math.sin(a) * 70, { summoned: true, hpMult: 0.7 });
          }
        }
      }
    }

    o.contactT -= DT;
    if (o.contactT <= 0) {
      for (const q of this.players) {
        if (q.dead || d2(o.x, o.y, q.x, q.y) > (o.r + q.r + 4) ** 2) continue;
        this.hurt(q, def.dmg * dm, o, { melee: true });
        o.contactT = 0.8;
      }
    }
  }

  // ───────────────────────── 보스 ─────────────────────────
  updateBoss() {
    const b = this.boss;
    if (b.hp <= 0) return;
    if (this.bossSealed()) return;
    if (!b.awake) {
      b.awake = true;
      this.pushFeed(`${BOSS.name}의 봉인이 풀렸습니다! 막타를 친 플레이어가 승리합니다.`, 'warn');
    }
    this.tickStatus(b);
    if (b.hp <= 0) return;
    const dm = this.monsterDmgMult();
    if (!b.enraged && b.hp < b.maxHp * 0.5) {
      b.enraged = true;
      this.pushFeed(`${BOSS.name}이(가) 분노했습니다!`, 'warn');
    }
    if (b.target && (b.target.dead || d2(b.target.x, b.target.y, CENTER.x, CENTER.y) > 1000 * 1000)) b.target = null;
    if (!b.target) {
      const q = this.nearestPlayer(b.x, b.y, 820);
      if (q) b.target = q;
    }
    const t = b.target;
    if (!t) {
      const dc = Math.hypot(CENTER.x - b.x, CENTER.y - b.y);
      if (dc > 4) { b.x += (CENTER.x - b.x) / dc * Math.min(BOSS.speed * DT, dc); b.y += (CENTER.y - b.y) / dc * Math.min(BOSS.speed * DT, dc); }
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.015 * DT);
      b.spiralT = 0; b.dashT = 0;
      return;
    }
    const dx = t.x - b.x, dy = t.y - b.y, dist = Math.hypot(dx, dy) || 1, ang = Math.atan2(dy, dx);
    if (b.dashT > 0) {
      b.dashT -= DT;
      b.x += b.dvx * DT; b.y += b.dvy * DT;
    } else if (dist > b.r + t.r + 20) {
      const sp = BOSS.speed * this.slowMult(b) * (b.enraged ? 1.25 : 1);
      b.x += dx / dist * sp * DT; b.y += dy / dist * sp * DT;
    }
    const cx = b.x - CENTER.x, cy = b.y - CENTER.y, cd = Math.hypot(cx, cy);
    if (cd > BOSS_ARENA_R) { b.x = CENTER.x + cx / cd * BOSS_ARENA_R; b.y = CENTER.y + cy / cd * BOSS_ARENA_R; }

    // 나선 탄막 진행
    if (b.spiralT > 0) {
      b.spiralT -= DT; b.spiralCd -= DT;
      if (b.spiralCd <= 0) {
        b.spiralCd = 0.09;
        b.spiralA += 0.33;
        const arms = b.enraged ? 4 : 3;
        for (let i = 0; i < arms; i++) this.monsterShot(b, b.x, b.y, b.spiralA + i * TAU / arms, 270, BOSS.dmg * dm * 0.55, 'boss', 10, 3.5);
      }
    }

    b.patternT -= DT;
    if (b.patternT <= 0) {
      const pats = ['burst', 'slam', 'charge', 'spiral', 'summon', 'burst', 'slam', 'charge'];
      const pat = pats[b.patIdx++ % pats.length];
      b.patternT = b.enraged ? 1.7 : 2.4;
      if (pat === 'burst') {
        const n = b.enraged ? 30 : 22, off = Math.random() * TAU;
        for (let i = 0; i < n; i++) this.monsterShot(b, b.x, b.y, off + i * TAU / n, 300, BOSS.dmg * dm * 0.7, 'boss', 11, 3.5);
      } else if (pat === 'slam') {
        for (const q of this.players) {
          if (q.dead || d2(q.x, q.y, b.x, b.y) > 900 * 900) continue;
          this.hazards.push({ id: this.id(), x: q.x, y: q.y, r: 140, t: 1.1, total: 1.1, dmg: BOSS.dmg * dm * 1.4, team: 'm', owner: b, kind: 0, status: null });
        }
        this.hazards.push({ id: this.id(), x: b.x, y: b.y, r: 250, t: 1.2, total: 1.2, dmg: BOSS.dmg * dm * 1.6, team: 'm', owner: b, kind: 0, status: { stun: { t: 0.7 } } });
      } else if (pat === 'charge') {
        b.dashT = 0.6; b.dvx = Math.cos(ang) * 780; b.dvy = Math.sin(ang) * 780;
      } else if (pat === 'spiral') {
        b.spiralT = 2.2; b.spiralCd = 0;
      } else if (pat === 'summon') {
        const n = b.enraged ? 8 : 5;
        for (let i = 0; i < n; i++) {
          const a = i * TAU / n;
          this.spawnMob(i % 4 === 0 ? 'brute' : 'skeleton', b.x + Math.cos(a) * 140, b.y + Math.sin(a) * 140, { summoned: true });
        }
      }
    }

    b.contactT -= DT;
    if (b.contactT <= 0) {
      for (const q of this.players) {
        if (q.dead || d2(b.x, b.y, q.x, q.y) > (b.r + q.r + 4) ** 2) continue;
        this.hurt(q, BOSS.dmg * dm, b, { melee: true });
        b.contactT = 0.7;
      }
    }
  }

  // ───────────────────────── 픽업 ─────────────────────────
  updatePickups() {
    const keep = [];
    for (const g of this.pickups) {
      if (g.taken) continue;
      if (g.moving) {
        const p = g.moving;
        if (p.dead) { g.moving = null; keep.push(g); continue; }
        const dx = p.x - g.x, dy = p.y - g.y, dist = Math.hypot(dx, dy);
        const sp = 520 + (g.speedUp = (g.speedUp || 0) + DT * 900);
        if (dist < p.r + 6 || dist < sp * DT) { this.collect(p, g); continue; }
        g.x += dx / dist * sp * DT; g.y += dy / dist * sp * DT;
        keep.push(g);
        continue;
      }
      let took = false;
      for (const p of this.players) {
        if (p.dead) continue;
        const dd = d2(p.x, p.y, g.x, g.y);
        if (g.type === 'gem') {
          if (dd < p.stats.magnet * p.stats.magnet) {
            g.moving = p;
            if (this.gemCells.get(g.key) === g) this.gemCells.delete(g.key);
            break;
          }
        } else if (dd < (p.r + 16) ** 2) {
          this.collect(p, g); took = true; break;
        }
      }
      if (!took) keep.push(g);
    }
    this.pickups = keep;
  }

  collect(p, g) {
    g.taken = true;
    if (this.gemCells.get(g.key) === g) this.gemCells.delete(g.key);
    switch (g.type) {
      case 'gem': this.gainXp(p, g.v); break;
      case 'meat': this.heal(p, p.stats.maxHp * 0.3); break;
      case 'magnet':
        for (const o of this.pickups) {
          if (o.type === 'gem' && !o.moving && !o.taken && d2(o.x, o.y, p.x, p.y) < 1800 * 1800) {
            o.moving = p;
            if (this.gemCells.get(o.key) === o) this.gemCells.delete(o.key);
          }
        }
        break;
      case 'bomb':
        for (const m of this.mobs) {
          if (!m.dead && d2(m.x, m.y, p.x, p.y) < 600 * 600) this.hurt(m, 200 * (1 + this.minutes * 0.3), p, { noCrit: true, noSteal: true, wid: 'bomb' });
        }
        this.fx.push(['boom', Math.round(p.x), Math.round(p.y), 600, 3]);
        break;
      case 'chest':
        p.choices.push({ type: 'level', options: null });
        this.ensureOptions(p);
        break;
    }
    if (g.type !== 'gem') this.fx.push(['item', Math.round(p.x), Math.round(p.y), ITEM_IDS.indexOf(g.type), p.id]);
  }

  // ───────────────────────── 직렬화 ─────────────────────────
  roster() {
    return this.players.map(p => ({ id: p.id, slot: p.slot, name: p.name, cls: p.cls, isBot: p.isBot, color: p.color }));
  }

  // 모든 클라이언트에 공통인 부분 (스냅샷 틱마다 1회 생성)
  buildShared() {
    const r = Math.round;
    const players = this.players.map(p => {
      let aura = 0, orb = 0, orbR = 0, orbRot = 0;
      for (const w of p.weapons) {
        const d = WEAPONS[w.id];
        if (d.kind === 'aura') aura = r(this.weaponStats(p, w).radius);
        if (d.kind === 'orbit') { const o = this.orbitParams(p, w); orb = o.count; orbR = r(o.radius); orbRot = r(o.rot * 100); }
      }
      return [p.id, r(p.x), r(p.y), r(p.hp), p.stats.maxHp, CLASS_IDS.indexOf(p.cls), p.level,
        (p.dead ? 1 : 0) | (this.statusFlags(p) << 1), r(p.face * 100), aura, orb, orbR, orbRot];
    });
    const objects = this.objects.map(o => [o.id, OBJ_TYPE_IDS.indexOf(o.type), r(o.x), r(o.y), r(o.hp), o.maxHp,
      o.alive ? 1 : 0, r(o.respawnT), this.statusFlags(o), o.tier]);
    const b = this.boss;
    const boss = [r(b.x), r(b.y), r(Math.max(0, b.hp)), b.maxHp, this.statusFlags(b), b.enraged ? 1 : 0, b.dashT > 0 ? 1 : 0,
      Math.max(0, Math.ceil(this.settings.bossUnseal - this.time))];
    const score = this.players.map(p => [p.id, p.level, p.kills, p.deaths, p.objKills, p.mobKills, p.dead ? Math.ceil(p.respawnT) : -1]);
    return {
      t: 's', time: Math.round(this.time * 1000) / 1000, mult: Math.round(this.mobAtkMult * 100) / 100,
      pvp: this.pvpActive() ? 1 : 0, grace: Math.max(0, Math.ceil(this.settings.pvpGrace - this.time)),
      p: players, o: objects, b: boss, sb: score, feed: this.feed.splice(0),
    };
  }

  // viewer: 시점 플레이어(자신 또는 관전 대상)
  snapshotFor(shared, viewer, me) {
    const r = Math.round;
    const cx = viewer ? viewer.x : CENTER.x, cy = viewer ? viewer.y : CENTER.y;
    const VX = 1250, VY = 850;
    const inView = (x, y, pad = 0) => Math.abs(x - cx) < VX + pad && Math.abs(y - cy) < VY + pad;
    const mobs = [];
    for (const m of this.mobs) if (!m.dead && inView(m.x, m.y)) mobs.push([m.id, MOB_TYPE_IDS.indexOf(m.type), r(m.x), r(m.y), r(m.hp / m.maxHp * 100), this.statusFlags(m)]);
    const proj = [];
    for (const p of this.projectiles) if (inView(p.x, p.y)) proj.push([p.id, PROJ_KINDS.indexOf(p.kind), r(p.x), r(p.y), r(p.r), p.team === 'm' ? 1 : 0, r(Math.atan2(p.vy, p.vx) * 100)]);
    const picks = [];
    for (const g of this.pickups) if (!g.taken && inView(g.x, g.y)) picks.push([g.id, ITEM_IDS.indexOf(g.type), r(g.x), r(g.y), g.type === 'gem' ? r(g.v * 10) : 0]);
    const haz = [];
    for (const h of this.hazards) if (inView(h.x, h.y, h.r)) haz.push([h.id, r(h.x), r(h.y), r(h.r), r(h.t * 100), r(h.total * 100), h.team === 'p' ? 0 : 1, h.kind || 0]);
    const vid = viewer ? viewer.id : -1;
    const fx = [];
    for (const f of this.fx) {
      if (f[0] === 'd') { if (f[5] === vid || f[6] === vid) fx.push([f[0], f[1], f[2], f[3], f[4], f[6] === vid ? 1 : 0]); continue; }
      if (f[0] === 'h' || f[0] === 'lvl' || f[0] === 'item') { if (f[f.length - 1] === vid) fx.push(f); continue; }
      if (f[0] === 'line' || inView(f[1], f[2], 300)) fx.push(f);
    }
    const snap = { ...shared, m: mobs, pr: proj, g: picks, hz: haz, fx, view: viewer ? viewer.id : 0 };
    if (me) snap.me = this.meState(me);
    return snap;
  }

  meState(p) {
    const c = p.choices[0];
    return {
      id: p.id, hp: Math.round(p.hp), maxHp: p.stats.maxHp, xp: Math.floor(p.xp), xpNext: xpToNext(p.level), level: p.level,
      w: p.weapons.map(w => [w.id, w.lv]), pa: p.passives, re: p.relics,
      ch: p.choices.length, ct: c ? c.type : null, opt: c ? c.options : null,
      sk: Math.round(p.skillT * 10) / 10, skm: Math.round(SKILLS[CLASSES[p.cls].skill].cd * p.stats.skillCd * 10) / 10,
      tm: p.targetMode, dead: p.dead, rt: Math.ceil(p.respawnT), seq: p.inputSeq, bot: p.isBot,
      st: {
        might: Math.round(p.stats.might * 100), armor: p.stats.armor, speed: Math.round(p.stats.speed),
        crit: Math.round(p.stats.crit * 100), cd: Math.round((1 - p.stats.cdMult) * 100), ls: Math.round(p.stats.lifesteal * 100),
      },
    };
  }

  results() {
    return this.players.map(p => ({
      id: p.id, name: p.name, cls: p.cls, isBot: p.isBot, level: p.level, kills: p.kills, deaths: p.deaths,
      objKills: p.objKills, mobKills: p.mobKills, dmg: Math.round(p.dmgDealt),
      dmgBy: Object.fromEntries(Object.entries(p.dmgBy).map(([k, v]) => [k, Math.round(v)])),
    }));
  }
}
