// 猜字游戏前端（支持单人/双人）。文章从服务端获取，服务端可由质谱大模型生成。

const PUNCTUATION_SET = new Set(Array.from('，。、；：？！…—·“”‘’（）《》〈〉【】[]{}<>—-·.,;:!?\"\'()[]{}<>/\\@#$%^&*_+=|`~\n\t '));

const el = {
  titleView: document.getElementById('titleView'),
  bodyView: document.getElementById('bodyView'),
  charForm: document.getElementById('charGuessForm'),
  charInput: document.getElementById('charInput'),
  charStatus: document.getElementById('charStatus'),
  modeSelect: document.getElementById('modeSelect'),
  playerSelect: document.getElementById('playerSelect'),
  connectionStatus: document.getElementById('connectionStatus'),
  playersGuessesBlock: document.getElementById('playersGuessesBlock'),
  p1Guesses: document.getElementById('p1Guesses'),
  p2Guesses: document.getElementById('p2Guesses'),
  attemptsStatus: document.getElementById('attemptsStatus'),
  resetBtn: document.getElementById('resetBtn'),
  regenBtn: document.getElementById('regenBtn'),
  revealAllBtn: document.getElementById('revealAllBtn'),
};

let ARTICLE = { title: '加载中', body: '' };
let FULL_SPLIT_INDEX = 0;
let fullChars = [];
let titleCharIndexes = [];
let revealedSet = new Set();
let missedSet = new Set();
let guessedSet = new Set();
let revealedMask = [];
let gameWon = false;
let preWinRevealed = null;
let serverConnected = false;
let es = null;
let playerGuesses = { '1': [], '2': [] };
let currentMode = 'single';
let attemptsCount = 0;
let serverArticleSeq = 0;

function setStatusLoading(flag) {
  if (!el.charStatus) return;
  if (flag) {
    el.charStatus.className = 'status';
    el.charStatus.textContent = '加载中…';
  } else {
    if (el.charStatus.textContent === '加载中…') {
      el.charStatus.className = 'status';
      el.charStatus.textContent = '';
    }
  }
}

function canonicalChar(ch) { return /[A-Za-z]/.test(ch) ? ch.toLowerCase() : ch; }

function rebuildFromArticle() {
  const full = `《${ARTICLE.title}》\n\n${ARTICLE.body}`;
  FULL_SPLIT_INDEX = `《${ARTICLE.title}》\n\n`.length;
  fullChars = Array.from(full);
  titleCharIndexes = [];
  for (let i = 0; i < FULL_SPLIT_INDEX; i++) if (!PUNCTUATION_SET.has(fullChars[i])) titleCharIndexes.push(i);
  revealedMask = new Array(fullChars.length).fill(false);
  for (let i = 0; i < fullChars.length; i++) if (PUNCTUATION_SET.has(fullChars[i])) revealedMask[i] = true;
  revealedSet.clear(); missedSet.clear(); guessedSet.clear();
  preWinRevealed = null; gameWon = false;
}

function renderAttempts() { if (el.attemptsStatus) el.attemptsStatus.textContent = `已猜测${attemptsCount}次`; }

function render() {
  const titleFrag = document.createDocumentFragment();
  const bodyFrag = document.createDocumentFragment();
  for (let i = 0; i < fullChars.length; i++) {
    const ch = fullChars[i];
    const span = document.createElement('span');
    if (ch === '\n') {
      span.textContent = '\n';
    } else if (revealedMask[i]) {
      span.textContent = ch;
      span.className = 'char';
      if (gameWon && preWinRevealed && preWinRevealed[i] && !PUNCTUATION_SET.has(ch)) span.classList.add('pre-hit');
    } else {
      span.textContent = ' ';
      span.className = 'char hidden-char';
    }
    if (i < FULL_SPLIT_INDEX) titleFrag.appendChild(span); else bodyFrag.appendChild(span);
  }
  el.titleView.textContent = '';
  el.titleView.appendChild(titleFrag);
  el.bodyView.textContent = '';
  el.bodyView.appendChild(bodyFrag);

  const renderGuessList = (container, arr) => {
    if (!container) return;
    container.textContent = '';
    arr.forEach((g) => {
      const s = document.createElement('span');
      s.className = `guess ${g.hit ? 'hit' : 'miss'}`;
      s.textContent = g.char;
      container.appendChild(s);
    });
  };
  renderGuessList(el.p1Guesses, playerGuesses['1'] || []);
  renderGuessList(el.p2Guesses, playerGuesses['2'] || []);
}

