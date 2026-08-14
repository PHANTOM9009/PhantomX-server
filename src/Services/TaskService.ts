import { SetupWorkspaceForSetup, CleanTask } from "./SetupWorkspace";
import * as ds from '../DataStructures';
import { Server, Socket } from 'socket.io';
import { getEC2Instance } from "./EC2Manager";
import { v4 as uuidv4 } from 'uuid';
import { getDBService } from "../DataAccessLayer/db-connection";
import { Workspaces } from "../DataAccessLayer/models/Workspaces";
import { Task } from "../DataAccessLayer/models/Task";
import { CollectionNames, IUser } from "../DataAccessLayer/models";
import { fileServerClientManager } from "./FileServerClientManager";
import { DatabaseService } from "../DataAccessLayer/DatabaseService";
import { toolServerClientManager } from "./ToolServerClientManager";
import { setupTerminalEnvironment, setupChromaAndIndexer, DeleteTask, coldKillTask } from './SetupWorkspace';
import path from 'path';
import { TaskStatus } from "../DataAccessLayer/models/Task";
import { createLogger } from '../utils/Logger';
import { EC2Type } from "../DataStructures";
import { installDependencies } from "./SetupWorkspace";
import { startPlaywrightServer } from "./SetupWorkspace";
import { constraintHandlerClass } from "./constraintsService";
import { constraintTypes } from "../model/Plans";
const SSHClient = require('./ssh-client');
const logger = createLogger('TaskService');
import { TaskType } from "../classes/TaskTypeEnum";
import { activeControllers } from "../socket-handlers/file-server.handler";
import { temporaryChatData } from "../DataStructures";
import { PromptExecutionService } from "./PromptExecutionService";
import { io } from '../socket-server';
import { TaskTypeEnum } from "../classes/TaskType";
import { Agent } from './agent-system';
import { Operations } from "../classes/OperationsEnum";
import { ChatHistoryService } from "./ChatHistoryService";
import { AgentTypeEnum } from "../classes/AgentTypeEnum";
import { AcccessRightsSubAgent, AccessRights, AccessRightsChildAgent, AccessRightsParentAgent } from "../classes/ModelAccessRights";

