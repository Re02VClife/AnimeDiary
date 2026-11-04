/**
 * AI 设置面板 — Provider 预设 / 模型列表 / 真实连通测试 / 用量
 *
 * 关键变化：API Key 不再存 localStorage，提交后由服务端写进
 * {DATA_DIR}/ai-config.json，前端只保留"是否已配置"的镜像。
 * （浏览器直连第三方会被 CORS 拦下，OpenCode 这类网关更是必须带会话头。）
 */

import { useState, useEffect, useCallback } from 'react';
import { Modal, Input, Button, Switch, message, Select, InputNumber, Alert, Spin, Tag } from 'antd';
import {
  loadAIConfig,
  initAIConfig,
  saveAIConfig,
  testAIConnection,
  fetchAIModels,
  fetchAIUsage,
} from './ai-config';
import type { AIConfig } from './ai-config';

interface AISettingsProps {
  open: boolean;
  onClose: () => void;
}

interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  todayCalls: number;
  todayCost: number;
}

interface FormState {
  provider: string;
  baseUrl: string;
  model: string;
  deepMode: boolean;
  thinking: 'auto' | 'off';
  maxTokens: number;
  temperature: number;
  apiKey: string;
}

function toForm(config: AIConfig): FormState {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    deepMode: config.deepMode,
    thinking: config.thinking,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    apiKey: '',
  };
}