function handleCharGuess(input) {
  const chars = Array.from((input || '').trim());
  el.charStatus.className = 'status';
  if (chars.length > 1) { el.charStatus.textContent = '一次只能输入一个字符'; el.charStatus.classList.add('err'); render(); return 'multi'; }
  const c = chars[0];
  if (!c) { el.charStatus.textContent = '请输入一个字符'; return 'empty'; }
  if (PUNCTUATION_SET.has(c)) { el.charStatus.textContent = '标点/空白无需猜测'; return 'punct'; }

  if (serverConnected && currentMode === 'multi') { attemptsCount++; renderAttempts(); sendGuessToServer(c); return 'sent'; }

  const key = canonicalChar(c);
  if (guessedSet.has(key)) {
    const exists = fullChars.some((cc) => !PUNCTUATION_SET.has(cc) && canonicalChar(cc) === key);
    el.charStatus.textContent = exists ? '已经猜过了（命中）' : '已经猜过了（未命中）';
    attemptsCount++; renderAttempts(); render(); return 'repeat';
  }
  guessedSet.add(key);

  let exists = false, newly = false;
  const variants = new Set([c, c.toLowerCase?.() || c, c.toUpperCase?.() || c]);
  for (let i = 0; i < fullChars.length; i++) {
    if (variants.has(fullChars[i])) { exists = true; if (!revealedMask[i]) { revealedMask[i] = true; newly = true; } }
  }
  if (!exists) { el.charStatus.textContent = `未命中：${c}`; el.charStatus.classList.add('err'); attemptsCount++; renderAttempts(); render(); return 'miss'; }
  if (!newly) { el.charStatus.textContent = '已经猜过了（命中）'; attemptsCount++; renderAttempts(); render(); return 'repeat'; }

  el.charStatus.textContent = `命中：${c}`; el.charStatus.classList.add('ok'); attemptsCount++; renderAttempts();

  if (!gameWon && titleCharIndexes.every((i) => revealedMask[i])) { preWinRevealed = revealedMask.slice(); gameWon = true; for (let i = 0; i < revealedMask.length; i++) revealedMask[i] = true; el.charStatus.textContent = '恭喜，标题已全部猜出，全文已揭示。'; el.charStatus.classList.add('ok'); }
  render(); return 'hit';
}

function resetGame() {
  rebuildFromArticle();
  el.charInput.value = '';
  el.charStatus.textContent = '';
  attemptsCount = 0; renderAttempts(); render();
}

