// 简易多人协作服务（无第三方依赖，使用 SSE + POST）
// 用法：node server.js，然后在另一设备访问同一局域网地址:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 文章数据（可由外部大模型生成）
let ARTICLE = {
  title: '桃花源记',
  body:
    '晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近，忽逢桃花林，夹岸数百步，中无杂树，芳草鲜美，落英缤纷。渔人甚异之；复前行，欲穷其林。\n\n林尽水源，便得一山，山有小口，仿佛若有光。便舍船，从口入。初极狭，才通人；复行数十步，豁然开朗。土地平旷，屋舍俨然，有良田美池桑竹之属。\n\n阡陌交通，鸡犬相闻。其中往来种作，男女衣着，悉如外人；黄发垂髫，并怡然自乐。',
};

let FULL_TEXT = `《${ARTICLE.title}》\n\n${ARTICLE.body}`;
let fullChars = Array.from(FULL_TEXT);
let FULL_SPLIT_INDEX = `《${ARTICLE.title}》\n\n`.length;
const PUNCT = new Set(Array.from('，。、；：？！…—·“”‘’（）《》〈〉【】[]{}<>—-·.,;:!?\"\'()[]{}<>/\\@#$%^&*_+=|`~\n\t '));

let titleCharIndexes = (() => {
  const arr = [];
  for (let i = 0; i < FULL_SPLIT_INDEX; i++) {
    if (!PUNCT.has(fullChars[i])) arr.push(i);
  }
  return arr;
})();

function canonicalChar(ch) { return /[A-Za-z]/.test(ch) ? ch.toLowerCase() : ch; }

// 游戏状态
let revealedMask = Array(fullChars.length).fill(false);
let guessedSet = new Set(); // 全局已猜集合（归一化）
let missedSet = new Set();
let gameWon = false;
let preWinRevealed = null; // 胜利瞬间已揭示位置
const byPlayer = { '1': [], '2': [] }; // 每项: { char, hit }
let articleSeq = 1;
function rebuildFromArticle() {
  FULL_TEXT = `《${ARTICLE.title}》\n\n${ARTICLE.body}`;
  fullChars = Array.from(FULL_TEXT);
  FULL_SPLIT_INDEX = `《${ARTICLE.title}》\n\n`.length;
  titleCharIndexes = (() => {
    const arr = [];
    for (let i = 0; i < FULL_SPLIT_INDEX; i++) {
      if (!PUNCT.has(fullChars[i])) arr.push(i);
    }
    return arr;
  })();
  revealedMask = Array(fullChars.length).fill(false);
  for (let i = 0; i < fullChars.length; i++) if (PUNCT.has(fullChars[i])) revealedMask[i] = true;
  guessedSet = new Set();
  missedSet = new Set();
  gameWon = false;
  preWinRevealed = null;
  byPlayer['1'] = [];
  byPlayer['2'] = [];
  articleSeq += 1;
}

// 初始化标点/空白可见
for (let i = 0; i < fullChars.length; i++) if (PUNCT.has(fullChars[i])) revealedMask[i] = true;

function stateSnapshot() {
  return {
    revealedMask,
    missed: Array.from(missedSet),
    players: byPlayer,
    gameWon,
    preWinRevealed,
    articleSeq,
  };
}

function resetState() {
  rebuildFromArticle();
}

// SSE 客户端集合
const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(stateSnapshot())}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

