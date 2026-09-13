/**
 * 角色补全面板
 *
 * 与「数据补全」（番剧元数据）同一套交互原则：
 *   1. 默认**一个都不选**，你必须先手动勾要处理哪些作品。
 *   2. 解析只产出建议 —— 勾选哪些角色、要不要建卡，全由你决定。
 *   3. 生成角色卡是**末尾追加新行**，不改动任何已有数据。
 *
 * 它能做到「手动搜索角色数据」：解析后每个作品都会列出主角/配角（带立绘缩略图、
 * 简体中文名、声优、生日），你可以挑任意角色建卡，不必先在番剧里填过角色名。
 * 已填过的角色名会自动匹配并预先勾上；匹配不可信的会标出来但不预勾。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Table, Tag, Space, Typography, Select, Checkbox, Progress, Alert, Tooltip, Empty } from 'antd';
import { CloudDownloadOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AnimeEntry, ScoreTemplate, TemplateGenre } from '../../src/types';
import { CHARACTER_TEMPLATE_ID } from '../../src/types';
import { getTemplate } from '../anime-data/template-service';
import { appendAnimeEntry, saveCharacterNames } from '../anime-data/excel-service';
import { catgirlMessage } from '../../src/theme';
import {
  resolveCharacters, downloadPortrait, matchRecordedNames, buildCharacterCardEntry,
  resolveSubjectTypes, WORK_TYPE_OPTIONS,
} from './character-service';
import type { CharacterEntry, WorkCandidate, RecordedMatch, WorkTypeOverride } from './character-service';

const { Text } = Typography;

/** 每个作品最多解析多少个角色的详情（主角优先） */
const DEFAULT_DETAIL_BUDGET = 30;
/** Excel 只有 4 列角色名 */
const MAX_CHARACTER_SLOTS = 4;

type RowStatus = 'idle' | 'resolving' | 'ready' | 'error';

interface Row {
  entry: AnimeEntry;
  /** 已记录的角色名（来自 Excel 的 AA/AD/AG/AJ） */
  recorded: string[];
  status: RowStatus;
  work: WorkCandidate | null;
  workScore: number;
  workLowConfidence: boolean;
  characters: CharacterEntry[];
  matches: RecordedMatch[];
  /** 勾选要建卡的角色 sourceId */
  picked: Set<string>;
  /** 已经建过卡的角色名（标题相同且是角色模板） */
  alreadyCard: Set<string>;
  /**
   * 已经建过卡的角色 sourceId。
   *
   * 为什么不能只比名字：卡片标题是「建卡时用的名字」（可能是当初记录在番剧里的
   * 「蕾娜」），而解析出来的是「弗拉迪蕾娜·米丽洁」—— 只比显示名会漏判，
   * 于是界面上既不预勾选、也不提示「已有卡」，用户完全不知道发生了什么。
   */
  alreadyCardIds: Set<string>;
  errors: string[];
  /** 解析耗时 */
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

const CharacterCompleteModal: React.FC<CharacterCompleteModalProps> = ({
  open, onClose, animeList, activeTemplateId, templates, onApplied,
}) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [typeOverride, setTypeOverride] = useState<WorkTypeOverride>('auto');
  const [withAniList, setWithAniList] = useState(true);
  const [withPortrait, setWithPortrait] = useState(true);
  const [includeNoRecorded, setIncludeNoRecorded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; text: string } | null>(null);
  const cancelledRef = useRef(false);

  const templateName = useMemo(
    () => templates.find((t) => t.id === activeTemplateId)?.name || activeTemplateId,
    [templates, activeTemplateId],
  );

  /** 已经建过卡的角色名（标题 = 角色名 且 模板 = character） */
  const existingCardTitles = useMemo(() => {
    const set = new Set<string>();
    for (const a of animeList) {
      if (a.templateId === CHARACTER_TEMPLATE_ID) set.add(a.title.trim());
    }
    return set;
  }, [animeList]);

