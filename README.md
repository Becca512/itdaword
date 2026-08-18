# 끝말잇기 — ITDAWORD

Node.js + Socket.io 기반 실시간 한국어 끝말잇기 게임. 표준국어대사전 21만여 단어를 로컬에 내장해서, API 호출 없이 즉시 판정합니다.

**실제 서비스**: https://itdaword.onrender.com

## 실행 (로컬)

```bash
npm install
npm start              # http://localhost:3001  (웹 클라이언트도 같은 주소에서 바로 열림)
```

`GET /health` 로 생존 확인 + 사전 크기 확인 가능.

## 배포 (Render, 무료 티어)

깃허브 저장소에 push하면 Render가 자동으로 감지해서 재배포합니다.

1. https://render.com 가입 (GitHub 계정으로 로그인하면 편함)
2. "New +" → "Web Service" → 이 저장소 연결
3. 설정: Build Command `npm install`, Start Command `npm start`, Instance Type **Free**
4. 배포되면 `https://프로젝트이름.onrender.com` 주소가 자동 생성됨
5. 이후 코드 수정할 때마다:
   ```bash
   git add .
   git commit -m "변경 내용"
   git push
   ```
   push만 하면 Render가 자동으로 다시 빌드·배포합니다. Render 사이트에 따로 들어가서 버튼을 누를 필요가 없습니다.

**무료 티어 제약**: 15분 정도 아무도 접속하지 않으면 서버가 잠들고(spin down), 다음 접속 시 깨어나는 데 30초~1분 정도 걸립니다. 고장이 아니라 정상 동작입니다.

**환경변수**: 현재는 API 키 등 별도 환경변수가 필요 없습니다 (사전이 전부 로컬 파일이라서). `dotenv`, `.env` 관련 코드는 전부 제거된 상태입니다.

## 사전: 국립국어원 표준국어대사전 로컬 전체 데이터 (21만 단어)

처음엔 실시간 오픈API로 연동했었는데, 운영 중 계속 문제가 생겼습니다 (Referer/Origin 체크로 조용히 빈 응답, `num` 파라미터 버그, "바둑"·"하마" 같은 흔한 단어까지 실패하는 등). 원인을 하나씩 고쳐도 계속 새로운 문제가 나와서, **API 호출 자체를 없애고 사전 전체를 로컬에 내장하는 방식으로 전환**했습니다.

- `src/dictionary.js`: stdict.korean.go.kr의 "사전 내려받기" 기능으로 받은 전체 표제어 데이터(43만여 행)에서, 구성단위=단어(구·속담·관용구 제외) + 품사에 "명사" 포함 + 한글 2~10글자 조건으로 필터링한 **213,363개 단어**가 들어있습니다.
- 동음이의어 번호(`나무(01)`처럼 괄호로 붙는 표기)와 형태소 경계 표시(`-`, `^`)는 파싱 단계에서 제거했습니다.
- `src/customDictionary.js`: 사전에 없는 단어(신조어, 만든 단어 등)를 직접 추가할 수 있는 파일. `gameEngine.js`가 시작할 때 `dictionary.js` + `customDictionary.js`를 합쳐서 최종 사전을 만듭니다.
- `src/loanwords.js`: 표준국어대사전에서 "고유어 여부 = 외래어"로 표시된 명사 17,803개 목록. 핸디캡 모드의 "외래어 금지" 옵션에서 사용합니다.

**사전을 최신화하려면**: stdict.korean.go.kr에 로그인 → 사전 내려받기 → 전체 내려받기(엑셀) → 압축 풀어서 CSV로 변환(`soffice --headless --convert-to csv ...` 또는 엑셀에서 직접 저장) → 위와 같은 필터 규칙으로 재추출해서 `dictionary.js`를 교체하면 됩니다.

## 게임 규칙

- 표준국어대사전에 실제로 등재된 명사만 인정 (최신 줄임말·신조어는 자동으로 막힘)
- 두 글자 이상 열 글자 이하 (핸디캡으로 3글자만 강제 가능)
- 이미 사용한 단어는 재사용 불가
- **두음법칙**: 방/싱글게임 시작 시 켜고 끌 수 있는 선택사항. 한글 자모를 직접 분해해서(초성/중성/종성) 계산하는 방식으로, 받침 있는 글자(력→역, 론→온 등)도 정확히 처리합니다. 정식 맞춤법(모음 조건별 ㄴ/ㅇ 구분)보다 느슨하게, 게임에서 흔히 쓰는 "ㄹ/ㄴ 초성이면 ㅇ으로도 인정" 방식을 씁니다.
- **핸디캡** (선택): 3글자 단어만 인정 / 외래어 금지 — 둘 다 AI도 동일하게 적용받습니다.

