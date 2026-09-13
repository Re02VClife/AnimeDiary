/**
 * 数据补全面板
 *
 * 目的：把「手工逐条录入」变成「自动匹配 + 人工过目 + 一次写入」。
 *
 * 安全约束（这是本面板存在的意义，不能为了省事破坏）：
 *   1. **绝不自动写 Excel**。所有操作只产出建议，必须点「确认写入」才落盘。
 *   2. **不覆盖已有数据**。默认只填空白字段；外链海报是唯一例外（它们随时会失效），
 *      而且由用户显式勾选「替换外链海报」控制。
 *   3. **跨源评分不混用**。B 站评分 ≠ Bangumi 评分，只有 Bangumi 候选才会填 BGM 列。
 *   4. 封面先下载到本地再入库，写进 Excel 的是本地地址而不是外链。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, Button, Table, Tag, Select, Space, Alert, Progress, Typography,
  Tooltip, Checkbox, Radio, Empty, message, Spin,
} from 'antd';
import {
  ReloadOutlined, SearchOutlined, CloudDownloadOutlined,
  CheckCircleOutlined, WarningOutlined, StopOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AnimeEntry, ScoreTemplate } from '../../src/types';
import { DEFAULT_TEMPLATE_ID } from '../../src/types';
import {
  probeSources, searchCandidates, fetchDetail, downloadCover,
  pickBestMatch, keywordChain, LOW_CONFIDENCE, SOURCE_LABEL,
  type MediaCandidate, type MediaSource, type SourceStatus,
} from './media-service';
import { applyCompletionPatches, type CompletionPatch } from '../anime-data/excel-service';

const { Text } = Typography;

type FieldKey = 'poster' | 'releaseDate' | 'episodes' | 'studio' | 'bangumiScore' | 'link';

const FIELD_LABEL: Record<FieldKey, string> = {
  poster: '封面',
  releaseDate: '上映时间',
  episodes: '总集数',
  studio: '制作组',
  bangumiScore: 'BGM评分',
  link: '外部链接',
};

const DEFAULT_FIELDS: Record<FieldKey, boolean> = {
  poster: true,
  releaseDate: true,
  episodes: true,
  studio: true,
  bangumiScore: true,
  // 外部链接整列为空，补上便于跳转，但属于「锦上添花」，默认不勾
  link: false,
};

type RowStatus = 'idle' | 'searching' | 'matched' | 'none' | 'error' | 'downloading' | 'written';

interface Row {
  key: string;
  entry: AnimeEntry;
  keyword: string;
  candidates: MediaCandidate[];
  chosen: MediaCandidate | null;
  score: number;
  status: RowStatus;
  error?: string;
  selected: boolean;
  /** 已下载到本地的封面地址 */
  localCover?: string;
  /** 详情（写入时才拉取，用于补 search 拿不到的字段） */
  detail?: MediaCandidate | null;
  /** 实际写入的字段 */
  written?: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  /**
   * 当前模板。补全**默认只处理属于该模板的条目** —— 「番剧列表」这个 sheet 里
   * 混着游戏区（原神/崩铁/尘白禁区…）和角色卡模板的条目，
   * 拿 Bangumi 动画库 / B站番剧库去查它们的封面必然失败，纯属浪费请求和误导。
   */
  activeTemplateId: string;
  templates: ScoreTemplate[];
  /** 写入成功后重载数据 */
  onApplied: () => Promise<void> | void;
}

