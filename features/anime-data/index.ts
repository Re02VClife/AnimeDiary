/**
 * features/anime-data — 数据持久层
 *   统一导出 Excel 读写、本地存储、数据加载编排、模板管理
 */
export { EXCEL_COL, EXCEL_SHEETS, MAIN_SHEET, DIMENSION_COL_MAP, EDITABLE_COLS } from './excel-mapping';
export {
  loadAnimeList,
  readRawRows,
  updateAnimeEntry,
  savePosterUrlToExcel,
  batchSaveAllPosters,
  fetchPoster,
  getExcelInfo,
} from './excel-service';
export {
  loadCategoryMap,
  saveCategory,
  saveCategoryMap,
  loadWatchingDeleted,
  addToWatchingDeleted,
  removeFromWatchingDeleted,
  loadDimensions,
  saveDimensions,
  loadEpisodeReviews,
  saveEpisodeReview,
  deleteEpisodeReview,
  loadDimReviews,
  saveDimReview,
  loadOverrides,
  loadPosterBlacklist,
  addToPosterBlacklist,
  loadPosterOverrides,
  savePosterOverride,
  loadPosterPositions,
  savePosterPosition,
  loadImgHeight,
  saveImgHeight,
  exportAllUserData,
  importUserData,
} from './storage-service';
export {
  loadTemplates,
  saveTemplates,
  getTemplate,
  getDefaultTemplate,
  getActiveDimensions,
  addTemplate,
  updateTemplate,
  deleteTemplate,
  migrateLegacyDimensions,
} from './template-service';
export {
  SHEET_ANIME,
  SHEET_CHARACTER,
  SHEET_ANOMALY,
  buildTransferWorkbook,
  parseTransferWorkbook,
  exportFileName,
  mergeImportedTemplates,
} from './excel-transfer';
export type { BuildExportOptions, ParsedTransfer } from './excel-transfer';
