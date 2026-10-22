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

- `src/host/exthost/bridge.ts`：在消息层拦截插件 webview 与后端之间的私有请求（比如 `open_diff`、`open_url`）；插件页面的知识也只写在这里（页面提示 `WebviewPageHints`：评论块的锚点、页面里哪些区域是内容、盖在页面自己样式上的样式、页面脚本合并哪些流式消息；页面存的状态里的会话 id）。
- `src/compat/vscode/`：插件依赖的 VS Code 行为细节（比如 diff 标签页的 `TabInputWebview` viewType 前缀）。

这两处和其他文档只描述跟插件交互时看得到的行为（消息格式、命令 id、设置项）；逆向得来的内部细节不写进仓库。

插件升级后的检查顺序：先跑 `npm run smoke`，再看最新一次 `logs\...\shim-unimplemented.log`，有新出现的 API 就补上。然后是汉化：重跑 `node tools/extension-strings/extract.mjs`，`npm run nls` 看新出现和过时的界面文字（`--todo-extension` 导出补译），并核对 bridge 页面提示里的类名在新版本里还在（侧栏会话列表的样式 `SESSION_LIST_STYLES`、对话正文的字体 `CONVERSATION_STYLES` 也是按类名写的，类名变了就退回插件原样），以及流式消息的形状（`STREAM_MERGE`，见"流式消息合并"）。

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
- **保存**：renderer 调 `document.save`，exthost 发 `onWillSaveTextDocument`、写盘（或写插件的 provider）、发 `onDidSaveTextDocument`。保存、还原、与已保存的比较作用于当前标签页编辑的文档（`EditorPane.documentUri`）：普通文本编辑器的，也包括嵌在别的视图里的（Markdown 的预览和源码是同一份文档，settings.json / keybindings.json 和默认值左右对照时是右边那份）；diff 标签页的 Ctrl+S 存右边。
- **自动保存**（`features/editor/autoSave.ts`）：VS Code 的 `files.autoSave` / `files.autoSaveDelay`，默认关。`afterDelay` 最后一次修改之后过一段时间存；`onFocusChange` 焦点离开这个文件的标签页（切到别的标签页、点进对话）时存，窗口失去焦点时全存；`onWindowChange` 只在窗口失去焦点时全存（焦点进 webview 也会让窗口 blur，所以看 `document.hasFocus()`）。只存磁盘上的文件：插件自己的文档（Claude 提议的改动的右边）不动。磁盘上被改过、又有未保存修改的文件不自动存（会盖掉磁盘上的），等用户自己存或重新载入。插件也读这个设置：关着时保存提议改动的右边等于接受（跟 VS Code 一样，对照 2.1.306），所以 compat 里它的默认值也是 `off`。
- **磁盘被外部改了**（Claude 改文件）：exthost 监视 attached 的文件；文档干净就推 `document.reload`（renderer 用最小替换更新模型，光标和滚动位置不乱），有未保存的修改就推 `document.didChangeOnDisk`，编辑器上方出提示（重新载入 / 保留我的）。exthost 自己写盘时记下写入的内容，不会把自己的写入当成外部修改。
- **编辑器状态**：标签页和编辑器的 id 由 exthost 分配（`compat/vscode/editors.ts` 的 EditorService）。`activeTextEditor` 是内容面板显示时当前标签页的编辑器（焦点在对话里也算，跟 VS Code 在旁边一列显示文件时一样），diff 标签页的左右两个都算可见、右边是 active；选区由 renderer 推给 exthost，插件据此在聊天框里带上当前文件和选中的行。
- **diff**：`vscode.diff` 打开 Monaco 的 diff 编辑器标签页，`TabInputTextDiff` 在命令返回前就进 `tabGroups`（插件会轮询找它）。右边的文档可写时可以直接改。Claude 提议的改动（右边是插件的 `_claude_vscode_fs_right` 文档）带"接受 / 拒绝"按钮：先把这个标签页设为 active，再执行插件的接受 / 拒绝命令。

- **插件进程重启**：旧进程里的标签页和文档跟着它没了；渲染进程断开前记下打开的文件和未保存的文字，新进程连上后重新打开，再把未保存的文字作为一次编辑放回去（新进程于是看到脏文档）。diff 不恢复，它属于提出它的那次会话。

Monaco、Shiki 和 Markdown 渲染都在第一次用到时才加载（renderer 是 ESM + 代码分割，见 [ADR 0003](adr/0003-esbuild-for-all-bundles.md)）。语法高亮用 Shiki（VS Code 的 TextMate 语法，语法颜色取 Dark+ / Light+），编辑器其余颜色取抓来的主题变量。注释符号、括号、缩进规则这些语言配置取自 Monaco 自带的语言定义（只用它们的 `conf`，分词还是 Shiki）。Markdown 预览里的本地图片走 `ccw://img/<路径>`，主进程只放行工作区文件夹里的图片文件。

## 设置（M2.5）

- **settings.json 只有主进程写**（`host/main/settingsStore.ts`，用 jsonc-parser 改，保留用户的注释和格式；文件被手改也会重新读）。改动推给 exthost（`settings.didChange`，插件的 `getConfiguration` 用）和渲染进程（`settingsChanged`）。渲染进程启动时读一次（`settings.read`），写用 `settings.update`（`undefined` 表示删掉、回到默认值）。
- **设置的贡献点** `core/settings.ts`：模块用 `ISettings.register` 声明自己的设置：键、值的 JSON schema（类型、默认值、说明、枚举、上下限……）、设置界面里的分区。插件的 `contributes.configuration` 从它的清单读出来一并声明；给 VS Code 界面用、在 Vilausity 里没意义的几项标成 `hidden`（不在设置界面列出，但留在 schema 里）。读值用 `get(键, 兜底)`：用户的值，否则声明的默认值。
- **设置编辑器**（`features/settings`）照 VS Code 的设置界面：按类型给控件，和默认值相同的值不写进文件（保持 settings.json 简短）。它显示在窗口正中的面板里（`settingsDialog.ts`，照 VS Code 的 modal editor：半透明遮罩、8px 圆角，Esc、关闭按钮或点旁边关掉），不占内容面板；面板里的操作要打开别的东西时（settings.json、默认设置、管理 API 接口）先把面板关掉。左边的目录随滚动高亮当前分区。
- **标题和说明**：标题在英文下照 VS Code 从键名推出来（`Editor: Font Size`）；中文名按键配在 `features/settings/messages.ts` 的 `settingTitleName` 里（只写名字，分区已经说明了归属；显示语言那一项故意保持英文，看不懂中文也找得到）。说明默认不显示（仍然参与搜索、出现在 settings.json 里），标题说不清的设置在声明时加 `showDescription`；插件的设置都显示说明。不显示说明的勾选项，勾选框放在标题前面。插件设置的说明、取值说明由插件进程用 M3.5 的对照表翻好再交给设置界面（`translateContributions`，提取工具也读 package.json 里的这些文字）。**settings.json** 用普通文本标签页打开，Monaco 的 JSON 语言服务（单独的 `json.worker`）按所有声明生成的 schema 给补全、悬停说明和校验。注意：JSON 语言服务的 `fileMatch` 是 glob（前面自动加 `**/`），拿去匹配的是解码后的 URI，所以给的是"上级文件夹/settings.json"，不是完整 URI。
- **编辑器设置**用 VS Code 的键名和默认值（`editor.*`、`diffEditor.*`）。字体相关的（`editor.fontFamily` 等）由主进程算成主题的字体变量，webview 和编辑器共用；其余的由编辑器模块转成 Monaco 选项，改了实时作用到所有文本和 diff 编辑器。加一项设置：在模块里 `register` 声明，`get` 读，`onDidChange` 里重新应用。
- **字体**（M5，2026-10-11）：设置界面的"字体"分区放所有字体，用 VS Code 的键名：界面 `workbench.fontFamily / fontSize`、对话 `chat.fontFamily / fontSize`、对话里的代码 `chat.editor.fontFamily / fontSize`（`default` = 编辑器字体）、编辑器 `editor.font*`（编辑器模块声明，分区一样）、Markdown 预览 `markdown.preview.*`（字体留空 = 对话字体）。默认值在 `platform/defaults.ts`，视觉上的分工见 design.md。没有模块自己应用它们：主进程的 `withFontVariables`（`host/main/themes.ts`，`FONT_SETTING_KEYS` 里的设置一变就重算主题）把它们算成主题变量：`--vscode-font-*`（界面）、`--vilaus-chat-*`（对话和对话里的代码）、`--vscode-editor-font-*`、`--vscode-markdown-*`，壳的页面和每个 webview 都拿到同一份。
  - **插件页面**：插件整页（按钮、菜单、会话列表、对话）都用 `--vscode-chat-font-*`，代码用 `--vscode-editor-font-*`，而且插件会按 VS Code 的 chat 设置把这些值写到页面根元素上。bridge 的页面样式用 `!important` 把前者指向界面字体、后者指向对话里的代码字体，再按类名给对话正文（消息、Markdown、thinking、输入框和它的镜像层）单独设对话字体（`FONT_STYLES`、`CONVERSATION_STYLES`，对照 2.1.296）。计划预览页本来就读 `--vscode-markdown-font-family`。
  - **打包的字体**：Noto Sans SC（思源黑体的字形，SIL OFL 1.1），来自 npm 包 `@fontsource-variable/noto-sans-sc`：可变字重，按 Unicode 范围切成约 100 个 woff2，页面只下载用到的几块。构建时复制到 `dist/renderer/fonts/`（连同许可证），生成 `fonts.css`（字体名改成 `Noto Sans SC`，URL 用绝对的 `ccw://app/fonts/...`）。壳的页面直接引用；webview 的文档由主进程内联这份 @font-face（`WebviewDocumentStore`，经引导脚本插进页面），字体文件跨源加载，所以 `ccw://app` 给字体文件带 CORS 头；插件页面的 CSP 只改 font-src：补上 `data:` 和 `ccw:`，没有 font-src 而 default-src 会拦字体的页面（计划预览）补一条（`allowShellFonts`）。
- **settings.json 比设置界面全**：设置界面只列常用的；Monaco 的编辑器选项自带 JSON schema（VS Code 的 `editor.*` 设置就是从它生成的，说明文字随 Monaco 的语言包），编辑器模块加载 Monaco 后把还没声明的都登记成 `hidden` 设置（`monacoOptionDefinitions`）；diff 编辑器的其余选项 Monaco 没有 schema，照 VS Code 的键名手写声明。settings.json 里的 `editor.*` / `diffEditor.*` 只要声明过，就转成 Monaco 的嵌套选项（`editor.minimap.side` → `minimap.side`，`diffEditor.wordWrap` → `diffWordWrap`）；没声明的忽略（跟 VS Code 一样），所以碰不到 `readOnly`、`automaticLayout` 这类不该开放的选项。字体走主题变量、缩进走模型（`applyIndentation`），不经这条路。
- **默认设置（JSON）**：只读的 Monaco 编辑器（`TextEditorService.createViewer`，背后没有文档，插件看不到），内容由所有声明生成（`defaultSettingsText`），声明变了（比如插件的设置晚到）跟着刷新。查找命令找当前有焦点的编辑器（`focusedCodeEditor`），所以 Ctrl+F 在它里面也能用。
- **settings.json 和默认设置左右对照**（M5.5）：照 VS Code 的 split JSON，settings.json 的标签页分成两栏：左边只读的默认设置（同样的生成文本，开头的说明改成"复制到右边"），右边是可编辑的 settings.json。做法跟 Markdown 预览一样：一个优先级更高的编辑器接下这个文件的文本输入（`DefaultsSplitPane`，`features/editor/defaultsSplitPane.ts`），右边嵌进普通的文本编辑器，所以保存、脏标记、插件看到的编辑器都照旧。中间的分隔条可以拖（双击回到一半），右栏顶上的按钮隐藏 / 显示默认值，宽度和隐藏与否按文件种类记在 localStorage。两栏显示在内容面板里时，内容面板临时加宽到最大（`Layout.widenContentPane`，对话栏挤到拖动分隔条能到的最小宽度），切走、关掉、隐藏左栏或移到独立窗口就回到用户自己的宽度；加宽期间用户拖了分隔条，就以拖的宽度为准。keybindings.json 用同一个编辑器，左边是默认快捷键（`defaultKeybindingsText`：各模块登记的规则，照 keybindings.json 的写法，每条上面注释命令名）。认文件按路径（`isFileUri`，盘符大小写不敏感）。单独的"默认设置（JSON）"标签页照样能开。
- **写 settings.json**：先写临时文件再 rename（`host/node/jsonFile.ts`）。Windows 上目标文件被别的进程打开着（读它的程序、杀毒软件、同步盘）时 rename 会 EPERM，所以短暂重试，跟 graceful-fs 一样。写入排队执行，一次失败不影响后面的。

