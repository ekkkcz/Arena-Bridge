// Arena Bridge 桌面版 —— 一个程序搞定全部：
//   * 内置 Chromium 窗口打开 Arena（不依赖你日常的 Edge）
//   * 内置 MCP 服务（不需要另开终端）
//   * 内置 cloudflared 隧道（自动获取公网地址）
//   * 启动即在页面上注入探针，实时显示模型名与思考强度
const { app, BrowserWindow, shell, Menu, ipcMain, clipboard, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

/* ---------- GPU ----------
 * Electron 在 Windows 上经常因为「驱动黑名单」静默退化到软件渲染
 * （SwiftShader），表现就是整页都卡、越复杂的页面越明显。
 * 这几项是 Chromium 官方开关，属于"打开本该有的能力"，不是 hack。
 * 注意：必须在 app.whenReady() 之前调用。 */
app.commandLine.appendSwitch("ignore-gpu-blocklist");       // 忽略驱动黑名单
app.commandLine.appendSwitch("enable-gpu-rasterization");   // 用 GPU 做光栅化
app.commandLine.appendSwitch("enable-zero-copy");           // 零拷贝上传纹理
try { app.commandLine.appendSwitch("enable-features", "CanvasOopRasterization"); } catch (e) {}

/* 手动兜底：确认这台机器真的用不了 GPU（诊断日志里 softwareRendering=true）
   之后，把 .arena-bridge/config.json 里的 forceSoftwareRender 设成 true。
   这样就不用改代码 —— 也不会在"其实 GPU 好好的"时候把性能砍掉。 */
try {
  const _cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", ".arena-bridge", "config.json"), "utf8"));
  if (_cfg && _cfg.forceSoftwareRender) {
    app.disableHardwareAcceleration();
    console.log("[arena-bridge] forceSoftwareRender=true，已禁用硬件加速");
  }
} catch (e) {}

const ROOT = path.resolve(__dirname, "..", "..");
/* 窗口/任务栏图标。不设它的话，任务栏会用 electron.exe 自带的图标（那个原子球），
   看起来和我们这个程序完全没关系。必须给绝对路径，且 app.ico 是 7 帧多尺寸。 */
const APP_ICON = path.join(ROOT, "app.ico");
/* 版本号单一来源：package.json。面板与 MCP serverInfo 都用它。 */
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0"; }
  catch (e) { return "0.0.0"; }
})();
const CFG_DIR = path.join(ROOT, ".arena-bridge");
const CFG_FILE = path.join(CFG_DIR, "config.json");
const LOG = path.join(CFG_DIR, "desktop.log");

try { fs.mkdirSync(CFG_DIR, { recursive: true }); } catch (e) {}
/* 日志改成异步批量写。
   原来每条都 appendFileSync —— 同步磁盘 IO 会卡住主进程，
   而主进程一卡，所有渲染进程（也就是窗口）跟着卡。 */
let logQueue = [];
let logTimer = null;
function flushLog() {
  logTimer = null;
  if (!logQueue.length) return;
  const chunk = logQueue.join("\n") + "\n";
  logQueue = [];
  try { fs.appendFile(LOG, chunk, () => {}); } catch (e) {}
}
const say = (m) => {
  try {
    logQueue.push(new Date().toISOString() + "  " + m);
    if (logQueue.length > 400) logQueue = logQueue.slice(-200);   // 兜底，别撑爆内存
    if (!logTimer) logTimer = setTimeout(flushLog, 500);
  } catch (e) {}
};
// 退出前把没写完的刷掉
process.on("exit", () => { try { if (logQueue.length) fs.appendFileSync(LOG, logQueue.join("\n") + "\n"); } catch (e) {} });

// 诊断：确认 Electron 模块导出正常
try {
  const EL = require("electron");
  say("electron 模块: type=" + typeof EL + " | ipcMain=" + (typeof EL.ipcMain) +
      " | ELECTRON_RUN_AS_NODE=[" + (process.env.ELECTRON_RUN_AS_NODE || "未设置") + "]" +
      " | 返回值前40字符=" + String(EL).slice(0, 40));
} catch (e) { say("require electron 失败: " + e.message); }
say("=== 启动 (electron " + process.versions.electron + ") ===");
process.on("uncaughtException", (e) => say("UNCAUGHT: " + e.message + "\n" + (e.stack || "").split("\n").slice(0, 5).join("\n")));

/* ---------- 配置 ---------- */
const SKIP = new Set(["node_modules", ".git", ".arena-bridge", "dist", "build", ".next", "__pycache__", ".venv"]);
function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch (e) { c = {}; }
  const out = Object.assign({
    port: 8788, token: "", projectDir: path.join(ROOT, "example-workspace"),
    allowWrite: true, allowExec: false,
    allowedCommands: ["node", "npm", "npx", "pnpm", "yarn", "git", "python", "py", "tsc"],
    maxReadBytes: 524288, maxWriteBytes: 524288, maxOutputBytes: 65536, commandTimeoutMs: 180000,
  }, c);
  let dirty = false;
  if (!out.token) { out.token = crypto.randomBytes(24).toString("hex"); dirty = true; }
  if (!fs.existsSync(out.projectDir)) { try { fs.mkdirSync(out.projectDir, { recursive: true }); } catch (e) {} }
  if (dirty) fs.writeFileSync(CFG_FILE, JSON.stringify(out, null, 2) + "\n");
  return out;
}
const cfg = loadCfg();
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) {} };

/* ---------- 历史模型档案 ----------
 * models.json 是「对话 id → 模型」的种子文件（可由日志推导生成）。
 * 面板会把没人认领的条目并进它自己的 localStorage 档案，
 * 这样以前检测过、但当时还没做归档功能的对话也能显示出来。 */
let seedModels = {};
try {
  seedModels = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "models.json"), "utf8")) || {};
  say("历史模型档案: " + Object.keys(seedModels).length + " 条");
} catch (e) { seedModels = {}; }