/** 海报是否「需要处理」 */
function posterNeedsWork(entry: AnimeEntry, replaceHotlink: boolean): boolean {
  const p = String(entry.posterUrl || '').trim();
  if (!p) return true;
  if (p.startsWith('/api/')) return false; // 已是本地文件
  if (p.startsWith('data:')) return true; // base64 不该出现，转存掉
  if (/^https?:\/\//i.test(p)) return replaceHotlink; // 外链脆弱
  return true;
}

/** 该条目在所选字段下缺哪些 */
function missingFields(entry: AnimeEntry, fields: Record<FieldKey, boolean>, replaceHotlink: boolean): FieldKey[] {
  const out: FieldKey[] = [];
  if (fields.poster && posterNeedsWork(entry, replaceHotlink)) out.push('poster');
  if (fields.releaseDate && !String(entry.releaseDate || '').trim()) out.push('releaseDate');
  if (fields.episodes && !entry.episodes) out.push('episodes');
  if (fields.studio && !String(entry.studio || '').trim()) out.push('studio');
  if (fields.bangumiScore && !entry.bangumiScore) out.push('bangumiScore');
  if (fields.link && !String(entry.link || '').trim()) out.push('link');
  return out;
}

const STATUS_TAG: Record<RowStatus, { color: string; text: string }> = {
  idle: { color: 'default', text: '待匹配' },
  searching: { color: 'processing', text: '搜索中' },
  matched: { color: 'success', text: '已匹配' },
  none: { color: 'warning', text: '未找到' },
  error: { color: 'error', text: '失败' },
  downloading: { color: 'processing', text: '处理中' },
  written: { color: 'blue', text: '已写入' },
};

export default function MediaCompleteModal({ open, onClose, animeList, activeTemplateId, templates, onApplied }: Props) {
  const [status, setStatus] = useState<SourceStatus[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [fields, setFields] = useState<Record<FieldKey, boolean>>(DEFAULT_FIELDS);
  const [replaceHotlink, setReplaceHotlink] = useState(true);
  /** 顺便修正「检索名」列（该列存在既有错位，默认关闭：它属于覆盖已有数据） */
  const [fixAlias, setFixAlias] = useState(false);
  /**
   * 是否允许写入低置信度匹配。默认关闭 ——
   * 低置信度意味着「标题对不上」，写进去大概率是错的封面/上映时间。
   * 需要时由用户显式打开（用于人工核对过的情况）。
   */
  const [allowLowConfidence, setAllowLowConfidence] = useState(false);
  /** 是否把其他模板（游戏区/角色卡）的条目也一起纳入扫描。默认关闭 */
  const [includeOtherTemplates, setIncludeOtherTemplates] = useState(false);
  const [primarySource, setPrimarySource] = useState<'auto' | MediaSource>('auto');

  const templateName = useMemo(
    () => templates.find((t) => t.id === activeTemplateId)?.name || activeTemplateId,
    [templates, activeTemplateId],
  );
  /** 当前模板下的条目（补全的默认作用范围） */
  const templateEntries = useMemo(
    () => (includeOtherTemplates
      ? animeList
      : animeList.filter((e) => (e.templateId || DEFAULT_TEMPLATE_ID) === activeTemplateId)),
    [animeList, includeOtherTemplates, activeTemplateId],
  );
  const otherTemplateCount = animeList.length - templateEntries.length;

  /**
   * 每个检索名在整张表里出现了几次。
   *
   * 用来判定「这个检索名可不可信」：实测这份 Excel 的检索名列有 23 处错位，
   * 而错位的特征恰恰是**同一个检索名被多条复用**
   * （「利兹与青鸟」和「玉子爱情故事」都写着 トニカクカワイイ）。
   * 因此只把「表内唯一」的检索名当作可信 —— 它往往是用户认真填的日文原名，
   * 用它做身份确认能救回「辉夜大小姐想让我告白3」这类数据源用副标题表示季数的条目，
   * 同时又不会重新引入错位检索名带来的误配。
   */
  const aliasFrequency = useMemo(() => {
    const freq = new Map<string, number>();
    for (const e of animeList) {
      const a = String(e.searchAlias || '').trim();
      if (a) freq.set(a, (freq.get(a) || 0) + 1);
    }
    return freq;
  }, [animeList]);

  /** 取该条目可信的检索名（最多一个） */
  const trustedAliasOf = useCallback(
    (entry: AnimeEntry): string[] => {
      const a = String(entry.searchAlias || '').trim();
      if (!a) return [];
      return aliasFrequency.get(a) === 1 ? [a] : [];
    },
    [aliasFrequency],
  );

  const [busy, setBusy] = useState<'matching' | 'writing' | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [log, setLog] = useState<string[]>([]);

  /** 停止标志（批量过程中可中断） */
  const cancelledRef = useRef(false);
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  const sourceOk = useMemo(() => {
    const map: Partial<Record<MediaSource, boolean>> = {};
    for (const s of status || []) map[s.source] = s.ok;
    return map;
  }, [status]);

  const bangumiAvailable = sourceOk.bangumi === true;
  const bilibiliAvailable = sourceOk.bilibili === true;
  const anySourceOk = bangumiAvailable || bilibiliAvailable;

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-199), line]);
  }, []);

  const handleProbe = useCallback(async (force: boolean) => {
    setProbing(true);
    try {
      const result = await probeSources(force);
      setStatus(result);
      // 刻意**不**因为探测到 Bangumi 不可用就把搜索源钉死在 B 站。
      // 本机代理会反复通/断，一次探测失败并不代表整轮都不可用；
      // 而 source='auto' 由服务端逐次判断（探测缓存 + 连续失败熔断 + 每源超时上限），
      // 代理恢复的下一刻就能重新用上 Bangumi。
      // 需要固定单一源时，用户可以用下面的单选按钮显式指定。
    } catch (e) {
      message.error(`探测数据源失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProbing(false);
    }
  }, []);

  // 打开时自动探测一次（服务端有缓存，很快）
  useEffect(() => {
    if (open && status === null) void handleProbe(false);
  }, [open, status, handleProbe]);

  // ── 扫描待补全清单 ──
  const handleScan = useCallback(() => {
    const list: Row[] = [];
    let skippedOtherTemplate = 0;
    for (const entry of templateEntries) {
      if (entry.excelRowIndex === undefined) continue; // 未落盘的条目无法写回
      const missing = missingFields(entry, fields, replaceHotlink);
      if (missing.length === 0) continue;
      list.push({
        key: entry.id,
        entry,
        // 检索词按源取首个候选：B 站要中文名，Bangumi 要日文检索名
        keyword: keywordChain(entry, primarySource)[0] || entry.title,
        candidates: [],
        chosen: null,
        score: 0,
        status: 'idle',
        // 刻意**默认全不勾选**：补全要由你自己挑需要处理的番，
        // 一次把上百条全丢给外部接口既没必要，也更容易招风控、更容易写错。
        selected: false,
      });
    }
    // 统计被模板过滤掉的条目（不是番剧的那些）
    if (!includeOtherTemplates) skippedOtherTemplate = otherTemplateCount;
    setRows(list);
    setProgress({ done: 0, total: 0 });
    setLog([]);
    appendLog(`扫描完成：模板「${templateName}」下共 ${templateEntries.length} 条，其中 ${list.length} 条存在缺失 —— 请勾选需要补全的番，再点「自动匹配」`);
    if (skippedOtherTemplate > 0) {
      appendLog(`已跳过 ${skippedOtherTemplate} 条属于其他模板的条目（游戏区 / 角色卡等，番剧库查不到它们的封面）。需要时勾选「包含其他模板的条目」`);
    }
  }, [templateEntries, otherTemplateCount, includeOtherTemplates, templateName, fields, replaceHotlink, primarySource, appendLog]);

  // ── 自动匹配（只处理已勾选、且尚未匹配成功的行）──
  const handleMatch = useCallback(async () => {
    const targets = rowsRef.current.filter((r) => r.selected && r.status !== 'matched' && r.status !== 'written');
    if (targets.length === 0) {
      message.info('请先勾选需要补全的番（匹配只对已勾选的行生效）');
      return;
    }
    setBusy('matching');
    cancelledRef.current = false;
    setProgress({ done: 0, total: targets.length });
    let matched = 0;
    let none = 0;
    let failed = 0;
    let consecutiveBlocked = 0;

    for (let i = 0; i < targets.length; i++) {
      if (cancelledRef.current) {
        appendLog('已停止匹配');
        break;
      }
      const row = targets[i];
      row.status = 'searching';
      row.error = undefined;
      setRows([...rowsRef.current]);
      try {
        // 检索词回退链：首个词没结果时依次换下一个（最多 3 次，控制请求量）。
        // 第 3 个位置是「去掉季数标记的主标题」，专门救 "XX3" 这类在数据源上
        // 用副标题区分的续作 —— 保证候选列表不是空的，用户还能手动挑。
        const chain = keywordChain(row.entry, primarySource);
        const tries = [row.keyword, ...chain].filter((x, idx, arr) => x && arr.indexOf(x) === idx).slice(0, 3);
        let candidates: MediaCandidate[] = [];
        let lastError = '';
        for (const kw of tries) {
          const outcome = await searchCandidates(kw, primarySource, 8);
          candidates = outcome.candidates;
          lastError = Object.entries(outcome.errors)
            .map(([k, v]) => `${SOURCE_LABEL[k as MediaSource] ?? k}: ${v}`)
            .join('；');
          if (candidates.length > 0) {
            row.keyword = kw; // 记录实际命中的检索词，便于人工核对
            break;
          }
        }

        if (candidates.length === 0) {
          row.candidates = [];
          row.status = 'none';
          row.chosen = null;
          row.score = 0;
          row.error = lastError || '没有搜索结果';
          none++;
          // 连续被风控（412/429）说明该停手了，继续打只会加重
          if (/412|429|风控|too many/i.test(lastError)) {
            consecutiveBlocked++;
            if (consecutiveBlocked >= 5) {
              appendLog('连续多次被数据源风控（412/429），已自动停止。请等待几分钟后重新点「自动匹配」继续。');
              setRows([...rowsRef.current]);
              break;
            }
          } else {
            consecutiveBlocked = 0;
          }
        } else {
          row.candidates = candidates;
          // ⚠️ 打分只依据「名字」列（entry.title / titleJa），不用检索词 ——
          // 这份 Excel 的检索名列存在既有错位，用它打分会把不相干的番剧判成 100% 命中。
          // 但**表内唯一**的检索名是可信的（错位的那些都是被多条复用的），
          // 单独作为身份确认传进去，见 trustedAliasOf 的说明。
          const best = pickBestMatch(
            candidates,
            [row.entry.title, row.entry.titleJa || ''],
            row.entry.releaseDate,
            trustedAliasOf(row.entry),
          );
          row.chosen = best?.candidate ?? candidates[0];
          row.score = best?.score ?? 0;
          row.status = 'matched';
          matched++;
          consecutiveBlocked = 0;
        }
      } catch (e) {
        row.status = 'error';
        row.error = e instanceof Error ? e.message : String(e);
        failed++;
      }
      setRows([...rowsRef.current]);
      setProgress({ done: i + 1, total: targets.length });
    }

    appendLog(`匹配完成：成功 ${matched}，未找到 ${none}，失败 ${failed}`);
    setBusy(null);
  }, [primarySource, trustedAliasOf, appendLog]);

  // ── 确认写入 ──
  /** 可写入的行：已勾选 + 已有匹配 + 尚未写入 +（置信度达标 或 用户显式允许低置信度） */
  const isWritable = useCallback(
    (r: Row) =>
      r.selected && !!r.chosen && r.status !== 'written' &&
      (allowLowConfidence || r.score >= LOW_CONFIDENCE),
    [allowLowConfidence],
  );

  const handleWrite = useCallback(async () => {
    const list = rowsRef.current.filter(isWritable);
    if (list.length === 0) {
      message.info('没有可写入的行：请先勾选番剧并完成匹配（低置信度的匹配默认不写入）');
      return;
    }

    setBusy('writing');
    cancelledRef.current = false;
    setProgress({ done: 0, total: list.length });
    const patches: CompletionPatch[] = [];
    let downloaded = 0;
    let downloadFailed = 0;
    /**
     * 详情接口的失败计数 + 熔断开关。
     *
     * 详情只是「锦上添花」（制作组 / 上映 / 集数），但服务端每次最多要等 8 秒。
     * 代理抖动时如果逐条都去撞这个超时，146 条就是 19 分钟的纯等待。
     * 连续失败 3 次就整批跳过详情 —— 封面下载与字段写入都不依赖它。
     */
    let detailFailures = 0;
    let detailDisabled = false;

    for (let i = 0; i < list.length; i++) {
      if (cancelledRef.current) {
        appendLog('已停止写入');
        break;
      }
      const row = list[i];
      const chosen = row.chosen!;
      row.status = 'downloading';
      row.error = undefined;
      setRows([...rowsRef.current]);

      // 只有「搜索候选本身也没有」我们仍需要的字段时，才值得多打一次详情请求。
      // （原先只看 entry 缺不缺，于是几乎每条都要查详情，白白多出一倍请求量）
      const needDetail =
        (fields.releaseDate && !String(row.entry.releaseDate || '').trim() && !chosen.releaseDate) ||
        (fields.episodes && !row.entry.episodes && !chosen.episodes) ||
        (fields.studio && !String(row.entry.studio || '').trim() && !chosen.studio);

      try {
        // 1. 详情（只在确有必要时多打一次请求）
        let detail = row.detail ?? null;
        if (needDetail && !detail && !detailDisabled) {
          try {
            detail = await fetchDetail(chosen.source, chosen.sourceId);
            row.detail = detail;
            detailFailures = 0;
          } catch (e) {
            detailFailures++;
            appendLog(`「${row.entry.title}」详情获取失败：${e instanceof Error ? e.message : String(e)}`);
            if (detailFailures >= 3 && !detailDisabled) {
              detailDisabled = true;
              appendLog('详情接口连续失败，本次已跳过后续所有详情请求（只影响制作组/上映/集数；封面与写入不受影响）');
            }
          }
        }
        const merged: MediaCandidate = { ...chosen, ...(detail || {}), source: chosen.source, sourceId: chosen.sourceId };

        // 2. 封面下载到本地
        let localCover: string | undefined;
        if (fields.poster && posterNeedsWork(row.entry, replaceHotlink) && merged.coverUrl) {
          if (merged.coverUrl.startsWith('/api/')) {
            localCover = merged.coverUrl;
          } else {
            const dl = await downloadCover(row.entry.title, merged.coverUrl);
            localCover = dl.url;
            row.localCover = dl.url;
            downloaded++;
          }
        }

        // 3. 组装补丁 —— 只填空白字段，绝不覆盖已有数据
        const patch: CompletionPatch = { entry: row.entry };
        const written: string[] = [];
        if (localCover) { patch.posterUrl = localCover; written.push(FIELD_LABEL.poster); }
        if (fields.releaseDate && merged.releaseDate && !String(row.entry.releaseDate || '').trim()) {
          patch.releaseDate = merged.releaseDate;
          written.push(FIELD_LABEL.releaseDate);
        }
        if (fields.episodes && merged.episodes && !row.entry.episodes) {
          patch.episodes = merged.episodes;
          written.push(FIELD_LABEL.episodes);
        }
        if (fields.studio && merged.studio && !String(row.entry.studio || '').trim()) {
          patch.studio = merged.studio;
          written.push(FIELD_LABEL.studio);
        }
        // ⚠️ 只有 Bangumi 候选才有资格填 BGM 评分列（B 站候选的 score 恒为 null）
        if (fields.bangumiScore && chosen.source === 'bangumi' && merged.score && !row.entry.bangumiScore) {
          patch.bangumiScore = merged.score;
          written.push(FIELD_LABEL.bangumiScore);
        }
        if (fields.link && merged.link && !String(row.entry.link || '').trim()) {
          patch.link = merged.link;
          written.push(FIELD_LABEL.link);
        }
        // 修正检索名：只对高置信度匹配做，且必须用户显式开启
        if (fixAlias && row.score >= LOW_CONFIDENCE && merged.title && merged.title !== row.entry.title) {
          patch.searchAlias = merged.title;
          written.push('检索名');
        }

        row.written = written;
        if (written.length > 0) patches.push(patch);
        row.status = 'matched';
      } catch (e) {
        row.status = 'error';
        row.error = e instanceof Error ? e.message : String(e);
        if (String(row.error).includes('封面') || String(row.error).includes('下载')) downloadFailed++;
      }
      setRows([...rowsRef.current]);
      setProgress({ done: i + 1, total: list.length });
    }

    // 4. 一次性写入（服务器端做写前身份校验，冲突则整批拒绝）
    if (patches.length > 0) {
      try {
        const count = await applyCompletionPatches(patches);
        appendLog(`已写入 ${patches.length} 条 / ${count} 个单元格（封面新下载 ${downloaded} 张）`);
        for (const row of list) {
          if (row.written && row.written.length > 0) row.status = 'written';
        }
        setRows([...rowsRef.current]);
        message.success(`补全完成：${patches.length} 条已写入 Excel`);
        await onApplied();
      } catch (e) {
        message.error(`写入失败：${e instanceof Error ? e.message : String(e)}`);
        appendLog(`写入失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      message.info('没有产生任何可写入的字段');
    }

    if (downloadFailed > 0) appendLog(`有 ${downloadFailed} 张封面下载失败（该行其余字段仍会写入）`);
    setBusy(null);
  }, [fields, replaceHotlink, fixAlias, bangumiAvailable, bilibiliAvailable, appendLog, onApplied]);

  // ── 行操作 ──
  const patchRow = useCallback((key: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const researchRow = useCallback(async (row: Row, source: 'auto' | MediaSource) => {
    patchRow(row.key, { status: 'searching', error: undefined });
    try {
      const { candidates, errors } = await searchCandidates(row.keyword, source, 8);
      const best = pickBestMatch(
        candidates,
        [row.entry.title, row.entry.titleJa || ''],
        row.entry.releaseDate,
        trustedAliasOf(row.entry),
      );
      patchRow(row.key, {
        candidates,
        chosen: best?.candidate ?? candidates[0] ?? null,
        score: best?.score ?? 0,
        status: candidates.length > 0 ? 'matched' : 'none',
        error: candidates.length > 0 ? undefined : Object.values(errors)[0] || '没有搜索结果',
        detail: null,
      });
    } catch (e) {
      patchRow(row.key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [patchRow, trustedAliasOf]);

  const selectedRows = rows.filter((r) => r.selected);
  const writableRows = selectedRows.filter(isWritable);
  const matchableRows = selectedRows.filter((r) => r.status !== 'matched' && r.status !== 'written');
  const lowConfidence = rows.filter((r) => r.selected && r.chosen && r.score < LOW_CONFIDENCE).length;

  const columns: ColumnsType<Row> = useMemo(() => [
    {
      title: '封面',
      width: 74,
      render: (_, row) => {
        const src = row.localCover || (row.chosen?.coverUrl
          ? (row.chosen.coverUrl.startsWith('/api/')
            ? row.chosen.coverUrl
            : `/api/images/proxy?url=${encodeURIComponent(row.chosen.coverUrl)}`)
          : '');
        return src
          ? <img src={src} alt="" style={{ width: 46, height: 64, objectFit: 'cover', borderRadius: 3, background: 'var(--bg-quaternary)' }} />
          : <div style={{ width: 46, height: 64, borderRadius: 3, background: 'var(--bg-quaternary)' }} />;
      },
    },
    {
      title: '番剧',
      width: 200,
      render: (_, row) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.entry.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {row.entry.releaseDate || '无上映'} · {row.entry.bangumiScore ? `BGM ${row.entry.bangumiScore}` : '无BGM'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            缺失：{missingFields(row.entry, fields, replaceHotlink).map((f) => FIELD_LABEL[f]).join('、') || '—'}
          </div>
        </div>
      ),
    },
    {
      title: '检索词',
      width: 170,
      render: (_, row) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          value={row.keyword}
          onChange={(v) => patchRow(row.key, { keyword: v, chosen: null, score: 0, status: 'idle', candidates: [] })}
          options={[row.entry.searchAlias, row.entry.title, row.entry.titleJa]
            .filter((x): x is string => !!x && x.trim() !== '')
            .filter((x, i, arr) => arr.indexOf(x) === i)
            .map((x) => ({ value: x, label: x }))}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      title: '匹配结果',
      render: (_, row) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder={row.status === 'searching' ? '搜索中…' : '未匹配'}
            value={row.chosen ? `${row.chosen.source}:${row.chosen.sourceId}` : undefined}
            onChange={(v) => {
              const found = row.candidates.find((c) => `${c.source}:${c.sourceId}` === v);
              if (found) patchRow(row.key, { chosen: found, detail: null });
            }}
            options={row.candidates.map((c) => ({
              value: `${c.source}:${c.sourceId}`,
              // 只有 Bangumi 的评分才是可信的 BGM 分；B 站候选不显示评分
              label: `[${SOURCE_LABEL[c.source]}] ${c.titleCn || c.title}${c.releaseDate ? ` (${c.releaseDate})` : ''}${c.source === 'bangumi' && c.score ? ` ★${c.score}` : ''}`,
            }))}
            showSearch
            optionFilterProp="label"
          />
          <Space size={4}>
            {row.chosen && row.score < LOW_CONFIDENCE && (
              <Tooltip title={`相似度仅 ${(row.score * 100).toFixed(0)}%，建议人工确认`}>
                <Tag color="warning" style={{ marginInlineEnd: 0 }}><WarningOutlined /> 低置信度 {(row.score * 100).toFixed(0)}%</Tag>
              </Tooltip>
            )}
            {row.chosen && row.score >= LOW_CONFIDENCE && (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>{(row.score * 100).toFixed(0)}%</Tag>
            )}
            <Button size="small" type="link" icon={<SearchOutlined />} disabled={busy !== null}
              onClick={() => void researchRow(row, primarySource)}>重搜</Button>
            <Button size="small" type="link" disabled={busy !== null || !bilibiliAvailable}
              onClick={() => void researchRow(row, 'bilibili')}>用B站搜</Button>
          </Space>
        </Space>
      ),
    },
    {
      title: '状态',
      width: 160,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Tag color={STATUS_TAG[row.status].color}>{STATUS_TAG[row.status].text}</Tag>
          {row.chosen && row.score < LOW_CONFIDENCE && (
            <span style={{ fontSize: 11, color: '#faad14' }}>
              低置信度{(row.score * 100).toFixed(0)}%{allowLowConfidence ? '（允许写入）' : '·不会写入'}
            </span>
          )}
          {row.written && row.written.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>写入：{row.written.join('、')}</span>
          )}
          {row.error && (
            <Tooltip title={row.error}>
              <span style={{ fontSize: 11, color: 'var(--color-error, #ff7875)' }}>
                {row.error.length > 24 ? row.error.slice(0, 24) + '…' : row.error}
              </span>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ], [fields, replaceHotlink, primarySource, busy, bilibiliAvailable, allowLowConfidence, patchRow, researchRow]);

  return (
    <Modal
      open={open}
      onCancel={() => { if (busy) { cancelledRef.current = true; } else { onClose(); } }}
      width={1180}
      className="media-complete-modal"
      title="数据补全 — 从 Bangumi / Bilibili 自动获取元数据与封面"
      footer={null}
      destroyOnClose={false}
      maskClosable={busy === null}
    >
      {/* ── 数据源状态 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <Text strong>数据源</Text>
        {status === null ? (
          <Spin size="small" />
        ) : (
          status.map((s) => (
            <Tooltip key={s.source} title={s.ok ? `${s.latencyMs}ms` : s.error || '不可达'}>
              <Tag color={s.ok ? 'success' : 'error'}>
                {SOURCE_LABEL[s.source]} {s.ok ? `可用 ${s.latencyMs}ms` : '不可用'}
              </Tag>
            </Tooltip>
          ))
        )}
        <Button size="small" icon={<ReloadOutlined />} loading={probing} onClick={() => void handleProbe(true)}>
          重新检测
        </Button>
        <Tag color="blue">作用范围：{includeOtherTemplates ? '全部条目' : `模板「${templateName}」`}</Tag>
        {!bangumiAvailable && (
          <Text type="warning" style={{ fontSize: 12 }}>
            Bangumi 需要代理才能连通（本机 Clash 未生效时会不可用）；Bilibili 国内直连，可单独使用。
          </Text>
        )}
      </div>

      {/* ── 选项 ── */}
      <div style={{ padding: 12, background: 'var(--bg-quaternary)', borderRadius: 6, marginBottom: 12 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap size={16}>
            <Text>补全字段：</Text>
            {(Object.keys(FIELD_LABEL) as FieldKey[]).map((f) => (
              <Checkbox key={f} checked={fields[f]} onChange={(e) => setFields((p) => ({ ...p, [f]: e.target.checked }))}>
                {FIELD_LABEL[f]}
              </Checkbox>
            ))}
          </Space>
          <Space wrap size={16}>
            <Text>搜索源：</Text>
            <Radio.Group size="small" value={primarySource} onChange={(e) => setPrimarySource(e.target.value)}>
              <Radio.Button value="auto" disabled={!bangumiAvailable}>自动（优先 Bangumi）</Radio.Button>
              <Radio.Button value="bangumi" disabled={!bangumiAvailable}>仅 Bangumi</Radio.Button>
              <Radio.Button value="bilibili" disabled={!bilibiliAvailable}>仅 Bilibili</Radio.Button>
            </Radio.Group>
            <Checkbox checked={replaceHotlink} onChange={(e) => setReplaceHotlink(e.target.checked)}>
              替换外链海报（推荐：外链随时会失效，替换为本地文件）
            </Checkbox>
            <Checkbox checked={fixAlias} onChange={(e) => setFixAlias(e.target.checked)}>
              顺便修正「检索名」列（该列有 23 处疑似错位；仅对高置信度匹配生效）
            </Checkbox>
            <Checkbox checked={allowLowConfidence} onChange={(e) => setAllowLowConfidence(e.target.checked)}>
              允许写入低置信度匹配（默认关闭，核对过再开）
            </Checkbox>
            <Checkbox checked={includeOtherTemplates} onChange={(e) => setIncludeOtherTemplates(e.target.checked)}>
              包含其他模板的条目{otherTemplateCount > 0 ? `（${otherTemplateCount} 条游戏区/角色卡，番剧库查不到）` : ''}
            </Checkbox>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            ① 先勾选需要补全的番 → ② 点「自动匹配」→ ③ 核对结果 → ④ 点「确认写入」。
            只填空缺字段，不覆盖你已有的评分 / 评价 / 标签 / 备注；低置信度的匹配默认不写入。
            <b>评分只取自 Bangumi</b>（B 站评分口径不同，已完全不采用）。
          </Text>
        </Space>
      </div>

      {/* ── 操作栏 ── */}
      <Space wrap style={{ marginBottom: 12 }}>
        <Button icon={<SearchOutlined />} onClick={handleScan} disabled={busy !== null || !anySourceOk}>
          扫描待补全（{templateEntries.length} 条中）
        </Button>
        <Button type="primary" icon={<SearchOutlined />} onClick={() => void handleMatch()}
          disabled={busy !== null || matchableRows.length === 0} loading={busy === 'matching'}>
          自动匹配（已勾选 {matchableRows.length} 条）
        </Button>
        <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => void handleWrite()}
          disabled={busy !== null || writableRows.length === 0} loading={busy === 'writing'}>
          确认写入（{writableRows.length} 条）
        </Button>
        {busy && (
          <Button danger icon={<StopOutlined />} onClick={() => { cancelledRef.current = true; }}>停止</Button>
        )}
        {rows.length > 0 && (
          <>
            <Button size="small" onClick={() => setRows((p) => p.map((r) => ({ ...r, selected: true })))} disabled={busy !== null}>全选</Button>
            <Button size="small" onClick={() => setRows((p) => p.map((r) => ({ ...r, selected: false })))} disabled={busy !== null}>全不选</Button>
            <Button size="small"
              onClick={() => setRows((p) => p.map((r) => ({ ...r, selected: !!r.chosen && r.score < LOW_CONFIDENCE })))}
              disabled={busy !== null}>只选低置信度</Button>
          </>
        )}
      </Space>

      {busy && progress.total > 0 && (
        <Progress percent={Math.round((progress.done / progress.total) * 100)}
          format={() => `${progress.done}/${progress.total}`} style={{ marginBottom: 8 }} />
      )}

      {!anySourceOk && status !== null && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
          message="所有数据源都不可用"
          description="Bangumi 需要代理；Bilibili 需要能直连 api.bilibili.com。请检查网络或 Clash 是否正常后点「重新检测」。" />
      )}

      {lowConfidence > 0 && !allowLowConfidence && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`已勾选的行里有 ${lowConfidence} 条匹配置信度偏低，本次不会写入`}
          description="置信度按「名字」列（真实标题）计算，不按检索词 —— 检索名列存在错位时，检索词可能召回完全不相干的番剧。核对无误后可勾选「允许写入低置信度匹配」，或点「只选低置信度」逐条处理。" />
      )}

      {rows.length === 0 ? (
        <Empty description={anySourceOk ? '点「扫描待补全」列出有缺失的番剧，然后勾选需要补全的番' : '等待数据源可用'} />
      ) : (
        <Table<Row>
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ y: 420 }}
          rowSelection={{
            selectedRowKeys: rows.filter((r) => r.selected).map((r) => r.key),
            onChange: (keys) => {
              const set = new Set(keys as string[]);
              setRows((p) => p.map((r) => ({ ...r, selected: set.has(r.key) })));
            },
          }}
        />
      )}

      {log.length > 0 && (
        <div style={{
          marginTop: 12, maxHeight: 110, overflow: 'auto', fontSize: 12,
          background: 'var(--bg-quaternary)', borderRadius: 4, padding: 8,
          fontFamily: 'monospace', whiteSpace: 'pre-wrap',
        }}>
          {log.slice(-60).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      <div style={{ marginTop: 12, textAlign: 'right' }}>
        <Button onClick={() => { if (busy) cancelledRef.current = true; else onClose(); }}>
          {busy ? '停止并关闭' : '关闭'}
        </Button>
      </div>
    </Modal>
  );
}