## 快捷键（M1；用户层和编辑 M5.5）

- **截住按键**：渲染进程把用到的组合键集合交给主进程（`window.setKeybindings`），主进程在 `before-input-event` 里截住（页面、iframe、Monaco 都收不到），发回渲染进程按规则分派（`core/keybindings.ts`，后面的规则优先，`when` 不成立的跳过）。所以快捷键在哪里都能用，代价是集合里的组合键页面永远收不到。组合键按物理键（`KeyboardEvent.code`）算，跟键盘布局无关（`platform/keybindings.ts`）。
- **两层**（照 VS Code）：各模块 `IKeybindings.register` 的是默认；用户的 `keybindings.json`（settings.json 旁边，VS Code 的格式：`key`、`command`、`when`、`args`）盖在上面：普通条目加在默认之后（优先），`-命令` 去掉这个命令的默认（`key` 给了就只去掉这个键的，`when` 给了要相同）。只有主进程写这个文件（`host/main/keybindingsStore.ts`，jsonc-parser 改，保留注释；手改也会重新读），渲染进程启动时读一次（`keybindings.read`，在模块登记默认之前），之后收 `keybindingsChanged`。不支持的条目（连按两下的 `ctrl+k ctrl+s`、缺 key 或 command）读的时候跳过；`when` 写错的那条永远不生效。
- **显示**：菜单、命令面板、提示里的按键都现查（`labelFor`：用户的优先，否则第一条默认；`bindTooltip` 在鼠标移上去时重算），改了快捷键跟着变。
- **设置里的"键盘快捷方式"**（`features/keybindings`）：设置面板里的一个分区，整块是一张表（照 VS Code 的键盘快捷方式编辑器）：在用的规则、还没有快捷键的命令（可以加）、最后是灰色的只读行（系统的复制粘贴、对话输入框的 Enter、Monaco 的常用键、鼠标侧键、Esc 关标签页，`builtins.ts`），按命令名排序。设置的搜索框也搜表里的行（`SettingsWidgetHandle.search`）。双击一行或点铅笔录新按键：录的时候主进程暂停截键（`pauseInterception`，不然 Ctrl+P 会直接打开搜索），Enter 确定、Esc 取消；只收带 Ctrl、Alt、Win 的组合或 F 键（别的键要留着打字）；跟别的命令或只读行重了会提示。改法跟 VS Code 一样（`edits.ts`）：默认的不就地改，加一条新的、再加一条 `-命令` 去掉默认，"重置"把这个命令的条目都删掉；用户自己的条目就地改。行上有重置、删除按钮，左边的竖线标出改过的命令。"在 keybindings.json 中编辑"用普通文本标签页打开，带 schema（命令 id 的补全）。
- **命令要有标题**：表里显示命令的标题；只给快捷键用、不想出现在命令面板里的命令，注册时加 `palette: false`（比如"打开第 N 个对话"，照 VS Code 拆成 9 个命令）。

## 标签页导航（M5.5）

`features/navigation` 记着"用过的标签页"（`history.ts`）：对话标签页和内容面板的标签页在同一条历史里，像浏览器一样，切到一个标签页记一条，后退之后再切到别处就丢掉前面的，关掉的标签页从历史里删掉。

- **前进 / 后退**：命令 `navigation.back` / `navigation.forward`（Alt+← / Alt+→，跟 VS Code 一样，可以在快捷键设置里改）。已经在屏幕上的标签页跳过：对话区和内容面板同时显示，切到正在显示的那个看起来像没反应。
- **鼠标侧键**：鼠标在页面上时，Chromium 自己把侧键当成鼠标按键交给页面（`mouseup`，`button` 3 是后退、4 是前进），不会再变成 Windows 的 app command（2026-10-12 用真实鼠标试过：VS Code 用的 `app-command` 在页面上收不到）。所以由页面报告：壳的页面自己听，插件页面由引导脚本转给壳（`navigate`）。主进程照样转 `app-command`（`browser-backward` / `browser-forward`），管不属于任何页面的地方（标题栏的拖动区）。同一下按键要是两条路都报过来，150 ms 内同方向的第二次不算。标签页的独立窗口里不支持侧键。
- **Esc 关标签页**：Esc 没被别处用掉时，关掉按下它的那个标签页，再回到上一个用过的标签页。只关内容面板的标签页和预览中的对话。正式打开的对话不关，关错了会丢掉正在看的对话。有未保存修改的不关，关掉就等于做了决定的也不关（`EditorPane.closesOnEscape`）：Claude 提议改动的 diff（关掉就是拒绝），以及 API 接口编辑页这种表单。主进程不截 Esc（截了页面就收不到了），"有没有被用掉"由页面自己判断：
  - 壳的页面：窗口上的 keydown 监听等事件分派完再看 `defaultPrevented`。壳的弹窗、查找框、选中文字弹出的菜单用掉 Esc 时都会 `preventDefault`；Monaco 有浮层、选区或多个光标时自己处理 Esc，也会 `preventDefault`。
  - 插件页面：引导脚本从捕获阶段开始看这次 Esc，被 `preventDefault`、被拦下没冒泡回 window、或者让页面变了，都算用掉了，否则报给壳（`keydown`）。看页面变没变（`MutationObserver`），是因为有的菜单按 Esc 关掉自己时前两样都不做。
- **对话页自己的 Esc 改成壳的快捷键**（对照插件 2.1.296，页面提示 `conversationEscapes`）：插件对话页里，没被 `preventDefault` 的普通 Esc 传到页面的 body 就会打断 Claude（没有权限确认在等时）；输入框空着时 800 ms 内连按两下 Esc 打开回退选择器（Rewind to…）。这两个都容易跟"Esc 关预览"打架、也容易误触，所以引导脚本在捕获阶段把每个普通 Esc 都 `preventDefault`（这不影响 Esc 关菜单、关弹窗、取消编辑），输入框空着时会成为"第二下"的 Esc 直接拦下不给页面。这样一来"有没有被用掉"只看后两样。对应的壳命令把这两个动作还给用户：`conversations.rewind`（"回退到…"，默认 Shift+Esc）和 `conversations.interrupt`（"打断 Claude"，默认不绑键），执行时由引导脚本给页面放它自己认的 Esc（`escape` 控制消息：回退是在输入框里连放两个，打断是往 `document.body` 放一个）。带修饰键的 Esc 只有 Shift+Esc 能用：Alt+Esc（切换窗口）、Ctrl+Esc（开始菜单）在 Windows 那一层就被拿走了，程序收不到（2026-10-12 用真实按键试过）。
- **预览对话**：照 VS Code 的预览编辑器。从会话列表单击打开的对话是预览（标题斜体）；再单击别的会话，新的预览在原位置顶替它；切到别的对话标签页，它就关掉。双击标签页、在列表里双击这一行，或者在里面发了消息，就转成正式标签页。插件那边（对照 2.1.296）：单击一行时页面发 `open_in_editor`（带 `sessionId`），插件执行 `claude-vscode.editor.open` 新建这个会话的面板（已经开着就提到前面），然后回 `open_in_editor_response`。bridge 把这个请求进来到回答之前新建的对话面板标成预览（`opensAsPreview` → `PanelCreateParams.preview`）；同一个会话 500 ms 内的第二次 `open_in_editor` 算双击，`io_message` 里的用户消息算发了消息，这两种都让 exthost 发 `panel.update`（`pinned`）；在壳里双击标签页转正式时，渲染进程告诉 exthost（`panel.didPin`）。关预览跟用户点关闭一样（`panel.didClose`，插件 dispose 面板，结束它的 claude 进程）。
  - **会话列表里预览不算"开着"**：插件的会话列表把本窗口开着的会话（`session_states_update` 的 `openSessionIds`）排到最上面、画一个点。预览中的会话要是也这样，单击之后那一行就跑到顶上去了，想在原地双击就找不到它。所以 bridge 发给会话列表页的状态里去掉预览中的会话（`observeToWebview` 可以返回一份改过的副本代替原消息；别的页面照原样收），转正式时再把最后一份状态补发一次（这回带上它），那一行这时才挪到最上面、出现点。面板关掉时 bridge 把它忘掉（`didDisposeWebview`）。

## 窗口和工作区（M4）

- **全局和每个窗口**：`host/main/shellApp.ts` 持有窗口共用的东西（设置、插件的 globalState、主题、界面语言、webview 文档、`ccw:` 协议），`host/main/windowContext.ts` 是一个窗口：BrowserWindow、它的文件夹和 workspaceState、它的 extension host。渲染进程调主进程时按发送的窗口分发；设置、主题、语言变了通知所有窗口。插件的 globalState 所有窗口共用：一个窗口的 extension host 写了，主进程转给其他窗口的（`storage.didChange`，compat 的 Memento 跟着更新）。webview 的 id 是随机的，所以所有窗口的 webview 文档放在同一个表里，窗口关掉或插件进程重启时按窗口清掉。
- **一个文件夹一个窗口**：打开一个已经有窗口的文件夹，就把那个窗口提到前面。在当前窗口打开别的文件夹（"打开文件夹…"、最近的文件夹、插件的"打开文件夹"按钮）先确认一句（有打开的对话或文件时），未保存的文件逐个问；然后主进程停掉这个窗口的 extension host（插件把打开的对话记在旧文件夹的 workspaceState 里，回到这个文件夹时恢复），换成新文件夹的 workspaceState，重新加载页面，页面加载完再起新的 extension host。界面在 `features/workspace`："打开最近的文件夹"（Ctrl+R，选择框里 Ctrl+Enter 在新窗口中打开）、新建窗口（Ctrl+Shift+N，选一个文件夹），以及搜索里的"文件夹"一组（标题栏的搜索框显示当前文件夹名，见下面的"标题栏搜索框"）。
- **记住的东西**（`state/shell.json`，`host/main/windowHistory.ts`，跟插件的 globalState 分开）：每个文件夹的窗口位置（最多 50 个）、开着的窗口、所有窗口共用的缩放级别。最近打开的文件夹单独放在 `state/recent-folders.json`（`host/main/recentFolders.ts`，最多 20 个），普通实例和管理员实例共用，每次读、改都直接读写文件（另一个进程可能刚写过）；以前版本记在各自 `shell.json` 里的，启动时并进来（同源页面的缩放在 Chromium 里本来就一起变）。开着的窗口随时更新，所以崩溃后也能恢复。启动时：命令行给了文件夹就只开它；没给就恢复上次开着的窗口，都没有才用主目录。一个个关窗口，最后一个关掉时退出，下次只恢复它；用"退出"命令或别处调 `app.quit()`（`before-quit` 被拦下来走同一条路）时开着几个记几个；换界面语言的重启（`app.relaunch`）不管命令行，恢复全部。
- **单实例**：`app.requestSingleInstanceLock` 的锁在 userData 里，一个数据目录一个实例。第二次启动在写任何东西之前把原始参数和工作目录（`additionalData`）交给已经在跑的实例，然后退出；那边按自己的规则解析（相对路径按第二次启动的工作目录算）。参数交给哪个窗口：文件夹 → 它自己的窗口；文件（位置参数或 `--goto 文件:行:列`）→ 文件夹包含它的窗口，没有就交给最近的窗口；什么都没给 → 最近的窗口（`--new-window` 开一个主目录的新窗口）。`--session` / `--prompt` 在那个窗口里开对话：窗口是新开的，就放进插件进程的初始化数据，代替窗口默认打开的空对话；已经开着的，经 `conversation.open` 让插件进程执行插件的 `claude-vscode.primaryEditor.open`；某个标签页已经显示这个会话时（插件页面存的状态里有会话 id），只把那个标签页提到前面，不开第二个。`--prompt` 只是填进输入框，不会发出去。开发时（`electron <开关> <app 路径> <参数>`）用户参数是 app 路径之后的部分（`cli.ts` 的 `userArguments`，Playwright 会在 app 路径前面加 `--inspect=0`）。
- **`vilaus://` 链接**：Windows 打开协议链接时把 URL 当参数传给程序，于是跟别的参数一样走单实例转发。`vilaus://<插件 id>/<路径>?<参数>` 交给那个插件用 `window.registerUriHandler` 注册的处理器（Claude Code 有 `/open?session=&prompt=`），之前照 VS Code 先问用户一次（网页也能放这种链接）。把协议登记进注册表在 M6 的安装包里做。
- **插件调的 VS Code 内置命令**（`host/exthost/workbenchCommands.ts`）：`vscode.openFolder`（插件的"打开文件夹 / 在新窗口中打开"按钮，没给文件夹就弹选择框）交给渲染进程走上面同一套流程；`workbench.action.openSettings` 打开设置编辑器并填好搜索词；`revealFileInOS` 在资源管理器里选中文件。

## 标题栏搜索框和快速访问（M5.5）

