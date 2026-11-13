# AppIcon 图标资源

`src/theme/AppIcon.tsx` 会按当前主题自动加载这里的图标。文件名必须与
`src/theme/types.ts` 里的 `IconKey` 完全一致（如 `search.png` → `search`），
缺图时自动回退到原来的 emoji，不会报错。

## 当前图标：极简角色色块

风格参考 `app.ico`：**无描边、无渐变、脸部无五官**，只用 2–4 个纯色块
拼出角色的发色、发型、服装和标志道具，每个角色来自一张看过的番。

| 文件 | 角色 | 出处 |
| --- | --- | --- |
| `anime.png` | 伊蕾娜 | 魔女之旅 |
| `search.png` | 芙莉莲 | 葬送的芙莉莲 |
| `add.png` | 后藤一里 | 孤独摇滚 |
| `edit.png` | 四宫辉夜 | 辉夜大小姐想让我告白 |
| `delete.png` | 蕾姆 | Re:从零开始的异世界生活 |
| `settings.png` | 加藤惠 | 路人女主的养成方法 |
| `calendar.png` | 薇尔莉特 | 紫罗兰永恒花园 |
| `poster.png` | 小鸟游六花 | 中二病也要谈恋爱 |
| `tag-manager.png` | 宫园薰 | 四月是你的谎言 |
| `ai-analysis.png` | 樱岛麻衣 | 青春猪头少年系列 |
| `radar-chart.png` | 锦木千束 | Lycoris Recoil |
| `theme.png` | 由崎司 | 总之就是非常可爱 |
| `template.png` | 星野爱 | 推子 |
| `save.png` | 蕾娜 | 86 -不存在的战区- |
| `close.png` | 阿尼亚 | SPY×FAMILY |

## 目录

| 目录 | 用途 |
| --- | --- |
| `light/` | 浅色主题：同样的角色 + 柔和浅色底 |
| `dark/`  | 深色主题：同样的角色 + 深色底 |
| `classic-light/` `classic-dark/` | 上一版「功能符号」图标，留作备份，不参与自动加载 |

## 规格

- 128×128 PNG，圆角透明（圆角半径约 30%）
- 主体居中，四周留白约 8%

## 扩展

1. 在 ComfyUI（Qwen-Image 2.1）生成 4×4 角色图标集，一格一个角色；
2. 按格子切分，圆角遮罩，缩放到 128×128；
3. 按 `IconKey` 命名，分别放进 `light/` 与 `dark/`，并更新上表。

新增 `IconKey` 时，还要同步更新 `src/theme/types.ts` 的 `ICON_KEYS`
和 `AppIcon.tsx` 的 `EMOJI_MAP`。
