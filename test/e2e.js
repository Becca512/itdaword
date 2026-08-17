const { io } = require('socket.io-client');
const URL = 'http://localhost:3001';

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function testSingle() {
  console.log('--- 싱글플레이 테스트 ---');
  const s = await connect();
  const start = await emitAck(s, 'single:start', { name: 'Becca', level: 8 });
  console.log('시작:', start);
  const r1 = await emitAck(s, 'single:submit', { gameId: start.gameId, word: '가방' });
  console.log('가방 ->', r1.ok, r1.state ? r1.state.chain : r1.reason);
  const bad = await emitAck(s, 'single:submit', { gameId: start.gameId, word: '가방' });
  console.log('중복단어 거부 확인:', bad.ok === false, bad.reason);
  s.disconnect();
}

async function testMulti() {
  console.log('--- 멀티플레이(초대코드) 테스트 ---');
  const host = await connect();
  const guest = await connect();

  const created = await emitAck(host, 'room:create', { name: 'Host', maxPlayers: 2, timeLimit: 5, teamMode: false });
  console.log('방 생성:', created.room.code);

  let lastGuestUpdate = null;
  guest.on('room:update', (r) => (lastGuestUpdate = r));
  let lastHostUpdate = null;
  host.on('room:update', (r) => (lastHostUpdate = r));

  const joined = await emitAck(guest, 'room:join', { code: created.room.code, name: 'Guest' });
  console.log('참가 성공:', joined.ok, '인원:', joined.room.players.length);

  await new Promise((r) => setTimeout(r, 200));

  const started = await emitAck(host, 'room:start', { code: created.room.code });
  console.log('게임 시작:', started.ok);

  await new Promise((r) => setTimeout(r, 200));
  const room1 = lastHostUpdate || lastGuestUpdate;
  console.log('턴 순서:', room1.turnOrder.map((id) => (id === host.id ? 'host' : 'guest')));

  const firstIsHost = room1.turnOrder[0] === host.id;
  const firstSocket = firstIsHost ? host : guest;
  const secondSocket = firstIsHost ? guest : host;

  const move1 = await emitAck(firstSocket, 'room:submit', { code: created.room.code, word: '가방' });
  console.log('1번째 플레이어 "가방" 제출:', move1.ok, move1.reason || '');

  await new Promise((r) => setTimeout(r, 200));

  const wrongMove = await emitAck(firstSocket, 'room:submit', { code: created.room.code, word: '방울' });
  console.log('내 차례 아닐 때 제출 거부 확인:', wrongMove.ok === false, wrongMove.reason);

  const move2 = await emitAck(secondSocket, 'room:submit', { code: created.room.code, word: '방울' });
  console.log('2번째 플레이어 "방울" 제출:', move2.ok, move2.reason || '');

  console.log('타임아웃(5초) 대기해서 서버측 자동 턴 넘김 확인...');
  await new Promise((r) => setTimeout(r, 5800));
  const finalRoom = lastHostUpdate;
  console.log('타임아웃 후 turnOrder 길이:', finalRoom.turnOrder.length, 'status:', finalRoom.status, 'winner:', finalRoom.winner);

  host.disconnect();
  guest.disconnect();
}

(async () => {
  await testSingle();
  await testMulti();
  process.exit(0);
})();
