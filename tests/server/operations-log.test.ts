/**
 * server/operations-log 单测 —— 追加写、倒序读、坏行容忍、永不抛错
 *
 * 这些性质是「回退功能可信」的前提：日志本身写坏了不能连累保存，
 * 日志里混进半行 JSON 也不能让整个列表读不出来。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createOperationLog } from '../../server/operations-log';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-log-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createOperationLog', () => {
  it('没有日志文件时返回空数组，不抛错', () => {
    const log = createOperationLog(dir);
    expect(log.read()).toEqual([]);
  });

  it('按追加顺序写入，读出来是新的在前', () => {
    const log = createOperationLog(dir);
    log.append({ op: 'excel.write', source: 'user', summary: '第一次' });
    log.append({ op: 'excel.append', source: 'ai', summary: '第二次' });

    const entries = log.read();
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toBe('第二次');
    expect(entries[1].summary).toBe('第一次');
    // source 必须能区分 AI 与手动 —— 三档权限要靠它审计
    expect(entries[0].source).toBe('ai');
  });

  it('at 字段由服务端生成，且是合法 ISO 时间', () => {
    const log = createOperationLog(dir);
    log.append({ op: 'excel.write', source: 'user', summary: 'x' });
    const at = log.read()[0].at;
    expect(Number.isNaN(new Date(at).getTime())).toBe(false);
    expect(at).toMatch(/Z$/);
  });

  it('snapshot / detail 会被保留，未提供时不出现在结果里', () => {
    const log = createOperationLog(dir);
    log.append({
      op: 'excel.write',
      source: 'user',
      summary: '更新《86》',
      snapshot: '番评分.2026-10-10T18-52-28.abc123.xlsx',
      detail: { cells: 3, titles: ['86'] },
    });
    log.append({ op: 'excel.write', source: 'user', summary: '无细节' });

    const [newest, oldest] = log.read();
    expect(oldest.snapshot).toBe('番评分.2026-10-10T18-52-28.abc123.xlsx');
    expect(oldest.detail).toEqual({ cells: 3, titles: ['86'] });
    // 没传的字段不该被写成 undefined 键，否则 JSON 里会多出噪声
    expect('snapshot' in newest).toBe(false);
    expect('detail' in newest).toBe(false);
  });

  it('limit 取最近 N 条', () => {
    const log = createOperationLog(dir);
    for (let i = 0; i < 10; i++) {
      log.append({ op: 'excel.write', source: 'user', summary: `第 ${i} 条` });
    }
    const entries = log.read(3);
    expect(entries).toHaveLength(3);
    expect(entries[0].summary).toBe('第 9 条');
    expect(entries[2].summary).toBe('第 7 条');
  });

  it('半行 JSON / 形状不对的行只跳过自己，不影响其它行', () => {
    const log = createOperationLog(dir);
    log.append({ op: 'excel.write', source: 'user', summary: '好行 1' });
    // 模拟进程被杀留下的半行，以及一条缺 op 的脏数据
    fs.appendFileSync(log.path, '{"op":"excel.write","summ\n', 'utf-8');
    fs.appendFileSync(log.path, '{"at":"2026-01-01T00:00:00Z","summary":"缺 op"}\n', 'utf-8');
    log.append({ op: 'excel.write', source: 'user', summary: '好行 2' });

    const entries = log.read();
    expect(entries.map((e) => e.summary)).toEqual(['好行 2', '好行 1']);
  });

  it('目录不可写时 append 不抛错（日志不能挡住保存）', () => {
    const log = createOperationLog(path.join(dir, '不存在的子目录'));
    expect(() => log.append({ op: 'excel.write', source: 'user', summary: 'x' })).not.toThrow();
    expect(log.read()).toEqual([]);
  });
});
