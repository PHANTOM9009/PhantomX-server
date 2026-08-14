/**
 * LLMService - High-level service for LLM interactions
 * 
 * This service provides a simplified interface for using LLM providers,
 * handling initialization, tool conversion, and response parsing.
 * It's designed to be a drop-in replacement for direct Bedrock API calls.
 */

import {
    LLMProvider,
    ProviderConfig,
    ProviderType,
    ModelRequest,
    ModelResponse,
    ToolDefinition,
    ToolCall,
    ToolResult,
    Message,
    MessageContent
} from './ILLMProvider';
import { ProviderFactory, ProviderFactoryOptions } from './ProviderFactory';
import { LLMInfo } from '../../DataAccessLayer/models/ModelInformation';
import { getModelInfo } from '../ModelInfoService';
import { createLogger } from '../../utils/Logger';
import { AZURE_OPENAI_API_KEY } from '../../DataAccessLayer/models/azureOpenAIAPIKey';
const logger = createLogger('LLMService');
import * as dotenv from 'dotenv';
dotenv.config();
/**
 * Simplified service options
 */
export interface LLMServiceOptions {
    modelKey: string;
    modelId?: string;
    modelInfo?: LLMInfo;
    region?: string;
    apiKey?: string;
    apiEndpoint?: string;
    providerType?: ProviderType;
    appUrl?: string;
    appName?: string;
    credentials?: {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
    };
}

/**
 * Options for invoking the model
 */
export interface InvokeOptions {
    maxTokens?: number;
    systemPrompt: string;
    messages: any[]; // Can be in Claude or standard format
    tools: any[]; // Can be in Claude or standard format
    thinking?: {
        enabled: boolean;
        budgetTokens?: number;
    };
    temperature?: number;
    signal?: AbortSignal;
}

/**
 * LLMService - High-level wrapper around provider abstraction
 */
export class LLMService {
    private provider: LLMProvider | null = null;
    private options: LLMServiceOptions;
    private isInitialized: boolean = false;
    private modelInfo: LLMInfo | null = null;
    providerType: ProviderType | null = null;
    constructor(options: LLMServiceOptions) {
        this.options = options;
    }

    /**
     * Get the current model info
     */
    getModelInfo(): LLMInfo | null {
        return this.modelInfo;
    }

    /**
     * Initialize the service and create the provider
     */
    async initialize(): Promise<void> {
       
//        Get model info if not provided
        if (!this.options.modelInfo) {
            const info = await getModelInfo(this.options.modelKey);
            if (!info) {
                throw new Error(`Model info not found for key: ${this.options.modelKey}`);
            }
            this.modelInfo = info;
        } else {
            this.modelInfo = this.options.modelInfo;
        }

        this.options.apiEndpoint = this.options.apiEndpoint
            || this.modelInfo.api_endpoint
            || this.modelInfo.azure_api_endpoint;

        // Get model ID if not provided
       

        // Create the provider
        const providerType = this.options.providerType
            || (this.modelInfo.providerType as ProviderType | undefined)
            || ProviderFactory.detectProviderType(this.options.modelKey, this.modelInfo.modelId);
        const apiKey = providerType === ProviderType.OPENROUTER
            ? this.options.apiKey || process.env.OPENROUTER_API_KEY
            : this.options.apiKey
                || AZURE_OPENAI_API_KEY.get(this.options.modelKey)
                || process.env.AZURE_OPENAI_API_KEY;

        const factoryOptions: ProviderFactoryOptions = {
            modelKey: this.options.modelKey,
            modelId: this.modelInfo.modelId,
            modelInfo: this.modelInfo,
            providerType,
            region: this.options.region,
            apiKey,
            apiEndpoint: this.options.apiEndpoint,
            appUrl: this.options.appUrl || process.env.OPENROUTER_HTTP_REFERER,
            appName: this.options.appName || process.env.OPENROUTER_APP_TITLE,
            credentials: this.options.credentials || {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID_AI,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_AI,
                sessionToken: process.env.AWS_SESSION_TOKEN
            }
        };

        this.provider = ProviderFactory.createProvider(factoryOptions);
        this.providerType = this.provider.providerType;
        await this.provider.initialize();
        this.isInitialized = true;

        logger.info('LLMService initialized', {
            modelKey: this.options.modelKey,
            modelId: this.modelInfo.modelId,
            provider: this.provider.getProviderName()
        });
    }

    /**
     * Get the provider type
     */
    getProviderType(): string {
        return this.provider?.getProviderName() || 'unknown';
    }

    /**
     * Check if provider is Claude
     */
    isClaude(): boolean {
        return this.provider?.getProviderName() === 'claude_bedrock';
    }

    /**
     * Check if provider is OpenAI
     */
    isOpenAI(): boolean {
        const name = this.provider?.getProviderName();
        return name === 'openai' || name === 'azure_openai';
    }


    /**
     * Check if provider is OpenRouter.
     */
    isOpenRouter(): boolean {
        return this.provider?.getProviderName() === 'openrouter';
    }