- **标题栏**：左边侧栏开关、logo 和软件名（见"标题栏 logo 和窗口图标"）、设置、API 接口按钮；中间搜索框（照 VS Code 的命令中心，显示"工作区：<文件夹名>"，用户主文件夹后面加"（全局）"——在那里 Claude 能动整台电脑；管理员实例在后面加"[管理员]"）；右边设置、内容面板开关。左右两边平分剩下的宽度，搜索框在窗口正中（左边自带 6px 的左右内边距，不算在平分的份额里，所以右边在靠搜索框那侧补同样多）。搜索框右端两个图标按钮：在文件资源管理器中显示工作区文件夹、在工作区打开终端（`workspace.revealFolder`、`workspace.openTerminal`，没输入时搜索里的"文件夹"一组和命令面板里也有）。终端由主进程起（`host/main/terminal.ts`）：设置 `terminal.external.windowsExec`（VS Code 的键名）填了就用它，没填时装了 Windows Terminal 用它（`-d .`），否则 PowerShell；照 VS Code 的外部终端走 `cmd /c start`，控制台程序才会有自己的窗口；管理员实例开的终端也是管理员的。
- **快速访问**（`core/quickAccess.ts`，照 VS Code 的 quick access）：一个输入框，开头的字符决定交给谁：`>` 是命令（`features/commandPalette`），没有前缀是搜索。打开时盖在标题栏的搜索框上（跟 VS Code 开着命令中心时一样，所有快速输入都在这个位置），看起来是搜索框变大成了输入框、下面接着列表；左右按搜索框实际的位置摆（`Layout.quickInputLeft`，窗口窄、左边内容长时搜索框不在正中），夹在窗口左边和窗口按钮之间，不能拖动窗口。搜索由各模块登记的分组拼成（`registerSearchContributor`，分组的顺序可以随输入变）：对话（`features/sessionSearch`）、新建对话（`features/conversations`）、文件（`features/quickOpen`；输入像文件名或路径时排到最前，Ctrl+P、文件名、回车照样打开文件）、文件夹（`features/workspace`；没输入时还有打开文件夹、最近的文件夹、以管理员身份打开）、命令（没输入时：显示所有命令，加最近用过的两个）、"在所有文件夹中搜索"。异步的分组按 id 保留上一次的结果直到新结果回来，打字时列表不闪。命令面板照 VS Code 把最近用过的命令排在前面（在命令面板和搜索里执行的才算，存在 localStorage，各窗口共用）。快捷键：Ctrl+P / Ctrl+E 搜索，Ctrl+Shift+P / F1 命令，Ctrl+R 最近的文件夹。
- **搜对话**：主进程读 Claude Code 的会话记录（`~/.claude/projects/<文件夹>/<会话 id>.jsonl`，`CLAUDE_CONFIG_DIR` 改了就跟着改；测试用 `VILAUS_SESSIONS_DIR` 指到别处）。这是 CLI 自己的存储格式，不是接口，所以只读、容错：不认识的行和字段跳过。只看标题（用户起的名字 > 旁路文件 `<会话 id>/custom-title.json` > 生成的标题 > 第一句话）、用户打的字和 Claude 的回复（不含工具输出、思考、IDE 和 CLI 附加的上下文），以及 Claude 读过和改过的文件。读取在主进程的 worker 线程里（`host/main/sessionSearch.ts`、`sessionSearchWorker.ts`，解析和匹配是纯函数 `sessionTranscripts.ts`），按文件大小和修改时间缓存，3 秒内的搜索直接用缓存。匹配不分大小写、整串子串匹配（中文直接能搜）：标题、文件、内容依次排，同类按时间新的在前。默认只搜当前文件夹的会话（按记录里的 `cwd`）。打开结果走主进程 `sessions.open`：找到（或打开）那个文件夹的窗口，再 `conversation.open`。

## 对话里的文件链接（M6.5）

对话页里能点开文件的地方（Claude 回复里的 Markdown 链接、用户消息里的 @提及、Read / Edit 这类工具调用的文件名），点一下由插件在编辑器里打开：页面在点击里同步发出 `open_file` 请求。壳加了两种点法，都是"把这条请求扣下来，让壳先决定"：

- **Shift+点击**：用系统默认程序打开（`shell.openPath`，文件夹就是资源管理器）。页面脚本（`host/webview/fileLinks.ts`）在捕获阶段记下这次点击按着 Shift，点击处理期间页面发出的、符合页面提示的打开请求不交给插件，改发给壳；壳（`features/fileLinks`）找到文件就自己打开、丢掉请求，找不到就放行，插件照常处理（它会自己搜）。
- **右键**：壳的菜单：在编辑器中打开、用默认程序打开、在文件资源管理器中显示、复制路径、复制相对路径；Markdown 链接再加"复制链接"（代替插件自己画的只有 "Copy Link" 的菜单）；文件夹只有"在文件资源管理器中打开"和复制路径。页面脚本先要知道右键的是哪个文件：在捕获阶段对这个元素放一次点击，期间页面发的所有消息都扣下不发、链接的默认动作也拦掉，从扣下的打开请求里取出路径；没有打开请求（网页链接发的是 `open_url`）就当没发生过，页面自己的菜单照常出来。"在编辑器中打开"把扣下的请求放行，插件照样定位到链接的那一行。菜单是主进程的原生菜单（`window.popupMenu`）。
- **哪些元素、哪条消息**由 bridge 的页面提示给（`WebviewPageHints.fileLinks`：选择器、请求的匹配规则、路径在哪个字段，对照 2.1.306），页面脚本自己不认识插件的消息。只对选择器认的元素放点击：消息里的附件小块没算进去，有的点了会预览图片。
- **路径**（`platform/fileLinks.ts`）：页面里是 Claude 写的样子，绝对路径、`file:` 链接、Git Bash 的 `/c/...`，或者相对工作区；带 `:12`、`#L12` 这类行号的，先按原样找，找不到再去掉行号找。

## 对话页的思考块和消息定位点（M6.5）

- **展开思考时保持位置**（`host/webview/scrollKeeper.ts`）：插件一个对话的所有思考块共用一个展开状态，点一个就全部展开 / 收起；上面的思考块一起变长，浏览器的滚动锚定挑的是别的元素，被点的标题就跑了（实测往下跑一个思考块的高度），在底部时插件还会把视图拉到新的底部。点思考块标题（页面提示 `keepInPlace`）之后 1.5 秒内，每次变化都把滚动位置挪回去，让被点的标题停在原处：每帧（rAF）一次，另外一个 ResizeObserver 在布局之后、绘制之前补一次（排在插件自己的观察者之后），所以变化那一帧就补上，看不到跳动。用户自己滚动（滚轮、按键、点滚动条）就停手。只展开被点的那一块不做（ROADMAP ③）。
- **消息定位点**（`host/webview/messageMarkers.ts`，照 DeepSeek 网页版）：对话的滚动条左边竖着一列短横线，一条用户消息一条，当前那条用焦点色（跟着接口的强调色）；消息多时只画当前附近的 15 条。鼠标移上去弹出列表（每条消息的第一行，右对齐，当前那条焦点色，菜单的颜色，8px 圆角），点一条就平滑滚到那一轮。"当前"是顶端在对话区顶上 48px 以内的最后一轮。轮次和用户消息的选择器来自页面提示（`messageMarkers`），滚动容器找最近的可滚动祖先；页面变了（MutationObserver，不算自己的改动）、滚动、窗口大小变了都按帧重算。设置 `vilaus.conversations.messageMarkers`（默认开，壳在页面加载和设置变化时告诉页面）；命令"转到我的上一条 / 下一条消息"（默认不绑键）。

## 拖文件进窗口（M6.5）

从资源管理器把文件拖进窗口，松手的地方决定做什么（`features/fileDrop`）：

- **分区**：侧栏会话列表 = 在对话里引用；对话区 = 作为附件上传至消息中（插件自己收）；内容面板 = 在编辑器中打开，内容面板收起时从对话区右边割一条做这个（`zones.ts` 的 `splitOpenStrip`：窗口宽度的 20%，至少 160px，最多对话区的 40%，左边一条 1px 的线）。标题栏（搜索框也是）、标签页那一行不收。
- **遮罩**（`overlay.ts`）：拖着文件进来时整个窗口压一层 `widget.shadow`，每个区中间一个标签写松手会做什么，鼠标所在的区用 `editorGroup.dropBackground` 亮起来，标签是 VS Code 拖进编辑器时那个提示的颜色（`editorGroup.dropIntoPrompt*`）。各区的位置在拖动开始时按元素算好（`ZoneSpec.rect`）。
- **iframe 的问题**：插件页面在 iframe 里，拖到它上面时拖动事件只到 iframe。每个页面的引导脚本察觉到拖着文件（`dataTransfer.types` 有 `Files`）就报给壳（`fileDrag`：`over` 带位置、离开整个页面时 `leave`、松手 `drop`），壳马上盖上遮罩。侧栏、内容面板和对话区右边那条上的区接鼠标事件，盖上以后拖动就转到壳的页面，松手时壳拿到文件（`webUtils.getPathForFile` 取路径）。对话区上的区不接鼠标事件（`pointer-events: none`），文件直接落进插件页面，插件照原样收成附件；页面报的位置让壳把这个区亮起来。
- **什么时候收起**：壳的页面（按 dragenter / dragleave 计数）和所有插件页面都离开了（等 100ms，换元素、换页面时先离开后进入），或者松手了，或者鼠标又动了（拖动中不会有鼠标事件，所以取消以后第一次移动就收；插件页面里的移动由页面脚本报 `end`）。
- **引用**：路径交给主进程（`files.placeInWorkspace`，`host/main/attachments.ts`）：工作区里的原样用，工作区外的复制进工作区的附件文件夹（设置 `vilaus.conversations.attachmentsFolder`，默认 `attachments`，没有就建；指到工作区外就用默认的），同名的加 " (1)"，文件夹整个复制。然后渲染进程经插件进程让 bridge 给对话页发插件的 `insert_at_mention`（`conversation.insertMention`，每个文件一次），页面插入 `@相对路径`（`/` 分隔，有空格就加引号），跟插件自己的"插入 @提及"一样变成小块。没有打开的对话就新开一个，引用填进它的输入框（`conversation.open` 带 prompt）。
- **测试**：CDP 的 `Input.dispatchDragEvent` 能拖真实文件，走的是跟系统拖放一样的路，但一次拖动只会发给开始时所在的页面，中途不会像真实拖放那样换到另一个页面；界面测试因此每次都从松手的那个页面开始拖。CDP 的取消也不给页面发 dragleave。

## 本地接口（M6.5）

给这台电脑上的别的程序用的 HTTP 接口（local API）：看窗口和对话在干什么、打开文件夹 / 文件 / 对话、执行壳的命令。怎么调用写在 [local-api.md](local-api.md)，这里只讲怎么搭的。