## 싱글플레이 진행 시스템

- **15초 턴 타이머**: 서버가 매 턴 15초를 재고, 넘기면 즉시 게임오버(생명 게이지가 100→0으로 한 번에 떨어짐). `roomManager.js`의 `GAUGE_TIMEOUT_PENALTY` 값을 낮추면 여러 번 봐주는 방식으로 바꿀 수 있습니다.
- **레벨업**: 이기면(AI가 이어갈 단어를 못 찾으면) "다음 레벨로 넘어갈까요?" 버튼이 뜹니다. 누르면 난이도 +1(최대 10)로 새 게임이 바로 시작됩니다.
- **패배 시 추천 단어**: 시간 초과로 지면, 그 순간 실제로 쓸 수 있었던 단어 3개를 서버가 계산해서 보여줍니다("😅 아쉽군요, 이런 단어들이 있었어요"). 첫 단어도 못 낸 채로 타임아웃된 경우엔 사전에서 무작위로 3개를 추천합니다.
- **친구 초대**: 게임 시작 시 서버가 6자리 `shareCode`를 발급합니다. "친구 초대" 버튼을 누르면 `?invite=코드`가 붙은 링크가 클립보드에 복사됩니다. 다른 사람이 그 링크로 접속하면 자동으로 `friend:redeem` 이벤트가 발동되고, 원래 플레이어에게 실시간으로 게이지 +1%가 반영됩니다(`single:gaugeUpdate` 이벤트). 같은 사람이 여러 번 눌러도 한 번만 적립되도록 소켓 id 기준으로 막아뒀습니다.
- **점수 공유**: 게임이 끝나면 "친구에게 내 점수 공유하기" 버튼으로 난이도·점수가 담긴 메시지와 링크를 공유할 수 있습니다.

## 랭킹

두 가지 기준으로 나눠서 집계합니다 (서버 인메모리 저장 — 재시작하면 초기화, 영구 저장하려면 DB 필요).

- **⚡ 최단 레벨업**: AI를 이긴 기록 중, 난이도 높은 순 → 그 안에서 적은 턴수(빠른 승리) 순
- **🔗 최대 단어 단계**: 승패 상관없이, 한 게임에서 이어간 단어 총 개수(내 턴+AI 턴)가 많은 순

## 단어 클릭 → 국어사전 연결

체인에 쌓인 단어를 클릭하면 새 탭으로 네이버 국어사전 검색 결과가 열립니다 (`ko.dict.naver.com`). AI가 낸 낯선 단어를 바로 확인할 수 있습니다.

## 디자인

다크 배경 위에 알록달록한 필(pill) 모양 버튼 — 참고 이미지(컬러풀 칩 스타일) 톤에 맞춰 만들었습니다. 폰트는 Noto Sans KR 하나로 통일(400~900 웨이트). 단어 체인 자체를 색이 순환되는 필 모양으로 표현해서, 끝말잇기의 "이어짐"을 시각적으로 강조했습니다. 로고는 "전복 끝말잇기 / ITDAWORD" 두 줄 구성이며 클릭하면 홈 화면으로 이동합니다.

## 왜 이런 구조인가

- **서버가 유일한 신뢰 소스**: 사전 검증·끝말 규칙·AI 로직(`src/gameEngine.js`)을 전부 서버에서 실행합니다. 클라이언트(모바일/PC 앱)는 판정 결과만 받습니다 — 클라이언트 조작으로 부정행위 못 하게.
- **턴 타이머도 서버가 관리**: `setTimeout`으로 서버가 직접 시간 초과를 감지해서 처리합니다. 클라이언트가 종료돼도 게임 상태는 서버 기준으로 정확합니다.
- **인메모리 저장**: 현재는 `Map`/배열로 방·랭킹 상태를 들고 있습니다. 서버 1대에서는 문제없지만, 인스턴스를 여러 대로 늘리거나(수평 확장) 데이터를 영구 보존하려면 Redis/DB로 옮겨야 합니다.

