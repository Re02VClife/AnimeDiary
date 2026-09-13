/**
 * 批量补全海报（搜索后人工确认）
 *
 * 为什么必须人工审批：自动搜索经常命中错误的番（中文译名尤其如此，
 * 你的海报黑名单就是为此设的）。所以这里只把候选图摆出来，
 * 由你逐条决定「采用」还是「跳过」，绝不直接写进去。
 * 采用的结果写入本地覆盖（IndexedDB），卡片立刻显示；
 * 想永久写进 Excel 的话，之后再点「持久化所有海报」。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, List, Tag, Progress, Empty } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { AnimeEntry } from '../types';
import { searchPoster } from '../../features/anime-data/excel-service';
import { loadPosterBlacklist, savePosterOverride } from '../../features/anime-data/storage-service';
import { catgirlMessage } from '../theme';

type ItemStatus = 'pending' | 'searching' | 'found' | 'notfound' | 'applied' | 'skipped';

interface Item {
  anime: AnimeEntry;
  status: ItemStatus;
  posterUrl: string;
  matchedKeyword: string;
  matchedName: string;
}

interface PosterFixModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  /** 采用后回调，用于同步全局状态 */
  onApplied: (animeId: string, posterUrl: string) => void;
}

const PosterFixModal: React.FC<PosterFixModalProps> = ({ open, onClose, animeList, onApplied }) => {
  const [items, setItems] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);
  const cancelledRef = useRef(false);
  const itemsRef = useRef<Item[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // 打开时重建待处理列表：只挑「没有海报」且「不在你黑名单里」的条目
  useEffect(() => {
    if (!open) {
      cancelledRef.current = true;
      setSearching(false);
      return;
    }
    cancelledRef.current = false;
    const blacklist = loadPosterBlacklist();
    const next: Item[] = animeList
      .filter((a) => !a.posterUrl && a.title && !blacklist.has(a.id))
      .map((a) => ({
        anime: a,
        status: 'pending' as ItemStatus,
        posterUrl: '',
        matchedKeyword: '',
        matchedName: '',
      }));
    setItems(next);
  }, [open, animeList]);

  const updateAt = useCallback((index: number, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }, []);

  const startSearch = useCallback(async () => {
    setSearching(true);
    const list = itemsRef.current;
    for (let i = 0; i < list.length; i++) {
      if (cancelledRef.current) break;
      const cur = itemsRef.current[i];
      if (!cur || cur.status === 'found' || cur.status === 'applied' || cur.status === 'skipped') continue;
      updateAt(i, { status: 'searching' });
      const a = cur.anime;
      const r = await searchPoster(a.searchAlias, a.titleJa, a.title);
      if (cancelledRef.current) break;
      updateAt(i, {
        status: r.posterUrl ? 'found' : 'notfound',
        posterUrl: r.posterUrl,
        matchedKeyword: r.matchedKeyword,
        matchedName: r.matchedName,
      });
      // 轻微限速，避免把 AniList 打挂
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    setSearching(false);
  }, [updateAt]);

  const apply = useCallback(
    (index: number) => {
      const it = itemsRef.current[index];
      if (!it || !it.posterUrl) return;
      savePosterOverride(it.anime.id, it.posterUrl).catch(() => {});
      onApplied(it.anime.id, it.posterUrl);
      updateAt(index, { status: 'applied' });
    },
    [onApplied, updateAt],
  );

  const skip = useCallback((index: number) => updateAt(index, { status: 'skipped' }), [updateAt]);

  const applyAll = useCallback(() => {
    let n = 0;
    itemsRef.current.forEach((it, i) => {
      if (it.status === 'found' && it.posterUrl) {
        apply(i);
        n++;
      }
    });
    if (n > 0) catgirlMessage.success(`已采用 ${n} 张搜索结果`);
  }, [apply]);

  const stats = useMemo(() => {
    const found = items.filter((i) => i.status === 'found').length;
    const applied = items.filter((i) => i.status === 'applied').length;
    const notfound = items.filter((i) => i.status === 'notfound').length;
    const skipped = items.filter((i) => i.status === 'skipped').length;
    return { total: items.length, found, applied, notfound, skipped, done: applied + notfound + skipped };
  }, [items]);

  return (
    <Modal
      title="批量补全海报（搜索后人工确认）"
      open={open}
      onCancel={() => {
        cancelledRef.current = true;
        onClose();
      }}
      width={900}
      footer={[
        <Button
          key="close"
          onClick={() => {
            cancelledRef.current = true;
            onClose();
          }}
        >
          关闭
        </Button>,
      ]}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          待处理 <b style={{ color: 'var(--text-primary)' }}>{stats.total}</b> 部
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>（已排除你删除过海报的条目）</span>
        </span>
        <Button
          type="primary"
          size="small"
          icon={<SearchOutlined />}
          loading={searching}
          disabled={stats.total === 0}
          onClick={startSearch}
        >
          {searching ? '搜索中…' : '开始搜索'}
        </Button>
        <Button size="small" disabled={stats.found === 0} onClick={applyAll}>
          采用全部已找到的（{stats.found}）
        </Button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          已采用 {stats.applied} · 没搜到 {stats.notfound} · 跳过 {stats.skipped}
        </span>
      </div>

      {searching && (
        <Progress
          percent={Math.round((stats.done / Math.max(stats.total, 1)) * 100)}
          size="small"
          style={{ marginBottom: 8 }}
        />
      )}

      <div style={{ maxHeight: '58vh', overflowY: 'auto' }}>
        <List
          size="small"
          dataSource={items}
          locale={{ emptyText: <Empty description="没有需要补全的番剧" /> }}
          renderItem={(it, index) => (
            <List.Item
              actions={[
                <Button
                  key="apply"
                  size="small"
                  type="primary"
                  disabled={!it.posterUrl || it.status === 'applied'}
                  onClick={() => apply(index)}
                >
                  {it.status === 'applied' ? '已采用' : '采用'}
                </Button>,
                <Button key="skip" size="small" onClick={() => skip(index)}>
                  跳过
                </Button>,
              ]}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', width: '100%' }}>
                <div
                  style={{
                    width: 54,
                    height: 72,
                    flexShrink: 0,
                    background: 'var(--bg-tertiary)',
                    borderRadius: 4,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {it.posterUrl ? (
                    <img
                      src={it.posterUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <span style={{ fontSize: 18, opacity: 0.4 }}>🎬</span>
                  )}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{it.anime.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                    {it.status === 'searching' ? (
                      '搜索中…'
                    ) : it.status === 'notfound' ? (
                      '没搜到 —— 可以先在详情里补「检索名」再回来搜'
                    ) : it.matchedName ? (
                      <>
                        命中：{it.matchedName}
                        <Tag style={{ marginLeft: 6, fontSize: 10 }}>{it.matchedKeyword}</Tag>
                      </>
                    ) : it.status === 'applied' ? (
                      '已采用'
                    ) : it.status === 'skipped' ? (
                      '已跳过'
                    ) : (
                      '待搜索'
                    )}
                  </div>
                </div>
              </div>
            </List.Item>
          )}
        />
      </div>
    </Modal>
  );
};

export default PosterFixModal;
