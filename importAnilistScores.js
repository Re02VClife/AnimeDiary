/**
 * 番评分.xlsx — 批量导入 AniList 评分到 AK 列（增强版）
 *
 * 搜索优先级：
 *   1. 缓存命中 → 直接使用
 *   2. A列检索名（日文/英文）→ AniList 搜索
 *   3. 内置中→日映射表 → AniList 搜索
 *   4. 中文标题（清理后）→ AniList 搜索
 *
 * 用法：node importAnilistScores.js
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.resolve(__dirname, '番评分.xlsx');
const OUTPUT_PATH = path.resolve(__dirname, '番评分.xlsx');
const SHEET_NAME = '番剧列表';
const SCORE_CACHE_PATH = path.resolve(__dirname, 'anilist_score_cache.json');

const DELAY_MS = 750; // AniList 限流 90/min，安全间隔

const COL = {
  SEARCH_ALIAS: 0,   // A - 检索名（日文/别名）
  TITLE: 1,          // B - 中文名
  ANILIST_SCORE: 36, // AK - AniList 评分
};

// ═══════════════════════════════════════
// 内置中→日文名映射（来自 fillSearchAlias.js）
// ═══════════════════════════════════════
const KNOWN_NAMES = {
  '路人女主的养成方法fine': '冴えない彼女の育てかた Fine',
  '无职转生': '無職転生 ～異世界行ったら本気だす～',
  '末日时在做什么？有没有空？可以来拯救吗？': '終末なにしてますか? 忙しいですか? 救ってもらっていいですか?',
  '86 不存在的战区 第二部分': '86－エイティシックス－',
  '義妹生活': '義妹生活',
  '天气之子': '天気の子',
  '青春猪头少年不会梦到兔女郎学姐': '青春ブタ野郎はバニーガール先輩の夢を見ない',
  '孤独摇滚': 'ぼっち・ざ・ろっく！',
  '游戏人生 零': 'ノーゲーム・ノーライフ ゼロ',
  '紫罗兰永恒花园': 'ヴァイオレット・エヴァーガーデン',
  '你的名字': '君の名は。',
  '摇曳露营': 'ゆるキャン△',
  '魔女之旅': '魔女の旅々',
  '四月是你的谎言': '四月は君の嘘',
  '路人女主的养成方法2': '冴えない彼女の育てかた♭',
  '路人女主的养成方法': '冴えない彼女の育てかた',
  '中二病也要谈恋爱 Take on me': '映画 中二病でも恋がしたい! -Take On Me-',
  '中二病也要谈恋爱': '中二病でも恋がしたい!',
  '中二病也要谈恋爱2': '中二病でも恋がしたい!戀',
  '电波女与青春男': '電波女と青春男',
  '辉夜大小姐想让我告白3': 'かぐや様は告らせたい-ウルトラロマンティック-',
  '辉夜大小姐想让我告白2': 'かぐや様は告らせたい？～天才たちの恋愛頭脳戦～',
  '辉夜大小姐想让我告白': 'かぐや様は告らせたい～天才たちの恋愛頭脳戦～',
  '缘之空': 'ヨスガノソラ',
  '樱花庄的宠物女孩': 'さくら荘のペットな彼女',
  '声之形': '聲の形',
  'Re：从零开始的异世界生活2': 'Re:ゼロから始める異世界生活 2nd season',
  '铃芽之旅': 'すずめの戸締まり',
  '埃罗芒阿老师': 'エロマンガ先生',
  '为美好的世界献上祝福2': 'この素晴らしい世界に祝福を！2',
  '为美好的世界献上祝福': 'この素晴らしい世界に祝福を！',
  '我的青春恋爱物语果然有问题-继': 'やはり俺の青春ラブコメはまちがっている。続',
  '我的青春恋爱物语果然有问题-完': 'やはり俺の青春ラブコメはまちがっている。完',
  '我的青春恋爱物语果然有问题': 'やはり俺の青春ラブコメはまちがっている。',
  '更衣人偶坠入爱河': 'その着せ替え人形は恋をする',
  '青之箱': 'アオのハコ',
  '龙与虎': 'とらドラ！',
  '境界的彼方': '境界の彼方',
  '堀与宫村piece': 'ホリミヤ -piece-',
  '堀与宫村': 'ホリミヤ',
  '月刊少女野崎君': '月刊少女野崎くん',
  '回复术士的重启人生': '回復術士のやり直し',
  '总之就是非常可爱': 'トニカクカワイイ',
  '总之就是非常可爱2+校园': 'トニカクカワイイ 2nd season',
  '上伊那牡丹，酒醉身姿似百合花般': '上伊那ぼたん、酔へる姿は百合の花',
  '在地下城寻求邂逅是否搞错了什么': 'ダンジョンに出会いを求めるのは間違っているだろうか',
  '无职转生2': '無職転生Ⅱ ～異世界行ったら本気だす～',
  '我推的孩子': '【推しの子】',
  '我推的孩子2': '【推しの子】第2期',
  '我推的孩子3': '【推しの子】第3期',
  'Charlotte': 'Charlotte',
  'ReLIFE': 'ReLIFE',
  'Hello World': 'HELLO WORLD',
  '冰菓': '氷菓',
  '游戏人生': 'ノーゲーム・ノーライフ',
  '利兹与青鸟': 'リズと青い鳥',
  '玉子爱情故事': 'たまこラブストーリー',
  '玉子市场': 'たまこまーけっと',
  '赛博朋克:边缘行者': 'サイバーパンク エッジランナーズ',
  '败犬女主太多了': '負けヒロインが多すぎる！',
  '我心里危险的东西': '僕の心のヤバイやつ',
  '我心里危险的东西2': '僕の心のヤバイやつ 第2期',
  '可塑性记忆': 'プラスティック・メモリーズ',
  '白箱': 'SHIROBAKO',
  '白箱剧场版': '劇場版 SHIROBAKO',
  '英雄联盟:双城之战': 'Arcane',
  '葬送的芙莉莲': '葬送のフリーレン',
  '葬送的芙莉莲 2': '葬送のフリーレン 第2期',
  '莉可丽丝': 'リコリス・リコイル',
  '莉可丽丝：友谊是时间的窃贼': 'リコリス・リコイル',
  '别当欧尼酱了': 'お兄ちゃんはおしまい！',
  '异世界舅舅': '異世界おじさん',
  '游戏三人娘': 'あそびあそばせ',
  '跃动青春': 'スキップとローファー',
  '契约之吻': 'Engage Kiss',
  '彻夜之歌': 'よふかしのうた',
  '彻夜之歌2': 'よふかしのうた 第2期',
  '为美好的世界献上爆焰': 'この素晴らしい世界に爆焔を！',
  '为美好的世界献上祝福3': 'この素晴らしい世界に祝福を！3',
  '月色真美': '月がきれい',
  '言叶之庭': '言の葉の庭',
  '好想告诉你': '君に届け',
  '好想告诉你2': '君に届け 2ND SEASON',
  '好想告诉你3': '君に届け 3RD SEASON',
  '寄生兽 生命的准则': '寄生獣 セイの格率',
  '间谍过家家': 'SPY×FAMILY',
  '间谍过家家 part1': 'SPY×FAMILY',
  '间谍过家家 part2': 'SPY×FAMILY 第2クール',
  '间谍过家家2': 'SPY×FAMILY 第2期',
  '间谍过家家3': 'SPY×FAMILY 第3期',
  '工作细胞': 'はたらく細胞',
  '五等分的花嫁': '五等分の花嫁',
  '五等分的花嫁～': '五等分の花嫁～',
  '五等分的花嫁∫∫': '五等分の花嫁∬',
  '五等分的花嫁剧场版': '映画 五等分の花嫁',
  '散华礼弥': 'さんかれあ',
  '笨蛋测验召唤兽': 'バカとテストと召喚獣',
  'AngleBeats!': 'Angel Beats!',
  'Shelter': 'Shelter',
  '更衣人偶坠入爱河2': 'その着せ替え人形は恋をする 第2期',
  "BanG Dream! Its MyGO!!!!!": "BanG Dream! It's MyGO!!!!!",
  '古见同学有交流障碍症': '古見さんは、コミュ症です。',
  '想结束这场我爱你的游戏': '君が死ぬまで恋をしたい',
  '想要成为影之实力者': '陰の実力者になりたくて！',
  '想要成为影之实力者2': '陰の実力者になりたくて！ 第2期',
  '在盛夏等待': 'あの夏で待ってる',
  '星之梦': 'planetarian ～ちいさなほしのゆめ～',
  '罪恶王冠': 'ギルティクラウン',
  '人形电脑天使心': 'ちょびっツ',
  '网络胜利组': 'ネト充のススメ',
  '超时空辉夜姬': '超時空輝夜姫',
  '灰与幻想的格林姆迦尔': '灰と幻想のグリムガル',
  '为美好的世界献上祝福！红传说': '映画 この素晴らしい世界に祝福を！紅伝説',
  '青春猪头少年不做怀梦美少女的梦': '青春ブタ野郎はゆめみる少女の夢を見ない',
  '青春笨蛋少年不做小学美少女的梦': '青春ブタ野郎はおでかけシスターの夢を見ない',
  '青春猪头少年不会梦到圣诞服女郎': '青春ブタ野郎はサンタクロースの夢を見ない',
  '青春猪头少年不会梦到外出娇怜妹': '青春ブタ野郎はアウトランダーの夢を見ない',
  '2.5次元的诱惑': '2.5次元の誘惑',
  '亚托莉-我的挚爱时光': 'ATRI -My Dear Moments-',
  '通往夏天的隧道，再见的出口': '夏へのトンネル、さよならの出口',
  '夏日口袋': 'Summer Pockets',
  '恋爱flops': '恋愛フロップス',
  '魔法少女与邪恶曾经敌对': '魔法少女と悪は敵対していた',
  '不时用俄语小声说真心话的邻座艾莉同学': '時々ボソッとロシア語でデレる隣のアーリャさん',
  '关于邻家的天使大人不知不觉把我惯成废人这档子事': 'お隣の天使様にいつの間にか駄目人間にされていた件',
  '关于邻家的天使大人不知不觉把我惯成废人这档子事2': 'お隣の天使様にいつの間にか駄目人間にされていた件 第2期',
  '继母的拖油瓶是我的前女友': '継母の連れ子が元カノだった',
  '和山田lv999的恋爱': '山田くんとLv999の恋をする',
  '时光流逝，饭菜依旧美味': '日々は過ぎれど飯うまし',
  '末日后酒店': '終末のホテル',
  '朝花夕誓': 'さよならの朝に約束の花をかざろう',
  '超超喜欢你的100个女孩子1': '君のことが大大大大大好きな100人の彼女 第1期',
  '超超喜欢你的100个女孩子2': '君のことが大大大大大好きな100人の彼女 第2期',
  '党大胆': 'ダンダダン',
  '党大胆2': 'ダンダダン 第2期',
  '白圣女与黑牧师': '白聖女と黒牧師',
  '薰香花朵凛然绽放': '薫る花は凛と咲く',
  '我怎么可以成为你的恋人，不行不行（不是不可能？）': 'わたしが恋人になれるわけないじゃん、ムリムリ!（※ムリじゃなかった!?）',
  '我怎么可以成为你的恋人，不行不行（不是不可能？）再次闪耀': 'わたしが恋人になれるわけないじゃん、ムリムリ!（※ムリじゃなかった!?）',
  '青蓝岛': '青の島',
  '百变的七仓同学': '七倉くんは七変化',
  '小阿尔玛想成为家人': 'アルマちゃんは家族になりたい',
  '野生的大魔王出现了': '野生のラスボスが現れた！',
  '两人份的证明': 'ふたり分の証明',
  '魔女与使魔': '魔女と使い魔',
  '迦楠大人的白给是恶魔级': 'カナン様の白給は悪魔級',
  '沉默魔女的秘密': '沈黙の魔女の秘密',
  '双胞胎阳奈妃莉': '双子の陽奈と妃莉',
  '朋友的妹妹只喜欢烦我': '友達の妹が俺にだけウザい',
  '相反的你和我': '正反対な君と僕',
  '与游戏中心的少女异文化交流的故事': 'ゲーセンの少女と異文化交流',
  '呼唤少女（特别篇）想做的事情到底是什么': '少女を呼ぶ 特別編 やりたいことってなんだっけ',
  '琉璃的宝石': '瑠璃の宝石',
  '神国之上': '神国の上',
  '几分钟的欢呼': '数分間のエールを',
  '银河特急 银河☆地铁': '銀河特急 ギャラクシー☆メトロ',
  '金钱掌控': 'C',
  '排名': '王様ランキング',
  '86 不存在的战区 part1': '86－エイティシックス－',
  '我推的孩子剧场版(第一集)': '【推しの子】',
  '辉夜大小姐想让我告白-迈向大人的阶梯': 'かぐや様は告らせたい',
  '辉夜大小姐想让我告白-初吻不会结束-': 'かぐや様は告らせたい',
  'Re：从零开始的异世界生活1': 'Re:ゼロから始める異世界生活',
  'Re：从零开始的异世界生活3': 'Re:ゼロから始める異世界生活 2nd season',
  'Re：从零开始的异世界生活4': 'Re:ゼロから始める異世界生活 3rd season',
  'RE：从零开始的异世界生活4': 'Re:ゼロから始める異世界生活 3rd season',
  'Re：从零开始的异世界生活 雪之回忆': 'Re:ゼロから始める異世界生活 Memory Snow',
  'Re：从零开始的异世界生活 冰之结绊': 'Re:ゼロから始める異世界生活 氷の結び',
  '参考平均分': '',
  '36': '',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 清理关键词用于 AniList 搜索 */
