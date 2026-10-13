// 서버와 클라이언트가 함께 쓰는 게임 데이터 정의.
// 수치 밸런스는 대부분 이 파일에서 조정한다.

export const TICK_RATE = 30;          // 서버 시뮬레이션 틱 (Hz)
export const SNAPSHOT_EVERY = 2;      // N틱마다 스냅샷 전송 (=15Hz)

export const MAP_W = 6000;
export const MAP_H = 6000;
export const CENTER = { x: MAP_W / 2, y: MAP_H / 2 };
export const BOSS_ARENA_R = 520;      // 보스 활동 반경 (일반 몹은 여기 스폰되지 않음)

// 4 귀퉁이 시작 위치
export const SPAWNS = [
  { x: 380, y: 380 },
  { x: MAP_W - 380, y: 380 },
  { x: 380, y: MAP_H - 380 },
  { x: MAP_W - 380, y: MAP_H - 380 },
];
export const SLOT_COLORS = ['#4fc3f7', '#ffb74d', '#9ccc65', '#f06292'];

export const PLAYER_RADIUS = 18;
export const PVP_DAMAGE_MULT = 0.6;   // 플레이어 간 피해 배율
export const DEATH_ATK_BONUS = 0.1;   // 플레이어 1명 사망당 몹 공격력 +10%
export const ARMOR_K = 30;            // 받는 피해 = dmg * K / (K + armor)
export const MAX_WEAPONS = 4;         // 고유 무기 포함
export const BASE_MAGNET = 90;

export const DEFAULT_SETTINGS = {
  respawn: true,      // 사망 후 부활 여부
  pvpGrace: 60,       // 게임 시작 후 PvP 금지 시간(초)
  bossUnseal: 480,    // 보스 봉인 해제 시각(초). 그 전에는 무적/휴면
};

// ───────────────────────── 클래스 ─────────────────────────
export const CLASSES = {
  warrior: {
    name: '전사', icon: '⚔', color: '#e53935',
    hp: 190, armor: 20, speed: 155, crit: 0.05,
    weapon: 'greatsword', skill: 'whirlwind',
    desc: '근거리 광역 베기, 높은 체력과 방어력',
  },
  rifleman: {
    name: '소총수', icon: '➶', color: '#8d6e63',
    hp: 130, armor: 10, speed: 165, crit: 0.08,
    weapon: 'rifle', skill: 'grenade',
    desc: '빠르고 강력한 원거리 사격, 중간 방어력',
  },
  mage: {
    name: '마법사', icon: '✦', color: '#7e57c2',
    hp: 95, armor: 2, speed: 160, crit: 0.05,
    weapon: 'fireball', skill: 'meteor',
    desc: '느리지만 광역 폭발 + 화상/둔화, 취약한 방어력',
  },
  spellblade: {
    name: '마검사', icon: '⚡', color: '#26a69a',
    hp: 145, armor: 11, speed: 165, crit: 0.06,
    weapon: 'runeblade', skill: 'blink',
    desc: '근거리 마법 검격 + 검기, 중간 방어력',
  },
  assassin: {
    name: '암살자', icon: '✧', color: '#455a64',
    hp: 110, armor: 5, speed: 192, crit: 0.22,
    weapon: 'daggers', skill: 'shadowstep',
    desc: '빠른 이동과 높은 치명타, 낮은 방어력',
  },
  paladin: {
    name: '성기사', icon: '✚', color: '#fdd835',
    hp: 215, armor: 16, speed: 145, crit: 0.04,
    weapon: 'consecrate', skill: 'divineShield',
    desc: '주변 지속 신성 피해 + 흡수, 무적 스킬',
  },
};
export const CLASS_IDS = Object.keys(CLASSES);

// ───────────────────────── 스킬 (Space / 우클릭) ─────────────────────────
export const SKILLS = {
  whirlwind:    { name: '회오리 베기', cd: 10, desc: '2.5초간 회전하며 주변을 베고 받는 피해 30% 감소' },
  grenade:      { name: '수류탄',     cd: 8,  desc: '조준 지점에 폭발 (넉백)' },
  meteor:       { name: '메테오',     cd: 12, desc: '잠시 후 조준 지점에 거대한 운석 (화상+기절)' },
  blink:        { name: '섬광 베기',   cd: 7,  desc: '조준 방향으로 순간이동하며 경로의 적을 벰' },
  shadowstep:   { name: '그림자 걸음', cd: 9,  desc: '순간 돌진 후 3초간 치명타 확정' },
  divineShield: { name: '천상의 보호막', cd: 18, desc: '2.5초 무적 + 체력 25% 회복' },
};

