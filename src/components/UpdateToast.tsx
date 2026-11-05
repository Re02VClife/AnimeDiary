/**
 * 更新提示浮层。
 *
 * 热更新下载完成后只在侧栏的「桌面应用」板块显示一行小字 —— 而那个板块在
 * 展开侧栏后的第 3 屏。实测用户根本不会注意到「已经下好了，重启即生效」。
 * 这里在下载完成时弹一次右上角通知，带「立即重启」按钮。
 *
 * 浏览器里 window.electronAPI 不存在，组件渲染 null。
 */
import React, { useEffect, useRef } from 'react';
import { Button, notification } from 'antd';

const UpdateToast: React.FC = () => {
  const api = window.electronAPI;
  /** 同一个版本只提示一次（onUpdateStatus 每次状态推进都会推一次全量状态） */
  const notifiedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api || typeof api.onUpdateStatus !== 'function') return undefined;

    const notify = (version: string, notes: string) => {
      if (notifiedRef.current === version) return;
      notifiedRef.current = version;
      notification.success({
        key: 'animediary-update-ready',
        message: `新版本 v${version} 已就绪`,
        description: notes
          ? String(notes).slice(0, 140)
          : '重启后生效。数据在 Excel 里，不受影响。',
        placement: 'bottomRight',
        duration: 0, // 常驻，等用户处理
        btn: (
          <Button
            size="small"
            type="primary"
            onClick={() => { void api.restartApp(); }}
          >
            立即重启
          </Button>
        ),
      });
    };

    // 启动时可能已经下载好了（上次开机的自动检查），先查一次
    api.getUpdateStatus()
      .then((s) => { if (s?.downloadedVersion) notify(s.downloadedVersion, s.notes); })
      .catch(() => { /* 主进程未就绪时忽略 */ });

    const off = api.onUpdateStatus((s) => {
      if (s?.downloadedVersion) notify(s.downloadedVersion, s.notes);
    });
    return typeof off === 'function' ? off : undefined;
  }, [api]);

  return null;
};

export default UpdateToast;
