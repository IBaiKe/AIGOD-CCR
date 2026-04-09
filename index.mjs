// Replit AI Proxy — 零依赖，Node.js 18+
// 部署: 新建 Replit Node.js 项目 → 开启 AI Integrations → 粘贴此文件为 index.mjs → Run
// API Key 首次运行自动生成并持久化到 .proxy-key 文件
//
// 完整支持 OpenAI <-> Anthropic Claude tool calling 双向协议转换
// 支持非流式和流式模式下的 tool_use / tool_calls 映射
// 支持 Anthropic 原生 /v1/messages 端点透传（Claude Code 等）

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

// ─────────────────────────────────────────────────────────
//  模型名透传：官方 API ID 已经是 claude-opus-4-6 等短名格式
//  不做任何映射，原样传递给上游 API
// ─────────────────────────────────────────────────────────
const mapAnthropicModel = (m) => m;

// ─────────────────────────────────────────────────────────
//  清理 cache_control：移除上游 API 不支持的额外字段（如 scope）
//  Claude Code 会发送 cache_control: { type: "ephemeral", scope: "..." }
//  但 Replit AI Integrations 上游只接受 { type: "ephemeral" }
// ─────────────────────────────────────────────────────────
function stripCacheControl(body) {
  // 清理 system 中的 cache_control
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && block.cache_control) {
        // 只保留 type 字段，移除 scope 等额外字段
        block.cache_control = { type: block.cache_control.type };
      }
    }
  }
  // 清理 messages 中的 cache_control
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.cache_control) {
            block.cache_control = { type: block.cache_control.type };
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
//  日志工具
// ─────────────────────────────────────────────────────────
let reqCounter = 0;
const ts = () => new Date().toISOString();
function log(reqId, ...args) {
  console.log(`[${ts()}] [#${reqId}]`, ...args);
}
function logErr(reqId, ...args) {
  console.error(`[${ts()}] [#${reqId}]`, ...args);
}

const creds = (p) => {
  const P = p.toUpperCase();
  return {
    url: process.env[`AI_INTEGRATIONS_${P}_BASE_URL`],
    key: process.env[`AI_INTEGRATIONS_${P}_API_KEY`],
  };
};

const route = (m) =>
  m.startsWith("claude-")
    ? "anthropic"
    : m.startsWith("gemini-")
      ? "gemini"
      : m.includes("/")
        ? "openrouter"
        : "openai";

const readBody = (req) =>
  new Promise((r) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => r(Buffer.concat(c).toString()));
  });

const J = (res, s, d) => {
  res.writeHead(s, { "Content-Type": "application/json" });
  res.end(JSON.stringify(d));
};

const rid = () => "chatcmpl-" + randomBytes(4).toString("hex");
const tcid = () => "call_" + randomBytes(8).toString("hex");
const now = () => (Date.now() / 1000) | 0;

// ─────────────────────────────────────────────────────────
//  OpenAI tools → Anthropic tools 转换
// ─────────────────────────────────────────────────────────
function convertToolsToAnthropic(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });
}

// ─────────────────────────────────────────────────────────
//  OpenAI tool_choice → Anthropic tool_choice 转换
// ─────────────────────────────────────────────────────────
function convertToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return undefined; // Anthropic doesn't have "none", just omit tools
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name };
  }
  return { type: "auto" };
}

