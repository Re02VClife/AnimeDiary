/**
 * 角色补全面板
 *
 * 与「数据补全」（番剧元数据）同一套交互原则：
 *   1. 默认**一个都不选**，你必须先手动勾要处理哪些作品。
 *   2. 解析只产出建议 —— 勾选哪些角色、要不要建卡，全由你决定。
 *   3. 生成角色卡是**末尾追加新行**（或按你的选择合并进已有卡），不改动评分/评价。
 *
 * 解析刻意拆成三步，否则一次请求要十几秒而中途没有任何反馈：
 *   找到作品 → 拉角色列表（立刻显示立绘）→ 按小批抓详情（进度条按角色推进）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Table, Tag, Space, Typography, Select, Checkbox, Progress, Alert, Tooltip, Empty, Input, Radio } from 'antd';
import { CloudDownloadOutlined, ReloadOutlined, UserAddOutlined, PictureOutlined, SearchOutlined, MergeCellsOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AnimeEntry, ScoreTemplate, TemplateGenre } from '../../src/types';
import { CHARACTER_TEMPLATE_ID, DEFAULT_TEMPLATE_ID } from '../../src/types';
import { LOW_CONFIDENCE } from '../../core/character';
import { appendAnimeEntry, saveCharacterNames, saveCharacterCardData } from '../anime-data/excel-service';
import { catgirlMessage } from '../../src/theme';
import {
  resolveWork, fetchCharacterList, fetchCharacterDetails, mergeDetailIntoListed,
  downloadPortrait, matchRecordedNames, buildCharacterCardEntry, mergeCharacterCardData,
  resolveSubjectTypes, WORK_TYPE_OPTIONS,
} from './character-service';
import type { CharacterEntry, WorkCandidate, RecordedMatch, WorkTypeOverride } from './character-service';
import CharacterMergeModal from './CharacterMergeModal';
import { buildDuplicateGroups } from './merge-duplicates';

const { Text } = Typography;

/** 每批抓多少个角色详情 —— 进度条按批推进，也让单次请求不至于排几分钟的节流队列 */
const DETAIL_CHUNK = 8;
/** 候选头像尺寸。原来是 20×26，太小看不清是谁 */
const THUMB_W = 56;
const THUMB_H = 74;
/** 横向滚动条里最多渲染多少个候选 */
const MAX_CHIPS = 60;
/** Excel 只有 4 列角色名 */
const MAX_CHARACTER_SLOTS = 4;

type RowStatus = 'idle' | 'resolving' | 'ready' | 'error';
type SortMode = 'relation' | 'name' | 'popularity';
/** 遇到同名角色卡时的处理方式 */
type DupAction = 'merge' | 'create' | 'skip';

const DUP_LABEL: Record<DupAction, string> = { merge: '合并', create: '新建', skip: '跳过' };
const DUP_COLOR: Record<DupAction, string> = { merge: 'blue', create: 'orange', skip: 'default' };

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: 'relation', label: '按关系（主角优先）' },
  { value: 'name', label: '按名称' },
  { value: 'popularity', label: '按人气' },
];

interface Row {
  entry: AnimeEntry;
  recorded: string[];
  status: RowStatus;
  /** 当前阶段的中文说明（显示在表格里） */
  phase: string;
  work: WorkCandidate | null;
  workScore: number;
  workLowConfidence: boolean;
  characters: CharacterEntry[];
  matches: RecordedMatch[];
  /** 勾选要建卡/合并的角色 sourceId */
  picked: Set<string>;
  /**
   * sourceId → **已存在的同名角色卡**。
   * 同系列续作、客串会让同一角色在多部作品里出现，从不同作品解析时
   * 各自建卡就重复了（实测 101 张卡里有 10 组同名）。默认对这些走「合并」。
   *
   * 为什么不能只比名字：卡片标题是「建卡时用的名字」（可能是记录在番剧里的
   * 「蕾娜」），而解析出来的是「弗拉迪蕾娜·米丽洁」—— 只比显示名会漏判。
   */
  existingCards: Map<string, AnimeEntry>;
  /** sourceId → 处理方式；缺省时按是否已有卡决定 */
  dupActions: Map<string, DupAction>;
  errors: string[];
  ms?: number;
}

interface CharacterCompleteModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  activeTemplateId: string;
  templates: ScoreTemplate[];
  /** 生成完成后回调（静默刷新，不要用会触发整屏 loading 的 fetchData） */
  onApplied: () => void;
}

interface ProgressState {
  worksDone: number;
  worksTotal: number;
  phase: string;
  detailDone: number;
  detailTotal: number;
}

