/**
 * 桌面端面板：热更新状态 + 数据目录入口
 * 浏览器里 window.electronAPI 不存在，此时组件不渲染任何内容。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Progress, Tooltip } from 'antd';
import { catgirlMessage } from '../theme';

const UpdatePanel: React.FC = () => {
  const api = window.electronAPI;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dataDir, setDataDir] = useState('');

  useEffect(() => {
    if (!api) return undefined;
    let alive = true;
    api.getUpdateStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    api.getDataDir().then((d) => { if (alive) setDataDir(d); }).catch(() => {});
    const off = api.onUpdateStatus((s) => { if (alive) setStatus(s); });
    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, [api]);

  const handleCheck = useCallback(async () => {
    if (!api) return;
    try {
      const s = await api.checkUpdate();
      if (s.error) {
        catgirlMessage.error('检查更新失败：' + s.error);
      } else if (s.downloadedVersion) {
        catgirlMessage.success(`已下载 v${s.downloadedVersion}，重启后生效`);
      } else {
        catgirlMessage.success(`已是最新版本（v${s.currentVersion}）`);
      }
    } catch (e) {
      catgirlMessage.error('检查更新失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [api]);

  if (!api || !status) return null;

  const busy = status.checking || status.downloading;
  const hasNew = !!status.downloadedVersion;
  const stateText = status.checking
    ? '正在检查…'
    : status.downloading
      ? `正在下载 ${status.progress}%`
      : hasNew
        ? `v${status.downloadedVersion} 已就绪`
        : status.error
          ? '检查失败'
          : '已是最新';

  return (
    <div className="sidebar-section">
      <div className="section-title">🖥 桌面应用</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
          <span>当前版本</span>
          <span style={{ color: 'var(--text-primary)' }}>
            v{status.currentVersion}
            {status.source === 'update' ? '（热更新）' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
          <span>更新状态</span>
          <Tooltip title={status.error || status.notes || ''}>
            <span style={{ color: hasNew ? 'var(--brand-primary)' : 'var(--text-primary)' }}>{stateText}</span>
          </Tooltip>
        </div>

        {status.downloading && <Progress percent={status.progress} size="small" showInfo={false} />}

        {hasNew && (
          <Button
            size="small"
            type="primary"
            block
            style={{ borderRadius: 6, fontSize: 12 }}
            onClick={() => api.restartApp()}
          >
            重启以应用更新
          </Button>
        )}

        <Button
          size="small"
          block
          loading={busy}
          style={{ borderRadius: 6, fontSize: 12 }}
          onClick={handleCheck}
        >
          检查更新
        </Button>

        {dataDir && (
          <Tooltip title={dataDir}>
            <Button
              size="small"
              block
              style={{ borderRadius: 6, fontSize: 12 }}
              onClick={() => api.openDataDir()}
            >
              打开数据文件夹
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

export default UpdatePanel;
