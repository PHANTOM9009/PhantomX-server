/**
 * Adaptive Compression Orchestrator
 * Determines and applies the optimal compression strategy based on token usage pressure
 */

import { AdvancedCompressionManager, CompressionConfig } from './compression-manager';
import { ConversationSummarizer } from './conversation-summarizer';
import { Logger } from '../utils/Logger';

const logger = new Logger('AdaptiveCompressor');

export interface AgentState {
    conversationHistory: any[];
    agentConversationHistory: any[];
    inputTokenCount: number;
    maxTokens: number;
    toolIdMap: Map<string, string>;
}

export enum CompressionLevel {
    NONE = 'none',
    PREVENTIVE = 'preventive',
    LIGHT = 'light',
    MEDIUM = 'medium',
    AGGRESSIVE = 'aggressive',
    CRISIS = 'crisis'
}

export class AdaptiveCompressor {
    private compressionManager: AdvancedCompressionManager;
    private conversationSummarizer: ConversationSummarizer;
    private config: CompressionConfig;

    constructor(
        conversationSummarizer: ConversationSummarizer,
        config?: Partial<CompressionConfig>
    ) {
        this.conversationSummarizer = conversationSummarizer;
        this.config = {
            preventiveThreshold: 0.3,
            lightThreshold: 0.5,
            mediumThreshold: 0.75,
            aggressiveThreshold: 0.9,
            preserveRecentMessages: 10,
            maxCommandOutputTokens: 2000,
            maxRAGResultTokens: 8000,
            maxFileReadTokens: 15000,
            ...config
        };
        this.compressionManager = new AdvancedCompressionManager(this.config);
    }

    /**
     * Get current compression level based on token usage
     */
    getCompressionLevel(tokenUsage: number): CompressionLevel {
        if (tokenUsage > this.config.aggressiveThreshold) {
            return CompressionLevel.CRISIS;
        } else if (tokenUsage > this.config.mediumThreshold) {
            return CompressionLevel.AGGRESSIVE;
        } else if (tokenUsage > this.config.lightThreshold) {
            return CompressionLevel.MEDIUM;
        } else if (tokenUsage > this.config.preventiveThreshold) {
            return CompressionLevel.LIGHT;
        } else {
            return CompressionLevel.NONE;
        }
    }

    /**
     * Apply adaptive compression based on current state
     */
    async applyAdaptiveCompression(state: AgentState): Promise<{
        conversationHistory: any[];
        agentConversationHistory: any[];
        didReset: boolean;
        level: CompressionLevel;
    }> {
        const tokenUsage = state.inputTokenCount / state.maxTokens;
        const level = this.getCompressionLevel(tokenUsage);

        logger.info('Applying adaptive compression', {
            tokenUsage: `${(tokenUsage * 100).toFixed(1)}%`,
            level,
            inputTokens: state.inputTokenCount,
            maxTokens: state.maxTokens
        });

        let didReset = false;

        // Always destroy tavily / RAG / browser results older than last 3 assistant
        // messages, regardless of compression level. These are the largest outputs
        // and have no value once the agent has acted on them.
        this.compressionManager.cleanAlwaysLargeToolResults(
            state.agentConversationHistory,
            state.toolIdMap
        );
        this.compressionManager.cleanAlwaysLargeToolResults(
            state.conversationHistory,
            state.toolIdMap
        );

        switch (level) {
            case CompressionLevel.CRISIS:
                await this.applyCrisisCompression(state);
                didReset = true;
                break;

            case CompressionLevel.AGGRESSIVE:
                await this.applyAggressiveCompression(state);
                break;

            case CompressionLevel.MEDIUM:
                await this.applyMediumCompression(state);
                break;

            case CompressionLevel.LIGHT:
                await this.applyLightCompression(state);
                break;

            case CompressionLevel.PREVENTIVE:
                await this.applyPreventiveCompression(state);
                break;

            default:
                // No compression needed
                break;
        }

        return {
            conversationHistory: state.conversationHistory,
            agentConversationHistory: state.agentConversationHistory,
            didReset,
            level
        };
    }

    /**
     * CRISIS Level (>90%): Full summarization + aggressive cleanup
     */
    private async applyCrisisCompression(state: AgentState): Promise<void> {
        logger.warn('CRISIS compression triggered - performing full reset');

        // Clean all tool results
        this.cleanAllToolResults(state.agentConversationHistory);

        // Generate LLM summary
        const summary = await this.conversationSummarizer.summarizeConversation(
            state.agentConversationHistory
        );

        // Also generate structured summary for key facts
        const structuredSummary = this.compressionManager.extractStructuredSummary(
            state.agentConversationHistory
        );
        const formattedSummary = this.compressionManager.formatStructuredSummary(structuredSummary);

        // Reset histories
        state.conversationHistory.length = 0;
        state.agentConversationHistory.length = 0;

        // Add combined summary as new starting point
        const summaryMessage = {
            role: 'user',
            content: [{
                type: 'text',
                text: `The previous agent session reached token limit. Here are two summaries of what happened:

=== LLM SUMMARY ===
${summary}

${formattedSummary}

Based on these summaries, analyze what went wrong and adjust your approach. Continue if the current approach seems viable, otherwise change strategy.`
            }]
        };

        state.agentConversationHistory.push(summaryMessage);

        logger.info('CRISIS compression completed - history reset with summary in agent history');
    }

