/**
 * features/local-library/LocalLibrarySettings — 设置里的「本地」页
 *
 * 三块内容，从上到下就是用户的操作顺序：
 *   1. 存储地址：导入放番剧的根目录（可以有多个，比如 Kazumi 一个、NAS 挂载一个）
 *   2. 番剧目录：扫描结果，每个目录一张卡，能手动绑到某部番上
 *   3. 待确认的匹配：自动识别出来但还没绑的，高置信度可以一键绑
 *
 * 识别结果来自 Bangumi（目录名里的 subject id），见 server/local-library.ts 顶部说明。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, Tooltip, Typography, Popconfirm, Spin, Empty, Tag, message } from 'antd';
import {
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
  DeleteOutlined,
  LinkOutlined,
  DisconnectOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { AnimeEntry } from '../../types';
import { animeKeyFor } from '../../../core/music-links';
import { episodeLabel } from '../../../core/local-library';
import type { LocalFolder } from '../../../core/local-library';
import {
  useLocalLibrary,
  refreshLocalLibrary,
  recomputeSuggestions,
  addLocalSource,
  removeLocalSource,
  bindAnime,
  bindHighConfidenceSuggestions,
} from './local-store';

/** Electron 暴露的选文件夹；浏览器 dev 模式没有，退化为手填路径 */
interface ElectronPickApi {
  pickLocalDir?: () => Promise<string | null>;
}

