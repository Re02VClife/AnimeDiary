/**
 * Excel 数据文件的初始化
 *
 * 打包后的应用把数据放在「文档/AnimeDiary/番评分.xlsx」，首次启动时该文件还不存在。
 * 这里生成一个只含表头的空白工作簿，让应用可以立刻开始使用
 * （列顺序与 server/api-routes.ts 里的 EXCEL_COL 完全对应）。
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/** 主表名（与 api-routes 的 MAIN_SHEET 一致） */
const MAIN_SHEET = '番剧列表';

/** 其余工作表：保持与原项目一致，便于「张数统计」等功能正常 */
const EXTRA_SHEETS = ['张数统计', '玩法', '游戏区', '角色排名', '乱葬岗'];

/** 43 列表头（索引即列号，与 EXCEL_COL 对应） */
const HEADERS = [];
HEADERS[0] = '检索名';
HEADERS[1] = '名字';
HEADERS[2] = '赋分';
HEADERS[3] = '综合(观感)';
HEADERS[4] = '音';
HEADERS[5] = '制作';
HEADERS[6] = '张数';
HEADERS[7] = '作画';
HEADERS[8] = '制作组';
HEADERS[9] = '内容';
HEADERS[10] = '沉浸感';
HEADERS[11] = '剧情';
HEADERS[12] = '人设';
HEADERS[13] = '深度';
HEADERS[14] = '电波';
HEADERS[15] = '评价';
HEADERS[16] = '上映年月';
HEADERS[17] = '首刷时间';
HEADERS[18] = '备注';
HEADERS[19] = '列1';
HEADERS[20] = '偏差值';
HEADERS[21] = '爬虫BGM';
HEADERS[22] = 'BGM';
HEADERS[23] = '代餐';
HEADERS[24] = '较客观评分';
HEADERS[25] = 'tag';
HEADERS[26] = '角色1';
HEADERS[27] = '人设4';
HEADERS[28] = '造型';
HEADERS[29] = '角色2';
HEADERS[30] = '人设2';
HEADERS[31] = '造型2';
HEADERS[32] = '角色3';
HEADERS[33] = '人设3';
HEADERS[34] = '造型3';
HEADERS[35] = '角色4';
HEADERS[36] = 'AniList评分';
HEADERS[37] = '海报URL';
HEADERS[38] = '模板ID';
HEADERS[39] = '链接';
HEADERS[40] = '总集数';
HEADERS[41] = '当前集';
HEADERS[42] = '模板JSON';

/**
 * 确保 Excel 数据文件存在；不存在则创建空白表。
 * @param {string} excelPath
 * @returns {{ created: boolean }}
 */
function ensureExcelFile(excelPath) {
  if (fs.existsSync(excelPath)) return { created: false };

  fs.mkdirSync(path.dirname(excelPath), { recursive: true });

  const wb = XLSX.utils.book_new();
  const mainSheet = XLSX.utils.aoa_to_sheet([HEADERS]);
  // 给主表一个足够宽的行范围，避免空表时 !ref 过窄
  mainSheet['!ref'] = `A1:${XLSX.utils.encode_col(HEADERS.length - 1)}1`;
  XLSX.utils.book_append_sheet(wb, mainSheet, MAIN_SHEET);
  for (const name of EXTRA_SHEETS) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), name);
  }
  XLSX.writeFile(wb, excelPath);
  return { created: true };
}

module.exports = { ensureExcelFile, MAIN_SHEET, HEADERS };
