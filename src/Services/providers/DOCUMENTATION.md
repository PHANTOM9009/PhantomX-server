# LLM Provider Abstraction Layer - Documentation


## OpenRouter Integration Plan

### Goal

Add OpenRouter as a third LLM provider for open-source and other hosted models while leaving the existing Claude Bedrock and Azure/OpenAI request paths unchanged.

### Architecture

```text
Application and agents
        |
        v
    LLMService
        |
        v
  ProviderFactory
    |-- ClaudeBedrockProvider -> AWS Bedrock
    |-- OpenAIProvider        -> existing Azure/OpenAI Responses API
    `-- OpenRouterProvider    -> OpenRouter Chat Completions API
```

OpenRouter will use `POST https://openrouter.ai/api/v1/chat/completions`. Although this API is OpenAI-compatible, it will have a dedicated provider because the existing OpenAI implementation uses the Responses API and Azure-specific authentication.

### Implementation steps

1. Add `openrouter` to the provider and model-provider types.
2. Add optional model capability metadata for tools, reasoning, caching, vision, and parallel tool calls.
3. Implement `OpenRouterProvider` with Bearer authentication, Chat Completions conversion, standardized response parsing, abort handling, and sanitized errors.
4. Register it in `ProviderFactory`, prioritizing explicit database provider metadata over legacy model-name detection.
5. Resolve credentials by provider in `LLMService`: existing AWS and Azure behavior stays unchanged; OpenRouter uses a supplied key or `OPENROUTER_API_KEY`.
6. Convert the agent's existing Claude-style tools and messages for OpenRouter without changing its internal conversation format.
7. Make model resolution database-driven so OpenRouter model keys do not silently fall back to Claude.
8. Remove source-embedded credentials and use configuration only.
9. Return database-backed model details alongside the legacy available-model list.
10. Add focused provider/factory tests and run the TypeScript build.

### Credential modes

A platform key can be configured through `OPENROUTER_API_KEY`. `LLMService` can also receive an authorized, server-resolved user key. Production UI flows should keep user keys in the existing encrypted secret store; raw keys must never enter task records, histories, metrics, or logs.

OpenRouter requests require an OpenRouter API key. Native provider keys are configured through OpenRouter BYOK rather than being sent directly as the OpenRouter bearer token.

### Model configuration

OpenRouter models use their complete OpenRouter slug and explicit provider metadata:

```json
{
  "modelKey": "OpenRouter_DeepSeek_V3",
  "modelId": "deepseek/deepseek-chat-v3-0324",
  "providerType": "openrouter",
  "displayName": "DeepSeek V3",
  "supportsTools": true,
  "supportsThinking": false,
  "supportsCaching": false,
  "supportsVision": false
}
```

Only models supporting the capabilities required by the coding agent, especially tool calling, should be exposed for those tasks.

### Verification

- Existing Claude and GPT models route exactly as before.
- Explicit OpenRouter records create `OpenRouterProvider`.
- Text, image, tool-call, tool-result, malformed-argument, usage, error, and cancellation paths are covered.
- Missing credentials produce a clear configuration error.
- The TypeScript build and focused tests pass, apart from any documented pre-existing repository errors.


