/**
 * ProviderFactory - Factory class to create LLM provider instances
 * 
 * This factory determines the appropriate provider based on:
 * - Model ID/name
 * - Provider type configuration
 * - Environment variables
 */

import { LLMProvider, ProviderConfig, ProviderType, ToolDefinition } from './ILLMProvider';
import { ClaudeBedrockProvider } from './ClaudeBedrockProvider';
import { OpenAIProvider, AzureOpenAIProvider, OpenRouterProvider } from './OpenAIProvider';
import { LLMInfo } from '../../DataAccessLayer/models/ModelInformation';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('ProviderFactory');

/**
 * Mapping of model key patterns to provider types
 */
const MODEL_PROVIDER_MAP: { pattern: RegExp; provider: ProviderType }[] = [
    { pattern: /^OpenRouter_/i, provider: ProviderType.OPENROUTER },
    { pattern: /^openrouter\//i, provider: ProviderType.OPENROUTER },
    { pattern: /^Claude_/i, provider: ProviderType.CLAUDE_BEDROCK },
    { pattern: /^anthropic\./i, provider: ProviderType.CLAUDE_BEDROCK },
    { pattern: /^gpt-/i, provider: ProviderType.AZURE_OPENAI },
    { pattern: /^o1-/i, provider: ProviderType.AZURE_OPENAI },
    { pattern: /^o3-/i, provider: ProviderType.AZURE_OPENAI },
    { pattern: /^o4-/i, provider: ProviderType.AZURE_OPENAI },
    { pattern: /^azure-/i, provider: ProviderType.AZURE_OPENAI }
];

export interface ProviderFactoryOptions {
    modelKey: string;
    modelId: string;
    modelInfo: LLMInfo;
    providerType?: ProviderType;
    region?: string;
    apiKey?: string;
    apiEndpoint?: string;
    appUrl?: string;
    appName?: string;
    credentials?: {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
    };
}

export class ProviderFactory {
    /**
     * Create a provider instance based on the options
     */
    static createProvider(options: ProviderFactoryOptions): LLMProvider {
        const providerType = options.providerType
            || (options.modelInfo.providerType as ProviderType | undefined)
            || this.detectProviderType(options.modelKey, options.modelId);
        
        const config: ProviderConfig = {
            modelId: options.modelId,
            providerType:providerType,
            modelInfo: options.modelInfo,
            region: options.region,
            apiKey: options.apiKey,
            apiEndpoint: options.apiEndpoint,
            appUrl: options.appUrl,
            appName: options.appName,
            credentials: options.credentials
        };

        logger.info('Creating LLM provider', { 
            providerType, 
            modelKey: options.modelKey, 
            modelId: options.modelId 
        });

        switch (providerType) {
            case ProviderType.CLAUDE_BEDROCK:
                return new ClaudeBedrockProvider(config);
            
            case ProviderType.OPENAI:
                return new OpenAIProvider(config);
            
            case ProviderType.AZURE_OPENAI:
                return new AzureOpenAIProvider(config);

            case ProviderType.OPENROUTER:
                return new OpenRouterProvider(config);
            
            default:
                throw new Error(`Unsupported LLM provider type: ${String(providerType)}`);
        }
    }

    /**
     * Detect the provider type from model key/id
     */
    static detectProviderType(modelKey: string, modelId: string): ProviderType {
        // Check model key first
        for (const mapping of MODEL_PROVIDER_MAP) {
            if (mapping.pattern.test(modelKey)) {
                return mapping.provider;
            }
        }

        // Check model id
        for (const mapping of MODEL_PROVIDER_MAP) {
            if (mapping.pattern.test(modelId)) {
                return mapping.provider;
            }
        }

        // Check environment variable for default provider
        const defaultProvider = process.env.DEFAULT_LLM_PROVIDER;
        if (defaultProvider) {
            const providerType = defaultProvider.toLowerCase() as ProviderType;
            if (Object.values(ProviderType).includes(providerType)) {
                return providerType;
            }
        }

        // Default to Claude Bedrock
        return ProviderType.CLAUDE_BEDROCK;
    }

    /**
     * Check if a model key/id uses Claude provider
     */
    static isClaude(modelKey: string, modelId: string): boolean {
        return this.detectProviderType(modelKey, modelId) === ProviderType.CLAUDE_BEDROCK;
    }

    /**
     * Check if a model key/id uses OpenAI provider
     */
    static isOpenAI(modelKey: string, modelId: string): boolean {
        const provider = this.detectProviderType(modelKey, modelId);
        return provider === ProviderType.OPENAI || provider === ProviderType.AZURE_OPENAI;
    }


    /**
     * Check if a model key/id uses OpenRouter.
     */
    static isOpenRouter(modelKey: string, modelId: string): boolean {
        return this.detectProviderType(modelKey, modelId) === ProviderType.OPENROUTER;
    }


    /**
     * Convert tools from Claude's input_schema format to standard format
     * This is useful when tools are defined in the existing Claude format
     */
    static convertClaudeToolsToStandard(claudeTools: any[]): ToolDefinition[] {
        return claudeTools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: {
                type: tool.input_schema?.type || 'object',
                properties: tool.input_schema?.properties || {},
                required: tool.input_schema?.required,
                additionalProperties: tool.input_schema?.additionalProperties
            },
            cacheControl: tool.cache_control
        }));
    }

    /**
     * Convert tools from OpenAI's function format to standard format
     */
    static convertOpenAIToolsToStandard(openaiTools: any[]): ToolDefinition[] {
        return openaiTools.map(tool => {
            const func = tool.function || tool;
            return {
                name: func.name,
                description: func.description,
                inputSchema: {
                    type: func.parameters?.type || 'object',
                    properties: func.parameters?.properties || {},
                    required: func.parameters?.required,
                    additionalProperties: func.parameters?.additionalProperties
                }
            };
        });
    }
}

