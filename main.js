// 简易“猜字游戏”Demo 实现（标题全部猜出即通关）
// 文章数据：标题 + 正文（先写死，后续可改为外部获取）
const ARTICLE = {
  title: "云栖山记",
  body:
    "晨雾初散，云栖山脉层峦叠嶂。溪水绕石，清声潺潺，山花在风里摇曳，似锦似霞。行人循着苔径前行，步步皆新景，偶有松鹤翩然，掠过林梢，影落山泉。\n\n及至山腰，有古亭隐现竹影之间，亭柱旧刻犹存，讲述往来游人的笑语。石桌残棋犹未终局，藤蔓垂落，缠绕其上，若与时光相对。坐而小憩，微风携着草木芬芳，自袖间穿行。\n\n再上数百级，峰顶平旷，可览云海涌动。远处村火点点，与夕阳相映，隐约闻钟声自谷底而来。行者俯视来路，皆成画卷，乃知世间喧嚣，在此不过轻烟。",
};

// 组合显示用全文（包含标题）
const FULL_TEXT = `《${ARTICLE.title}》\n\n${ARTICLE.body}`;

// 判定“标点或空白” —— 这些字符初始可见
const PUNCTUATION_SET = new Set(
  Array.from(
    "，。、；：？！…—·“”‘’（）《》〈〉【】[]{}<>—-·.,;:!?\"'()[]{}<>/\\@#$%^&*_+=|`~\n\t "
  )
);

const el = {
  titleView: document.getElementById("titleView"),
  bodyView: document.getElementById("bodyView"),
  charForm: document.getElementById("charGuessForm"),
  charInput: document.getElementById("charInput"),
  charStatus: document.getElementById("charStatus"),
  // multiplayer UI
  modeSelect: document.getElementById("modeSelect"),
  playerSelect: document.getElementById("playerSelect"),
  connectionStatus: document.getElementById("connectionStatus"),
  playersGuessesBlock: document.getElementById("playersGuessesBlock"),
  p1Guesses: document.getElementById("p1Guesses"),
  p2Guesses: document.getElementById("p2Guesses"),
  attemptsStatus: document.getElementById("attemptsStatus"),
  resetBtn: document.getElementById("resetBtn"),
};

const FULL_SPLIT_INDEX = `《${ARTICLE.title}》\n\n`.length;
const fullChars = Array.from(FULL_TEXT);

// 归一化字符：英文字母统一为小写，其余按原样
function canonicalChar(ch) {
  return /[A-Za-z]/.test(ch) ? ch.toLowerCase() : ch;
}

// 需要完全揭示才能通关的标题字符位置（排除标点/空白）
const titleCharIndexes = (() => {
  const idx = [];
  for (let i = 0; i < FULL_SPLIT_INDEX; i++) {
    const ch = fullChars[i];
    if (!PUNCTUATION_SET.has(ch)) idx.push(i);
  }
  return idx;
})();

// 状态
let revealedSet = new Set(); // 已命中揭示过的字符（含大小写变体）
let missedSet = new Set(); // 未命中的字符集合（离线用）
let guessedSet = new Set(); // 已猜过的字符（离线用，字母按小写归一）
let revealedMask = new Array(fullChars.length).fill(false); // 各位置是否已揭示
let gameWon = false;
let preWinRevealed = null; // 通关瞬间已揭示位置快照

// 多人相关（SSE）
let serverConnected = false;
let es = null;
let playerGuesses = { '1': [], '2': [] }; // {char, hit}[]
let currentMode = 'single';

// 初始化：标点/空白直接揭示
for (let i = 0; i < fullChars.length; i++) {
  const ch = fullChars[i];
  if (PUNCTUATION_SET.has(ch)) revealedMask[i] = true;
}

// 预计算文章中出现过的有效字符（用于“已猜过（命中/未命中）”提示）
const CHAR_PRESENCE = (() => {
  const s = new Set();
  for (const ch of fullChars) {
    if (!PUNCTUATION_SET.has(ch)) s.add(canonicalChar(ch));
  }
  return s;
})();
let attemptsCount = 0;
function renderAttempts() {
  if (el.attemptsStatus) el.attemptsStatus.textContent = `已猜测${attemptsCount}次`;
}

