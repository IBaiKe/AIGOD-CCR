将以下代码部署到 Replit 并发布（需要 publish），但不是简单部署，你必须先修改代码，使它成为一个“真正兼容 OpenAI Chat Completions 协议”的 AI 代理，并且在 Claude 模型场景下正确支持 tool calling 的双向协议转换。

严格要求如下：

1. 部署目标
- 使用 Replit Node.js 项目部署这份代码
- 启用 AI Integrations
- 修改完成后进行 publish
- 服务运行完成后，必须在最终输出中贴出：
  - Base URL
  - 生成的 API Key

2. 协议兼容目标
这个代理对外必须保持 OpenAI Chat Completions API 兼容，也就是客户端仍然按 OpenAI 格式调用：
- 请求使用 `/v1/chat/completions`
- 支持 `model`
- 支持 `messages`
- 支持 `stream`
- 支持 `tools`
- 支持 `tool_choice`
- 支持 assistant 返回 `tool_calls`
- 支持 tool 返回后的多轮继续对话

重点：当后端实际路由到 Claude（Anthropic）模型时，不能直接透传 OpenAI 的 `tools/tool_calls` 格式，必须做协议转换。

3. Claude tool calling 双向转换要求
你必须实现以下映射，而不是只支持普通文本对话：

A. OpenAI -> Anthropic
当外部请求是 OpenAI 格式，且目标模型是 Claude 时：
- 将 OpenAI 的 `tools` 转换为 Anthropic Messages API 所需的 `tools`
- 将 OpenAI 的 `tool_choice` 转换为 Anthropic 对应语义
- 将 `messages` 转换为 Anthropic `messages`
- 如果出现 OpenAI 风格的 assistant `tool_calls` / tool message 续轮，也要正确转换为 Claude 可理解的格式
- 特别注意：Anthropic 原生工具调用不是 `tool_calls` 字段，而是 `content` 数组中的 `tool_use` / `tool_result` block，必须正确映射

B. Anthropic -> OpenAI
当 Claude 返回工具调用时：
- 如果是非流式响应，必须将 Anthropic 的 `tool_use` block 转换成 OpenAI Chat Completions 风格的：
  - `choices[0].message.role = "assistant"`
  - `choices[0].message.tool_calls = [...]`
  - 每个 tool call 都要包含：
    - `id`
    - `type: "function"`
    - `function.name`
    - `function.arguments`（JSON 字符串）
- 如果 Claude 返回普通文本，则仍按 OpenAI `message.content` 返回
- 如果 Claude 返回的是文本 + tool_use 混合内容，也要尽可能按 OpenAI 兼容方式表达，不能丢失工具调用信息

C. tool result 回传
当客户端按 OpenAI 格式把工具执行结果传回时，例如消息里包含：
- `role: "tool"`
- `tool_call_id`
- `content`

你必须把它正确转换成 Anthropic 可接受的 `tool_result` content block，并挂到对应对话轮次中，保证 Claude 能继续完成后续推理。

4. 流式兼容要求
如果 `stream=true` 且目标模型为 Claude：
- 不能只转发文本增量
- 必须正确处理 Claude 流式事件中的工具调用相关事件
- 当 Claude 流式产生工具调用时，要把它转换成 OpenAI SSE 风格的增量事件，使 OpenAI SDK / AI SDK 能识别 `tool_calls` 增量
- 至少要兼容：
  - 文本增量
  - tool call 开始
  - tool call 参数增量
  - stop 结束
- 最终输出必须符合 OpenAI 流式 chat completions 习惯格式，而不是 Anthropic 原生事件格式

5. 兼容性目标
修改后的代理必须能被基于 OpenAI 兼容接口的 SDK 正常使用，尤其是：
- `@ai-sdk/openai-compatible`
- 依赖 OpenAI `tools/tool_calls` 机制的 MCP / function calling 场景

换句话说：
- 对外看起来是 OpenAI
- 对内如果走 Claude，代理层负责做完整协议翻译
- 不能把 Anthropic 原生 `tool_use` 结构直接泄露给 OpenAI 客户端

