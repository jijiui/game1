/**
 * Test script for Zhipu BigModel GLM-4.5-Flash
 * Usage:
 *   node test_bigmodel.js            # Uses env ZHIPUAI_API_KEY; generate -> check
 *   node test_bigmodel.js --key=XXX  # Provide API key explicitly
 */

const https = require('https');

const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4.5-flash';
const BANNED_TITLES = new Set(['图书馆', '咖啡', '蓝牙']);

function getArgKey() {
  const a = process.argv.find((s) => s.startsWith('--key='));
  return a ? a.slice('--key='.length) : undefined;
}

function postJson(urlStr, bodyObj, apiKey) {
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  return new Promise((resolve, reject) => {
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
          const txt = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(txt));
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
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

async function generateArticle(apiKey, maxTries = 3) {
  let attempts = 0;
  for (let i = 0; i < maxTries; i++) {
    attempts++;
    const payload = {
      model: MODEL,
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
    const resp = await postJson(API_URL, payload, apiKey);
    const text = resp?.choices?.[0]?.message?.content || '';
    const obj = parseJsonFromText(text);
    if (!obj || !obj.title || !obj.body) continue;
    const title = String(obj.title).trim();
    const body = String(obj.body).trim();
    if (BANNED_TITLES.has(title)) {
      // retry when banned
      continue;
    }
    return { title, body, attempts };
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
          '你是中文文本校对助手。接收 JSON：{"title":"...","body":"..."}，仅返回修正后的 JSON（同样字段），不要多余文字或代码块。修正错别字、标点、语法，意图不变。',
      },
      {
        role: 'user',
        content: '请校对并仅返回 JSON：' + JSON.stringify({ title: article.title, body: article.body }),
      },
    ],
    temperature: 0.2,
  };
  const resp = await postJson(API_URL, payload, apiKey);
  const text = resp?.choices?.[0]?.message?.content || '';
  const obj = parseJsonFromText(text);
  if (obj && obj.title && obj.body) {
    return { title: String(obj.title).trim(), body: String(obj.body).trim() };
  }
  return null;
}

async function main() {
  const apiKey = getArgKey() || process.env.ZHIPUAI_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] 请通过环境变量 ZHIPUAI_API_KEY 或参数 --key= 提供 API Key');
    process.exit(1);
  }

  console.log('1) 生成文章（最多 3 次尝试，过滤：图书馆/咖啡/蓝牙）...');
  const gen = await generateArticle(apiKey, 3);
  if (!gen) {
    console.error('生成失败（可能是网络或返回格式异常）。');
    process.exit(2);
  }
  console.log(`生成成功（尝试次数: ${gen.attempts})\n标题: ${gen.title}\n正文长度: ${gen.body.length}`);

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

