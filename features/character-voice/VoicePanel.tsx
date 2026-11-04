/**
 * 角色语音面板 — 给一张角色卡抓一段「原声台词」
 *
 * 交互刻意做成「先搜 → 再挑 → 后生成」：
 *   B 站上同名/近似的视频很多（翻唱、声线教学、MAD、鬼畜都混在结果里），
 *   自动挑一个就下载，最省事但对用户最不负责 —— 等 30 秒拿回一段鬼畜的
 *   体验比多点一次差得多。所以候选列表把标题、时长、播放量、UP 主都摆出来，
 *   由人点「用这个生成」。
 *
 * 生成完不自动关窗：用户要能立刻试听，不满意就往上再挑一个源。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Popconfirm, Spin, Tag, Tooltip } from 'antd';
import { catgirlMessage } from '../../src/theme';
import { formatClipDuration } from '../../core/voice-clips';
import type { FfmpegStatus, VoiceCandidate, VoiceInfo } from './voice-service';
import {
  buildVoice,
  deleteVoice,
  fetchVoiceInfo,
  fetchVoiceStatus,
  searchVoice,
  voiceFileUrl,
} from './voice-service';

interface VoicePanelProps {
  open: boolean;
  /** 角色卡标题，同时用作搜索关键词与落盘目录名 */
  characterName: string;
  /**
   * 角色所属作品（角色卡的 char_source，多个用 '/' 分隔）。
   * 用来消歧同名角色 —— 「蕾娜」在 86、魔女之旅、超神学院里都有。
   */
  workTitle?: string;
  onClose: () => void;
  /** 生成/删除成功后回调（角色卡上的播放条要立刻更新；删除时传 null） */
  onSaved: (info: VoiceInfo | null) => void;
}

/** 目标时长：用户要「至少 30 秒」，留 5 秒余量，避免刚好卡在 30.0 被判不足 */
const TARGET_SECONDS = 35;