const AISettings: React.FC<AISettingsProps> = ({ open, onClose }) => {
  const [config, setConfig] = useState<AIConfig>(loadAIConfig);
  const [form, setForm] = useState<FormState>(() => toForm(loadAIConfig()));
  const [models, setModels] = useState<string[]>(loadAIConfig().providers?.[0]?.models || []);
  const [modelSource, setModelSource] = useState<'remote' | 'preset'>('preset');
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs: number;
    model: string;
    error?: string;
    usage?: { totalTokens: number; reasoningTokens: number; cost?: number };
    sample?: string;
  } | null>(null);
  const [usage, setUsage] = useState<UsageTotals | null>(null);

  const preset = config.providers.find((p) => p.id === form.provider);

  const refreshUsage = useCallback(async () => {
    try {
      const data = await fetchAIUsage(10);
      setUsage(data.totals);
    } catch { /* 用量拿不到不影响设置 */ }
  }, []);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const data = await fetchAIModels();
      setModels(data.models);
      setModelSource(data.source);
      if (data.error && data.source === 'preset') {
        message.warning(`模型列表未能从服务端拉取（${data.error}），已显示预设`);
      }
    } catch (e) {
      message.warning(e instanceof Error ? e.message : '获取模型列表失败');
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    (async () => {
      const fresh = await initAIConfig();
      setConfig(fresh);
      setForm(toForm(fresh));
      const p = fresh.providers.find((x) => x.id === fresh.provider);
      setModels(p?.models || []);
      void loadModels();
      void refreshUsage();
    })();
  }, [open, loadModels, refreshUsage]);

  /** 切换 provider：地址和模型跟着预设走 */
  const handleProviderChange = (id: string) => {
    const next = config.providers.find((p) => p.id === id);
    setForm((f) => ({
      ...f,
      provider: id,
      baseUrl: next?.baseUrl || f.baseUrl,
      model: next?.models?.[0] || f.model,
    }));
    setModels(next?.models || []);
    setTestResult(null);
  };

  const buildPatch = () => ({
    provider: form.provider,
    baseUrl: form.baseUrl,
    model: form.model,
    deepMode: form.deepMode,
    thinking: form.thinking,
    maxTokens: form.maxTokens,
    temperature: form.temperature,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
  });

  const persist = async (): Promise<AIConfig> => {
    const next = await saveAIConfig(buildPatch());
    setConfig(next);
    return next;
  };

  const handleSave = async () => {
    if (!form.baseUrl.trim()) { message.warning('请填写 API 地址'); return; }
    if (!form.model.trim()) { message.warning('请选择或填写模型'); return; }
    if (preset?.needsKey && !form.apiKey && !config.hasKey) {
      message.warning('请填写 API Key');
      return;
    }
    try {
      await persist();
      message.success('AI 配置已保存到本机');
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  /** 测试连接：先落盘当前表单，再让服务端真跑一次结构化请求 */
  const handleTest = async () => {
    if (!form.baseUrl.trim()) { message.warning('请填写 API 地址'); return; }
    setTesting(true);
    setTestResult(null);
    try {
      await persist();
      const result = await testAIConnection();
      setTestResult(result);
      if (result.ok) {
        message.success(`连接正常（${result.latencyMs} ms）`);
        void refreshUsage();
      } else {
        message.error(result.error || '连接失败');
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const inputStyle = {
    background: 'var(--bg-primary)',
    borderColor: 'var(--border-primary)',
    color: 'var(--text-primary)',
  } as const;

  return (
    <Modal
      title="🤖 AI 设置"
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      width={560}
      styles={{ body: { padding: '16px 24px', maxHeight: '70vh', overflowY: 'auto' } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Provider */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>服务商</div>
          <Select
            value={form.provider}
            onChange={handleProviderChange}
            style={{ width: '100%' }}
            options={config.providers.map((p) => ({ value: p.id, label: p.label }))}
          />
          {preset?.hint && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{preset.hint}</div>
          )}
        </div>

        {/* Base URL */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>API 地址</div>
          <Input
            value={form.baseUrl}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            placeholder="https://api.deepseek.com/v1"
            style={inputStyle}
          />
        </div>

        {/* Key */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            API Key{' '}
            {config.hasKey && (
              <Tag color="green" style={{ fontSize: 10, marginLeft: 4 }}>
                已保存 {config.keyMask}
              </Tag>
            )}
          </div>
          <Input.Password
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder={config.hasKey ? '留空则沿用已保存的 Key' : 'sk-…'}
            style={inputStyle}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            Key 只写在本机服务端配置文件里，不进 localStorage、不上传
          </div>
        </div>

        {/* 模型 */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span>模型</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {modelSource === 'remote' ? '来自 /models' : '预设列表'}
              <Button
                type="link"
                size="small"
                style={{ fontSize: 10, padding: '0 4px' }}
                loading={loadingModels}
                onClick={() => void loadModels()}
              >
                刷新
              </Button>
            </span>
          </div>
          <Select
            showSearch
            value={form.model || undefined}
            onChange={(v) => setForm((f) => ({ ...f, model: v }))}
            style={{ width: '100%' }}
            placeholder="选择模型，或直接输入模型名"
            options={[...new Set([...models, form.model].filter(Boolean))].map((m) => ({ value: m, label: m }))}
            dropdownRender={(menu) => (
              <>
                {menu}
                <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border-primary)' }}>
                  <Input
                    size="small"
                    placeholder="输入自定义模型名后回车"
                    onPressEnter={(e) => {
                      const value = (e.target as HTMLInputElement).value.trim();
                      if (!value) return;
                      setForm((f) => ({ ...f, model: value }));
                      setModels((prev) => [...new Set([...prev, value])]);
                    }}
                  />
                </div>
              </>
            )}
          />
        </div>

        {/* 高级参数 */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>输出上限</div>
            <InputNumber
              value={form.maxTokens}
              min={512}
              max={32000}
              step={500}
              onChange={(v) => setForm((f) => ({ ...f, maxTokens: v || 3000 }))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>推理模型会先花掉一部分写思维链</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>思考模式</div>
            <Select
              value={form.thinking}
              onChange={(v) => setForm((f) => ({ ...f, thinking: v }))}
              style={{ width: '100%' }}
              options={[
                { value: 'auto', label: '自动（模型决定）' },
                { value: 'off', label: '关闭推理（更快）' },
              ]}
              disabled={!preset?.thinkingParam}
            />
          </div>
        </div>

        <Button block loading={testing} onClick={handleTest}>
          🔌 测试连接（真跑一次结构化请求）
        </Button>

        {testResult && (
          <Alert
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            message={
              testResult.ok
                ? `${testResult.model} · ${testResult.latencyMs} ms · ${testResult.usage?.totalTokens ?? 0} tokens${
                    testResult.usage?.reasoningTokens ? `（其中思考 ${testResult.usage.reasoningTokens}）` : ''
                  }`
                : testResult.error
            }
            description={testResult.sample ? `模型返回：${testResult.sample}` : undefined}
          />
        )}

        {usage && usage.calls > 0 && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            今日调用 {usage.todayCalls} 次
            {usage.todayCost > 0 ? `，花费 $${usage.todayCost.toFixed(4)}` : ''}；
            最近 {usage.calls} 次共 {usage.promptTokens + usage.completionTokens} tokens
          </div>
        )}

        {/* 深度模式 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>🔬 深度偏好分析</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              额外采集 Bangumi 社区评论，逐番归纳后再汇总。调用次数多，耗时和费用明显更高
            </div>
          </div>
          <Switch checked={form.deepMode} onChange={(v) => setForm((f) => ({ ...f, deepMode: v }))} />
        </div>

        {testing && <Spin size="small" />}
      </div>
    </Modal>
  );
};

export default AISettings;
