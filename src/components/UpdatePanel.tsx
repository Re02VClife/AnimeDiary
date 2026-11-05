/**
 * 桌面端面板：热更新状态 + 数据目录入口
 * 浏览器里 window.electronAPI 不存在，此时组件不渲染任何内容。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Progress, Tooltip } from 'antd';
import { catgirlMessage } from '../theme';

const UpdatePanel: React.FC = () => {
  const api = window.electronAPI;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [updateUrl, setUpdateUrl] = useState('');
  /** 更新源地址改成输入框（低频操作，但 IPC 一直有，只是以前没界面） */
  const [editingUrl, setEditingUrl] = useState(false);

  useEffect(() => {
    if (!api) return undefined;
    let alive = true;
    api.getUpdateStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    api.getDataDir().then((d) => { if (alive) setDataDir(d); }).catch(() => {});
    // 更新源可能还没配（IPC 偶尔失败），失败就留空
    api.getUpdateConfig()
      .then((c) => { if (alive) setUpdateUrl(c?.updateUrl || ''); })
      .catch(() => {});
    const off = api.onUpdateStatus((s) => { if (alive) setStatus(s); });
    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, [api]);

  const saveUpdateUrl = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.setUpdateUrl(updateUrl.trim());
      setUpdateUrl(next?.updateUrl || '');
      setEditingUrl(false);
      catgirlMessage.success('更新源已保存，下次检查生效');
    } catch (e) {
      catgirlMessage.error('保存失败：' + (e instanceof Error ? e.message : '未知错误'));
    }
  }, [api, updateUrl]);

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

        {/* 更新源：低频配置，点一下才能改，避免误碰 */}
        {editingUrl ? (
          <Input
            size="small"
            autoFocus
            value={updateUrl}
            onChange={(e) => setUpdateUrl(e.target.value)}
            onPressEnter={() => { void saveUpdateUrl(); }}
            onBlur={() => { void saveUpdateUrl(); }}
            placeholder="本地文件夹或 HTTP 目录"
            style={{ fontSize: 12 }}
          />
        ) : (
          <Tooltip title={updateUrl ? `更新源：${updateUrl}` : '未配置更新源'}>
            <Button
              size="small"
              block
              type="text"
              style={{ borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' }}
              onClick={() => setEditingUrl(true)}
            >
              更新源：{updateUrl ? (updateUrl.length > 26 ? '…' + updateUrl.slice(-24) : updateUrl) : '未配置'}
            </Button>
          </Tooltip>
        )}

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