- **服务**（`host/main/localApiServer.ts`，不认识 Electron，单元测试直接起）：`node:http` 只听 127.0.0.1，端口默认由系统分配（设置 `vilaus.api.port` 可以固定，固定的被占了就换一个、记日志）。请求要带 `Authorization: Bearer <令牌>`（`timingSafeEqual` 比较）；带 `Origin` 头的一律 403（浏览器发跨源请求都带它，所以网页用不了，令牌泄露了也一样）；`Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`（防 DNS rebinding）。操作按名字：`GET /v1/<名字>` 只给只读的操作（参数在查询串里，都是字符串，参数工具会把 `"12"`、`"true"` 认成数字、布尔），`POST /v1/<名字>` 带 JSON 对象；`GET /v1` 列出应用信息和所有操作（带 `available`）；`GET /v1/events` 是 SSE 事件流，连上先发一份 `windows`，之后每 25 秒一行注释保活。出错回 `{error: <短代码>, message}` 和对应的状态码（`ApiError`）。
- **启停**（`host/main/localApi.ts`）：`vilaus.api.enabled`（默认关）、`vilaus.api.port` 变了就停掉重开。开着时把地址和令牌写进实例目录的 `api.json`（`ApiDiscovery`：`url`、`port`、`token`、`pid`、`version`、`elevated`）；停的时候不删，令牌在文件还在时一直沿用（固定端口加固定令牌，写死配置的工具也能用；删掉文件就换新令牌）。设置面板"本地接口"一节顶上的块显示在不在跑、地址、`api.json` 在哪（`api.status` / `apiStatus`）。
- **三种权限**（`ApiAccess`）：`read` 只看；`write` 在壳里打开、改东西；`send` 让 Claude 干活、没人在电脑前按回车（还要 `vilaus.api.allowSend`，默认关）。**管理员实例只读**：同一个 Windows 用户下没提升的程序也读得到它的 `api.json`，不能让它们借提升过的 Vilausity 做事（比如打开管理员终端、让 Claude 以管理员身份干活）。
- **操作从哪来**：主进程自己的在 `host/main/localApiOperations.ts`（`builtInOperations`：检查参数，事情交给 `ShellApp` 实现的 `OperationsHost`）；渲染进程的模块用 core 的服务 `ILocalApi`（`core/localApi.ts`）`register` 操作、`emit` 事件。渲染进程把自己有哪些操作报给主进程（`api.operations`，每次变了报全部），调用时主进程按参数 `window`（没给就是最近用的窗口）发 `apiRequest` 给那个窗口的页面，页面用 `api.respond` 回答（30 秒没回答算超时）。所以模块里加一个操作就是外部程序能调的一个接口，不用碰主进程和协议。壳的命令就是这样接出去的（`features/localApi`：`commands.list`、`commands.run`，只认有标题的命令；插件的命令不在壳的命令表里，碰不到）。
- **对话的状态**：bridge 原来只数干活、等输入的个数（`sessions.activity`），现在还把 `session_states_update.sessions` 整理成 `{sessionId, title, state}`（`waiting_input` 记成 `waiting`，不认识的算 `idle`）连同前面那个对话报给主进程（`sessions.states`，变了才报）。主进程比较前后，给事件流发 `conversation.state`（新出现的没有 `previous`，没了的是 `closed`；插件进程停了或崩了，这个窗口的对话全算没了），再发一份新的 `windows`（50 毫秒内的变化合成一份）。窗口开关、换接口、换文件夹、换前台窗口也发 `windows`。刚新建、还没发过消息的对话也有会话 id，会出现在列表里，标题是空的。
- **发送**（`conversations.send`）：跟用户打字、按回车走同一条路，不自己往插件发 `io_message`（那样页面上不显示这条消息）。插件进程找到显示这个会话的对话（没开就用插件的 `claude-vscode.primaryEditor.open` 打开，没给会话就新开一个），bridge 给它的页面发控制消息 `submitPrompt`；页面脚本（`host/webview/promptSubmit.ts`）等输入框出现（页面提示 `promptSubmit`），输入框空着就用 `execCommand('insertText')` 填进去，再派发一个 Enter 的 keydown（插件不看 `isTrusted`，2.1.302 / 2.1.306 实测），输入框清空了就算发出去了。回答走页面发给插件的那条路（`{ccwReply: 'submitPrompt', id, outcome}`），bridge 把它截下，不交给插件。输入框里已经有别的字（用户打了一半的）不动、不发；会话被别的进程占着（`liveElsewhereSessions`）不发，同一个会话不能有两个 Claude 进程。主进程先看哪个窗口开着这个会话，有就交给那个窗口；为发送新开的窗口不再开自己的空对话（`skipInitialConversation`）。
- **测试**：单元测试起真的服务测鉴权、路由、错误、事件流、启停和 `api.json`、参数检查、发送的各种结果；界面测试打开开关后用 `fetch` 和事件流把读、写、命令、关掉再开（令牌不变）走一遍，再在假的 Anthropic 接口上发送（新对话、同一个会话再发一次、发送没开时拒绝、输入框有字时不发）。

## 会话列表里壳加的东西（M5.5）

都是页面脚本照 bridge 的页面提示做的（对照插件 2.1.296）；插件改了类名就退回插件原样。数据靠 bridge 旁听插件发给页面的消息（`observeToWebview`），再用控制消息（`ShellToWebviewControl`）交给页面脚本。页面上的显示都走 `data-vilaus-*` 属性加 bridge 的样式，React 管的内容不动。

- **用量的重置时间**（`usageBars`、`host/webview/usageResets.ts`）：插件只写"Resets in 3h"。bridge 从 `panel_usage_update`（`unifiedWindows.<窗口>.resetsAt`，秒）和 `get_usage_response`（`rate_limits.<窗口>.resets_at`，ISO 日期；`model_scoped[]` 按模型）里取出精确时刻，按用量条的标签（"Session (5hr)"等，`usageResetsOf`）交给页面；页面按标签的英文原文（汉化记着原文）对上，显示"15:42 重置""明天 09:00 重置"。
- **筛选下拉**（`statusFilter`、`host/webview/statusFilter.ts`）：插件的筛选按钮写上"活跃 · N"（从藏起来的"活跃"开关抄字），有会话在等用户时加"需要输入 · N"（bridge 数 `session_states_update.sessions` 里 `state` 是 `waiting_input` 的，见"标题栏 logo 和窗口图标"；第二块当初按 `waiting` 数，一直没显示过，第六块修了）。

## 删除会话（M5.5）

插件的会话列表只能归档，删除是壳加的（对照插件 2.1.296）。

- **按钮**：bridge 的页面提示 `sessionRows` 告诉页面脚本行在哪（`<button id="sessions-list-row-<会话 id>">`）、按钮组在哪、插件按钮用的类名；`host/webview/sessionRows.ts` 在每行的重命名、归档后面加一个同样样式的垃圾桶按钮（文字随引导数据的 `labels` 来，主进程按界面语言给）。点击不往上冒泡，免得行本身打开会话；消息 `deleteSession` 交给壳。
- **能不能删**：插件给它的每个页面推 `session_states_update`，里面有本窗口打开的会话（`openSessionIds`）和别的进程占着的（`liveElsewhereSessions`：另一个窗口、VS Code、命令行，插件靠 Claude Code 记的运行中进程知道）。bridge 旁听插件发给页面的消息（`observeToWebview`）记下这两份名单，渲染进程删之前问一次（`sessions.busy`），确认后再问一次。别的进程在用的不删，提示先在那边关掉；本窗口标签页里开着的照常确认、照常删。
- **确认框**：会话用过兼容接口（壳自己算钱的那种）时，确认框多一句：它在那个接口上花的钱（`usage.sessionCost`，主进程按接口的价格算好）也会从会话列表的用量里去掉，接口设置里的历史累计还算着（见"用量和费用"的账本）。
- **开着的先关**：确认后插件进程关掉显示这个会话的标签页（`sessions.close`，按页面状态里的会话 id 找面板，跟用户点关闭一样 dispose），插件随之结束它的 claude 进程，但进程要过一会儿才退出。Claude Code 运行时在 `sessions/<pid>.json` 里登记（`{pid, sessionId, ...}`），退出时先删登记、再往会话记录里写最后几行（`atis-latch`、`cost-state`，2.1.296 实测），只看登记的话会在这两步之间删掉文件，它又被写回来。所以 `sessions.close` 关之前先按登记记下这个会话的进程号，关完等这些进程真的退出（`host/node/claudeProcesses.ts` 的 `waitForExit`，最多 10 秒）才返回；Claude Code 的目录由主进程放进插件进程的初始化数据（`paths.claudeConfig`）。主进程删之前再等一次没有活着的进程登记这个会话（`sessionFiles.ts` 的 `waitForSessionEnd`，最多 10 秒，管的是别的进程）；等不到就不删，提示在别处使用。
- **删什么**：主进程 `sessions.delete`（`host/main/sessionFiles.ts`）。会话 id 必须是 UUID 才会拼进路径。删 Claude Code 存的这几处：`projects/<文件夹>/<id>.jsonl` 和同名目录、`file-history/<id>`、`session-env/<id>`；输入历史 `history.jsonl` 不动（CLI 一直在往里追加）。不进回收站，确认框写明删了就找不回。目录跟搜索一样按主进程的 `CLAUDE_CONFIG_DIR` 找；某个 API 接口在自己的环境变量里改了 `CLAUDE_CONFIG_DIR` 的话，那个目录里的会话找不到（提示"找不到"）。
- **删完**：主进程通知每个窗口的插件进程，bridge 给插件页面发插件自己的 `session_store_changed` 请求（插件在 Claude Code 目录换了时也发这个），页面重新读会话列表。
- **Claude Code 自己的清理**：Claude Code 每次启动（不管是 Vilausity、命令行还是 VS Code 起的）都会删掉闲置超过 `cleanupPeriodDays` 的会话记录，没设时是 30 天（2.1.296 实测：0 不收，最小 1，要长期保留就设个大数）。设置 `vilaus.sessions.keepForever`（默认开）：主进程启动时、设置变了时看 Claude Code 的用户设置 `<Claude Code 目录>\settings.json`，没设这一项就写成 36500 天（`host/main/claudeRetention.ts`，用 jsonc-parser 改，别的内容和注释不动；文件不是 JSON 对象时不碰，Claude Code 自己也会报错、不清理）；关掉时，值是 36500 才去掉。用户自己设的别的值不动。改的是全局的 Claude Code 设置，命令行和 VS Code 也跟着不删。插件另有一个"闲置 14 天自动归档"（`claudeCode.archiveInactiveSessions`），只是从列表里收起来、不删，没改它。

## API 接口（M4）

- **数据**：`platform/providers.ts` 定义接口（类型、Base URL、鉴权方式、各档模型、请求头、超时、最大输出、关闭非必要流量、其他环境变量、强调色、来自哪个预设），以及接口 → 环境变量的纯函数（`providerEnvironment`），主进程、渲染进程和单元测试共用。内置的"Claude 订阅"不设任何变量。预设在 `features/providers/presets.ts`，按各家官方文档（2026-10-10；火山方舟、MiniMax、OpenRouter 2026-10-12），只是起点，每个带官方说明的链接。各档模型（2026-10-14 定）一档都不空：最强的给 Opus 和 Fable，供应商让 Claude Code 日常用的给主模型、Sonnet 和子代理，小的给 Haiku；只有一个模型（或只推荐一个、套餐在控制台里选）的就每档都填它。比如 DeepSeek：主模型、Sonnet、子代理 `deepseek-flash[1m]`，Opus、Fable `deepseek-v4-pro[1m]`，Haiku `deepseek-flash`（DeepSeek 自己的页面全写 Flash，Pro 就没地方用了）。`[1m]` 照各家文档写（DeepSeek 的 Pro 文档里没出现，价格页写着 1M 上下文，也带上）：不带的话 Claude Code 按它不认识的模型的默认窗口算，自动压缩会提前。千问的文档不用 `[1m]`，要 1M 时另设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（可选；qwen3.6-flash 超过 256K 涨价），照它不带。只收说 Anthropic Messages API 的接口（Claude Code 只会说这一种）：OpenAI 和 Google 的接口不是，xAI 的 Anthropic 兼容已经弃用；它们的模型可以经 OpenRouter 用。
- **存储**：`providers.json` 只有主进程写（`host/main/providerStore.ts`）。密钥用 Electron 的 safeStorage 加密后存（Windows 上是 DPAPI，只有这个 Windows 用户能解开），系统不提供加密时拒绝保存，绝不存明文。渲染进程只知道有没有密钥（`ProviderSummary.hasKey`）：密钥在编辑页里输入后经 `providers.setKey` 交给主进程，再也不回到页面。
- **怎么交给插件**：插件每次起 claude 进程时读 `claudeCode.environmentVariables`。主进程给每个窗口算一份"设置叠加层"（`providerSettingsOverlay`）：用户自己写在这个设置里的变量，同名的换成接口的（名字不分大小写），再加 `claudeCode.disableLoginPrompt: true`；随初始化数据和 `settings.overlay` 交给这个窗口的插件进程，compat 的配置层读设置时把它盖在用户设置上面。settings.json 和设置界面里看不到叠加层，插件写设置也只写用户那一层（插件只写 `focusView` 等三个键，不写这个）。两个变量都总是设上，免得用户环境里残留的那个盖过我们的：用 API key 时清空 `ANTHROPIC_AUTH_TOKEN`；兼容接口还要防一件事：Claude Code 用 Console 账号（API key）登录时，CLI 只要拿不到它认的 `ANTHROPIC_API_KEY`，就把登录存的 Anthropic key 当 x-api-key 发出去，发到的是第三方的地址。空的不算；插件起的 CLI（入口 `claude-vscode`）里，环境变量给的 key 还得是用户在 CLI 的终端界面里批准过的（`~/.claude.json` 的 `customApiKeyResponses`），否则也不认。办法是 SDK 拼请求头时自定义头排在认证头后面、同名覆盖：兼容接口的 `ANTHROPIC_CUSTOM_HEADERS` 里总加一行 `x-api-key: <接口自己的 key>`（用户自己写了 x-api-key 就不加；还没填 key 时是占位值 `vilaus-no-key`，请求会被对方拒掉），`ANTHROPIC_API_KEY` 也填同一个 key（非插件的模式下直接认）。两个头都发给接口自己的服务器。2026-10-13 用本地假服务器对 CLI 2.1.282、2.1.296 实测过：只设 `ANTHROPIC_API_KEY` 时 x-api-key 仍是登录的 key，加上自定义头后变成接口的 key。不去改批准列表：那要把 key 的后 20 位明文写进 CLI 一直在读写的 `~/.claude.json`。Anthropic API 类型的接口用 bearer 时照旧清空 `ANTHROPIC_API_KEY`，退回登录也还是发给 Anthropic。
- **每个窗口一个接口**：标题栏「API 接口 ▾」（`features/providers`）切换，新对话立即用新接口；已经打开的对话还是原来的 claude 进程，提示里"重新加载窗口"会重启插件进程、恢复对话，新进程就用新接口了。每个文件夹记住自己上次用的接口（`state/shell.json`），第一次打开的文件夹用设置 `vilaus.provider.default`（默认订阅）。`--provider <id>` 给参数交到的那个窗口指定接口。
- **强调色**（2026-10-12）：每个窗口按自己的接口上色。颜色是接口自己选的，否则是供应商的（`PRESET_ACCENTS`，按预设），Claude 订阅和 Claude 的几种 API 用 Claude 的橙色，自定义的兼容接口没有（用主题自己的蓝色）；`providerAccentColor` 算，主进程和渲染进程共用。以前每个接口都存了一份当时预设的颜色或灰色，读 providers.json 时去掉（`withoutLegacyColor`），这些接口就跟着供应商走。
  - **主题**：主进程给每个窗口算一份主题（`ShellApp.windowTheme`）：共用的主题加上这个窗口的强调色（`platform/accent.ts` 的 `withAccent`，纯函数）。VS Code 的主题用一种强调色画焦点框、当前标签页的线、主按钮、选中项、匹配的字（Dark Modern 的 #0078d4）；列出的那些颜色键里，主题原来的值属于这个色相的才换：线和边框对背景至少 3:1（WCAG 对界面元件的要求），填充的控件（按钮、菜单的选中项、徽标）对背景 3:1、必要时加深到白字有 4.5:1，选中项和半透明的底色按主题原来离背景多远来调，高亮的字 4.5:1。不是这个色相的（Light Modern 的灰色选中项、徽标、链接）不动；高对比度主题全部不动。窗口的页面、它的 webview（文档一开始就用这个窗口的主题）、系统按钮层都用这一份；接口、接口的设置、主题、字体变了就重算。
  - **顶部色条**：`--vilaus-accent`，标题栏顶边 2px，横贯整个窗口。系统按钮层（titleBarOverlay）的颜色是标题栏的颜色、透明度 0：页面画的标题栏和色条从按钮底下透出来，Windows 照这个颜色算按钮悬停的深浅。
  - **设置** `vilaus.accent`（工作台，"主题色"）：`provider` 跟随 API 接口（默认）、`custom` 用 `vilaus.accent.custom` 的颜色（设置界面里是颜色选择器：schema 的 `format: "color-hex"`，跟 VS Code 一样）、`vscode` 用颜色主题自己的（没有顶部色条）。
  - **插件页面**：插件自己的橙色（发送按钮、输入框的焦点圈、链接、小标签）在 `--app-claude-orange` / `--app-claude-clay-button-orange` 里，bridge 的页面样式把它们指向主题带来的 `--vilaus-accent-line / -fill / -fill-foreground`；auto 和 bypassPermissions 模式下插件把发送按钮和焦点圈换成红色（`--app-error-foreground`），这两处也换成主题色，改由输入框旁的模式按钮带一层底色提醒（bypassPermissions 红色，auto 琥珀色）；没有强调色时这几个变量是 `initial`，回落到插件自己的值。账户用量条不跟主题色，按用掉的比例从绿经黄到红：条的长度是插件写的行内 `width`，引导脚本按页面提示的 `meters` 把它抄成 `--vilaus-meter`，样式再用 `color-mix` 算颜色。
