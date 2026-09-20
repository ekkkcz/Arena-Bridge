// 在 Electron 主进程里直接跑 MCP 服务 —— 不再需要另外开一个终端。
//
// 主进程本身就是完整的 Node 环境，所以 server/lib 里的模块可以直接 require。
// 这样"浏览器 + MCP"就是一个程序，真正做到开箱即用。
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CFG_DIR = path.join(ROOT, ".arena-bridge");
const CFG_FILE = path.join(CFG_DIR, "config.json");

const SKIP_DIRS = new Set(["node_modules", ".git", ".arena-bridge", "dist", "build", ".next", "__pycache__", ".venv"]);
const DEFAULT_CMD = ["node", "npm", "npx", "pnpm", "yarn", "git", "python", "py", "tsc", "go", "cargo", "make"];

function loadConfig() {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch (e) { c = {}; }
  const out = Object.assign({
    port: 8788, token: "", projectDir: path.join(ROOT, "example-workspace"),
    allowWrite: false, allowExec: false, allowedCommands: DEFAULT_CMD,
    maxReadBytes: 524288, maxWriteBytes: 524288, maxOutputBytes: 65536, commandTimeoutMs: 180000,
  }, c);
  let dirty = false;
  if (!out.token) { out.token = crypto.randomBytes(24).toString("hex"); dirty = true; }
  if (!fs.existsSync(out.projectDir)) { fs.mkdirSync(out.projectDir, { recursive: true }); }
  if (dirty) fs.writeFileSync(CFG_FILE, JSON.stringify(out, null, 2) + "\n");
  return out;
}

function saveConfig(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + "\n"); }

function createTools(cfg, log) {
  const ROOTD = path.resolve(cfg.projectDir);
  const safe = (p) => {
    const abs = path.resolve(ROOTD, String(p || "."));
    if (abs !== ROOTD && !abs.startsWith(ROOTD + path.sep)) throw new Error("路径越界（只能访问项目目录）: " + p);
    return abs;
  };
  const rel = (a) => path.relative(ROOTD, a).split(path.sep).join("/") || ".";
  const raw = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

  function walk(dir, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 14 || out.length > 5000) return out;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of es) {
      if (SKIP_DIRS.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, out, depth + 1); else out.push(rel(f));
    }
    return out;
  }

  function resolveBin(bin) {
    if (path.isAbsolute(bin)) return bin;
    const exts = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    for (const d of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      for (const x of exts) { const c = path.join(d, bin + x); try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
    }
    return null;
  }

  function runCmd(cmd, args, ms) {
    return new Promise((resolve) => {
      const bin = resolveBin(cmd);
      if (!bin) return resolve({ code: null, stdout: "", stderr: "", note: "找不到可执行文件: " + cmd });
      const shim = /\.(cmd|bat)$/i.test(bin);
      const child = spawn(shim ? "cmd.exe" : bin, shim ? ["/d", "/s", "/c", bin].concat(args) : args,
        { cwd: ROOTD, shell: false, windowsHide: true });
      let o = "", e = "", done = false;
      const fin = (code, note) => { if (done) return; done = true; resolve({ code, note: note || null, stdout: o.slice(-cfg.maxOutputBytes), stderr: e.slice(-cfg.maxOutputBytes) }); };
      const t = setTimeout(() => { try { child.kill(); } catch (x) {} fin(null, "超时 " + ms + "ms"); }, ms);
      child.stdout.on("data", (d) => { o += d; });
      child.stderr.on("data", (d) => { e += d; });
      child.on("error", (x) => { clearTimeout(t); fin(null, "启动失败: " + x.message); });
      child.on("close", (c) => { clearTimeout(t); fin(c); });
    });
  }

  const tools = [
    { name: "get_project_info", description: "获取项目根目录、权限开关与可用工具。建议第一步先调用。",
      inputSchema: { type: "object", properties: {} },
      handler: async () => raw({ projectDir: ROOTD, platform: process.platform, node: process.versions.node, permissions: { read: true, write: !!cfg.allowWrite, exec: !!cfg.allowExec }, allowedCommands: cfg.allowExec ? cfg.allowedCommands : [] }) },
    { name: "list_files", description: "列出项目内所有文件（跳过 node_modules/.git 等）。",
      inputSchema: { type: "object", properties: {} },
      handler: async () => raw(walk(ROOTD).join("\n") || "(空目录)") },
    { name: "read_file", description: "读取项目内的文本文件。path 相对于项目根目录。",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: async (a) => { const abs = safe(a.path); const st = fs.statSync(abs); if (st.size > cfg.maxReadBytes) throw new Error("文件过大"); return raw(fs.readFileSync(abs, "utf8")); } },
    { name: "search", description: "在项目内做文本搜索，返回 file:line: 内容。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, regex: { type: "boolean" } }, required: ["query"] },
      handler: async (a) => {
        const re = new RegExp(a.regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const hits = [];
        for (const f of walk(ROOTD)) {
          if (hits.length >= 60) break;
          let txt; try { txt = fs.readFileSync(path.join(ROOTD, f), "utf8"); } catch (e) { continue; }
          const ls = txt.split(/\r?\n/);
          for (let i = 0; i < ls.length && hits.length < 60; i++) if (re.test(ls[i])) hits.push(f + ":" + (i + 1) + ": " + ls[i].trim().slice(0, 200));
        }
        return raw(hits.join("\n") || "(无匹配)");
      } },
  ];

  if (cfg.allowWrite) {
    tools.push({ name: "write_file", description: "写入或覆盖项目内的文本文件（父目录自动创建）。",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      handler: async (a) => {
        const abs = safe(a.path);
        const b = Buffer.byteLength(a.content, "utf8");
        if (b > cfg.maxWriteBytes) throw new Error("内容过大");
        const existed = fs.existsSync(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, a.content, "utf8");
        log("[write] " + rel(abs) + "  " + b + " 字节");
        return raw({ ok: true, path: rel(abs), bytes: b, created: !existed });
      } });
    tools.push({ name: "apply_patch", description: "把文件中一段文本替换为另一段（old_string 必须唯一）。",
      inputSchema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] },
      handler: async (a) => {
        const abs = safe(a.path);
        const before = fs.readFileSync(abs, "utf8");
        const n = before.split(a.old_string).length - 1;
        if (n === 0) throw new Error("文件里找不到 old_string");
        if (n > 1) throw new Error("old_string 匹配到 " + n + " 处，请让它唯一");
        fs.writeFileSync(abs, before.replace(a.old_string, a.new_string), "utf8");
        log("[patch] " + rel(abs));
        return raw({ ok: true, path: rel(abs) });
      } });
  }

  if (cfg.allowExec) {
    tools.push({ name: "run_command", description: "在项目目录内执行命令（仅白名单，无 shell 拼接）。",
      inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["command"] },
      handler: async (a) => {
        const n = String(a.command).replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
        if (!cfg.allowedCommands.includes(n)) throw new Error("命令不在白名单内: " + a.command);
        log("[exec] " + n + " " + (a.args || []).join(" "));
        const r = await runCmd(a.command, a.args || [], cfg.commandTimeoutMs);
        return raw({ exitCode: r.code, note: r.note, stdout: r.stdout, stderr: r.stderr });
      } });
  }

  return tools;
}

