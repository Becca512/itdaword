# 끝말잇기 서버 (wordchain-server)

Node.js + Socket.io 기반 실시간 매칭 서버. iOS/Android/PC 네이티브 앱이 붙을 백엔드입니다.

## 실행

```bash
npm install
npm start              # http://localhost:3001  (웹 클라이언트도 같은 주소에서 바로 열림)
```

`GET /health` 로 생존 확인 + 사전 크기 확인 가능.

## 사전: 국립국어원 표준국어대사전 로컬 전체 데이터 (21만 단어)

처음엔 실시간 오픈API로 연동했었는데, 운영 중 계속 문제가 생겼어요 (Referer/Origin 체크로 조용히 빈 응답, `num` 파라미터 버그, "바둑"·"하마" 같은 흔한 단어까지 실패하는 등). 원인을 하나씩 고쳐도 계속 새로운 문제가 나와서, **API 호출 자체를 없애고 사전 전체를 로컬에 내장하는 방식으로 전환**했습니다.

- `src/dictionary.js`: stdict.korean.go.kr의 "사전 내려받기" 기능으로 받은 전체 표제어 데이터(43만여 행)에서, 구성단위=단어(구·속담·관용구 제외) + 품사에 "명사" 포함 + 한글 2~6글자 조건으로 필터링한 **211,126개 단어**가 들어있습니다.
- 동음이의어 번호(`나무(01)`처럼 괄호로 붙는 표기)와 형태소 경계 표시(`-`, `^`)는 파싱 단계에서 제거했습니다.
- `src/customDictionary.js`: 사전에 없는 단어(신조어, 만든 단어 등)를 직접 추가할 수 있는 파일. `gameEngine.js`가 시작할 때 `dictionary.js` + `customDictionary.js`를 합쳐서 최종 사전을 만듭니다.

**장점**: 네트워크 호출이 없어서 응답이 즉시(수 ms) 오고, API 서버 상태에 전혀 영향받지 않습니다. AI가 15수를 미리 계산하는 데도 0.5초가 안 걸립니다.

**사전을 최신화하려면**: stdict.korean.go.kr에 로그인 → 사전 내려받기 → 전체 내려받기(엑셀) → 압축 풀어서 CSV로 변환(`soffice --headless --convert-to csv ...` 또는 엑셀에서 직접 저장) → 위와 같은 필터 규칙으로 재추출해서 `dictionary.js`를 교체하면 됩니다.

## 왜 이런 구조인가

- **서버가 유일한 신뢰 소스**: 사전 검증·끝말 규칙·AI 로직(`src/gameEngine.js`)을 전부 서버에서 실행합니다. 클라이언트(모바일/PC 앱)는 판정 결과만 받습니다 — 클라이언트 조작으로 부정행위 못 하게.
- **턴 타이머도 서버가 관리**: `setTimeout`으로 서버가 직접 시간 초과를 감지해서 탈락 처리합니다. 클라이언트가 종료돼도 게임 상태는 서버 기준으로 정확합니다.
- **인메모리 저장**: 현재는 `Map`으로 방 상태를 들고 있습니다. 서버 1대에서는 문제없지만, 인스턴스를 여러 대로 늘리려면(수평 확장) Redis 등 공유 저장소로 옮겨야 합니다 (아래 확장 참고).

## 싱글플레이 진행 시스템 (생명 게이지 / 레벨업 / 친구 초대)

- **15초 턴 타이머**: 서버가 각 턴마다 15초를 재고, 넘기면 게임을 끝내는 대신 **생명 게이지를 20%씩** 깎습니다(`roomManager.js`의 `GAUGE_TIMEOUT_PENALTY`). 게이지가 0%가 되면 그때 AI 승리로 종료됩니다. 5번 연속 시간 초과하면 게임오버라는 뜻이에요.
- **레벨업**: 이기면(AI가 이어갈 단어를 못 찾으면) 그 자리에서 종료하지 않고 "다음 레벨로 넘어갈까요?" 버튼이 떠요. 누르면 난이도를 1 올려서(최대 10) 바로 새 게임이 시작됩니다.
- **친구 초대**: 게임 시작 시 서버가 6자리 `shareCode`를 발급합니다(`roomManager.js`의 `referralCodes` 맵). "친구 초대" 버튼을 누르면 `?invite=코드`가 붙은 링크가 클립보드에 복사돼요. 다른 사람이 그 링크로 접속하면 소켓 연결 직후 자동으로 `friend:redeem` 이벤트가 발동되고, 원래 플레이어에게 **실시간으로 게이지 +1%**가 반영됩니다(`single:gaugeUpdate` 이벤트로 push). 같은 사람이 같은 코드로 여러 번 눌러도 한 번만 적립되도록 소켓 id 기준으로 막아뒀어요.
- 이 세 기능 모두 서버를 실제로 띄워서 소켓 연결로 끝까지 테스트했습니다 (타이머는 테스트할 때만 3초로 줄여서 확인 후 15초로 복구).

