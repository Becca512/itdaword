// 끝말잇기 규칙 판정 + AI 로직.
// 국립국어원 표준국어대사전 "사전 내려받기"로 받은 전체 데이터(21만여 명사)를 로컬에 내장해서 쓴다.
// 실시간 API 호출이 없어서 네트워크 문제(Referer 체크, 파라미터 버그, 타임아웃 등)가 원천적으로 없다.
const { DICT_FINAL } = require('./dictionary');
const { CUSTOM_WORDS } = require('./customDictionary');
const { LOANWORDS } = require('./loanwords');

// ---------- 두음법칙 (한글 자모 분해 기반, 받침 있는 글자도 정확히 처리) ----------
// 정식 맞춤법(제10~12항)은 모음에 따라 ㄹ→ㄴ(아오우으 앞) / ㄹ→ㅇ(야여요유이 앞)을 구분하지만,
// 실제 끝말잇기 게임에서는 이렇게 세밀하게 안 따지고 "ㄹ/ㄴ으로 시작하면 ㅇ으로도 인정"하는
// 느슨한 방식을 관례적으로 써서(예: 론→온), 여기서도 모음 조건 없이 폭넓게 인정한다.
// 예: 력(ㄹ+ㅕ+ㄱ) → 역(ㅇ+ㅕ+ㄱ), 론(ㄹ+ㅗ+ㄴ) → 온(ㅇ+ㅗ+ㄴ) 또는 논(ㄴ+ㅗ+ㄴ)
const HANGUL_BASE = 0xac00;
const INITIALS = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const MEDIALS = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const IDX_ㅇ = INITIALS.indexOf('ㅇ');
const IDX_ㄴ = INITIALS.indexOf('ㄴ');

function decomposeHangul(ch) {
  const code = ch.charCodeAt(0) - HANGUL_BASE;
  if (code < 0 || code > 11171) return null;
  const final = code % 28;
  const medial = ((code - final) / 28) % 21;
  const initial = ((code - final) / 28 - medial) / 21;
  return { initial, medial, final };
}
function composeHangul(initial, medial, final) {
  return String.fromCharCode(HANGUL_BASE + (initial * 21 + medial) * 28 + final);
}

// 두음법칙 적용 시 인정되는 대체 표기들을 배열로 반환. 해당 없으면 빈 배열.
function alt두음(ch) {
  const d = decomposeHangul(ch);
  if (!d) return [];
  const initChar = INITIALS[d.initial];
  if (initChar === 'ㄹ') {
    return [composeHangul(IDX_ㅇ, d.medial, d.final), composeHangul(IDX_ㄴ, d.medial, d.final)];
  }
  if (initChar === 'ㄴ') {
    return [composeHangul(IDX_ㅇ, d.medial, d.final)];
  }
  return [];
}

// 전체 단어 = 표준국어대사전 21만여 개 + 커스텀 단어장
const ALL_WORDS = Array.from(new Set([...DICT_FINAL, ...CUSTOM_WORDS.filter((w) => /^[가-힣]{2,6}$/.test(w))]));
const WORD_SET = new Set(ALL_WORDS);

// 첫 글자별 단어 목록 (두음법칙과 무관하게 실제 표기 기준으로만 색인)
const GRAPH = {};
ALL_WORDS.forEach((w) => {
  const first = w[0];
  (GRAPH[first] = GRAPH[first] || []).push(w);
});

function lastChar(w) {
  return w[w.length - 1];
}
function firstChar(w) {
  return w[0];
}

// ---------- 핸디캡 ----------
// handicap = { threeOnly: boolean, noLoanwords: boolean } — 방장/플레이어가 시작 시 선택.
// threeOnly: 정확히 3글자 단어만 인정 (2~6글자 기본 규칙보다 훨씬 좁아져서 어려워진다)
// noLoanwords: 표준국어대사전에 "외래어"로 분류된 명사는 사용 불가
function passesHandicap(word, handicap) {
  if (!handicap) return true;
  if (handicap.threeOnly && word.length !== 3) return false;
  if (handicap.noLoanwords && LOANWORDS.has(word)) return false;
  return true;
}

