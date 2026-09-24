/* Arena 模型探测器 v3 — 单脚本架构
 *
 * 为什么重写：旧版要经过 MAIN→ISOLATED→background 三次转发，
 * 每一步都会坏（MV3 worker 被回收、权限缺失、上下文失效）。
 * 实测发现 api.trigger.dev 明确允许 https://arena.ai 跨域：
 *     access-control-allow-origin: https://arena.ai
 *     access-control-allow-headers: authorization
 * 因此可以在页面里【直接】读 trace，所有中间环节全部删掉。
 *
 * 本脚本运行在 MAIN world，做三件事：
 *   1. 挂钩 fetch/XHR/EventSource/WebSocket，从流里捞出 access token（不依赖字段名）
 *   2. 拿 token 去 api.trigger.dev 读 run events，解析真实模型名
 *   3. 把状态广播给宿主（window.postMessage）
 *
 * 两种运行方式：
 *   a) 桌面版（Arena Bridge.exe）—— 宿主会先设 window.__amp3NoHud = true，
 *      探针不画 HUD，状态由 preload 的统一面板显示（视觉与 arena.ai 一致）。
 *   b) 浏览器扩展单独用 —— 探针自己画 HUD，样式同样复用 Arena 的设计变量。
 */
(function () {
  "use strict";
  if (window.__amp3) return;
  window.__amp3 = true;

  var TRIGGER = "https://api.trigger.dev";
  /* 值得扫描的响应类型（白名单）。JWT 与模型名只可能出现在这些里。 */
  var WORTH_SCANNING = /^(?:text\/(?:event-stream|plain|x-component|html)|application\/(?:json|x-ndjson|ndjson))/i;
  /* ── 快速通道的来源白名单（坑 7 的另一半）──
     快速通道是"不等 token、直接从响应文本里认模型名"，它的问题是【不区分数据来源】：
     只要一段 JSON/HTML 里出现像模型名的东西就投票。
     实测（2026-09-23）：切一下【排行榜】页面，立刻报出 gemini-3.8-flash-low / gemini-omni-flash，
     而那一轮连 token 都没拿到 —— 名字纯粹来自排行榜的模型目录，不是本轮抽到的模型。
     更早的 claude-opus-4-8 连报 10 次也是同类（会话历史/侧栏）。

     所以这里按 URL 判定：黑名单里的来源（排行榜/历史/侧栏/模型目录/存储）直接作废；
     黑名单之外一律放行 —— 宁可留一点误报，也不把快速通道卡死（见下方 fastSourceOk 的说明）。
     注意：token 通道完全不受影响，仍然照常扫全量（token 自带 iss/pub/scopes 校验，不会误认）。 */
  var FAST_BAD = /(leaderboard|\/models?\b|model-list|catalog|history|conversations?|threads?|sidebar|search|\/rank\b|pricing|prices?|localStorage|sessionStorage)/i;
  /* ── 坑 7 又回潮了：/api/chat/ 曾经被整段当成"本轮对话自己的流" ──
     实测（2026-09-25，用户报"我是 opus-5，怎么检测到 gpt5.5"）：
     打开一个对话时页面会拉 /api/chat/<id>/preview、/workspace/latest、/run-status，
     这些响应里带着这个对话的【标题】。而本工具有"把对话标题改成模型名"的功能，
     所以标题里就是模型名 —— 于是它被当成了"本轮模型"。
     这不是猜的：日志里 405 次 token 全部来自【响应体流】，
     只有 13 次来自实时会话；而且把改名的开关打开之后，标题就是模型名（65× gpt-5.6-sol…）。
     结论：只有【本轮的流】能信。/api/chat/<id>/ 下的其它端点都是读历史。
     另外补上 workspace/review-feedback/connectors/pulse/rum/logs 这些杂接口。 */
  var FAST_GOOD = /(create-chat|\/stream|trigger\.dev|\/events\b|\/spans\b|messages|event-stream|\/agent)/i;
  var FAST_CHAT_STREAM = /\/api\/chat\/[0-9a-f-]{36}\/(?:stream|message|messages|events?)\b/i;
  function fastSourceOk(where) {
    var w = String(where || "");
    if (FAST_BAD.test(w)) return false;   // 排行榜/历史/侧栏/模型目录 —— 一律不信
    if (FAST_CHAT_STREAM.test(w)) return true;  // 本轮的流（不是 preview 之类读历史）
    if (/\/api\/chat\//i.test(w)) return false; // 对话元数据端点：读的是标题/历史，不是本轮
    if (FAST_GOOD.test(w)) return true;   // 本轮对话自己的流
    /* 认不出来时【放行】，而不是拒绝。
       —— 这里和 token 通道的取舍相反，原因是有过一次很贵的返工：
          早期把快速通道卡得太死，实测 24 分钟里 0 次命中（见投票表的注释）。
       所以策略是"只拉黑确证会污染的来源"，宁可留一点误报也不废掉快速通道。 */
    return true;
  }
  /* 网络活动计数：用于区分"钩子没看到请求"与"看到了但没有 token" */
  var net = { seen: 0, byType: {}, tokenSeen: 0, gotHeaders: 0, lastUrl: "", lastCt: "" };
  var seen = Object.create(null);

  /* ================= 诊断（只看不改）=================
   *
   * 目的：回答"旧对话里发一条消息，为什么检测不出来"。
   * 现在 where 里没有 URL，所以看不出 token 是"服务端没下发"还是"被白名单过滤掉了"。
   * 这里只做记录，不参与任何识别决策。
   */
  var DIAG = { reqs: [], resps: [], tokUrls: [], jwtSamples: [] };
  var DIAG_MAX = 40;
  function diagPush(arr, item) {
    arr.push(item);
    if (arr.length > DIAG_MAX) arr.shift();
    try { window.__amp3Diag = DIAG; } catch (e) {}
  }
  function shortUrl(u) {
    try { return String(u || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0].slice(0, 110); } catch (e) { return "?"; }
  }
  function diagReq(kind, url) {
    var s = shortUrl(url);
    if (!s) return;
    // 只记"像对话接口"的，避免被埋点/静态资源淹没
    if (!/nextjs-api|api\/|trigger|arena/i.test(s)) return;
    if (DIAG.reqs.length && DIAG.reqs[DIAG.reqs.length - 1].u === s) DIAG.reqs[DIAG.reqs.length - 1].n++;
    else diagPush(DIAG.reqs, { u: s, n: 1, k: kind });
  }
  function diagResp(url, status, ct, verdict) {
    var s = shortUrl(url);
    if (!s) return;
    if (!/nextjs-api|api\/|trigger|arena/i.test(s)) return;
    diagPush(DIAG.resps, { u: s, st: status, ct: String(ct || "").slice(0, 40), v: verdict });
  }
  function diagToken(url, tok) {
    diagPush(DIAG.tokUrls, { u: shortUrl(url), len: String(tok || "").length });
  }
  /* 把诊断快照打进日志（主进程每 30 秒会读 __amp3NetCount，这里复用同一通道） */
  function diagSnapshot() {
    try {
      var reqs = {}; DIAG.reqs.forEach(function (r) { reqs[r.u] = (reqs[r.u] || 0) + r.n; });
      var skipped = DIAG.resps.filter(function (r) { return r.v === "SKIPPED"; })
                              .map(function (r) { return r.u + " [" + r.ct + "]"; });
      return {
        urls: Object.keys(reqs).slice(-18),
        skippedByWhitelist: skipped.slice(-10),
        tokenUrls: DIAG.tokUrls.slice(-8),
        jwtSeen: DIAG.jwtSamples.slice(-5)
      };
    } catch (e) { return { err: String(e && e.message) }; }
  }
  try { window.__amp3DiagSnapshot = diagSnapshot; } catch (e) {}

  /* ================= 日志（同时进 HUD 与 console） ================= */
  var logs = [];
  function log(msg) {
    var line = new Date().toLocaleTimeString() + " " + msg;
    logs.push(line);
    if (logs.length > 60) logs.shift();
    renderLog();
    broadcast();
    try { console.log("[amp]", msg); } catch (e) {}
  }

  /* ================= HUD ================= */
  var host = null, shadow = null, wrap = null, elVerdict = null, elLog = null, elDot = null;

  /* 取页面上的 Arena 设计变量（同桌面版那套），取不到就退回浅色主题默认值 */
  var TOKENS = {
    "--ab-surface2":  ["--surface-secondary",     "0 0% 100%"],
    "--ab-surface3":  ["--surface-tertiary",      "33 31% 94%"],
    "--ab-text":      ["--text-primary",          "24 6% 17%"],
    "--ab-text2":     ["--text-secondary",        "30 7% 24%"],
    "--ab-muted":     ["--text-muted",            "37 5% 52%"],
    "--ab-border":    ["--border-medium",         "30 9% 87%"],
    "--ab-border2":   ["--border-faint",          "30 5% 93%"],
    "--ab-link":      ["--interactive-link",      "208 77% 52%"],
    "--ab-ok":        ["--interactive-positive",  "125 49% 43%"],
    "--ab-warn":      ["--interactive-warning",   "48 93% 45%"],
    "--ab-bad":       ["--interactive-negative",  "2 63% 54%"],
    "--ab-accent":    ["--brand-yellow-6",        "47 95% 49%"],
  };
  function readTokens() {
    var out = [];
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) {}
    for (var k in TOKENS) {
      var v = "";
      try { v = (cs && cs.getPropertyValue(TOKENS[k][0])) || ""; } catch (e) {}
      out.push(k + ":" + ((v && v.trim()) ? v.trim() : TOKENS[k][1]));
    }
    var font = "";
    try { font = getComputedStyle(document.body).fontFamily || ""; } catch (e) {}
    if (!font || /^(inherit|)$/i.test(font.trim())) font = "system-ui,-apple-system,'Segoe UI',sans-serif";
    out.push("--ab-font:" + font);
    return out.join(";");
  }

  var CSS = (function () {
    var vars = readTokens();
    return [
    ":host{all:initial;" + vars + "}",
    "*{box-sizing:border-box}",
    ".wrap{position:fixed;left:16px;bottom:16px;z-index:2147483646;width:236px;",
    "font-family:var(--ab-font);font-size:12px;line-height:1.45;color:hsl(var(--ab-text));",
    "background:hsl(var(--ab-surface2));border:1px solid hsl(var(--ab-border));",
    "border-radius:12px;overflow:hidden;",
    "box-shadow:0 8px 28px -8px hsl(var(--ab-text) / .18),0 2px 8px -2px hsl(var(--ab-text) / .08)}",
    ".hd{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:move;",
    "border-bottom:1px solid hsl(var(--ab-border2));background:hsl(var(--ab-surface3) / .5);",
    "touch-action:none;user-select:none}",
    ".dot{width:7px;height:7px;border-radius:50%;background:hsl(var(--ab-ok));flex:0 0 auto}",
    ".dot.warn{background:hsl(var(--ab-warn))}.dot.bad{background:hsl(var(--ab-bad))}",
    ".ttl{font-weight:600;flex:1;font-size:11.5px;letter-spacing:-.01em}",
    ".mini{cursor:pointer;color:hsl(var(--ab-muted));padding:1px 3px;border-radius:4px;",
    "font-size:13px;line-height:1;user-select:none}",
    ".mini:hover{background:hsl(var(--ab-surface3));color:hsl(var(--ab-text))}",
    ".bd{padding:9px 11px 11px;max-height:46vh;overflow:auto}",
    ".verdict{border-radius:9px;padding:9px 10px;border:1px solid hsl(var(--ab-border2));",
    "background:hsl(var(--ab-surface3) / .45);margin-bottom:7px}",
    ".verdict.ok{border-color:hsl(var(--ab-ok) / .45);background:hsl(var(--ab-ok) / .09)}",
    ".verdict.wait{border-color:hsl(var(--ab-accent) / .5);background:hsl(var(--ab-accent) / .12)}",
    ".verdict.bad{border-color:hsl(var(--ab-bad) / .45);background:hsl(var(--ab-bad) / .09)}",
    ".mode{font-size:9.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;",
    "color:hsl(var(--ab-muted))}",
    ".model{font-size:12.5px;font-weight:650;margin:3px 0 1px;word-break:break-all;letter-spacing:-.01em}",
    ".model.ok{color:hsl(var(--ab-ok))}.model.wait{color:hsl(var(--ab-link))}",
    ".model.bad{color:hsl(var(--ab-bad))}",
    ".ev{font-size:10.5px;color:hsl(var(--ab-text2));word-break:break-all;margin-top:2px}",
    ".sec{margin-top:10px;padding-top:8px;border-top:1px solid hsl(var(--ab-border2));",
    "font-size:9.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;",
    "color:hsl(var(--ab-muted))}",
    ".row{display:flex;gap:6px;align-items:baseline;padding:2px 0;font-size:10.5px}",
    ".k{color:hsl(var(--ab-muted));flex:0 0 74px}.v{flex:1;word-break:break-all}",
    ".v.ok{color:hsl(var(--ab-ok))}.v.warn{color:hsl(var(--ab-warn))}",
    ".log{max-height:74px;overflow:auto;font-family:ui-monospace,Consolas,monospace;",
    "font-size:9px;line-height:1.5;color:hsl(var(--ab-muted));margin-top:8px;",
    "padding-top:7px;border-top:1px solid hsl(var(--ab-border2))}",
    ".hide .bd{display:none}",
    ].join("");
  })();

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function buildHud() {
    if (host) return;
    // 宿主（桌面版 Electron）自带统一 UI 时，探针不再自己画面板，避免两个 UI
    if (window.__amp3NoHud) return;
    host = document.createElement("div");
    host.id = "amp3-hud";
    shadow = host.attachShadow({ mode: "open" });
    var st = document.createElement("style"); st.textContent = CSS; shadow.appendChild(st);
    wrap = document.createElement("div"); wrap.className = "wrap";
    wrap.innerHTML =
      '<div class="hd"><span class="dot warn"></span><span class="ttl">Arena 模型探测器 v3</span>' +
      '<span class="mini" data-a="d" title="立刻检测当前会话的模型（自动识别在切换对话、或只在旧对话里待着时会漏）">检测</span>' +
      '<span class="mini" data-a="t" title="收起">—</span>' +
      '<span class="mini" data-a="r" title="复位">⟲</span></div>' +
      '<div class="bd"><div id="v"></div><div class="log" id="l"></div></div>';
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    elVerdict = shadow.querySelector("#v");
    elLog = shadow.querySelector("#l");
    elDot = shadow.querySelector(".dot");

    /* 手动检测：和桌面版面板上那颗按钮走同一条路（detectCurrent） */
    shadow.querySelector('[data-a="d"]').onclick = function () { detectCurrent(true); };
    shadow.querySelector('[data-a="t"]').onclick = function () { wrap.classList.toggle("hide"); };
    shadow.querySelector('[data-a="r"]').onclick = function () {
      // 复位到左下角（与右侧边条错开）
      wrap.style.left = "16px"; wrap.style.top = "auto";
      wrap.style.right = "auto"; wrap.style.bottom = "16px";
    };
    // 拖动：pointer capture，避免鼠标出页丢失 mouseup
    var hd = shadow.querySelector(".hd"), drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
    hd.style.touchAction = "none";
    hd.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      var r = wrap.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { hd.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    hd.addEventListener("pointermove", function (e) {
      if (!drag) return;
      wrap.style.left = Math.max(0, Math.min(ox + e.clientX - sx, innerWidth - 240)) + "px";
      wrap.style.top = Math.max(0, Math.min(oy + e.clientY - sy, innerHeight - 60)) + "px";
      wrap.style.right = "auto"; wrap.style.bottom = "auto";
    });
    function end(e) { drag = false; try { hd.releasePointerCapture(e.pointerId); } catch (x) {} }
    hd.addEventListener("pointerup", end);
    hd.addEventListener("pointercancel", end);
    hd.addEventListener("dblclick", function () {
      wrap.style.left = "16px"; wrap.style.top = "auto";
      wrap.style.right = "auto"; wrap.style.bottom = "16px";
    });
    draw({ state: "idle" });
  }

  function renderLog() {
    if (elLog) elLog.innerHTML = logs.map(function (l) { return "<div>" + esc(l) + "</div>"; }).join("");
  }

  /* ================= 状态渲染 ================= */
  var state = { state: "idle", model: null, fastModel: null, runId: null, attempts: 0, reasoning: null, usage: null, thinking: false, lastErr: "", internalModel: null, internalTier: null, meta: null };
  /* 宿主是否还需要 token（带外补 span 用）。
     默认 false —— token 播出去没意义，让它躺着自然过期最省事；
     宿主手上有没解析完的 run 时才会点名要。 */
  var needTok = false;
  /* runId → token。带外补 span 用：切走之后要拿【那个 run 自己的】token
     去查它的 span，拿最新那个是查不到的（授权范围不同）。 */
  var tokByRun = Object.create(null);
  var tokOrder = [];
  var historySkip = Object.create(null);   // 已经处理过的 run，别重复轮询
  var lastTrace = "";   // 最近一次 trace 原文，仅用于诊断导出

  /* ============ 向宿主广播 ============
     preload 跑在隔离世界（contextIsolation:true），读不到页面的 window.__amp3State。
     所以这里用 window.postMessage 把状态克隆过去 —— 标准做法，跨世界安全。 */
  var lastBcast = "";
  function snapshot() {
    return {
      state: state.state, model: state.model, fastModel: state.fastModel,
      runId: state.runId, attempts: state.attempts,
      tier: state.tier || null, reasoning: state.reasoning || null,
      usage: state.usage || null, thinking: !!state.thinking, lastErr: state.lastErr || "",
      meta: state.meta || null,
      internalModel: state.internalModel || null, internalTier: state.internalTier || null,
      /* token 不走广播（每秒一次，没必要）。
         宿主用 __amp3_cmd/tok-for 按 runId 单独点名要。 */
      quota: quota, balance: state.balance || null,
      modelChanges: state.modelChanges || [],
      logs: logs.slice(-40),
      net: { seen: net.seen, tokenSeen: net.tokenSeen, byType: net.byType },
    };
  }
  function broadcast(force) {
    try {
      var s = snapshot(), j = JSON.stringify(s);
      if (!force && j === lastBcast) return;   // 内容没变就不发，避免刷屏
      lastBcast = j;
      window.postMessage({ source: "__amp3", type: "state", state: s }, "*");
    } catch (e) {}
  }
  // 宿主点名要状态时立刻回一份
  window.addEventListener("message", function (e) {
    if (e.source && e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== "__amp3_cmd") return;
    if (d.cmd === "get") broadcast(true);
    else if (d.cmd === "balance") { fetchBalance(true); }     // 宿主点名要最新额度
    else if (d.cmd === "tok-for") {                           // 点名要某个 run 的 token
      var tk = (d.runId && tokByRun[d.runId]) || state.token || null;
      try {
        window.postMessage({ source: "__amp3", type: "tok", runId: d.runId || "", token: tk }, "*");
      } catch (e) {}
    }
    else if (d.cmd === "need-token") { needTok = true; broadcast(true); }
    else if (d.cmd === "drop-token") { needTok = false; }
    else if (d.cmd === "trace") {
      // 诊断用：把 trace 原文回传给宿主，由主进程落盘
      try {
        window.postMessage({
          source: "__amp3", type: "trace",
          trace: lastTrace, model: state.model, runId: state.runId,
          bytes: lastTrace.length,
        }, "*");
      } catch (x) {}
    }
    /* 手动检测：宿主点「检测模型」时走这里。见下方 detectCurrent() 的说明。 */
    else if (d.cmd === "detect-current") { detectCurrent(true); }
  });

  function draw(patch) {
    if (patch) for (var k in patch) state[k] = patch[k];
    broadcast();
    if (!elVerdict) return;

    // 快速通道：还没拿到 trace，但已经从流里认出模型名了
    if (state.fastModel && !state.model) {
      elDot.className = "dot warn";
      var ft = tierFromName(state.fastModel);
      elVerdict.innerHTML =
        '<div class="verdict wait"><div class="mode">快速识别（未确认）</div>' +
        '<div class="model wait">' + esc(state.fastModel) + '</div>' +
        (ft ? '<div class="ev"><b>思考强度: ' + esc(ft.toUpperCase()) + '</b></div>' : '') +
        '<div class="ev">来自消息流 · 正在用 run trace 复核…</div></div>' + reasoningHtml();
      return;
    }

    if (state.state === "found") {
      elDot.className = "dot";
      elVerdict.innerHTML =
        '<div class="verdict ok"><div class="mode">本轮真实模型名</div>' +
        '<div class="model ok">' + esc(state.model) + '</div>' +
        (state.tier && state.tier.level ? '<div class="ev" style="font-weight:700;color:hsl(var(--ab-ok))">思考强度: ' + esc(state.tier.level.toUpperCase()) + '</div>' : '') +
        '<div class="ev">runId: ' + esc(state.runId || "-") + '</div></div>' + reasoningHtml();
    } else if (state.state === "polling") {
      elDot.className = "dot warn";
      elVerdict.innerHTML =
        '<div class="verdict wait"><div class="mode">状态</div>' +
        '<div class="model wait">等待模型标签…</div>' +
        '<div class="ev">已捕获 token · 第 ' + state.attempts + ' 次读取' +
        (state.lastErr ? ' · ' + esc(state.lastErr) : '') + '</div></div>' + reasoningHtml();
    } else if (state.state === "nologin") {
      elDot.className = "dot bad";
      elVerdict.innerHTML = '<div class="verdict bad"><div class="mode">状态</div>' +
        '<div class="model bad">需要登录</div><div class="ev">请先登录 Arena</div></div>';
    } else {
      elDot.className = "dot warn";
      elVerdict.innerHTML =
        '<div class="verdict wait"><div class="mode">状态</div>' +
        '<div class="model wait">尚未开始</div>' +
        '<div class="ev">在 Agent 模式下发一条消息即可识别</div></div>' + reasoningHtml();
    }
  }

  function updateVerdict() {
    try { draw(); } catch (e) { /* noop */ }
  }

  function reasoningHtml() {
    // 快速通道下 state.tier 还没算出来，先用模型名推一个
    var t = state.tier || (state.fastModel ? (function () {
      var ft = tierFromName(state.fastModel);
      return ft ? { status: "name", level: ft, source: "模型名后缀（快速）", note: "尚未与 trace 复核" } : null;
    })() : null);
    var r = state.reasoning, u = state.usage || {};
    var h = '<div class="sec">思考强度</div>';

    // ① 结论档位（名字 + trace 合成）
    if (t && t.level) {
      var cls = t.status === "mismatch" ? "warn" : "ok";
      h += '<div class="row"><span class="k">档位</span><span class="v ' + cls + '" style="font-weight:700">' + esc(t.level) + '</span></div>';
      h += '<div class="row"><span class="k">来源</span><span class="v">' + esc(t.source) + '</span></div>';
      if (t.note) h += '<div class="ev">' + esc(t.note) + '</div>';
    } else {
      h += '<div class="row"><span class="k">档位</span><span class="v">—</span></div>';
      h += '<div class="ev">模型名与 trace 里都没有档位信息</div>';
    }

    // ② 两个来源分别列出，便于核对
    if (t && (t.nameTier || t.traceTier)) {
      h += '<div class="row"><span class="k">名字里的</span><span class="v">' + esc(t.nameTier || "—") + '</span></div>';
      h += '<div class="row"><span class="k">trace 里的</span><span class="v">' + esc(t.traceTier || "—") + '</span></div>';
    }

    // ③ 思考 token
    var rt = (u.reasoning != null) ? u.reasoning : null;
    h += '<div class="row"><span class="k">思考 token</span><span class="v ' + (rt != null ? "ok" : "") + '">' +
      (rt != null ? esc(String(rt)) : "未报告") + '</span></div>';
    if (u.input != null || u.output != null) {
      h += '<div class="row"><span class="k">输入/输出</span><span class="v">' +
        (u.input != null ? u.input : "?") + " / " + (u.output != null ? u.output : "?") + '</span></div>';
    }

    // ④ 思考块
    h += '<div class="row"><span class="k">思考块</span><span class="v ' + (state.thinking ? "ok" : "warn") + '">' +
      (state.thinking ? "出现过" : "未出现") + '</span></div>';
    return h;
  }

  /* ================= 限流与额度 =================
     Arena 在 create-chat / in/append 的【响应头】里直接下发了限流状态：
        ratelimit-limit / ratelimit-remaining / ratelimit-reset / retry-after / ratelimit-policy
     429 时正文还会说明是撞了哪种上限。
     这些数据我们以前完全没看 —— 现在采集起来，抽卡就不会一头撞上限流。
     （来源：Ted 探针 2.8.0 的 quotaOf / quotaReason，同源公开接口行为） */
  var quota = { chat: null, append: null };
  var RATE_KEYS = ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after", "ratelimit-policy"];

  function quotaKindOf(u) {
    try {
      var p = new URL(u, location.href).pathname;
      if (/\/stream\/create-chat$/.test(p)) return "chat";
      if (/\/in\/append$/.test(p)) return "append";
    } catch (e) {}
    return null;
  }
  function quotaFrom(res, body) {
    var h = function (k) { try { return res.headers.get(k); } catch (e) { return null; } };
    var num = function (v) { return (v !== null && v !== undefined && /^\d{1,12}$/.test(String(v).trim())) ? Number(String(v).trim()) : null; };
    var limit = num(h("ratelimit-limit")), remaining = num(h("ratelimit-remaining"));
    var reset = num(h("ratelimit-reset")), retry = num(h("retry-after"));
    var status = res.status;
    if (limit === null && remaining === null && reset === null && retry === null && status !== 429) return null;
    var now = Date.now();
    var resetAt = reset !== null ? (reset > 1e11 ? reset : reset > 1e9 ? reset * 1000 : now + reset * 1000)
                : retry !== null ? now + retry * 1000 : null;
    /* ratelimit-policy 的格式是「配额;w=窗口秒」，例如 1800;w=300。
       以前只抓了 w=，把真正的配额数（1800）丢了 ——
       而 ratelimit-limit 报的是另一个数（实测 30 / 10），
       两者不一致正是"上限为什么在 10 和 30 之间跳"的疑点之一。 */
    var pol = h("ratelimit-policy"), wm = pol && /(?:^|[;,\s])w=(\d{1,8})/.exec(pol);
    var polLimit = null;
    if (pol) {
      var pp = String(pol).split(/[;,\s"]+/);
      for (var pi = 0; pi < pp.length; pi++) {
        var s2 = pp[pi].replace(/^q=/i, "");
        if (/^\d{1,12}$/.test(s2)) { polLimit = Number(s2); break; }
      }
    }
    var reason = null;
    if (status === 429) {
      var msg = "";
      try { var j = JSON.parse(body || ""); msg = (j && (j.error || j.message)) || ""; }
      catch (e) { msg = String(body || "").trim().slice(0, 160); }
      /* 撞上限流时把正文原样写进 desktop.log。
         以前只记到"429"三个字，结果查不出撞的是哪条规则
         （已知的三种都不匹配时 reason 是空的，等于什么都没留下）。 */
      log("429 正文: " + (String(body || "").trim().slice(0, 220) || "(空)") +
          " | reset=" + h("ratelimit-reset") + " retry-after=" + h("retry-after") +
          " policy=" + h("ratelimit-policy"));
      if (/daily limit of 100 agent messages/i.test(msg)) reason = "每日 Agent 消息上限（100 条/24h）";
      else if (/daily spend limit reached/i.test(msg)) reason = "每日花费上限";
      else if (/modelId/.test(body || "")) reason = "该模型限流";
      else if (msg && !/^too many requests/i.test(msg)) reason = msg.slice(0, 80);
      else reason = "新会话窗口用尽（HTTP 429）";
    }
    return { at: now, status: status, limit: limit, remaining: remaining, resetAt: resetAt,
             blocked: status === 429, window: wm ? Number(wm[1]) : null,
             policy: pol || null, policyLimit: polLimit, reason: reason };
  }
  /* 上一次看到的限流头原样留着，用来判断"这次是不是变了"。
     为什么要留：实测同一个 300s 窗口下，上限会在 10 和 30 之间来回跳，
     剩余数还会回升（8→9）—— 单一计数器不可能这样。
     推测是 create-chat 挂了多条限流策略（短窗口 + 长窗口），
     服务端每次报"当前生效的那条"。但这是猜测，
     要坐实就得把【每一条】响应的原始头都记下来对比。 */
  var lastRateHdr = "";
  function noteQuota(u, res) {
    var kind = quotaKindOf(u);
    if (!kind) return;
    var hh = function (k) { try { return res.headers.get(k); } catch (e) { return null; } };
    var path = "";
    try { path = new URL(u, location.href).pathname; } catch (e) {}
    var finish = function (body) {
      var q = quotaFrom(res, body);
      if (!q) {
        // 成功响应常常不带限流头：若此前是限流中，视为已解除
        if (quota[kind] && quota[kind].blocked && res.status >= 200 && res.status < 400) {
          quota[kind] = null;
          log((kind === "chat" ? "新会话" : "消息") + " 限流已解除");
          broadcast(true);
        }
        return;
      }
      quota[kind] = q;
      state.quota = quota;          // 供主进程 / 面板读取

      /* 原始限流头 —— 以前只有 429 才记，正常响应全扔了，
         结果"上限为什么在 10/30 之间跳"根本查不出来。
         现在只要和上一条不同就记一行，包含完整 policy。 */
      var raw = ["policy=" + (hh("ratelimit-policy") || "-"),
                 "limit=" + (hh("ratelimit-limit") || "-"),
                 "remaining=" + (hh("ratelimit-remaining") || "-"),
                 "reset=" + (hh("ratelimit-reset") || "-"),
                 "retry=" + (hh("retry-after") || "-")].join(" ");
      if (raw !== lastRateHdr) {
        lastRateHdr = raw;
        log("限流头变了 [" + path + "] " + raw);
      }

      log((kind === "chat" ? "新会话" : "消息") +
          (q.blocked ? " 限流 429" : "") + (q.reason ? " · " + q.reason : "") +
          (q.limit !== null ? " · 剩余 " + (q.remaining === null ? "?" : q.remaining) + "/" + q.limit : "") +
          (q.window ? " · 窗口 " + q.window + "s" : "") +
          " · reset=" + (hh("ratelimit-reset") || "-"));
      broadcast(true);
    };
    if (res.status === 429) {
      try { res.clone().text().then(finish).catch(function () { finish(""); }); } catch (e) { finish(""); }
    } else finish(null);
  }

  /* ================= 账号额度 =================
     同源接口 GET /api/billing/balance（页面自己也在用，带 cookie 即可）：
         { creditsRemaining, dailyFreeCredits, refreshedAt }
     这是"这个号还有多少额度"（群里说的"1000000 额度"就是 creditsRemaining），
     跟新会话限流（create-chat 响应头，5 分钟窗口那种）是两码事。
     别人家的做法：最小间隔 60 秒刷新一次。 */
  var balance = null, balanceAt = 0;
  function fetchBalance(force) {
    if (!force && Date.now() - balanceAt < 60000) return;
    balanceAt = Date.now();
    try {
      fetch(location.origin + "/api/billing/balance", {
        credentials: "include", headers: { "Accept": "application/json" }, cache: "no-store",
      }).then(function (r) {
        if (!r.ok) throw new Error("http-" + r.status);
        return r.json();
      }).then(function (j) {
        var b = {
          remaining: (j && typeof j.creditsRemaining === "number") ? j.creditsRemaining : null,
          daily: (j && typeof j.dailyFreeCredits === "number") ? j.dailyFreeCredits : null,
          refreshAt: (j && j.refreshedAt) ? (Date.parse(j.refreshedAt) || null) : null,
          at: Date.now(),
        };
        if (b.remaining === null) return;
        var changed = !balance || balance.remaining !== b.remaining || balance.daily !== b.daily;
        balance = b;
        state.balance = b;
        if (changed) log("账号额度: 剩余 " + b.remaining + (b.daily !== null ? " / 每日 " + b.daily : ""));
        broadcast(true);
      }).catch(function () { /* 未登录或接口改了，静默 */ });
    } catch (e) {}
  }

  /* ================= 1. 抓 token ================= */
  /* 不再依赖 "public-access-token" 这个字段名：
     直接在全文中找任意 JWT（eyJ 开头、三段 base64url），
     再靠 token 内部的 iss / pub / scopes 判断是否可用。
     这样即使 Arena 改了字段名、换了位置或转义方式，也能抓到。 */
  // 头两段是 base64url(JSON)，实际长度都远大于 10；第三段（签名）长短不一，
  // 有些实现会很短，所以下限放宽到 1，避免漏掉。
  var anyJwtRe = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;

  // 供主进程读取的计数器（诊断用）
  if (!window.__amp3NetCount) window.__amp3NetCount = { scans: 0, lastWhere: "", lastLen: 0, tokens: 0, fetches: 0 };

  /* 计时包装：scanTotalMs / scanCalls 会随 [net] 一起写进日志，
     用来判断"卡"到底是不是探针造成的（用数据说话，不靠猜）。 */
  function nowMs() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  /* 每 5 秒把诊断快照挂到 __amp3NetCount.diag —— 主进程读它时会一起写进日志。
     这是唯一让"页面内信息"流到"日志文件"的通路，不需要改主进程。 */
  setInterval(function () {
    try {
      if (!window.__amp3NetCount) return;
      window.__amp3NetCount.diag = diagSnapshot();
    } catch (e) {}
  }, 5000);
  function scan(text, where) {
    if (!text || typeof text !== "string") return;
    var t0 = nowMs();
    /* 诊断：记录"哪些响应里真的出现了 JWT"——
       这能区分"服务端没下发 token" 与 "下发了但没被识别"。 */
    try {
      if (text.indexOf("eyJ") >= 0) {
        anyJwtRe.lastIndex = 0;
        var _j = anyJwtRe.exec(text);
        if (_j) diagToken(where, _j[0]);
      }
    } catch (e) {}
    scanBody(text, where);
    var __dt = nowMs() - t0;
    if (__dt > (net.maxScanMs || 0)) net.maxScanMs = __dt;
    net.scanTotalMs = (net.scanTotalMs || 0) + __dt;
    net.scanCalls = (net.scanCalls || 0) + 1;
    // 同步到 __amp3NetCount —— 主进程每 30 秒会把它读进日志
    var nc = window.__amp3NetCount;
    if (nc) {
      nc.scanMs = Math.round(net.scanTotalMs);
      nc.scanCalls = net.scanCalls;
      nc.skipped = net.skipped || 0;
      nc.fastBlocked = net.fastBlocked || 0;
      nc.fastBlockedWhere = net.fastBlockedWhere || "";
      nc.maxScanMs = Math.round(Math.max(net.maxScanMs || 0, nowMs() - t0));
    }
  }
  function scanBody(text, where) {
    window.__amp3NetCount.scans++;
    window.__amp3NetCount.lastWhere = where;
    window.__amp3NetCount.lastLen = text.length;

    // 快速通道：先看有没有明文模型名
    scanForModelName(text, where);

    // token 通道：找 JWT，用于读 run trace（更权威，但更慢）
    if (text.indexOf("eyJ") === -1) return;
    anyJwtRe.lastIndex = 0;
    var m, n = 0;
    while ((m = anyJwtRe.exec(text)) !== null) {
      var tok = m[0];
      if (seen[tok]) continue;
      seen[tok] = 1;
      n++;
      if (n > 40) break;                     // 单次文本里最多看 40 个，防爆
      onToken(tok, where);
    }
  }

  /* ================= 快速通道：不等 token，直接从流里认模型 =================
   *
   * 背景：token 要等到【第一次模型调用完成】才会下发。
   * 但 Arena 的消息流里其实早就有线索：
   *   - 明文的模型名（gpt-6-astra-max 这类）
   *   - modelId（UUID），可用排行榜映射表还原成真名
   * 先走这条路，能把结果提前到"模型刚开始回答"的时候。
   * token 那条路仍然保留，作为最终确认。
   */
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  /* 模型名长得像什么：厂商前缀 + 版本 + 可选档位 */
  var MODEL_NAME_RE = /\b((?:gpt|claude|gemini|grok|deepseek|qwen|kimi|glm|llama|mistral|moonshot|hunyuan|ernie|minimax|seed|step)[a-z0-9._-]{1,60})/gi;
  /* 明显不是模型名的噪音（避免把界面文字误当模型） */
  var NAME_NOISE = /^(gpt-?oss|claude-?(ai|code)?$|qwen-?code$|gemini-?api$)/i;

  function looksLikeModelName(s) {
    if (!s || s.length < 4 || s.length > 70) return false;
    if (NAME_NOISE.test(s)) return false;
    // 必须含版本号或档位后缀，否则太容易误判
    return /(?:^|[-_.])(?:\d|max|high|medium|low|xhigh|mini|nano|pro|flash|turbo)(?:[-_.]|$)/i.test(s);
  }

  /* 从任意文本里找模型名（快速通道） */
  /* 快速通道投票表。
     实测问题：一个对话只可能有一个模型，但"取最后一个匹配"会乱报 ——
     日志里出现过同一对话 1.5 秒内先报 gpt-5.6-sol-xhigh、再报 claude-fable-5-v2。
     原因是页面里别处（选择器、历史数据）也会出现模型名。
     改成：同一个名字累计出现 ≥2 次才认，单次命中一律丢掉。 */
  var nameVotes = Object.create(null);
  var FAST_MIN_VOTES = 2;
  var votesAt = Date.now();

  function scanForModelName(text, where) {
    if (!text || typeof text !== "string") return;
    if (state.model) return;                       // trace 已经确认了，不再听快速通道
    /* ★ 来源必须可信。没有这一条，切排行榜 / 翻历史就会报出"本轮"根本不存在的模型名。
       where 形如 "fetch.body:/nextjs-api/stream/create-chat"（URL 由钩子拼进来）。 */
    if (!fastSourceOk(where)) {
      net.fastBlocked = (net.fastBlocked || 0) + 1;
      net.fastBlockedWhere = String(where || "").slice(0, 60);
      return;
    }
    MODEL_NAME_RE.lastIndex = 0;
    var m, n = 0, hits = Object.create(null);
    while ((m = MODEL_NAME_RE.exec(text)) !== null) {
      n++;
      if (n > 200) break;
      var cand = m[1];
      if (looksLikeModelName(cand)) hits[cand] = (hits[cand] || 0) + 1;
    }
    var names = Object.keys(hits);
    if (!names.length) return;

    /* 一段文本里同时冒出好几个模型名 —— 那是会话历史 / 模型目录 / 侧栏数据，
       不是"这一轮到底轮到了谁"。整段丢掉，别投票。
       （实测：claude-opus-4-8 就是这样连报 10 次，全是假的。） */
    if (names.length > 3) return;

    /* 票数要衰减：只有"最近反复出现"的名字才算数。
       ── 这里返过一次工 ──
       第一版写成"每扫一次就乘 0.5"，而票是"每扫一次 +1"：
       0.5 衰减配 1 增长，票数会收敛到 2 却永远到不了 2，
       结果快速通道一次都不触发（实测 24 分钟里 0 次命中）。
       改成按【时间】衰减，半衰期 3 秒 —— 300ms 一块的流大约第 3 块就能到 2 票。 */
    var nowTs = Date.now();
    if (nowTs - votesAt > 250) {
      var decay = Math.pow(0.5, (nowTs - votesAt) / 3000);
      for (var kd in nameVotes) {
        nameVotes[kd] *= decay;
        if (nameVotes[kd] < 0.5) delete nameVotes[kd];
      }
      votesAt = nowTs;
    }
    names.forEach(function (kk) { nameVotes[kk] = (nameVotes[kk] || 0) + hits[kk]; });

    /* 取【本次票数最高】的，而不是"循环里最后一个匹配到的"。
       以前 best 是遍历到的最后一个候选，等于随机挑一个。 */
    var top = null, topN = 0, second = 0;
    names.forEach(function (kk) {
      var v = nameVotes[kk];
      if (v > topN) { second = topN; topN = v; top = kk; }
      else if (v > second) second = v;
    });
    if (!top || topN < FAST_MIN_VOTES) return;
    if (topN <= second) return;                     // 两个名字并列，别猜
    if (top !== state.model && top !== state.fastModel) {
      state.fastModel = top;
      log("快速通道命中模型名: " + top + "（票数 " + topN + "）");
      updateVerdict();
    }
  }

  function scanHeaders(h, where) {
    try {
      if (!h || typeof h.forEach !== "function") return;
      h.forEach(function (v, k) {
        // 只要头的值像 JWT 就交给 scan（内部会校验 iss/pub/scopes）
        var sv = String(v || "");
        if (sv.indexOf("eyJ") === 0 || /public-access-token/i.test(String(k))) scan(sv, where + ":" + k);
      });
    } catch (e) {}
  }

  /* 增量扫描 —— 这里是"卡"的主因。
     原来每来一块就把【整个累积缓冲区】重扫一遍：O(n²)。
     Agent 的长回复缓冲区涨到 20 万字符，切上千块，
     等于拿正则扫上百 MB 文本，主线程直接被拖死。
     现在只扫【新到的一段 + 上一段末尾的一小截】，
     留重叠是为了兜住被切断的 token / 模型名。 */
  var SCAN_TAIL = 512;
  /* 单个响应最多读取多少字节。
     以前是「有多大读多大」—— 实测 472 次请求里 380 次被整份读完，
     大 JSON（会话历史）动辄几 MB，解码 + 拼接全在主线程上。
     超过上限就 cancel，剩下的不再看。 */
  var MAX_SCAN_BYTES = 1024 * 1024;

  function streamScan(stream, where) {
    if (!stream || typeof stream.getReader !== "function") return;
    var reader = stream.getReader(), dec = new TextDecoder("utf-8"), tail = "", read = 0;
    (function pump() {
      reader.read().then(function (r) {
        if (r.done) { if (tail) scan(tail, where + ":end"); return; }
        read += r.value && r.value.byteLength ? r.value.byteLength : 0;
        if (read > MAX_SCAN_BYTES) {                 // 超限就放弃，别再拖主线程
          try { reader.cancel(); } catch (e) {}
          net.truncated = (net.truncated || 0) + 1;
          if (window.__amp3NetCount) window.__amp3NetCount.truncated = net.truncated;
          return;
        }
        var chunk = "";
        var t0 = nowMs();
        try { chunk = dec.decode(r.value, { stream: true }); } catch (e) { return; }
        if (chunk) {
          scan(tail + chunk, where);
          tail = (tail + chunk).slice(-SCAN_TAIL);
        }
        // 解码 + 拼接的开销也计入（以前漏了这块，导致 scanMs 看起来很低）
        net.decodeMs = (net.decodeMs || 0) + (nowMs() - t0);
        if (window.__amp3NetCount) window.__amp3NetCount.decodeMs = Math.round(net.decodeMs);
        pump();
      }).catch(function () {});
    })();
  }

  // --- fetch ---
  var of = window.fetch;
  if (typeof of === "function") {
    window.fetch = function () {
      var a = arguments, req = a[0], init = a[1], url = "";
      try {
        url = typeof req === "string" ? req : (req && req.url) || "";
        var b = init && init.body;
        if (typeof b === "string") scan(b, "fetch.req:" + shortUrl(url));
        try {
          var hh = (init && init.headers) || (req && req.headers);
          if (hh) {
            if (typeof hh.forEach === "function") hh.forEach(function (v, k) {
              var sv = String(v || "");
              if (sv.indexOf("eyJ") === 0 || /public-access-token/i.test(String(k))) scan(sv, "fetch.req.header:" + shortUrl(url));
            });
            else for (var hk in hh) {
              var sv2 = String(hh[hk] || "");
              if (sv2.indexOf("eyJ") === 0 || /public-access-token/i.test(hk)) scan(sv2, "fetch.req.header:" + shortUrl(url));
            }
          }
        } catch (e) {}
      } catch (e) {}
      net.lastUrl = String(url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 80);
      if (window.__amp3NetCount) window.__amp3NetCount.fetches++;
      /* ---- 诊断（只记录，不影响任何识别逻辑）----
         目的：搞清楚"发消息时到底请求了哪些 URL、哪个带 token"。
         之前 where 里没有 URL，所以无法判断 token 是"没下发"还是"被白名单过滤掉了"。 */
      try { diagReq("fetch", url); } catch (e) {}
      var p = of.apply(this, a);
      try {
        p.then(function (res) {
          try {
            if (!res || typeof res.clone !== "function") return;
            var ct = "";
            try { ct = String(res.headers.get("content-type") || ""); } catch (e) {}
            net.seen++;
            net.byType[ct.split(";")[0] || "?"] = (net.byType[ct.split(";")[0] || "?"] || 0) + 1;
            scanHeaders(res.headers, "fetch.res.header:" + shortUrl(url));
            try { noteQuota(url, res); } catch (e) {}
            /* 只读可能含 token / 模型名的文本类响应。
               原来"任何响应都扫一遍"，把图片、字体、JS bundle 统统 clone 并读完 ——
               那些地方既不会有 JWT 也不会有模型名，纯浪费。 */
            if (!WORTH_SCANNING.test(ct)) {
              net.skipped = (net.skipped || 0) + 1;
              if (window.__amp3NetCount) window.__amp3NetCount.skipped = net.skipped;
              try { diagResp(url, res.status, ct, "SKIPPED"); } catch (e) {}
              return;
            }
            try { diagResp(url, res.status, ct, "scanned"); } catch (e) {}
            var len = 0;
            try { len = Number(res.headers.get("content-length") || 0) || 0; } catch (e) {}
            if (len > MAX_SCAN_BYTES) {              // 事先知道太大就根本别克隆
              net.skipped = (net.skipped || 0) + 1;
              if (window.__amp3NetCount) window.__amp3NetCount.skipped = net.skipped;
              return;
            }
            var cl = res.clone();
            if (cl.body && typeof cl.body.getReader === "function") streamScan(cl.body, "fetch.body:" + shortUrl(url));
            else cl.text().then(function (t) {
              if (t.length > MAX_SCAN_BYTES) return;
              scan(t, "fetch.body.full:" + shortUrl(url));
            }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
      return p;
    };
  }

  // --- XHR ---
  try {
    var XO = window.XMLHttpRequest;
    if (XO && !XO.__amp3) {
      XO.__amp3 = 1;
      var oo = XO.prototype.open, os = XO.prototype.send;
      XO.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
      XO.prototype.send = function (b) {
        try { if (typeof b === "string") scan(b, "xhr.req:" + shortUrl(this.__u)); } catch (e) {}
        var self = this;
        this.addEventListener("progress", function () {
          try {
            var now = Date.now();
            if (now - (self.__amp3T || 0) < 800) return;   // 节流：最多每 800ms 一次
            self.__amp3T = now;
            if (self.responseText) scan(self.responseText.slice(-40000), "xhr.progress:" + shortUrl(self.__u));
          } catch (e) {}
        });
        this.addEventListener("load", function () {
          try { if (typeof self.responseText === "string") scan(self.responseText.slice(-200000), "xhr.load:" + shortUrl(self.__u)); } catch (e) {}
        });
        return os.apply(this, arguments);
      };
    }
  } catch (e) {}

  // --- EventSource ---
  try {
    var OE = window.EventSource;
    if (OE && !OE.__amp3) {
      var W = function (u, c) {
        var es = new OE(u, c);
        try { es.addEventListener("message", function (ev) { scan(ev && ev.data, "es:" + shortUrl(u)); }); } catch (e) {}
        return es;
      };
      W.prototype = OE.prototype; W.__amp3 = 1;
      window.EventSource = W;
    }
  } catch (e) {}

  // --- WebSocket ---
  try {
    var OW = window.WebSocket;
    if (OW && !OW.__amp3) {
      var WS = function (u, p) {
        var ws = p === undefined ? new OW(u) : new OW(u, p);
        try { ws.addEventListener("message", function (ev) { scan(ev && ev.data, "ws:" + shortUrl(u)); }); } catch (e) {}
        return ws;
      };
      WS.prototype = OW.prototype; WS.__amp3 = 1;
      window.WebSocket = WS;
    }
  } catch (e) {}

  /* ================= 2. 拿 token 读 trace ================= */
  var polling = null, pollStart = 0, attempts = 0;
  /* 用于统计"看过多少 JWT 但都不是我们要的"，只做静默计数 */

  function b64urlDecode(s) {
    var t = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    try {
      var bin = atob(t), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) { return null; }
  }
  function decodeJwt(tok) {
    var p = String(tok || "").split(".");
    if (p.length < 2) return null;
    try { return { header: JSON.parse(b64urlDecode(p[0])), payload: JSON.parse(b64urlDecode(p[1])) }; } catch (e) { return null; }
  }
  function runIdFrom(p) {
    if (!p) return null;
    var sc = Array.isArray(p.scopes) ? p.scopes : [];
    for (var i = 0; i < sc.length; i++) {
      var m = String(sc[i]).match(/(?:read|write):[a-zA-Z]+:(run_[A-Za-z0-9]+)/);
      if (m) return m[1];
    }
    var m2 = JSON.stringify(p).match(/(run_[A-Za-z0-9]{10,})/);
    return m2 ? m2[1] : null;
  }

  var EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  /* 从模型名后缀解析思考强度。
     Arena 把档位直接编进模型名，例如：
       gpt-6-astra-max        -> max
       gpt-6-astra-medium     -> medium
       claude-opus-5-max      -> max
       claude-fable-5.1-high  -> high
       gpt-5.6-luna-xhigh     -> xhigh
     这是【名字里明写的】，不是在猜——但它是"名字里的档位"，
     与 trace 里显式下发的 reasoning_effort 是两个来源，要分别标注。 */
  var TIER_ORDER = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
  function tierFromName(name) {
    if (!name) return null;
    var s = String(name).toLowerCase();
    // 长档位优先匹配，避免 high 抢走 xhigh
    var alts = ["xhigh", "max", "high", "medium", "low", "minimal", "none"];
    for (var i = 0; i < alts.length; i++) {
      var t = alts[i];
      var re = new RegExp("(?:^|[-_\\s])" + t + "(?:$|[-_\\s])");
      if (re.test(s)) return t;
    }
    return null;
  }

  /* 把"名字档位"与"trace 显式档位"合成一个结论 */
  function combineTier(nameTier, traceSummary) {
    var traceTier = (traceSummary && traceSummary.status === "explicit") ? traceSummary.level : null;
    var status, level, source, note;
    if (nameTier && traceTier) {
      if (nameTier === traceTier) { status = "both"; level = nameTier; source = "名字 + trace 一致"; note = "两个来源一致，可信度最高"; }
      else { status = "mismatch"; level = nameTier; source = "不一致"; note = "名字说 " + nameTier + "，trace 说 " + traceTier + "（以名字为准，仅供参考）"; }
    } else if (nameTier) {
      status = "name"; level = nameTier; source = "模型名后缀"; note = "Arena 把档位编进了模型名";
    } else if (traceTier) {
      status = "trace"; level = traceTier; source = "trace 显式字段"; note = "服务端下发的显式配置";
    } else {
      status = "unknown"; level = null; source = "未标明"; note = "名字与 trace 里都没有档位";
    }
    return { status: status, level: level, source: source, note: note, nameTier: nameTier, traceTier: traceTier };
  }

  function extractReasoning(node, path, depth, out) {
    path = path || "$"; depth = depth || 0; out = out || [];
    if (!node || typeof node !== "object" || depth > 14) return out;
    if (Array.isArray(node)) return out;
    var SKIP = /^(messages?|parts|content|text|delta|prompt|input|output|choices|candidates|headers|token|authorization)$/i;
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (SKIP.test(k)) continue;
      var v = node[k], p = path + "." + k, parent = path.split(".").pop();
      var direct = /^(reasoning_effort|reasoningEffort|thinkingLevel|thinking_level)$/.test(k);
      var nested = k === "effort" && /^(reasoning|output_config|outputConfig)$/.test(parent);
      var ns = /^(?:ai\.settings\.reasoningEffort|gen_ai\.request\.reasoning_effort)$/.test(k);
      var suffix = !direct && !ns && /[._](?:reasoning_?effort|thinking_?level)$/i.test(k);
      if ((direct || nested || ns || suffix) && typeof v === "string") {
        var lv = v.trim().toLowerCase();
        out.push({ kind: "effort", level: EFFORTS.indexOf(lv) >= 0 ? lv : null, raw: v.slice(0, 40), path: p });
      } else if (/^(thinkingBudget|thinking_budget|budget_tokens)$/.test(k) && /^(thinking|thinkingConfig|thinking_config)$/.test(parent) && typeof v === "number") {
        out.push({ kind: "budget", value: v, path: p });
      } else if (v && typeof v === "object") extractReasoning(v, p, depth + 1, out);
    }
    return out;
  }

  function num() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v && typeof v === "object") v = v.intValue != null ? v.intValue : (v.doubleValue != null ? v.doubleValue : v.stringValue);
      if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
      if (typeof v === "number" && isFinite(v) && v >= 0) return v;
    }
    return null;
  }

  function parseTrace(text) {
    var models = [], reasoning = [], usage = {}, thinking = false;
    var meta = {};      // accessory 里的附加信息：tokens / cost
    var docs = [];
    try { docs = [JSON.parse(text)]; } catch (e) {
      var parts = text.split(/\r?\n/);
      for (var i = 0; i < parts.length; i++) { if (!parts[i]) continue; try { docs.push(JSON.parse(parts[i])); } catch (e2) {} }
    }
    function visit(n, d) {
      if (!n || typeof n !== "object" || d > 40) return;
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) visit(n[i], d + 1); return; }
      var items = n.style && n.style.accessory && n.style.accessory.items;
      if (items && items.length) {
        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          if (!it || typeof it.text !== "string") continue;
          var ic = String(it.icon || "");
          if (/cube/i.test(ic)) models.push(it.text.slice(0, 120));
          // 实测 trace 的 accessory 里还有这两个（tabler-hash / tabler-currency-dollar）
          else if (/hash/i.test(ic)) meta.tokens = String(it.text).slice(0, 24);
          else if (/currency|dollar|coin/i.test(ic)) meta.cost = String(it.text).slice(0, 24);
          else if (/sparkl|brain|think|reason/i.test(ic)) {
            thinking = true;
            var nn = Number(String(it.text).replace(/[^\d.]/g, ""));
            if (isFinite(nn) && nn > 0) usage.reasoning = Math.max(usage.reasoning || 0, Math.round(nn * (/k/i.test(it.text) ? 1000 : 1)));
          }
        }
      }
      if (typeof n.message === "string" && /think|reason/i.test(n.message)) thinking = true;
      var a = n.attributes || {}, u = n.usage || a.usage || {};
      var rr = num(a["gen_ai.usage.reasoning_tokens"], u.output_tokens_details && u.output_tokens_details.reasoning_tokens, u.reasoningTokens);
      if (rr != null) usage.reasoning = rr;
      var ii = num(a["gen_ai.usage.input_tokens"], u.input_tokens, u.prompt_tokens);
      if (ii != null) usage.input = ii;
      var oo2 = num(a["gen_ai.usage.output_tokens"], u.output_tokens, u.completion_tokens);
      if (oo2 != null) usage.output = oo2;
      var ks = Object.keys(n).join(",");
      if (/reasoning|thinking|effort/i.test(ks)) {
        var more = extractReasoning(n);
        for (var q = 0; q < more.length; q++) reasoning.push(more[q]);
      }
      for (var k in n) {
        if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
        if (/^(input|output|prompt|messages|content|text|payload)$/.test(k)) continue;
        visit(n[k], d + 1);
      }
    }
    for (var z = 0; z < docs.length; z++) visit(docs[z], 0);
    // dedupe
    var uniq = [], seenCfg = {};
    for (var y = 0; y < reasoning.length; y++) {
      var key = JSON.stringify(reasoning[y]);
      if (!seenCfg[key]) { seenCfg[key] = 1; uniq.push(reasoning[y]); }
    }
    return { models: models, reasoning: uniq, usage: usage, thinking: thinking, meta: meta };
  }

  function summarize(list) {
    var efforts = [], budgets = [], levels = [], unsupported = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === "budget") budgets.push(list[i]);
      else {
        efforts.push(list[i]);
        if (list[i].level) { if (levels.indexOf(list[i].level) < 0) levels.push(list[i].level); }
        else unsupported = true;
      }
    }
    var status = levels.length > 1 ? "conflict" : unsupported ? "unsupported" : levels.length ? "explicit" : "unknown";
    return { status: status, level: (status === "explicit" ? levels[0] : null), budgets: budgets.slice(-3) };
  }

  var junkSeen = {};
  function onToken(tok, where) {
    var dec = decodeJwt(tok), p = dec && dec.payload;
    if (!p) return;
    // 只认 Trigger.dev 签发、且带 run 授权的 token；其余静默忽略
    // （页面上还有很多别的 JWT，逐个记日志会淹没面板）
    if (p.pub !== true) return;
    if (p.iss !== "https://id.trigger.dev") return;
    state.token = tok;                 // 兜底：宿主点名要时拿得到最近这一个

    /* ── 这里返过一次工，代价很大 ──
       上一版为了"把没 run 授权的 token 也收着"，把 if (!rid) return 删了，
       结果空 runId 也放行 → 探针拿一个不相干的 token 去请求
       /api/v1/runs//events，全线 Failed to fetch，模型名一个都读不出来
       （实测连挂 59 次）。
       收 token 和启轮询是两件事：token 收着，但【这一轮的轮询】必须有 runId。 */
    var rid = runIdFrom(p);
    if (!rid) return;
    if (historySkip[rid]) return;       // 本轮已经试过这个 run 了，别重复打

    /* 按 run 存一份 token —— 带外补 span 要的是【那个 run 的】token，
       不能拿最新那个去查旧 run（授权范围不一样）。只留最近 8 个。 */
    tokByRun[rid] = tok;
    if (tokOrder.indexOf(rid) < 0) tokOrder.push(rid);
    while (tokOrder.length > 8) { try { delete tokByRun[tokOrder.shift()]; } catch (e) {} }

    net.tokenSeen++;
    log("捕获 token (" + (where || "?") + ")");

    if (polling && state.runId === rid) return;   // 同 run 已在轮询
    stopPoll();
    state.runId = rid;
    attempts = 0;
    pollStart = Date.now();
    log("token 有效 · runId=" + rid);
    draw({ state: "polling", runId: rid, attempts: 0, lastErr: "" });
    tick(tok, rid);   // 立刻读第一次，不等待
  }

  function stopPoll() { if (polling) { clearTimeout(polling); polling = null; } }

  /* ================= 内部模型名（带档位）=================
     关键：/events 返回的是 span 【摘要】，properties 被裁剪过；
     真正带档位后缀的 Arena 内部名在 span 【详情】里：
         GET /api/v1/runs/{runId}/spans/{spanId}  →  properties.modelName
     用量 span（token.usage.recorded / spend.recorded）是回合结束后才写进去的，
     所以要靠轮询多试几次。
     来源优先级：内部名  >  trace 的 tabler-cube 标签（后者只是回退）。 */
  var internalCache = { runId: null, name: null, done: false, reading: false };

  function latestUsageSpans(doc, runId) {
    var evs = (doc && Array.isArray(doc.events)) ? doc.events : [];
    var list = [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (!e || (runId && e.runId && e.runId !== runId)) continue;
      if (typeof e.message === "string" && /^chat turn (\d{1,4})$/.test(e.message)) { list = []; continue; }
      if ((e.message === "token.usage.recorded" || e.message === "spend.recorded") &&
          e.spanId && e.isPartial === false) list.push(e);
    }
    return list;
  }

  /* ================= 带外补 span =================
     背景：带档位的内部名在 token.usage.recorded 的 span 详情里，
     而这个 span 是回合【结束后】才写的，实测比显示名晚 8~9 秒。
     抽卡早就翻到下一个对话了 —— 探针一重置，那个 span 就永远拿不到，
     侧栏于是留下一堆没有 -max/-low 的名字。

     以前只能干瞪眼，因为改名必须停在那个对话页面上点菜单；
     现在改名走 PATCH /api/history/agentic/{id}，可以改【任意】对话，
     所以这里把 runId + token 交给宿主，让它异步把名字补回来。 */
  window.__amp3ExternalSpan = function (runId, token) {
    try {
      return fetch(TRIGGER + "/api/v1/runs/" + encodeURIComponent(runId) + "/events", {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
        credentials: "omit", mode: "cors", cache: "no-store",
      }).then(function (r) {
        if (!r.ok) return { ok: false, err: "events http-" + r.status };
        return r.text().then(function (t) {
          var doc; try { doc = JSON.parse(t); } catch (e) { return { ok: false, err: "bad json" }; }
          var evs = (doc && Array.isArray(doc.events)) ? doc.events : [];
          var mine = [], seen = {};
          for (var i = 0; i < evs.length; i++) {
            var e = evs[i];
            if (!e || !e.spanId) continue;
            if ((e.message === "token.usage.recorded" || e.message === "spend.recorded") && e.isPartial === false) {
              if (!seen[e.spanId]) { seen[e.spanId] = 1; mine.push(e.spanId); }
            }
          }
          if (!mine.length) return { ok: false, err: "usage span 还没写进来" };
          return (function next(k, acc) {
            if (k >= mine.length || acc) return { ok: true, model: acc || null };
            return fetch(TRIGGER + "/api/v1/runs/" + encodeURIComponent(runId) + "/spans/" + encodeURIComponent(mine[k]), {
              headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
              credentials: "omit", mode: "cors", cache: "no-store",
            }).then(function (r2) {
              if (!r2 || !r2.ok) return next(k + 1, acc);
              return r2.text().then(function (t2) {
                try {
                  var d2 = JSON.parse(t2), p2 = d2 && d2.properties;
                  var nm = p2 && typeof p2.modelName === "string" ? p2.modelName.trim() : "";
                  if (nm && nm.length <= 200) return { ok: true, model: nm };
                } catch (e2) {}
                return next(k + 1, acc);
              });
            });
          })(0, null);
        });
      });
    } catch (e) { return Promise.resolve({ ok: false, err: String((e && e.message) || e) }); }
  };

  function fetchInternalName(tok, rid, doc) {
    if (internalCache.runId !== rid) internalCache = { runId: rid, name: null, done: false, reading: false };
    if (internalCache.done || internalCache.reading) return;
    var spans = latestUsageSpans(doc, rid);
    if (!spans.length) return;                       // 还没写进来，下次轮询再试
    internalCache.reading = true;

    var uniq = [], spanReasoning = [], seenId = {}, queue = spans.slice(-6);   // 最多 6 个，别太贪
    (function next() {
      if (!queue.length) {
        internalCache.reading = false;
        // span 详情里读到的推理配置（summarize 传空数组是安全的，status 会是 unknown）
        var sr = summarize(spanReasoning);
        var srOk = sr && sr.status === "explicit";
        if (srOk) log("span 详情里发现档位: " + sr.level);

        if (uniq.length === 1) {
          internalCache.name = uniq[0];
          internalCache.done = true;
          state.internalModel = uniq[0];
          state.internalTier = tierFromName(uniq[0]);
          // 档位优先级：名字后缀 > span 详情 > /events 摘要
          var best = srOk ? sr : state.reasoning;
          state.reasoning = best;
          var nt = state.internalTier || tierFromName(state.model);
          state.tier = combineTier(nt, best);
          log("内部模型名: " + uniq[0] + (state.internalTier ? "  档位 " + state.internalTier.toUpperCase() : ""));
          draw();
        } else if (srOk) {
          state.reasoning = sr;
          state.tier = combineTier(tierFromName(state.model), sr);
          draw();
        }
        return;
      }
      var sp = queue.shift();
      if (!sp || seenId[sp.spanId]) return next();
      seenId[sp.spanId] = 1;
      fetch(TRIGGER + "/api/v1/runs/" + encodeURIComponent(rid) + "/spans/" + encodeURIComponent(sp.spanId), {
        method: "GET",
        headers: { "Authorization": "Bearer " + tok, "Accept": "application/json" },
        credentials: "omit", mode: "cors", cache: "no-store",
      }).then(function (r) {
        if (!r || !r.ok) return null;
        return r.text().then(function (t) {
          try {
            var d = JSON.parse(t), p = d && d.properties;
            var nm = p && typeof p.modelName === "string" ? p.modelName.trim() : "";
            if (nm && nm.length <= 200 && uniq.indexOf(nm) < 0) uniq.push(nm);
            /* span 详情里不只有 modelName —— 推理配置也可能在这里。
               /events 是摘要（properties 被裁剪），所以以前从那儿读不到档位；
               详情接口才是完整 properties。（参考 9.17.9 探针同时读两类字段） */
            if (p) {
              var rs = extractReasoning(p);
              for (var q2 = 0; q2 < rs.length; q2++) spanReasoning.push(rs[q2]);
            }
          } catch (e) {}
          return null;
        });
      }).catch(function () {}).then(function () { setTimeout(next, 120); });
    })();
  }

  function tick(tok, rid) {
    attempts++;
    /* 分层退避：token 到手后的头几秒最容易出结果，
       所以一开始用 300ms 密集试；拿到后再退到 1s / 3s。
       这样既能在最快时机显示模型名，又不会长时间猛打接口。 */
    var age = Date.now() - pollStart;
    var next = age < 15000 ? 300 : (age < 60000 ? 1000 : 3000);

    fetch(TRIGGER + "/api/v1/runs/" + encodeURIComponent(rid) + "/events", {
      method: "GET",
      headers: { "Authorization": "Bearer " + tok, "Accept": "application/json" },
      credentials: "omit",
      mode: "cors",
    }).then(function (res) {
      if (!res.ok) {
        var why = "http-" + res.status;
        draw({ state: "polling", attempts: attempts, lastErr: why });
        if (attempts === 1 || attempts % 8 === 0) log("读取 #" + attempts + " -> " + why);
        if ([401, 403, 404].indexOf(res.status) >= 0) { log("trace 读取被拒（token 可能过期）"); return; }
        polling = setTimeout(function () { tick(tok, rid); }, next);
        return;
      }
      return res.text().then(function (t) {
        lastTrace = t;
        try { fetchInternalName(tok, rid, JSON.parse(t)); } catch (e) {}
        var r = parseTrace(t);
        if (r.models.length) {
          var model = r.models[r.models.length - 1];
          /* 同一对话中途被路由换模型 —— 实测会发生
             （别人的工具也印过 "模型变化: deepseek-v4-flash-vision-exp → deepseek-flash"）。
             这里只要发现本轮标签和上一轮不同就明确报出来，别让用户以为一直是同一个。 */
          if (state.model && state.model !== model) {
            var from = state.model;
            state.modelChanges = (state.modelChanges || []);
            state.modelChanges.push({ from: from, to: model, at: Date.now() });
            log("⚠ 模型变化: " + from + " → " + model);
          }
          var firstTime = state.model !== model;
          var nameTier = tierFromName(model);
          draw({
            state: "found", model: model, runId: rid,
            nameTier: nameTier,
            tier: combineTier(nameTier, summarize(r.reasoning)),
            reasoning: summarize(r.reasoning),
            usage: r.usage, thinking: r.thinking, meta: r.meta || {},
          });
          if (firstTime) log("★ 真实模型名: " + model);

          /* 拿到 cube 标签【不能停】。
             cube 标签只是【基名】，带档位的真名在用量 span 的详情里，
             而用量 span 是回合结束后才写进去的 —— 停早了就永远读不到。
             这里继续轮询直到内部名到手（或试够次数）。 */
          if (!internalCache.done) {
            /* 内部名（带档位的真名）来自用量 span，而用量 span 是【回合结束后】
               才写进 trace 的。长任务（几分钟）以前会在 48 秒后彻底放弃轮询，
               之后即使 span 出现了也再没人看 —— 现在改成：
                 前 40 次快问（1.2s）→ 之后放慢到 10s 继续等 → 最多等 6 分钟。 */
            var waited = Date.now() - pollStart;
            if (waited < 360000) {
              if (attempts === 40) log("内部名还没出现，改成每 10 秒问一次（等回合结束）");
              polling = setTimeout(function () { tick(tok, rid); }, attempts < 40 ? 1200 : 10000);
            } else {
              log("内部名等了 6 分钟仍未出现，档位只能按 trace 标签判断");
            }
          }
          return;
        }
        draw({ state: "polling", attempts: attempts, lastErr: "", reasoning: summarize(r.reasoning), usage: r.usage, thinking: r.thinking });
        if (attempts === 1 || attempts % 8 === 0) log("读取 #" + attempts + " -> 暂无标签（" + t.length + " bytes）");
        if (Date.now() - pollStart > 300000) { log("超时：本轮未取到模型标签"); return; }
        polling = setTimeout(function () { tick(tok, rid); }, next);
      });
    }).catch(function (e) {
      draw({ state: "polling", attempts: attempts, lastErr: "网络错误" });
      log("读取 #" + attempts + " 失败: " + (e && e.message));
      polling = setTimeout(function () { tick(tok, rid); }, next);
    });
  }

  /* ================= 3. 思考块检测（DOM，最快） ================= */
  var THINK_RE = /^(Thinking\b|Thought\b|思考|已思考|Reasoning\b)/i;
  function scanThinking() {
    try {
      if (state.thinking) return;   // 已经发现过就别再遍历了（原来每次仍扫全部按钮）
      // 只扫正文区：侧栏几十个对话项也都是 button，扫它们纯属浪费
      var scope = document.querySelector("main") || document.body;
      var hits = scope.querySelectorAll("button, summary, [role='button']");
      for (var i = 0; i < hits.length; i++) {
        var el = hits[i];
        // 先做便宜的字符串判断 —— getClientRects() 会触发同步布局，不能对每个按钮都调
        var txt = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
        if (!THINK_RE.test(txt)) continue;
        if (!el.getClientRects().length) continue;   // 只有疑似命中才验可见性
        state.thinking = true;
        log("检测到思考块: " + txt.slice(0, 28));
        draw();
        return;
      }
    } catch (e) {}
  }

  /* ================= 4. 对话切换检测 ================= */
  function convKey() {
    try {
      var p = location.pathname || "";
      var m = p.match(/\/agent\/([0-9a-f-]{36})/i);
      if (m) return "conv:" + m[1].toLowerCase();
      if (/\/agent\/?$/.test(p)) return "new";
      return "other:" + p;
    } catch (e) { return "unknown"; }
  }
  var curConv = convKey();
  // 关键：/agent -> /agent/<uuid> 是【同一对话刚分到 id】，不算切换
  function isRealSwitch(from, to) {
    if (from === to) return false;
    if (from === "new" && to.indexOf("conv:") === 0) return false;
    return true;
  }
  function checkConv() {
    var k = convKey();
    if (k === curConv) return;
    if (!isRealSwitch(curConv, k)) { curConv = k; return; }
    curConv = k;
    // 真切换：重置一切
    stopPoll();
    seen = Object.create(null);
    internalCache = { runId: null, name: null, done: false, reading: false };
    nameVotes = Object.create(null);   // 切对话，重新计票
    votesAt = Date.now();
    state = { state: "idle", model: null, fastModel: null, runId: null, attempts: 0, reasoning: null, usage: null, thinking: false, lastErr: "", internalModel: null, internalTier: null, meta: null };
    log("—— 切换对话 · 已重置 ——");
    draw();
  }

  /* ================= 手动检测当前会话模型 =================
     ── 为什么需要它 ──
     自动通道有三处会漏，都不是 bug，是机制本身决定的：
       ① token 由服务端在【回合结束】时才下发，而且只在页面重新请求
          /api/history/unified 或 /api/chat/<id>/preview 时才补发；
          只打开页面不动，等多久都没有（HANDOFF-01 §2.2 实测）。
       ② SPA 切对话时 checkConv() 会 stopPoll() 并把 state 整个重置，
          切换瞬间正在跑的那次轮询结果就丢了。
       ③ 内部名（带档位的真名）在回合结束后 8~9 秒才写进 span，
          到那时抽卡早就翻到下一个对话了。

     所以这里【不新增任何识别手段】，只是把上面那两件事手动催一次：
       ① 手上已有的 token → 对着它自己的 run 重读一遍
          （绕开 historySkip 那个"同一个 run 只试一次"的闸门）；
       ② 把存储里可能躺着的 token 再扫一遍（自动兜底是每 4 秒一次且只在没结果时跑）；
       ③ 主动请求页面自己也会发的两个接口，让服务端补发一个当前会话的 token。
     接口走的是页面自己的 fetch，所以响应照样被上面的钩子扫到、照样走 onToken ——
     【自动识别的判断逻辑一行都没改】。 */
  var DETECT_BUDGET_MS = 30000;
  /* 一直没有 token 就早点收工 —— 这种情况下等满 30 秒是纯浪费 */
  var DETECT_NOTOKEN_MS = 8000;
  var detectTimers = [];
  function detectStop() {
    for (var i = 0; i < detectTimers.length; i++) { try { clearTimeout(detectTimers[i]); } catch (e) {} }
    detectTimers = [];
  }
  function detectLater(fn, ms) { detectTimers.push(setTimeout(fn, ms)); }

  function detectCurrent(manual) {
    detectStop();
    var t0 = Date.now();
    var report = { at: Date.now(), manual: !!manual, notes: [], token: false, runId: null,
                   model: null, fastModel: null, internalModel: null, ms: 0, reason: "" };

    /* ── 先清掉【未经确认】的快速通道结果，重新从零认一次 ──
       起因（2026-09-25 用户报）：面板上挂着 gpt-5.5，实际是 opus-5。
       旧值的来源是"读历史的端点被快速通道采信"（已修，见 fastSourceOk）。
       但光修来源不够 —— 那个错值已经写进 state.fastModel，
       只要没有新一轮覆盖它，面板就会【一直】显示错的模型名。
       所以手动检测的含义是"现在，重新判一次"：
         · 已由 trace 确认的 state.model 不动（那是权威结果）；
         · 未经确认的 fastModel / 档位清掉，重新计票重新认。
       这样即使旧版本留下了错值，点一下就能回到干净状态。 */
    if (!state.model) {
      if (state.fastModel) report.notes.push("清掉未经确认的旧结果: " + state.fastModel);
      state.fastModel = null;
      state.tier = null;
      state.internalModel = null;
      state.internalTier = null;
      nameVotes = Object.create(null);
      votesAt = Date.now();
    }

    function finish(reason) {
      detectStop();
      report.reason = reason;
      report.model = state.model || null;
      report.fastModel = state.fastModel || null;
      report.internalModel = state.internalModel || null;
      report.runId = state.runId || null;
      report.token = !!state.token;
      report.ms = Date.now() - t0;
      /* 认不出来时把原因说清楚 —— 用户看到的是"为什么没出来"，不是一句"失败" */
      report.why = (report.model || report.fastModel) ? "" :
        (!report.token
          ? "没有拿到 token。服务端只在回合结束时补发，先在这个对话里发一条消息再看"
          : "有 token，但 trace 里还没有模型标签（回合可能还没结束，稍后再点一次）");
      log("手动检测" + (report.model ? "成功" : "结束") + "：" +
          (report.internalModel || report.model || report.fastModel || "仍未认出来") +
          (report.why ? " —— " + report.why : "") +
          "（" + Math.max(1, Math.round(report.ms / 1000)) + "s）");
      if (manual) {
        try { window.postMessage({ source: "__amp3", type: "detect", report: report }, "*"); } catch (e) {}
      }
      return report;
    }

    /* ① 已有的 token：对着它自己的 run 重读一次 */
    try {
      var rid = null;
      for (var i = tokOrder.length - 1; i >= 0; i--) {
        if (tokByRun[tokOrder[i]]) { rid = tokOrder[i]; break; }
      }
      if (rid) {
        delete historySkip[rid];            // 手动 = 明确要求重读，绕开"只试一次"
        /* 带档位的内部名读一次就 done 了。用户既然手动点了，就说明他要的是
           【完整】结果（名字 + 档位），所以把这个闸门也松开重读一次 ——
           代价只是最多 6 次 span 详情请求，而这是用户主动点的一次。 */
        if (!state.internalModel) {
          internalCache = { runId: rid, name: null, done: false, reading: false };
        }
        if (polling && state.runId === rid) {
          report.notes.push("这个 run 正在轮询中，直接等它出结果");
        } else {
          report.notes.push("复用已捕获的 token（run " + rid + "）");
          onToken(tokByRun[rid], "手动检测");
        }
      } else {
        report.notes.push("手上还没有 token");
      }
    } catch (e) { report.notes.push("复用 token 失败: " + (e && e.message)); }

    /* ② 存储兜底立刻跑一遍（不等自动那条 4 秒的定时器） */
    try {
      for (var s = 0; s < sessionStorage.length; s++) {
        var k = sessionStorage.key(s), v = sessionStorage.getItem(k);
        if (v && v.indexOf("eyJ") >= 0) scan(k + "=" + v, "sessionStorage(手动)");
      }
      for (var l = 0; l < localStorage.length; l++) {
        var k2 = localStorage.key(l), v2 = localStorage.getItem(k2);
        if (v2 && v2.indexOf("eyJ") >= 0) scan(k2 + "=" + v2, "localStorage(手动)");
      }
    } catch (e) {}

    /* ③ 催服务端补发 token：这两个接口页面自己也会发（见 HANDOFF-01 §2.2）。
       只负责发起 —— 响应由既有的 fetch 钩子扫描，不在这里重复读 body。 */
    function nudge(url, tag) {
      try {
        return fetch(location.origin + url, {
          method: "GET", credentials: "same-origin", cache: "no-store",
          headers: { Accept: "application/json" },
        }).then(function (r) {
          report.notes.push(tag + " → HTTP " + (r && r.status));
        }).catch(function (e) {
          report.notes.push(tag + " 失败: " + (e && e.message));
        });
      } catch (e) { report.notes.push(tag + " 异常: " + (e && e.message)); return Promise.resolve(); }
    }
    nudge("/api/history/unified", "历史列表");
    try {
      var m = (location.pathname || "").match(/\/agent\/([0-9a-f-]{36})/i);
      if (m) detectLater(function () { nudge("/api/chat/" + m[1].toLowerCase() + "/preview", "会话预览"); }, 1500);
    } catch (e) {}

    /* ④ 盯着状态：认出来就收工，超时就如实报告 */
    function watch() {
      if (state.model) { finish("found"); return; }
      /* 早退：连 token 都没有，就没什么可等的了 —— 别让用户对着"检测中…"干等 30 秒
         才发现这个对话压根没有可用的 token。 */
      if (!state.token && Date.now() - t0 > DETECT_NOTOKEN_MS) { finish("no-token"); return; }
      if (Date.now() - t0 > DETECT_BUDGET_MS) { finish("timeout"); return; }
      detectLater(watch, 1200);
    }
    detectLater(watch, 1200);

    return report;
  }
  /* 控制台里也能手动催一次：window.__amp3Detect() */
  try { window.__amp3Detect = function () { return detectCurrent(true); }; } catch (e) {}

  /* ================= 启动 ================= */
  function boot() {
    buildHud();
    broadcast(true);
    log("v3 就绪（单脚本 · 直连 Trigger.dev）");
    setInterval(function () { checkConv(); }, 1500);   // 很便宜
    setTimeout(function () { fetchBalance(true); }, 2500);   // 启动后拉一次额度
    setInterval(function () { fetchBalance(false); }, 60000); // 之后每 60 秒（最小间隔也在函数里兜底）
    setInterval(function () { scanThinking(); }, 3000); // getClientRects 会触发布局，别太勤
    // 兜底：token 也可能出现在存储里（较贵，频率放低；已拿到结果就整段跳过）
    setInterval(function () {
      try {
        if (state.model && state.runId) return;
        for (var i = 0; i < sessionStorage.length; i++) {
          var k = sessionStorage.key(i), v = sessionStorage.getItem(k);
          if (v && v.indexOf("eyJ") >= 0) scan(k + "=" + v, "sessionStorage");
        }
        for (var j = 0; j < localStorage.length; j++) {
          var k2 = localStorage.key(j), v2 = localStorage.getItem(k2);
          if (v2 && v2.indexOf("eyJ") >= 0) scan(k2 + "=" + v2, "localStorage");
        }
      } catch (e) {}
    }, 4000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 自检
  window.__amp3Scan = function () { return "ok"; };
  window.__amp3State = function () { return state; };
  /* 一键诊断：把网络活动与状态打印到 console 并返回 */
  /* 用 performance entries 反查所有网络请求 —
     即使请求来自 Web Worker / Service Worker（页面钩子够不到），这里也能看到 URL */
  function perfUrls() {
    try {
      var es = performance.getEntriesByType("resource") || [];
      var urls = [];
      for (var i = 0; i < es.length; i++) {
        var u = String(es[i].name || "");
        if (/arena\.ai|trigger\.dev|\/api\/|nextjs-api|stream/i.test(u)) {
          var short = u.replace(/^https?:\/\/[^/]+/, "").slice(0, 90);
          if (urls.indexOf(short) < 0) urls.push(short);
        }
      }
      return urls.slice(-25);
    } catch (e) { return []; }
  }
  window.__amp3Perf = perfUrls;

  window.__amp3Diag = function () {
    var d = {
      perfUrls: perfUrls(),
      hasServiceWorker: (function () { try { return !!navigator.serviceWorker; } catch (e) { return null; } })(),
      isTopFrame: (function () { try { return window.top === window; } catch (e) { return "cross-origin"; } })(),
      hudBuilt: !!host,
      netSeen: net.seen,
      netByType: net.byType,
      tokenSeen: net.tokenSeen,
      lastUrl: net.lastUrl,
      state: state,
      logs: logs.slice(-15),
    };
    try { console.log("[amp3 诊断]", d); } catch (e) {}
    if (host) {
      var el = shadow.querySelector("#diag");
      if (!el) {
        el = document.createElement("div");
        el.id = "diag";
        el.style.cssText = "margin-top:6px;padding-top:6px;border-top:1px solid #21262d;font-size:10.5px;opacity:.9";
        shadow.querySelector(".bd").appendChild(el);
      }
      var pu = perfUrls();
      el.innerHTML = "<div><b>已见响应 " + net.seen + " · token " + net.tokenSeen + "</b></div>" +
        Object.keys(net.byType).map(function (k) { return "<div>" + esc(k) + " × " + net.byType[k] + "</div>"; }).join("") +
        (net.lastUrl ? "<div>最近: " + esc(net.lastUrl) + "</div>" : "") +
        (pu.length ? "<div style='margin-top:4px'>performance 里的 API 请求:</div>" +
          pu.slice(-8).map(function (u) { return "<div>· " + esc(u) + "</div>"; }).join("") : "<div>（performance 无相关请求）</div>");
    }
    return d;
  };
})();
