/**
 * Excel 列索引常量 —— 对应「番评分.xlsx」→「番剧列表」Sheet 的列位置
 * 列索引从 0 开始（A=0, B=1, C=2, ...）
 */
export const EXCEL_COL = {
  SEARCH_ALIAS: 0,    // A - 检索名
  TITLE: 1,           // B - 名字
  ASSIGNED_SCORE: 2,  // C - 赋分（公式计算）
  OVERALL: 3,         // D - 综合(观感)
  AUDIO: 4,           // E - 音
  PRODUCTION: 5,      // F - 制作
  FRAME_COUNT: 6,     // G - 张数
  ANIMATION: 7,       // H - 作画
  STUDIO: 8,          // I - 制作组
  CONTENT: 9,         // J - 内容
  IMMERSION: 10,      // K - 沉浸感
  PLOT: 11,           // L - 剧情
  CHARACTER: 12,      // M - 人设
  DEPTH: 13,          // N - 深度
  VIBE: 14,           // O - 电波
  REVIEW: 15,         // P - 评价
  RELEASE_DATE: 16,   // Q - 上映年月
  FIRST_WATCH: 17,    // R - 首刷时间（Excel 序列号）
  NOTES: 18,          // S - 备注
  COL1: 19,           // T - 列1
  DEVIATION: 20,      // U - 偏差值
  CRAWLED_BGM: 21,    // V - 爬虫BGM
  BGM_SCORE: 22,      // W - BGM（Bangumi 评分）
  SUBSTITUTE: 23,     // X - 代餐
  OBJECTIVE_SCORE: 24,// Y - 较客观评分
  TAG: 25,            // Z - tag
  // 角色信息：每角色占3列（名字、人设分、造型分）
  CHAR1_NAME: 26,     // AA - 角色1
  CHAR1_DESIGN: 27,   // AB - 人设4
  CHAR1_STYLE: 28,    // AC - 造型
  CHAR2_NAME: 29,     // AD - 角色2
  CHAR2_DESIGN: 30,   // AE - 人设2
  CHAR2_STYLE: 31,    // AF - 造型2
  CHAR3_NAME: 32,     // AG - 角色3
  CHAR3_DESIGN: 33,   // AH - 人设3
  CHAR3_STYLE: 34,    // AI - 造型3
  CHAR4_NAME: 35,     // AJ - 角色4
  ANILIST_SCORE: 36,  // AK - AniList 评分
  WATCH_DATE: 17,     // R - 首刷时间（别名，同 FIRST_WATCH）
  POSTER_URL: 37,     // AL - 海报 URL（持久化存储）
  TEMPLATE_JSON: 19,  // T - 扩展评分 JSON（非默认模板的评分序列化）
  TEMPLATE_ID: 38,    // AM - 模板 ID
  LINK: 39,           // AN - 外部链接
} as const;

/** Excel 工作表名称 */
export const EXCEL_SHEETS = {
  ANIME_LIST: '番剧列表',
  FRAME_STATS: '张数统计',
  GAMEPLAY: '玩法',
  GAME_ZONE: '游戏区',
  CHAR_RANK: '角色排名',
  GRAVEYARD: '乱葬岗',
} as const;

/** 主数据 Sheet 名 */
export const MAIN_SHEET = EXCEL_SHEETS.ANIME_LIST;

/** 维度 key 到 Excel 列的映射 */
export const DIMENSION_COL_MAP: Record<string, number> = {
  overall: EXCEL_COL.OVERALL,
  audio: EXCEL_COL.AUDIO,
  production: EXCEL_COL.PRODUCTION,
  frameCount: EXCEL_COL.FRAME_COUNT,
  animation: EXCEL_COL.ANIMATION,
  immersion: EXCEL_COL.IMMERSION,
  plot: EXCEL_COL.PLOT,
  character: EXCEL_COL.CHARACTER,
  depth: EXCEL_COL.DEPTH,
  vibe: EXCEL_COL.VIBE,
};

/** 用户可编辑列（写回时只修改这些列，不碰公式列） */
export const EDITABLE_COLS: number[] = [
  EXCEL_COL.SEARCH_ALIAS,
  EXCEL_COL.AUDIO,
  EXCEL_COL.PRODUCTION,
  EXCEL_COL.FRAME_COUNT,
  EXCEL_COL.ANIMATION,
  EXCEL_COL.IMMERSION,
  EXCEL_COL.PLOT,
  EXCEL_COL.CHARACTER,
  EXCEL_COL.DEPTH,
  EXCEL_COL.VIBE,
  EXCEL_COL.REVIEW,
  EXCEL_COL.TAG,
  EXCEL_COL.NOTES,
  EXCEL_COL.STUDIO,
  EXCEL_COL.RELEASE_DATE,
  EXCEL_COL.FIRST_WATCH,
  EXCEL_COL.BGM_SCORE,
  EXCEL_COL.ANILIST_SCORE,
  EXCEL_COL.POSTER_URL,
  EXCEL_COL.TEMPLATE_JSON,
  EXCEL_COL.TEMPLATE_ID,
  EXCEL_COL.LINK,
];
