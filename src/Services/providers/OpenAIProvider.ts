/**
 * OpenAIProvider - Implementation for Azure OpenAI Responses API ONLY
 * 
 * Responses API format:
 * - input: array of message objects
 * - tools: flat structure with name at top level
 * - max_output_tokens (not max_tokens)
 * - output array with function_call type
 * - usage: input_tokens, output_tokens, total_tokens, cached_tokens
 * 
 * PROMPT CACHING:
 * OpenAI/Azure OpenAI uses automatic prompt caching (different from Claude's explicit cache_control)
 * 
 * Key Differences:
 * 1. AUTOMATIC vs EXPLICIT:
 *    - OpenAI: Automatically caches prompts > 1024 tokens, no explicit markers needed
 *    - Claude: Requires explicit cache_control breakpoints in tools/messages
 * 
 * 2. CACHE DETECTION:
 *    - OpenAI: Returns 'input_tokens_details.cached_tokens' in Responses API
 *    - Claude: Returns 'cache_creation_input_tokens' and 'cache_read_input_tokens'
 * 
 * 3. PRICING:
 *    - OpenAI: Cached tokens cost 50% less than regular input tokens
 *    - Claude: Cache writes cost 25% more, cache reads cost 90% less
 * 
 * 4. CACHE LIFETIME:
 *    - OpenAI: 5-10 minutes (automatic eviction)
 *    - Claude: ~5 minutes for ephemeral caching
 * 
 * 5. MINIMUM CACHEABLE SIZE:
 *    - OpenAI: 1024 tokens minimum
 *    - Claude: 2048 tokens per cache breakpoint (1024 for prompt caching 2024-07-31+)
 * 
 * Supported Models (as of 2024):
 * - gpt-4o, gpt-4o-mini
 * - gpt-4-turbo, gpt-4
 * - o1-preview, o1-mini, o3-mini
 * 
 * Reference: https://platform.openai.com/docs/guides/prompt-caching
 */

import axios, { AxiosInstance } from 'axios';
import { createLogger } from '../../utils/Logger';
import {
    LLMProvider,
    ProviderConfig,
    ModelRequest,
    ModelResponse,
    ToolDefinition,
    ToolCall,
    ToolResult,
    Message,
    MessageContent
} from './ILLMProvider';

const logger = createLogger('OpenAIProvider');

export class OpenAIProvider extends LLMProvider {
    private httpClient: AxiosInstance;
    private apiKey: string;
    private apiEndpoint: string;
    private isAzure: boolean;

    constructor(config: ProviderConfig) {
        super(config);
        this.apiKey = config.apiKey as any;
        this.apiEndpoint = config.apiEndpoint || '';
        this.isAzure = true;

        logger.info('Initialized Responses API provider', { 
            endpoint: this.apiEndpoint,
            modelId: this.modelId 
        });

        this.httpClient = axios.create({
            timeout: 600000,
            headers: this.isAzure 
                ? { 'api-key': this.apiKey, 'Content-Type': 'application/json' }
                : { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }
        });
    }

    async initialize(): Promise<void> {
        logger.info('OpenAIProvider initialized', { modelId: this.modelId, isAzure: this.isAzure });
    }

    getProviderName(): string {
        return this.isAzure ? 'azure_openai' : 'openai';
    }
       supportsThinking(): boolean {
        return true;
    }


   

    supportsCaching(): boolean {
        // OpenAI supports prompt caching for certain models
        // Reference: https://platform.openai.com/docs/guides/prompt-caching
           return true;
    }

    /**
     * Convert to Responses API tool format
     */
    convertToolsToProviderFormat(tools: ToolDefinition[]): any[] {
        return tools.map(tool => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: {
                type: tool.inputSchema.type,
                properties: tool.inputSchema.properties,
                required: tool.inputSchema.required,
                additionalProperties: tool.inputSchema.additionalProperties ?? false
            }
        }));
    }

