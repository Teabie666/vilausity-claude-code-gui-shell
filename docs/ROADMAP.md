# ROADMAP

完整计划在 [PLAN.md](PLAN.md)。这里只把各阶段（M0–M6，外加插进去的 M1.5、M2.5、M5.5 和可选的 M3.5）拆成勾选清单、记进度；两边对不上时以 PLAN.md 为准。

`[x]` 已完成，`[ ]` 未完成。最后一次对照代码核对：2026-10-11。

## 下一步

1. M5 名字、图标、视觉打磨（打磨到满意再往下走；过程中冒出来的新功能和大改动只在 M5.5 记下来）
2. M5.5：M5 做完后集中做、集中试用（第一块已经提前写好，等那时一起试）
3. 最后：M6 打包和发布

2026-10-10 把视觉打磨和打包对调了：功能做完不直接发布，先把界面打磨好。

每个阶段结束都要做：typecheck、`npm test`、`node tests/ui.mjs`（动了 bridge / compat 再跑 `npm run smoke`）；看最新一次的 `shim-unimplemented.log`；确认没往 `C:\Program Files\VSCodium` 写任何东西、git 里没有密钥；用屏幕工具截图，跟 VSCodium 里的同一界面对比；用 `run-dev.cmd` 试用。

测试现状（2026-10-11）：单元 304/304，语言包 0 条缺译（插件界面对照表 1454 条），界面 48/48，smoke 13/13（M4 第①块后跑的；之后没动 bridge / compat）。

## M0 技术验证：完成（2026-10-08）

- [x] git 仓库和骨架：platform、protocol、最小 compat，以及 main、exthost、renderer
- [x] 插件从 VSCodium 目录加载（`extensionLocator.ts`），在 utilityProcess 里激活（约 20 ms），开出对话 iframe
- [x] 能收发消息
- [x] 内嵌审批的接受和拒绝都生效（`open_diff` 先挂起，见 [ADR 0002](adr/0002-hold-open-diff-until-diff-editor.md)）
- [x] `insert_at_mention` 能往输入框插纯文本；输入框能用 `[role="textbox"][aria-label="Message input"]` 定位（M3 的评论块要用）
- [x] `io_message` 的结构确认清楚（smoke 会把结构写进 exthost.log）
- [x] 登录状态跟 CLI 共用（凭据在 `~/.claude/`）
- [x] 语音输入模块 `audio-capture.node` 在 Electron 44 下能加载（没实际录音测过）

## M1 核心壳：完成（2026-10-09）

