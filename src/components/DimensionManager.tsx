/**
 * 维度管理 Modal
 *   增删改评分维度 + 权重调整
 */
import { useState, useEffect } from 'react';
import { Modal, Input, InputNumber, Button, Space, List, message, Popconfirm, Slider } from 'antd';
import { PlusOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import type { Dimension } from '../types';
import { loadDimensions, saveDimensions } from '../../features/anime-data/storage-service';

interface DimensionManagerProps {
  open: boolean;
  onClose: () => void;
}

const DimensionManager: React.FC<DimensionManagerProps> = ({ open, onClose }) => {
  const [dimensions, setDims] = useState<Dimension[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newWeight, setNewWeight] = useState(0.1);

  useEffect(() => {
    if (open) setDims(loadDimensions());
  }, [open]);

  const handleSave = () => {
    const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
    if (Math.abs(totalWeight - 1) > 0.01 && dimensions.length > 1) {
      message.warning(`权重总和为 ${totalWeight.toFixed(2)}，建议调整为 1.0`);
    }
    saveDimensions(dimensions);
    message.success('维度配置已保存，刷新后生效');
    onClose();
  };

  const handleAdd = () => {
    if (!newLabel.trim()) { message.warning('请输入维度名称'); return; }
    const key = 'custom_' + newLabel.trim().toLowerCase().replace(/\s+/g, '_');
    setDims((prev) => [...prev, { key, label: newLabel.trim(), description: newDesc.trim(), weight: newWeight }]);
    setNewLabel(''); setNewDesc(''); setNewWeight(0.1);
  };

  const handleDelete = (key: string) => {
    setDims((prev) => prev.filter((d) => d.key !== key));
  };

  const handleWeightChange = (key: string, value: number) => {
    setDims((prev) => prev.map((d) => d.key === key ? { ...d, weight: value } : d));
  };

  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);

  return (
    <Modal
      title="📐 维度管理"
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={<><SaveOutlined /> 保存</>}
      width={560}
    >
      <div style={{ marginBottom: 12, color: '#8b949e', fontSize: 12 }}>
        权重总和：<span style={{ color: totalWeight === 1 ? '#52c41a' : '#fb7299', fontWeight: 600 }}>{totalWeight.toFixed(2)}</span>
        （建议 = 1.0）
      </div>

      <List
        dataSource={dimensions}
        renderItem={(dim) => (
          <List.Item
            extra={
              <Popconfirm title="删除此维度？" onConfirm={() => handleDelete(dim.key)} okText="删除" cancelText="取消">
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            }
          >
            <List.Item.Meta
              title={<span style={{ color: '#e6edf3', fontSize: 14 }}>{dim.label}</span>}
              description={
                <div>
                  <span style={{ color: '#8b949e', fontSize: 12 }}>{dim.description}</span>
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#8b949e', fontSize: 12 }}>权重：</span>
                    <Slider
                      min={0} max={0.5} step={0.01}
                      value={dim.weight}
                      onChange={(v) => handleWeightChange(dim.key, v)}
                      style={{ width: 120, margin: 0 }}
                      tooltip={{ formatter: (v) => `${(v! * 100).toFixed(0)}%` }}
                    />
                    <InputNumber
                      size="small" min={0} max={1} step={0.01}
                      value={dim.weight}
                      onChange={(v) => handleWeightChange(dim.key, v || 0)}
                      style={{ width: 64 }}
                    />
                  </div>
                </div>
              }
            />
          </List.Item>
        )}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 12, padding: 10, background: '#1c2128', borderRadius: 8 }}>
        <Input size="small" placeholder="维度名称" value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)} style={{ width: 100 }} />
        <Input size="small" placeholder="描述" value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)} style={{ flex: 1 }} />
        <InputNumber size="small" min={0} max={0.5} step={0.01} value={newWeight}
          onChange={(v) => setNewWeight(v || 0)} style={{ width: 60 }} />
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
      </div>
    </Modal>
  );
};

export default DimensionManager;
