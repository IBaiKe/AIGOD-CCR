// test-conversion.mjs
// 离线测试 OpenAI ↔ Anthropic tool calling 协议转换逻辑
// 运行: node test-conversion.mjs

import { randomBytes } from "node:crypto";

// ─── 复制核心转换函数 (与 index.mjs 保持一致) ───

const tcid = () => "call_" + randomBytes(8).toString("hex");

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

function convertToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return undefined;
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name };
  }
  return { type: "auto" };
}

function convertMessagesToAnthropic(messages) {
  let system = undefined;
  const out = [];

  for (const msg of messages) {
    if (msg.role === "system") {
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
      const content =
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content.map((part) => {
                if (part.type === "text")
                  return { type: "text", text: part.text };
                return { type: "text", text: JSON.stringify(part) };
              })
            : [{ type: "text", text: String(msg.content) }];
      out.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = [];
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
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      };
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        if (!Array.isArray(last.content)) {
          last.content = [{ type: "text", text: String(last.content) }];
        }
        last.content.push(toolResultBlock);
      } else {
        out.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    out.push({
      role: "user",
      content:
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : [{ type: "text", text: JSON.stringify(msg.content) }],
    });
  }

  // 合并连续同 role
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
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

  let finishReason = "stop";
  if (data.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (data.stop_reason === "end_turn") {
    finishReason = "stop";
  } else if (data.stop_reason === "max_tokens") {
    finishReason = "length";
  }

  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens:
        (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

// ─── 测试框架 ───

let passed = 0;
let failed = 0;

function assert(condition, testName, detail) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    if (detail)
      console.log(
        `     Detail: ${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`,
      );
    failed++;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ═══════════════════════════════════════════════════════════
//  TEST 1: OpenAI tools → Anthropic tools
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 1: convertToolsToAnthropic");
{
  const openaiTools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a location",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
          },
          required: ["location"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    },
  ];

  const result = convertToolsToAnthropic(openaiTools);

  assert(result.length === 2, "Should produce 2 tools");
  assert(result[0].name === "get_weather", "First tool name = get_weather");
  assert(
    result[0].description === "Get the current weather for a location",
    "First tool description preserved",
  );
  assert(
    result[0].input_schema.type === "object",
    "First tool input_schema.type = object",
  );
  assert(
    result[0].input_schema.properties.location.type === "string",
    "First tool has location property",
  );
  assert(result[1].name === "search", "Second tool name = search");
  assert(
    convertToolsToAnthropic(null) === undefined,
    "null tools returns undefined",
  );
  assert(
    convertToolsToAnthropic([]) !== undefined,
    "Empty array returns array",
  );
}

// ═══════════════════════════════════════════════════════════
//  TEST 2: OpenAI tool_choice → Anthropic tool_choice
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 2: convertToolChoiceToAnthropic");
{
  assert(
    deepEqual(convertToolChoiceToAnthropic("auto"), { type: "auto" }),
    'auto → { type: "auto" }',
  );
  assert(
    convertToolChoiceToAnthropic("none") === undefined,
    "none → undefined",
  );
  assert(
    deepEqual(convertToolChoiceToAnthropic("required"), { type: "any" }),
    'required → { type: "any" }',
  );
  assert(
    deepEqual(
      convertToolChoiceToAnthropic({
        type: "function",
        function: { name: "get_weather" },
      }),
      { type: "tool", name: "get_weather" },
    ),
    'specific function → { type: "tool", name }',
  );
  assert(convertToolChoiceToAnthropic(null) === undefined, "null → undefined");
}

// ═══════════════════════════════════════════════════════════
//  TEST 3: Basic messages conversion (system + user + assistant)
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 3: convertMessagesToAnthropic - basic messages");
{
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
    { role: "user", content: "How are you?" },
  ];

  const result = convertMessagesToAnthropic(messages);

  assert(
    result.system === "You are a helpful assistant.",
    "System message extracted",
  );
  assert(result.messages.length === 3, "3 non-system messages");
  assert(result.messages[0].role === "user", "First message is user");
  assert(
    result.messages[0].content[0].text === "Hello",
    "User content preserved",
  );
  assert(
    result.messages[1].role === "assistant",
    "Second message is assistant",
  );
  assert(
    result.messages[1].content[0].text === "Hi there!",
    "Assistant content preserved",
  );
  assert(result.messages[2].role === "user", "Third message is user");
}