/* ---------- 内置 MCP ---------- */
function buildTools(log) {
  const R = path.resolve(cfg.projectDir);
  const safe = (p) => { const a = path.resolve(R, String(p || ".")); if (a !== R && !a.startsWith(R + path.sep)) throw new Error("路径越界（只能访问项目目录）: " + p); return a; };
  const rel = (a) => path.relative(R, a).split(path.sep).join("/") || ".";
  const raw = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  const walk = (d, o, dep) => { o = o || []; dep = dep || 0; if (dep > 14 || o.length > 5000) return o;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return o; }
    for (const e of es) { if (SKIP.has(e.name)) continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f, o, dep + 1); else o.push(rel(f)); } return o; };
  const which = (b) => { if (path.isAbsolute(b)) return b; const ex = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    for (const d of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) for (const x of ex) { const c = path.join(d, b + x); try { if (fs.statSync(c).isFile()) return c; } catch (e) {} } return null; };
  const run = (cmd, args, ms) => new Promise((res) => {
    const bin = which(cmd); if (!bin) return res({ code: null, stdout: "", stderr: "", note: "找不到可执行文件: " + cmd });
    const shim = /\.(cmd|bat)$/i.test(bin);
    const ch = spawn(shim ? "cmd.exe" : bin, shim ? ["/d", "/s", "/c", bin].concat(args) : args, { cwd: R, shell: false, windowsHide: true });
    let o = "", e = "", done = false;
    const fin = (c, n) => { if (done) return; done = true; res({ code: c, note: n || null, stdout: o.slice(-cfg.maxOutputBytes), stderr: e.slice(-cfg.maxOutputBytes) }); };
    const t = setTimeout(() => { try { ch.kill(); } catch (x) {} fin(null, "超时"); }, ms);
    ch.stdout.on("data", (d) => { o += d; }); ch.stderr.on("data", (d) => { e += d; });
    ch.on("error", (x) => { clearTimeout(t); fin(null, "启动失败: " + x.message); });
    ch.on("close", (c) => { clearTimeout(t); fin(c); }); });

  const T = [
    { name: "get_project_info", description: "获取项目根目录、权限与工具清单。建议第一步调用。", inputSchema: { type: "object", properties: {} },
      handler: async () => raw({ projectDir: R, platform: process.platform, permissions: { read: true, write: !!cfg.allowWrite, exec: !!cfg.allowExec }, allowedCommands: cfg.allowExec ? cfg.allowedCommands : [] }) },
    { name: "list_files", description: "列出项目内所有文件。", inputSchema: { type: "object", properties: {} }, handler: async () => raw(walk(R).join("\n") || "(空目录)") },
    { name: "read_file", description: "读取项目内的文本文件。path 相对项目根目录。", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: async (a) => { const f = safe(a.path); if (fs.statSync(f).size > cfg.maxReadBytes) throw new Error("文件过大"); return raw(fs.readFileSync(f, "utf8")); } },
    { name: "search", description: "项目内文本搜索，返回 file:line: 内容。", inputSchema: { type: "object", properties: { query: { type: "string" }, regex: { type: "boolean" } }, required: ["query"] },
      handler: async (a) => { const re = new RegExp(a.regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); const h = [];
        for (const f of walk(R)) { if (h.length >= 60) break; let t; try { t = fs.readFileSync(path.join(R, f), "utf8"); } catch (e) { continue; }
          const ls = t.split(/\r?\n/); for (let i = 0; i < ls.length && h.length < 60; i++) if (re.test(ls[i])) h.push(f + ":" + (i + 1) + ": " + ls[i].trim().slice(0, 200)); }
        return raw(h.join("\n") || "(无匹配)"); } },
  ];
  if (cfg.allowWrite) {
    T.push({ name: "write_file", description: "写入/覆盖项目内文本文件。", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      handler: async (a) => { const f = safe(a.path); const b = Buffer.byteLength(a.content, "utf8"); if (b > cfg.maxWriteBytes) throw new Error("内容过大");
        const ex = fs.existsSync(f); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, a.content, "utf8");
        log("写入 " + rel(f) + " (" + b + " 字节)"); return raw({ ok: true, path: rel(f), bytes: b, created: !ex }); } });
    T.push({ name: "apply_patch", description: "替换文件中的一段文本（old_string 必须唯一）。", inputSchema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] },
      handler: async (a) => { const f = safe(a.path); const bf = fs.readFileSync(f, "utf8"); const n = bf.split(a.old_string).length - 1;
        if (n === 0) throw new Error("找不到 old_string"); if (n > 1) throw new Error("匹配到 " + n + " 处，请让它唯一");
        fs.writeFileSync(f, bf.replace(a.old_string, a.new_string), "utf8"); log("修改 " + rel(f)); return raw({ ok: true, path: rel(f) }); } });
  }
  if (cfg.allowExec) {
    T.push({ name: "run_command", description: "在项目目录执行命令（仅白名单）。", inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["command"] },
      handler: async (a) => { const n = String(a.command).replace(/\.(cmd|exe|bat)$/i, "").toLowerCase(); if (!cfg.allowedCommands.includes(n)) throw new Error("命令不在白名单内: " + a.command);
        log("执行 " + n + " " + (a.args || []).join(" ")); const r = await run(a.command, a.args || [], cfg.commandTimeoutMs);
        return raw({ exitCode: r.code, note: r.note, stdout: r.stdout, stderr: r.stderr }); } });
  }
  return T;
}