// ─────────────────────────────────────────────────────────
//  OpenAI messages → Anthropic messages 转换
//  处理 system / user / assistant (含 tool_calls) / tool
// ─────────────────────────────────────────────────────────
function convertMessagesToAnthropic(messages) {
  let system = undefined;
  const out = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Anthropic 的 system 是顶层字段，支持字符串或数组
      if (system === undefined) {
        system =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
      } else {
        system +=
          "\n" +
          (typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content));
      }
      continue;
    }

    if (msg.role === "user") {
      // user message — 直接映射
      const content =
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content.map((part) => {
                if (part.type === "text")
                  return { type: "text", text: part.text };
                if (part.type === "image_url") {
                  const url = part.image_url?.url || "";
                  if (url.startsWith("data:")) {
                    const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
                    if (match) {
                      return {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: match[1],
                          data: match[2],
                        },
                      };
                    }
                  }
                  return { type: "text", text: `[Image: ${url}]` };
                }
                return { type: "text", text: JSON.stringify(part) };
              })
            : [{ type: "text", text: String(msg.content) }];
      out.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = [];

      // 文本部分
      if (msg.content) {
        if (typeof msg.content === "string") {
          content.push({ type: "text", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text")
              content.push({ type: "text", text: part.text });
          }
        }
      }

      // tool_calls 部分 → Anthropic tool_use blocks
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          let args = {};
          if (typeof fn.arguments === "string") {
            try {
              args = JSON.parse(fn.arguments);
            } catch {
              args = { raw: fn.arguments };
            }
          } else if (typeof fn.arguments === "object") {
            args = fn.arguments;
          }
          content.push({
            type: "tool_use",
            id: tc.id || tcid(),
            name: fn.name || "",
            input: args,
          });
        }
      }

      if (content.length > 0) {
        out.push({ role: "assistant", content });
      }
      continue;
    }

    if (msg.role === "tool") {
      // OpenAI tool result → Anthropic tool_result block
      // Anthropic 要求 tool_result 在 user 消息中
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      };

      // 检查上一条消息是否已经是 user role（合并 tool_result 到同一个 user 消息中）
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        // 确保 content 是数组
        if (!Array.isArray(last.content)) {
          last.content = [{ type: "text", text: String(last.content) }];
        }
        last.content.push(toolResultBlock);
      } else {
        out.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    // fallback: 未知 role 当作 user
    out.push({
      role: "user",
      content:
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : [{ type: "text", text: JSON.stringify(msg.content) }],
    });
  }

  // Anthropic 要求消息交替 user/assistant，如果有连续同 role 需要合并
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      // 合并 content
      if (!Array.isArray(last.content)) {
        last.content = [{ type: "text", text: String(last.content) }];
      }
      const toMerge = Array.isArray(m.content)
        ? m.content
        : [{ type: "text", text: String(m.content) }];
      last.content.push(...toMerge);
    } else {
      merged.push({
        role: m.role,
        content: Array.isArray(m.content) ? [...m.content] : m.content,
      });
    }
  }

  return { system, messages: merged };
}

