/**
 * Planner - Tool for generating task plans using LLM providers
 * 
 * This module uses the LLM provider abstraction to support both Claude and OpenAI models.
 */

import { LLMService } from './providers';
import { promises as fs } from 'fs';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
const pl = require('./prompt_library');

/**
 * Planner class that uses LLM to generate task plans
 * with thinking/reasoning capabilities.
 */
export class Planner {
    private llmService: LLMService;
    private modelName: string;
    private logFileName: string;
    private folderPath: string;
    
    /**
     * Creates a new Planner instance
     * @param modelName Model name to use (defaults to Claude Sonnet)
     * @param folderPath Path to save generated plans
     */
    constructor(modelName: string, folderPath: string) {
        this.modelName = modelName || 'Claude_Sonnet_45';
        this.folderPath = folderPath;
        
        // Initialize LLM service with the specified model
        this.llmService = new LLMService({
            modelKey: this.modelName,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID_AI,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_AI,
                sessionToken: process.env.AWS_SESSION_TOKEN
            }
        });
        
        // Generate unique log filename for this planning session
        this.logFileName = `Plan_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    }
    
    /**
     * Saves the generated plan to the plans directory
     * @param plan The generated plan to save
     */
    private async savePlan(plan: string): Promise<void> {
        try {
            const logsDir = path.join(this.folderPath, '.AIPlans');
            
            // Create logs directory if it doesn't exist
            if (!existsSync(logsDir)) {
                mkdirSync(logsDir, { recursive: true });
                console.log('Created Plans directory:', logsDir);
            }
            
            const logPath = path.join(logsDir, this.logFileName);
            await fs.writeFile(logPath, plan);
            console.log(`Plan saved to ${logPath}`);
        } catch (error) {
            console.error('Error saving Plan:', error);
        }
    }
    
    /**
     * Generates a plan using LLM with thinking capability
     * @param userQuery The user's query/task description
     * @returns A detailed plan for the task
     */
    async GeneratePlan(userQuery: string): Promise<string> {
        if (!userQuery || userQuery.length === 0) {
            return 'No user query to process.';
        }
        
        try {
            // Initialize the LLM service if not already done
            await this.llmService.initialize();
            
            // Check if the model supports thinking
            const supportsThinking = this.llmService.supportsThinking();
            
            // Prepare the messages for the LLM
            const messages = [
                {
                    role: 'user',
                    content: [{
                        type: 'text',
                        text: userQuery
                    }]
                }
            ];
            
            console.log('Sending plan generation request to LLM...');
            
            // Use the LLM service to invoke the model with thinking enabled
            const response = await this.llmService.invoke({
                maxTokens: 4000,
                systemPrompt: pl.get_planner_system_prompt(),
                messages: messages,
                tools: [], // No tools needed for planning
                thinking: supportsThinking ? {
                    enabled: true,
                    budgetTokens: 4000
                } : undefined
            });
            
            if (!response) {
                return 'Failed to get response from LLM.';
            }
            
            // Extract the plan text from the response
            const plan = response.text || 'Failed to generate Plan.';
            
            // Get thinking content if available (from raw response)
            let thinkingContent = '';
            if (response.rawResponse?.content) {
                const thinkingItem = response.rawResponse.content.find((item: any) => item.type === 'thinking');
                if (thinkingItem?.thinking) {
                    thinkingContent = thinkingItem.thinking;
                }
            }
            
            const finalPlan = thinkingContent 
                ? plan + '\n\nThinking Process:\n' + thinkingContent
                : plan;
            
            // Save the plan to a file
            await this.savePlan(finalPlan);
            
            return plan;
        } catch (error) {
            console.error('Error generating plan:', error);
            return `Error generating Plan: ${error}`;
        }
    }
}

export default Planner;