  /** 重建候选行 */
  const rebuild = useCallback(() => {
    const genreOf = (templateId?: string): TemplateGenre | undefined =>
      templates.find((t) => t.id === (templateId || 'default'))?.applicableGenre;

    const next: Row[] = animeList
      // 角色卡自己不需要再补角色
      .filter((a) => a.templateId !== CHARACTER_TEMPLATE_ID)
      // 只看当前模板的条目（与「数据补全」一致），除非勾了「包含其他模板」
      .filter((a) => includeNoRecorded || (a.templateId || 'default') === activeTemplateId)
      .map((a) => {
        const recorded = (a.characters || []).map((c) => String(c).trim()).filter(Boolean);
        const alreadyCard = new Set(recorded.filter((n) => existingCardTitles.has(n)));
        return {
          entry: a,
          recorded,
          status: 'idle' as RowStatus,
          work: null,
          workScore: 0,
          workLowConfidence: false,
          characters: [],
          matches: [],
          picked: new Set<string>(),
          alreadyCard,
          alreadyCardIds: new Set<string>(),
          errors: [],
          _genre: genreOf(a.templateId),
        } as Row & { _genre?: TemplateGenre };
      })
      // 默认只列「已经填过角色名」的（可操作）；没填的按需显示
      .filter((r) => includeNoRecorded || r.recorded.length > 0);

    setRows(next);
    setSelectedKeys([]);
    setProgress(null);
  }, [animeList, templates, activeTemplateId, includeNoRecorded, existingCardTitles]);

  useEffect(() => {
    if (!open) { cancelledRef.current = true; return; }
    cancelledRef.current = false;
    rebuild();
  }, [open, rebuild]);

  /** 解析选中的作品 */
  const handleResolve = async () => {
    const targets = rows.filter((r) => selectedKeys.includes(r.entry.id));
    if (targets.length === 0) { catgirlMessage.warning('先勾选要解析的作品'); return; }
    cancelledRef.current = false;
    setResolving(true);
    setProgress({ done: 0, total: targets.length, text: '准备解析…' });

    for (let i = 0; i < targets.length; i++) {
      if (cancelledRef.current) break;
      const row = targets[i];
      const genre = (row as Row & { _genre?: TemplateGenre })._genre;
      const types = resolveSubjectTypes(typeOverride, genre);
      setProgress({ done: i, total: targets.length, text: `解析「${row.entry.title}」…` });
      setRows((prev) => prev.map((r) => (r.entry.id === row.entry.id ? { ...r, status: 'resolving' } : r)));

      const started = Date.now();
      try {
        const result = await resolveCharacters({
          workTitle: row.entry.title,
          types,
          names: [],
          withAniList,
          detailBudget: DEFAULT_DETAIL_BUDGET,
        });
        const matches = matchRecordedNames(result.characters, row.recorded);
        // 预勾选：已记录且匹配可信、且**还没建过卡**的角色。
        // 判定要把三种名字都算上（记录名 / 简体中文名 / 原名），
        // 否则「卡片标题是蕾娜、解析出来是弗拉迪蕾娜·米丽洁」这种情况会被漏掉，
        // 结果就是重复建卡。
        const picked = new Set<string>();
        const alreadyCardIds = new Set<string>();
        const hasCardFor = (c: CharacterEntry, recordedName: string) =>
          row.alreadyCard.has(recordedName)
          || row.alreadyCard.has(c.nameCn || '')
          || row.alreadyCard.has(c.name);
        for (const m of matches) {
          if (!m.character) continue;
          if (hasCardFor(m.character, m.name)) { alreadyCardIds.add(m.character.sourceId); continue; }
          if (!m.lowConfidence) picked.add(m.character.sourceId);
        }
        setRows((prev) => prev.map((r) => (r.entry.id === row.entry.id ? {
          ...r,
          status: result.work ? 'ready' : 'error',
          work: result.work,
          workScore: result.workScore,
          workLowConfidence: result.workLowConfidence,
          characters: result.characters,
          matches,
          picked,
          alreadyCardIds,
          errors: result.errors || [],
          ms: Date.now() - started,
        } : r)));
      } catch (e) {
        setRows((prev) => prev.map((r) => (r.entry.id === row.entry.id ? {
          ...r, status: 'error', errors: [e instanceof Error ? e.message : String(e)],
        } : r)));
      }
    }
    setProgress({ done: targets.length, total: targets.length, text: '解析完成' });
    setResolving(false);
  };

