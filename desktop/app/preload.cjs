// preload：唯一的 UI —— 右侧「Arena Bridge」卡片。
//
// 设计目标：贴合 arena.ai 自身的视觉语言。
// Arena 是 shadcn/ui + HSL 三元组变量（--surface-primary: 36 45% 98% 这种），
// 所以这里不写死颜色，而是在运行时把页面上的变量读出来复用，
// 换主题（浅色/深色）时面板会跟着变。
//
// 模型状态来自 MAIN world 的探针：因为 contextIsolation:true，
// preload 读不到 window.__amp3State，探针改用 window.postMessage 广播。
const { ipcRenderer } = require("electron");

const PANEL_ID = "arena-bridge-panel";
const COLLAPSE_KEY = "ab-panel-collapsed";

let status = null;      // 主进程推来的 MCP 信息
let probe = null;       // 探针广播的模型状态
let gacha = { running: false, total: 0, done: 0, hits: [] };
let blockReported = false;   // 本轮抽卡已经报过拦截，别重复上报
// log() 定义在 build() 里，模块级代码（消息监听等）够不到它 ——
// 之前在这里直接调 log() 会抛 "log is not defined"，把后面的逻辑整个带崩。
let panelLog = () => {};
// 关键信息同时写进 desktop.log（面板日志区外部读不到）
function noteToFile(m) {
  try { ipcRenderer.invoke("bridge:note", String(m == null ? "" : m)); } catch (e) {}
}

function reportBlocked(where) {
  if (blockReported) return;
  blockReported = true;
  gacha.running = false;
  try { ipcRenderer.send("gacha-blocked", { where: where || "页面" }); } catch (e) {}
  render();
}

/* ============ 按对话归档模型 ============
   模型是跟对话绑定的，但探针只在【收到新回复】时才知道模型名，
   所以重新打开一个历史对话时它是空的。
   这里把「对话 id → 模型」存进 localStorage，
   下次打开同一个对话就能把上次的结果显示出来。 */
const MODEL_KEY = "ab-models";
const GACHA_KEY = "ab-gacha";   // 抽卡设置：轮数 / 目标 / 命中即停 / 降频

/* 抽卡降频档位。真正的间隔数字在 main.cjs 的 PACES 表里，这里只负责选。
   「关」不是不能用 —— 只是实测抽到第 5~6 轮就弹过人机验证。 */
/* 抽卡提示词预设。留空 = 用内置短问句轮换。
   "只回数字1" 是群里普遍在用的那句：回答只有一个 token，回合立刻结束，
   模型名（在回合结束后才写的 usage span 里）也就出得早。
   注意：限流是按【次数】算的，短提示词帮不上忙 —— 反而因为跑得快，
   5 分钟窗口里的 30 次会更快用完。 */
const PROMPT_PRESETS = [
  ["", "内置问句"],
  ["只回答数字 1，不要补充", "只回数字1"],
];

/* 降频档位 —— 注意这【不】包含守株待兔。
   守株待兔不是"更慢的一档"，它是另一条轴：
     降频     = 我们主动限速（免得把人家服务当压测目标）
     守株待兔 = 一直抽到出目标；撞上限流就等，而不是停。
   而且它【特意】把间隔拉到 12~30 秒 —— 因为按次数算的限流
   （30 次 / 300 秒窗口）在 6 秒一轮下 3 分钟就打满，
   拉长间隔换来的正是"不被限"。把它塞进降频那一行会自相矛盾。 */
const PACES = [["off", "关"], ["std", "标准"], ["strong", "强"]];
const PACE_LABEL = { off: "关", std: "标准", strong: "强" };
let huntMode = false;
const PACE_TIP = {
  off: "不降频：轮间隔 2~5 秒、不歇。实测抽到第 5~6 轮弹过人机验证",
  std: "标准：轮间隔 6~15 秒，每 3 轮歇 45~90 秒（默认）",
  strong: "强降频：轮间隔 15~30 秒，每 2 轮歇 90~180 秒",
};
let gachaPace = "std";
const RENAME_KEY = "ab-rename"; // 是否把对话标题改成模型名
let renameOn = false;
let autoContinue = false;   // 自动点击「继续」（长任务无人值守用）
const renamedOnce = {};         // "对话id|名字" → 1，避免重复改名
const gotTier = {};             // "对话id|runId" → 1，本轮是否已经登记过带外补档

/* ============ 人机验证检测 ============
 * 只做「发现 → 立刻停」，绝不做任何绕过。
 * 触发验证是平台正当的风控，交给人工处理才对。 */
function detectChallenge() {
  try {
    // ① 真正的挑战弹窗（不是角落那个隐形徽标）
    const frames = document.querySelectorAll(
      'iframe[src*="/recaptcha/"][src*="bframe"], iframe[title*="recaptcha" i],' +
      'iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]'
    );
    for (const f of frames) {
      const r = f.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 80 && r.bottom > 0 && r.top < innerHeight) return "验证弹窗";
    }
    // ② 标题被换成拦截文案
    if (/just a moment|attention required|verify|人机|验证/i.test(document.title || "")) return "标题提示";
    // ③ 路由跳到挑战页
    if (/\/(challenge|verify|blocked|cdn-cgi)\b/i.test(location.pathname)) return "挑战页";
  } catch (e) {}
  return null;
}
// 只在抽卡进行中才做较重的整页文案扫描
function detectChallengeDeep() {
  const quick = detectChallenge();
  if (quick) return quick;
  try {
    const t = ((document.body && document.body.innerText) || "").slice(0, 6000);
    if (/verify you are human|确认您不是机器人|确认你不是机器人|人机验证|unusual traffic|检测到异常流量|请完成安全验证/i.test(t)) return "页面提示";
  } catch (e) {}
  return null;
}

/* 抽卡时发的话。
   原来用「你好 / hi / hello」—— 同一个词连发十几次太机械，也不产生信息。
   换成自然问句，一举两得：
     · 不像机器刷量
     · 模型的回答里可能自己报出身份（"我是 Claude，由 Anthropic 开发"） */
/* 用【短】问句：模型名是回合结束后才出现的，问得太宽（"你能做什么"）
   会引来长篇回答，把检测拖到超时。这几个都要求一句话作答。 */
const GREETINGS = [
  "你是什么模型？一句话回答",
  "你是哪家公司开发的？",
  "用一句话介绍你自己",
  "你的知识截止到什么时候？",
  "你叫什么名字？",
];
let greetIdx = Math.floor(Math.random() * GREETINGS.length);
function pickGreeting() {
  greetIdx = (greetIdx + 1) % GREETINGS.length;
  return GREETINGS[greetIdx];
}