/**
     * Convert to Responses API message format
     * Responses API format:
     * - Messages use: {type: "message", role: "user/assistant/system", content: ...}
     * - Function calls use: {type: "function_call", call_id, name, arguments}
     * - Function outputs use: {type: "function_call_output", call_id, output}
     * - Text content uses: {type: "input_text", text: ...}
     * - Image content uses: {type: "input_image", image_url: ...}
     */
    convertMessagesToProviderFormat(messages: Message[], systemPrompt?: string): any[] {
        const convertedMessages: any[] = [];

        if (systemPrompt) {
            convertedMessages.push({
                type: 'message',
                role: 'system',
                content: systemPrompt
            });
        }

        for (const msg of messages) {
            if (msg.role === 'system') {
                convertedMessages.push({
                    type: 'message',
                    role: 'system',
                    content: typeof msg.content === 'string' 
                        ? msg.content 
                        : (msg.content as MessageContent[])[0]?.text || ''
                });
                continue;
            }

            // Tool results in Responses API use type: 'function_call_output'
            if (msg.role === 'tool') {
                convertedMessages.push({
                    type: 'function_call_output',
                    call_id: msg.toolCallId,
                    output: typeof msg.content === 'string' 
                        ? msg.content 
                        : (msg.content as MessageContent[])[0]?.content || ''
                });
                continue;
            }

            const hasToolUse = Array.isArray(msg.content) && 
                (msg.content as MessageContent[]).some(c => c.type === 'tool_use');

            if (msg.role === 'assistant' && hasToolUse) {
                // For Responses API, we need to include function_call items
                // so the API can match function_call_output with the original calls
                
                // First add any text content as assistant message
                let textContent: string = '';
                for (const item of msg.content as MessageContent[]) {
                    if (item.type === 'text' && item.text) {
                        textContent = item.text;
                        break;
                    }
                }

                if (textContent) {
                    convertedMessages.push({
                        type: 'message',
                        role: 'assistant',
                        content: textContent
                    });
                }

                // Then add function_call items for each tool_use
                // This is required so the API can match function_call_output with call_id
                for (const item of msg.content as MessageContent[]) {
                    if (item.type === 'tool_use') {
                        convertedMessages.push({
                            type: 'function_call',
                            call_id: item.id,
                            name: item.name,
                            arguments: typeof item.input === 'string' 
                                ? item.input 
                                : JSON.stringify(item.input || {})
                        });
                    }
                }
                continue;
            }

            // Simple string content
            if (typeof msg.content === 'string') {
                convertedMessages.push({
                    type: 'message',
                    role: msg.role,
                    content: msg.content
                });
                continue;
            }

            // Complex content with multiple parts
            const contentParts: any[] = [];
            for (const contentItem of msg.content as MessageContent[]) {
                if (contentItem.type === 'text') {
                    contentParts.push({
                        type: 'input_text',
                        text: contentItem.text
                    });
                } else if (contentItem.type === 'image') {
                    const imageData = contentItem.source?.data;
                    const mediaType = contentItem.source?.mediaType || 'image/png';
                    contentParts.push({
                        type: 'input_image',
                        image_url: contentItem.source?.url || `data:${mediaType};base64,${imageData}`
                    });
                } else if (contentItem.type === 'tool_result') {
                    // Tool results use type: 'function_call_output' in Responses API
                    convertedMessages.push({
                        type: 'function_call_output',
                        call_id: contentItem.toolUseId,
                        output: contentItem.content || ''
                    });
                }
            }

            if (contentParts.length > 0) {
                convertedMessages.push({
                    type: 'message',
                    role: msg.role,
                    content: contentParts.length === 1 && contentParts[0].type === 'input_text' 
                        ? contentParts[0].text 
                        : contentParts
                });
            }
        }

        return convertedMessages;
    }

    /**
     * Convert tool results to message format
     */
    convertToolResultsToMessage(toolResults: ToolResult[]): Message {
        const content: MessageContent[] = toolResults.map(result => ({
            type: 'tool_result' as const,
            toolUseId: result.id,
            content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
            isError: result.isError
        }));

        return {
            role: 'user',
            content
        };
    }

    /**
     * Parse Responses API response
     * Handles: function_call, reasoning, message types in output array
     */
    parseResponse(responseBody: any): ModelResponse {
        const toolCalls: ToolCall[] = [];
        let text = responseBody.output_text || '';
        const stopReason = responseBody.status || 'completed';
        let reasoningSummary: string[] = [];
        
        if (responseBody.output && Array.isArray(responseBody.output)) {
            for (const output of responseBody.output) {
                // Handle function calls
                if (output.type === 'function_call') {
                    // Check status - only process completed calls
                    if (output.status && output.status !== 'completed') {
                        logger.warn('Skipping non-completed function call', { 
                            call_id: output.call_id,
                            status: output.status 
                        });
                        continue;
                    }

                    let parsedInput: Record<string, any>;
                    try {
                        parsedInput = typeof output.arguments === 'string' 
                            ? JSON.parse(output.arguments)
                            : output.arguments;
                    } catch (error) {
                        logger.error('Failed to parse function call arguments', { 
                            arguments: output.arguments,
                            error 
                        });
                        parsedInput = { raw: output.arguments };
                    }
                    
                    toolCalls.push({
                        id: output.call_id || output.id,
                        name: output.name,
                        input: parsedInput
                    });
                }
                // Handle reasoning output
                else if (output.type === 'reasoning') {
                    if (output.summary && Array.isArray(output.summary)) {
                        reasoningSummary = output.summary;
                        logger.debug('Reasoning summary received', { summary: reasoningSummary });
                    }
                }
                // Handle message output
                else if (output.type === 'message' && output.content) {
                    for (const content of output.content) {
                        if (content.type === 'output_text') {
                            text = content.text || text;
                        }
                    }
                }
            }
        }
        
        const usage = {
            inputTokens: responseBody.usage?.input_tokens || 0,
            outputTokens: responseBody.usage?.output_tokens || 0,
            totalTokens: responseBody.usage?.total_tokens || 0,
            // OpenAI Responses API prompt caching:
            // Cached tokens appear at: usage.input_tokens_details.cached_tokens
            cacheReadInputTokens: responseBody.usage?.input_tokens_details?.cached_tokens || 0,
            // OpenAI doesn't expose cache creation separately, it's included in input_tokens
            cacheCreationInputTokens: 0
        };

        return {
            toolUse: toolCalls.length > 0,
            tools: toolCalls,
            text: text || null,
            usage,
            stopReason,
            rawResponse: responseBody
        };
    }

    /**
     * Invoke Responses API
     */
    async invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse | null> {
        try {
            if (signal?.aborted) {
                return null;
            }

            const openaiTools = this.convertToolsToProviderFormat(request.tools);
            const messages = this.convertMessagesToProviderFormat(
                request.messages,
                request.systemPrompt
            );

const requestBody: any = {
                model: this.modelId,
                input: messages,
                tools: openaiTools.length > 0 ? openaiTools : undefined,
            };

            if (request.maxTokens) {
                requestBody.max_output_tokens = request.maxTokens;
            }
            
            if (openaiTools.length > 0) {
                requestBody.parallel_tool_calls = true;
            }

            if (request.temperature !== undefined) {
                requestBody.temperature = request.temperature;
            }

            if (request.thinking?.enabled) {
                requestBody.reasoning = {effort: 'high'};
         }
            requestBody.model = this.modelId ;
            // Debug logging for troubleshooting
            logger.debug('Responses API request', {
                model: requestBody.model,
                inputCount: messages.length,
                toolCount: openaiTools.length,
                inputTypes: messages.map((m: any) => m.type || m.role)
            });

            const response = await this.httpClient.post(
                this.apiEndpoint,
                requestBody,
                { signal }
            );

            if (signal?.aborted) {
                return null;
            }

            return this.parseResponse(response.data);

        } catch (error: any) {
            if (axios.isCancel(error) || signal?.aborted) {
                return null;
            }
            
            const errorData = error.response?.data;
            const errorMessage = errorData?.error?.message || error.message;
            
            logger.error('Error invoking Responses API', { 
                error: errorMessage, 
                endpoint: this.apiEndpoint,
                response: errorData 
            });
            throw error;
        }
    }
}

