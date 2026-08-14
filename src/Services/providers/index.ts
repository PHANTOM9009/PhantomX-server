/**
 * LLM Provider Abstraction Layer
 * 
 * This module provides a unified interface for different LLM providers,
 * handling the schema differences between Claude (Anthropic) and OpenAI APIs.
 * 
 * Usage:
 * ```typescript
 * // Method 1: Using LLMService (Recommended - handles backward compatibility)
 * import { LLMService } from './providers';
 * 
 * const service = new LLMService({ modelKey: 'Claude_Sonnet_45' });
 * await service.initialize();
 * const response = await service.invoke({
 *     systemPrompt: 'You are a helpful assistant.',
 *     messages: [...], // Can be Claude or standard format
 *     tools: [...]     // Can be Claude or standard format
 * });
 * 
 * // Method 2: Using ProviderFactory (For more control)
 * import { ProviderFactory, ProviderType } from './providers';
 * 
 * const provider = ProviderFactory.createProvider({
 *     modelKey: 'Claude_Sonnet_45',
 *     modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
 *     modelInfo: modelInfo,
 *     credentials: { accessKeyId, secretAccessKey }
 * });
 * 
 * // Or for OpenAI
 * const openaiProvider = ProviderFactory.createProvider({
 *     modelKey: 'gpt-4o',
 *     modelId: 'gpt-4o-2024-08-06',
 *     modelInfo: modelInfo,
 *     apiKey: process.env.OPENAI_API_KEY
 * });
 * 
 * await provider.initialize();
 * const response = await provider.invoke({
 *     maxTokens: 4096,
 *     systemPrompt: 'You are a helpful assistant.',
 *     messages: [...],
 *     tools: [...]
 * });
 * ```
 * 
 * Key Schema Differences Handled:
 * 
 * | Feature | Claude | OpenAI |
 * |---------|--------|--------|
 * | Tool Schema | input_schema | parameters |
 * | Tool Wrapper | Direct object | { type: "function", function: {...} } |
 * | Tool Response | type: "tool_use" in content | tool_calls array |
 * | Tool Input | Object | JSON string |
 * | Tool Result Role | user | tool |
 * | Tool Result ID | tool_use_id | tool_call_id |
 * | System Message | Separate system array | In messages with role="system" |
 * | Image Format | type: "image" + base64 | type: "image_url" + data URI |
 */

export * from './ILLMProvider';
export * from './ClaudeBedrockProvider';
export * from './OpenAIProvider';
export * from './ProviderFactory';
export * from './LLMService';
