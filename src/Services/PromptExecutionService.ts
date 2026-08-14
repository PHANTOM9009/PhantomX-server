import { Server, Socket } from 'socket.io';
import { Agent } from './agent-system';
import * as ds from '../DataStructures';
import { Operations } from '../classes/OperationsEnum';
import { v4 as uuidv4 } from 'uuid';
import { SetupWorkspaceForSetup, CleanTask } from './SetupWorkspace';
import { constraintHandlerClass } from './constraintsService';
import { constraintTypes } from '../model/Plans';
import { getDBService } from '../DataAccessLayer/db-connection';
import { Task, TaskStatus } from '../DataAccessLayer/models/Task';
import { CollectionNames } from '../DataAccessLayer/models';
import { sendNotification } from './NotificationService';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { MessageQueueService } from './swarms/messageQueue';
import { io } from '../socket-server';
import { AgentTypeEnum } from '../classes/AgentTypeEnum';
import { activeControllers } from '../socket-handlers/file-server.handler';
import { AccessRights } from '../classes/ModelAccessRights';
let logger = new Logger('PromptExecutionService');
export class PromptExecutionService {

    static async executePromptWorkspace(data: any, socket: Socket, activeControllers: Map<string, AbortController>, logger: Logger): Promise<void> {

        // this endpoint is specially for the workspace init screen
        /*
        The data will have the following things:
         wpId,
         prompt:
    
        */
        try {
            // creating a new session ID
            let workspaceData: SetupWorkspaceForSetup | any = ds.PendingWorkspaces.get(socket);
            if (workspaceData === null) {
                logger.error('execute_prompt_workspace request came, but there is no workspace against this socket');
                return;

            }
            if (workspaceData.sessionId === null) {
                workspaceData.sessionId = uuidv4();
            }
            const controller = new AbortController();
            const controllerKey = data.taskId || data.wpId;
            activeControllers.set(controllerKey, controller);
            let agent = new Agent(1, workspaceData.folderPath, Operations.WORKSPACE_SETUP, workspaceData.ec2_instance_ip, workspaceData.sessionId,
                data.wpId, socket.data.user.userId, AgentTypeEnum.MASTER_AGENT, [AccessRights.READ_FILES, AccessRights.EXECUTE_COMMAND_TOOL], false);
            let agentResponse = await agent.run(data.prompt, undefined, Operations.WORKSPACE_SETUP, socket, controller.signal);

            if (agentResponse != null) {

                socket?.emit('prompt_response', { success: true, result: agentResponse?.text, chatTopicName: "" });

            }
        }
        catch (ex) {

        }
    }
    static async createTaskTopicName(taskId: string, socket: Socket, chat: string) {
        // this function will set the name of the task in the task document
        try {
            let databaseService = await getDBService();
            let TaskHandler = databaseService.getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
            let task = await TaskHandler.findOne({ taskId: taskId });
            if (task?.metadata?.title != null && task?.metadata?.title === "") {
                // set the topic name for the task
                let agent = new Agent(1, "", Operations.GENERAL_QUERY, "", "", taskId, socket.data.user.userId, AgentTypeEnum.MASTER_AGENT, [AccessRights.READ_FILES], false);
                let agentResponse = await agent.run(`from the given prompt : ${chat}, give a concise and descriptive title for the task in less than 5 words, this title will be used as the topic name for the chat session. Output the title in plain text not a md string. you have to output only the title of the task, dont give any explanation or 
                    anything, we want pure string having only the task name.`, undefined, Operations.GENERAL_QUERY, socket);
                if (agentResponse != null) {
                    let topicName = agentResponse.text;
                    await TaskHandler.updateOne({ taskId: taskId }, {
                        $set: { 'metadata.title': topicName }
                    });
                    // now we got the topic name, lets relay this name to the client
                    socket.emit('update_chat_topic_name', {
                        taskId: taskId,
                        chatTopicName: topicName
                    });


                }
                else {
                    return;
                }
            }
        }
        catch (ex) {
            logger.error('Error in createTaskTopicName:', ex);
        }

    }
    static async executePromptSubAgent(data: any, socket?: Socket, io?: any) {
        /*
        data will have:
        agentId: for storing the in the active controller
        */
        // for executing execute prompt for a subagent.
        try {
            const controller = new AbortController();
            activeControllers.set(data.agentId, controller);

            // now calling the run function via the agent object stored


            let agent = ds.taskId_task.get(data.taskId)?.subAgents?.get(data.agentId);
            if (agent) {
                agent.abortController = controller;
                let result = await agent.run(data.prompt, undefined, Operations.CODING_AGENT, null, controller.signal);
                agent.agentStatus = TaskStatus.Waiting;
                activeControllers.delete(data.agentId);
                if (result) {
                    MessageQueueService.addMessageToQueue(agent.agentId, agent.parentAgent as any, result.text ?? ""); // sending the message back to the main agent
                }
            }
            return {
                succes: true,
                message: "query is submitted to the sub agent"
            }
        }
        catch (ex) {
            logger.error('error in executePromptSubAgent=>', ex);
        }

    }