function cleanKeyword(title) {
  return title
    .replace(/[（(][^)）]*[)）]/g, ' ')
    .replace(/[：:！!？?、，,。\-_\s—…~～・()（）【】\[\]「」『』""''＋+＝=*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** 搜索 AniList 并返回最佳匹配的评分 */
async function searchAniListScore(keyword) {
  const escaped = keyword.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 80);
  const query = `{
    Page(page:1, perPage:5){media(search:"${escaped}",type:ANIME){
      id title{romaji english native} averageScore episodes seasonYear
    }}
  }`;
  try {
    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const mediaList = (json?.data?.Page?.media || []);
    if (mediaList.length === 0) return null;
    // 返回第一个有评分的
    for (const m of mediaList) {
      if (m.averageScore && m.averageScore > 0) {
        return { score: Math.round(m.averageScore) / 10, id: m.id, foundName: m.title?.native || m.title?.romaji || '' };
      }
    }
    return { score: 0, id: mediaList[0].id, foundName: '' };
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  番评分.xlsx — 批量导入 AniList 评分 v2');
  console.log('  策略: A列日文名 → 内置映射 → 中文名');
  console.log('═══════════════════════════════════════\n');

  console.log(`[1/4] 读取: ${INPUT_PATH}`);
  const wb = XLSX.readFile(INPUT_PATH);
  const ws = wb.Sheets[SHEET_NAME];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  console.log(`  总行数: ${data.length}\n`);

  // 加载缓存
  let scoreCache = {};
  try {
    if (fs.existsSync(SCORE_CACHE_PATH)) {
      scoreCache = JSON.parse(fs.readFileSync(SCORE_CACHE_PATH, 'utf-8'));
      console.log(`  已有缓存: ${Object.keys(scoreCache).length} 条\n`);
    }
  } catch (_) {}

  // 扫描需要导入的行
  const toImport = [];
  for (let i = 1; i < data.length; i++) {
    const title = data[i][COL.TITLE];
    if (!title || String(title).trim() === '') continue;

    const existingScore = data[i][COL.ANILIST_SCORE];
    if (existingScore !== null && existingScore !== undefined && existingScore !== '' && Number(existingScore) > 0) {
      continue;
    }

    const alias = data[i][COL.SEARCH_ALIAS];
    toImport.push({
      rowIndex: i,
      title: String(title).trim(),
      alias: alias ? String(alias).trim() : '',
    });
  }

  console.log(`[2/4] 需要导入: ${toImport.length} 部\n`);
  if (toImport.length === 0) {
    console.log('✅ 全部已有评分');
    return;
  }

  console.log('[3/4] 开始查询…\n');

  let stats = { cache: 0, alias: 0, known: 0, cn: 0, fail: 0 };
  const fails = [];
  let dirty = false;

  for (let idx = 0; idx < toImport.length; idx++) {
    const { rowIndex, title, alias } = toImport[idx];
    const progress = `[${idx + 1}/${toImport.length}]`;
    let result = null;
    let source = '';

    // Step 1: 查缓存
    const cacheKey = alias || title;
    if (scoreCache[cacheKey] && scoreCache[cacheKey].score > 0) {
      result = scoreCache[cacheKey];
      source = '缓存';
      stats.cache++;
    }

    // Step 2: A列检索名（日文名/别名，最高优先级）
    if (!result && alias) {
      result = await searchAniListScore(alias);
      if (result && result.score > 0) {
        source = 'A列日文名';
        stats.alias++;
      } else if (result && result.score === 0) {
        result = null; // 搜到了但没评分，继续降级
      }
      if (result) await sleep(200); // 成功时短暂休息
    }

    // Step 3: 内置映射
    if (!result && KNOWN_NAMES.hasOwnProperty(title) && KNOWN_NAMES[title]) {
      const jpName = KNOWN_NAMES[title];
      if (jpName !== alias) { // 避免和 Step 2 重复
        await sleep(DELAY_MS);
        result = await searchAniListScore(jpName);
        if (result && result.score > 0) {
          source = '内置映射';
          stats.known++;
        } else if (result && result.score === 0) {
          result = null;
        }
      }
    }

    // Step 4: 中文名（清理后）
    if (!result) {
      const cleaned = cleanKeyword(title);
      // 如果清理后的中文名和别名/映射不同，才搜索
      if (cleaned && cleaned !== alias && cleaned !== KNOWN_NAMES[title]) {
        if (stats.alias > 0 || stats.known > 0) await sleep(DELAY_MS);
        result = await searchAniListScore(cleaned);
        if (result && result.score > 0) {
          source = '中文名';
          stats.cn++;
        } else if (result && result.score === 0) {
          result = null;
        }
      }
    }

    // 输出 + 写入
    if (result && result.score > 0) {
      data[rowIndex][COL.ANILIST_SCORE] = result.score;
      ws[XLSX.utils.encode_cell({ r: rowIndex, c: COL.ANILIST_SCORE })] = { t: 'n', v: result.score };
      scoreCache[cacheKey] = { score: result.score, id: result.id, foundName: result.foundName };
      dirty = true;
      const nameHint = result.foundName ? ` (${result.foundName})` : '';
      console.log(`${progress} [${source}] "${title}" → ${result.score}分${nameHint}`);
    } else {
      stats.fail++;
      fails.push(title);
      console.log(`${progress} ❌ "${title}"`);
    }

    // 请求间隔
    if (idx < toImport.length - 1) await sleep(DELAY_MS);

    // 每 30 条保存缓存
    if (dirty && (idx + 1) % 30 === 0) {
      try { fs.writeFileSync(SCORE_CACHE_PATH, JSON.stringify(scoreCache, null, 2), 'utf-8'); } catch (_) {}
      console.log(`  💾 缓存已保存\n`);
    }
  }

  if (dirty) {
    try { fs.writeFileSync(SCORE_CACHE_PATH, JSON.stringify(scoreCache, null, 2), 'utf-8'); } catch (_) {}
  }

  console.log(`\n[4/4] 保存: ${OUTPUT_PATH}`);
  if (dirty) {
    XLSX.writeFile(wb, OUTPUT_PATH);
    console.log('  ✅ Excel 已更新');
  } else {
    console.log('  ⏭ 无变更');
  }

  const total = stats.cache + stats.alias + stats.known + stats.cn;
  console.log('\n═══════════════════════════════════════');
  console.log('  完成！');
  console.log(`  📦 缓存: ${stats.cache}`);
  console.log(`  🔍 A列日文: ${stats.alias}`);
  console.log(`  📋 内置映射: ${stats.known}`);
  console.log(`  🌐 中文名: ${stats.cn}`);
  console.log(`  ❌ 未获取: ${stats.fail}`);
  console.log(`  ✅ 总计: ${total}`);
  if (fails.length > 0) {
    console.log(`\n  失败列表 (${fails.length}个):`);
    fails.forEach(t => console.log(`    - ${t}`));
  }
  console.log('═══════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
