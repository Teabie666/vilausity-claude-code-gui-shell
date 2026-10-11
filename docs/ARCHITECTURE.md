# 架构

## 一句话

Claude Code 插件以为自己跑在 VS Code 里。Vilausity 给它伪造了一个 `vscode` 模块，把插件需要的编辑器能力翻译成 Vilausity 自己的界面。

## 进程

```
Electron main ── 窗口、命令行参数、设置和状态存储（唯一写入方）、ccw:// 协议、系统集成
   │
   ├─ extension host（utilityProcess，每个窗口一个）
   │     require('vscode') 被劫持 → compat/vscode；加载 extension.js → activate(context)
   │     ↕ MessagePort，直连 renderer
   │
   └─ renderer（窗口页面）
         壳 UI：标题栏、标签页、弹层；每个插件 webview 是一个 iframe（ccw://wv<id>/）
```

- 一个主进程管所有窗口，每个窗口一个文件夹、一个 extension host（[ADR 0004](adr/0004-one-process-many-windows.md)，见下面的"窗口和工作区"）。
- 插件跑在独立进程里：卡顿或崩溃不会拖垮窗口（跟 VS Code 的 extension host 一样）。
- 三个进程之间的所有消息都定义在 `src/platform/protocol.ts` 一个文件里，走 `src/platform/ipc.ts` 的带类型 RPC。
- webview 的消息走 renderer 的 `window.postMessage`，iframe 里先运行注入的引导脚本 `src/host/webview/bootstrap.ts`，它负责提供 `acquireVsCodeApi`、主题变量、VS Code 默认样式、链接拦截。

## 目录分层

| 目录 | 职责 | 可以依赖 |
| --- | --- | --- |
| `src/platform/` | 与环境无关的基础件：事件、Disposable、日志、RPC、协议类型、URL 规则、界面文案（nls） | 无 |
| `src/nls/` | 语言包（`zh-cn.json`：`命名空间.键` → 译文）和取包的 `packs.ts`，只给 main 和 renderer 用 | platform（只用类型） |
| `src/compat/vscode/` | VS Code API 兼容层（shim），一个命名空间一个文件 | platform |
| `src/host/node/` | main 和 extension host 共用的 Node 工具 | platform |
| `src/host/main/` | Electron 主进程 | platform、host/node、nls |
| `src/host/exthost/` | extension host 进程：加载插件、桥接 | platform、compat、host/node |
| `src/host/renderer/` | 窗口页面 | platform |
| `src/host/webview/` | 注入每个 webview 的引导脚本 | platform（只用类型） |
| `src/core/`、`src/features/` | M1 起：壳的贡献点注册表和功能模块（见下） | platform、core；core 的 workbench 还取 nls 的语言包 |

依赖只能向上指（表格上方），不能反过来。compat 不认识 Electron；platform 什么都不认识。

## 跟插件私有协议有关的代码

插件升级最容易坏的地方，全部集中在这两处，每处都注明对照的插件版本：

- `src/host/exthost/bridge.ts`：在消息层拦截插件 webview 与后端之间的私有请求（比如 `open_diff`、`open_url`）；插件页面的知识也只写在这里（页面提示 `WebviewPageHints`：评论块的锚点、页面里哪些区域是内容；页面存的状态里的会话 id）。
- `src/compat/vscode/`：插件依赖的 VS Code 行为细节（比如 diff 标签页的 `TabInputWebview` viewType 前缀）。

这两处和其他文档只描述跟插件交互时看得到的行为（消息格式、命令 id、设置项）；逆向得来的内部细节不写进仓库。

插件升级后的检查顺序：先跑 `npm run smoke`，再看最新一次 `logs\...\shim-unimplemented.log`，有新出现的 API 就补上。然后是汉化：重跑 `node tools/extension-strings/extract.mjs`，`npm run nls` 看新出现和过时的界面文字（`--todo-extension` 导出补译），并核对 bridge 页面提示里的类名在新版本里还在。

## 内容面板（M2）

窗口分三栏：会话侧边栏 | 对话 | 内容面板。对话标签页（`features/conversations`）在对话那一栏的顶上，跟内容面板的标签页同一高度；只有一个对话时不显示这一行（设置 `vilaus.conversations.alwaysShowTabs` 打开后总是显示），因为多数时候只用一个对话。内容面板（`features/contentPane`）只管标签页：打开（含 VS Code 的预览标签页）、切换、脏标记、关闭；有标签页时自动显示，最后一个关掉就隐藏。

