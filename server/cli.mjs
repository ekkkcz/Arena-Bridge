#!/usr/bin/env node
// 一条命令启动：MCP 服务 + 免费公网隧道，并打印可直接粘贴给网页 AI 的提示词。
import path from "node:path";
import { load, save } from "./lib/config.mjs";
import { createTools } from "./lib/tools.mjs";
import { createMcpServer } from "./lib/mcp.mjs";
import { startTunnel } from "./lib/tunnel.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const cfg = load();
let dirty = false;

if (has("--write")) { cfg.allowWrite = true; dirty = true; }
if (has("--exec")) { cfg.allowExec = true; dirty = true; }
if (has("--readonly")) { cfg.allowWrite = false; cfg.allowExec = false; dirty = true; }
// --no-tunnel 只对本次运行生效，不写进配置（否则下次会莫名跳过隧道）
const noTunnel = has("--no-tunnel");
if (val("--dir")) { cfg.projectDir = path.resolve(val("--dir")); dirty = true; }
if (val("--port")) { cfg.port = Number(val("--port")); dirty = true; }
if (dirty) save(cfg);

const c = {
  dim: (s) => "\x1b[2m" + s + "\x1b[0m",
  b: (s) => "\x1b[1m" + s + "\x1b[0m",
  g: (s) => "\x1b[32m" + s + "\x1b[0m",
  y: (s) => "\x1b[33m" + s + "\x1b[0m",
  r: (s) => "\x1b[31m" + s + "\x1b[0m",
  cy: (s) => "\x1b[36m" + s + "\x1b[0m",
};
const rule = () => console.log(c.dim("─".repeat(74)));

console.log("");
console.log(c.b("  Arena Bridge") + c.dim("  ·  让网页 AI Agent 直接读写你的本机项目"));
rule();
console.log("  项目目录   " + c.cy(cfg.projectDir));
console.log("  权限       " + (cfg.allowWrite ? c.g("读 + 写") : c.y("只读")) +
  (cfg.allowExec ? c.r(" + 执行命令") : ""));
console.log("");

const tools = createTools(cfg, (m) => console.log("  " + c.dim(m)));
const server = createMcpServer({
  tools,
  token: cfg.token,
  port: cfg.port,
  onLog: (m) => console.log("  " + c.dim(m)),
});

let port;
try {
  ({ port } = await server.listen());
} catch (e) {
  console.error(c.r("  启动失败: " + e.message));
  console.error(c.dim("  端口被占用？换一个： node cli.mjs --port 8899"));
  process.exit(1);
}

console.log("  " + c.g("✓") + " MCP 服务   127.0.0.1:" + port + "/mcp");
console.log("  " + c.g("✓") + " 可用工具   " + tools.map((t) => t.name).join(", "));
console.log("");

if (noTunnel) {
  console.log("  " + c.y("已跳过隧道") + c.dim("（--no-tunnel）"));
  console.log("  本机地址   " + c.cy("http://127.0.0.1:" + port + "/mcp/" + cfg.token));
  console.log("");
} else {
  console.log("  正在申请公网地址" + c.dim("（cloudflared，免费、无需账号）…"));
  const tunnel = startTunnel({
    localPort: port,
    onLog: (m) => console.log("  " + c.dim(m)),
    onUrl: (url) => {
      console.log("");
      rule();
      console.log("  " + c.b(c.g("就绪")) + "  把下面这段整段复制，粘进网页 AI 的聊天框：");
      console.log("");
      console.log("  " + c.b(c.cy(url + "/mcp/" + cfg.token)));
      console.log("");
      console.log("  连接这个 MCP。工作目录是 " + cfg.projectDir);
      console.log("  请先调用 get_project_info 确认，然后告诉我你能看到哪些工具。");
      console.log("");
      rule();
      console.log(c.dim("  提示：让它先调用一次工具，浏览器面板上的模型名会更快出现。"));
      console.log(c.dim("  注意：这个地址等于你电脑的钥匙，不要发到公开场合。"));
      console.log("");
    },
  });
  const shutdown = () => {
    console.log("\n  正在停止…");
    tunnel.stop();
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