// ═══════════════════════════════════════════════════════════
//  TEST 4: Messages with tool_calls (assistant) and tool result
// ═══════════════════════════════════════════════════════════
console.log(
  "\n🔧 Test 4: convertMessagesToAnthropic - tool calling round trip",
);
{
  const messages = [
    { role: "user", content: "What is the weather in Tokyo?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"location":"Tokyo"}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_abc123",
      content: '{"temperature": 22, "condition": "sunny"}',
    },
  ];

  const result = convertMessagesToAnthropic(messages);

  assert(
    result.messages.length === 3,
    "Should have 3 messages (user, assistant, user-with-tool-result)",
  );

  // Check assistant message has tool_use
  const assistantMsg = result.messages[1];
  assert(assistantMsg.role === "assistant", "Second message is assistant");
  assert(assistantMsg.content.length === 1, "Assistant has 1 content block");
  assert(
    assistantMsg.content[0].type === "tool_use",
    "Content block type is tool_use",
  );
  assert(assistantMsg.content[0].id === "call_abc123", "tool_use id preserved");
  assert(
    assistantMsg.content[0].name === "get_weather",
    "tool_use name = get_weather",
  );
  assert(
    deepEqual(assistantMsg.content[0].input, { location: "Tokyo" }),
    "tool_use input parsed from JSON string",
  );

  // Check tool result message
  const toolResultMsg = result.messages[2];
  assert(toolResultMsg.role === "user", "Tool result wrapped in user message");
  assert(
    toolResultMsg.content[0].type === "tool_result",
    "Content block type is tool_result",
  );
  assert(
    toolResultMsg.content[0].tool_use_id === "call_abc123",
    "tool_use_id preserved",
  );
  assert(
    toolResultMsg.content[0].content ===
      '{"temperature": 22, "condition": "sunny"}',
    "Tool result content preserved",
  );
}