- **编辑器贡献点** `core/editors.ts`：一个标签页 = 一个输入（`EditorInput`：类型、URI、语言、给编辑器的数据）+ 一个编辑器（`EditorPane`）。模块按输入类型 / 语言注册 `EditorProvider`，同一输入有多个提供者时取优先级高的（Markdown 预览就是这样盖过普通文本编辑器的）。
- **插件的 webview 面板**由 `core/panels.ts` 按区域分发：exthost 按面板请求的列决定区域（聊天面板永远在对话区；`ViewColumn.Beside` 或第二列以后进内容面板，插件的计划预览就是这样进来的），对话区由 conversations 模块显示，内容面板由 contentPane 模块显示。
- **compat 的标签组**跟着分成两组：第一组是对话区，第二组是内容面板（文本、diff、侧边 webview）。
- **标签页移到独立窗口**（照 VS Code 的 auxiliary window）：主窗口的页面用 `window.open('about:blank', 'vilaus-aux-…')` 开一个同源子窗口（主进程只放行这个名字前缀），子窗口里的内容由主窗口的脚本直接画：样式表、Monaco 生成的样式和主题变量从主窗口镜像过去（`features/contentPane/auxWindow.ts`）。编辑器支持 `EditorPane.relocate(容器)` 才能移：文本 / diff 编辑器在新位置重建 Monaco 控件，模型不变（未保存的修改和撤销历史都在）；webview 在新位置重新加载（计划预览会再要一次内容）。子窗口里的按键由主进程照样截住、交给主窗口的快捷键服务；命令作用在"当前"标签页上（焦点在子窗口时就是子窗口里那个，`ContentPane.current`）。关子窗口 = 关这个标签页（有未保存的修改先问），标题栏上的按钮把它移回内容面板；主窗口关闭或重新加载时子窗口一起销毁。

## 文档和编辑器

插件看到的 `TextDocument` 在 exthost（`compat/vscode/textDocuments.ts`），用户看到的编辑器在 renderer（Monaco）。规则照 VS Code：

- **attached 文档**（有编辑器在显示的）：文字以 renderer 的 Monaco 模型为准（`features/editor/textModels.ts`，同一 URI 的模型被所有编辑器共用）。用户的修改以增量 `document.didChange` 发给 exthost，exthost 更新镜像并发 `onDidChangeTextDocument`；插件要改这些文档（`applyEdit`、`TextEditor.edit`）时，exthost 请 renderer 改模型，改动再照常传回来。脏状态是模型离上次保存的版本有多远（`document.didChangeDirty`）。
- **没有编辑器的文档**由 exthost 自己读写（插件的 FileSystemProvider 也在 exthost）。
- **保存**：renderer 调 `document.save`，exthost 发 `onWillSaveTextDocument`、写盘（或写插件的 provider）、发 `onDidSaveTextDocument`。
- **磁盘被外部改了**（Claude 改文件）：exthost 监视 attached 的文件；文档干净就推 `document.reload`（renderer 用最小替换更新模型，光标和滚动位置不乱），有未保存的修改就推 `document.didChangeOnDisk`，编辑器上方出提示（重新载入 / 保留我的）。exthost 自己写盘时记下写入的内容，不会把自己的写入当成外部修改。
- **编辑器状态**：标签页和编辑器的 id 由 exthost 分配（`compat/vscode/editors.ts` 的 EditorService）。`activeTextEditor` 是内容面板显示时当前标签页的编辑器（焦点在对话里也算，跟 VS Code 在旁边一列显示文件时一样），diff 标签页的左右两个都算可见、右边是 active；选区由 renderer 推给 exthost，插件据此在聊天框里带上当前文件和选中的行。
- **diff**：`vscode.diff` 打开 Monaco 的 diff 编辑器标签页，`TabInputTextDiff` 在命令返回前就进 `tabGroups`（插件会轮询找它）。右边的文档可写时可以直接改。Claude 提议的改动（右边是插件的 `_claude_vscode_fs_right` 文档）带"接受 / 拒绝"按钮：先把这个标签页设为 active，再执行插件的接受 / 拒绝命令。

- **插件进程重启**：旧进程里的标签页和文档跟着它没了；渲染进程断开前记下打开的文件和未保存的文字，新进程连上后重新打开，再把未保存的文字作为一次编辑放回去（新进程于是看到脏文档）。diff 不恢复，它属于提出它的那次会话。

Monaco、Shiki 和 Markdown 渲染都在第一次用到时才加载（renderer 是 ESM + 代码分割，见 [ADR 0003](adr/0003-esbuild-for-all-bundles.md)）。语法高亮用 Shiki（VS Code 的 TextMate 语法，语法颜色取 Dark+ / Light+），编辑器其余颜色取抓来的主题变量。注释符号、括号、缩进规则这些语言配置取自 Monaco 自带的语言定义（只用它们的 `conf`，分词还是 Shiki）。Markdown 预览里的本地图片走 `ccw://img/<路径>`，主进程只放行工作区文件夹里的图片文件。

## 设置（M2.5）