    static isTaskRunning(taskId: string) {
        // this function will check the status of the sub agents and child tasks, it will set it as running, if any one of them is running
        let running = false;
        let task = ds.taskId_task.get(taskId);
        if (task) {
            for (let [agentId, agent] of task.subAgents || []) {
                running = running || activeControllers.has(agentId);
            }
            for (let childTaskId of task.childTasks || []) {
                running = running || (ds.taskId_task.get(childTaskId)?.status === TaskStatus.Running);
            }
            return running;
        }
    }

    static async executePrompt(data: any, socket: Socket, io: Server, activeControllers: Map<string, AbortController>): Promise<any> {
        /*
        data will have:
        {
            sessionId: <the chat session the user is on>
            taskId: we will also assume that data will contain the task ID from which the command was sent.,
            modelKey: string name of the model against which we will find the enum ( in mongodb we have stored it as enum (key_))
            apiKey?: optional runtime OpenRouter API key; it is not persisted or logged
            prompt: current prompt the user has entered
            agentId: we will need agent ID for executing the prompt.
            attachments: attachments Array [{

            type: 'image'|'jira'|'file'
            value: <>

            }]
        }
        */

        // Check if organization has active subscription
        // const subscriptionCheck = await checkSubscription(socket);
        // if (!subscriptionCheck.success) {
        //     socket.emit('prompt_response', {
        //         success: false,
        //         status: subscriptionCheck.error?.code || 410,
        //         error: subscriptionCheck.error?.message || 'You dont have any active subscription. Please contact your admin'
        //     });
        //     return;
        // }

        // // console.log('Received prompt:', data.prompt);


        //if agentId is not present in the data,that means this has to be excuted by the main master agent.


        PromptExecutionService.createTaskTopicName(data.taskId, socket, data.prompt); //it will set the new chat name for the task if not set already, else it will just return
        let cresult: any = await constraintHandlerClass.constraintHandler(socket.data.user.userId, constraintTypes.executePrompt);
        if (!cresult?.success) {
            socket.emit('prompt_response', {
                success: false,
                error: cresult?.message
            });
            return;
        }

        //setting the agentId of the main agent since it is not coming properly
        if (data.agentId == null) {
            data.agentId = ds.taskId_task.get(data.taskId)?.Agent?.agentId;
        }
        if (activeControllers.has(data.agentId)) {
            socket.emit('prompt_response', {
                success: false,
                error: 'Another prompt is already being processed. Please cancel it first or wait for completion.'
            });
            return;
        }

        const controller = new AbortController();
        activeControllers.set(data.agentId, controller);

        let runningTask: any = ds.taskId_task.get(data.taskId);
        //changing the status of the task to running
        if (!runningTask) {
            // the task is not running hence this is a false request 
            return null;
        }
        io.to(socket.data.user.userId).emit('change_task_status', {
            taskId: data.taskId,
            status: TaskStatus.Running

        });
        let agent;
        if (data.agentId == null) {
            agent = runningTask.Agent;
        }
        else {

            agent = ds.agentId_agent.get(data.agentId);
        }
        //updating the status in db
        let databaseService = getDBService();
        let TaskHandler = (await databaseService).getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
        // Activity log for status change to RUNNING
        const prevStatus = runningTask.status;
        const newStatus = TaskStatus.Running;
        // Fetch latest task for activity log update
        const taskDoc = await TaskHandler.findOne({ taskId: runningTask.taskId });


        let activityLog = (taskDoc?.metadata?.activityLog || []).slice();
        const userData = ds.UserInfo.get(socket.data.user.userId);
        const userName = userData && userData.firstName && userData.lastName
            ? `${userData.firstName} ${userData.lastName}`
            : (userData?.userName || userData?.name || userData?.userId || "User");
        const activity = {
            id: `activity_${Date.now()}`,
            type: "status_change",
            description: `Status changed from ${prevStatus} to ${newStatus}`,
            timestamp: new Date().toISOString(),
            user: userData?.userId || "user1",
            userName: "Phantom",
            isAgent: true,
            metadata: { fromStatus: prevStatus, toStatus: newStatus }
        };
        activityLog.push(activity);



        let chatHistoryData = runningTask?.sessionId_chatHistoryData[data?.sessionId as any];
        // removing the stuff from temporary chat if any once the data comes in, so that duplicate things are not stored in any case.
        //ds.temporaryChatData.delete(data?.sessionId); 

        chatHistoryData.LastMessageSent = new Date();

        await TaskHandler.updateOne({
            taskId: runningTask.taskId
        }, {
            $set: {
                status: newStatus,

                [`sessionId_chatHistoryData.${data.sessionId}.LastMessageSent`]: chatHistoryData.LastMessageSent
            }
        });

        runningTask.status = TaskStatus.Running; // setting the task status to running
        runningTask.nonRunningSince = undefined; // reset non-running timer when task starts running again
        runningTask.AIAbortController = controller; // setting the controller to abort the task

        //checking if the chat topic name is empty, if yes then filling the name

        let topicName = "";
        if (chatHistoryData?.chatTopicName === undefined || chatHistoryData?.chatTopicName === "") // the name is empty
        {
            // we will pick first five words of the user query
            topicName = data.prompt.trim().split(/\s+/).slice(0, 15).join(" ");
            chatHistoryData.chatTopicName = topicName;
            // now updating it in the db
            let dbService = await getDBService();
            let handler = dbService.getRepository<Task>(userData?.dbName, CollectionNames.TASKS);
            handler.updateOne({
                taskId: runningTask.taskId
            }, {
                $set: {
                    [`sessionId_chatHistoryData.${data.sessionId}.chatTopicName`]: topicName
                }
            });
            socket.emit('new_chat_topic_name', {
                chatTopicName: topicName
            });
        }
        else {
            topicName = chatHistoryData.chatTopicName;
        }
        let real_socket: any = runningTask.socketId === null ? socket : io.sockets.sockets.get(runningTask.socketId);


        if (data.sessionId != agent.chatSessionId) {
            // load the new chat by emptying the conversation history and agent chat history
            agent.conversationHistory = [];
            agent.agentConversationHistory = [];
            agent.chatSessionId = data.sessionId;
            agent.conversationHistoryFileName = chatHistoryData.chatHistoryFileName;
        }


        try {
            // changing the model for the given modelKey
           await agent.setLLMModel(data.modelKey, data.apiKey);
            const result: any = await agent.run(data.prompt, undefined, Operations.CODING_AGENT, real_socket, controller.signal, data?.attachments); // Execute the prompt

            activeControllers.delete(data.agentId);
            if (result != null) {

                real_socket?.emit('prompt_response', { success: true, result: result?.text, chatTopicName: topicName });

            }
            if (agent.parentAgent)// if this agent has any parent agent.
            {
                // if this agent has a parent agent lets send the work back to the main parent agent
                MessageQueueService.addMessageToQueue(agent.agentId, agent.parentAgent as any, result.text ?? ""); // sending the message back to the main agent
            }
            //checking if any of the sub agents or child tasks are still running.
            let isTaskRunning = this.isTaskRunning(data.taskId);
            if (!isTaskRunning) {
                runningTask.status = TaskStatus.Waiting;
                runningTask.nonRunningSince = new Date();
            }

            io.to(socket.data.user.userId).emit('change_task_status', {
                taskId: runningTask.taskId,
                status: runningTask.status
            });
            // Activity log for status change (dynamic status)
            const prevStatus2 = taskDoc?.status;
            const newStatus2 = runningTask.status;
            let activityLog2 = (taskDoc?.metadata?.activityLog || []).slice();
            const activity2 = {
                id: `activity_${Date.now()}`,
                type: "status_change",
                description: `Status changed from ${prevStatus2} to ${newStatus2}`,
                timestamp: new Date().toISOString(),
                user: userData?.userId || "user1",
                userName: "Phantom",
                isAgent: true,
                metadata: { fromStatus: prevStatus2, toStatus: newStatus2 }
            };
            activityLog2.push(activity2);
            await TaskHandler.updateOne({
                taskId: runningTask.taskId
            }, {
                $set: {
                    status: newStatus2,

                }
            });
            if ((TaskStatus as any)[runningTask.status] === TaskStatus.Completed) {
                sendNotification(socket.data.user.userId, {
                    message: `Task: ${runningTask.taskName}, Agent is done with its work please check the progress!`
                });
            }
            else if ((TaskStatus as any)[runningTask.status] === TaskStatus.Waiting) {
                const taskName = runningTask.taskName || taskDoc?.metadata?.title || runningTask.taskId;
                sendNotification(socket.data.user.userId, {
                    message: `Task: ${taskName} is waiting for your attention.`,
                    type: 'task_status',
                    taskStatus: runningTask.status,
                    fromStatus: prevStatus2,
                    taskId: runningTask.taskId,
                    taskName
                });
            }


        } catch (error: any) {
            console.error('Error executing prompt:', error);
            if (error.name === 'AbortError' || error.message.includes('abort')) {
                real_socket.emit('prompt_response', {
                    success: false,
                    error: 'Request was cancelled by user',
                    cancelled: true,
                    chatTopicName: topicName
                });
                runningTask.status = TaskStatus.Stopped;
                runningTask.nonRunningSince = new Date();
                io.to(socket.data.user.userId).emit('change_task_status', {
                    taskId: runningTask.taskId,
                    status: runningTask.status
                });
                // Activity log for status change (dynamic status)
                const prevStatus3 = taskDoc?.status;
                const newStatus3 = runningTask.status;
                let activityLog3 = (taskDoc?.metadata?.activityLog || []).slice();
                const activity3 = {
                    id: `activity_${Date.now()}`,
                    type: "status_change",
                    description: `Status changed from ${prevStatus3} to ${newStatus3}`,
                    timestamp: new Date().toISOString(),
                    user: userData?.userId || "user1",
                    userName: "Phantom",
                    isAgent: true,
                    metadata: { fromStatus: prevStatus3, toStatus: newStatus3 }
                };
                activityLog3.push(activity3);
                await TaskHandler.updateOne({
                    taskId: runningTask.taskId
                }, {
                    $set: {
                        status: newStatus3,

                    }
                });
            } else {
                real_socket.emit('prompt_response', { success: false, error: error.message, chatTopicName: topicName });
                runningTask.status = TaskStatus.Failed;
                runningTask.nonRunningSince = new Date();
                io.to(socket.data.user.userId).emit('change_task_status', {
                    taskId: runningTask.taskId,
                    status: runningTask.status
                });
                await TaskHandler.updateOne({
                    taskId: runningTask.taskId
                }, {
                    $set: {
                        status: runningTask.status
                    }
                });
            }
        } finally {


            activeControllers.delete(data.agentId);
            // checking if the taskData has socketId as null, that means the task is disowned, and now that the AI execution is over so we can release it
            let task = ds.taskId_task.get(data.taskId);
            if (task && task.socketId == null) {

                CleanTask(socket, task.taskId, runningTask.status); // completely stopping everything and the task is done

            }

        }
    }