// ═══════════════════════════════════════════════════════════
//  TEST 5: Multiple tool calls in single assistant message
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 5: convertMessagesToAnthropic - multiple tool calls");
{
  const messages = [
    { role: "user", content: "Compare weather in Tokyo and London" },
    {
      role: "assistant",
      content: "Let me check both cities.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
        },
        {
          id: "call_2",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"London"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
    { role: "tool", tool_call_id: "call_2", content: '{"temp":15}' },
  ];

  const result = convertMessagesToAnthropic(messages);

  // Assistant should have text + 2 tool_use blocks
  const assistantMsg = result.messages[1];
  assert(
    assistantMsg.content.length === 3,
    "Assistant has 3 content blocks (1 text + 2 tool_use)",
  );
  assert(assistantMsg.content[0].type === "text", "First block is text");
  assert(
    assistantMsg.content[0].text === "Let me check both cities.",
    "Text content preserved",
  );
  assert(
    assistantMsg.content[1].type === "tool_use",
    "Second block is tool_use",
  );
  assert(assistantMsg.content[1].id === "call_1", "First tool_use id");
  assert(
    assistantMsg.content[2].type === "tool_use",
    "Third block is tool_use",
  );
  assert(assistantMsg.content[2].id === "call_2", "Second tool_use id");

  // Both tool results should be merged into one user message
  const toolMsg = result.messages[2];
  assert(toolMsg.role === "user", "Tool results in user message");
  assert(toolMsg.content.length === 2, "Two tool_result blocks merged");
  assert(toolMsg.content[0].tool_use_id === "call_1", "First tool_result id");
  assert(toolMsg.content[1].tool_use_id === "call_2", "Second tool_result id");
}

// ═══════════════════════════════════════════════════════════
//  TEST 6: Anthropic response → OpenAI (text only)
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 6: convertAnthropicResponseToOpenAI - text only");
{
  const anthropicResponse = {
    id: "msg_123",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello! How can I help?" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 8 },
  };

  const result = convertAnthropicResponseToOpenAI(
    anthropicResponse,
    "claude-sonnet-4-6",
  );

  assert(result.object === "chat.completion", "object = chat.completion");
  assert(result.model === "claude-sonnet-4-6", "model preserved");
  assert(result.choices[0].message.role === "assistant", "role = assistant");
  assert(
    result.choices[0].message.content === "Hello! How can I help?",
    "Content preserved",
  );
  assert(result.choices[0].message.tool_calls === undefined, "No tool_calls");
  assert(result.choices[0].finish_reason === "stop", "finish_reason = stop");
  assert(result.usage.prompt_tokens === 10, "prompt_tokens");
  assert(result.usage.completion_tokens === 8, "completion_tokens");
  assert(result.usage.total_tokens === 18, "total_tokens");
}

// ═══════════════════════════════════════════════════════════
//  TEST 7: Anthropic response → OpenAI (tool_use)
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 7: convertAnthropicResponseToOpenAI - tool_use");
{
  const anthropicResponse = {
    id: "msg_456",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the weather." },
      {
        type: "tool_use",
        id: "toolu_abc123",
        name: "get_weather",
        input: { location: "Tokyo" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 50, output_tokens: 30 },
  };

  const result = convertAnthropicResponseToOpenAI(
    anthropicResponse,
    "claude-sonnet-4-6",
  );

  assert(
    result.choices[0].message.content === "Let me check the weather.",
    "Text content preserved",
  );
  assert(
    result.choices[0].message.tool_calls !== undefined,
    "tool_calls present",
  );
  assert(result.choices[0].message.tool_calls.length === 1, "1 tool call");

  const tc = result.choices[0].message.tool_calls[0];
  assert(tc.id === "toolu_abc123", "tool call id preserved");
  assert(tc.type === "function", 'type = "function"');
  assert(tc.function.name === "get_weather", "function name");
  assert(
    tc.function.arguments === '{"location":"Tokyo"}',
    "function arguments as JSON string",
  );
  assert(
    result.choices[0].finish_reason === "tool_calls",
    "finish_reason = tool_calls",
  );
}

// ═══════════════════════════════════════════════════════════
//  TEST 8: Anthropic response → OpenAI (multiple tool_use)
// ═══════════════════════════════════════════════════════════
console.log(
  "\n🔧 Test 8: convertAnthropicResponseToOpenAI - multiple tool_use",
);
{
  const anthropicResponse = {
    id: "msg_789",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "get_weather",
        input: { location: "Tokyo" },
      },
      {
        type: "tool_use",
        id: "toolu_2",
        name: "get_weather",
        input: { location: "London" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 60, output_tokens: 40 },
  };

  const result = convertAnthropicResponseToOpenAI(
    anthropicResponse,
    "claude-sonnet-4-6",
  );

  assert(result.choices[0].message.content === null, "No text content → null");
  assert(result.choices[0].message.tool_calls.length === 2, "2 tool calls");
  assert(
    result.choices[0].message.tool_calls[0].id === "toolu_1",
    "First tool call id",
  );
  assert(
    result.choices[0].message.tool_calls[1].id === "toolu_2",
    "Second tool call id",
  );
  assert(
    result.choices[0].finish_reason === "tool_calls",
    "finish_reason = tool_calls",
  );
}

// ═══════════════════════════════════════════════════════════
//  TEST 9: Message alternation (consecutive same-role merging)
// ═══════════════════════════════════════════════════════════
console.log(
  "\n🔧 Test 9: convertMessagesToAnthropic - role alternation enforcement",
);
{
  const messages = [
    { role: "user", content: "Hello" },
    { role: "user", content: "Are you there?" },
    { role: "assistant", content: "Yes!" },
  ];

  const result = convertMessagesToAnthropic(messages);

  assert(
    result.messages.length === 2,
    "Consecutive user messages merged into 1",
  );
  assert(result.messages[0].role === "user", "First is user");
  assert(
    result.messages[0].content.length === 2,
    "Merged user has 2 content blocks",
  );
  assert(
    result.messages[0].content[0].text === "Hello",
    "First text preserved",
  );
  assert(
    result.messages[0].content[1].text === "Are you there?",
    "Second text preserved",
  );
  assert(result.messages[1].role === "assistant", "Second is assistant");
}

// ═══════════════════════════════════════════════════════════
//  TEST 10: Multiple system messages
// ═══════════════════════════════════════════════════════════
console.log(
  "\n🔧 Test 10: convertMessagesToAnthropic - multiple system messages",
);
{
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hi" },
  ];

  const result = convertMessagesToAnthropic(messages);

  assert(
    result.system === "You are helpful.\nBe concise.",
    "System messages concatenated",
  );
  assert(result.messages.length === 1, "1 non-system message");
}

// ═══════════════════════════════════════════════════════════
//  TEST 11: Anthropic max_tokens stop_reason
// ═══════════════════════════════════════════════════════════
console.log(
  "\n🔧 Test 11: convertAnthropicResponseToOpenAI - max_tokens → length",
);
{
  const anthropicResponse = {
    content: [{ type: "text", text: "Truncated..." }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 10, output_tokens: 100 },
  };

  const result = convertAnthropicResponseToOpenAI(
    anthropicResponse,
    "claude-sonnet-4-6",
  );
  assert(result.choices[0].finish_reason === "length", "max_tokens → length");
}

// ═══════════════════════════════════════════════════════════
//  TEST 12: Full round-trip scenario
// ═══════════════════════════════════════════════════════════
console.log("\n🔧 Test 12: Full round-trip scenario simulation");
{
  // Step 1: User sends OpenAI-format request with tools
  const openaiRequest = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "You are a weather assistant." },
      { role: "user", content: "What's the weather in Paris?" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "auto",
  };

  // Convert to Anthropic format
  const { system, messages } = convertMessagesToAnthropic(
    openaiRequest.messages,
  );
  const anthropicTools = convertToolsToAnthropic(openaiRequest.tools);
  const anthropicToolChoice = convertToolChoiceToAnthropic(
    openaiRequest.tool_choice,
  );

  assert(
    system === "You are a weather assistant.",
    "Round-trip: system extracted",
  );
  assert(messages.length === 1, "Round-trip: 1 user message");
  assert(
    anthropicTools[0].name === "get_weather",
    "Round-trip: tool converted",
  );
  assert(
    anthropicTools[0].input_schema.properties.city.type === "string",
    "Round-trip: tool schema preserved",
  );
  assert(
    anthropicToolChoice.type === "auto",
    "Round-trip: tool_choice converted",
  );

  // Step 2: Claude responds with tool_use
  const claudeResponse = {
    content: [
      { type: "text", text: "I'll look up the weather in Paris for you." },
      {
        type: "tool_use",
        id: "toolu_paris",
        name: "get_weather",
        input: { city: "Paris" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
  };

  // Convert back to OpenAI format
  const openaiResponse = convertAnthropicResponseToOpenAI(
    claudeResponse,
    "claude-sonnet-4-6",
  );

  assert(
    openaiResponse.choices[0].message.content ===
      "I'll look up the weather in Paris for you.",
    "Round-trip: text preserved",
  );
  assert(
    openaiResponse.choices[0].message.tool_calls[0].function.name ===
      "get_weather",
    "Round-trip: tool call name",
  );
  assert(
    openaiResponse.choices[0].message.tool_calls[0].function.arguments ===
      '{"city":"Paris"}',
    "Round-trip: tool call args",
  );
  assert(
    openaiResponse.choices[0].finish_reason === "tool_calls",
    "Round-trip: finish_reason",
  );

  // Step 3: Client sends tool result back in OpenAI format
  const followUpMessages = [
    { role: "system", content: "You are a weather assistant." },
    { role: "user", content: "What's the weather in Paris?" },
    {
      role: "assistant",
      content: "I'll look up the weather in Paris for you.",
      tool_calls: [
        {
          id: "toolu_paris",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "toolu_paris",
      content: '{"temperature": 18, "condition": "cloudy"}',
    },
  ];

  const followUp = convertMessagesToAnthropic(followUpMessages);

  assert(
    followUp.system === "You are a weather assistant.",
    "Round-trip follow-up: system",
  );
  assert(
    followUp.messages.length === 3,
    "Round-trip follow-up: 3 messages (user, assistant, user-tool-result)",
  );

  const assistantBlock = followUp.messages[1];
  assert(
    assistantBlock.content[0].type === "text",
    "Round-trip follow-up: assistant text block",
  );
  assert(
    assistantBlock.content[1].type === "tool_use",
    "Round-trip follow-up: assistant tool_use block",
  );
  assert(
    assistantBlock.content[1].id === "toolu_paris",
    "Round-trip follow-up: tool_use id preserved",
  );

  const toolResultBlock = followUp.messages[2];
  assert(
    toolResultBlock.role === "user",
    "Round-trip follow-up: tool result in user msg",
  );
  assert(
    toolResultBlock.content[0].type === "tool_result",
    "Round-trip follow-up: tool_result block",
  );
  assert(
    toolResultBlock.content[0].tool_use_id === "toolu_paris",
    "Round-trip follow-up: tool_use_id",
  );
}

// ═══════════════════════════════════════════════════════════
//  TEST 13: Assistant message with content=null and tool_calls
// ═══════════════════════════════════════════════════════════
console.log(
  "\n🔧 Test 13: convertMessagesToAnthropic - assistant with null content + tool_calls",
);
{
  const messages = [
    { role: "user", content: "Search for AI news" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_search1",
          type: "function",
          function: { name: "search", arguments: '{"query":"AI news 2025"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_search1",
      content: "Top AI news: GPT-5 released...",
    },
  ];

  const result = convertMessagesToAnthropic(messages);
  const assistantMsg = result.messages[1];

  assert(
    assistantMsg.content.length === 1,
    "No text block when content is null",
  );
  assert(
    assistantMsg.content[0].type === "tool_use",
    "Only tool_use block present",
  );
  assert(assistantMsg.content[0].name === "search", "Tool name preserved");
}

// ═══════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(50)}`);
console.log(
  `  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`,
);
console.log(`${"═".repeat(50)}`);

if (failed > 0) {
  console.log("  ⚠️  Some tests failed!\n");
  process.exit(1);
} else {
  console.log("  🎉 All tests passed!\n");
  process.exit(0);
}
