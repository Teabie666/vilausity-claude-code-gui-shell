# Vilausity：围绕 Claude Code 的轻量工作台（图标待定）

## Context

Claude Code 插件在 VS Code / VSCodium 里的界面好用，但为了它每次开一整个 VSCodium 太重，Claude 桌面版的界面又是另一套风格。目标是做一个**独立程序**，打成 NSIS 安装包，可以装进 Program Files，也方便分享给别人用：
- 以原版 Claude Code 插件为核心（插件不改一行，也不打包进安装包）；
- 编辑器、diff 用 VS Code 的编辑器内核 Monaco；
- **结构**学 Claude app：左边会话列表代替文件树，中间对话，右边内容面板；
- **视觉**完全是 VS Code / Codium 的专业风格；
- 砍掉文件树、终端、调试、源代码管理 SCM、扩展市场、状态栏这些跟 vibe coding 无关的模块。

它的定位是长期使用的主力工具，以后要加功能，甚至做独立的插件系统，所以**可维护性和模块化是一等要求**。质量优先，不赶工。

已定的决策：
- 路线：新壳 + Monaco，不 fork VS Code 源码；
- 默认普通权限运行，需要时用户自己"以管理员身份运行"；
- 第一版要会话侧边栏、diff 预览标签页、API 接口模式、脱离 VSCodium；
- 评论复刻插件现有的"计划评论"体验；
- 开发目录 `C:\Users\79157\Desktop\Made by Claude (Code)\ccshell\`，只出 NSIS 安装包，不出便携版。

## 研究结论（设计依据，均已在插件 2.1.282 源码里核实）

插件目录：`C:\Program Files\VSCodium\data\extensions\anthropic.claude-code-2.1.282-win32-x64\`

1. **结构**：插件由三部分组成。
   - `extension.js`：3MB 的 CommonJS 后端，`module.exports={activate,deactivate}`，有 36 处 `require("vscode")`，一共用到约 96 个 VS Code API 成员。
   - `webview/index.js` + `index.css`：React 前端，codicon 字体已内嵌。
   - `resources/native-binary/claude.exe`。
2. **前端传输**：
   - 前端只调用 `acquireVsCodeApi().postMessage`，通过监听 `window` 的 `message` 事件接收 `{type:"from-extension", message}`。
   - 请求格式 `{type:"request", channelId, requestId, request:{type}}`，响应格式 `{type:"response", requestId, response}`，取消格式 `{type:"cancel_request", targetRequestId}`。
   - 用户发消息走 `{type:"io_message", channelId, message, done}`。
   - 后端处理约 140 种请求，绝大多数跟编辑器无关。
3. **HTML**：插件生成的页面有 CSP（nonce + `cspSource`）、`index.css`、`#root`、`window.IS_SIDEBAR / IS_FULL_EDITOR / IS_SESSION_LIST_ONLY`，再加一个 `type="module"` 的 index.js。
4. **改文件审批**：前端收到 Edit/Write 权限请求时，会发 `open_diff` 并等结果，返回空会自动拒绝。
   - 后端调用 `vscode.diff`，轮询 `tabGroups.all` 找 `TabInputTextDiff`，然后等三件事里先发生的一件：标签页关闭、接受（`claude-vscode.acceptProposedDiff`，或前端发来的 `accept_diff`）、保存。
   - diff 右侧文档来自插件注册的 FileSystemProvider（`_claude_vscode_fs_right`）。
   - 内嵌审批：`accept_diff` 返回 `found:false` 时，前端改为直接接受。
5. **ExtensionContext**：只用到 `globalState`、`workspaceState`、`extensionUri/Path`、`asAbsolutePath`、`subscriptions`、`extension`、`globalStorageUri`。
   - 不用 VS Code 的 SecretStorage。
   - 登录由 CLI 自己走 OAuth，壳里只需要实现 `env.openExternal`。
