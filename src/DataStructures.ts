//this class is for managing data strucures:
import {githubData} from './DataAccessLayer/models/UserCredentials';
import {Socket} from 'socket.io'
import {IUser} from './DataAccessLayer/models/User';
import { DatabaseService } from './DataAccessLayer';
import * as dotenv from 'dotenv';
import { Workspaces } from './DataAccessLayer/models/Workspaces';
import { RepoDetails } from './DataAccessLayer/models/Workspaces';
dotenv.config();
import { SetupWorkspaceForSetup } from './Services/SetupWorkspace';
import { TaskStatus } from './DataAccessLayer/models/Task';
import { IndexedHeap } from './utils/IndexedHeap';
import { chatHistory } from './DataAccessLayer/models/Task';
import { TaskTypeEnum } from './classes/TaskType';
import Agent from './Services/agent-system';

export const user_github: Map<string,githubData> = new Map<string,githubData>();

export const user_userDetails: Map<string,any> = new Map<string,any>();

export const partialOAuthData : Map<string,any> = new Map<string, any>();// this is used for saving the temp code sent to the UI in query params such that when we get
//that code again we can give the refresh token and access tokens back;

export interface OAuthTokenRecord {
  accessToken: string;
  tokenType: string;
  scope: string;
  userId?: string;
  createdAt: Date;
}

export interface OAuthStateRecord {
  state: string;
  createdAt: Date;
  expiresAt: Date;
  inviteJWT?: string | null;
}
export interface GithubAppInstallationDetails{
  appId:string;
  installationId:number;
  githubOrganizationName:string;
  
}
// Use singleton instance and connect once at application startup
export const globalDatabaseService: DatabaseService = DatabaseService.getInstance();

// Initialize connection (will only connect once due to singleton)
if (!globalDatabaseService.isConnected()) {
    globalDatabaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV)
        .then(() => {
            console.log('Global MongoDB connection established');
        })
        .catch((error) => {
            console.error('Failed to establish global MongoDB connection:', error);
        });
}

export const oauthTokens: Record<string, OAuthTokenRecord> = {};
export const oauthStates: Record<string, OAuthStateRecord> = {};

export const oauthTempState: Map<string, any> = new Map<string, any>();


export interface PendingInviteData {
  invitedUserId: string;
  inviterName: string;
  recipientEmail: string;
  accessToken: string;
  
  organizationId: string;
  organizationName: string;
  
  inviterEmail: string;
  
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  
  role: string;
  metadata?: Record<string, any>;
}
export enum EC2Type{
  Task,
  Indexer
};

export const pendingInvites: Map<string, PendingInviteData> = new Map<string, PendingInviteData>();
export const pendingInviteJWT: Map<string, string> = new Map<string, string>();

export const pendingEmailResets: Map<string, PendingEmailResets> = new Map<string, PendingEmailResets>();

export interface PendingVerificationData {
  email: string;
  password: string;
  otp: string;
  status: 'pending' | 'verified' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  verifiedAt?: Date;
  attempts?: number;
  metadata?: Record<string, any>;
}

export interface PendingEmailResets{
  id: string;
  userId:string;
  email: string;
  resetToken: string;
  createdAt: Date;
  expiresAt: Date;
  status: 'pending' | 'completed' | 'expired' | 'verified';
}


export interface chatHistoryData{
  chatHistoryFileName:string;
  CreatedDate: Date;
  chatTopicName:string; // the name of the chat topic
  LastMessageSent?: Date;
}
export interface RunningTaskData{
  socketId:any; // this will be the socket id on which the task was running or is running
  taskId:string;
  taskName:string;
  taskSessionId:string; // unique session id for the task
  wpId:string;
  organizationId:string;
  playwrightUrl:string;
  isTaskOpenedInChat?:boolean;// this is a flag to know if the task is opened in chat or in the editor.
  organizationName:string;
  startedByUserId:string;
  folderPath:string;
  ec2InstanceIP:string;
  startedAt: Date; // the name of the container will be taskId_startedAt to make it unique.
  nonRunningSince?: Date; // timestamp from when task entered a non-running state, used by TaskReaper.
  status: TaskStatus ;
  metadata?: Record<string, any>;
  createdBy:string; // userId of the person who created this task
  sessionId_chatHistoryData:Record<string,chatHistoryData>; // the key is the session Id
  branchName:string
  assignedEc2InstanceId:string;
  chromaDbPort?:string; // the port on which chroma db will run, storing this to remove this server later on
  chromaDbUrl?:string; // url to access chroma db for the given task
  repoDetails:RepoDetails[];
  workspaceName:string;
  indexerWatcherProcessInfo?:any; // this will store SSHClient object, which will store the infomration about the indexer watch process which has started as a background process.
  chromaDbFolder?:string;
  chromaDbContainerName?:string;
  assignedEc2PublicDns?:string;
  isIndexerRunning?:boolean; // a flag to check if the indexer is running or not.
  userDockerTerminalUrl?: string;
  AIAbortController?: AbortController; // to abort the AI agent call
  isDependencyInstalled:boolean;
 
