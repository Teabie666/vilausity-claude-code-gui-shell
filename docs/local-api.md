# 本地接口（local API）参考

Vilausity 给本机其他程序的 HTTP 接口：读窗口和对话状态，打开文件夹 / 文件 / 对话，执行壳的命令，发送消息，订阅事件。实现见 `ARCHITECTURE.md`"本地接口"；加新操作见 `DEVELOPING.md`"本地接口的操作"。

## 开关与发现

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `vilaus.api.enabled` | `false` | 开启服务 |
| `vilaus.api.allowSend` | `false` | 允许 `send` 类操作（`conversations.send`） |
| `vilaus.api.port` | `0` | 端口；0 = 系统分配。固定端口被占时改用随机端口 |

- 发现文件：`%APPDATA%\Vilausity\api.json`；管理员实例 `%APPDATA%\Vilausity\admin\api.json`；`npm run dev` 的开发实例 `<仓库>\.test-data\dev\api.json`。内容 `{url, port, token, pid, version, elevated}`，`url` 形如 `http://127.0.0.1:<port>/v1`。
- 每次从文件读 `url` 和 `token`，不要缓存端口。服务停止时文件保留，`token` 沿用到文件被删。
- 管理员实例（`elevated: true`）只读：`write`、`send` 一律 403。
- 只听 127.0.0.1。带 `Origin` 请求头的请求、`Host` 不是 `127.0.0.1:<port>` / `localhost:<port>` 的请求一律 403（网页用不了）。

## 请求

- 鉴权：`Authorization: Bearer <token>`，否则 401。
- `GET /v1`：`{app, version, extension: {version} | null, elevated, allowSend, docs, operations: [{name, access, description, params, available}]}`。以它为准（功能模块可以加操作）。
- `GET /v1/<name>?k=v`：只限 `read` 操作；查询串值都是字符串，参数工具把 `"12"`、`"true"` 当数字、布尔。
- `POST /v1/<name>`：任何操作；body 是 UTF-8 JSON 对象（空 body = `{}`，上限 1 MB）。
- 成功 200 + 结果 JSON（无结果为 `null`）。失败 `{error, message}`：

| 状态 | `error` |
| --- | --- |
| 400 | `bad_request`（缺参数、类型错、路径不是绝对路径、操作名编码坏） |
| 401 | `unauthorized` |
| 403 | `forbidden`（网页请求、管理员实例写、发送没开） |
| 404 | `unknown_operation`、`no_window`、`not_found`、`unknown_command` |
| 405 | `method_not_allowed`（非 read 操作用了 GET） |
| 409 | `disabled`（命令此刻不能执行）、`input_not_empty`、`not_sent`、`busy_elsewhere` |
| 413 | `too_large` |
| 500 | `internal` |
| 504 | `timeout`（窗口 30 秒没回答 / 插件 60 秒没起来）、`no_input` |

公共参数 `window`（可选）：`windows.list` 的窗口 id；缺省 = 最近用的窗口。路径参数必须是绝对路径。

## 操作

| 名字 | 权限 | 参数 | 返回 |
| --- | --- | --- | --- |
| `windows.list` | read | — | `ApiWindow[]` |
| `sessions.search` | read | `query?`、`folder?`（只要在此文件夹跑的）、`limit?`（默认 20，最多 100） | `[{sessionId, title, folder, updatedAt, match?}]`，空 `query` = 最近的 |
| `usage.get` | read | `window?` | `{provider: {id, name}, currency, conversation: Scope \| null, workspace: Scope, all: Scope}`；订阅、Claude 自家 API（插件自己算钱的）返回 `null` |
| `commands.list` | read | `window?` | `[{id, title, category?, enabled}]`（有标题的壳命令） |
| `windows.focus` | write | `window` | `{window}` |
| `folders.open` | write | `folder` | `{window}`：新窗口，或已显示它的窗口提到前面 |
| `files.open` | write | `path`、`line?`、`column?` | `{window}`：文件夹包含它的窗口，否则最近的窗口 |
| `conversations.open` | write | `sessionId?`、`prompt?`、`folder?` \| `window?` | `{window}` |
| `commands.run` | write | `command`、`args?`（数组）、`window?` | `{command}` |
| `conversations.send` | send | `prompt`、`sessionId?`、`folder?` \| `window?` | `{window, sessionId}` |

