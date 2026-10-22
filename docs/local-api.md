# 本地接口（local API）

让这台电脑上的别的程序（脚本、机器人、快捷键工具、Stream Deck 之类）知道 Vilausity 在干什么，并替你做几件事：看有哪些窗口、每个对话是在干活还是在等你、打开文件夹 / 文件 / 对话、把提示词填进输入框或直接发出去、执行壳的命令。

它是 127.0.0.1 上的 HTTP 接口，只有本机的程序连得上，而且要带上密钥。默认关着。

想给 Vilausity 加自己的接口，看 [二次开发指南](DEVELOPING.md) 里"加一个本地接口的操作"。这个接口是怎么搭的见 [ARCHITECTURE](ARCHITECTURE.md) 的"本地接口"。

## 打开

设置（Ctrl+,）→"本地接口"：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 启用本地接口 `vilaus.api.enabled` | 关 | 开了才有接口 |
| 允许直接发送消息 `vilaus.api.allowSend` | 关 | 开了外部程序才能直接把消息发给 Claude（`conversations.send`）；关着时只能填进输入框，由你按回车 |
| 端口 `vilaus.api.port` | 0 | 0 = 系统挑一个空闲端口；想写死在配置里就填一个固定的 |

打开后，这一节顶上会显示地址（比如 `http://127.0.0.1:52344/v1`）和 `api.json` 在哪。

### api.json

地址和密钥写在 `%APPDATA%\Vilausity\api.json`：

```json
{
  "url": "http://127.0.0.1:52344/v1",
  "port": 52344,
  "token": "64 位十六进制",
  "pid": 12345,
  "version": "0.9.4",
  "elevated": false
}
```

- 每个请求都要带请求头 `Authorization: Bearer <token>`。
- 程序应该每次从这个文件读地址和密钥，不要写死（端口默认每次启动都可能不同）。
- 关掉接口时文件不删，密钥一直沿用；想换新密钥就删掉这个文件，再关开一次接口。
- 密钥就是钥匙：谁拿到它，谁就能在你的 Vilausity 里打开对话、执行命令（开了发送的话还能让 Claude 干活）。别把它发给别人、别提交进仓库。

### 管理员实例

以管理员身份运行的 Vilausity 也能开接口，它的 `api.json` 在 `%APPDATA%\Vilausity\admin\api.json`，**只读**：只能看，不能打开、执行、发送。原因：同一个 Windows 用户下没提升权限的程序也读得到这个文件，不能让它们借提升过的 Vilausity 做事。

## 请求的格式

- 操作按名字调：`/v1/<名字>`，比如 `/v1/windows.list`。
- 只读的操作可以用 `GET`，参数放在查询串里（`?window=1`）；所有操作都可以用 `POST`，参数是一个 JSON 对象（UTF-8）。改东西的操作只能 `POST`。
- 成功：HTTP 200，返回结果的 JSON（没有结果时是 `null`）。
- 失败：对应的状态码，加 `{"error": "<短代码>", "message": "<说明>"}`。

| 状态码 | `error` | 什么情况 |
| --- | --- | --- |
| 400 | `bad_request` | 参数不对（缺了、类型不对、路径不是绝对路径） |
| 401 | `unauthorized` | 没带密钥或密钥不对 |
| 403 | `forbidden` | 网页发来的请求；管理员实例里改东西；发送没开 |
| 404 | `unknown_operation`、`no_window`、`not_found`、`unknown_command` | 没有这个操作 / 窗口 / 文件夹或文件 / 命令 |
| 405 | `method_not_allowed` | 改东西的操作用了 GET |
| 409 | `disabled`、`input_not_empty`、`not_sent`、`busy_elsewhere` | 现在做不了（见各操作） |
| 504 | `timeout`、`no_input` | 窗口没及时回答 |
| 500 | `internal` | 程序内部出错（日志里有详情） |

