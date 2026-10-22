# 本地接口的例子

先在 Vilausity 里打开本地接口：设置（Ctrl+,）→"本地接口"→"启用本地接口"。接口的说明见 [docs/local-api.md](../../docs/local-api.md)。

| 文件 | 做什么 |
| --- | --- |
| [notify.py](notify.py) | 一直听着事件流，Claude 在等你（权限确认、提问）或一轮做完时打印一行、响一声。只用 Python 标准库：`python notify.py` |
| [vilaus-api.ps1](vilaus-api.ps1) | PowerShell 里按名字调操作：`. .\vilaus-api.ps1` 之后 `Invoke-Vilaus windows.list`、`Invoke-Vilaus conversations.open @{ prompt = '...' }`。Windows 自带的 PowerShell 5.1 也能用 |

两个例子默认读 `%APPDATA%\Vilausity\api.json`。连别的实例（比如 `npm run dev` 开的开发实例，它的在仓库的 `.test-data\dev\api.json`）就设环境变量 `VILAUS_API_FILE` 指到那个文件。

开着代理软件（系统代理）时：`notify.py` 已经设成不走代理；PowerShell 走系统代理，代理软件一般会放过 127.0.0.1，连不上的话在代理软件里把 127.0.0.1 加进"绕过"。