## 폴더 구조

```
src/
  dictionary.js      로컬 사전 (표준국어대사전 전체 데이터에서 추출한 명사 211,126개)
  customDictionary.js 커스텀 단어장 — 사전에 없는 단어를 직접 추가 가능
  gameEngine.js       판정 규칙 + 두음법칙 + AI(난이도 0~10) — 전부 로컬, API 호출 없음
  roomManager.js      방/매칭/턴/타이머 상태 관리
  server.js           Socket.io 이벤트 라우팅 + 웹 클라이언트 정적 서빙
public/
  index.html          웹 클라이언트 (같은 서버에서 바로 열림: http://localhost:3001)
test/
  e2e.js              싱글/멀티 시나리오 통합 테스트 (21만 단어 사전으로 통과 확인됨)
```

## Socket.io 이벤트

### 싱글플레이 (vs AI)
| 이벤트 | payload | 응답(ack) |
|---|---|---|
| `single:start` | `{name, level}` (0~10) | `{ok, gameId, level, levelDesc}` |
| `single:submit` | `{gameId, word}` | `{ok, state, finished, winner}` 또는 `{ok:false, reason}` |

### 멀티플레이
| 이벤트 | payload | 응답(ack) |
|---|---|---|
| `room:create` | `{name, maxPlayers(2~8), timeLimit(초), teamMode}` | `{ok, room}` |
| `room:join` | `{code, name}` | `{ok, room}` 또는 `{ok:false, reason}` |
| `room:quickmatch` | `{name}` | `{ok, room}` — 대기 중인 방 있으면 합류, 없으면 새로 만들고 큐 등록 |
| `room:start` | `{code}` | 방장만 가능. 2인 이상 필요 |
| `room:submit` | `{code, word}` | 내 차례일 때만 처리 |
| `room:leave` | `{code}` | — |

서버 → 클라이언트 브로드캐스트: 방에 변화가 있을 때마다 `room:update` 로 방 전체 상태 전송 (해당 `code` 룸에 join한 소켓 전원 수신).

`teamMode`가 켜져 있으면 참가 순서대로 인원이 적은 팀에 자동 배정됩니다(A/B 2팀). 턴 순서는 전체 인원 셔플이며, 시간 초과로 탈락한 플레이어는 회전에서 제외됩니다. 팀 전원이 탈락하면 상대 팀 승리 처리됩니다.

## 네이티브 앱에서 붙이는 법

React Native / Flutter / Electron 어디서든 `socket.io-client`로 붙이면 됩니다.

```js
import { io } from 'socket.io-client';
const socket = io('https://your-server.example.com');
socket.emit('room:create', { name: 'Becca', maxPlayers: 4, teamMode: true }, (res) => {
  console.log(res.room.code); // 초대코드
});
socket.on('room:update', (room) => { /* 화면 갱신 */ });
```

## 아직 안 된 것 (다음 단계)

- **배포**: 이 코드는 로컬에서 동작 검증만 됐습니다. 실제 앱이 붙으려면 공인 도메인이 있는 서버(Fly.io, Render, AWS 등)에 올리고 HTTPS/WSS로 열어야 합니다.
- **DB/Redis**: 현재 인메모리라 서버 재시작하면 방이 모두 사라짐. 서버를 여러 대로 늘리려면 Redis pub/sub 또는 Socket.io Redis adapter 필요.
- **인증**: 지금은 닉네임만 입력하면 누구나 방에 들어옵니다. 친구 초대를 계정 기반으로 하려면 로그인/친구목록이 필요.
- **사전 최신화**: 신조어나 최근 등재어를 반영하려면 stdict.korean.go.kr에서 사전을 다시 내려받아 `dictionary.js`를 갱신해야 합니다. 자동화된 파이프라인은 아직 없습니다.
- **욕설/비속어 필터**: 표준어로 등재된 단어 중에도 게임에 부적절한 단어(비속어, 역사적 차별어 등)가 있을 수 있어요. 별도 금칙어 목록이 없어서 걸러지지 않습니다.
- **재접속 처리**: 지금은 disconnect 즉시 방에서 제거됩니다. 모바일 네트워크 특성상 순간 끊김에 대비해 짧은 유예시간(grace period) 후 제거하는 로직이 필요합니다.