const VoicePanel: React.FC<VoicePanelProps> = ({ open, characterName, workTitle, onClose, onSaved }) => {
  const [status, setStatus] = useState<FfmpegStatus | null>(null);
  const [keyword, setKeyword] = useState('');
  const [candidates, setCandidates] = useState<VoiceCandidate[]>([]);
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [buildingBvid, setBuildingBvid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 关闭后到达的异步结果不该再 setState（会覆盖下一次打开的状态） */
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const workTitles = useMemo(
    () => String(workTitle ?? '').split('/').map((w) => w.trim()).filter((w) => w.length > 0),
    [workTitle],
  );
  const defaultKeyword = workTitles[0]
    ? `${characterName} ${workTitles[0]} 语音`
    : `${characterName} 语音`;

  const runSearch = useCallback(async (text: string) => {
    setSearching(true);
    setError(null);
    try {
      const list = await searchVoice(characterName, text, workTitles);
      if (!aliveRef.current) return;
      setCandidates(list);
    } catch (e) {
      if (!aliveRef.current) return;
      setCandidates([]);
      setError(e instanceof Error ? e.message : '搜索失败');
    } finally {
      if (aliveRef.current) setSearching(false);
    }
  }, [characterName, workTitles]);

  // 打开时：查 ffmpeg 状态、已有语音、并自动搜一次（省掉「先点一下才看到东西」）
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    const initial = workTitles[0]
      ? `${characterName} ${workTitles[0]} 语音`
      : `${characterName} 语音`;
    setKeyword(initial);
    setCandidates([]);
    setError(null);
    setBuildingBvid(null);
    setInfo(null);

    void (async () => {
      try {
        const next = await fetchVoiceStatus();
        if (aliveRef.current) setStatus(next);
      } catch {
        if (aliveRef.current) {
          setStatus({ ok: false, path: null, version: null, hint: '读不到服务端的 ffmpeg 状态，本地服务可能没起' });
        }
      }
      try {
        const existing = await fetchVoiceInfo(characterName);
        if (aliveRef.current) setInfo(existing);
      } catch {
        // 没有历史语音是常态，不打扰用户
      }
      await runSearch(initial);
    })();
  }, [open, characterName, runSearch]);

  const handleBuild = async (candidate: VoiceCandidate) => {
    setBuildingBvid(candidate.bvid);
    setError(null);
    try {
      const built = await buildVoice({
        bvid: candidate.bvid,
        character: characterName,
        targetSeconds: TARGET_SECONDS,
      });
      if (!aliveRef.current) return;
      setInfo(built);
      onSaved(built);
      if (built.seconds < 30) {
        catgirlMessage.warning(`这个源里只找到 ${Math.round(built.seconds)} 秒人声，不够 30 秒，建议换一个视频`);
      } else {
        catgirlMessage.success(`已生成 ${Math.round(built.seconds)} 秒角色语音`);
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      if (aliveRef.current) setBuildingBvid(null);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteVoice(characterName);
      if (!aliveRef.current) return;
      setInfo(null);
      onSaved(null);
      catgirlMessage.success('已删除这个角色的语音');
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const ffmpegMissing = status !== null && !status.ok;

  return (
    <Modal
      title={`🎙 角色语音 — ${characterName}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={780}
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {ffmpegMissing && (
          <Alert
            type="warning"
            showIcon
            message="本机没有可用的 ffmpeg"
            description={status?.hint}
          />
        )}

        {/* ── 当前已经有语音 ── */}
        {info ? (
          <div style={{
            padding: 10, borderRadius: 8,
            background: 'var(--bg-quaternary)',
            border: '1px solid var(--border-primary)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Tag color="green">已有语音</Tag>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {formatClipDuration(info.seconds)} · 拼了 {info.spans.length} 段
              </span>
              <Tooltip title={info.source.title}>
                <a
                  href={info.source.pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, color: 'var(--brand-primary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  B 站：{info.source.title || info.source.bvid}
                </a>
              </Tooltip>
              <span style={{ flex: 1 }} />
              <Popconfirm
                title="删掉这段语音？"
                description="只删本地 audio 目录里的音频，不影响角色卡其它资料"
                okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
                onConfirm={handleDelete}
              >
                <Button size="small" type="text" danger style={{ fontSize: 11 }}>删除</Button>
              </Popconfirm>
            </div>
            <audio
              key={info.builtAt}
              controls
              preload="metadata"
              src={voiceFileUrl(characterName, info.builtAt)}
              style={{ width: '100%', height: 34 }}
            />
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            这个角色还没有语音。下面是从 B 站搜到的候选，点「用这个生成」即可下载并拼接成
            {TARGET_SECONDS} 秒。
          </div>
        )}

        {/* ── 搜索 ── */}
        <div>
          <Input.Search
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={(value) => void runSearch(value || defaultKeyword)}
            enterButton="搜索"
            loading={searching}
            placeholder={defaultKeyword}
            allowClear
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            搜的是 B 站视频标题。中文搜不到时，把关键词换成日文原名或「ボイス」再试。
          </div>
        </div>

        {error && (
          <Alert
            type="error"
            showIcon
            closable
            message="出错了"
            description={<span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>}
            onClose={() => setError(null)}
          />
        )}

        {/* ── 候选列表 ── */}
        <Spin spinning={!!buildingBvid} tip={`正在下载并拼接「${buildingBvid ?? ''}」的人声，通常 10~30 秒…`}>
          <div style={{
            maxHeight: 360, minHeight: 120, overflowY: 'auto',
            border: '1px solid var(--border-primary)', borderRadius: 8,
          }}>
            {candidates.length === 0 && !searching ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={searching ? '搜索中…' : '没搜到候选视频'}
                style={{ padding: '24px 0' }}
              />
            ) : (
              candidates.map((candidate) => (
                <div
                  key={candidate.bvid}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--border-primary)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Tooltip title={candidate.title}>
                      <div style={{
                        fontSize: 12, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {candidate.title}
                      </div>
                    </Tooltip>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span>{formatClipDuration(candidate.durationSeconds)}</span>
                      <span>{candidate.play.toLocaleString()} 播放</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                        {candidate.author}
                      </span>
                      {candidate.score >= 20 && <Tag color="green" style={{ margin: 0, fontSize: 10 }}>高相关</Tag>}
                      {candidate.durationSeconds < 30 && <Tag color="orange" style={{ margin: 0, fontSize: 10 }}>偏短</Tag>}
                    </div>
                  </div>
                  <Button
                    size="small"
                    type="primary"
                    loading={buildingBvid === candidate.bvid}
                    disabled={ffmpegMissing || (!!buildingBvid && buildingBvid !== candidate.bvid)}
                    onClick={() => void handleBuild(candidate)}
                  >
                    用这个生成
                  </Button>
                </div>
              ))
            )}
          </div>
        </Spin>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          取的是视频音轨里「静音之外的人声」，会跳过开场音乐、挑人声最密的一段拼够时长；
          源里若混了别的角色或旁白，换一个源即可。音频存在本地
          <code style={{ margin: '0 4px', color: 'var(--text-secondary)' }}>audio/{characterName}/voice.mp3</code>
          ，不进 Excel。
        </div>
      </div>
    </Modal>
  );
};

export default VoicePanel;
