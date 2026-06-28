import { useMemo } from 'react';
import { Input, Button, Segmented, Select } from 'antd';
import { SearchOutlined, PlusOutlined } from '@ant-design/icons';
import type { AnimeCategory, ScoreTemplate, CategoryOverrides } from '../types';
import { CATEGORY_CONFIG, getVisibleCategories } from '../types';

interface TopBarProps {
  activeCategory: AnimeCategory;
  onCategoryChange: (cat: AnimeCategory) => void;
  searchText: string;
  onSearchChange: (text: string) => void;
  searchMode: 'title' | 'tag';
  onSearchModeChange: (mode: 'title' | 'tag') => void;
  onAddAnime?: () => void;
  /** 模板筛选 */
  templates: ScoreTemplate[];
  activeTemplateId: string;
  onTemplateChange: (id: string) => void;
  /** 当前模板的分类标签覆盖（决定显示哪些分类 tab） */
  categoryLabels?: CategoryOverrides;
}

const TopBar: React.FC<TopBarProps> = ({
  activeCategory,
  onCategoryChange,
  searchText,
  onSearchChange,
  searchMode,
  onSearchModeChange,
  onAddAnime,
  templates,
  activeTemplateId,
  onTemplateChange,
  categoryLabels,
}) => {
  // 计算可见分类：[]=隐藏全部(模板无分类覆盖)，[...]=只显示这些
  const visibleCategories = useMemo<AnimeCategory[]>(() => {
    return getVisibleCategories(categoryLabels);
  }, [categoryLabels]);

  // 可用的分类 tab 列表（空=隐藏全部，显示该模板所有条目）
  const displayCategories = visibleCategories.length > 0 ? visibleCategories : [];

  return (
    <div className="top-bar">
      <div className="top-bar-row">
        {/* 搜索栏 + 模式切换 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Input
            className="search-input"
            style={{ width: searchMode === 'tag' ? 200 : 280 }}
            placeholder={searchMode === 'title' ? '搜索名称…' : '搜索标签…'}
            prefix={<SearchOutlined style={{ color: 'var(--text-muted)' }} />}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            allowClear
          />
          <Segmented
            className="search-mode-seg"
            size="small"
            value={searchMode}
            onChange={(v) => onSearchModeChange(v as 'title' | 'tag')}
            options={[
              { value: 'title', label: 'name' },
              { value: 'tag', label: 'Tag' },
            ]}
            style={{ background: 'var(--bg-quaternary)' }}
          />
        </div>

        {/* 分类按钮（当模板有分类覆盖时仅显示非空分类，全部留空则隐藏） */}
        {displayCategories.length > 0 && (
          <div className="category-tabs">
            {displayCategories.map((cat) => {
              const cfg = CATEGORY_CONFIG[cat];
              const label = categoryLabels?.[cat] || cfg.label;
              return (
                <div
                  key={cat}
                  className={`category-tab${activeCategory === cat ? ' active' : ''}`}
                  style={activeCategory === cat ? { background: cfg.color, borderColor: cfg.color } : undefined}
                  onClick={() => onCategoryChange(cat)}
                >
                  {label}
                </div>
              );
            })}
          </div>
        )}

        {/* 右侧：模板切换 + 新增按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          {templates.length > 1 && (
            <Select
              size="small"
              value={activeTemplateId}
              onChange={(v) => onTemplateChange(v)}
              style={{ width: 120 }}
              options={templates.map((t) => ({
                value: t.id,
                label: `${t.isDefault ? '⭐ ' : ''}${t.name}`,
              }))}
            />
          )}
          {onAddAnime && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={onAddAnime}
              style={{ borderRadius: 20 }}
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