const LocalLibrarySettings: React.FC<{ animeList: AnimeEntry[] }> = ({ animeList }) => {
  const lib = useLocalLibrary();
  const [pathInput, setPathInput] = useState('');
  const [adding, setAdding] = useState(false);
  const startedRef = useRef(false);

  /** 首次进入设置页时扫一次（带识别）；之后靠「重新扫描」按钮 */
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void refreshLocalLibrary({ identify: true, animeList });
    // 只在挂载时跑一次，animeList 变化由下面的 effect 补算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Excel 数据换了（导入/新增）就补算建议 */
  useEffect(() => {
    if (lib.loaded) recomputeSuggestions(animeList);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animeList.length, lib.loaded]);

  /** 番剧标题下拉（手动绑定用） */
  const animeOptions = useMemo(
    () => animeList.map((a) => ({ value: animeKeyFor(a), label: a.title })),
    [animeList],
  );
  const animeTitleByKey = useMemo(
    () => new Map(animeList.map((a) => [animeKeyFor(a), a.title])),
    [animeList],
  );

  /** 目录 → 当前绑在谁身上（反查） */
  const bindingOfDir = useMemo(() => {
    const map = new Map<string, { key: string; title: string }>();
    for (const [key, binding] of Object.entries(lib.bindings)) {
      for (const dir of binding.dirPaths) {
        map.set(dir, { key, title: animeTitleByKey.get(key) ?? key });
      }
    }
    return map;
  }, [lib.bindings, animeTitleByKey]);

  const stats = useMemo(() => {
    const episodes = lib.folders.reduce((n, f) => n + f.episodes.length, 0);
    const identified = lib.folders.filter((f) => f.identify.state === 'ok').length;
    return { folders: lib.folders.length, episodes, identified };
  }, [lib.folders]);

  const handlePickDir = useCallback(async () => {
    const api = (window as any).electronAPI as ElectronPickApi | undefined;
    if (api?.pickLocalDir) {
      try {
        const dir = await api.pickLocalDir();
        if (dir) setPathInput(dir);
        return;
      } catch {
        /* 落到手填 */
      }
    }
    message.info('浏览器模式没法弹系统对话框，直接粘贴路径吧（桌面版有「选择文件夹」）');
  }, []);

  const handleAdd = useCallback(async () => {
    const raw = pathInput.trim();
    if (!raw) return;
    setAdding(true);
    try {
      const result = await addLocalSource(raw);
      if (!result.ok) {
        message.error(result.error || '添加失败');
        return;
      }
      setPathInput('');
      message.success('已导入，正在扫描…');
      await refreshLocalLibrary({ identify: true, animeList });
    } finally {
      setAdding(false);
    }
  }, [pathInput, animeList]);

  const handleRemove = useCallback(async (path: string) => {
    const result = await removeLocalSource(path);
    if (!result.ok) {
      message.error(result.error || '删除失败');
      return;
    }
    message.success('已移除存储地址');
  }, []);

  const handleRescan = useCallback(() => {
    void refreshLocalLibrary({ identify: true, force: true, animeList });
  }, [animeList]);

  const handleBindFolder = useCallback(async (folder: LocalFolder, key: string | null) => {
    const current = bindingOfDir.get(folder.dirPath);
    if (current?.key === (key ?? '')) return;

    // 先从旧的那部番上摘掉这个目录，再挂到新的上 —— 一个目录只能属于一部番
    if (current) {
      const rest = lib.bindings[current.key].dirPaths.filter((d) => d !== folder.dirPath);
      await bindAnime(current.key, rest);
    }
    if (key) {
      const existing = lib.bindings[key]?.dirPaths ?? [];
      await bindAnime(key, Array.from(new Set([...existing, folder.dirPath])));
    }
  }, [bindingOfDir, lib.bindings]);

  const handleBindAllHigh = useCallback(async () => {
    const count = await bindHighConfidenceSuggestions();
    if (count > 0) message.success(`已绑定 ${count} 部番`);
    else message.info('没有可自动绑定的高置信度匹配');
  }, []);

  const busy = lib.loading || lib.identifying;

  return (
    <div className="local-settings">
      {/* ── 存储地址 ── */}
      <div className="local-section">
        <div className="local-section-head">
          <span className="local-section-title">📁 存储地址</span>
          <span className="local-section-hint">
            放番剧的根目录，可以导入多个。每个子文件夹会被当成一部番。
          </span>
        </div>

        <div className="local-add-row">
          <Input
            size="small"
            placeholder="E:\kazhumi Anime"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onPressEnter={() => void handleAdd()}
          />
          <Tooltip title="选一个文件夹（桌面版）">
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void handlePickDir()} />
          </Tooltip>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            loading={adding}
            disabled={!pathInput.trim()}
            onClick={() => void handleAdd()}
          >
            导入
          </Button>
        </div>

        {lib.sources.length === 0 ? (
          <div className="local-empty">还没有导入存储地址。把上面填成番剧所在目录，点「导入」开始扫描。</div>
        ) : (
          <div className="local-source-list">
            {lib.sources.map((source) => (
              <div key={source.path} className="local-source-row">
                <span className="local-source-label">{source.label}</span>
                <span className="local-source-path" title={source.path}>{source.path}</span>
                <Popconfirm
                  title="移除这个存储地址？"
                  description="只是不再扫描它，硬盘上的文件不会被删；指向它的卡片绑定会一并解除。"
                  okText="移除"
                  cancelText="取消"
                  onConfirm={() => void handleRemove(source.path)}
                >
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 番剧目录 ── */}
      <div className="local-section">
        <div className="local-section-head">
          <span className="local-section-title">🎬 番剧目录</span>
          <span className="local-section-hint">
            {lib.sources.length === 0
              ? '导入存储地址后自动扫描'
              : `${stats.folders} 个目录 · ${stats.episodes} 集 · 已识别 ${stats.identified} 个`}
          </span>
          <div className="local-section-actions">
            <Tooltip title="重新扫描并重新识别（会绕过 Bangumi 缓存）">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={busy}
                disabled={lib.sources.length === 0}
                onClick={handleRescan}
              >
                重新扫描
              </Button>
            </Tooltip>
          </div>
        </div>

        {lib.error && (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {lib.error}
          </Typography.Text>
        )}

        {busy && lib.folders.length === 0 && (
          <div className="local-loading">
            <Spin size="small" />
            <span>{lib.identifying ? '正在向 Bangumi 识别番剧…' : '正在扫描…'}</span>
          </div>
        )}

        {!busy && lib.folders.length === 0 && lib.sources.length > 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="这些目录里没找到视频文件（支持 mp4/mkv/webm/avi/mov/ts）"
            style={{ margin: '16px 0' }}
          />
        )}

        {lib.folders.length > 0 && (
          <div className="local-folder-list">
            {lib.folders.map((folder) => {
              const bound = bindingOfDir.get(folder.dirPath);
              const displayTitle = folder.meta?.nameCn || folder.meta?.name || folder.guessedTitle || folder.dirName;
              const stateTag =
                folder.identify.state === 'ok' ? null
                  : folder.identify.state === 'failed'
                    ? <Tag color="error">识别失败</Tag>
                    : <Tag>未识别</Tag>;
              return (
                <div key={folder.dirPath} className={`local-folder-row${bound ? ' is-bound' : ''}`}>
                  <div className="local-folder-cover">
                    {folder.meta?.posterUrl ? (
                      <img
                        src={folder.meta.posterUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          /**
                           * 图床直连能不能成，取决于「谁在发请求」：
                           *   - 浏览器 / dev:web：渲染进程跟着系统代理走，直连就行；
                           *   - 打包后的 Electron：渲染进程不一定继承系统代理，直连会卡住。
                           * 所以失败一次后退到 /api/images/proxy（服务端走 net.fetch），
                           * 两端各取所长；再失败就只剩占位图标。
                           */
                          const img = e.currentTarget;
                          if (img.dataset.fallback === '1') {
                            img.style.display = 'none';
                            return;
                          }
                          img.dataset.fallback = '1';
                          img.src = `/api/images/proxy?url=${encodeURIComponent(folder.meta?.posterUrl ?? '')}`;
                        }}
                      />
                    ) : (
                      <span aria-hidden>🎞️</span>
                    )}
                  </div>
                  <div className="local-folder-main">
                    <div className="local-folder-title" title={displayTitle}>
                      {displayTitle}
                      {stateTag}
                      {folder.bangumiId && (
                        <span className="local-folder-id">#{folder.bangumiId}</span>
                      )}
                    </div>
                    <div className="local-folder-meta">
                      <span>{folder.episodes.length} 集</span>
                      {folder.episodes.length > 0 && (
                        <span className="local-folder-range">
                          {episodeLabel(folder.episodes[0].number)}–
                          {episodeLabel(folder.episodes[folder.episodes.length - 1].number)}
                        </span>
                      )}
                      <span className="local-folder-dirname" title={folder.dirName}>{folder.dirName}</span>
                    </div>
                    {folder.identify.reason && folder.identify.state !== 'ok' && (
                      <div className="local-folder-reason">{folder.identify.reason}</div>
                    )}
                  </div>
                  <div className="local-folder-bind">
                    <Select
                      size="small"
                      showSearch
                      allowClear
                      placeholder={bound ? bound.title : '绑定到卡片…'}
                      value={bound?.key}
                      optionFilterProp="label"
                      options={animeOptions}
                      onChange={(value) => void handleBindFolder(folder, value ?? null)}
                      className="local-bind-select"
                      popupMatchSelectWidth={false}
                    />
                    {bound && (
                      <Tooltip title="解除绑定">
                        <Button
                          size="small"
                          type="text"
                          icon={<DisconnectOutlined />}
                          onClick={() => void handleBindFolder(folder, null)}
                        />
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 自动匹配建议 ── */}
      {lib.suggestions.length > 0 && (
        <div className="local-section">
          <div className="local-section-head">
            <span className="local-section-title">✨ 自动匹配</span>
            <span className="local-section-hint">
              按 Bangumi ID / 标题相似度自动认出来的，确认后绑到卡片上
            </span>
            <div className="local-section-actions">
              <Tooltip title="只绑「高置信 + 无冲突」的，中低置信度留给手动">
                <Button
                  size="small"
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  disabled={!lib.suggestions.some((s) => s.confidence === 'high' && !s.conflict)}
                  onClick={() => void handleBindAllHigh()}
                >
                  一键绑定高置信度
                </Button>
              </Tooltip>
            </div>
          </div>
          <div className="local-suggest-list">
            {lib.suggestions.map((suggestion) => (
              <div key={suggestion.key} className="local-suggest-row">
                <span className="local-suggest-title" title={suggestion.animeTitle}>
                  {suggestion.animeTitle}
                </span>
                <Tag color={suggestion.confidence === 'high' ? 'success' : 'warning'}>
                  {suggestion.confidence === 'high' ? '高置信' : '存疑'}
                </Tag>
                {suggestion.conflict && <Tag color="error">目录冲突</Tag>}
                <span className="local-suggest-reason">
                  {suggestion.reason === 'bangumiId' ? 'Bangumi ID 一致'
                    : suggestion.reason === 'savedMatch' ? '已确认过的映射'
                      : `标题相似 ${(suggestion.score * 100).toFixed(0)}%`}
                </span>
                <span className="local-suggest-dirs">
                  {suggestion.dirPaths.map((d) => d.split(/[\\/]/).pop()).join(' + ')}
                </span>
                <Button
                  size="small"
                  icon={<LinkOutlined />}
                  onClick={() => void bindAnime(suggestion.key, suggestion.dirPaths)}
                >
                  绑定
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
        绑定关系存在 <code>{'文档/AnimeDiary/local-library.json'}</code>，<strong>不会写进 Excel</strong> ——
        路径属于这台机器，不该跟着表格同步。目录名形如 <code>799_giriGiriLove</code> 时，
        开头的数字就是 Bangumi 番剧 ID，识别不需要猜名字。
      </Typography.Paragraph>
    </div>
  );
};

export default LocalLibrarySettings;
