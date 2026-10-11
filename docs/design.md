# 视觉规范

结构学 Claude app（会话列表、对话、内容面板），视觉完全是 VS Code / Codium 的专业风格。

## 规则

1. **圆角不一刀切，档位照搬 VS Code**：窗口骨架（标题栏、标签页、侧边栏、面板、横条、整行高亮的列表）直角；按钮、输入框这类控件和菜单、对话框这类浮层按 VS Code 的档位给小圆角。变量名和数值跟 VS Code 一样（`--vscode-cornerRadius-*`，定义在 `styles.css` 的 `:root`，Monaco 的浮层也读这些变量），每类控件用哪档见下面的"壳里的用法"。插件的对话页保持原样；侧栏的会话列表按壳的风格调整（2026-10-11 起，样式由 bridge 的页面提示给出，见 ARCHITECTURE）；注入插件页面的东西跟旁边插件的控件协调（评论列表跟对话输入框一样是 8px）。
2. **颜色只用主题变量**：`var(--vscode-*)`，不写死任何颜色。新组件先去 VS Code 里找对应的颜色键（比如 `tab.activeBackground`、`quickInput.background`）。
3. **1px 分隔线**，用 `--vscode-panel-border`、`--vscode-tab-border` 这类变量。
4. **信息密度高**：行高 22px 左右，内边距小；不要大面积留白。
5. **图标用 codicon**，跟 VS Code 一致；不用 emoji 当图标。
6. **不要**：大圆角卡片、渐变、彩色大块背景、玻璃拟态、弹跳动画。阴影只给浮层，而且要淡：用 VS Code 的阴影变量 `--vscode-shadow-*`（数值照搬 VS Code，深色主题下几乎看不出来），一般浮层用 lg，命令面板和对话框用 xl。骨架（标题栏、标签页）不加阴影，靠 1px 线分隔。阴影和弹出面板后面的遮罩（VS Code 的 modal 用 30% 的黑）是样式表里仅有的字面颜色，跟 VS Code 一样。
7. **滚动条**：全软件一个样子：跟插件页面一样用 Chromium 自己的滚动条（细的圆角滑块），颜色用 `scrollbarSlider.*`；Monaco 自己画的滑块画成同样 8px 宽的圆角（`styles.css` 的"scrollbars"一节）。
8. **字体分三档**（2026-10-11）：界面、对话、代码各一套，靠中文字体和字号拉开；英文照 VS Code（Segoe UI，代码 Consolas）。全都在设置的"字体"分区里可以改（键名和变量见 ARCHITECTURE 的"字体"）。
   - 界面：Segoe UI + 微软雅黑 UI（Microsoft YaHei UI，比普通雅黑行距紧，适合密的界面），13px（跟 VS Code 一样）。标题栏、标签页、菜单、设置，以及插件页面里的按钮、菜单、会话列表。
   - 对话：Segoe UI + 思源黑体（Noto Sans SC，随软件附带，干净的 Windows 上也一样），14px，行高 1.6。你的消息、Claude 的回复、thinking、输入框；Markdown 预览和插件的计划预览默认也用它。
   - 代码：编辑器默认 Consolas 14px，中文落到系统的宋体，跟非代码的部分一眼分开；对话里的代码默认跟编辑器同一个字体，13px。

9. **强调色跟着 API 接口**（2026-10-12）：主题里 VS Code 用强调色的地方（焦点框、当前标签页的线、主按钮、选中项、匹配的字、开着的开关按钮）换成窗口所用接口的颜色，窗口顶边一条 2px 色条。颜色由程序按对比度调到看得清（线 3:1，字 4.5:1），所以供应商的颜色可以照品牌色定，不用为深色、浅色主题各调一份；链接、警告、错误这些有含义的颜色不换。各家的颜色在 `platform/providers.ts` 的 `PRESET_ACCENTS`。

## 图标（2026-10-12）

- **样子**：一个亮橙色、往右倾 18° 的 `v_`，左边拖两条速度线，透明底，整体再横向拉宽 10%、纵向压扁 10%。`v_` 是终端提示符 `>_` 的 `>` 转了 90°，后面跟着光标；倾斜和速度线给速度感。所有尺寸都是同一个图形等比缩小，16px 也带速度线。
- **颜色**：`#ff7b1c`（亮橙）。橙色故意跟 Claude 的赭橙（`#D97757`）拉开：同样是橙色、终端出身，颜色再一样就像官方的 Claude Code 图标了。
- **文件**：`resources/icon/` 下的 `icon.svg`（图标：图形放在透明的正方形里，宽占 96%）、`mark.svg`（只有图形、裁到边，给程序里面用）、`icon.ico`（16–256 各尺寸）。都由 `npm run icons`（`scripts/icons.mjs`）生成，几何形状和颜色只在脚本里改，生成的文件一起提交。构建时 `icon.ico` 复制到 `dist/`，给窗口用；M6 的安装包也用它。
- 试过又放弃的（2026-10-12）：黑色底板（深色任务栏上像个黑洞，浅色任务栏上又太重）；小尺寸去掉速度线（底板上显得空）。
- **不能用**：Claude 的星芒、Anthropic 的字标、Claude Code 的像素形象、插件包里的图标、VS Code 的 logo。图标不能让人以为是 Anthropic 或微软的产品。

## 文案（English / 简体中文）