    static async cancelPrompt(socket: Socket, activeControllers: Map<string, AbortController>): Promise<void> {

        const taskId = socket.data.user.taskId;
        //getting the main agent ID
        let agentId: any = ds.taskId_task.get(taskId)?.Agent?.agentId;
        const controller = activeControllers.get(agentId);
        if (controller) {
            // console.log('Cancelling prompt for task:', taskId);
            controller.abort();
            socket.emit('cancel_prompt', { message: 'Cancellation requested' });
            activeControllers.delete(agentId); // deleting the event if existed from the queue

            let userData: any = ds.UserInfo.get(socket.data.user.userId);
            let databaseService = await getDBService();
            await databaseService.ensureCollection(userData.dbName, CollectionNames.TASKS as any);
            let taskHandler = databaseService.getRepository<Task>(userData.dbName, CollectionNames.TASKS);
            logger.success("successfully stopped the main agent prompt==>", taskId);
            //updating the status of the task from Running to Stopped
            io.to(socket.data.user.userId).emit('change_task_status', {
                taskId: taskId,
                status: TaskStatus.Stopped
            });
            let taskData = ds.taskId_task.get(taskId);
            if (taskData) {
                taskData.status = TaskStatus.Stopped;
            }
            taskHandler.updateOne({
                taskId: socket.data.user.taskId,

            },
                {
                    $set: {
                        status: TaskStatus.Stopped
                    }
                });
            // taskStatus
        } else {
            logger.error("error in stopping the prompt of the main agent==>", taskId);
            socket.emit('cancel_prompt', { message: 'No active request to cancel' });
        }
    }
}
