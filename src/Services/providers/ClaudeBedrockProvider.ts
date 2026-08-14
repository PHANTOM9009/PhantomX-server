/**
 * ClaudeBedrockProvider - Implementation for Claude models via AWS Bedrock
 * 
 * Handles the Claude-specific message format:
 * - Uses input_schema for tools
 * - Tool calls are in content array with type: "tool_use"
 * - Tool results use role: "user" with type: "tool_result"
 * - Supports cache_control for prompt caching
 * - Supports thinking/reasoning mode
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
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

const logger = createLogger('ClaudeBedrockProvider');

export class ClaudeBedrockProvider extends LLMProvider {
    private bedrockClient: BedrockRuntimeClient;
    private anthropicVersion: string = 'bedrock-2023-05-31';

    constructor(config: ProviderConfig) {
        super(config);
        this.bedrockClient = new BedrockRuntimeClient({
            region: config.region || process.env.AWS_REGION || 'us-east-1',
            credentials: config.credentials ? {
                accessKeyId: config.credentials.accessKeyId || '',
                secretAccessKey: config.credentials.secretAccessKey || '',
                sessionToken: config.credentials.sessionToken
            } : undefined
        });
    }

    async initialize(): Promise<void> {
        // BedrockRuntimeClient doesn't require explicit initialization
        logger.info('ClaudeBedrockProvider initialized', { modelId: this.modelId });
    }

    getProviderName(): string {
        return 'claude_bedrock';
    }

    supportsThinking(): boolean {
        return true;
    }

    supportsCaching(): boolean {
        return true;
    }

    /**
     * Convert standard tool definitions to Claude/Bedrock format
     * Claude uses input_schema (not parameters)
     */
    convertToolsToProviderFormat(tools: ToolDefinition[]): any[] {
        return tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: {
                type: tool.inputSchema.type,
                properties: tool.inputSchema.properties,
                required: tool.inputSchema.required,
                additionalProperties: tool.inputSchema.additionalProperties
            },
            ...(tool.cacheControl && { cache_control: tool.cacheControl })
        }));
    }

    /**
     * Convert standard messages to Claude/Bedrock format
     * Claude uses separate system array and doesn't have system role in messages
     */
    convertMessagesToProviderFormat(messages: Message[], systemPrompt?: string): any {
        const convertedMessages: any[] = [];

        // for (const msg of messages) {
        //     if (msg.role === 'system') {
        //         // System messages are handled separately in Claude
        //         continue;
        //     }

        //     if (msg.role === 'tool') {
        //         // Tool results in Claude are user messages with tool_result type
        //         const toolResultMsg = {
        //             role: 'user',
        //             content: [{
        //                 type: 'tool_result',
        //                 tool_use_id: msg.toolCallId,
        //                 content: typeof msg.content === 'string' ? msg.content : 
        //                     (msg.content as MessageContent[])[0]?.content || ''
        //             }]
        //         };
        //         convertedMessages.push(toolResultMsg);
        //         continue;
        //     }

        //     const convertedMsg: any = {
        //         role: msg.role,
        //         content: []
        //     };

        //     if (typeof msg.content === 'string') {
        //         convertedMsg.content.push({
        //             type: 'text',
        //             text: msg.content
        //         });
        //     } else {
        //         for (const contentItem of msg.content as MessageContent[]) {
        //             if (contentItem.type === 'text') {
        //                 const textContent: any = {
        //                     type: 'text',
        //                     text: contentItem.text
        //                 };
        //                 if (contentItem.cacheControl) {
        //                     textContent.cache_control = contentItem.cacheControl;
        //                 }
        //                 convertedMsg.content.push(textContent);
        //             } else if (contentItem.type === 'image') {
        //                 convertedMsg.content.push({
        //                     type: 'image',
        //                     source: {
        //                         type: contentItem.source?.type || 'base64',
        //                         media_type: contentItem.source?.mediaType || 'image/png',
        //                         data: contentItem.source?.data
        //                     }
        //                 });
        //             } else if (contentItem.type === 'tool_use') {
        //                 convertedMsg.content.push({
        //                     type: 'tool_use',
        //                     id: contentItem.id,
        //                     name: contentItem.name,
        //                     input: contentItem.input
        //                 });
        //             } else if (contentItem.type === 'tool_result') {
        //                 convertedMsg.content.push({
        //                     type: 'tool_result',
        //                     tool_use_id: contentItem.toolUseId,
        //                     content: contentItem.content,
        //                     ...(contentItem.isError && { is_error: true })
        //                 });
        //             }
        //         }
        //     }

        //     convertedMessages.push(convertedMsg);
        // }

        return {
            system: systemPrompt ? [{
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral' }
            }] : undefined,
            messages: messages
        };
    }

    /**
     * Convert tool results to Claude's message format
     */
    convertToolResultsToMessage(toolResults: ToolResult[]): Message {
        const content: MessageContent[] = [];
        
        // Group results by tool ID
        const resultsMap = new Map<string, any[]>();
        for (const result of toolResults) {
            const existing = resultsMap.get(result.id) || [];
            existing.push(result);
            resultsMap.set(result.id, existing);
        }

        for (const [toolId, results] of Array.from(resultsMap)) {
            if (results.length === 1) {
                const result = results[0];
                content.push({
                    type: 'tool_result',
                    toolUseId: result.id,
                    content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
                    isError: result.isError
                });
            } else {
                // Multiple results for the same tool - combine them
                const combinedContent: any[] = [];
                for (const result of results) {
                    if (result.type === 'image') {
                        combinedContent.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: result.result
                            }
                        });
                    } else {
                        combinedContent.push({
                            type: 'text',
                            text: typeof result.result === 'string' ? result.result : JSON.stringify(result.result)
                        });
                    }
                }
                content.push({
                    type: 'tool_result',
                    toolUseId: toolId,
                    content: JSON.stringify(combinedContent)
                } as any);
            }
        }

        return {
            role: 'user',
            content
        };
    }

    /**
     * Parse Claude's response to standard format
     */
    parseResponse(responseBody: any): ModelResponse {
        const toolCalls: ToolCall[] = [];
        let text = '';

        if (responseBody.content && Array.isArray(responseBody.content)) {
            for (const item of responseBody.content) {
                if (item.type === 'tool_use') {
                    toolCalls.push({
                        id: item.id,
                        name: item.name,
                        input: item.input
                    });
                } else if (item.type === 'text') {
                    text = item.text || '';
                }
            }
        }

        return {
            toolUse: toolCalls.length > 0,
            tools: toolCalls,
            text: text || 'No content found in response',
            usage: {
                inputTokens: responseBody.usage?.input_tokens || 0,
                outputTokens: responseBody.usage?.output_tokens || 0,
                cacheCreationInputTokens: responseBody.usage?.cache_creation_input_tokens || 0,
                cacheReadInputTokens: responseBody.usage?.cache_read_input_tokens || 0,
                totalTokens: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0)
            },
            stopReason: responseBody.stop_reason || 'unknown',
            rawResponse: responseBody
        };
    }

    /**
     * Invoke the Claude model via Bedrock
     */
    async invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse | null> {
        try {
            if (signal?.aborted) {
                return null;
            }

            // Convert tools to Claude format
            const claudeTools = request.tools;

            // Convert messages to Claude format
            const { system, messages } = this.convertMessagesToProviderFormat(
                request.messages,
                request.systemPrompt
            );

            // Build the request body
            const requestBody: any = {
                max_tokens: request.maxTokens,
                anthropic_version: this.anthropicVersion,
                tools: claudeTools,
                messages: messages
            };

            if (system) {
                requestBody.system = system;
            }

            // Add thinking support if enabled
            if (request.thinking?.enabled) {
                requestBody.thinking = {
                    type: 'enabled',
                    budget_tokens: request.thinking.budgetTokens || 10000
                };
            }

            const command = new InvokeModelCommand({
                modelId: this.modelId,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(requestBody)
            });

            const options = signal ? { abortSignal: signal } : {};
            const response = await this.bedrockClient.send(command, options);

            if (signal?.aborted) {
                return null;
            }

            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            return this.parseResponse(responseBody);

        } catch (error: any) {
            if (error.name === 'AbortError' || signal?.aborted) {
                return null;
            }
            logger.error('Error invoking Claude model via Bedrock', { error: error.message });
            throw error;
        }
    }
}
