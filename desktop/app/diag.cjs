// 诊断版主进程：把每一步都写入文件，定位闪退点。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const LOG = path.resolve(__dirname, "..", "..", ".arena-bridge", "diag.log");
try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); } catch {}
try { fs.writeFileSync(LOG, ""); } catch {}
const say = (m) => {
  const line = new Date().toISOString() + "  " + m + "\n";
  try { fs.appendFileSync(LOG, line); } catch {}
  console.log("[diag] " + m);
};

say("1. 脚本已加载, electron=" + process.versions.electron + " node=" + process.versions.node);
say("2. argv=" + JSON.stringify(process.argv.slice(0, 5)));

process.on("uncaughtException", (e) => { say("UNCAUGHT: " + e.message + "\n" + e.stack); });
process.on("unhandledRejection", (e) => { say("UNHANDLED: " + (e && e.message || e)); });

say("3. app 对象: " + (app ? "有" : "无"));

app.whenReady().then(() => {
  say("4. app ready");

  let win;
  try {
    win = new BrowserWindow({
      width: 1200, height: 800, show: true,
      webPreferences: {
        partition: "persist:arena-bridge",
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    say("5. BrowserWindow 已创建");
  } catch (e) {
    say("创建窗口失败: " + e.message);
    return;
  }

  win.on("closed", () => say("窗口被关闭"));
  win.webContents.on("did-finish-load", () => say("6. 页面加载完成"));
  win.webContents.on("did-fail-load", (_e, code, desc) => say("页面加载失败: " + code + " " + desc));
  win.webContents.on("render-process-gone", (_e, d) => say("渲染进程崩溃: " + JSON.stringify(d)));
  win.on("unresponsive", () => say("窗口无响应"));

  win.loadURL("https://arena.ai/agent").then(() => say("7. loadURL 已 resolve"))
    .catch((e) => say("loadURL 失败: " + e.message));

  setTimeout(() => {
    say("8. 5 秒后: 窗口可见=" + win.isVisible() + " 句柄=" + win.getNativeWindowHandle().length + " 销毁=" + win.isDestroyed());
  }, 5000);
}).catch((e) => say("whenReady 失败: " + e.message));
