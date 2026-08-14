import { Document, ObjectId } from 'mongodb';

export interface LLMInfo extends Document
{
    // all the prices are per 1000 input tokens
   
    modelKey:string; // this is the main key of the model.
    modelId:string;
    price_per_input_token: number;
    price_per_output_token: number;
    price_per_input_batch:number;
    price_per_output_batch:number;
    price_cache_write:number;
    price_cache_read:number;
    max_input_tokens?:number;
   
    azure_api_endpoint?:string; // this is the endpoint for the azure openAI agent.
    api_endpoint?: string; // Optional endpoint override for non-Azure providers.
    providerType?: 'claude_bedrock' | 'openai' | 'azure_openai' | 'openrouter'; // Provider type for this model
    displayName?: string;
    supportsTools?: boolean;
    supportsThinking?: boolean;
    supportsCaching?: boolean;
    supportsVision?: boolean;
    supportsParallelToolCalls?: boolean;
}

export enum available_models{
    // Claude models (via AWS Bedrock)
    gpt_53_codex = "gpt-5.3-codex",
    Claude_Sonnet_46 = "Claude Sonnet 4.6",
    Claude_Opus_46= "Claude Opus 4.6",
    Amazon_titan_text_embeddings= "Amazon_tital_text_embeddings",
    
   
    
    // New GPT models
    
    
   
    gpt_54_pro = "gpt-5.4-pro",
    gpt_55 = "gpt-5.5",
    gpt_56_sol = "gpt-5.6-sol",
    gpt_56_luna="gpt-5.6-luna",


}

/**
 * Provider type enum for model routing
 */
export enum ModelProviderType {
    CLAUDE_BEDROCK = 'claude_bedrock',
    OPENAI = 'openai',
    AZURE_OPENAI = 'azure_openai',
    OPENROUTER = 'openrouter'
}
