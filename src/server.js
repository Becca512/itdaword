const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const rm = require('./roomManager');
const { DIFF_DESC, ALL_WORDS, candidatesFor, suggestStartWords } = require('./gameEngine');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 프로덕션에서는 실제 앱 도메인/스킴으로 제한할 것
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rm.rooms.size,
    uptime: process.uptime(),
    dictionarySize: ALL_WORDS.length,
  });
});

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', rm.publicRoom(room));
}

function scheduleTurnTimer(room) {
  rm.clearTurnTimer(room);
  if (room.status !== 'playing') return;
  room.turnTimer = setTimeout(() => {
    rm.handleTimeout(room);
    broadcastRoom(room);
    if (room.status === 'playing') scheduleTurnTimer(room);
  }, room.timeLimit * 1000);
}

// ---------- 싱글플레이 턴 타이머 (15초 — 넘기면 생명 게이지가 깎인다) ----------
const SINGLE_TURN_LIMIT_MS = 15000;
const singleTimers = new Map(); // gameId -> timeout handle

function scheduleSingleTimer(state) {
  clearSingleTimer(state.gameId);
  if (state.status !== 'playing') return;
  const handle = setTimeout(async () => {
    const result = rm.applySingleTimeout(state);
    let suggestions = [];
    if (result.finished) {
      // 시간 초과로 졌을 때, 그 순간 실제로 쓸 수 있었던 단어를 몇 개 뽑아서 알려준다.
      // (이 게임 로직상, 후보가 아예 0개였다면 애초에 타임아웃 전에 즉시 종료됐을 것이므로
      //  여기 도달했다는 건 최소 1개 이상의 유효한 단어가 실제로 존재했다는 뜻이다.)
      const lastWord = state.chain.length ? state.chain[state.chain.length - 1].word : null;
      if (lastWord) {
        const cands = await candidatesFor(lastWord, state.usedWords, state.allowDueum, state.handicap);
        suggestions = cands
          .slice()
          .sort((a, b) => a.length - b.length)
          .slice(0, 3);
      } else {
        // 아직 첫 단어도 안 낸 상태에서 시간 초과 — 아무 단어나(핸디캡만 만족하면) 추천
        suggestions = await suggestStartWords(state.handicap, 3);
      }
    }
    io.to(state.socketId).emit('single:timeout', {
      gauge: state.gauge,
      finished: result.finished,
      winner: result.winner || null,
      suggestions,
    });
    if (result.finished) {
      rm.recordResult({
        name: state.name,
        level: state.level,
        myScore: state.myScore,
        aiScore: state.aiScore,
        won: result.winner === 'me',
        allowDueum: state.allowDueum,
      });
    }
    if (!result.finished) scheduleSingleTimer(state);
    else clearSingleTimer(state.gameId);
  }, SINGLE_TURN_LIMIT_MS);
  singleTimers.set(state.gameId, handle);
}
function clearSingleTimer(gameId) {
  const h = singleTimers.get(gameId);
  if (h) {
    clearTimeout(h);
    singleTimers.delete(gameId);
  }
}

// 클라이언트가 보낸 handicap 값을 신뢰하지 않고, 정확히 boolean 두 개만 남긴다.
function sanitizeHandicap(h) {
  return {
    threeOnly: !!(h && h.threeOnly),
    noLoanwords: !!(h && h.noLoanwords),
  };
}

