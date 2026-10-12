# Vilausity 项目说明（给在这个仓库里干活的 AI 编码助手）

Vilausity：在 VS Code 之外原样运行官方 Claude Code 插件的 Electron 程序。做法是伪造一个 `vscode` 模块，编辑器用 Monaco，窗口结构学 Claude app，视觉用 VS Code 的风格。

- 计划和阶段：`docs/PLAN.md`（立项时定下的完整计划，别删别改原意）；进度和下一步见 `docs/ROADMAP.md`。
- 架构和分层规矩：`docs/ARCHITECTURE.md`；视觉规范：`docs/design.md`；关键决策：`docs/adr/`。
- 插件内部的逆向笔记（消息格式、diff 流程、会话标签页和标题、M4 用的环境变量）在本地的 `.local/extension-internals.md`，不进仓库（`.gitignore` 了）。
- 如果根目录有 `HANDOFF.md`，先读它，里面是上一个对话留下的待办。

## 命令

```powershell
npm run build        # esbuild 打包到 dist/
npm run typecheck    # 四套 tsconfig 都要过（含单元测试）
npm test             # 单元测试（免费），之后顺带跑 npm run nls
npm run nls          # 语言包检查：没翻译的条目（显示英文）和过时的条目（算失败）；-- --todo 输出待翻译的 JSON
node tests/ui.mjs    # 界面测试：快捷键、标签页、主题、查找、重启恢复（不发消息，免费）
npm run smoke        # 端到端：真实 Claude 会话发 3 条消息。条款只允许脚本走 API key，所以默认拒绝运行，M2 接上 API 模式；-- --subscription 强制用登录的账号
npm run icons        # 重新生成 resources/icon/ 的图标（SVG + .ico），几何形状和颜色在 scripts/icons.mjs 里改
npm run package      # 正式构建 + electron-builder：release\win-unpacked\ 和 NSIS 安装包
npm run package:dir  # 只出 release\win-unpacked\（快，测打包版用）
run-dev.cmd          # 在资源管理器里双击：构建并启动（手动试用就用它）
```

改完代码的顺序：typecheck，然后 `npm test`，然后 `node tests/ui.mjs`。动了插件私有协议相关的代码（bridge、compat）才跑 smoke。动了打包相关的（electron-builder 配置、构建脚本、读程序文件的路径）就 `npm run package:dir`，再用 `VILAUS_EXECUTABLE=release\win-unpacked\Vilausity.exe` 跑界面测试（smoke 也认）。`npm run package` 之后 `dist/` 是正式构建，`npm run build` 换回开发版。

## 必须遵守

- **分层**：`platform` ← `compat` / `host/node` ← `host/*`；`core` ← `features`。依赖只能往下指。跨进程消息只在 `src/platform/protocol.ts` 里定义。
- **插件私有协议**（webview 和插件后端之间的消息格式）只能出现在 `src/host/exthost/bridge.ts` 和 `src/compat/vscode/`。每处都要注明对照的插件版本（当前是 2.1.282）。
- **壳的新功能**做成 `src/features/<名字>/` 模块，只通过 `core` 的服务接入（`ShellContext.services`），然后在 `src/host/renderer/main.ts` 里登记。以后的插件系统会用同一套机制。
- **视觉**：圆角跟 VS Code 一样不一刀切（骨架偏直角，控件和浮层小圆角，见 `docs/design.md`）、1px 分隔线、颜色只用 `var(--vscode-*)`，不要大圆角卡片、渐变、留白多的"AI 风"。
- **界面文字**：代码里只写英文，放在模块目录的 `messages.ts` 里（`platform/nls.ts` 的 `defineMessages('<命名空间>', {...})`，命名空间不能重名）。中文放进语言包 `src/nls/zh-cn.json`，可以晚点批量补：`npm run nls -- --todo` 导出待翻译的条目，译好合并进去，再 `npm run nls -- --sort` 排好序。术语规范见 `docs/design.md` 的"文案"。日志不翻译。
- **代码**：TypeScript strict，注释用英文，写在行为不直观的地方。文档用中文，术语带英文。
- **测试实例**要用临时数据目录（`--user-data-dir .test-data/...`）和临时工作区，并加 `--secondary-display`（有第二块显示器时窗口开在那块上，不挡主屏）。绝不在测试实例里打开正在进行中的会话（会话列表里带绿点、标着"now"的那条），那会起第二个 claude 进程续写同一个会话。
- **提交**：Conventional Commits，每完成一步提交一次。git 在 `C:\Program Files\Git\cmd\git.exe`；老会话的 PATH 里可能还没有 git，就用全路径。
- **推送**：远程 `origin` 是 GitHub 上的 `Teabie666/vilausity-claude-code-gui-shell`，目前只做备份，不用于协作。需要时就推，大一点的改动可以开分支；不 force push。