- **settings.json 只有主进程写**（`host/main/settingsStore.ts`，用 jsonc-parser 改，保留用户的注释和格式；文件被手改也会重新读）。改动推给 exthost（`settings.didChange`，插件的 `getConfiguration` 用）和渲染进程（`settingsChanged`）。渲染进程启动时读一次（`settings.read`），写用 `settings.update`（`undefined` 表示删掉、回到默认值）。
- **设置的贡献点** `core/settings.ts`：模块用 `ISettings.register` 声明自己的设置：键、值的 JSON schema（类型、默认值、说明、枚举、上下限……）、设置界面里的分区。插件的 `contributes.configuration` 从它的清单读出来一并声明；给 VS Code 界面用、在 Vilausity 里没意义的几项标成 `hidden`（不在设置界面列出，但留在 schema 里）。读值用 `get(键, 兜底)`：用户的值，否则声明的默认值。
- **设置编辑器**（`features/settings`）是内容面板的一个标签页，照 VS Code 的设置界面：按类型给控件，和默认值相同的值不写进文件（保持 settings.json 简短）。**settings.json** 用普通文本标签页打开，Monaco 的 JSON 语言服务（单独的 `json.worker`）按所有声明生成的 schema 给补全、悬停说明和校验。注意：JSON 语言服务的 `fileMatch` 是 glob（前面自动加 `**/`），拿去匹配的是解码后的 URI，所以给的是"上级文件夹/settings.json"，不是完整 URI。
- **编辑器设置**用 VS Code 的键名和默认值（`editor.*`、`diffEditor.*`）。字体相关的（`editor.fontFamily` 等）由主进程算成主题的字体变量，webview 和编辑器共用；其余的由编辑器模块转成 Monaco 选项，改了实时作用到所有文本和 diff 编辑器。加一项设置：在模块里 `register` 声明，`get` 读，`onDidChange` 里重新应用。
- **settings.json 比设置界面全**：设置界面只列常用的；Monaco 的编辑器选项自带 JSON schema（VS Code 的 `editor.*` 设置就是从它生成的，说明文字随 Monaco 的语言包），编辑器模块加载 Monaco 后把还没声明的都登记成 `hidden` 设置（`monacoOptionDefinitions`）；diff 编辑器的其余选项 Monaco 没有 schema，照 VS Code 的键名手写声明。settings.json 里的 `editor.*` / `diffEditor.*` 只要声明过，就转成 Monaco 的嵌套选项（`editor.minimap.side` → `minimap.side`，`diffEditor.wordWrap` → `diffWordWrap`）；没声明的忽略（跟 VS Code 一样），所以碰不到 `readOnly`、`automaticLayout` 这类不该开放的选项。字体走主题变量、缩进走模型（`applyIndentation`），不经这条路。
- **默认设置（JSON）**：只读的 Monaco 编辑器（`TextEditorService.createViewer`，背后没有文档，插件看不到），内容由所有声明生成（`defaultSettingsText`），声明变了（比如插件的设置晚到）跟着刷新。查找命令找当前有焦点的编辑器（`focusedCodeEditor`），所以 Ctrl+F 在它里面也能用。
- **写 settings.json**：先写临时文件再 rename（`host/node/jsonFile.ts`）。Windows 上目标文件被别的进程打开着（读它的程序、杀毒软件、同步盘）时 rename 会 EPERM，所以短暂重试，跟 graceful-fs 一样。写入排队执行，一次失败不影响后面的。

## 窗口和工作区（M4）

- **全局和每个窗口**：`host/main/shellApp.ts` 持有窗口共用的东西（设置、插件的 globalState、主题、界面语言、webview 文档、`ccw:` 协议），`host/main/windowContext.ts` 是一个窗口：BrowserWindow、它的文件夹和 workspaceState、它的 extension host。渲染进程调主进程时按发送的窗口分发；设置、主题、语言变了通知所有窗口。插件的 globalState 所有窗口共用：一个窗口的 extension host 写了，主进程转给其他窗口的（`storage.didChange`，compat 的 Memento 跟着更新）。webview 的 id 是随机的，所以所有窗口的 webview 文档放在同一个表里，窗口关掉或插件进程重启时按窗口清掉。
- **一个文件夹一个窗口**：打开一个已经有窗口的文件夹，就把那个窗口提到前面。在当前窗口打开别的文件夹（"打开文件夹…"、最近的文件夹、插件的"打开文件夹"按钮）先确认一句（有打开的对话或文件时），未保存的文件逐个问；然后主进程停掉这个窗口的 extension host（插件把打开的对话记在旧文件夹的 workspaceState 里，回到这个文件夹时恢复），换成新文件夹的 workspaceState，重新加载页面，页面加载完再起新的 extension host。界面在 `features/workspace`：标题栏的文件夹按钮和"打开最近的文件夹"（Ctrl+R，选择框里 Ctrl+Enter 在新窗口中打开）、新建窗口（Ctrl+Shift+N，选一个文件夹）。
- **记住的东西**（`state/shell.json`，`host/main/windowHistory.ts`，跟插件的 globalState 分开）：每个文件夹的窗口位置（最多 50 个）、最近打开的文件夹、开着的窗口、所有窗口共用的缩放级别（同源页面的缩放在 Chromium 里本来就一起变）。开着的窗口随时更新，所以崩溃后也能恢复。启动时：命令行给了文件夹就只开它；没给就恢复上次开着的窗口，都没有才用主目录。一个个关窗口，最后一个关掉时退出，下次只恢复它；用"退出"命令或别处调 `app.quit()`（`before-quit` 被拦下来走同一条路）时开着几个记几个；换界面语言的重启（`app.relaunch`）不管命令行，恢复全部。
- **单实例**：`app.requestSingleInstanceLock` 的锁在 userData 里，一个数据目录一个实例。第二次启动在写任何东西之前把原始参数和工作目录（`additionalData`）交给已经在跑的实例，然后退出；那边按自己的规则解析（相对路径按第二次启动的工作目录算）。参数交给哪个窗口：文件夹 → 它自己的窗口；文件（位置参数或 `--goto 文件:行:列`）→ 文件夹包含它的窗口，没有就交给最近的窗口；什么都没给 → 最近的窗口（`--new-window` 开一个主目录的新窗口）。`--session` / `--prompt` 在那个窗口里开对话：窗口是新开的，就放进插件进程的初始化数据，代替窗口默认打开的空对话；已经开着的，经 `conversation.open` 让插件进程执行插件的 `claude-vscode.primaryEditor.open`。`--prompt` 只是填进输入框，不会发出去。开发时（`electron <开关> <app 路径> <参数>`）用户参数是 app 路径之后的部分（`cli.ts` 的 `userArguments`，Playwright 会在 app 路径前面加 `--inspect=0`）。
- **`vilaus://` 链接**：Windows 打开协议链接时把 URL 当参数传给程序，于是跟别的参数一样走单实例转发。`vilaus://<插件 id>/<路径>?<参数>` 交给那个插件用 `window.registerUriHandler` 注册的处理器（Claude Code 有 `/open?session=&prompt=`），之前照 VS Code 先问用户一次（网页也能放这种链接）。把协议登记进注册表在 M6 的安装包里做。
- **插件调的 VS Code 内置命令**（`host/exthost/workbenchCommands.ts`）：`vscode.openFolder`（插件的"打开文件夹 / 在新窗口中打开"按钮，没给文件夹就弹选择框）交给渲染进程走上面同一套流程；`workbench.action.openSettings` 打开设置编辑器并填好搜索词；`revealFileInOS` 在资源管理器里选中文件。

