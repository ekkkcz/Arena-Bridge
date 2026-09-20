# Arena Bridge 桌面版

将 Arena 页面、本地 MCP 服务、连接隧道和操作面板整合在一个窗口中。
你可以选择本机项目目录、调整读写与执行权限，并查看模型识别和自动抽卡状态。

桌面版使用 **Electron**（Chromium 内核）提供独立浏览器窗口，无需使用日常的 Edge 或 Chrome。
安装和使用步骤见[项目首页](../README.md#快速开始)。

## 为什么用 Electron

| 方案 | 运行时体积 | 内核 | 许可 | 可魔改 |
| --- | --- | --- | --- | --- |
| **Electron** | ~370 MB（开发）/ ~150 MB（打包） | Chromium | **MIT 全开源** | ★★★★★ 源码可随意改 |
| WebView2 | ~2 MB | Edge 内核（系统自带） | 运行时**闭源** | ★★☆ 只能调 API |
| CEF | ~150 MB | Chromium | BSD | ★★★★ 但构建很麻烦 |
| Ultralight / Sciter | ~10 MB | **非** Chromium | 部分开源 | ★ 扩展脚本不兼容 |

**关键点**：本项目的探针（`extension/probe.js`）是**纯页面脚本**，
已实测**不依赖任何 `chrome.*` 扩展 API**，所以能原样注入任何 Chromium 内核。

## 启动

```cmd
start-desktop.cmd
```

## 实现原理

```
desktop/app/
├─ package.json      Electron 应用的入口定义
├─ main.cjs          主进程：开窗口、独立 session 分区、加载 arena.ai
└─ preload.cjs       把 extension/probe.js 注入页面 MAIN world
```

**注入方式**：preload 里读取 `probe.js` 源码，用 `<script>` 标签插入页面。
这样脚本就获得了真正的 MAIN world 执行环境，与扩展 content script 等效，
因此能挂钩页面的 `fetch` / `XHR` / `EventSource`。

**会话隔离**：使用 `persist:arena-bridge` 独立分区，
**不读取、不影响**你日常浏览器的登录态和 Cookie。

## 踩过的坑

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `app is undefined` | 环境变量 `ELECTRON_RUN_AS_NODE=1` 让 Electron 退化成纯 Node | 启动前清除该变量 |
| `Unable to load preload script` / `module not found: node:fs` | preload 默认在沙箱里，读不了文件 | `sandbox: false` |
| `require("electron")` 返回 undefined | 文件不在 Electron 应用根目录 | 用 `--app <目录>` + 目录内有 `package.json` |

这三条都已在代码里处理好了。

## 实测结果

在真实 `https://arena.ai/agent` 上验证：

```
[arena-bridge] 探针已注入 (30298 字符)
PAGE_LOADED
SELFTEST_URL=https://arena.ai/agent
SELFTEST_HUD=true          <- 面板出现
SELFTEST_ALIVE=true        <- 探针工作
[amp] v3 就绪（单脚本 · 直连 Trigger.dev）
```