6. **当前文件和选区**：`window.activeTextEditor` 和选区事件会经 `selection_changed` 同步到聊天框。`request:{type:"insert_at_mention", text}` 可以往输入框插文本。
7. **计划评论**：只在 ExitPlanMode 的权限卡片里显示，格式是 `[Re: "<选中文字>"] <评论>`。普通对话里**没有**通用的评论块功能，要自己做。
8. **工作目录**：`cwd = workspaceFolders[0] || os.homedir()`。会话列表是单独一个 webview（`claudeVSCodeSessionsList`）。
9. **主题**：CSS 用了 250 个 `--vscode-*` 变量。VS Code 给 webview 的默认样式在 `C:\Program Files\VSCodium\resources\app\out\vs\workbench\contrib\webview\browser\pre\index.html`（`_defaultStyles`，MIT 许可）。
10. **Open VSX**：`GET https://open-vsx.org/api/anthropic/claude-code/win32-x64` 返回 `version`（2.1.294）、`files.download`、`files.sha256`。
11. **Claude Code 支持的接口和模型自定义**（在插件和 settings schema 里核实）：
    - 接口和鉴权：`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`、`API_TIMEOUT_MS`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_SKIP_AUTH_LOGIN`。
    - 模型：`ANTHROPIC_MODEL`，以及 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`，每个都可以带 `_NAME`、`_DESCRIPTION`、`_SUPPORTED_CAPABILITIES`（决定模型选择器里怎么显示）。
    - 额外模型选项：`ANTHROPIC_CUSTOM_MODEL_OPTION`（+ `_NAME`、`_DESCRIPTION`）；子代理：`CLAUDE_CODE_SUBAGENT_MODEL`。
    - 云厂商：Bedrock / Vertex / Foundry（`CLAUDE_CODE_USE_*`）。
    - settings 里的 `availableModels`、`modelOverrides`、`apiKeyHelper`。
    - 插件通过设置项 `claudeCode.environmentVariables` 把这些环境变量注入它启动的 claude 进程。
12. **环境**：
    - VSCodium.exe 设了 `RUNASADMIN`。
    - VSCodium 的 DeepSeek 配置档 `profiles\-68229e90\settings.json` 里就是上面那几个环境变量。
    - 本机有 node 24、npm 11、electron 44.7.0 可装。
    - git 2.55 装在 `C:\Program Files\Git`，但还没配 `user.name` / `user.email`。当前 VSCodium 会话的 PATH 是装 git 之前的，用全路径调用，或者重启 VSCodium。

## 代码架构（为可维护性和以后的插件系统设计）

```
src/
  platform/      最底层：类型化 IPC 协议（protocol.ts，所有跨进程消息的唯一定义处）、事件、Disposable、日志、
                 服务注册表（轻量依赖注入 DI）。不依赖任何 feature。
  core/          壳的骨架和"贡献点"注册表 contribution registries：commands、keybindings、menus、views（侧边栏/面板）、
                 editors（按文件类型或 scheme 注册内容面板编辑器）、settings schema、title bar items。
                 对外暴露 Vilausity API，所有 feature 都只通过它接入。
  features/      每个功能是一个模块（目录里有 manifest + activate(ctx)），只依赖 Vilausity API：
                 sessions/、chat/、content-pane/、editor/（Monaco+Shiki）、diff/、markdown/、comments/、
                 providers/（API 接口）、extension-manager/、theme/、quick-open/、command-palette/
  compat/vscode/ VS Code API 兼容层（shim），一个命名空间一个文件，跟壳的 UI 完全隔开，只通过 core 的服务说话
  host/          Electron 胶水层：main/（窗口、CLI、单实例、存储、协议、系统集成）、exthost/（utilityProcess 入口、
                 require 劫持、bridge 拦截）、renderer/（启动 core 和 features、iframe 宿主）
```

- **以后的插件系统**：内置功能本身就用"模块 + Vilausity API + 贡献点"这套机制，以后开放外部插件只是"从用户目录加载同样格式的模块"。第一版不开放，但 API 按这个要求设计：版本号、只读的上下文、可撤销的注册。
- **工程规范**：
  - TypeScript strict，ESLint + Prettier；
  - IPC 消息全部在 `protocol.ts` 里有类型定义，运行时用 zod 校验；
  - 每个模块都有单元测试；
  - `docs/ARCHITECTURE.md` 写清楚分层和数据流，关键决策写成 ADR（决策记录，放 `docs/adr/`）；
  - git 从第一天就用，每完成一步提交一次，提交信息遵循 Conventional Commits；
  - 跟插件私有协议有关的代码只放在 `host/exthost/bridge.ts` 和 `compat/`，每处都注明来自哪个插件版本的哪段逻辑。
- **技术栈**：
  - 构建：esbuild（main、exthost）、Vite（renderer）；
  - 编辑器：`monaco-editor`、`shiki` + `@shikijs/monaco`（TextMate 语法 + dark-plus/light-plus，高亮效果跟 VS Code 一致）；
  - 其他库：`vscode-uri`、`@types/vscode`（shim 按它实现）、`marked` + `dompurify`、`yauzl`、`zod`；
  - 打包和测试：`electron-builder`、`playwright`。

## 进程模型

