// 免费公网隧道：cloudflared Quick Tunnel（无需账号、无需域名）。
import { spawn } from "node:child_process";
import fs from "node:fs";

const CANDIDATES = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  "/usr/local/bin/cloudflared",
  "/opt/homebrew/bin/cloudflared",
  "/usr/bin/cloudflared",
];

export function findCloudflared() {
  for (const c of CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  return "cloudflared";   // 交给 PATH
}

export function startTunnel({ localPort, onUrl, onLog }) {
  const log = onLog || (() => {});
  const bin = findCloudflared();
  log("启动隧道: " + bin);

  const child = spawn(bin, ["tunnel", "--url", "http://127.0.0.1:" + localPort, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let announced = false;
  const scan = (buf) => {
    const s = String(buf);
    if (!announced) {
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { announced = true; onUrl(m[0]); }
    }
    for (const ln of s.split(/\r?\n/)) {
      if (/\bERR\b|failed to|error/i.test(ln) && ln.trim()) {
        log("cloudflared: " + ln.trim().slice(0, 150));
      }
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  child.on("error", (e) => log("cloudflared 启动失败: " + e.message + "（可加 --no-tunnel 只用本机地址）"));

  return { stop() { try { child.kill(); } catch { /* noop */ } }, get ready() { return announced; } };
}