export class TaskService {
    /**
     * Helper function to check when user terminal has started
     */
    static async checkUserTerminal(taskId: string, socket: Socket): Promise<void> {
        try {
            // if incoming for workspace it will come as wpId else for task it will come as taskId
            let taskData: any = ds.taskId_task.get(taskId); // getting the task data

            while (1) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // adding a delay of 2 seconds before running to check the command
                let ssh = new SSHClient('/', taskData?.ec2InstanceIP);
                let id = taskData.taskId === null || taskData.taskId === '' ? taskData.wpId : taskData.taskId;
                let result = await ssh.executeCommand(`docker exec  ${id}-user bash -c 'echo "started"'`);
                if (result.success && result?.output?.trim() === 'started') {
                    socket.emit('user_terminal_started', true);
                    console.log("user docker terminal started for the task=>", taskData.taskId);
                    break;
                }
            }
        }
        catch (ex) {
            console.log("\n error in the function check_user_terminal==>", ex);
        }
    }


    static async taskAliveStatus(data: any, socket: Socket): Promise<any> {
        try {
            const taskId = data?.taskId;
            if (!taskId) return false;
            const user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) return false;
            // const dbService = await getDBService();
            // const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
            // const taskFromDb = await taskRepository.findOne({ taskId });
            // if(taskFromDb && taskFromDb.status === TaskStatus.Running) return true;
            //we will early return if status is true directly

            const runningTask: any = ds.taskId_task.get(taskId);
            if (runningTask) {


                return {
                    taskAlive: true,
                    taskStatus: runningTask.status
                };
            }     //if running task is found in memory db means it is running
            else {
                const dbService = await getDBService();
                const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
                const taskFromDb = await taskRepository.findOne({ taskId });
                return {
                    taskAlive: false,
                    taskStatus: taskFromDb?.status || null
                }
            }
            return false;
        } catch {
            return false;
        }
    }

    /**
     * Helper function to get the latest session ID based on creation date
     */
    static getLatestSessionId(sessionIdChatHistoryData: Record<string, ds.chatHistoryData>): string | null {
        if (!sessionIdChatHistoryData || Object.keys(sessionIdChatHistoryData).length === 0) {
            return null;
        }

        // Convert Map to array of entries for sorting
        const sessions = Object.entries(sessionIdChatHistoryData);

        const sortedSessions = sessions.sort((a, b) => {
            const getEffectiveDate = (session: ds.chatHistoryData): Date => {
                if (session.LastMessageSent) {
                    return session.LastMessageSent instanceof Date ? session.LastMessageSent : new Date(session.LastMessageSent);
                }
                return session.CreatedDate instanceof Date ? session.CreatedDate : new Date(session.CreatedDate);
            };
            return getEffectiveDate(b[1]).getTime() - getEffectiveDate(a[1]).getTime();
        });

        return sortedSessions[0][0]; // Return the session ID of the newest session
    }


    static upsertTaskInMemory(userId: string, taskId: string, status: TaskStatus, taskPatch: Partial<ds.RunningTaskData> = {}): ds.RunningTaskData {
        const existingTask = ds.taskId_task.get(taskId);

        let baseTask: ds.RunningTaskData = existingTask || {
            socketId: null,
            taskId,
            taskName: "",
            taskSessionId: uuidv4(),
            wpId: "",
            organizationId: "",
            playwrightUrl: "",
            organizationName: "",
            startedByUserId: userId,
            folderPath: "",
            ec2InstanceIP: "",
            startedAt: new Date(),
            status,
            createdBy: userId,
            sessionId_chatHistoryData: {},
            branchName: "",
            assignedEc2InstanceId: "",
            repoDetails: [],
            workspaceName: "",
            isDependencyInstalled: false,
            EC2Type: EC2Type.Task,
            subAgents: new Map<string, Agent>(),
            childTasks: []
        } as ds.RunningTaskData;

        baseTask = {
            ...baseTask,
            ...taskPatch,
            taskId,
            status
        };

        ds.taskId_task.set(taskId, baseTask);

        // const existingTasks = ds.userId_task.get(userId) || [];
        // const taskIndex = existingTasks.findIndex(task => task.taskId === taskId);

        // if (taskIndex >= 0) {
        //     existingTasks[taskIndex] = updatedTask;
        // }
        // else {
        //     existingTasks.push(updatedTask);
        // }

        // ds.userId_task.set(userId, existingTasks);
        return baseTask;
    }


    /**
     * Get task GitHub data
     */
    static async getTaskGithubData(data: any, socket: Socket): Promise<any> {
        try {
            const { taskId } = data;
            if (!taskId) {
                return { success: false, error: "taskId is required" };
            }
            const user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) {
                return { success: false, error: "User not found" };
            }
            const dbService = await getDBService();
            const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
            const task = await taskRepository.findOne({ taskId });
            if (!task) {
                return { success: false, error: "Task not found" };
            }
            return { success: true, github: task.metadata?.github || null };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : err };
        }
    }

    /**
     * Get task activity log
     */
    static async getTaskActivityLog(data: any, socket: Socket): Promise<any> {
        try {
            const { taskId } = data;
            if (!taskId) {
                return { success: false, error: "taskId is required" };
            }
            const user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) {
                return { success: false, error: "User not found" };
            }
            const dbService = await getDBService();
            const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
            const task = await taskRepository.findOne({ taskId });
            if (!task) {
                return { success: false, error: "Task not found" };
            }
            const activityLog = task.metadata?.activityLog || [];
            return { success: true, activityLog };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : err };
        }
    }

    /**
     * Update task notes
     */
    static async updateTaskNotes(data: any, socket: Socket): Promise<any> {
        try {
            const { taskId, notes } = data;
            if (!taskId) {
                return { success: false, error: "taskId is required" };
            }
            const user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) {
                return { success: false, error: "User not found" };
            }
            const dbService = await getDBService();
            const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
            const task = await taskRepository.findOne({ taskId });
            if (!task) {
                return { success: false, error: "Task not found" };
            }
            await taskRepository.updateOne(
                { taskId },
                { $set: { 'metadata.notes': notes } }
            );
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : err };
        }
    }

    /**
     * Get a single task
     */
    static async getTask(data: any, socket: Socket): Promise<any> {
        try {
            const { taskId } = data || {};
            if (!taskId) {
                return { success: false, message: "taskId is required" };
            }

            const user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) {
                return { success: false, message: "User not found" };
            }

            const dbService = await getDBService();
            const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
            const task = await taskRepository.findOne({ taskId });
            if (!task) {
                return { success: false, message: "Task not found" };
            }

            if (task.createdBy !== socket.data.user.userId) {
                return { success: false, message: "Not authorized to access this task" };
            }

            return { success: true, task };
        } catch (ex) {
            return { success: false, message: ex instanceof Error ? ex.message : ex };
        }
    }

    /**
     * Setup a new task
     */
    static async setupTask(data: any, socket: Socket): Promise<any> {
        try {
            // the data might have a prompt as well.
            //initialPrompt is the name
            // we will be having a flag : cascadeOn which 

            let cresult: any = await constraintHandlerClass.constraintHandler(socket.data.user.userId, constraintTypes.TotalTasks);
            if (!cresult.success) {
                return {
                    success: false,
                    message: cresult.message
                };
            }
            let wpData: any = {};
            let databaseService = DatabaseService.getInstance();
            if (data.mode === TaskType.WITH_WORKSPACE) {
                logger.info('Setting up new task', { wpId: data.wpId, userId: socket.data.user.userId, workspaceName: data.workspaceName });

                let wpHandler = databaseService.getRepository<Workspaces>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.WORKSPACES);
                wpData = await wpHandler.findOne({
                    wpId: data.wpId as any
                });
            }
            else if (data.mode === TaskType.DYNAMIC_WORKSPACE) {
                wpData = {
                    repoDetails: data?.repoDetails,

                };
            }
            let userData: IUser = ds.UserInfo.get(socket.data.user.userId as string) as any;
            let taskId = uuidv4();
            this.upsertTaskInMemory(socket.data.user.userId, taskId, TaskStatus.Starting, {
                taskId,
                createdBy: socket.data.user.userId,
                startedByUserId: socket.data.user.userId,
                wpId: data.wpId,
                taskName: data?.metadata?.title,
                branchName: data.branchName,
                metadata: data?.metadata
            });

            await databaseService.ensureCollection(userData.dbName, CollectionNames.TASKS as any);
            let taskHandler = databaseService.getRepository<Task>(userData.dbName, CollectionNames.TASKS);
            let sessionId = uuidv4();
            let chatHistoryPath = `${userData.organizationName}/task/${taskId}/${sessionId}`;

            //storing the first acitivity log that task has been started
            const userName = userData && userData.firstName && userData.lastName
                ? `${userData.firstName} ${userData.lastName}`
                : (userData?.userName || userData?.name || userData?.userId || "User");
            const activity = {
                id: `activity_${Date.now()}`,
                type: "comment",
                description: "Started task",
                timestamp: new Date().toISOString(),
                user: userData?.userId || "user1",
                userName: userName,
                isAgent: false
            };

            let result = await taskHandler.insertOne({ // this is a temporary addition in db
                taskId: taskId,
                wpId: wpData?.wpId as any,
                createdBy: userData.userId,
                createdAt: new Date(),
                permissionScopes: data.permissionScopes as any,
                EC2InstanceIP: "", // will be updated in db
                status: TaskStatus.Starting,
                chromaDataFolderPath: "",
                AIMetadataFolderPath: "",
                chromaServerPort: 8080,
                metadata: data?.metadata,
                taskFolderPath: "", // will be updated in db
                sessionId_chatHistoryData: { [sessionId]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() } } as Record<string, ds.chatHistoryData>,
                branchName: data.branchName,
                wpName: wpData?.workspaceName as any,
                repoDetails: [], // to be updated in db
                systemPrompts: [], // to be updated in db
                taskType: TaskTypeEnum.PARENT_TASK


            });

            socket.emit('refresh_task_grid', true);
            let repoInfo: any = [];
            for (let i of data.repoDetails) {
                repoInfo.push({
                    repoName: i.repoName,
                    branchName: i.branchName
                });
            }



            // let ec2Details: ds.Ec2Details = await getEC2Instance(taskId, ds.EC2Type.Task);
            // logger.info('EC2 instance acquired for task', { taskId, ec2Ip: ec2Details.publicIp });
            let folderPath = taskId;
            let setupWorkspace = new SetupWorkspaceForSetup(userData?.dbName as any, userData?.organizationName as any, socket.data.user.userId as string, "",
                "", data.workspaceName, data.wpId, taskId, data?.description, data?.tags
            );
            let terminal_sessionID: any;
            try {
                terminal_sessionID = await setupWorkspace.finalizeTaskSelfHosted(folderPath, repoInfo, socket, false, data.permissionScopes, data.metadata, data.branchName);
            }
            catch (ex) {
                console.log(ex);
                return { success: false, error: ex }
            }

            let status = !data?.cascadeOn ? TaskStatus.Waiting : TaskStatus.Running;
            let newTaskData: ds.RunningTaskData = {
                taskId: taskId,
                EC2Type: EC2Type.Task,
                playwrightUrl: ``, // setting the url
                taskName: data.metadata?.title,
                wpId: data.wpId,
                organizationId: userData?.organizationId as any,
                organizationName: userData?.organizationName as any,
                startedByUserId: userData?.userId as any,
                folderPath: folderPath,
                ec2InstanceIP: '',
                startedAt: new Date(),
                nonRunningSince: new Date(),
                status: status,
                createdBy: socket.data.user.userId,
                metadata: data.metadata,
                assignedEc2InstanceId: '',
                chromaDbPort: '',
                assignedEc2PublicDns: '',
                isIndexerRunning: false, userDockerTerminalUrl: '',
                taskSessionId: uuidv4(),
                socketId: null,
                sessionId_chatHistoryData: terminal_sessionID.sessionId_chatHistoryData as any,
                branchName: data.branchName,
                repoDetails: data?.repoDetails,
                workspaceName: "",
                isDependencyInstalled: false,
                sharedMemoryPath: `${setupWorkspace.folderPath}/.AIMetadata/sharedMemory`
            };
            newTaskData = this.upsertTaskInMemory(socket.data.user.userId, taskId, status, newTaskData);
            // Get the same reference from taskId_task and add to userId_task array
            const taskReference = ds.taskId_task.get(taskId);
            if (taskReference) {
                const existingUserTasks = ds.userId_task.get(socket.data.user.userId) || [];
                existingUserTasks.push(taskReference);
                ds.userId_task.set(socket.data.user.userId, existingUserTasks);
            }

            //storing the temporary message if any
            //fetching the id
            if (data?.initialPrompt) {
                const [key, value] = Object.entries(terminal_sessionID.sessionId_chatHistoryData)[0]; //getting the first id
                temporaryChatData.set(key, {
                    "role": "user",
                    "content": [
                        {
                            type: "text",
                            text: data?.initialPrompt
                        }

                    ]
                });
            }



            //   startPlaywrightServer(newTaskData.ec2InstanceIP, terminal_sessionID.playwrightPort, setupWorkspace.folderPath);

            //  setupChromaAndIndexer(newTaskData);

            //  this.checkUserTerminal(taskId, socket); // to check when the docker terminal has started to work

            logger.success('Task setup completed successfully', { taskId, wpId: data.wpId, userId: socket.data.user.userId });
            if (data?.cascadeOn === true) {
                // now we will be calling start task
                //before calling the start task we will be updating the status of the task to running, because cascading will only be turned on when the
                // message is sent along with the start task
                this.upsertTaskInMemory(socket.data.user.userId, taskId, TaskStatus.Running, {
                    ...newTaskData,
                    status: TaskStatus.Running
                });
                this.changeTaskStatusInDB(taskId, socket, TaskStatus.Running);
                const startResult = await this.startTask({ taskId, cascadeOn: true, initialPrompt: data?.initialPrompt as string }, socket, io);
                return startResult;

            }
            else {
                return {
                    success: true,
                    taskId: setupWorkspace.taskId
                };
            }
        }
        catch (ex) {
            logger.error('Task setup failed', {
                userId: socket.data.user.userId,
                wpId: data.wpId,
                workspaceName: data.workspaceName,
                error: ex
            });
            return {
                success: false,
                message: ex
            };
        }
    }

    /**
     * Transfer a task from one socket to another
     */
    static async transferTask(data: any, socket: Socket, io: Server): Promise<any> {
        try {
            logger.info('Transferring task', { taskId: data.taskId, userId: socket.data.user.userId });

            //here we are going to transfer a given task
            let userData = ds.UserInfo.get(socket.data.user.userId);
            let currentRunningTask: any = ds.taskId_task.get(data.taskId);
            if (!currentRunningTask) {
                //start task directly here
                logger.warn('No task running in memory for transfer, starting task instead', { taskId: data.taskId, userId: socket.data.user.userId });
                const startResult = await this.startTask(data, socket, io);
                return startResult;
            }
            // now we have a legit task working so we need to shift that task only chaning the key in the socket_task should work ideally

            let existingTaskSocket: any = io.sockets.sockets.get(currentRunningTask?.socketId); // getting the previous socket.
            if (existingTaskSocket?.connected && currentRunningTask.socketId !== socket.id) {
                existingTaskSocket.emit("deregister_task", {
                    taskId: currentRunningTask.taskId
                });
            };
            // if (currentRunningTask.socketId) {
            //     activeControllers.delete(currentRunningTask.socketId); // removing the active controller for the previous socket
            // }

            currentRunningTask.socketId = socket.id;
            socket.data.user.taskId = data.taskId; // hereby the task is transferred from the previous socket to the new socket.

            // also changing the abort controller for the new task ownership
            // let abortController = new AbortController();
            // currentRunningTask.AIAbortController = abortController;
            // activeControllers.set(currentRunningTask.taskId, abortController);


            logger.success('Task transferred successfully', { taskId: data.taskId, userId: socket.data.user.userId });
            const latestSessionId = this.getLatestSessionId(currentRunningTask.sessionId_chatHistoryData);
        
            
            return {
                success: true,
                folderPath: `/mnt/efs1/${userData?.organizationName}/Tasks/${data.taskId}`,
                dockerTerminalUrl: currentRunningTask.userDockerTerminalUrl,
                latestSessionId: latestSessionId,
                taskId: data.taskId
            };
        }
        catch (ex) {
            logger.error('Task transfer failed', {
                userId: socket.data.user.userId,
                taskId: data.taskId,
                currentTaskId: socket.data.user.taskId,
                socketId: socket.id,
                error: ex instanceof Error ? ex.message : ex,
                stack: ex instanceof Error ? ex.stack : undefined
            });
            return {
                success: false,
                message: ex
            };
        }
    }
    static async changeTaskStatusInDB(taskId: string, socket: Socket, status: TaskStatus) {
        try {

            socket = (typeof (socket as any) === 'string' ? ({ data: { user: { userId: socket as any } } } as any) : socket);
            io.to(socket.data.user.userId).emit('change_task_status', {
                taskId: taskId,
                status: status
            });
            let dbService = getDBService();

            let taskHandler = (await dbService).getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
            await taskHandler.updateOne({ taskId: taskId }, { $set: { status: status } });

        }
        catch (ex) {
            logger.error('Failed to update task status in DB', ex);
        }

    }

    static async stopSubAgent(data: any) {
        // this function will stop any sub agent
        try {
            let agent = ds.agentId_agent.get(data.agentId);
            if (agent) {
                agent.abortController?.abort();
                return {
                    success: true,
                    message: "agent's execution stopped successfully"
                }
            }
            // Fallback: try to find agent in task's subTasks if not in global registry
            for (const [taskId, taskData] of ds.taskId_task.entries()) {
                const subAgent = taskData.subAgents?.get(data.agentId);
                if (subAgent) {
                    subAgent.abortController?.abort();
                    logger.info("Stopped sub-agent via task lookup (not in registry)", { agentId: data.agentId, taskId });
                    return {
                        success: true,
                        message: "agent's execution stopped successfully"
                    }
                }
            }
            logger.warn("Sub-agent not found in registry or task subTasks", { agentId: data.agentId });
            return {
                success: false,
                message: "Sub-agent not found"
            }
        }
        catch (ex) {
            logger.error("error while stopping the agent=>" + data.agentId + " the execption is=>" + ex);
            return {
                success: false,
                message: ex instanceof Error ? ex.message : String(ex)
            }
        }
    }
    static async cleanSubAgent(agentId: any) {

        try {

            //stopping the sub agent before cleaning it down
            await this.stopSubAgent(agentId);
            // now that it is stopped lets delete it from the dta structure
            ds.agentId_agent.delete(agentId);
            logger.success("cleaned the sub agent successfully=>", agentId);


        }
        catch (ex) {
            logger.error("error while cleaning the sub agent==>", ex);
        }
    }
    static async stopTask(taskId: any) {
        try {
            //this will stop any given child task using the id of the task
            let task: any = ds.taskId_task.get(taskId); // getting the task
            if (!task) {
                logger.warn("Task not found for stopTask", { taskId });
                return;
            }
            // aborting the children of the task first
            for (let [agentId, agent] of task?.subTasks || new Map<string, Agent>()) {
                let abortController = activeControllers.get(agentId);
                if (abortController) {
                    abortController.abort();
                    activeControllers.delete(agentId);
                }
            }
            //also stopping the childtasks if any
            for (let taskId of task.childTasks || []) {
                await this.stopTask(taskId);
            }
            // now stopping the main agent of the task
            if (task.Agent?.agentId) {
                let abortController = activeControllers.get(task.Agent.agentId);
                abortController?.abort();
                activeControllers.delete(task.Agent.agentId);
            }
            logger.info("Task stopped successfully with taskId=>" + taskId);
        }
        catch (ex) {
            logger.error("error while stopping the task=>" + taskId + " the execption is=>" + ex);
        }
    }


    static async startSubAgentInternal(data: any) {
        /*
         * The 'data' object must contain the following properties:
         *
         * Required:
         *   - taskId   : (string) The ID of the running task whose context the sub-agent will operate in.
         *                Used to look up the task from the in-memory store (ds.taskId_task).
         *
         *   - modelKey : (string) The AI model key to be used when creating the sub-agent
         *                (e.g. 'gpt-4o', 'claude-3-5-sonnet').
         *                Passed directly to the Agent constructor.
         *
         *   - prompt   : (string) The initial prompt/instruction to execute inside the sub-agent.
         *                Forwarded to PromptExecutionService.executePromptSubAgent.
         *
         *   - parentId : (string) The agent ID of the parent agent that spawned this sub-agent.
         *                Assigned to agent.parentAgent so the sub-agent knows its parent.
         * 
         * --agentId
         */
        try {
            let task = ds.taskId_task.get(data.taskId);
            if (task) {
                //creating a new chat session specially for the sub agent
                let chatHistoryService = new ChatHistoryService();
                let agentId = data.agentId;
                let sessionId: any = await chatHistoryService.createNewAgentChatSession(agentId, task.createdBy, task.taskId); //


                //updating the db with the agent data

                let dbSerivce = await getDBService();
                let taskHandler = dbSerivce.getRepository<Task>(ds.UserInfo.get(task.createdBy)?.dbName, CollectionNames.TASKS);

                taskHandler.updateOne({
                    taskId: task.taskId
                },
                    {
                        $set: {
                            [`subAgents.${agentId}`]: {
                                agentId: agentId,
                                chatSessionId: sessionId.sessionId,
                                conversationHistoryFileName: sessionId.chatHistoryFileName
                            }
                        }
                    });


                let agent = new Agent(1, task.folderPath, Operations.CODING_AGENT, task.ec2InstanceIP, sessionId.chatHistoryPath,
                    task.taskId, task.createdBy, AgentTypeEnum.SUB_AGENT, AcccessRightsSubAgent, false, task.sharedMemoryPath, data.modelKey, path.basename(task.folderPath), undefined, undefined, undefined, sessionId.sessionId, agentId);
                task.subAgents?.set(agentId, agent);
                ds.agentId_agent.set(agentId, agent); // Register in global agent registry
                agent.parentAgent = data.parentId;
                agent.parentTaskId = task.taskId;
                const startResult: any = await PromptExecutionService.executePromptSubAgent({
                    agentId: agentId,
                    taskId: task.taskId,
                    prompt: data.prompt

                });

                return {
                    success: startResult?.success ?? startResult?.succes ?? true,
                    message: startResult?.message || "query is submitted to the sub agent",
                    agentId: agentId,
                    sessionId: sessionId.sessionId,
                    taskId: task.taskId
                };

            }
        }
        catch (ex) {
            logger.error('Failed to start sub-agent', ex);
            return {
                success: false,
                error: ex
            }
        }
    }
    static async startTaskInternal(data: any, userId: string, parentTaskId: string, parentAgentId: string) //swarms feature
    {
        /*
         * The 'data' object should contain the following properties:
         *
         * Required:
         *   - mode            : (TaskType) Task creation mode. One of:
         *                         TaskType.WITH_WORKSPACE     => task is tied to an existing workspace (requires wpId)
         *                         TaskType.DYNAMIC_WORKSPACE  => task uses dynamic repo details (requires repoDetails)
         *   - metadata        : (object) Task metadata, must include:
         *                         - title           : (string) Display name/title of the task
         *                         - workspaceBranch : (string) Branch of the workspace to use
         *   - branchName      : (string) Git branch name for this task
         *   - permissionScopes: (Record<string, 'Read'|'Write'>) Permission scopes for the task (userId/groupId -> access level)
         *   - modelKey        : (string) AI model key to be used for the agent (e.g. 'gpt-4o', 'claude-3-5-sonnet')
         *   - initialPrompt   : (string) The initial prompt/instruction to send to the AI agent when the task starts
         *   - cascadeOn       : (boolean) If true, the AI agent will be started immediately after task setup
         *
         * Conditional:
         *   - wpId            : (string) Workspace ID — required when mode === TaskType.WITH_WORKSPACE
         *   - workspaceName   : (string) Workspace name — required when mode === TaskType.WITH_WORKSPACE
         *   - repoDetails     : (array)  Repository details — required when mode === TaskType.DYNAMIC_WORKSPACE
         *
         * Optional:
         *   - description     : (string) A brief description of the task
         *   - tags            : (string[]) Tags associated with the task
         */
        // this function will be used to start the tasks which was started by another agent, for swarms feature
        // this will be a multi level funciton, which will do multiple things:
        /*
        1.  to create a new task if not existing before
        2. this will not wake a sleeping or a dead task, rather it will create a new task
        3. and also call execute Prompt (a new function) to give the prompt the AI agent
        */
        try {
            let wpData: any = {};
            let databaseService = DatabaseService.getInstance();



            logger.info('Setting up new task', { userId: userId });
            let ParentTaskData: any = ds.taskId_task.get(parentTaskId); // we will directly inherit the workspace from the parent task
            let wpHandler = databaseService.getRepository<Workspaces>(ds.UserInfo.get(userId)?.dbName, CollectionNames.WORKSPACES);
            wpData = await wpHandler.findOne({
                wpId: ParentTaskData.wpId as any
            });

            let userData: IUser = ds.UserInfo.get(userId as string) as any;
            let taskId = data.newTaskId;
            this.upsertTaskInMemory(userId, taskId, TaskStatus.Starting, {
                taskId,
                createdBy: userId,
                startedByUserId: userId,
                wpId: wpData.wpId,
                taskName: ParentTaskData.taskName,
                branchName: data.branchName,
                metadata: ParentTaskData.metadata,
                taskType: TaskTypeEnum.CHILD_TASK,
                ParentTaskId: parentTaskId
            });

            await databaseService.ensureCollection(userData.dbName, CollectionNames.TASKS as any);
            let taskHandler = databaseService.getRepository<Task>(userData.dbName, CollectionNames.TASKS);
            let sessionId = uuidv4();
            let chatHistoryPath = `${userData.organizationName}/task/${taskId}/${sessionId}`;

            //storing the first acitivity log that task has been started
            const userName = userData && userData.firstName && userData.lastName
                ? `${userData.firstName} ${userData.lastName}`
                : (userData?.userName || userData?.name || userData?.userId || "User");
            const activity = {
                id: `activity_${Date.now()}`,
                type: "comment",
                description: "Started task",
                timestamp: new Date().toISOString(),
                user: userData?.userId || "user1",
                userName: userName,
                isAgent: false
            };

            let result = await taskHandler.insertOne({ // this is a temporary addition in db
                taskId: taskId,
                wpId: wpData?.wpId as any,
                createdBy: userData.userId,
                createdAt: new Date(),
                permissionScopes: ParentTaskData.permissionScopes as any,
                EC2InstanceIP: "", // will be updated in db
                status: TaskStatus.Starting,
                chromaDataFolderPath: "",
                AIMetadataFolderPath: "",
                chromaServerPort: 8080,
                metadata: ParentTaskData.metadata,
                taskFolderPath: "", // will be updated in db
                sessionId_chatHistoryData: { [sessionId]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() } } as Record<string, ds.chatHistoryData>,
                branchName: data.branchName,
                wpName: wpData?.workspaceName as any,
                repoDetails: [], // to be updated in db
                systemPrompts: [], // to be updated in db
                taskType: TaskTypeEnum.CHILD_TASK,
                parentTaskId: parentTaskId,
                sharedMemoryPath: ParentTaskData.sharedMemoryPath

            });


            let folderPath = `/mnt/f/PhantomX-workspace/${taskId}`;
            let repoInfo: any[] = [];
            for (let i of wpData.repoDetails) {
                repoInfo.push({
                    repoName: i.repoName,
                    branchName: data.branchName
                });
            }

            let setupWorkspace = new SetupWorkspaceForSetup(
                userData?.dbName as any,
                userData?.organizationName as any,
                userId as string,
                "",
                "",
                wpData?.workspaceName,
                wpData.wpId,
                taskId,
                data?.description,
                data?.tags
            );
            let terminal_sessionID: any;
            try {
                terminal_sessionID = await setupWorkspace.finalizeTaskSelfHosted(folderPath, repoInfo, io.sockets.sockets.get(ds.taskId_task.get(parentTaskId)?.socketId) as any, false, ParentTaskData.permissionScopes, data.metadata, data.branchName);
            }
            catch (ex) {
                console.log(ex);
            }
            let status = !data?.cascadeOn ? TaskStatus.Waiting : TaskStatus.Running;

            const newTaskData: ds.RunningTaskData = {
                taskId: taskId,
                EC2Type: EC2Type.Task,
                playwrightUrl: ``,
                taskName: ParentTaskData.taskName,
                wpId: ParentTaskData.wpId,
                organizationId: userData?.organizationId as any,
                organizationName: userData?.organizationName as any,
                startedByUserId: userData?.userId as any,
                folderPath: folderPath,
                ec2InstanceIP: '',
                startedAt: new Date(),
                nonRunningSince: new Date(),
                status: status,
                createdBy: userId,
                metadata: ParentTaskData.metadata,
                assignedEc2InstanceId: '',
                chromaDbPort: '',
                assignedEc2PublicDns: '',
                isIndexerRunning: false,
                userDockerTerminalUrl: '',
                taskSessionId: uuidv4(),
                socketId: ds.taskId_task.get(parentTaskId)?.socketId,
                sessionId_chatHistoryData: terminal_sessionID.sessionId_chatHistoryData as any,
                branchName: data.branchName,
                repoDetails: terminal_sessionID.repoDetails,
                workspaceName: terminal_sessionID.workspaceName,
                isDependencyInstalled: false,
                sharedMemoryPath: `${setupWorkspace.folderPath}/.AIMetadata/sharedMemory`
            };
            //getting and setting the a new chat session Id
            const latestSessionId = newTaskData ? this.getLatestSessionId(newTaskData.sessionId_chatHistoryData) : null;
            let agent = new Agent(1, newTaskData.folderPath, Operations.CODING_AGENT, newTaskData.ec2InstanceIP, newTaskData.sessionId_chatHistoryData[latestSessionId as string]?.chatHistoryFileName, newTaskData.taskId, newTaskData.createdBy, AgentTypeEnum.MASTER_AGENT, AccessRightsChildAgent, true, newTaskData.sharedMemoryPath, data.modelKey, path.basename(newTaskData.folderPath), undefined, undefined, undefined, latestSessionId as string);
            ds.agentId_agent.set(agent.agentId, agent);
            newTaskData.Agent = agent; // created and set the agent.
            agent.parentAgent = parentAgentId;
            agent.parentTaskId = parentTaskId;

            newTaskData.ParentTaskId = parentTaskId;
            // appending this task to the parent task in the child Task
            ds.taskId_task.get(parentTaskId)?.childTasks?.push(newTaskData.taskId);


            //creating a new agent for this task which will be the main agent of this task
            this.upsertTaskInMemory(userId, taskId, status, newTaskData);
            // Get the same reference from taskId_task and add to userId_task array
            const taskReference = ds.taskId_task.get(taskId);
            if (taskReference) {
                const existingUserTasks = ds.userId_task.get(userId) || [];
                existingUserTasks.push(taskReference);
                ds.userId_task.set(userId, existingUserTasks);
            }

            //storing the temporary message if any
            //fetching the id

            //  startPlaywrightServer(newTaskData.ec2InstanceIP, terminal_sessionID.playwrightPort, setupWorkspace.folderPath);

            //  setupChromaAndIndexer(newTaskData);

            //  this.checkUserTerminal(taskId, socket); // to check when the docker terminal has started to work

            logger.success('Task setup completed successfully', { taskId, wpId: data.wpId, userId: userId });

            // now we will be calling start task
            //before calling the start task we will be updating the status of the task to running, because cascading will only be turned on when the
            // message is sent along with the start task
            this.upsertTaskInMemory(userId, taskId, TaskStatus.Running, {
                ...newTaskData,
                status: TaskStatus.Running
            });
            let dbService = getDBService();


            await taskHandler.updateOne({ taskId: taskId }, { $set: { status: status } });
            //now the logic will be of start task and then execute prompt.
            //inserting the new taskId in childTaskId array of the parent task in db
            taskHandler.updateOne({ taskId: taskId },
                {
                    $set: { sharedMemoryPath: newTaskData.sharedMemoryPath },
                    $push: { childTaskIds: taskId }
                }
            );


            PromptExecutionService.executePrompt({
                sessionId: latestSessionId as string,
                agentId: agent.agentId,
                taskId: taskId,
                modelKey: data.modelKey,
                prompt: data?.initialPrompt as string,
                attachments: [],

            }, io.sockets.sockets.get(ds.taskId_task.get(parentTaskId)?.socketId) as any, io, activeControllers)

            return {
                success: true,
                taskId: taskId
            }

        }
        catch (ex) {
            logger.error("Error in startTaskInternal for swarms feature", ex);
        }





    }
    /**
     * Start a task
     */

    static async startTask(data: any, socket: any, io: Server): Promise<any> {
        try {
            // Wait for task deletion to complete using async 
            // polling (non-blocking)
            /*
            Data will have these many fields:
            taskId,
            cascadeOn:boolean?
            initialPrompt?

            */

            const maxWaitTime = 60000; // 60 seconds maximum wait
            const pollInterval = 100; // Check every 100msf
            const startTime = Date.now();

            while (ds.pendingTaskDeletions.get(data.taskId)) {
                // Check if we've exceeded maximum wait time
                if (Date.now() - startTime > maxWaitTime) {
                    console.log(`Task ${data.taskId} deletion timeout - proceeding anyway`);
                    break;
                }

                // Use non-blocking async wait
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            if (!socket.connected) {
                return;
            }
            if (data?.cascadeOn && data?.initialPrompt) {

                this.upsertTaskInMemory(socket.data.user.userId, data?.taskId, TaskStatus.Running, {

                    taskId: data?.taskId,
                    createdBy: socket.data.user.userId,
                    startedByUserId: socket.data.user.userId
                });
                this.changeTaskStatusInDB(data?.taskId, socket, TaskStatus.Running);
            }
            data.task = ds.taskId_task.get(socket.data.user.taskId)?.taskId;
            //if the incoming task is already in the in memory ds then dont allow it to open it.
            let databaseService = DatabaseService.getInstance();
            let taskHandler = databaseService.getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
            let taskData: any = await taskHandler.findOne({
                taskId: data.taskId as any
            });
            let userData: any = ds.UserInfo.get(socket.data.user.userId as string);

            const latestSessionId: any = this.getLatestSessionId(taskData.sessionId_chatHistoryData);
            if (data?.initialPrompt) {
                temporaryChatData.set(latestSessionId, {
                    "role": "user",
                    "content": [
                        {
                            type: "text",
                            text: data?.initialPrompt
                        }

                    ]
                });
            }

            const allTasks = Array.from(ds.userId_task.values()).flat();
            const isTaskAlreadyRunning = allTasks.some(v => v.taskId === data.taskId);
            const currentRunningTask: any = allTasks.find(v => v.taskId === data.taskId);
            let userId = taskData.createdBy;
            if (taskData && (socket == null || (socket != null && taskData.createdBy === socket.data.user.userId)) && !isTaskAlreadyRunning) {

                //this is the case when we will need to start the task from scratch so we will send a socket to inform client that show the loading in the ui
                socket.emit("start_task_loading", {
                    taskId: data.taskId
                });

                let folderPath = taskData.taskFolderPath;
                let repoInfo: any[] = [];
                for (let i of taskData.repoDetails) {
                    repoInfo.push({
                        repoName: i.repoName,
                        branchName: taskData.branchName
                    });
                }

                let selfHostedSocket: any = ds.userId_orchestratorSocket.get(userId);
                if (selfHostedSocket) {
                    let promise = new Promise((resolve, reject) => {
                        selfHostedSocket.emit('start_local_task', {
                            folderPath: folderPath,
                            taskId: data.taskId,
                            repos: repoInfo // this is in the format of the structure defined in PhantomX_Controller repository, we need to create that object to send to that
                        }, (result: any) => {
                            if (result.success) {
                                logger.success("setup is successful at the client's local machine");
                                resolve({
                                    success: true
                                });
                            }
                            else {
                                logger.error("setup failed at the client's local machine=>", result.error);
                                reject({
                                    success: false,
                                    error: result.error
                                });
                            }
                        })
                    });
                    let result = await promise;


                    const newStatus = !data?.cascadeOn ? TaskStatus.Waiting : TaskStatus.Running;
                    let newTaskData: ds.RunningTaskData = {
                        socketId: socket.id,
                        taskName: taskData.metadata?.title,
                        playwrightUrl: ``,
                        taskId: data.taskId,
                        wpId: taskData.wpId,
                        createdBy: socket.data.user.userId,
                        organizationId: userData?.organizationId as any,
                        organizationName: userData?.organizationName as any,
                        startedByUserId: userData?.userId as any,
                        folderPath: folderPath,
                        ec2InstanceIP: '',
                        startedAt: new Date(),
                        nonRunningSince: new Date(),
                        taskSessionId: uuidv4(),
                        status: newStatus,
                        metadata: taskData.metadata,
                        assignedEc2InstanceId: '',
                        chromaDbPort: '',
                        assignedEc2PublicDns: '',
                        isIndexerRunning: false,
                        branchName: taskData.branchName,
                        sessionId_chatHistoryData: taskData.sessionId_chatHistoryData as any,
                        userDockerTerminalUrl: '',
                        repoDetails: taskData?.repoDetails,
                        workspaceName: taskData.workspaceName,
                        isDependencyInstalled: false,
                        EC2Type: EC2Type.Task,
                        sharedMemoryPath: ``// we will add this later when we require it.
                    };

                    socket.data.user.taskId = newTaskData.taskId;

                    newTaskData = this.upsertTaskInMemory(socket.data.user.userId, newTaskData.taskId, newStatus, newTaskData);
                    // Get the same reference from taskId_task and add to userId_task array
                    const taskReference = ds.taskId_task.get(newTaskData.taskId);
                    if (taskReference) {
                        const existingUserTasks = ds.userId_task.get(socket.data.user.userId) || [];
                        existingUserTasks.push(taskReference);
                        ds.userId_task.set(socket.data.user.userId, existingUserTasks);
                    }

                    ////////////////  setupChromaAndIndexer(newTaskData);

                    //  this.checkUserTerminal(newTaskData.taskId, socket);

                    //creating the agent for this newly started task
                    let agent = new Agent(3, newTaskData.folderPath, Operations.CODING_AGENT, newTaskData.ec2InstanceIP, newTaskData.sessionId_chatHistoryData[latestSessionId as string]?.chatHistoryFileName, newTaskData.taskId, newTaskData.createdBy, AgentTypeEnum.MASTER_AGENT, AccessRightsParentAgent, false, newTaskData.sharedMemoryPath, data.modelKey, path.basename(newTaskData.folderPath), undefined, undefined, undefined, latestSessionId as string);
                    ds.agentId_agent.set(agent.agentId, agent);
                    newTaskData.Agent = agent; // created and set the agent.
                    if (data?.cascadeOn) {
                        //call execute prompt
                        let data1: any = {
                            sessionId: latestSessionId,
                            taskId: newTaskData.taskId,
                            prompt: data?.initialPrompt as string,
                            modelKey: data?.modelKey as string,
                            agentId: newTaskData.Agent.agentId
                        };
                        PromptExecutionService.executePrompt(data1, socket, io, activeControllers,);
                    }
                    return {
                        success: true,
                        folderPath: folderPath,
                        dockerTerminalUrl: newTaskData.userDockerTerminalUrl,
                        latestSessionId: latestSessionId,
                        taskId: data.taskId
                    };
                }
            }
            else if ((taskData && taskData.createdBy === socket.data.user.userId) && (taskData && isTaskAlreadyRunning && (ds.taskId_task.get(data.taskId)?.socketId == null ||
                ds.taskId_task.get(data.taskId)?.socketId === undefined || io.sockets.sockets.get(ds.taskId_task.get(data.taskId)?.socketId)?.connected === false))) {
                // in this case the user is just asking from the folderPath so better return it
                socket.data.user.taskId = data.taskId;
                let currentTaskData: any = ds.taskId_task.get(socket.data.user.taskId);
                const latestSessionId: any = currentTaskData ? this.getLatestSessionId(currentTaskData.sessionId_chatHistoryData) : null;
                
                currentTaskData.socketId = socket.id;
                currentTaskData = this.upsertTaskInMemory(socket.data.user.userId, data.taskId, currentTaskData.status, {
                    ...currentTaskData,
                    socketId: socket.id,
                    createdBy: socket.data.user.userId,
                    startedByUserId: socket.data.user.userId
                });

                if(currentTaskData.Agent == null)
                {
                    let agent = new Agent(1, currentTaskData.folderPath, Operations.CODING_AGENT, currentTaskData.ec2InstanceIP, currentTaskData.sessionId_chatHistoryData[latestSessionId]?.chatHistoryFileName, currentTaskData.taskId, currentTaskData.createdBy, AgentTypeEnum.MASTER_AGENT, AccessRightsParentAgent, false, currentTaskData.sharedMemoryPath, data.modelKey, path.basename(currentTaskData.folderPath), undefined, undefined, undefined, latestSessionId as string);
                    ds.agentId_agent.set(agent.agentId, agent);
                    currentTaskData.Agent = agent;
                    
               
                }   
                if (data?.cascadeOn) {
                    //call execute prompt
                    this.upsertTaskInMemory(socket.data.user.userId, data.taskId, TaskStatus.Running, {
                        ...currentTaskData,
                        socketId: socket.id,
                        createdBy: socket.data.user.userId,
                        startedByUserId: socket.data.user.userId
                    });
                    this.changeTaskStatusInDB(data.taskId, socket, TaskStatus.Running);
                    let data1: any = {
                        sessionId: latestSessionId,
                        taskId: taskData.taskId,
                        prompt: data?.initialPrompt as string,
                        agentId: currentTaskData.Agent?.agentId
                    };
                    PromptExecutionService.executePrompt(data1, socket, io, activeControllers);


                }

                return {
                    success: true,
                    folderPath: currentTaskData?.folderPath,
                    dockerTerminalUrl: currentTaskData?.userDockerTerminalUrl,
                    latestSessionId: latestSessionId,
                    taskId: data.taskId
                };

            }
            else if (isTaskAlreadyRunning) {
                return {
                    success: false,
                    message: "This task is open in another tab or browser, do you want to close that and open in the current tab?",
                    statusCode: 500
                };
            }
            else {
                return {
                    success: false,
                    message: 'user is not authorized to open this task',
                    statusCode: 404
                };
            }


        }

        catch (ex) {
            console.error('\n[ERROR] start_task failed:', {
                timestamp: new Date().toISOString(),
                userId: socket.data.user.userId,
                taskId: data.taskId,
                socketId: socket.id,
                error: ex instanceof Error ? ex.message : ex,
                stack: ex instanceof Error ? ex.stack : undefined
            });
            return {
                success: false,
                message: ex
            };
        }
    }

    /**
     * Get all tasks for a user
     */
    static async getTasks(data: any, socket: Socket): Promise<any> {
        try {
            let user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) {
                return {
                    success: false,
                    message: "User data not found"
                };
            }
            let dbService = await getDBService();
            let taskRepository = dbService.getRepository<Task>(user?.dbName as any, CollectionNames.TASKS);
            let availableTasks = await taskRepository.find({
                createdBy: user.userId
            });
            return {
                success: true,
                tasks: availableTasks
            };
        }
        catch (ex) {
            console.error('\n[ERROR] get_tasks failed:', {
                timestamp: new Date().toISOString(),
                userId: socket.data.user?.userId,
                socketId: socket.id,
                error: ex instanceof Error ? ex.message : ex,
                stack: ex instanceof Error ? ex.stack : undefined
            });
            return {
                success: false,
                message: ex
            };
        }
    }

    /**
     * Get workspace tasks
     */
    static async getWorkspaceTasks(data: any, socket: Socket): Promise<any> {
        try {
            let userData = ds.UserInfo.get(socket.data.user.userId as string);
            if (!userData) {
                return {
                    success: false,
                    message: "User data not found"
                };
            }
            const { wpId } = data;
            if (!wpId) {
                return {
                    success: false,
                    message: "Workspace ID is required"
                };
            }
            //we can later also check here to see if user has access to this workspace
            let dbService = await getDBService();
            let taskRepository = dbService.getRepository<Task>(userData?.dbName as any, CollectionNames.TASKS);
            let tasks = await taskRepository.find({
                wpId: wpId as any
            });
            //we are only showing the tasks that are created by user
            tasks = tasks.filter(t => t.createdBy === socket.data.user.userId);
            return {
                success: true,
                tasks: tasks
            };
        }
        catch (ex) {
            console.error('\n[ERROR] get_workspace_tasks failed:', {
                timestamp: new Date().toISOString(),
                userId: socket.data.user?.userId,
                wpId: data?.wpId,
                socketId: socket.id,
                error: ex instanceof Error ? ex.message : ex,
                stack: ex instanceof Error ? ex.stack : undefined
            });
            return {
                success: false,
                message: ex
            };
        }
    }

    /**
     * Abort a task
     */
    static async abortTask(data: any, socket: Socket): Promise<any> {
        try {
            let taskData = ds.taskId_task.get(socket.data.user.taskId);
            if (taskData && taskData.status === TaskStatus.Running) {
                // cold killing the task
                coldKillTask(socket, data?.taskId);
            }
            else if (taskData && taskData.status !== TaskStatus.Running) {
                CleanTask(socket, socket.data.user.taskId, taskData.status);
            }
            return { success: true };
        }
        catch (ex) {
            console.error('\n[ERROR] abort_task failed:', {
                timestamp: new Date().toISOString(),
                userId: socket.data.user?.userId,
                taskId: socket.data.user?.taskId,
                socketId: socket.id,
                error: ex instanceof Error ? ex.message : ex,
                stack: ex instanceof Error ? ex.stack : undefined
            });
            return {
                success: false,
                message: ex
            };
        }
    }

    /**
     * Kill a task
     */
    static async killTask(data: any, socket: Socket): Promise<any> {
        try {
            // this task will be completely removed i.e ec2 resources reallocated and AI agent is stopped and containers stopped and removed along with the images, only when the task is not running and the user is not on the screen, if the user is not on the screen in that case that task cannot be found in socket_task data strucutre
            CleanTask(socket, socket.data.user.taskId, TaskStatus.Stopped);

            console.log("\n task cleaned successfully" + data.taskId);
            return {
                success: true
            };
        }
        catch (ex) {
            console.error('\n[ERROR] kill_task failed:', {
                timestamp: new Date().toISOString(),
                userId: socket.data.user?.userId,
                taskId: data?.taskId,
                socketId: socket.id,
                error: ex instanceof Error ? ex.message : ex,
                stack: ex instanceof Error ? ex.stack : undefined
            });
            return {
                success: false,
                message: ex
            };
        }
    }

    /**
     * Delete tasks
     */
    static async deleteTasks(data: any, socket: Socket): Promise<any> {
        try {
            //deleting the task from the workspace and the metadata of the task
            // we are storing task data in the efs2 and efs1, as well, in efs2 we are storing the .AIMetadata and chroma data for the task and in efs1 we are storing the actual project files

            // we will be recving an array of the ids of the task to be deletd
            for (let taskId of data.taskIds) {
                await DeleteTask(taskId, socket);
            }
            return {
                success: true,
                message: ' task deleted successfully'
            };
        }
        catch (ex) {
            logger.error("\n error occured in deleting the task for==>", data.task.ids);
            return {
                success: false,
                message: " task deletion failed due to the reason" + ex
            };
        }
    }
    static async getSubTasksUI(data: any, socket: any) {
        try {
            let taskData: any = ds.taskId_task.get(data.taskId);
            let subTaskData = [];
            for (let taskId of taskData.childTasks || []) {

            }
        }
        catch (ex) {
            logger.error("\n error occured in fetching the sub tasks for==>", data.taskId);
            return {
                success: false,
                message: ex
            }
        }
    }

    /**
     * Rename a task (update metadata.title)
     */
    static async renameTask(data: any, socket: Socket): Promise<any> {
        try {
            const { taskId, newName } = data;
            if (!taskId) {
                return { success: false, error: 'taskId is required' };
            }
            if (!newName || !newName.trim()) {
                return { success: false, error: 'newName is required' };
            }
            const user = ds.UserInfo.get(socket.data.user.userId as string);
            if (!user) {
                return { success: false, error: 'User not found' };
            }
            const dbService = await getDBService();
            const taskRepository = dbService.getRepository<Task>(user.dbName, CollectionNames.TASKS);
            const task = await taskRepository.findOne({ taskId });
            if (!task) {
                return { success: false, error: 'Task not found' };
            }
            if (task.createdBy !== socket.data.user.userId) {
                return { success: false, error: 'Not authorized to rename this task' };
            }
            const trimmedName = newName.trim();
            await taskRepository.updateOne(
                { taskId },
                { $set: { 'metadata.title': trimmedName } }
            );
            // Also update in-memory if running
            const runningTask = ds.taskId_task.get(taskId);
            if (runningTask) {
                runningTask.taskName = trimmedName;
                if ((runningTask as any).metadata) {
                    (runningTask as any).metadata.title = trimmedName;
                }
                ds.taskId_task.set(taskId, runningTask);
            }
            return { success: true, newName: trimmedName };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : err };
        }
    }
}
