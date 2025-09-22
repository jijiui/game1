/**
 * Test script for Zhipu BigModel GLM-4.5-Flash
 * Usage examples:
 *   node test_bigmodel.js                              # Uses env ZHIPUAI_API_KEY; default params
 *   node test_bigmodel.js --key=XXX                    # Provide API key explicitly
 *   node test_bigmodel.js --tries=6 --top_p=0.9
 *   node test_bigmodel.js --avoid=seen_titles.json --update-seen
 *   node test_bigmodel.js --multi=6 --debug
 */

const https = require('https');
const fs = require('fs');

const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4.5-flash';
const BANNED_TITLES = new Set(['图书馆', '咖啡', '蓝牙']);
const DEFAULT_CATEGORIES = ['历史', '地理', '品牌', '日常', '科技', '艺术', '生物', '人物', '地点', '作品', '物品', '概念'];

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

function getApiKey(args) {
  return args.key || process.env.ZHIPUAI_API_KEY;
}

function postJsonDetailed(urlStr, bodyObj, apiKey) {
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + (u.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            Authorization: `Bearer ${apiKey}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch {}
            resolve({ status: res.statusCode, text, json });
          });
        }
      );
      req.on('error', (e) => reject(e));
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

function parseJsonFromText(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseCandidatesFromText(text) {
  const obj = parseJsonFromText(text);
  if (!obj) return null;
  if (Array.isArray(obj.candidates)) {
    const arr = obj.candidates
      .map((c) => ({ title: String(c?.title || ''), body: String(c?.body || '') }))
      .filter((c) => c.title && c.body);
    return arr.length ? arr : null;
  }
  if (obj.title && obj.body) return [{ title: String(obj.title), body: String(obj.body) }];
  return null;
}

function splitParagraphs(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  // 以一个或多个空行分段
  const parts = text.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  return parts;
}

function isParagraphsValid(body, min = 2, max = 4) {
  const parts = splitParagraphs(body);
  return parts.length >= min && parts.length <= max;
}

function normalizeTitle(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

function pickCategories(n = 2, pool = DEFAULT_CATEGORIES) {
  const arr = [...pool];
  const res = [];
  for (let i = 0; i < n && arr.length > 0; i++) {
    const idx = Math.floor(Math.random() * arr.length);
    res.push(arr.splice(idx, 1)[0]);
  }
  return res;
}

function loadSeen(file) {
  if (!file) return new Set();
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const arr = JSON.parse(txt);
    return new Set((arr || []).map(normalizeTitle));
  } catch {
    return new Set();
  }
}

function saveSeen(file, seen, keep = 500) {
  if (!file) return;
  try {
    const arr = Array.from(seen);
    const out = arr.slice(-keep);
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.warn('保存已出清单失败:', e?.message || e);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function generateArticle(apiKey, opts = {}) {
  const maxTries = Number(opts.tries || opts.maxTries || 6);
  const top_p = opts.top_p ? Number(opts.top_p) : 0.9;
  const avoidSet = opts.avoid instanceof Set ? opts.avoid : new Set();
  const categories = Array.isArray(opts.categories) && opts.categories.length ? opts.categories : pickCategories(2);
  const multi = Math.max(0, Number(opts.multi || 0));
  const debug = !!opts.debug;

  let attempts = 0;
  for (let i = 0; i < maxTries; i++) {
    attempts++;
    const avoidList = Array.from(new Set([...BANNED_TITLES, ...avoidSet])).slice(0, 300);
    const avoidStr = avoidList.length ? `以下词严禁再次出现：${avoidList.join('、')}。` : '';
    const catStr = `请从这些类别随机选择一个合适的常见名词（不得生僻）：${categories.join('、')}。`;
    const payload = {
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            (multi && multi > 1)
              ? '你是一个文字助手。请仅返回 JSON：{"candidates":[{"title":"...","body":"..."}, ...]}，不返回额外说明或代码块。正文通俗、原创、无敏感内容。要求 body 使用空行（\\n\\n）分段，段落数为 2~4 段。不要使用列表、编号、标题或 Markdown。'
              : '你是一个文字助手，你会被要求给出一个不生僻名词，可以是人物地点作品物品品牌等等的任意东西的名字，也可以是一个概念，然后给出关于这个词的介绍。你的输出永远是这样的格式 JSON：{"title":"...","body":"..."}，没有额外说明，没有代码块。正文通俗、原创、无敏感内容。要求 body 使用空行（\\n\\n）分段，段落数为 2~4 段。不要使用列表、编号、标题或 Markdown。',
        },
        {
          role: 'user',
          content:
            (multi && multi > 1)
              ? `${catStr} 出过的词不要再出。${avoidStr} 请给出${multi}个不同的候选，每个候选一个词及其300~400字介绍，正文用空行（\\n\\n）分为 2~4 段。仅返回 JSON，字段为 candidates。`
              : `${catStr} 出过的词不要再出。${avoidStr} 给出一个词，并提供300~400字介绍，正文用空行（\\n\\n）分为 2~4 段。仅返回 JSON。`,
        },
      ],
      top_p,
    };
    const resp = await postJsonDetailed(API_URL, payload, apiKey);
    const text = resp?.json?.choices?.[0]?.message?.content || resp?.text || '';
    if (debug) {
      const head = String(text).slice(0, 240).replace(/\s+/g, ' ').trim();
      console.log(`[debug] try ${attempts}: status=${resp?.status} head="${head}"`);
    }
    const candidates = parseCandidatesFromText(text);
    if (!candidates || !candidates.length) { await sleep(200 + Math.random() * 400); continue; }
    // 随机顺序挑选未出现过的候选
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    for (const cand of shuffled) {
      const title = String(cand.title).trim();
      const body = String(cand.body).trim();
      const norm = normalizeTitle(title);
      if (!title || !body) continue;
      if (!isParagraphsValid(body)) { if (debug) console.log('[debug] reject candidate: paragraphs not in 2~4'); continue; }
      if (BANNED_TITLES.has(title) || avoidSet.has(norm)) continue;
      return { title, body, attempts };
    }
    await sleep(200 + Math.random() * 400);
  }
  return null;
}

async function checkAndFix(apiKey, article) {
  const payload = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          '你是中文文本校对助手。接收 JSON：{"title":"...","body":"..."}，仅返回修正后的 JSON（同样字段），不要多余文字或代码块。修正错别字、标点、语法，意图不变。若正文未按段落分隔，请将 body 用空行（\\n\\n）分为 2~4 段，保持意思不变。',
      },
      {
        role: 'user',
        content: '请校对并仅返回 JSON：' + JSON.stringify({ title: article.title, body: article.body }),
      },
    ],
    temperature: 0.2,
  };
  const resp = await postJsonDetailed(API_URL, payload, apiKey);
  const text = resp?.json?.choices?.[0]?.message?.content || resp?.text || '';
  const obj = parseJsonFromText(text);
  if (obj && obj.title && obj.body) {
    return { title: String(obj.title).trim(), body: String(obj.body).trim() };
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const apiKey = getApiKey(args);
  if (!apiKey) {
    console.error('[ERROR] 请通过环境变量 ZHIPUAI_API_KEY 或参数 --key= 提供 API Key');
    process.exit(1);
  }

  const tries = Number(args.tries || 6);
  const top_p = args.top_p || 0.9;
  const multi = Number(args.multi || 0);
  const debug = !!args.debug;
  const avoidFile = args.avoid; // e.g. seen_titles.json
  const updateSeen = !!args['update-seen'];
  const seen = loadSeen(avoidFile);

  console.log(`1) 生成文章（重试: ${tries}，top_p: ${top_p}，multi: ${multi || 1}）...`);
  const gen = await generateArticle(apiKey, { tries, top_p, avoid: seen, multi, debug });
  if (!gen) {
    console.error('生成失败（可能是网络或返回格式异常/严重重复）。');
    process.exit(2);
  }
  console.log(`生成成功（尝试次数: ${gen.attempts})\n标题: ${gen.title}\n正文长度: ${gen.body.length}`);

  if (updateSeen && avoidFile) {
    seen.add(normalizeTitle(gen.title));
    saveSeen(avoidFile, seen, 500);
  }

  console.log('\n2) 校对纠错（仅返回 JSON）...');
  const fixed = await checkAndFix(apiKey, gen);
  if (!fixed) {
    console.warn('校对失败或返回格式异常，使用原文。');
    console.log(JSON.stringify({ title: gen.title, body: gen.body }, null, 2));
  } else {
    console.log('校对成功:');
    console.log(JSON.stringify(fixed, null, 2));
  }
}

main().catch((e) => {
  console.error('脚本执行异常:', e?.message || e);
  process.exit(99);
});
