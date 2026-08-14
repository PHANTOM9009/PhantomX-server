/**
 * Advanced Compression Manager for Agent Context
 * Implements multi-tier compression strategies to optimize token usage
 * while maintaining quality and context coherence.
 */

import { Logger } from '../utils/Logger';

const logger = new Logger('CompressionManager');

export interface CompressionMetrics {
    tokensBefore: number;
    tokensAfter: number;
    compressionRatio: number;
    method: 'masking' | 'truncation' | 'summarization' | 'structured' | 'smart_truncation';
    qualityScore?: number;
    costSaved: number;
    timestamp: Date;
}

export interface StructuredSummary {
    filesModified: string[];
    commandsRun: string[];
    errorsEncountered: string[];
    decisionsMade: string[];
    unresolvedIssues: string[];
    toolsUsed: Map<string, number>;
}

export interface CompressionConfig {
    preventiveThreshold: number;      // 0.3 (30%)
    lightThreshold: number;           // 0.5 (50%)
    mediumThreshold: number;          // 0.75 (75%)
    aggressiveThreshold: number;      // 0.9 (90%)
    preserveRecentMessages: number;   // 10
    maxCommandOutputTokens: number;   // 2000
    maxRAGResultTokens: number;       // 8000
    maxFileReadTokens: number;        // 15000
}

export class AdvancedCompressionManager {
    private metrics: CompressionMetrics[] = [];
    private config: CompressionConfig;
    private tokenPricePerThousand: number = 0.015; // Claude Sonnet pricing

    constructor(config?: Partial<CompressionConfig>) {
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
    }

    /**
     * Estimate token count (rough estimation: 1 token ≈ 4 characters)
     */
    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    /**
     * Calculate cost saved from compression
     */
    private calculateCostSaved(tokensBefore: number, tokensAfter: number): number {
        const tokensSaved = tokensBefore - tokensAfter;
        return (tokensSaved / 1000) * this.tokenPricePerThousand;
    }

    /**
     * Log compression metrics
     */
    private logMetrics(metric: CompressionMetrics): void {
        this.metrics.push(metric);
        logger.info('Compression applied', {
            method: metric.method,
            ratio: `${metric.compressionRatio.toFixed(2)}x`,
            tokensBefore: metric.tokensBefore,
            tokensAfter: metric.tokensAfter,
            saved: `$${metric.costSaved.toFixed(4)}`
        });
    }

    /**
     * Tier 1: Context Masking (removes thinking/text from old assistant messages)
     * Very fast, 30-50% reduction, minimal quality loss
     */
    maskOldMessages(history: any[], preserveRecent: number = 10): any[] {
        const startTime = Date.now();
        let tokensBefore = 0;
        let tokensAfter = 0;

        const maskedHistory = history.map((msg, index) => {
            const shouldMask = index < history.length - preserveRecent;
            const msgCopy = JSON.parse(JSON.stringify(msg));
            
            tokensBefore += this.estimateTokens(JSON.stringify(msg));

            if (shouldMask && msg.role === 'assistant' && Array.isArray(msg.content)) {
                // Keep only tool_use, remove thinking and text content
                msgCopy.content = msg.content.filter((item: any) =>
                    item.type === 'tool_use'
                );
            }

            tokensAfter += this.estimateTokens(JSON.stringify(msgCopy));
            return msgCopy;
        });

        const metric: CompressionMetrics = {
            tokensBefore,
            tokensAfter,
            compressionRatio: tokensBefore / tokensAfter,
            method: 'masking',
            costSaved: this.calculateCostSaved(tokensBefore, tokensAfter),
            timestamp: new Date()
        };

        this.logMetrics(metric);
        logger.info(`Masking completed in ${Date.now() - startTime}ms`);

        return maskedHistory;
    }

