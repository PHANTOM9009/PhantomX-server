/**
 * Conversation history summarizer using LLM providers
 * 
 * This module uses the LLM provider abstraction to support both Claude and OpenAI models.
 */

import { LLMService } from './providers';
import { promises as fs } from 'fs';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { Logger } from '../utils/Logger';
const pl = require('./prompt_library');

/**
 * ConversationSummarizer class that uses LLM to summarize conversation history
 * from agent interactions, including all operations performed like reading files,
 * editing code, and executing commands.
 */
export class ConversationSummarizer {
    private llmService: LLMService;
    private logFileName: string;
    private modelName: string;
    private logger:Logger = new Logger('ConversationSummarizer');
    /**
     * Creates a new ConversationSummarizer instance
     * @param modelName Optional model name to use (defaults to claude haiku)
     */
    constructor(modelName: string) {
        this.modelName = modelName || 'Claude_Haiku_45';
        
        // Initialize LLM service with the specified model
        // The service will auto-detect the provider based on model name
        this.llmService = new LLMService({
            modelKey: this.modelName,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID_AI,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_AI,
                sessionToken: process.env.AWS_SESSION_TOKEN
            }
        });
        
        // Set model ID based on provided model name or default
           
       
            
      
        
        // Generate unique log filename for this summarization session
        this.logFileName = `summary_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    }
    
    /**
     * Saves the generated summary to the logs directory
     * @param summary The conversation summary to save
     */
    private async saveSummary(summary: string): Promise<void> {
        try {
            const logsDir = path.join(process.cwd(), 'logs');
            
            // Create logs directory if it doesn't exist
            if (!existsSync(logsDir)) {
                mkdirSync(logsDir, { recursive: true });
                console.log('Created logs directory:', logsDir);
            }
            
            const logPath = path.join(logsDir, this.logFileName);
            await fs.writeFile(logPath, summary);
            console.log(`Summary saved to ${logPath}`);
        } catch (error) {
            console.error('Error saving summary:', error);
        }
    }
    
    /**
     * Summarizes a conversation history using LLM
     * @param conversationHistory The conversation history to summarize
     * @returns A detailed summary of the conversation with all operations enumerated
     */
    async summarizeConversation(conversationHistory: any[]): Promise<string> {
        if (!conversationHistory || conversationHistory.length === 0) {
            return 'No conversation history to summarize.';
        }
        
        try {
            // Initialize the LLM service if not already done
        await this.llmService.initialize();
            
            // Prepare the messages for the LLM
            const messages = [
                {
                    role: 'user',
                    content: [{
                        type: 'text',
                        text: `Please summarize the following conversation history, focusing on the operations performed and their outcomes:

${JSON.stringify(conversationHistory, null, 4)}`
                    }]
                }
            ];
            
            console.log('Sending summarization request to LLM...');
            
            // Use the LLM service to invoke the model
            const response = await this.llmService.invoke({
                maxTokens: 4000,
                temperature: 0.1,
                systemPrompt: pl.get_summarization_system_prompt(),
                messages: messages,
                tools: [] // No tools needed for summarization
            });
            
            if (!response) {
                return 'Failed to get response from LLM.';
            }
            
            // Extract the summary text from the response
            const summary = response.text || 'Failed to generate summary.';
            
            // Save the summary to a file (optional)
            // await this.saveSummary(summary);
            
            return summary;
        } catch (error) {
            console.error('Error summarizing conversation:', error);
            return `Error generating summary: ${error}`;
        }
    }
    
    /**
     * Loads a conversation history from a JSON file and summarizes it
     * @param filePath Path to the conversation history JSON file
     * @returns A detailed summary of the conversation
     */
    async summarizeFromFile(filePath: string): Promise<string> {
        try {
            // Read the conversation history file
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const conversationHistory = JSON.parse(fileContent);
            
            // Summarize the loaded conversation
            return await this.summarizeConversation(conversationHistory);
        } catch (error) {
            console.error(`Error loading or summarizing file ${filePath}:`, error);
            return `Error summarizing file ${filePath}: ${error}`;
        }
    }
}

export default ConversationSummarizer;
