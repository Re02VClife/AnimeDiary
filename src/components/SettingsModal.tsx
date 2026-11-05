/**
 * SettingsModal — 全应用设置面板
 *
 * 以前「主题 / 桌面应用 / 设置」三块直接铺在侧栏底部：侧栏整体高 2954px（3.4 屏），
 * 而侧栏又是 hover 展开的 —— 鼠标稍微偏出去就收起，改个显示设置的成功率很低。
 *
 * 这里把它们收进一个分页弹窗：
 *   外观（主题/猫娘/配色/图片高度/雷达范围）
 *   数据（导入导出/表格视图/海报/备份）
 *   工具（修正检索名/重建总评列/维度管理）
 *   关于（版本/热更新/更新源/数据目录）
 *
 * 侧栏只留「浏览与筛选」，长度砍掉一大半。
 */
import React, { useState } from 'react';
import { Modal, Tabs, Segmented, Switch, Button, Slider, InputNumber, ColorPicker, Typography } from 'antd';
import { useAnimeContext } from '../../context/AnimeContext';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/types';
import UpdatePanel from './UpdatePanel';
import PosterFixModal from './PosterFixModal';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/** 一行设置：左侧标题 + 可选说明，右侧放控件 */
const Row: React.FC<{
  title: string;
  hint?: string;
  children?: React.ReactNode;
  onClick?: () => void;
}> = ({ title, hint, children, onClick }) => (
  <div className={`settings-row${onClick ? ' clickable' : ''}`} onClick={onClick}>
    <div className="settings-row-label">
      <span>{title}</span>
      {hint && <span className="settings-row-hint">{hint}</span>}
    </div>
    {children && <div className="settings-row-control" onClick={(e) => e.stopPropagation()}>{children}</div>}
  </div>
);

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="settings-group-block">
    <div className="settings-group-title">{title}</div>
    {children}
  </div>
);

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const {
    state, dispatch,
    handleImportExcel, handleExportExcel, handleOpenExcel,
    handleBatchSavePosters, handleExportUserData, handleImportUserData,
    handleFixSearchAlias, handleRebuildOverallColumn,
  } = useAnimeContext();
  const { imgHeight, radarMode, radarMin, animeList } = state;

  const { state: themeState, colors, setThemeMode, toggleCatgirlMode, setCustomColors, resetCustomColors } = useTheme();
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [editingColors, setEditingColors] = useState<Partial<ThemeColors>>({});
  /** 批量补全海报（搜索后人工确认，不自动写入） */
  const [posterFixOpen, setPosterFixOpen] = useState(false);

  const hasCustomColors = Object.keys(themeState.customColors).length > 0;

  // ── 外观 ──
  const appearance = (
    <>
      <Group title="主题">
        <Row title="模式">
          <Segmented
            size="small"
            value={themeState.themeMode}
            onChange={(v) => setThemeMode(v as 'dark' | 'light')}
            options={[
              { value: 'dark', label: '🌙 深色' },
              // 不带 U+FE0F：带变体选择符时 antd 的 Segmented 里会渲染成一个黑圆点
              { value: 'light', label: '☀ 浅色' },
            ]}
          />
        </Row>
        <Row title="🐱 猫娘模式" hint="界面文案换成猫娘口癖">
          <Switch size="small" checked={themeState.catgirlMode} onChange={toggleCatgirlMode} />
        </Row>
        <Row title="🎨 配色" hint={hasCustomColors ? '已改动预设配色' : '使用预设'}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="small"
              onClick={() => { setEditingColors({ ...themeState.customColors }); setThemeEditorOpen(true); }}
            >
              自定义
            </Button>
            {hasCustomColors && (
              <Button size="small" danger onClick={resetCustomColors}>恢复预设</Button>
            )}
          </div>
        </Row>
      </Group>

      <Group title="显示">
        <Row title="🖼️ 卡片图片高度" hint={`${imgHeight}px`}>
          <Slider
            min={200} max={800} step={20}
            value={imgHeight}
            onChange={(v) => dispatch({ type: 'SET_IMG_HEIGHT', payload: v })}
            style={{ width: 180 }}
            styles={{ track: { background: 'var(--brand-primary)' }, rail: { background: 'var(--border-primary)' } }}
          />
        </Row>
        <Row title="📊 雷达图范围" hint={radarMode === 'percentile' ? '按百分位排名' : '固定 0-10 分'}>
          <Segmented
            size="small"
            value={radarMode}
            onChange={(v) => dispatch({ type: 'SET_RADAR_MODE', payload: v as 'percentile' | 'fixed' })}
            options={[
              { value: 'percentile', label: '百分比' },
              { value: 'fixed', label: '固定值' },
            ]}
          />
        </Row>
        <Row title="雷达图最小值" hint={radarMode === 'percentile' ? '(0-50%)' : '(0-7 分)'}>
          <InputNumber
            size="small"
            min={0}
            max={radarMode === 'percentile' ? 50 : 7}
            step={1}
            value={radarMin}
            onChange={(v) => dispatch({ type: 'SET_RADAR_MIN', payload: v ?? 0 })}
            style={{ width: 70 }}
          />
        </Row>
      </Group>
    </>
  );

  // ── 数据 ──
  const data = (
    <>
      <Group title="表格数据">
        <Row title="📤 导入 Excel" hint="用导出的分表格式重建数据" onClick={handleImportExcel} />
        <Row title="📥 导出 Excel" hint="按类型分表导出（番剧/角色卡/模板/异常行）" onClick={handleExportExcel} />
        <Row title="📋 表格视图" hint="在应用内直接改列表数据，先暂存再保存" onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'excel' })} />
        <Row title="📂 用系统程序打开 Excel" onClick={handleOpenExcel} />
      </Group>

      <Group title="海报">
        <Row title="🖼 持久化所有海报" hint="把远程海报下载到本地 images/ 目录" onClick={handleBatchSavePosters} />
        <Row title="🔍 批量补全海报" hint="搜索候选后人工确认，不自动写入" onClick={() => setPosterFixOpen(true)} />
      </Group>

      <Group title="备份与恢复">
        <Row title="🗄 存档与回退" hint="快照列表 + 操作记录" onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'backupHistory' })} />
        <Row title="💾 导出用户数据" hint="模板、标签、配色等打包成 zip" onClick={handleExportUserData} />
        <Row
          title="📂 导入用户数据"
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.zip';
            input.onchange = (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) handleImportUserData(file);
            };
            input.click();
          }}
        />
      </Group>
    </>
  );

  // ── 工具 ──
  const tools = (
    <>
      <Group title="数据维护">
        <Row title="🔄 修正检索名" hint="用 Bangumi 复核，低置信度的一律跳过不写" onClick={handleFixSearchAlias} />
        <Row title="🧮 按模板权重重建总评列" hint="按当前模板权重重写 Excel 的 D 列公式与缓存值" onClick={() => void handleRebuildOverallColumn()} />
        <Row title="📐 维度管理" hint="编辑评分模板的维度、权重与字段" onClick={() => dispatch({ type: 'OPEN_MODAL', modal: 'templateManager' })} />
      </Group>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        这些操作会直接写回 Excel。写之前会自动生成快照，可在「存档与回退」里撤销。
      </Typography.Paragraph>
    </>
  );

  // ── 关于 ──
  const about = (
    <>
      <div className="settings-about-block">
        <UpdatePanel />
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
        数据存在「文档/AnimeDiary/番评分.xlsx」，图片在同目录的 <code>images/</code>，
        备份在 <code>backups/</code>。整个目录可以直接复制到另一台机器继续用。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        快捷键：<kbd>Ctrl K</kbd> 聚焦搜索 · <kbd>Esc</kbd> 清空搜索 · 详情面板里 <kbd>←</kbd> <kbd>→</kbd> 切换番剧 ·
        <kbd>F12</kbd> 打开开发者工具
      </Typography.Paragraph>
    </>
  );

  return (
    <>
      <Modal
        title="⚙️ 设置"
        open={open}
        onCancel={onClose}
        footer={null}
        width={680}
        destroyOnHidden
        className="settings-modal"
      >
        <Tabs
          items={[
            { key: 'appearance', label: '外观', children: appearance },
            { key: 'data', label: '数据', children: data },
            { key: 'tools', label: '工具', children: tools },
            { key: 'about', label: '关于', children: about },
          ]}
        />
      </Modal>

      {/* 自定义配色编辑器（嵌套弹窗） */}
      <Modal
        title="🎨 自定义配色"
        open={themeEditorOpen}
        onCancel={() => setThemeEditorOpen(false)}
        onOk={() => { setCustomColors(editingColors); setThemeEditorOpen(false); }}
        okText="应用"
        cancelText="取消"
        width={460}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', maxHeight: 420, overflow: 'auto' }}>
          {(Object.keys(colors) as (keyof ThemeColors)[]).map((key) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>{key}</span>
              <ColorPicker
                size="small"
                value={editingColors[key] ?? colors[key]}
                onChange={(_, hex) => { setEditingColors((prev) => ({ ...prev, [key]: hex })); }}
              />
            </div>
          ))}
        </div>
      </Modal>

      {/* 批量补全海报（自己也是一个 Modal） */}
      <PosterFixModal
        open={posterFixOpen}
        onClose={() => setPosterFixOpen(false)}
        animeList={animeList}
        onApplied={(animeId, posterUrl) => dispatch({ type: 'SET_ANIME_POSTER', animeId, posterUrl })}
      />
    </>
  );
};

export default SettingsModal;