let mcpServer = null;
let mcpTools = [];
let mcpLog = () => {};
/* 会话统计 —— ShunCode 那种「工具调用 / 平均响应 / 成功率」我们也能给 */
const mcpStats = { calls: 0, ok: 0, fail: 0, totalMs: 0, last: "", lastAt: 0, connected: false };
function startMcp(onLog) {
  const http = require("node:http");
  mcpLog = onLog || (() => {});
  mcpTools = buildTools(mcpLog);
  const okR = (id, r) => ({ jsonrpc: "2.0", id, result: r });
  const erR = (id, c, m) => ({ jsonrpc: "2.0", id, error: { code: c, message: m } });

  async function dispatch(m) {
    const { id, method, params } = m || {};
    if (method === "initialize") return okR(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "arena-bridge", version: APP_VERSION } });
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return okR(id, {});
    if (method === "tools/list") return okR(id, { tools: mcpTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    if (method === "tools/call") {
      const t = mcpTools.find((x) => x.name === (params && params.name));
      if (!t) return erR(id, -32602, "未知工具");
      const t0 = Date.now();
      mcpStats.calls++; mcpStats.connected = true; mcpStats.last = t.name; mcpStats.lastAt = Date.now();
      try {
        const r = await t.handler((params && params.arguments) || {});
        mcpStats.ok++; mcpStats.totalMs += Date.now() - t0;
        pushStatus();
        return okR(id, r);
      } catch (e) {
        mcpStats.fail++; mcpStats.totalMs += Date.now() - t0;
        pushStatus();
        return okR(id, { content: [{ type: "text", text: "错误: " + (e && e.message) }], isError: true });
      }
    }
    if (method === "resources/list") return okR(id, { resources: [] });
    if (method === "prompts/list") return okR(id, { prompts: [] });
    return erR(id, -32601, "未实现: " + method);
  }

  mcpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pt = url.pathname.startsWith("/mcp/") ? decodeURIComponent(url.pathname.slice(5)) : "";
    if (url.pathname !== "/mcp" && !pt) { res.writeHead(404).end("not found"); return; }
    const au = String(req.headers["authorization"] || "");
    if (!(au === "Bearer " + cfg.token || pt === cfg.token)) { res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized"); return; }
    if (req.method === "GET" && !String(req.headers.accept || "").includes("text/event-stream")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({
        ok: true, service: "arena-bridge", protocol: "MCP over Streamable HTTP",
        how_to_use: { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, tools: mcpTools.map((t) => t.name) })); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "GET, POST" }).end(); return; }
    const ch = []; for await (const c of req) ch.push(c);
    let body; try { body = JSON.parse(Buffer.concat(ch).toString("utf8")); } catch (e) { res.writeHead(400).end("{}"); return; }
    const sse = String(req.headers.accept || "").includes("text/event-stream");
    const batch = Array.isArray(body) ? body : [body];
    const reps = []; for (const m of batch) { const r = await dispatch(m); if (r) reps.push(r); }
    if (!reps.length) { res.writeHead(202).end(); return; }
    const payload = Array.isArray(body) ? reps : reps[0];
    if (sse) { res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }); res.write("event: message\ndata: " + JSON.stringify(payload) + "\n\n"); res.end(); }
    else res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(payload));
  });

  return new Promise((resolve) => { mcpServer.once("error", (e) => resolve({ ok: false, err: e.message })); mcpServer.listen(cfg.port, "127.0.0.1", () => resolve({ ok: true, port: cfg.port })); });
}

/* ---------- 隧道 ---------- */
let tunnelProc = null;
let publicUrl = "";
let tunnelState = "starting";     // starting | up | down
function startTunnel(onUrl, onLog) {
  const cands = ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "cloudflared"];
  let bin = "cloudflared";
  for (const c of cands) { try { if (c.includes(":") && fs.existsSync(c)) { bin = c; break; } } catch (e) {} }
  tunnelProc = spawn(bin, ["tunnel", "--url", "http://127.0.0.1:" + cfg.port, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  let done = false;
  const scan = (b) => { const s = String(b); if (!done) { const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { done = true; publicUrl = m[0]; tunnelState = "up"; onUrl(m[0]); } } };
  if (tunnelProc.stdout) tunnelProc.stdout.on("data", scan);
  if (tunnelProc.stderr) tunnelProc.stderr.on("data", scan);
  tunnelProc.on("error", (e) => { tunnelState = "down"; onLog("隧道启动失败: " + e.message); pushStatus(); });
  // 隧道进程退出 = 公网地址失效。必须让面板知道，
  // 否则会把已经死掉的 URL 发给 Arena，对方只会看到 Cloudflare 1033。
  tunnelProc.on("exit", (code) => {
    if (tunnelState === "up" || tunnelState === "starting") {
      tunnelState = "down";
      onLog("隧道已断开（退出码 " + code + "），公网地址失效");
      pushStatus();
    }
  });
}

/* ---------- 窗口 ---------- */
let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 940, show: false, backgroundColor: "#0d1117", title: "Arena Bridge",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: { partition: "persist:arena-bridge", contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, "preload.cjs") },
  });
  /* 显示窗口 —— 用三重兜底，不依赖单一的 ready-to-show
     （实测 ready-to-show 有时不触发，导致窗口永远隐藏） */
  let shown = false;
  const showWindow = (why) => {
    if (shown) return;
    shown = true;
    say("显示窗口（触发源: " + why + "）");
    try { win.show(); win.focus(); } catch (e) { say("show 失败: " + e.message); }
    try {
      win.setAlwaysOnTop(true);
      setTimeout(() => { try { win.setAlwaysOnTop(false); } catch (e) {} }, 1200);
    } catch (e) { /* noop */ }
  };
  win.once("ready-to-show", () => showWindow("ready-to-show"));
  win.webContents.once("did-finish-load", () => setTimeout(() => showWindow("did-finish-load"), 800));
  setTimeout(() => showWindow("timeout-fallback"), 6000);   // 最后兜底

  // 把渲染进程的 console 输出写进日志 —— preload 出错时唯一的线索
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (/arena-bridge|\[amp|Error|error/i.test(message)) {
      say("[renderer] " + String(message).slice(0, 220) + (sourceId ? "  @" + sourceId.split(/[\\/]/).pop() + ":" + line : ""));
    }
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    say("[preload-error] " + preloadPath + " -> " + (error && error.message));
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });

  // 注入探针：用 executeJavaScript（不受页面 CSP 限制），
  // 而 preload 里插 <script> 的方式会被 Arena 的 CSP 拦掉。
  const injectProbe = async () => {
    try {
      const code = fs.readFileSync(path.join(ROOT, "extension", "probe.js"), "utf8");
      // 统一 UI：探针不再自己画 HUD，改由 preload 的面板显示（它通过 postMessage 拿状态）
      await win.webContents.executeJavaScript("window.__amp3NoHud = true; true", true);
      await win.webContents.executeJavaScript(code, true);
      say("探针代码已执行 (" + code.length + " 字符, HUD 已由统一面板接管)");

      // 回读页面真实状态 —— 这一步最能说明问题
      const diag = await win.webContents.executeJavaScript(`(function(){
        try {
          return JSON.stringify({
            url: location.href,
            hasScan: typeof window.__amp3Scan === "function",
            hasState: typeof window.__amp3State === "function",
            installed: !!window.__amp3,
            hotHud: !!document.getElementById("amp3-hud"),
            noHudFlag: !!window.__amp3NoHud,
            readyState: document.readyState,
            hasBody: !!document.body,
            panel: !!document.getElementById("arena-bridge-panel"),
          });
        } catch (e) { return "DIAG-ERR:" + e.message; }
      })()`, true);
      say("注入后自检: " + diag);
    } catch (e) {
      say("探针注入失败: " + (e && e.message));
    }
  };

  win.webContents.on("did-finish-load", () => { injectProbe(); });

  // 每 10 秒回读探针的网络计数器 —— 判断钩子到底有没有看到请求
  let tick = 0;
  setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    tick++;
    if (tick % 3 !== 0) return;          // 每 30 秒记一次，避免刷屏
    try {
      const s = await win.webContents.executeJavaScript(
        "JSON.stringify(window.__amp3NetCount || null) + ' | state=' + (window.__amp3State ? JSON.stringify(window.__amp3State()) : 'n/a')", true);
      say("[net] " + String(s).slice(0, 300));
    } catch (e) { say("[net] 读取失败: " + e.message); }
  }, 10000);
  // 页面内路由切换后也要重新注入（SPA 不会重新加载文档）
  /* SPA 每次路由变化都重跑 43KB 探针 —— 实测 2.5 小时注入了 184 次。
     探针自己有 __amp3 幂等门，但"解析 43KB 再立刻 return"仍然是白费。
     先问一句装了没，装了就直接跳过。 */
  win.webContents.on("did-navigate-in-page", async () => {
    try {
      const already = await win.webContents.executeJavaScript("!!window.__amp3", true);
      if (already) return;
    } catch (e) { /* 读不到就照常注入 */ }
    setTimeout(injectProbe, 300);
  });

  /* 记住当前对话地址。
     模型是跟对话绑定的（/agent/<uuid> 上挂着 runId 与抽中的模型），
     所以重启后应该回到同一个对话，而不是开一个新的空对话把它顶掉。 */
  let saveUrlTimer = null;
  const rememberUrl = (u) => {
    try {
      if (!/^https:\/\/arena\.ai\//.test(u)) return;
      clearTimeout(saveUrlTimer);
      saveUrlTimer = setTimeout(() => {
        if (cfg.lastUrl !== u) { cfg.lastUrl = u; saveCfg(); }
      }, 800);
    } catch (e) {}
  };
  win.webContents.on("did-navigate", (_e, u) => rememberUrl(u));
  win.webContents.on("did-navigate-in-page", (_e, u) => rememberUrl(u));

  // 只在"确实是一个已存在的对话"时才恢复，否则回到新对话页
  const startUrl = (/^https:\/\/arena\.ai\/agent\/[0-9a-f-]{36}/i.test(cfg.lastUrl || ""))
    ? cfg.lastUrl : "https://arena.ai/agent";
  say("起始地址: " + startUrl);
  win.loadURL(startUrl).catch((e) => {
    say("loadURL 失败（回退到新对话页）: " + e.message);
    win.loadURL("https://arena.ai/agent").catch((e2) => say("回退也失败: " + e2.message));
  });

  // 等页面就绪后把 MCP 地址注入面板
  win.webContents.on("did-finish-load", () => {
    setTimeout(() => pushStatus(), 1500);
  });
  return win;
}

