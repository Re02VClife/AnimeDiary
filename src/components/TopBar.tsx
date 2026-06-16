import { Input, Button, Segmented } from 'antd';
import { SearchOutlined, PlusOutlined } from '@ant-design/icons';
import type { AnimeCategory } from '../types';
import { CATEGORY_CONFIG } from '../types';

interface TopBarProps {
  activeCategory: AnimeCategory;
  onCategoryChange: (cat: AnimeCategory) => void;
  searchText: string;
  onSearchChange: (text: string) => void;
  searchMode: 'title' | 'tag';
  onSearchModeChange: (mode: 'title' | 'tag') => void;
  onAddAnime?: () => void;
}

const CATEGORIES: AnimeCategory[] = ['watching', 'wantToWatch', 'onHold', 'watched', 'dropped'];

const TopBar: React.FC<TopBarProps> = ({
  activeCategory,
  onCategoryChange,
  searchText,
  onSearchChange,
  searchMode,
  onSearchModeChange,
  onAddAnime,
}) => {
  return (
    <div className="top-bar">
      <div className="top-bar-row">
        {/* 搜索栏 + 模式切换 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Input
            className="search-input"
            style={{ width: searchMode === 'tag' ? 200 : 280 }}
            placeholder={searchMode === 'title' ? '搜索番剧名称…' : '搜索标签名…'}
            prefix={<SearchOutlined style={{ color: '#484f58' }} />}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            allowClear
          />
          <Segmented
            size="small"
            value={searchMode}
            onChange={(v) => {
              onSearchModeChange(v as 'title' | 'tag');
              onSearchChange(''); // 切换模式时清空搜索
            }}
            options={[
              { value: 'title', label: '番名' },
              { value: 'tag', label: 'Tag' },
            ]}
            style={{ background: '#21262d' }}
          />
        </div>

        {/* 分类按钮 */}
        <div className="category-tabs">
          {CATEGORIES.map((cat) => {
            const cfg = CATEGORY_CONFIG[cat];
            return (
              <div
                key={cat}
                className={`category-tab${activeCategory === cat ? ' active' : ''}`}
                style={activeCategory === cat ? { background: cfg.color, borderColor: cfg.color } : undefined}
                onClick={() => onCategoryChange(cat)}
              >
                {cfg.label}
              </div>
            );
          })}
        </div>

        {/* 新增番剧按钮 */}
        {onAddAnime && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onAddAnime}
            style={{ borderRadius: 20 }}
          >
            新增番剧
          </Button>
        )}
      </div>
    </div>
  );
};

export default TopBar;
