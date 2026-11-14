/**
 * server/music-login-window 的可降级性测试
 *
 * 这个模块只在 Electron 主进程里能开窗；跑在纯 Node / jsdom 里必须**明确拒绝**
 * （抛 LoginWindowUnavailable → 路由回 501 → 前端退回手动粘贴），而不是崩掉整条 API。
 */
import { describe, expect, it } from 'vitest';
import { createLoginWindowRunner, LoginWindowUnavailable } from '../../server/music-login-window';
import type { MusicClient } from '../../server/music-qq';

const stubClient = {
  login: () => ({ loggedIn: true, uinMasked: '012****789' }),
} as unknown as MusicClient;

describe('createLoginWindowRunner', () => {
  it('非 Electron 环境下 start() 抛 LoginWindowUnavailable', async () => {
    const runner = createLoginWindowRunner(stubClient);
    await expect(runner.start()).rejects.toBeInstanceOf(LoginWindowUnavailable);
  });

  it('查不到的会话返回 null（前端据此提示重新点登录）', () => {
    const runner = createLoginWindowRunner(stubClient);
    expect(runner.status('nope')).toBeNull();
    expect(runner.cancel('nope')).toBeNull();
  });
});