    /**
     * Tier 2: Smart Tool Result Compression
     * Applies different strategies based on tool type
     */
    compressToolResult(toolName: string, result: string, toolId?: string): string {
        const tokensBefore = this.estimateTokens(result);
        let compressed = result;

        try {
            if (toolName === 'Execute_commmand' || toolName === 'Execute_commmand_host_machine') {
                compressed = this.compressCommandOutput(result, this.config.maxCommandOutputTokens);
            } else if (toolName === 'ReadFile') {
                compressed = this.compressFileContent(result, this.config.maxFileReadTokens);
            } else if (toolName === 'RAG') {
                compressed = this.compressRAGResult(result, this.config.maxRAGResultTokens);
            } else if (toolName.toLowerCase().includes('browser')) {
                compressed = this.compressBrowserOutput(result, 5000);
            } else if (toolName.toLowerCase().includes('tavily')) {
                compressed = this.compressWebSearchResult(result, 6000);
            } else {
                // Generic compression for unknown tools
                const maxTokens = 5000;
                if (tokensBefore > maxTokens) {
                    const maxChars = maxTokens * 4;
                    compressed = result.substring(0, maxChars) + 
                        `\n... [Result truncated: ${tokensBefore} tokens → ${maxTokens} tokens]`;
                }
            }

            const tokensAfter = this.estimateTokens(compressed);
            if (tokensBefore !== tokensAfter) {
                const metric: CompressionMetrics = {
                    tokensBefore,
                    tokensAfter,
                    compressionRatio: tokensBefore / tokensAfter,
                    method: 'smart_truncation',
                    costSaved: this.calculateCostSaved(tokensBefore, tokensAfter),
                    timestamp: new Date()
                };
                this.logMetrics(metric);
            }
        } catch (error) {
            logger.error('Error in compressToolResult', { error, toolName });
            // Return original on error
            return result;
        }

        return compressed;
    }

    /**
     * Smart command output compression: Keep head + tail + errors
     */
    private compressCommandOutput(output: string, maxTokens: number): string {
        const lines = output.split('\n');
        const totalTokens = this.estimateTokens(output);

        if (totalTokens <= maxTokens) {
            return output;
        }

        // Extract errors (high priority)
        const errorLines = lines.filter(line => 
            /error|failed|exception|fatal|warning/i.test(line)
        );

        // Calculate how many lines we can keep
        const headLines = Math.min(50, Math.floor(lines.length * 0.2));
        const tailLines = Math.min(50, Math.floor(lines.length * 0.2));

        const head = lines.slice(0, headLines);
        const tail = lines.slice(-tailLines);
        const omittedCount = lines.length - headLines - tailLines;

        const parts: string[] = [];
        parts.push(head.join('\n'));
        
        if (errorLines.length > 0 && omittedCount > 0) {
            parts.push('\n--- ERRORS/WARNINGS FOUND ---');
            parts.push(errorLines.slice(0, 20).join('\n')); // Max 20 error lines
        }
        
        if (omittedCount > 0) {
            parts.push(`\n... [${omittedCount} lines omitted] ...`);
        }
        
        parts.push(tail.join('\n'));

        return parts.join('\n');
    }

    /**
     * Compress file content: Keep structure, reduce body
     */
    private compressFileContent(content: string, maxTokens: number): string {
        const totalTokens = this.estimateTokens(content);

        if (totalTokens <= maxTokens) {
            return content;
        }

        // Try to parse JSON first
        try {
            const parsed = JSON.parse(content);
            return this.compressJSON(parsed, maxTokens);
        } catch {
            // Not JSON, treat as code/text
            return this.compressCodeFile(content, maxTokens);
        }
    }

    /**
     * Compress JSON by keeping structure, sampling values
     */
    private compressJSON(obj: any, maxTokens: number): string {
        const compressed = this.recursiveJSONCompress(obj, 3); // Max depth 3
        return JSON.stringify(compressed, null, 2);
    }

    private recursiveJSONCompress(obj: any, maxDepth: number, currentDepth: number = 0): any {
        if (currentDepth >= maxDepth) {
            return Array.isArray(obj) ? '[...]' : '{...}';
        }

        if (Array.isArray(obj)) {
            if (obj.length <= 5) {
                return obj.map(item => this.recursiveJSONCompress(item, maxDepth, currentDepth + 1));
            }
            // Keep first 3 and last 2 items
            return [
                ...obj.slice(0, 3).map(item => this.recursiveJSONCompress(item, maxDepth, currentDepth + 1)),
                `... ${obj.length - 5} items omitted ...`,
                ...obj.slice(-2).map(item => this.recursiveJSONCompress(item, maxDepth, currentDepth + 1))
            ];
        }

        if (typeof obj === 'object' && obj !== null) {
            const compressed: any = {};
            const keys = Object.keys(obj);
            
            if (keys.length <= 10) {
                keys.forEach(key => {
                    compressed[key] = this.recursiveJSONCompress(obj[key], maxDepth, currentDepth + 1);
                });
            } else {
                // Keep first 8 keys and indicate omission
                keys.slice(0, 8).forEach(key => {
                    compressed[key] = this.recursiveJSONCompress(obj[key], maxDepth, currentDepth + 1);
                });
                compressed['...'] = `${keys.length - 8} keys omitted`;
            }
            
            return compressed;
        }

        return obj;
    }