function convId() {
  try {
    const m = (location.pathname || "").match(/\/agent\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}
function loadModelMap() {
  try { const o = JSON.parse(localStorage.getItem(MODEL_KEY) || "{}"); return (o && typeof o === "object") ? o : {}; }
  catch (e) { return {}; }
}
function saveModelMap(m) {
  try {
    const ks = Object.keys(m);
    if (ks.length > 300) {                       // 只留最近 300 条，别把 localStorage 撑爆
      ks.sort((a, b) => (m[b].at || 0) - (m[a].at || 0));
      for (const k of ks.slice(300)) delete m[k];
    }
    localStorage.setItem(MODEL_KEY, JSON.stringify(m));
  } catch (e) {}
}
const models = loadModelMap();
let lastConv = convId();

/* 合并种子档案：只补本地没有的，绝不覆盖已经真实检测到的结果 */
function mergeSeed(seed) {
  if (!seed || typeof seed !== "object") return;
  let dirty = false;
  for (const k of Object.keys(seed)) {
    const v = seed[k];
    if (!v || !v.model || models[k]) continue;
    models[k] = { model: v.model, tier: v.tier || "", at: v.at || Date.now(), seeded: true };
    dirty = true;
  }
  if (dirty) saveModelMap(models);
}

/* ============ 复用 Arena 自己的设计变量 ============ */
// 页面上的变量是 "H S% L%" 三元组，取不到就用浅色主题的默认值。
const TOKENS = {
  "--ab-surface":   ["--surface-primary",     "36 45% 98%"],
  "--ab-surface2":  ["--surface-secondary",   "0 0% 100%"],
  "--ab-surface3":  ["--surface-tertiary",    "33 31% 94%"],
  "--ab-text":      ["--text-primary",        "24 6% 17%"],
  "--ab-text2":     ["--text-secondary",      "30 7% 24%"],
  "--ab-muted":     ["--text-muted",          "37 5% 52%"],
  "--ab-border":    ["--border-medium",       "30 9% 87%"],
  "--ab-border2":   ["--border-faint",        "30 5% 93%"],
  "--ab-link":      ["--interactive-link",    "208 77% 52%"],
  "--ab-ok":        ["--interactive-positive","125 49% 43%"],
  "--ab-warn":      ["--interactive-warning", "48 93% 45%"],
  "--ab-bad":       ["--interactive-negative","2 63% 54%"],
  "--ab-accent":    ["--brand-yellow-6",      "47 95% 49%"],
  "--ab-cta":       ["--interactive-cta",     "60 3% 14%"],
  "--ab-oncta":     ["--interactive-on-cta",  "36 45% 98%"],
  "--ab-cta2":      ["--interactive-cta-secondary", "0 0% 100%"],
  "--ab-cta2hover": ["--interactive-cta-secondary-hover", "34 23% 89%"],
};

function readTokens() {
  const out = {};
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch (e) {}
  for (const key of Object.keys(TOKENS)) {
    const [src, fallback] = TOKENS[key];
    let v = "";
    try { v = (cs && cs.getPropertyValue(src)) || ""; } catch (e) {}
    out[key] = (v && v.trim()) ? v.trim() : fallback;
  }
  // 字体也跟随 Arena
  let font = "";
  try { font = getComputedStyle(document.body).fontFamily || ""; } catch (e) {}
  if (!font || /^(inherit|)$/i.test(font.trim())) font = "system-ui,-apple-system,'Segoe UI',sans-serif";
  out["--ab-font"] = font;
  return out;
}

/* ============ 样式 ============ */
function css(t) {
  // 把取到的 Arena 变量声明在 :host 上，shadow 内部就能直接用 var(--ab-*)
  const vars = Object.keys(t).map((k) => k + ":" + t[k]).join(";");
  return [
    ":host{all:initial;" + vars + "}",
    "*{box-sizing:border-box}",
    ".wrap{position:fixed;right:14px;bottom:14px;z-index:2147483647;",
    "width:212px;font-family:var(--ab-font);font-size:12px;line-height:1.45;",
    "color:hsl(var(--ab-text));background:hsl(var(--ab-surface2));",
    "border:1px solid hsl(var(--ab-border));border-radius:12px;overflow:hidden;",
    "box-shadow:0 8px 28px -8px hsl(var(--ab-text) / .18),0 2px 8px -2px hsl(var(--ab-text) / .08)}",
    // 收起态是个完整圆角的胶囊：不管停在哪都像个正常控件，
    // 不再用"贴右边"的半圆角侧条（拖动后的内联定位会把它顶到页面中间）
    ".wrap.hide{width:auto;border-radius:999px}",
    ".wrap.hide .body{display:none}.wrap.hide .rail{display:flex}",

    ".rail{display:none;align-items:center;gap:7px;padding:7px 12px;cursor:grab;",
    "white-space:nowrap;user-select:none;font-size:11px;font-weight:600;",
    "letter-spacing:-.01em;color:hsl(var(--ab-text));max-width:230px}",
    ".rail:hover{background:hsl(var(--ab-surface3) / .65)}",
    ".rail:active{cursor:grabbing}",
    // 注意：这里的 class 必须叫 .rlbl —— 叫 .lbl 会撞上面板小节标题那套样式
    // （9.5px + uppercase + margin-bottom:5px），导致文字被顶高 2.5px 且模型名被强制大写
    ".rail .rlbl{overflow:hidden;text-overflow:ellipsis;line-height:1}",
    ".rail .lvl{font-size:9px;font-weight:650;padding:1px 5px;border-radius:999px;",
    "background:hsl(var(--ab-accent) / .2);color:hsl(var(--ab-warn))}",

    ".hd{display:flex;align-items:center;gap:7px;padding:9px 11px;cursor:move;",
    "border-bottom:1px solid hsl(var(--ab-border2));background:hsl(var(--ab-surface3) / .5);",
    "touch-action:none;user-select:none}",
    ".x{cursor:pointer !important}",
    ".dot{width:7px;height:7px;border-radius:50%;background:hsl(var(--ab-muted));flex:0 0 auto}",
    ".dot.on{background:hsl(var(--ab-ok))}",
    ".dot.warn{background:hsl(var(--ab-warn))}",
    ".dot.live{background:hsl(var(--ab-ok));animation:ab-p 1.4s ease-in-out infinite}",
    "@keyframes ab-p{0%,100%{opacity:1}50%{opacity:.3}}",
    ".ttl{flex:1;font-size:11.5px;font-weight:600;letter-spacing:-.01em}",
    ".x{cursor:pointer;color:hsl(var(--ab-muted));padding:1px 3px;border-radius:4px;",
    "font-size:13px;line-height:1;user-select:none}",
    ".x:hover{background:hsl(var(--ab-surface3));color:hsl(var(--ab-text))}",

    ".body{max-height:74vh;overflow:auto;overscroll-behavior:contain}",
    ".sec{padding:11px 11px 0}",
    ".sec:last-child{padding-bottom:11px}",
    ".lbl{font-size:9.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;",
    "color:hsl(var(--ab-muted));margin-bottom:5px}",

    ".model{font-size:12.5px;font-weight:650;letter-spacing:-.01em;word-break:break-all;",
    "line-height:1.3}",
    ".model.ok{color:hsl(var(--ab-ok))}",
    ".model.fast{color:hsl(var(--ab-link))}",
    ".model.none{font-weight:400;font-size:11.5px;color:hsl(var(--ab-muted))}",
    ".model.hist{color:hsl(var(--ab-text2))}",   // 历史记录：正常色但弱一档，区别于本轮的绿
    ".hint{font-size:9.5px;line-height:1.4;color:hsl(var(--ab-muted));margin-top:3px}",

    ".pill{display:inline-flex;align-items:center;gap:4px;margin-top:5px;padding:2.5px 7px;",
    "border-radius:999px;font-size:10px;font-weight:650;letter-spacing:.04em}",
    ".pill.on{background:hsl(var(--ab-accent) / .18);color:hsl(var(--ab-warn));",
    "border:1px solid hsl(var(--ab-accent) / .45)}",
    ".pill.off{background:hsl(var(--ab-surface3));color:hsl(var(--ab-muted));border:1px solid hsl(var(--ab-border2))}",

    ".kv{display:flex;gap:6px;font-size:10.5px;padding:1.5px 0;color:hsl(var(--ab-text2))}",
    ".kv .k{color:hsl(var(--ab-muted));flex:0 0 auto;min-width:52px}",
    ".kv .v{flex:1;word-break:break-all}",
    ".kv .v.ok{color:hsl(var(--ab-ok))}.kv .v.warn{color:hsl(var(--ab-warn))}",
    ".more{margin-top:5px;font-size:10.5px;color:hsl(var(--ab-muted));cursor:pointer;",
    "user-select:none;display:inline-block}",
    ".more:hover{color:hsl(var(--ab-link))}",
    ".detail{display:none}.detail.show{display:block}",

    ".url{font-family:var(--ab-font-mono,ui-monospace,Consolas,monospace);font-size:9.5px;",
    "line-height:1.35;padding:6px 7px;border-radius:6px;background:hsl(var(--ab-surface3) / .55);",
    "border:1px solid hsl(var(--ab-border2));color:hsl(var(--ab-text2));word-break:break-all;",
    "max-height:44px;overflow:auto;cursor:pointer;transition:background .12s}",
    ".url:hover{background:hsl(var(--ab-surface3))}",
    ".url.none{color:hsl(var(--ab-muted));cursor:default}",
    ".url.copied{background:hsl(var(--ab-ok) / .14);border-color:hsl(var(--ab-ok) / .5)}",

    "button{font-family:inherit;width:100%;padding:7px 10px;border-radius:8px;cursor:pointer;",
    "font-size:11.5px;font-weight:600;letter-spacing:-.01em;border:1px solid transparent;",
    "transition:background .12s,opacity .12s;margin-top:6px}",
    "button.p{background:hsl(var(--ab-cta));color:hsl(var(--ab-oncta))}",
    "button.p:hover{opacity:.88}",
    "button.s{background:hsl(var(--ab-cta2));color:hsl(var(--ab-text));",
    "border-color:hsl(var(--ab-border))}",
    "button.s:hover{background:hsl(var(--ab-cta2hover))}",
    "button.g{background:hsl(var(--ab-accent));color:hsl(var(--ab-text))}",
    "button.g:hover{filter:brightness(.95)}",
    "button.r{background:hsl(var(--ab-bad));color:#fff}",
    "button.r:hover{opacity:.88}",
    "button:disabled{opacity:.45;cursor:default}",

    ".gopt{display:flex;align-items:center;gap:6px;margin-bottom:5px}",
    ".gl{font-size:10px;color:hsl(var(--ab-muted));flex:0 0 26px}",
    ".gi{flex:1;min-width:0;font-family:inherit;font-size:11px;line-height:1.3;",
    "padding:4px 7px;border-radius:6px;border:1px solid hsl(var(--ab-border));",
    "background:hsl(var(--ab-surface2));color:hsl(var(--ab-text));outline:none}",
    ".gi:focus{border-color:hsl(var(--ab-link))}",
    ".gi:disabled{opacity:.5}",
    ".gchk{display:flex;align-items:center;gap:5px;margin:6px 0 1px;cursor:pointer;",
    "user-select:none;font-size:10.5px;color:hsl(var(--ab-text2))}",
    ".gchk input{accent-color:hsl(var(--ab-cta));margin:0}",
    ".gwarn{margin:6px 0 2px;padding:6px 8px;border-radius:6px;font-size:10px;line-height:1.5;",
    "background:hsl(var(--ab-bad) / .1);border:1px solid hsl(var(--ab-bad) / .45);color:hsl(var(--ab-bad))}",
    ".chips{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 4px}",
    ".chip{font-size:9.5px;font-weight:600;padding:2.5px 7px;border-radius:999px;cursor:pointer;",
    "border:1px solid hsl(var(--ab-border));background:hsl(var(--ab-surface2));",
    "color:hsl(var(--ab-text2));user-select:none}",
    ".chip:hover{background:hsl(var(--ab-surface3))}",
    ".chip.on{background:hsl(var(--ab-accent) / .22);border-color:hsl(var(--ab-accent) / .6);",
    "color:hsl(var(--ab-warn))}",
    ".gsum{font-size:9.5px;color:hsl(var(--ab-muted));margin-top:6px;line-height:1.5}",
    ".gsum.warn{color:hsl(var(--ab-warn))}",
    ".gsum.bad{color:hsl(var(--ab-bad));font-weight:600}",
    ".hits{margin-top:5px;max-height:118px;overflow:auto}",
    ".hit.win{background:hsl(var(--ab-accent) / .14);border-radius:5px;padding-left:4px;padding-right:4px}",
    ".hit .n.win{color:hsl(var(--ab-warn))}",
    ".hit{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:10.5px;",
    "border-bottom:1px solid hsl(var(--ab-border2))}",
    ".hit:last-child{border-bottom:0}",
    ".hit .n{flex:1;font-weight:600;word-break:break-all;letter-spacing:-.01em}",
    ".hit .n.ok{color:hsl(var(--ab-ok))}",
    ".hit .b{font-size:9px;font-weight:650;padding:1.5px 5px;border-radius:999px;",
    "background:hsl(var(--ab-accent) / .2);color:hsl(var(--ab-warn))}",
    ".empty{font-size:10.5px;color:hsl(var(--ab-muted));padding:2px 0}",

    ".log{margin-top:10px;padding:8px 11px 11px;border-top:1px solid hsl(var(--ab-border2));",
    "font-family:ui-monospace,Consolas,monospace;font-size:9px;line-height:1.5;",
    "color:hsl(var(--ab-muted));max-height:78px;overflow:auto}",
    ".log div{white-space:pre-wrap;word-break:break-all}",
  ].join("");
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ 构建 ============ */
let root = null;
function build() {
  if (document.getElementById(PANEL_ID)) return;
  const host = document.createElement("div");
  host.id = PANEL_ID;
  root = host.attachShadow({ mode: "open" });

  let tk = {};
  try { tk = readTokens(); } catch (e) { tk = {}; }

  const st = document.createElement("style");
  st.textContent = css(tk);
  root.appendChild(st);

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.innerHTML =
    '<div class="rail" id="rail" title="点一下展开 · 可拖动（双击复位）"><span class="dot" id="rdot"></span>' +
      '<span class="rlbl" id="rlabel">Arena Bridge</span><span class="lvl" id="rlvl" style="display:none"></span></div>' +
    '<div class="body">' +
      '<div class="hd"><span class="dot" id="hdot"></span>' +
      '<span class="ttl">Arena Bridge</span>' +
      '<span class="x" id="collapse" title="收起">\u203a</span></div>' +

      '<div class="sec"><div class="lbl" id="mlblTop">本轮模型</div>' +
        '<div class="model none" id="model">尚未开始</div>' +
        '<div class="hint" id="mhint"></div>' +
        '<div id="pillWrap"></div>' +
        '<span class="more" id="more">详情</span>' +
        '<label class="gchk" style="margin-top:6px">' +
          '<input type="checkbox" id="rnChk">' +
          '<span>把对话标题改成模型名</span></label>' +
        '<label class="gchk">' +
          '<input type="checkbox" id="acChk">' +
          '<span>自动点击「继续」（长任务无人值守）</span></label>' +
        '<span class="more" id="doRename" style="margin-left:10px" ' +
          'title="立刻把当前对话标题改成检测到的模型名">改名</span>' +
        '<span class="more" id="trace" style="margin-left:10px" ' +
          'title="把本轮 run trace 原文导出到 .arena-bridge/diag-trace.json，用来核对档位等信息">导出 trace</span>' +
        '<div class="detail" id="detail"></div>' +
      "</div>" +

      '<div class="sec"><div class="lbl" id="mlbl">MCP</div>' +
        '<div class="chips" id="perms"></div>' +
        '<div class="url none" id="url">获取中\u2026</div>' +
        '<div class="gsum" id="stline"></div>' +
        '<button class="s" id="pdir">选择项目目录\u2026</button>' +
        '<div class="gsum" id="pdirShow" title="Agent 只能在这个目录内读写">\u2026</div>' +
        '<button class="p" id="connect" title="在当前对话里连接 MCP，不会新开对话">一键连接并开工</button>' +
      "</div>" +

      '<div class="sec"><div class="lbl">抽卡</div>' +
        '<div class="gopt"><span class="gl">轮数</span>' +
          '<input class="gi" id="gRounds" type="number" min="1" max="200" step="1" value="10"' +
          ' title="建议 5~10。抽太快会触发平台的人机验证"></div>' +
        '<div class="gopt"><span class="gl">目标</span>' +
          '<input class="gi" id="gTargets" type="text" placeholder="gpt-6,fable-5.1"></div>' +
        '<div class="chips" id="gChips"></div>' +
        '<div class="gopt"><span class="gl">提示词</span>' +
          '<input class="gi" id="gPrompt" type="text" placeholder="留空=轮流用内置短问句"></div>' +
        '<div class="chips" id="pChips" style="margin:0 0 4px 32px"></div>' +
        '<div class="gopt"><span class="gl">降频</span>' +
          '<div class="chips" id="gPace" style="flex:1;margin:0"></div></div>' +
        '<label class="gchk"><input type="checkbox" id="gStop" checked><span>抽到目标就停</span></label>' +
        '<label class="gchk" title="带档位的内部名比显示名晚 8~9 秒才出现。关掉更快，但名字上就没有 -max / -low 后缀">' +
          '<input type="checkbox" id="gTier" checked><span>等档位（借轮间隔等，几乎不额外花时间）</span></label>' +
        '<label class="gchk" title="一直抽，直到抽出目标列表里的第 1 个模型。间隔 12~30 秒（按次数算的限流：30 次/300 秒，抽太快 3 分钟就打满）。撞上限流/额度见底会自动等，而不是停。">' +
          '<input type="checkbox" id="gHunt"><span>守株待兔（一直抽到出目标；撞限流就等）</span></label>' +
        '<div class="gsum" id="qline"></div>' +
        '<div class="gsum" id="bline"></div>' +
        '<div class="gsum" id="chgline"></div>' +
        '<div id="gwarn"></div>' +
        '<div id="gctrl"></div>' +
        '<div class="gsum" id="gsum"></div>' +
        '<div class="hits" id="hits"><div class="empty">暂无结果</div></div>' +
      "</div>" +

      '<div class="log" id="log"></div>' +
    "</div>";

  root.appendChild(wrap);
  (document.body || document.documentElement).appendChild(host);

  const $ = (id) => root.getElementById(id);
  const log = (m) => {
    const l = $("log"); if (!l) return;
    const d = document.createElement("div");
    d.textContent = m;
    l.appendChild(d);
    while (l.childNodes.length > 40) l.removeChild(l.firstChild);
    l.scrollTop = l.scrollHeight;
  };

  // 重命名开关
  try {
    renameOn = localStorage.getItem(RENAME_KEY) === "1";
    $("rnChk").checked = renameOn;
  } catch (e) {}
  // 权限开关：点一下就生效（主进程会重建工具表）
  $("perms").addEventListener("click", (e) => {
    const p = e.target && e.target.getAttribute && e.target.getAttribute("data-p");
    if (!p) return;
    const cur = !!(status && status[p]);
    if (!cur && p === "allowExec") {
      const cmds = (status && status.allowedCommands) || [];
      if (!confirm("允许 Agent 在你电脑上执行命令？\n\n" +
                   "只能执行白名单里的：\n" + cmds.join(", ") + "\n\n" +
                   "工作目录被限制在项目目录内，不拼接 shell 字符串。\n" +
                   "但命令本身能读写的东西不受我们控制 —— 请确认你信任这次任务。\n\n" +
                   "随时可以再点一下关掉。")) return;
    }
    ipcRenderer.invoke("bridge:set", { [p]: !cur });
  });

  // 事件委托：标签行重绘后依然有效
  $("gChips").addEventListener("click", (e) => {
    const t = e.target && e.target.getAttribute && e.target.getAttribute("data-t");
    if (t) toggleTarget(t);
  });
  $("gTargets").addEventListener("input", () => render());

  // 守株待兔：勾了就无限抽，撞限流/额度见底自动等
  if ($("gHunt")) $("gHunt").onchange = () => {
    huntMode = !!$("gHunt").checked;
    try {
      const g = JSON.parse(localStorage.getItem(GACHA_KEY) || "{}");
      g.hunt = huntMode;
      localStorage.setItem(GACHA_KEY, JSON.stringify(g));
    } catch (e) {}
    log(huntMode
      ? "守株待兔：已开（一直抽到目标出现；间隔 12~30 秒；撞限流/额度见底自动等）"
      : "守株待兔：已关");
  };

  // 提示词预设：点一下直接填进去（还能手改）
  $("pChips").addEventListener("click", (e) => {
    const t = e.target && e.target.getAttribute && e.target.getAttribute("data-p");
    if (t === null || t === undefined) return;
    $("gPrompt").value = t;
    try {
      const g = JSON.parse(localStorage.getItem(GACHA_KEY) || "{}");
      g.prompt = t;
      localStorage.setItem(GACHA_KEY, JSON.stringify(g));
    } catch (err) {}
    log(t ? ("抽卡提示词 → " + t) : "抽卡提示词 → 内置短问句轮换");
    render();
  });
  $("gPrompt").addEventListener("input", () => render());

  // 降频档位：点了立刻存，下一轮抽卡生效（正在跑的那轮不改）
  $("gPace").addEventListener("click", (e) => {
    const v = e.target && e.target.getAttribute && e.target.getAttribute("data-p");
    if (!v || !PACE_LABEL[v]) return;
    gachaPace = v;
    try {
      const g = JSON.parse(localStorage.getItem(GACHA_KEY) || "{}");
      g.pace = v;
      localStorage.setItem(GACHA_KEY, JSON.stringify(g));
    } catch (err) {}
    log("抽卡降频：" + PACE_LABEL[v] + "（" + PACE_TIP[v] + "）");
    render();
  });

  // 自动继续开关
  try {
    autoContinue = localStorage.getItem("ab-autocontinue") === "1";
    $("acChk").checked = autoContinue;
  } catch (e) {}
  $("acChk").onchange = () => {
    autoContinue = !!$("acChk").checked;
    try { localStorage.setItem("ab-autocontinue", autoContinue ? "1" : "0"); } catch (e) {}
    log(autoContinue ? "已开启：自动点击「继续」" : "已关闭自动继续");
  };

  $("rnChk").onchange = () => {
    renameOn = !!$("rnChk").checked;
    try { localStorage.setItem(RENAME_KEY, renameOn ? "1" : "0"); } catch (e) {}
    log(renameOn ? "已开启：检测到模型后重命名对话" : "已关闭重命名");
  };

  // 恢复上次的抽卡设置
  try {
    const g = JSON.parse(localStorage.getItem(GACHA_KEY) || "{}");
    if (g.rounds) $("gRounds").value = g.rounds;
    $("gTargets").value = (typeof g.targets === "string" && g.targets) ? g.targets : "gpt-6,fable-5.1";
    if (typeof g.prompt === "string") $("gPrompt").value = g.prompt;
    if (g.stopOnHit === false) $("gStop").checked = false;
    if (g.awaitTier === false) $("gTier").checked = false;
    if (PACES.some((p) => p[0] === g.pace)) gachaPace = g.pace;
    huntMode = !!g.hunt;
    if ($("gHunt")) $("gHunt").checked = huntMode;
  } catch (e) {}

  try { if (localStorage.getItem(COLLAPSE_KEY) === "1") wrap.classList.add("hide"); } catch (e) {}
  /* 拖拽：标题栏和收起后的胶囊都能拖；双击复位到右下角 */
  const RESET = () => { wrap.style.left = "auto"; wrap.style.top = "auto"; wrap.style.right = "14px"; wrap.style.bottom = "14px"; };
  let wasDragged = false;   // 刚拖完那一下不算「点击」，否则松手会顺手展开/收起

  function makeDraggable(el) {
    let drag = false, sx = 0, sy = 0, ox = 0, oy = 0, lastTap = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.id === "collapse") return;
      // 双击复位：不能靠 dblclick 事件 —— 下面的 preventDefault() 按规范会
      // 抑制掉兼容性鼠标事件，dblclick 永远不触发。自己数两次点击。
      const now = Date.now();
      if (now - lastTap < 450) { lastTap = 0; wasDragged = false; RESET(); return; }
      lastTap = now;
      const r = wrap.getBoundingClientRect();
      drag = true; wasDragged = false;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!wasDragged && Math.abs(dx) + Math.abs(dy) < 4) return;   // 手抖几个像素不算拖
      wasDragged = true;
      const r = wrap.getBoundingClientRect();
      wrap.style.left = Math.max(4, Math.min(ox + dx, innerWidth - r.width - 4)) + "px";
      wrap.style.top = Math.max(4, Math.min(oy + dy, innerHeight - 40)) + "px";
      wrap.style.right = "auto"; wrap.style.bottom = "auto";
    });
    const end = (e) => { if (!drag) return; drag = false; try { el.releasePointerCapture(e.pointerId); } catch (x) {} };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  makeDraggable(root.querySelector(".hd"));
  makeDraggable(root.querySelector(".rail"));

  /* 把面板收回视口内。
     注意：爆炸半径随【尺寸】变化 —— 胶囊 160px、展开后 212px。
     如果只按当前宽度钳制，用户把胶囊拖到右下角再点开，
     多出来的宽度就会顶到窗口外（这就是"右下角打开变成这样"的原因）。
     所以尺寸一变就要重新钳一次。 */
  function clampIntoView() {
    // 没拖动过、或已双击复位（left 变成 "auto"）时交给 CSS。
    // 否则 parseFloat("auto") = NaN → 会被当成 0，把面板弹到左上角。
    if (!wrap.style.left || wrap.style.left === "auto") return;
    requestAnimationFrame(() => {
      const r = wrap.getBoundingClientRect();
      const nl = Math.max(4, Math.min(parseFloat(wrap.style.left) || 0, innerWidth - r.width - 4));
      const nt = Math.max(4, Math.min(parseFloat(wrap.style.top) || 0, innerHeight - r.height - 4));
      wrap.style.left = nl + "px";
      wrap.style.top = nt + "px";
    });
  }

  window.addEventListener("resize", clampIntoView);

  $("collapse").onclick = () => { wrap.classList.add("hide"); clampIntoView(); try { localStorage.setItem(COLLAPSE_KEY, "1"); } catch (e) {} };
  $("rail").onclick = () => {
    if (wasDragged) { wasDragged = false; return; }   // 刚拖完，这一下不算点击
    wrap.classList.remove("hide");
    clampIntoView();                                  // 变宽了，重新收进视口
    try { localStorage.setItem(COLLAPSE_KEY, "0"); } catch (e) {}
  };
  $("more").onclick = () => {
    const d = $("detail");
    d.classList.toggle("show");
    $("more").textContent = d.classList.contains("show") ? "收起" : "详情";
  };
  // 手动改名：立刻触发一次，结果同时写进 desktop.log 供排查
  $("doRename").onclick = async () => {
    const p = probe || {};
    const nm = p.internalModel || p.model || p.fastModel;
    if (!nm) { log("还没检测到模型，无法改名"); noteToFile("改名失败：尚未检测到模型"); return; }
    try {
      const got = await renameCurrentConversation(nm);
      log("已改名 → " + got);
      noteToFile("改名成功 → " + got);
    } catch (e) {
      log("改名失败: " + e.message);
      noteToFile("改名失败: " + e.message);
    }
  };

  // 导出 trace 原文（诊断"思考强度到底在不在里面"这类问题）
  $("trace").onclick = () => {
    try {
      window.postMessage({ source: "__amp3_cmd", cmd: "trace" }, "*");
      log("正在导出 trace…");
    } catch (e) { log("导出失败: " + e.message); }
  };

  $("url").onclick = () => {
    if (!status || !status.token) return;
    const u = mcpUrl();
    ipcRenderer.invoke("bridge:copy-url", status.publicUrl ? "public" : "local").catch(() => {});
    log("已复制 MCP 地址");
    const el = $("url");
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 700);
    void u;
  };

  /* ---- 一键连接并开工 ---- */
  $("connect").onclick = async () => {
    const btn = $("connect");
    btn.disabled = true; btn.textContent = "正在连接\u2026";
    try {
      const url = mcpUrl();
      const dir = status ? status.projectDir : "";
      if (!url) throw new Error("MCP 地址未就绪");
      // 关键：不新开对话。
      // MCP 是挂在当前对话上的，新开等于把刚抽到的模型扔掉 —— 这正是之前
      // "点一下就跳到新对话" 的原因。要换对话请自己点左侧 New Chat。
      const prompt =
        url + "\n\n" +
        "请连接上面这个 MCP 服务，它提供本机项目的读写能力（工作目录 " + dir + "）。\n" +
        "第一步调用 get_project_info 确认连接，然后简短说明你看到的工具。\n" +
        "之后我会直接给任务，你就能开始干活。";
      const ok = await fillAndSend(prompt);
      if (ok) { log("已在当前对话发送连接指令（模型保持不变）"); btn.textContent = "已连接 \u2713"; }
      else {
        try { await navigator.clipboard.writeText(prompt); } catch (e) {}
        log("自动发送失败，已复制到剪贴板");
        btn.textContent = "已复制，请粘贴";
      }
    } catch (e) {
      log("连接失败: " + e.message);
      btn.textContent = "重试";
    }
    setTimeout(() => { btn.disabled = false; btn.textContent = "一键连接并开工"; }, 2800);
  };

  ipcRenderer.on("bridge-status", (_e, s) => {
    status = s;
    if (s && s.seedModels) mergeSeed(s.seedModels);
    render();
  });
  ipcRenderer.on("bridge-log", (_e, m) => log(m));
  ipcRenderer.on("gacha-log", (_e, m) => log(m));
  ipcRenderer.on("gacha-state", (_e, s) => { gacha = Object.assign(gacha, s); render(); });
  /* 每一轮：开新对话 → 发一句招呼。
     三个检查点都盯着人机验证，撞到就立刻上报主进程停机。 */
  ipcRenderer.on("gacha-round", async () => {
    try {
      let c = detectChallengeDeep();
      if (c) return reportBlocked(c);

      await newConversation();
      await sleep(2200 + Math.random() * 2600);     // 2.2~4.8s，别刚开就贴字
      c = detectChallengeDeep();
      if (c) return reportBlocked(c);

      // 自定义提示词优先；留空则轮流用内置的短问句
      const custom = (($("gPrompt") && $("gPrompt").value) || "").trim();
      const msg = custom || pickGreeting();
      const ok = await fillAndSend(msg);
      log(ok ? "  已发送「" + msg + "」" : "  自动发送失败");

      await sleep(1300);
      c = detectChallengeDeep();
      if (c) return reportBlocked(c);
    } catch (e) { log("  出错: " + e.message); }
  });

  /* 自动点击「继续」。
     长任务里 Arena 偶尔会停下并给一个 Continue 按钮，不点就不往下走 ——
     无人值守跑长活时这是刚需。只认这一个按钮，不去碰别的弹窗
     （比如"此任务成功了吗?"那种，乱答会影响平台的数据）。 */
  const CONTINUE_RE = /^(Continue|Continue generating|继续生成|继续)$/i;
  setInterval(() => {
    if (!autoContinue) return;
    try {
      const scope = document.querySelector("main") || document.body;
      const btns = scope.querySelectorAll("button");
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i];
        if (b.disabled || !b.getClientRects().length) continue;
        const t = ((b.getAttribute("aria-label") || b.textContent) || "").trim();
        if (CONTINUE_RE.test(t)) {
          b.click();
          panelLog("自动点击了「" + t + "」");
          break;
        }
      }
    } catch (e) {}
  }, 3000);

  // 抽卡进行中定期瞄一眼，别等下一轮才发现被拦了
  setInterval(() => {
    if (!gacha.running || blockReported) return;
    const c = detectChallenge();
    if (c) reportBlocked(c);
  }, 2500);

  /* 主题跟随：Arena 切换浅色/深色时（<html> 上加 .dark），重新取变量刷新面板 */
  let lastTheme = document.documentElement.className;
  let themeTimer = null;
  try {
    new MutationObserver(() => {
      const now = document.documentElement.className;
      if (now === lastTheme) return;
      lastTheme = now;
      clearTimeout(themeTimer);
      themeTimer = setTimeout(() => {
        try {
          const nt = readTokens();
          const vars = Object.keys(nt).map((k) => k + ":" + nt[k]).join(";");
          if (st) st.textContent = css(nt);
        } catch (e) {}
      }, 120);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  } catch (e) {}

  // SPA 路由切换不一定有探针广播（例如从历史列表点进一个旧对话），自己盯一下
  setInterval(() => { if (convId() !== lastConv) render(); }, 900);

  panelLog = log;      // 接出来给模块级代码用
  render();
  window.__abPanel = { log, render, status: () => status, probe: () => probe, models: () => models };
}

/* ============ 页面操作 ============ */
async function newConversation() {
  const els = [...document.querySelectorAll("a[href='/agent'], button, a")];
  const btn = els.find((e) => /^(New Chat|新对话|新聊天)$/i.test((e.getAttribute("aria-label") || e.textContent || "").trim()));
  if (btn) { btn.click(); return true; }
  location.href = "https://arena.ai/agent";
  return true;
}

async function fillAndSend(text) {
  const el = document.querySelector("main div[contenteditable='true']") || document.querySelector("div[contenteditable='true']");
  if (!el) return false;
  el.focus();
  const range = document.createRange(); range.selectNodeContents(el);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  if (!document.execCommand("insertText", false, text)) return false;
  await sleep(800 + Math.random() * 1600);   // 打完字停一下再发，别秒发
  const send = [...document.querySelectorAll("button")].find((b) => {
    const lb = (b.getAttribute("aria-label") || b.textContent || "").trim();
    return /^(Send message|发送消息|发送)$/i.test(lb) && !b.disabled;
  });
  if (!send) return false;
  send.click();
  return true;
}

/* ============ 抽卡目标：快捷标签 ============
   这些是 Arena 真实存在的模型基名（取自其内部目录），
   用子串匹配所以能覆盖全部档位变体：
     gpt-6        → gpt-6-astra / -high / -low / -max / -medium
     fable-5.1    → claude-fable-5.1-max / -high / -low
     opus-5       → claude-opus-5-max / -high / -medium / -low
     gemini-3.8   → gemini-3.8-flash / -high / -low / -medium
                    （9/17 有传闻说这个"3.8 Flash"其实是没发布的 Gemini 4 Pro。
                      真伪可以看【内部名】—— 如果它不叫 3.8-flash，传闻就有实锤） */
const TARGET_PRESETS = ["gpt-6", "fable-5.1", "opus-5", "gpt-5.6-sol", "kimi-k3", "gemini-3.8"];

function splitTargets(s) {
  return String(s || "").split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
}
function targetInput() {
  const host = document.getElementById(PANEL_ID);
  return host && host.shadowRoot ? host.shadowRoot.getElementById("gTargets") : null;
}
function toggleTarget(t) {
  const el = targetInput();
  if (!el) return;
  const cur = splitTargets(el.value);
  const i = cur.indexOf(t);
  if (i >= 0) cur.splice(i, 1); else cur.push(t);
  el.value = cur.join(",");
  try {
    const opts = Object.assign({}, JSON.parse(localStorage.getItem(GACHA_KEY) || "{}"));
    opts.targets = el.value;
    localStorage.setItem(GACHA_KEY, JSON.stringify(opts));
  } catch (e) {}
  render();
}

/* ============ 把对话标题改成模型名 ============
   这样侧栏一眼就能看到每个对话抽到什么，不用逐个点开。
   DOM 上两个坑（参考别人踩过的）：
     · Radix 菜单要用合成 pointerdown 打开，普通 click 无效
     · 名称输入框是 React 受控组件，必须用原生 setter 写值再派发 input */
const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
const lbl = (e) => ((e && (e.getAttribute("aria-label") || e.textContent)) || "").trim();
const allQ = (q, root) => Array.from((root || document).querySelectorAll(q)).filter(vis);

function convKeyOf(href) {
  try {
    const u = new URL(href, location.href);
    if (u.origin !== "https://arena.ai") return null;
    // 容忍可选的语言前缀：/agent/<uuid> 或 /zh-CN/agent/<uuid>
    const m = u.pathname.replace(/\/+$/, "").match(/^(?:\/[a-zA-Z-]{2,7})?\/agent\/([0-9a-f-]{36})$/i);
    return m ? u.origin + "/agent/" + m[1].toLowerCase() : null;
  } catch (e) { return null; }
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v = null;
    try { v = fn(); } catch (e) {}
    if (v) return v;
    await sleep(150);
  }
  return null;
}