io.on('connection', (socket) => {
  // ---------- 싱글플레이 (vs AI) ----------
  socket.on('single:start', ({ name, level, allowDueum, handicap }, ack) => {
    const state = rm.createSingleGame({ socketId: socket.id, name: name || '플레이어', level: Number(level) || 0, allowDueum: !!allowDueum, handicap: sanitizeHandicap(handicap) });
    ack &&
      ack({
        ok: true,
        gameId: state.gameId,
        level: state.level,
        levelDesc: DIFF_DESC[state.level],
        allowDueum: state.allowDueum,
        handicap: state.handicap,
        gauge: state.gauge,
        gaugeMax: rm.GAUGE_MAX,
        shareCode: state.shareCode,
      });
    scheduleSingleTimer(state);
  });

  socket.on('single:submit', async ({ gameId, word }, ack) => {
    const result = await rm.submitSingleWord({ gameId, word });
    if (result.ok) {
      if (result.finished) {
        clearSingleTimer(gameId);
        rm.recordResult({
          name: result.state.name,
          level: result.state.level,
          myScore: result.state.myScore,
          aiScore: result.state.aiScore,
          won: result.winner === 'me',
          allowDueum: result.state.allowDueum,
        });
      } else {
        scheduleSingleTimer(result.state);
      }
    }
    ack && ack(result);
  });

  // 랭킹 조회 (이긴 기록 중 난이도 높은 순 → 점수 높은 순)
  socket.on('leaderboard:get', (payload, ack) => {
    const mode = payload && payload.mode === 'longest' ? 'longest' : 'fastest';
    ack && ack({ ok: true, mode, entries: rm.getLeaderboard(mode, 20) });
  });

  // 친구가 초대 링크(?invite=코드)로 접속해서 자동으로 호출하는 이벤트.
  socket.on('friend:redeem', ({ code }, ack) => {
    const result = rm.redeemFriendCode({ code, redeemerSocketId: socket.id });
    ack && ack(result.ok ? { ok: true, newGauge: result.newGauge } : { ok: false, reason: result.reason });
    if (result.ok) {
      io.to(result.ownerSocketId).emit('single:gaugeUpdate', { gauge: result.newGauge });
    }
  });

  // ---------- 방 만들기 / 참가 / 랜덤매칭 ----------
  socket.on('room:create', ({ name, maxPlayers, timeLimit, teamMode, allowDueum, handicap }, ack) => {
    const room = rm.createRoom({ hostSocketId: socket.id, name: name || '방장', maxPlayers, timeLimit, teamMode, allowDueum, handicap: sanitizeHandicap(handicap) });
    socket.join(room.code);
    ack && ack({ ok: true, room: rm.publicRoom(room) });
  });

  socket.on('room:join', ({ code, name }, ack) => {
    const result = rm.joinRoom({ code: (code || '').toUpperCase(), socketId: socket.id, name: name || '플레이어' });
    if (result.error) {
      ack && ack({ ok: false, reason: result.error });
      return;
    }
    socket.join(result.room.code);
    ack && ack({ ok: true, room: rm.publicRoom(result.room) });
    broadcastRoom(result.room);
  });

  socket.on('room:quickmatch', ({ name }, ack) => {
    const { room } = rm.quickMatch({ socketId: socket.id, name: name || `Guest${Math.floor(Math.random() * 1000)}` });
    socket.join(room.code);
    ack && ack({ ok: true, room: rm.publicRoom(room) });
    broadcastRoom(room);
  });

  socket.on('room:start', ({ code }, ack) => {
    const room = rm.rooms.get(code);
    if (!room) return ack && ack({ ok: false, reason: '방을 찾을 수 없어요.' });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, reason: '방장만 시작할 수 있어요.' });
    if (room.players.length < 2) return ack && ack({ ok: false, reason: '2명 이상 모여야 시작할 수 있어요.' });
    rm.startGame(room);
    ack && ack({ ok: true });
    broadcastRoom(room);
    scheduleTurnTimer(room);
  });

  socket.on('room:submit', async ({ code, word }, ack) => {
    const result = await rm.submitWord({ code, socketId: socket.id, word });
    if (!result.ok) {
      ack && ack({ ok: false, reason: result.reason });
      return;
    }
    ack && ack({ ok: true });
    broadcastRoom(result.room);
    if (result.finished) rm.clearTurnTimer(result.room);
    else scheduleTurnTimer(result.room);
  });

  socket.on('room:leave', ({ code }) => {
    const room = rm.leaveRoom({ code, socketId: socket.id });
    socket.leave(code);
    if (room) broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rm.rooms) {
      if (room.players.some((p) => p.id === socket.id)) {
        const updated = rm.leaveRoom({ code, socketId: socket.id });
        if (updated) broadcastRoom(updated);
      }
    }
    for (const [gameId, state] of rm.singleGames) {
      if (state.socketId === socket.id) clearSingleTimer(gameId);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`끝말잇기 서버 실행 중: http://localhost:${PORT}`);
});

module.exports = { app, server, io };
