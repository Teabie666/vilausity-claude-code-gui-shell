# 二次开发指南

想要 Vilausity 没有的功能，可以自己加：克隆这个仓库，在 Vilausity 里打开它，跟 Claude 说你要什么。这份指南讲怎么把环境搭起来、怎么试、怎么验证、怎么打出自己的安装包，以及常见的改动该落在哪里。人看得懂，Claude 也照着它做。

- 只想让别的程序读 Vilausity 的状态、替你打开对话或发消息，不用改代码：用 [本地接口](local-api.md)。
- 给在这个仓库里干活的 AI 编码助手的规矩在根目录的 [CLAUDE.md](../CLAUDE.md)（Claude Code 打开仓库时自动读它）。架构和分层在 [ARCHITECTURE.md](ARCHITECTURE.md)，视觉和文案规范在 [design.md](design.md)。

## 准备

- Windows 10 / 11（x64）。Vilausity 目前只做 Windows。
- [Node.js](https://nodejs.org/) 24 或更新（带 npm 11），[Git](https://git-scm.com/download/win)。
- Claude Code 插件：开发版按这个顺序找：`--extension-dir` 指的目录 → 数据目录里 Vilausity 自己装的那份 → 本机 VSCodium / VS Code 装的。都没有时窗口里会出现首次启动页，点下载就行。

```powershell
git clone https://github.com/Teabie666/vilausity-claude-code-gui-shell.git
cd vilausity-claude-code-gui-shell
npm install
```

npm 11 默认不跑依赖的安装脚本，要跑的那几个已经批准过了（`package.json` 的 `allowScripts`）。Electron 的程序文件在第一次启动时下载。

## 跑起来

| 命令 | 用的数据目录 | 什么时候用 |
| --- | --- | --- |
| `npm run dev` | 仓库里的 `.test-data\dev` | **推荐**。开一个独立的开发实例，跟你正在用的 Vilausity 互不影响 |
| `run-dev.cmd`（资源管理器里双击）或 `npm start` | `%APPDATA%\Vilausity`（跟安装版同一份） | 想用自己平时的设置、API 接口和对话来试；这时安装版要先关掉 |

为什么要分开：一个数据目录同时只能有一个 Vilausity 在跑。安装版开着时再用同一个数据目录启动开发版，开发版会把参数交给已经在跑的那个，然后自己退出（命令行里会提示一句）。`npm run dev` 第一次运行时从 `%APPDATA%\Vilausity` 复制 `settings.json` 和 `keybindings.json`；API 接口的密钥是按数据目录加密的，复制不过来，要在开发实例里重新填一次。参数照样能传：`npm run dev -- C:\某个\文件夹`。

改了代码之后：

- 改的是渲染进程（`src/core`、`src/features`、`src/host/renderer`）或插件进程（`src/host/exthost`、`src/compat`）：`npm run build`，然后在开发实例里执行命令"Developer: Reload Window"（重新加载窗口）。嫌每次 build 麻烦就另开一个终端跑 `npm run watch`，它会在保存时自动重新打包。
- 改的是主进程（`src/host/main`）或插件页面里的脚本（`src/host/webview`）：关掉开发实例重新 `npm run dev`。
- 调试：命令"Developer: Toggle Developer Tools"打开当前窗口的开发者工具（插件页面在里面的 iframe 里）。日志在数据目录的 `logs\<启动时间>\`：`main.log` 是主进程，`window1\exthost.log` 是第一个窗口的插件进程，`window1\shim-unimplemented.log` 记着插件调用了哪些还没实现的 VS Code API。

## 在 Vilausity 里改 Vilausity

推荐的流程：

1. 用你平时用的 Vilausity 打开克隆下来的文件夹（Ctrl+R →"打开文件夹…"）。
2. 在对话里说清楚要什么。Claude 会读 `CLAUDE.md`，按里面的规矩和这份指南干活。
3. 让它改完按顺序检查：`npm run typecheck` → `npm run lint`（格式不对先 `npm run format`）→ `npm test` → `node tests/ui.mjs`。
4. 你自己用 `npm run dev` 开开发实例试一下。
5. 满意了就提交（`git commit`），想装成正式的就打安装包（见下面"打自己的安装包"）。

提需求时：

- 一次一件事，说清楚在界面的哪里、怎么才算做好（"会话列表每一行右边加一个按钮，点了把会话标题复制到剪贴板"比"会话列表加个复制功能"好做得多）。
- 先让它研究再动手："先读 ARCHITECTURE 里跟 XX 有关的部分，说说打算改哪些文件，我同意了再改。"
- 涉及插件页面里的东西（对话、会话列表）的，让它先在开发实例里用开发者工具看清页面结构再写代码。
- 让它照着已有的功能写：仓库里几乎每种改动都有现成的例子，下面列了位置。

两条要小心的：

- **别在开发实例里打开正在进行中的会话**（会话列表里带绿点、标着 "now" 的那条）：那会起第二个 Claude 进程，跟原来那个抢着往同一个会话里写。
- 开发实例和你正在用的 Vilausity 共用 Claude Code 自己的目录（`~\.claude`：登录、会话记录、设置）。在开发实例里删会话、改 Claude Code 的设置，正式的那边也会看到。

## 代码地图

三个进程：

- **主进程**（`src/host/main/`）：窗口、命令行参数、设置和状态文件（只有它写）、本地接口、系统集成。入口 `main.ts`，总管 `shellApp.ts`，一个窗口是一个 `windowContext.ts`。
- **插件进程**（`src/host/exthost/`，每个窗口一个）：加载 Claude Code 插件，`require('vscode')` 拿到的是 `src/compat/vscode/` 里我们实现的那份。`bridge.ts` 在插件页面和插件后端之间截消息。
- **渲染进程**（窗口页面）：壳的界面。`src/core/` 是各种注册表和服务，`src/features/<名字>/` 是一个个功能模块，`src/host/renderer/main.ts` 把模块列出来启动。插件的每个页面是一个 iframe，里面先跑 `src/host/webview/bootstrap.ts`（"页面脚本"）。

跨进程的消息全部定义在 `src/platform/protocol.ts`。`src/platform/` 是谁都能用的基础件。依赖只能往下指：`platform` ← `compat` / `host/node` ← `host/*`；`core` ← `features`。细节看 [ARCHITECTURE.md](ARCHITECTURE.md)，"加功能该改哪里"一节是总览。

## 常见改动的做法

### 加一个功能模块

壳的界面功能都做成模块：`src/features/<名字>/index.ts` 导出一个 `ShellModule`，在 `src/host/renderer/main.ts` 的列表里加上它。模块只通过 `services` 拿 core 的服务，注册的东西都放进 `subscriptions`（模块停用时一起撤销）。

```ts
// src/features/myFeature/index.ts
import type { ShellModule } from '../../core/module';
import { ICommands } from '../../core/serviceIds';
import { t } from './messages';

export const myFeatureModule: ShellModule = {
  id: 'myFeature',
  activate({ services, subscriptions, logger }) {
    const commands = services.get(ICommands);
    subscriptions.add(commands.register('myFeature.hello', () => logger.info('hello'), { title: t('hello') }));
  },
};
```

能拿的服务在 `src/core/serviceIds.ts`：命令 `ICommands`、快捷键 `IKeybindings`、菜单 `IMenus`、布局 `ILayout`（标题栏按钮、侧栏、内容面板）、设置 `ISettings`、对话框 `IDialogs`、搜索框 `IQuickAccess`、编辑器 `IEditors`、跟主进程说话的 `INative`、跟插件进程说话的 `IExtensionHost`、本地接口 `ILocalApi` 等。

### 界面上的文字

代码里只写英文，放在模块目录的 `messages.ts`：

```ts
// src/features/myFeature/messages.ts
import { defineMessages } from '../../platform/nls';

export const t = defineMessages('myFeature', {
  hello: 'Say Hello',
});
```

中文写进 `src/nls/zh-cn.json`（键是 `命名空间.键`，比如 `"myFeature.hello": "打个招呼"`）。没翻译的先显示英文；`npm run nls -- --todo` 列出所有没翻译的，`npm run nls -- --sort` 把语言包排好序。用词规范见 design.md 的"文案"。

### 加一个命令和快捷键

照 `src/features/sessions/index.ts` 的"切换会话列表"：

```ts
subscriptions.add(commands.register('myFeature.hello', run, { title: t('hello'), category: CommandCategory.view }));
subscriptions.add(keybindings.register({ key: 'ctrl+alt+h', command: 'myFeature.hello' }));
```

有标题的命令会出现在命令面板（Ctrl+Shift+P）和设置的"键盘快捷方式"里；只想给快捷键用、不进命令面板就加 `palette: false`。主进程会截住所有注册过的组合键，页面（包括编辑器）就收不到了，所以别占用打字要用的键。提示文字里别写死按键，用 `keybindings.bindTooltip`。

### 加一个按钮

- 标题栏：`services.get(ILayout).addTitleBarItem('left' | 'right', 元素, 顺序)`，例子是会话列表开关（`features/sessions`）。
- 选中文字旁边的按钮：往菜单 `MenuId.EditorSelection` 登记一个命令（例子是评论，`features/comments`）。
- 插件页面里的右键菜单：`MenuId.WebviewContext`。

按钮的样子用现成的 class（`icon-button`、`button`、`button secondary`），颜色只用 `var(--vscode-*)`，见 design.md。

### 加一个设置

```ts
subscriptions.add(
  services.get(ISettings).register([
    { key: 'vilaus.myFeature.enabled', section: SettingsSection.workbench, schema: { type: 'boolean', default: true, description: t('enabledSetting') } },
  ]),
);
const settings = services.get(ISettings);
const enabled = settings.get('vilaus.myFeature.enabled', true);
subscriptions.add(settings.onDidChange((keys) => { if (keys.includes('vilaus.myFeature.enabled')) { /* 重新应用 */ } }));
```

声明了的设置会出现在设置面板里，settings.json 里也有补全和说明。设置的中文名写在 `src/features/settings/messages.ts` 的 `settingTitleName`。主进程也要读的设置，把键名和默认值放进 `src/platform/`（比如 `platform/defaults.ts`），两边共用。

### 加一个本地接口的操作

在模块里用 `ILocalApi` 登记，外部程序就能用 `POST /v1/<名字>` 调它，不用碰主进程和协议：

```ts
import { IDialogs, ILocalApi } from '../../core/serviceIds';
import { requiredString } from '../../platform/localApi';