function pushStatus() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("bridge-status", {
      port: cfg.port, token: cfg.token, projectDir: cfg.projectDir,
      allowWrite: cfg.allowWrite, allowExec: cfg.allowExec,
      tools: mcpTools.map((t) => t.name), publicUrl, tunnelState,
      seedModels, stats: mcpStats, version: APP_VERSION,
    });
  } catch (e) { say("推送状态失败: " + e.message); }
}

/* ---------- 抽卡引擎 ----------
 * 每一轮：让页面开新对话 → 发"你好" → 等探针报出模型 → 记录 → 下一轮。
 *
 * 升级点：
 *   · 轮数可指定（不再是写死的 20）
 *   · 可设目标关键字（如 opus,gpt-6,fable），抽到就停
 *   · 命中后停在那个对话上，不切走 —— 直接就能给它派活
 */
let gachaRun = null;

function gachaSend(msg) {
  try { if (win && !win.isDestroyed()) win.webContents.send("gacha-state", msg); } catch (e) {}
}
function gachaLg(m) {
  try { if (win && !win.isDestroyed()) win.webContents.send("gacha-log", m); } catch (e) {}
  say("[gacha] " + m);   // 也写进 desktop.log —— 以前只进面板，出问题时查不到
}

async function readProbe() {
  try {
    if (!win || win.isDestroyed()) return null;
    const s = await win.webContents.executeJavaScript(
      "window.__amp3State ? JSON.stringify(window.__amp3State()) : null", true);
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

/* 当前页面是哪个对话。用来判断探针读回来的状态是不是【这一轮】的 ——
   实测教训：新开对话后 URL 还没变过去，readProbe() 读到的还是上一个对话的
   残留状态，于是 1 秒就"抽到"了，而且报告的是上一轮的名字；
   真正的这一轮反而没人读，侧栏就一直标不上名。 */
async function currentConvId() {
  try {
    if (!win || win.isDestroyed()) return null;
    const s = await win.webContents.executeJavaScript(
      "(function(){var m=(location.pathname||'').match(/\\/agent\\/([0-9a-f-]{36})/i);" +
      "return m?m[1].toLowerCase():null;})()", true);
    return s || null;
  } catch (e) { return null; }
}

/* 只在"还是本轮对话"时才认这份状态 */
async function probeIfMine(myId) {
  const st = await readProbe();
  if (!st || !myId) return st;
  const now = await currentConvId();
  return now === myId ? st : null;
}

async function waitForModel(timeoutMs, run, myId) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    if (!run || !run.running || gachaRun !== run) return null;
    const st = await probeIfMine(myId);
    if (st) {
      last = st;
      /* 撞上限流就立刻收手。
         以前是傻等满 150 秒才去检查 —— 实测 02:35:29 就 429 了，
         白白干等两分多钟。 */
      if (st.quota && st.quota.chat && st.quota.chat.blocked) return st;
      if (st.model) {
        /* 只做一小段宽限，不在这儿等档位。
           带档位的内部名要 8~9 秒才写进 span，原地干等纯属浪费 ——
           后面本来就有一段时间在睡（轮间隔），把等待挪到那儿去，
           等于不花时间。见下面的 waitGapAndTier()。 */
        await new Promise((r) => setTimeout(r, 2500));
        const st2 = (await probeIfMine(myId)) || st;
        return st2.model ? st2 : st;
      }
      if (st.fastModel) {
        /* 只有快速通道的票、还没 trace。快速通道会误报
           （实测把 claude-opus-4-8 报到别的对话上，连报 10 次）。
           trace 才是真名 —— 所以再给它 25 秒；等不到才退回 fastModel。 */
        const t1 = Date.now();
        let st3 = st;
        while (Date.now() - t1 < 12000 && run.running && gachaRun === run) {
          await new Promise((r) => setTimeout(r, 1000));
          const s = await readProbe();
          if (!s) continue;
          st3 = s;
          if (s.model) break;
        }
        if (st3.model) {
          await new Promise((r) => setTimeout(r, 2000));
          const s4 = (await readProbe()) || st3;
          return s4.model ? s4 : st3;
        }
        return st3;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));   // 1 秒一问，反应快一点
  }
  return last;
}

