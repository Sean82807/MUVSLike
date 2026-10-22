// 방 하나 = 로비(슬롯 4개) + 진행 중인 게임. 방마다 독립적으로 동작한다.
import { Game, DT } from './game.js';
import { SNAPSHOT_EVERY, CLASS_IDS, CLASSES, DEFAULT_SETTINGS } from '../shared/defs.js';

const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };

export class Room {
  /**
   * @param {string} id 방 코드
   * @param {string} name 방 이름
   * @param {boolean} isPrivate 목록에 표시하지 않음 (코드/링크로만 입장)
   * @param {{onEmpty:Function, onChange:Function}} hooks
   */
  constructor(id, name, isPrivate, hooks) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.hooks = hooks;
    this.clients = new Map(); // cid -> client
    this.hostId = 0;
    this.state = 'lobby'; // lobby | playing | over
    this.settings = { ...DEFAULT_SETTINGS };
    this.game = null;
    this.overTimer = null;
    this.tickAcc = 0;
    this.tickCount = 0;
    this.createdAt = Date.now();
    this.slots = [0, 1, 2, 3].map(i => ({ type: 'bot', cid: 0, name: `AI ${i + 1}`, cls: CLASS_IDS[i] }));
  }

  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients.values()) send(c, s); }

  lobbyState() {
    return {
      t: 'lobby', room: { id: this.id, name: this.name, private: this.isPrivate },
      state: this.state, hostId: this.hostId, settings: this.settings,
      slots: this.slots.map((s, i) => ({ i, type: s.type, name: s.name, cls: s.cls, cid: s.cid })),
      spectators: [...this.clients.values()].filter(c => c.slot < 0).map(c => ({ id: c.id, name: c.name })),
    };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyState());
    this.hooks.onChange();
  }

  summary() {
    const host = this.clients.get(this.hostId);
    return {
      id: this.id, name: this.name, state: this.state, host: host ? host.name : '',
      humans: this.slots.filter(s => s.type === 'human').length,
      spectators: [...this.clients.values()].filter(c => c.slot < 0).length,
      time: this.game ? Math.floor(this.game.time) : 0,
    };
  }

  pickHost() {
    if (this.clients.has(this.hostId)) return;
    const all = [...this.clients.values()];
    const first = all.find(c => c.slot >= 0) || all[0];
    this.hostId = first ? first.id : 0;
  }

  takeSlot(c, i) {
    const s = this.slots[i];
    s.type = 'human'; s.cid = c.id; s.name = c.name;
    c.slot = i;
  }

  releaseSlot(c) {
    if (c.slot < 0) return;
    const s = this.slots[c.slot];
    s.type = 'bot'; s.cid = 0; s.name = `AI ${c.slot + 1}`;
    if (this.game) {
      const p = this.game.players[c.slot];
      this.game.setBot(p, true);
      this.game.pushFeed(`${c.name} 님이 나갔습니다 — AI가 이어서 플레이합니다`, 'info');
    }
    c.slot = -1;
  }

  // ───────────────────────── 입장/퇴장 ─────────────────────────
  join(c) {
    c.room = this;
    c.slot = -1;
    c.spectate = 0;
    this.clients.set(c.id, c);
    if (this.state === 'lobby') {
      const i = this.slots.findIndex(s => s.type === 'bot');
      if (i >= 0) this.takeSlot(c, i);
    }
    this.pickHost();
    this.broadcastLobby();
    if (this.state === 'playing' && this.game) this.sendStart(c);
  }

  leave(c) {
    if (c.room !== this) return;
    this.releaseSlot(c);
    this.clients.delete(c.id);
    c.room = null;
    if (this.clients.size === 0) { this.dispose(); this.hooks.onEmpty(this); return; }
    this.pickHost();
    if (this.game && this.state === 'playing') this.broadcast({ t: 'roster', roster: this.game.roster() });
    this.broadcastLobby();
  }

  dispose() {
    if (this.overTimer) { clearTimeout(this.overTimer); this.overTimer = null; }
    this.game = null;
  }

  // ───────────────────────── 게임 진행 ─────────────────────────
  startGame() {
    if (this.overTimer) { clearTimeout(this.overTimer); this.overTimer = null; }
    this.game = new Game(this.slots.map(s => ({ name: s.name, cls: s.cls, isBot: s.type === 'bot' })), this.settings);
    this.state = 'playing';
    this.tickAcc = 0;
    this.tickCount = 0;
    for (const c of this.clients.values()) this.sendStart(c);
    this.broadcastLobby();
  }

  sendStart(c) {
    const p = c.slot >= 0 && this.game ? this.game.players[c.slot] : null;
    send(c, { t: 'start', roster: this.game.roster(), you: p ? p.id : 0, settings: this.game.settings });
  }

  backToLobby() {
    if (this.overTimer) { clearTimeout(this.overTimer); this.overTimer = null; }
    this.game = null;
    this.state = 'lobby';
    for (const c of this.clients.values()) {
      if (c.slot < 0) {
        const i = this.slots.findIndex(s => s.type === 'bot');
        if (i >= 0) this.takeSlot(c, i);
      }
    }
    this.broadcastLobby();
  }

  // 게임 루프에서 매 프레임 호출 (dt: 실제 경과 시간, 초)
  update(dt) {
    if (!this.game || this.state !== 'playing') return;
    this.tickAcc += dt;
    let steps = 0;
    while (this.tickAcc >= DT && steps < 5) {
      this.tickAcc -= DT; steps++;
      try { this.game.step(); } catch (e) { console.error(`[room ${this.id}] step error`, e); }
      this.tickCount++;
      if (this.tickCount % SNAPSHOT_EVERY === 0) this.sendSnapshots();
      if (this.game.over) { this.endGame(); return; }
    }
    if (steps === 5) this.tickAcc = 0;
  }

  sendSnapshots() {
    const game = this.game;
    const shared = game.buildShared();
    for (const c of this.clients.values()) {
      if (c.ws.readyState !== 1) continue;
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

  endGame() {
    this.sendSnapshots();
    this.state = 'over';
    this.broadcast({ t: 'over', winnerId: this.game.over.winnerId, time: this.game.over.time, results: this.game.results() });
    this.broadcastLobby();
    this.overTimer = setTimeout(() => { if (this.state === 'over') this.backToLobby(); }, 30000);
  }

  // ───────────────────────── 메시지 ─────────────────────────
  handle(c, msg) {
    const isHost = c.id === this.hostId;
    const { slots, game } = this;
    switch (msg.t) {
      case 'cls':
        if (this.state === 'lobby' && c.slot >= 0 && CLASSES[msg.cls]) { slots[c.slot].cls = msg.cls; this.broadcastLobby(); }
        break;
      case 'botcls':
        if (isHost && this.state === 'lobby' && slots[msg.slot] && slots[msg.slot].type === 'bot') {
          slots[msg.slot].cls = CLASSES[msg.cls] ? msg.cls : CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];
          this.broadcastLobby();
        }
        break;
      case 'settings':
        if (isHost && this.state === 'lobby') {
          const s = msg.settings || {};
          if (typeof s.respawn === 'boolean') this.settings.respawn = s.respawn;
          if (Number.isFinite(+s.pvpGrace)) this.settings.pvpGrace = Math.max(0, Math.min(600, +s.pvpGrace));
          if (Number.isFinite(+s.bossUnseal)) this.settings.bossUnseal = Math.max(0, Math.min(3600, +s.bossUnseal));
          this.broadcastLobby();
        }
        break;
      case 'rename':
        if (isHost) {
          const name = String(msg.name || '').replace(/[<>]/g, '').trim().slice(0, 20);
          if (name) { this.name = name; this.broadcastLobby(); }
        }
        break;
      case 'slot': // 로비에서 다른 빈(AI) 슬롯으로 이동
        if (this.state === 'lobby' && slots[msg.slot] && slots[msg.slot].type === 'bot') {
          const cls = c.slot >= 0 ? slots[c.slot].cls : slots[msg.slot].cls;
          if (c.slot >= 0) this.releaseSlot(c);
          this.takeSlot(c, msg.slot);
          slots[msg.slot].cls = cls;
          this.broadcastLobby();
        }
        break;
      case 'spectate': // 로비에서 관전자로 전환
        if (this.state === 'lobby' && c.slot >= 0) { this.releaseSlot(c); this.broadcastLobby(); }
        break;
      case 'start':
        if (isHost && this.state === 'lobby') this.startGame();
        break;
      case 'lobby':
        if (isHost && this.state === 'over') this.backToLobby();
        break;
      case 'takeover': // 게임 중 관전자가 AI 플레이어를 인수
        if (game && this.state === 'playing' && c.slot < 0 && slots[msg.slot] && slots[msg.slot].type === 'bot') {
          this.takeSlot(c, msg.slot);
          const p = game.players[msg.slot];
          game.setBot(p, false);
          p.name = c.name;
          game.pushFeed(`${c.name} 님이 ${msg.slot + 1}번 플레이어를 인수했습니다`, 'info');
          this.broadcast({ t: 'roster', roster: game.roster() });
          this.sendStart(c);
          this.broadcastLobby();
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
        if (text) this.broadcast({ t: 'chat', name: c.name, text });
        break;
      }
    }
  }
}