const dialogs = services.get(IDialogs);
subscriptions.add(
  services.get(ILocalApi).register({
    name: 'myFeature.greet',
    access: 'write', // 只看的用 'read'；让 Claude 干活的用 'send'
    description: 'Shows a greeting in the window.',
    params: { name: 'string: who to greet' },
    handle: (params) => {
      const name = requiredString(params, 'name'); // 参数不对会回 400
      void dialogs.showMessage({ severity: 'info', message: `Hello, ${name}`, modal: false, items: [] });
      return { greeted: name };
    },
  }),
);
// 给事件流发事件：外部程序收到 event: myFeature.greeted，数据是 {window, data}
services.get(ILocalApi).emit('myFeature.greeted', { name: 'world' });
```

调用时带 `window` 参数就交给那个窗口，不带就交给最近用的窗口。返回值会转成 JSON；抛 `ApiError(状态码, 代码, 说明)` 就回那个状态码。现成的例子：`src/features/localApi/index.ts` 的 `commands.list` / `commands.run`。要读主进程才有的东西（窗口、会话记录），就照 `src/host/main/localApiOperations.ts` 在主进程里加。权限照实填：改东西的别填 `read`，管理员实例和发送开关都靠它把关。

### 往插件页面里加东西

插件的页面（对话、会话列表）是插件自己用 React 画的，壳不改插件的文件，只在页面里加脚本和样式：

1. 页面结构的知识（选择器、类名）只写在 `src/host/exthost/bridge.ts`：在 `WebviewPageHints`（`platform/protocol.ts`）里加一个字段，在 bridge 的 `pageHints()` 里按页面给出，注释写明对照的插件版本。
2. 页面脚本写在 `src/host/webview/<名字>.ts`，在 `bootstrap.ts` 里看到这个提示才装上。插件会频繁重画，要用 `MutationObserver` 跟着页面变，别直接改 React 管的节点（用 `data-vilaus-*` 属性加 bridge 的样式）。
3. 页面脚本要跟壳说话：发 `WebviewToShellMessage`（渲染进程收）；壳要跟页面说话：发 `ShellToWebviewControl`。

现成的例子：消息定位点（`messageMarkers.ts`）、会话列表的删除按钮（`sessionRows.ts`）、对话里的评论按钮（`conversationQuotes.ts`）。先在开发实例里用开发者工具对着真实页面试，再写代码。

### 截插件的请求

插件页面和插件后端之间的私有消息（比如 `open_diff`、`open_url`）在 `bridge.ts` 的 `interceptFromWebview`（页面 → 插件）和 `observeToWebview`（插件 → 页面）里截。加一条拦截规则时写清楚对照的插件版本。插件的私有协议只允许出现在 `bridge.ts` 和 `src/compat/vscode/` 两处，插件升级时只用查这两处。

### 新的跨进程消息

先在 `src/platform/protocol.ts` 对应的表里加方法和类型（比如渲染进程调主进程的 `MainApiForRenderer`），再在两边接上：主进程在 `shellApp.ts` 的处理表里，渲染进程用 `native.call('名字', 参数)`。

### 插件用到了没实现的 VS Code API

看 `logs\...\window1\shim-unimplemented.log`，在 `src/compat/vscode/` 对应的命名空间文件里实现。插件执行的 VS Code 内置命令（`workbench.action.*`）在 `src/host/exthost/workbenchCommands.ts`。

## 规矩

完整的在 [CLAUDE.md](../CLAUDE.md)，这里是最容易踩的几条：

- 分层和"插件私有协议只在两处"见上。
- 视觉照 VS Code：骨架直角、控件和浮层小圆角、1px 分隔线、颜色只用 `var(--vscode-*)`；不要大圆角卡片、渐变、大片留白。
- 代码 TypeScript strict，注释用英文；界面文字走 `messages.ts`。
- 测试实例一律用临时数据目录（`--user-data-dir`），界面测试会自己建。
- 提交用 [Conventional Commits](https://www.conventionalcommits.org/)（`feat: ...`、`fix: ...`），一步一提交。

## 测试

| 命令 | 测什么 | 花钱吗 |
| --- | --- | --- |
| `npm run typecheck` | 四套 tsconfig 的类型检查 | 不 |
| `npm run lint` | oxlint + Prettier，有警告就算失败 | 不 |
| `npm test` | 单元测试（`tests/unit/`）和语言包检查 | 不 |
| `node tests/ui.mjs` | 界面测试：真的启动 Vilausity 点一遍（不给 Claude 发消息）。`UI_ONLY=<正则>` 只跑名字匹配的几步 | 不 |
| `npm run smoke` | 端到端：真的跟 Claude 对话几轮 | 花：要走 API key，见脚本说明 |

界面测试的窗口会开在第二块显示器上（有的话），跑的时候别拿别的窗口盖住它，被盖住的窗口不出画面，测试会超时。加了功能就在 `tests/ui.mjs` 里照旁边的步骤加一步。

## 打自己的安装包

```powershell
npm run package
```

输出在 `release\`：`Vilausity-Setup-<版本>.exe` 和 `win-unpacked\`（装好后的样子）。版本号在 `package.json`。之后 `dist\` 里是正式构建，`npm run build` 换回开发版。

- 安装包没有代码签名，Windows SmartScreen 会拦一下：点"更多信息"→"仍要运行"。
- 你的包和官方的包是同一个程序（同一个 `APP_ID`）：装上会覆盖原来装的 Vilausity，数据目录（`%APPDATA%\Vilausity`）照旧。之后再装官方的新版本也会把你的覆盖掉，所以自己的改动要随上游一起合并、重新打包。
- 打包后可以先 `npm run package:dir` 只出 `win-unpacked`，再用 `$env:VILAUS_EXECUTABLE='release\win-unpacked\Vilausity.exe'; node tests/ui.mjs` 在打包版上跑界面测试。

## 跟上游同步

```powershell
git remote add upstream https://github.com/Teabie666/vilausity-claude-code-gui-shell.git   # 只用加一次
git fetch upstream
git merge upstream/main
```

有冲突就让 Claude 帮你解决（"合并上游时这几个文件冲突了，保留我的功能、采用上游的修改"）。少冲突的办法：自己的功能尽量放在自己的模块目录里，别去改一大片现有代码；必须改现有文件时改得小一点。

## 插件升级以后

Claude Code 插件更新很勤，偶尔会改到壳依赖的东西：

1. `npm run smoke`（或者手动发几条消息），看对话、改文件审批、权限确认还正常。
2. 看最新的 `shim-unimplemented.log`，有新出现的 API 就补上。
3. 插件页面里壳加的东西（定位点、评论按钮、会话列表的按钮……）不见了，多半是插件改了类名：在 `bridge.ts` 里找对应的页面提示，对着新页面改选择器和注明的版本。
4. 界面汉化：`npm run nls` 会报插件新出现的界面文字（需要本地的插件文字清单，见 ARCHITECTURE"插件界面汉化"）。