/**
 * AzureOpenAIProvider
 */
export class AzureOpenAIProvider extends OpenAIProvider {
    constructor(config: ProviderConfig) {
        const azureEndpoint = config.apiEndpoint || process.env.AZURE_OPENAI_ENDPOINT || '';
        super({
            ...config,
            apiEndpoint: azureEndpoint,
            apiKey: config.apiKey || process.env.AZURE_OPENAI_API_KEY
        });
    }

    getProviderName(): string {
        return 'azure_openai';
    }
}


/**
 * OpenRouterProvider - OpenRouter Chat Completions API implementation.
 * Kept separate from the Responses API implementation above because message,
 * tool-call, and usage schemas differ between the two APIs.
 */
export class OpenRouterProvider extends LLMProvider {
    private httpClient: AxiosInstance;
    private apiEndpoint: string;

    constructor(config: ProviderConfig) {
        super(config);

        if (!config.apiKey) {
            throw new Error('OpenRouter API key is required. Set OPENROUTER_API_KEY or provide apiKey.');
        }

        this.apiEndpoint = config.apiEndpoint || 'https://openrouter.ai/api/v1/chat/completions';
        const headers: Record<string, string> = {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
        };

        if (config.appUrl) {
            headers['HTTP-Referer'] = config.appUrl;
        }
        if (config.appName) {
            headers['X-OpenRouter-Title'] = config.appName;
        }

        this.httpClient = axios.create({
            timeout: 600000,
            headers
        });
    }

    async initialize(): Promise<void> {
        logger.info('OpenRouterProvider initialized', { modelId: this.modelId });
    }

    getProviderName(): string {
        return 'openrouter';
    }

    supportsThinking(): boolean {
        return this.modelInfo.supportsThinking === true;
    }

    supportsCaching(): boolean {
        return this.modelInfo.supportsCaching === true;
    }

