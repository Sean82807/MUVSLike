// 헤드리스 시뮬레이션: AI 4명으로 게임을 빠르게 돌려 크래시/밸런스를 확인한다.
//   node test/sim.js            전체 게임 (최대 30분 게임 시간)
//   node test/sim.js --quick    3분만 실행 (스모크 테스트)
//   node test/sim.js --games 5  여러 판 실행 후 요약
import { Game } from '../server/game.js';
import { TICK_RATE, SNAPSHOT_EVERY, CLASS_IDS } from '../shared/defs.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const games = +(args[args.indexOf('--games') + 1] || 1) || 1;
const maxMinutes = quick ? 3 : 30;

function runOne(n) {
  const classes = [...CLASS_IDS].sort(() => Math.random() - 0.5).slice(0, 4);
  const g = new Game(classes.map((cls, i) => ({ name: `Bot${i + 1}`, cls, isBot: true })));
  const start = Date.now();
  let lastMin = -1, maxMobs = 0, maxProj = 0, snapBytes = 0, snaps = 0;
  while (!g.over && g.time < maxMinutes * 60) {
    g.step();
    maxMobs = Math.max(maxMobs, g.mobs.length);
    maxProj = Math.max(maxProj, g.projectiles.length);
    if (g.tick % SNAPSHOT_EVERY === 0) {
      const shared = g.buildShared();
      for (const p of g.players) {
        const s = JSON.stringify(g.snapshotFor(shared, p, p));
        snapBytes += s.length; snaps++;
      }
      g.fx.length = 0;
    }
    const m = Math.floor(g.minutes);
    if (m !== lastMin && (m % 2 === 0 || quick)) {
      lastMin = m;
      const ps = g.players.map(p => `${p.name}(${p.cls}) L${p.level} K${p.kills} D${p.deaths} O${p.objKills}${p.dead ? ' dead' : ''}`).join(' | ');
      console.log(`[${m}m] mobs=${g.mobs.length} gems=${g.pickups.length} boss=${Math.round(g.boss.hp)} mult=x${g.mobAtkMult.toFixed(1)}  ${ps}`);
    }
  }
  const wall = (Date.now() - start) / 1000;
  const winner = g.over && g.players.find(p => p.id === g.over.winnerId);
  console.log(`== game ${n}: ${g.over ? (winner ? `winner ${winner.name}(${winner.cls}) at ${(g.time / 60).toFixed(1)}m` : 'no winner') : 'timeout'}`
    + ` | sim ${(g.time / wall).toFixed(0)}x realtime, ms/tick ${(wall * 1000 / g.tick).toFixed(2)}`
    + ` | peak mobs ${maxMobs}, proj ${maxProj}, avg snapshot ${(snapBytes / Math.max(1, snaps) / 1024).toFixed(1)}KB`);
  for (const r of g.results()) {
    const by = Object.entries(r.dmgBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${Math.round(v / 1000)}k`).join(' ');
    console.log(`   ${r.name} ${r.cls.padEnd(10)} L${r.level} kills ${r.kills} deaths ${r.deaths} obj ${r.objKills} mobs ${r.mobKills} dmg ${r.dmg} [${by}]`);
  }
  return { over: !!g.over, winner: winner ? winner.cls : null, time: g.time, tickMs: wall * 1000 / g.tick };
}

const res = [];
for (let i = 1; i <= games; i++) res.push(runOne(i));
if (games > 1) {
  const wins = {};
  for (const r of res) if (r.winner) wins[r.winner] = (wins[r.winner] || 0) + 1;
  console.log('wins by class:', wins, 'avg end minute:', (res.reduce((a, r) => a + r.time, 0) / res.length / 60).toFixed(1));
}
const worst = Math.max(...res.map(r => r.tickMs));
if (worst > 1000 / TICK_RATE) { console.error(`tick too slow: ${worst.toFixed(2)}ms`); process.exit(1); }
