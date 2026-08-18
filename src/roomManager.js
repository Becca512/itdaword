const { isValidNext, candidatesFor, aiPickWord, aiThinkTimeMs } = require('./gameEngine');

const rooms = new Map(); // code -> room
const quickmatchQueue = []; // [code]
const singleGames = new Map(); // gameId -> state

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
function genId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function publicRoom(room) {
  // 소켓 id, 타이머 핸들 등 내부 필드는 클라이언트에 노출하지 않는다
  return {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    timeLimit: room.timeLimit,
    teamMode: room.teamMode,
    allowDueum: room.allowDueum,
    handicap: room.handicap,
    rankedMode: !!room.rankedMode,
    status: room.status,
    players: room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, connected: p.connected })),
    chain: room.chain,
    turnOrder: room.turnOrder,
    currentTurn: room.currentTurn,
    scores: room.scores,
    winner: room.winner,
    lastMoveAt: room.lastMoveAt,
  };
}

function currentPlayerId(room) {
  if (!room.turnOrder.length) return null;
  return room.turnOrder[room.currentTurn % room.turnOrder.length];
}

function assignTeam(room) {
  if (!room.teamMode) return null;
  const countA = room.players.filter((p) => p.team === 'A').length;
  const countB = room.players.filter((p) => p.team === 'B').length;
  return countA <= countB ? 'A' : 'B';
}