This document provides comprehensive documentation for the LLM Provider Abstraction Layer, including migration guides and schema differences between Claude and OpenAI.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Schema Differences: Claude vs OpenAI](#schema-differences-claude-vs-openai)
4. [Migration Guide](#migration-guide)
5. [API Reference](#api-reference)
6. [Examples](#examples)
7. [Best Practices](#best-practices)

---

## Overview

The LLM Provider Abstraction Layer provides a unified interface for interacting with different Large Language Model providers (Claude via AWS Bedrock and OpenAI). This abstraction handles all the schema differences between providers, allowing you to:

- Write code once that works with multiple providers
- Easily switch between providers
- Maintain backward compatibility with existing Claude-format code
- Support future providers with minimal code changes

### Key Components

| Component | Description |
|-----------|-------------|
| `LLMProvider` | Abstract base class defining the provider interface |
| `ClaudeBedrockProvider` | Implementation for Claude models via AWS Bedrock |
| `OpenAIProvider` | Implementation for OpenAI GPT models |
| `AzureOpenAIProvider` | Implementation for Azure-hosted OpenAI models |
| `ProviderFactory` | Factory class for creating provider instances |
| `LLMService` | High-level service with backward compatibility |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application Code                          │
│                    (agent-system.ts, etc.)                       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         LLMService                               │
│         (High-level wrapper with format conversion)              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ProviderFactory                             │
│              (Creates appropriate provider)                      │
└─────────────────────────────────────────────────────────────────┘
                    ┌───────────┴───────────┐
                    ▼                       ▼
┌─────────────────────────────┐  ┌─────────────────────────────┐
│   ClaudeBedrockProvider     │  │      OpenAIProvider         │
│   (AWS Bedrock API)         │  │      (OpenAI API)           │
└─────────────────────────────┘  └─────────────────────────────┘
                    │                       │
                    ▼                       ▼
┌─────────────────────────────┐  ┌─────────────────────────────┐
│   Claude API Format         │  │      OpenAI API Format      │
│   - input_schema            │  │      - parameters           │
│   - tool_use in content     │  │      - tool_calls array     │
│   - system array            │  │      - system in messages   │
└─────────────────────────────┘  └─────────────────────────────┘
```

---

## Schema Differences: Claude vs OpenAI

### Quick Reference Table

| Feature | Claude (Anthropic) | OpenAI |
|---------|-------------------|--------|
| **Tool Definition** | | |
| Schema field | `input_schema` | `parameters` |
| Tool wrapper | Direct object `{ name, description, input_schema }` | Wrapped `{ type: "function", function: { name, description, parameters } }` |
| **Tool Calls** | | |
| Location | In `content` array with `type: "tool_use"` | Separate `tool_calls` array |
| Arguments | Object (parsed) | JSON string (needs parsing) |
| **Tool Results** | | |
| Role | `user` | `tool` |
| ID field | `tool_use_id` | `tool_call_id` |
| Content wrapper | `{ type: "tool_result", tool_use_id, content }` | `{ role: "tool", tool_call_id, content }` |
| **System Messages** | | |
| Location | Separate `system` array at request level | In `messages` array with `role: "system"` |
| Format | `[{ type: "text", text: "...", cache_control: {...} }]` | `{ role: "system", content: "..." }` |
| **Images** | | |
| Type | `type: "image"` | `type: "image_url"` |
| Data format | `source: { type: "base64", media_type, data }` | `image_url: { url: "data:image/...;base64,..." }` |
| **Caching** | | |
| Support | Yes (`cache_control: { type: "ephemeral" }`) | No (different mechanism) |
| **Thinking/Reasoning** | | |
| Support | Yes (`thinking: { type: "enabled", budget_tokens }`) | Limited (o1/o3 models with `reasoning_effort`) |

### Detailed Schema Comparisons

#### 1. Tool Definition

**Claude Format:**
```json
{
  "name": "execute_command",
  "description": "Execute a bash command",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "The command to execute"
      }
    },
    "required": ["command"]
  }
}
```

**OpenAI Format:**
```json
{
  "type": "function",
  "function": {
    "name": "execute_command",
    "description": "Execute a bash command",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "The command to execute"
        }
      },
      "required": ["command"]
    }
  }
}
```

#### 2. Assistant Response with Tool Calls

**Claude Format:**
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I'll execute the command for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01XFDUDYJgAACzvnptvVer6u",
      "name": "execute_command",
      "input": {
        "command": "ls -la"
      }
    }
  ]
}
```

**OpenAI Format:**
```json
{
  "role": "assistant",
  "content": "I'll execute the command for you.",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "execute_command",
        "arguments": "{\"command\": \"ls -la\"}"
      }
    }
  ]
}
```

#### 3. Tool Results