```
Electron main ── 窗口、CLI、单实例、配置/状态存储（唯一写入方）、插件下载、ccw:// 协议、
   │              系统集成（对话框/剪贴板/外部浏览器/通知/DPAPI 加密）
   ├─ 每个窗口一个 ext host（utilityProcess）：require('vscode') → compat/vscode；activate(ctx)
   │     ↕ MessagePort 直连 renderer（webview 消息、编辑器模型）
   └─ renderer：core + features；每个插件 webview 一个 <iframe>（ccw://<id>.webview/）
               iframe 的 HTML = 插件生成的页面 + 用同一个 nonce 注入的引导脚本
```
- 引导脚本负责：`acquireVsCodeApi`、主题变量和 body 的 class、`_defaultStyles`、拦截链接点击、转发快捷键。消息在 iframe `load` 之前先缓存。
- `ccw://res/...` 只放行插件目录。插件进程崩溃不影响窗口，可以一键重启。

## 界面（结构学 Claude app，视觉是 VS Code）

```
┌ 标题栏：Vilausity · <文件夹 ▾> · <API 接口 ▾>                            ─ □ × ┐
├──────────┬───────────────────────────┬──────────────────────────────────┤
│ 会话列表  │ 当前对话（插件原版界面）     │ 内容面板 [plan.md][diff: a.py][b.ts]   │
│          │ ┌评论块 3┐ ← 往上叠          │ Monaco / diff / Markdown 预览          │
│          │ ├评论块 2┤                  │ 选中文字 → [评论] 按钮 → 评论小窗        │
│          │ ├评论块 1┤                  │                                       │
│          │ [ 输入框 ]                   │                                       │
└──────────┴───────────────────────────┴──────────────────────────────────┘
```
- **视觉规范**（`docs/design.md`）：圆角不一刀切，大方向跟 VS Code 一样：窗口骨架偏直角，控件和浮层用跟 VS Code、插件协调的小圆角，具体的在 M5 打磨时定。1px 分隔线、codicon 图标、信息密度高、颜色全部来自主题变量。不要大圆角卡片、渐变、阴影、留白过多的"AI 风"。插件自己的界面保持原样不动。（2026-10-10 改：原来写的是壳里一律直角，做出来跟插件的微圆角放在一起不协调，VS Code 自己也不是处处直角。2026-10-11 改：侧栏的会话列表例外，按壳的风格调整布局和样式；对话页仍保持原样。）
- 侧边栏用 Ctrl+B 开关。内容面板有东西时自动打开，Ctrl+\ 开关，宽度可拖，标签页可以弹出成独立窗口。
- 每个打开的对话对应一个插件 panel（背后一个活着的 claude 进程）。中间只显示当前对话，切换靠侧边栏，Ctrl+Tab 在已打开的对话之间轮换，Ctrl+N 新建。
- 保留的 VS Code 组件：Monaco 编辑器和 diff 编辑器、codicon、主题配色、Ctrl+P 快速打开、Ctrl+Shift+P 命令面板、Ctrl+F 查找、设置编辑器（图形界面 + 在 Monaco 里编辑带 schema 的 settings.json，两者都有，跟 VS Code 一样）。
- 砍掉的：文件树、终端、调试、SCM、扩展市场、任务、状态栏、活动栏、底部面板。

## vscode 兼容层（compat/vscode）

- **真实现**：
  - 基础类型：`Uri`（vscode-uri）、事件和基础类型、各种枚举，以及 `TabInput*`（插件用 instanceof 判断）。
  - `commands`：注册表 + `executeCommand`，内置实现 `setContext`、`vscode.open`、`vscode.diff`、`vscode.openFolder`，`workbench.action.*` 只实现用得到的。
  - `window`：
    - webview 相关：`createWebviewPanel`、`registerWebviewViewProvider`、`registerWebviewPanelSerializer`（重启后恢复对话）。
    - 弹层：`show*Message`（壳里的提示；窗口没焦点时发系统通知并闪任务栏）、`showQuickPick`、`showInputBox`、`withProgress`。
    - 日志：`createOutputChannel`，写到日志文件。
    - `tabGroups` 模型：对话标签页加内容面板标签页，`close()` 和变更事件都实现。
    - 编辑器状态：`activeTextEditor`、`visibleTextEditors`、`showTextDocument`、选区事件，都对接 Monaco。
    - `registerUriHandler`。
  - `workspace`：
    - 工作区和配置：`workspaceFolders`、`getConfiguration`、`onDidChangeConfiguration`。
    - 文件：`fs`、`findFiles`（遵守 .gitignore 和 exclude）。
    - 文档：`openTextDocument`、`textDocuments`、文档的 open/change/save/close 事件。
    - 内容提供者：`registerFileSystemProvider`、`registerTextDocumentContentProvider`，diff 的临时文档靠它们。
    - 其他：`applyEdit`（最小实现）、`asRelativePath`。
  - `env`：`appName`、`clipboard`、`openExternal`、`machineId`、`uriScheme`、`shell`、`uiKind`、`language`。
  - 其他：`extensions.getExtension`、`version`。
