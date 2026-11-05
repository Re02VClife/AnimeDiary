import { useEffect, useMemo, useRef } from 'react';
import { Input, Button, Segmented, Select, Dropdown, Tooltip } from 'antd';
import type { InputRef, MenuProps } from 'antd';
import {
  SearchOutlined,
  PlusOutlined,
  CloudDownloadOutlined,
  UserAddOutlined,
  BgColorsOutlined,
  AppstoreOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { AnimeCategory, ScoreTemplate, CategoryOverrides } from '../types';
import { CATEGORY_CONFIG, getVisibleCategories } from '../types';
import {
  QUICK_ACTION_MAP,
  useQuickActionIds,
  type QuickActionId,
} from '../features/quick-actions/quick-actions';

interface TopBarProps {
  activeCategory: AnimeCategory;
  onCategoryChange: (cat: AnimeCategory) => void;
  searchText: string;
  onSearchChange: (text: string) => void;
  searchMode: 'title' | 'tag';
  onSearchModeChange: (mode: 'title' | 'tag') => void;
  onAddAnime?: () => void;
  /** 打开「数据补全」面板（从 Bangumi/Bilibili 批量补齐元数据与封面） */
  onCompleteData?: () => void;
  /** 打开「角色补全」面板（搜索角色资料并生成角色卡） */
  onCompleteCharacters?: () => void;
  /** 打开「去白底」面板（把角色立绘的白底变透明） */
  onCutoutCharacters?: () => void;
  /** 模板筛选 */
  templates: ScoreTemplate[];
  activeTemplateId: string;
  onTemplateChange: (id: string) => void;
  /** 当前模板的分类标签覆盖（决定显示哪些分类 tab） */
  categoryLabels?: CategoryOverrides;
  /** 悬停左上角品牌块时展开侧栏 */
  onExpandSidebar?: () => void;
  /** 执行顶栏快捷动作（录制 GIF / AI 对话 / 数据补全…） */
  onQuickAction?: (id: QuickActionId) => void;
  /** 打开设置面板（快捷栏为空时留一个入口） */
  onOpenSettings?: () => void;
}

/**
 * 顶栏内部分类配色。
 *
 * 数据层里五个分类共用品牌粉，一排 tab 全激活时看不出区别；
 * 这里给每个状态一个语义色（在看=生机绿、想看=期待蓝、搁置=琥珀、看过=粉、抛弃=灰），
 * 只作用于顶栏，不动 Excel 与知识图谱的颜色来源。
 */
const CATEGORY_TINT: Record<AnimeCategory, string> = {
  watching: '#3ddc97',
  wantToWatch: '#5eb1ff',
  onHold: '#f5b84b',
  watched: '#fb7299',
  dropped: '#9aa4b2',
};

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT_HINT = isMac ? '⌘K' : 'Ctrl K';

const TopBar: React.FC<TopBarProps> = ({
  activeCategory,
  onCategoryChange,
  searchText,
  onSearchChange,
  searchMode,
  onSearchModeChange,
  onAddAnime,
  onCompleteData,
  onCompleteCharacters,
  onCutoutCharacters,
  templates,
  activeTemplateId,
  onTemplateChange,
  categoryLabels,
  onExpandSidebar,
  onQuickAction,
  onOpenSettings,
}) => {
  const searchRef = useRef<InputRef>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** 快捷栏配置与设置面板共享（localStorage + 自定义事件同步） */
  const { ids: quickActionIds } = useQuickActionIds();

  /**
   * 把顶栏实际高度写进 CSS 变量 `--topbar-height`。
   *
   * 侧栏是绝对定位的浮层（不占布局），如果从 y=0 开始就会盖住顶栏左侧的搜索框。
   * 让侧栏从顶栏下沿开始，顶栏永远完整可见。高度用实测值而不是写死常量 ——
   * 窄窗口里顶栏可能换行变高。
   */
  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    const apply = () => {
      document.documentElement.style.setProperty('--topbar-height', `${el.offsetHeight}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--topbar-height');
    };
  }, []);

  /**
   * ⌘K / Ctrl+K 聚焦搜索：这是和 Raycast / Linear 对齐的肌肉记忆，
   * 也让「搜番」不必先把鼠标移到输入框。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 计算可见分类：[]=隐藏全部(模板无分类覆盖)，[...]=只显示这些
  const visibleCategories = useMemo<AnimeCategory[]>(() => {
    return getVisibleCategories(categoryLabels);
  }, [categoryLabels]);

  // 可用的分类 tab 列表（空=隐藏全部，显示该模板所有条目）
  const displayCategories = visibleCategories.length > 0 ? visibleCategories : [];

  /**
   * 三个批量工具收进一个下拉。
   *
   * 它们和「新增」平铺成一排四个按钮时：低频批量操作却和日常的
   * "新增一部"并排抢视线，顶栏右侧显得杂乱。说明文字放在菜单项里，
   * 比原来的 title 悬浮提示更容易被发现。
   */
  const toolItems: MenuProps['items'] = [];
  const toolLabel = (title: string, desc: string) => (
    <div style={{ lineHeight: 1.35 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</div>
    </div>
  );
  if (onCompleteData) {
    toolItems.push({
      key: 'complete-data',
      icon: <CloudDownloadOutlined />,
      label: toolLabel('数据补全', '从 Bangumi / Bilibili 补齐元数据与封面'),
      onClick: onCompleteData,
    });
  }
  if (onCompleteCharacters) {
    toolItems.push({
      key: 'complete-characters',
      icon: <UserAddOutlined />,
      label: toolLabel('角色补全', '搜索立绘 / 声优 / 生日 / 人设，生成角色卡'),
      onClick: onCompleteCharacters,
    });
  }
  if (onCutoutCharacters) {
    toolItems.push({
      key: 'cutout',
      icon: <BgColorsOutlined />,
      label: toolLabel('去白底', '把角色立绘的白底变透明（原图保留，可撤销）'),
      onClick: onCutoutCharacters,
    });
  }

  return (
    <div className="top-bar" ref={barRef}>
      <div className="top-bar-row">
        {/*
          品牌块兼侧栏入口：以前是浮在左上角的方块，和顶栏、网格都不对齐；
          放进顶栏流里之后三者的左边缘终于在同一条线上。
        */}
        <button
          type="button"
          className="brand-trigger"
          title="打开侧栏"
          aria-label="打开侧栏"
          onMouseEnter={onExpandSidebar}
          onClick={onExpandSidebar}
        >
          <span className="brand-glyph">A</span>
          <span className="brand-spark" aria-hidden />
        </button>

        {/* 搜索 + 模式切换：合并为一条「命令面板」风格的玻璃控件 */}
        <div className={`search-cluster${searchText ? ' is-active' : ''}`}>
          <Input
            ref={searchRef}
            className="search-input"
            variant="borderless"
            placeholder={searchMode === 'title' ? '搜索番名…' : '搜索标签…'}
            prefix={<SearchOutlined className="search-icon" />}
            suffix={<kbd className="search-kbd">{SHORTCUT_HINT}</kbd>}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              // 光标在搜索框里按 Esc 清空并失焦 —— 这是搜索框的通用肌肉记忆。
              // 只绑在输入框上，不要提升到 window：否则详情面板打开时 Esc 会
              // 一边关弹窗一边把搜索词清掉。
              if (e.key === 'Escape' && searchText) {
                e.preventDefault();
                onSearchChange('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            allowClear
          />
          <span className="search-divider" aria-hidden />
          <Segmented
            className="search-mode-seg"
            size="small"
            value={searchMode}
            onChange={(v) => onSearchModeChange(v as 'title' | 'tag')}
            options={[
              { value: 'title', label: '名称' },
              { value: 'tag', label: '标签' },
            ]}
          />
        </div>

        {/* 分类按钮（当模板有分类覆盖时仅显示非空分类，全部留空则隐藏） */}
        {displayCategories.length > 0 && (
          <nav className="category-tabs" aria-label="分类">
            {displayCategories.map((cat) => {
              const cfg = CATEGORY_CONFIG[cat];
              const label = categoryLabels?.[cat] || cfg.label;
              const active = activeCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  className={`category-tab${active ? ' active' : ''}`}
                  style={{ '--cat-color': CATEGORY_TINT[cat] } as React.CSSProperties}
                  onClick={() => onCategoryChange(cat)}
                  // 默认只显示当前分类的文字，其余只剩彩色圆点：
                  // 圆点本身没有语义，title / aria-label 负责可读性与可访问性。
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                >
                  <span className="category-tab-dot" aria-hidden />
                  {/* 内层 span 配合 grid-template-columns: 0fr→1fr 做宽度动画，
                      比 max-width 更均匀：宽度按内容比例展开，不会前 100ms 就弹完 */}
                  <span className="category-tab-label"><span>{label}</span></span>
                </button>
              );
            })}
          </nav>
        )}

        {/* 右侧：快捷动作 + 设置 + 模板切换 + 批量工具 + 新增
            快捷栏放在右侧操作组里而不是紧跟分类栏：分类栏展开会把自己撑宽 130px，
            快捷按钮若在它后面就会被推着走，鼠标从分类移过去时得追按钮。 */}
        <div className="top-bar-actions">
          {quickActionIds.length > 0 && (
            <div className="quick-actions" role="group" aria-label="快捷操作">
              {quickActionIds.map((id) => {
                const def = QUICK_ACTION_MAP[id];
                if (!def) return null;
                return (
                  <Tooltip key={id} title={def.label} placement="bottom">
                    <button
                      type="button"
                      className="quick-action-btn"
                      aria-label={def.label}
                      onClick={() => onQuickAction?.(id)}
                    >
                      <span className="quick-action-icon" aria-hidden>{def.icon}</span>
                    </button>
                  </Tooltip>
                );
              })}
              <span className="quick-actions-divider" aria-hidden />
            </div>
          )}
          {onOpenSettings && (
            <Tooltip title="设置" placement="bottom">
              <Button
                className="ghost-action settings-btn"
                icon={<SettingOutlined />}
                aria-label="设置"
                onClick={onOpenSettings}
              />
            </Tooltip>
          )}
          {templates.length > 1 && (
            <Select
              size="small"
              className="template-select"
              value={activeTemplateId}
              onChange={(v) => onTemplateChange(v)}
              popupMatchSelectWidth={false}
              options={templates.map((t) => ({
                value: t.id,
                label: `${t.isDefault ? '⭐ ' : ''}${t.name}`,
              }))}
            />
          )}
          {toolItems.length > 0 && (
            <Dropdown
              menu={{ items: toolItems }}
              trigger={['click']}
              placement="bottomRight"
              overlayClassName="tool-dropdown"
            >
              <Button className="ghost-action" icon={<AppstoreOutlined />}>
                批量工具
              </Button>
            </Dropdown>
          )}
          {onAddAnime && (
            <Button
              className="add-anime-btn"
              type="primary"
              icon={<PlusOutlined />}
              onClick={onAddAnime}
            >
              新增
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default TopBar;