/* 目标匹配：大小写无关的子串匹配。
   Arena 的模型名带版本后缀（gpt-5.5-2026-04-23），所以用子串比全等实用得多。 */
function matchTarget(name, targets) {
  if (!name || !targets || !targets.length) return false;
  const n = String(name).toLowerCase();
  return targets.some((t) => t && n.indexOf(String(t).toLowerCase()) >= 0);
}
function parseTargets(s) {
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return String(s || "").split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 抽卡节奏（面板上那个「降频」按钮就是调这张表）。
   轮间隔必须带抖动 —— 实测教训：固定 1.2 秒、每次都发同一句话，
   抽 5~6 轮就弹人机验证。这不是"绕过风控"，是把节奏放回正常使用的水平。
   pace 由渲染进程随 gacha-start 一起传进来，非法值一律退回 std。 */
const PACES = {
  off:    { gap: [2000, 5000],   breakEvery: 0, brk: [0, 0] },
  std:    { gap: [6000, 15000],  breakEvery: 3, brk: [45000, 90000] },
  strong: { gap: [15000, 30000], breakEvery: 2, brk: [90000, 180000] },
  hunt:   { gap: [12000, 30000], breakEvery: 0, brk: [0, 0] },          // 守株待兔（间隔另见 HUNT）
};
const PACE_LABEL = { off: "关", std: "标准", strong: "强", hunt: "守株待兔" };
function paceOf(p) { return PACES[p] || PACES.std; }
function roundGapMs(p) { const c = paceOf(p).gap; return c[0] + Math.floor(Math.random() * (c[1] - c[0])); }
function breakMs(p)    { const c = paceOf(p).brk; return c[0] + Math.floor(Math.random() * (c[1] - c[0])); }

/* 一轮抽卡 = 一份独立的 run 对象，由 gacha-start 建好后传进来。
   ── 这里踩过一个很贵的坑 ──
   原来 gachaRun 是全局单例：点「停止」只把 running 置 false，
   但旧循环还卡在 await 里；这时再点「开始」会【新建】一个对象，
   旧循环醒来读到的是新对象（running=true），于是它接着跑 ——
   两个循环抢同一个页面，轮流把对方刚开的对话导航走。
   后果：对话开了、模型也抽到了，可页面被抢走，真实模型名永远读不到
   → 侧栏留着原标题，看起来就像「跳过了某个对话」。
   现在每个循环只认自己那份 run；gachaRun 只用来判断"我还是不是最新的"。 */
/* 轮间隔 + 顺便等档位。
   ── 为什么放这儿 ──
   带档位的内部名（gpt-5.6-sol-low、claude-opus-5-max-vertex…）在 span 详情里，
   而那个 span 是【回合结束后】才写的，实测比显示名晚 8~9 秒。
   原来是在等到显示名之后原地干等 —— 纯浪费；
   而轮间隔这段时间本来就在睡，搬进来之后只要 gap ≥ 9 秒就完全不额外花时间。
   等不到也不拖：到点就开下一轮。 */
const TIER_BUDGET_MS = 11000;

/* ================= 守株待兔模式 =================
   目标模型随机命中，抽不到就只能重来 —— 这个模式负责"一直抽，直到出现"。
   但它不是"加速版"，恰好相反：

   ★ 它和「降频」是两条轴，不是一档。
     降频 = 我们主动限速（免得把人家服务当压测目标）；
     守株待兔 = 被动应对封顶（撞上了就等，不等就只能停）。
     这个模式【特意】把轮间隔拉到 12~30 秒 —— 因为按次数算的限流
     （30 次 / 300 秒的窗口）在 6 秒一轮下只要 3 分钟就打满，
     拉长间隔换来的正是"不会被限"，这才是它"避免风控"的方式。 */
const HUNT = { gap: [12000, 30000] };

/* 目标按顺序分优先级：目标 gpt-6,fable-5.1 → 抽到 gpt-6 才停，
   抽到 fable-5.1 只记一笔"次选"。逆序写目标就能改偏好。 */
function targetRank(n, targets) {
  const s = String(n || "").toLowerCase();
  for (let i = 0; i < targets.length; i++) {
    if (targets[i] && s.indexOf(String(targets[i]).toLowerCase()) >= 0) return i;
  }
  return -1;
}

/* 被限流时的冷却。429 的时间尺度比轮间隔大得多（分钟级），只能等它过去。 */
async function waitCooldown(sec, run) {
  const t0 = Date.now();
  while (Date.now() - t0 < sec * 1000) {
    if (!run.running || gachaRun !== run) return false;
    await sleep(1000);
    const left = sec - Math.floor((Date.now() - t0) / 1000);
    if (left > 0 && left % 30 === 0) {
      gachaLg("  ⏳ 冷却中…还剩 " + left + " 秒（这段时间频繁重试只会白白撞更多 429）");
    }
  }
  return true;
};
async function waitGapAndTier(gapMs, run, myId) {
  if (!run.awaitTier) { await sleep(gapMs); return; }
  const t0 = Date.now();
  const budget = Math.max(gapMs, TIER_BUDGET_MS);   // 至少睡满 gap（降频不能因为等到了就缩短）
  const h = run.hits[run.hits.length - 1];
  let done = false;
  while (Date.now() - t0 < budget) {
    if (!run.running || gachaRun !== run) return;
    await sleep(600);
    if (done) continue;
    const s = await probeIfMine(myId);
    if (!s || !s.internalModel) continue;
    done = true;
    const nm = s.internalModel;
    const lv = String((s.tier && s.tier.level) || "").toUpperCase();
    if (h && h.model !== nm) {
      h.model = nm;
      h.tier = lv;
      gachaSend({ hits: run.hits });
      gachaLg("  ↑ 档位补上：" + nm + (lv ? "  [" + lv + "]" : "") + "（借轮间隔等的，没多花时间）");
    }
  }
}

async function gachaLoop(run, opts) {
  const rounds = run.total;
  const targets = run.targets;
  const stopOnHit = run.stopOnHit;

  gachaSend(run);
  const tgtTxt = targets.length
    ? " · 目标 " + targets.join(" / ") +
      (run.hunt ? "（按顺序优先：抽到第 1 个才停，后面的只记一笔）"
                : (stopOnHit ? "（命中即停）" : "（只记录，不停）"))
    : " · 未设目标，全部记录";
  gachaLg("抽卡开始：" + (run.hunt ? "一直抽到主目标出现" : rounds + " 轮") + tgtTxt +
    " · " + (run.hunt ? "守株待兔" : "降频 " + (PACE_LABEL[run.pace] || "标准")) +
    " · 提示词 " + (run.prompt ? JSON.stringify(run.prompt) : "内置轮换"));

  let missStreak = 0;
  const maxRounds = run.hunt ? 100000 : rounds;      // 守株待兔没有轮数上限
  for (let i = 1; i <= maxRounds; i++) {
    if (!run.running || gachaRun !== run) break;
    run.round = i;
    gachaSend({ round: i });
    gachaLg(run.hunt ? ("第 " + i + " 轮（守株待兔）：开新对话…")
                     : ("第 " + i + "/" + rounds + " 轮：开新对话…"));

    /* 先记住"现在是哪个对话"，再让它开新对话；
       开完必须等 URL 真的变过去，否则 readProbe() 读到的还是上一个对话的残留。
       实测：抽卡日志里那些 1~2 秒就出结果的轮次，全是这么来的 ——
       报的是上一轮的名字，而这一轮真正的模型名再也没人去读。 */
    let prevId = await currentConvId();
    for (let k = 0; k < 20 && !prevId; k++) {
      if (!run.running || gachaRun !== run) break;
      await sleep(300);
      prevId = await currentConvId();
    }

    try { win.webContents.send("gacha-round", i); } catch (e) {}

    let myId = null;
    if (prevId) {
      for (let k = 0; k < 60; k++) {                  // 最多 18 秒
        if (!run.running || gachaRun !== run) break;
        await sleep(300);
        const id = await currentConvId();
        if (id && id !== prevId) { myId = id; break; }
      }
      if (!myId && run.running && gachaRun === run) {
        gachaLg("  ⚠ 没等到新对话的 URL，本轮不做残留核对，结果可能读到上一轮");
      }
    }

    /* 150 秒。原来 90 秒不够 —— 实测有一轮 95 秒才出模型名被判超时跳过。
       模型名是【回合结束后】才出现在响应里的，问句越长、回答越长，出得越晚。 */
    const st = await waitForModel(150000, run, myId);
    if (!run.running || gachaRun !== run) break;

    // 被平台限流就别硬撞了 —— 继续开只会把账号往更严的风控上推
    const q = st && st.quota && st.quota.chat;
    if (q && q.blocked) {
      const mins = q.resetAt ? Math.max(1, Math.ceil((q.resetAt - Date.now()) / 60000)) : null;
      if (run.hunt) {
        const wait = Math.max(120, Math.min(900, (mins || 5) * 60 + 15));
        gachaLg("⏸ Arena 限流：" + (q.reason || "429") + (mins ? "，约 " + mins + " 分钟后解除" : "") +
                "。守株待兔：歇 " + Math.round(wait / 60) + " 分钟再接着抽（停掉就是前功尽弃）。");
        run.blocked = true;
        gachaSend({ running: true, blocked: true, hunt: true, coolUntil: Date.now() + wait * 1000 });
        if (!(await waitCooldown(wait, run))) break;
        run.blocked = false;
        missStreak = 0;
        gachaSend({ blocked: false, coolUntil: 0 });
        i--;                                   // 这一轮不算数
        continue;
      }
      gachaLg("⛔ Arena 限流：" + (q.reason || "429") + (mins ? "，约 " + mins + " 分钟后解除" : ""));
      run.blocked = true;
      break;
    }

    /* 额度见底就先停，别等撞上 429 再停。
       实测：02:33:23 就已经是「剩余 0/30」，可后面又白抽了两轮。 */
    if (q && !q.blocked && q.remaining === 0) {
      const mins = q.resetAt ? Math.max(1, Math.ceil((q.resetAt - Date.now()) / 60000)) : null;
      if (run.hunt) {
        // 窗口是滚动的：等一个窗口长度，最早那批就过期了
        const wait = Math.max(90, Math.min(600, mins ? mins * 60 + 15 : (q.window || 300) + 30));
        gachaLg("⏸ 新会话额度见底（0/" + (q.limit === null ? "?" : q.limit) + "）" +
                "。守株待兔：等 " + Math.round(wait / 60) + " 分钟让窗口滚过去。");
        gachaSend({ blocked: true, coolUntil: Date.now() + wait * 1000 });
        if (!(await waitCooldown(wait, run))) break;
        run.blocked = false;
        gachaSend({ blocked: false, coolUntil: 0 });
        i--;
        continue;
      }
      gachaLg("⛔ 新会话额度已用尽（0/" + (q.limit === null ? "?" : q.limit) + "）" +
              (mins ? "，约 " + mins + " 分钟后重置" : "") +
              "。再抽只会撞 429，先停手。");
      run.blocked = true;
      break;
    }

    if (!st || !(st.model || st.fastModel)) {
      missStreak++;
      run.done = i;
      gachaSend({ done: i });
      if (missStreak >= 2) {
        gachaLg("连续 " + missStreak + " 轮识别不到模型 —— 多半已经被风控拦住，停止抽卡");
        run.blocked = true;
        break;
      }
      gachaLg("  未识别到模型（超时），跳过");
      continue;
    }
    missStreak = 0;

    const name = st.model || st.fastModel;
    const tier = String((st.tier && st.tier.level) || (st.reasoning && st.reasoning.level) || "");
    const rank = run.hunt ? targetRank(name, targets) : (matchTarget(name, targets) ? 0 : -1);
    const hit = rank === 0;
    run.hits.push({ model: name, tier: tier.toUpperCase(), confirmed: !!st.model, hit, at: Date.now() });
    run.done = i;
    if (hit) run.hit = name;
    gachaSend({ hits: run.hits, done: i, hit: run.hit });
    gachaLg("  第 " + i + " 轮 → " + name + (tier ? "  [" + tier.toUpperCase() + "]" : "") +
            (st.model ? "" : " (未确认)") + (hit ? "   ★ 命中主目标" : "") +
            (rank > 0 ? "   (次选，继续抽)" : ""));

    if (hit && stopOnHit) {
      if (run.hunt) {
        gachaLg("🎯 抽到主目标 " + name + "！");
        gachaLg("   它就在【刚才第 " + i + " 个新对话】里 —— 侧栏从上往下数第 " + i + " 条。");
        gachaLg("   直接切到那个对话派活即可；别的对话都只是垫脚石，不用管。");
      } else {
        gachaLg("★ 命中 " + name + "，第 " + i + " 轮停止。" +
                "当前对话就是它，直接派活即可（别再点「一键连接并开工」，那会开新对话）。");
      }
      break;
    }

    // 轮间隔带抖动；长歇的周期和时长都由「降频」档位决定（off 档不歇）
    const gap = run.hunt
      ? HUNT.gap[0] + Math.floor(Math.random() * (HUNT.gap[1] - HUNT.gap[0]))
      : roundGapMs(run.pace);
    gachaLg("  等 " + Math.round(gap / 1000) + " 秒继续…" +
            (run.awaitTier ? "" : "（不等档位）") +
            (run.hunt ? "（守株待兔的间隔下限 12 秒 —— 就是为了别把 300 秒窗口打满）" : ""));
    await waitGapAndTier(gap, run, myId);
    const every = run.hunt ? 0 : paceOf(run.pace).breakEvery;
    if (every && i % every === 0 && i < rounds && run.running && gachaRun === run) {
      const brk = breakMs(run.pace);
      gachaLg("  已抽 " + i + " 轮，休息 " + Math.round(brk / 1000) + " 秒（降频，避免触发风控）…");
      await sleep(brk);
    }
  }

  const hitModel = run.hit;                     // 别叫 win —— 会遮蔽 BrowserWindow
  const doneCount = run.done;
  const gotCount = run.hits.length;
  const superseded = gachaRun !== run;          // 被新一轮顶替了：别改状态、别再打一条"结束"
  run.running = false;
  if (!superseded) {
    gachaSend({ running: false, hit: hitModel, blocked: !!run.blocked });
    gachaLg(hitModel && stopOnHit
      ? "抽卡结束：命中 " + hitModel + "（共抽 " + doneCount + " 轮）"
      : (run.hunt
          ? "抽卡结束：守株待兔共抽 " + doneCount + " 轮，没抽到主目标，记录 " + gotCount + " 个模型"
          : "抽卡结束：共抽 " + doneCount + " 轮，记录 " + gotCount + " 个模型"));
  }
}

ipcMain.on("gacha-start", (_e, opts) => {
  if (gachaRun && gachaRun.running) return;
  const o = opts || {};
  const rounds = Math.max(1, Math.min(200, parseInt(o.rounds, 10) || 10));
  const targets = parseTargets(o.targets);
  const stopOnHit = !(o.stopOnHit === false);
  const run = {
    running: true, total: rounds, done: 0, hits: [], targets, stopOnHit,
    pace: PACES[o.pace] ? o.pace : "std",          // 非法值退回「标准」
    hunt: o.pace === "hunt",                       // 守株待兔：无限抽 + 撞限流就等
    awaitTier: o.awaitTier !== false,              // 是否在轮间隔里顺便等带档位的内部名
    prompt: String(o.prompt || "").slice(0, 120),  // 本轮用的提示词（空=内置轮换），记进日志便于 A/B
    hit: null, blocked: false, startedAt: Date.now(),
  };
  if (run.hunt) run.total = null;                  // 没有轮数上限，面板别显示分母
  gachaRun = run;
  gachaLoop(run, o);
});

/* 页面侧发现人机验证时上报 —— 立刻停。
   注意：这里只负责"停"，不去做任何绕过验证的事。 */
ipcMain.on("gacha-blocked", (_e, info) => {
  if (!gachaRun || !gachaRun.running) return;
  gachaRun.running = false;
  gachaRun.blocked = true;
  gachaSend({ running: false, blocked: true });
  gachaLg("⛔ 检测到人机验证（" + ((info && info.where) || "页面") + "），已自动停止抽卡");
  gachaLg("   请在窗口里手动完成验证。这是平台的风控，本工具不会绕过它。");
  gachaLg("   验证通过后建议歇一会儿再抽，频率调低些（轮数改小、目标写明确）。");
});
ipcMain.on("gacha-stop", () => {
  if (gachaRun) { gachaRun.running = false; gachaSend({ running: false }); gachaLg("已停止"); }
});

/* 选项目目录 —— 换目录后必须重建工具表，因为 buildTools 把根路径烧进了闭包 */
ipcMain.handle("bridge:pick-dir", async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: "选择要让 Agent 操作的项目目录",
      defaultPath: cfg.projectDir,
      properties: ["openDirectory"],
      buttonLabel: "用这个目录",
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    cfg.projectDir = r.filePaths[0];
    saveCfg();
    mcpTools = buildTools(mcpLog);
    say("项目目录改为: " + cfg.projectDir + "（工具表已重建，" + mcpTools.length + " 个工具）");
    pushStatus();
    return { ok: true, dir: cfg.projectDir };
  } catch (e) { return { ok: false, err: e && e.message }; }
});

