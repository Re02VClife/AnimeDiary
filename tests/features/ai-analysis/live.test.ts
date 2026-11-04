/**
 * 真实模型联调测试（默认跳过）
 *
 * 用法：
 *   1. 先起本地服务：npm run dev:web（:5173）
 *   2. 配置好 ai-config.json（provider / baseUrl / model / apiKey）
 *   3. PowerShell: $env:AI_LIVE='1'; npx vitest run tests/features/ai-analysis/live.test.ts
 *
 * 它会读真实的 番评分.xlsx，把 6 个 Skill 全部跑一遍，断言：
 *   - 结构化输出能通过 Schema 校验（解析/纠偏/重写链路是通的）
 *   - 内容不是空壳
 *   - 结果落盘成一份可读报告，便于人工看质量
 *
 * 注意：必须跑在 node 环境。jsdom 的 AbortController 与 Node 的 fetch(undici)
 * 不是同一个类，传 signal 会被拒（Expected signal to be an instance of AbortSignal）。
 */
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadAnimeList } from '../../../features/anime-data/excel-service';
import { tasteAnalysis } from '../../../features/ai-analysis/taste-analysis';
import { preferenceProfile, buildDeviationData } from '../../../features/ai-analysis/preference-profile';
import { singleAnimeAnalysis } from '../../../features/ai-analysis/single-anime-analysis';
import { autoTag } from '../../../features/ai-analysis/auto-tag';
import { graphOptimize } from '../../../features/ai-analysis/graph-optimize';
import { smartRecommend } from '../../../features/ai-analysis/smart-recommend';
import { calcOverall } from '../../../features/ai-analysis/ai-helpers';
import type { AnimeEntry } from '../../../src/types';

const LIVE = process.env.AI_LIVE === '1';
const BASE = process.env.AI_BASE_URL || 'http://localhost:5173';
const REPORT_PATH = path.resolve(__dirname, '../../../.review/ai-live-report.md');

const report: string[] = [];
function log(line: string): void {
  report.push(line);
  console.log(line);
}

let animeList: AnimeEntry[] = [];

describe.skipIf(!LIVE)('AI 分析 · 真实模型联调', () => {
  beforeAll(async () => {
    // node 环境没有 localStorage：给 ai-config / 模板服务一个内存实现
    if (typeof (globalThis as any).localStorage === 'undefined') {
      const store = new Map<string, string>();
      (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
      };
    }

    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' && input.startsWith('/') ? `${BASE}${input}` : input;
      return nativeFetch(url, init);
    }) as typeof fetch;

    animeList = await loadAnimeList();
    log('# AI 联调报告\n');
    log(`- 数据：${animeList.length} 条（${animeList.filter((a) => a.scores.some((s) => s.score > 0)).length} 条有评分）\n`);
  }, 120000);

  it('Skill 1 · 品味分析', async () => {
    expect(animeList.length).toBeGreaterThan(0);
    const result = await tasteAnalysis(animeList, { stream: false });
    expect(result.summary.length).toBeGreaterThan(8);
    expect(result.highlights.length).toBeGreaterThanOrEqual(3);
    expect(result.highlights.length).toBeLessThanOrEqual(6);
    log('## 品味分析\n');
    log(`**${result.summary}**\n`);
    result.highlights.forEach((h, i) => log(`${i + 1}. ${h}`));
    log('');
    result.notes.forEach((n) => log(`- ${n}`));
    log('');
  }, 300000);

  it('Skill 2 · 偏好画像', async () => {
    const dev = buildDeviationData(animeList);
    expect(dev.samples.length).toBeGreaterThanOrEqual(5);
    const result = await preferenceProfile(animeList, 'metadata', { stream: false });
    expect(result.likes.length).toBeGreaterThanOrEqual(2);
    expect(result.preferenceProfile.length).toBeGreaterThan(8);
    log('## 偏好画像\n');
    log(`**${result.preferenceProfile}**\n`);
    log(`${result.tasteDeviation}\n`);
    result.likes.forEach((l) => log(`- 喜欢 ${l.aspect}（${Math.round(l.confidence * 100)}%）：${l.evidence}`));
    result.dislikes.forEach((d) => log(`- 雷区 ${d.aspect}（${Math.round(d.confidence * 100)}%）：${d.evidence}`));
    log('');
  }, 300000);

  it('Skill 4 · 单番深度分析', async () => {
    const scored = animeList
      .filter((a) => a.scores.some((s) => s.score > 0))
      .sort((a, b) => calcOverall(b) - calcOverall(a));
    const target = scored[0];
    expect(target).toBeTruthy();
    const result = await singleAnimeAnalysis(target, animeList, { stream: false });
    expect(result.coreAppeal.length).toBeGreaterThan(0);
    expect(result.vibePattern.length).toBeGreaterThan(4);
    log(`## 单番分析 · ${target.title}\n`);
    result.coreAppeal.forEach((c) => log(`- ${c.aspect}：${c.evidence}（${Math.round(c.confidence * 100)}%）`));
    log('');
    log(`电波模式：${result.vibePattern}\n`);
    log(`社区差距：${result.communityGap}\n`);
  }, 300000);

  it('Skill 6 · 智能打标签', async () => {
    const target = animeList.find((a) => a.tags.length > 0 && a.scores.some((s) => s.score > 0));
    expect(target).toBeTruthy();
    const result = await autoTag(target!);
    expect(Array.isArray(result.suggestedTags)).toBe(true);
    log(`## 自动打标签 · ${target!.title}\n`);
    log(`已有：${target!.tags.map((t) => t.name).join('、') || '无'}`);
    result.suggestedTags.forEach((t) => log(`- ${t.name}：${t.reason}`));
    log('');
  }, 300000);

  it('Skill 5 · 标签图谱优化', async () => {
    const result = await graphOptimize(animeList);
    expect(Array.isArray(result.merges)).toBe(true);
    log('## 标签图谱优化\n');
    result.merges.forEach((m) => log(`- 合并「${m.from}」→「${m.to}」：${m.reason}`));
    result.newTags.slice(0, 5).forEach((t) => log(`- 给「${t.anime}」加「${t.tag}」：${t.reason}`));
    result.issues.forEach((i) => log(`- 问题：${i}`));
    log('');
  }, 300000);

  it('Skill 3 · 发现新番', async () => {
    const result = await smartRecommend(animeList, null, (p) => log(`> ${p}`), {});
    expect(Array.isArray(result.recommendations)).toBe(true);
    log(`\n## 发现新番（来源：${result.sourceLabel || '未知'}，候选 ${result.candidateCount}）\n`);
    result.recommendations.forEach((r) => {
      log(`- **${r.title}**（${Math.round(r.confidence * 100)}%，${r.verified ? '已校验' : '未校验'}）`);
      log(`  ${r.intro}`);
      log(`  理由：${r.reason}`);
    });
    log('');

    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, report.join('\n'), 'utf-8');
    log(`\n报告已写入 ${REPORT_PATH}`);
  }, 600000);
});
