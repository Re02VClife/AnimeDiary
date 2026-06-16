import XLSX from 'xlsx';
import fs from 'fs';

const EXCEL = 'C:/Users/24628/Desktop/vscode/番评分.xlsx';
const CACHE = 'anilist_cache.json';

const wb = XLSX.readFile(EXCEL);
const ws = wb.Sheets['番剧列表'];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

// 收集番名 + 英文别名 { mainTitle, alias }
const animeItems = [];
const seen = new Set();
for (let i = 1; i < data.length; i++) {
  const title = String(data[i][1] || '').trim();
  const alias = String(data[i][0] || '').trim();
  if (title && !seen.has(title)) {
    seen.add(title);
    animeItems.push({ title, alias });
  }
}
console.log('待抓取:', animeItems.length, '部');

let cache = {};
if (fs.existsSync(CACHE)) cache = JSON.parse(fs.readFileSync(CACHE, 'utf-8'));
const initialCount = Object.keys(cache).length;
console.log('已有缓存:', initialCount, '跳过');

async function searchOne(keyword) {
  try {
    const escaped = keyword.replace(/"/g, '\\"');
    const q = `{Page(page:1,perPage:1){media(search:"${escaped}",type:ANIME){id title{romaji english native}coverImage{large medium}averageScore episodes seasonYear}}}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data?.Page?.media?.[0] || null;
  } catch { return null; }
}

async function fetchOne(item) {
  const { title, alias } = item;
  if (cache[title]) return;
  // 先搜中文标题，再试英文别名
  let m = await searchOne(title);
  if (!m && alias) {
    m = await searchOne(alias);
  }
  if (!m) return;
  cache[title] = {
    id: m.id,
    name: m.title?.native || m.title?.romaji || '',
    name_cn: m.title?.native || '',
    images: {
      large: m.coverImage?.large || '',
      common: m.coverImage?.medium || '',
      medium: m.coverImage?.medium || '',
      small: m.coverImage?.medium || '',
    },
    rating: { score: (m.averageScore || 0) / 10, total: 0 },
    air_date: m.seasonYear ? String(m.seasonYear) : '',
    eps: m.episodes || 0,
    summary: '',
  };
}

const arr = animeItems;
let done = 0;
const BATCH = 3;
const DELAY = 2000;

for (let i = 0; i < arr.length; i += BATCH) {
  const batch = arr.slice(i, i + BATCH);
  await Promise.all(batch.map(fetchOne));
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2), 'utf-8');
  done += batch.length;
  if (done % 30 === 0 || i >= arr.length - BATCH) {
    const total = Object.keys(cache).length;
    console.log(`  ${total} 部 (${Math.round(done/arr.length*100)}%)`);
  }
  // 速率限制延迟
  await new Promise(r => setTimeout(r, DELAY));
}

const final = Object.keys(cache).length;
console.log(`\n完成! ${final} 部 (新增 ${final - initialCount})`);