## 폴더 구조

```
src/
  dictionary.js        로컬 사전 (표준국어대사전 전체 데이터에서 추출한 명사 213,363개)
  customDictionary.js  커스텀 단어장 — 사전에 없는 단어를 직접 추가 가능
  loanwords.js          외래어 명사 목록 (핸디캡 "외래어 금지"용)
  gameEngine.js         판정 규칙 + 두음법칙 + 핸디캡 + AI(난이도 0~10) — 전부 로컬, API 호출 없음
  roomManager.js        방/매칭/턴/타이머/게이지/랭킹 상태 관리
  server.js             Socket.io 이벤트 라우팅 + 웹 클라이언트 정적 서빙
public/
  index.html            웹 클라이언트 (같은 서버에서 바로 열림)
test/
  e2e.js                싱글/멀티 시나리오 통합 테스트
```

## Socket.io 이벤트

### 싱글플레이 (vs AI)
| 이벤트 | payload | 응답(ack) |
|---|---|---|
| `single:start` | `{name, level, allowDueum, handicap}` | `{ok, gameId, level, levelDesc, allowDueum, handicap, gauge, gaugeMax, shareCode}` |
| `single:submit` | `{gameId, word}` | `{ok, state, finished, winner}` 또는 `{ok:false, reason}` |
| `leaderboard:get` | `{mode: 'fastest'|'longest'}` | `{ok, mode, entries}` |
| `friend:redeem` | `{code}` | `{ok, newGauge}` 또는 `{ok:false, reason}` |

서버 → 클라이언트 푸시: `single:timeout` (턴 초과 시, `{gauge, finished, winner, suggestions}`), `single:gaugeUpdate` (친구 적립 시, `{gauge}`).

### 멀티플레이
| 이벤트 | payload | 응답(ack) |
|---|---|---|
| `room:create` | `{name, maxPlayers(2~8), timeLimit(초), teamMode, allowDueum, handicap}` | `{ok, room}` |
| `room:join` | `{code, name}` | `{ok, room}` 또는 `{ok:false, reason}` |
| `room:quickmatch` | `{name}` | `{ok, room}` |
| `room:start` | `{code}` | 방장만 가능, 2인 이상 필요 |
| `room:submit` | `{code, word}` | 내 차례일 때만 처리 |
| `room:leave` | `{code}` | — |

`room:update`가 방에 변화가 있을 때마다 브로드캐스트됩니다. `teamMode`가 켜져 있으면 인원이 적은 팀에 자동 배정(A/B), 시간 초과로 탈락한 플레이어는 회전에서 제외됩니다.

## 네이티브 앱에서 붙이는 법

React Native / Flutter / Electron 어디서든 `socket.io-client`로 붙이면 됩니다.

```js
import { io } from 'socket.io-client';
const socket = io('https://itdaword.onrender.com');
socket.emit('room:create', { name: 'Becca', maxPlayers: 4, teamMode: true }, (res) => {
  console.log(res.room.code); // 초대코드
});
socket.on('room:update', (room) => { /* 화면 갱신 */ });
```

## 아직 안 된 것 (다음 단계)

- **DB/영구 저장**: 현재 인메모리라 서버 재시작(Render 무료 티어는 비활성 시 재시작됨) 시 방·랭킹이 모두 사라집니다. Postgres 등 DB 연동 필요.
- **인증**: 지금은 닉네임만 입력하면 누구나 방에 들어옵니다. 계정 기반 친구 시스템은 없습니다.
- **사전 최신화 자동화**: 신조어 반영은 수동으로 사전을 다시 내려받아 교체해야 합니다.
- **욕설/비속어 필터**: 표준어로 등재된 단어 중에도 부적절한 단어가 있을 수 있는데, 별도 금칙어 목록이 없습니다.
- **재접속 처리**: disconnect 즉시 방에서 제거됩니다. 순간 끊김에 대비한 유예시간(grace period) 로직이 없습니다.
- **커스텀 도메인**: 지금은 Render가 준 `onrender.com` 주소를 그대로 씁니다. 도메인을 구매하면 Render 대시보드에서 연결 가능합니다 (선택사항, 필수 아님).