- [x] core：服务注册表、模块（`ShellModule`，带版本号的 `ShellContext`，注册都可撤销）、命令、上下文键和 when 子句、快捷键、菜单（`core/menus.ts`）、布局
- [x] 标题栏：程序名、文件夹名、对话标签页，Windows 原生窗口按钮（「文件夹 ▾」「API 接口 ▾」两个下拉放在 M4）
- [x] 会话侧边栏：插件自带的会话列表 webview，Ctrl+B 开关，宽度可拖
- [x] 多对话：标签页，Ctrl+N / Ctrl+W / Ctrl+Tab / Ctrl+1–9，Ctrl+Shift+T 重开关掉的对话
- [x] 主题：从 VSCodium 抓了 6 套内置主题（`npm run capture-themes`），壳和 webview 共用；`vilaus.theme` 和字体设置改了实时生效；命令面板里能切
- [x] 链接：webview 里的链接用外部浏览器打开
- [x] 通知：窗口没焦点时，插件的消息发系统通知并闪任务栏
- [x] 快捷键：在 main 里拦截，焦点在 webview 里也生效；命令面板 Ctrl+Shift+P / F1
- [x] 缩放：Ctrl+= / Ctrl+- / Ctrl+0，会记住
- [x] 对话内查找 Ctrl+F（在 webview 里用 CSS Custom Highlight API）
- [x] 窗口位置记忆
- [x] 重启后恢复对话（`panelRestore.ts`，借插件自己的 WebviewPanelSerializer）
- [x] 日志：`logs\<启动时间>\` 下的 main.log、exthost.log、shim-unimplemented.log、output\
- [x] 插件进程崩溃时提示，可以一键重启
- [x] 右键菜单的基础项：撤销、重做、剪切、复制、粘贴、全选；链接的"在浏览器打开 / 复制地址"
- [x] 右键菜单加插件的 `webview/context` 命令（2026-10-09）：在对话里右键有 Mark Session as Unread / Rename Session Tab / Add Session Tab to Group，会话列表里没有，跟 VS Code 一样
  - exthost 从插件清单读出菜单（`host/exthost/contributions.ts`）→ `features/extensionMenus` 登记进 core 的菜单注册表，按 when 子句和 VS Code 的排序算出每个 webview 的菜单项，登记给主进程 → 主进程右键时按 iframe 地址追加到菜单末尾，点击后回到渲染进程执行插件命令
  - 顺带补上 `showInputBox` 的 `validateInput`：重命名时空名字会被拦下，带着插件的提示再问一次
- [x] 试用 M1（2026-10-09）。试用后的改动：右键菜单项去掉 "Claude Code: " 前缀；界面要有中文 → 新增 M1.5

`claude-vscode.showLogs` 暂时只把日志路径写进 exthost.log，等 M2 的内容面板。

## M1.5 界面语言：完成（2026-10-09）

- [x] 机制：`platform/nls.ts`（`defineMessages`、`defineNames`、`{0}` 占位符、缺译回落英文），三个进程启动时定好语言；代码里只有英文，中文在语言包 `src/nls/zh-cn.json`，`npm run nls` 检查缺译和过时条目
- [x] 设置 `vilaus.language`（`auto` / `zh-cn` / `en`，默认跟随系统）；命令面板"配置显示语言"；改了以后弹提示，点"重启"后生效，打开的对话会恢复
- [x] 壳的全部现有文字两份：标题栏、标签页、空状态、查找、命令面板（含分类）、快速输入和对话框、通知、崩溃提示、右键菜单（编辑项用 Electron 的 role，但换上自己的文字）
- [x] 插件的右键菜单项：中文按命令 id 自带译名（`features/extensionMenus/commandTitles.ts`）；英文去掉 "Claude Code: " 前缀
- [x] `vscode.env.language` 和页面的 `lang` 属性跟着界面语言（中文靠 `lang` 用系统的中文字体）
- [x] 内置主题名的中文（深色 Modern、浅色+……）
- [x] 测试：nls 的单元测试；界面测试固定英文跑，最后在命令面板里切到中文、重启，检查命令面板和右键菜单
- [x] 试用（2026-10-09）。试用后的改动：代码里只写英文，中文移进单独的语言包 `src/nls/zh-cn.json`，译文可以晚点批量补；`npm run nls` 检查缺的和过时的条目

## M2 内容面板 + Monaco：完成（2026-10-09）

依赖：`monaco-editor` 0.57、`shiki` 4.5（没用 `@shikijs/monaco`：它的类型依赖没装的 `monaco-editor-core`，用到的那点逻辑自己写在 `features/editor/highlighting.ts`）、`marked` + `dompurify`。构建改动见 [ADR 0003](adr/0003-esbuild-for-all-bundles.md) 的 M2 补充；文档和编辑器的设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

- [x] 内容面板：有东西时自动打开，`Ctrl+\` 和标题栏右侧按钮开关，宽度可拖，标签页（预览标签页、脏标记、中键关闭、焦点在面板里时 Ctrl+W / Ctrl+Tab 作用于面板）
- [x] core 的 editors 贡献点（`core/editors.ts`），以及按区域分发插件 webview 面板（`core/panels.ts`）
- [x] Monaco 标签页：Shiki 高亮（语法色 Dark+ / Light+，编辑器色取主题变量，切主题跟着变），有行号；Monaco 自己的界面文字按界面语言加载它的中文包
- [x] 新加的界面文字都写中英两份（M2 的 34 条译文已补）
- [x] 打开文件：聊天里点文件（`open_file` → `showTextDocument`）、Ctrl+P / Ctrl+E 快速打开（模糊匹配）、拖进窗口（拖文件还没自动测）
- [x] Ctrl+S 保存，未保存标记，关闭时问是否保存；磁盘上被 Claude 改了：没改过就自动重新载入，改过就在编辑器上方提示
- [x] compat 的文本文档跟 Monaco 模型对上：open / change（真实增量）/ will-save / save / close 事件
- [x] Markdown：默认显示渲染后的预览（代码块用 Shiki 上色），可以切到源码（Ctrl+Shift+V）
- [x] 计划预览：插件的 `claudePlanPreview` webview 作为内容面板的标签页（smoke 验证过）
- [x] diff 标签页（ADR 0002 已被取代）
  - [x] `vscode.diff` 打开 Monaco DiffEditor 标签页，同时往 `tabGroups` 里加 `TabInputTextDiff(left, right)`，插件 `tabGroups.close` 时关掉标签页
  - [x] 右侧可编辑，改动触发 `workspace.onDidChangeTextDocument`
  - [x] "接受 / 拒绝"按钮：先把该标签设为 active，再执行 `claude-vscode.acceptProposedDiff` / `rejectProposedDiff`
  - [x] bridge 不再挂起 `open_diff`（`diffEditorAvailable: () => true`）
  - [x] 用真实会话验证（smoke）：提议改动 → diff 标签页 → 接受 / 拒绝；聊天里的内嵌审批照常能用
  - [x] 额外："Compare Active File with Saved"（跟磁盘上的版本比较），界面测试靠它覆盖 diff 标签页
- [x] 选区同步：`activeTextEditor`、`visibleTextEditors`、`showTextDocument`、`onDidChangeTextEditorSelection` 接到 Monaco，聊天框能带上当前文件
- [x] 标签页可以弹出成独立窗口（内容面板右上角的按钮或命令"Move Editor into New Window"；关窗口即关标签页，标题栏按钮移回）
- [x] 日志进面板：`claude-vscode.showLogs` 和聊天里的"打开输出"都调 `outputChannel.show()`，在内容面板打开日志文件（不需要 bridge 拦截）
- [x] smoke 改成 API 模式：`VILAUS_SMOKE_API_KEY` 或 `VILAUS_SMOKE_AUTH_TOKEN`，可选 `VILAUS_SMOKE_BASE_URL`、`VILAUS_SMOKE_MODEL`，注入测试设置里的 `claudeCode.environmentVariables`；没配就拒绝运行（`--subscription` 才用登录的账号）
- [x] smoke 加了 diff 标签页的接受 / 拒绝两项
- [x] smoke 再加：点聊天里的文件提及，Monaco 标签页打开该文件；计划模式下计划预览进内容面板
- [x] 收尾时补的：语言配置（Ctrl+/ 注释、括号、缩进，取自 Monaco 自带的语言定义）；插件进程崩溃重启后，打开的文件连同未保存的修改自动回来；Markdown 预览显示工作区里的图片（`ccw://img`，只放行工作区内的图片文件）和 https 图片；只打包 Dark+ / Light+ 两套 Shiki 主题
- [x] 试用（2026-10-09，包括弹出窗口、语言配置、Markdown 图片、拖文件进窗口）

