# AIGOD-CCR - AI API Gateway Proxy
Node.js 18+ / ES Modules / Zero Dependencies

<directory>
doc/ - 原始需求文档
</directory>

<config>
index.mjs - 主服务：HTTP 路由 + 多 Provider 协议转换 + 限流 + 流式处理
test-conversion.mjs - 离线测试：协议转换函数的单元测试（复制核心函数，独立运行）
package.json - 包配置，无外部依赖，仅 node:http / node:crypto / node:fs
.replit - Replit 部署配置（Node.js 20, autoscale, port 3000）
replit.nix - Nix 环境（nodejs-20_x）
</config>

## 架构

单文件服务（index.mjs），三个 API 端点共享统一的认证、限流、Provider 路由基础设施：

```
/v1/chat/completions  ← OpenAI Chat Completions API 兼容
/v1/responses         ← OpenAI Responses API 兼容（Codex CLI）
/v1/messages          ← Anthropic Messages API 原生透传（Claude Code）
```

Provider 路由规则：`claude-*` → anthropic, `gemini-*` → gemini, 含 `/` → openrouter, 其他 → openai

核心转换链：
- Chat Completions → Anthropic: `convertMessagesToAnthropic()` + `convertToolsToAnthropic()`
- Responses API → Anthropic: `convertResponsesInputToMessages()` → 复用 Chat Completions 转换链
- Anthropic → Chat Completions: `convertAnthropicResponseToOpenAI()` / `streamAnthropicWithTools()`
- Anthropic → Responses API: `convertAnthropicResponseToResponses()` / `streamAnthropicToResponses()`

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