function createMcp(cfg, log) {
  const tools = createTools(cfg, log);
  const okR = (id, r) => ({ jsonrpc: "2.0", id, result: r });
  const erR = (id, c, m) => ({ jsonrpc: "2.0", id, error: { code: c, message: m } });

  async function dispatch(m) {
    const { id, method, params } = m || {};
    if (method === "initialize") return okR(id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "arena-bridge", version: "1.1.0" } });
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return okR(id, {});
    if (method === "tools/list") return okR(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    if (method === "tools/call") {
      const t = tools.find((x) => x.name === (params && params.name));
      if (!t) return erR(id, -32602, "未知工具: " + (params && params.name));
      try { return okR(id, await t.handler((params && params.arguments) || {})); }
      catch (e) { return okR(id, { content: [{ type: "text", text: "错误: " + (e && e.message || e) }], isError: true }); }
    }
    if (method === "resources/list") return okR(id, { resources: [] });
    if (method === "prompts/list") return okR(id, { prompts: [] });
    return erR(id, -32601, "未实现: " + method);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pt = url.pathname.startsWith("/mcp/") ? decodeURIComponent(url.pathname.slice(5)) : "";
    if (url.pathname !== "/mcp" && !pt) { res.writeHead(404).end("not found"); return; }
    const auth = String(req.headers["authorization"] || "");
    if (!(auth === "Bearer " + cfg.token || pt === cfg.token)) { res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized"); return; }

    if (req.method === "GET" && !String(req.headers["accept"] || "").includes("text/event-stream")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({
        ok: true, service: "arena-bridge", protocol: "MCP over Streamable HTTP",
        how_to_use: { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
        tools: tools.map((t) => t.name),
      }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "GET, POST" }).end(); return; }

    const ch = []; for await (const c of req) ch.push(c);
    let body; try { body = JSON.parse(Buffer.concat(ch).toString("utf8")); } catch (e) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(erR(null, -32700, "Parse error"))); return; }
    const sse = String(req.headers["accept"] || "").includes("text/event-stream");
    const batch = Array.isArray(body) ? body : [body];
    const reps = [];
    for (const m of batch) { const r = await dispatch(m); if (r) reps.push(r); }
    if (!reps.length) { res.writeHead(202).end(); return; }
    const payload = Array.isArray(body) ? reps : reps[0];
    if (sse) { res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }); res.write("event: message\ndata: " + JSON.stringify(payload) + "\n\n"); res.end(); }
    else { res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(payload)); }
  });

  return {
    tools,
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, "127.0.0.1", () => resolve(cfg.port)); }),
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { loadConfig, saveConfig, createMcp, createTools, CFG_FILE };
