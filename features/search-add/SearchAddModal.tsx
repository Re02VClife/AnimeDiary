/**
 * 番剧搜索 + 新增条目 Modal
 *
 * 走 /api/media/search 的统一多源搜索（Bangumi + Bilibili），
 * 并把封面**先下载到本地**再入库 —— 直接写外链的话，
 * 一旦图床被墙或下线，这条新番的海报就永远不会显示了。
 */
import { useState, useCallback } from 'react';
import { Modal, Input, List, Button, Spin, message, Empty, Typography, Tag } from 'antd';
import { SearchOutlined, CloudDownloadOutlined } from '@ant-design/icons';
import type { AnimeEntry } from '../../src/types';
import { DEFAULT_TEMPLATE_ID } from '../../src/types';
import {
  searchCandidates, downloadCover, SOURCE_LABEL, type MediaCandidate,
} from '../media-complete/media-service';

const { Text, Paragraph } = Typography;

interface SearchAddModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (anime: AnimeEntry) => void;
  /** 当前激活模板 ID：非默认模板下新增的条目归属该模板 */
  activeTemplateId?: string;
}

/** 生成唯一 ID */
function uid(): string {
  return 'new-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/** 远程封面走本地代理显示（部分图床必须经代理才通，且能避免混合内容问题） */
function previewSrc(url: string): string {
  if (!url) return '';
  return url.startsWith('/api/') ? url : `/api/images/proxy?url=${encodeURIComponent(url)}`;
}

const SearchAddModal: React.FC<SearchAddModalProps> = ({ open, onClose, onAdd, activeTemplateId }) => {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<MediaCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  /** 正在下载封面的候选（key = source:id） */
  const [adding, setAdding] = useState<string | null>(null);

  const doSearch = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setSearched(true);
    try {
      const { candidates, errors } = await searchCandidates(kw, 'auto', 12);
      setResults(candidates);
      if (candidates.length === 0) {
        const detail = Object.values(errors)[0];
        message.info(detail ? `没搜到（${detail}）` : '没搜到，可直接手动添加');
      }
    } catch (e) {
      setResults([]);
      message.warning(`搜索失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSearching(false);
    }
  }, [keyword]);

  const handleSelect = async (item: MediaCandidate) => {
    const key = `${item.source}:${item.sourceId}`;
    setAdding(key);
    const title = item.titleCn || item.title;

    // 封面先下载到本地：外链图床（lain.bgm.tv / s4.anilist.co / i0.hdslb.com）
    // 随时可能连不上，存成外链等于埋一个"以后会突然没图"的坑
    let posterUrl = '';
    if (item.coverUrl) {
      try {
        const dl = await downloadCover(title, item.coverUrl);
        posterUrl = dl.url;
      } catch (e) {
        message.warning(`封面下载失败（${e instanceof Error ? e.message : String(e)}），该条目将不带封面`);
      }
    }

    const entry: AnimeEntry = {
      id: uid(),
      title,
      titleJa: item.title && item.title !== title ? item.title : undefined,
      // 检索名沿用现有约定：存原名（日文），给后续 Bangumi 检索用
      searchAlias: item.title && item.title !== title ? item.title : undefined,
      posterUrl,
      category: 'watching',
      tags: [],
      scores: [],
      releaseDate: item.releaseDate || undefined,
      // ⚠️ B 站评分与 Bangumi 评分不是同一套体系，只有 Bangumi 的才写 BGM
      bangumiScore: item.source === 'bangumi' && item.score ? item.score : undefined,
      bangumiId: item.source === 'bangumi' ? Number(item.sourceId) || undefined : undefined,
      characters: [],
      episodes: item.episodes || undefined,
      studio: item.studio || undefined,
      link: item.link || undefined,
      review: item.summary ? item.summary.slice(0, 200) : undefined,
      // 非默认模板下新增的条目归属当前模板
      templateId: activeTemplateId && activeTemplateId !== DEFAULT_TEMPLATE_ID ? activeTemplateId : undefined,
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
    };
    onAdd(entry);
    message.success(`已添加「${entry.title}」${posterUrl ? '（封面已保存到本地）' : ''}`);
    setAdding(null);
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
      // 非默认模板下新增的条目归属当前模板
      templateId: activeTemplateId && activeTemplateId !== DEFAULT_TEMPLATE_ID ? activeTemplateId : undefined,
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
      width={620}
      footer={null}
    >
      <Input.Search
        placeholder="输入名称搜索 Bangumi / Bilibili…"
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
            renderItem={(item) => {
              const key = `${item.source}:${item.sourceId}`;
              return (
                <List.Item
                  extra={
                    item.coverUrl ? (
                      <img
                        src={previewSrc(item.coverUrl)}
                        alt={item.titleCn}
                        style={{ width: 60, height: 80, objectFit: 'cover', borderRadius: 6, background: 'var(--bg-quaternary)' }}
                      />
                    ) : null
                  }
                  style={{ cursor: 'pointer', padding: '8px 12px', borderRadius: 8, opacity: adding && adding !== key ? 0.5 : 1 }}
                  onClick={() => { if (!adding) void handleSelect(item); }}
                >
                  <List.Item.Meta
                    title={
                      <span style={{ color: 'var(--text-primary)' }}>
                        <Tag color={item.source === 'bangumi' ? 'magenta' : 'blue'} style={{ marginInlineEnd: 6 }}>
                          {SOURCE_LABEL[item.source]}
                        </Tag>
                        {item.titleCn || item.title}
                        {item.titleCn && item.title && item.title !== item.titleCn && (
                          <Text style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>{item.title}</Text>
                        )}
                      </span>
                    }
                    description={
                      <div>
                        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                          {item.releaseDate || '未知日期'} · {item.episodes || '?'}集
                          {/* 评分只认 Bangumi：B 站候选的 score 恒为 null */}
                          {item.source === 'bangumi' && item.score ? ` · 评分 ${item.score}` : ''}
                          {item.studio ? ` · ${item.studio}` : ''}
                        </span>
                        {item.summary && (
                          <Paragraph
                            ellipsis={{ rows: 2 }}
                            style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4, marginBottom: 0 }}
                          >
                            {item.summary}
                          </Paragraph>
                        )}
                        {adding === key && (
                          <Text style={{ fontSize: 12, color: 'var(--brand-primary)' }}>
                            <CloudDownloadOutlined /> 正在下载封面到本地…
                          </Text>
                        )}
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </>
      )}
    </Modal>
  );
};

export default SearchAddModal;
