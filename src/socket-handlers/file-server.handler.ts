// this will be handling the file server events
import { Server, Socket } from 'socket.io';
import { FolderStructureImplementation } from '../Implementation/FolderStructureImplementation';
import { Operations } from '../classes/OperationsEnum';
import { FolderRequest, FileRequest, MessageData, ClientData } from '../classes/file_server';
import { io as ioClient } from 'socket.io-client';
const SSHClient = require('../Services/ssh-client');
import { Agent } from '../Services/agent-system';
import * as ds from '../DataStructures';
import { fileServerClientManager } from '../Services/FileServerClientManager';
import { toolServerClientManager } from '../Services/ToolServerClientManager';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../DataAccessLayer';
import { getDBService } from '../DataAccessLayer/db-connection';
import { Task } from '../DataAccessLayer/models/Task';
import { Collection } from 'chromadb';
import { CollectionNames } from '../DataAccessLayer/models';
import { ChatHistoryService } from './../Services/ChatHistoryService';
import { CleanTask, SetupWorkspaceForSetup } from '../Services/SetupWorkspace';
import { checkSubscription } from "../Services/SubscriptionService";
import { Workspaces } from '../DataAccessLayer/models/Workspaces';
import { TaskStatus } from '../DataAccessLayer/models/Task';
import * as path from 'path';
import { sendNotification } from '../Services/NotificationService';
import * as ModelInfo from './../DataAccessLayer/models/ModelInformation';
import { constraintHandlerClass } from '../Services/constraintsService';
import { constraintTypes } from '../model/Plans';
import { Logger } from '../utils/Logger';
import { workerData } from 'worker_threads';
import { PromptExecutionService } from '../Services/PromptExecutionService';
import { TaskAction, TaskQueueService } from '../Services/TaskQueueService';

export const activeControllers = new Map<string, AbortController>();