1. 壳里每一处界面文字都要有中英两份。代码里只写英文（模块目录的 `messages.ts`，`platform/nls.ts` 的 `defineMessages`）；中文在语言包 `src/nls/zh-cn.json`，键是 `命名空间.键`。还没翻译的条目显示英文，`npm run nls` 会列出来。
2. 术语跟 VS Code 官方简体中文语言包一致：命令面板、颜色主题、首选项、查看、开发人员、撤消 / 恢复、剪切 / 复制 / 粘贴、全选、区分大小写、上一个 / 下一个匹配项、无结果、"第 {0} 项，共 {1} 项"。
3. 产品名（Claude、Claude Code、Vilausity）、快捷键（Ctrl+N）、设置键名和取值（`zh-cn`）保持原样。
4. 中文里夹英文时，按 VS Code 的写法在中英文之间留空格（"重启 Claude Code"）；括号里是快捷键时用半角括号（"关闭 (Ctrl+W)"），其余用全角。
5. 插件自己的界面没有本地化。壳在插件页面里按对照表把界面文字换成中文（M3.5，`src/nls/zh-cn.extension.json`），插件弹在壳里的通知、输入框、选择框用同一张表；插件的菜单项由壳按命令 id 给中文名。
6. 插件的术语跟 Claude Code 官方中文文档一致（[术语表](https://code.claude.com/docs/zh-CN/glossary)）：功能名保留英文，比如 Plan mode、Auto mode、Hooks、Skills、Subagents、MCP server、Output styles、Plugins、Checkpoint、Effort、Extended thinking、Remote Control、Worktree；工具名（Read、Edit、Bash、Grep）和斜杠命令（`/compact`）也不翻。通用的词照常翻：会话、对话、权限模式、权限规则、设置、工具、上下文窗口、市场、模型。
7. 日志、代码注释、提交信息只用英文，不翻译。

## 参照

拿不准的时候，去 VSCodium 里看同类控件长什么样，照着做。

### 圆角参考（VSCodium 1.121 实测，2026-10-10）

VS Code 定义了一组圆角档位（尺寸 token，CSS 变量 `--vscode-cornerRadius-*`）：

| 档位 | 数值 | VS Code 里用在哪 |
|---|---|---|
| — | 0 | 窗口骨架：标签页、活动栏图标、列表里的分隔行 |
| `xSmall` | 2px | 计数徽标；部分按钮和列表行（直接写的 2px） |
| `small` | 4px | 下拉框（select）、查找框里的开关按钮；文字按钮、通知也是 4px |
| `medium` | 6px | 工具栏图标按钮、快捷键标签、快速输入里的输入框、代码操作菜单的列表行 |
| `large` | 8px | 浮层：右键菜单、下拉菜单、查找框、悬停提示、补全列表、代码操作菜单 |
| `xLarge` | 12px | 快速输入（命令面板）、对话框 |

- 样式表里直接写死的值也很多：4px 最常见，其次 3px、2px、5px；比 12px 大的只有十来处（16px、20px），另外就是圆形和胶囊形的元素。
- 插件的 webview 用的是 4 / 6 / 8px 三档，跟上表的 small / medium / large 对得上。
- 查法：VSCodium 的 `resources/app/out/vs/workbench/workbench.desktop.main.css` 里搜 `border-radius`；档位的定义在同目录的 `workbench.desktop.main.js` 里搜 `cornerRadius.`。VS Code 升级后数值可能会变。

### 壳里的用法（M5，2026-10-11）

| 圆角 | 用在哪 |
|---|---|
| 0 | 骨架：标题栏、标签页、侧边栏、面板、横条（编辑器上方的提示条、工具栏）、整行高亮的列表（设置目录、接口列表） |
| 3px | 复选框、快捷键标签（kbd）、命令面板的列表行（跟 VS Code 一样直接写 3px）；Markdown 预览的代码块 |
| `xSmall` 2px | Markdown 预览的引用块、颜色选择框里的色块 |
| `small` 4px | 文字按钮、输入框、下拉框、通知、选中文字旁的按钮组；查找框（贴着顶边，只有下面两个角圆）；Markdown 预览的行内代码；图标按钮、标题栏的文件夹 / 接口按钮、评论栏的折叠按钮（VS Code 的图标按钮是 medium，壳里小一档，2026-10-11 试用后改） |
| `medium` 6px | 标题栏的搜索框（跟 VS Code 的命令中心一样）、命令面板的输入框、设置页里的方块（插件版本）、首次启动页的选项、评论栏的列表；代码编辑器（Monaco）里的浮层：悬停提示、补全列表、参数提示、查找框（VS Code 是 large，壳里小一档：`.monaco-editor` 上把 large 改成 medium，2026-10-11 试用后改） |
| `large` 8px | 评论编辑小窗；注入插件页面的评论列表（跟对话输入框一样）；设置面板（跟 VS Code 的 modal editor 一样） |
| `xLarge` 12px | 命令面板（快速输入）、对话框 |

阴影（`--vscode-shadow-*`，VS Code 定义在 `.monaco-workbench` 上的数值）：

| 档位 | 数值 | 壳里用在哪 |
|---|---|---|
| `lg` | `0 0 12px rgba(0,0,0,.14)` | 查找框（往上不投影）、通知、评论编辑小窗、选中文字旁的按钮组 |
| `xl` | `0 0 20px rgba(0,0,0,.15)` | 命令面板、对话框 |
| `sm` / `md` / `hover` | 4px .08 / 6px .08 / 8px .12 | 定义了但壳里暂时没用（VS Code 用在标签页悬停、标题栏、悬停提示上）；Monaco 自己的浮层会用 |