- **编辑页**是内容面板的标签页（"管理 API 接口"）：左边列表和"添加 API 接口…"（从预设选），右边表单，显式保存。强调色一栏没选时写着"供应商的颜色（默认）"，选了别的可以"恢复默认"；选的跟供应商的一样就不存。"为此接口创建桌面快捷方式"写一个 `.lnk`：`Vilausity.exe --provider <id>`（开发时是 electron.exe 加 app 目录），图标是这个接口的 logo 颜色（见"标题栏 logo 和窗口图标"）。
- **测试**：界面测试在 127.0.0.1 起一个假的 Anthropic 接口，切到指向它的接口、重新加载窗口、新对话发一句话，检查假接口收到的 `Authorization: Bearer <key>` 和模型名；不花钱也不联网。

## 用量和费用（M6）

用兼容接口（DeepSeek 等）时，插件显示的费用不对：它的数是 Claude Code CLI 算的，CLI 不认识的模型一律按 Claude Opus 的价格算（对照插件 2.1.296、CLI 2.1.29x）。CLI 有个 `modelPricing` 设置能改价格，但只认托管设置（managed settings），用户设置和 `--settings` 里的都不认，而且只有美元。所以壳自己算：价格由用户填在 API 接口里，token 数从会话记录里读，币种按接口选。