  // adding variables to support EC2 usage for htis task
  EC2Type:EC2Type;

  taskType?: TaskTypeEnum;
  ParentTaskId?:string;// the id of the parent task
  Agent?:Agent; // this is the main agent which will be responsible for this task


  subAgents?:Map<string,Agent>; // tthis will have the agent object of the sub agent running in that task
  childTasks?:string[]; // these will be the ids of the child tasks.
  sharedMemoryPath?:string; // this will be the path of the shared memory folder for the task


}
export interface Ec2Details{
  EC2Type: EC2Type;
  instanceId: string;
  publicIp:string;
  publicDns?:string;
  startedAt:Date;
  region:string;
  numberOfRunningTasks: number; // number of tasks currently running on this instant  
  runningTaskIds?:string[];
}
export const pendingVerifications: Map<string, PendingVerificationData> = new Map<string, PendingVerificationData>();

export const Organization_AppInstallation: Map<string,GithubAppInstallationDetails> = new Map<string,GithubAppInstallationDetails>();

export const UserName_Socket : Map<string,Socket> = new Map<string,Socket>(); //Maps for UserId to socket. THIS IS DEPRICATED NOW


export const pendingGithubAppInstall: Map<string,[string,Socket]> = new Map<string,[string,Socket]>();// for the users who clicked on install but did not complete the flow
//for storing the state of the user when he is installing the Github Application..

export const UserInfo : Map<string,IUser>  = new Map<string,IUser>();

export let PlanInfo: Record<string,any> = {};

export const RunningTaskData: RunningTaskData[] = []; // this is the pool of free EC2 instances available 

export const userId_task : Map<string,RunningTaskData[]> = new Map<string,RunningTaskData[]>();

export const Ec2Id_Map: Map<string,Ec2Details> =  new Map<string, Ec2Details>(); // the details in this are referenced by FreeEc2Pool and FreeIndexerEC2Pool

export const FreeEc2Pool: IndexedHeap = new IndexedHeap(true); // this has the reference of Ec2Id_Map
 
export const FreeIndexerEc2Pool: IndexedHeap = new IndexedHeap(true); // this has the reference of Ec2Id_Map
// pool of EC2 instances in use
export const socket_task: Map<Socket,RunningTaskData> = new Map<Socket,RunningTaskData>(); // this will be used for workspace and task

export const taskId_task: Map<string,RunningTaskData>  =  new Map<string,RunningTaskData>();
export const agentId_agent: Map<string,Agent> = new Map<string,Agent>();
export const userId_sockets : Map<string,Socket[]> = new Map<string, Socket[]>();

export const PendingWorkspaces : Map<Socket,SetupWorkspaceForSetup> = new Map<Socket,SetupWorkspaceForSetup>(); // this will store the pending workspace data until the setup is complete
export const PendingTaskChromaData: Map<string,RunningTaskData[]> = new Map<string,RunningTaskData[]>(); // this will store the pending task chroma data until the chroma folder is ready for the workspace.
// Maps workspace ID to EC2 instance IP for file server connections
export const WorkspaceId_EC2Ip: Map<string, string> = new Map<string, string>();
export const pendingTaskDeletions:Map<string,any> = new Map<string, any>(); // this map is used to store the pending task deletions such that multiple delete requests are not sent for same task.
// Maps workspace ID to file server port (default: 4002)
export const WorkspaceId_FileServerPort: Map<string, number> = new Map<string, number>();

export const temporaryChatData : Map<string,any> = new Map<string,any>(); 
// this will temporarily store the chat data and will always append to the origainl chat at the end if available
// it will be removed by execute_prompt once the new request comes, we are assuming that request is finally here and can be processed.

export const userId_orchestratorSocket : Map<string,Socket> = new Map<string, Socket>(); // this will store orchestrator for a given user.