## M2.5 设置编辑器：完成（2026-10-09）

M2 试用后加的。原来 PLAN 砍掉了设置图形界面，改为图形界面和 settings.json 编辑两者都有，跟 VS Code 一样；M4 里设置的 schema 和热更新挪到这里。

- [x] 设置的 schema 贡献点（`core/settings.ts`）：各模块注册自己的设置（键、JSON schema、所在分类）；插件的 `contributes.configuration` 也登记进来（VS Code 专用的 5 项不列出）
- [x] 渲染进程能读写设置：主进程是唯一写入方，改了推送给渲染进程；启动时没有 settings.json 就建一个空的
- [x] 设置图形界面：内容面板的标签页（Ctrl+, / 标题栏齿轮）；搜索、分类目录（窄时收起）；开关 / 下拉 / 文本和数字输入（带校验）；改过的项有标记、能还原；复杂的值链接到 settings.json（缺的键先补上默认值再定位过去）
- [x] 在 Monaco 里编辑 settings.json：Monaco 的 JSON 语言服务（单独的 worker），按已知设置生成 schema：补全、悬停说明、校验；保存后立即生效
- [x] 编辑器设置：字体、字号、字重、行高、连字、Tab 宽度 / 插入空格 / 检测缩进、自动换行（含换行列）、行号、缩略图、空白字符、括号配对着色、光标闪烁、平滑滚动、末行之后滚动；diff 并排 / 窄时内联 / 忽略首尾空白 / 换行；对普通编辑器和 diff 都实时生效。工作台一节：主题、界面字体和字号、界面语言
- [x] 测试（界面 +2 项、单元 +9 项）、中文译文（49 条）、文档
- [x] 试用（2026-10-09）。试用后加的：
  - [x] diff 自己的字体和字号（`diffEditor.fontFamily` / `diffEditor.fontSize`，为空 / 0 时跟编辑器一样）
  - [x] settings.json 比图形界面全：Monaco 的全部编辑器选项和其余 diff 选项都声明成隐藏设置（编辑器选项的说明用 Monaco 自带的，跟界面语言走），在 settings.json 里有补全、悬停说明和校验，改了实时生效；图形界面只列常用的。没声明的键忽略，跟 VS Code 一样
  - [x] 默认设置（JSON）：只读视图，列出所有设置的说明和默认值（设置界面右上角的按钮、命令"打开默认设置（JSON）"），可以弹出成独立窗口；settings.json 只存改过的项，以后默认值变了照样生效
  - [x] Ctrl+F 在有焦点的编辑器里查找，只读视图也算
  - [x] 修：设置写入失败一次后，之后的写入都跟着失败（写入队列卡死）；Windows 上目标文件被别的进程占着时替换会 EPERM，现在会短暂重试
  - [x] 测试（界面 +2 项、单元 +9 项）、中文译文（+22 条）
- [x] 试用上面这些（2026-10-09）

## M3 评论：完成（2026-10-10）

复刻插件"计划评论"的体验，做成 `features/comments`。设计见 [ARCHITECTURE.md](ARCHITECTURE.md) 的"评论（M3）"。

- [x] 添加：在 Monaco、Markdown 预览、diff（两侧都行）里选中文字 → 旁边浮出"评论"按钮 → 评论小窗（引用片段、`文件名:行号`、输入框、"添加评论 / 取消"；Enter 添加，Ctrl+Enter 也行，Shift+Enter 换行，Escape 取消；输入法选词时的 Enter 不算）
  - 按钮来自新的菜单贡献点 `editor/selection`，以后别的功能也能往选区旁加按钮；快捷键 Ctrl+Alt+M 对当前标签页的选区添加评论
  - Markdown 预览里的选区换算回源码行（渲染时每个顶层块前插行号标记）