// Export all provider-related types and classes for convenience
export * from './ILLMProvider';
export { ClaudeBedrockProvider } from './ClaudeBedrockProvider';
export { OpenAIProvider, AzureOpenAIProvider, OpenRouterProvider } from './OpenAIProvider';


/**
 * Lightweight provider regression checks. Run directly with:
 * `npx ts-node src/Services/providers/ProviderFactory.ts`
 */
async function runProviderRegressionChecks(): Promise<void> {
    const assert = (condition: boolean, message: string): void => {
        if (!condition) {
            throw new Error(`Provider regression check failed: ${message}`);
        }
    };
    const modelInfo = {
        modelKey: 'OpenRouter_Test',
        modelId: 'deepseek/deepseek-chat',
        providerType: 'openrouter',
        price_per_input_token: 0,
        price_per_output_token: 0,
        price_per_input_batch: 0,
        price_per_output_batch: 0,
        price_cache_write: 0,
        price_cache_read: 0,
        supportsTools: true,
        supportsThinking: false
    } as LLMInfo;

    assert(
        ProviderFactory.detectProviderType('Claude_Sonnet_46', 'anthropic.claude') === ProviderType.CLAUDE_BEDROCK,
        'Claude routing changed'
    );
    assert(
        ProviderFactory.detectProviderType('gpt-4o', 'gpt-4o') === ProviderType.AZURE_OPENAI,
        'Azure OpenAI routing changed'
    );
    assert(
        ProviderFactory.detectProviderType('OpenRouter_Test', modelInfo.modelId) === ProviderType.OPENROUTER,
        'OpenRouter key routing failed'
    );

    const provider = ProviderFactory.createProvider({
        modelKey: modelInfo.modelKey,
        modelId: modelInfo.modelId,
        modelInfo,
        apiKey: 'test-key'
    }) as OpenRouterProvider;
    assert(provider.getProviderName() === 'openrouter', 'Factory did not create OpenRouterProvider');

    const tools = provider.convertToolsToProviderFormat([{
        name: 'execute_command',
        description: 'Execute a command',
        inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
        }
    }]);
    assert(tools[0]?.function?.parameters?.required?.[0] === 'command', 'Tool conversion failed');

    const response = provider.parseResponse({
        choices: [{
            message: {
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'execute_command', arguments: '{"command":"pwd"}' }
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    assert(response.toolUse && response.tools[0]?.input?.command === 'pwd', 'Tool response parsing failed');
    assert(response.usage.totalTokens === 15, 'Usage parsing failed');

    const convertedMessages = provider.convertMessagesToProviderFormat([{
        role: 'assistant',
        content: [{
            type: 'tool_use',
            id: 'call_1',
            name: 'execute_command',
            input: { command: 'pwd' }
        }]
    }, {
        role: 'user',
        content: [{
            type: 'tool_result',
            toolUseId: 'call_1',
            content: '/app'
        }]
    }], 'You are a coding assistant.');
    assert(convertedMessages[0]?.role === 'system', 'System message conversion failed');
    assert(convertedMessages[1]?.tool_calls?.[0]?.id === 'call_1', 'Assistant tool call conversion failed');
    assert(convertedMessages[2]?.tool_call_id === 'call_1', 'Tool result conversion failed');

    let missingKeyRejected = false;
    try {
        ProviderFactory.createProvider({
            modelKey: modelInfo.modelKey,
            modelId: modelInfo.modelId,
            modelInfo
        });
    } catch (error) {
        missingKeyRejected = error instanceof Error && error.message.includes('OpenRouter API key is required');
    }
    assert(missingKeyRejected, 'Missing OpenRouter key was not rejected');

    const malformed = provider.parseResponse({
        choices: [{
            message: {
                tool_calls: [{
                    id: 'call_2',
                    function: { name: 'execute_command', arguments: '{invalid' }
                }]
            }
        }]
    });
    assert(malformed.tools[0]?.input?.raw === '{invalid', 'Malformed arguments were not preserved');

    const abortController = new AbortController();
    abortController.abort();
    const abortedResponse = await provider.invoke({
        maxTokens: 10,
        systemPrompt: '',
        messages: [],
        tools: []
    }, abortController.signal);
    assert(abortedResponse === null, 'Pre-aborted request did not return null');

    console.log('OpenRouter provider regression checks passed');
}

if (require.main === module) {
    runProviderRegressionChecks().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