// ───────────────────────── 무기 ─────────────────────────
// cntLv: 해당 레벨 도달 시 개수 +1 (기본 [3,5]), pierceLv: 3레벨마다 관통 +1
// kind: arc(근접 부채꼴), proj(투사체), aoeproj(폭발 투사체), aura(주변 지속),
//       orbit(회전), strike(번개), homing(유도), nova(파동)
export const WEAPONS = {
  greatsword: { name: '대검', desc: '전방 넓은 부채꼴 베기 + 넉백', sig: 'warrior', kind: 'arc', dmg: 40, cd: 1.0, range: 150, arc: 2.4, kb: 70, cntLv: [] },
  rifle:      { name: '소총', desc: '가장 가까운 적에게 고속 탄환 (레벨업 시 관통)', sig: 'rifleman', kind: 'proj', dmg: 21, cd: 0.45, speed: 980, life: 0.8, pierce: 0, pierceLv: true, count: 1, cntLv: [5], spread: 0.1, r: 5, range: 720 },
  fireball:   { name: '화염구', desc: '착탄 시 폭발, 화상+둔화', sig: 'mage', kind: 'aoeproj', dmg: 48, cd: 1.7, speed: 470, life: 1.5, explode: 125, r: 13, range: 680, cntLv: [6],
                status: { burn: { t: 3, dps: 10 }, slow: { t: 1.5, amt: 0.4 } } },
  runeblade:  { name: '룬검', desc: '마력 베기 + 전방 검기 발사, 둔화', sig: 'spellblade', kind: 'arc', dmg: 32, cd: 0.85, range: 135, arc: 2.0, kb: 30, wave: true, cntLv: [],
                status: { slow: { t: 1, amt: 0.3 } } },
  daggers:    { name: '단검', desc: '단검 여러 개 투척', sig: 'assassin', kind: 'proj', dmg: 15, cd: 0.45, speed: 820, life: 0.55, pierce: 0, count: 2, spread: 0.22, r: 5, range: 450 },
  consecrate: { name: '신성 지대', desc: '주변 적에게 지속 피해, 적중 수만큼 회복', sig: 'paladin', kind: 'aura', dmg: 14, cd: 0.5, radius: 125, heal: 1.0 },

  orbit:      { name: '회전 칼날', desc: '주위를 도는 칼날', kind: 'orbit', dmg: 16, count: 2, radius: 95, rot: 3.2, hitCd: 0.5 },
  lightning:  { name: '낙뢰', desc: '무작위 적에게 낙뢰 + 기절', kind: 'strike', dmg: 42, cd: 2.2, count: 2, range: 520, status: { stun: { t: 0.35 } } },
  missile:    { name: '유도탄', desc: '적을 추적하는 유도탄', kind: 'homing', dmg: 22, cd: 1.5, count: 2, speed: 430, life: 2.5, r: 7, range: 600 },
  nova:       { name: '서리 파동', desc: '주변에 냉기 파동, 강한 둔화', kind: 'nova', dmg: 22, cd: 3.2, radius: 190, status: { slow: { t: 2, amt: 0.5 } } },
};
export const WEAPON_MAX_LV = 6;
export const GENERIC_WEAPONS = Object.keys(WEAPONS).filter(k => !WEAPONS[k].sig);

// ───────────────────────── 패시브 ─────────────────────────
export const PASSIVES = {
  might:     { name: '힘',     max: 5, desc: '피해 +12%' },
  armor:     { name: '갑옷',   max: 5, desc: '방어력 +4' },
  vitality:  { name: '활력',   max: 5, desc: '최대 체력 +18%' },
  regen:     { name: '재생',   max: 5, desc: '초당 체력 +0.7' },
  swift:     { name: '신속',   max: 5, desc: '이동 속도 +8%' },
  haste:     { name: '가속',   max: 5, desc: '무기 쿨다운 -7%' },
  area:      { name: '확장',   max: 5, desc: '공격 범위 +10%' },
  multi:     { name: '복제',   max: 2, desc: '투사체/타격 수 +1' },
  magnet:    { name: '자력',   max: 5, desc: '획득 범위 +35%' },
  precision: { name: '정밀',   max: 5, desc: '치명타 확률 +6%' },
  vampire:   { name: '흡혈',   max: 5, desc: '피해량의 2% 흡혈' },
};

