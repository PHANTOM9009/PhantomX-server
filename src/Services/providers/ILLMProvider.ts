/**
 * LLMProvider - Abstract interface for LLM providers (Claude, OpenAI, etc.)
 * 
 * This module provides a unified interface for different LLM providers,
 * handling the schema differences between Claude (Anthropic) and OpenAI APIs.
 */

import { LLMInfo } from '../../DataAccessLayer/models/ModelInformation';

// ================== Common Types ==================

/**
 * Standard tool definition that works with both Claude and OpenAI
 */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Record<string, any>;
        required?: string[];
        additionalProperties?: boolean;
    };
    cacheControl?: { type: string };
}

/**
 * Standard tool call from the model
 */
export interface ToolCall {
    id: string;
    name: string;
    input: Record<string, any>;
}

/**
 * Standard tool result to send back to the model
 */
export interface ToolResult {
    id: string;
    result: any;
    type: string; // 'text' or 'image'
    isError?: boolean;
}

/**
 * Standard message format for conversation history
 */
export interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: MessageContent[] | string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
}

export interface MessageContent {
    type: 'text' | 'image' | 'tool_use' | 'tool_result';
    text?: string;
    // For images
    source?: {
        type: string;
        mediaType?: string;
        data?: string;
        url?: string;
    };
    // For tool calls
    id?: string;
    name?: string;
    input?: Record<string, any>;
    // For tool results
    toolUseId?: string;
    content?: string;
    isError?: boolean;
    cacheControl?: { type: string };
}

/**
 * Standard request format for invoking the model
 */
export interface ModelRequest {
    maxTokens: number;
    systemPrompt: string;
    messages: Message[];
    tools: ToolDefinition[];
    thinking?: {
        enabled: boolean;
        budgetTokens?: number;
    };
    temperature?: number;
}

/**
 * Standard response format from the model
 */
export interface ModelResponse {
    toolUse: boolean;
    tools: ToolCall[];
    text: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
        totalTokens?: number;
    };
    stopReason: string;
    rawResponse?: any;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
    modelId: string;
    modelInfo: LLMInfo;
    region?: string;
    apiKey?: string;
    apiEndpoint?: string;
    appUrl?: string;
    appName?: string;
    providerType: ProviderType;
    credentials?: {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
    };
}

// ================== Abstract Provider Interface ==================

/**
 * Abstract base class for LLM providers
 * Each provider must implement these methods to handle their specific API formats
 */
export abstract class LLMProvider {
    protected config: ProviderConfig;
    protected modelId: string;
    protected modelInfo: LLMInfo;
    providerType:ProviderType;
    constructor(config: ProviderConfig) {
        this.config = config;
        this.providerType = config.providerType;
        this.modelId = config.modelId;
        this.modelInfo = config.modelInfo;
    }

    /**
     * Initialize the provider (establish connections, etc.)
     */
    abstract initialize(): Promise<void>;

    /**
     * Invoke the model with the given request
     */
    abstract invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse | null>;

    /**
     * Convert tool definitions to the provider's format
     */
    abstract convertToolsToProviderFormat(tools: ToolDefinition[]): any[];

    /**
     * Convert conversation history to the provider's format
     */
    abstract convertMessagesToProviderFormat(messages: Message[], systemPrompt?: string): any;

    /**
     * Convert tool results to the provider's message format
     */
    abstract convertToolResultsToMessage(toolResults: ToolResult[]): Message;

    /**
     * Parse the provider's response to standard format
     */
    abstract parseResponse(response: any): ModelResponse;

    /**
     * Get the provider name
     */
    abstract getProviderName(): string;

    /**
     * Check if the provider supports thinking/reasoning
     */
    abstract supportsThinking(): boolean;

    /**
     * Check if the provider supports caching
     */
    abstract supportsCaching(): boolean;
}

// ================== Provider Type Enum ==================

export enum ProviderType {
    CLAUDE_BEDROCK = 'claude_bedrock',
    OPENAI = 'openai',
    AZURE_OPENAI = 'azure_openai',
    OPENROUTER = 'openrouter'
}