## 踩过的坑（非显而易见）

- **从 VSCodium 里的 Claude 会话启动 Electron**：环境里带着 `ELECTRON_RUN_AS_NODE=1` 和一堆 `VSCODE_*`，electron.exe 会变成纯 Node。开发时用 `node scripts/launch.mjs` 或 `run-dev.cmd`；程序本身启动 extension host 时会用 `cleanEnvironment()` 清掉这些变量。
- **Playwright 的模拟按键**走 DevTools 协议，会绕过主进程的 `before-input-event`，测不到我们拦截的快捷键。测试里用 `webContents.sendInputEvent`，见 `tests/ui.mjs` 的 `press()`。**鼠标反过来**：`sendInputEvent` 的鼠标事件只进顶层页面，不会分发进跨进程的 webview iframe，右键会被算到壳的页面上；测右键菜单用 Playwright 的 `page.mouse`（见 `rightClick()`）。
- **页面内查找**不能用 `webContents.findInPage`：查找输入框跟被搜索的内容在同一个页面里时，它会抢焦点，还会悄悄丢掉请求。现在的实现在 webview 里用 CSS Custom Highlight API 自己找（`src/host/webview/find.ts`）。
- **插件 CSS 里的图标字体是 `data:` 内嵌的**，但插件自己的 CSP `font-src` 不放行 `data:`，图标会显示成方框。注入时会给 `font-src` 补上 `data:`（`allowInlineFonts`）。
- **本机的 VSCodium 是便携版**，便携模式会无视 `--user-data-dir`。主题抓取（`npm run capture-themes`）因此只在临时工作区的工作区级设置里切主题，不碰用户设置。
- **源码里别直接写 U+2028/U+2029 这类不可见字符**。tsc 能过，但 esbuild 会把它们当换行，正则会坏掉；要用就用 `String.fromCharCode` 生成。
- **有的依赖默认入口是 UMD**（比如 jsonc-parser），esbuild 打包不了。构建配置里已经设了 `mainFields: ['module', 'main']`。
- **PowerShell 是 5.1**：`Set-Content -Encoding utf8NoBOM` 不存在。写 UTF-8 无 BOM 用 `[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))`；git 提交信息先写进文件，再用 `git commit -F 文件`。
- **npm 11 默认拦依赖的安装脚本**：新装的依赖如果要跑安装脚本，得先 `npm approve-scripts`，批准记录在 package.json 的 `allowScripts`。Electron 44 的二进制在第一次运行时才下载。

## 写进仓库的内容

- 仓库是公开的。文档、代码注释、提交信息只写需求、项目知识、方案和开发环境，不写开发者个人的背景、偏好和协作习惯；这类内容放进助手的记忆（memory）。
- 插件逆向得来的细节（压缩后的函数名、插件内部的流程和状态名）不进仓库，记在本地的 `.local/extension-internals.md`。仓库里的文档和代码注释只写跟插件交互时看得到的行为（消息格式、命令 id、设置项），并注明对照的插件版本。
- 插件的界面文字也不进仓库：M3.5 的对照表用原文的哈希做键，只存译文。
