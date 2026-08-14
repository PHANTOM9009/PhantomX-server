import { TaskStatus } from '../../DataAccessLayer/models/Task';
import * as ds from '../../DataStructures';
import { Server, Socket } from 'socket.io';
import { TaskService } from '../TaskService';
 // this service is used to handle the message queues for the agents
import { Logger } from '../../utils/Logger';

import { activeControllers } from '../../socket-handlers/file-server.handler';
import { PromptExecutionService } from '../PromptExecutionService';
import { io } from '../../socket-server';
const logger = new Logger('MessageQueueService');
import { AgentTypeEnum } from '../../classes/AgentTypeEnum';
 export class MessageQueueService
 {
    static async addMessageToQueue(senderAgentId:string,recvrAgentId:string,message:any)
    {
        try{
            let finalMessage:any = {
                senderAgentId: senderAgentId,
                message: message,
            }
            finalMessage = JSON.stringify(finalMessage);
            // checking if the given agent is running or not
            if(activeControllers.has(recvrAgentId))
            {
                //add to the queue only when the agent is running
                let agent = ds.agentId_agent.get(recvrAgentId);
                if(agent)
                {
                    agent.messageQueue.push(message);
                    agent.messageQueueArchive.push(message);
                }

            }
            else{
                // the agent has to be triggered by calling execute prompt for this agent.
                // we need to get the task id for this agent
                let agent:any = ds.agentId_agent.get(recvrAgentId);
                if(agent)
                {
                    // getting the current socket from the task 
                    let task:any = ds.taskId_task.get(agent.taskId);
                    if(task)
                    {
                        // Resolve socket from socketId
                        let socket: Socket | undefined = undefined;
                        if (task.socketId) {
                            socket = io.sockets.sockets.get(task.socketId);
                        }
                        if (!socket) {
                            logger.warn(`No valid socket found for task ${agent.taskId}, cannot execute prompt`);
                            return;
                        }
                        if(agent.agentType === AgentTypeEnum.SUB_AGENT)
                        {
                            PromptExecutionService.executePromptSubAgent({
                                prompt: message,
                                taskId: agent.taskId,
                                agentId: recvrAgentId
                            },);
                        }
                        else{
                        // calling the execute prompt here
                        PromptExecutionService.executePrompt({
                            sessionId:agent.chatSessionId,
                            taskId: agent.taskId,
                            modelKey: agent.modelKey,
                            prompt: message,
                            agentId: recvrAgentId,
                        
                        },socket,io,activeControllers);
                    }

                    }
                }
            }
        }
        catch(ex)
        {
            logger.error(`Error in adding message to queue for agent ${recvrAgentId}`,ex);
        }
    }
}