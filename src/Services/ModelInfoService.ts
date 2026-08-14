import { getDBService } from '../DataAccessLayer/db-connection';
import * as ds from './../DataStructures';
import { LLMInfo } from '../DataAccessLayer/models/ModelInformation';
export async function setModelInfo()
{
    // this function is for sending data to mongodb and meant to be run in initialize()
    
    let dbservice =await getDBService();
    let modelInformationHandler = dbservice.ensureCollection('General','ModelInformation');
    let repo = dbservice.getRepository<LLMInfo>('General','ModelInformation');

    let result = await repo.insertMany([
        {
            modelKey: "Claude_Sonnet_45",
            modelId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
            price_per_input_token: 0.003,
            price_per_output_token: 0.015,
            price_per_input_batch: 0.0015,
            price_per_output_batch: 0.0075,
            price_cache_write: 0.00375,
            price_cache_read: 0.0003,
            max_input_tokens:2000000
    },
        {
            modelKey: "Amazon_titan_text_embeddings",
            modelId: "amazon.titan-embed-text-v2:0",
            price_per_input_token: 0.000027,
            price_per_output_token: 0,
            price_per_input_batch: 0,
            price_per_output_batch: 0,
            price_cache_write: 0,
            price_cache_read: 0,
            max_input_tokens:512000
        },
        {
            modelKey: "Claude_Opus_45",
            modelId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
            price_per_input_token: 0.003,
            price_per_output_token: 0.015,
            price_per_input_batch: 0.0015,
            price_per_output_batch: 0.0075,
            price_cache_write: 0.00375,
            price_cache_read: 0.0003,
            max_input_tokens:150000
        },
        {
            modelKey:"Claude_Opus_41",
            modelId: "us.anthropic.claude-opus-4-1-20250805-v1:0",
            price_per_input_token: 0.015,
            price_per_output_token: 0.075 ,
            price_per_input_batch: 0,
            price_per_output_batch: 0,
            price_cache_write: 0.01875,
            price_cache_read: 0.0015,
            max_input_tokens: 2000000
        },
        {
            modelKey:"Claude_Haiku_45",
            modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
            price_per_input_token: 0.0011,
            price_per_output_token: 0.0055 ,
            price_per_input_batch: 0.00055,
            price_per_output_batch: 0.00275,
            price_cache_write: 0.001375,
            price_cache_read: 0.00011,
            max_input_tokens:2000000

        }



    ])
    let a=3;
}
export async function getAllModelInfo()
{
    let dbService = await getDBService();
    let handler = dbService.getRepository<LLMInfo>('General','ModelInformation');

    return await handler.find();

}
export async function getModelInfo(key:string): Promise<LLMInfo | null> { // here we are expecting in the key  the name of the model, i.e the name of the modelwhich we have given.
    // here key is the modelKey i.e the name of the model in our db
    try
    {
    let dbService = await getDBService();
    let handler = dbService.getRepository<LLMInfo>('General','ModelInformation');

    const result = await handler.findOne({
        $or: [
            { modelKey: key },
            { displayName: key }
        ]
    } as any);
    
    if (!result) {
        return null;
    }
    
    // Remove MongoDB's _id field and return clean LLMInfo object
    const { _id, ...modelInfo } = result;
    return modelInfo as LLMInfo;
}
catch(error)
{
    console.error(`Error fetching model info for key ${key}:`, error);
    return null;
}
}