/**
 * 服务端网络出口：按目标域名决定「直连」还是「走 Chromium（= 系统代理）」。
 *
 * 为什么必须分流（这是实测出来的，不是猜的）：
 *
 *   ┌──────────────┬───────────────┬────────────────────────────────────┐
 *   │ 目标         │ 直连          │ 走系统代理(Clash)                  │
 *   ├──────────────┼───────────────┼────────────────────────────────────┤
 *   │ api.bgm.tv   │ ✗ DNS 污染/   │ ✓ 200（0.42s）                     │
 *   │              │   SNI 阻断    │                                    │
 *   │ B站 api      │ ✓ 200         │ ✗ 412（被风控当成境外 IP）         │
 *   └──────────────┴───────────────┴────────────────────────────────────┘
 *
 * 也就是说**两个源的正确走法正好相反**，一刀切必然有一边坏掉。
 * Kazumi 靠它自建的规则集在代理层解决同一问题；这里不依赖用户的 Clash 规则
 * 是否写了 B 站直连，直接在应用内按域名决定，行为可预期。
 *
 * 选择 net.fetch 作为「走代理」的实现，是因为它使用 Chromium 网络栈，
 * 自动遵守系统代理设置；而 Node 自带的全局 fetch(undici) 完全不读系统代理，
 * 这正是以前「机器上开着 Clash，打包后的应用却连不上 Bangumi」的根因。
 */
const { net } = require('electron');

/** 国内直连的域名（B 站接口与图床） */
const DOMESTIC_HOST = /^https?:\/\/(?:[^/]*\.)?(?:bilibili\.com|hdslb\.com|bilivideo\.com)(?::\d+)?\//i;

function isDomesticHost(url) {
  return DOMESTIC_HOST.test(String(url || ''));
}

/**
 * 创建服务端 fetch。
 * @returns {(url: string, init?: object) => Promise<any>}
 */
function createFetch() {
  return (url, init) =>
    isDomesticHost(url)
      ? globalThis.fetch(url, init) // 国内直连：走代理会吃 B 站 412
      : net.fetch(url, init); // 国外走 Chromium：自动遵守系统代理
}

module.exports = { createFetch, isDomesticHost };