// ─────────────────────────────────────────────────────────
//  Anthropic response → OpenAI response 转换 (非流式)
// ─────────────────────────────────────────────────────────
function convertAnthropicResponseToOpenAI(data, model) {
  const textParts = [];
  const toolCalls = [];

  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || tcid(),
          type: "function",
          function: {
            name: block.name,
            arguments:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input || {}),
          },
        });
      }
    }
  }

  const message = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  // 映射 stop_reason
  let finishReason = "stop";
  if (data.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (data.stop_reason === "end_turn") {
    finishReason = "stop";
  } else if (data.stop_reason === "max_tokens") {
    finishReason = "length";
  } else if (data.stop_reason === "stop_sequence") {
    finishReason = "stop";
  }

  return {
    id: rid(),
    object: "chat.completion",
    created: now(),
    model: model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens:
        (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

// ─────────────────────────────────────────────────────────
//  SSE chunk helpers for OpenAI streaming format
// ─────────────────────────────────────────────────────────
function makeStreamChunk(id, model, delta, finishReason) {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [
      {
        index: 0,
        delta: delta || {},
        finish_reason: finishReason || null,
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────
//  Anthropic SSE stream → OpenAI SSE stream 转换
//  处理文本增量 + tool_use 增量
// ─────────────────────────────────────────────────────────
async function streamAnthropicWithTools(reader, res, model) {
  const dec = new TextDecoder();
  const id = rid();
  let buf = "";
  let sentRole = false;
  let toolCallIndex = -1;
  // 跟踪当前正在构建的工具调用，key = block index from Anthropic
  const toolCallMap = new Map();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 发送 role delta 作为第一个 chunk
  function ensureRole() {
    if (!sentRole) {
      sentRole = true;
      res.write(
        `data: ${makeStreamChunk(id, model, { role: "assistant" }, null)}\n\n`,
      );
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;

      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }

      switch (event.type) {
        case "message_start": {
          ensureRole();
          break;
        }

        case "content_block_start": {
          ensureRole();
          const block = event.content_block;
          if (block && block.type === "tool_use") {
            toolCallIndex++;
            const callId = block.id || tcid();
            toolCallMap.set(event.index, {
              id: callId,
              name: block.name,
              tcIndex: toolCallIndex,
            });
            // 发送 tool_call 开始事件
            const delta = {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: callId,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: "",
                  },
                },
              ],
            };
            res.write(`data: ${makeStreamChunk(id, model, delta, null)}\n\n`);
          }
          break;
        }

        case "content_block_delta": {
          ensureRole();
          const delta = event.delta;
          if (delta) {
            if (delta.type === "text_delta" && delta.text) {
              // 普通文本增量
              res.write(
                `data: ${makeStreamChunk(id, model, { content: delta.text }, null)}\n\n`,
              );
            } else if (
              delta.type === "input_json_delta" &&
              delta.partial_json !== undefined
            ) {
              // 工具调用参数增量
              const info = toolCallMap.get(event.index);
              if (info) {
                const tcDelta = {
                  tool_calls: [
                    {
                      index: info.tcIndex,
                      function: {
                        arguments: delta.partial_json,
                      },
                    },
                  ],
                };
                res.write(
                  `data: ${makeStreamChunk(id, model, tcDelta, null)}\n\n`,
                );
              }
            }
          }
          break;
        }

        case "content_block_stop": {
          // 不需要特别处理
          break;
        }

        case "message_delta": {
          // 消息级别的 delta，包含 stop_reason
          let finishReason = "stop";
          if (event.delta?.stop_reason === "tool_use") {
            finishReason = "tool_calls";
          } else if (event.delta?.stop_reason === "max_tokens") {
            finishReason = "length";
          }
          res.write(
            `data: ${makeStreamChunk(id, model, {}, finishReason)}\n\n`,
          );
          break;
        }

        case "message_stop": {
          // 流结束
          break;
        }

        case "ping": {
          // 忽略 ping
          break;
        }

        case "error": {
          // 转发错误
          const errMsg = event.error?.message || "Unknown Anthropic error";
          res.write(
            `data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`,
          );
          break;
        }

        default:
          break;
      }
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

// ─────────────────────────────────────────────────────────
//  原有的简单流处理函数 (pipe / streamGemini)
// ─────────────────────────────────────────────────────────
const oaiChunk = (id, model, content, finish) =>
  JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [
      {
        index: 0,
        delta: finish ? {} : { content },
        finish_reason: finish || null,
      },
    ],
  });

async function pipe(reader, res) {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function streamGemini(reader, res, model) {
  const dec = new TextDecoder(),
    id = rid();
  let buf = "";
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith("data: ")) continue;
      try {
        const e = JSON.parse(l.slice(6));
        const t = e.candidates?.[0]?.content?.parts?.[0]?.text;
        if (t) res.write(`data: ${oaiChunk(id, model, t)}\n\n`);
        if (e.candidates?.[0]?.finishReason)
          res.write(`data: ${oaiChunk(id, model, "", "stop")}\n\n`);
      } catch {}
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─────────────────────────────────────────────────────────
//  HTTP Server
// ─────────────────────────────────────────────────────────
createServer(async (req, res) => {
  const reqId = ++reqCounter;
  const startTime = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  log(reqId, `→ ${req.method} ${req.url}`);

  // ─── Health check（无需认证） ───
  if (req.url === "/" || req.url === "/health") {
    log(reqId, `← 200 health check (${Date.now() - startTime}ms)`);
    return J(res, 200, {
      status: "ok",
      message: "Replit AI Proxy is running",
      endpoints: ["/v1/models", "/v1/chat/completions", "/v1/messages"],
    });
  }

  // 支持 Bearer token 和 x-api-key 两种认证方式（兼容 Claude Code）
  const authKey =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.headers["x-api-key"];
  if (authKey !== KEY) {
    log(
      reqId,
      `← 401 Unauthorized (auth method: ${req.headers["x-api-key"] ? "x-api-key" : req.headers.authorization ? "bearer" : "none"})`,
    );
    return J(res, 401, {
      error: { message: "Unauthorized", type: "auth_error" },
    });
  }

  // ─── /v1/models ───
  if (req.url === "/v1/models") {
    log(reqId, `← 200 models list (${Date.now() - startTime}ms)`);
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
      data: models.map((m) => ({
        ...m,
        object: "model",
        created: 1700000000,
      })),
    });
  }

  // ─── /v1/chat/completions ───
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    const raw = await readBody(req);
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      log(reqId, `← 400 Invalid JSON body`);
      return J(res, 400, { error: { message: "Invalid JSON body" } });
    }
    const prov = route(p.model);
    const { url, key } = creds(prov);

    log(
      reqId,
      `  model=${p.model} provider=${prov} stream=${!!p.stream} messages=${(p.messages || []).length} tools=${(p.tools || []).length}`,
    );

    if (!url || !key) {
      log(reqId, `← 500 Missing credentials for ${prov}`);
      return J(res, 500, {
        error: {
          message: `Missing AI Integrations credentials for provider: ${prov}. Ensure AI_INTEGRATIONS_${prov.toUpperCase()}_BASE_URL and AI_INTEGRATIONS_${prov.toUpperCase()}_API_KEY are set.`,
        },
      });
    }

    try {
      // ═══════════════════════════════════════════════════
      //  OpenAI / OpenRouter — 直接转发
      // ═══════════════════════════════════════════════════
      if (prov === "openai" || prov === "openrouter") {
        log(reqId, `  → upstream ${prov} ${url}/chat/completions`);
        const up = await fetch(`${url}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: raw,
        });
        log(reqId, `  ← upstream ${up.status}`);
        if (p.stream) {
          log(
            reqId,
            `  streaming response to client (${Date.now() - startTime}ms)`,
          );
          res.writeHead(up.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          return pipe(up.body.getReader(), res);
        }
        const respData = await up.json();
        log(reqId, `← ${up.status} (${Date.now() - startTime}ms)`);
        return J(res, up.status, respData);
      }

      // ═══════════════════════════════════════════════════
      //  Anthropic — 完整 OpenAI ↔ Claude 协议转换
      // ═══════════════════════════════════════════════════
      if (prov === "anthropic") {
        // 映射模型名
        const mappedModel = mapAnthropicModel(p.model);
        if (mappedModel !== p.model) {
          log(reqId, `  model mapping: ${p.model} → ${mappedModel}`);
        }

        // 转换 messages
        const { system, messages } = convertMessagesToAnthropic(
          p.messages || [],
        );

        // 构建 Anthropic 请求体
        const anthropicBody = {
          model: mappedModel,
          max_tokens: p.max_tokens || 8192,
          messages,
        };

        // system
        if (system) {
          anthropicBody.system = system;
        }

        // tools
        const anthropicTools = convertToolsToAnthropic(p.tools);
        if (anthropicTools && anthropicTools.length > 0) {
          anthropicBody.tools = anthropicTools;
        }

        // tool_choice
        if (p.tool_choice !== undefined && anthropicTools) {
          const tc = convertToolChoiceToAnthropic(p.tool_choice);
          if (tc) {
            anthropicBody.tool_choice = tc;
          }
        }

        // stream
        if (p.stream) {
          anthropicBody.stream = true;
        }

        // temperature
        if (p.temperature !== undefined) {
          anthropicBody.temperature = p.temperature;
        }

        // top_p
        if (p.top_p !== undefined) {
          anthropicBody.top_p = p.top_p;
        }

        // stop sequences
        if (p.stop) {
          anthropicBody.stop_sequences = Array.isArray(p.stop)
            ? p.stop
            : [p.stop];
        }

        log(
          reqId,
          `  → upstream anthropic ${url}/messages (model=${mappedModel})`,
        );
        const up = await fetch(`${url}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(anthropicBody),
        });

        log(reqId, `  ← upstream ${up.status}`);
        if (!up.ok) {
          const errBody = await up.json().catch(() => ({
            error: { message: up.statusText },
          }));
          logErr(
            reqId,
            `← ${up.status} upstream error:`,
            JSON.stringify(errBody),
          );
          return J(res, up.status, errBody);
        }

        // 流式
        if (p.stream) {
          log(
            reqId,
            `  streaming response to client (${Date.now() - startTime}ms)`,
          );
          return streamAnthropicWithTools(up.body.getReader(), res, p.model);
        }

        // 非流式 — 完整转换 (包含 tool_use 支持)
        const data = await up.json();
        log(
          reqId,
          `← 200 finish_reason=${data.stop_reason} usage=[${data.usage?.input_tokens}/${data.usage?.output_tokens}] (${Date.now() - startTime}ms)`,
        );
        return J(res, 200, convertAnthropicResponseToOpenAI(data, p.model));
      }

      // ═══════════════════════════════════════════════════
      //  Gemini — OpenAI 格式 ↔ Google generateContent API
      // ═══════════════════════════════════════════════════
      if (prov === "gemini") {
        log(reqId, `  → upstream gemini ${url}/models/${p.model}`);
        const sys = p.messages.find((m) => m.role === "system")?.content;
        const contents = p.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [
              {
                text:
                  typeof m.content === "string"
                    ? m.content
                    : JSON.stringify(m.content),
              },
            ],
          }));
        const action = p.stream
          ? "streamGenerateContent?alt=sse"
          : "generateContent";
        const up = await fetch(`${url}/models/${p.model}:${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            contents,
            ...(sys && {
              systemInstruction: { parts: [{ text: sys }] },
            }),
            generationConfig: {
              maxOutputTokens: p.max_tokens || 8192,
            },
          }),
        });
        log(reqId, `  ← upstream ${up.status}`);
        if (!up.ok) {
          const errResp = await up
            .json()
            .catch(() => ({ error: up.statusText }));
          logErr(
            reqId,
            `← ${up.status} upstream error:`,
            JSON.stringify(errResp),
          );
          return J(res, up.status, errResp);
        }
        if (p.stream) {
          log(
            reqId,
            `  streaming response to client (${Date.now() - startTime}ms)`,
          );
          return streamGemini(up.body.getReader(), res, p.model);
        }
        const d = await up.json();
        log(reqId, `← 200 gemini (${Date.now() - startTime}ms)`);
        return J(res, 200, {
          id: rid(),
          object: "chat.completion",
          created: now(),
          model: p.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: d.candidates?.[0]?.content?.parts?.[0]?.text || "",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: d.usageMetadata?.promptTokenCount || 0,
            completion_tokens: d.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: d.usageMetadata?.totalTokenCount || 0,
          },
        });
      }
    } catch (e) {
      logErr(reqId, `← 502 proxy error: ${e.message}`);
      return J(res, 502, {
        error: { message: e.message, type: "proxy_error" },
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  /v1/messages — Anthropic 原生 API 透传
  //  Claude Code 等原生 Anthropic 客户端直接使用此端点
  // ═══════════════════════════════════════════════════════
  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`,
  );
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith("/v1/messages") && req.method === "POST") {
    const raw = await readBody(req);
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      log(reqId, `← 400 Invalid JSON body`);
      return J(res, 400, {
        error: { message: "Invalid JSON body", type: "invalid_request_error" },
      });
    }

    // 映射模型名
    const originalModel = p.model;
    const mappedModel = mapAnthropicModel(p.model);
    if (mappedModel !== originalModel) {
      log(reqId, `  model mapping: ${originalModel} → ${mappedModel}`);
      p.model = mappedModel;
    }

    // 清理 cache_control 中上游不支持的字段
    stripCacheControl(p);

    log(
      reqId,
      `  [/v1/messages] model=${originalModel}→${mappedModel} stream=${!!p.stream} messages=${(p.messages || []).length}`,
    );

    const { url, key } = creds("anthropic");
    if (!url || !key) {
      log(reqId, `← 500 Missing anthropic credentials`);
      return J(res, 500, {
        error: {
          message:
            "Missing AI Integrations credentials for provider: anthropic. Ensure AI_INTEGRATIONS_ANTHROPIC_BASE_URL and AI_INTEGRATIONS_ANTHROPIC_API_KEY are set.",
          type: "api_error",
        },
      });
    }

    try {
      // 收集客户端传入的 anthropic-* 头，原样透传
      const fwdHeaders = {
        "Content-Type": "application/json",
        "x-api-key": key,
      };
      for (const [h, v] of Object.entries(req.headers)) {
        if (h.startsWith("anthropic-")) {
          fwdHeaders[h] = v;
        }
      }
      // 确保至少有 anthropic-version
      if (!fwdHeaders["anthropic-version"]) {
        fwdHeaders["anthropic-version"] = "2023-06-01";
      }

      // 计算上游路径：/v1/messages/xxx → /messages/xxx
      const upstreamPath = pathname.replace(/^\/v1/, "");
      const upstreamQs = parsedUrl.search || "";
      const upstreamUrl = `${url}${upstreamPath}${upstreamQs}`;

      log(
        reqId,
        `  → upstream anthropic ${upstreamUrl} (model=${mappedModel})`,
      );
      // 用修改后的 body（模型名已映射）
      const upBody = JSON.stringify(p);
      const up = await fetch(upstreamUrl, {
        method: "POST",
        headers: fwdHeaders,
        body: upBody,
      });

      log(reqId, `  ← upstream ${up.status}`);

      if (p.stream) {
        // 流式：原样透传 SSE
        log(
          reqId,
          `  streaming response to client (${Date.now() - startTime}ms)`,
        );
        res.writeHead(up.status, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        return pipe(up.body.getReader(), res);
      }

      // 非流式：原样透传 JSON
      const data = await up.text();
      if (up.ok) {
        try {
          const parsed = JSON.parse(data);
          log(
            reqId,
            `← ${up.status} stop_reason=${parsed.stop_reason} usage=[${parsed.usage?.input_tokens}/${parsed.usage?.output_tokens}] (${Date.now() - startTime}ms)`,
          );
        } catch {
          log(reqId, `← ${up.status} (${Date.now() - startTime}ms)`);
        }
      } else {
        logErr(reqId, `← ${up.status} upstream error: ${data.slice(0, 500)}`);
      }
      res.writeHead(up.status, { "Content-Type": "application/json" });
      return res.end(data);
    } catch (e) {
      logErr(reqId, `← 502 proxy error: ${e.message}`);
      return J(res, 502, {
        error: { message: e.message, type: "proxy_error" },
      });
    }
  }

  log(reqId, `← 404 Not found`);
  J(res, 404, { error: { message: "Not found" } });
}).listen(PORT, () => {
  const domain = process.env.REPLIT_DEV_DOMAIN || `localhost:${PORT}`;
  const base = `https://${domain}/v1`;
  console.log(`\n========================================`);
  console.log(`  Replit AI Proxy 已启动`);
  console.log(`  支持 OpenAI <-> Claude Tool Calling 双向协议转换`);
  console.log(`========================================`);
  console.log(`  Base URL : ${base}`);
  console.log(`  API Key  : ${KEY}`);
  console.log(`========================================`);
  console.log(`  用法示例 (curl):`);
  console.log(`  curl ${base}/chat/completions \\`);
  console.log(`    -H "Authorization: Bearer ${KEY}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(
    `    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'`,
  );
  console.log(`========================================`);
  console.log(`  Anthropic 原生 API 透传 (Claude Code 等):`);
  console.log(
    `  模型名: 原样透传给上游 API (claude-opus-4-6, claude-sonnet-4-6 等)`,
  );
  console.log(`  ANTHROPIC_BASE_URL=${base.replace("/v1", "")} \\`);
  console.log(`  ANTHROPIC_API_KEY=${KEY} \\`);
  console.log(`  claude`);
  console.log(`========================================`);
  console.log(`  Tool Calling 示例:`);
  console.log(`  curl ${base}/chat/completions \\`);
  console.log(`    -H "Authorization: Bearer ${KEY}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(
    `    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"What is the weather in Tokyo?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}}]}'`,
  );
  console.log(`========================================\n`);
});
