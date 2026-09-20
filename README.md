# Arena Bridge

让 **Arena** 里的网页 Agent 能像 Codex / Claude Code 那样读写文件、跑命令，
而不只是聊天。

Arena 的 Agent 模式本来就会调工具，只是碰不到你本机的文件 —— 这个工具把这段接上，
走的是你已有的 Arena 账号。

顺带解决了 Arena 自己不做的一件事：**它不告诉你这一轮用的是哪个模型**。
这里实时显示真实模型名与思考强度，于是能靠「抽卡」刷到高级模型再干活：

```
claude-opus-5-max      gpt-6-astra-max
claude-fable-5.1-high  gpt-5.6-luna-xhigh
```

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)

![工作流](docs/screenshots/workflow.webp)

左：Arena 对话与工具调用　中：面板（`claude-opus-5` / 思考强度 **HIGH**）　右：它在你本机写出的页面

---

## 快速开始

### 桌面版（推荐）

下载或克隆后，双击 **`start-desktop.cmd`**。
首次运行会自动装 Electron（约 300 MB，只需一次），然后开窗口。

等右侧面板出现 → 点 **一键连接并开工** → 派活。

> 想用命令行装：`npm install` 后双击 `Arena Bridge.vbs`（无黑框）。
> 访问密钥首次运行自动生成在 `.arena-bridge/config.json`，**不入库**。

**适合**你自己的项目、脚本、调试、原型 —— 有人在旁边看着的活。
**别拿它跑无人值守的生产负载**：模型每轮随机分配、隧道地址每次重启都变、平台没有 SLA。
（要稳定跑生产，还是得用官方 API —— 这工具的定位是「先免费用上，再决定要不要买」。）

### 命令行版

```bash
node server/cli.mjs                    # 只读（先从这个开始）
node server/cli.mjs --write            # + 写文件
node server/cli.mjs --write --exec     # + 执行命令
node server/cli.mjs --dir "D:\proj"    # 指定目录
node server/cli.mjs --no-tunnel        # 仅本机
```

这是**标准 MCP 服务端**（零依赖，只用 Node 内置模块），任何支持 MCP 的客户端都能连 ——
不像桌面版那样绑死 Arena。启动后会打印一段可直接粘贴的内容：

```
https://xxxx.trycloudflare.com/mcp/<密钥>

连接这个 MCP。工作目录是 C:\...\example-workspace
请先调用 get_project_info 确认，然后告诉我你能看到哪些工具。
```

> 让它**第一句就调用工具**（如 `get_project_info`）——模型一调用，模型名更快出现。

---

## 两个功能

### 1 · 把本机交给 AI Agent

MCP 服务 + cloudflared 免费隧道都内置，无需账号。权限分三级，默认只读：

| 启动参数 | 可用工具 |
| --- | --- |
| *(无)* | `get_project_info` `list_files` `read_file` `search` |
| `--write` | 上面 + `write_file` `apply_patch` |
| `--write --exec` | 上面 + `run_command` |

安全：目录边界（越界即拒）、命令白名单（不用 shell 拼接）、读写各 512 KB 上限。

### 2 · 看穿这一轮抽到了什么模型

Arena 每开新对话就随机分配模型，顶级模型**不可选**，而且**界面不显示用的是哪个**。
这个工具把模型名读出来，于是玩法变成：

```
新开对话 → 发一句「你好」 → 看面板
   ├─ 好牌 → 留在这一轮干活
   └─ 烂牌 → 点「开始抽卡」自动连抽
```

**10~20 秒**就够，别等它做完项目：

| 阶段 | 耗时 |
| --- | --- |
| 快速通道（消息流里的模型名） | **1~2 秒** |
| 权威确认（Trigger.dev run trace） | 2~5 秒 |

![思考强度](docs/screenshots/thinking-effort.webp)

模型名 `gpt-5.6-sol` **不带**档位后缀，面板仍读出 **XHIGH** —— 来自 run trace 的 span 详情。

抽卡可设轮数（1–200）、目标关键字（`opus,gpt-6`，大小写无关的子串匹配）、命中即停。
命中后停在那个对话上不切走，直接派活即可。

---

## 为什么合规

|  | 反代类（chat2api 等） | **本项目** |
| --- | --- | --- |
| 谁发请求 | 你的程序冒充浏览器 | **平台自己的 Agent** |
| 要不要凭据 | 窃取 Cookie / 代解验证码 | **完全不碰** |
| 要不要绕过限制 | 隐藏模型、伪造指纹 | **不需要** |

没有绕过任何东西——网页 Agent 本来就会调工具，这里只是多给它一个工具源。

---

## 常见问题

**地址会变吗？**　Quick Tunnel 每次启动都变。要固定就换 Named Tunnel 或 ngrok。

**国内连不上？**　cloudflared 走 QUIC/UDP 7844，普通 HTTP 代理**无效**，需要 TUN/全局代理。

**面板不显示模型名？**　① 确认在 **Agent 模式**；② **刷新页面**（改扩展后必须 F5）；③ 让它先调用一次工具；④ 控制台跑 `window.__amp3State()`。

**安全吗？**　地址=钥匙，别发到公开场合。从只读开始，确认可控再放权。

**需要什么？**　Node.js 18+。cloudflared 可选——没有它就只能本机/局域网用：

```bash
winget install --id Cloudflare.cloudflared --exact
```

---

## 目录结构

```
arena-bridge/
├─ start-desktop.cmd     ★ 双击这个（首次会自动 npm install）
├─ Arena Bridge.vbs      静默启动（无黑框；已装好依赖后用）
├─ desktop/
│  ├─ launcher/          原生启动器 Arena Bridge.exe（C#，45 KB）
│  └─ app/
│     ├─ main.cjs        主进程：内置 MCP + 隧道 + 探针注入 + 抽卡引擎
│     └─ preload.cjs     ★ 唯一的 UI：跟随 Arena 设计变量的右侧面板
├─ server/               命令行版
│  ├─ cli.mjs
│  └─ lib/{mcp,tools,tunnel,config}.mjs
├─ extension/            浏览器扩展（命令行版配它看模型名）
├─ example-workspace/    默认项目目录
└─ docs/                 调研 · 实测 · 截图
```

---

## 实测

| 项 | 结果 |
| --- | --- |
| 官方 MCP SDK 客户端连接 | ✅ |
| 只读 / 读写 / 执行 三档 | ✅ 4 / 6 / 7 个工具 |
| 目录越界 · 命令白名单 | ✅ 均被拒 |
| Arena Agent 读写本机文件 | ✅ |
| Arena Agent 修 bug 至测试全绿 | ✅ 9/9 |
| 模型名识别 | ✅ opus-5 / gpt-5.5 / gpt-5.6-sol / gpt-6-astra-* |
| 思考强度解析 | ✅ 15 个真实模型名全通过 |
| 面板跟随 Arena 主题 | ✅ 浅色 ↔ 深色 |
| 隧道断线保护 | ✅ 未就绪时锁按钮（防 1033） |

更详细的过程见 [docs/实测报告.md](docs/实测报告.md) 与 [docs/调研报告.md](docs/调研报告.md)。

---

## 链接

- [docs/实测报告.md](docs/实测报告.md) —— MCP 通路实测原始输出
- [docs/调研报告.md](docs/调研报告.md) —— 原理、收费模式、可行性评估
- [desktop/README.md](desktop/README.md) —— Electron 方案取舍与踩坑

MIT © 2026 ekkkcz