function handleGuess(char, playerId) {
  const resp = { code: 'hit', message: '', hit: false, repeat: false };
  const c = (char || '').trim();
  if (!c) { resp.code = 'empty'; resp.message = '请输入一个字符'; return resp; }
  if (Array.from(c).length > 1) { resp.code = 'multi'; resp.message = '一次只能输入一个字符'; return resp; }
  const ch = Array.from(c)[0];
  if (PUNCT.has(ch)) { resp.code = 'punct'; resp.message = '标点/空白无需猜测'; return resp; }

  const key = canonicalChar(ch);
  if (guessedSet.has(key)) {
    const exists = fullChars.some(cc => !PUNCT.has(cc) && canonicalChar(cc) === key);
    // 不再向玩家列表追加重复字符，避免重复显示
    resp.code = 'repeat';
    resp.message = exists ? '已经猜过了（命中）' : '已经猜过了（未命中）';
    resp.hit = exists;
    resp.repeat = true;
    return resp;
  }
  guessedSet.add(key);

  // 命中与否
  let exists = false, newly = false;
  const variants = new Set([ch]);
  if (/[A-Za-z]/.test(ch)) { variants.add(ch.toLowerCase()); variants.add(ch.toUpperCase()); }
  for (let i = 0; i < fullChars.length; i++) {
    if (variants.has(fullChars[i])) {
      exists = true;
      if (!revealedMask[i]) { revealedMask[i] = true; newly = true; }
    }
  }

  if (!exists) {
    missedSet.add(ch);
    byPlayer[playerId]?.push({ char: ch, hit: false });
    resp.code = 'miss'; resp.message = `未命中：${ch}`; resp.hit = false;
  } else {
    byPlayer[playerId]?.push({ char: ch, hit: true });
    resp.code = newly ? 'hit' : 'repeat';
    resp.message = newly ? `命中：${ch}` : '已经猜过了（命中）';
    resp.hit = newly;
  }

  // 胜利检测
  if (!gameWon && titleCharIndexes.every((i) => revealedMask[i])) {
    preWinRevealed = revealedMask.slice();
    gameWon = true;
    for (let i = 0; i < revealedMask.length; i++) revealedMask[i] = true;
  }

  return resp;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'GET' && parsed.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`retry: 2000\n`);
    res.write(`data: ${JSON.stringify(stateSnapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/guess') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { char, playerId } = JSON.parse(body || '{}');
        const pid = (playerId === '2') ? '2' : '1';
        const r = handleGuess(char, pid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        broadcast();
      } catch (e) {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/reset') {
    resetState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    broadcast();
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/article') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(ARTICLE));
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/regenerate') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const apiKey = process.env.ZHIPUAI_API_KEY || (JSON.parse(body || '{}').apiKey);
        const result = await generateArticleWithZhipuTest(apiKey);
        if (result) {
          ARTICLE = result;
          rebuildFromArticle();
          broadcast();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, article: ARTICLE }));
        } else {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'generation_failed' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // 静态文件服务
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const abs = path.join(process.cwd(), filePath.replace(/\.+/g, '.'));
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  if (process.env.ZHIPUAI_API_KEY) {
    try {
      const gen = await generateArticleWithZhipuTest(process.env.ZHIPUAI_API_KEY);
      if (gen) {
        ARTICLE = gen;
        rebuildFromArticle();
        console.log('Article loaded from Zhipu BigModel (startup).');
      }
    } catch {}
  }
});

// ———————————— 调用质谱大模型（GLM‑4.5‑Flash） ————————————
async function generateArticleWithZhipu(apiKey) {
  if (!apiKey) return null;
  const payload = {
    model: 'glm-4.5-flash',
    messages: [
      { role: 'system', content: '你是一个文字助手，先给出一个不生僻的常用名词，可以是人物地点作品物品品牌等等的任意东西的名字，也可以是一个概念，然后给出关于这个词的介绍。输出 JSON：{"title":"...","body":"..."}，不要额外说明，不要代码块。正文通俗、原创、无敏感内容。出过的词不要再出' },
      { role: 'user', content: '请生成一个不生僻的常用名词（注意，出过的词不要再出），人物地点作品物品品牌等等的任意东西的名字，也可以是一个概念，以及300~400字的关于这个词的介绍,介绍要至少分2段，最多分4段，要求上面的 JSON 格式。' },
    ],
    temperature: 0.7,
  };

  const resp = await httpsJson('https://open.bigmodel.cn/api/paas/v4/chat/completions', payload, apiKey);
  if (!resp) return null;
  const text = resp?.choices?.[0]?.message?.content || '';
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    const raw = jsonStart >= 0 ? text.slice(jsonStart, jsonEnd + 1) : text;
    const obj = JSON.parse(raw);
    if (obj && typeof obj.title === 'string' && typeof obj.body === 'string') {
      return { title: obj.title.trim(), body: obj.body.trim() };
    }
  } catch {}
  return null;
}

function httpsJson(urlStr, jsonBody, apiKey) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const https = require('https');
      const data = Buffer.from(JSON.stringify(jsonBody), 'utf8');
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'Authorization': `Bearer ${apiKey}`,
        },
      }, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks).toString('utf8');
          try { resolve(JSON.parse(buf)); } catch { resolve(null); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    } catch (e) { reject(e); }
  });
}

// Use test script prompts for generation (banned titles filtered, up to 3 tries)
async function generateArticleWithZhipuTest(apiKey) {
  if (!apiKey) return null;
  const banned = new Set(['图书馆', '咖啡', '蓝牙']);
  for (let i = 0; i < 3; i++) {
    const payload = {
      model: 'glm-4.5-flash',
      messages: [
        {
          role: 'system',
          content:
            '你是一个文字助手，先给出一个不生僻名词，可以是人物地点作品物品品牌等等的任意东西的名字，也可以是一个概念，然后给出关于这个词的介绍。注意，出过的词不要再出。输出 JSON：{"title":"...","body":"..."}，不要额外说明，不要代码块。正文通俗、原创、无敏感内容。出过的词不要再出。',
        },
        {
          role: 'user',
          content:
            '给出一个不生僻名词，出过的词不要再出，人物地点作品物品品牌等等的任意东西的名字，也可以是一个概念，涉及历史文艺生物日常生活，以及300~400字的关于这个词的介绍,介绍要至少分2段，最多分4段，要求上面的 JSON 格式。',
        },
      ],
      temperature: 0.7,
    };
    const resp = await httpsJson('https://open.bigmodel.cn/api/paas/v4/chat/completions', payload, apiKey);
    if (!resp) continue;
    const text = resp?.choices?.[0]?.message?.content || '';
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      const raw = start >= 0 ? text.slice(start, end + 1) : text;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.title === 'string' && typeof obj.body === 'string') {
        const title = String(obj.title).trim();
        const body = String(obj.body).trim();
        if (banned.has(title)) continue;
        return { title, body };
      }
    } catch {}
  }
  return null;
}
