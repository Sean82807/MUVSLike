// AI 플레이어. 사람과 같은 입력(이동 벡터, 조준점, 스킬, 선택)만 사용한다.
import { MAP_W, MAP_H, CENTER, BOSS_ARENA_R, SPAWNS, WEAPONS, CLASSES } from '../shared/defs.js';

const rand = (a, b) => a + Math.random() * (b - a);
const MELEE = new Set(['warrior', 'spellblade', 'paladin']);

const PASSIVE_PREF = {
  melee:  { armor: 8, vitality: 8, might: 9, area: 8, regen: 6, haste: 6, vampire: 7, swift: 5, multi: 6, precision: 4, magnet: 3 },
  ranged: { might: 9, haste: 9, multi: 9, precision: 7, swift: 7, area: 6, vitality: 6, armor: 5, regen: 4, vampire: 5, magnet: 4 },
};
const RELIC_PREF = {
  dragonHeart: 10, phoenix: 9, berserker: 9, prismOrb: 8, titanBelt: 7, executioner: 7, aegis: 7,
  vampFang: 7, luckyClover: 7, stormBoots: 6, manaCrystal: 5, greedCrown: 6, thornMail: 5, hunterMark: 5,
};

export class BotBrain {
  constructor(game, p) {
    this.g = game;
    this.p = p;
    this.melee = MELEE.has(p.cls);
    this.aggr = rand(0.2, 1);          // PvP 성향
    this.bossLevel = Math.round(rand(20, 25));
    this.thinkT = 0;
    this.goalT = 0;
    this.pickT = rand(0.5, 1.5);
    this.goal = { type: 'farm' };
    this.wander = Math.atan2(CENTER.y - p.y, CENTER.x - p.x) + rand(-0.8, 0.8);
    this.mx = 0; this.my = 0;
  }

  power(q) {
    let s = q.level * 1.0;
    for (const w of q.weapons) s += w.lv * 0.6;
    for (const k in q.relics) s += q.relics[k] * 2.5;
    return s * (q.hp / q.stats.maxHp * 0.5 + 0.5);
  }