    convertToolsToProviderFormat(tools: ToolDefinition[]): any[] {
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: tool.inputSchema.type,
                    properties: tool.inputSchema.properties,
                    required: tool.inputSchema.required,
                    additionalProperties: tool.inputSchema.additionalProperties ?? false
                }
            }
        }));
    }

    convertMessagesToProviderFormat(messages: Message[], systemPrompt?: string): any[] {
        const convertedMessages: any[] = [];

        if (systemPrompt) {
            convertedMessages.push({ role: 'system', content: systemPrompt });
        }

        for (const message of messages) {
            if (typeof message.content === 'string') {
                if (message.role === 'tool') {
                    convertedMessages.push({
                        role: 'tool',
                        tool_call_id: message.toolCallId,
                        content: message.content
                    });
                } else {
                    convertedMessages.push({ role: message.role, content: message.content });
                }
                continue;
            }

            const content = message.content as MessageContent[];
            const toolResults = content.filter(item => item.type === 'tool_result');
            const toolCalls = content.filter(item => item.type === 'tool_use');
            const regularContent = content.filter(item => item.type === 'text' || item.type === 'image');

            if (message.role === 'assistant' && toolCalls.length > 0) {
                const assistantText = regularContent
                    .filter(item => item.type === 'text')
                    .map(item => item.text || '')
                    .join('\n');

                convertedMessages.push({
                    role: 'assistant',
                    content: assistantText || null,
                    tool_calls: toolCalls.map(item => ({
                        id: item.id,
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: JSON.stringify(item.input || {})
                        }
                    }))
                });
            } else if (regularContent.length > 0) {
                const convertedContent = regularContent.map(item => {
                    if (item.type === 'image') {
                        const mediaType = item.source?.mediaType || 'image/png';
                        return {
                            type: 'image_url',
                            image_url: {
                                url: item.source?.url || `data:${mediaType};base64,${item.source?.data || ''}`
                            }
                        };
                    }
                    return { type: 'text', text: item.text || '' };
                });

                const textOnly = convertedContent.every(item => item.type === 'text');
                convertedMessages.push({
                    role: message.role,
                    content: textOnly
                        ? convertedContent.map(item => item.text).join('\n')
                        : convertedContent
                });
            }

            for (const result of toolResults) {
                convertedMessages.push({
                    role: 'tool',
                    tool_call_id: result.toolUseId,
                    content: result.content || ''
                });
            }
        }

        return convertedMessages;
    }

    convertToolResultsToMessage(toolResults: ToolResult[]): Message {
        return {
            role: 'user',
            content: toolResults.map(result => ({
                type: 'tool_result' as const,
                toolUseId: result.id,
                content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
                isError: result.isError
            }))
        };
    }

    parseResponse(responseBody: any): ModelResponse {
        const choice = responseBody?.choices?.[0];
        const message = choice?.message || {};
        const toolCalls: ToolCall[] = (message.tool_calls || []).map((toolCall: any) => {
            let input: Record<string, any>;
            try {
                input = typeof toolCall.function?.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function?.arguments || {};
            } catch {
                input = { raw: toolCall.function?.arguments };
            }

            return {
                id: toolCall.id,
                name: toolCall.function?.name,
                input
            };
        });

        const usage = responseBody?.usage || {};
        return {
            toolUse: toolCalls.length > 0,
            tools: toolCalls,
            text: typeof message.content === 'string' ? message.content : '',
            usage: {
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0,
                cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens || 0,
                cacheCreationInputTokens: 0
            },
            stopReason: choice?.finish_reason || 'unknown',
            rawResponse: responseBody
        };
    }

    async invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse | null> {
        try {
            if (signal?.aborted) {
                return null;
            }

            if (request.tools.length > 0 && this.modelInfo.supportsTools === false) {
                throw new Error(`OpenRouter model '${this.modelId}' does not support tool calling`);
            }

            const tools = this.convertToolsToProviderFormat(request.tools);
            const requestBody: any = {
                model: this.modelId,
                messages: this.convertMessagesToProviderFormat(request.messages, request.systemPrompt),
                max_tokens: request.maxTokens
            };

            if (tools.length > 0) {
                requestBody.tools = tools;
                if (this.modelInfo.supportsParallelToolCalls !== false) {
                    requestBody.parallel_tool_calls = true;
                }
            }
            if (request.temperature !== undefined) {
                requestBody.temperature = request.temperature;
            }
            if (request.thinking?.enabled && this.supportsThinking()) {
                requestBody.reasoning = { effort: 'high' };
            }

            const response = await this.httpClient.post(this.apiEndpoint, requestBody, { signal });
            return signal?.aborted ? null : this.parseResponse(response.data);
        } catch (error: any) {
            if (axios.isCancel(error) || signal?.aborted) {
                return null;
            }

            const status = error.response?.status;
            const providerMessage = error.response?.data?.error?.message;
            const safeMessage = providerMessage || error.message || 'OpenRouter request failed';
            logger.error('Error invoking OpenRouter', {
                status,
                modelId: this.modelId,
                error: safeMessage
            });
            throw new Error(status ? `OpenRouter request failed (${status}): ${safeMessage}` : safeMessage);
        }
    }
}
