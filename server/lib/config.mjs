// 配置：首次运行自动生成 config.json（含随机访问密钥）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const DIR = path.join(ROOT, ".arena-bridge");
export const FILE = path.join(DIR, "config.json");

const DEFAULTS = {
  port: 8788,
  token: "",
  projectDir: "",
  allowWrite: false,
  allowExec: false,
  // 权限档位：sandbox=路径锁项目内+命令白名单 / full=不限路径与命令。
  // 桌面版面板上的两个档位按钮就是改这个字段（两边共用同一份 config.json）。
  permission: "sandbox",
  // 注意 powershell/pwsh/cmd 是 shell：它们进白名单后，白名单就不再是安全边界。
  allowedCommands: ["node", "npm", "npx", "pnpm", "yarn", "git", "python", "py", "tsc", "go", "cargo", "make",
                    "powershell", "pwsh", "cmd"],
  maxReadBytes: 524288,
  maxWriteBytes: 524288,
  maxOutputBytes: 65536,
  commandTimeoutMs: 180000,
};

export function load() {
  fs.mkdirSync(DIR, { recursive: true });
  let cfg = {};
  if (fs.existsSync(FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { cfg = {}; }
  }
  const out = { ...DEFAULTS, ...cfg };
  let changed = !fs.existsSync(FILE);
  if (!out.token) { out.token = crypto.randomBytes(24).toString("hex"); changed = true; }
  if (!out.projectDir) {
    out.projectDir = path.join(ROOT, "example-workspace");
    fs.mkdirSync(out.projectDir, { recursive: true });
    changed = true;
  }
  if (changed) fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n");
  return out;
}

export function save(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + "\n");
}

export { DEFAULTS };
