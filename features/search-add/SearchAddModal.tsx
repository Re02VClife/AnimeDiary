/**
 * 番剧搜索 + 新增条目 Modal
 *   搜索 Bangumi API → 选择 → 填充信息 → 添加到列表
 */
import { useState, useCallback } from 'react';
import { Modal, Input, List, Button, Spin, message, Empty, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { AnimeEntry, BangumiSearchItem } from '../../src/types';

const { Text, Paragraph } = Typography;

interface SearchAddModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (anime: AnimeEntry) => void;
}

/** 生成唯一 ID */
function uid(): string {
  return 'new-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

const SearchAddModal: React.FC<SearchAddModalProps> = ({ open, onClose, onAdd }) => {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<BangumiSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setSearched(true);
    try {
      // 先尝试 AniList，失败则降级 Bangumi 缓存
      let resp = await fetch(`/api/anilist/search?keyword=${encodeURIComponent(kw)}`);
      if (!resp.ok) {
        resp = await fetch(`/api/bangumi/search?keyword=${encodeURIComponent(kw)}`);
      }
      if (resp.ok) {
        const data = await resp.json();
        setResults(data.list || data || []);
      } else {
        setResults([]);
      }
    } catch {
      // API 不可用，尝试本地缓存
      setResults([]);
      message.info('Bangumi 搜索暂不可用，可手动填写信息');
    } finally {
      setSearching(false);
    }
  }, [keyword]);

  const handleSelect = (item: BangumiSearchItem) => {
    const entry: AnimeEntry = {
      id: uid(),
      title: item.name_cn || item.name,
      titleJa: item.name_cn && item.name !== item.name_cn ? item.name : undefined,
      posterUrl: item.images?.large || item.images?.common || '',
      category: 'watching',
      tags: [],
      scores: [],
      releaseDate: item.air_date || undefined,
      bangumiScore: item.rating?.score || undefined,
      characters: [],
      episodes: item.eps || undefined,
      review: item.summary ? item.summary.slice(0, 200) : undefined,
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
    };
    onAdd(entry);
    message.success(`已添加「${entry.title}」`);
    setKeyword('');
    setResults([]);
    setSearched(false);
    onClose();
  };

  const handleManualAdd = () => {
    const title = keyword.trim();
    if (!title) return;
    const entry: AnimeEntry = {
      id: uid(),
      title,
      posterUrl: '',
      category: 'watching',
      tags: [],
      scores: [],
      releaseDate: undefined,
      characters: [],
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
    };
    onAdd(entry);
    message.success(`已手动添加「${title}」`);
    setKeyword('');
    setResults([]);
    setSearched(false);
    onClose();
  };

  return (
    <Modal
      title="🔍 搜索并添加"
      open={open}
      onCancel={onClose}
      width={600}
      footer={null}
    >
      <Input.Search
        placeholder="输入名称搜索 Bangumi…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={doSearch}
        enterButton={<><SearchOutlined /> 搜索</>}
        size="large"
        loading={searching}
        style={{ marginBottom: 16 }}
      />

      {searching && (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      )}

      {!searching && searched && results.length === 0 && (
        <Empty description="找不到喵~">
          {keyword.trim() && (
            <Button type="primary" onClick={handleManualAdd}>
              手动添加「{keyword.trim()}」
            </Button>
          )}
        </Empty>
      )}

      {!searching && results.length > 0 && (
        <>
          {keyword.trim() && (
            <div style={{ marginBottom: 10 }}>
              <Button type="dashed" block onClick={handleManualAdd}>
                ➕ 不选择以上条目，直接新建「{keyword.trim()}」
              </Button>
            </div>
          )}
          <List
          dataSource={results}
          renderItem={(item) => (
            <List.Item
              extra={
                item.images?.small ? (
                  <img src={item.images.small} alt={item.name} style={{ width: 60, height: 80, objectFit: 'cover', borderRadius: 6 }} />
                ) : null
              }
              style={{ cursor: 'pointer', padding: '8px 12px', borderRadius: 8 }}
              onClick={() => handleSelect(item)}
            >
              <List.Item.Meta
                title={
                  <span style={{ color: 'var(--text-primary)' }}>
                    {item.name_cn || item.name}
                    {item.name_cn && <Text style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>{item.name}</Text>}
                  </span>
                }
                description={
                  <div>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                      {item.air_date || '未知日期'} · {item.eps || '?'}集
                      {item.rating?.score ? ` · 评分 ${item.rating.score}` : ''}
                    </span>
                    {item.summary && (
                      <Paragraph
                        ellipsis={{ rows: 2 }}
                        style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4, marginBottom: 0 }}
                      >
                        {item.summary}
                      </Paragraph>
                    )}
                  </div>
                }
              />
            </List.Item>
          )}
        />
        </>
      )}
    </Modal>
  );
};

export default SearchAddModal;
