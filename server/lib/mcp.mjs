// 零依赖 MCP 服务端（只用 node: 内置模块）。
// 已用官方 @modelcontextprotocol/sdk 客户端验证互通。
//
// 兼容三种客户端行为（都在真实网页 Agent 上踩过）：
//   1. 标准 MCP 客户端：POST + Accept: application/json, text/event-stream
//   2. 只会普通 POST 的客户端：回纯 JSON（不强求 SSE）
//   3. 先用 GET 探路的客户端：回一份说明，而不是 406
import http from "node:http";

export function createMcpServer({ tools, token, port, host = "127.0.0.1", onLog }) {
  const log = onLog || (() => {});
  const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
  const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function dispatch(msg) {
    const { id, method, params } = msg || {};
    if (method === "initialize") {
      return rpcOk(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "arena-bridge", version: "1.0.0" },
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return rpcOk(id, {});
    if (method === "tools/list") {
      return rpcOk(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    }
    if (method === "tools/call") {
      const tool = tools.find((t) => t.name === (params && params.name));
      if (!tool) return rpcErr(id, -32602, "未知工具: " + (params && params.name));
      try {
        return rpcOk(id, await tool.handler((params && params.arguments) || {}));
      } catch (e) {
        return rpcOk(id, { content: [{ type: "text", text: "错误: " + (e && e.message || e) }], isError: true });
      }
    }
    if (method === "resources/list") return rpcOk(id, { resources: [] });
    if (method === "prompts/list") return rpcOk(id, { prompts: [] });
    return rpcErr(id, -32601, "未实现的方法: " + method);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathToken = url.pathname.startsWith("/mcp/") ? decodeURIComponent(url.pathname.slice(5)) : "";
    if (url.pathname !== "/mcp" && !pathToken) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }

    const auth = String(req.headers["authorization"] || "");
    if (!(auth === "Bearer " + token || pathToken === token)) {
      log("[401] " + req.method + " ua=" + (req.headers["user-agent"] || "-"));
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("unauthorized");
      return;
    }

    if (req.method === "GET" && !String(req.headers["accept"] || "").includes("text/event-stream")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({
        ok: true,
        service: "arena-bridge",
        protocol: "MCP (Model Context Protocol) over Streamable HTTP",
        message: "这是一个 MCP 端点，不是普通 REST 接口。",
        how_to_use: {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          note: "SSE 可选：不支持 SSE 的客户端会收到纯 JSON 响应。",
        },
        tools: tools.map((t) => t.name),
      }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", Allow: "GET, POST" })
        .end(JSON.stringify(rpcErr(null, -32000, "Method not allowed")));
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" })
        .end(JSON.stringify(rpcErr(null, -32700, "Parse error")));
      return;
    }

    const wantSse = String(req.headers["accept"] || "").includes("text/event-stream");
    const batch = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const m of batch) {
      const r = await dispatch(m);
      if (r) replies.push(r);
    }
    if (!replies.length) { res.writeHead(202).end(); return; }
    const payload = Array.isArray(body) ? replies : replies[0];

    if (wantSse) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: message\n");
      res.write("data: " + JSON.stringify(payload) + "\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        .end(JSON.stringify(payload));
    }
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve({ port, host }));
    }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
