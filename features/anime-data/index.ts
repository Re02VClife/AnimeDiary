/**
 * features/anime-data — 数据持久层
 *   统一导出 Excel 读写、本地存储、数据加载编排
 */
export { EXCEL_COL, EXCEL_SHEETS, MAIN_SHEET, DIMENSION_COL_MAP, EDITABLE_COLS } from './excel-mapping';
export {
  loadAnimeList,
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