- **空实现**：诊断（返回空数组）、`comments.createCommentController`、状态栏项、装饰，终端和 notebook API。
- **兜底**：整个 shim 包一层 Proxy，没实现的成员返回能调用的空函数，并写入 `logs/shim-unimplemented.log`。插件升级后先看它。
- **bridge 拦截**（`host/exthost/bridge.ts`）：
  - `open_terminal / open_claude_in_terminal` → Windows Terminal；
  - `open_folder*` → 壳的文件夹选择 / 新窗口（2026-10-10 研究后改：插件处理这两个请求时调的是 `vscode.openFolder` 命令，compat 实现这个命令就行，不用在 bridge 拦截）；
  - `open_output_panel` → 在内容面板打开日志；
  - `io_message`（用户消息）→ 附加评论块（见下）；
  - 其余原样转发。

## 内容面板和编辑器

- **打开文件**：聊天里点文件（`open_file` → `showTextDocument`）、Ctrl+P、拖拽进窗口都能打开。语法高亮，有行号，Ctrl+S 保存，有未保存标记。Claude 在磁盘上改了文件：没改过就自动重新载入，改过就提示冲突。
- **Markdown**：默认显示渲染后的预览，可以切到源码。插件自己的计划预览 webview（`claudePlanPreview`，自带评论）作为一个标签页显示。
- **diff 预览**：插件调用 `vscode.diff` 时打开 Monaco DiffEditor 标签页。右侧可以直接改，改动回传给插件。有"接受 / 拒绝"按钮，执行 `claude-vscode.acceptProposedDiff / rejectProposedDiff` 前，先把 activeTab 设成这个 diff 标签页。聊天里的内嵌审批照常能用。
- **选区同步**：当前文件和选区经 shim 报告给插件，聊天框显示"已选 N 行"并自动带上上下文。

## 评论（复刻插件"计划评论"的体验，features/comments）

- **添加**：在 Monaco、Markdown 预览、diff 里选中文字后，旁边浮出一个"评论"按钮。点开是一个评论小窗，里面有引用片段、输入框、"添加评论 / 取消"，Ctrl+Enter 也能添加。
- **显示**：评论按对话归属，在对话输入框正上方**一条一块**地显示，新的往上叠。每块显示：
  - 引用片段（截断）
  - `文件名:行号`（点击跳回原文）
  - 评论内容
  - 编辑和删除按钮

  块太多时折叠成"N 条评论"。块是注入到 iframe 里的独立 DOM，跟插件界面同一套主题变量，样式跟旁边插件的输入框协调。
- **发送**：用户在输入框里正常发消息时，bridge 拦截这条 `io_message`，把评论按插件同款格式附加进去：`[Re: "<片段>" — <文件>:<行>] <评论>`，每条一段，再加一个说明头。发送后清空这些评论块。不会往用户的输入文字里硬塞文本。
- **持久化**：评论存在 workspaceState，重启不丢。插件自己计划预览里的评论走插件原生流程，不重复处理。
- **M0 要验证**的两点：怎么定位插件的输入框（优先用 role、aria 等稳定特征，不靠哈希类名）；`io_message` 用户消息的结构。

## API 接口模式（features/providers）

- **"接口"是一等配置**，可以有多个，每个窗口在标题栏里切换，也可以用 CLI `--provider <id>` 指定。每个接口包含：
  - `type`：`subscription`（Claude 账号登录，默认）、`anthropic-api`（官方 API key）、`compatible`（Anthropic 兼容接口：base URL + key，DeepSeek、Kimi、GLM、Qwen 等）、`bedrock` / `vertex` / `foundry`；
  - `baseUrl`；鉴权方式（`apiKey` → `ANTHROPIC_API_KEY`，`bearer` → `ANTHROPIC_AUTH_TOKEN`）；
  - 模型映射：主模型，Opus / Sonnet / Haiku / Fable 各档，子代理，以及模型选择器里显示的名字和描述（`_NAME`、`_DESCRIPTION`）、额外的自定义模型选项；
  - 自定义请求头、超时、最大输出、是否关闭非必要流量，以及任意额外环境变量。
