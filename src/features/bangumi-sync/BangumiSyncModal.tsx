/**
 * BangumiSyncModal — 把本地评分推到 Bangumi
 *
 * 三步：绑账号 → 对条目 → 传评分。
 *
 * 中间那步不能省：本地表里**一条 BGM ID 都没有**（Excel 里根本没有 ID 列），
 * 而番剧标题在 Bangumi 上同名 / 多季 / 衍生作极多，自动匹配只能给候选，
 * 最终确认必须交给人 —— 传错条目是那种「过半年才发现」的错。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  message, Modal, Tabs, Alert, Input, Button, Select, Slider, Checkbox, Progress,
  Tag, Table, Empty, Typography, Space, Avatar, Tooltip, Divider,
} from 'antd';
import { useAnimeContext } from '../../../context/AnimeContext';
import { getTemplate } from '../../../features/anime-data/template-service';
import { calcOverall } from '../../../core/overall';
import {
  DEFAULT_SCORE_MAPPING,
  SCORE_MAPPING_LIMITS,
  mapScore,
  kdeSamples,
  meanOf,
  stdOf,
  type ScoreMapping,
} from '../../../core/bangumi-score';
import { rankCandidates, type MatchCandidate } from '../../../core/bangumi-match';
import type { AnimeEntry, AnimeCategory } from '../../types';
import {
  fetchAccountState, saveCredentials, startLogin, logout,
  uploadCollection, searchBangumi,
  type BangumiAccountState,
} from './bangumi-client';
import { loadMatchMap, matchKey, saveMatch, saveMatches, type SavedMatch } from './bangumi-map';

/** Bangumi 收藏类型：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃 */
const CATEGORY_TO_TYPE: Record<AnimeCategory, number> = {
  wantToWatch: 1,
  watched: 2,
  watching: 3,
  onHold: 4,
  dropped: 5,
};

const CATEGORY_LABEL: Record<AnimeCategory, string> = {
  wantToWatch: '想看',
  watched: '看过',
  watching: '在看',
  onHold: '搁置',
  dropped: '抛弃',
};

type RowStatus = 'idle' | 'searching' | 'done' | 'error';

interface MatchRow {
  key: string;
  entry: AnimeEntry;
  /** 本地加权总评 */
  overall: number;
  candidates: MatchCandidate[];
  selected: number | null;
  selectedName: string;
  score: number;
  status: RowStatus;
  error?: string;
  /** 下拉框里手输的内容：搜不到的番可以直接填 Bangumi ID */
  manualInput?: string;
}

interface UploadRecord {
  key: string;
  title: string;
  subjectId: number;
  rate: number | null;
  ok: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 年份，用于在候选里区分同名季度 */
function yearOf(date?: string): string {
  return date?.match(/\d{4}/)?.[0] ?? '';
}

const BangumiSyncModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { state } = useAnimeContext();
  const [tab, setTab] = useState('account');

  // ── 账号 ──
  const [account, setAccount] = useState<BangumiAccountState | null>(null);
  const [form, setForm] = useState({ clientId: '', clientSecret: '', redirectUri: 'http://127.0.0.1:8765/callback' });
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const pollingRef = useRef<number | null>(null);