// 多人通讯
function getPlayerId() { const saved = localStorage.getItem('playerId'); const current = el.playerSelect?.value || saved || '1'; if (current !== saved) localStorage.setItem('playerId', current); return current; }
async function sendGuessToServer(ch) {
  try { const resp = await fetch('/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char: ch, playerId: getPlayerId() }) }); const data = await resp.json(); el.charStatus.className = 'status'; let msg = data.message || ''; if (data.code === 'repeat' && !/已经猜过了（(命中|未命中)）/.test(msg)) msg = `已经猜过了（${data.hit ? '命中' : '未命中'}）`; el.charStatus.textContent = msg; if (data.code === 'miss') el.charStatus.classList.add('err'); if (data.code === 'hit' || (data.code === 'repeat' && data.hit)) el.charStatus.classList.add('ok'); } catch { el.connectionStatus.textContent = '发送失败，请检查网络/服务端'; }
}
function applyServerState(s) { revealedMask = s.revealedMask.map(Boolean); gameWon = !!s.gameWon; preWinRevealed = s.preWinRevealed || null; playerGuesses = s.players || { '1': [], '2': [] }; render(); }
function shouldRefreshArticle(s) { return typeof s.articleSeq === 'number' && s.articleSeq !== serverArticleSeq; }
function connectSSE() { try { es = new EventSource('/events'); es.onopen = () => { serverConnected = true; el.connectionStatus.textContent = '多人协作：已连接'; }; es.onmessage = async (ev) => { try { const s = JSON.parse(ev.data); if (shouldRefreshArticle(s)) { serverArticleSeq = s.articleSeq; setStatusLoading(true); try { const r = await fetch('/article'); const a = await r.json(); if (a && a.title) { ARTICLE = a; rebuildFromArticle(); } } catch {} finally { setStatusLoading(false); } } applyServerState(s); } catch {} }; es.onerror = () => { serverConnected = false; el.connectionStatus.textContent = '多人协作：未连接（单机模式）'; }; } catch { serverConnected = false; el.connectionStatus.textContent = '多人协作：未连接（单机模式）'; } }
function disconnectSSE() { if (es && typeof es.close === 'function') { try { es.close(); } catch {} } es = null; serverConnected = false; }
function setMode(mode) { currentMode = mode === 'multi' ? 'multi' : 'single'; localStorage.setItem('gameMode', currentMode); if (currentMode === 'single') { disconnectSSE(); if (el.playerSelect) el.playerSelect.style.display = 'none'; if (el.playersGuessesBlock) el.playersGuessesBlock.style.display = 'none'; if (el.connectionStatus) el.connectionStatus.style.display = 'none'; resetGame(); } else { if (el.playerSelect) el.playerSelect.style.display = ''; if (el.playersGuessesBlock) el.playersGuessesBlock.style.display = ''; if (el.connectionStatus) el.connectionStatus.style.display = ''; connectSSE(); fetch('/reset', { method: 'POST' }).catch(() => {}); attemptsCount = 0; renderAttempts(); } }

// 启动逻辑：加载文章 -> 初始化模式/玩家 -> 绑定事件
(async function start() {
  setStatusLoading(true);
  try { const r = await fetch('/article'); const a = await r.json(); if (a && a.title) { ARTICLE = a; } } catch {}
  rebuildFromArticle();
  if (el.modeSelect) { const savedMode = localStorage.getItem('gameMode') || 'single'; el.modeSelect.value = savedMode; setMode(savedMode); el.modeSelect.addEventListener('change', () => setMode(el.modeSelect.value)); } else { setMode('single'); }
  if (el.playerSelect) { const saved = localStorage.getItem('playerId'); if (saved === '2') el.playerSelect.value = '2'; el.playerSelect.addEventListener('change', () => getPlayerId()); }
  el.charForm.addEventListener('submit', (e) => { e.preventDefault(); if (gameWon) return; const res = handleCharGuess(el.charInput.value); if (res !== 'multi') el.charInput.value = ''; el.charInput.focus(); });
  if (el.charInput) { el.charInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.keyCode === 13) { ev.preventDefault(); if (!gameWon) el.charForm.requestSubmit ? el.charForm.requestSubmit() : el.charForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } }); }
  el.resetBtn.addEventListener('click', async () => { if (serverConnected && currentMode === 'multi') { try { await fetch('/reset', { method: 'POST' }); } catch {} attemptsCount = 0; renderAttempts(); } else { resetGame(); } });
  if (el.regenBtn) {
    el.regenBtn.addEventListener('click', async () => {
      setStatusLoading(true);
      try {
        const resp = await fetch('/regenerate', { method: 'POST' });
        const data = await resp.json();
        if (data && data.ok) {
          // 拉取新文章内容并重建
          const r = await fetch('/article');
          const a = await r.json();
          if (a && a.title) { ARTICLE = a; rebuildFromArticle(); attemptsCount = 0; renderAttempts(); render(); }
          el.charStatus.className = 'status ok';
          el.charStatus.textContent = '已更换文章';
        } else {
          el.charStatus.className = 'status err';
          el.charStatus.textContent = '换一篇失败：请先在服务器设置 ZHIPUAI_API_KEY';
        }
      } catch {
        el.charStatus.className = 'status err';
        el.charStatus.textContent = '换一篇失败：网络或服务端错误';
      } finally { setStatusLoading(false); }
    });
  }
  if (el.revealAllBtn) {
    el.revealAllBtn.addEventListener('click', () => {
      preWinRevealed = revealedMask.slice();
      for (let i = 0; i < revealedMask.length; i++) revealedMask[i] = true;
      gameWon = true;
      el.charStatus.className = 'status ok';
      el.charStatus.textContent = '已显示全文答案';
      render();
    });
  }
  renderAttempts(); render(); setStatusLoading(false);
})();
