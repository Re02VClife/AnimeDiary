/**
 * 追番时间轴组件
 *   基于首刷时间（createdAt）按时间线展示追番历程
 */
import { useMemo, useState } from 'react';
import { Select, Segmented } from 'antd';
import type { AnimeEntry } from '../types';

interface WatchTimelineProps {
  animeList: AnimeEntry[];
  onAnimeClick?: (anime: AnimeEntry) => void;
}

/** 格式化年月显示 */
function formatYM(iso: string): string {
  if (!iso) return '未知';
  const [y, m] = iso.split('-');
  return `${y}年${m}月`;
}

const WatchTimeline: React.FC<WatchTimelineProps> = ({ animeList, onAnimeClick }) => {
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // 按观看时间分组
  const timelineData = useMemo(() => {
    // 筛选有观看时间的条目
    const dated = animeList.filter((a) => a.createdAt && a.createdAt.length >= 7);
    const sorted = [...dated].sort((a, b) => {
      const cmp = (a.createdAt || '').localeCompare(b.createdAt || '');
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    // 按年月分组
    const groups: { label: string; items: AnimeEntry[] }[] = [];
    for (const anime of sorted) {
      const ym = (anime.createdAt || '').slice(0, 7); // YYYY-MM
      const last = groups[groups.length - 1];
      if (last && last.label === ym) {
        last.items.push(anime);
      } else {
        groups.push({ label: ym, items: [anime] });
      }
    }
    return groups;
  }, [animeList, sortOrder]);

  if (timelineData.length === 0) {
    return (
      <div style={{ padding: '20px 10px', textAlign: 'center', color: '#484f58', fontSize: 13 }}>
        暂无追番时间数据
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Segmented
          size="small"
          value={sortOrder}
          onChange={(v) => setSortOrder(v as 'asc' | 'desc')}
          options={[
            { value: 'desc', label: '最新' },
            { value: 'asc', label: '最早' },
          ]}
        />
      </div>

      <div style={{ maxHeight: 400, overflowY: 'auto', paddingRight: 4 }}>
        {timelineData.map((group) => (
          <div key={group.label} style={{ position: 'relative', paddingLeft: 20, marginBottom: 4 }}>
            {/* 时间线竖线 */}
            <div style={{
              position: 'absolute', left: 5, top: 0, bottom: 0,
              width: 2, background: '#30363d',
            }} />
            {/* 时间点 */}
            <div style={{
              position: 'absolute', left: 1, top: 4,
              width: 10, height: 10, borderRadius: '50%',
              background: '#fb7299', border: '2px solid #161b22',
            }} />

            {/* 月份标签 */}
            <div style={{
              fontSize: 11, color: '#fb7299', fontWeight: 600,
              marginBottom: 2, paddingTop: 2,
            }}>
              {formatYM(group.label)}
              <span style={{ color: '#484f58', fontWeight: 400, marginLeft: 6 }}>
                {group.items.length}部
              </span>
            </div>

            {/* 该月的番剧 */}
            {group.items.map((anime) => (
              <div
                key={anime.id}
                onClick={() => onAnimeClick?.(anime)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '3px 8px', marginBottom: 2,
                  borderRadius: 4, cursor: 'pointer',
                  background: 'transparent',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#1c2128'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  fontSize: 12, color: '#e6edf3', flex: 1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {anime.title}
                </span>
                <span style={{ fontSize: 10, color: '#484f58' }}>
                  {(anime.watchDate || anime.createdAt || '').slice(5, 10)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default WatchTimeline;
