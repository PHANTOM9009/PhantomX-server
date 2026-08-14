import { Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import * as ds from '../DataStructures';
import { ChatHistoryS3Service } from './ChatHistoryS3Service';
import { getDBService } from '../DataAccessLayer/db-connection';
import { Task } from '../DataAccessLayer/models/Task';
import { CollectionNames } from '../DataAccessLayer/models';
import { Logger } from '../utils/Logger';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';

// Feature flags for chat history storage (must match agent-system.ts)
const SAVE_HISTORY_TO_S3: boolean = process.env.SAVE_HISTORY_TO_S3 !== 'false';
const SAVE_HISTORY_TO_LOCAL: boolean = process.env.SAVE_HISTORY_TO_LOCAL === 'true';

export interface ChatHistoryResponse {
    success: boolean;
    message?: string;
    result?: any;
    sessionId?: string;
    chatHistoryPath?: string;
    error?: any;
}

export class ChatHistoryService {
    private s3Service: ChatHistoryS3Service;
    private logger = new Logger('ChatHistoryService');
    constructor() {
        this.s3Service = new ChatHistoryS3Service();
    }

    /**
     * Deletes a chat history session
     */
    async deleteChatHistory(socket: Socket, sessionId: string): Promise<ChatHistoryResponse> {
        try {
            const taskData = ds.taskId_task.get(socket.data.user.taskId);

            if (!taskData) {
                return {
                    success: false,
                    message: 'task does not exist on this socket'
                };
            }

            const chatHistoryFileName = taskData.sessionId_chatHistoryData[sessionId]?.chatHistoryFileName;

            if (!chatHistoryFileName) {
                return {
                    success: false,
                    message: 'Chat session not found'
                };
            }

            // Delete from S3 if flag is enabled
            if (SAVE_HISTORY_TO_S3) {
                await this.s3Service.removeFile(chatHistoryFileName);
            }

            // Delete from local chat-history folder if flag is enabled
            if (SAVE_HISTORY_TO_LOCAL) {
                const localPath = path.join(process.cwd(), 'chat-history', chatHistoryFileName);
                if (existsSync(localPath)) {
                    await fs.unlink(localPath);
                }
            }

            // Remove from local map
            delete taskData.sessionId_chatHistoryData[sessionId];

            return {
                success: true,
                message: 'chat session deleted successfully'
            };
        } catch (ex) {
            console.log("exception in deleteChatHistory ==>", ex);
            return {
                success: false,
                message: ex as any
            };
        }
    }

    /**
     * Gets the list of all chat history sessions for the current task
     * Returns session IDs sorted by creation date in descending order (newest first)
     */
    async getChatHistoryList(socket: Socket, taskId?: string): Promise<ChatHistoryResponse> {
        try {
            let task = ds.taskId_task.get(socket.data.user.taskId);

            if (!task) {
                if (taskId) {
                    //running task not found but this is the case that user might want to just see chat history so we fetch the task using taskId
                    const userData = ds.UserInfo.get(socket.data.user.userId);
                    const dbService = await getDBService();
                    const taskRepository = dbService.getRepository<Task>(userData?.dbName, CollectionNames.TASKS);
                    const taskDoc = await taskRepository.findOne({ taskId });
                    if (!taskDoc) {
                        return {
                            success: false,
                            message: 'No task found for the given taskId'
                        };
                    }
                    task = taskDoc as any;
                }
                else return {
                    success: false,
                    message: 'No task found for this socket'
                };
            }
            if (!task) return {
                success: false,
                message: 'No task data found for this socket'
            };
            // Get all sessions with their creation dates
            const sessions = Object.entries(task.sessionId_chatHistoryData);

            // Sort by creation date in descending order (newest first)
            const sortedSessions = sessions.sort((a, b) => {
                const dateA = a[1].CreatedDate instanceof Date ? a[1].CreatedDate : new Date(a[1].CreatedDate);
                const dateB = b[1].CreatedDate instanceof Date ? b[1].CreatedDate : new Date(b[1].CreatedDate);
                return dateB.getTime() - dateA.getTime();
            });

            // Extract session IDs
            let sessionIds = sortedSessions.map(session => ({ sessionId: session[0], chatTopicName: session[1]?.chatTopicName, createdDate: session[1]?.CreatedDate, lastMessageSent: session[1]?.LastMessageSent }));
            if (sessionIds === undefined || sessionIds === null) {
                sessionIds = [];
            }
            return {
                success: true,
                result: sessionIds ?? []
            };
        } catch (ex) {
            console.log("exception in getChatHistoryList ==>", ex);
            return {
                success: false,
                message: ex as any
            };
        }
    }

    /**
     * Gets the chat history content for a specific session
     */
    async getChatHistory(socket: Socket, sessionId: string, taskId: string): Promise<ChatHistoryResponse> {
        try {
            let taskData:any = ds.taskId_task.get(taskId);
            if(taskData!=null && taskData?.Agent?.chatSessionId === sessionId)
            {
                // just return the current conversation hitory with appending the temporary chat data
                const tempChatSessionDataForSession = ds.temporaryChatData.get(sessionId);
                const conversationHistory = structuredClone(taskData.Agent.conversationHistory);
                if(tempChatSessionDataForSession)
                {
                    conversationHistory.push(tempChatSessionDataForSession);
                }
                return {
                    success:true,
                    result: conversationHistory
                }
            }
            if(taskData == null)
            {
                let dbService = await getDBService();
                let taskHandler = dbService.getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
                taskData = await taskHandler.findOne({taskId: taskId});
            }
            
            
            const chatHistoryPath = taskData.sessionId_chatHistoryData[sessionId]?.chatHistoryFileName;

            if (!chatHistoryPath) {
                return {
                    success: false,
                    message: 'Chat session not found'
                };
            }
            try {
                let contentString: string | null = null;

                if (SAVE_HISTORY_TO_S3) {
                    // Load from S3 (S3 is source of truth when enabled)
                    const data = await this.s3Service.getFile(chatHistoryPath);
                    if (data.success && data.content) {
                        contentString = data.content.toString('utf-8');
                    } else {
                        throw new Error(data.error || 'Failed to retrieve chat history from S3');
                    }
                } else if (SAVE_HISTORY_TO_LOCAL) {
                    // Load from local chat-history folder
                    const localPath = path.join(process.cwd(), 'chat-history',sessionId);
                    if (existsSync(localPath)) {
                        contentString = await fs.readFile(localPath, 'utf-8');
                    } else {
                        throw new Error('Chat history file not found in local storage');
                    }
                } else {
                    throw new Error('No history storage is enabled (both SAVE_HISTORY_TO_S3 and SAVE_HISTORY_TO_LOCAL are off)');
                }

                const tempChatKey = sessionId;
                const tempChatDataForSession = ds.temporaryChatData.get(tempChatKey);

                let parsedContent;
                try {
                    parsedContent = JSON.parse(contentString);
                } catch (parseError) {
                    console.log("Failed to parse chat history as JSON, returning as plain text:", parseError);
                    parsedContent = contentString;
                }

                // Append temporary chat data if available
                if (tempChatDataForSession) {
                    if (Array.isArray(parsedContent)) {
                        parsedContent.push(tempChatDataForSession);
                        console.log(`Appended temporary chat data to session ${sessionId}`);
                    } else {
                        console.log(`Parsed content is not an array for session ${sessionId}, cannot append temporary data`);
                    }
                } else {
                    console.log(`No temporary chat data found for session ${sessionId}`);
                }

                return {
                    success: true,
                    result: parsedContent
                };
            }
            catch (ex) {
                // Could not get history from storage — fall back to temporary chat data if available
                const tempChatKey = sessionId;
                const tempChatDataForSession = ds.temporaryChatData.get(tempChatKey);
                if (tempChatDataForSession) {
                    return {
                        success: true,
                        result: [tempChatDataForSession]
                    };
                }
                throw ex;
            }
        } catch (ex) {
            console.log("exception in getChatHistory ==>", ex);
            return {
                success: false,
                message: ex as any
            };
        }
    }

    async createNewAgentChatSession(agentId:string,userId:string,taskId:string)// this will be used to create a new chat session for the sub agent;
    {
        try{

            let userInfo = ds.UserInfo.get(userId);
             if (!userInfo) {
                return {
                    success: false,
                    message: 'User information not found'
                };
            }
            const sessionId = uuidv4();
            const chatHistoryPath = `${userInfo.organizationName}/${userInfo.userId}/task/${taskId}/${agentId}/${sessionId}`;
            return {
                    success: true,
                    sessionId: sessionId,
                    chatHistoryPath: chatHistoryPath,
                    message: 'New chat session created successfully'
                };


        }
        catch(ex)
        {
            this.logger.error(`Error creating new chat session for agent ${agentId}:`, ex);
            return {
                success:false,
                message: `Error creating new chat session for agent ${agentId}: ${ex as any}`
            }
        }
    }
    /**
     * 
     * Creates a new chat session and updates the database this is for the tasks 
     */
    async createNewChatSession(taskId: any, activeControllers: Map<string, AbortController>, socket: Socket): Promise<ChatHistoryResponse> {
        try {
            const taskData: any = ds.taskId_task.get(taskId);

            // if (!taskData) {
            //     return {
            //         success: false,
            //         message: 'No task found for this socket'
            //     };
            // }
            const userInfo = ds.UserInfo.get(socket.data.user.userId);

            if (!userInfo) {
                return {
                    success: false,
                    message: 'User information not found'
                };
            }
            const databaseService = await getDBService();
            const taskHandler = databaseService.getRepository<Task>(userInfo.dbName, CollectionNames.TASKS);


            // Generate new session ID and path
            const sessionId = uuidv4();
            const chatHistoryPath = `${userInfo.organizationName}/${userInfo.userId}/task/${taskId}/${sessionId}`;

            // Add to local task data
            let newUuid = uuidv4();
            if (taskData) {
                taskData.sessionId_chatHistoryData[sessionId] = { chatTopicName: "", chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() };
            }
            // Update the database


            const result = await taskHandler.updateOne(
                { taskId: taskId },
                {
                    $set: {
                        [`sessionId_chatHistoryData.${sessionId}`]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() }
                    }
                }
            );

            // Abort any existing API call
            let agentId = taskData?.Agent?.agentId;
            const controller = activeControllers.get(agentId);
            if (controller) {
                console.log('Aborting the prompt for task due to a new chat session creation:', taskId);
                controller.abort();
                activeControllers.delete(agentId);
            }
            //removing the conversation history from the agent's object, and also changing the new chat session
            if(taskData && taskData.Agent)
            {
                taskData.Agent.conversationHistory = [];
                taskData.Agent.agentConversationHistory = [];
                taskData.Agent.conversationHistoryFileName = chatHistoryPath;
                taskData.Agent.chatSessionid = sessionId;
            }
            if (result && result.modifiedCount > 0) {
              //  taskData.AgentObject.conversationHistory = [];
                return {
                    success: true,
                    sessionId: sessionId,
                    chatHistoryPath: chatHistoryPath,
                    message: 'New chat session created successfully'
                };
            } else {
                return {
                    success: false,
                    message: 'Failed to update task with new session'
                };
            }
        } catch (ex) {
            console.log("exception in createNewChatSession ==>", ex);
            return {
                success: false,
                message: ex as any
            };
        }
    }
}