**Claude Format:**
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01XFDUDYJgAACzvnptvVer6u",
      "content": "total 24\ndrwxr-xr-x 5 user user 4096 Jan 30 12:00 .\n..."
    }
  ]
}
```

**OpenAI Format:**
```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "total 24\ndrwxr-xr-x 5 user user 4096 Jan 30 12:00 .\n..."
}
```

#### 4. Complete Request Structure

**Claude/Bedrock Request:**
```json
{
  "max_tokens": 4096,
  "anthropic_version": "bedrock-2023-05-31",
  "system": [
    {
      "type": "text",
      "text": "You are a helpful assistant.",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "tools": [...],
  "messages": [...]
}
```

**OpenAI Request:**
```json
{
  "model": "gpt-4o",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    ...
  ],
  "tools": [...],
  "temperature": 0.7
}
```

#### 5. Image Handling

**Claude Format:**
```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgoAAAANSUhEUgAAAAUA..."
  }
}
```

**OpenAI Format:**
```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA..."
  }
}
```

---

## Migration Guide

### For Existing Code Using Direct Bedrock API

**Before (Direct Bedrock API):**
```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

const message = {
  max_tokens: 4000,
  anthropic_version: 'bedrock-2023-05-31',
  system: 'You are a helpful assistant.',
  messages: [...],
  tools: [...]
};

const command = new InvokeModelCommand({
  modelId: 'anthropic.claude-3-sonnet',
  body: JSON.stringify(message)
});

const response = await bedrock.send(command);
const responseBody = JSON.parse(new TextDecoder().decode(response.body));
```

**After (Using LLMService):**
```typescript
import { LLMService } from './providers';

const llmService = new LLMService({
  modelKey: 'Claude_Sonnet_45'
  // Credentials auto-loaded from environment
});

await llmService.initialize();

const response = await llmService.invoke({
  maxTokens: 4000,
  systemPrompt: 'You are a helpful assistant.',
  messages: [...], // Can still use Claude format
  tools: [...]     // Can still use Claude format
});

// Response is already parsed with standardized format
console.log(response.text);
console.log(response.tools); // Array of tool calls if any
console.log(response.usage); // Token usage statistics
```

### Key Migration Points

1. **Tool Format**: The LLMService accepts tools in Claude's `input_schema` format and automatically converts for OpenAI.

2. **Message Format**: Messages can be provided in Claude's content array format - they're converted automatically.

3. **Response Handling**: The response is already parsed into a standard `ModelResponse` object.

4. **Error Handling**: Abort signals and error handling are built-in.

---

## API Reference

### LLMService

```typescript
class LLMService {
  constructor(options: LLMServiceOptions)
  
  // Initialize the service
  async initialize(): Promise<void>
  
  // Invoke the model
  async invoke(options: InvokeOptions): Promise<ModelResponse | null>
  
  // Get model information
  getModelInfo(): LLMInfo | null
  
  // Provider checks
  getProviderType(): string
  isClaude(): boolean
  isOpenAI(): boolean
  supportsThinking(): boolean
  supportsCaching(): boolean
  
  // Format conversion utilities
  convertClaudeToolsToStandard(claudeTools: any[]): ToolDefinition[]
  convertToolResultsToMessage(toolResults: ToolResult[]): Message
  
  // Advanced: Get underlying provider
  getProvider(): LLMProvider | null
}
```

### LLMServiceOptions

```typescript
interface LLMServiceOptions {
  modelKey: string;           // e.g., 'Claude_Sonnet_45', 'gpt-4o'
  modelId?: string;           // Optional: Override model ID
  modelInfo?: LLMInfo;        // Optional: Provide model info
  region?: string;            // AWS region for Bedrock
  apiKey?: string;            // API key for OpenAI
  apiEndpoint?: string;       // Custom endpoint
  credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
}
```

### InvokeOptions

```typescript
interface InvokeOptions {
  maxTokens?: number;         // Default: 20000
  systemPrompt: string;       // System instructions
  messages: any[];            // Conversation history
  tools: any[];               // Tool definitions
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;    // Default: 10000
  };
  temperature?: number;
  signal?: AbortSignal;       // For cancellation
}
```

### ModelResponse

```typescript
interface ModelResponse {
  toolUse: boolean;           // Whether tools were called
  tools: ToolCall[];          // Array of tool calls
  text: string;               // Text response
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    totalTokens?: number;
  };
  stopReason: string;         // Why generation stopped
  rawResponse?: any;          // Original provider response
}
```

---

## Examples

### Basic Usage

```typescript
import { LLMService } from './providers';