// ---------- 방 생성 / 참가 ----------
function createRoom({ hostSocketId, name, maxPlayers, timeLimit, teamMode, allowDueum, handicap, rankedMode }) {
  const code = genCode();
  const room = {
    code,
    hostId: hostSocketId,
    maxPlayers: Math.min(8, Math.max(2, maxPlayers || 4)),
    timeLimit: Math.min(60, Math.max(5, timeLimit || 20)),
    teamMode: !!teamMode,
    allowDueum: !!allowDueum,
    handicap: handicap || {},
    rankedMode: !!rankedMode,
    rankedApplied: false, // 레이팅 반영은 딱 한 번만 (타임아웃/제출/퇴장 등 여러 경로로 게임이 끝날 수 있어서)
    status: 'lobby',
    players: [{ id: hostSocketId, name, team: teamMode ? 'A' : null, connected: true }],
    chain: [],
    usedWords: new Set(),
    turnOrder: [],
    currentTurn: 0,
    scores: {},
    winner: null,
    lastMoveAt: Date.now(),
    turnTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function joinRoom({ code, socketId, name }) {
  const room = rooms.get(code);
  if (!room) return { error: '존재하지 않는 방 코드예요.' };
  if (room.status !== 'lobby') return { error: '이미 시작된 게임이에요.' };
  if (room.players.length >= room.maxPlayers) return { error: '방이 가득 찼어요.' };
  room.players.push({ id: socketId, name, team: assignTeam(room), connected: true });
  return { room };
}

function quickMatch({ socketId, name }) {
  while (quickmatchQueue.length) {
    const code = quickmatchQueue[0];
    const room = rooms.get(code);
    if (room && room.status === 'lobby' && room.players.length < room.maxPlayers) {
      room.players.push({ id: socketId, name, team: assignTeam(room), connected: true });
      if (room.players.length >= room.maxPlayers) quickmatchQueue.shift();
      return { room, created: false };
    }
    quickmatchQueue.shift();
  }
  const room = createRoom({ hostSocketId: socketId, name, maxPlayers: 4, timeLimit: 20, teamMode: false, allowDueum: false, handicap: {} });
  quickmatchQueue.push(room.code);
  return { room, created: true };
}

// ---------- 랭크전 / 티어 ----------
// 계정 시스템이 없어서 "닉네임"을 식별자로 레이팅을 저장한다 (같은 닉네임 = 같은 기록 이어짐,
// 서버 재시작하면 초기화, 다른 사람이 같은 닉네임을 쓰면 섞일 수 있음 — 알려진 한계).
const ratings = new Map(); // name -> { rating, wins, losses }
const rankedQueue = [];

const TIERS = [
  { name: '브론즈', min: 0, color: '#B08D57' },
  { name: '실버', min: 1000, color: '#B9C4CA' },
  { name: '골드', min: 1200, color: '#FFD23F' },
  { name: '플래티넘', min: 1400, color: '#5B8CFF' },
  { name: '다이아몬드', min: 1600, color: '#7FDBFF' },
  { name: '마스터', min: 1800, color: '#B983FF' },
];

function getTier(rating) {
  let tier = TIERS[0];
  for (const t of TIERS) {
    if (rating >= t.min) tier = t;
  }
  return tier;
}

function getRatingInfo(name) {
  const key = (name || '플레이어').trim().slice(0, 20) || '플레이어';
  if (!ratings.has(key)) ratings.set(key, { rating: 1000, wins: 0, losses: 0 });
  const r = ratings.get(key);
  const tier = getTier(r.rating);
  return { name: key, rating: r.rating, wins: r.wins, losses: r.losses, tier: tier.name, tierColor: tier.color };
}

// 간이 ELO: K=32. 승자는 (1-기대승률)*K 만큼 얻고, 패자는 그만큼 잃는다.
function applyRankedResult(winnerName, loserName) {
  const wKey = (winnerName || '플레이어').trim().slice(0, 20) || '플레이어';
  const lKey = (loserName || '플레이어').trim().slice(0, 20) || '플레이어';
  if (wKey === lKey) return null; // 같은 이름이면(식별 불가) 반영하지 않음
  if (!ratings.has(wKey)) ratings.set(wKey, { rating: 1000, wins: 0, losses: 0 });
  if (!ratings.has(lKey)) ratings.set(lKey, { rating: 1000, wins: 0, losses: 0 });
  const w = ratings.get(wKey);
  const l = ratings.get(lKey);
  const K = 32;
  const expectedW = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
  const delta = Math.max(8, Math.round(K * (1 - expectedW))); // 최소 8점은 오르내리게 (밋밋함 방지)
  w.rating += delta;
  l.rating = Math.max(0, l.rating - delta);
  w.wins += 1;
  l.losses += 1;
  return {
    winner: { ...getRatingInfo(wKey), delta },
    loser: { ...getRatingInfo(lKey), delta: -delta },
  };
}

// 랭크전 전용 빠른 매칭 — 항상 2인, 핸디캡/두음법칙 없이 공정한 기본 규칙으로 고정.
function quickMatchRanked({ socketId, name }) {
  while (rankedQueue.length) {
    const code = rankedQueue[0];
    const room = rooms.get(code);
    if (room && room.status === 'lobby' && room.players.length < room.maxPlayers) {
      room.players.push({ id: socketId, name, team: null, connected: true });
      rankedQueue.shift(); // 랭크전은 항상 2인이라 채워지면 큐에서 바로 뺀다
      return { room, created: false };
    }
    rankedQueue.shift();
  }
  const room = createRoom({
    hostSocketId: socketId,
    name,
    maxPlayers: 2,
    timeLimit: 20,
    teamMode: false,
    allowDueum: false,
    handicap: {},
    rankedMode: true,
  });
  rankedQueue.push(room.code);
  return { room, created: true };
}

function leaveRoom({ code, socketId }) {
  const room = rooms.get(code);
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== socketId);
  if (room.status === 'playing') {
    room.turnOrder = room.turnOrder.filter((id) => id !== socketId);
    maybeFinishByElimination(room);
  }
  if (room.players.length === 0) {
    clearTurnTimer(room);
    rooms.delete(code);
    const qi = quickmatchQueue.indexOf(code);
    if (qi >= 0) quickmatchQueue.splice(qi, 1);
    const rqi = rankedQueue.indexOf(code);
    if (rqi >= 0) rankedQueue.splice(rqi, 1);
  } else if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
  }
  return room;
}

// ---------- 게임 진행 (멀티) ----------
function startGame(room) {
  const order = room.players.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  room.turnOrder = order;
  room.currentTurn = 0;
  room.status = 'playing';
  room.chain = [];
  room.usedWords = new Set();
  room.scores = {};
  room.players.forEach((p) => (room.scores[p.id] = 0));
  room.winner = null;
  room.lastMoveAt = Date.now();
  // 랭크전은 항상 2인 — 게임이 시작된 시점의 두 이름을 따로 저장해둔다.
  // (나중에 한쪽이 방을 나가서 room.players에서 빠지더라도, 승자/패자를 정확히 가리기 위함)
  if (room.rankedMode) room.rankedParticipants = room.players.map((p) => p.name);
}

function playerName(room, id) {
  const p = room.players.find((pl) => pl.id === id);
  return p ? p.name : '?';
}
function playerTeam(room, id) {
  const p = room.players.find((pl) => pl.id === id);
  return p ? p.team : null;
}