网页里的脚本用不了这个接口：带 `Origin` 请求头的请求（浏览器发跨源请求都带）一律拒绝。

### 例子

PowerShell（Windows 自带的 5.1 也行）：

```powershell
$api = Get-Content "$env:APPDATA\Vilausity\api.json" -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($api.token)" }
# 看
Invoke-RestMethod "$($api.url)/windows.list" -Headers $headers
# 改：PowerShell 5.1 发字符串会丢中文，所以先转成 UTF-8 字节
$body = [Text.Encoding]::UTF8.GetBytes((@{ prompt = '看看 build 为什么失败' } | ConvertTo-Json))
Invoke-RestMethod "$($api.url)/conversations.open" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
```

curl（Windows 10 以后自带 `curl.exe`）：

```bat
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/v1/windows.list
```

Python（只用标准库）：

```python
import json, os, urllib.request

api = json.load(open(os.path.expandvars(r'%APPDATA%\Vilausity\api.json'), encoding='utf-8'))
# 不走系统代理：127.0.0.1 的请求交给代理软件可能会失败
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def call(name, **params):
    request = urllib.request.Request(
        f"{api['url']}/{name}",
        data=json.dumps(params).encode('utf-8'),
        headers={'Authorization': f"Bearer {api['token']}", 'Content-Type': 'application/json'},
    )
    with opener.open(request) as response:
        return json.load(response)

print(call('windows.list'))
```

仓库里的 [`examples/local-api/`](../examples/local-api/) 有能直接跑的例子。

## 操作

`GET /v1` 列出全部操作（名字、权限、参数说明、现在能不能用），还有版本、插件版本、是不是管理员实例、发送开没开。下面是内置的这些；功能模块可以自己加（见二次开发指南），以 `GET /v1` 列出的为准。

参数 `window` 都是可选的：`windows.list` 里的窗口 `id`，不给就是最近用过的那个窗口。

### 只读

**`windows.list`**：打开的窗口。

```json
[
  {
    "id": 1,
    "folder": "C:\\Users\\me\\project",
    "active": true,
    "provider": { "id": "deepseek", "name": "DeepSeek", "type": "compatible" },
    "activeSessionId": "3b3e8d9d-…",
    "conversations": [{ "sessionId": "3b3e8d9d-…", "title": "修 build", "state": "running" }]
  }
]
```

- `id`：这次启动以来按打开顺序编的号（1、2…），重启后重新编。
- `active`：最近用过的窗口，不指定窗口的调用都去它那里。
- `activeSessionId`：窗口里在前面的那个对话。
- `conversations[].state`：`running`（Claude 在干活，或有后台任务在跑）、`waiting`（在等你：权限确认、提问）、`idle`。刚新建、还没发过消息的对话也在里面，标题是空的。

**`sessions.search`**：搜 Claude Code 的会话（标题、对话内容、读过改过的文件），参数 `query`（不给 = 最近的）、`folder`（只要在这个文件夹里跑的）、`limit`（默认 20，最多 100）。返回 `[{sessionId, title, folder, updatedAt, match}]`，跟标题栏搜索框搜的是同一份。

**`usage.get`**：窗口当前 API 接口的费用，跟会话列表顶上那块一样（壳自己算钱的接口才有，订阅和 Claude 自家的 API 返回 `null`）。返回 `{provider, currency, conversation, workspace, all}`，后三个各有 `cost`、`calls`、`unpricedModels`（没填价格的模型）和按模型的明细。

**`commands.list`**：壳的命令（命令面板和快捷键设置里列的那些）：`[{id, title, category, enabled}]`。

### 改东西（`write`）

**`windows.focus`** `{window}`：把窗口提到前面。

**`folders.open`** `{folder}`：在自己的窗口里打开一个文件夹（绝对路径）；已经有窗口在显示它，就把那个窗口提到前面。返回 `{window}`。