- **实现**：切换接口就是改写传给插件的 `claudeCode.environmentVariables`（加上 `disableLoginPrompt` 和 `CLAUDE_CODE_SKIP_AUTH_LOGIN`），之后新开的对话生效，已经打开的对话会提示重开。
- **预设**以数据文件的形式内置：Claude 订阅、Anthropic API、DeepSeek、Kimi、GLM、Qwen…，用户可以增删。（2026-10-10 定：国内四家加国际站（Kimi moonshot.ai、智谱 Z.ai、阿里云新加坡），另有"自定义兼容接口"模板；地址和模型名按各家官方文档，模型名变得快，预设只是起点，每个带官方说明的链接。）
- **密钥**用 Electron `safeStorage`（Windows DPAPI）加密存放，绝不以明文写进 settings.json，也绝不进安装包。
- ~~**导入**：从 VSCodium 的 DeepSeek 配置档 `profiles\-68229e90` 导入成一个"DeepSeek"接口，导入后密钥立即加密。~~（2026-10-10 定：不做，跟导入设置一样砍掉；选 DeepSeek 预设、把 key 粘进接口编辑页就行。）
- 菜单里可以"为此接口创建快捷方式"（例如给 DeepSeek 接口生成快捷方式：`Vilausity.exe --provider deepseek`）。窗口用不同的强调色区分接口。（2026-10-10 定：订阅不加颜色；其他接口在标题栏底边加一条 2px 色线，「API 接口 ▾」按钮前一个色块。一个文件夹第一次打开时用设置里的默认接口（初始是订阅），之后每个文件夹记住自己上次用的。）

## 配置和 CLI

