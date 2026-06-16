/**
 * 品味报告 Modal — 双 Tab 三阶段面板
 *
 * 每个分析 Tab 分三个阶段展示：
 *   Phase 1 — 前端数据统计（即时显示，纯计算）
 *   Phase 2 — LLM 思考中（加载动画）
 *   Phase 3 — AI 生成的文字报告
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal, Tabs, Spin, Button, Tag, Empty, Input } from 'antd';
import {
  ReloadOutlined,
  ExperimentOutlined,
  UserOutlined,
  ThunderboltOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  GiftOutlined,
} from '@ant-design/icons';
import type { AnimeEntry } from '../types';
import { DEFAULT_DIMENSIONS, DIMENSION_LABEL_MAP } from '../types';
import { hasAIConfig } from '../services/aiConfig';
import {
  tasteAnalysis,
  preferenceProfile,
  smartRecommend,
  buildTasteStats,
  buildDeviationData,
} from '../services/aiSkills';
import type {
  TasteReport,
  PreferenceProfile,
  TasteStats,
  DeviationData,
  RecommendResult,
} from '../services/aiSkills';
import type { TokenUsage } from '../services/llmService';
import { saveProfileCache, loadProfileCache } from '../services/aiCache';

interface TasteReportModalProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
}

type TabKey = 'taste' | 'profile' | 'recommend';

// ═══════════════════════════════════════════════════════
// 共享工具
// ═══════════════════════════════════════════════════════

/** 粉色渐变进度条 */
const StatBar: React.FC<{ value: number; max: number; label?: string }> = ({
  value,
  max,
  label,
}) => {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
      {label !== undefined && (
        <span style={{ width: 50, fontSize: 11, color: '#8b949e', textAlign: 'right', flexShrink: 0 }}>
          {label}
        </span>
      )}
      <div
        style={{
          flex: 1,
          height: 14,
          background: '#21262d',
          borderRadius: 7,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: 'linear-gradient(90deg, #fb7299, #e85d8a)',
            borderRadius: 7,
            transition: 'width 0.6s ease',
          }}
        />
      </div>
      <span style={{ width: 36, fontSize: 11, color: '#e6edf3', textAlign: 'right', flexShrink: 0 }}>
        {value}%
      </span>
    </div>
  );
};

const SectionTitle: React.FC<{ icon: string; title: string; color?: string }> = ({
  icon,
  title,
  color = '#e6edf3',
}) => (
  <div
    style={{
      fontSize: 13,
      fontWeight: 600,
      color,
      marginBottom: 10,
      marginTop: 4,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}
  >
    <span>{icon}</span> {title}
  </div>
);

const PhaseDivider: React.FC<{ label: string; active: boolean; done: boolean }> = ({
  label,
  active,
  done,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 0',
      margin: '12px 0 8px',
      borderTop: '1px solid #30363d',
      borderBottom: '1px solid #30363d',
    }}
  >
    {done ? (
      <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 13 }} />
    ) : active ? (
      <LoadingOutlined style={{ color: '#fb7299', fontSize: 13 }} />
    ) : (
      <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid #30363d' }} />
    )}
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: active ? '#fb7299' : done ? '#52c41a' : '#484f58',
      }}
    >
      {label}
    </span>
  </div>
);

// ═══════════════════════════════════════════════════════
// Tab 1: 品味分析
// ═══════════════════════════════════════════════════════