function maybeFinishByElimination(room) {
  if (room.status !== 'playing') return false;
  if (room.turnOrder.length <= 1) {
    room.status = 'finished';
    room.winner = room.turnOrder.length === 1 ? playerName(room, room.turnOrder[0]) : null;
    clearTurnTimer(room);
    return true;
  }
  if (room.teamMode) {
    const teams = new Set(room.turnOrder.map((id) => playerTeam(room, id)));
    if (teams.size === 1) {
      room.status = 'finished';
      room.winner = `팀 ${[...teams][0]}`;
      clearTurnTimer(room);
      return true;
    }
  }
  return false;
}

// 반환: { ok, reason?, room, finished }
async function submitWord({ code, socketId, word }) {
  const room = rooms.get(code);
  if (!room || room.status !== 'playing') return { ok: false, reason: '진행 중인 게임이 아니에요.' };
  const curId = currentPlayerId(room);
  if (curId !== socketId) return { ok: false, reason: '내 차례가 아니에요.' };

  const prev = room.chain.length ? room.chain[room.chain.length - 1].word : null;
  const check = await isValidNext(prev, word, room.usedWords, room.allowDueum, room.handicap);
  if (!check.ok) return { ok: false, reason: check.reason, room };

  // 검증 중에 상태가 바뀌었을 수 있으니(다른 탈락 처리 등) 한 번 더 확인
  if (room.status !== 'playing' || currentPlayerId(room) !== socketId) {
    return { ok: false, reason: '내 차례가 아니에요.' };
  }

  room.chain.push({ word: check.word, playerId: socketId });
  room.usedWords.add(check.word);
  room.scores[socketId] = (room.scores[socketId] || 0) + 1;
  room.currentTurn += 1;
  room.lastMoveAt = Date.now();

  const nextOpts = await candidatesFor(check.word, room.usedWords, room.allowDueum, room.handicap);
  let finished = false;
  if (nextOpts.length === 0) {
    room.status = 'finished';
    room.winner = room.teamMode ? `팀 ${playerTeam(room, socketId)}` : playerName(room, socketId);
    clearTurnTimer(room);
    finished = true;
  }
  return { ok: true, room, finished };
}