    /**
     * Compress code file: Extract structure
     */
    private compressCodeFile(content: string, maxTokens: number): string {
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Keep imports, class/function signatures, type definitions
        const importantLines: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Keep these patterns
            if (
                line.startsWith('import ') ||
                line.startsWith('export ') ||
                line.startsWith('class ') ||
                line.startsWith('interface ') ||
                line.startsWith('type ') ||
                line.startsWith('function ') ||
                line.startsWith('async function ') ||
                line.startsWith('const ') ||
                /^(public|private|protected)\s/.test(line)
            ) {
                importantLines.push(lines[i]);
            }
        }

        if (importantLines.length > 0 && this.estimateTokens(importantLines.join('\n')) < maxTokens) {
            return importantLines.join('\n') + '\n\n// ... [function bodies omitted] ...';
        }

        // Fallback: head + tail
        const headLines = Math.min(100, Math.floor(totalLines * 0.3));
        const tailLines = Math.min(100, Math.floor(totalLines * 0.3));
        
        return [
            ...lines.slice(0, headLines),
            `\n... [${totalLines - headLines - tailLines} lines omitted] ...\n`,
            ...lines.slice(-tailLines)
        ].join('\n');
    }

    /**
     * Compress RAG results: Keep most relevant chunks
     */
    private compressRAGResult(result: string, maxTokens: number): string {
        const totalTokens = this.estimateTokens(result);

        if (totalTokens <= maxTokens) {
            return result;
        }

        try {
            const parsed = JSON.parse(result);
            
            if (Array.isArray(parsed)) {
                // Assume array of search results, keep top ones
                const kept = parsed.slice(0, 5);
                const omitted = parsed.length - kept.length;
                
                return JSON.stringify({
                    results: kept,
                    note: `Kept top 5 results. ${omitted} results omitted.`
                }, null, 2);
            }
        } catch {
            // Not JSON, simple truncation
        }

        const maxChars = maxTokens * 4;
        return result.substring(0, maxChars) + '\n... [RAG result truncated]';
    }

    /**
     * Compress browser output
     */
    private compressBrowserOutput(output: string, maxTokens: number): string {
        const totalTokens = this.estimateTokens(output);

        if (totalTokens <= maxTokens) {
            return output;
        }

        const maxChars = maxTokens * 4;
        return output.substring(0, maxChars) + '\n... [Browser output truncated]';
    }

    /**
     * Compress web search results
     */
    private compressWebSearchResult(result: string, maxTokens: number): string {
        const totalTokens = this.estimateTokens(result);

        if (totalTokens <= maxTokens) {
            return result;
        }

        try {
            const parsed = JSON.parse(result);
            
            if (parsed.results && Array.isArray(parsed.results)) {
                // Keep top 5 search results
                parsed.results = parsed.results.slice(0, 5);
                return JSON.stringify(parsed, null, 2);
            }
        } catch {
            // Fallback
        }

        const maxChars = maxTokens * 4;
        return result.substring(0, maxChars) + '\n... [Search results truncated]';
    }

    /**
     * Tier 3: Extract structured summary from conversation
     */
    extractStructuredSummary(messages: any[]): StructuredSummary {
        const summary: StructuredSummary = {
            filesModified: [],
            commandsRun: [],
            errorsEncountered: [],
            decisionsMade: [],
            unresolvedIssues: [],
            toolsUsed: new Map()
        };

        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.content) {
                for (const item of msg.content) {
                    // Track tool usage
                    if (item.type === 'tool_use') {
                        const count = summary.toolsUsed.get(item.name) || 0;
                        summary.toolsUsed.set(item.name, count + 1);

                        // Extract file modifications
                        if (item.name === 'EditCodeFile' && item.input?.edits) {
                            for (const edit of item.input.edits) {
                                if (edit.filePath && !summary.filesModified.includes(edit.filePath)) {
                                    summary.filesModified.push(edit.filePath);
                                }
                            }
                        }

                        // Extract commands
                        if ((item.name === 'Execute_commmand' || item.name === 'Execute_commmand_host_machine') 
                            && item.input?.command) {
                            summary.commandsRun.push(item.input.command);
                        }
                    }

                    // Extract text decisions
                    if (item.type === 'text' && item.text) {
                        // Look for error patterns
                        if (/error|failed|exception/i.test(item.text)) {
                            const errorMatch = item.text.match(/error[^.!?]*[.!?]/i);
                            if (errorMatch) {
                                summary.errorsEncountered.push(errorMatch[0]);
                            }
                        }
                    }
                }
            }

            // Look for user-reported issues
            if (msg.role === 'user' && msg.content) {
                for (const item of msg.content) {
                    if (item.type === 'text' && /not working|issue|problem|bug/i.test(item.text)) {
                        summary.unresolvedIssues.push(item.text.substring(0, 200));
                    }
                }
            }
        }

        return summary;
    }

    /**
     * Format structured summary as string
     */
    formatStructuredSummary(summary: StructuredSummary): string {
        const parts: string[] = [
            '=== CONVERSATION SUMMARY ===\n'
        ];

        if (summary.filesModified.length > 0) {
            parts.push(`Files Modified (${summary.filesModified.length}):`);
            parts.push(summary.filesModified.slice(0, 20).join('\n'));
            if (summary.filesModified.length > 20) {
                parts.push(`... and ${summary.filesModified.length - 20} more files`);
            }
            parts.push('');
        }

        if (summary.commandsRun.length > 0) {
            parts.push(`Commands Executed (${summary.commandsRun.length}):`);
            parts.push(summary.commandsRun.slice(0, 10).join('\n'));
            if (summary.commandsRun.length > 10) {
                parts.push(`... and ${summary.commandsRun.length - 10} more commands`);
            }
            parts.push('');
        }

        if (summary.errorsEncountered.length > 0) {
            parts.push('Errors Encountered:');
            parts.push(summary.errorsEncountered.slice(0, 5).join('\n'));
            parts.push('');
        }

        if (summary.toolsUsed.size > 0) {
            parts.push('Tools Used:');
            const toolStats = Array.from(summary.toolsUsed.entries())
                .map(([tool, count]) => `  ${tool}: ${count}x`)
                .join('\n');
            parts.push(toolStats);
            parts.push('');
        }

        if (summary.unresolvedIssues.length > 0) {
            parts.push('Unresolved Issues:');
            parts.push(summary.unresolvedIssues.slice(0, 3).join('\n'));
            parts.push('');
        }

        parts.push('=== END SUMMARY ===');

        return parts.join('\n');
    }

    /**
     * Get compression statistics
     */
    getStats(): any {
        if (this.metrics.length === 0) {
            return {
                totalCompressions: 0,
                averageRatio: 0,
                totalCostSaved: 0,
                totalTokensSaved: 0
            };
        }

        const totalCostSaved = this.metrics.reduce((sum, m) => sum + m.costSaved, 0);
        const totalTokensSaved = this.metrics.reduce((sum, m) => 
            sum + (m.tokensBefore - m.tokensAfter), 0);
        const averageRatio = this.metrics.reduce((sum, m) => 
            sum + m.compressionRatio, 0) / this.metrics.length;

        const methodBreakdown = this.metrics.reduce((acc: any, m) => {
            acc[m.method] = (acc[m.method] || 0) + 1;
            return acc;
        }, {});

        return {
            totalCompressions: this.metrics.length,
            averageRatio: averageRatio.toFixed(2),
            totalCostSaved: totalCostSaved.toFixed(4),
            totalTokensSaved,
            methodBreakdown
        };
    }

    /**
     * Clean selective tool results based on per-tool-type recency policy:
     * - File tools (ReadFile, EditCodeFile): preserve outputs linked to tool_use calls
     *   in the last 10 assistant messages; clean the rest.
     * - Command/RAG/Browser/Tavily tools: preserve outputs linked to tool_use calls
     *   in the last 3 assistant messages; clean the rest.
     * Other tool types are left untouched.
     */
    cleanSelectiveToolResults(
        history: any[],
        toolIdMap: Map<string, string>,
        _preserveRecent: number = 10
    ): any[] {
        let cleaned = 0;

        const isFileTool = (name: string): boolean => {
            const n = name.toLowerCase();
            return n === 'readfile' || n === 'editcodefile';
        };

        const isHeavyTool = (name: string): boolean => {
            const n = name.toLowerCase();
            return (
                n === 'execute_commmand' ||
                n === 'execute_commmand_host_machine' ||
                n === 'rag' ||
                n.includes('browser') ||
                n.includes('tavily')
            );
        };

        // Build a map of tool_use_id -> tool name by scanning assistant messages.
        // toolIdMap may already have entries; this supplements it from inline tool_use items.
        const resolvedName = (toolUseId: string): string => {
            if (toolIdMap.has(toolUseId)) return toolIdMap.get(toolUseId)!;
            for (const msg of history) {
                if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                    for (const item of msg.content) {
                        if (item?.type === 'tool_use' && item?.id === toolUseId) {
                            return item.name || '';
                        }
                    }
                }
            }
            return '';
        };

        // Collect preserved tool_use IDs by scanning the last N assistant messages.
        const collectPreservedIds = (windowSize: number, matcher: (n: string) => boolean): Set<string> => {
            const ids = new Set<string>();
            let seen = 0;
            for (let i = history.length - 1; i >= 0 && seen < windowSize; i--) {
                const msg = history[i];
                if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
                seen++;
                for (const item of msg.content) {
                    if (item?.type === 'tool_use' && item?.id && matcher(item.name || '')) {
                        ids.add(item.id);
                    }
                }
            }
            return ids;
        };

        const preservedFileIds  = collectPreservedIds(10, isFileTool);
        const preservedHeavyIds = collectPreservedIds(3,  isHeavyTool);

        for (const message of history) {
            if (message.role !== 'user' || !Array.isArray(message.content)) continue;

            message.content = message.content.map((item: any) => {
                if (item.type !== 'tool_result' || !item.tool_use_id) return item;

                const name = resolvedName(item.tool_use_id);

                if (isFileTool(name) && !preservedFileIds.has(item.tool_use_id)) {
                    cleaned++;
                    return { ...item, content: 'This result has been removed to save context' };
                }

                if (isHeavyTool(name) && !preservedHeavyIds.has(item.tool_use_id)) {
                    cleaned++;
                    return { ...item, content: 'This result has been removed to save context' };
                }

                return item;
            });
        }

        if (cleaned > 0) {
            logger.info(`Cleaned ${cleaned} selective tool results from history`);
        }

        return history;
    }

    /**
     * Always-run cleanup: destroy RAG, browser, and tavily tool results
     * that are linked to tool_use calls outside the last 3 assistant messages.
     * This runs unconditionally on every turn regardless of token pressure.
     */
    cleanAlwaysLargeToolResults(
        history: any[],
        toolIdMap: Map<string, string>
    ): void {
        const isLargeTool = (name: string): boolean => {
            const n = name.toLowerCase();
            return n === 'rag' || n.includes('browser') || n.includes('tavily');
        };

        // Resolve tool name from toolIdMap or inline assistant tool_use items.
        const resolvedName = (toolUseId: string): string => {
            if (toolIdMap.has(toolUseId)) return toolIdMap.get(toolUseId)!;
            for (const msg of history) {
                if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                    for (const item of msg.content) {
                        if (item?.type === 'tool_use' && item?.id === toolUseId) {
                            return item.name || '';
                        }
                    }
                }
            }
            return '';
        };

        // Collect tool_use IDs of large tools from the last 3 assistant messages.
        const preservedIds = new Set<string>();
        let seen = 0;
        for (let i = history.length - 1; i >= 0 && seen < 3; i--) {
            const msg = history[i];
            if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
            seen++;
            for (const item of msg.content) {
                if (item?.type === 'tool_use' && item?.id && isLargeTool(item.name || '')) {
                    preservedIds.add(item.id);
                }
            }
        }

        let cleaned = 0;
        for (const message of history) {
            if (message.role !== 'user' || !Array.isArray(message.content)) continue;
            message.content = message.content.map((item: any) => {
                if (
                    item.type === 'tool_result' &&
                    item.tool_use_id &&
                    isLargeTool(resolvedName(item.tool_use_id)) &&
                    !preservedIds.has(item.tool_use_id)
                ) {
                    cleaned++;
                    return { ...item, content: 'This result has been removed to save context' };
                }
                return item;
            });
        }

        if (cleaned > 0) {
            logger.info(`Always-run cleanup: removed ${cleaned} large tool results (RAG/browser/tavily)`);
        }
    }
}

export default AdvancedCompressionManager;