  /** 每个作品可建卡的角色数（勾选数） */
  const pickCount = useMemo(() => rows.reduce((n, r) => n + r.picked.size, 0), [rows]);
  const readyRows = useMemo(() => rows.filter((r) => r.status === 'ready' && r.picked.size > 0), [rows]);

  /** 生成角色卡 */
  const handleGenerate = async () => {
    if (pickCount === 0) { catgirlMessage.warning('还没有勾选任何角色'); return; }
    setWriting(true);
    cancelledRef.current = false;
    let done = 0;
    let failed = 0;
    let namesWritten = 0;
    let slotFull = 0;
    setProgress({ done: 0, total: pickCount, text: '开始生成…' });

    for (const row of readyRows) {
      // 当前作品的角色名占用情况（可能在生成过程中被填满）
      const currentNames = [...row.recorded];
      const pickedCharacters = row.characters.filter((c) => row.picked.has(c.sourceId));

      for (const character of pickedCharacters) {
        if (cancelledRef.current) break;
        const cardTitle = character.nameCn || character.name;
        setProgress({ done, total: pickCount, text: `生成「${cardTitle}」…` });
        try {
          // 1) 立绘先落盘，再写卡片 —— 否则卡片上会留一个外链
          let localUrl = '';
          if (withPortrait && character.imageUrl) {
            try {
              localUrl = await downloadPortrait(cardTitle, character.imageUrl);
            } catch (e) {
              // 立绘失败不该阻止建卡：资料（声优/生日/人设）仍然有价值
              failed++;
              console.warn('[角色补全] 立绘下载失败：', e);
            }
          }

          // 2) 追加角色卡（只新增行，不动已有数据）
          await appendAnimeEntry(buildCharacterCardEntry({
            character,
            fallbackWork: row.work,
            localPosterUrl: localUrl,
            title: cardTitle,
            sourceWorkName: row.work ? (row.work.titleCn || row.work.title) : row.entry.title,
          }));

          // 3) 顺手把角色名记进所属番剧（这样详情面板里点得到这张卡）
          //    只写角色名那 4 列，不动海报/评分/评价
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
          console.error('[角色补全] 生成失败：', e);
        }
        done++;
        setProgress({ done, total: pickCount, text: `生成「${cardTitle}」…` });
      }
    }

    setWriting(false);
    setProgress(null);
    const ok = done - failed;
    catgirlMessage.success(
      `已生成 ${ok} 张角色卡`
      + (namesWritten > 0 ? `，并把 ${namesWritten} 个角色名记进所属番剧` : '')
      + (slotFull > 0 ? `；${slotFull} 个角色名因所属番剧 4 个名额已满未记录（卡片已建）` : '')
      + (failed > 0 ? `；${failed} 项失败（详见控制台）` : ''),
    );
    onApplied();
    rebuild();
  };

  /** 切换某个角色的勾选 */
  const togglePick = (entryId: string, sourceId: string) => {
    setRows((prev) => prev.map((r) => {
      if (r.entry.id !== entryId) return r;
      const picked = new Set(r.picked);
      if (picked.has(sourceId)) picked.delete(sourceId); else picked.add(sourceId);
      return { ...r, picked };
    }));
  };

  /** 只勾选某个作品里「匹配可信且尚未建卡」的角色 */
  const pickConfident = (entryId: string) => {
    setRows((prev) => prev.map((r) => {
      if (r.entry.id !== entryId) return r;
      const picked = new Set<string>();
      for (const m of r.matches) {
        if (m.character && !m.lowConfidence && !r.alreadyCardIds.has(m.character.sourceId)) {
          picked.add(m.character.sourceId);
        }
      }
      return { ...r, picked };
    }));
  };