export async function file_server_handler(io: Server, socket: Socket, connectedClients: any) {
    
    let logger = new Logger('file-server-handler');
    // Initialize chat history service
    const chatHistoryService = new ChatHistoryService();

    const liveEventId: string = socket.data.user.taskId ?? socket.data.user.wpId;
    if (liveEventId) {
        toolServerClientManager.subscribeUserSocket(liveEventId, socket);
        socket.on('disconnect', () => {
            toolServerClientManager.unsubscribeUserSocket(liveEventId, socket);
        });
    }


    // let ec2_ip = ds.socket_task.get(socket)?.ec2InstanceIP as any;
    // const agent = new Agent(1, '/mnt/efs/AI_CODER',Operations.CODING_AGENT,ec2_ip || 'localhost'); // Using SSH mode for remote execution
    // await agent.connect();
    //handler to get the git changes
    socket.on('get_git_changes', async (data: any) => {
        let id: string = socket.data.user.taskId ?? socket.data.user.wpId;

        try {
            const result = await toolServerClientManager.sendToolRequest(id, 'Github_GetGitChanges', {
                path: data.data
            });
            socket.emit('git_changes_response', result);
        } catch (error: any) {
            logger.error('[get_git_changes] Tool server error:', error);
            socket.emit('git_changes_response', { success: false, error: error.message });
        }
    });
    socket.on("merge_branch", async (data: any) => {
        // console.log("Received merge branch:", data);
        let runningTask = ds.taskId_task.get(socket.data.user.taskId);
        let id: string = socket.data.user.wpId == undefined || socket.data.user.wpId == null ? socket.data.user.taskId : socket.data.user.wpId
        let fileServerClient = fileServerClientManager.getOrCreateClient(id, runningTask?.ec2InstanceIP as any, socket);
        let wpId = runningTask?.wpId;
        let userData = ds.UserInfo.get(socket.data.user.userId);
        let databaseService = DatabaseService.getInstance();
        let workspaceRepository = databaseService.getRepository<Workspaces>(userData?.dbName as string, CollectionNames.WORKSPACES);
        let workspaceDoc = await workspaceRepository.findOne({ wpId: wpId });

        let workspaceBranch = workspaceDoc?.repoDetails[0]?.branchName;

        fileServerClient?.emit('merge_branch', { repoName: data.repoName, targetBranch: workspaceBranch });
    });
    socket.on("discard_file_changes", async (data: any) => {
        let id: string = socket.data.user.taskId ?? socket.data.user.wpId;

        try {
            const result = await toolServerClientManager.sendToolRequest(id, 'Github_DiscardFileChanges', {
                repoName: data.repoName,
                filePath: data.filePath
            });
            socket.emit('discard_file_changes_response', result);
        } catch (error: any) {
            logger.error('[discard_file_changes] Tool server error:', error);
            socket.emit('discard_file_changes_response', { success: false, error: error.message });
        }
    });

    // Handler to get diff for a single file on demand (lazy loading)
    socket.on("get_file_diff", async (data: { repoPath: string; filePath: string; status: string }, callback) => {
        let id: string = socket.data.user.taskId ?? socket.data.user.wpId;

        try {
            const result = await toolServerClientManager.sendToolRequest(id, 'Github_GetFileDiff', {
                repoPath: data.repoPath,
                filePath: data.filePath,
                status: data.status
            });

            if (callback) {
                callback(result);
            } else {
                socket.emit('file_diff_response', result);
            }
        } catch (error: any) {
            logger.error('[get_file_diff] Tool server error:', error);
            const errResult = { success: false, error: error.message };
            if (callback) {
                callback(errResult);
            } else {
                socket.emit('file_diff_response', errResult);
            }
        }
    });


    socket.on('delete_chat_history', async (data: any, callback) => {
        const result = await chatHistoryService.deleteChatHistory(socket, data.sessionId);
        callback(result);
    });
    socket.on('get_chat_history_list', async (data: any, callback) => {
        const taskId = data.taskId;
        const result = await chatHistoryService.getChatHistoryList(socket, taskId);
        callback(result);
    });

    socket.on('get_chat_history', async (data: any, callback) => {
        const taskId = data.taskId;
        const result = await chatHistoryService.getChatHistory(socket, data.session_id, taskId);
        callback(result);
    });
    socket.on('create_new_chat_session', async (data: any, callback) => {
        const result = await chatHistoryService.createNewChatSession(data.taskId, activeControllers,socket);
        callback(result);
    });
socket.on('execute_prompt_workspace', async (data: any) => {
        await PromptExecutionService.executePromptWorkspace(data, socket, activeControllers, logger);
    });
    // Handle prompt execution
socket.on('execute_prompt', async (data: any) => {
        if (data?.queue === true) { // to queue this for later usage with start task and setup task and execute prompt.
            TaskQueueService.enqueue(data.taskId, { socket, io, data, action: TaskAction.ExecutePrompt, activeControllers, callback: () => {} });
        } else {
            await PromptExecutionService.executePrompt(data, socket, io, activeControllers);
        }
    });
    socket.on("get_available_models", async (data: any, callback) => {
        const legacyModels = Object.values(ModelInfo.available_models).filter(
            (value) => typeof value === 'string' && value !== 'Amazon_tital_text_embeddings'
        );

        try {
            const dbService = await getDBService();
            const modelRepository = dbService.getRepository<ModelInfo.LLMInfo>('General', 'ModelInformation');
            const modelRecords = await modelRepository.find();
            const modelDetails = modelRecords
                .filter(model => model.modelKey !== 'Amazon_titan_text_embeddings')
                .map(model => ({
                    modelKey: model.modelKey,
                    displayName: model.displayName || model.modelKey,
                    providerType: model.providerType,
                    supportsTools: model.supportsTools,
                    supportsThinking: model.supportsThinking
                }));
            const models = Array.from(new Set([
                ...legacyModels,
      
            ]));

            callback({ success: true, models, modelDetails });
        } catch (error) {
            logger.error('Failed to load database model information', error);
            callback({ success: true, models: legacyModels, modelDetails: [] });
        }
    });

    // Handle cancellation
socket.on('cancel_prompt', async () => {
        await PromptExecutionService.cancelPrompt(socket, activeControllers);
    });

    // Handle terminal query execution
    socket.on('execute_terminal_query', async (data: { query: string }) => {
        // console.log('Received terminal query:', data.query);
        let folderPath = ds.taskId_task.get(socket.data.user.taskId)?.folderPath as any;
        let ec2_ip = ds.taskId_task.get(socket.data.user.taskId)?.ec2InstanceIP as any;
        const ssh = new SSHClient(folderPath, ec2_ip);
        try {
            await ssh.connect(); // Connect to the SSH server
            const result = await ssh.executeCommand(data.query);
            socket.emit('terminal_query_response', { success: true, output: result }); // Send the output back to the client
        } catch (error) {
            console.error('Error executing terminal query:', error);
            socket.emit('terminal_query_response', { success: false, error: (error as any).message }); // Send error back to the client
        } finally {
            ssh.disconnect();
        }
    });


    // Handle file processes
    socket.on('file_process', async (data: { command: string, address: string, processData: any }, callback) => {
        //// // console.log('Received file process:', data);
        let runningTask = ds.taskId_task.get(socket.data.user.taskId);
        let id: string = socket.data.user.wpId == undefined || socket.data.user.wpId == null ? socket.data.user.taskId : socket.data.user.wpId
        let fileServerClient = fileServerClientManager.getOrCreateClient(id, runningTask?.ec2InstanceIP as any, socket);

        fileServerClient?.emit('file_process', { command: data.command, address: data.address, processData: data.processData });


    });

    socket.on("get_folder_structure", async (data: any) => {
        try {

            const maxWaitTime = 30000; // 30 seconds maximum wait
            const pollInterval = 100; // Check every 100ms
            const startTime = Date.now();

            while (ds.pendingTaskDeletions.get(data?.taskId)) {
                // Check if we've exceeded maximum wait time
                if (Date.now() - startTime > maxWaitTime) {
                    // console.log(`Task ${data.taskId} deletion timeout - proceeding anyway`);
                    break;
                }

                // Use non-blocking async wait
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            // // console.log("Received get folder structure:", data);
            let id = socket.data.user.taskId === undefined || socket.data.user.taskId === null ? socket.data.user.wpId : socket.data.user.taskId;
            let runningTask = ds.taskId_task.get(id);

            let fileServerClient = fileServerClientManager.getOrCreateClient(id, runningTask?.ec2InstanceIP as any, socket);
            fileServerClient?.emit('get_folder_structure', { path: data.path, reqId: data.reqId, depth: data.depth });
        }
        catch (error) {
            console.error("Error in get_folder_structure:", error);


        }
    });

    socket.on('stream_folder_structure', async (data: any) => {
        try {
            const maxWaitTime = 30000;
            const pollInterval = 100;
            const startTime = Date.now();

            while (ds.pendingTaskDeletions.get(data?.taskId)) {
                if (Date.now() - startTime > maxWaitTime) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            let id = socket.data.user.taskId === undefined || socket.data.user.taskId === null ? socket.data.user.wpId : socket.data.user.taskId;
            let runningTask = ds.taskId_task.get(id);
            let fileServerClient = fileServerClientManager.getOrCreateClient(id, runningTask?.ec2InstanceIP as any, socket);
            fileServerClient?.emit('stream_folder_structure', { path: data.path, reqId: data.reqId });
        } catch (error) {
            console.error('Error in stream_folder_structure:', error);
            socket.emit('folder_structure_response', {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred',
                isComplete: true
            });
        }
    });

    socket.on("get_file_content", async (data: FileRequest) => {
        //  // console.log("Received get file content:", data);
        let runningTask = ds.taskId_task.get(socket.data.user.taskId);
        let id: string = socket.data.user.wpId == undefined || socket.data.user.wpId == null ? socket.data.user.taskId : socket.data.user.wpId
        let fileServerClient = fileServerClientManager.getOrCreateClient(id, runningTask?.ec2InstanceIP as any, socket);

        fileServerClient?.emit('get_file_content', { path: data.path, reqId: data.reqId });
    })


    // Handle diagnostics request from client
    socket.on('request_diagnostics', async (data: { filePath: string }) => {
        // logger.debug("Received diagnostics request", { filePath: data.filePath });
        let runningTask = ds.taskId_task.get(socket.data.user.taskId);
        let id: string = socket.data.user.wpId == undefined || socket.data.user.wpId == null ? socket.data.user.taskId : socket.data.user.wpId;
        let fileServerClient = fileServerClientManager.getOrCreateClient(id, runningTask?.ec2InstanceIP as any, socket);
        
        fileServerClient?.emit('request_diagnostics', { filePath: data.filePath });
    });

    // Cleanup on disconnect
   

    socket.on('error', (error: Error) => {
        console.error('Socket error:', error);
    });

}