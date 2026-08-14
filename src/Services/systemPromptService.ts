import * as ds from './../DataStructures';
import { S3Service } from './S3Service';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import * as dotenv from 'dotenv';
import { CollectionNames } from '../DataAccessLayer/models';
import { systemPrompt } from '../DataAccessLayer/models/systemPrompt';
import {v4 as uuid4} from 'uuid';
dotenv.config();
export class systemPromptService {
    static logger = new Logger('SystemPromptService');
    static async createSystemPrompt(prompt: string, userId: string, promptName: string, permissionScopes: Record<string, any>) {
        
        try{
            let s3Service = new S3Service(process.env.SYSTEM_PROMPT_BUCKET);
        let userData = ds.UserInfo.get(userId);
        if (userData) {
            let path = `${userData.organizationName}/${userData.userId}/${promptName}` // ideally all the files stored in the blob are in txt, but this should be a md file but later of that
            let result = await s3Service.uploadFile(path, prompt);
            if (result.success) {
                this.logger.success("System Prompt upload succeded in s3 bucket");
            }
            else {
                this.logger.error("system prompt upload failed in s3 bucket");
            }
            // now updating the mongodb database for this created system prompt
            let dbService = await getDBService();
            dbService.ensureCollection(userData.dbName, CollectionNames.SYSTEM_PROMPT);
            let systemPromptHandler = dbService.getRepository<systemPromptService>(userData.dbName, CollectionNames.SYSTEM_PROMPT);
            let uid = uuid4();
            let val: Partial<systemPrompt> = {
                promptId: uid,
                createdBy: userId,
                cratedAt: new Date(),
                filePath: path,
                systemPromptName: promptName,
                permissionScopes: permissionScopes
            };
            let result1 = await systemPromptHandler.insertOne(val as any);
            if (result1.acknowledged) {
                this.logger.success("systemp prompt metadata is added in mongodb");
                return {success:true,promptId:uid};
            }
            else {
                this.logger.error("userData not found for creating a system prompt");
                return { success: false };
            }
        }
    }
        catch (ex) {
            this.logger.error("error while creating a system prompt", ex);
            return { success: false };
        }

    }
    static async editSystemPrompt(prompt: string, userId: string, promptId: string) {
        let dbService = await getDBService();
        let userData = ds.UserInfo.get(userId);
        if (userData) {
            let handler = dbService.getRepository<systemPrompt>(userData.dbName,CollectionNames.SYSTEM_PROMPT);
            //getting the file name
            let data:any = await handler.findOne({
                promptId: promptId
            });
            let s3Service = new S3Service(process.env.SYSTEM_PROMPT_BUCKET);
            await s3Service.deleteFile(data.filePath);
            await s3Service.uploadFile(data.filePath,prompt);
            // edited everything.
        }
    }
   static async editPermissionScopes(promptId:string,userId:string,permissionScopes:Record<string,any>)
    {
        
          let dbService = await getDBService();
        let userData = ds.UserInfo.get(userId);
        if (userData) {
             let handler = dbService.getRepository<systemPrompt>(userData.dbName,CollectionNames.SYSTEM_PROMPT);
             await handler.updateOne({
                promptId: promptId
             },
            {
                $set:
                {
                    $set:
                    {
                        permissionScopes: permissionScopes
                    }
                }});
        }
    }
    static async getSystemPrompt(promptId:string,userId:string)
    {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                systemPromptService.logger.error('userData not found for getSystemPrompt');
                return { success: false, error: 'user not found' };
            }

            let handler = dbService.getRepository<systemPrompt>(userData.dbName, CollectionNames.SYSTEM_PROMPT);
            const data:any = await handler.findOne({ promptId: promptId });
            if (!data) {
                systemPromptService.logger.error(`system prompt metadata not found for ${promptId}`);
                return { success: false, error: 'prompt metadata not found' };
            }

            const s3Service = new S3Service(process.env.SYSTEM_PROMPT_BUCKET);
            const fileResult = await s3Service.getFile(data.filePath, undefined, true);
            if (!fileResult.success || !fileResult.data) {
                systemPromptService.logger.error(`failed to retrieve prompt file from s3: ${fileResult.error}`);
                return { success: false, error: fileResult.error || 'failed to get prompt file' };
            }

