/**
 * 回归：编辑已有条目的「名字」必须真的写进 Excel 的 B 列。
 *
 * 踩过的坑：mapAnimeToUpdates 里漏了标题列，于是保存改名的请求里根本没有标题这一项
 * —— 界面提示"已保存"、内存里也变成了新名字，但 Excel 还是旧名字。
 * 更糟的是 handleSaveAnime 保存成功后会把 excelTitleSnapshot 更新成新标题，
 * 下一次保存的写前校验（expectedTitle）就拿新标题去比 Excel 里的旧标题 → 409，
 * 用户看到的就是「为什么不让改名字 + 卡在保存失败」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateAnimeEntry } from '../../../features/anime-data/excel-service';
import { EXCEL_COL } from '../../../features/anime-data/excel-mapping';

interface SentUpdate {
  rowIndex: number;
  colIndex: number;
  value: unknown;
  expectedTitle?: string;
}

function stubWrite() {
  const sent: SentUpdate[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body) as SentUpdate[]));
    return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response;
  }));
  return sent;
}

describe('updateAnimeEntry 写回标题', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('改名要写进名字列，且校验用的是加载时的旧标题', async () => {
    const sent = stubWrite();
    await updateAnimeEntry({
      id: 'excel-250',
      excelRowIndex: 250,
      excelTitleSnapshot: '无职转生3',
      title: '无职转生3上半',
      scores: [],
      tags: [],
    } as never);

    const titleUpdate = sent.find((u) => u.colIndex === EXCEL_COL.TITLE);
    expect(titleUpdate).toBeTruthy();
    expect(titleUpdate!.value).toBe('无职转生3上半');
    // 关键：校验基准必须是旧标题。若是新标题，改完名字后每次保存都会被 409 挡下。
    expect(titleUpdate!.expectedTitle).toBe('无职转生3');
  });

  it('标题为空时不写，免得把 Excel 里的名字清空', async () => {
    const sent = stubWrite();
    await updateAnimeEntry({
      id: 'excel-250',
      excelRowIndex: 250,
      excelTitleSnapshot: '无职转生3',
      title: '',
      scores: [],
      tags: [],
    } as never);

    expect(sent.find((u) => u.colIndex === EXCEL_COL.TITLE)).toBeUndefined();
  });
});
