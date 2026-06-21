/**
 * 单集评价编辑器
 *   选择剧集 → 输入剧情/名场面/评分/观后感
 */
import { useState, useEffect } from 'react';
import { Modal, Input, InputNumber, Select, Button, List, Space, message, Popconfirm, Form } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { AnimeEntry, EpisodeReview as EpisodeReviewType } from '../types';
import { loadEpisodeReviews, saveEpisodeReview, deleteEpisodeReview } from '../../features/anime-data/storage-service';

const { TextArea } = Input;

interface EpisodeReviewProps {
  anime: AnimeEntry;
  open: boolean;
  onClose: () => void;
}

/** 生成 ID */
function uid(): string {
  return 'ep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

const EpisodeReviewComponent: React.FC<EpisodeReviewProps> = ({ anime, open, onClose }) => {
  const [reviews, setReviews] = useState<EpisodeReviewType[]>([]);
  const [editing, setEditing] = useState(false);
  const [epNum, setEpNum] = useState<number>(1);
  const [plot, setPlot] = useState('');
  const [highlights, setHighlights] = useState('');
  const [score, setScore] = useState<number>(8);
  const [impression, setImpression] = useState('');

  useEffect(() => {
    if (open && anime) setReviews(loadEpisodeReviews(anime.id));
  }, [open, anime]);

  const handleSave = () => {
    const review: EpisodeReviewType = {
      id: uid(),
      animeId: anime.id,
      episodeNumber: epNum,
      plot: plot.trim(),
      highlights: highlights.trim(),
      score,
      impression: impression.trim(),
      createdAt: new Date().toISOString(),
    };
    saveEpisodeReview(review);
    setReviews(loadEpisodeReviews(anime.id));
    setEditing(false);
    setPlot(''); setHighlights(''); setScore(8); setImpression('');
    message.success(`第 ${epNum} 集评价已保存`);
  };

  const handleDelete = (id: string) => {
    deleteEpisodeReview(id);
    setReviews((prev) => prev.filter((r) => r.id !== id));
  };

  const epOptions = anime.episodes
    ? Array.from({ length: anime.episodes }, (_, i) => ({ value: i + 1, label: `第 ${i + 1} 集` }))
    : Array.from({ length: 24 }, (_, i) => ({ value: i + 1, label: `第 ${i + 1} 集` }));

  return (
    <Modal
      title={`📺 ${anime.title} — 单集评价`}
      open={open}
      onCancel={onClose}
      width={640}
      footer={null}
    >
      {/* 已有评价列表 */}
      <List
        dataSource={reviews.sort((a, b) => a.episodeNumber - b.episodeNumber)}
        locale={{ emptyText: '暂无单集评价' }}
        renderItem={(r) => (
          <List.Item
            extra={
              <Popconfirm title="删除此评价？" onConfirm={() => handleDelete(r.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            }
          >
            <List.Item.Meta
              title={
                <span style={{ color: '#e6edf3' }}>
                  第 {r.episodeNumber} 集 · 评分 <span style={{ color: '#fb7299' }}>{r.score}</span>
                </span>
              }
              description={
                <div style={{ color: '#8b949e', fontSize: 12 }}>
                  {r.plot && <div>📖 {r.plot}</div>}
                  {r.highlights && <div>🌟 {r.highlights}</div>}
                  {r.impression && <div>💭 {r.impression}</div>}
                </div>
              }
            />
          </List.Item>
        )}
      />

      {/* 新增评价 */}
      {!editing ? (
        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setEditing(true)} style={{ marginTop: 12 }}>
          添加单集评价
        </Button>
      ) : (
        <div style={{ marginTop: 12, padding: 12, background: '#1c2128', borderRadius: 8 }}>
          <Form layout="inline" style={{ marginBottom: 8 }}>
            <Form.Item label="剧集">
              <Select value={epNum} onChange={setEpNum} options={epOptions} style={{ width: 100 }} size="small" />
            </Form.Item>
            <Form.Item label="评分">
              <InputNumber min={0} max={10} step={0.1} value={score} onChange={(v) => setScore(v || 0)} size="small" style={{ width: 72 }} />
            </Form.Item>
          </Form>
          <Input placeholder="主要剧情" value={plot} onChange={(e) => setPlot(e.target.value)}
            style={{ marginBottom: 8, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          <Input placeholder="名场面" value={highlights} onChange={(e) => setHighlights(e.target.value)}
            style={{ marginBottom: 8, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          <TextArea placeholder="观后感" value={impression} onChange={(e) => setImpression(e.target.value)}
            rows={3} style={{ marginBottom: 8, background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }} />
          <Space>
            <Button size="small" type="primary" onClick={handleSave}>保存</Button>
            <Button size="small" onClick={() => setEditing(false)}>取消</Button>
          </Space>
        </div>
      )}
    </Modal>
  );
};

export default EpisodeReviewComponent;