// 시간 초과 시 해당 플레이어를 회전에서 제외(탈락)
function handleTimeout(room) {
  if (room.status !== 'playing') return;
  const outId = currentPlayerId(room);
  room.turnOrder = room.turnOrder.filter((id) => id !== outId);
  if (room.currentTurn >= room.turnOrder.length) room.currentTurn = 0;
  room.lastMoveAt = Date.now();
  maybeFinishByElimination(room);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

// ---------- 싱글플레이 (서버 권위 AI) ----------
const referralCodes = new Map(); // shareCode -> gameId
const GAUGE_MAX = 100;
const GAUGE_TIMEOUT_PENALTY = GAUGE_MAX; // 15초 한 번만 넘겨도 즉시 게임오버 (게이지가 한 번에 0으로)
const GAUGE_FRIEND_BONUS = 1; // 친구 한 명 참여당 이만큼 회복

function genShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function createSingleGame({ socketId, name, level, allowDueum, handicap }) {
  const gameId = genId('sg');
  const shareCode = genShareCode();
  const state = {
    gameId,
    socketId,
    name,
    level: Math.min(10, Math.max(0, level)),
    allowDueum: !!allowDueum,
    handicap: handicap || {},
    chain: [],
    usedWords: new Set(),
    myScore: 0,
    aiScore: 0,
    status: 'playing',
    busy: false, // 이전 제출이 처리 중일 때 동시 제출(더블클릭 등)을 막기 위한 락
    gauge: GAUGE_MAX,
    shareCode,
    redeemedBy: new Set(), // 이 코드로 이미 보상을 받은 소켓 id들 (중복 적립 방지)
  };
  singleGames.set(gameId, state);
  referralCodes.set(shareCode, gameId);
  return state;
}

// 친구가 초대코드로 접속했을 때 호출. 같은 사람이 여러 번 눌러도 한 번만 적립된다.
function redeemFriendCode({ code, redeemerSocketId }) {
  const gameId = referralCodes.get(code);
  if (!gameId) return { ok: false, reason: '유효하지 않은 초대 코드예요.' };
  const state = singleGames.get(gameId);
  if (!state || state.status !== 'playing') return { ok: false, reason: '게임이 이미 끝났거나 찾을 수 없어요.' };
  if (state.socketId === redeemerSocketId) return { ok: false, reason: '본인이 만든 코드는 사용할 수 없어요.' };
  if (state.redeemedBy.has(redeemerSocketId)) return { ok: false, reason: '이미 참여 보상을 받은 친구예요.' };
  state.redeemedBy.add(redeemerSocketId);
  state.gauge = Math.min(GAUGE_MAX, state.gauge + GAUGE_FRIEND_BONUS);
  return { ok: true, gameId, ownerSocketId: state.socketId, newGauge: state.gauge };
}

// 15초 턴 제한 초과 시 호출 — 게임을 끝내지 않고 게이지만 깎는다.
function applySingleTimeout(state) {
  if (state.status !== 'playing') return { finished: false };
  state.gauge = Math.max(0, state.gauge - GAUGE_TIMEOUT_PENALTY);
  if (state.gauge <= 0) {
    state.status = 'finished';
    return { finished: true, winner: 'ai' };
  }
  return { finished: false };
}

async function submitSingleWord({ gameId, word }) {
  const state = singleGames.get(gameId);
  if (!state || state.status !== 'playing') return { ok: false, reason: '진행 중인 게임이 아니에요.' };
  if (state.busy) return { ok: false, reason: '이전 입력을 처리하고 있어요. 잠시만 기다려 주세요.' };
  state.busy = true;
  try {
    const prev = state.chain.length ? state.chain[state.chain.length - 1].word : null;
    const check = await isValidNext(prev, word, state.usedWords, state.allowDueum, state.handicap);
    if (!check.ok) return { ok: false, reason: check.reason };
    if (state.status !== 'playing') return { ok: false, reason: '진행 중인 게임이 아니에요.' };

    state.chain.push({ word: check.word, who: 'me' });
    state.usedWords.add(check.word);
    state.myScore += 1;

    const aiOpts = await candidatesFor(check.word, state.usedWords, state.allowDueum, state.handicap);
    if (aiOpts.length === 0) {
      state.status = 'finished';
      return { ok: true, state, finished: true, winner: 'me' };
    }
    const aiWord = await aiPickWord(check.word, state.usedWords, state.level, state.allowDueum, state.handicap);
    state.chain.push({ word: aiWord, who: 'ai' });
    state.usedWords.add(aiWord);
    state.aiScore += 1;

    const nextOpts = await candidatesFor(aiWord, state.usedWords, state.allowDueum, state.handicap);
    if (nextOpts.length === 0) {
      state.status = 'finished';
      return { ok: true, state, finished: true, winner: 'ai' };
    }
    return { ok: true, state, finished: false };
  } finally {
    state.busy = false;
  }
}

// ---------- 랭킹 (인메모리 — 서버 재시작하면 초기화됨. 영구 저장하려면 DB 필요) ----------
const leaderboard = []; // { name, level, myScore, aiScore, won, allowDueum, ts }
const LEADERBOARD_MAX_ENTRIES = 500;

function recordResult({ name, level, myScore, aiScore, won, allowDueum }) {
  leaderboard.push({
    name: (name || '플레이어').slice(0, 20),
    level,
    myScore,
    aiScore,
    won: !!won,
    allowDueum: !!allowDueum,
    ts: Date.now(),
  });
  if (leaderboard.length > LEADERBOARD_MAX_ENTRIES) leaderboard.shift();
}

// 랭킹 두 가지 기준
//  - 'fastest' : AI와 겨뤄서 이긴 기록 중, 난이도 높은 순 → 그 안에서 가장 적은 턴(빠른 승리) 순
//  - 'longest' : 승패 상관없이, 한 게임에서 이어간 단어 총 개수(내 턴+AI 턴)가 가장 많은 순
function getLeaderboard(mode, limit) {
  const n = limit || 20;
  if (mode === 'longest') {
    return leaderboard
      .slice()
      .sort((a, b) => (b.myScore + b.aiScore) - (a.myScore + a.aiScore) || b.ts - a.ts)
      .slice(0, n);
  }
  return leaderboard
    .filter((e) => e.won)
    .slice()
    .sort((a, b) => b.level - a.level || a.myScore - b.myScore || b.ts - a.ts)
    .slice(0, n);
}

module.exports = {
  rooms,
  publicRoom,
  currentPlayerId,
  createRoom,
  joinRoom,
  quickMatch,
  quickMatchRanked,
  applyRankedResult,
  getRatingInfo,
  leaveRoom,
  startGame,
  submitWord,
  handleTimeout,
  clearTurnTimer,
  createSingleGame,
  submitSingleWord,
  redeemFriendCode,
  applySingleTimeout,
  recordResult,
  getLeaderboard,
  singleGames,
  playerName,
  playerTeam,
  genId,
  aiThinkTimeMs,
  GAUGE_MAX,
};