const CharacterCompleteModal: React.FC<CharacterCompleteModalProps> = ({
  open, onClose, animeList, activeTemplateId, templates, onApplied,
}) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [typeOverride, setTypeOverride] = useState<WorkTypeOverride>('auto');
  const [withAniList, setWithAniList] = useState(true);
  const [withPortrait, setWithPortrait] = useState(true);
  const [includeNoRecorded, setIncludeNoRecorded] = useState(false);
  const [dupDefault, setDupDefault] = useState<DupAction>('merge');
  const [sortMode, setSortMode] = useState<SortMode>('relation');
  const [nameFilter, setNameFilter] = useState('');
  const [resolving, setResolving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const cancelledRef = useRef(false);

  /**
   * 作品来源模板。
   *
   * 角色卡本身不能当来源：rebuild 第一步就把角色卡排除了，若此时「作用范围」
   * 还是角色模板，两个条件相乘就是空集 —— 在角色模板下打开面板会看到一张空表。
   * 所以当前模板是角色模板时退回默认（番剧）模板。
   */
  const sourceTemplateId = activeTemplateId === CHARACTER_TEMPLATE_ID ? DEFAULT_TEMPLATE_ID : activeTemplateId;

  const templateName = useMemo(
    () => templates.find((t) => t.id === sourceTemplateId)?.name || sourceTemplateId,
    [templates, sourceTemplateId],
  );

  /** 是否因为「当前看的是角色模板」而自动改用了番剧模板（界面上要说明） */
  const scopeFallback = activeTemplateId === CHARACTER_TEMPLATE_ID;

  /** 所有已有角色卡，按标题索引（用于同名检测/合并） */
  const cardByTitle = useMemo(() => {
    const map = new Map<string, AnimeEntry>();
    for (const a of animeList) {
      if (a.templateId !== CHARACTER_TEMPLATE_ID) continue;
      const key = a.title.trim();
      if (key && !map.has(key)) map.set(key, a);
    }
    return map;
  }, [animeList]);

  /** 重建候选行 */
  const rebuild = useCallback(() => {
    const genreOf = (templateId?: string): TemplateGenre | undefined =>
      templates.find((t) => t.id === (templateId || DEFAULT_TEMPLATE_ID))?.applicableGenre;

    const next: Row[] = animeList
      .filter((a) => a.templateId !== CHARACTER_TEMPLATE_ID)
      .filter((a) => includeNoRecorded || (a.templateId || DEFAULT_TEMPLATE_ID) === sourceTemplateId)
      .map((a) => ({
        entry: a,
        recorded: (a.characters || []).map((c) => String(c).trim()).filter(Boolean),
        status: 'idle' as RowStatus,
        phase: '',
        work: null,
        workScore: 0,
        workLowConfidence: false,
        characters: [],
        matches: [],
        picked: new Set<string>(),
        existingCards: new Map<string, AnimeEntry>(),
        dupActions: new Map<string, DupAction>(),
        errors: [],
        _genre: genreOf(a.templateId),
      } as Row))
      // 默认只列「已经填过角色名」的（可操作）；没填的按需显示
      .filter((r) => includeNoRecorded || r.recorded.length > 0);

    setRows(next);
    setSelectedKeys([]);
    setProgress(null);
  }, [animeList, templates, sourceTemplateId, includeNoRecorded]);

  useEffect(() => {
    if (!open) { cancelledRef.current = true; return; }
    cancelledRef.current = false;
    rebuild();
  }, [open, rebuild]);

  const patchRow = useCallback((entryId: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.entry.id === entryId ? { ...r, ...patch } : r)));
  }, []);

  // ── 解析（分三步，带进度） ──

  const handleResolve = async () => {
    const targets = rows.filter((r) => selectedKeys.includes(r.entry.id));
    if (targets.length === 0) { catgirlMessage.warning('先勾选要解析的作品'); return; }
    cancelledRef.current = false;
    setResolving(true);
    const startedAll = Date.now();

    for (let i = 0; i < targets.length; i++) {
      if (cancelledRef.current) break;
      const row = targets[i];
      const genre = (row as Row & { _genre?: TemplateGenre })._genre;
      const types = resolveSubjectTypes(typeOverride, genre);
      const started = Date.now();
      patchRow(row.entry.id, { status: 'resolving', phase: '查找作品…', errors: [] });
      setProgress({ worksDone: i, worksTotal: targets.length, phase: `查找作品：${row.entry.title}`, detailDone: 0, detailTotal: 0 });

      try {
        // 1) 找作品（快）
        const w = await resolveWork(row.entry.title, types);
        if (!w.work) {
          patchRow(row.entry.id, { status: 'error', phase: '', errors: ['没搜到匹配的作品，可换个作品类型再试'] });
          continue;
        }
        patchRow(row.entry.id, {
          work: w.work, workScore: w.workScore, workLowConfidence: w.workLowConfidence,
          phase: '拉取角色列表…',
        });

        // 2) 角色列表（1 次请求，立刻有立绘可看）
        const listed = await fetchCharacterList(w.work.sourceId);
        const existingCards = new Map<string, AnimeEntry>();
        const findExistingCard = (c: CharacterEntry, recordedName: string): AnimeEntry | undefined =>
          cardByTitle.get(recordedName)
          || (c.nameCn ? cardByTitle.get(c.nameCn) : undefined)
          || cardByTitle.get(c.name);
        for (const c of listed) {
          const hit = findExistingCard(c, '');
          if (hit) existingCards.set(c.sourceId, hit);
        }
        patchRow(row.entry.id, { characters: listed, existingCards, phase: '抓取角色详情…' });

        // 3) 分批抓详情（只为主角/配角），进度条按角色推进
        const pool = listed.filter((c) => c.relation === '主角' || c.relation === '配角');
        const targets2 = (pool.length > 0 ? pool : listed).slice(0, 40);
        const details = new Map<string, CharacterEntry>();
        for (let off = 0; off < targets2.length; off += DETAIL_CHUNK) {
          if (cancelledRef.current) break;
          const chunk = targets2.slice(off, off + DETAIL_CHUNK);
          setProgress({
            worksDone: i, worksTotal: targets.length,
            phase: `抓取详情：${row.entry.title}`,
            detailDone: off, detailTotal: targets2.length,
          });
          try {
            const res = await fetchCharacterDetails(chunk.map((c) => c.sourceId));
            for (const d of res.characters) details.set(d.sourceId, d);
          } catch (e) {
            patchRow(row.entry.id, { errors: [`部分详情抓取失败：${e instanceof Error ? e.message : ''}`] });
          }
          // 每批都刷新一次界面，让用户看到角色一个个补齐
          setRows((prev) => prev.map((r) => {
            if (r.entry.id !== row.entry.id) return r;
            const merged = r.characters.map((c) => {
              const d = details.get(c.sourceId);
              return d ? mergeDetailIntoListed(c, d) : c;
            });
            return { ...r, characters: merged };
          }));
        }
        setProgress({
          worksDone: i, worksTotal: targets.length, phase: '',
          detailDone: targets2.length, detailTotal: targets2.length,
        });

        // 用最终的（带详情）角色列表做匹配与同名检测
        setRows((prev) => prev.map((r) => {
          if (r.entry.id !== row.entry.id) return r;
          const matches = matchRecordedNames(r.characters, r.recorded);
          const found = new Map<string, AnimeEntry>();
          const picked = new Set<string>();
          const dupActions = new Map<string, DupAction>();
          for (const m of matches) {
            if (!m.character) continue;
            const card = findExistingCard(m.character, m.name);
            if (card) {
              found.set(m.character.sourceId, card);
              dupActions.set(m.character.sourceId, 'merge');
              // 已有卡：默认勾上（走合并补齐），而不是再建一张
              if (!m.lowConfidence) picked.add(m.character.sourceId);
              continue;
            }
            if (!m.lowConfidence) picked.add(m.character.sourceId);
          }
          // 列表里其它与已有卡同名的角色，也标出来（客串/同系列的情况）
          for (const c of r.characters) {
            if (found.has(c.sourceId)) continue;
            const card = (c.nameCn ? cardByTitle.get(c.nameCn) : undefined) || cardByTitle.get(c.name);
            if (card) {
              found.set(c.sourceId, card);
              dupActions.set(c.sourceId, 'merge');
            }
          }
          return {
            ...r, matches, picked, existingCards: found, dupActions,
            status: 'ready', phase: '', ms: Date.now() - started,
          };
        }));
      } catch (e) {
        patchRow(row.entry.id, {
          status: 'error', phase: '',
          errors: [e instanceof Error ? e.message : String(e)],
        });
      }
    }

    setProgress({ worksDone: targets.length, worksTotal: targets.length, phase: '', detailDone: 0, detailTotal: 0 });
    setResolving(false);
    catgirlMessage.success(`解析完成，用时 ${((Date.now() - startedAll) / 1000).toFixed(1)} 秒`);
  };

  // ── 勾选与排序 ──

  const pickCount = useMemo(() => rows.reduce((n, r) => n + r.picked.size, 0), [rows]);
  const readyRows = useMemo(() => rows.filter((r) => r.status === 'ready'), [rows]);

  const togglePick = (entryId: string, sourceId: string) => {
    setRows((prev) => prev.map((r) => {
      if (r.entry.id !== entryId) return r;
      const picked = new Set(r.picked);
      if (picked.has(sourceId)) picked.delete(sourceId); else picked.add(sourceId);
      return { ...r, picked };
    }));
  };

  const cycleDupAction = (entryId: string, sourceId: string, current: DupAction) => {
    const order: DupAction[] = ['merge', 'create', 'skip'];
    const next = order[(order.indexOf(current) + 1) % order.length];
    setRows((prev) => prev.map((r) => {
      if (r.entry.id !== entryId) return r;
      const dupActions = new Map(r.dupActions);
      dupActions.set(sourceId, next);
      // 「跳过」时顺手取消勾选，避免语义矛盾
      const picked = new Set(r.picked);
      if (next === 'skip') picked.delete(sourceId); else picked.add(sourceId);
      return { ...r, dupActions, picked };
    }));
  };

  /** 某个角色最终用哪种处理方式 */
  const actionFor = (row: Row, sourceId: string): DupAction => {
    const explicit = row.dupActions.get(sourceId);
    if (explicit) return explicit;
    return row.existingCards.has(sourceId) ? dupDefault : 'create';
  };

  /** 按当前排序+过滤整理候选 */
  const arrangeCandidates = useCallback((row: Row): CharacterEntry[] => {
    const keyword = nameFilter.trim().toLowerCase();
    let list = row.characters.filter((c) => c.relation === '主角' || c.relation === '配角');
    if (list.length === 0) list = row.characters;
    if (keyword) {
      list = list.filter((c) => `${c.nameCn || ''}${c.name}${c.aliases.join('')}`.toLowerCase().includes(keyword));
    }
    const sorted = [...list];
    if (sortMode === 'name') {
      // localeCompare('zh') 在 Chromium 里按拼音排，中文名比日文名好用
      sorted.sort((a, b) => (a.nameCn || a.name).localeCompare(b.nameCn || b.name, 'zh-Hans-CN'));
    } else if (sortMode === 'popularity') {
      sorted.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
    }
    // relation 模式：服务端已按 主角→配角→闲角 排好，保持原序
    return sorted;
  }, [sortMode, nameFilter]);

  // ── 生成 / 合并 ──

  const handleGenerate = async () => {
    if (pickCount === 0) { catgirlMessage.warning('还没有勾选任何角色'); return; }
    setWriting(true);
    cancelledRef.current = false;
    let done = 0, created = 0, merged = 0, mergedFields = 0, skipped = 0, failed = 0, namesWritten = 0, slotFull = 0;
    setProgress({ worksDone: 0, worksTotal: pickCount, phase: '开始生成…', detailDone: 0, detailTotal: 0 });

    for (const row of readyRows) {
      const currentNames = [...row.recorded];
      const pickedCharacters = row.characters.filter((c) => row.picked.has(c.sourceId));
      const workName = row.work ? (row.work.titleCn || row.work.title) : row.entry.title;

      for (const character of pickedCharacters) {
        if (cancelledRef.current) break;
        const cardTitle = character.nameCn || character.name;
        const action = actionFor(row, character.sourceId);
        setProgress({
          worksDone: done, worksTotal: pickCount,
          phase: `${DUP_LABEL[action]}「${cardTitle}」`, detailDone: 0, detailTotal: 0,
        });
        if (action === 'skip') { skipped++; done++; continue; }

        try {
          const existing = row.existingCards.get(character.sourceId);

          // 1) 需要补图时先落盘（已有卡只在没图时补，不冲掉你自己换过的图）
          let localUrl = '';
          const needPortrait = withPortrait && character.imageUrl && (!existing || !existing.posterUrl);
          if (needPortrait) {
            try {
              localUrl = await downloadPortrait(cardTitle, character.imageUrl as string);
            } catch (e) {
              failed++;
              console.warn('[角色补全] 立绘下载失败：', e);
            }
          }

          if (existing && action === 'merge') {
            // 2a) 合并进已有卡：只补空、不覆盖；所属作品取并集（一对多绑定）
            const result = mergeCharacterCardData(existing.customFields, character, workName);
            const needWrite = result.changed || !!localUrl || (!existing.link && !!character.sourceId);
            if (needWrite) {
              await saveCharacterCardData(existing, {
                customFields: result.customFields,
                posterUrl: localUrl || undefined,
                link: existing.link || (character.sourceId ? `https://bgm.tv/character/${character.sourceId}` : undefined),
              });
              merged++;
              mergedFields += result.filled.length;
            }
          } else {
            // 2b) 新建一张卡（末尾追加）
            await appendAnimeEntry(buildCharacterCardEntry({
              character, fallbackWork: row.work, localPosterUrl: localUrl,
              title: cardTitle, sourceWorkName: workName,
            }));
            created++;
          }

          // 3) 顺手把角色名记进所属番剧（只写角色名那 4 列）
          if (!currentNames.includes(cardTitle) && !currentNames.includes(character.name)) {
            if (currentNames.length < MAX_CHARACTER_SLOTS) {
              currentNames.push(cardTitle);
              await saveCharacterNames(row.entry, currentNames);
              namesWritten++;
            } else {
              slotFull++;
            }
          }
        } catch (e) {
          failed++;
          console.error('[角色补全] 处理失败：', e);
        }
        done++;
        setProgress({ worksDone: done, worksTotal: pickCount, phase: '', detailDone: 0, detailTotal: 0 });
      }
    }

    setWriting(false);
    setProgress(null);
    catgirlMessage.success(
      `新建 ${created} 张、合并 ${merged} 张`
      + (mergedFields > 0 ? `（补齐 ${mergedFields} 个字段）` : '')
      + (skipped > 0 ? `、跳过 ${skipped} 个` : '')
      + (namesWritten > 0 ? `；把 ${namesWritten} 个角色名记进所属番剧` : '')
      + (slotFull > 0 ? `；${slotFull} 个名字因番剧 4 个名额已满未记录` : '')
      + (failed > 0 ? `；${failed} 项失败（详见控制台）` : ''),
    );
    onApplied();
    rebuild();
  };

  /** 重复角色卡的组数（用于「合并重复卡」按钮的提示） */
  const dupGroupCount = useMemo(
    () => buildDuplicateGroups(animeList, (a) => a.templateId === CHARACTER_TEMPLATE_ID).length,
    [animeList],
  );

  /** 缺图/缺资料的角色卡（用于「补齐」按钮的提示数量） */
  const incompleteCards = useMemo(() => animeList.filter((a) => {
    if (a.templateId !== CHARACTER_TEMPLATE_ID) return false;
    const cf = a.customFields || {};
    return !a.posterUrl || !String(cf.char_profile || '').trim() || !String(cf.char_cv || '').trim();
  }), [animeList]);

  /**
   * 补齐已有角色卡的缺图 / 缺资料。
   *
   * 为什么需要：Bangumi 有些角色没有立绘，解析时下载也会偶发失败（实测 101 张卡里
   * 18 张没图）。这里按每张卡的「所属作品」反查角色，补上立绘与空缺的声优/生日/人设
   * —— 只补空，不覆盖，也不动评分。
   *
   * 两个必须做对的地方（都是实测踩出来的）：
   *   1. 解析作品**必须带类型过滤**。不带过滤会搜所有类型，把「86 不存在的战区 part1」
   *      解析成书籍、把「我推的孩子」解析成三次元，然后把错的立绘写到卡片上。
   *   2. 匹配前**必须先抓角色详情**。角色列表里根本没有中文名（实测 has_name_cn_key=0），
   *      而卡片标题通常是中文名 —— 拿列表直接匹配会全军覆没。
   *      所以先抓详情（主角优先、命中即提前停），再用同一套 core 匹配。
   */
  const handleBackfill = async () => {
    if (incompleteCards.length === 0) { catgirlMessage.info('没有缺图或缺资料的卡片'); return; }
    setBackfilling(true);
    cancelledRef.current = false;
    let fixedPoster = 0, fixedFields = 0, failed = 0, unmatched = 0;

    // 按所属作品分组：同一个作品只解析一次
    const byWork = new Map<string, AnimeEntry[]>();
    for (const card of incompleteCards) {
      const work = String((card.customFields || {}).char_source || '').split('/').filter(Boolean)[0] || '';
      const list = byWork.get(work) || [];
      list.push(card);
      byWork.set(work, list);
    }

    const groups = [...byWork.entries()];
    for (let gi = 0; gi < groups.length; gi++) {
      if (cancelledRef.current) break;
      const [workName, cards] = groups[gi];
      setProgress({ worksDone: gi, worksTotal: groups.length, phase: `解析作品：${workName || '(无)'}`, detailDone: 0, detailTotal: 0 });
      try {
        // 1) 解析作品：先按动画找，不够可信再不限类型重试
        let w = await resolveWork(workName, resolveSubjectTypes(typeOverride, 'anime'));
        if (!w.work || w.workScore < LOW_CONFIDENCE) {
          const retry = await resolveWork(workName, typeOverride === 'auto' ? undefined : resolveSubjectTypes(typeOverride, undefined));
          if (retry.work && retry.workScore > (w.workScore || 0)) w = retry;
        }
        if (!w.work || w.workScore < LOW_CONFIDENCE) {
          unmatched += cards.length;
          continue;
        }

        // 2) 角色列表 + 分批抓详情（主角/配角优先），目标全部命中就提前停
        const listed = await fetchCharacterList(w.work.sourceId);
        const pool = listed.filter((c) => c.relation === '主角' || c.relation === '配角');
        const detailPool = (pool.length > 0 ? pool : listed).slice(0, 40);
        const detailed: CharacterEntry[] = [];
        const isAllMatched = () => cards.every((card) => {
          const m = matchRecordedNames(detailed, [card.title.trim()])[0];
          return !!(m && m.character);
        });
        for (let off = 0; off < detailPool.length; off += DETAIL_CHUNK) {
          if (cancelledRef.current || isAllMatched()) break;
          const chunk = detailPool.slice(off, off + DETAIL_CHUNK);
          setProgress({
            worksDone: gi, worksTotal: groups.length, phase: `抓角色详情：${workName}`,
            detailDone: off, detailTotal: detailPool.length,
          });
          const res = await fetchCharacterDetails(chunk.map((c) => c.sourceId));
          for (const d of res.characters) {
            const base = chunk.find((c) => c.sourceId === d.sourceId);
            detailed.push(base ? mergeDetailIntoListed(base, d) : d);
          }
        }

        // 3) 逐张卡补齐
        for (let ci = 0; ci < cards.length; ci++) {
          if (cancelledRef.current) break;
          const card = cards[ci];
          const title = card.title.trim();
          setProgress({
            worksDone: gi, worksTotal: groups.length, phase: `补齐「${title}」`,
            detailDone: ci, detailTotal: cards.length,
          });
          const m = matchRecordedNames(detailed, [title])[0];
          const hit = m && m.character ? m.character : null;
          if (!hit) { unmatched++; continue; }

          let localUrl = '';
          if (!card.posterUrl && hit.imageUrl) {
            try { localUrl = await downloadPortrait(title, hit.imageUrl); fixedPoster++; }
            catch (e) { failed++; console.warn('[角色补全] 补齐立绘失败：', title, e); }
          }
          const result = mergeCharacterCardData(card.customFields, hit, workName);
          if (result.changed || localUrl) {
            await saveCharacterCardData(card, {
              customFields: result.customFields,
              posterUrl: localUrl || undefined,
              link: card.link || (hit.sourceId ? `https://bgm.tv/character/${hit.sourceId}` : undefined),
            });
            fixedFields += result.filled.length;
          }
        }
      } catch (e) {
        failed += cards.length;
        console.warn('[角色补全] 补齐失败：', workName, e);
      }
    }

    setBackfilling(false);
    setProgress(null);
    catgirlMessage.success(
      `补齐完成：${fixedPoster} 张补上立绘、${fixedFields} 个字段被填充`
      + (unmatched > 0 ? `；${unmatched} 张没能可信地找到对应角色（已跳过，未写入）` : '')
      + (failed > 0 ? `；${failed} 项失败（详见控制台）` : ''),
    );
    onApplied();
    rebuild();
  };

  // ── 横向拖动滚动（候选栏超出时向左拖） ──

  const stripRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<{ startX: number; startScroll: number; moved: boolean } | null>(null);
  const justDraggedRef = useRef(false);

  const onStripMouseDown = (entryId: string) => (e: React.MouseEvent) => {
    const el = stripRefs.current.get(entryId);
    if (!el) return;
    dragRef.current = { startX: e.clientX, startScroll: el.scrollLeft, moved: false };
    justDraggedRef.current = false;
  };
  const onStripMouseMove = (entryId: string) => (e: React.MouseEvent) => {
    const el = stripRefs.current.get(entryId);
    const st = dragRef.current;
    if (!el || !st) return;
    const dx = e.clientX - st.startX;
    if (Math.abs(dx) > 3) st.moved = true;
    el.scrollLeft = st.startScroll - dx;
  };
  const endStripDrag = () => {
    if (dragRef.current?.moved) justDraggedRef.current = true;
    dragRef.current = null;
  };

  // ── 表格 ──

  const sortControl = (
    <Space size={6} wrap>
      <Text style={{ fontSize: 11 }}>排序</Text>
      <Select size="small" value={sortMode} onChange={setSortMode} options={SORT_OPTIONS} style={{ width: 150 }} />
      <Input
        size="small"
        allowClear
        prefix={<SearchOutlined style={{ color: 'var(--text-muted)' }} />}
        placeholder="按名称筛选"
        value={nameFilter}
        onChange={(e) => setNameFilter(e.target.value)}
        style={{ width: 120 }}
      />
    </Space>
  );

  const columns: ColumnsType<Row> = useMemo(() => [
    {
      title: '作品',
      width: 190,
      render: (_: unknown, row: Row) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ fontSize: 12 }}>{row.entry.title}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            已记录 {row.recorded.length} 个{row.recorded.length > 0 ? `：${row.recorded.join('、')}` : ''}
          </Text>
        </Space>
      ),
    },
    {
      title: '解析结果',
      width: 230,
      render: (_: unknown, row: Row) => {
        if (row.status === 'idle') return <Text type="secondary" style={{ fontSize: 11 }}>未解析</Text>;
        if (row.status === 'resolving') {
          return <Text type="secondary" style={{ fontSize: 11 }}>{row.phase || '解析中…'}</Text>;
        }
        if (row.status === 'error') {
          return <Text type="danger" style={{ fontSize: 11 }}>{row.errors[0] || '解析失败'}</Text>;
        }
        const dupCount = row.existingCards.size;
        return (
          <Space direction="vertical" size={2}>
            <Space size={4} wrap>
              <Tag color={row.workLowConfidence ? 'warning' : 'success'} style={{ fontSize: 10 }}>
                {row.work ? (row.work.titleCn || row.work.title) : '未匹配'}
              </Tag>
              <Text type="secondary" style={{ fontSize: 10 }}>
                标题分 {row.workScore.toFixed(2)} · {row.characters.length} 角色 · {((row.ms || 0) / 1000).toFixed(1)}s
              </Text>
            </Space>
            {row.matches.length > 0 && (
              <Text type="secondary" style={{ fontSize: 10 }}>
                {row.matches.map((m) => (
                  <Tag
                    key={m.name}
                    color={m.character ? (m.lowConfidence ? 'warning' : 'magenta') : 'default'}
                    style={{ fontSize: 10, marginInlineEnd: 2 }}
                  >
                    {m.name}
                    {m.character ? `→${m.character.nameCn || m.character.name}${m.lowConfidence ? `(${m.score.toFixed(2)})` : ''}` : ' 未找到'}
                  </Tag>
                ))}
              </Text>
            )}
            {dupCount > 0 && (
              <Text type="warning" style={{ fontSize: 10 }}>
                其中 {dupCount} 个已有同名角色卡，默认按「{DUP_LABEL[dupDefault]}」处理（点角色上的小标签可单独改）
              </Text>
            )}
            {row.errors.length > 0 && (
              <Text type="warning" style={{ fontSize: 10 }}>{row.errors[0]}</Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '可建卡的角色（勾选 · 可左右拖动）',
      render: (_: unknown, row: Row) => {
        if (row.status !== 'ready') return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
        const arranged = arrangeCandidates(row);
        if (arranged.length === 0) {
          return <Text type="secondary" style={{ fontSize: 11 }}>
            {nameFilter ? '没有匹配该名称的角色' : '没找到角色'}
          </Text>;
        }
        const shown = arranged.slice(0, MAX_CHIPS);
        const pickVisible = () => {
          setRows((prev) => prev.map((r) => {
            if (r.entry.id !== row.entry.id) return r;
            const picked = new Set(r.picked);
            for (const c of shown) {
              const act = (r.dupActions.get(c.sourceId)) || (r.existingCards.has(c.sourceId) ? dupDefault : 'create');
              if (act !== 'skip') picked.add(c.sourceId);
            }
            return { ...r, picked };
          }));
        };
        return (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Button size="small" type="link" style={{ padding: 0, fontSize: 11 }} onClick={pickVisible}>
                全选可见（{shown.length}）
              </Button>
              <Button size="small" type="link" style={{ padding: 0, fontSize: 11 }}
                onClick={() => setRows((prev) => prev.map((r) => r.entry.id === row.entry.id ? { ...r, picked: new Set() } : r))}>
                清空
              </Button>
              <Text type="secondary" style={{ fontSize: 10 }}>
                已勾 {row.picked.size} 个{arranged.length > MAX_CHIPS ? ` · 仅显示前 ${MAX_CHIPS}` : ''}
              </Text>
            </Space>
            <div
              ref={(el) => { if (el) stripRefs.current.set(row.entry.id, el); else stripRefs.current.delete(row.entry.id); }}
              onMouseDown={onStripMouseDown(row.entry.id)}
              onMouseMove={onStripMouseMove(row.entry.id)}
              onMouseUp={endStripDrag}
              onMouseLeave={endStripDrag}
              style={{
                display: 'flex', flexWrap: 'nowrap', gap: 6,
                overflowX: 'auto', overflowY: 'hidden',
                paddingBottom: 6,
                cursor: dragRef.current ? 'grabbing' : 'grab',
                userSelect: 'none',
              }}
            >
              {shown.map((c) => {
                const cardTitle = c.nameCn || c.name;
                const existing = row.existingCards.get(c.sourceId);
                const checked = row.picked.has(c.sourceId);
                const act = actionFor(row, c.sourceId);
                return (
                  <Tooltip
                    key={c.sourceId}
                    mouseEnterDelay={0.4}
                    title={
                      <div style={{ fontSize: 11 }}>
                        <div>{c.nameCn ? `${c.nameCn} / ${c.name}` : c.name}</div>
                        <div>关系：{c.relation || '未知'}　CV：{c.voiceActors.map((v) => v.name).join('、') || '无'}</div>
                        <div>
                          {c.birthday ? `生日 ${c.birthday}　` : ''}{c.bloodType ? `血型 ${c.bloodType}　` : ''}
                          {c.height ? `身高 ${c.height}` : ''}
                        </div>
                        <div>人设 {c.profile ? `${c.profile.text.length} 字（${c.profile.source}/${c.profile.lang}）` : '无'}</div>
                        {c.popularity !== null ? <div>AniList 收藏 {c.popularity}</div> : null}
                        {existing ? <div style={{ color: '#faad14' }}>已存在角色卡（行 {existing.excelRowIndex !== undefined ? existing.excelRowIndex + 1 : '?'}）：{existing.title}</div> : null}
                      </div>
                    }
                  >
                    <div style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                      padding: 3, borderRadius: 4, flex: '0 0 auto', width: THUMB_W + 10,
                      border: checked ? '1px solid var(--brand-primary)' : '1px solid var(--border-primary)',
                      background: 'var(--bg-primary)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%', justifyContent: 'center' }}>
                        <Checkbox
                          checked={checked}
                          onClick={(e) => {
                            // 拖动过程中不要误触发勾选
                            if (justDraggedRef.current) { e.preventDefault(); justDraggedRef.current = false; return; }
                            togglePick(row.entry.id, c.sourceId);
                          }}
                        />
                        {c.relation === '主角' ? <span style={{ fontSize: 10, color: 'var(--brand-primary)' }}>★</span> : null}
                      </div>
                      {c.imageThumbUrl ? (
                        <img
                          src={c.imageThumbUrl}
                          alt=""
                          draggable={false}
                          style={{
                            width: THUMB_W, height: THUMB_H, objectFit: 'cover', objectPosition: '50% 0%',
                            borderRadius: 3, background: 'var(--bg-quaternary)',
                          }}
                        />
                      ) : (
                        <div style={{
                          width: THUMB_W, height: THUMB_H, borderRadius: 3, background: 'var(--bg-quaternary)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, color: 'var(--text-muted)',
                        }}>无图</div>
                      )}
                      <span style={{
                        fontSize: 10, color: 'var(--text-primary)', maxWidth: THUMB_W + 8,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{cardTitle}</span>
                      {existing ? (
                        <Tag
                          color={DUP_COLOR[act]}
                          style={{ fontSize: 9, margin: 0, cursor: 'pointer', lineHeight: '14px' }}
                          onClick={(e) => { e.stopPropagation(); cycleDupAction(row.entry.id, c.sourceId, act); }}
                        >
                          已有卡·{DUP_LABEL[act]}
                        </Tag>
                      ) : null}
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          </Space>
        );
      },
    },
  ], [arrangeCandidates, cardByTitle, dupDefault, nameFilter, togglePick, cycleDupAction, actionFor]);

  const reselectable = !resolving && !writing && !backfilling;

  /** 总进度：作品解析 + 当前作品的详情抓取 */
  const overallPercent = useMemo(() => {
    if (!progress || progress.worksTotal === 0) return 0;
    const detailPart = progress.detailTotal > 0 ? progress.detailDone / progress.detailTotal : 0;
    return Math.min(100, Math.round(((progress.worksDone + detailPart) / progress.worksTotal) * 100));
  }, [progress]);

  return (
    <Modal
      open={open}
      onCancel={() => { if (!reselectable) cancelledRef.current = true; else onClose(); }}
      width={1240}
      className="media-complete-modal"
      title="角色补全 — 从 Bangumi 获取角色立绘 / 声优 / 生日 / 人设并生成角色卡"
      footer={null}
      destroyOnClose={false}
      maskClosable={reselectable}
    >
      {/* ── 作用范围与选项 ── */}
      <div style={{ padding: 12, background: 'var(--bg-quaternary)', borderRadius: 6, marginBottom: 12 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap size={16} align="center">
            <Tag color="blue">
              作用范围：{includeNoRecorded ? '全部条目' : `模板「${templateName}」中已填角色名的条目`}
            </Tag>
            {scopeFallback && !includeNoRecorded && (
              <Tooltip title="角色模板本身不能作为角色来源（角色卡不是「作品」），这里自动改用番剧评分模板">
                <Tag color="gold">当前看的是「角色评分」，已自动改用「{templateName}」</Tag>
              </Tooltip>
            )}
            <Checkbox checked={includeNoRecorded} disabled={!reselectable} onChange={(e) => setIncludeNoRecorded(e.target.checked)}>
              包含未填角色名的条目 / 其他模板
            </Checkbox>
          </Space>
          <Space wrap size={16} align="center">
            <Text>作品类型：</Text>
            <Select size="small" value={typeOverride} onChange={setTypeOverride}
              options={WORK_TYPE_OPTIONS} style={{ width: 170 }} disabled={!reselectable} />
            <Checkbox checked={withAniList} disabled={!reselectable} onChange={(e) => setWithAniList(e.target.checked)}>
              用 AniList 补生日/年龄/人气/详细人设
            </Checkbox>
            <Checkbox checked={withPortrait} disabled={!reselectable} onChange={(e) => setWithPortrait(e.target.checked)}>
              下载立绘到本地
            </Checkbox>
          </Space>
          <Space wrap size={16} align="center">
            <Text>遇到已有同名角色卡：</Text>
            <Radio.Group size="small" value={dupDefault} disabled={!reselectable}
              onChange={(e) => setDupDefault(e.target.value as DupAction)}>
              <Radio.Button value="merge">合并（补空缺，作品取并集）</Radio.Button>
              <Radio.Button value="create">新建</Radio.Button>
              <Radio.Button value="skip">跳过</Radio.Button>
            </Radio.Group>
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>
            作品类型「自动」按模板的适用类别判断。同一角色在多部作品（同系列续作/客串）出现时，
            「合并」会把新抓到的资料补进已有卡、并把作品并进「所属作品」，不会重复建卡。
            AniList 不覆盖游戏。
          </Text>
        </Space>
      </div>

      {!withPortrait && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="已关闭立绘下载：新卡会没有海报、合并时也不会补图。"
        />
      )}

      {/* ── 操作条 ── */}
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<CloudDownloadOutlined />} loading={resolving}
          disabled={!reselectable || selectedKeys.length === 0} onClick={() => void handleResolve()}>
          解析选中的 {selectedKeys.length} 部作品
        </Button>
        <Button type="primary" ghost icon={<UserAddOutlined />} loading={writing}
          disabled={!reselectable || pickCount === 0} onClick={() => void handleGenerate()}>
          处理 {pickCount} 个角色
        </Button>
        <Button icon={<PictureOutlined />} loading={backfilling}
          disabled={!reselectable || incompleteCards.length === 0} onClick={() => void handleBackfill()}
          title="扫描已有角色卡，补上缺失的立绘与空着的声优/生日/人设（只补空，不覆盖）">
          补齐缺图/资料（{incompleteCards.length}）
        </Button>
        <Button icon={<ReloadOutlined />} disabled={!reselectable} onClick={rebuild}>重置</Button>
        <Button
          icon={<MergeCellsOutlined />}
          disabled={!reselectable || dupGroupCount === 0}
          onClick={() => setMergeOpen(true)}
          title="把同名的角色卡合并成一张（资料取并集、评分取各维度有值的；被合并的卡软删除，可撤销）"
        >
          合并重复角色卡（{dupGroupCount} 组）
        </Button>
        <Text type="secondary" style={{ fontSize: 11 }}>共 {rows.length} 部候选</Text>
      </Space>

      {progress && (
        <div style={{ marginBottom: 12 }}>
          <Progress percent={overallPercent} size="small" status="active" />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {progress.worksTotal > 0 && progress.detailTotal === 0
              ? `${progress.phase}（${progress.worksDone + 1}/${progress.worksTotal}）`
              : progress.phase}
            {progress.detailTotal > 0 ? ` · 详情 ${progress.detailDone}/${progress.detailTotal}` : ''}
          </Text>
        </div>
      )}

      <Space style={{ marginBottom: 8 }} wrap>
        <Text strong style={{ fontSize: 12 }}>候选角色</Text>
        {sortControl}
      </Space>

      <Table<Row>
        rowKey={(r) => r.entry.id}
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: setSelectedKeys,
          getCheckboxProps: () => ({ disabled: !reselectable }),
        }}
        locale={{ emptyText: (
          <Empty
            description={
              includeNoRecorded
                ? '没有任何可作来源的条目'
                : `模板「${templateName}」里还没有填过角色名的条目 —— 先在番剧详情面板点「修改」，在角色区加上角色名；或勾上上面的「包含未填角色名的条目」`
            }
          />
        ) }}
        scroll={{ y: 460 }}
      />

      <CharacterMergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        animeList={animeList}
        onApplied={onApplied}
      />
    </Modal>
  );
};

export default CharacterCompleteModal;