// 渲染函数
function render() {
  const titleFrag = document.createDocumentFragment();
  const bodyFrag = document.createDocumentFragment();

  let revealedCount = 0;

  for (let i = 0; i < fullChars.length; i++) {
    const ch = fullChars[i];
    const span = document.createElement("span");
    if (ch === "\n") {
      span.textContent = "\n";
    } else if (revealedMask[i]) {
      span.textContent = ch;
      span.className = "char";
      if (gameWon && preWinRevealed && preWinRevealed[i] && !PUNCTUATION_SET.has(ch)) {
        span.classList.add("pre-hit"); // 通关前命中的字符加粗
      }
      if (!PUNCTUATION_SET.has(ch)) revealedCount++;
    } else {
      span.textContent = " ";
      span.className = "char hidden-char"; // 小黑块
    }

    if (i < FULL_SPLIT_INDEX) titleFrag.appendChild(span);
    else bodyFrag.appendChild(span);
  }

  el.titleView.textContent = ""; // 清空
  el.titleView.appendChild(titleFrag);
  el.bodyView.textContent = "";
  el.bodyView.appendChild(bodyFrag);

  // 已揭示计数UI已移除，不再更新

  // 渲染玩家猜过列表
  function renderGuessList(container, arr) {
    container.textContent = "";
    arr.forEach((g) => {
      const s = document.createElement("span");
      s.className = `guess ${g.hit ? "hit" : "miss"}`;
      s.textContent = g.char;
      container.appendChild(s);
    });
  }
  renderGuessList(el.p1Guesses, playerGuesses['1'] || []);
  renderGuessList(el.p2Guesses, playerGuesses['2'] || []);
}

function handleCharGuess(input) {
  const chars = Array.from((input || "").trim());
  el.charStatus.className = "status";

  if (chars.length > 1) {
    el.charStatus.textContent = "一次只能输入一个字符";
    el.charStatus.classList.add("err");
    render();
    return "multi";
  }

  const c = chars[0];
  if (!c) {
    el.charStatus.textContent = "请输入一个字符";
    return "empty";
  }

  if (PUNCTUATION_SET.has(c)) {
    el.charStatus.textContent = "标点/空白无需猜测";
    return "punct";
  }

  // 如果连接了服务器，交由服务器处理
  if (serverConnected) {
    // 有效提交计数+1（有效单字符且非标点）
    attemptsCount += 1;
    renderAttempts();
    sendGuessToServer(c);
    return "sent";
  }

  // 已经猜过（大小写按同一字符处理）
  const key = canonicalChar(c);
  if (guessedSet.has(key)) {
    const exists = CHAR_PRESENCE.has(key);
    el.charStatus.textContent = exists ? "已经猜过了（命中）" : "已经猜过了（未命中）";
    attemptsCount += 1;
    renderAttempts();
    render();
    return "repeat";
  }
  guessedSet.add(key);

  // 命中/未命中判定
  const variants = new Set([c]);
  if (/[A-Za-z]/.test(c)) {
    variants.add(c.toLowerCase());
    variants.add(c.toUpperCase());
  }

  let exists = false;
  let newly = false;
  for (let i = 0; i < fullChars.length; i++) {
    if (variants.has(fullChars[i])) {
      exists = true;
      if (!revealedMask[i]) {
        revealedMask[i] = true;
        newly = true;
      }
    }
  }

  if (!exists) {
    if (!missedSet.has(c)) missedSet.add(c);
    el.charStatus.textContent = `未命中：${c}`;
    el.charStatus.classList.add("err");
    // 记录到玩家列表
    const pid = getPlayerId();
    (playerGuesses[pid] ||= []).push({ char: c, hit: false });
    attemptsCount += 1;
    renderAttempts();
    render();
    return "miss";
  }

  // 有该字符
  variants.forEach((v) => revealedSet.add(v));
  if (!newly) {
    el.charStatus.textContent = "已经猜过了（命中）";
    attemptsCount += 1;
    renderAttempts();
    render();
    return "repeat";
  }

  el.charStatus.textContent = `命中：${c}`;
  el.charStatus.classList.add("ok");
  missedSet.delete(c);
  if (/[A-Za-z]/.test(c)) {
    missedSet.delete(c.toLowerCase());
    missedSet.delete(c.toUpperCase());
  }
  // 记录到玩家列表（命中新揭示）
  (playerGuesses[getPlayerId()] ||= []).push({ char: c, hit: true });
  attemptsCount += 1;
  renderAttempts();

  // 标题是否已全部揭示
  if (!gameWon && titleCharIndexes.every((i) => revealedMask[i])) {
    preWinRevealed = revealedMask.slice();
    gameWon = true;
    for (let i = 0; i < revealedMask.length; i++) revealedMask[i] = true;
    el.charStatus.textContent = `恭喜，标题已全部猜出，全文已揭示。`;
    el.charStatus.classList.remove("err");
    el.charStatus.classList.add("ok");
  }
  render();
  return "hit";
}

// 服务器通信
function getPlayerId() {
  const saved = localStorage.getItem('playerId');
  const current = el.playerSelect?.value || saved || '1';
  if (current !== saved) localStorage.setItem('playerId', current);
  return current;
}