// allowDueum: 이 게임(방/싱글게임)에서 두음법칙을 인정할지 여부. 방장/플레이어가 시작 시 선택한다.
async function isValidNext(prevWord, candidate, usedWords, allowDueum, handicap) {
  if (typeof candidate !== 'string') return { ok: false, reason: '단어를 입력해 주세요.' };
  const word = candidate.trim();
  const minLen = handicap && handicap.threeOnly ? 3 : 2;
  const maxLen = handicap && handicap.threeOnly ? 3 : 6;
  if (word.length < minLen || word.length > maxLen) {
    return handicap && handicap.threeOnly
      ? { ok: false, reason: '핸디캡: 정확히 세 글자 단어만 입력할 수 있어요.' }
      : { ok: false, reason: '두 글자 이상, 여섯 글자 이하로 입력해 주세요.' };
  }
  if (!/^[가-힣]+$/.test(word)) {
    return { ok: false, reason: '한글 단어만 입력할 수 있어요.' };
  }
  if (usedWords.has(word)) {
    return { ok: false, reason: '이미 사용된 단어예요.' };
  }
  if (!WORD_SET.has(word)) {
    return { ok: false, reason: '표준국어대사전에 없는 단어예요.' };
  }
  if (handicap && handicap.noLoanwords && LOANWORDS.has(word)) {
    return { ok: false, reason: '핸디캡: 외래어는 사용할 수 없어요.' };
  }
  if (prevWord) {
    const need = lastChar(prevWord);
    const cand0 = firstChar(word);
    if (cand0 !== need) {
      const altsOfNeed = allowDueum ? alt두음(need) : [];
      if (!altsOfNeed.includes(cand0)) {
        return { ok: false, reason: `'${need}'(으)로 시작하는 단어를 입력해 주세요.` };
      }
    }
  }
  return { ok: true, word };
}

async function candidatesFor(prevWord, usedWords, allowDueum, handicap) {
  const need = lastChar(prevWord);
  let list = GRAPH[need] || [];
  if (allowDueum) {
    for (const alt of alt두음(need)) {
      if (GRAPH[alt]) list = list.concat(GRAPH[alt]);
    }
  }
  return list.filter((w) => !usedWords.has(w) && passesHandicap(w, handicap));
}

const DIFF_DESC = {
  0: '완전 초보 — AI가 랜덤으로 아무 단어나 골라요. 자주 막혀요.',
  1: '입문 — 가끔 실수해요.',
  2: '쉬움 — 좁은 단어장만 사용해요.',
  3: '보통 하 — 막다른 길은 피하려고 해요.',
  4: '보통 — 무난하게 이어가요.',
  5: '보통 상 — 웬만해선 지지 않아요.',
  6: '약간 어려움 — 한 수 앞을 내다봐요.',
  7: '어려움 — 상대를 막다른 길로 유도해요.',
  8: '매우 어려움 — 두 수 앞을 계산해요.',
  9: '고수 — 희귀 음절을 적극적으로 노려요.',
  10: '살벌함 — 세 수 앞까지 계산하는 최적 대응.',
};

function aiThinkTimeMs(level) {
  const base = 1500 - level * 100;
  return Math.max(250, base) + Math.random() * 300;
}

async function graphOutDegree(word, usedWords, allowDueum, handicap) {
  const c = await candidatesFor(word, usedWords, allowDueum, handicap);
  return c.length;
}

async function aiPickWord(prevWord, usedWords, level, allowDueum, handicap) {
  const cands = await candidatesFor(prevWord, usedWords, allowDueum, handicap);
  if (cands.length === 0) return null;

  if (level <= 2) {
    return cands[Math.floor(Math.random() * cands.length)];
  }

  if (level <= 5) {
    const checks = await Promise.all(
      cands.map(async (w) => [w, await graphOutDegree(w, new Set([...usedWords, w]), allowDueum, handicap)])
    );
    const safe = checks.filter(([, deg]) => deg > 0).map(([w]) => w);
    const pool = safe.length ? safe : cands;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const depth = level <= 8 ? 1 : level === 9 ? 2 : 3;
  // 핸디캡을 걸면(특히 3글자만) 후보 수 자체가 확 줄어드니, 상위 N개 제한은 그대로 유지해도 충분하다.
  const MAX_BRANCH = 15;
  const shortlist = cands.length > MAX_BRANCH ? shuffle(cands).slice(0, MAX_BRANCH) : cands;

  async function scoreMove(word, used, d) {
    const nextUsed = new Set([...used, word]);
    const opts = await candidatesFor(word, nextUsed, allowDueum, handicap);
    if (opts.length === 0) return 100;
    if (d <= 0) return -opts.length;
    const branch = opts.length > MAX_BRANCH ? shuffle(opts).slice(0, MAX_BRANCH) : opts;
    const scores = await Promise.all(branch.map((opp) => scoreMove(opp, nextUsed, d - 1)));
    const worstForOpponent = Math.max(...scores.map((s) => -s));
    return worstForOpponent * 0.5 - opts.length * 0.3;
  }

  const scored = await Promise.all(shortlist.map(async (w) => [w, await scoreMove(w, usedWords, depth - 1)]));
  scored.sort((a, b) => b[1] - a[1]);
  return scored[0][0];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 첫 단어를 아직 아무도 안 낸 상태(이전 단어가 없음)에서 추천할 때 쓴다 — 핸디캡만 만족하면 무엇이든 OK.
async function suggestStartWords(handicap, count) {
  const pool = ALL_WORDS.filter((w) => passesHandicap(w, handicap));
  return shuffle(pool).slice(0, count || 3);
}

module.exports = {
  ALL_WORDS,
  isValidNext,
  candidatesFor,
  suggestStartWords,
  aiPickWord,
  aiThinkTimeMs,
  DIFF_DESC,
  alt두음,
};
