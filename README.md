# Replit AI Proxy — OpenAI Compatible API Gateway

零依赖 Node.js 18+ AI 代理服务，对外完全兼容 OpenAI Chat Completions API，内部自动路由到 Anthropic Claude / OpenAI / Google Gemini / OpenRouter，并在 Claude 场景下实现完整的 tool calling 双向协议转换。

## 特性

- **OpenAI API 兼容**：客户端使用标准 OpenAI SDK 即可调用所有支持的模型
- **多模型路由**：自动根据模型名称路由到对应后端（Anthropic / OpenAI / Gemini / OpenRouter）
- **Claude Tool Calling 双向转换**：完整实现 OpenAI `tools/tool_calls` ↔ Anthropic `tool_use/tool_result` 协议映射
- **流式支持**：非流式和流式（SSE）均支持，包括流式 tool calling 增量事件
- **零依赖**：仅使用 Node.js 内置模块，无需 npm install

## 支持的模型

| Provider | 模型 |
|----------|------|
| Anthropic | claude-opus-4-6, claude-opus-4-5, claude-opus-4-1, claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5 |
| OpenAI | gpt-5.2, gpt-5.1, gpt-5, gpt-5-mini, gpt-5-nano, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o4-mini, o3, o3-mini |
| Gemini | gemini-3.1-pro-preview, gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash |
| OpenRouter | 任何包含 `/` 的模型标识 |

## 部署到 Replit

### 步骤

1. 在 Replit 新建 **Node.js** 项目
2. 开启 **AI Integrations**（Settings → AI Integrations），确保 Anthropic / OpenAI / Gemini 的凭据已配置
3. 将 `index.mjs` 粘贴到项目根目录
4. 将 `.replit` 和 `replit.nix` 也复制到项目中
5. 点击 **Run**，控制台会输出 Base URL 和 API Key
6. 点击 **Publish / Deploy** 发布服务

### 环境变量（由 AI Integrations 自动注入）

| 变量 | 说明 |
|------|------|
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | Anthropic API 地址 |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Anthropic API Key |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | OpenAI API 地址 |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI API Key |
| `AI_INTEGRATIONS_GEMINI_BASE_URL` | Gemini API 地址 |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | Gemini API Key |
| `AI_INTEGRATIONS_OPENROUTER_BASE_URL` | OpenRouter API 地址 |
| `AI_INTEGRATIONS_OPENROUTER_API_KEY` | OpenRouter API Key |

## API 端点

### `GET /v1/models`

列出所有可用模型。

### `POST /v1/chat/completions`

标准 OpenAI Chat Completions 接口，支持：

- `model` — 模型名称
- `messages` — 消息数组
- `stream` — 是否流式返回
- `tools` — 工具定义（OpenAI function calling 格式）
- `tool_choice` — 工具选择策略（`auto` / `none` / `required` / 指定工具）
- `temperature` / `top_p` / `max_tokens` / `stop` — 生成参数

### `GET /` 或 `GET /health`

健康检查。

## Claude Tool Calling 协议转换说明

### 请求方向：OpenAI → Anthropic

| OpenAI 格式 | Anthropic 格式 |
|-------------|---------------|
| `tools[].function.name/description/parameters` | `tools[].name/description/input_schema` |
| `tool_choice: "auto"` | `tool_choice: { type: "auto" }` |
| `tool_choice: "required"` | `tool_choice: { type: "any" }` |
| `tool_choice: { function: { name } }` | `tool_choice: { type: "tool", name }` |
| `messages[role=system]` | 顶层 `system` 字段 |
| `messages[role=assistant].tool_calls` | `content: [{ type: "tool_use", id, name, input }]` |
| `messages[role=tool]` | `content: [{ type: "tool_result", tool_use_id, content }]`（挂在 `user` 角色下） |

### 响应方向：Anthropic → OpenAI

| Anthropic 格式 | OpenAI 格式 |
|---------------|-------------|
| `content[type=text]` | `message.content` |
| `content[type=tool_use]` | `message.tool_calls[].{id, type:"function", function:{name, arguments}}` |
| `stop_reason: "tool_use"` | `finish_reason: "tool_calls"` |
| `stop_reason: "end_turn"` | `finish_reason: "stop"` |
| `stop_reason: "max_tokens"` | `finish_reason: "length"` |

### 流式 Tool Calling 事件映射

| Anthropic SSE 事件 | OpenAI SSE 转换 |
|-------------------|----------------|
| `content_block_start` (type=tool_use) | `delta.tool_calls[{index, id, type:"function", function:{name, arguments:""}}]` |
| `content_block_delta` (input_json_delta) | `delta.tool_calls[{index, function:{arguments: partial_json}}]` |
| `content_block_delta` (text_delta) | `delta.content` |
| `message_delta` (stop_reason=tool_use) | `finish_reason: "tool_calls"` |
| `message_stop` | `data: [DONE]` |

## 使用示例

### 基础对话

```bash
curl https://YOUR-REPLIT-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR-API-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Tool Calling（非流式）

```bash
curl https://YOUR-REPLIT-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR-API-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string", "description": "City name"}
          },
          "required": ["location"]
        }
      }
    }]
  }'
```

### Tool Calling 多轮对话

```bash
# 第一轮：模型返回 tool_calls
# 第二轮：回传 tool result 继续对话
curl https://YOUR-REPLIT-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR-API-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"},
      {"role": "assistant", "content": null, "tool_calls": [
        {"id": "call_abc123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"location\":\"Tokyo\"}"}}
      ]},
      {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"temperature\": 22, \"condition\": \"sunny\"}"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          },
          "required": ["location"]
        }
      }
    }]
  }'
```

### 流式 Tool Calling

```bash
curl https://YOUR-REPLIT-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR-API-KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "stream": true,
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          },
          "required": ["location"]
        }
      }
    }]
  }'
```

### 使用 @ai-sdk/openai-compatible

```javascript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const provider = createOpenAICompatible({
  name: 'replit-proxy',
  baseURL: 'https://YOUR-REPLIT-DOMAIN/v1',
  headers: {
    Authorization: 'Bearer YOUR-API-KEY',
  },
});

const result = await generateText({
  model: provider.chatModel('claude-sonnet-4-6'),
  prompt: 'What is the weather in Tokyo?',
  tools: {
    get_weather: {
      description: 'Get the current weather for a location',
      parameters: z.object({
        location: z.string().describe('City name'),
      }),
      execute: async ({ location }) => {
        return { temperature: 22, condition: 'sunny' };
      },
    },
  },
});
```

## 项目结构

```
rep-ccgod/
├── index.mjs       # 主服务文件（全部逻辑）
├── package.json     # Node.js 包配置
├── .replit          # Replit 运行配置
├── replit.nix       # Nix 环境配置
├── aigod-cc.md      # 原始需求文档
└── README.md        # 本文件
```

## 认证

- API Key 首次运行时自动生成，持久化到 `.proxy-key` 文件
- 所有请求需在 `Authorization` header 中携带 `Bearer <API-KEY>`

## License

MIT