# 视觉规范

结构学 Claude app（会话列表、对话、内容面板），视觉完全是 VS Code / Codium 的专业风格。

## 规则

1. **圆角不一刀切，档位照搬 VS Code**：窗口骨架（标题栏、标签页、侧边栏、面板、横条、整行高亮的列表）直角；按钮、输入框这类控件和菜单、对话框这类浮层按 VS Code 的档位给小圆角。变量名和数值跟 VS Code 一样（`--vscode-cornerRadius-*`，定义在 `styles.css` 的 `:root`，Monaco 的浮层也读这些变量），每类控件用哪档见下面的"壳里的用法"。插件自己的界面保持原样，不去改它；注入插件页面的东西跟旁边插件的控件协调（评论列表跟对话输入框一样是 8px）。
2. **颜色只用主题变量**：`var(--vscode-*)`，不写死任何颜色。新组件先去 VS Code 里找对应的颜色键（比如 `tab.activeBackground`、`quickInput.background`）。
3. **1px 分隔线**，用 `--vscode-panel-border`、`--vscode-tab-border` 这类变量。
4. **信息密度高**：行高 22px 左右，内边距小；不要大面积留白。
5. **图标用 codicon**，跟 VS Code 一致；不用 emoji 当图标。
6. **不要**：大圆角卡片、渐变、彩色大块背景、玻璃拟态、弹跳动画。阴影只给浮层，而且要淡：用 VS Code 的阴影变量 `--vscode-shadow-*`（数值照搬 VS Code，深色主题下几乎看不出来），一般浮层用 lg，命令面板和对话框用 xl。骨架（标题栏、标签页）不加阴影，靠 1px 线分隔。阴影是样式表里唯一写了字面颜色的地方，跟 VS Code 一样。
7. 字体：界面用 `--vscode-font-family`，代码用 `--vscode-editor-font-family`，都来自设置（`workbench.fontFamily`、`editor.fontFamily`）。中文界面靠页面的 `lang="zh-CN"` 让 Chromium 选系统的中文字体，不在样式表里写死字体名。

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
| `small` 4px | 文字按钮、输入框、下拉框、通知、选中文字旁的按钮组；查找框（贴着顶边，只有下面两个角圆）；Markdown 预览的行内代码 |
| `medium` 6px | 图标按钮、标题栏的文件夹 / 接口按钮、命令面板的输入框、设置页里的方块（插件版本）、首次启动页的选项、评论栏的列表 |
| `large` 8px | 评论编辑小窗；注入插件页面的评论列表（跟对话输入框一样） |
| `xLarge` 12px | 命令面板（快速输入）、对话框 |

阴影（`--vscode-shadow-*`，VS Code 定义在 `.monaco-workbench` 上的数值）：

| 档位 | 数值 | 壳里用在哪 |
|---|---|---|
| `lg` | `0 0 12px rgba(0,0,0,.14)` | 查找框（往上不投影）、通知、评论编辑小窗、选中文字旁的按钮组 |
| `xl` | `0 0 20px rgba(0,0,0,.15)` | 命令面板、对话框 |
| `sm` / `md` / `hover` | 4px .08 / 6px .08 / 8px .12 | 定义了但壳里暂时没用（VS Code 用在标签页悬停、标题栏、悬停提示上）；Monaco 自己的浮层会用 |