/* 面板把关键信息转到这里落盘 —— 面板日志区我读不到，走文件才看得见 */
ipcMain.handle("bridge:note", (_e, m) => {
  say("[panel] " + String(m == null ? "" : m).slice(0, 400));
  return true;
});

/* 诊断：把探针抓到的 trace 原文写到文件，用来核对
   "思考强度到底在不在 trace 里" 这类问题（不靠猜）。 */
ipcMain.handle("bridge:save-trace", (_e, p) => {
  try {
    const file = path.join(CFG_DIR, "diag-trace.json");
    const trace = (p && p.trace) || "";
    fs.writeFileSync(file, JSON.stringify({
      savedAt: new Date().toISOString(),
      model: (p && p.model) || null,
      runId: (p && p.runId) || null,
      bytes: trace.length,
      traceRaw: trace,
    }, null, 1));
    say("已导出 trace: " + file + " (" + trace.length + " bytes, model=" + ((p && p.model) || "-") + ")");
    return { ok: true, path: file, bytes: trace.length };
  } catch (e) { return { ok: false, err: e && e.message }; }
});

ipcMain.handle("bridge:copy-url", (_e, which) => {
  const u = (which === "local" ? "http://127.0.0.1:" + cfg.port : publicUrl) + "/mcp/" + cfg.token;
  try { clipboard.writeText(u); } catch (e) {}
  return u;
});
ipcMain.handle("bridge:set", (_e, patch) => {
  if (patch && typeof patch === "object") {
    Object.assign(cfg, patch);
    saveCfg();
    // 权限变了必须重建工具表 —— 否则新工具（比如 run_command）
    // 要等到下次启动才出现，用户会以为"开了没用"。
    if ("allowExec" in patch || "allowWrite" in patch) {
      try { mcpTools = buildTools(mcpLog); } catch (e) { say("重建工具表失败: " + e.message); }
    }
  }
  pushStatus();
  return { ok: true };
});

