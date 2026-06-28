/**
 * 模板管理 Modal
 *   创建/编辑/删除评分模板，管理维度权重、字段配置、分类标签
 *   替代旧版 DimensionManager
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import { Modal, Input, InputNumber, Button, Tabs, List, Popconfirm, Popover, Slider, Select, Checkbox, Switch, Divider } from 'antd';
import { PlusOutlined, DeleteOutlined, SaveOutlined, ImportOutlined } from '@ant-design/icons';
import type { Dimension, ScoreTemplate, TemplateGenre, TemplateCustomField, CategoryOverrides } from '../types';
import { CATEGORY_CONFIG, createDefaultTemplate, DEFAULT_TEMPLATE_ID, DEFAULT_FIELD_CONFIG } from '../types';
import type { AnimeCategory } from '../types';
import { loadTemplates, saveTemplates } from '../../features/anime-data/template-service';
import { catgirlMessage } from '../theme';
import * as XLSX from 'xlsx';
import { useAnimeContext } from '../../context/AnimeContext';
import { appendAnimeEntry } from '../../features/anime-data/excel-service';
import type { AnimeEntry, DimensionScore } from '../types';

const GENRE_OPTIONS: { value: TemplateGenre; label: string }[] = [
  { value: 'anime', label: '动画' },
  { value: 'game', label: '游戏' },
  { value: 'movie', label: '电影' },
  { value: 'book', label: '书籍' },
  { value: 'custom', label: '自定义' },
];

interface TemplateManagerProps {
  open: boolean;
  onClose: () => void;
}

const TemplateManager: React.FC<TemplateManagerProps> = ({ open, onClose }) => {
  const [templates, setTemplates] = useState<ScoreTemplate[]>([]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [edited, setEdited] = useState<ScoreTemplate | null>(null);
  const [activeTab, setActiveTab] = useState<string>('dims');

  // ── 维度表单 ──
  const [newLabel, setNewLabel] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newWeight, setNewWeight] = useState(0.1);

  // ── 自定义字段表单 ──
  const [newFieldLabel, setNewFieldLabel] = useState('');
  const [newFieldType, setNewFieldType] = useState<'text' | 'number'>('text');

  // Excel 导入 + 条目创建
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state: animeState, dispatch: animeDispatch } = useAnimeContext();

  useEffect(() => {
    if (open) {
      const ts = loadTemplates();
      setTemplates(ts);
      setActiveId(ts.find((t) => t.isDefault)?.id || ts[0]?.id || DEFAULT_TEMPLATE_ID);
    }
  }, [open]);

  useEffect(() => {
    const t = templates.find((t) => t.id === activeId);
    setEdited(t ? JSON.parse(JSON.stringify(t)) : null);
    setNewLabel(''); setNewDesc(''); setNewWeight(0.1);
    setNewFieldLabel(''); setNewFieldType('text');
  }, [activeId, templates]);

  // ── 编辑辅助 ──
  const updateEdited = (patch: Partial<ScoreTemplate>) => {
    if (!edited) return;
    const u = { ...edited, ...patch };
    setEdited(u);
    setTemplates((prev) => prev.map((t) => (t.id === edited.id ? u : t)));
  };

  // ── 保存 ──
  const handleSave = () => {
    if (!edited) return;
    const totalWeight = edited.dimensions
      .filter((d) => d.key !== 'overall')
      .reduce((s, d) => s + d.weight, 0);
    if (Math.abs(totalWeight - 1) > 0.01 && edited.dimensions.length > 1) {
      catgirlMessage.warning(`权重总和为 ${totalWeight.toFixed(2)}，建议调整为 1.0`);
    }
    const updated = templates.map((t) =>
      t.id === edited.id ? { ...edited, updatedAt: new Date().toISOString().split('T')[0] } : t,
    );
    setTemplates(updated);
    saveTemplates(updated);
    catgirlMessage.success('模板已保存，即时生效');
    onClose();
  };

  // ── 模板 CRUD ──
  const handleCreate = () => {
    const base = edited || createDefaultTemplate();
    const newTemplate: ScoreTemplate = {
      ...JSON.parse(JSON.stringify(base)),
      id: `template-${Date.now()}`,
      name: `新模板 ${templates.length + 1}`,
      isDefault: false,
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
    };
    setTemplates([...templates, newTemplate]);
    setActiveId(newTemplate.id);
  };

  const handleDelete = () => {
    if (templates.length <= 1) { catgirlMessage.warning('至少保留一个模板'); return; }
    if (edited?.isDefault) { catgirlMessage.warning('请先将其他模板设为默认后再删除'); return; }
    const remaining = templates.filter((t) => t.id !== activeId);
    setTemplates(remaining);
    setActiveId(remaining[0].id);
    catgirlMessage.success('模板已删除');
  };

  // ── Excel 导入模板 ──
  const handleImportTemplate = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!/\.xlsx?$/i.test(file.name)) {
      catgirlMessage.warning('请选择 .xlsx 或 .xls 文件');
      e.target.value = '';
      return;
    }

    const fileBaseName = file.name.replace(/\.xlsx?$/i, '');

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target!.result as ArrayBuffer);
        // 保留公式以便从"综合"列提取权重
        const wb = XLSX.read(data, { type: 'array', cellFormula: true });
        const sheetNames = wb.SheetNames;
        if (sheetNames.length === 0) {
          catgirlMessage.warning('Excel 文件中没有 Sheet');
          return;
        }

        // ── 1. 可选元信息 Sheet ──
        const metaSheetName = sheetNames.find((n) =>
          ['模板', 'Template', 'Meta', '信息'].includes(n),
        );
        let templateName = fileBaseName;
        let templateGenre: TemplateGenre = 'custom';
        let templateIsDefault = false;

        if (metaSheetName) {
          const metaRows = XLSX.utils.sheet_to_json(wb.Sheets[metaSheetName], { header: 1 }) as unknown[][];
          if (metaRows.length >= 2) {
            const headers = (metaRows[0] as unknown[]).map((h) => String(h ?? '').trim());
            const row = metaRows[1] as unknown[];
            const col = (n: string) => { const i = headers.findIndex((h) => h === n); return i >= 0 ? String(row[i] ?? '').trim() : ''; };
            if (col('名称')) templateName = col('名称');
            const g = col('类型');
            if (['anime', 'game', 'movie', 'book', 'custom'].includes(g as TemplateGenre)) templateGenre = g as TemplateGenre;
            if (['是', 'true', 'TRUE', '1', 'yes', 'YES'].includes(col('设为默认'))) templateIsDefault = true;
          }
        }

        // ── 2. 自动检测数据格式 ──
        const mainSheetName =
          sheetNames.find((n) => ['维度', 'Dimensions', 'Dims'].includes(n)) || sheetNames[0];
        const mainSheet = wb.Sheets[mainSheetName];
        const rows = XLSX.utils.sheet_to_json(mainSheet, { header: 1 }) as unknown[][];
        if (rows.length < 2) {
          catgirlMessage.warning('至少需要标题行 + 1 行数据');
          return;
        }

        const headers = (rows[0] as unknown[]).map((h) => String(h ?? '').trim());

        // 检测格式：首列为空=列式布局（维度在列上），首列="名称"=行式布局（维度在行上）
        const isColumnLayout = headers[0] === '' || headers[0] === '综合' || !headers[0];

        let dimensions: Dimension[] = [];

        if (isColumnLayout) {
          // ── 列式布局（如 游戏.xlsx） ──
          // Row 0: ["", "综合", "玩法", "世界观与剧情", ...]
          // 列 A = 条目名（跳过），列 B = 综合（含权重公式），列 C+ = 各维度
          // 从列 B（综合）的公式中提取权重

          // 找到"综合"列（可能叫 综合/总分/总评/overall）
          const overallCol = headers.findIndex((h) =>
            ['综合', '总分', '总评', 'overall'].includes(h),
          );

          // 提取权重：解析综合列公式 "C*0.12+D*0.1+..."
          const weightMap = new Map<string, number>();
          if (overallCol >= 0) {
            // 取第一行数据中综合列的公式
            const formulaCell = mainSheet[XLSX.utils.encode_cell({ r: 1, c: overallCol })];
            const formula = formulaCell?.f || '';
            // 匹配 列字母*数字 模式，如 C2*0.12 或 C*0.12
            const matches = formula.matchAll(/([A-Z]+)\d*\*([\d.]+)/g);
            for (const m of matches) {
              const colLetter = m[1];
              const weight = parseFloat(m[2]);
              // 列字母 → 列索引
              const colIdx = XLSX.utils.decode_col(colLetter);
              const dimName = headers[colIdx];
              if (dimName && !['综合', '总分', '总评', 'overall'].includes(dimName)) {
                weightMap.set(dimName, weight);
              }
            }
          }

          // 遍历列，提取维度（跳过 列A=条目名、列B=综合）
          const dimLabels: string[] = [];
          for (let c = 1; c < headers.length; c++) {
            const label = headers[c];
            if (!label || label === '' || ['综合', '总分', '总评'].includes(label)) continue;
            dimLabels.push(label);
          }

          // 若公式解析失败（weightMap 为空），使用等权重兜底
          const hasWeights = weightMap.size > 0;
          const fallbackWeight = hasWeights ? 0 : dimLabels.length > 0 ? 1 / dimLabels.length : 0;

          for (const label of dimLabels) {
            const weight = hasWeights ? (weightMap.get(label) || 0) : fallbackWeight;
            dimensions.push({
              key: 'dim_' + label.toLowerCase().replace(/[^\w一-鿿]+/g, '_').replace(/^_|_$/g, ''),
              label,
              description: '',
              weight,
            });
          }

        } else {
          // ── 行式布局（每行 = 一个维度的定义） ──
          const colIdx = (names: string[]) => {
            for (const n of names) { const i = headers.findIndex((h) => h === n); if (i >= 0) return i; }
            return -1;
          };
          const nameIdx = colIdx(['名称', '维度名称', '维度', 'name']);
          const keyIdx = colIdx(['键', 'key', '标识']);
          const descIdx = colIdx(['描述', '说明', 'description', 'desc']);
          const weightIdx = colIdx(['权重', 'weight']);

          if (nameIdx < 0) {
            catgirlMessage.warning(`未识别到维度名称列（标题：${headers.join('、')}）。请确保第一列是维度名称，或包含"名称"标题列。`);
            return;
          }

          for (let i = 1; i < rows.length; i++) {
            const row = rows[i] as unknown[];
            if (!row || row.every((c) => c === undefined || c === null || String(c).trim() === '')) continue;
            const label = String(row[nameIdx] ?? '').trim();
            if (!label) continue;
            const key = keyIdx >= 0 ? String(row[keyIdx] ?? '').trim() : '';
            const description = descIdx >= 0 ? String(row[descIdx] ?? '').trim() : '';
            const weight = weightIdx >= 0 ? parseFloat(String(row[weightIdx] || '0')) : 0;
            dimensions.push({
              key: key || 'dim_' + label.toLowerCase().replace(/[^\w一-鿿]+/g, '_').replace(/^_|_$/g, ''),
              label,
              description,
              weight: isNaN(weight) ? 0 : weight,
            });
          }
        }

        if (dimensions.length === 0) {
          catgirlMessage.warning('未解析到维度数据，请检查格式');
          return;
        }

        // ── 3. 自动补充"总评" ──
        const hasOverall = dimensions.some((d) => d.key === 'overall' || d.label === '总评');
        if (!hasOverall) {
          dimensions.push({ key: 'overall', label: '总评', description: '由各维度加权计算得出', weight: 0 });
        }

        // ── 4. 创建模板 ──
        const newTemplateId = `template-${Date.now()}`;
        const newTemplate: ScoreTemplate = {
          id: newTemplateId,
          name: templateName,
          applicableGenre: templateGenre,
          dimensions,
          isDefault: templateIsDefault,
          fieldConfig: { ...DEFAULT_FIELD_CONFIG, customFields: [] },
          categoryLabels: {},
          layoutConfig: undefined,
          createdAt: new Date().toISOString().split('T')[0],
          updatedAt: new Date().toISOString().split('T')[0],
        };

        // 立即持久化到 localStorage，确保 getTemplate() 能查到（总评计算依赖它）
        const currentTemplates = loadTemplates();
        if (templateIsDefault) {
          const updated = currentTemplates.map((t) => ({ ...t, isDefault: false }));
          const saved = [...updated, newTemplate];
          saveTemplates(saved);
          setTemplates(saved);
        } else {
          const saved = [...currentTemplates, newTemplate];
          saveTemplates(saved);
          setTemplates(saved);
        }
        setActiveId(newTemplate.id);

        // 自动切换到新模板，让用户在主界面立即看到导入的条目
        animeDispatch({ type: 'SET_ACTIVE_TEMPLATE', payload: newTemplateId });
        animeDispatch({ type: 'SET_ACTIVE_DIM', payload: 'overall' });

        // ── 5. 从数据行创建条目（仅列式布局） ──
        let entryCount = 0;
        if (isColumnLayout) {
          // 构建列索引 → 维度 key 映射
          const colToDimKey = new Map<number, string>();
          for (let c = 0; c < headers.length; c++) {
            const h = headers[c];
            if (!h || h === '' || ['综合', '总分', '总评'].includes(h)) continue;
            const dim = dimensions.find((d) => d.label === h);
            if (dim) {
              colToDimKey.set(c, dim.key);
            } else {
            }
          }

          // 收集已有条目名，避免重复
          const existingTitles = new Set(animeState.animeList.map((a) => a.title));

          // 逐行创建条目（row 0 = 标题行，从 row 1 开始）
          const createEntries = async () => {
            for (let r = 1; r < rows.length; r++) {
              const row = rows[r] as unknown[];
              if (!row || row.every((c) => c === undefined || c === null)) continue;
              const title = String(row[0] ?? '').trim();
              if (!title || existingTitles.has(title)) continue;

              // 构建维度分数
              const scores: DimensionScore[] = [];
              for (const [col, dimKey] of colToDimKey) {
                const rawVal = parseFloat(String(row[col] || '0'));
                if (!isNaN(rawVal)) {
                  scores.push({ dimensionKey: dimKey, score: rawVal });
                }
              }

              const now = new Date().toISOString();
              const newEntry: AnimeEntry = {
                id: `import-${Date.now()}-${r}`,
                title,
                scores,
                tags: [],
                category: 'watched',
                templateId: newTemplateId,
                posterUrl: '',
                createdAt: now,
                updatedAt: now,
              };

              try {
                const rowIndex = await appendAnimeEntry(newEntry);
                newEntry.id = `excel-${rowIndex}`;
                newEntry.excelRowIndex = rowIndex;
                animeDispatch({ type: 'ADD_ANIME', payload: newEntry });
                entryCount++;
              } catch (err) {
                console.error('导入条目失败:', title, err);
              }
            }

            const weightInfo = dimensions.filter((d) => d.weight > 0).length > 0
              ? `，${dimensions.filter((d) => d.weight > 0).length} 个维度已从公式提取权重`
              : '';
            const entryInfo = entryCount > 0 ? `，已创建 ${entryCount} 个条目并保存` : '';
            catgirlMessage.success(`已导入模板「${templateName}」（${dimensions.length} 个维度${weightInfo}${entryInfo}）`);
          };
          createEntries();
          return; // 异步处理，提前返回避免执行下面的同步 success
        }

        const weightInfo = dimensions.filter((d) => d.weight > 0).length > 0
          ? `，${dimensions.filter((d) => d.weight > 0).length} 个维度已从公式提取权重`
          : '';
        catgirlMessage.success(`已导入模板「${templateName}」（${dimensions.length} 个维度${weightInfo}）`);
      } catch (err) {
        catgirlMessage.error('解析失败喵…：' + (err instanceof Error ? err.message : '文件格式错误'));
      }
    };
    reader.onerror = () => catgirlMessage.error('读取文件失败喵…');
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  // ── 维度操作 ──
  const addDim = () => {
    if (!newLabel.trim()) { catgirlMessage.warning('请输入维度名称'); return; }
    if (!edited) return;
    const key = 'custom_' + newLabel.trim().toLowerCase().replace(/\s+/g, '_');
    updateEdited({ dimensions: [...edited.dimensions, { key, label: newLabel.trim(), description: newDesc.trim(), weight: newWeight }] });
    setNewLabel(''); setNewDesc(''); setNewWeight(0.1);
  };

  const deleteDim = (key: string) => {
    if (!edited || key === 'overall') return;
    updateEdited({ dimensions: edited.dimensions.filter((d) => d.key !== key) });
  };

  const changeDimWeight = (key: string, v: number) => {
    if (!edited) return;
    updateEdited({ dimensions: edited.dimensions.map((d) => (d.key === key ? { ...d, weight: v } : d)) });
  };

  const changeDimLabel = (key: string, v: string) => {
    if (!edited) return;
    updateEdited({ dimensions: edited.dimensions.map((d) => (d.key === key ? { ...d, label: v } : d)) });
  };

  const changeDimDesc = (key: string, v: string) => {
    if (!edited) return;
    updateEdited({ dimensions: edited.dimensions.map((d) => (d.key === key ? { ...d, description: v } : d)) });
  };

  // ── 字段配置操作 ──
  const toggleField = (field: keyof typeof DEFAULT_FIELD_CONFIG) => {
    if (!edited) return;
    const fc = edited.fieldConfig || DEFAULT_FIELD_CONFIG;
    updateEdited({ fieldConfig: { ...fc, [field]: !fc[field] } });
  };

  const addCustomField = () => {
    if (!newFieldLabel.trim()) { catgirlMessage.warning('请输入字段名'); return; }
    if (!edited) return;
    const key = 'cf_' + newFieldLabel.trim().toLowerCase().replace(/\s+/g, '_');
    const fc = edited.fieldConfig || DEFAULT_FIELD_CONFIG;
    const exists = fc.customFields?.some((f) => f.key === key);
    if (exists) { catgirlMessage.warning('已经有了喵'); return; }
    const cf: TemplateCustomField = { key, label: newFieldLabel.trim(), type: newFieldType };
    updateEdited({ fieldConfig: { ...fc, customFields: [...(fc.customFields || []), cf] } });
    setNewFieldLabel(''); setNewFieldType('text');
  };

  const deleteCustomField = (key: string) => {
    if (!edited) return;
    const fc = edited.fieldConfig || DEFAULT_FIELD_CONFIG;
    updateEdited({ fieldConfig: { ...fc, customFields: (fc.customFields || []).filter((f) => f.key !== key) } });
  };

  // ── 分类标签 ──
  const updateCatLabel = (catKey: string, label: string) => {
    if (!edited) return;
    updateEdited({ categoryLabels: { ...(edited.categoryLabels || {}), [catKey]: label } });
  };

  const totalWeight = useMemo(() => {
    if (!edited) return 0;
    return edited.dimensions.filter((d) => d.key !== 'overall').reduce((s, d) => s + d.weight, 0);
  }, [edited]);

  // ── 维度 Tab 内容 ──
  const dimsTab = (
    <>
      <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 12 }}>
        权重总和：<span style={{ color: Math.abs(totalWeight - 1) < 0.01 ? 'var(--color-success)' : 'var(--brand-primary)', fontWeight: 600 }}>{totalWeight.toFixed(2)}</span>
        （建议 = 1.0，总评维度不计入）
      </div>
      <List
        dataSource={edited?.dimensions || []}
        renderItem={(dim) => (
          <List.Item
            extra={
              dim.key !== 'overall' ? (
                <Popconfirm title="删除此维度？" onConfirm={() => deleteDim(dim.key)} okText="删除" cancelText="取消">
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ) : null
            }
          >
            <List.Item.Meta
              title={
                <Input
                  size="small" value={dim.label} disabled={dim.key === 'overall'}
                  onChange={(e) => changeDimLabel(dim.key, e.target.value)}
                  style={{ width: 100, fontSize: 13 }}
                />
              }
              description={
                <div>
                  <Input
                    size="small"
                    placeholder="维度描述"
                    value={dim.description || ''}
                    onChange={(e) => changeDimDesc(dim.key, e.target.value)}
                    style={{ fontSize: 12 }}
                  />
                  {dim.key !== 'overall' && (
                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>权重：</span>
                      <Slider min={0} max={0.5} step={0.01} value={dim.weight}
                        onChange={(v) => changeDimWeight(dim.key, v)} style={{ width: 100, margin: 0 }}
                        tooltip={{ formatter: (v) => `${((v || 0) * 100).toFixed(0)}%` }} />
                      <InputNumber size="small" min={0} max={1} step={0.01}
                        value={dim.weight} onChange={(v) => changeDimWeight(dim.key, v || 0)} style={{ width: 60 }} />
                    </div>
                  )}
                </div>
              }
            />
          </List.Item>
        )}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 12, padding: 10, background: 'var(--bg-tertiary)', borderRadius: 8 }}>
        <Input size="small" placeholder="维度名称" value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)} style={{ width: 100 }} />
        <Input size="small" placeholder="描述" value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)} style={{ flex: 1 }} />
        <InputNumber size="small" min={0} max={0.5} step={0.01} value={newWeight}
          onChange={(v) => setNewWeight(v || 0)} style={{ width: 60 }} />
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={addDim}>添加</Button>
      </div>
    </>
  );

  // ── 字段配置 Tab 内容 ──
  const fc = edited?.fieldConfig || DEFAULT_FIELD_CONFIG;
  const fieldsTab = (
    <div>
      {/* 内置字段开关 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📋 内置字段</div>
        {([
          ['showAnilistScore', 'AniList 评分'],
          ['showBangumiId', 'Bangumi ID'],
          ['showReleaseDate', '上映时间'],
          ['showFrameCount', '张数'],
          ['showStudio', '制作组'],
          ['showCharacters', '角色'],
          ['showEpisodes', '集数'],
        ] as const).map(([key, label]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{label}</span>
            <Switch size="small" checked={fc[key]} onChange={() => toggleField(key)} />
          </div>
        ))}
      </div>

      <Divider style={{ margin: '8px 0', borderColor: 'var(--border-primary)' }} />

      {/* 分类标签自定义 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>🏷️ 分类标签</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 8 }}>设置后在顶栏显示对应分类；<b>留空 = 隐藏该分类</b>，全部留空则显示全部条目</div>
        {(Object.keys(CATEGORY_CONFIG) as AnimeCategory[]).map((catKey) => {
          const cfg = CATEGORY_CONFIG[catKey];
          const customVal = edited?.categoryLabels?.[catKey];
          return (
            <div key={catKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 40 }}>{cfg.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>→</span>
              <Input size="small" placeholder={cfg.label}
                value={customVal ?? ''}
                onChange={(e) => updateCatLabel(catKey, e.target.value)}
                style={{ width: 120 }} />
            </div>
          );
        })}
      </div>

      <Divider style={{ margin: '8px 0', borderColor: 'var(--border-primary)' }} />

      {/* 自定义补充字段 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>➕ 自定义字段</div>
        {(fc.customFields || []).map((cf) => (
          <div key={cf.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 13, flex: 1 }}>{cf.label}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{cf.type === 'number' ? '数字' : '文本'}</span>
            <Popconfirm title="删除此字段？" onConfirm={() => deleteCustomField(cf.key)} okText="删除" cancelText="取消">
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, padding: 8, background: 'var(--bg-tertiary)', borderRadius: 8 }}>
          <Input size="small" placeholder="字段名" value={newFieldLabel}
            onChange={(e) => setNewFieldLabel(e.target.value)} style={{ flex: 1 }} />
          <Select size="small" value={newFieldType} onChange={(v) => setNewFieldType(v)} style={{ width: 80 }}
            options={[{ value: 'text', label: '文本' }, { value: 'number', label: '数字' }]} />
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={addCustomField}>添加</Button>
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      title="📐 评分模板管理"
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={<><SaveOutlined /> 保存</>}
      width={660}
    >
      {/* 模板选择器 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <Select
          value={activeId}
          onChange={(v) => setActiveId(v)}
          style={{ flex: 1 }}
          options={templates.map((t) => ({ value: t.id, label: `${t.name}${t.isDefault ? ' ⭐' : ''}` }))}
        />
        <Button icon={<PlusOutlined />} onClick={handleCreate} type="primary" ghost>新建</Button>
        <Popover
          title="支持两种 Excel 格式"
          content={
            <div style={{ fontSize: 12, lineHeight: 1.8, maxWidth: 380 }}>
              <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: 4 }}>格式 A · 列式布局（推荐）</div>
              <div style={{ background: 'var(--bg-quaternary)', padding: '6px 8px', borderRadius: 4, fontFamily: 'monospace', marginBottom: 10, whiteSpace: 'pre' }}>{`    | 综合 | 玩法 | 画面 | 音乐 | …
终末地 | 75  | 59  | 86  | 63  | …
原神  | 77  | 51  | 84  | 90  | …`}</div>
              <div style={{ color: 'var(--text-secondary)' }}>首行为维度名，每行一个条目。<br/>权重从"综合"列的公式自动提取。</div>
              <div style={{ borderTop: '1px solid var(--border-primary)', margin: '8px 0' }} />
              <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: 4 }}>格式 B · 行式布局</div>
              <div style={{ background: 'var(--bg-quaternary)', padding: '6px 8px', borderRadius: 4, fontFamily: 'monospace', marginBottom: 10, whiteSpace: 'pre' }}>{`名称   | 描述     | 权重
玩法   | 核心玩法  | 0.12
画面   | 画面表现  | 0.10`}</div>
              <div style={{ color: 'var(--text-secondary)' }}>每行定义一个维度，带名称/描述/权重列。</div>
            </div>
          }
          trigger="hover"
          placement="bottom"
        >
          <Button icon={<ImportOutlined />} onClick={handleImportTemplate}>导入</Button>
        </Popover>
        <Popconfirm title="确定删除此模板？" onConfirm={handleDelete} okText="删除" cancelText="取消">
          <Button danger icon={<DeleteOutlined />} disabled={templates.length <= 1}>删除</Button>
        </Popconfirm>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls"
          style={{ display: 'none' }} onChange={handleFileChange} />
      </div>

      {edited && (
        <>
          {/* 模板基本信息 */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
            <Input addonBefore="名称" value={edited.name}
              onChange={(e) => updateEdited({ name: e.target.value })} style={{ flex: 1 }} />
            <Select value={edited.applicableGenre}
              onChange={(v) => updateEdited({ applicableGenre: v })} style={{ width: 100 }} options={GENRE_OPTIONS} />
            <Checkbox checked={edited.isDefault}
              onChange={(e) => {
                if (e.target.checked) {
                  setTemplates((prev) => prev.map((t) => ({ ...t, isDefault: false })));
                  updateEdited({ isDefault: true });
                } else {
                  updateEdited({ isDefault: false });
                }
              }}>
              默认
            </Checkbox>
          </div>

          {/* 内容区 Tab */}
          <Tabs size="small" activeKey={activeTab} onChange={setActiveTab}
            items={[
              { key: 'dims', label: '📊 维度 & 权重', children: dimsTab },
              { key: 'fields', label: '⚙️ 字段配置', children: fieldsTab },
            ]}
          />
        </>
      )}
    </Modal>
  );
};

export default TemplateManager;