## API 接口（M4）

- **数据**：`platform/providers.ts` 定义接口（类型、Base URL、鉴权方式、各档模型、请求头、超时、最大输出、关闭非必要流量、其他环境变量、强调色、来自哪个预设），以及接口 → 环境变量的纯函数（`providerEnvironment`），主进程、渲染进程和单元测试共用。内置的"Claude 订阅"不设任何变量。预设在 `features/providers/presets.ts`，按各家官方文档（2026-10-10），只是起点，每个带官方说明的链接。
- **存储**：`providers.json` 只有主进程写（`host/main/providerStore.ts`）。密钥用 Electron 的 safeStorage 加密后存（Windows 上是 DPAPI，只有这个 Windows 用户能解开），系统不提供加密时拒绝保存，绝不存明文。渲染进程只知道有没有密钥（`ProviderSummary.hasKey`）：密钥在编辑页里输入后经 `providers.setKey` 交给主进程，再也不回到页面。
- **怎么交给插件**：插件每次起 claude 进程时读 `claudeCode.environmentVariables`。主进程给每个窗口算一份"设置叠加层"（`providerSettingsOverlay`）：用户自己写在这个设置里的变量，同名的换成接口的（名字不分大小写），再加 `claudeCode.disableLoginPrompt: true`；随初始化数据和 `settings.overlay` 交给这个窗口的插件进程，compat 的配置层读设置时把它盖在用户设置上面。settings.json 和设置界面里看不到叠加层，插件写设置也只写用户那一层（插件只写 `focusView` 等三个键，不写这个）。用 bearer 时清空 `ANTHROPIC_API_KEY`、用 API key 时清空 `ANTHROPIC_AUTH_TOKEN`，免得用户环境里残留的那个盖过我们的。
- **每个窗口一个接口**：标题栏「API 接口 ▾」（`features/providers`）切换，新对话立即用新接口；已经打开的对话还是原来的 claude 进程，提示里"重新加载窗口"会重启插件进程、恢复对话，新进程就用新接口了。每个文件夹记住自己上次用的接口（`state/shell.json`），第一次打开的文件夹用设置 `vilaus.provider.default`（默认订阅）。`--provider <id>` 给参数交到的那个窗口指定接口。接口有颜色时，标题栏底边一条 2px 色线、按钮前一个色块；订阅不加。
- **编辑页**是内容面板的标签页（"管理 API 接口"）：左边列表和"添加 API 接口…"（从预设选），右边表单，显式保存。"为此接口创建桌面快捷方式"写一个 `.lnk`：`Vilausity.exe --provider <id>`（开发时是 electron.exe 加 app 目录）。
- **测试**：界面测试在 127.0.0.1 起一个假的 Anthropic 接口，切到指向它的接口、重新加载窗口、新对话发一句话，检查假接口收到的 `Authorization: Bearer <key>` 和模型名；不花钱也不联网。

## 插件管理（M4）