/* ---------- 启动 ---------- */
try { Menu.setApplicationMenu(null); } catch (e) {}

/* AppUserModelID：Windows 靠它给任务栏分组/固定。
   不设的话窗口会被归到 electron.exe 名下，右键菜单和固定行为都不对。
   必须和 _make-shortcut.ps1 里写进快捷方式的值一致。 */
try { app.setAppUserModelId("ekkkcz.ArenaBridge"); } catch (e) { say("setAppUserModelId 失败: " + e.message); }

/* 单实例锁：重复双击时聚焦已有窗口，而不是再起一个（后者会因端口占用而崩溃） */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  say("已有实例在运行，本次启动退出");
  app.quit();
} else {
  app.on("second-instance", () => {
    say("检测到重复启动，聚焦已有窗口");
    try {
      if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
    } catch (e) { /* noop */ }
  });
}

app.whenReady().then(async () => {
  const log = (m) => {
    say(m);
    try {
      const w = BrowserWindow.getAllWindows()[0];
      if (w && !w.isDestroyed()) w.webContents.send("bridge-log", m);
    } catch (e) { /* 窗口还没建好就忽略 */ }
  };
  /* 把真实 GPU 状态写进日志 —— 以后卡不卡一眼能查。
     ⚠ 注意时序：whenReady 那一刻 GPU 进程可能还没起来，
     此时的 getGPUFeatureStatus() 会【偏悲观】地报 disabled_software。
     所以除了立刻读一次，12 秒后再读一次 + 问 getGPUInfo 要真实设备。
     不这样区分的话，很容易误判成"我们没用 GPU"，
     进而干出"把本来能用的硬件加速关掉"这种反向优化。 */
  const dumpGpu = (tag) => {
    try {
      const g = app.getGPUFeatureStatus();
      const soft = Object.keys(g).filter((k) => /software|disabled/i.test(String(g[k])));
      say("GPU 特性状态[" + tag + "]: " + JSON.stringify(g));
      if (soft.length) say("⚠ 软件实现的特性[" + tag + "]: " + soft.join(", "));
      else say("✅ GPU 特性[" + tag + "]: 全部硬件加速");
    } catch (e) { say("读 GPU 状态失败[" + tag + "]: " + e.message); }
  };
  dumpGpu("ready");
  try {
    app.getGPUInfo("basic").then((info) => {
      // 这台机器到底有没有 GPU、是不是软件渲染，看这里最准
      const g = (info && info.gpuDevice) || [];
      const au = info && info.auxAttributes ? info.auxAttributes : {};
      say("GPU 设备: " + JSON.stringify(g.map((d) => ({
        vendor: d.vendorId, device: d.deviceId, name: d.deviceString || "",
      }))) +
        " | glRenderer=" + (au.glRenderer || "-") +
        " | softwareRendering=" + (au.softwareRendering === undefined ? "?" : au.softwareRendering) +
        " | optimus=" + (au.optimus === undefined ? "?" : au.optimus));
    }).catch((e) => say("getGPUInfo 失败: " + e.message));
  } catch (e) { say("getGPUInfo 异常: " + e.message); }
  setTimeout(() => dumpGpu("+12s"), 12000);

  try {
    const r = await startMcp(log);
    if (r.ok) log("MCP 已启动 127.0.0.1:" + r.port);
    else log("MCP 启动失败: " + r.err + "（端口被占用？）");
  } catch (e) {
    log("MCP 启动异常: " + (e && e.message));
  }

  createWindow();

  try {
    startTunnel((url) => { log("公网地址: " + url); pushStatus(); }, log);
  } catch (e) {
    tunnelState = "down";
    log("隧道启动异常: " + (e && e.message));
  }
  // 隧道状态会晚于首次 pushStatus 才确定，这里补偿推一次
  setTimeout(pushStatus, 2500);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  say("窗口关闭，退出");
  try { if (win && !win.isDestroyed()) { const u = win.webContents.getURL(); if (/^https:\/\/arena\.ai\//.test(u)) { cfg.lastUrl = u; saveCfg(); } } } catch (e) {}
  try { if (tunnelProc) tunnelProc.kill(); } catch (e) {}
  try { if (mcpServer) mcpServer.close(); } catch (e) {}
  if (process.platform !== "darwin") app.quit();
});
