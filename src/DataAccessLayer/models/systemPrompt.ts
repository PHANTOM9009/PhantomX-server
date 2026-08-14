
import{Document,ObjectId} from'mongodb';
export interface systemPrompt extends Document{

    _id?:ObjectId;
    promptId:string;
    createdBy: string; // this is the user id of the creator of this sytem prompt
    createdAt: Date; // the date on which this system prompt was created
    filePath: string; // file path of this system prompt in s3 bucket
    systemPromptName: string; // this is the unique name of the prompt
    permissionScopes:Record<string,'Read'|'Write'>;


}