- `ApiWindow`：`{id, folder, active, provider: {id, name, type}, activeSessionId?, conversations: [{sessionId, title, state}]}`。`id` 是本次启动内按打开顺序的编号。`active` = 最近用的窗口。`state`：`running`（Claude 在干活或有后台任务）、`waiting`（等用户：权限、提问）、`idle`。新建未发消息的对话也在列表里，`title` 为空。
- `Scope`：`{cost, calls, unpricedModels, models: {<模型>: {input, output, cacheRead, cacheWrite, calls, cost | null}}}`，金额用 `currency`。
- 对话的目标窗口：`sessionId` 已在某窗口打开 → 那个窗口（不管 `folder` / `window`）；否则 `folder` 的窗口（没有就新开），否则 `window`，否则最近的窗口。`folder` 和 `window` 不能同时给。会话要在它自己的文件夹打开（`sessions.search` 结果的 `folder`）。
- `conversations.open`：给 `sessionId` = 打开这个会话（已显示则提到前面）；给 `prompt` = 填进输入框，不发送；都不给 = 新对话。
- `conversations.send`：等同用户在输入框打字、按回车；不给 `sessionId` = 新对话。输入框里已有别的文字 → 409 `input_not_empty`（不覆盖）；页面没收走消息（比如停在等用户回答的提问上）→ 409 `not_sent`；会话被别的进程占着（另一个实例、VS Code、CLI）→ 409 `busy_elsewhere`；20 秒内没有输入框 → 504 `no_input`。新对话的 `sessionId` 偶尔为 `null`，可从事件流里新出现的对话拿。
- `commands.run`：只认 `commands.list` 里的命令；插件自己的命令不在其中。

## 事件流

`GET /v1/events`（要鉴权），SSE。每个事件 `event: <name>\ndata: <单行 JSON>\n\n`；以 `:` 开头的行是注释（连上时 `: connected`，之后每 25 秒 `: ping`）。

- `windows`：连上时发一次，之后窗口有变化时（开关窗口、换接口、换文件夹、换最近用的窗口、对话变化；50 ms 内合并）发完整的 `ApiWindow[]`。
- `conversation.state`：`{window, folder, sessionId, title, state, previous?}`。新出现的对话没有 `previous`；关掉的（标签页关闭、窗口关闭、插件进程重启）`state: "closed"`。等用户 = `state: "waiting"`；一轮结束 = `previous: "running"` 且 `state: "idle"`。
- 模块事件 `<模块>.<事件>`：`{window, data}`。

## 调用要点

- Windows PowerShell 5.1：`Invoke-RestMethod -Body` 用字符串会丢非 ASCII 字符，传 `[Text.Encoding]::UTF8.GetBytes(json)` 并设 `-ContentType 'application/json; charset=utf-8'`；出错时响应体在 `$_.ErrorDetails.Message`。
- Python：`urllib` 用 `build_opener(ProxyHandler({}))` 绕开系统代理。
- 现成的例子：`examples/local-api/notify.py`（等用户 / 一轮结束时提示）、`examples/local-api/vilaus-api.ps1`（`Invoke-Vilaus <名字> @{...}`）。两者都认环境变量 `VILAUS_API_FILE`，用来指到别的实例的 `api.json`。

```powershell
$api = Get-Content "$env:APPDATA\Vilausity\api.json" -Raw | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($api.token)" }
Invoke-RestMethod "$($api.url)/windows.list" -Headers $h
$body = [Text.Encoding]::UTF8.GetBytes((@{ prompt = '...' } | ConvertTo-Json))
Invoke-RestMethod "$($api.url)/conversations.open" -Method Post -Headers $h -ContentType 'application/json; charset=utf-8' -Body $body
```

## 与 Claude Code hooks 的分工

Claude Code 的 hooks（`~/.claude/settings.json` 的 `hooks`：`Notification`、`Stop` 等）随 Claude Code 走，命令行、VS Code、Vilausity 都生效，每个会话各自触发。只要"等我 / 做完了提醒我"用 hooks；要看 Vilausity 全局状态、从外部操作 Vilausity（打开、填提示、执行命令、发送）用本地接口。