- [x] 显示：按对话归属，在输入框正上方一条一块，新的往上叠；每块有引用片段（截断）、`文件名:行号`（点击跳回原文，Markdown 预览里也能选中原文）、评论内容、编辑（壳里的小窗盖在块上）和删除按钮；超过 3 条折叠成"N 条评论"，可展开；"清除所有评论"按钮和命令
- [x] 评论块是注入到 iframe 里的独立 DOM，用同一套主题变量，直角；锚点选择器只写在 bridge 里，经页面提示（`WebviewPageHints`）交给引导脚本；插件重新渲染后自动放回原位；块里的事件不传给插件页面；定位失败（或输入框一直没出来）就退回到壳层渲染的评论栏
- [x] 发送：bridge 拦截 `io_message`，把评论按 `[Re: "<片段>" — <文件>:<行>] <评论>` 一条一段、加说明头 `Comments on selected text:`，作为单独的 text 块附在用户文字后面；不改用户的输入；斜杠命令不带评论；发送后清空评论块
- [x] 持久化：评论跟对话面板的恢复记录一起存在 workspaceState，重启不丢（试用后改成按会话存，见下）。插件自己计划预览里的评论走插件原生流程，不重复处理
- [x] 单元测试（+57）：评论格式、CommentStore、bridge 附加评论和页面提示、视图模型、Markdown 行号换算；界面测试（+5）：编辑器和 Markdown 预览加评论、块里编辑 / 跳回 / 删除、Ctrl+Alt+M 和折叠、重启恢复、后备评论栏；smoke（+1）：两条评论 → 输入框上方两个块 → 发送后会话记录里的用户消息有两段 `[Re: …]` → 评论块清空
- [x] 试用（2026-10-10）。试用后的改动：
  - [x] 没发的评论按会话 id 存（工作区存储 `vilaus.comments`），关掉对话标签页不再丢，之后从会话列表、Ctrl+Shift+T 或重启恢复打开这个会话时回来；面板换到别的会话就显示那个会话的评论。还没发过消息的新对话没有可恢复的会话，评论先挂在面板上，会话有了记录再并进去
  - [x] 测试：单元 +12（会话归属、迁移、存取，会话 id 的解析），smoke +1（关掉对话 → Ctrl+Shift+T → 评论还在）

## M3.5 插件界面汉化（可选）：完成（2026-10-10）

方案见 PLAN 的"插件界面汉化"，研究后定下的几处（2026-10-10）也记在那里；设计见 [ARCHITECTURE.md](ARCHITECTURE.md) 的"插件界面汉化（M3.5）"。

- [x] 提取脚本 `tools/extension-strings/`：`extract.mjs` 从插件的 webview 代码和 extension.js 里整理界面文字（按插件版本），只挑大致一行以内的界面骨架（`scan.mjs` 认压缩代码里的字面量和上下文，减掉 Monaco 的文字）；输出到本地 `.local/extension-strings/`，原文清单和中间产物不提交。2.1.282：1362 条文字（166 条是句子片段）、92 条单变量模板
- [x] 对照表 `src/nls/zh-cn.extension.json`：键是原文的哈希（空白规范化，带长度），值是译文，空串表示保持英文；单变量模板单独一节（前后缀的长度和哈希、变量类型）；`npm run nls` 在本地清单存在时检查缺译和过时的条目，`--todo-extension` 导出待译条目，`merge.mjs` 合并译文
- [x] 引导脚本里的对照表翻译（`host/webview/translate.ts`）：运行时给页面文字算哈希查表，只换完全相等的文本节点和 `title` / `placeholder` / `data-placeholder`（`aria-label` 不翻）；拆成几段的句子按段翻；单变量模板（变量本身是界面文字时一起翻）；MutationObserver 跟着重绘；插件文件不改
- [x] 排除对话内容区域（回复、代码块、用户输入、diff），以及对话区以外的内容（提问卡片的问题和选项、权限卡片里的工具说明和参数、会话 / 分组名、对话标题）；长段说明文字不翻；bridge 不认识的页面整页不翻
- [x] 插件弹在壳里的通知、输入框、选择框用同一张表翻（插件进程里翻，返回给插件的仍是它自己的条目）
- [x] 设置 `vilaus.translateExtensionUi`（默认开，只在中文界面起作用，改了立即生效），关掉就是原样
- [x] 翻译：1454 条（2.1.282），术语按 design.md 的文案规范；句子片段和模板逐条按所在的整句核对，统一了术语和标点；Monaco 的按键名、符号种类等内部名存成保持英文
- [x] 测试：单元 +15（键、查表、模板类型和嵌套、对照表格式、页面提示）；界面测试 +1（中文下输入框提示、会话列表是中文，排除区里的文字不变，`aria-label` 不变，关掉设置立即回到英文，插件经壳弹出的提示是中文）；smoke 固定英文，13/13；另用 Anthropic 兼容接口跑过一次中文的真实会话（权限卡片、计划预览、计划确认卡片都是中文，消息列表和模型写的内容原样）
- [x] 试用（2026-10-10）。试用后提的：翻成中文的插件界面文字跟对话内容是同一套字体，看着分不开，留到 M5 的视觉打磨