- **数据目录**：`%APPDATA%\Vilausity\`，下面有 `settings.json`（JSONC）、`providers.json`（密钥字段是加密后的值）、`state\`、`logs\`、`extensions\`、`themes\`。Program Files 下的程序目录只读。
- **设置的 schema** = 插件的 `contributes.configuration` + 各 feature 通过贡献点注册的设置（`vilaus.*`，以及壳照 VS Code 支持的 `editor.*`、`workbench.*` 等）。
- **设置编辑器**（M2.5）：照 VS Code 的设置界面，作为内容面板的标签页（Ctrl+,）：搜索、分类目录、按类型给开关 / 下拉 / 输入框，改过的项有标记、可以还原，复杂的值去 settings.json 改；一个按钮切到在 Monaco 里编辑 settings.json（补全、悬停说明、按 schema 校验）。两边改了都保存后立即生效。编辑器的字体、字号等设置对普通编辑器和 diff 都生效。
- **CLI**：
  ```
  vilaus [folder] [--provider <id>] [--new-window] [--session <id>] [--prompt <文本>] [--goto <file:line>]
          [--extension-dir <dir>] [--user-data-dir <dir>] [--theme <id>] [--log-level <lv>]
          [--devtools] [--version] [--help]
  ```
  第二次启动时，参数转发给已经在运行的实例。以管理员身份运行的实例用单独的 Chromium 数据目录，但共用配置，写入由 main 串行处理。
- **多窗口**（2026-10-10 定）：一个进程管多个窗口，每个窗口一个工作区（文件夹）和一个插件进程；同一个文件夹只开一个窗口，再打开就切到那个窗口。在当前窗口打开文件夹 = 替换这个窗口的工作区（照 VS Code，回到原来的文件夹时对话会恢复），"在新窗口中打开"另有一项。不带文件夹启动时恢复上次的窗口。
- 2026-10-10 定：不做从 VS Code / VSCodium 导入设置（原来写的是首次启动可以导入 `claudeCode.*` 和编辑器字体设置）；去掉 `--settings <file>`，要单独一份设置就用 `--user-data-dir`。

## 插件管理（脱离 VSCodium）

- 查询 Open VSX，下载 VSIX，用 `.sha256` 校验，解压 `extension/` 到 `extensions\anthropic.claude-code-<ver>\`，下次启动时切换过去。保留上一个版本用于回滚。
- 设置项：自动更新开关、锁定版本。记录"最后一个能正常运行的版本"：新版本激活失败，或者没实现的 API 突然变多，就提示回滚。
- 2026-10-11 定（④⑤）：首次启动页装好插件后，同一页接着问"怎么连接 Claude"：用 Claude 账号登录（交给插件自己的登录页），或者用 API 接口（打开"管理 API 接口"从预设添加，存好密钥就切过去）。找不到 Git 时启动提示一次（用途、下载 Git for Windows、不再提示），不限于首次启动。管理员实例跟普通实例**共享 API 密钥**：启动时同步普通实例的加密主密钥（主密钥由 Windows 按用户加密，管理员是同一用户；依赖 Chromium 的 Local State 格式，格式变了就退化成管理员实例里重新输入密钥）。管理员实例除了 Windows 的"以管理员身份运行"，标题栏「文件夹 ▾」里加"以管理员身份打开此文件夹"（UAC 确认）；管理员窗口的标题栏标出来。
- 2026-10-10 定：自动更新**默认开**，新版本下载好后**下次启动**才换上，保留上一个版本用于一键回滚；开关、回滚按钮、手动检查更新、导入 VSIX 都做进设置界面，方便别人操作。
- 首次启动显示下载进度，下完走登录，或者选一个 API 接口。开发时用 `--extension-dir` 指向 VSCodium 里的插件。
- **下载不了时的备用办法**（断网、Open VSX 访问不了）：可以手动选一个 `.vsix` 文件导入，或者直接用本机 VS Code / VSCodium 里已经装好的插件。手动导入的包没法跟 Open VSX 对校验值，改为检查包的结构和 `package.json` 里的发布者、名字、平台。

## 主题

- 开发时用 `tools/theme-capture`（VSCodium 开发扩展）在**隔离实例**里跑：`VSCodium.exe --user-data-dir <临时> --extensions-dir <临时> --extensionDevelopmentPath=...`。它依次切换内置主题（Dark Modern / Light Modern / Dark+ / Light+ / 高对比），抓 webview 的主题变量、body class 和 `_defaultStyles`，生成 `src/features/theme/themes/*.json`。不碰用户自己的设置。
- 同一份主题数据同时给壳、Monaco 和 webview 用。语法配色用 Shiki 的 dark-plus/light-plus。

## 界面语言（English / 简体中文，features/language）

- **两种语言**：英文和简体中文。设置 `vilaus.language`：`auto`（默认，跟随系统首选语言：中文就用中文，否则英文）、`zh-cn`、`en`。命令面板里"配置显示语言"（Configure Display Language）切换，跟 VS Code 一样重启后生效；重启时打开的对话会自动恢复。
- **范围**：壳自己画的全部文字（标题栏、标签页、空状态、查找、命令面板的命令名和分类、快速输入和对话框、通知、插件进程崩溃提示、右键菜单的编辑项和链接项），加上插件出现在壳里的文字（目前是右键菜单项）。插件自己的界面（对话、会话列表）不在范围内：插件没做本地化（2.1.282 没有 nls 文件，也不读 `vscode.env.language`），始终是英文。
- **插件命令的名字**：插件的命令标题是写死的英文。Vilausity 按命令 id 自带中文名，没收录的回落到英文；英文去掉标题里的 "Claude Code: " 前缀。
- **机制**：`platform/nls.ts`，三个进程共用。代码里只写英文：每个模块在自己目录的 `messages.ts` 里用 `defineMessages('<命名空间>', {...})` 定义，键有类型检查。中文放在单独的语言包 `src/nls/zh-cn.json`（键是 `命名空间.键`），没翻译的条目显示英文，所以写功能时可以只写英文，译文攒一批再补。`npm run nls` 列出语言包缺的和过时的条目（过时的算失败），`npm run nls -- --todo` 把待翻译的条目输出成 JSON。支持 `{0}` 占位符。语言由 main 在启动时算出，传给 renderer 和 extension host；`vscode.env.language` 报告同一个值（跟 VS Code 一致）。页面的 `lang` 属性跟着设，中文用系统的中文回退字体。
- **译名**：术语跟 VS Code 官方简体中文语言包一致（命令面板、颜色主题、开发人员工具……）；产品名（Claude、Claude Code、Vilausity）和快捷键保持原样。规范写进 `docs/design.md`。日志、代码注释、提交信息不翻译。
- **之后的阶段**：新加的界面文字一律走这套机制（先写英文，译文进语言包）；M2 的 Monaco 按界面语言加载它自己的语言包。

## 插件界面汉化（可选，放在 M3 之后）

- **目标**：界面语言是中文时，插件自己的界面（会话列表、对话里的按钮和标题、输入框提示、权限卡片等）也显示中文。插件没做本地化，只能由壳在页面里替换。
- **做法**：插件的文件一个字节都不改，只在运行时替换页面上显示出来的文字。在注入每个 webview 的引导脚本里加一层对照表翻译：只替换跟原文**完全相等**的界面文字（文本节点，以及 `placeholder`、`title`、`aria-label` 属性），用 MutationObserver 跟着插件的 React 重绘持续替换。
  - 研究后定的（2026-10-10）：
    - `aria-label` 不翻：屏幕上看不到，壳（评论块的锚点、对话内容的排除区）和测试还靠它定位插件页面里的元素。输入框的提示文字在 `data-placeholder` 属性里，也要翻。
    - 插件代码里拆成几段的句子（"Allow reading from" + 路径 + "?"）按段翻，中文语序对得上的才翻。
    - 运行时拼出来的文字（模板，比如 "3 days ago"）：只有一个变量的按模板匹配，表里存前后缀的长度和哈希，加上变量的类型（数字 / 任意）防止误配；在 Windows 上值固定的直接当普通条目；多个变量的保持英文。
    - 插件经 VS Code API 弹在壳里的通知、输入框、选择框，也用同一张表翻。
    - 插件的功能名跟 Claude Code 官方中文文档一致，保留英文（Plan mode、Hooks、Skills、MCP……），通用的词翻译；写进 `docs/design.md` 的文案规范。
- **对照表不带原文**：表的键是英文原文的哈希（空白规范化后计算，用快速的同步算法，键里带上长度），值是中文译文；运行时给页面上的文字算哈希再查表。仓库和安装包里只有哈希和译文，没有插件的界面文字。从插件代码里整理原文、交给翻译，都只在本地做，中间产物不提交。表按插件版本维护，放在语言包目录下单独的文件里（对照本地整理出的原文清单检查），翻译走壳的文案同一套补译流程。
- **只翻短的界面骨架**：按钮、标题、菜单项、标签、输入框提示这类大致一行以内的文字。长段的说明文字不翻，保持英文；对话内容一律不碰（Claude 的回复、代码块、用户输入、diff）：对话内容区域整块排除，表里没有的文字也不动；对话区以外的内容（Claude 提问卡片里的问题和选项、会话标题、输入框里的提示建议等）也排除。插件升级后新出现的文字先显示英文。设置里可以关掉，回到原样。
- **测试**：smoke 依赖插件的英文按钮名，固定英文跑；界面测试另加一项：中文下会话列表和输入框提示是中文，对话内容不变。
- **为什么放在 M3 之后**：M3 要往插件页面里注入评论块，注入、定位、避开插件内容的那套机制在 M3 里完善，汉化直接复用。

## 打包

electron-builder 打 NSIS 安装包：可以选只装当前用户，或装到 Program Files 给所有用户；建开始菜单和桌面快捷方式；卸载时默认保留 `%APPDATA%\Vilausity`。安装包里不含任何 Anthropic 代码，插件在首次启动时从 Open VSX 下载。不出便携版。**名字、图标在打包之前（M5）定。**

- **目标环境**：一台干净的 Windows 10/11 x64，只有安装包和网络。有 Claude 账号，或者有某个接口的 API 和 key，装好就能用 Claude Code 和 Vilausity 的功能：不需要 VS Code / VSCodium，不需要单独装 Claude Code CLI（插件包里自带 `claude.exe`），不需要 Node、Python、Git。第一次启动要联网下载插件（Open VSX 上 Anthropic 认证发布的包，2.1.295 约 116 MB）。
- **Git for Windows 可选**：找不到 Git Bash 时，Claude Code（2.1.282 起）自动改用它的 PowerShell 工具；装了 Git，Claude 才能跑 bash 命令、做 git 操作、用 `shell: bash` 的技能。首次启动提示一次（说明 + 下载链接），不打包。Git 不在默认位置时，用环境变量 `CLAUDE_CODE_GIT_BASH_PATH` 指定 `bash.exe`。
- **发布**：安装包放在 GitHub Releases，新版本由使用者手动下载安装，不做程序内自动更新。
- **不做代码签名**：第一次运行安装包会被 SmartScreen 拦一下，发布说明里写清楚怎么放行（"更多信息" → "仍要运行"）。

## 分阶段交付（每个阶段结束都能用，试用后再继续）

- **M0 技术验证**：
  - 建 git 仓库（先配好 git 身份），搭骨架：platform、protocol、最小 compat，以及 main、exthost、renderer。
  - 插件从 VSCodium 目录加载，开一个对话 iframe，用 scratch 文件夹测试。
  - 通过标准：
    - 能收发消息，内嵌审批的接受和拒绝都生效；
    - `insert_at_mention` 和输入框定位验证可行；
    - `io_message` 的结构确认清楚；
    - 登录状态跟 CLI 共用；
    - 语音输入模块 `audio-capture.node` 能不能加载。
- **M1 核心壳**：
  - core 的贡献点、标题栏、会话侧边栏、多对话、主题抓取并应用；
  - 链接、通知、右键菜单、快捷键、缩放、查找；
  - 窗口状态记忆、重启后恢复对话、日志。
- **M1.5 界面语言**：英文 / 简体中文切换（设置 + 命令面板，重启生效），壳的全部现有文字和插件出现在壳里的菜单项都有中文。放在 M2 之前：后面几个阶段会加大量界面文字，先有机制，它们一开始就是两种语言，不用回头补。
- **M2 内容面板 + Monaco**：打开文件、Ctrl+P、Markdown 预览、保存和外部修改处理、选区同步、diff 标签页、计划预览标签页、弹出成独立窗口。
- **M2.5 设置编辑器**（M2 试用后加的）：设置的 schema 贡献点、设置图形界面、带 schema 的 settings.json 编辑、编辑器和 diff 的字体等设置。原来排在 M4 的"settings 加 schema 和热更新"挪到这里。
- **M3 评论**：完整复刻上面描述的交互。
- **M3.5 插件界面汉化（可选）**：界面语言是中文时，插件自己界面里的短文字按对照表显示中文；插件文件不改，对照表不带原文，对话内容不动。
- **M4 配置 / CLI / API 接口 / 插件管理**：CLI 参数和单实例、API 接口和加密存储、导入 DeepSeek、快捷方式、Open VSX 下载/更新/回滚（下载不了时手动导入）、首次启动流程（含可选安装 Git 的提示）。
- **M5 名字、图标、视觉打磨**（2026-10-10 跟打包对调：原来是 M6。功能做完先把界面打磨到满意，再打包发布）：
  - 范围开工前再商量，不设固定清单：多轮试用、按反馈改，满意了才进 M6。已经知道要改的：圆角（去掉"一律直角"）、配色、按钮和功能的布局、细节的粗糙感。
  - 名字已定为 Vilausity（简称 vilaus）；图标在这里定。
- **M5.5 打磨中加的功能**（2026-10-11 加）：M5 只做界面美化，打磨过程中冒出来的新功能和大改动放到这里，先研究，研究完集中成一块做。第一块是标题栏和对话标签页：标签页挪到对话栏顶上、只有一个对话时隐藏；标题栏中间做搜索框（合并文件夹按钮和命令面板），能搜对话的标题、内容和涉及的文件。
- **M6 打包和发布**：NSIS 安装包，在全新环境下测试（临时 user-data-dir、不依赖 VSCodium、模拟没登录的情况）；发布到 GitHub Releases 后，交给几位使用者在各自的电脑上从零试用。

## 验证

- **自动冒烟测试** `tests/smoke.mjs`（Playwright `_electron.launch`，参数 `--user-data-dir <临时>`，在 scratch 文件夹里跑）：
  - 对话渲染出来，会话列表能加载；
  - 发"只回复 OK"能收到 OK；
  - 让 Claude 改 `scratch/a.txt`：出现 diff 标签页 → 点接受后文件改了；走一遍拒绝，文件没变；
  - 点文件链接，Monaco 标签页显示高亮内容；
  - 选中文字加两条评论 → 输入框上方出现两个独立块 → 发送后 Claude 收到的消息里包含两段 `[Re: …]`，评论块被清空；
  - 切到一个兼容接口，新对话的环境变量正确（检查子进程环境，不实际调用）。
- **单元测试**（node:test / vitest）：protocol 校验、Uri、配置合并、Memento、tabGroups、bridge、providers 生成的环境变量、评论格式。
- **每个阶段的手动检查**：用屏幕工具截图，跟 VSCodium 里的同一界面对比；检查 `shim-unimplemented.log`；确认没有往 `C:\Program Files\VSCodium` 写任何东西；确认 git 里没提交任何密钥。
- **安装包测试**：装到 Program Files，分别用普通权限和管理员权限运行，再卸载。发布后交给几位使用者，在各自的电脑上从零走一遍：安装 → 首次启动下载插件 → 登录或配置 API → 发消息、审批改文件（没装 Git 的电脑上 Claude 用 PowerShell），收集问题。

## 风险

- **插件升级破坏兼容**：Proxy 兜底和日志、锁定版本、回滚、冒烟测试。插件私有协议的依赖集中在 bridge 和 compat 里，每处都注明来源。
- **许可**：插件是 Anthropic 的 All rights reserved 代码，只在本机运行，不重新分发；使用者自己从 Open VSX 下载。正式名字和图标不能像官方产品（M5 处理）。
- **评论块注入 iframe**：依赖插件输入框的 DOM 位置。定位要用稳定特征；定位失败就退回到壳层渲染的评论栏，功能不受影响。
- **同时开 VSCodium 和 Vilausity**：别在两边同时打开同一个会话。
- **管理员实例**：Windows 的 UIPI 会拦掉从资源管理器拖进窗口的文件。