/* 元素是不是真的画在屏幕上。
   Radix 的菜单/对话框关掉后节点还留在 DOM 里（data-state="closed"），
   只数 [role="menuitem"] 会数到一堆幽灵节点 —— 实测就是这么坑的：
   菜单里明明有 Rename，却因为"数出来有 2 个"被判成"没出现"。 */
function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
/* 收掉任何还开着的菜单/对话框。
   关键：改名失败也必须收干净 —— 残留的菜单会让【后面每一轮】都失败。
   实测 01:59:29→01:59:53 连挂 5 次，直到导航把菜单清掉才恢复。 */
function closeOverlays() {
  try {
    for (const el of [document.activeElement, document.body]) {
      if (!el || !el.dispatchEvent) continue;
      for (const type of ["keydown", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
        }));
      }
    }
    document.body.click();
  } catch (e) {}
}

/* 改名。第二个参数是本对话的 uuid —— 传了就先核对一次，
   防止"模型是在 A 对话抽到的、可页面已经切到 B 对话"时把 B 改错名。 */
/* ── 改名：优先走 Arena 自己的接口，不再点 UI ──
   PATCH /api/history/agentic/{id}    body: {"title":"..."}
   这就是页面自带"重命名"用的同一个接口
   （来源：Ted 探针 2.8.0-Arena-Model-Probe-Lite 的 syncTitle）。

   为什么把点菜单换掉：
     ① 实测点菜单只有 60% 成功率 —— 幽灵节点、"恰好 1 个"判定、
        React 受控输入框把值覆写回旧标题、表单 pending 时按钮禁用，
        四种失败模式叠在一起；
     ② 接口可以改【任意】对话，包括已经切走的那几个 —— 这是点菜单做不到的，
        而"档位比显示名晚 8~9 秒"恰恰意味着我们经常在改名时已经走了。
   点菜单那条路保留着当兜底，接口不通时会自动回退。 */