- **价格**：`ProviderConfig.pricing`（`platform/providers.ts`）：币种（CNY / USD）和按模型的单价（每百万 token：输入、输出、缓存读、缓存写，缓存的两项不填按输入价算）。模型名用 `modelKey` 规范化后比较：小写，去掉结尾的 `[1m]` 这类标记（Claude Code 发请求前会去掉它）。
- **token 数**：会话记录 `projects/<文件夹>/<会话 id>.jsonl` 里每次 API 调用是一行（或几行，一个内容块一行）`type: "assistant"`，带 `message.id`、`message.model`、`message.usage` 的四种 token 数和 `timestamp`；按 `message.id` 去重。子代理的调用在 `<会话 id>/subagents/*.jsonl`。从别的对话分叉出来的对话开头是原对话记录的一份拷贝，同样的调用、同样的 id：一次调用只算一次，算在做出它的会话名下，也就是几份记录里文件建得最早的那个（文件的创建时间；拷贝的那几行连时间戳都一样，分不出先后）。分叉出来的对话的"本对话"只算它自己新做的调用，各个对话加起来正好是总数。`input_tokens` 不含缓存读，四种按各自的价格相加。
- **会话记录里没有的调用**：CLI 自己做的调用不逐条进会话记录：生成标题、压缩对话时生成摘要（输出长，最贵）、WebFetch 读网页时用小模型做的摘要、WebSearch（DeepSeek 在服务端搜，搜到的内容算进那次调用的输入）。但 Claude 进程会往会话记录里写一行 `cost-state`，是它自己的累计数（`modelUsage`，按请求时的模型名、四种 token 数），这些调用都算在里面。2.1.299 只在进程退出时写（更早的版本写得更勤），所以一个进程还开着时，它这些调用要等它退出才补得上。进程启动时接着会话里最后一行 `cost-state` 往下数，连 `startTime` 一起接过来，所以 `startTime` 相同的几行是同一串、后一行包含前一行；进程被直接杀掉（比如程序没正常退出）就一行也不写，它的调用在会话记录里、却不在以后任何一行的数里，下一个进程接着更早的那行数，或者（之前一行都没有）从零开始、`startTime` 是它自己的。所以每行 `cost-state` 只跟会话记录里从它的 `startTime` 到它为止的调用（子代理的也算，进程把它们算在自己数里）比：按模型、按四种 token 分别减，只取多出来的，跟同一串前几行已经补过的比只补新多出来的（`platform/usage.ts` 的 `unrecordedCalls`），当成一次"没记录的调用"（`unrecorded`）。比的时候调用按请求时的模型名（回复行的 `requestedModel`，2.1.296 起有）归到模型下，跟 CLI 的数一一对上；更早的会话记录只有接口回复的模型名，OpenRouter 这类网关两个名字可能不一样，逐个模型减会把整段对话再算一遍，所以这时还要求加起来不超过所有模型合计多出来的部分。时间取它前面最近一条带时间的记录（API 回复行和 4KB 以内的短行，解析出顶层的 `timestamp`；工具结果里也可能有 `timestamp`，而且写在顶层的后面，所以不能在行里直接找；时间只往后走），不早于它的 `startTime`（被杀的进程之后，前面最近一条记录可能是很久以前的）；`cost-state` 自己的 `startTime + totalDuration` 只算进程运行的时间，进程之间的空档不算，不能当写入时间。某个模型的数少于它那段时间里会话记录的调用时，这个模型什么也不补：同一串中间有进程被杀、两个进程同时写一个会话（`continued-in`）时，都只会少补、不会重复；分叉出来的对话的 `cost-state` 从分叉时重新算，拷过来的调用都在它的 `startTime` 之前。这些调用汇总进本对话、本工作区、历史消费和账本，不算进调用次数；悬停明细里每个模型下面单独列出其中多少是这类调用。按时段计价时用补出来的时间，按输入长度分档时是几次调用加在一起的长度（近似）。账本里这类调用每次按整份会话记录重算，记录还在时，旧算法补过、现在不再补的写成 0（`usageLedger.ts`）。
- **统计不到的调用**：Auto mode 下判断工具能不能执行的请求（权限分类器）既不进会话记录，也不进 `cost-state`。用第三方接口时没有 Anthropic 的服务端分类器，CLI 改成自己调 haiku 档的模型，每次带约 13.8 万字符的内置提示词（2.1.299，插件日志里 `[auto-mode] context comparison: classifierChars=…` 和 `classifier_request_started … model=…`，token 数是隐去的）。工具结果行的 `permissionDecision.reasonType` 是 `"classifier"` 的就是它判断的（WebSearch、WebFetch 这类；Read、Grep 按模式放行，Bash 按规则）。所以开了 Auto mode 的对话算出来会偏低：侧栏用量块底下有一行小字说可能略低，接口编辑页价格表下面说明原因和实测差多少。
- **实测核对**（DeepSeek 测试 key，2026-10-14，空闲时段，余额精度是分，扣费不是实时的，几分钟后余额才变）：直接调 API，接口回的 token 数按价格表算是 ¥0.2476，余额扣 ¥0.24；smoke 跑的一段对话，只看会话记录 ¥0.0485、补上没记录的（标题）¥0.0497，余额扣 ¥0.05；命令行跑一段读文件、子代理、WebFetch、`/compact` 的对话，只看会话记录 ¥0.193、补上（压缩摘要 1.2 万输出、WebFetch 摘要）¥0.2508，余额扣 ¥0.25。会话记录里的调用跟 CLI 自己的计数逐条对过，一个 token 不差。高峰时段（北京时间工作日 9:05）直接调两次 flash，按高峰价 ¥0.4933、空闲价 ¥0.2466，余额扣 ¥0.49。
- **实测核对**之二（同一天，高峰时段）：用户的一段 Auto mode 对话（pro 模型，8 次 WebSearch、1 次 WebFetch），平台扣 ¥2.32；修了被杀进程那处以后算出 ¥2.24，差的 ¥0.08 是 9 次分类器请求。同一时段另一段没有分类器的对话算 ¥1.14，跟余额推出的 ¥1.15 对得上。联网搜索不按次另收费：直接发 10 次搜索，按 token 应扣 ¥0.2858、实扣 ¥0.29；流式回复的 `message_delta` 里是全部轮次合计的 token 数，CLI 拿得全。
- 读取在 `host/main/sessionUsage.ts`，跑在搜索用的那个 worker 线程里（`sessionSearchWorker.ts`），跟搜索索引分开存，只留调用不留正文；会话记录只会变长，变长了就从上次读到的位置接着读。
- **哪个接口的**：只看模型名分不开（订阅和 Anthropic API 的模型名一样，同一家开两个 key 也一样），所以每个会话打接口标签。插件把 CLI 的输出原样转给对话页（`io_message`）；CLI 起来以后，插件自己再发一条 `{type: "system", subtype: "status", launchTiming}`，每个进程一次。bridge 看到它就记下这个窗口此刻的接口（插件进程从初始化数据和 `usage.changed` 知道窗口用哪个接口）：CLI 只在启动时读环境变量，所以这就是这个进程用的接口，之后窗口换了接口也不变。`system/init`（带 `session_id`）是每一轮都有的，不能当进程启动看。进程在某个会话上第一次有 API 回复（`assistant`）时，bridge 报给主进程（`sessions.used`，带接口和进程启动的时刻），主进程写进标签文件 `<数据目录>\session-providers.jsonl`（`host/main/sessionProviders.ts`，普通实例和管理员实例共用，只追加），一个进程一行；光打开、没发消息的不算。窗口的接口是用户自己在 `claudeCode.environmentVariables` 里配的（不是 Vilausity 的接口）时，标签记的是窗口的接口（比如订阅），以模型名为准的推断也不会纠正它。
- **归属规则**（`platform/usage.ts` 的 `attributeCall`）：一次调用归它之前最近的那个标签的接口；如果那个接口的模型里没有这个模型、而另一个兼容接口明确写了它，就归那一个（会话后来在 Vilausity 外面换了接口接着聊）。没有标签的调用（有标签之前的历史、命令行和 VS Code 里跑的）按模型名推断：只有一个兼容接口写了这个模型才算它的；Claude 自己的模型名在只配了订阅时算订阅。推断不出的不算任何接口的。
- **统计范围**：只算当前窗口所用接口的费用，不把各家加在一起；分本对话、本工作区、这台电脑上的全部会话（"Claude Code 历史消费"）。这三个数跟着现有的会话记录走：删掉一个对话，它的钱也从这里去掉（删除的确认框会说）。
- **账本：含已删除对话的历史累计**（`host/main/usageLedger.ts`）：worker 每读到会话记录里新的调用，就追加进 `<数据目录>\usage-ledger.jsonl`（普通实例和管理员实例共用，只追加；一行是一个会话新增的调用：`{s: 会话 id, f: 文件夹, c: [[id, 时刻, 模型, 输入, 输出, 缓存读, 缓存写, 思考], ...]}`），按调用 id 去重，后写的为准。同一会话的调用 token 数变了才再写一行；别的会话里已有的 id 是分叉拷贝，不写。从 `cost-state` 补出来的调用也进账本（id 是 `<会话 id>:unrecorded:<第几行 cost-state>:<模型>`）。删除会话前主进程让 worker 立刻重读一遍（`sync`），最后几次调用也进账本。API 接口编辑页的价格表下面显示"Claude Code 历史累计消费：¥X（含已删除的对话）"（`usage.total`，按账本里归到这个接口的调用、用保存的价格算），悬停是按模型的明细。Claude Code 默认会删 30 天没动过的会话记录（`cleanupPeriodDays`），这些对话的钱也留在账本里，只要它们被删之前 Vilausity 读到过。账本从这个版本开始记，之前删掉的找不回来。
- **价格编辑**：API 接口编辑页里，兼容接口的模型一栏下面是价格表：币种（预设给了默认值）、官方价格页链接（预设的 `prices`，2026-10-13 核对过）、每个模型一行（各档模型名、已经有价格的、会话记录里归到这个接口的模型，后者由主进程的 `usage.models` 给出）。国内站的预设带默认价格（见下面"默认价格"）；国际版不带：同一批模型的国际版定价差得很远，用国内模型的人付的也不是国际版的价。
- **侧栏用量块**：窗口用的是兼容接口时（主进程在初始化数据和 `usage.changed` 里告诉插件进程 `shellPricing`），bridge 把插件推给页面的 `active_session_totals_update` 的 `session` 换成 null（插件那块"Account & usage"就不显示了），把 `get_usage_response` 的 `usage.session` 去掉（"查看详情"弹框不显示美元数）。会话列表页由页面脚本 `host/webview/usageBlock.ts` 在同一个位置（`.root_djirOA` 的最前面）放壳自己的一块，用插件同样的类名（bridge 的页面提示 `usageBlock`），插件重绘后自己放回去；内容（标题、三行、按模型的悬停明细、没填价格的模型、底下一行"可能略低于实际扣费"的小字）由主进程按界面语言写好（`host/main/usageView.ts`），经 `usage.view` 交给 bridge，bridge 用控制消息 `usageView` 发给页面。什么时候重新要：会话列表页出现时、当前对话换了（`session_states_update.activeSessionId`）、一轮结束（`result`）、插件推会话合计时、接口或价格变了，最多一秒一次。块上的"价格"链接打开这个接口的编辑页，滚到价格表。订阅、Anthropic API、Bedrock、Vertex、Foundry 的窗口不动，插件的数对它们是对的。
- **价格规则**（`platform/pricing.ts`）：有的接口一个模型不止一个价：按时段（DeepSeek 高峰 / 空闲）、按这次调用的输入长度分档（千问、豆包）、按思考模式。每个模型除了表里的单价，还可以带一串规则 `rules`，每条是一个条件 `when` 加一套单价：`zone`（IANA 时区）+ `days`（1 = 周一 … 7 = 周日，看当地日期）+ `from` / `to`（当地钟点，`to` 不含，比 `from` 早就是跨午夜）+ `startDate` / `endDate`（限时价），`inputOver` / `inputUpTo`（这次调用的输入 = 输入 + 缓存读 + 缓存写，大于前者、不超过后者）、`outputOver` / `outputUpTo`，`thinking`（回复里有没有思考块，会话记录里每次调用记了这一项），`exceptHolidays: "CN"`（中国大陆的法定节假日不算，看 `zone` 的当地日期；DeepSeek 的高峰时段在节假日全天按空闲价）。节假日的日子写在 `platform/holidays.ts` 里（国务院每年的放假安排里放假的那几天，调休上班的周末不算：用到它的规则本来就不含周末），目前只有 2026 年；没收录的年份当成没有节假日，每年 11 月安排出来后加上下一年。给了的条件全满足才算命中；按顺序取第一条命中的，整次调用都按它的价格算（分档是整次按档，不是超出部分加价）；都不命中按表里的单价。主进程把接口的价格交给 worker，每次调用按自己命中的规则算钱，汇总里带上费用和每条规则算了几次（侧栏悬停明细里列出来，方便核对）。时区换算按小时缓存偏移量，几万次调用也不慢。
- **规则从哪来**：不做分段编辑界面，也不爬官网。价格表上方"复制给 AI 的提示词"（`pricingPrompt`）：填好接口名、地址、官方价格页、模型名（模型栏的加记录里用过的）、币种、今天的日期和界面语言，写明格式（附一个能通过校验的例子）和规矩：必须现场打开官方页面查、不许凭记忆或估、打不开网页就只回 `CANNOT_BROWSE`、查不到的模型放进 `missing`、每页给来源和日期、每个模型摘一句原文（`evidence`）、表达不了的计价方式（超出部分加价、节假日、按次收费、缓存按小时存储费、免费额度）写进 `notes`。提示词是给 AI 看的，不走语言包，固定英文。用户把回答粘回"粘贴回答"框：`readPricingAnswer` 从文字里抠出 JSON 严格校验，多余的键（比如 `cache_read`）、负数、时刻格式、不存在的时区、空范围都会指出位置；没问题就预览（每个模型的单价、每条规则的条件和单价、原文摘录、没价格的模型、来源和备注、会因此没价格的现有模型），点"使用这些价格"才替换掉表里的价格（之后跟别的修改一样要保存）。"复制价格"按同一格式导出。存进 providers.json 的价格读取时走同一套校验，只是宽松：坏的规则单独丢掉，模型的单价留着。
- **默认价格**（`features/providers/presetPrices.json`，按预设 id）：从预设新建接口时直接带上；已有的接口在价格表上方有"默认价格"按钮，把它填进粘贴框，走同样的预览、确认。只给按 token 计费的国内站预设（DeepSeek、Kimi、智谱、千问）；编程套餐是包月的，OpenRouter 模型太多，不给。生成办法（发版前跑一次，`tools/prices/`）：`node tools/prices/fetch.mjs` 用 Edge（playwright-core 的 `msedge` 通道）把价格页渲染后存成文本（`.local/prices/<日期>/<预设>.txt`，阿里云的缓存价在另一页，`MORE_PAGES` 一起抓），并按 app 的提示词生成任务（改成读这个文件、不上网）；让能读文件的 AI（大肥鱼）逐个回答，回答存成 `<预设>.json`；`node tools/prices/check.mjs` 审：跟粘贴一样严格校验，币种对得上，预设的每个模型要么有价要么在 `missing`，`evidence` 里的原文必须在页面文本里一字不差找得到，每个价格数字都要在页面里出现过（没出现的列出来人工看，多半是按百分比算出来的缓存价）；再人工对一遍表头和分档，`--write` 写进 `presetPrices.json` 并列出跟上一版的差异。网站连不上（有时阿里云）就先用 `--tasks` 从已下载的文本重新生成任务；国内站这次连不上的预设先空着，不拿国际版的价顶替。单元测试检查每份默认价格都能通过严格校验、有来源和日期、给预设的主模型定了价。
- **会话列表的接口色标**：主进程的 `usage.sessionProviders` 给出每个会话最后用的接口（最后一次调用的归属，没有调用就看最后一个标签）、各接口的名字和强调色（没有强调色的用主题的灰），bridge 跟用量块一起要、一起发（控制消息 `sessionProviders`，订阅窗口也发）。页面脚本 `host/webview/sessionProviders.ts` 在每行标题前加一个小方块（悬停是接口名），在筛选按钮右边加一个同样式的按钮（当前接口颜色的方块）；按下去是设置 `vilaus.sessions.currentProviderOnly`（设置界面"API 接口"一节里也有），别的接口的行藏起来，看不出接口的照样显示。没做插件列表里的真分组：要改插件 React 渲染的结构，插件一更新就容易坏。
- **用错接口的提示**：对话页打开一个有历史的会话时会向插件要它的记录（`get_session_request`，`purpose` 是 `transcript_open` 或没有；`diff_refresh` 只是刷新改动，不算）。bridge 看到就问主进程（`sessions.opened`）：这个会话最后用的接口跟窗口现在的不一样，就给一条提示，bridge 发给那个对话页（控制消息 `providerNotice`），页面脚本 `host/webview/providerNotice.ts` 把它放在输入框上方（评论块再往上）。按钮"切换到 X 并重新打开"：渲染进程关掉这个会话的标签页、让窗口换到 X（别的对话保留原来的进程，不弹重新加载的提示），主进程等原来的 Claude 进程退出（`sessions.reopen`，跟删除会话一样看 `sessions/<pid>.json`）再在这个窗口重新打开它；"忽略"只是收起。在这个对话里用当前接口发了消息，提示也收起。放在对话里而不是弹通知：从会话列表单击一个个预览时不会连弹一串。为什么会出错没有实测，推测是一家接口回的思考块签名另一家不认。

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
- **哪些分开、哪些共用**（`AppPaths`）：管理员实例的 `instanceRoot` 是 `<数据目录>\admin`，state（窗口、插件的 globalState / workspaceState）、logs、Chromium 配置、插件的 globalStorage / workspaceStorage 都在它下面。Electron 的 userData 也指向它，所以单实例锁也是自己的：管理员实例可以跟普通实例同时开，第二次启动只转发给同一种实例。settings.json、providers.json、`extensions\`、最近打开的文件夹（`state\recent-folders.json`）共用。
- **API 密钥共用**（`host/main/safeStorageKey.ts`）：safeStorage 加密用的主密钥存在 Chromium 配置的 `Local State` 里（`os_crypt.encrypted_key`，本身由 DPAPI 按 Windows 用户加密）。启动时（拿到单实例锁之后、Chromium 读 `Local State` 之前）互相同步：管理员实例用普通实例的主密钥；普通实例自己没有时才用管理员实例的。这依赖 Chromium 的 `Local State` 格式；格式哪天变了，后果只是管理员实例解不开普通实例存的密钥，在管理员实例里重新输入就行。实测：主密钥第一次生成后约 10 秒内写盘，正常退出时一定会写。
- **插件目录共用**：store 每次修改都基于磁盘上最新的 `state.json`（`update()`），两个进程不会互相覆盖。清理旧版本时先改名再删：Windows 不允许给里面有打开文件的文件夹改名，所以另一个实例正在用的版本、正在写的下载不会被删掉一半。只有普通实例会自动检查更新；管理员实例里可以手动检查更新、回滚。
- **怎么标出来**：标题栏搜索框里文件夹名后面加"[管理员]"（照 VSCodium 窗口标题的写法）；原生窗口标题后面加 " [Administrator]"（在 `page-title-updated` 里改，页面自己的 `document.title` 不变）。
- **入口**：Windows 的"以管理员身份运行"；资源管理器右键菜单的"用 Vilausity 打开（管理员）"（`--admin`，见下一节）；普通实例搜索框（没输入时的文件夹一组）和 Ctrl+R 列表里的"以管理员身份打开此文件夹"（命令 `workspace.openAsAdministrator`）：主进程用 PowerShell 的 `Start-Process -Verb RunAs` 启动，Windows 弹 UAC 确认。参数按 CommandLineToArgvW 的规则加引号，开发时带上 app 目录，有 `--user-data-dir` 时也带上。
- **测试**：单元测试覆盖强制开关、路径、命令行引号、主密钥同步。界面测试在普通实例运行时再起一个强制管理员的实例，检查搜索框里的标记、窗口标题、它的主进程用 safeStorage 能解开普通实例存的密钥、它自己的 state 和 Chromium 目录。UAC 那一步没有自动测试。

## 资源管理器右键菜单（M5.5）

- **是什么**：右键文件夹、文件夹空白处、驱动器时的"用 Vilausity 打开"和"用 Vilausity 打开（管理员）"，把那个路径当工作区打开。只有用户要才加：设置"工作台"里的开关（`features/explorerMenu`），或者安装包的选项（M6，调 `--register-context-menu`，卸载时 `--unregister-context-menu`，两个都做完就退出）。
- **写在哪**：`HKCU\Software\Classes` 下 `Directory\shell`、`Directory\Background\shell`、`Drive\shell` 各两个动词（`Vilausity`、`VilausityAdministrator`），只影响当前 Windows 用户，不需要管理员权限。开关的状态以注册表为准，不存 settings.json。主进程拼一个 .reg 文件（UTF-16，中文标签不会坏）交给 `reg import`，一次写完；查有没有用 `reg query` 的退出码，不解析它的输出（按控制台代码页输出，中文会乱）。测试用 `VILAUS_REGISTRY_ROOT` 把根换到 `HKCU\Software\Vilausity-test\...`。
- **命令**：`"Vilausity.exe" "%V"`，管理员那项加 `--admin`、带盾牌图标（`HasLUAShield`）。驱动器的 `"%V"` 是 `"D:\"`，反斜杠把收尾的引号转义了，进程拿到的是 `D:"`，命令行解析时还原成 `D:\`。只有叫 `runas` 的动词才会自己提权，所以 `--admin` 由程序处理：普通权限的进程用"以管理员身份打开此文件夹"同一套（`startElevated`，Windows 弹 UAC）起管理员实例，自己不拿单实例锁、不开窗口，直接退出。
- **跟着程序走**：安装版每次启动时，菜单在就按当前的程序路径和界面语言重写一遍（换了安装位置、改了语言都能跟上）；开发时不重写（那会指向 electron.exe 和这份代码）。
- **Windows 11**：新右键菜单只收带签名的 MSIX 包注册的项，我们不签名，所以默认在"显示更多选项"里；开了经典右键菜单的电脑上直接在第一层。

## 标题栏 logo 和窗口图标（M5.5）

- **图形**：几何形状只在 `scripts/icons.mjs` 里改。`npm run icons` 除了 `resources/icon/` 还生成 `src/platform/logoMark.ts`：图形的多边形（光标 `_` 单独一块）、放进图标正方形里的版本、`icon.ico` 有哪些尺寸。程序里的 logo 和别的颜色的图标都照这份数据画。
- **颜色**：`platform/accent.ts` 的 `logoColor`：就是窗口的强调色，但 Claude 的橙色（订阅、Anthropic API、Claude 的几种平台）和没有强调色时（"VS Code 默认颜色"、没选颜色的自定义接口）用 logo 自己的亮橙 `#ff7b1c`，这样的窗口显示的就是程序图标本身。主题里的 `--vilaus-logo` 是标题栏用的，跟顶部色条一样调到对标题栏至少 3:1（近黑的颜色在深色标题栏上会提亮，亮橙在浅色标题栏上会压暗一点）。
- **标题栏的 logo**（`features/window/logo.ts`）：内联 SVG，在软件名前面，高 14px。光标兼当状态灯：本窗口任何一个对话里 Claude 在干活时，它像终端光标一样闪（亮 0.53 秒、灭 0.53 秒）；有对话在等用户（权限确认、提问）时琥珀色常亮（`editorWarning.foreground`，跟会话列表的"需要输入"同色），两种都有时显示等用户的。系统关了动画（`prefers-reduced-motion`）时，干活显示成半亮、不闪。悬停提示写着几个对话在干活、几个在等。
- **状态从哪来**（对照插件 2.1.296）：每个对话页把自己的状态报给插件（`update_session_state`：有权限请求或提问在等时 `waiting_input`，Claude 在回复或有后台任务在跑时 `running`，否则 `idle`）；插件给本窗口每个页面广播 `session_states_update.sessions[] = {sessionId, state, title}`，对话关掉时删掉它那条。bridge 旁听这条广播数出 `{running, waiting}`（每个页面收到的是同一条，变了才报一次），exthost 报给主进程（`sessions.activity`），主进程设任务栏，再转给页面（`sessionActivity` 事件）。插件进程停掉或崩溃时主进程把它归零。会话列表的"需要输入 · N"也用这个数。
- **任务栏**（`ShellWindow.setActivity`）：干活时任务栏按钮上的绿色进度条来回走（`setProgressBar` 的 `indeterminate`），有对话在等用户时整个按钮变黄（`paused`），都没有就去掉。实测（StartAllBack 的任务栏）前台窗口的按钮不一定画进度，后台窗口的都能看到；前台时看标题栏的 logo 就行。
- **窗口图标**：每个窗口按 logo 的颜色 `setIcon`（任务栏按钮、Alt+Tab，连同移到独立窗口的标签页）；亮橙用程序自己的 `icon.ico`。别的颜色主进程自己画（`host/main/logoIcons.ts`：多边形扫描线填充，横向按精确面积、纵向每像素采样 16 次，再自己编成 PNG 和 ICO，ICO 的写法跟 `icons.mjs` 一样），存成数据目录下的 `icons/logo-<颜色>-<几何的哈希>.ico`，一个颜色一个文件、两个实例共用；图形改了文件名就不同，旧文件留着给以前建的快捷方式用。必须是 .ico 文件：Electron 只有拿到 .ico 文件时才把 Windows 要的那个尺寸交给它，从图片给的是一张让 Windows 自己缩放。图标对任务栏也要看得清：按任务栏的深浅（`nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`，变了就换）对 Windows 11 任务栏的底色调到 3:1，亮橙不调。不按接口给窗口分任务栏组（2026-10-12 定）：几个窗口合不合成一个按钮看用户的任务栏设置，不合成时每个按钮显示窗口自己的图标（实测）。
- **快捷方式**："为此接口创建桌面快捷方式"用这个接口的窗口此刻的 logo 颜色的 .ico（亮橙时：安装版用 exe 自己的图标，开发时用 `dist/icon.ico`）。之后改了颜色，再建一次就更新。
- **`--provider` 和主题**：带 `--provider` 启动（接口的快捷方式就是这样）时，主进程等页面加载完才切接口，新主题可能在页面开始监听之前就发来了，以前会出现接口名对了、颜色还是订阅的。所以 `core/workbench.ts` 在第一个 await 之前就开始听 `themeChanged`，用最后收到的那份。
- **测试**：单元测试覆盖 logo 的颜色规则和对比度、扫描线填充（对齐像素的方块、半个像素、总面积跟多边形面积一致）、PNG 和 ICO 的格式、图标文件的缓存、bridge 数状态。界面测试在 API 接口那步检查 logo 跟着订阅、自定义颜色、VS Code 默认、假接口变色，图标文件画出来了，给假接口发消息时 logo 从闲着到干活再回来。smoke 检查真实回复时 logo 干活再停下，审批改文件时 logo 和会话列表都显示在等输入。

