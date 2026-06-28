/**
 * AI 设置面板 — 配置 API Key / Base URL / 模型 / 深度模式开关
 * 模式：Modal（与 DimensionManager 一致）
 */

import { useState, useEffect } from 'react';
import { Modal, Input, Button, Switch, message, Divider } from 'antd';
import { loadAIConfig, saveAIConfig } from './ai-config';
import type { AIConfig } from './ai-config';

interface AISettingsProps {
  open: boolean;
  onClose: () => void;
}

const AISettings: React.FC<AISettingsProps> = ({ open, onClose }) => {
  const [config, setConfig] = useState<AIConfig>(loadAIConfig);
  const [testing, setTesting] = useState(false);

  // 弹窗打开时刷新配置
  useEffect(() => {
    if (open) setConfig(loadAIConfig());
  }, [open]);

  const handleSave = () => {
    saveAIConfig(config);
    message.success('AI 配置已保存');
    onClose();
  };

  /** 测试连接：调 /v1/models 验证 API Key 和 Base URL */
  const handleTest = async () => {
    if (!config.apiKey) {
      message.warning('请先填写 API Key');
      return;
    }
    setTesting(true);
    try {
      const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const modelList = data?.data || [];
        const modelIds = modelList.map((m: { id: string }) => m.id);
        const hasCurrent = modelIds.includes(config.model);
        if (!hasCurrent && modelIds.length > 0) {
          message.success(
            `连接成功！可用模型：${modelIds.slice(0, 5).join(', ')}${modelIds.length > 5 ? '…' : ''}`,
            5,
          );
        } else {
          message.success('连接成功！');
        }
      } else {
        message.error(`连接失败：HTTP ${resp.status}`);
      }
    } catch (e) {
      message.error(
        '连接失败：' + (e instanceof Error ? e.message : '网络错误'),
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      title="🤖 AI 设置"
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      width={460}
      styles={{
        body: { padding: '16px 24px' },
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Base URL */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            API 地址
          </div>
          <Input
            value={config.baseUrl}
            onChange={(e) =>
              setConfig((c) => ({ ...c, baseUrl: e.target.value }))
            }
            placeholder="https://api.deepseek.com/v1"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)',
            }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            支持 DeepSeek / OpenAI / 通义千问 / Ollama 等兼容 OpenAI
            协议的 provider
          </div>
        </div>

        {/* API Key */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            API Key
          </div>
          <Input.Password
            value={config.apiKey}
            onChange={(e) =>
              setConfig((c) => ({ ...c, apiKey: e.target.value }))
            }
            placeholder="sk-…"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)',
            }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            存储在本地 localStorage，不会上传到任何服务器
          </div>
        </div>

        {/* 模型 */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            模型
          </div>
          <Input
            value={config.model}
            onChange={(e) =>
              setConfig((c) => ({ ...c, model: e.target.value }))
            }
            placeholder="deepseek-chat"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* 测试连接 */}
        <Button
          block
          loading={testing}
          onClick={handleTest}
          style={{
            background: 'var(--bg-quaternary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-secondary)',
          }}
        >
          🔌 测试连接
        </Button>

        <Divider style={{ margin: '4px 0', borderColor: 'var(--border-primary)' }} />

        {/* 深度模式开关 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              🔬 深度偏好分析
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              启用后偏好画像将额外采集 Bangumi 评论数据（约 5 万
              token，¥0.1-0.2/次，二期实现）
            </div>
          </div>
          <Switch
            checked={config.deepMode}
            onChange={(v) => setConfig((c) => ({ ...c, deepMode: v }))}
          />
        </div>
      </div>
    </Modal>
  );
};

export default AISettings;