## M4 配置 / CLI / API 接口 / 插件管理：完成（2026-10-11，④⑤待试用）

2026-10-10 定的做法（PLAN 的"配置和 CLI"一节也记了）：分五块按顺序做，每块做完提交。

- 多窗口：一个进程管多个窗口，主进程分成全局的一份和每个窗口一份；同一个文件夹只开一个窗口。在当前窗口打开文件夹 = 替换这个窗口的工作区（照 VS Code），"在新窗口中打开"另有一项；不带文件夹启动时恢复上次的窗口。
- 不做从 VS Code / VSCodium 导入设置；去掉 `--settings`（要单独一份设置就用 `--user-data-dir`）。
- 设置的 schema 贡献点、设置界面、在 Monaco 里编辑 settings.json：挪到了 M2.5。

### ① 多窗口、单实例、CLI、文件夹

- [x] 重构（行为不变）：主进程拆成全局（设置、主题、语言、globalState、webview 文档、ccw 协议）和每个窗口一份（窗口、插件进程、工作区和 workspaceState）；渲染进程的 IPC 按发送的窗口分发，设置 / 主题 / 语言变了通知所有窗口；插件的 globalState 在各窗口的插件进程之间同步；日志按窗口分子目录
- [x] 多窗口：新建窗口、关闭窗口、退出；窗口位置按文件夹记；最近打开的文件夹；退出时记下开着的窗口，不带文件夹启动时恢复（一个个关掉的只恢复最后关的那个，"退出"和重启恢复全部）
- [x] 已有的参数：`[folder]` / `--folder`、`--extension-dir`、`--user-data-dir`、`--theme`、`--log-level`、`--devtools`、`--secondary-display`（窗口开在非主显示器上，测试用）
- [x] 补齐：`--new-window`、`--session`、`--prompt`、`--goto <file:line[:col]>`、`--version`、`--help`（`--provider` 在 ②）
- [x] 单实例：第二次启动时，参数转发给已经在运行的实例（数据目录相同才算同一个实例，所以测试实例互不干扰）
- [x] `vilaus://` 链接接到插件的 `window.registerUriHandler`，外部来的链接先问一次；往注册表登记协议放到 M6 的安装包
- [x] 标题栏「文件夹 ▾」：最近的文件夹、打开文件夹…、在新窗口中打开…、在资源管理器中显示
- [x] 插件调的内置命令：`vscode.openFolder`（插件的"打开文件夹"走它，不用在 bridge 拦截）、`workbench.action.openSettings`（打开设置编辑器并预填搜索词）、`revealFileInOS`
- [x] 测试和文档：CLI 解析、窗口记录和恢复顺序的单元测试；界面测试：第二个窗口、换文件夹后对话恢复、关窗口、第二次启动转发文件夹 / `--goto` / `--prompt` / `vilaus://` 链接、不带文件夹启动时恢复窗口；ARCHITECTURE 的"窗口和工作区"、[ADR 0004](adr/0004-one-process-many-windows.md)

### ② API 接口（`features/providers`）：完成（2026-10-10，待试用）

2026-10-10 定（PLAN 的"API 接口模式"一节也记了）：预设是国内四家加国际站，外加"自定义兼容接口"；强调色 = 标题栏底边 2px 色线 + 按钮前色块，订阅不加；不做从 VSCodium 导入；新文件夹用设置里的默认接口，之后每个文件夹记住自己的。

- [x] 接口配置：`type`（subscription / anthropic-api / compatible / bedrock / vertex / foundry）、`baseUrl`、鉴权方式（apiKey → `ANTHROPIC_API_KEY`，bearer → `ANTHROPIC_AUTH_TOKEN`）、模型映射（主模型，Opus / Sonnet / Haiku / Fable 各档，子代理，模型选择器里显示的 `_NAME` / `_DESCRIPTION`，额外的自定义模型选项）、自定义请求头、超时、最大输出、关闭非必要流量、任意额外环境变量
- [x] 切换接口 = 改写传给插件的 `claudeCode.environmentVariables`（加上 `disableLoginPrompt` 和 `CLAUDE_CODE_SKIP_AUTH_LOGIN`）；新开的对话生效，已经打开的对话提示重开
- [x] 标题栏「API 接口 ▾」切换；CLI `--provider <id>`；窗口用不同的强调色区分接口
- [x] 内置预设（数据文件）：Claude 订阅、Anthropic API、DeepSeek、Kimi、GLM、Qwen…，用户可以增删
- [x] 密钥用 Electron `safeStorage`（Windows DPAPI）加密存放，绝不明文写进 settings.json，绝不进安装包
- ~~从 VSCodium 的 DeepSeek 配置档导入成一个"DeepSeek"接口~~：不做（2026-10-10）
- [x] "为此接口创建快捷方式"（比如 `Vilausity.exe --provider deepseek`；会往桌面写文件，没有自动测试，留到试用时手点）
- [x] 单元测试：接口生成的环境变量、叠加层、读写校验；界面测试（不是 smoke）：本机起一个假接口，切到指向它的接口发一句话，检查它收到的 key 和模型名；编辑页从预设添加、改名、存密钥（文件里没有明文）、删除