async function renameByApi(id, name) {
  const r = await fetch(location.origin + "/api/history/agentic/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "content-type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ title: name }),
  });
  if (!r.ok) throw new Error("PATCH HTTP " + r.status);
  return name;
}

/* 改名排队，一次只跑一个（兜底那条路不能重叠，否则对话框会撞车）。 */
let renameChain = Promise.resolve();
function queueRename(newName, expectId, allowOther) {
  const p = renameChain.then(() => renameCurrentConversation(newName, expectId, allowOther));
  renameChain = p.catch(() => {});
  return p;
}

async function renameCurrentConversation(newName, expectId, allowOther) {
  const id = String(expectId || convId() || "").toLowerCase();
  const name = String(newName || "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!id) throw new Error("拿不到对话 id");
  if (!name) throw new Error("名称为空");

  try {
    const got = await renameByApi(id, name);
    noteToFile("改名(接口)成功 → " + got);
    return got;
  } catch (e) {
    noteToFile("改名(接口)失败: " + e.message + " —— 回退到点菜单");
  }

  if (!allowOther && convId() !== id) {
    throw new Error("接口改名失败，且已切到别的对话（回退路径必须停在该对话上）");
  }
  try {
    return await renameOnce(name, null);
  } finally {
    closeOverlays();
  }
}

/* ============ 待补档的 run（带外补 span）============
   每轮拿到 token 时记一笔 {对话id, runId, 猜的名字}。
   只处理最近这一条 + 每条最多试 3 次 —— 免得拿旧 token 反复空打。
   实测：档位在轮到点后约 1 秒就补上（日志里的「↑ 档位补上」）。 */
const pendRuns = [];
function rememberRun(id, runId, name) {
  if (!id || !runId) return;
  for (const r of pendRuns) if (r.runId === runId) return;
  pendRuns.push({ id: String(id).toLowerCase(), runId, name: name || "", tries: 0, at: Date.now() });
  while (pendRuns.length > 12) pendRuns.shift();
}
/* token 按 runId 单独要。
   不能拿"最新的那个 token"去查一个旧 run —— 授权范围不一样，会 403/404。
   探针按 run 存着一份（只留最近 8 个），这里是本地缓存。 */
const tokCache = {};
function requestToken(runId) {
  try { window.postMessage({ source: "__amp3_cmd", cmd: "tok-for", runId }, "*"); } catch (e) {}
}

/* 把一条积压的 run 解出来。token 来自探针广播（只有宿主说"还需要"时才播）。 */
const PEND_TTL_MS = 120000;     // 一条 run 最多追 2 分钟
const PEND_MAX_CALLS = 10;
async function resolvePending(entry, tok) {
  if (!tok) return false;
  if (Date.now() - entry.at > PEND_TTL_MS) { entry.done = true; return false; }
  entry.tries++;
  const r = await window.__amp3ExternalSpan(entry.runId, tok);
  if (!r || !r.ok || !r.model) return false;
  if (r.model === entry.name) { entry.done = true; return true; }
  try {
    await queueRename(r.model, entry.id, true);
    noteToFile("补档成功 → " + r.model + "（" + entry.id + "）");
    try { render(); } catch (err) {}
    entry.done = true;
    renamedOnce[entry.id + "|" + r.model] = 1;
    return true;
  } catch (e) {
    noteToFile("补档改名失败: " + e.message + "（" + entry.id + "）");
    return false;
  }
}

let draining = false;
async function drainPendRuns() {
  if (draining) return;                 // 状态每秒都在播，不加锁会连环重入
  draining = true;
  try {
    for (let i = pendRuns.length - 1; i >= 0; i--) {
      const e = pendRuns[i];
      if (e.done) continue;
      if (e.tries >= PEND_MAX_CALLS || Date.now() - e.at > PEND_TTL_MS) { e.done = true; continue; }
      const tok = tokCache[e.runId];
      if (!tok) {
        // 手上还没这个 run 的 token —— 每 5 秒问探针要一次，等应答
        if (!e.asked || Date.now() - e.asked > 5000) { e.asked = Date.now(); requestToken(e.runId); }
        continue;
      }
      try { await resolvePending(e, tok); } catch (err) {}
    }
    for (let i = pendRuns.length - 1; i >= 0; i--) if (pendRuns[i].done) pendRuns.splice(i, 1);
  } finally { draining = false; }
}

async function renameOnce(newName, expectId) {
  if (expectId && convId() !== String(expectId).toLowerCase()) {
    throw new Error("已经切到别的对话了，跳过改名");
  }
  const want = convKeyOf(location.href);
  if (!want) throw new Error("当前不在对话页");
  const name = String(newName || "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!name) throw new Error("名称为空");

  let links = allQ("a[href]").filter((a) => convKeyOf(a.href) === want);
  if (!links.length) {                       // 侧栏可能是收起的
    const opener = allQ("button").filter((b) => !b.disabled &&
      /^(Expand sidebar|Open sidebar|展开侧边栏|打开侧边栏)$/i.test(lbl(b)));
    if (opener.length === 1) { opener[0].click(); await sleep(700); }
    links = allQ("a[href]").filter((a) => convKeyOf(a.href) === want);
  }
  if (links.length !== 1) {
    const near = allQ("a[href]").map((a) => a.getAttribute("href") || "")
      .filter((h) => /agent/.test(h)).slice(0, 4);
    throw new Error("侧栏定位不到当前对话（找到 " + links.length + " 个；当前 " + want + "）" +
      (near.length ? "；附近链接 " + near.join(" | ") : ""));
  }

  const link = links[0];
  link.scrollIntoView({ block: "nearest" });
  await sleep(200);

  // 菜单按钮：中英文都要认（Arena 界面可能是中文）
  const MORE_RE = /^(More options|更多操作|更多选项|更多)$/i;
  const RENAME_RE = /^(Rename|重命名)( chat|对话)?$/i;
  let scope = link.parentElement;
  let more = allQ("button", scope).filter((b) => MORE_RE.test(lbl(b)));
  if (more.length !== 1 && scope && scope.parentElement) {
    scope = scope.parentElement;
    more = allQ("button", scope).filter((b) => MORE_RE.test(lbl(b)));
  }
  if (more.length !== 1) {
    const seen = allQ("button", scope || document).map((b) => lbl(b)).filter(Boolean).slice(0, 10);
    throw new Error("找不到 More options（" + more.length + " 个）。同级按钮: " + seen.join(" / "));
  }
  more[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  await sleep(450);

  let menuSeen = [];
  const mi = await waitFor(() => {
    const all = allQ('[role="menuitem"]');
    menuSeen = all.map((e) => lbl(e)).filter(Boolean);
    const hit = all.filter((e) => isVisible(e) && RENAME_RE.test(lbl(e)));
    return hit.length ? hit[hit.length - 1] : null;   // 有多个就取最后弹出来的那个
  }, 4000);
  if (!mi) throw new Error("Rename 菜单项没出现。菜单里有: " + (menuSeen.join(" / ") || "（空）"));
  mi.click();
  await sleep(500);

  let dlgSeen = [];
  const dlg = await waitFor(() => {
    const all = allQ('[role="dialog"],[role="alertdialog"]');
    dlgSeen = all.map((e) => (e.innerText || "").split("\n")[0].slice(0, 30)).filter(Boolean);
    const hit = all.filter((e) => isVisible(e) && /rename|重命名/i.test(e.innerText || ""));
    return hit.length ? hit[hit.length - 1] : null;
  }, 4000);
  if (!dlg) throw new Error("重命名对话框没出现。可见对话框: " + (dlgSeen.join(" / ") || "（无）"));

  const inp = allQ("input", dlg).filter((e) => e.type === "text" || !e.type);
  if (!inp.length) throw new Error("对话框里没有输入框");
  const input = inp[0];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const confirmBtn = () => allQ("button", dlg).filter((b) => RENAME_RE.test(lbl(b)) && !b.disabled)[0] || null;

  /* 填值必须回读确认 + 重试。
     实测 8 次「确认按钮不可用。对话框按钮: Cancel / Rename」——
     对话框刚挂载时 React 还会把 defaultValue 写回输入框，
     我们抢在前面设的值被覆盖掉，按钮就一直 disabled。
     所以设完要回读；值没进去就再来一遍。 */
  /* 往输入框里写字。
     光用「原生 setter + input 事件」在 React 受控组件上不可靠 ——
     实测值会被 React 用原值覆盖回去（错误信息里能看到"输入框现值=kimi-k3"，
     正是对话框打开时预填的旧标题）。
     execCommand("insertText") 走的是浏览器真正的输入通道，
     产生的是真 beforeinput/input 事件，React 一定认。 */
  function typeInto(el, val) {
    try { el.focus(); } catch (e) {}
    try {
      el.setSelectionRange(0, el.value.length);
      if (document.execCommand && document.execCommand("insertText", false, val) && el.value === val) return true;
    } catch (e) {}
    try {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {}
    return el.value === val;
  }

  let okBtn = null;
  for (let k = 0; k < 10 && !okBtn; k++) {
    typeInto(input, name);
    await sleep(500);
    if (input.value !== name) continue;            // 被 React 改回去了，重来
    okBtn = confirmBtn();
  }
  if (!okBtn) {
    const bs = allQ("button", dlg).map((b) => lbl(b) + (b.disabled ? "(禁用)" : "")).filter(Boolean).slice(0, 8);
    throw new Error("确认按钮不可用（输入框现值=" + JSON.stringify(input.value).slice(0, 40) + "）。对话框按钮: " + bs.join(" / "));
  }
  okBtn.click();
  await sleep(400);
  return name;
}

/* ============ 渲染（只在值变化时改 DOM，避免每秒重绘闪烁） ============ */
const memo = {};
function setHTML(sh, id, html) { if (memo[id] === html) return; memo[id] = html; const e = sh.getElementById(id); if (e) e.innerHTML = html; }
function setText(sh, id, txt) { if (memo[id] === txt) return; memo[id] = txt; const e = sh.getElementById(id); if (e) e.textContent = txt; }
function setCls(sh, id, cls) { if (memo[id + ":c"] === cls) return; memo[id + ":c"] = cls; const e = sh.getElementById(id); if (e) e.className = cls; }

// 只有隧道确认可用时才给公网地址；否则退回本机地址并标注，
// 免得把一个已失效的 trycloudflare 链接发给 Arena（那会得到 1033）。
function mcpUrl() {
  if (!status || !status.token) return "";
  const base = (status.tunnelState === "up" && status.publicUrl)
    ? status.publicUrl
    : "http://127.0.0.1:" + status.port;
  return base + "/mcp/" + status.token;
}
function tunnelUp() { return !!(status && status.tunnelState === "up" && status.publicUrl); }
function urlNote() {
  if (!status || !status.token) return "";
  return tunnelUp() ? "MCP · 公网地址" : "MCP · 隧道未就绪";
}

function row(k, v, cls) {
  return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v ' + (cls || "") + '">' + esc(v) + "</span></div>";
}

function render() {
  const sh = document.getElementById(PANEL_ID)?.shadowRoot;
  if (!sh) return;
  const p = probe || {};

  /* ---- 模型名：本轮优先，其次这个对话的历史记录 ---- */
  const cid = convId();
  lastConv = cid;

  const name = p.model || p.fastModel || null;
  const fast = !p.model && !!p.fastModel;

  /* ---- 思考强度 ----
     内部名（Arena 真跑的，带档位后缀）优先于 trace 标签。 */
  const internal = p.internalModel || null;
  const internalTier = p.internalTier || null;
  const t = p.tier || (p.reasoning && p.reasoning.level ? { level: p.reasoning.level } : null);
  let lvl = internalTier || (t && t.level ? String(t.level) : null);

  // 探针报了就归档到当前对话
  if (name && cid) {
    const prev = models[cid];
    if (!prev || prev.model !== name || (prev.tier || "") !== (lvl || "")) {
      models[cid] = { model: name, tier: lvl || "", at: Date.now() };
      saveModelMap(models);
    }
  }
  // 探针还没报（比如刚打开一个历史对话）→ 用存过的
  const rec = cid ? models[cid] : null;
  const histName = (!name && rec && rec.model) ? rec.model : null;
  if (histName && !lvl && rec.tier) lvl = rec.tier;

  const showName = name || histName;
  const mEl = sh.getElementById("model");
  if (mEl) {
    let cls, txt;
    if (showName) { cls = "model " + (histName ? "hist" : fast ? "fast" : "ok"); txt = showName; }
    else { cls = "model none"; txt = p.state === "polling" ? "识别中\u2026" : p.state === "nologin" ? "需要登录" : "尚未开始"; }
    setCls(sh, "model", cls); setText(sh, "model", txt);
  }
  setText(sh, "mlblTop", histName ? "上轮模型" : "本轮模型");
  setText(sh, "mhint", histName
    ? "这条对话上次检测到的 · 发一条消息可重新确认"
    : internal
      ? ("内部名 " + internal + (internalTier
          ? "  ·  档位 " + internalTier.toUpperCase() + "（span 详情）"
          : "  ·  该模型无档位后缀"))
      : (fast ? "快速识别，正在用 run trace 复核\u2026"
              : (p.model ? "内部名读取中…" : "")));
  setHTML(sh, "pillWrap", lvl
    ? '<div class="pill on">思考强度 ' + esc(lvl.toUpperCase()) + "</div>"
    : '<div class="pill off">思考强度 \u2014</div>');

  /* ---- 详情 ---- */
  const d = [];
  if (t) {
    if (t.nameTier || t.traceTier) {
      d.push(row("名字档位", t.nameTier || "\u2014"));
      d.push(row("trace 档位", t.traceTier || "\u2014"));
    }
    if (t.status === "mismatch") d.push(row("提示", "两个来源不一致", "warn"));
    if (t.source) d.push(row("来源", t.source));
  }
  // 内部真名：来自 span 详情接口的 properties.modelName（带档位后缀）
  if (internal) {
    d.push(row("内部名", internal + (internalTier ? "  [" + internalTier.toUpperCase() + "]" : ""),
      internalTier ? "ok" : ""));
  }

  // 用量与花费：来自 trace accessory（实测 kimi-k3 一轮 6.4k / $0.0219）
  const mt = p.meta || {};
  if (mt.tokens) d.push(row("用量", mt.tokens, "ok"));
  if (mt.cost) d.push(row("花费", mt.cost, "ok"));

  const u = p.usage || {};
  d.push(row("思考 token", u.reasoning != null ? String(u.reasoning) : "未报告", u.reasoning != null ? "ok" : ""));
  d.push(row("思考块", p.thinking ? "出现过" : "未出现", p.thinking ? "ok" : ""));
  if (p.runId) d.push(row("runId", p.runId));
  setHTML(sh, "detail", d.join(""));

  /* ---- MCP 地址 ---- */
  /* ---- 权限标签：读永远开；写/执行可点 ---- */
  setHTML(sh, "perms", status ? (
    '<span class="chip on" title="读取：始终开启">读</span>' +
    '<span class="chip' + (status.allowWrite ? " on" : "") + '" data-p="allowWrite" ' +
      'title="写文件 / 改文件（路径限制在项目目录内）">写</span>' +
    '<span class="chip' + (status.allowExec ? " on" : "") + '" data-p="allowExec" ' +
      'title="执行白名单命令，工作目录限定在项目目录">执行</span>'
  ) : "");

  /* ---- 项目目录 ---- */
  setText(sh, "pdirShow", (status && status.projectDir) ? status.projectDir : "（未设置）");
  const pdEl = sh.getElementById("pdir");
  if (pdEl && !pdEl.dataset.b) {
    pdEl.dataset.b = "1";
    pdEl.onclick = async () => {
      try {
        const r = await ipcRenderer.invoke("bridge:pick-dir");
        if (r && r.ok) panelLog("项目目录已改为 " + r.dir + "（工具表已重建）");
        else if (r && r.err) panelLog("换目录失败: " + r.err);
      } catch (e) { panelLog("换目录失败: " + e.message); }
    };
  }

  /* ---- MCP 会话统计（对标 ShunCode 那个面板） ---- */
  const st = status && status.stats;
  if (st && st.calls) {
    const avg = Math.round(st.totalMs / Math.max(1, st.calls));
    const rate = ((st.ok / Math.max(1, st.calls)) * 100).toFixed(1);
    setText(sh, "stline", "工具调用 " + st.calls + " · 平均 " + avg + "ms · 失败 " + st.fail + " · 成功率 " + rate + "%");
  } else {
    setText(sh, "stline", status ? "尚无工具调用" : "");
  }

  const url = mcpUrl();
  const uEl = sh.getElementById("url");
  if (uEl) {
    if (url) { setCls(sh, "url", "url"); setText(sh, "url", url); }
    else { setCls(sh, "url", "url none"); setText(sh, "url", "获取中\u2026"); }
    setText(sh, "mlbl", urlNote() || "MCP");
  }

  /* ---- 抽卡 ---- */
  const gR = sh.getElementById("gRounds"), gT = sh.getElementById("gTargets"),
        gS = sh.getElementById("gStop"), gG = sh.getElementById("gTier"),
        gPromptEl = sh.getElementById("gPrompt"), gHuntEl = sh.getElementById("gHunt");
  const busy = !!gacha.running;

  // 快捷标签：选中的高亮
  const curT = splitTargets(gT && gT.value);
  setHTML(sh, "gChips", TARGET_PRESETS.map((p) =>
    '<span class="chip' + (curT.indexOf(p) >= 0 ? " on" : "") + '" data-t="' + esc(p) + '">' + esc(p) + "</span>"
  ).join(""));
  const gPv = (gPromptEl && gPromptEl.value) || "";
  setHTML(sh, "pChips", PROMPT_PRESETS.map(([v, n]) =>
    '<span class="chip' + (gPv === v ? " on" : "") + '" data-p="' + esc(v) + '">' + esc(n) + "</span>"
  ).join(""));
  setHTML(sh, "gPace", PACES.map(([v, n]) =>
    '<span class="chip' + (gachaPace === v ? " on" : "") +
    '" data-p="' + esc(v) + '" title="' + esc(PACE_TIP[v]) + '">' + esc(n) + "</span>"
  ).join(""));
  if (gR) gR.disabled = busy;
  if (gT) gT.disabled = busy;
  if (gS) gS.disabled = busy;
  if (gG) gG.disabled = busy;
  if (gPromptEl) gPromptEl.disabled = busy;
  if (gHuntEl && gHuntEl.checked !== huntMode) gHuntEl.checked = huntMode;
  if (gHuntEl) gHuntEl.disabled = busy;
  const pC = sh.getElementById("pChips");
  if (pC) { pC.style.opacity = busy ? ".45" : "1"; pC.style.pointerEvents = busy ? "none" : "auto"; }
  const gP = sh.getElementById("gPace");       // chips 没法用 disabled，就禁掉点击
  if (gP) { gP.style.opacity = busy ? ".45" : "1"; gP.style.pointerEvents = busy ? "none" : "auto"; }

  setHTML(sh, "gctrl", busy
    ? '<button class="r" id="gstop">停止（' +
      ((gacha.total === null || gacha.total === undefined || gacha.hunt)
        ? "第 " + (gacha.round || gacha.done || 0) + " 轮 · 守株待兔"
        : "第 " + (gacha.round || gacha.done || 0) + "/" + gacha.total + " 轮") +
      '）</button>'
    : '<button class="g" id="gacha">开始抽卡</button>');
  const gb = sh.getElementById(busy ? "gstop" : "gacha");
  if (gb && !gb.dataset.b) {
    gb.dataset.b = "1";
    gb.onclick = () => {
      if (gacha.running) { ipcRenderer.send("gacha-stop"); return; }
      const opts = {
        rounds: Math.max(1, Math.min(200, parseInt(gR && gR.value, 10) || 20)),
        targets: ((gT && gT.value) || "").trim(),
        stopOnHit: gS ? !!gS.checked : true,
        pace: huntMode ? "hunt" : gachaPace,
        hunt: huntMode,
        awaitTier: gG ? !!gG.checked : true,
        prompt: ((sh.getElementById("gPrompt") || {}).value || "").trim(),
      };
      try { localStorage.setItem(GACHA_KEY, JSON.stringify(opts)); } catch (e) {}
      blockReported = false;          // 新一轮，清掉上一轮的拦截状态
      gacha.blocked = false;
      ipcRenderer.send("gacha-start", opts);
    };
  }

  /* ---- 连接按钮：隧道没就绪就锁住，避免把死地址发出去 ---- */
  const cEl = sh.getElementById("connect");
  if (cEl && !cEl.dataset.busy) {
    const ok = tunnelUp();
    if (cEl.disabled === ok) {           // 只在状态翻转时改，别打断进行中的文案
      cEl.disabled = !ok;
      cEl.textContent = ok ? "一键连接并开工" : "等待隧道就绪\u2026";
    }
  }

  /* ---- 新会话限流（来自 create-chat 响应头，服务端按窗口计数）---- */
  const qc = (p.quota && p.quota.chat) || null;
  let qtxt = "", qbad = false, qwarn = false;
  // 守株待兔冷却中：把还剩多久说清楚，不然看着像卡死
  const cooling = (gacha.coolUntil && gacha.coolUntil > Date.now()) ? gacha.coolUntil : 0;
  if (qc) {
    const mins = qc.resetAt ? Math.max(0, Math.ceil((qc.resetAt - Date.now()) / 60000)) : null;
    if (qc.blocked) {
      qtxt = "⛔ " + (qc.reason || "限流中") + (mins ? " · 约 " + mins + " 分钟后解除" : "");
      qbad = true;
    } else if (qc.limit !== null) {
      qwarn = qc.remaining !== null && qc.remaining <= Math.max(2, Math.floor(qc.limit * 0.2));
      qtxt = "新会话额度 " + (qc.remaining === null ? "?" : qc.remaining) + "/" + qc.limit +
             (mins ? " · " + mins + " 分钟后重置" : "") + (qc.window ? " · 窗口 " + qc.window + "s" : "");
    }
  }
  /* 冷却倒计时最后写 —— 不然会被上面那段"⛔ 限流中 · 约 N 分钟后解除"盖掉，
     而倒计时恰恰是这时候唯一有用的信息（它告诉我们还要等多久、且会自动接着抽）。 */
  if (cooling) {
    const s = Math.ceil((cooling - Date.now()) / 1000);
    qtxt = "⏳ 守株待兔冷却中 · 还剩 " + Math.floor(s / 60) + " 分 " + String(s % 60).padStart(2, "0") +
           " 秒（到点自动接着抽，别关窗口）";
    qbad = false; qwarn = true;
  }
  setText(sh, "qline", qtxt);
  setCls(sh, "qline", "gsum" + (qbad ? " bad" : qwarn ? " warn" : ""));

  /* ---- 同对话里被路由换过模型 ---- */
  const mc = p.modelChanges || [];
  if (mc.length) {
    const last = mc[mc.length - 1];
    setText(sh, "chgline", "⚠ 这个对话换过模型: " + last.from + " → " + last.to +
      (mc.length > 1 ? "（共 " + mc.length + " 次）" : ""));
    setCls(sh, "chgline", "gsum warn");
  } else {
    setText(sh, "chgline", "");
  }

  /* ---- 账号额度（同源 /api/billing/balance）---- */
  const bal = p.balance;
  setText(sh, "bline", (bal && bal.remaining !== null)
    ? ("账号额度 " + bal.remaining + (bal.daily !== null ? " / 每日 " + bal.daily : ""))
    : "");

  setHTML(sh, "gwarn", gacha.blocked
    ? "<div class=\"gwarn\">⛔ 检测到人机验证，已自动停止。<br>" +
      "请在窗口里手动完成验证，然后把轮数调小、目标写明确，歇一会儿再抽。</div>"
    : "");

  /* ---- 把对话标题改成模型名 ----
     只在 trace 确认（p.model）之后做，且每个对话每个名字只改一次。
     等 2 秒再动手，避开正在流式输出的时刻。 */
  if (renameOn && cid && p.model && !histName) {
    const target = (internal && internal.length <= 100) ? internal : showName;
    const k = cid + "|" + target;
    if (target && !renamedOnce[k]) {
      renamedOnce[k] = 1;
      setTimeout(() => {
        queueRename(target, cid)
          .then((n) => { panelLog("已把对话重命名为 " + n); noteToFile("自动改名成功 → " + n); })
          .catch((e) => { panelLog("重命名失败: " + e.message); noteToFile("自动改名失败: " + e.message); delete renamedOnce[k]; });
      }, 2000);
    }
  }
  /* ---- 记账：这一轮是哪个 run，交给带外补档队列 ----
     目标名字只填「显示名」这一层。档位要到回合结束后才写进 span，
     而那时我们多半已经翻到下一个对话了 —— 留着让补档那条路去补。 */
  if (cid && p.runId && p.model && !internal) {
    const gk = cid + "|" + p.runId;
    if (!gotTier[gk]) {
      gotTier[gk] = 1;
      rememberRun(cid, p.runId, p.model);
    }
  }

  const hs = gacha.hits || [];
  const winN = hs.filter((h) => h.hit).length;
  setText(sh, "gsum", (hs.length || busy || gacha.done)
    ? ("已抽 " + ((gacha.total === null || gacha.total === undefined || gacha.hunt)
        ? (gacha.done || 0) + " 轮"
        : (gacha.done || 0) + "/" + gacha.total + " 轮") +
       " · 记录 " + hs.length + (winN ? " · ★ 命中 " + winN : ""))
    : "");
  // 最新的排最前，免得抽了几十轮还要往下翻
  setHTML(sh, "hits", hs.length
    ? hs.slice().reverse().map((h) => '<div class="hit' + (h.hit ? " win" : "") + '">' +
        '<span class="n' + (h.hit ? " win" : (h.confirmed ? " ok" : "")) + '">' +
        (h.hit ? "★ " : "") + esc(h.model) + "</span>" +
        (h.tier ? '<span class="b">' + esc(h.tier) + "</span>" : "") + "</div>").join("")
    : '<div class="empty">暂无结果</div>');

  /* ---- 状态点 ---- */
  const live = p.state === "polling" || p.state === "found";
  const dotCls = "dot" + (live ? " live" : name ? " on" : "");
  for (const id of ["hdot", "rdot"]) setCls(sh, id, dotCls);

  // 收起态也显示模型名与档位，不用展开就能看见
  setText(sh, "rlabel", showName || "Arena Bridge");
  setHTML(sh, "rlvl", lvl ? esc(lvl.toUpperCase()) : "");
  const rlvlEl = sh.getElementById("rlvl");
  if (rlvlEl) rlvlEl.style.display = lvl ? "" : "none";
}

/* ============ 接收探针广播（跨隔离世界） ============ */
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "__amp3") return;
  if (d.type === "state" && d.state) {
    probe = d.state;
    render();
    drainPendRuns();                    // 队列里还有活就顺手清一遍（有防重入）
    return;
  }
  if (d.type === "tok") {               // 探针按 runId 给的 token
    if (d.runId && d.token) tokCache[d.runId] = d.token;
    drainPendRuns();
    return;
  }
  if (d.type === "trace") {
    panelLog("trace 原文 " + (d.bytes || 0) + " 字节，正在写文件…");
    ipcRenderer.invoke("bridge:save-trace", { trace: d.trace, model: d.model, runId: d.runId })
      .then((r) => panelLog(r && r.ok ? ("已导出 → " + r.path) : ("导出失败: " + ((r && r.err) || "未知"))))
      .catch((err) => panelLog("导出失败: " + err.message));
  }
});

/* ============ 启动 ============ */
function boot() {
  if (!location.hostname.endsWith("arena.ai")) return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, { once: true });
  else build();

  // 主动索取一次状态（探针可能早就跑过了）
  setTimeout(() => { try { window.postMessage({ source: "__amp3_cmd", cmd: "get" }, "*"); } catch (e) {} }, 1200);

  /* 抽卡期间把额度刷新提到 10 秒一次。
     探针平时是 60 秒一拉 /api/billing/balance —— 但抽卡时每轮都在烧，
     60 秒的粒度看不出"这一轮花了多少"。只在真抽的时候提速，平时不打扰。 */
  let balNudgeAt = 0;
  setInterval(() => {
    if (!gacha.running) return;
    if (Date.now() - balNudgeAt < 10000) return;
    balNudgeAt = Date.now();
    try { window.postMessage({ source: "__amp3_cmd", cmd: "balance" }, "*"); } catch (e) {}
  }, 5000);
  // 主进程可能已经推过状态，这里补一次握手
  setTimeout(() => { try { ipcRenderer.invoke("bridge:set", {}); } catch (e) {} }, 900);
}
boot();
