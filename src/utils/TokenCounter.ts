
/**
 * TokenCounter - Local token counting utility using js-tiktoken
 * 
 * Replaces the AWS Bedrock CountTokensCommand which has a 200k token limit
 * and doesn't work for OpenAI models. This provides accurate local token
 * counting with no API calls and no token limits.
 */

import { getEncoding, Tiktoken } from 'js-tiktoken';
import { createLogger } from './Logger';

const logger = createLogger('TokenCounter');

// Cache the encoder instance - it's expensive to create
let cachedEncoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
    if (!cachedEncoder) {
        // cl100k_base works well for both Claude and GPT-4/GPT-4o models
        // o200k_base is for newer OpenAI models but cl100k_base is a reasonable
        // universal approximation. The counts are close enough for compression decisions.
        cachedEncoder = getEncoding('cl100k_base');
    }
    return cachedEncoder;
}

// Strings shorter than this are encoded exactly; longer ones use sampling.
const EXACT_ENCODE_LIMIT = 30_000;
// Sample size used to estimate tokens-per-char ratio for long strings.
const SAMPLE_SIZE = 10_000;

/**
 * Count tokens in a string using tiktoken.
 * For strings > EXACT_ENCODE_LIMIT chars, samples a portion and extrapolates
 * the ratio to keep counting fast (< 20ms even for very large inputs).
 */
export function countStringTokens(text: string): number {
    if (!text) return 0;
    try {
        const encoder = getEncoder();
        if (text.length <= EXACT_ENCODE_LIMIT) {
            return encoder.encode(text).length;
        }
        // For large strings, sample from start, middle and end to get a
        // representative tokens-per-char ratio, then extrapolate.
        const third = Math.floor(SAMPLE_SIZE / 3);
        const mid = Math.floor(text.length / 2);
        const sample =
            text.slice(0, third) +
            text.slice(mid - Math.floor(third / 2), mid + Math.ceil(third / 2)) +
            text.slice(-third);
        const sampleTokens = encoder.encode(sample).length;
        const ratio = sampleTokens / sample.length;
        return Math.ceil(text.length * ratio);
    } catch (error) {
        // Fallback: rough estimate of ~4 chars per token
        logger.warn('Tiktoken encoding failed, using char-based estimate', { error });
        return Math.ceil(text.length / 4);
    }
}

/**
 * Count tokens for an entire conversation (messages array in Claude format)
 * This handles the full message structure including tool_use, tool_result, images, etc.
 */
export function countConversationTokens(
    messages: any[],
    systemPrompt?: string,
    tools?: any[]
): number {
    let totalTokens = 0;

    // Count system prompt tokens
    if (systemPrompt) {
        totalTokens += countStringTokens(systemPrompt);
        // Overhead for system message structure
        totalTokens += 4;
    }

    // Count tool definition tokens
    if (tools && tools.length > 0) {
        try {
            const toolsJson = JSON.stringify(tools);
            totalTokens += countStringTokens(toolsJson);
        } catch {
            // Fallback estimate: ~100 tokens per tool definition
            totalTokens += tools.length * 100;
        }
    }

    // Count message tokens
    for (const message of messages) {
        // Per-message overhead (role, structure)
        totalTokens += 4;

        if (typeof message.content === 'string') {
            totalTokens += countStringTokens(message.content);
        } else if (Array.isArray(message.content)) {
            for (const item of message.content) {
                totalTokens += countContentItemTokens(item);
            }
        }
    }

    // Final overhead for the conversation structure
    totalTokens += 3;

    return totalTokens;
}

/**
 * Count tokens for a single content item (text, tool_use, tool_result, image, etc.)
 */
function countContentItemTokens(item: any): number {
    if (!item) return 0;

    switch (item.type) {
        case 'text':
            return countStringTokens(item.text || '') + 4; // +4 for structure overhead

        case 'tool_use':
            let toolUseTokens = 4; // structure overhead
            toolUseTokens += countStringTokens(item.name || '');
            toolUseTokens += countStringTokens(item.id || '');
            if (item.input) {
                try {
                    const inputStr = typeof item.input === 'string'
                        ? item.input
                        : JSON.stringify(item.input);
                    toolUseTokens += countStringTokens(inputStr);
                } catch {
                    toolUseTokens += 50; // fallback estimate
                }
            }
            return toolUseTokens;

        case 'tool_result':
            let toolResultTokens = 4; // structure overhead
            toolResultTokens += countStringTokens(item.tool_use_id || '');
            if (typeof item.content === 'string') {
                toolResultTokens += countStringTokens(item.content);
            } else if (Array.isArray(item.content)) {
                for (const subItem of item.content) {
                    toolResultTokens += countContentItemTokens(subItem);
                }
            }
            return toolResultTokens;

        case 'image':
            // Images are converted to tokens by the API.
            // A rough estimate: most screenshots are 1000-2000 tokens.
            // The exact count depends on image size, but for compression
            // decisions this is good enough.
            return 1600;

        case 'thinking':
            return countStringTokens(item.thinking || '') + 4;

        default:
            // Unknown type - try to stringify
            try {
                return countStringTokens(JSON.stringify(item));
            } catch {
                return 10;
            }
    }
}

export default {
    countStringTokens,
    countConversationTokens
};
