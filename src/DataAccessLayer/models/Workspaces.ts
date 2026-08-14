import {Document,ObjectId} from 'mongodb';


export interface RepoDetails
{
    repoName: string;
    branchName:string;
    keys: string[];
    commands:Record<string,string>;


}

export interface Workspaces extends Document{
    _id?:ObjectId;
    wpId:string; // if of the current workspace
    workspaceName:string; // name of the workspace
    repoDetails:RepoDetails[];
    createdBy:string;
    permissionScopes:Record<string,'Read'|'Write'>;
    systemPrompts:[]; // this will be an array of string, string of ids of the system prompt.
    tags:string[];
    description:string;
    createdOn:Date;
    isIndexerComplete: boolean; // if it is true then the task can be created on this
    chatSessionId?:string;
}
