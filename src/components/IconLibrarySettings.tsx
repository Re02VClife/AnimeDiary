/**
 * IconLibrarySettings — 设置里的「图标库」
 *
 * 列出 AppIcon 支持的功能图标位，可以把任意一个换成角色头像图标
 * （src/assets/icons/portraits-v2、portraits-batch2）。
 * 存储值用 `char:<角色名>` 而不是 URL，构建后哈希变化也不会失效。
 */

import React, { useMemo, useState } from 'react';
import { Button, Modal, message } from 'antd';
import { useTheme } from '../theme/ThemeContext';
import { BUILTIN_ICONS, CHARACTER_ICONS, resolveIconValue } from '../theme/AppIcon';
import type { IconKey } from '../theme/types';

/** 有内置图片的图标位 + 中文名（其余 IconKey 仍是 emoji，不在这里列） */
const ICON_SLOTS: { key: IconKey; label: string }[] = [
  { key: 'anime', label: '番剧' },
  { key: 'search', label: '搜索' },
  { key: 'add', label: '新增' },
  { key: 'edit', label: '编辑' },
  { key: 'delete', label: '删除' },
  { key: 'settings', label: '设置' },
  { key: 'calendar', label: '日历' },
  { key: 'poster', label: '海报' },
  { key: 'tag-manager', label: '标签' },
  { key: 'ai-analysis', label: 'AI 分析' },
  { key: 'radar-chart', label: '雷达图' },
  { key: 'theme', label: '主题' },
  { key: 'template', label: '模板' },
  { key: 'save', label: '保存' },
  { key: 'close', label: '关闭' },
];

const TILE_SIZE = 64;

const IconLibrarySettings: React.FC = () => {
  const { state, setCustomIcons } = useTheme();
  const [picking, setPicking] = useState<IconKey | null>(null);

  const builtin = BUILTIN_ICONS[state.themeMode] || {};
  const characters = useMemo(
    () => Object.keys(CHARACTER_ICONS).sort((a, b) => a.localeCompare(b, 'zh')),
    [],
  );

  const currentUrl = (key: IconKey) =>
    resolveIconValue(state.customIcons[key]) || builtin[key] || '';

  const isCustomized = (key: IconKey) => Boolean(state.customIcons[key]);

  const applyIcon = (value: string) => {
    if (!picking) return;
    setCustomIcons({ [picking]: value });
    message.success(`已替换「${ICON_SLOTS.find((s) => s.key === picking)?.label || picking}」图标`);
    setPicking(null);
  };

  const resetIcon = (key: IconKey) => {
    setCustomIcons({ [key]: '' });
    message.success('已恢复默认图标');
  };

  const renderTile = (url: string, title: string, onClick: () => void, hint?: string) => (
    <button
      key={title + url}
      type="button"
      title={title}
      onClick={onClick}
      style={{
        width: TILE_SIZE + 20,
        padding: 6,
        border: '1px solid var(--border-primary)',
        borderRadius: 10,
        background: 'var(--bg-tertiary)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <img
        src={url}
        alt={title}
        style={{ width: TILE_SIZE, height: TILE_SIZE, objectFit: 'contain' }}
      />
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: TILE_SIZE + 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {hint || title}
      </span>
    </button>
  );

  return (
    <div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 12, lineHeight: 1.7 }}>
        点任意图标位，从角色头像或内置图标里挑一个替换。替换只影响这个图标位，
        取消「恢复默认」即可还原。当前主题：{state.themeMode === 'light' ? '浅色' : '深色'}。
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {ICON_SLOTS.map(({ key, label }) => {
          const url = currentUrl(key);
          const custom = isCustomized(key);
          return (
            <div
              key={key}
              style={{
                width: 116,
                border: `1px solid ${custom ? 'var(--brand-primary)' : 'var(--border-primary)'}`,
                borderRadius: 12,
                padding: '10px 8px',
                background: 'var(--bg-tertiary)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {url ? (
                <img src={url} alt={label} style={{ width: 56, height: 56, objectFit: 'contain' }} />
              ) : (
                <span style={{ width: 56, height: 56, lineHeight: '56px', textAlign: 'center', fontSize: 24 }}>•</span>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{label}</div>
              <div style={{ fontSize: 10, color: custom ? 'var(--brand-primary)' : 'var(--text-muted)' }}>
                {custom ? '已自定义' : '默认'}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <Button size="small" onClick={() => setPicking(key)}>更换</Button>
                {custom && (
                  <Button size="small" type="text" onClick={() => resetIcon(key)}>还原</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={picking !== null}
        onCancel={() => setPicking(null)}
        footer={null}
        width={760}
        title={`选择图标：${ICON_SLOTS.find((s) => s.key === picking)?.label || ''}`}
      >
        <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 10px' }}>
            角色头像（{characters.length}）
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {characters.map((name) =>
              renderTile(CHARACTER_ICONS[name], name, () => applyIcon(`char:${name}`), name),
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default IconLibrarySettings;
