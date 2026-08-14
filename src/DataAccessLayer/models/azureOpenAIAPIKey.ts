import * as dotenv from 'dotenv';
dotenv.config();
export const AZURE_OPENAI_API_KEY : Map<string,string> = new Map<string,string>([
    ["gpt_53_codex",process.env.AZURE_OPENAI_API_KEY_GPT_53_CODEX || '']
])