async function chat() {
  const service = new LLMService({ modelKey: 'Claude_Sonnet_45' });
  await service.initialize();
  
  const response = await service.invoke({
    systemPrompt: 'You are a helpful coding assistant.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Explain async/await in JavaScript' }]
      }
    ],
    tools: []
  });
  
  console.log(response?.text);
}
```

### Using Tools

```typescript
import { LLMService } from './providers';

async function executeWithTools() {
  const service = new LLMService({ modelKey: 'Claude_Sonnet_45' });
  await service.initialize();
  
  const tools = [{
    name: 'execute_command',
    description: 'Execute a bash command',
    input_schema: {  // Claude format - automatically converted for OpenAI
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command' }
      },
      required: ['command']
    }
  }];
  
  const response = await service.invoke({
    systemPrompt: 'You can execute commands.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'List files in current directory' }] }
    ],
    tools
  });
  
  if (response?.toolUse) {
    for (const tool of response.tools) {
      console.log(`Tool: ${tool.name}`);
      console.log(`Input: ${JSON.stringify(tool.input)}`);
    }
  }
}
```

### Switching Providers

```typescript
// Use Claude
const claudeService = new LLMService({ modelKey: 'Claude_Sonnet_45' });

// Use OpenAI - same interface!
const openaiService = new LLMService({
  modelKey: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY
});

// Use Azure OpenAI
const azureService = new LLMService({
  modelKey: 'azure-gpt-4o',
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  apiEndpoint: 'https://your-resource.openai.azure.com/...'
});

// All use the same invoke() interface!
```

---

## Best Practices

### 1. Use LLMService for New Code
The `LLMService` class provides the simplest interface and handles all format conversions automatically.

### 2. Keep Tool Definitions in Standard Format
While Claude format is supported for backward compatibility, consider using the standard format:

```typescript
{
  name: 'tool_name',
  description: 'Tool description',
  inputSchema: {  // Note: inputSchema, not input_schema
    type: 'object',
    properties: {...},
    required: [...]
  }
}
```

### 3. Handle Abort Signals
Always pass abort signals for user-initiated requests:

```typescript
const controller = new AbortController();
const response = await service.invoke({
  ...,
  signal: controller.signal
});

// To cancel:
controller.abort();
```

### 4. Check Response Before Using

```typescript
const response = await service.invoke({...});

if (!response) {
  // Request was aborted or failed
  return;
}

if (response.toolUse) {
  // Handle tool calls
} else {
  // Handle text response
}
```

### 5. Environment Configuration
Use environment variables for credentials:

```bash
# For Claude/Bedrock
AWS_ACCESS_KEY_ID_AI=your_key
AWS_SECRET_ACCESS_KEY_AI=your_secret
AWS_REGION=us-east-1

# For OpenAI
OPENAI_API_KEY=your_key

# For Azure OpenAI
AZURE_OPENAI_API_KEY=your_key
AZURE_OPENAI_ENDPOINT=your_endpoint
```

---

## Supported Models

### Claude (via AWS Bedrock)
- `Claude_Sonnet_45` - Claude Sonnet 4.5
- `Claude_Haiku_45` - Claude Haiku 4.5
- `Claude_Opus_45` - Claude Opus 4.5

### OpenAI
- `GPT_4o` - GPT-4o
- `GPT_4o_mini` - GPT-4o Mini
- `GPT_o1` - GPT o1 (with reasoning)
- `GPT_o1_mini` - GPT o1 Mini

---

## Troubleshooting

### "Provider not initialized"
Ensure you call `initialize()` before `invoke()`.

### Tool arguments are JSON strings
This is expected for OpenAI - the abstraction layer handles parsing automatically.

### Caching not working with OpenAI
OpenAI doesn't support Claude's `cache_control`. The feature is ignored for OpenAI providers.

### Thinking not working with GPT-4
Only Claude and OpenAI's o1/o3 models support thinking/reasoning. For other models, the `thinking` option is ignored.

---

## Version History

- **1.0.0** - Initial release with Claude and OpenAI support
- Provider factory pattern
- LLMService for backward compatibility
- Automatic format conversion