### ③ 插件管理（脱离 VSCodium）：完成（2026-10-10，待试用）

2026-10-10 定（PLAN 的"插件管理"一节也记了）：自动更新是设置里的开关，默认开；新版本下次启动才换上，保留上一个版本用于回滚；开关、回滚、手动检查更新、导入 VSIX 都在设置界面里。设计见 [ARCHITECTURE.md](ARCHITECTURE.md) 的"插件管理（M4）"。

- [x] 开发时用 `--extension-dir` 指定插件目录（不指定就从 VSCodium 的安装目录找）
- [x] 查询 Open VSX → 下载 VSIX → 用 `.sha256` 校验 → 解压 `extension/` 到 `extensions\anthropic.claude-code-<ver>\` → 下次启动时切换过去；保留上一个版本用于回滚（回滚退掉的版本自动更新会跳过）
- [x] 设置项：自动更新开关（默认开）、锁定版本、Open VSX 地址（可填镜像）；记录"最后一个能正常运行的版本"，更新装上的新版本激活失败就提示回滚
- [ ] 没实现的 API 突然变多时提示回滚：没做（要先定怎么算"突然变多"）
- [x] 下载不了时的备用办法：手动选 `.vsix` 文件导入（检查包结构和 `package.json` 的发布者、名字、平台）；本机 VS Code / VSCodium 里装好的插件在找插件时自动用上（自己装的那份没有时）
- [x] 设置界面"插件版本"一节：正在用的版本和来源、检查更新、从 VSIX 安装、一键「退回 X 并重启」（试用后加的：第一次更新时把 VSCodium 那份备份成上一个版本；没有备份时用 VSCodium 里更旧的那份，先备份再退回；没得退时按钮灰掉并说明）；命令面板里也有
- [x] 测试：单元 +15（真解压、本机假 Open VSX、备份和退回）；界面 +2（设置里检查更新、拒绝别人发布的 VSIX；重启后退回到备份并能激活）

### ④ 首次启动：完成（2026-10-11，待试用）

2026-10-11 定（PLAN 的"插件管理"一节也记了）：装好插件后同一页接着问怎么连接 Claude；找不到 Git 时启动提示一次，不限于首次启动。设计见 [ARCHITECTURE.md](ARCHITECTURE.md) 的"首次启动（M4）"。

- [x] 找不到插件时窗口照常打开，显示首次启动页：下载（显示进度）/ 选 `.vsix`（本机 VS Code、VSCodium 里装好的会被自动用上，所以都找不到时才出现这页）；装好后不用重启就启动插件
- [x] 第 2 步：用 Claude 账号登录（交给插件自己的登录），或者用 API 接口（从预设添加，存好密钥就切过去）
- [x] 提示一次可选安装 Git for Windows（没有也能用，Claude 改用 PowerShell）
- [x] 测试：单元 +6（找 Git、开关、找插件）；界面 +1（首次启动全流程，`--ignore-other-editors`）

### ⑤ 管理员实例：完成（2026-10-11，待试用）

2026-10-11 定（PLAN 的"插件管理"一节也记了）：跟普通实例共享 API 密钥；「文件夹 ▾」里加"以管理员身份打开此文件夹"。设计见 [ARCHITECTURE.md](ARCHITECTURE.md) 的"管理员实例（M4）"。

- [x] 以管理员身份运行的实例用单独的 Chromium 数据目录，不参与普通实例的单实例转发（两种实例可以同时开）；设置、接口、插件共用，状态和日志分开；标题栏和窗口标题标出来
- [x] 先验证：safeStorage 的主密钥跟着 Chromium 配置走，换了目录就解不开；把普通实例 `Local State` 里加密的主密钥同步过去就能解开（DPAPI 按用户，管理员是同一用户）。做成启动时同步
- [x] 「文件夹 ▾」里"以管理员身份打开此文件夹"（UAC 确认）
- [x] 两个实例共用插件目录：修改基于磁盘上最新的状态，清理旧版本不碰正在用的；只有普通实例自动更新
- [x] 测试：单元 +8；界面 +1（同时开、徽标和标题、解开普通实例的密钥、状态分开）

## M5 名字、图标、视觉打磨：进行中

原来是 M6，2026-10-10 跟打包对调。范围开工前再商量，不设固定清单：多轮试用、按反馈改，满意了才进 M6。

- [x] 正式名字：Vilausity（简称 vilaus，2026-10-10）
- [ ] 图标
- [ ] 视觉打磨（已经知道的）
  - [x] 圆角和阴影（2026-10-11，待试用）：去掉"一律直角"的全局规则和强制 Monaco 浮层直角的那条；圆角和阴影的变量、档位照搬 VS Code，骨架直角，阴影只给浮层；注入插件页面的评论列表跟对话输入框一样 8px。用法见 design.md 的"壳里的用法"
  - [ ] 配色、按钮和功能的布局、细节的粗糙感
    - [x] 滚动条统一（2026-10-11，待试用）：壳自己的页面跟插件页面一样用 Chromium 的滚动条（细的圆角滑块）配主题色；Monaco 自己画的滑块改成同样 8px 宽的圆角
    - [x] 侧栏会话列表（2026-10-11，待试用；同一天修了"整个滚不动"：中间一层被插件设成只伸不缩，列表没有高度上限）：只有会话列表滚动，账户和用量固定在上面；"账户"和邮箱合成一行；"新建会话"做成按钮；去掉本地 / Web 切换；"活跃"和状态筛选的 ▾ 拼成一个按钮；搜索按钮做成占满一行的搜索框（"新建分组"只留图标）。样式在 bridge 的 `SESSION_LIST_STYLES`
  - [ ] 插件界面翻成中文后，界面文字和对话内容用的是同一套字体，分不开：给壳翻译过的界面文字换一套界面字体（M3.5 试用后提的）

## M5.5 打磨中加的功能：等 M5 做完（第一块已提前写好，待试用）

2026-10-11 加的。M5 只做界面美化；打磨过程中冒出来的新功能和大改动在 M5 期间只记在这里（可以先研究），等 M5 做完再集中做、集中试用和修改。第一块是提前写好的，跟后面的一起试。

### 待做（M5 期间记下的）

- [ ] 用量的重置时间精确到分钟（2026-10-11 提的）：插件只显示"in 3h"这种粗略时间（< 1 小时按分钟，< 1 天按小时，再往上按天，向下取整），但它收到的数据里有精确的重置时刻（`resets_at`）。要从插件收到的用量数据里取出这个时刻，替换页面上的文字（比如"10:42 重置"）。用量本身在启动、登录后和每次对话有 API 调用后更新，没有定时刷新。
- [ ] "活跃"和状态筛选合成一个下拉按钮（2026-10-11 提的）：按钮显示活跃的个数，点开是状态筛选；有需要输入的会话时按钮横向变宽，显示需要输入的个数。现在 M5 只把两个按钮在样式上拼成了一个，点"活跃"还是切换只看活跃的；要按用户的意思做，需要壳拿到各状态的数量、改按钮的行为。

- [ ] 对话的预览标签页（2026-10-11 提的，照 VS Code 的预览编辑器）：从会话列表单击一个会话，只是临时打开看看（标签页标题斜体）；再单击别的会话就在同一个标签页里换掉它，切回原来的标签页时它自动关掉；双击，或者在里面发了消息（有了新内容），才算正式打开、一直留着。
  - 研究：会话列表的单击由插件处理（打开或切到那个会话的面板），壳能在 bridge 里看到会话列表页发出的打开请求，从而知道下一个新面板是从列表单击来的，标成预览；关掉面板走现有的 `panel.didClose`（插件 dispose）；"发了消息"在 bridge 里看得到（这个面板的 `io_message`），"双击"可以是双击标签页，或者在列表里对同一个会话的第二次打开请求。
- [ ] 前进 / 后退（2026-10-11 提的）：鼠标侧键（后退 / 前进）在用过的标签页之间来回，像浏览器和 VS Code 的"返回 / 前进"；对话标签页和右边内容面板的标签页在同一条历史里。也给键盘快捷键（VS Code 是 Alt+← / Alt+→）。
  - 研究：鼠标侧键在 Windows 上是 `WM_APPCOMMAND`，Electron 的 BrowserWindow 有 `app-command` 事件（`browser-backward` / `browser-forward`），焦点在插件页面（iframe）里也收得到，比在页面里监听鼠标按钮可靠。主进程收到后交给页面，页面维护一条"用过的标签页"历史。
- [ ] Esc 关标签页（2026-10-11 提的）：Esc 关掉当前标签页（主要是右边看一眼的文件、计划预览），回到上一个用过的标签页。Vilausity 里很少手动编辑文件，多数是看一眼。
  - 研究：Esc 在很多地方已经有用处，不能无条件地关：插件对话页里 Esc 用来关菜单、弹窗、取消编辑消息（插件页面里有十几处 Esc 处理，都会 `preventDefault`）；Monaco 里关查找框、补全；壳的弹窗和快速访问也用 Esc 关。做法：只在 Esc 没被别处用掉时才关标签页——编辑器里看 Monaco 有没有处理（有浮层开着就不关），插件页面里由引导脚本在冒泡阶段看事件有没有被 `preventDefault`，没被用掉才转给壳。对话标签页要不要也用 Esc 关，等做的时候再跟用户确认（关错了会丢正在看的对话；预览标签页关掉没关系）。

### 第一块：标题栏和对话标签页（2026-10-11 定）

Vilausity 多数时候拿来做简单的电脑任务，工作流基本在单个对话里，所以标签页只在开了多个对话时出现；标题栏只放全局的东西，中间做成 VS Code 那样的搜索框。

- [x] 对话标签页从标题栏挪到对话栏顶上（跟内容面板的文件标签页同一高度）；只有一个对话时不显示标签页行，设置 `vilaus.conversations.alwaysShowTabs`（默认关）
- [x] 标题栏：左边只留侧栏开关、软件名、API 接口按钮；中间搜索框（显示当前文件夹名，右端一个按钮进命令面板）；右边设置、内容面板开关
- [x] 快捷键：Ctrl+P / Ctrl+E 打开搜索，Ctrl+Shift+P / F1 打开命令面板（搜索框里输入 `>` 也能切过去），Ctrl+R 切换文件夹
- [x] 文件夹按钮合进搜索框：什么都没输入时列出最近的对话、新建对话、文件夹（最近的、打开文件夹…、打开最近的文件夹…）
- [x] 搜对话：标题、对话内容（用户说的话和 Claude 的回复）、对话里读过和改过的文件；默认只搜当前文件夹的对话，列表最后一行"在所有文件夹中搜索对话"；结果第二行显示命中原因或内容摘要。输入像文件名或路径时文件排最前（Ctrl+P、文件名、回车照样打开文件）
- [x] 测试：单元 +12（会话记录解析、标题、搜索排序、摘录、索引的缓存、匹配高亮）；界面 +1（搜索框按标题 / 内容 / 文件找到对话，`>` 列命令），标签页那一步加了标签页行的显示 / 隐藏
- [ ] 试用

## M6 打包和发布：未开始

- [ ] electron-builder 打 NSIS 安装包：可以选只装当前用户，或装到 Program Files 给所有用户；建开始菜单和桌面快捷方式；卸载时默认保留 `%APPDATA%\Vilausity`
- [ ] 安装包里不含任何 Anthropic 代码（插件首次启动时从 Open VSX 下载）；不出便携版
- [ ] 目标环境：干净的 Windows 10/11 x64，只有安装包和网络；不需要 VS Code / VSCodium、单独的 Claude Code CLI、Node、Python、Git
- [ ] 发布到 GitHub Releases，新版本手动下载安装（不做自动更新）；不做代码签名，发布说明写清楚 SmartScreen 怎么放行
- [ ] 全新环境测试：临时 user-data-dir、不依赖 VSCodium、模拟没登录的情况
- [ ] 发布后交给几位使用者，在各自的电脑上从零试用：安装 → 首次启动下载插件 → 登录或配置 API → 发消息、审批改文件（没装 Git 的电脑上 Claude 用 PowerShell）；收集问题
- [ ] 装到 Program Files，分别用普通权限和管理员权限运行，再卸载

## 贯穿各阶段（PLAN 的工程规范）

- [x] TypeScript strict，四套 tsconfig（node 侧 / 网页侧 / preload / 单元测试）
- [x] 跨进程消息的类型只在 `protocol.ts` 里定义
- [ ] 运行时校验 IPC 消息的内容（PLAN 写的是用 zod；现在 `ipc.ts` 只检查信封格式）
- [ ] ESLint + Prettier（还没装）
- [ ] 每个模块都有单元测试
  - [x] compat 的 configuration，host 的 bridge 和 webviewDocuments
  - [x] A 组：platform 的 ipc / event / cancellation，compat 的 types（2026-10-09；写测试时发现并修了 `Event.once`、ipc 发送失败、FileSystemError 名字三处源码问题）
  - [x] core 的 menus，exthost 的 contributions，compat 的 `window.showInputBox`，platform 的 webviewUrls（2026-10-09，跟右键菜单一起写的）
  - [ ] 还没有测试的：platform 的 keybindings；core 的 contextKeys / commands / module；compat 的 memento / tabs / commands / webviews；host/main 的 cli / settingsStore / stateStore
  - [x] 测试文件也做类型检查（`tsconfig.test.json`，2026-10-09；之前 esbuild 只剥类型、不检查）
- [x] ARCHITECTURE.md、design.md、ADR 0001–0003
- [x] git，Conventional Commits，每完成一步提交一次
- [x] 插件私有协议的代码只在 `bridge.ts` 和 `compat/vscode/`，每处注明插件版本（当前 2.1.282）

## 还没排进阶段的（PLAN 里有，但没写归哪个阶段）

- [ ] bridge 拦截 `open_terminal` / `open_claude_in_terminal`，改用 Windows Terminal 打开（现在原样转给插件后端，没做专门处理）
