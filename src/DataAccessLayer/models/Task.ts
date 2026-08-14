import{Document,ObjectId} from'mongodb';
import * as ds from './../../DataStructures';
import { RepoDetails } from './Workspaces';
import{TaskTypeEnum} from './../../classes/TaskType';
export interface chatHistory extends Document{
    sessionId:string;
    chatHistoryFileName:string; // this will be the name of the file in s3 bucket where this session's chat history is stored
}
export enum TaskStatus
{
    Running='RUNNING',
    Stopped='STOPPED',
    Deleted='DELETED',
    Failed='FAILED',
    Completed='COMPLETED',
    Waiting='WAITING',
    Starting='STARTING'
    
}
export interface AgentData
{
    agentId:string;
    chatSessionId:string;
    conversationHistoryFileName:string; 
    

}
export interface Task extends Document{
    _id?:ObjectId;
    createdBy:string,
    createdAt:Date,
    permissionScopes:Record<string,'Read'|'Write'>, // this can have organization ID as well as Group IDs
    EC2InstanceIP:string,
    status:TaskStatus, 
    taskFolderPath:string;
    chromaDataFolderPath:string,
    AIMetadataFolderPath:string,
    chromaServerPort:number, // it will be renewed everytime.
    taskId:string // unique task identifier
    wpId:string; // workspace ID from which this task is inherited
    wpName:string; // name of the workspace
    branchName: string;
    sessionId_chatHistoryData:Record<string,ds.chatHistoryData>;
    repoDetails:RepoDetails[]; // storing the information of the repo it will be having keys branchName and repoName
    metadata?:any;
    systemPrompts:[];
    isMasked?:boolean;// if this is true, then don't show this task on the UI grid, this was an internal task and will be cleared soon by the main agent.
    taskType?: TaskTypeEnum;
    parentTaskId?:string;

    childTaskIds?:string[];
    subAgents?:Record<string,AgentData>;
    sharedMemoryPath?:string;

}