6. 实现要求
- 尽量在现有代码基础上最小修改
- 不要引入复杂依赖，优先零依赖或仅使用 Node.js 内置能力
- 保留现有 OpenAI、OpenRouter、Gemini 路由能力
- 重点增强 Anthropic 分支
- 需要同时处理非流式和流式
- 需要处理多轮工具调用，不只是首轮调用

7. 验收要求
完成后请：
- 给出最终可运行代码
- 完成 Replit publish
- 贴出 Base URL 和 API Key
- 说明你具体实现了哪些 OpenAI <-> Claude tool calling 转换逻辑
- 最好附一个最小测试示例，证明 OpenAI 格式 tools 请求打到 Claude 时也能正常工作

以下是需要部署和修改的代码：

// Replit AI Proxy — 零依赖，Node.js 18+
// 部署: 新建 Replit Node.js 项目 → 开启 AI Integrations → 粘贴此文件为 index.mjs → Run
// API Key 首次运行自动生成并持久化到 .proxy-key 文件
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PORT = process.env.PORT || 3000;
const KEY_FILE = ".proxy-key";
let KEY;
if (existsSync(KEY_FILE)) {
  KEY = readFileSync(KEY_FILE, "utf8").trim();
} else {
  KEY = "sk-replit-" + randomBytes(5).toString("hex");
  writeFileSync(KEY_FILE, KEY);
}

const creds = (p) => {
  const P = p.toUpperCase();
  return { url: process.env[`AI_INTEGRATIONS_${P}_BASE_URL`], key: process.env[`AI_INTEGRATIONS_${P}_API_KEY`] };
};

const route = (m) =>
  m.startsWith("claude-") ? "anthropic" : m.startsWith("gemini-") ? "gemini" : m.includes("/") ? "openrouter" : "openai";

const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
const J = (res, s, d) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
const rid = () => "chatcmpl-" + randomBytes(4).toString("hex");
const now = () => (Date.now() / 1000) | 0;
const oaiChunk = (id, model, content, finish) =>
  JSON.stringify({ id, object: "chat.completion.chunk", created: now(), model, choices: [{ index: 0, delta: finish ? {} : { content }, finish_reason: finish || null }] });

async function pipe(reader, res) {
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
  res.end();
}

async function streamAnthropic(reader, res, model) {
  const dec = new TextDecoder(), id = rid();
  let buf = "";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith("data: ")) continue;
      try {
        const e = JSON.parse(l.slice(6));
        if (e.type === "content_block_delta" && e.delta?.text) res.write(`data: ${oaiChunk(id, model, e.delta.text)}\n\n`);
        if (e.type === "message_stop") res.write(`data: ${oaiChunk(id, model, "", "stop")}\n\n`);
      } catch {}
    }
  }
  res.write("data: [DONE]\n\n"); res.end();
}

