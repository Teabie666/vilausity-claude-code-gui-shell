# Vilausity

围绕 Claude Code 插件的轻量工作台（简称 vilaus）。在 VS Code 之外，原样运行官方的 Claude Code VS Code 插件，再配上 VS Code 的编辑器内核 Monaco，用 Claude app 式的窗口结构加上 VS Code 的视觉风格。

> 插件本身（`anthropic.claude-code`）是 Anthropic 的专有软件，Vilausity 不包含、不修改、不分发它，运行时从本机已安装的位置加载（M4 起从 Open VSX 下载）。

## 开发

需要 Node 24+。

```powershell
npm install
npm run build        # 打包到 dist/
npm start            # 构建并启动（自动清理从 VS Code 系环境继承的 ELECTRON_RUN_AS_NODE 等变量）
npm run typecheck    # 四套 tsconfig：node 侧 / 网页侧 / preload / 单元测试
npm test             # 单元测试（esbuild 打包后用 node:test 跑），再检查语言包
npm run nls          # 语言包检查；-- --todo 输出还没翻译的条目
npm run smoke        # 端到端冒烟测试：真实启动 + 真实 Claude 会话（用 Haiku，消耗少量额度）
npm run capture-themes   # 从本机 VSCodium 重新抓取内置主题到 resources/themes/
npm run package      # 正式构建并打包：release\win-unpacked\ 和 NSIS 安装包
```

启动参数（M4 会补全）：

```
electron . [文件夹] [--folder <dir>] [--extension-dir <dir>] [--user-data-dir <dir>] [--theme <id>] [--log-level <lv>] [--devtools] [--secondary-display]
```

界面语言（英文 / 简体中文）：命令面板里的"配置显示语言"（Configure Display Language），或者在 settings.json 里设 `"vilaus.language"`：`"auto"`（默认，跟随系统）、`"zh-cn"`、`"en"`，重启后生效。中文下，Claude Code 插件自己的界面（按钮、菜单、提示、会话列表）也显示中文，对话内容不翻译；不想要可以设 `"vilaus.translateExtensionUi": false`，立即生效。

插件界面的对照表（`src/nls/zh-cn.extension.json`）只有哈希和译文。维护：`node tools/extension-strings/extract.mjs` 在本地整理插件的界面文字，`npm run nls -- --todo-extension` 导出待译条目，`node tools/extension-strings/merge.mjs <译文.json>` 合并。

数据默认在 `%APPDATA%\Vilausity\`：`settings.json`、`state\`、`logs\<本次启动时间>\`（`main.log`、`exthost.log`、`shim-unimplemented.log`、`output\`）。

## 文档

- [docs/PLAN.md](docs/PLAN.md)：立项时定下的完整计划
- [docs/ROADMAP.md](docs/ROADMAP.md)：M0–M6 的勾选清单和下一步
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：分层、进程、数据流，以及"加一个功能该改哪里"
- [docs/design.md](docs/design.md)：视觉规范
- [docs/adr/](docs/adr/)：关键决策记录

## 许可证

Copyright (C) 2026 Teabie

Vilausity 以 [GNU General Public License v3.0 或更高版本](LICENSE)（GPL-3.0-or-later）发布。许可证只覆盖本仓库的代码；Claude Code 插件不在其中，它的条款由 Anthropic 规定。随软件附带的字体 Noto Sans SC（思源黑体）以 [SIL Open Font License 1.1](https://openfontlicense.org) 发布，许可证文件跟字体放在一起（`fonts/noto-sans-sc/LICENSE`）。