    /**
     * Convert Claude-format tools to standard format
     * This helps migrate existing code that defines tools in Claude format
     */
    convertClaudeToolsToStandard(claudeTools: any[]): ToolDefinition[] {
        return ProviderFactory.convertClaudeToolsToStandard(claudeTools);
    }

    /**
     * Invoke the model with automatic format conversion
     * This method accepts tools and messages in Claude format and converts as needed
     */
    async invoke(options: InvokeOptions): Promise<ModelResponse | null> {
        if (!this.provider || !this.isInitialized) {
            await this.initialize();
        }

        if (!this.provider) {
            throw new Error('Provider not initialized');
        }

        // Check abort signal
        if (options.signal?.aborted) {
            return null;
        }
        let standardTools = options.tools;
        let standardMessages = options.messages;
        
        if (this.isOpenAI() || this.isOpenRouter()) {
            // Convert the agent's legacy Claude-format tools and messages to the common format.
            standardTools = this.convertToolsFromClaudeFormat(options.tools);
            standardMessages = this.convertMessagesFromClaudeFormat(options.messages);
        }

        // Build the request
        const request: ModelRequest = {
            maxTokens: options.maxTokens || 20000,
            systemPrompt: options.systemPrompt,
            messages: standardMessages,
            tools: standardTools,
            thinking: options.thinking,
            temperature: options.temperature
        };

        // Invoke the provider
        return this.provider.invoke(request, options.signal);
    }

    /**
     * Convert tool results to the proper format for the next message
     */
    convertToolResultsToMessage(toolResults: ToolResult[]): Message {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }
        return this.provider.convertToolResultsToMessage(toolResults);
    }

    /**
     * Convert Claude-format tools to standard format
     * Handles both formats for backward compatibility
     */
    private convertToolsFromClaudeFormat(tools: any[]): ToolDefinition[] {
        return tools.map(tool => {
            // Check if already in standard format
            if (tool.inputSchema) {
                return tool as ToolDefinition;
            }

            // Convert from Claude format (input_schema)
            if (tool.input_schema) {
                return {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: {
                        type: tool.input_schema.type || 'object',
                        properties: tool.input_schema.properties || {},
                        required: tool.input_schema.required,
                        additionalProperties: tool.input_schema.additionalProperties
                    },
                    cacheControl: tool.cache_control
                };
            }

            // Convert from OpenAI format (function wrapper)
            if (tool.type === 'function' && tool.function) {
                return {
                    name: tool.function.name,
                    description: tool.function.description,
                    inputSchema: {
                        type: tool.function.parameters?.type || 'object',
                        properties: tool.function.parameters?.properties || {},
                        required: tool.function.parameters?.required,
                        additionalProperties: tool.function.parameters?.additionalProperties
                    }
                };
            }

            // Fallback - return as is
            return {
                name: tool.name,
                description: tool.description,
                inputSchema: {
                    type: 'object',
                    properties: tool.parameters?.properties || {},
                    required: tool.parameters?.required
                }
            };
        });
    }

    /**
     * Convert Claude-format messages to standard format
     */
    private convertMessagesFromClaudeFormat(messages: any[]): Message[] {
        return messages.map(msg => {
            // Handle string content
            if (typeof msg.content === 'string') {
                return {
                    role: msg.role,
                    content: msg.content
                } as Message;
            }

            // Handle array content (Claude format)
            if (Array.isArray(msg.content)) {
                const convertedContent: MessageContent[] = msg.content.map((item: any) => {
                    if (item.type === 'text') {
                        return {
                            type: 'text' as const,
                            text: item.text,
                            cacheControl: item.cache_control
                        };
                    }

                    if (item.type === 'image') {
                        return {
                            type: 'image' as const,
                            source: {
                                type: item.source?.type || 'base64',
                                mediaType: item.source?.media_type || 'image/png',
                                data: item.source?.data
                            }
                        };
                    }

                    if (item.type === 'tool_use') {
                        return {
                            type: 'tool_use' as const,
                            id: item.id,
                            name: item.name,
                            input: item.input
                        };
                    }

                    if (item.type === 'tool_result') {
                        return {
                            type: 'tool_result' as const,
                            toolUseId: item.tool_use_id,
                            content: typeof item.content === 'string' 
                                ? item.content 
                                : JSON.stringify(item.content),
                            isError: item.is_error
                        };
                    }

                    // Unknown type - pass through
                    return item;
                });

                return {
                    role: msg.role,
                    content: convertedContent
                } as Message;
            }

            // Fallback
            return msg as Message;
        });
    }

    /**
     * Get the underlying provider for advanced use cases
     */
    getProvider(): LLMProvider | null {
        return this.provider;
    }

    /**
     * Check if the provider supports thinking/reasoning
     */
    supportsThinking(): boolean {
        return this.provider?.supportsThinking() || false;
    }

    /**
     * Check if the provider supports caching
     */
    supportsCaching(): boolean {
        return this.provider?.supportsCaching() || false;
    }
}

export default LLMService;