async function streamGemini(reader, res, model) {
  const dec = new TextDecoder(), id = rid();
  let buf = "";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith("data: ")) continue;
      try {
        const e = JSON.parse(l.slice(6));
        const t = e.candidates?.[0]?.content?.parts?.[0]?.text;
        if (t) res.write(`data: ${oaiChunk(id, model, t)}\n\n`);
        if (e.candidates?.[0]?.finishReason) res.write(`data: ${oaiChunk(id, model, "", "stop")}\n\n`);
      } catch {}
    }
  }
  res.write("data: [DONE]\n\n"); res.end();
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.headers.authorization !== `Bearer ${KEY}`) return J(res, 401, { error: "Unauthorized" });

  if (req.url === "/v1/models") {
    const models = [
      // Anthropic
      { id: "claude-opus-4-6", owned_by: "anthropic" },
      { id: "claude-opus-4-5", owned_by: "anthropic" },
      { id: "claude-opus-4-1", owned_by: "anthropic" },
      { id: "claude-sonnet-4-6", owned_by: "anthropic" },
      { id: "claude-sonnet-4-5", owned_by: "anthropic" },
      { id: "claude-haiku-4-5", owned_by: "anthropic" },
      // OpenAI
      { id: "gpt-5.2", owned_by: "openai" },
      { id: "gpt-5.1", owned_by: "openai" },
      { id: "gpt-5", owned_by: "openai" },
      { id: "gpt-5-mini", owned_by: "openai" },
      { id: "gpt-5-nano", owned_by: "openai" },
      { id: "gpt-4.1", owned_by: "openai" },
      { id: "gpt-4.1-mini", owned_by: "openai" },
      { id: "gpt-4.1-nano", owned_by: "openai" },
      { id: "gpt-4o", owned_by: "openai" },
      { id: "gpt-4o-mini", owned_by: "openai" },
      { id: "o4-mini", owned_by: "openai" },
      { id: "o3", owned_by: "openai" },
      { id: "o3-mini", owned_by: "openai" },
      // Gemini
      { id: "gemini-3.1-pro-preview", owned_by: "google" },
      { id: "gemini-3-pro-preview", owned_by: "google" },
      { id: "gemini-3-flash-preview", owned_by: "google" },
      { id: "gemini-2.5-pro", owned_by: "google" },
      { id: "gemini-2.5-flash", owned_by: "google" },
    ];
    return J(res, 200, {
      object: "list",
      data: models.map((m) => ({ ...m, object: "model", created: 1700000000 })),
    });
  }

  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    const raw = await readBody(req);
    const p = JSON.parse(raw);
    const prov = route(p.model);
    const { url, key } = creds(prov);

    try {
      // OpenAI / OpenRouter — 直接转发
      if (prov === "openai" || prov === "openrouter") {
        const up = await fetch(`${url}/chat/completions`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: raw,
        });
        if (p.stream) { res.writeHead(up.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); return pipe(up.body.getReader(), res); }
        return J(res, up.status, await up.json());
      }

      // Anthropic — OpenAI 格式 ↔ Anthropic Messages API
      if (prov === "anthropic") {
        const sys = p.messages.find((m) => m.role === "system")?.content;
        const msgs = p.messages.filter((m) => m.role !== "system");
        const up = await fetch(`${url}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: p.model, max_tokens: p.max_tokens || 8192, ...(sys && { system: sys }), messages: msgs, ...(p.stream && { stream: true }) }),
        });
        if (!up.ok) return J(res, up.status, await up.json().catch(() => ({ error: up.statusText })));
        if (p.stream) return streamAnthropic(up.body.getReader(), res, p.model);
        const d = await up.json();
        return J(res, 200, {
          id: rid(), object: "chat.completion", created: now(), model: p.model,
          choices: [{ index: 0, message: { role: "assistant", content: d.content?.[0]?.text || "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: d.usage?.input_tokens || 0, completion_tokens: d.usage?.output_tokens || 0, total_tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0) },
        });
      }

      // Gemini — OpenAI 格式 ↔ Google generateContent API
      if (prov === "gemini") {
        const sys = p.messages.find((m) => m.role === "system")?.content;
        const contents = p.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        const action = p.stream ? "streamGenerateContent?alt=sse" : "generateContent";
        const up = await fetch(`${url}/models/${p.model}:${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents, ...(sys && { systemInstruction: { parts: [{ text: sys }] } }), generationConfig: { maxOutputTokens: p.max_tokens || 8192 } }),
        });
        if (!up.ok) return J(res, up.status, await up.json().catch(() => ({ error: up.statusText })));
        if (p.stream) return streamGemini(up.body.getReader(), res, p.model);
        const d = await up.json();
        return J(res, 200, {
          id: rid(), object: "chat.completion", created: now(), model: p.model,
          choices: [{ index: 0, message: { role: "assistant", content: d.candidates?.[0]?.content?.parts?.[0]?.text || "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: d.usageMetadata?.promptTokenCount || 0, completion_tokens: d.usageMetadata?.candidatesTokenCount || 0, total_tokens: d.usageMetadata?.totalTokenCount || 0 },
        });
      }
    } catch (e) {
      return J(res, 502, { error: { message: e.message } });
    }
  }
  J(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  const domain = process.env.REPLIT_DEV_DOMAIN || `localhost:${PORT}`;
  const base = `https://${domain}/v1`;
  console.log(`\n========================================`);
  console.log(`  Replit AI Proxy 已启动`);
  console.log(`========================================`);
  console.log(`  Base URL : ${base}`);
  console.log(`  API Key  : ${KEY}`);
  console.log(`========================================`);
  console.log(`  用法示例 (curl):`);
  console.log(`  curl ${base}/chat/completions \\`);
  console.log(`    -H "Authorization: Bearer ${KEY}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'`);
  console.log(`========================================\n`);
});