    /**
     * AGGRESSIVE Level (75-90%): Structured summary + masking + aggressive tool cleanup
     */
    private async applyAggressiveCompression(state: AgentState): Promise<void> {
        logger.warn('AGGRESSIVE compression triggered');

        // 1. Clean all tool results in both histories to keep cache breakpoints aligned
        this.cleanAllToolResults(state.agentConversationHistory);
        this.cleanAllToolResults(state.conversationHistory);

        // 2. Mask old assistant messages (keep only tool calls) in both histories
        state.agentConversationHistory = this.compressionManager.maskOldMessages(
            state.agentConversationHistory,
            this.config.preserveRecentMessages
        );
        state.conversationHistory = this.compressionManager.maskOldMessages(
            state.conversationHistory,
            this.config.preserveRecentMessages
        );

        // 3. Generate structured summary of older messages and mirror replacement in both histories
        const oldMessagesCount = Math.max(0, state.agentConversationHistory.length - 20);
        if (oldMessagesCount > 10) {
            const oldMessages = state.agentConversationHistory.slice(0, oldMessagesCount);
            const structuredSummary = this.compressionManager.extractStructuredSummary(oldMessages);
            const formattedSummary = this.compressionManager.formatStructuredSummary(structuredSummary);

            const summaryMessage = {
                role: 'user',
                content: [{
                    type: 'text',
                    text: `Previous work summary:\n${formattedSummary}`
                }]
            };

            // Remove old messages and replace with summary in both arrays
            state.agentConversationHistory.splice(0, oldMessagesCount);
            state.conversationHistory.splice(0, Math.min(oldMessagesCount, state.conversationHistory.length));

            state.agentConversationHistory.unshift(summaryMessage);
            state.conversationHistory.unshift(JSON.parse(JSON.stringify(summaryMessage)));

            logger.info(`Replaced ${oldMessagesCount} old messages with structured summary in both histories`);
        }

        logger.info('AGGRESSIVE compression completed');
    }

    /**
     * MEDIUM Level (50-75%): Masking + selective tool cleanup
     */
    private async applyMediumCompression(state: AgentState): Promise<void> {
        logger.info('MEDIUM compression triggered');

        // 1. Clean selective tool results (browser, RAG, Tavily) in both histories
        state.agentConversationHistory = this.compressionManager.cleanSelectiveToolResults(
            state.agentConversationHistory,
            state.toolIdMap,
            this.config.preserveRecentMessages
        );
        state.conversationHistory = this.compressionManager.cleanSelectiveToolResults(
            state.conversationHistory,
            state.toolIdMap,
            this.config.preserveRecentMessages
        );

        // 2. Mask old assistant messages in both histories
        state.agentConversationHistory = this.compressionManager.maskOldMessages(
            state.agentConversationHistory,
            this.config.preserveRecentMessages
        );
        state.conversationHistory = this.compressionManager.maskOldMessages(
            state.conversationHistory,
            this.config.preserveRecentMessages
        );

        logger.info('MEDIUM compression completed');
    }

    /**
     * LIGHT Level (30-50%): Selective tool cleanup only
     */
    private async applyLightCompression(state: AgentState): Promise<void> {
        logger.info('LIGHT compression triggered');

        // Clean selective tool results (browser, RAG, Tavily, Jira) in both histories
        state.agentConversationHistory = this.compressionManager.cleanSelectiveToolResults(
            state.agentConversationHistory,
            state.toolIdMap,
            this.config.preserveRecentMessages
        );
        state.conversationHistory = this.compressionManager.cleanSelectiveToolResults(
            state.conversationHistory,
            state.toolIdMap,
            this.config.preserveRecentMessages
        );

        logger.info('LIGHT compression completed');
    }

    /**
     * PREVENTIVE Level (<30%): Just clean browser/RAG from older messages
     */
    private async applyPreventiveCompression(state: AgentState): Promise<void> {
        logger.info('PREVENTIVE compression triggered');

        // Only clean browser and RAG from messages older than 15 in both histories
        state.agentConversationHistory = this.compressionManager.cleanSelectiveToolResults(
            state.agentConversationHistory,
            state.toolIdMap,
            15 // More lenient preservation
        );
        state.conversationHistory = this.compressionManager.cleanSelectiveToolResults(
            state.conversationHistory,
            state.toolIdMap,
            15 // More lenient preservation
        );

        logger.info('PREVENTIVE compression completed');
    }

    /**
     * Clean all tool results from history
     */
    private cleanAllToolResults(history: any[]): void {
        for (const message of history) {
            if (message.role === 'user' && Array.isArray(message.content)) {
                message.content = message.content.map((item: any) => {
                    if (item.type === 'tool_result') {
                        return {
                            ...item,
                            content: 'This result has been removed to save context'
                        };
                    }
                    return item;
                });
            }
        }
    }

    /**
     * Compress tool result using smart strategies
     */
    compressToolResult(toolName: string, result: string): string {
        return this.compressionManager.compressToolResult(toolName, result);
    }

    /**
     * Get compression statistics
     */
    getStats(): any {
        return this.compressionManager.getStats();
    }

    /**
     * Get compression manager (for direct access if needed)
     */
    getCompressionManager(): AdvancedCompressionManager {
        return this.compressionManager;
    }
}

export default AdaptiveCompressor;