  update(dt) {
    const p = this.p;
    if (p.choices.length) {
      this.pickT -= dt;
      if (this.pickT <= 0) {
        this.g.ensureOptions(p);
        const c = p.choices[0];
        if (c && c.options) this.g.pick(p, this.choose(c.options));
        this.pickT = rand(0.4, 1.6);
      }
    }
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.15 + Math.random() * 0.1;
      this.think(dt);
    }
    p.moveX = this.mx; p.moveY = this.my;
  }

  choose(opts) {
    const p = this.p;
    const pref = PASSIVE_PREF[this.melee ? 'melee' : 'ranged'];
    let best = 0, bs = -Infinity;
    opts.forEach((o, i) => {
      let s = 0;
      if (o.k === 'w') {
        const own = p.weapons.find(w => w.id === o.id);
        if (WEAPONS[o.id].sig) s = 11;
        else if (own) s = 7 + own.lv * 0.3;
        else s = p.weapons.length < 3 ? 7.5 : 5;
      } else if (o.k === 'p') s = pref[o.id] || 5;
      else if (o.k === 'r') {
        s = RELIC_PREF[o.id] || 5;
        if (o.id === 'phoenix' && p.relics.phoenix) s = 4;
        if (o.id === 'executioner' && p.level >= 15) s += 3;
      } else s = 1;
      s += Math.random() * 2.5;
      if (s > bs) { bs = s; best = i; }
    });
    return best;
  }

  chooseGoal() {
    const g = this.g, p = this.p;
    const hpF = p.hp / p.stats.maxHp;
    if (hpF < 0.4) return { type: 'retreat' };

    // 보스
    if (g.boss.hp > 0 && !g.bossSealed() && (p.level >= this.bossLevel || g.minutes > 16 || (g.boss.hp < g.boss.maxHp * 0.35 && p.level >= 14))) {
      if (hpF > 0.5) return { type: 'boss' };
    }

    // PvP
    if (g.pvpActive() && hpF > 0.5) {
      const mine = this.power(p);
      let prey = null, pd = Infinity;
      for (const q of g.players) {
        if (q === p || q.dead || q.invuln > 0) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        const range = 500 + this.aggr * 400;
        if (d < range && this.power(q) * (1.25 - this.aggr * 0.4) < mine && d < pd) { prey = q; pd = d; }
      }
      if (prey && Math.random() < 0.3 + this.aggr * 0.6) return { type: 'hunt', target: prey };
    }

    // 오브젝트
    let obj = null, od = Infinity;
    for (const o of g.objects) {
      if (!o.alive) continue;
      const need = (o.tier === 2 ? 16 : 10) + (o.type === 'wyvern' ? 2 : 0);
      if (p.level < need) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < 1700 && d < od) { obj = o; od = d; }
    }
    if (obj && hpF > 0.7) return { type: 'object', target: obj };

    return { type: 'farm' };
  }

  think() {
    const g = this.g, p = this.p;
    const hpF = p.hp / p.stats.maxHp;

    this.goalT -= 0.2;
    const gl = this.goal;
    const invalid =
      (gl.type === 'hunt' && (gl.target.dead || gl.target.invuln > 0 || hpF < 0.35)) ||
      (gl.type === 'object' && (!gl.target.alive || hpF < 0.45)) ||
      (gl.type === 'boss' && (g.boss.hp <= 0 || hpF < 0.3)) ||
      (gl.type === 'retreat' && hpF > 0.75);
    if (this.goalT <= 0 || invalid) {
      this.goal = this.chooseGoal();
      this.goalT = rand(1.5, 3);
    }
    const goal = this.goal;

    // 목표 방향
    let gx = 0, gy = 0, aimTarget = null;
    const toward = (x, y, keep) => {
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d > keep + 20) { gx = dx / d; gy = dy / d; }
      else if (d < keep - 60) { gx = -dx / d; gy = -dy / d; }
      else { gx = -dy / d * 0.6; gy = dx / d * 0.6; } // 원을 그리며 카이팅
    };
    const keepDist = this.melee ? 0 : 280;

    p.targetMode = this.aggr > 0.7 && g.pvpActive() ? 'auto' : 'monster';
    if (goal.type === 'retreat') {
      const sp = SPAWNS[p.slot];
      // 고기 우선
      let meat = null, md = 700 * 700;
      for (const it of g.pickups) {
        if (it.type !== 'meat') continue;
        const d = (it.x - p.x) ** 2 + (it.y - p.y) ** 2;
        if (d < md) { md = d; meat = it; }
      }
      if (meat) toward(meat.x, meat.y, 0);
      else toward(sp.x, sp.y, 0);
    } else if (goal.type === 'boss') {
      toward(g.boss.x, g.boss.y, keepDist + g.boss.r);
      aimTarget = g.boss;
    } else if (goal.type === 'object') {
      toward(goal.target.x, goal.target.y, keepDist + goal.target.r);
      aimTarget = goal.target;
    } else if (goal.type === 'hunt') {
      toward(goal.target.x, goal.target.y, this.melee ? 0 : 230);
      aimTarget = goal.target;
      p.targetMode = 'player';
    } else {
      // 파밍: 가까운 경험치 쪽으로, 없으면 배회 (레벨이 오를수록 중앙 쪽으로)
      let gem = null, best = -Infinity;
      for (const it of g.pickups) {
        if (it.type !== 'gem' || it.moving) continue;
        const d = Math.hypot(it.x - p.x, it.y - p.y);
        if (d > 650) continue;
        const s = it.v * 2 - d / 60;
        if (s > best) { best = s; gem = it; }
      }
      if (gem) toward(gem.x, gem.y, 0);
      else {
        const dc = Math.hypot(CENTER.x - p.x, CENTER.y - p.y);
        const wantDist = Math.max(BOSS_ARENA_R + 700, 3600 - p.level * 140);
        const ca = Math.atan2(CENTER.y - p.y, CENTER.x - p.x);
        this.wander += rand(-0.25, 0.25);
        const bias = dc > wantDist ? 0.5 : -0.5;
        gx = Math.cos(this.wander) + Math.cos(ca) * bias;
        gy = Math.sin(this.wander) + Math.sin(ca) * bias;
      }
    }

    // 위험 회피
    let ax = 0, ay = 0, crowd = 0;
    const R = this.melee && hpF > 0.5 ? 110 : 240;
    g.grid.query(p.x, p.y, R, m => {
      if (m.dead) return;
      const dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy) || 1;
      if (d > R) return;
      const w = (1 - d / R) ** 2 * (m.type === 'brute' ? 2.5 : 1);
      ax += dx / d * w; ay += dy / d * w;
      crowd++;
    });
    for (const pr of g.projectiles) {
      if (pr.team !== 'm') continue;
      const dx = p.x - pr.x, dy = p.y - pr.y, d = Math.hypot(dx, dy);
      if (d > 220) continue;
      const sp = Math.hypot(pr.vx, pr.vy) || 1;
      if ((pr.vx * dx + pr.vy * dy) / sp / (d || 1) < 0.6) continue; // 나를 향하지 않음
      // 투사체 진행 방향의 수직으로 회피
      const px = -pr.vy / sp, py = pr.vx / sp;
      const side = px * dx + py * dy >= 0 ? 1 : -1;
      ax += px * side * 2.2 * (1 - d / 220); ay += py * side * 2.2 * (1 - d / 220);
    }
    for (const h of g.hazards) {
      if (h.team !== 'm') continue;
      const dx = p.x - h.x, dy = p.y - h.y, d = Math.hypot(dx, dy) || 1;
      if (d < h.r + p.r + 30) { ax += dx / d * 6; ay += dy / d * 6; }
    }
    // 보스/오브젝트 회피 (교전 대상이 아닐 때)
    if (goal.type !== 'boss' && g.boss.hp > 0) {
      const dx = p.x - CENTER.x, dy = p.y - CENTER.y, d = Math.hypot(dx, dy) || 1;
      if (d < BOSS_ARENA_R + 450) { ax += dx / d * 3; ay += dy / d * 3; }
    }
    for (const o of g.objects) {
      if (!o.alive || (goal.type === 'object' && goal.target === o)) continue;
      const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy) || 1;
      if (d < o.r + 380) { ax += dx / d * 2.5; ay += dy / d * 2.5; }
    }
    // 강한 플레이어 회피
    if (g.pvpActive() && hpF < 0.5) {
      for (const q of g.players) {
        if (q === p || q.dead) continue;
        const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy) || 1;
        if (d < 450 && this.power(q) > this.power(p)) { ax += dx / d * 2; ay += dy / d * 2; }
      }
    }
    // 맵 가장자리
    const E = 160;
    if (p.x < E) ax += (E - p.x) / E * 2;
    if (p.y < E) ay += (E - p.y) / E * 2;
    if (p.x > MAP_W - E) ax -= (p.x - (MAP_W - E)) / E * 2;
    if (p.y > MAP_H - E) ay -= (p.y - (MAP_H - E)) / E * 2;

    const dangerW = goal.type === 'retreat' ? 2 : this.melee ? 1.0 : 1.6;
    let mx = gx + ax * dangerW, my = gy + ay * dangerW;
    const l = Math.hypot(mx, my);
    if (l > 0.05) { mx /= l; my /= l; } else { mx = 0; my = 0; }
    this.mx = mx; this.my = my;

    this.useSkill(goal, aimTarget, crowd, hpF);
  }

  useSkill(goal, aimTarget, crowd, hpF) {
    const g = this.g, p = this.p;
    if (p.skillT > 0) return;
    const sk = CLASSES[p.cls].skill;
    const [near] = g.findTargets(p, 600, 1);
    const tgt = aimTarget && Math.hypot(aimTarget.x - p.x, aimTarget.y - p.y) < 650 ? aimTarget : near;
    const aimAt = u => { p.aimX = u.x; p.aimY = u.y; };
    const tgtDist = tgt ? Math.hypot(tgt.x - p.x, tgt.y - p.y) : Infinity;
    const big = tgt && tgt.kind !== 'mob';
    switch (sk) {
      case 'whirlwind':
        if (crowd >= 5 || (big && tgtDist < 170)) g.useSkill(p);
        break;
      case 'grenade':
      case 'meteor':
        if (tgt && (big || crowd >= 4) && tgtDist < 560) { aimAt(tgt); g.useSkill(p); }
        break;
      case 'blink':
      case 'shadowstep':
        if (goal.type === 'retreat' && crowd >= 3) {
          const sp = SPAWNS[p.slot];
          p.aimX = sp.x; p.aimY = sp.y;
          g.useSkill(p);
        } else if (tgt && (big || crowd >= 4) && tgtDist < 380 && hpF > 0.4) { aimAt(tgt); g.useSkill(p); }
        break;
      case 'divineShield':
        if (hpF < 0.4 || (crowd >= 8 && hpF < 0.7)) g.useSkill(p);
        break;
    }
  }
}