  // ── 匹配 ──
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [matching, setMatching] = useState(false);
  const [matchedCount, setMatchedCount] = useState(0);
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);

  // ── 上传 ──
  const [mapping, setMapping] = useState<ScoreMapping>(DEFAULT_SCORE_MAPPING);
  const [syncRate, setSyncRate] = useState(true);
  const [syncType, setSyncType] = useState(true);
  const [syncComment, setSyncComment] = useState(false);
  const [syncTags, setSyncTags] = useState(false);
  const [makePrivate, setMakePrivate] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [records, setRecords] = useState<UploadRecord[]>([]);
  const [doneCount, setDoneCount] = useState(0);

  const overallOf = useCallback((entry: AnimeEntry): number => (
    calcOverall(entry.scores, getTemplate(entry.templateId).dimensions)
  ), []);

  const refreshAccount = useCallback(async () => {
    try {
      const s = await fetchAccountState();
      setAccount(s);
      if (s.clientId) setForm((f) => ({ ...f, clientId: s.clientId ?? '', redirectUri: s.redirectUri || f.redirectUri }));
      return s;
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取账号状态失败');
      return null;
    }
  }, []);

  // 打开时读一次状态
  useEffect(() => {
    if (!open) return;
    void refreshAccount();
  }, [open, refreshAccount]);

  // 授权进行中：每 2 秒问一次服务端，登录成功就停
  useEffect(() => {
    if (!open || !account?.loginPending) return;
    const timer = window.setInterval(async () => {
      const s = await refreshAccount();
      if (s?.loggedIn) {
        window.clearInterval(timer);
        setAuthorizing(false);
        message.success(`已绑定 Bangumi：${s.user?.nickname || s.user?.username}`);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open, account?.loginPending, refreshAccount]);

  // ── 匹配数据初始化 ──
  const buildRows = useCallback(() => {
    const saved: Record<string, SavedMatch> = loadMatchMap();
    const list: MatchRow[] = state.animeList
      .map((entry) => ({ entry, overall: overallOf(entry) }))
      .filter((x) => x.overall > 0)
      .map(({ entry, overall }) => {
        const hit = saved[matchKey(entry.title)];
        return {
          key: matchKey(entry.title),
          entry,
          overall,
          candidates: [],
          selected: hit?.subjectId ?? null,
          selectedName: hit?.subjectName ?? '',
          score: 0,
          status: 'idle' as RowStatus,
        };
      });
    setRows(list);
    setMatchedCount(list.filter((r) => r.selected != null).length);
  }, [state.animeList, overallOf]);

  useEffect(() => {
    if (!open) return;
    buildRows();
    setRecords([]);
    setDoneCount(0);
  }, [open, buildRows]);

  const updateRow = useCallback((key: string, patch: Partial<MatchRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  /** 串行 + 3 路并发地搜候选。逐条落 state，界面能看到一条条填上 */
  const runMatching = useCallback(async () => {
    if (matching) return;
    const queue = rows.filter((r) => r.selected == null && r.status !== 'searching');
    if (queue.length === 0) {
      message.info('没有需要匹配的条目');
      return;
    }
    setMatching(true);
    setMatchedCount(0);
    let cursor = 0;
    const picked: Array<{ title: string; subjectId: number; subjectName: string }> = [];

    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        updateRow(row.key, { status: 'searching' });
        try {
          const candidates = await searchBangumi(row.entry.title);
          const ranked = rankCandidates(
            {
              title: row.entry.title,
              titleJa: row.entry.titleJa,
              searchAlias: row.entry.searchAlias,
              releaseDate: row.entry.releaseDate,
            },
            candidates,
            10,
          );
          const best = ranked[0];
          // 只有高置信才自动选中；中置信留给人点一下
          const auto = best && best.confidence === 'high' ? best.candidate : null;
          updateRow(row.key, {
            candidates: ranked.map((x) => x.candidate),
            selected: auto?.id ?? null,
            selectedName: auto ? (auto.nameCn || auto.name) : '',
            score: best?.score ?? 0,
            status: 'done',
          });
          if (auto) picked.push({ title: row.entry.title, subjectId: auto.id, subjectName: auto.nameCn || auto.name });
        } catch (e) {
          updateRow(row.key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      }
    };

    await Promise.all([worker(), worker(), worker()]);
    setMatching(false);
    if (picked.length > 0) saveMatches(picked);
    // 队列里只会出现「原本没匹配」的条目，所以直接累加即可
    if (picked.length > 0) setMatchedCount((n) => n + picked.length);
    message.success(`匹配完成：自动对上 ${picked.length} 条，其余请手动选择`);
  }, [matching, rows, updateRow]);

  const pickCandidate = useCallback((row: MatchRow, subjectId: number | null) => {
    const candidate = row.candidates.find((c) => c.id === subjectId);
    const name = candidate ? (candidate.nameCn || candidate.name) : '';
    updateRow(row.key, { selected: subjectId, selectedName: name });
    if (subjectId != null) {
      saveMatch(row.entry.title, subjectId, name);
      setMatchedCount((n) => (row.selected == null ? n + 1 : n));
    } else if (row.selected != null) {
      setMatchedCount((n) => Math.max(0, n - 1));
    }
  }, [updateRow]);

  // ── 上传 ──
  const selectedRows = useMemo(
    () => rows.filter((r) => r.selected != null),
    [rows],
  );

  /**
   * 缩放中心用「这批数据的均值」，而不是写死的 8。
   *
   * 写死 8 的后果：本地均值是 7.19，斜率一放大，均值就被推着跑（×1.5 时
   * 均值会掉到 6.8），用户得靠 offset 把它拽回来 —— 两个旋钮互相干扰。
   * 以均值为轴缩放，斜率只管分散程度、offset 只管整体高低，互不牵连。
   */
  const localMean = useMemo(
    () => meanOf(selectedRows.map((r) => r.overall)) ?? DEFAULT_SCORE_MAPPING.center,
    [selectedRows],
  );

  const effectiveMapping = useMemo(
    () => ({ ...mapping, center: localMean }),
    [mapping, localMean],
  );

  const mapped = useMemo(
    () => selectedRows.map((r) => ({ row: r, rate: mapScore(r.overall, effectiveMapping) })),
    [selectedRows, effectiveMapping],
  );

  const startUpload = useCallback(async () => {
    if (uploading || mapped.length === 0) return;
    setUploading(true);
    setRecords([]);
    setDoneCount(0);

    let consecutiveFails = 0;
    for (const item of mapped) {
      const entry = item.row.entry;
      const payload: Parameters<typeof uploadCollection>[1] = {};
      if (syncRate && item.rate != null) payload.rate = item.rate;
      if (syncType) payload.type = CATEGORY_TO_TYPE[entry.category] ?? 2;
      if (syncComment && entry.review?.trim()) payload.comment = entry.review.trim();
      if (syncTags && entry.tags?.length) {
        // Bangumi 的 tag 不能含空格，太长的也去掉（tag 是给人筛的，不是备注）
        const tags = entry.tags
          .map((t) => t.name.replace(/\s+/g, ''))
          .filter((t) => t.length > 0 && t.length <= 20)
          .slice(0, 10);
        if (tags.length > 0) payload.tags = tags;
      }
      if (makePrivate) payload.private = true;

      const result = await uploadCollection(item.row.selected!, payload);
      setRecords((prev) => [...prev, {
        key: item.row.key,
        title: entry.title,
        subjectId: item.row.selected!,
        rate: item.rate,
        ok: result.ok,
        error: result.ok ? undefined : (result.error || `HTTP ${result.status}`),
      }]);
      setDoneCount((n) => n + 1);
      consecutiveFails = result.ok ? 0 : consecutiveFails + 1;
      if (consecutiveFails >= 3) {
        // 连着失败基本是 token 失效或被限流，继续发只会刷一屏同样的错误
        message.error('连续 3 条失败，已暂停。检查账号状态或代理后重试');
        break;
      }
      // 官方没有公布写接口的限流阈值，按 400ms 一条走，189 条约 75 秒
      await sleep(400);
    }

    setUploading(false);
    message.success('上传结束，结果见下方列表');
  }, [uploading, mapped, syncRate, syncType, syncComment, syncTags, makePrivate]);

  const visibleRows = onlyUnmatched ? rows.filter((r) => r.selected == null) : rows;
  const failed = records.filter((r) => !r.ok);
  const loggedIn = !!account?.loggedIn;

  // ── 账号页 ──
  const handleSaveCredentials = async () => {
    setSaving(true);
    try {
      // 服务端从不回传 clientSecret，所以输入框在「已保存过」时是空的。
      // 空值不能当成「清空」发出去，否则用户只改回调地址就会把 secret 抹掉。
      const payload: { clientId?: string; clientSecret?: string; redirectUri?: string } = {
        clientId: form.clientId,
        redirectUri: form.redirectUri,
      };
      if (form.clientSecret.trim()) payload.clientSecret = form.clientSecret.trim();
      const s = await saveCredentials(payload);
      setAccount(s);
      setForm((f) => ({ ...f, clientSecret: '' }));
      message.success('凭据已保存');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleLogin = async () => {
    setAuthorizing(true);
    try {
      const { url, state: s } = await startLogin();
      setAccount(s);
      // Electron 里 setWindowOpenHandler 会把外链交给系统浏览器；浏览器里直接开新标签
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) message.warning('浏览器拦截了新窗口，请手动打开控制台里的授权链接');
      console.info('[Bangumi] 授权链接：', url);
    } catch (e) {
      setAuthorizing(false);
      message.error(e instanceof Error ? e.message : '发起授权失败');
    }
  };

  const accountPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert
        type="info"
        showIcon
        message="需要先在 Bangumi 注册一个应用"
        description={
          <div style={{ fontSize: 12, lineHeight: 1.8 }}>
            打开 <a href="https://bgm.tv/dev/app" target="_blank" rel="noreferrer">bgm.tv/dev/app</a> 创建应用，
            回调地址填下面的「回调地址」原样内容（端口要和这里一致）。创建后把 App ID / App Secret 填进来。
            <br />
            授权只会拿到你自己的收藏读写权限，应用凭据保存在本机数据目录，不会上传到任何地方。
          </div>
        }
      />

      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Input
          addonBefore="App ID"
          value={form.clientId}
          onChange={(e) => setForm({ ...form, clientId: e.target.value })}
          placeholder="例如 12345"
        />
        <Input.Password
          addonBefore="App Secret"
          value={form.clientSecret}
          onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
          placeholder="只用于在本机换取 token"
        />
        <Input
          addonBefore="回调地址"
          value={form.redirectUri}
          onChange={(e) => setForm({ ...form, redirectUri: e.target.value })}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          端口必须固定（授权完成后由本机在 127.0.0.1 上接 code）。8765 被占用就换一个，两个地方一起改。
        </Typography.Text>
      </Space>

      <Space>
        <Button onClick={handleSaveCredentials} loading={saving}>保存凭据</Button>
        <Button
          type="primary"
          onClick={handleLogin}
          disabled={!account?.configured}
          loading={authorizing}
        >
          {account?.configured ? '打开授权页' : '先保存凭据'}
        </Button>
        {account?.loginPending && <Tag color="processing">等待浏览器授权…</Tag>}
      </Space>

      <Divider style={{ margin: '4px 0' }} />

      {loggedIn ? (
        <Space size={12}>
          <Avatar src={account?.user?.avatar}>{account?.user?.nickname?.[0]}</Avatar>
          <div>
            <div style={{ fontWeight: 600 }}>{account?.user?.nickname || account?.user?.username}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              @{account?.user?.username}
              {account?.expiresAt ? ` · token 到期 ${new Date(account.expiresAt).toLocaleString()}` : ' · 长期有效'}
            </Typography.Text>
          </div>
          <Button
            size="small"
            danger
            onClick={async () => {
              setAccount(await logout());
              message.success('已退出 Bangumi');
            }}
          >
            退出
          </Button>
        </Space>
      ) : (
        <Typography.Text type="secondary">尚未绑定账号。</Typography.Text>
      )}
    </div>
  );

  // ── 匹配页 ──
  const columns = [
    {
      title: '本地条目',
      dataIndex: 'title',
      width: 220,
      render: (_: unknown, row: MatchRow) => (
        <div>
          <div style={{ fontSize: 13 }}>{row.entry.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {[yearOf(row.entry.releaseDate), CATEGORY_LABEL[row.entry.category]].filter(Boolean).join(' · ')}
          </div>
        </div>
      ),
    },
    {
      title: '总评',
      dataIndex: 'overall',
      width: 70,
      render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v.toFixed(2)}</span>,
    },
    {
      title: 'Bangumi 条目',
      dataIndex: 'selected',
      render: (_: unknown, row: MatchRow) => {
        const options = row.candidates.map((c) => ({
          value: c.id,
          label: `${c.nameCn || c.name}${c.airDate ? ` · ${c.airDate.slice(0, 4)}` : ''}`,
        }));
        if (row.selected != null && !options.some((o) => o.value === row.selected)) {
          options.unshift({ value: row.selected, label: row.selectedName || `#${row.selected}` });
        }
        // 搜不到的条目（拼写不一致 / 冷门 / 剧场版分集）允许直接手填 ID：
        // 打开下拉框输入纯数字，会多出一个「使用手填 ID」的选项
        const manualText = (row.manualInput ?? '').trim();
        const manualId = /^\d+$/.test(manualText) ? Number(manualText) : null;
        if (manualId && !options.some((o) => o.value === manualId)) {
          options.unshift({ value: manualId, label: `使用手填 ID ${manualId}` });
        }
        return (
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder={row.status === 'searching' ? '搜索中…' : '未匹配（可输入数字 ID）'}
            value={row.selected ?? undefined}
            options={options}
            allowClear
            showSearch
            optionFilterProp="label"
            onSearch={(v) => updateRow(row.key, { manualInput: v })}
            onChange={(v) => {
              updateRow(row.key, { manualInput: '' });
              pickCandidate(row, v ?? null);
            }}
            notFoundContent={<span style={{ fontSize: 12 }}>没有候选，输入 Bangumi 条目 ID 可直接指定</span>}
          />
        );
      },
    },
    {
      title: '置信度',
      dataIndex: 'score',
      width: 90,
      render: (score: number, row: MatchRow) => {
        if (row.status === 'searching') return <Tag>…</Tag>;
        if (row.status === 'error') return <Tooltip title={row.error}><Tag color="error">失败</Tag></Tooltip>;
        if (score >= 0.88) return <Tag color="success">高</Tag>;
        if (score >= 0.6) return <Tag color="warning">待确认</Tag>;
        if (row.selected != null) return <Tag color="default">手动</Tag>;
        return <Tag color="default">未匹配</Tag>;
      },
    },
  ];

  const matchPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Alert
        type="warning"
        showIcon
        message="这一步不能跳过"
        description={
          <span style={{ fontSize: 12 }}>
            本地表里没有 Bangumi 条目 ID，得先对一遍。只有「高」置信度会自动勾上，
            「待确认」的一定要点开看一眼 —— 同名书籍、续作、OVA 在搜索结果里经常挨着。
            搜不到的条目可以在下拉框里直接输入 Bangumi 条目 ID（bgm.tv 地址栏里 subject 后面那串数字）。
          </span>
        }
      />
      <Space wrap>
        <Button type="primary" onClick={runMatching} loading={matching}>
          {matching ? `匹配中…` : '开始自动匹配'}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {rows.length} 条 · 已对上 {matchedCount} 条
        </Typography.Text>
        <Checkbox checked={onlyUnmatched} onChange={(e) => setOnlyUnmatched(e.target.checked)}>
          只看未匹配
        </Checkbox>
      </Space>
      {matching && (
        <Progress
          percent={Math.round((rows.filter((r) => r.status === 'done').length / Math.max(1, rows.length)) * 100)}
          size="small"
        />
      )}
      <Table
        size="small"
        rowKey="key"
        dataSource={visibleRows}
        columns={columns}
        pagination={{ pageSize: 15, showSizeChanger: false, size: 'small' }}
        scroll={{ y: 360 }}
        locale={{ emptyText: <Empty description={rows.length === 0 ? '没有已打分的条目' : '都匹配好了'} /> }}
      />
    </div>
  );

  // ── 上传页 ──
  const currentHist = useMemo(() => {
    const b = new Array(11).fill(0);
    for (const m of mapped) {
      if (m.rate != null) b[m.rate]++;
    }
    return b;
  }, [mapped]);

  const defaultHist = useMemo(() => {
    const b = new Array(11).fill(0);
    for (const m of mapped) {
      const v = mapScore(m.row.overall, DEFAULT_SCORE_MAPPING);
      if (v != null) b[v]++;
    }
    return b;
  }, [mapped]);

  const atMax = currentHist[10];
  const atMin = currentHist[1];

  /**
   * 这批番在 Bangumi 上的社区评分（本地 Excel 的 BGM 列）。
   * 它是小数，落不进整数档，所以用核密度曲线画形状，给映射结果做参照 ——
   * 一眼就能看出「我把 8.2 的番推到 9 分」是不是整体偏高。
   */
  const bgmScores = useMemo(
    () => selectedRows
      .map((r) => r.entry.bangumiScore)
      .filter((v): v is number => typeof v === 'number' && v > 0),
    [selectedRows],
  );

  const bgmCurve = useMemo(() => {
    const pts = kdeSamples(bgmScores);
    if (pts.length === 0) return [];
    const peak = Math.max(...pts.map((p) => p.density)) || 1;
    return pts.map((p) => ({
      // 柱状图第 k 档的中心在整宽的 (k-0.5)*10%，曲线按同一坐标换算才能对齐
      x: (p.x - 0.5) * 10,
      y: 64 - (p.density / peak) * 60,
    }));
  }, [bgmScores]);

  const bgmAvg = useMemo(() => meanOf(bgmScores), [bgmScores]);
  const myAvg = useMemo(
    () => meanOf(mapped.map((m) => m.rate).filter((v): v is number => v != null)),
    [mapped],
  );

  /** 三组标准差：本地的、社区的和映射后的。回答「我比大众分散多少、映射后还剩多少」 */
  const localStd = useMemo(() => stdOf(selectedRows.map((r) => r.overall)), [selectedRows]);
  const bgmStd = useMemo(() => stdOf(bgmScores), [bgmScores]);
  const mappedStd = useMemo(
    () => stdOf(mapped.map((m) => m.rate).filter((v): v is number => v != null)),
    [mapped],
  );

  const uploadPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!loggedIn && <Alert type="warning" showIcon message="还没绑定账号，先去「账号」页完成授权" />}
      {mapped.length === 0 && <Alert type="info" showIcon message="还没有匹配到任何条目，先去「匹配」页" />}

      <div>
        <Typography.Text style={{ fontSize: 13, fontWeight: 600 }}>分数映射</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          本地总评是加权平均的连续值，Bangumi 只收 1-10 的整数。下面的柱状图里
          <span style={{ color: 'var(--text-secondary)' }}> 灰色是直接四舍五入 </span>，
          <span style={{ color: 'var(--brand-primary)' }}> 彩色是你当前这套旋钮的结果 </span>，
          蓝线是这些番<strong>在 Bangumi 上</strong>的社区评分分布（小数落不进整数档，所以画成拟合曲线；
          曲线按最高点归一化，只比形状不比绝对值）。
          <br />
          斜率以这批的均值 <strong>{localMean.toFixed(2)}</strong> 分为轴缩放，所以调它只会改变分散程度，
          不会把整体高低带跑；要整体挪动就调偏移。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }} size={2}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 64, fontSize: 12 }}>整体偏移</span>
            <Slider
              style={{ flex: 1 }}
              min={SCORE_MAPPING_LIMITS.offset.min}
              max={SCORE_MAPPING_LIMITS.offset.max}
              step={0.1}
              value={mapping.offset}
              onChange={(v) => setMapping((m) => ({ ...m, offset: v }))}
              tooltip={{ formatter: (v) => `${v! > 0 ? '+' : ''}${v}` }}
            />
            <span style={{ width: 40, textAlign: 'right', fontSize: 12 }}>{mapping.offset > 0 ? '+' : ''}{mapping.offset}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 64, fontSize: 12 }}>斜率</span>
            <Slider
              style={{ flex: 1 }}
              min={SCORE_MAPPING_LIMITS.slope.min}
              max={SCORE_MAPPING_LIMITS.slope.max}
              step={0.05}
              value={mapping.slope}
              onChange={(v) => setMapping((m) => ({ ...m, slope: v }))}
              tooltip={{ formatter: (v) => `×${v}` }}
            />
            <span style={{ width: 40, textAlign: 'right', fontSize: 12 }}>×{mapping.slope}</span>
          </div>
        </Space>
      </div>

      <div style={{ position: 'relative' }}>
        {bgmCurve.length > 1 && (
          <svg
            viewBox="0 0 100 64"
            preserveAspectRatio="none"
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 64, pointerEvents: 'none' }}
            aria-hidden
          >
            <polyline
              points={bgmCurve.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
              fill="none"
              stroke="var(--color-info)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
          </svg>
        )}
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 90 }}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((score) => (
            <div key={score} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 1, height: 64 }}>
                <div
                  title={`直接四舍五入：${defaultHist[score]} 条`}
                  style={{
                    width: 8,
                    height: Math.max(2, (defaultHist[score] / Math.max(1, Math.max(...defaultHist))) * 64),
                    background: 'var(--text-secondary)',
                    opacity: 0.35,
                    borderRadius: 2,
                  }}
                />
                <div
                  title={`当前映射：${currentHist[score]} 条`}
                  style={{
                    width: 8,
                    height: Math.max(2, (currentHist[score] / Math.max(1, Math.max(...currentHist))) * 64),
                    background: 'var(--brand-primary)',
                    borderRadius: 2,
                  }}
                />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{score}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-secondary)', marginTop: -2 }}>
        <span>
          <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--text-secondary)', opacity: 0.4, marginRight: 5 }} />
          直接四舍五入
        </span>
        <span>
          <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--brand-primary)', marginRight: 5 }} />
          当前映射
        </span>
        <span>
          <i style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--color-info)', verticalAlign: 'middle', marginRight: 5 }} />
          Bangumi 社区评分{bgmScores.length > 0 ? `（${bgmScores.length} 部）` : ''}
        </span>
      </div>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {atMax} 条会拿到 10 分（{Math.round((atMax / Math.max(1, mapped.length)) * 100)}%）
        {atMin > 0 ? ` · ${atMin} 条会拿到 1 分` : ''}
      </Typography.Text>

      {bgmAvg != null && myAvg != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          这批番在 Bangumi 平均 {bgmAvg.toFixed(2)} 分，你的映射平均 {myAvg.toFixed(2)} 分 ——
          {Math.abs(myAvg - bgmAvg) < 0.3
            ? ' 基本对齐。'
            : ` 整体${myAvg > bgmAvg ? '高' : '低'} ${Math.abs(myAvg - bgmAvg).toFixed(2)} 分${myAvg > bgmAvg ? '，可以把偏移往负调一点' : '，可以把偏移往正调一点'}。`}
        </Typography.Text>
      )}
      {localStd != null && bgmStd != null && mappedStd != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          分散度（标准差）：本批 {localStd.toFixed(2)} · Bangumi {bgmStd.toFixed(2)} · 映射后 {mappedStd.toFixed(2)}
          {mappedStd > bgmStd
            ? ` —— 是社区的 ${(mappedStd / bgmStd).toFixed(1)} 倍，个人口味被放大了。`
            : ' —— 比社区还收敛，斜率可以往上抬。'}
        </Typography.Text>
      )}
      {bgmScores.length === 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          这批条目没有 Bangumi 评分数据（Excel 的 BGM 列是空的），所以画不出对照曲线。
          用「数据补全」从 Bangumi 拉一次评分就会出现。
        </Typography.Text>
      )}

      <Divider style={{ margin: '2px 0' }} />

      <Space direction="vertical" size={6}>
        <Checkbox checked={syncRate} onChange={(e) => setSyncRate(e.target.checked)}>上传评分</Checkbox>
        <Checkbox checked={syncType} onChange={(e) => setSyncType(e.target.checked)}>
          同时同步收藏状态（想看 / 在看 / 看过 / 搁置 / 抛弃）
        </Checkbox>
        <Checkbox checked={syncComment} onChange={(e) => setSyncComment(e.target.checked)}>
          把「评价」作为短评发出去
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>（会公开，注意别把私人内容带上去）</span>
        </Checkbox>
        <Checkbox checked={syncTags} onChange={(e) => setSyncTags(e.target.checked)}>
          同步标签（最多 10 个，空格会被去掉）
        </Checkbox>
        <Checkbox checked={makePrivate} onChange={(e) => setMakePrivate(e.target.checked)}>收藏设为仅自己可见</Checkbox>
      </Space>

      <Space>
        <Button
          type="primary"
          onClick={startUpload}
          disabled={!loggedIn || mapped.length === 0 || uploading}
          loading={uploading}
        >
          {uploading ? `上传中 ${doneCount}/${mapped.length}` : `开始上传 ${mapped.length} 条`}
        </Button>
        {records.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            成功 {records.length - failed.length} · 失败 {failed.length}
          </Typography.Text>
        )}
      </Space>

      {uploading && <Progress percent={Math.round((doneCount / Math.max(1, mapped.length)) * 100)} />}

      {records.length > 0 && (
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {records.map((r) => (
            <div
              key={r.key}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 8,
                fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
              <span style={{ color: r.ok ? 'var(--brand-primary)' : 'var(--color-error, #f87171)', flexShrink: 0 }}>
                {r.ok ? `✓ ${r.rate ?? '—'} 分` : `✗ ${r.error?.slice(0, 60)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Modal
      title="📤 同步到 Bangumi"
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      destroyOnHidden
      className="bangumi-sync-modal"
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'account', label: `账号${loggedIn ? ' ✓' : ''}`, children: accountPane },
          { key: 'match', label: `匹配 (${matchedCount}/${rows.length})`, children: matchPane },
          { key: 'upload', label: '上传', children: uploadPane },
        ]}
      />
    </Modal>
  );
};

export default BangumiSyncModal;