const TastePanel: React.FC<{ animeList: AnimeEntry[] }> = ({ animeList }) => {
  // Phase 1 — 前端统计（即时）
  const stats = useMemo(() => buildTasteStats(animeList), [animeList]);

  const [phase, setPhase] = useState<'stats' | 'llm' | 'done'>('stats');
  const [reportText, setReportText] = useState('');
  const [editing, setEditing] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    runningRef.current = false;
    setPhase('stats');
  }, []);

  const runLLM = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase('llm');
    setEditing(false);
    setError(null);
    setReportText('');

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const report = await tasteAnalysis(animeList);
      if (abort.signal.aborted || !runningRef.current) return;

      const s = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
      const lines: string[] = [s(report.summary)];
      if (Array.isArray(report.highlights) && report.highlights.length > 0) {
        lines.push('', '✨ 亮点发现', '');
        report.highlights.forEach((h, i) => lines.push(`${i + 1}. ${s(h)}`));
      }
      if (Array.isArray(report.notes) && report.notes.length > 0) {
        lines.push('', '🔍 细节观察', '');
        report.notes.forEach((n) => lines.push(`· ${s(n)}`));
      }
      setReportText(lines.join('\n'));

      const estPrompt = 1500;
      const estComp = Math.round(lines.join('\n').length / 1.5);
      setUsage({ promptTokens: estPrompt, completionTokens: estComp, totalTokens: estPrompt + estComp });
      setPhase('done');
    } catch (e) {
      if (!abort.signal.aborted && runningRef.current) {
        setError(e instanceof Error ? e.message : '分析失败');
        setPhase('stats');
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }, [animeList]);

  const maxTagCount = Math.max(1, ...stats.topTags.map((t) => t.count));

  return (
    <div style={{ padding: '4px 0' }}>
      {/* ═══ Phase 1: 前端统计 ═══ */}
      <PhaseDivider label="本地数据统计" active={false} done={true} />

      {/* 数据概览 */}
      <div
        style={{
          display: 'flex', gap: 16, marginBottom: 16,
          background: '#0d1117', borderRadius: 8, padding: '10px 16px',
          border: '1px solid #30363d',
        }}
      >
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#fb7299' }}>{stats.animeCount}</div>
          <div style={{ fontSize: 10, color: '#484f58' }}>总番剧</div>
        </div>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#00a1d6' }}>{stats.scoredCount}</div>
          <div style={{ fontSize: 10, color: '#484f58' }}>有评分</div>
        </div>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#ffb347' }}>{stats.topTags.length}</div>
          <div style={{ fontSize: 10, color: '#484f58' }}>活跃标签</div>
        </div>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#52c41a' }}>
            {stats.dimStdDev[0]?.label || '-'}
          </div>
          <div style={{ fontSize: 10, color: '#484f58' }}>最分歧维度</div>
        </div>
      </div>

      {/* 各维度平均百分位 */}
      <SectionTitle icon="📊" title="各维度平均百分位" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
        {DEFAULT_DIMENSIONS
          .filter((d) => d.key !== 'overall')
          .sort((a, b) => (stats.dimAvg[b.key] || 0) - (stats.dimAvg[a.key] || 0))
          .map((dim) => (
            <StatBar
              key={dim.key}
              value={stats.dimAvg[dim.key] || 0}
              max={100}
              label={dim.label}
            />
          ))}
      </div>

      {/* 评分最集中的标签 */}
      <SectionTitle icon="🏷️" title="评分最集中的标签" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {stats.topTags.slice(0, 12).map((t) => (
          <div
            key={t.name}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', borderRadius: 12, fontSize: 11,
              background: '#21262d', border: '1px solid #30363d',
              color: '#8b949e',
            }}
          >
            <span style={{ fontWeight: 600, color: '#e6edf3' }}>{t.name}</span>
            <span style={{ fontSize: 10, color: '#484f58' }}>×{t.count}</span>
            {t.avgScore !== null && (
              <span style={{ fontSize: 10, color: '#fb7299' }}>{t.avgScore}</span>
            )}
          </div>
        ))}
      </div>

      {/* 追番密度 + 品味波动 并排 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        {/* 月度追番密度 */}
        <div style={{ flex: 1 }}>
          <SectionTitle icon="📅" title="追番峰值月" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {stats.topMonths.length === 0 ? (
              <span style={{ fontSize: 11, color: '#484f58' }}>暂无日期数据</span>
            ) : (
              stats.topMonths.map(([m, c]) => (
                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#8b949e', fontFamily: 'monospace' }}>{m}</span>
                  <div style={{ flex: 1, height: 12, background: '#21262d', borderRadius: 6, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min((c / (stats.topMonths[0]?.[1] || 1)) * 100, 100)}%`,
                        background: 'linear-gradient(90deg, #00a1d6, #0090bf)',
                        borderRadius: 6,
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 11, color: '#e6edf3', width: 30, textAlign: 'right' }}>{c}部</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 品味波动 */}
        <div style={{ flex: 1 }}>
          <SectionTitle icon="📈" title="品味分歧度（标准差）" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {stats.dimStdDev.slice(0, 5).map((d) => (
              <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 32, fontSize: 11, color: '#8b949e', textAlign: 'right' }}>{d.label}</span>
                <div style={{ flex: 1, height: 10, background: '#21262d', borderRadius: 5, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min((d.std / 3) * 100, 100)}%`,
                      background: 'linear-gradient(90deg, #ffb347, #e89520)',
                      borderRadius: 5,
                    }}
                  />
                </div>
                <span style={{ fontSize: 10, color: '#e6edf3', width: 36, textAlign: 'right' }}>
                  σ={d.std.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 启动分析按钮（仅在 stats 阶段显示） */}
      {phase === 'stats' && (
        <div style={{ textAlign: 'center', marginTop: 12, marginBottom: 8 }}>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={runLLM}
            style={{
              background: 'linear-gradient(135deg, #fb7299, #e85d8a)',
              border: 'none',
              borderRadius: 20,
              padding: '6px 28px',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            开始 AI 分析
          </Button>
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 6 }}>
            将以上统计数据发送给 AI，生成品味报告（约 2000 token / ¥0.004）
          </div>
        </div>
      )}

      {/* ═══ Phase 2: LLM 分析中 ═══ */}
      {phase === 'llm' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="default" />
          <div style={{ color: '#8b949e', fontSize: 12, marginTop: 10 }}>
            AI 正在分析你的品味数据…
          </div>
          <Button size="small" onClick={handleCancel}
            style={{ marginTop: 12, background: '#21262d', borderColor: '#30363d', color: '#f85149', fontSize: 11 }}>
            取消
          </Button>
        </div>
      )}

      {/* ═══ Phase 3: 分析结果 ═══ */}
      {phase === 'done' && reportText && (
        <>
          <PhaseDivider label="AI 分析报告" active={false} done={true} />

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <Button
              size="small"
              type="text"
              onClick={() => setEditing(!editing)}
              style={{ color: editing ? '#fb7299' : '#484f58', fontSize: 11 }}
            >
              {editing ? '👁 预览' : '✏️ 编辑文案'}
            </Button>
          </div>

          {editing ? (
            <Input.TextArea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              autoSize={{ minRows: 6, maxRows: 20 }}
              style={{
                background: '#0d1117',
                borderColor: '#fb7299',
                color: '#e6edf3',
                fontSize: 13,
                lineHeight: 2,
                fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
              }}
            />
          ) : (
            <div
              style={{
                background: '#0d1117',
                border: '1px solid #30363d',
                borderRadius: 8,
                padding: '14px 18px',
                fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
                fontSize: 13,
                lineHeight: 2,
                color: '#e6edf3',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {reportText}
            </div>
          )}

          {usage && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 14px',
                background: '#161b22',
                border: '1px solid #30363d',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                fontSize: 11,
              }}
            >
              <span style={{ color: '#8b949e' }}>
                📊 本次消耗：
              </span>
              <span style={{ color: '#e6edf3' }}>
                <span style={{ color: '#fb7299', fontWeight: 600 }}>{usage.totalTokens.toLocaleString()}</span> tokens
              </span>
              <span style={{ color: '#484f58' }}>|</span>
              <span style={{ color: '#8b949e' }}>
                输入 <span style={{ color: '#00a1d6' }}>{usage.promptTokens.toLocaleString()}</span>
              </span>
              <span style={{ color: '#8b949e' }}>
                输出 <span style={{ color: '#52c41a' }}>{usage.completionTokens.toLocaleString()}</span>
              </span>
              <span style={{ color: '#484f58' }}>|</span>
              <span style={{ color: '#8b949e' }}>
                预估费用 <span style={{ color: '#ffb347', fontWeight: 600 }}>
                  ¥{(usage.totalTokens / 1_000_000 * 2).toFixed(4)}
                </span>
                <span style={{ fontSize: 9, color: '#484f58' }}>（DeepSeek ¥2/1M tokens）</span>
              </span>
            </div>
          )}
        </>
      )}

      {/* 错误状态 */}
      {error && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ color: '#f85149', fontSize: 12, marginBottom: 8 }}>{error}</div>
          <Button size="small" icon={<ReloadOutlined />} onClick={runLLM}
            style={{ background: '#21262d', borderColor: '#30363d', color: '#e6edf3', fontSize: 11 }}>
            重试
          </Button>
        </div>
      )}

      {/* 重新生成按钮 */}
      {phase === 'done' && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={runLLM}
            style={{ background: '#21262d', borderColor: '#30363d', color: '#8b949e', fontSize: 11 }}>
            重新生成
          </Button>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════
// Tab 2: 偏好画像
// ═══════════════════════════════════════════════════════

const ProfilePanel: React.FC<{ animeList: AnimeEntry[] }> = ({ animeList }) => {
  // Phase 1 — 前端统计（即时）
  const devData = useMemo(() => buildDeviationData(animeList), [animeList]);

  const [phase, setPhase] = useState<'stats' | 'llm' | 'done'>('stats');
  const [reportText, setReportText] = useState('');
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState<PreferenceProfile | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    runningRef.current = false;
    setPhase('stats');
  }, []);

  const runLLM = useCallback(async () => {
    if (devData.samples.length < 5) return;
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase('llm');
    setEditing(false);
    setError(null);
    setReportText('');
    setProfile(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const result = await preferenceProfile(animeList);
      if (abort.signal.aborted || !runningRef.current) return;

      setProfile(result);
      saveProfileCache(result);

      // 构建文本摘要
      const s = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
      const lines: string[] = [];
      if (result.preferenceProfile) lines.push(s(result.preferenceProfile));
      if (result.tasteDeviation) lines.push(s(result.tasteDeviation));
      setReportText(lines.join('\n'));

      const estPrompt = 2500;
      const estComp = 300;
      setUsage({ promptTokens: estPrompt, completionTokens: estComp, totalTokens: estPrompt + estComp });
      setPhase('done');
    } catch (e) {
      if (!abort.signal.aborted && runningRef.current) {
        setError(e instanceof Error ? e.message : '分析失败');
        setPhase('stats');
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }, [animeList, devData.samples.length]);

  const maxHiTag = Math.max(1, ...devData.topHiTags.map(([, c]) => c));
  const maxLoTags = Math.max(1, ...devData.topLoTags.map(([, c]) => c));

  if (devData.samples.length < 5) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center' }}>
        <Empty
          description={
            <span style={{ color: '#8b949e', fontSize: 12 }}>
              需要至少 5 部同时有 BGM 评分和电波评分的番剧才能生成偏好画像
            </span>
          }
        />
        <div style={{ fontSize: 11, color: '#484f58', marginTop: 4 }}>
          口味偏差 = (总评 × 0.4 + 电波 × 0.6) − BGM 评分
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {/* ═══ Phase 1: 口味偏差统计 ═══ */}
      <PhaseDivider label="口味偏差计算" active={false} done={true} />

      {/* 偏差概览 */}
      <div
        style={{
          display: 'flex', gap: 12, marginBottom: 16,
        }}
      >
        <div style={{
          flex: 1, background: 'linear-gradient(135deg, rgba(0,161,214,0.12), rgba(0,161,214,0.04))',
          border: '1px solid rgba(0,161,214,0.15)', borderRadius: 8, padding: '12px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#fb7299' }}>{devData.posCount}</div>
          <div style={{ fontSize: 10, color: '#8b949e' }}>正偏差番（个人 &gt; 社区）</div>
          <div style={{ fontSize: 11, color: '#fb7299', marginTop: 2 }}>平均 +{devData.avgPosDev}</div>
        </div>
        <div style={{
          flex: 1, background: 'linear-gradient(135deg, rgba(248,81,73,0.08), rgba(248,81,73,0.02))',
          border: '1px solid rgba(248,81,73,0.12)', borderRadius: 8, padding: '12px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#f85149' }}>{devData.negCount}</div>
          <div style={{ fontSize: 10, color: '#8b949e' }}>负偏差番（社区 &gt; 个人）</div>
          <div style={{ fontSize: 11, color: '#f85149', marginTop: 2 }}>平均 {devData.avgNegDev}</div>
        </div>
        <div style={{
          flex: 1, background: 'linear-gradient(135deg, rgba(82,196,26,0.08), rgba(82,196,26,0.02))',
          border: '1px solid rgba(82,196,26,0.12)', borderRadius: 8, padding: '12px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#52c41a' }}>{devData.samples.length}</div>
          <div style={{ fontSize: 10, color: '#8b949e' }}>分析样本</div>
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
            偏差极值 + 电波极值去重
          </div>
        </div>
      </div>

      {/* 偏差分布简图 */}
      <SectionTitle icon="📉" title="口味偏差分布" />
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            height: 24,
            borderRadius: 6,
            overflow: 'hidden',
            background: '#21262d',
          }}
        >
          {devData.negCount > 0 && (
            <div
              style={{
                width: `${(devData.negCount / (devData.posCount + devData.negCount)) * 100}%`,
                background: 'linear-gradient(90deg, #f85149, #e0483f)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <span style={{ fontSize: 9, color: '#fff', fontWeight: 600 }}>
                负偏差 {devData.negCount}部
              </span>
            </div>
          )}
          {devData.posCount > 0 && (
            <div
              style={{
                width: `${(devData.posCount / (devData.posCount + devData.negCount)) * 100}%`,
                background: 'linear-gradient(90deg, #fb7299, #e85d8a)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <span style={{ fontSize: 9, color: '#fff', fontWeight: 600 }}>
                正偏差 {devData.posCount}部
              </span>
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex', justifyContent: 'space-between', marginTop: 4,
            fontSize: 9, color: '#484f58',
          }}
        >
          <span>社区 &gt;&gt; 个人</span>
          <span>口味偏差值</span>
          <span>个人 &gt;&gt; 社区</span>
        </div>
      </div>

      {/* 维度均值对比 + 标签共现 并排 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        {/* 维度均值对比 */}
        <div style={{ flex: 1 }}>
          <SectionTitle icon="⚖️" title="高低偏差组维度均值" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {DEFAULT_DIMENSIONS
              .filter((d) => d.key !== 'overall')
              .map((dim) => {
                const hi = devData.dimAvgHi[dim.key] || 0;
                const lo = devData.dimAvgLo[dim.key] || 0;
                const diff = hi - lo;
                return (
                  <div key={dim.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 28, fontSize: 10, color: '#8b949e', textAlign: 'right', flexShrink: 0 }}>
                      {dim.label}
                    </span>
                    <div style={{ flex: 1, display: 'flex', gap: 2, alignItems: 'center' }}>
                      {/* 高偏差组 */}
                      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                        <div
                          style={{
                            height: 8,
                            width: `${Math.min((hi / 10) * 100, 100)}%`,
                            background: 'linear-gradient(90deg, #fb7299, #e85d8a)',
                            borderRadius: 4,
                            minWidth: hi > 0 ? 4 : 0,
                          }}
                        />
                      </div>
                      {/* 差值指示 */}
                      <span style={{
                        fontSize: 8, color: diff > 0.3 ? '#fb7299' : diff < -0.3 ? '#f85149' : '#484f58',
                        width: 28, textAlign: 'center',
                      }}>
                        {diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)}
                      </span>
                      {/* 低偏差组 */}
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            height: 8,
                            width: `${Math.min((lo / 10) * 100, 100)}%`,
                            background: 'linear-gradient(90deg, #484f58, #30363d)',
                            borderRadius: 4,
                            minWidth: lo > 0 ? 4 : 0,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 6, fontSize: 9 }}>
            <span style={{ color: '#fb7299' }}>● 高偏差组</span>
            <span style={{ color: '#484f58' }}>● 低偏差组</span>
          </div>
        </div>

        {/* 标签共现对比 */}
        <div style={{ flex: 1 }}>
          <SectionTitle icon="🏷️" title="标签共现对比" />
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: '#fb7299', marginBottom: 4 }}>高偏差番高频标签</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {devData.topHiTags.map(([name, c]) => (
                <span
                  key={name}
                  style={{
                    padding: '1px 6px', borderRadius: 8, fontSize: 9,
                    background: `rgba(251,114,153,${Math.max(0.05, c / maxHiTag * 0.2)})`,
                    border: '1px solid rgba(251,114,153,0.2)',
                    color: '#fb7299',
                  }}
                >
                  {name}×{c}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#f85149', marginBottom: 4 }}>负偏差番高频标签</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {devData.topLoTags.map(([name, c]) => (
                <span
                  key={name}
                  style={{
                    padding: '1px 6px', borderRadius: 8, fontSize: 9,
                    background: `rgba(248,81,73,${Math.max(0.05, c / Math.max(1, maxLoTags) * 0.2)})`,
                    border: '1px solid rgba(248,81,73,0.15)',
                    color: '#f85149',
                  }}
                >
                  {name}×{c}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 评价关键词 */}
      {devData.keywords.length > 0 && (
        <>
          <SectionTitle icon="💬" title="评价高频词（正偏差番）" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 16 }}>
            {devData.keywords.map((w) => (
              <Tag
                key={w}
                style={{
                  background: '#21262d',
                  border: '1px solid #30363d',
                  color: '#8b949e',
                  fontSize: 10,
                  borderRadius: 10,
                  margin: 0,
                }}
              >
                {w}
              </Tag>
            ))}
          </div>
        </>
      )}

      {/* 样本番剧预览 */}
      <SectionTitle icon="📋" title={`分析样本（${devData.samples.length} 部）`} />
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 16,
          maxHeight: 80, overflowY: 'auto',
        }}
      >
        {devData.samples.map((a) => {
          const dev = devData.withDev.find((d) => d.anime.id === a.id);
          const isPos = dev && dev.deviation > 0;
          return (
            <span
              key={a.id}
              style={{
                padding: '2px 8px', borderRadius: 10, fontSize: 10,
                background: isPos ? 'rgba(251,114,153,0.08)' : 'rgba(248,81,73,0.06)',
                border: `1px solid ${isPos ? 'rgba(251,114,153,0.15)' : 'rgba(248,81,73,0.1)'}`,
                color: isPos ? '#fb7299' : '#f85149',
              }}
            >
              {a.title}
              {dev && (
                <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 3 }}>
                  {dev.deviation > 0 ? '+' : ''}{dev.deviation.toFixed(1)}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* 启动分析按钮 */}
      {phase === 'stats' && (
        <div style={{ textAlign: 'center', marginTop: 12, marginBottom: 8 }}>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={runLLM}
            style={{
              background: 'linear-gradient(135deg, #00a1d6, #0088b8)',
              border: 'none',
              borderRadius: 20,
              padding: '6px 28px',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            开始 AI 分析
          </Button>
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 6 }}>
            将口味偏差数据发送给 AI，生成偏好画像（约 2500 token / ¥0.005）
          </div>
        </div>
      )}

      {/* ═══ Phase 2: LLM 分析中 ═══ */}
      {phase === 'llm' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="default" />
          <div style={{ color: '#8b949e', fontSize: 12, marginTop: 10 }}>
            AI 正在提取你的偏好特征…
          </div>
          <Button size="small" onClick={handleCancel}
            style={{ marginTop: 12, background: '#21262d', borderColor: '#30363d', color: '#f85149', fontSize: 11 }}>
            取消
          </Button>
        </div>
      )}

      {/* ═══ Phase 3: 分析结果 ═══ */}
      {phase === 'done' && profile && (
        <>
          <PhaseDivider label="AI 偏好画像" active={false} done={true} />

          {/* 总结语 */}
          {(profile.preferenceProfile || profile.tasteDeviation) && (
            <div
              style={{
                background: 'linear-gradient(135deg, rgba(0,161,214,0.12), rgba(0,161,214,0.04))',
                border: '1px solid rgba(0,161,214,0.2)',
                borderRadius: 10,
                padding: '14px 18px',
                marginBottom: 14,
                fontSize: 13,
                color: '#00a1d6',
                fontWeight: 600,
                lineHeight: 1.8,
              }}
            >
              <div>{profile.preferenceProfile}</div>
              {profile.tasteDeviation && (
                <div style={{ fontSize: 11, color: '#8b949e', fontWeight: 400, marginTop: 4 }}>
                  {profile.tasteDeviation}
                </div>
              )}
            </div>
          )}

          {/* 偏好倾向卡片 */}
          {profile.likes.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <SectionTitle icon="❤️" title="偏好倾向" color="#fb7299" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {profile.likes.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      background: '#161b22', border: '1px solid #30363d',
                      borderRadius: 8, padding: '10px 14px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>{item.aspect}</span>
                      <Tag color="pink" style={{ fontSize: 9, lineHeight: '16px', margin: 0 }}>
                        {Math.round(item.confidence * 100)}%
                      </Tag>
                    </div>
                    {item.evidence && (
                      <div style={{ fontSize: 11, color: '#8b949e', lineHeight: 1.5 }}>{item.evidence}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 潜在雷区卡片 */}
          {profile.dislikes.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <SectionTitle icon="⚠️" title="潜在雷区" color="#f85149" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {profile.dislikes.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      background: '#161b22', border: '1px solid #30363d',
                      borderRadius: 8, padding: '10px 14px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>{item.aspect}</span>
                      <Tag color="red" style={{ fontSize: 9, lineHeight: '16px', margin: 0 }}>
                        {Math.round(item.confidence * 100)}%
                      </Tag>
                    </div>
                    {item.evidence && (
                      <div style={{ fontSize: 11, color: '#8b949e', lineHeight: 1.5 }}>{item.evidence}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 隐藏宝藏 */}
          {profile.hiddenGems && profile.hiddenGems.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <SectionTitle icon="💎" title="可能错过的宝藏" color="#ffb347" />
              {profile.hiddenGems.map((g, i) => (
                <div key={i} style={{ fontSize: 11, color: '#8b949e', lineHeight: 1.6, padding: '4px 12px', borderLeft: '2px solid #ffb347', marginBottom: 4 }}>
                  <span style={{ color: '#e6edf3', fontWeight: 600 }}>{g.anime}</span> — {g.reason}
                </div>
              ))}
            </div>
          )}

          {/* 可编辑文案 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <Button size="small" type="text" onClick={() => setEditing(!editing)}
              style={{ color: editing ? '#fb7299' : '#484f58', fontSize: 11 }}>
              {editing ? '👁 预览' : '✏️ 编辑文案'}
            </Button>
          </div>
          {editing ? (
            <Input.TextArea value={reportText} onChange={(e) => setReportText(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 16 }}
              style={{ background: '#0d1117', borderColor: '#00a1d6', color: '#e6edf3', fontSize: 12, lineHeight: 1.8,
                fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif' }}
            />
          ) : (
            reportText && (
              <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 8, padding: '12px 16px',
                fontSize: 12, lineHeight: 1.8, color: '#8b949e', whiteSpace: 'pre-wrap' }}>
                {reportText}
              </div>
            )
          )}

          {usage && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 14px',
                background: '#161b22',
                border: '1px solid #30363d',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                fontSize: 11,
              }}
            >
              <span style={{ color: '#8b949e' }}>📊 本次消耗：</span>
              <span style={{ color: '#e6edf3' }}>
                <span style={{ color: '#fb7299', fontWeight: 600 }}>{usage.totalTokens.toLocaleString()}</span> tokens
              </span>
              <span style={{ color: '#484f58' }}>|</span>
              <span style={{ color: '#8b949e' }}>
                输入 <span style={{ color: '#00a1d6' }}>{usage.promptTokens.toLocaleString()}</span>
              </span>
              <span style={{ color: '#8b949e' }}>
                输出 <span style={{ color: '#52c41a' }}>{usage.completionTokens.toLocaleString()}</span>
              </span>
              <span style={{ color: '#484f58' }}>|</span>
              <span style={{ color: '#8b949e' }}>
                预估费用 <span style={{ color: '#ffb347', fontWeight: 600 }}>
                  ¥{(usage.totalTokens / 1_000_000 * 2).toFixed(4)}
                </span>
              </span>
            </div>
          )}
        </>
      )}

      {error && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ color: '#f85149', fontSize: 12, marginBottom: 8 }}>{error}</div>
          <Button size="small" icon={<ReloadOutlined />} onClick={runLLM}
            style={{ background: '#21262d', borderColor: '#30363d', color: '#e6edf3', fontSize: 11 }}>
            重试
          </Button>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={runLLM}
            style={{ background: '#21262d', borderColor: '#30363d', color: '#8b949e', fontSize: 11 }}>
            重新生成
          </Button>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════
// Tab 3: 智能推荐
// ═══════════════════════════════════════════════════════

const RecommendPanel: React.FC<{ animeList: AnimeEntry[] }> = ({ animeList }) => {
  const [phase, setPhase] = useState<'idle' | 'llm' | 'done'>('idle');
  const [recommendations, setRecommendations] = useState<RecommendResult | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    runningRef.current = false;
    setPhase('idle');
  }, []);

  const runLLM = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase('llm');
    setError(null);
    setRecommendations(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const cachedProfile = loadProfileCache();
      const result = await smartRecommend(animeList, cachedProfile);
      if (abort.signal.aborted || !runningRef.current) return;

      setRecommendations(result);
      const estPrompt = 2000;
      const estComp = 300;
      setUsage({ promptTokens: estPrompt, completionTokens: estComp, totalTokens: estPrompt + estComp });
      setPhase('done');
    } catch (e) {
      if (!abort.signal.aborted && runningRef.current) {
        setError(e instanceof Error ? e.message : '推荐生成失败');
        setPhase('idle');
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }, [animeList]);

  return (
    <div style={{ padding: '4px 0' }}>
      {phase === 'idle' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.6 }}>🎯</div>
          <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 4 }}>
            基于你的偏好画像和评分数据，AI 会从候选中推荐最适合你的番剧
          </div>
          <div style={{ fontSize: 10, color: '#484f58', marginBottom: 16 }}>
            {loadProfileCache() ? '已检测到缓存的偏好画像' : '建议先生成偏好画像以获得更精准的推荐'}
          </div>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={runLLM}
            style={{ background: 'linear-gradient(135deg, #ffb347, #e89520)', border: 'none', borderRadius: 20,
              padding: '6px 28px', fontWeight: 600, fontSize: 13 }}>
            生成推荐
          </Button>
          <div style={{ fontSize: 10, color: '#484f58', marginTop: 6 }}>约 600 token / ¥0.001</div>
        </div>
      )}

      {phase === 'llm' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="default" />
          <div style={{ color: '#8b949e', fontSize: 12, marginTop: 10 }}>AI 正在为你筛选推荐…</div>
          <Button size="small" onClick={handleCancel}
            style={{ marginTop: 12, background: '#21262d', borderColor: '#30363d', color: '#f85149', fontSize: 11 }}>
            取消
          </Button>
        </div>
      )}

      {phase === 'done' && recommendations && (
        <>
          <PhaseDivider label="智能推荐" active={false} done={true} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recommendations.recommendations.map((r, i) => (
              <div
                key={i}
                style={{
                  background: 'linear-gradient(135deg, rgba(255,179,71,0.08), rgba(255,179,71,0.02))',
                  border: '1px solid rgba(255,179,71,0.15)',
                  borderRadius: 10,
                  padding: '12px 16px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 11, background: '#ffb347',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: '#fff',
                  }}>{i + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3' }}>{r.title}</span>
                  <Tag color="gold" style={{ fontSize: 9, lineHeight: '16px', margin: 0 }}>
                    {(r.confidence * 100).toFixed(0)}%
                  </Tag>
                </div>
                <div style={{ fontSize: 11, color: '#8b949e', lineHeight: 1.6, marginLeft: 30 }}>
                  {r.reason}
                </div>
              </div>
            ))}
          </div>

          {usage && (
            <div style={{ marginTop: 12, padding: '8px 14px', background: '#161b22', border: '1px solid #30363d',
              borderRadius: 8, display: 'flex', alignItems: 'center', gap: 16, fontSize: 11 }}>
              <span style={{ color: '#8b949e' }}>📊 {usage.totalTokens.toLocaleString()} tokens</span>
              <span style={{ color: '#484f58' }}>|</span>
              <span style={{ color: '#8b949e' }}>
                预估 ¥{(usage.totalTokens / 1_000_000 * 2).toFixed(4)}（DeepSeek ¥2/1M tokens）
              </span>
            </div>
          )}
        </>
      )}

      {error && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ color: '#f85149', fontSize: 12, marginBottom: 8 }}>{error}</div>
          <Button size="small" icon={<ReloadOutlined />} onClick={runLLM}
            style={{ background: '#21262d', borderColor: '#30363d', color: '#e6edf3', fontSize: 11 }}>
            重试
          </Button>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={runLLM}
            style={{ background: '#21262d', borderColor: '#30363d', color: '#8b949e', fontSize: 11 }}>
            重新生成
          </Button>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════
// 主 Modal
// ═══════════════════════════════════════════════════════

const TasteReportModal: React.FC<TasteReportModalProps> = ({
  open,
  onClose,
  animeList,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('taste');

  if (!hasAIConfig()) {
    return (
      <Modal
        title="🤖 AI 品味分析"
        open={open}
        onCancel={onClose}
        footer={null}
        width={640}
      >
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>🔑</div>
          <div style={{ fontSize: 14, color: '#8b949e', marginBottom: 8 }}>
            请先在侧栏「🤖 AI 分析」→「⚙️ AI 设置」中配置 API Key
          </div>
          <div style={{ fontSize: 11, color: '#484f58' }}>
            支持 DeepSeek / OpenAI / 通义千问 / Ollama
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ThunderboltOutlined style={{ color: '#fb7299' }} />
          <span>AI 品味分析</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      className="taste-report-modal"
      styles={{
        body: {
          padding: '16px 24px',
          maxHeight: '72vh',
          overflowY: 'auto',
        },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
        items={[
          {
            key: 'taste',
            label: (
              <span>
                <ExperimentOutlined /> 品味分析
              </span>
            ),
            children: <TastePanel animeList={animeList} />,
          },
          {
            key: 'profile',
            label: (
              <span>
                <UserOutlined /> 偏好画像
              </span>
            ),
            children: <ProfilePanel animeList={animeList} />,
          },
          {
            key: 'recommend',
            label: (
              <span>
                <GiftOutlined /> 智能推荐
              </span>
            ),
            children: <RecommendPanel animeList={animeList} />,
          },
        ]}
        tabBarStyle={{ borderBottomColor: '#30363d', marginBottom: 4 }}
      />
    </Modal>
  );
};

export default TasteReportModal;