  const columns: ColumnsType<Row> = useMemo(() => [
    {
      title: '作品',
      dataIndex: ['entry', 'title'],
      width: 200,
      render: (_: unknown, row: Row) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ fontSize: 12 }}>{row.entry.title}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            已记录 {row.recorded.length} 个角色{row.recorded.length > 0 ? `：${row.recorded.join('、')}` : '（无）'}
          </Text>
        </Space>
      ),
    },
    {
      title: '解析结果',
      width: 250,
      render: (_: unknown, row: Row) => {
        if (row.status === 'idle') return <Text type="secondary" style={{ fontSize: 11 }}>未解析</Text>;
        if (row.status === 'resolving') return <Text type="secondary" style={{ fontSize: 11 }}>解析中…</Text>;
        if (row.status === 'error') {
          return <Text type="danger" style={{ fontSize: 11 }}>{row.errors[0] || '解析失败'}</Text>;
        }
        return (
          <Space direction="vertical" size={2}>
            <Space size={4} wrap>
              <Tag color={row.workLowConfidence ? 'warning' : 'success'} style={{ fontSize: 10 }}>
                {row.work ? (row.work.titleCn || row.work.title) : '未匹配'}
              </Tag>
              <Text type="secondary" style={{ fontSize: 10 }}>
                标题分 {row.workScore.toFixed(2)} · 共 {row.characters.length} 角色 · {row.ms}ms
              </Text>
            </Space>
            {row.matches.length > 0 && (
              <Text type="secondary" style={{ fontSize: 10 }}>
                已记录名字：
                {row.matches.map((m) => (
                  <Tag
                    key={m.name}
                    color={m.character ? (m.lowConfidence ? 'warning' : 'magenta') : 'default'}
                    style={{ fontSize: 10, marginInlineEnd: 2 }}
                  >
                    {m.name}
                    {m.character
                      ? `→${m.character.nameCn || m.character.name}${m.lowConfidence ? `(${m.score.toFixed(2)})` : ''}`
                      : ' 未找到'}
                  </Tag>
                ))}
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
      title: '可建卡的角色（勾选）',
      render: (_: unknown, row: Row) => {
        if (row.status !== 'ready') return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
        const list = row.characters.filter((c) => c.relation === '主角' || c.relation === '配角');
        const shown = list.length > 0 ? list : row.characters;
        if (shown.length === 0) return <Text type="secondary" style={{ fontSize: 11 }}>没找到角色</Text>;
        return (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space size={8}>
              <Button size="small" type="link" style={{ padding: 0, fontSize: 11 }} onClick={() => pickConfident(row.entry.id)}>
                只勾可信匹配
              </Button>
              <Button size="small" type="link" style={{ padding: 0, fontSize: 11 }}
                onClick={() => setRows((prev) => prev.map((r) => r.entry.id === row.entry.id ? { ...r, picked: new Set() } : r))}>
                清空
              </Button>
            </Space>
            <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {shown.slice(0, 40).map((c) => {
                const cardTitle = c.nameCn || c.name;
                const hasCard = row.alreadyCardIds.has(c.sourceId)
                  || row.alreadyCard.has(cardTitle)
                  || row.alreadyCard.has(c.name);
                const checked = row.picked.has(c.sourceId);
                return (
                  <Tooltip
                    key={c.sourceId}
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
                        {hasCard ? <div style={{ color: '#faad14' }}>已存在同名角色卡，仍勾选会再建一张</div> : null}
                      </div>
                    }
                  >
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px',
                      border: checked ? '1px solid var(--brand-primary)' : '1px solid var(--border-primary)',
                      borderRadius: 4, cursor: 'pointer', background: 'var(--bg-primary)',
                    }}>
                      <Checkbox
                        checked={checked}
                        onChange={() => togglePick(row.entry.id, c.sourceId)}
                      />
                      {c.imageThumbUrl ? (
                        <img src={c.imageThumbUrl} alt="" style={{ width: 20, height: 26, objectFit: 'cover', objectPosition: '50% 0%', borderRadius: 2 }} />
                      ) : null}
                      <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>
                        {cardTitle}
                        {c.relation === '主角' ? ' ★' : ''}
                        {hasCard ? ' (已有卡)' : ''}
                      </span>
                    </label>
                  </Tooltip>
                );
              })}
              {shown.length > 40 && (
                <Text type="secondary" style={{ fontSize: 10 }}>…共 {shown.length} 个，仅显示前 40</Text>
              )}
            </div>
          </Space>
        );
      },
    },
  ], [togglePick]);

  const reselectable = !resolving && !writing;

  return (
    <Modal
      open={open}
      onCancel={() => { if (resolving || writing) cancelledRef.current = true; else onClose(); }}
      width={1180}
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
            <Checkbox checked={includeNoRecorded} disabled={!reselectable} onChange={(e) => setIncludeNoRecorded(e.target.checked)}>
              包含未填角色名的条目 / 其他模板
            </Checkbox>
          </Space>
          <Space wrap size={16} align="center">
            <Text>作品类型：</Text>
            <Select
              size="small"
              value={typeOverride}
              onChange={setTypeOverride}
              options={WORK_TYPE_OPTIONS}
              style={{ width: 170 }}
              disabled={!reselectable}
            />
            <Checkbox checked={withAniList} disabled={!reselectable} onChange={(e) => setWithAniList(e.target.checked)}>
              用 AniList 补生日/年龄/人气/详细人设
            </Checkbox>
            <Checkbox checked={withPortrait} disabled={!reselectable} onChange={(e) => setWithPortrait(e.target.checked)}>
              下载立绘到本地再建卡
            </Checkbox>
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>
            作品类型「自动」按模板的适用类别判断（番剧/剧场版→动画，书籍→书籍，游戏→游戏）。
            AniList 不覆盖游戏，游戏只会拿到 Bangumi 的字段。
          </Text>
        </Space>
      </div>

      {!withPortrait && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="已关闭立绘下载：角色卡会没有海报，且卡上会记录外链（代理不通时显示不出来）。"
        />
      )}

      {/* ── 操作条 ── */}
      <Space style={{ marginBottom: 12 }} wrap>
        <Button
          type="primary"
          icon={<CloudDownloadOutlined />}
          loading={resolving}
          disabled={writing || selectedKeys.length === 0}
          onClick={() => void handleResolve()}
        >
          解析选中的 {selectedKeys.length} 部作品
        </Button>
        <Button icon={<ReloadOutlined />} disabled={!reselectable} onClick={rebuild}>
          重置
        </Button>
        <Button
          type="primary"
          ghost
          icon={<UserAddOutlined />}
          loading={writing}
          disabled={resolving || pickCount === 0}
          onClick={() => void handleGenerate()}
        >
          生成 {pickCount} 张角色卡
        </Button>
        <Text type="secondary" style={{ fontSize: 11 }}>共 {rows.length} 部候选作品</Text>
      </Space>

      {progress && (
        <div style={{ marginBottom: 12 }}>
          <Progress
            percent={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
            size="small"
            status="active"
          />
          <Text type="secondary" style={{ fontSize: 11 }}>{progress.text}</Text>
        </div>
      )}

      <Table<Row>
        rowKey={(r) => r.entry.id}
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: setSelectedKeys,
          getCheckboxProps: () => ({ disabled: !reselectable }),
        }}
        locale={{ emptyText: <Empty description="没有候选作品 —— 先在番剧详情面板里给番剧加上角色名，或勾上「包含未填角色名的条目」" /> }}
        scroll={{ y: 420 }}
      />
    </Modal>
  );
};

export default CharacterCompleteModal;