async function sendGuessToServer(ch) {
  try {
    const resp = await fetch('/guess', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ char: ch, playerId: getPlayerId() }),
    });
    const data = await resp.json();
    // 根据返回码显示状态，但不在本地立即改状态，等待 SSE 同步
    el.charStatus.className = 'status';
    let msg = data.message || '';
    // 兼容旧服务端：当 repeat 没带（命中/未命中）时，用 data.hit 补充
    if (data.code === 'repeat') {
      const hasDetail = /已经猜过了（(命中|未命中)）/.test(msg);
      if (!hasDetail) {
        msg = `已经猜过了（${data.hit ? '命中' : '未命中'}）`;
      }
    }
    el.charStatus.textContent = msg;
    if (data.code === 'miss') el.charStatus.classList.add('err');
    if (data.code === 'hit') el.charStatus.classList.add('ok');
    if (data.code === 'repeat' && data.hit) el.charStatus.classList.add('ok');
  } catch (e) {
    el.connectionStatus.textContent = '发送失败，请检查网络/服务端';
  }
}

function applyServerState(s) {
  // 从服务端状态覆盖本地
  revealedMask = s.revealedMask.map(Boolean);
  gameWon = !!s.gameWon;
  preWinRevealed = s.preWinRevealed || null;
  playerGuesses = s.players || { '1': [], '2': [] };
  render();
}

function connectSSE() {
  try {
    es = new EventSource('/events');
    es.onopen = () => {
      serverConnected = true;
      el.connectionStatus.textContent = '多人协作：已连接';
    };
    es.onmessage = (ev) => {
      try { applyServerState(JSON.parse(ev.data)); } catch {}
    };
    es.onerror = () => {
      serverConnected = false;
      el.connectionStatus.textContent = '多人协作：未连接（单机模式）';
    };
  } catch {
    serverConnected = false;
    el.connectionStatus.textContent = '多人协作：未连接（单机模式）';
  }
}

function disconnectSSE() {
  if (es && typeof es.close === 'function') {
    try { es.close(); } catch {}
  }
  es = null;
  serverConnected = false;
}

function setMode(mode) {
  currentMode = mode === 'multi' ? 'multi' : 'single';
  localStorage.setItem('gameMode', currentMode);
  if (currentMode === 'single') {
    // 关闭多人连接，隐藏多人UI，重置本地局
    disconnectSSE();
    if (el.playerSelect) el.playerSelect.style.display = 'none';
    if (el.playersGuessesBlock) el.playersGuessesBlock.style.display = 'none';
    if (el.connectionStatus) el.connectionStatus.style.display = 'none';
    resetGame();
  } else {
    // 打开多人连接，显示多人UI，并让服务端重置一局
    if (el.playerSelect) el.playerSelect.style.display = '';
    if (el.playersGuessesBlock) el.playersGuessesBlock.style.display = '';
    if (el.connectionStatus) el.connectionStatus.style.display = '';
    connectSSE();
    // 请求服务端重置，确保两端从同一状态开始
    fetch('/reset', { method: 'POST' }).catch(() => {});
    // 本地也清空尝试计数
    attemptsCount = 0;
    renderAttempts();
  }
}

function resetGame() {
  revealedSet.clear();
  missedSet.clear();
  guessedSet.clear();
  gameWon = false;
  preWinRevealed = null;
  for (let i = 0; i < revealedMask.length; i++) {
    revealedMask[i] = PUNCTUATION_SET.has(fullChars[i]);
  }
  el.charInput.value = "";
  el.charStatus.textContent = "";
  attemptsCount = 0;
  renderAttempts();
  render();
}

// 事件绑定
el.charForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (gameWon) return;
  const res = handleCharGuess(el.charInput.value);
  if (res !== "multi") {
    el.charInput.value = "";
  }
  el.charInput.focus();
});

el.resetBtn.addEventListener("click", async () => {
  if (serverConnected) {
    try { await fetch('/reset', { method: 'POST' }); } catch {}
    attemptsCount = 0;
    renderAttempts();
  } else {
    resetGame();
  }
});

// 初次渲染
// 初始化玩家选择
if (el.playerSelect) {
  const saved = localStorage.getItem('playerId');
  if (saved === '2') el.playerSelect.value = '2';
  el.playerSelect.addEventListener('change', () => getPlayerId());
}

// 初始化模式选择
if (el.modeSelect) {
  const savedMode = localStorage.getItem('gameMode') || 'single';
  el.modeSelect.value = savedMode;
  setMode(savedMode);
  el.modeSelect.addEventListener('change', () => setMode(el.modeSelect.value));
} else {
  // 没有模式选择控件时默认单人
  setMode('single');
}

render();

// 在输入框上拦截 Enter（移动端键盘“回车/下一步/发送”）直接提交
if (el.charInput) {
  el.charInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.keyCode === 13) {
      ev.preventDefault();
      if (gameWon) return;
      if (typeof el.charForm.requestSubmit === 'function') {
        el.charForm.requestSubmit();
      } else {
        // 兼容旧浏览器：手动触发提交事件
        const evt = new Event('submit', { bubbles: true, cancelable: true });
        el.charForm.dispatchEvent(evt);
      }
    }
  });
}