- **找插件的顺序**（`host/main/extensionLocator.ts`）：`--extension-dir` → Vilausity 自己装的那份 → 本机 VSCodium / VS Code 装的。`LocatedExtension.kind` 记着来源（`cli` / `managed` / `external`）。
- **自己装的那份**（`host/main/extensionStore.ts`）：`extensions\anthropic.claude-code-<版本>\` 是安装包里的 `extension/` 目录；`extensions\state.json` 记 `current`（正在用的）、`previous`（上一个，用于回滚）、`pending`（已装好、下次启动换上）、`lastGood`（最后一个激活成功的）、`skipped`（回滚时退掉的，自动更新跳过它，直到出了更新的版本）。状态的变化都是 `platform/extensionUpdates.ts` 里的纯函数。**只在启动时切换**（`prepare()`，在任何插件进程加载之前）：`pending` 变成 `current`、原来的 `current` 变成 `previous`，然后删掉这三个以外的版本和崩溃留下的半成品。正在运行的版本从不在运行中替换（插件进程开着它的文件，claude.exe 也在跑）。
- **安装**：先解压到 `extensions\.staging-*`，检查完再改名成版本目录，所以半解压的包不会被当成装好了。解压用系统自带的 `C:\Windows\System32\tar.exe`（bsdtar，能解 zip；它默认拒绝 `..` 和绝对路径），不加依赖。检查：`package.json` 的发布者 `anthropic`、名字 `claude-code`、版本号、`main` 文件存在；`extension.vsixmanifest` 的 `TargetPlatform` 是本机平台（`win32-x64`）。
- **更新**（`host/main/extensionUpdater.ts`，不依赖 Electron，网络请求从外面传进来：程序里是 `net.fetch`，走系统代理；单元测试里是 Node 的 fetch）：`GET <Open VSX>/api/anthropic/claude-code/win32-x64[/<版本>]` → 比较版本（`shouldInstall`）→ 下载 `.vsix`（跟随 302）到 `extensions\.downloads\`，边下边算 sha256，跟 Open VSX 公布的 `.sha256` 对 → 交给 store 安装、设成 `pending`。一次只跑一个；进度、结果作为 `ExtensionStatus` 推给所有窗口（`extensionStatus` 事件）。手动导入的 `.vsix` 没有校验值可比，只做上面的包检查。签名（`.sigzip`）没验。
- **设置**：`vilaus.extension.autoUpdate`（默认开）、`vilaus.extension.version`（锁定版本：填了就装这个版本，可以往回装；空 = 跟最新）、`vilaus.extension.openVsxUrl`（Open VSX 或镜像）。自动检查在启动 15 秒后、之后每 12 小时、以及这三个设置改了时；`--extension-dir` 时不检查。自动装好后给最近用过的窗口发 `extensionUpdated`，弹"下次启动时使用"+「立即重启」。
- **回滚**：设置界面的「退回 X 并重启」（一键：退回后马上重启，窗口和对话会恢复）或命令面板：`pending = 目标版本`、`skipped = current`（自动更新跳过退掉的版本，直到出了更新的），然后重启。目标是自己装的上一个版本；没有的话（比如第一次更新是在升级前没有备份的版本上做的），用其他编辑器里比当前旧的那份，先复制进 `extensions\`（备份）再切过去。**第一次更新时自动备份**：当时用的如果是 VSCodium / VS Code 那份，新版本装好后先把它复制进 `extensions\`、记为 `previous`，这样 VSCodium 之后更新或删掉它也能退回（约 240 MB，复制几秒）。没有可退回的版本时按钮灰掉并说明原因。插件激活成功时记 `lastGood`；激活失败、而且这个版本是更新装上的、从没成功过、有可退回的版本时，错误框里多一个"回到 X 并重启"。
- **界面**（`features/extensionUpdates`）：设置编辑器"插件版本"一节，三个设置项上面是一个自定义块（`SettingsWidget`，`core/settings.ts` 的 `registerWidget`，设置编辑器把它画在所属分节的最前面，搜索按它的关键词过滤）：正在用的版本和来源、待切换的版本和「立即重启」、上一个版本和「退回」、「检查更新」「从 VSIX 安装...」和状态行（进度、结果、按错误码本地化的失败原因）。命令面板里也有这三个动作。
- **测试**：单元测试用 bsdtar 现做小 `.vsix`、本机起假的 Open VSX（含 302、校验值不符、按版本查询），把下载 → 校验 → 安装 → 下次启动切换 → 回滚 → 清理整个跑一遍，还有第一次更新时备份其他编辑器那份、没有备份时从其他编辑器那份退回。界面测试最后两步：在设置里点"检查更新"（VSCodium 那份被备份成上一个版本）、导入一个别人发布的 VSIX 被拒；重启后用的是新版本，点「退回 X 并重启」，再启动时跑的是备份出来的那份，真插件能激活。界面测试和 smoke 的设置里关了自动更新（不然每个测试实例都会去 Open VSX 下 120 MB），测试结束删掉装的插件。

## 首次启动（M4）

- **找不到插件时**（也没给 `--extension-dir`）窗口照常打开，但不起插件进程（`WindowContext.startExtHost` 直接返回）。`features/setup` 在主区域盖一层首次启动页：
  - 第 1 步「下载并安装」（走 `extension.check`，进度来自 `extensionStatus`）或「从 VSIX 安装...」；「换一个下载服务器」打开设置的"插件版本"一节。
  - 第 2 步「用 Claude 账号登录」：关掉这页、开一个对话，登录交给插件自己。「用 API 接口」：`providers.add` 从预设添加并打开编辑页；等它有了密钥（要密钥的类型才等）就 `providers.select` 切过去。「以后再说」在插件装好之后才出现，免得留下一个空窗口。
- **第一次装好不用重启**：这时没有在跑的插件，主进程的 `afterInstall` 立即 `prepare()`（pending 变成 current）、更新 updater 的 `running`，给每个窗口 `startMissingExtensionHost()`。之后的更新照旧是下次启动换上。没插件时不自动检查更新，等用户点。
- `--extension-dir` 指的目录里没有插件：报错退出（开发时的错，不提供安装）。
- **Git**：`host/main/gitLocator.ts` 在 Claude Code 找 Git 的地方找：`CLAUDE_CODE_GIT_BASH_PATH`、PATH、`Program Files\Git`、`%LOCALAPPDATA%\Programs\Git`。找不到时，第一个来问的窗口（`app.startupNotices`）弹一条提示：用途、「下载 Git for Windows」「不再提示」。只提示一次，记在 `state\shell.json`，不限于首次启动。
- **测试**：开关 `--ignore-other-editors` 不找 VSCodium / VS Code 的插件（只给测试用，不写进 `--help`）。界面测试起一个全新数据目录的实例，加这个开关、PATH 里去掉 Git：检查首次启动页和 Git 提示 → 从本机假 Open VSX 下载安装 → 插件不重启就激活 → 第 2 步选 API 接口、从预设加 DeepSeek → 存了密钥后窗口切过去。

## 管理员实例（M4）

- **怎么判断**（`host/main/elevation.ts`）：能列出 `System32\config\systemprofile` 就是管理员（只有 SYSTEM 和 Administrators 能读；没提升的令牌里 Administrators 只用于拒绝）。`VILAUS_ELEVATED=1` / `0` 强制指定：测试一律设 0，因为测试常从提升过权限的终端里启动。
- **哪些分开、哪些共用**（`AppPaths`）：管理员实例的 `instanceRoot` 是 `<数据目录>\admin`，state（窗口、最近的文件夹、插件的 globalState / workspaceState）、logs、Chromium 配置、插件的 globalStorage / workspaceStorage 都在它下面。Electron 的 userData 也指向它，所以单实例锁也是自己的：管理员实例可以跟普通实例同时开，第二次启动只转发给同一种实例。settings.json、providers.json、`extensions\` 共用。
- **API 密钥共用**（`host/main/safeStorageKey.ts`）：safeStorage 加密用的主密钥存在 Chromium 配置的 `Local State` 里（`os_crypt.encrypted_key`，本身由 DPAPI 按 Windows 用户加密）。启动时（拿到单实例锁之后、Chromium 读 `Local State` 之前）互相同步：管理员实例用普通实例的主密钥；普通实例自己没有时才用管理员实例的。这依赖 Chromium 的 `Local State` 格式；格式哪天变了，后果只是管理员实例解不开普通实例存的密钥，在管理员实例里重新输入就行。实测：主密钥第一次生成后约 10 秒内写盘，正常退出时一定会写。
- **插件目录共用**：store 每次修改都基于磁盘上最新的 `state.json`（`update()`），两个进程不会互相覆盖。清理旧版本时先改名再删：Windows 不允许给里面有打开文件的文件夹改名，所以另一个实例正在用的版本、正在写的下载不会被删掉一半。只有普通实例会自动检查更新；管理员实例里可以手动检查更新、回滚。
- **怎么标出来**：标题栏有"管理员"徽标（用 `activityErrorBadge` 的颜色）；原生窗口标题后面加 " [Administrator]"（在 `page-title-updated` 里改，页面自己的 `document.title` 不变）。
- **入口**：Windows 的"以管理员身份运行"；普通实例「文件夹 ▾」里的"以管理员身份打开此文件夹"（命令 `workspace.openAsAdministrator`）：主进程用 PowerShell 的 `Start-Process -Verb RunAs` 启动，Windows 弹 UAC 确认。参数按 CommandLineToArgvW 的规则加引号，开发时带上 app 目录，有 `--user-data-dir` 时也带上。
- **测试**：单元测试覆盖强制开关、路径、命令行引号、主密钥同步。界面测试在普通实例运行时再起一个强制管理员的实例，检查徽标、窗口标题、它的主进程用 safeStorage 能解开普通实例存的密钥、它自己的 state 和 Chromium 目录。UAC 那一步没有自动测试。

## 评论（M3）

在内容面板里选中文字写评论，评论显示在对话输入框正上方，随下一条消息发给 Claude（照插件计划评论的做法）。

- **选中按钮**是一个通用的菜单贡献点 `editor/selection`（`MenuId.EditorSelection`）：编辑器里有选区时，这个菜单的按钮浮在选区旁边；命令收到 `EditorSelectionContext`（选中的文字、文档 URI、文件路径、范围，以及 `showWidget`，用来在按钮的位置显示自己的界面）。文本和 diff 编辑器用 Monaco 的 content widget（`features/editor/selectionMenu.ts`）；Markdown 预览自己摆放（渲染时在每个顶层块前插一个隐藏的源码行号标记，选区按最近的标记换算回源码行，`features/markdown/sourceLines.ts`）。评论模块（`features/comments`）往这个菜单里登记"评论"，以后别的功能也可以加按钮。快捷键 Ctrl+Alt+M 作用于当前标签页的选区（`EditorPane.selectionContext`）。
- **数据在插件进程**：`host/exthost/comments.ts` 的 ConversationComments 按会话（session）存评论，对外按聊天面板的 webview 提供：面板现在显示哪个会话，就读写哪个会话的评论（会话 id 取自插件页面存的 webview 状态，解析写在 bridge 里）。渲染进程用 `comments.add / update / remove` 修改，收 `comments.didChange` 显示。bridge 在用户发消息（`io_message`）时同步取出评论，作为一个单独的 text 块附在用户打的字后面（斜杠命令不带），然后清空。
- **跟着会话走**：关掉对话标签页，没发的评论留在会话名下，之后从会话列表、Ctrl+Shift+T 或者重启恢复打开这个会话，评论还在；面板换到别的会话，就显示那个会话的评论。会话的评论存在工作区存储（`vilaus.comments`），随时写入。新对话一打开就有会话 id，但发出第一条消息之前会话还没有记录（插件页面在状态里标成 `sessionWithNoTranscript`），这种会话不会被恢复（重启后换一个新 id 重开），所以不算数：这期间的评论先挂在面板上（跟面板的恢复记录一起存，重启后回来），会话有了记录再并进去；一条消息都没发就关掉的对话，评论随面板丢弃。
- **评论块在插件页面里**：块该放在哪个元素前面是插件页面的知识，只写在 bridge 里，以 `WebviewPageHints.commentsAnchor`（输入框所在 form 的选择器）随页面文档交给引导脚本（`host/webview/comments.ts`）。引导脚本把块插在锚点前，用 MutationObserver 在插件重新渲染后放回原位；块里的事件不会冒泡到插件页面；所有文字由壳算好（包括翻译）再发进去，引导脚本里没有界面文案。编辑在壳里进行（小窗盖在块的位置上）。插件页面会量输入区的高度给消息列表垫底，所以块不会挡住最后一条消息。
- **后备**：页面一直找不到锚点（插件改了界面，或者输入框还没出来）时，壳在对话下方显示内容相同的评论栏（`features/comments/fallbackBar.ts`），功能不受影响。
- **发出去的格式**：以 `Comments on selected text:` 开头，每条评论一段：`[Re: "<片段>" — <文件>:<行>] <评论>`。片段压成一行、过长截断；文件是相对工作区的路径；行是 `12` 或 `12-15`。
- 点评论块上的 `文件名:行号` 回到原文：打开着的标签页（文本、diff、Markdown 预览）用 `EditorPane.revealSelection` 选中那段文字，没打开就经插件进程打开文件再选中。

## 插件界面汉化（M3.5）

界面语言是中文时，插件自己的页面（对话、会话列表、计划预览）和插件弹在壳里的通知、选择框、输入框显示中文。插件文件不改，对话内容不动。

- **对照表** `src/nls/zh-cn.extension.json` 不带英文原文。普通文字的键是"长度:哈希"（空白规范化后算 FNV-1a 32 位哈希，36 进制）。只有一个变量的模板（"3 days ago"）单独一节，键是"前缀长度:后缀长度:哈希"，另记变量类型（`number` 只配数字，`any` 配任意短文字），防止配错。译文是空串表示保持英文。算键和查表都在 `platform/extensionStrings.ts`，提取工具和运行时共用，两边算出的键一定一致。
- **原文清单只在本地**：`node tools/extension-strings/extract.mjs` 扫插件的 `webview/index.js` 和 `extension.js`，输出 `.local/extension-strings/<版本>.json`（英文、键、出现的位置、片段所在的整句）。认界面文字的办法（`scan.mjs` 是一个认压缩代码里字面量和上下文的小扫描器）：显示用的属性（children、title、placeholder、label……）的值、JSX children 数组里的句子片段、webview 里别处像句子的字面量、通知和选择框 API 的参数、计划预览 HTML 里的文字；减掉 Monaco 的文字（插件包里打包了一份 Monaco）；`aria-label` 和超过 100 个字符的不收。
- **补译**：`npm run nls` 在本地清单存在时顺带检查对照表（缺译只报数量，过时条目算失败）。`npm run nls -- --todo-extension` 导出待译条目（带上下文），译好后用 `node tools/extension-strings/merge.mjs <译文.json>` 合进表：只写键和译文，跟英文相同的存成空串，清单里已经没有的删掉。术语见 `docs/design.md` 的"文案"。
- **页面里怎么换**：main 渲染插件页面时，界面语言是中文、`vilaus.translateExtensionUi` 开着，就把表放进引导数据。引导脚本（`host/webview/translate.ts`）先过一遍已有的文本节点和 `title` / `placeholder` / `data-placeholder` 属性，再用 MutationObserver 跟着插件的 React 重绘替换。替换时保留原文首尾的空白，并记下原文，关掉设置时原样换回。`aria-label` 不翻：屏幕上看不到，壳（评论锚点、排除区）和测试还靠它定位。
- **哪里不翻**：页面上哪些区域是"内容"属于插件页面的知识，由 bridge 的 `WebviewPageHints.untranslated` 按页面给出（对照 2.1.282）：对话的消息列表、Markdown、用户消息、提问卡片的标题 / 问题 / 选项、权限卡片里的工具说明和参数、会话 / 分组 / worktree 名、对话标题；计划预览里是计划正文和评论引用的原文。引导脚本另外总是跳过可编辑区域（输入框、textarea；输入框自己的提示文字照翻）、代码（pre、code）和壳自己注入的元素。bridge 没给提示的页面（新版插件新出的页面）整页不翻。剩下的风险：排除区以外的内容恰好跟某条界面文字一字不差，会被翻成中文。
- **句子片段和模板**：插件把一句话拆成几个文本节点（"Allow reading from" + 路径 + "?"），只能一段段换；中文语序对得上的才翻（"允许读取" + 路径 + "?"），带复数词尾之类对不上的保持英文。模板的变量本身是表里的文字时也一起换（"`<模式说明>`. Click to change…"）。紧凑的时长（"5m"、"2h 30m"）格式不一，统一保持英文。
- **壳里的提示**：插件经 `window.showInformationMessage` / `showQuickPick` / `showInputBox` 弹出的文字，在插件进程里（`host/exthost/compatHost.ts`）查表后再发给渲染进程。返回给插件的仍是它自己的条目，插件按英文比较选项不受影响。表经 `ExtHostInitData.extensionTranslations` 交给插件进程，是否翻译按当时的设置。
- **设置** `vilaus.translateExtensionUi`：默认开，只在中文界面起作用，改了立即生效：main 通知渲染进程，渲染进程给每个 webview 发控制消息（开 = 发表，关 = 换回原文）。

## 加功能该改哪里

- 插件调用了我们没实现的 VS Code API：在 `src/compat/vscode/` 对应的命名空间文件里实现。没实现的 API 会先返回一个会记日志的空桩，不会崩。插件执行的 VS Code 内置命令（`workbench.action.*` 这类）在 `src/host/exthost/workbenchCommands.ts`。
- 新的跨进程消息：先在 `protocol.ts` 加类型，再在两端 `handle` / `call`。
- 插件 webview 里某个请求要换成 Vilausity 自己的做法：`bridge.ts` 加一条拦截规则，并写清楚对照的插件版本。
- 壳的界面功能（M1 起）：在 `src/features/<名字>/` 建模块，只通过 `core` 的贡献点接入（命令、快捷键、菜单、视图、编辑器类型、设置项）。以后的插件系统也会用同一套机制。
- 内容面板里新的一种标签页：注册一个 `EditorProvider`（`core/editors.ts`），再用 `IContentPane.open(输入)` 打开。要跟插件共用的文档（插件能看到、能改的）一律经 exthost 打开（`documents.show`），别在 renderer 里自己读文件。
- 选中文字旁边的按钮：往 `editor/selection` 菜单（`MenuId.EditorSelection`）登记一个命令，命令收到 `EditorSelectionContext`，可以用 `showWidget` 在原地显示自己的界面（评论的小窗就是这样）。
- 快捷键注意：主进程会先截住所有注册过的组合键，页面（包括 Monaco）收不到。Monaco 自己要用的键（比如 Ctrl+F）如果被别的模块注册了，要在编辑器模块里用 `when: 'editorTextFocus'` 再注册一条转回给 Monaco。
- 界面上的文字：在模块目录的 `messages.ts` 里用 `defineMessages('<命名空间>', {...})` 写英文，代码里用 `t('键')` 取；中文进 `src/nls/zh-cn.json`，没翻译的先显示英文，`npm run nls` 检查（规范见 `docs/design.md` 的"文案"）。界面语言在每个进程启动时定好（main 算出来，传给 renderer 和 extension host），换语言要重启。

## 数据

| 路径（`%APPDATA%\Vilausity\` 下） | 内容 | 谁写 |
| --- | --- | --- |
| `settings.json` | 用户设置（JSONC，键名沿用 VS Code / 插件的） | main |
| `state\global.json`、`state\workspaces\<hash>.json` | 插件的 globalState / workspaceState | main |
| `state\shell.json` | 窗口位置、最近打开的文件夹、要恢复的窗口、缩放级别 | main |
| `globalStorage\`、`workspaceStorage\` | 插件自己的存储目录 | 插件 |
| `logs\<启动时间>\` | 本次启动的日志，保留最近 10 次：`main.log`，每个窗口一个 `window<N>\`（exthost.log、shim-unimplemented.log、output\） | main / extension host |
| `providers.json` | API 接口（密钥用 safeStorage 加密） | main |
| `extensions\` | 自己装的 Claude Code 插件（每个版本一个目录）和 `state.json`（当前、上一个、待切换的版本） | main |
| `chromium\` | Chromium 自己的缓存等 | Electron |
| `admin\` | 管理员实例自己的 state、logs、chromium、插件存储（结构同上） | 管理员实例 |

Claude 的会话记录和登录凭据在 `~\.claude\`，由 Claude CLI 管理，跟 VSCodium 里的插件共用。