## 评论（M3，对话里的评论 M6.5）

在内容面板里或对话里选中文字写评论，评论显示在对话输入框正上方，随下一条消息发给 Claude（照插件计划评论的做法）。

- **选中按钮**是一个通用的菜单贡献点 `editor/selection`（`MenuId.EditorSelection`）：编辑器里有选区时，这个菜单的按钮浮在选区旁边；命令收到 `EditorSelectionContext`（选中的文字、文档 URI、文件路径、范围，以及 `showWidget`，用来在按钮的位置显示自己的界面）。文本和 diff 编辑器用 Monaco 的 content widget（`features/editor/selectionMenu.ts`）；Markdown 预览自己摆放（渲染时在每个顶层块前插一个隐藏的源码行号标记，选区按最近的标记换算回源码行，`features/markdown/sourceLines.ts`）。评论模块（`features/comments`）往这个菜单里登记"评论"，以后别的功能也可以加按钮。快捷键 Ctrl+Alt+M：键盘焦点在对话页里时先问页面选中了什么（见下面"对话里的评论"），那里没有选区再用当前标签页的选区（`EditorPane.selectionContext`）。
- **数据在插件进程**：`host/exthost/comments.ts` 的 ConversationComments 按会话（session）存评论，对外按聊天面板的 webview 提供：面板现在显示哪个会话，就读写哪个会话的评论（会话 id 取自插件页面存的 webview 状态，解析写在 bridge 里）。渲染进程用 `comments.add / update / remove` 修改，收 `comments.didChange` 显示。bridge 在用户发消息（`io_message`）时同步取出评论，作为一个单独的 text 块附在用户打的字后面（斜杠命令不带），然后清空。
- **跟着会话走**：关掉对话标签页，没发的评论留在会话名下，之后从会话列表、Ctrl+Shift+T 或者重启恢复打开这个会话，评论还在；面板换到别的会话，就显示那个会话的评论。会话的评论存在工作区存储（`vilaus.comments`），随时写入。新对话一打开就有会话 id，但发出第一条消息之前会话还没有记录（插件页面在状态里标成 `sessionWithNoTranscript`），这种会话不会被恢复（重启后换一个新 id 重开），所以不算数：这期间的评论先挂在面板上（跟面板的恢复记录一起存，重启后回来），会话有了记录再并进去；一条消息都没发就关掉的对话，评论随面板丢弃。
- **评论块在插件页面里**：块该放在哪个元素前面是插件页面的知识，只写在 bridge 里，以 `WebviewPageHints.commentsAnchor`（输入框所在 form 的选择器）随页面文档交给引导脚本（`host/webview/comments.ts`）。引导脚本把块插在锚点前，用 MutationObserver 在插件重新渲染后放回原位；块里的事件不会冒泡到插件页面；所有文字由壳算好（包括翻译）再发进去，引导脚本里没有界面文案。编辑在壳里进行（小窗盖在块的位置上）。插件页面会量输入区的高度给消息列表垫底，所以块不会挡住最后一条消息。
- **后备**：页面一直找不到锚点（插件改了界面，或者输入框还没出来）时，壳在对话下方显示内容相同的评论栏（`features/comments/fallbackBar.ts`），功能不受影响。
- **发出去的格式**：以 `Comments on selected text:` 开头，每条评论一段：`[Re: "<片段>" — <文件>:<行>] <评论>`。片段压成一行、过长截断；文件是相对工作区的路径；行是 `12` 或 `12-15`。对话里的文字把位置换成谁说的（用户的口吻，消息是用户发的）：`your earlier reply`（Claude 的回复，工具调用也算）、`your earlier thinking`、`my earlier message`。
- 点评论块上的 `文件名:行号` 回到原文：打开着的标签页（文本、diff、Markdown 预览）用 `EditorPane.revealSelection` 选中那段文字，没打开就经插件进程打开文件再选中。
- **评论小窗**点别处就关（写了字的不关）。点进插件页面（iframe）时壳的 document 收不到 mousedown，所以另外看窗口失焦：焦点进了 iframe 就算点了别处。

### 对话里的评论（M6.5）

- **页面提示**：对话页里哪些元素是消息、谁的消息、消息的 uuid 在哪个属性，是插件页面的知识，由 bridge 以 `WebviewPageHints.conversationComments` 给出（对照 2.1.306）：消息、Claude 消息上的 uuid 属性（回复、思考、工具调用都有；一条记录里同时有思考和正文时是一个元素）、用户消息里的文字部分（用户消息没有 uuid）、思考内容和展开它的标题、每一轮。按钮上的字随引导数据的 `labels` 给（`main.comment`）。
- **选中按钮**画在页面里（`host/webview/conversationQuotes.ts`，样子照壳的选区按钮）：鼠标选完、选区在一条消息之内时，按钮出在选区末尾下方；选区滚出视野就藏起来，Escape 收起。点了把选区交给壳（评论事件 `selection`：原文、位置、选区末行的框），壳把评论小窗盖在 iframe 里对应的位置。Ctrl+Alt+M 走控制消息 `commentSelection`，页面用同一个事件带上请求的 id 回答（没有选区回 null）。
- **位置**（`ConversationPlaceDto`）：谁的话（`reply` / `thinking` / `user`）、Claude 消息的 uuid、第几轮、原文在这条消息文字里的起点。评论 `kind: 'conversation'`（`ConversationCommentDto`），文件的评论是 `kind: 'file'`；M3 存下的评论没有 `kind`，当文件的评论读。
- **找回原文**：页面每次重绘都可能换掉文本节点，所以按原文找：先在原来那条消息里找（Claude 的按 uuid，用户的按第几轮），空白宽松匹配（选区文字在块之间有换行，页面的文字不一定有），出现多次取离原起点最近的；找不到再去同类的其他消息里找，离原来那轮近的先找。
- **淡高亮**：评论块的数据（`CommentsViewDto.quotes`）带上对话里被评论的原文，页面脚本用 CSS Custom Highlight API 标出来（`vilaus-comment`，颜色是 VS Code 评论范围的 `editorCommentsWidget.rangeBackground`），不改插件的 DOM；页面一变就在下一帧检查，原来的范围失效了再找。评论发出去，块和高亮一起没了。
- **转到原文**：点块上的来源（"Claude 的回复"等）→ 壳发控制消息 `revealQuote` → 页面把原文滚到对话中间，闪两下（`vilaus-comment-flash`，`editor.findMatchHighlightBackground`）。在收起的思考里就先点一下思考块的标题（插件的所有思考块共用一个展开状态，会一起展开），等它画出来再滚。

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

## 流式消息合并