**`files.open`** `{path, line?, column?}`：在编辑器里打开文件（绝对路径），用文件夹包含它的那个窗口，没有就用最近的窗口。返回 `{window}`。

**`conversations.open`** `{sessionId?, prompt?, folder?, window?}`：打开对话。

- 给 `sessionId`：打开这个会话（已经有标签页在显示就提到前面）。会话要在它自己的文件夹里打开：从 `sessions.search` 拿到的会话用它的 `folder`。
- 给 `prompt`：填进输入框，不发出去。
- 都不给：新对话。
- `folder`：在这个文件夹的窗口里开（没有就新开一个窗口）；`window`：在这个窗口里开。两个只能给一个。
- 返回 `{window}`。

**`commands.run`** `{command, args?, window?}`：执行一个壳的命令，跟在命令面板里执行一样。只认 `commands.list` 里有的；现在不能执行（条件不满足）的回 409 `disabled`。

### 发送（`send`，要开"允许直接发送消息"）

**`conversations.send`** `{prompt, sessionId?, folder?, window?}`：把 `prompt` 发给 Claude，跟你在输入框里打字、按回车一样。

- 给 `sessionId`：发到这个会话。它已经在某个窗口里开着，就发到那个窗口（不管 `window` 参数）；没开就先打开（同 `conversations.open`）。
- 不给：开一个新对话发出去。
- 输入框里已经有别的字（你打了一半的），不会覆盖，回 409 `input_not_empty`。
- 会话正被别的程序占着（另一个 Vilausity 实例、VS Code、命令行）回 409 `busy_elsewhere`：同一个会话不能有两个 Claude 进程。
- 页面没把消息收走（比如 Claude 正停在一个需要你回答的提问上）回 409 `not_sent`；20 秒内等不到输入框回 504 `no_input`。
- 返回 `{window, sessionId}`；新对话的 `sessionId` 在发出后才确定，偶尔会没有，可以看事件流里新出现的对话。

## 事件流

`GET /v1/events`（同样要带密钥）是一个不断开的 [SSE（server-sent events）](https://developer.mozilla.org/docs/Web/API/Server-sent_events/Using_server-sent_events) 流，每个事件两行：

```
event: conversation.state
data: {"window":1,"folder":"C:\\project","sessionId":"…","title":"修 build","state":"waiting","previous":"running"}
```

- 连上先收到一行注释 `: connected` 和一个 `windows` 事件（当前的窗口，跟 `windows.list` 一样）。每 25 秒有一行注释 `: ping`，读的时候跳过以 `:` 开头的行。
- **`windows`**：窗口有变化（开关窗口、换接口、换文件夹、换前台窗口、对话变了）时，整份新的窗口列表。短时间内的几次变化合成一份。
- **`conversation.state`**：某个对话的状态变了。新出现的对话没有 `previous`；关掉的（标签页关了、窗口关了、插件进程重启）`state` 是 `closed`。
  - Claude 在等你：`state` 是 `waiting`。
  - 一轮做完：`previous` 是 `running`、`state` 是 `idle`。
- 功能模块自己发的事件：名字是 `<模块>.<事件>`，数据是 `{window, data}`。

## 跟 Claude Code 自己的 hooks 怎么分工

Claude Code 有自己的 [hooks](https://docs.claude.com/en/docs/claude-code/hooks)：在 `~/.claude/settings.json` 里配，Claude 等你确认（`Notification`）、一轮结束（`Stop`）、用工具前后之类的时候跑一条命令。它跟着 Claude Code 走，在命令行、VS Code、Vilausity 里都生效，每个会话各跑各的。

- 只想"Claude 等我 / 做完了就提醒我"：用 hooks 就够了，不用开本地接口。
- 要看 Vilausity 整体的样子（几个窗口、每个对话在干嘛）、要从外面操作 Vilausity（打开文件夹和对话、填提示、执行命令、发消息）：用本地接口。
- 两个也可以一起用：hooks 管提醒，本地接口管操作。
