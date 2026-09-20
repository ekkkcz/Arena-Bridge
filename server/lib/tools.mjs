// 工具集：全部限定在 projectDir 之内，按开关逐级放权。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const SKIP_DIRS = new Set(["node_modules", ".git", ".arena-bridge", "dist", "build", ".next", "__pycache__", ".venv"]);

export function createTools(cfg, log = () => {}) {
  const ROOT = path.resolve(cfg.projectDir);

  const safe = (p) => {
    const abs = path.resolve(ROOT, String(p || "."));
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      throw new Error("路径越界（只能访问项目目录）: " + p);
    }
    return abs;
  };
  const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/") || ".";
  const raw = (v) => ({
    content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
  });

  function walk(dir, out = [], depth = 0) {
    if (depth > 14 || out.length > 5000) return out;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out, depth + 1);
      else out.push(rel(full));
    }
    return out;
  }

  function resolveBin(bin) {
    if (path.isAbsolute(bin)) return bin;
    const exts = process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
    for (const d of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      for (const ext of exts) {
        const c = path.join(d, bin + ext);
        try { if (fs.statSync(c).isFile()) return c; } catch { /* 继续找 */ }
      }
    }
    return null;
  }

  function runCmd(command, args, timeoutMs) {
    return new Promise((resolve) => {
      const bin = resolveBin(command);
      if (!bin) {
        resolve({ code: null, stdout: "", stderr: "", note: "找不到可执行文件: " + command });
        return;
      }
      const isShim = /\.(cmd|bat)$/i.test(bin);
      const child = spawn(
        isShim ? "cmd.exe" : bin,
        isShim ? ["/d", "/s", "/c", bin, ...args] : args,
        { cwd: ROOT, shell: false, windowsHide: true },
      );
      let out = "", err = "", done = false;
      const finish = (code, note) => {
        if (done) return;
        done = true;
        resolve({
          code,
          note: note || null,
          stdout: out.slice(-cfg.maxOutputBytes),
          stderr: err.slice(-cfg.maxOutputBytes),
        });
      };
      const t = setTimeout(() => {
        try { child.kill(); } catch { /* noop */ }
        finish(null, "超时 " + timeoutMs + "ms");
      }, timeoutMs);
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("error", (e) => { clearTimeout(t); finish(null, "启动失败: " + e.message); });
      child.on("close", (c) => { clearTimeout(t); finish(c); });
    });
  }

  const tools = [
    {
      name: "get_project_info",
      description: "获取项目根目录、当前权限开关与可用工具清单。建议第一步先调用它。",
      inputSchema: { type: "object", properties: {} },
      handler: async () => raw({
        projectDir: ROOT,
        platform: os.platform(),
        node: process.version,
        permissions: { read: true, write: !!cfg.allowWrite, exec: !!cfg.allowExec },
        allowedCommands: cfg.allowExec ? cfg.allowedCommands : [],
      }),
    },
    {
      name: "list_files",
      description: "列出项目内所有文件（自动跳过 node_modules/.git 等）。",
      inputSchema: { type: "object", properties: {} },
      handler: async () => raw(walk(ROOT).join("\n") || "(空目录)"),
    },
    {
      name: "read_file",
      description: "读取项目内的文本文件。path 相对于项目根目录。",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: async ({ path: p }) => {
        const abs = safe(p);
        const st = fs.statSync(abs);
        if (st.size > cfg.maxReadBytes) throw new Error("文件过大（" + st.size + " 字节）");
        return raw(fs.readFileSync(abs, "utf8"));
      },
    },
    {
      name: "search",
      description: "在项目内做文本搜索，返回 file:line: 内容。regex=true 时按正则解释。",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, regex: { type: "boolean" }, max: { type: "number" } },
        required: ["query"],
      },
      handler: async ({ query, regex, max }) => {
        const re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const hits = [];
        const limit = max || 60;
        for (const f of walk(ROOT)) {
          if (hits.length >= limit) break;
          let text;
          try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= limit) break;
            if (re.test(lines[i])) hits.push(f + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 200));
          }
        }
        return raw(hits.join("\n") || "(无匹配)");
      },
    },
  ];

  if (cfg.allowWrite) {
    tools.push({
      name: "write_file",
      description: "写入或覆盖项目内的文本文件（父目录自动创建）。path 相对于项目根目录。",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async ({ path: p, content }) => {
        const abs = safe(p);
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > cfg.maxWriteBytes) throw new Error("内容过大（" + bytes + " 字节）");
        const existed = fs.existsSync(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        log("[write] " + rel(abs) + "  " + bytes + " 字节  " + (existed ? "覆盖" : "新建"));
        return raw({ ok: true, path: rel(abs), bytes, created: !existed });
      },
    });

    tools.push({
      name: "apply_patch",
      description: "把文件里的一段文本替换成另一段。old_string 必须在文件中唯一出现。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
      handler: async ({ path: p, old_string, new_string }) => {
        const abs = safe(p);
        const before = fs.readFileSync(abs, "utf8");
        const count = before.split(old_string).length - 1;
        if (count === 0) throw new Error("文件里找不到 old_string");
        if (count > 1) throw new Error("old_string 匹配到 " + count + " 处，请让它唯一");
        fs.writeFileSync(abs, before.replace(old_string, new_string), "utf8");
        log("[patch] " + rel(abs));
        return raw({ ok: true, path: rel(abs) });
      },
    });
  }

  if (cfg.allowExec) {
    tools.push({
      name: "run_command",
      description: "在项目目录内执行命令。只允许白名单内的可执行文件，不使用 shell 字符串拼接。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
      },
      handler: async ({ command, args }) => {
        const name = String(command).replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
        if (!cfg.allowedCommands.includes(name)) {
          throw new Error("命令不在白名单内: " + command + "（允许: " + cfg.allowedCommands.join(", ") + "）");
        }
        log("[exec] " + name + " " + (args || []).join(" "));
        const r = await runCmd(command, args || [], cfg.commandTimeoutMs);
        return raw({ exitCode: r.code, note: r.note, stdout: r.stdout, stderr: r.stderr });
      },
    });
  }

  return tools;
}