插件把 Claude Code 的流式事件 (stream event) 一条条转给对话页面：`stream_event` 里的 `content_block_delta`（回复的文字、工具调用的参数、思考），每段思考后面还跟一条 `thinking_tokens`（思考的 token 计数）。页面每收到一条就把整个对话重新渲染一遍。Anthropic 的接口一个事件带好几个 token；DeepSeek 一个 token 一个事件，每秒 200 到 1000 条。对话长一点、电脑慢一点，每条的渲染时间乘上条数就超过一秒，页面跟不上：消息越积越多，显示的内容落后几十秒到几分钟，这期间页面没有反应（转圈不动、不能滚动、关掉计划后对话不重新排版），输出结束、积压处理完才恢复。

- **做法**：引导脚本在插件脚本之前给 window 加 message 监听器。window 上的监听器不分 capture，按添加顺序调用，所以它总在插件的前面。它按 bridge 给的规则（`WebviewPageHints.streamMerge`，对照 2.1.296）认出这些消息，同一个流、同一个内容块的一串合成一条：文字拼起来；`thinking_tokens` 取最新的计数，新增数相加。别的消息一到，先把攒着的按原来的顺序交出去，再放它过去；没有别的消息就最多等 50 毫秒。页面上一次渲染花得更久，就等同样长（最多 1 秒），渲染最多占一半时间。交给页面的是新造的 MessageEvent，origin 和 source 跟原消息一样。逻辑在 `host/webview/streamMerge.ts`，规则是数据，引导脚本本身不认识插件的消息格式。
- **实测**（插件 2.1.296、DeepSeek flash；对话页约 2 千个元素，CPU 降速 4 倍模拟慢电脑）：让 Claude 写一个 200 行的文件。合并前页面收到约 1 万条消息，主线程 96% 被占满，显示落后 95 秒，最长 15 秒不响应；合并后插件只收到约 1 千条，主线程占 40%，落后 0.2 秒，30 毫秒内响应。写长篇 Markdown、中途停止、子代理的情况一样，显示的内容跟合并前一致。不降速时，合并前也会卡 3 秒、落后 7 秒，合并后察觉不到延迟。这期间我们注入的脚本（翻译、计量条）只占几百毫秒。
- **插件改了消息格式**：规则对不上就不合并，消息原样交给页面，退回原来的样子，不会出错。升级插件后核对 bridge 里 `STREAM_MERGE` 写的消息形状。

## 打包和安装包（M6）

- **构建**：`npm run package` = `node scripts/build.mjs --production`（压缩、不带 source map；`keepNames` 留住函数名和类名，日志里的调用栈看得懂，插件看到的 API 类名也不变）+ electron-builder（配置在 `electron-builder.config.ts`，electron-builder 用 jiti 直接加载 TS）。输出在 `release/`：`win-unpacked\`（装好后的样子）和 `Vilausity-Setup-<版本>.exe`。`npm run package:dir` 只出 `win-unpacked`，快。
- **只装 `dist/` 和 package.json**：esbuild 把运行时要的东西全打进了 `dist/`，所以 package.json 里的包都是 devDependencies，electron-builder 一个 `node_modules` 也不带。打成 `app.asar`，不用 `asarUnpack`：插件进程（`utilityProcess.fork`）、搜索会话的 worker 线程、`ccw:` 协议、`fs` 读主题 / 字体 / 引导脚本、窗口图标都直接读 asar（界面测试和 smoke 在打包版上全过）。
- **Electron**：版本和 zip 都来自 `node_modules/electron`（npm 装它时 zip 已经下进 `%LOCALAPPDATA%\electron\Cache`，不再下第二次）。不用 `electronDist` 指向解开的目录：那样 electron-builder 不删 `default_app.asar`。
- **fuse**：关掉 `RunAsNode`：从 VS Code 系的终端启动时会继承 `ELECTRON_RUN_AS_NODE`，exe 就成了纯 Node；程序和插件都不靠它（插件进程是 utilityProcess，插件不 fork）。打开 `OnlyLoadAppFromAsar`。`--inspect` 留着：Playwright 靠它连打包版。
- **AppUserModelID**：`platform/product.ts` 的 `APP_ID` 既是安装包的 appId，也是开始菜单快捷方式的 AUMID；安装版启动时 `app.setAppUserModelId(APP_ID)`，于是从右键菜单、链接、接口快捷方式启动的窗口也跟开始菜单、固定到任务栏的图标合成一组，系统通知也算在它名下。开发时不设，免得跟装好的那份混成一组。`APP_ID` 不能改：安装信息的注册表项由它算出来，改了会装成第二份。
- **许可证**：打包时去掉了第三方库的许可证注释（`legalComments: 'none'`），所以构建按 esbuild 的 metafile 找出打进包的每个 npm 包（加上复制进去的 Monaco 样式和思源黑体），把它们的 LICENSE / NOTICE / ThirdPartyNotices 拼成 `dist/ThirdPartyNotices.txt`；安装时它和本项目的 `LICENSE.txt` 放在 exe 旁边，Electron 自带的 `LICENSE.electron.txt`、`LICENSES.chromium.html` 也在。
- **在打包版上跑测试**：`VILAUS_EXECUTABLE=release\win-unpacked\Vilausity.exe node tests/ui.mjs`（smoke 也认这个变量）启动打包的 exe（不带 app 目录），asar、fuse、`app.isPackaged` 的分支都测到。测试一律把右键菜单的注册表根换到测试键（`VILAUS_REGISTRY_ROOT`）：安装版启动时会改写真实的菜单项。
- **安装包**（NSIS 的向导式安装）：第一页选"仅为我安装"（默认：不用管理员权限，装到 `%LOCALAPPDATA%\Programs\Vilausity`）或"所有用户"（Program Files，Windows 要管理员权限），然后是安装位置、右键菜单、安装、完成（可勾"运行 Vilausity"）。开始菜单和桌面快捷方式；卸载时保留 `%APPDATA%\Vilausity`。界面只有英文和简体中文，跟系统语言走。完成页和卸载页的侧边图由 `npm run icons` 画（`build/installerSidebar.bmp`，Dark Modern 的底色加 logo）。electron-updater 才用的 `elevate.exe` 和 blockmap 不要。
- **`build/installer.nsh`**（electron-builder 的 NSIS 钩子）：
  - `vilaus://`：electron-builder 的 `protocols` 在 Windows 上什么都不写，所以自己写进 `SHCTX\Software\Classes\vilaus`（仅为我 = HKCU，所有用户 = HKLM）。命令是 `"Vilausity.exe" -- "%1"`：`--` 之后 Chromium 不认开关、程序不认选项，一个带引号逃出来的链接塞不进 `--gpu-launcher=…` 这类开关。Electron 自己不会在链接处停下（实测：没有 `--` 时链接后面的 `--remote-debugging-port` 照样生效）。
  - 右键菜单：安装位置之后一页复选框，第一次装默认不勾，重装时照现在有没有。装的时候运行 `Vilausity.exe --register-context-menu`（取消勾选、原来有就 `--unregister-context-menu`），用 UAC 插件的 `UAC_AsUser_Call` 在用户自己启动的那个安装程序里跑：为所有用户安装时安装程序会提权重启自己，提权后的进程的 HKCU 可能是另一个管理员账户的。卸载时只删指向本次安装的 exe 的项（别处的安装、开发版的不动）。
  - 更新安装：electron-builder 装新版本之前总会带 `--updated` 跑旧版的卸载程序，这时协议和右键菜单都不删，新版本装完再写。
  - 写法上的坑：electron-builder 把这个文件插在它的脚本最前面，那时还没有 MUI2、语言和 `common.nsh` 的宏（`APP_EXECUTABLE_FILENAME`），所以文案用语言号（1033、2052），用到它们的函数写在之后才展开的宏里（`customPageAfterChangeDir`、`customHeader`）；安装程序和卸载程序分两遍编译（`BUILD_UNINSTALLER`），只在一边用的变量和函数要放进对应的 `!ifdef`，否则 makensis 的警告会被当成错误。
- **测试安装包**：`node tests/installer.mjs`（当前用户，装进 `.test-data` 下带空格和括号的文件夹）、`node tests/installer.mjs --all-users`（要在提升过的 shell 里，装进 Program Files）：静默安装 → 检查文件（没有 `default_app.asar`、`elevate.exe`）、卸载信息、快捷方式、`vilaus://`、右键菜单 → 启动装好的程序（提升过的 shell 里是管理员实例；所有用户模式再用 `runas /trustlevel:0x20000` 以普通令牌启动一次）→ 静默卸载 → 检查只剩数据目录。两轮：原来有右键菜单（装好后指向新装的 exe，卸载时删掉）、原来没有（不加；之后冒出别处的菜单项，卸载时不动）。它会真的写快捷方式和注册表，所以已经装了 Vilausity 时拒绝运行，跑完把右键菜单和 `vilaus` 键恢复原样。安装和卸载的图形界面（各页、复选框、完成页）用屏幕工具点过一遍，没有自动测试；提权那一步（UAC）也没有。

## 加功能该改哪里

- 插件调用了我们没实现的 VS Code API：在 `src/compat/vscode/` 对应的命名空间文件里实现。没实现的 API 会先返回一个会记日志的空桩，不会崩。插件执行的 VS Code 内置命令（`workbench.action.*` 这类）在 `src/host/exthost/workbenchCommands.ts`。
- 新的跨进程消息：先在 `protocol.ts` 加类型，再在两端 `handle` / `call`。
- 插件 webview 里某个请求要换成 Vilausity 自己的做法：`bridge.ts` 加一条拦截规则，并写清楚对照的插件版本。
- 壳的界面功能（M1 起）：在 `src/features/<名字>/` 建模块，只通过 `core` 的贡献点接入（命令、快捷键、菜单、视图、编辑器类型、设置项）。以后的插件系统也会用同一套机制。
- 内容面板里新的一种标签页：注册一个 `EditorProvider`（`core/editors.ts`），再用 `IContentPane.open(输入)` 打开。要跟插件共用的文档（插件能看到、能改的）一律经 exthost 打开（`documents.show`），别在 renderer 里自己读文件。
- 搜索框（Ctrl+P）里多一组结果：`IQuickAccess.registerSearchContributor`（id、顺序、按输入给出一组行）；新的前缀模式（像 `>` 那样）用 `registerProvider`。
- 选中文字旁边的按钮：往 `editor/selection` 菜单（`MenuId.EditorSelection`）登记一个命令，命令收到 `EditorSelectionContext`，可以用 `showWidget` 在原地显示自己的界面（评论的小窗就是这样）。
- 快捷键注意：主进程会先截住所有注册过的组合键，页面（包括 Monaco）收不到。Monaco 自己要用的键（比如 Ctrl+F）如果被别的模块注册了，要在编辑器模块里用 `when: 'editorTextFocus'` 再注册一条转回给 Monaco。绑了快捷键的命令要有标题（设置里的快捷键表格显示它），提示文字里别写死按键，用 `IKeybindings.bindTooltip` / `tooltip`。
- 界面上的文字：在模块目录的 `messages.ts` 里用 `defineMessages('<命名空间>', {...})` 写英文，代码里用 `t('键')` 取；中文进 `src/nls/zh-cn.json`，没翻译的先显示英文，`npm run nls` 检查（规范见 `docs/design.md` 的"文案"）。界面语言在每个进程启动时定好（main 算出来，传给 renderer 和 extension host），换语言要重启。

## 数据

| 路径（`%APPDATA%\Vilausity\` 下） | 内容 | 谁写 |
| --- | --- | --- |
| `settings.json` | 用户设置（JSONC，键名沿用 VS Code / 插件的） | main |
| `keybindings.json` | 用户的快捷键（JSONC，VS Code 的格式） | main |
| `state\global.json`、`state\workspaces\<hash>.json` | 插件的 globalState / workspaceState | main |
| `state\shell.json` | 窗口位置、要恢复的窗口、缩放级别 | main |
| `state\recent-folders.json` | 最近打开的文件夹（普通实例和管理员实例共用） | main（两种实例） |
| `globalStorage\`、`workspaceStorage\` | 插件自己的存储目录 | 插件 |
| `logs\<启动时间>\` | 本次启动的日志，保留最近 10 次：`main.log`，每个窗口一个 `window<N>\`（exthost.log、shim-unimplemented.log、output\） | main / extension host |
| `providers.json` | API 接口（密钥用 safeStorage 加密） | main |
| `api.json` | 本地接口的地址和令牌（开过本地接口才有；管理员实例的在 `admin\` 下） | main |
| `extensions\` | 自己装的 Claude Code 插件（每个版本一个目录）和 `state.json`（当前、上一个、待切换的版本） | main |
| `chromium\` | Chromium 自己的缓存等 | Electron |
| `admin\` | 管理员实例自己的 state、logs、chromium、插件存储（结构同上） | 管理员实例 |

Claude 的会话记录和登录凭据在 `~\.claude\`，由 Claude CLI 管理，跟 VSCodium 里的插件共用。