            let promptContent: string;
            if (Buffer.isBuffer(fileResult.data)) {
                promptContent = (fileResult.data as Buffer).toString('utf-8');
            } else {
                // stream -> collect
                const chunks: Buffer[] = [];
                for await (const chunk of (fileResult.data as any)) {
                    chunks.push(Buffer.from(chunk));
                }
                promptContent = Buffer.concat(chunks).toString('utf-8');
            }

            const promptObject = {
                _id: data._id,
                promptId: data.promptId,
                systemPromptName: data.systemPromptName,
                content: promptContent,
                permissionScopes: data.permissionScopes,
                createdAt: data.cratedAt,
                createdBy: data.createdBy,
                filePath: data.filePath
            };

            return { success: true, prompt: promptObject };
        }
        catch (err: any) {
            systemPromptService.logger.error('error in getSystemPrompt', err);
            return { success: false, error: err.message || 'unknown error' };
        }
    }

   static async deleteSystemPrompt(promptId: string, userId: string) {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                systemPromptService.logger.error('userData not found for deleteSystemPrompt');
                return { success: false, error: 'user not found' };
            }

            let handler = dbService.getRepository<systemPrompt>(userData.dbName, CollectionNames.SYSTEM_PROMPT);
            const data:any = await handler.findOne({ promptId: promptId });
            if (!data) {
                systemPromptService.logger.error(`system prompt metadata not found for deletion: ${promptId}`);
                return { success: false, error: 'prompt metadata not found' };
            }

            const s3Service = new S3Service(process.env.SYSTEM_PROMPT_BUCKET);
            const deleteResult = await s3Service.deleteFile(data.filePath);
            if (!deleteResult.success) {
                systemPromptService.logger.error(`failed to delete file from s3: ${deleteResult.error}`);
                return { success: false, error: deleteResult.error || 'failed to delete s3 file' };
            }

            const delDbRes = await handler.deleteOne({ promptId: promptId });
            if (delDbRes.deletedCount && delDbRes.deletedCount > 0) {
                systemPromptService.logger.success(`system prompt ${promptId} deleted from db and s3`);
                return { success: true };
            }
            else {
                systemPromptService.logger.error(`failed to delete system prompt metadata for ${promptId}`);
                return { success: false, error: 'failed to delete metadata' };
            }
        }
        catch (err: any) {
            systemPromptService.logger.error('error in deleteSystemPrompt', err);
            return { success: false, error: err.message || 'unknown error' };
        }
    }

    static async getAllPrompts(permissionScopeIds: string[], userId: string): Promise<{ success: boolean; prompts?: Array<any>; error?: string }> {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                systemPromptService.logger.error('userData not found for getAllPrompts');
                return { success: false, error: 'user not found' };
            }

            await dbService.ensureCollection(userData.dbName, CollectionNames.SYSTEM_PROMPT);
            let handler = dbService.getRepository<systemPrompt>(userData.dbName, CollectionNames.SYSTEM_PROMPT);
            const filter: any = {};
            if (permissionScopeIds && permissionScopeIds.length > 0) {
                filter.$or = permissionScopeIds.map(id => ({
                    [`permissionScopes.${id}`]: { $exists: true }
                }));
            }

            const promptsByGroups = await handler.find(filter);
            const promptsCreatedByUser = await handler.find({ createdBy: userId });
            
            const combined = [...promptsByGroups, ...promptsCreatedByUser];
            const promptDocs = Array.from(
                new Map(combined.map(item => [item._id.toString(), item])).values()
            );

            if (!promptDocs || promptDocs.length === 0) {
                return { success: false, error: 'No prompts found with matching permissionScopeIds' };
            }

            const prompts = promptDocs.map(doc => ({
                promptId: doc.promptId,
                systemPromptName: doc.systemPromptName,
                permissionScopes: doc.permissionScopes || {}
            }));

            return { success: true, prompts };
        } catch (error: any) {
            systemPromptService.logger.error('Error getting all prompts', error);
            return { 
                success: false, 
                error: error.message || 'unknown error' 
            };
        }
    }
}
