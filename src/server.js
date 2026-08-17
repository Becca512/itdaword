require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const rm = require('./roomManager');
const { DIFF_DESC, ALL_WORDS } = require('./gameEngine');

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
  const handle = setTimeout(() => {
    const result = rm.applySingleTimeout(state);
    io.to(state.socketId).emit('single:timeout', {
      gauge: state.gauge,
      finished: result.finished,
      winner: result.winner || null,
    });
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

io.on('connection', (socket) => {
  // ---------- 싱글플레이 (vs AI) ----------
  socket.on('single:start', ({ name, level, allowDueum }, ack) => {
    const state = rm.createSingleGame({ socketId: socket.id, name: name || '플레이어', level: Number(level) || 0, allowDueum: !!allowDueum });
    ack &&
      ack({
        ok: true,
        gameId: state.gameId,
        level: state.level,
        levelDesc: DIFF_DESC[state.level],
        allowDueum: state.allowDueum,
        gauge: state.gauge,
        gaugeMax: rm.GAUGE_MAX,
        shareCode: state.shareCode,
      });
    scheduleSingleTimer(state);
  });

  socket.on('single:submit', async ({ gameId, word }, ack) => {
    const result = await rm.submitSingleWord({ gameId, word });
    if (result.ok) {
      if (result.finished) clearSingleTimer(gameId);
      else scheduleSingleTimer(result.state);
    }
    ack && ack(result);
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
  socket.on('room:create', ({ name, maxPlayers, timeLimit, teamMode, allowDueum }, ack) => {
    const room = rm.createRoom({ hostSocketId: socket.id, name: name || '방장', maxPlayers, timeLimit, teamMode, allowDueum });
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
