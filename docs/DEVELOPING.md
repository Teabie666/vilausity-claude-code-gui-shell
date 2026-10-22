# 二次开发参考

面向在 Vilausity 克隆仓库里改代码的 AI 编码助手。先读 `CLAUDE.md`（规矩、命令、坑），结构细节查 `ARCHITECTURE.md`，视觉与文案查 `design.md`。外部程序要读写 Vilausity 而不改代码时用本地接口：`local-api.md`。

## 环境

- Windows 10/11 x64；Node 24+（npm 11）；Git。`npm install`（依赖安装脚本已在 `package.json` 的 `allowScripts` 批准；Electron 二进制首次运行时下载）。
- 插件查找顺序：`--extension-dir` → 数据目录 `extensions\` 里自装的 → 本机 VSCodium / VS Code 的；都没有时出首次启动页。

## 运行

| 命令 | 数据目录 | 用途 |
| --- | --- | --- |
| `npm run dev [-- 参数]` | `.test-data\dev` | 默认用这个：独立实例，不跟正在用的 Vilausity 争单实例锁和数据。首次运行复制 `%APPDATA%\Vilausity` 的 settings.json、keybindings.json；API 密钥按数据目录加密，不复制，要在开发实例里重填 |
| `run-dev.cmd` / `npm start` | `%APPDATA%\Vilausity` | 用真实数据试；同数据目录已有实例在跑时参数交给它、自己退出（stdout 提示） |
| `npm run watch` | — | 保存即重新打包 |

改动生效：
- `src/core`、`src/features`、`src/host/renderer`（渲染进程）和 `src/host/exthost`、`src/compat`（插件进程）：build 后执行命令 "Developer: Reload Window"（`window.reload`）。
- `src/host/main`（主进程）和 `src/host/webview`（引导脚本在主进程启动时读入）：重启实例。
- DevTools："Developer: Toggle Developer Tools"（插件页面是其中的 iframe）。日志：`<数据目录>\logs\<启动时间>\main.log`、`window<N>\exthost.log`、`window<N>\shim-unimplemented.log`（插件调了没实现的 VS Code API）。
- 数据目录里：`settings.json`、`keybindings.json`、`providers.json`、`state\`、`extensions\`（自装的插件版本）、`logs\`。
- 启动参数全表见 `src/host/main/cli.ts`（`--help`）；开发常用 `--folder <dir>`、`--extension-dir <dir>`、`--user-data-dir <dir>`、`--theme <id>`、`--log-level <lv>`、`--devtools`、`--secondary-display`（窗口开在副屏）。
- 内置主题 `resources/themes/` 是从本机 VSCodium 抓的：`npm run capture-themes` 重抓。

硬约束：
- 开发实例里不打开进行中的会话（会话列表带绿点、标 "now"）：会起第二个 Claude 进程写同一会话。
- 开发实例与正式实例共用 `~\.claude`（登录、会话记录、Claude Code 设置）：在开发实例里删会话、改 Claude Code 设置会影响正式实例。
- 插件页面相关改动：先在开发实例用 DevTools 看真实 DOM，再写代码。

## 验证

顺序：`npm run typecheck` → `npm run lint`（格式错先 `npm run format`）→ `npm test`（单元 + 语言包）→ `node tests/ui.mjs`（`UI_ONLY=<正则>` 只跑匹配的步骤；第一步等窗口就绪，部分步骤依赖前面的）。动了 `bridge.ts` / `src/compat` 再跑 `npm run smoke`（走 API key，要花钱）。动了打包相关的跑 `npm run package:dir` 后 `VILAUS_EXECUTABLE=release\win-unpacked\Vilausity.exe node tests/ui.mjs`。界面测试窗口在副屏，被遮挡会随机超时。新功能在 `tests/ui.mjs` 照相邻步骤加一步，纯逻辑在 `tests/unit/` 加单元测试。

## 结构速查

- 进程：主进程 `src/host/main/`（`main.ts` 入口，`shellApp.ts` 总管，`windowContext.ts` 一个窗口）；插件进程 `src/host/exthost/`（每窗口一个，`require('vscode')` → `src/compat/vscode/`，`bridge.ts` 截插件页面 ↔ 后端的私有消息）；渲染进程 `src/core/`（服务和注册表）+ `src/features/<名字>/`（功能模块）+ `src/host/renderer/main.ts`（模块列表）；插件页面 iframe 里先跑 `src/host/webview/bootstrap.ts`。
- 跨进程消息只在 `src/platform/protocol.ts`。依赖方向：`platform` ← `compat` / `host/node` ← `host/*`；`core` ← `features`。
- 插件私有协议（消息格式、页面 DOM 知识）只允许在 `src/host/exthost/bridge.ts` 和 `src/compat/vscode/`，每处注明对照的插件版本。

## 配方

### 功能模块

`src/features/<名字>/index.ts` 导出 `ShellModule`，加进 `src/host/renderer/main.ts` 的列表。只经 `services.get(ID)` 取服务，注册结果一律 `subscriptions.add(...)`。

```ts
export const myFeatureModule: ShellModule = {
  id: 'myFeature',
  activate({ services, subscriptions, logger }) {
    const commands = services.get(ICommands);
    subscriptions.add(commands.register('myFeature.hello', () => logger.info('hello'), { title: t('hello') }));
  },
};
```

服务 ID（`src/core/serviceIds.ts`）：`ICommands` `IKeybindings` `IMenus` `ILayout` `ISettings` `IDialogs` `IQuickAccess` `IEditors` `IPanels` `IWebviewFrames` `IThemes` `IWorkspace` `INative`（调主进程）`IExtensionHost`（调插件进程）`ILocalApi`。

### 界面文字

`src/features/<名字>/messages.ts`：`export const t = defineMessages('<命名空间>', { key: 'English' })`（命名空间不能重名）。中文进 `src/nls/zh-cn.json`，键 `命名空间.key`；`npm run nls -- --todo` 列缺译，`npm run nls -- --sort` 排序。用词按 `design.md`"文案"。日志、本地接口的描述不翻译。

界面语言：设置 `vilaus.language`（`auto` / `zh-cn` / `en`，重启生效）。插件自己的界面在中文下按 `src/nls/zh-cn.extension.json` 翻（键是原文的哈希，只存译文；`vilaus.translateExtensionUi` 关掉，即时生效）。维护：`node tools/extension-strings/extract.mjs` 在本地整理插件的界面文字，`npm run nls -- --todo-extension` 导出待译条目，`node tools/extension-strings/merge.mjs <译文.json>` 合并。

### 命令和快捷键

```ts
subscriptions.add(commands.register('myFeature.hello', run, { title: t('hello'), category: CommandCategory.view }));
subscriptions.add(keybindings.register({ key: 'ctrl+alt+h', command: 'myFeature.hello' }));
```

例：`features/sessions` 的 `sessions.toggleSidebar`。有 `title` 才进命令面板和快捷键表；只给快捷键用加 `palette: false`。主进程截住所有注册过的组合键（页面和 Monaco 收不到），别占打字用的键；提示里的按键用 `keybindings.bindTooltip` 现查。

### 按钮

标题栏 `ILayout.addTitleBarItem('left' | 'right', el, order)`（例 `features/sessions`）；选区旁按钮登记到 `MenuId.EditorSelection`（例 `features/comments`）；插件页面右键 `MenuId.WebviewContext`。样式用现成 class（`icon-button`、`button`、`button secondary`），颜色只用 `var(--vscode-*)`。

### 设置

```ts
const settings = services.get(ISettings);
subscriptions.add(settings.register([
  { key: 'vilaus.myFeature.enabled', section: SettingsSection.workbench, schema: { type: 'boolean', default: true, description: t('enabledSetting') } },
]));
settings.get('vilaus.myFeature.enabled', true);
subscriptions.add(settings.onDidChange((keys) => { /* keys.includes(...) 时重新应用 */ }));
```

中文标题在 `src/features/settings/messages.ts` 的 `settingTitleName`。主进程也读的设置：键名和默认值放 `src/platform/`（如 `platform/defaults.ts`），主进程在 `shellApp.ts` 的 `settingsChanged` 里响应。

### 本地接口的操作

渲染进程模块（无须动主进程和协议）：

```ts
subscriptions.add(services.get(ILocalApi).register({
  name: 'myFeature.greet',            // <模块>.<动词>，不能重名
  access: 'write',                    // read | write | send：照实填，管理员实例只读和发送开关靠它把关
  description: 'Shows a greeting.',   // 英文一句，GET /v1 列出
  params: { name: 'string: who to greet' },
  handle: (params) => {
    const name = requiredString(params, 'name');   // 参数工具（platform/localApi.ts）出错即 400
    return { greeted: name };                      // 返回值转 JSON；抛 ApiError(status, code, message) 回该状态
  },
}));
services.get(ILocalApi).emit('myFeature.greeted', { name });   // 事件流里是 {window, data}
```

调用带 `window` 参数交给那个窗口，否则交给最近用的窗口。例：`features/localApi` 的 `commands.list` / `commands.run`。要用主进程才有的东西（窗口、会话记录、文件系统）时在 `src/host/main/localApiOperations.ts` 加（检查参数，事情交给 `ShellApp` 实现的 `OperationsHost`），同时更新 `local-api.md`。

### 插件页面里加东西

1. 页面知识（选择器、类名）写进 `bridge.ts`：`protocol.ts` 的 `WebviewPageHints` 加字段，`bridge.pageHints()` 按页面（viewType）给出，注明插件版本。
2. 页面脚本 `src/host/webview/<名字>.ts`，`bootstrap.ts` 见到对应提示才装。插件用 React 频繁重画：用 `MutationObserver` 跟随，不改 React 管的节点，用 `data-vilaus-*` 属性 + bridge 样式。
3. 页面 → 壳：`WebviewToShellMessage`（渲染进程收）；壳 → 页面：`ShellToWebviewControl`；页面 → bridge 的应答：走插件消息通道并带标记，由 `interceptFromWebview` 截下（例 `promptSubmit.ts` 的 `PromptSubmitReply`）。

例：`messageMarkers.ts`、`sessionRows.ts`、`conversationQuotes.ts`、`promptSubmit.ts`。

### 截插件的请求

`bridge.ts`：`interceptFromWebview`（页面 → 插件，返回 true 即吞掉）、`observeToWebview`（插件 → 页面，可返回改过的副本）。注明插件版本。

### 跨进程消息

在 `protocol.ts` 对应表加方法（`MainApiForRenderer`、`MainApiForExtHost`、`ExtHostApiForMain`、`ExtHostApiForRenderer`、`RendererApiForExtHost`、`MainEventsForRenderer`），两端 `handle` / `call`。主进程处理渲染进程调用在 `shellApp.ts` 的 `registerRendererHandlers`，渲染进程 `native.call(...)`。

### 缺的 VS Code API

按 `shim-unimplemented.log` 在 `src/compat/vscode/` 对应命名空间文件实现；插件执行的内置命令（`workbench.action.*` 等）在 `src/host/exthost/workbenchCommands.ts`。

## 打包

`npm run package` → `release\Vilausity-Setup-<版本>.exe` 和 `release\win-unpacked\`；之后 `dist\` 是正式构建，`npm run build` 换回。版本在 `package.json`。未签名（SmartScreen 拦一次）。`APP_ID`（`platform/product.ts`）不能改：同一 `APP_ID` 的安装包互相覆盖，数据目录 `%APPDATA%\Vilausity` 不变。

## 跟上游同步

`git remote add upstream https://github.com/Teabie666/vilausity-claude-code-gui-shell.git`（一次）→ `git fetch upstream` → `git merge upstream/main`。功能尽量放在独立模块目录、少改现有文件，冲突就少。

## 插件升级后

1. `npm run smoke` 或手动发消息、审批改文件、权限确认。
2. 新版本跑起来后看 `shim-unimplemented.log` 的新条目，补实现。
3. 壳在插件页面加的东西失效 → 多半类名变了：改 `bridge.ts` 对应页面提示的选择器和注明的版本。
4. 汉化：`npm run nls`（需要本地插件文字清单，见 ARCHITECTURE"插件界面汉化"）。