// ───────────────────────── 강화 아이템(유물) ─────────────────────────
// 오브젝트 막타, 플레이어 처치 시 3개 중 1개를 실시간으로 선택
export const RELICS = {
  dragonHeart:  { name: '용의 심장',     desc: '피해 +25%, 최대 체력 +20%' },
  titanBelt:    { name: '거인의 허리띠', desc: '최대 체력 +45%' },
  berserker:    { name: '광전사의 인장', desc: '무기 쿨다운 -18%' },
  aegis:        { name: '수호자의 방패', desc: '방어력 +12' },
  vampFang:     { name: '흡혈귀의 송곳니', desc: '흡혈 +5%' },
  stormBoots:   { name: '폭풍의 장화',   desc: '이동 속도 +18%' },
  prismOrb:     { name: '분광 보주',     desc: '투사체 +1, 범위 +15%' },
  executioner:  { name: '처형자의 도끼', desc: '오브젝트/보스 피해 +40%' },
  phoenix:      { name: '불사조 깃털',   desc: '사망 시 1회 부활 (50% 체력)' },
  manaCrystal:  { name: '마나 결정',     desc: '스킬 쿨다운 -35%' },
  greedCrown:   { name: '탐욕의 왕관',   desc: '경험치 획득 +40%' },
  thornMail:    { name: '가시 갑옷',     desc: '받은 근접 피해의 35% 반사' },
  hunterMark:   { name: '사냥꾼의 표식', desc: '플레이어 대상 피해 +30%' },
  luckyClover:  { name: '네잎클로버',   desc: '치명타 +10%, 치명타 피해 +50%' },
};

// ───────────────────────── 몬스터 ─────────────────────────
export const MOBS = {
  zombie:   { name: '좀비',   hp: 22,  dmg: 8,  speed: 62,  r: 14, xp: 1,  color: '#6d8f4e' },
  bat:      { name: '박쥐',   hp: 11,  dmg: 5,  speed: 122, r: 10, xp: 1,  color: '#8e5bb5' },
  skeleton: { name: '해골',   hp: 45,  dmg: 10, speed: 80,  r: 14, xp: 2,  color: '#d7ccc8' },
  archer:   { name: '해골 궁수', hp: 32, dmg: 10, speed: 72,  r: 13, xp: 3,  color: '#bcaaa4',
              ranged: { range: 380, cd: 2.4, speed: 300 } },
  brute:    { name: '오우거', hp: 280, dmg: 24, speed: 58,  r: 25, xp: 12, color: '#a1887f', drop: 0.12 },
};

// ───────────────────────── 오브젝트 (정예 몬스터) ─────────────────────────
export const OBJECTS = {
  golem:  { name: '바위 골렘', hp: 3600, dmg: 34, r: 46, speed: 55, xp: 140, color: '#8d8d8d' },
  wyvern: { name: '비룡',     hp: 3000, dmg: 22, r: 42, speed: 85, xp: 140, color: '#c0392b' },
  lich:   { name: '리치',     hp: 2700, dmg: 24, r: 36, speed: 60, xp: 160, color: '#5e35b1' },
};
// 가장자리 중간(두 플레이어가 경쟁) + 대각선 안쪽(각 플레이어 진행 경로, 더 강함)
export const OBJECT_SPOTS = [
  { type: 'golem',  x: MAP_W / 2, y: 900,         tier: 1 },
  { type: 'golem',  x: MAP_W / 2, y: MAP_H - 900, tier: 1 },
  { type: 'wyvern', x: 900,         y: MAP_H / 2, tier: 1 },
  { type: 'wyvern', x: MAP_W - 900, y: MAP_H / 2, tier: 1 },
  { type: 'lich',   x: 1750,         y: 1750,         tier: 2 },
  { type: 'lich',   x: MAP_W - 1750, y: 1750,         tier: 2 },
  { type: 'wyvern', x: 1750,         y: MAP_H - 1750, tier: 2 },
  { type: 'golem',  x: MAP_W - 1750, y: MAP_H - 1750, tier: 2 },
];
export const OBJECT_RESPAWN = 110; // 초

export const BOSS = { name: '심연의 군주', hp: 140000, dmg: 40, r: 78, speed: 70, color: '#311b92' };

// ───────────────────────── 드랍 아이템 ─────────────────────────
export const ITEMS = {
  meat:   { name: '고기',     desc: '체력 30% 회복', color: '#ef5350' },
  magnet: { name: '자석',     desc: '주변 경험치 흡수', color: '#42a5f5' },
  bomb:   { name: '폭탄',     desc: '주변 몬스터에 큰 피해', color: '#424242' },
  chest:  { name: '보물상자', desc: '추가 성장 선택지', color: '#ffca28' },
};
export const ITEM_DROP_CHANCE = 0.012; // 일반 몹 아이템 드랍 확률

export function xpToNext(level) {
  return Math.floor(8 + level * 9 + level * level * 0.8);
}

// 스냅샷 직렬화용 인덱스
export const MOB_TYPE_IDS = Object.keys(MOBS);
export const OBJ_TYPE_IDS = Object.keys(OBJECTS);
export const ITEM_IDS = ['gem', ...Object.keys(ITEMS)];
export const STATUS_BITS = { burn: 1, slow: 2, stun: 4, freeze: 8, invuln: 16, shield: 32, whirl: 64, crit: 128 };

// 투사체 외형 종류
export const PROJ_KINDS = ['bullet', 'dagger', 'fireball', 'wave', 'missile', 'mbolt', 'arrow', 'rock', 'fire', 'grenade', 'boss'];
