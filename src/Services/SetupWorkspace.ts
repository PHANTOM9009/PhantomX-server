import { DatabaseService } from './../DataAccessLayer/DatabaseService'
import { Organization_AppInstallation, UserName_Socket, UserInfo } from '../DataStructures'
import * as dotenv from 'dotenv'
import { user_details_handler } from '../socket-handlers/user-details.handler';
import { fetchInstallationToken } from './GithubAppFlow';
import { getGithubOrganizationName } from './GithubAppFlow';
import { Agent } from './agent-system'
import { Operations } from '../classes/OperationsEnum';
const SSHClient = require('./ssh-client'); //getting the ssh client
import { Server, Socket } from 'socket.io';
import path from 'path';
import { SecretManager } from './SecretManager';
import { verify } from 'crypto';
import {Task} from '../DataAccessLayer/models/Task';
import { CollectionNames } from './../DataAccessLayer/models/Collections';
import { Workspaces,RepoDetails } from '../DataAccessLayer/models/Workspaces';
import { getEC2Instance,releaseEC2Instance } from './EC2Manager';
import * as ds from './../DataStructures';
import { fileServerClientManager } from "../Services/FileServerClientManager";
import { toolServerClientManager } from "../Services/ToolServerClientManager";
dotenv.config();
import { v4 as uuidv4 } from 'uuid';
import { cp } from 'fs';
import { getDBService } from '../DataAccessLayer/db-connection';
import { createLogger } from '../utils/Logger';
import fs from 'fs';
const logger = createLogger('SetupWorkspace');
import { io } from '../socket-server';
import { Collection } from 'chromadb';
import S3Service from './S3Service';
import { SSHClientCombined } from './ssh-client-combined';
import { systemPromptService } from './systemPromptService';
import { TaskStatus } from '../DataAccessLayer/models/Task';
import { sendNotification } from './NotificationService';
import {EC2MetricsService} from './../DataAccessLayer/EC2MetricsService';
import { EC2Type } from './../DataStructures';
import { pendingRetries } from '../routes/terminal.routes';
import { TaskType } from '../classes/TaskTypeEnum';
import { AgentTypeEnum } from '../classes/AgentTypeEnum';
import { AccessRights } from '../classes/ModelAccessRights';
export enum commandType {
    INSTALL_DEPENDENCIES,
    START_PROJECT
}
export async function removeContainerAndImageForTaskMachines(TaskData:Task) // specially for the task and not for the workspace
{
      let ssh = new SSHClient('/',TaskData.ec2InstanceIP);
    try{
        logger.info(`Removing containers and images for task`, { taskId: TaskData.taskId });

        // remvoing the two containers, one is for the agent and another is for the user
      
        let result = await ssh.executeCommand(`sudo docker rm -f ${TaskData.taskId}-user`); // removing the docker container for user terminal
        if(!result.success)
        {
            logger.warn("User's docker container removal failed", { error: result?.error, taskId: TaskData.taskId });
        }
        // now removing the docker container of the terminal for the AI agent
        let dockerCommand = `image=$(sudo docker inspect -f '{{.Config.Image}}' ${TaskData.taskId}) && \
        sudo docker rm -f ${TaskData.taskId} && \
        sudo docker rmi -f "$image" `;
        result = await ssh.executeCommand(dockerCommand);

        if(!result.success)
        {
            logger.warn("Agent's docker container removal failed", { error: result?.error, taskId: TaskData.taskId });
        }

        // now removing the chroma server container as well.
        let dockerCommandChroma = `image=$(sudo docker inspect -f '{{.Config.Image}}' chroma_${TaskData.taskId}) && \
        sudo docker rm -f chroma_${TaskData.taskId} && \
        sudo docker rmi -f "$image"`;

        result = await ssh.executeCommand(dockerCommandChroma); // removed the docker container for chroma db
        
        if(!result.success)
        {
            logger.warn("Chroma docker container removal failed", { error: result?.error, taskId: TaskData.taskId });
        }

        // copying back the chroma db data from /srv to efs before cleanup
        let organizationName = UserInfo.get(TaskData.createdBy)?.organizationName;
        if(!organizationName)
        {
            logger.error("Organization name not found", { userId: TaskData.createdBy, taskId: TaskData.taskId });
            return;
        }

        let sourceChromaFolder = `/srv/${organizationName}/${TaskData.taskId}/chroma/`;
        let destinationEFSFolder = `/mnt/efs2/${organizationName}/${TaskData.taskId}/`;
        
        // Check if source chroma folder exists before copying
        let checkSourceResult = await ssh.executeCommand(`[ -d "${sourceChromaFolder}" ] && echo "exists" || echo "not_exists"`);
        
        if(checkSourceResult.output.trim() === "exists")
        {
            // Ensure destination directory exists
            result = await ssh.executeCommand(`sudo mkdir -p ${destinationEFSFolder}`);
            result = await ssh.executeCommand(`sudo chmod -R 777 ${destinationEFSFolder}`);
            
            // Remove old chroma folder in destination if exists to ensure clean replacement
            result = await ssh.executeCommand(`sudo rm -rf ${destinationEFSFolder}chroma`);
            
            // Copy the chroma data back to EFS
            result = await ssh.executeCommand(`sudo cp -r ${sourceChromaFolder} ${destinationEFSFolder}`);
            
            if(result.success)
            {
                logger.success("Chroma db data copied back to EFS from /srv", { taskId: TaskData.taskId });
                
                // Clean up the /srv folder after successful copy
                result = await ssh.executeCommand(`sudo rm -rf /srv/${organizationName}/${TaskData.taskId}`);
                
                if(result.success)
                {
                    logger.success("Chroma data cleaned up from /srv", { taskId: TaskData.taskId });
                }
                else
                {
                    logger.warn("Failed to clean up chroma data from /srv", { error: result?.error, taskId: TaskData.taskId });
                }
            }
            else
            {
                logger.warn("Failed to copy chroma db data back to EFS", { error: result?.error, taskId: TaskData.taskId });
            }
        }
        else
        {
            logger.info("Source chroma folder does not exist in /srv, skipping copy", { taskId: TaskData.taskId });
        }
    }
    catch(ex)
    {
        logger.error("Exception while removing container and image", ex);
    }
    finally{
       await  ssh.disconnect();
    }
}

   export async function DeleteWorkspace(socket:Socket, wpId:string)
    {
        // for deleting the workspace
        /*
            we will not be deleting the docker files of the workspce from the efs2 because it is used by existing tasks
            and thenw e will be removing the workspace metadata from the mongodb

        */
        let organizationName = ds.UserInfo.get(socket.data.user.userId)?.organizationName;
        let dockerData = `/mnt/efs2/${organizationName}/WorkspaceData/${wpId}/docker/`;

        // deleting this dockerData now
        let Ec2Details:any;
        let ec2Ip:any;
        let ec2InstanceId= "";
        // if(ds.Ec2Id_Map.size==0)
        // {
        //     // in this case we are not having existing ec2 open so we will open one and then we will release it after the deletion is done
        //     Ec2Details = getEC2Instance(wpId,ds.EC2Type.Task);
        //     ec2Ip = Ec2Details.publicIp;
        //     ec2InstanceId = Ec2Details.instanceId;
        // }
        // else{
        //  const mapEntry = ds.Ec2Id_Map.entries().next().value;
        //  if (mapEntry && mapEntry[1]) {
        //      Ec2Details = mapEntry[1]; // this will have the value of the ec2
        //      ec2Ip = Ec2Details.publicIp;
        //  }
        // }
        // let ssh = new SSHClient('/',ec2Ip);
        // let result = await ssh.executeCommand(`sudo rm -rf ${dockerData}`);
        // if(result.success)
        // {
        //     logger.info("Docker folder of workspace deleted successfully==>",wpId);
        // }
        // else{
        //     logger.error(`Docker folder of workspace ${wpId} deletion failed due to the error=>",${result?.error}`);
        // }
        // //releasing the ec2 instance taken
        // if(ec2InstanceId !== "")
        // {
        //     releaseEC2Instance(ec2InstanceId,wpId,ds.EC2Type.Task);
        // }
        let databaseService = await getDBService();
        let dbName = ds.UserInfo.get(socket.data.user.userId)?.dbName;
        let wpHandler = databaseService.getRepository<Workspaces>(dbName,CollectionNames.WORKSPACES);


        await wpHandler.deleteOne({
            wpId:wpId
        });
        logger.info("\n wp with the id is deleted successfully==>",wpId);    
    }

export async function startPlaywrightServer(ec2_instance_ip:string, playwrightPort:string,folderPath:string)
{
     let ssh = new SSHClientCombined(folderPath,ec2_instance_ip);
    try{
       
        // executing commands 
        let result =  await ssh.executeCommand(`cd /playwright && npx playwright install chromium`);
        result =  await ssh.executeCommand(`cd /playwright && npx playwright install chrome`);
        let result1 =  await ssh.executeBackgroundCommand(`cd /playwright && node cli.js --port ${playwrightPort} --host 0.0.0.0 --headless --isolated --no-sandbox`);
        if(result1.success)
        {
            logger.success("Playwright server started successfully", { ec2_instance_ip, playwrightPort });
        }
    }
    catch(ex)
    {
        logger.error("Exception in starting playwright server", ex);
    }
    finally
    {
        await ssh.disconnect();
    }
}
export async function DeleteTask(taskId:string,socket:Socket)
{
    // for deleting a task following is the logic
    /*
    if the task is running, we will first clean the task,
    then we will remove the workspace folder from the efs1 
    then we will remove the .AIMetdata and chromaData from efs2
    and then in the end we will be deleting the task metadata from mongodb.
    */
    //checking the status of the task, if it is still running then it would be in taskId_task ds, else the task is assumed to be closed

    if(ds.taskId_task.has(taskId))
    {
         CleanTask(socket,taskId,TaskStatus.Deleted);
    }
    // now lets delete stuff from the task
    let databaseService = await getDBService();
    let taskHandler = databaseService.getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName,CollectionNames.TASKS);
    let taskData = await taskHandler.findOne({
        taskId: taskId
    });
    // removing the folder of the user from the self hosted machine.

    let controllerSocket = ds.userId_orchestratorSocket.get(taskData?.createdBy as string);
    if(controllerSocket)
    {
        let promise = new Promise((resolve,reject)=>{
                
            controllerSocket.emit("delete_task",{taskId:taskId,folderPath: taskData?.taskFolderPath},(response:any)=>{

                if(response.success)
                {
                    resolve({success:true});
                }                   
                else
                {
                    resolve({success:false, error: response.error});
                }

            });
            
        });
       let result:any =  await promise;
       if(result.success)
       {
            logger.success("Task folder deleted successfully from the self hosted machine", { taskId });
       }
        else
        {
            logger.error("Task folder deletion failed from the self hosted machine", { taskId, error: result.error });
        }
    }
    else
    {
        logger.warn("No controller socket found for the task, skipping remote cleanup", { taskId });
    }
   
    // now removing all the chat history from aws s3 machine for this task

    let s3Service = new S3Service();

    const chatHistoryEntries = taskData?.sessionId_chatHistoryData ?? {};
    for (const [key, value] of Object.entries(chatHistoryEntries)) {
        // now deleting the value
        s3Service.deleteFile(value.chatHistoryFileName);
    }

   
    taskHandler.deleteOne({taskId: taskData?.taskId}); 
    logger.info("deletion of the task is successfull==>",taskId);
    

    
}

export async function removeDockerContainersSelfHosted(taskId: string)
{
    //getting the socket for tool server
    let toolSocket = ds.userId_orchestratorSocket.get(ds.taskId_task.get(taskId)?.createdBy as string);
    let promise =  new Promise((resolve,reject)=>{

        if(toolSocket)
        {
            toolSocket.emit('stop_task',{taskId: taskId},(response:any)=>{
                if(response.success)
                {
                    resolve({
                        success:true,
                        error:null
                    });
                }
                else
                {
                    reject({
                        success:false,
                        error: response.error
                    });
                }
            })
        }
        else
        {
            reject({
                success:false,
                error:"no tool socket found for the taskId=>"+taskId    
            });
        }
        
    });
    return await promise;

}

export async function CleanTask(socket:Socket,taskId:string, taskStatus:TaskStatus) // kill the task in its entirely
{
    // removing PendingWorkspaces as well, if they exist

    // here we also have to update the task status
try{
    
    logger.info(`Cleaning task with status: ${taskStatus}`);
    
      let taskDataRemoved = ds.taskId_task.get(taskId);
            if(taskDataRemoved)
            {
                // adding PendingTaskDeletion in this such that the logic is now centralized.

                ds.pendingTaskDeletions.set(taskId,true);
                 
                // if there is data then remove it 
                
                // Remove this task from the user's task list only
                const userId = taskDataRemoved.createdBy;
                const userTasks = ds.userId_task.get(userId) || [];
                const filteredUserTasks = userTasks.filter(task => task.taskId !== taskDataRemoved.taskId);

                // updating the status of the task in the db and pushing status_change activity log
                let databaseService = getDBService();
                let TaskHandler = (await databaseService).getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
                let fromStatus = taskDataRemoved.status;
                let toStatus = taskStatus;
                
                if (taskStatus === TaskStatus.Running || taskStatus === TaskStatus.Waiting) {
                    toStatus = TaskStatus.Stopped;
                    io.to(socket.data.user.userId).emit('change_task_status', {
                        taskId: taskId,
                        status: TaskStatus.Stopped
                    });
                    sendNotification(socket.data.user.userId, {
                        message: `Task: ${ds.taskId_task.get(taskId)?.taskName} is stopped successfully !`,
                    });
                }

                // Fetch latest task for activity log update
                const taskDoc = await TaskHandler.findOne({ taskId: taskDataRemoved.taskId });
                let activityLog = (taskDoc?.metadata?.activityLog || []).slice();
                const userData = ds.UserInfo.get(socket.data.user.userId);
                const userName = userData && userData.firstName && userData.lastName
                    ? `${userData.firstName} ${userData.lastName}`
                    : (userData?.userName || userData?.name || userData?.userId || "User");
                const activity = {
                    id: `activity_${Date.now()}`,
                    type: "status_change",
                    description: `Status changed from ${fromStatus} to ${toStatus}`,
                    timestamp: new Date().toISOString(),
                    user: userData?.userId || "user1",
                    userName: userName,
                    isAgent: false,
                    metadata: { fromStatus, toStatus }
                };
                activityLog.push(activity);
                await TaskHandler.updateOne({
                    taskId: taskDataRemoved.taskId
                }, {
                    $set: {
                        status: toStatus,
                      
                    }
                });


                
                // now aborting the api call if any
                taskDataRemoved.Agent?.abortController?.abort();
                // now stopping other sub agents as well if they are running
                for(let[agentId,agent] of taskDataRemoved.subAgents ?? new Map<string,Agent>())
                {
                    agent.abortController?.abort();
                    ds.agentId_agent.delete(agentId); // Remove sub-agent from global registry
                }
                


                fileServerClientManager.removeClient(taskId,ds.taskId_task.get(taskId)?.ec2InstanceIP as string); // conection with the file server is teared down now.
                toolServerClientManager.removeClient(taskId);

                //await removeContainerAndImageForTaskMachines(taskDataRemoved as any);
                await removeDockerContainersSelfHosted(taskId); // removing the docker containers and images for the task machines
                // now killing the indexer watcher process if running
                let sshObj = taskDataRemoved.indexerWatcherProcessInfo;
                if(sshObj)
                {
                    try{
                        let total = await sshObj.getBackgroundProcesses();
                       Object.keys(total).forEach(async(key)=>{

                        await sshObj.terminateBackgroundProcess(total[key].id);

                       });
                    }
                    catch(ex)
                    {
                        logger.warn("Failed to terminate background processes", ex);
                    }
                }

                // deleting the docker files from the folder path
                // let ssh = new SSHClient(taskDataRemoved.folderPath,taskDataRemoved.ec2InstanceIP); 
                // // let result = await ssh.executeCommand(`sudo rm -f ${taskDataRemoved.folderPath}/Dockerfile`);
                // // if(!result.success)
                // // {
                // //     logger.error("removal of Dockerfile failed for the task=>",taskDataRemoved.taskId+" due to the error =>"+result.error);

                // // }
                // // result = await ssh.executeCommand(`sudo rm -f ${taskDataRemoved.folderPath}/docker-compose.yml`);
                
                // // if(!result.success)
                // // {
                // //     logger.error("removal of Dockerfile failed for the task=>",taskDataRemoved.taskId+" due to the error =>"+result.error);

                // // }
                // // now removing node modules installed in each of the repo
                

                // // for(let repo of taskDataRemoved.repoDetails)
                // // {
                // //   let result=  ssh.executeCommand(`cd ${repo.repoName} && sudop rm -rf node_modules`); // removing the node modules to save the storage.
                  
                // //   if(result.success)
                // //   {
                // //         logger.success("node modules successfully removed for the task=>",taskId);
                // //   }
                // //   else{
                // //     logger.error("node modules removal failed for the task=>",taskId);
                // //   }
                // // }

                // let ec2UsageService = new EC2MetricsService(ds.UserInfo.get(socket.data.user.userId)?.dbName as any);
                // const now = new Date();
                // ec2UsageService.trackUsage({
                //     ec2InstanceId: taskDataRemoved.assignedEc2InstanceId,
                //     ec2Type: taskDataRemoved.EC2Type as any,
                //     usageTime: ((now.getTime())-taskDataRemoved.startedAt.getTime())/(1000*60),
                //     userId: socket.data.user.userId,
                //     groupedName: taskDataRemoved.taskName,
                //     userName: ds.UserInfo.get(socket.data.user.userId)?.userName as any,
                //     organizationId: taskDataRemoved.organizationId,
                //     taskId: taskId,
                // }); // so now we are assuming that this thing will be tracked.

                ds.userId_task.set(userId, filteredUserTasks); // Update user's task list correctly
                ds.taskId_task.delete(taskDataRemoved.taskId);
                socket.data.user.taskId =  null;
           //     await releaseEC2Instance(taskDataRemoved?.assignedEc2InstanceId as any,taskDataRemoved?.taskId as any,ds.EC2Type.Task);
                ds.pendingTaskDeletions.delete(taskId);

                //removing the pending retry for terminal proxy URL
                pendingRetries.delete(taskId);

                // stopping its child tasks now
                for(let childTaskId of taskDataRemoved.childTasks ?? [])
                {
                    CleanTask(socket,childTaskId,TaskStatus.Stopped); // we are stopping the child tasks because we don't want to delete them, we just want to stop them because they can be useful for the user after the main task is deleted.
                }

            }
}
catch(ex)
{
    logger.error("Exception in cleaning task", ex);
}
   
         
}

export async function coldKillTask(socket:Socket,taskId:string)
{
    // only disassociate this task from the socket and do nothing else
    
    const task:any = ds.taskId_task.get(taskId);
    
    if (task && task.socketId === socket.id) { // this second condition is important and it is making sure that we are not deleting the task which is associated with some other socket in case of reconnections and all
       ds.pendingTaskDeletions.set(task.taskId,true);
        task.socketId = null;
       // fileServerClientManager.removeClient(socket.data.user.taskId,ds.taskId_task.get(socket.data.user.taskId)?.ec2InstanceIP as string); // conection with the file server is teared down now.
               
        socket.data.user.taskId = null; // setting it to null, so that, if other tasks starts then we will know that they have started.
        ds.pendingTaskDeletions.delete(task.taskId);
    }
    
    
}
export async function setupTerminalEnvironment(ec2_instance_ip:string,folderPath:string,taskId:string)
    {
        let ssh = new SSHClient('/',ec2_instance_ip as any);
    try{
            
            await ssh.connect();
            logger.info(`Setting up terminal environment`, { taskId, ec2_ip: ec2_instance_ip });
            
            let availablePortResult = await ssh.executeCommand("for p in $(seq 8900 9000); do (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; break; }; done");
            let availablePort = availablePortResult.output.trim();
            let name = path.basename(folderPath);
            let imageName = name;
            let result = await ssh.executeCommand(`sudo docker run -dit --name ${name}-user -p ${availablePort}:${availablePort} -v ${folderPath}:/app -w /app ${imageName} bash -c \"apt update && apt install -y wget && wget -qO /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x /usr/local/bin/ttyd && ttyd -p ${availablePort} -i 0.0.0.0 --writable bash -ic 'echo -e \\\"\\033]10;#FFFFFF\\007\\033]11;#000000\\007\\\"; exec bash'\"`);

            if(result.success)
            {
                logger.success("User docker terminal started", { taskId, port: availablePort });
                let taskData:ds.RunningTaskData = ds.taskId_task.get(taskId) as ds.RunningTaskData;
                if(taskData != undefined)
                {
                    taskData.userDockerTerminalUrl = `http://${ec2_instance_ip}:${availablePort}`;
                }
                 return `http://${ec2_instance_ip}:${availablePort}`
            }
            else{
                logger.error("User docker terminal start failed", { taskId, error: result.error });
                return ""
            }
            
            //  let chatHistoryPath = `${this.organizationName}/task/${this.taskId}/SetupUserDockerTerminal`;
            // let agent = new Agent(1, this.folderPath, Operations.TERMINAL_SETUP, this.ec2_instance_ip,chatHistoryPath, "", "");
            // await agent.connect();
            // let result = await agent.run("Setup the terminal environment for this project with ttyd using the same image as in docker compose", [], Operations.TERMINAL_SETUP);
            // if(result.result)
            // {
            //      console.log("the terminal env is set");
                
            //     await agent.disconnect();

            //     this.DockerUserTerminalCommand = result.ExactCommand;
            //     return `http://${this.ec2_instance_ip}:${result.portRunning}`
                   
            // }
            // else
            // {
            //     return {
            //         success:false,
            //         message: result.error
            //     }
            // }
           
        }
        catch(ex){logger.error("Exception in setupTerminalEnvironment", ex);}
        finally{
            await ssh.disconnect();
        }
       
    }

export async function installDependencies(repoName:string,command:string,folderPath:string,ec2_instance_ip:string)
    {
        let ssh = new SSHClientCombined(folderPath,ec2_instance_ip);
        try{

            
           
            let commandResult = await ssh.executeBackgroundCommand(`cd ${repoName} && ${command}`);
            if(commandResult.success)
            {
                    logger.success("command=>"+command+" ran successfully on the repo==>"+repoName);
            }
            else{
                logger.error("command=>"+command+" failed when ran on the repo=>"+repoName+" the error is==>"+commandResult.error);
            }    
        }    
        catch(ex)
        {
            logger.error("error in installDependencies function==>",ex);
        }
        finally{
            await ssh.disconnect();
        }
    }


/**
 * Helper function to verify that a directory copy to EFS is complete
 * @param ssh SSH client instance
 * @param sourceDir Source directory path  
 * @param destinationDir Destination directory path (the parent dir where content was copied)
 * @param taskId Task ID for logging
 * @returns Promise<boolean> true if verification successful
 */
async function verifyEFSCopy(ssh: any, sourceDir: string, destinationDir: string, taskId: string): Promise<boolean> {
    const maxRetries = 10;
    const retryDelay = 2000; // 2 seconds
    
    logger.info('Starting EFS copy verification', { taskId, sourceDir, destinationDir });
    
    // First, flush file system buffers to ensure data is written
    await ssh.executeCommand('sync');
    
    // Wait a bit for EFS to sync
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Check if destination directory exists
            const destCheckResult = await ssh.executeCommand(`[ -d "${destinationDir}" ] && echo "exists" || echo "not_exists"`);
            
            if (destCheckResult.output.trim() !== "exists") {
                logger.warn(`Attempt ${attempt}: Destination directory does not exist yet`, { taskId, destinationDir });
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }
            
            // Get file count from source
            const sourceCountResult = await ssh.executeCommand(`find "${sourceDir}" -type f 2>/dev/null | wc -l`);
            const sourceFileCount = parseInt(sourceCountResult.output.trim());
            
            if (isNaN(sourceFileCount) || sourceFileCount === 0) {
                logger.warn(`Attempt ${attempt}: Could not get source file count or source is empty`, { taskId, sourceDir });
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }
            
            // Get file count from destination
            const destCountResult = await ssh.executeCommand(`find "${destinationDir}" -type f 2>/dev/null | wc -l`);
            const destFileCount = parseInt(destCountResult.output.trim());
            
            logger.info(`File count check - Attempt ${attempt}`, { 
                taskId, 
                sourceFileCount, 
                destFileCount,
                sourceDir,
                destinationDir 
            });
            
            // Check if file counts match
            if (destFileCount >= sourceFileCount && destFileCount > 0) {
                // Additional verification - check if we can actually read from the destination
                const readTestResult = await ssh.executeCommand(`ls -la "${destinationDir}" 2>&1`);
                
                if (readTestResult.success) {
                    logger.success('EFS copy verification successful', { 
                        taskId, 
                        attempt, 
                        sourceFileCount, 
                        destFileCount 
                    });
                    
                    // Final sync to be absolutely sure
                    await ssh.executeCommand('sync');
                    return true;
                }
            }
            
            // If not successful yet, wait before retry
            if (attempt < maxRetries) {
                logger.info(`Attempt ${attempt} incomplete, retrying...`, { taskId });
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
            
        } catch (error) {
            logger.error(`Error during verification attempt ${attempt}`, { taskId, error });
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }
    
    logger.error('EFS copy verification failed after all retries', { taskId, maxRetries });
    return false;
}

  async function firstTimeIndex(TaskData:ds.RunningTaskData) // this is for indexing the repo 
    {
        let startTime = new Date();
        let ec2Details = await getEC2Instance(TaskData.taskId,ds.EC2Type.Indexer);
        logger.info(`Starting first time indexing`, { taskId: TaskData.taskId });
        logger.info('recved ec2Details for indexing of this task, the ip of the machine is==>',ec2Details.publicIp);
       let chromaDbData:any = await startChromaServer(TaskData.taskId,ec2Details.publicIp,TaskData.organizationName) // this will start the chroma server 
       // running the indexer now
       let ssh = new SSHClient('/mnt/efs2/Utilities/Indexer',ec2Details.publicIp);
       
       // Create logs directory for indexer if it doesn't exist
       let logDir = `/mnt/efs1/Indexer/logs`;
       let logFile = `${logDir}/indexer_${TaskData.taskId}_${Date.now()}.log`;
       await ssh.executeCommand(`sudo mkdir -p ${logDir}`); 
        await ssh.executeCommand(`sudo chmod -R 777 ${logDir}`);
       
       // Run indexer with live log output redirection
       let result = await ssh.executeCommand(`sudo npm run indexer ${TaskData.folderPath} ${chromaDbData?.chromaDbPort} 0 > ${logFile} 2>&1`); // here the mode is to index it only the once and not edit the indexing files
       if(result.success)
       {
            logger.success(`Indexer completed`, { taskId: TaskData.taskId, logFile });
       }
       else
       {
            logger.error(`Indexer failed`, { taskId: TaskData.taskId, logFile, error: result.error });
       }
       //now copying back the stuff - first ensure destination directory exists

       let destinationDir = `/mnt/efs2/${TaskData.organizationName}/${TaskData.taskId}/`; // /chroma 
       result = await ssh.executeCommand(`sudo mkdir -p ${destinationDir}`);
       result = await ssh.executeCommand(`sudo chmod -R 777 ${destinationDir}`);
       
       // Remove old chroma folder in destination if exists to ensure clean replacement
       result = await ssh.executeCommand(`sudo rm -rf ${destinationDir}chroma`);
       
       // Now copy the chroma db data
       result = await ssh.executeCommand(`sudo cp -r ${chromaDbData?.chromaDbFolder} ${destinationDir}`);
       
       if(result.success)
       {
            logger.info('Chroma db data copy command completed, verifying...', { taskId: TaskData.taskId });
            
            // Verify that the copy to EFS is complete
            const chromaDestPath = `${destinationDir}chroma`;
            const copyVerified = await verifyEFSCopy(ssh, chromaDbData?.chromaDbFolder, chromaDestPath, TaskData.taskId);
            
            if (copyVerified) {
                logger.success('Chroma db data successfully copied and verified on EFS', { taskId: TaskData.taskId });
            } else {
                logger.error('Chroma db data copy verification failed', { taskId: TaskData.taskId });
                throw new Error('EFS copy verification failed');
            }
       }
       else
       {
            logger.error('Failed to copy chroma db data', { taskId: TaskData.taskId, error: result.error });
            throw new Error(`Copy command failed: ${result.error}`);
       }

       result = await ssh.executeCommand(`sudo rm -rf ${chromaDbData?.chromaDbFolder}`); // removing the chroma db folder from the indexer machine
       let command = `image=$(sudo docker inspect -f '{{.Config.Image}}' chroma_${TaskData.taskId}) && \
        sudo docker rm -f chroma_${TaskData.taskId} && \
        sudo docker rmi "$image" `
       result = await ssh.executeCommand(command); // removing the docker container and the image as well

       

       await releaseEC2Instance(ec2Details.instanceId,TaskData.taskId,ds.EC2Type.Indexer); //
       //after releasing the indexer lets log the usage
       let end = new Date();
       let usageTime = ((end.getTime())-(startTime.getTime()))/(1000 * 60);
       
       let userData:any = ds.UserInfo.get(TaskData.startedByUserId);
       let ec2Usage = new EC2MetricsService(userData.dbName);
       ec2Usage.trackUsage({
        ec2InstanceId: ec2Details.instanceId,
        ec2Type:EC2Type.Indexer as any,
        usageTime: usageTime,
        organizationId:userData.organizationId,
        taskId:TaskData.taskId,
        userId: userData.userId,
        userName: userData.userName,
        groupedName: TaskData.taskName

      }); // logged the usage for EC2 for indexer as well.
      await ssh.disconnect();


    }
    export async function preSetupChromaAndIndexer(taskData:ds.RunningTaskData)
    {
        // this function will be the pre setup , i.e it will copy and paste the things from workspace to the task folder for chroma data and .AIMetadata
        //checking the date modified of the folder of workspace which has chroma data and .AIMetadata
        let sourceDirectory = `/mnt/efs2/${taskData.organizationName}/${taskData.startedByUserId}/WorkspaceData/${taskData.wpId}/chroma`;
        let ssh = new SSHClient('/',taskData.ec2InstanceIP); //setting the folder path to root.
        let result = await ssh.executeCommand(`sudo stat -c %Y ${sourceDirectory}`);
        if(!result.success)
        {
            logger.error("Failed to get chroma data folder modified time", { taskId: taskData.taskId, error: result.error });
            return;
        }
        let sourceChromaModifiedTime = parseInt(result.output.trim());
        //if the time is over 1 hour then we will do something
        let currentTime = Math.floor(Date.now() / 1000);
        if((currentTime - sourceChromaModifiedTime) > 3600) // if it is more than 1 hour old then we will copy the data
        {
            // this is the case when it has been an hour since the last modification in th
        }
        await ssh.disconnect();

    }
    export async function setupChromaAfterPull(taskData:ds.RunningTaskData )
    {
        // use this function after git pull for the project, this will run the indexer in a separate machine and copy the meatadata back
        let ssh = new SSHClient('/',taskData.ec2InstanceIP); //setting the folder path to root.
        try{
         
         await firstTimeIndex(taskData);
                //retrying to copy the stuff back again - check if source exists first
                let retrySourceDir = `/mnt/efs2/${taskData.organizationName}/${taskData.taskId}/chroma/`;
                let retryCheckResult = await ssh.executeCommand(`[ -d "${retrySourceDir}" ] && echo "exists" || echo "not_exists"`);
                let chromaDataFolder = `/srv/${taskData.organizationName}/${taskData.taskId}/`; // using the task ID to create a unique folder for each chroma sesssion
                if(retryCheckResult.output.trim() === "exists")
                {
                    // Remove old chroma folder in destination if exists before retry
                    await ssh.executeCommand(`sudo rm -rf ${chromaDataFolder}chroma`);
                    
                    let result2 = await ssh.executeCommand(`sudo cp -r ${retrySourceDir} ${chromaDataFolder}`); // this is the copy command
                    if(result2.success)
                    {
                        logger.success("Indexer setup complete, chromaDb data copied", { taskId: taskData.taskId });
                    }
                    else
                    {
                        logger.error("Failed to copy chromaDb data after indexer setup", { taskId: taskData.taskId, error: result2.error });
                    }
                }
                else
                {
                    logger.warn(`Source directory still does not exist after indexer setup`, { sourceDir: retrySourceDir, taskId: taskData.taskId });
                }
            }
            catch(ex)
            {
                logger.error("Exception in setupChromaAfterPull", ex);
                return ;
            }
            finally{
                await ssh.disconnect();
            }
    }
    export async function setupChromaAndIndexer(taskData:ds.RunningTaskData) { // this is the main function bro here, always call this function do setup the indexer and the chroma db
         
         logger.info(`Setting up Chroma and Indexer`, { taskId: taskData.taskId });
            let ec2_instance_ip = taskData.ec2InstanceIP;
            let organizationName = taskData.organizationName;

        let ssh = new SSHClient('/',ec2_instance_ip); //setting the folder path to root.
        try {
           
          
            await ssh.connect();
            let taskId = taskData.taskId;
            if(taskId === '')
            {
                taskId = uuidv4();
            }
            let chromaDataFolder = `/srv/${organizationName}/${taskId}/`; // using the task ID to create a unique folder for each chroma sesssion
            
            // Remove old folder first to ensure clean state
            let removeResult = await ssh.executeCommand(`sudo rm -rf ${chromaDataFolder}`);
            
            let result = await ssh.executeCommand(`sudo mkdir -p ${chromaDataFolder}`);
            result = await ssh.executeCommand(`sudo chmod -R 777 ${chromaDataFolder}`);

            //now copying the data from efs to the folderPath
            // Check if source directory exists before copying
            let sourceDir = `/mnt/efs2/${organizationName}/${taskId}/chroma/`;
            let checkSourceResult = await ssh.executeCommand(`[ -d "${sourceDir}" ] && echo "exists" || echo "not_exists"`);
            
            if(checkSourceResult.output.trim() === "exists")
            {
                result = await ssh.executeCommand(`sudo cp -r ${sourceDir} ${chromaDataFolder}`); // this is the copy command
            }
            else
            {
                logger.info(`Source directory does not exist, will run first time indexing`, { sourceDir, taskId: taskData.taskId });
                result = { success: false, output: '', error: 'Source directory does not exist' } as any;
            }
            //also copying .AIMetadata folder but that would be in the current working folder of the user for this workspace but lets copy it

            let db =await getDBService();
            let taskHanlder = db.getRepository<Task>(ds.UserInfo.get(taskData.startedByUserId)?.dbName as any, CollectionNames.TASKS);
            if(!result.success)
            {
                // before calling the full flash indexer we will check for other tasks created from this workspace 
                // to check if they also do have some chroma data, then we will copy paste the same thing.
                // find all the tasks having the same workspace
                if(taskData.wpId)
                {
                    let tasks = await taskHanlder.find({
                        wpId: taskData.wpId
                    },{
                        sort:{
                            createdAt:-1
                        }
                    });
                    if(tasks.length > 1)
                    {
                        let latestTask = tasks[1]; // we have to pick up the chroma data from there and copy paste it in the current task workspace
                        let latestTaskChromaDataPath = `/mnt/efs2/${organizationName}/${latestTask.taskId}/chroma/`;
                        let checkLatestTaskSourceResult = await ssh.executeCommand(`[ -d "${latestTaskChromaDataPath}" ] && echo "exists" || echo "not_exists"`);
                      
                        let staticChromaDataPath = `/mnt/efs2/${taskData.organizationName}/${taskData.taskId}/`;
                        if(checkLatestTaskSourceResult.output.trim() === "exists")
                        {
                            logger.info(`Found another task with the same workspace having chroma data, copying from there`, { sourceDir: latestTaskChromaDataPath, taskId: taskData.taskId });
                            // Ensure chromaDataFolder exists with proper permissions before copying
                            await ssh.executeCommand(`sudo mkdir -p ${chromaDataFolder}`);
                            await ssh.executeCommand(`sudo chmod -R 777 ${chromaDataFolder}`);
                            // Ensure staticChromaDataPath exists with proper permissions before copying
                            await ssh.executeCommand(`sudo mkdir -p ${staticChromaDataPath}`);
                            await ssh.executeCommand(`sudo chmod -R 777 ${staticChromaDataPath}`);

                            result = await ssh.executeCommand(`sudo cp -r ${latestTaskChromaDataPath} ${chromaDataFolder}`); // this is the copy command
                            result = await ssh.executeCommand(`sudo cp -r ${latestTaskChromaDataPath} ${staticChromaDataPath}`); // this is the copy command to static path as well, because after the indexing is done we will be copying from this static path only

                            if(result.success)
                            {
                                logger.success(`Chroma data copied from latest task with same workspace`, { taskId: taskData.taskId, sourceTaskId: latestTask.taskId });
                            }
                            else
                            {
                                logger.error(`Failed to copy chroma data from latest task with same workspace`, { taskId: taskData.taskId, sourceTaskId: latestTask.taskId, error: result.error });
                            }
                        }
                        else
                        {
                            // Previous task exists but has no chroma data — fall back to full first-time indexing
                            logger.warn(`Previous task found but has no chroma data, falling back to first time indexing`, { taskId: taskData.taskId, sourceTaskId: latestTask.taskId });
                            await firstTimeIndex(taskData);
                            if(ds.taskId_task.has(taskData.taskId))
                            {
                                let retrySourceDir = `/mnt/efs2/${organizationName}/${taskId}/chroma/`;
                                let retryInterval = 10;
                                let retryDelay = 2000;
                                for(let i = 0; i < retryInterval; i++)
                                {
                                    let retryCheckResult = await ssh.executeCommand(`[ -d "${retrySourceDir}" ] && echo "exists" || echo "not_exists"`);
                                    if(retryCheckResult.output.trim() === "exists")
                                    {
                                        await ssh.executeCommand(`sudo rm -rf ${chromaDataFolder}chroma`);
                                        let result2 = await ssh.executeCommand(`sudo cp -r ${retrySourceDir} ${chromaDataFolder}`);
                                        if(result2.success)
                                        {
                                            logger.success("Indexer setup complete, chromaDb data copied", { taskId: taskData.taskId });
                                        }
                                        else
                                        {
                                            logger.error("Failed to copy chromaDb data after indexer setup", { taskId: taskData.taskId, error: result2.error });
                                        }
                                        break;
                                    }
                                    else
                                    {
                                        logger.warn(`Source directory still does not exist after indexer setup`, { sourceDir: retrySourceDir, taskId: taskData.taskId });
                                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                                        continue;
                                    }
                                }
                            }
                        }


                    }    
                    else
                    {
                        // No previous task with chroma data found for this workspace — fall back to full first-time indexing
                        logger.warn(`No previous task found for this workspace, falling back to first time indexing`, { taskId: taskData.taskId, wpId: taskData.wpId });
                        await firstTimeIndex(taskData);
                        if(ds.taskId_task.has(taskData.taskId))
                        {
                            let retrySourceDir = `/mnt/efs2/${organizationName}/${taskId}/chroma/`;
                            let retryInterval = 10;
                            let retryDelay = 2000;
                            for(let i = 0; i < retryInterval; i++)
                            {
                                let retryCheckResult = await ssh.executeCommand(`[ -d "${retrySourceDir}" ] && echo "exists" || echo "not_exists"`);
                                if(retryCheckResult.output.trim() === "exists")
                                {
                                    await ssh.executeCommand(`sudo rm -rf ${chromaDataFolder}chroma`);
                                    let result2 = await ssh.executeCommand(`sudo cp -r ${retrySourceDir} ${chromaDataFolder}`);
                                    if(result2.success)
                                    {
                                        logger.success("Indexer setup complete, chromaDb data copied", { taskId: taskData.taskId });
                                    }
                                    else
                                    {
                                        logger.error("Failed to copy chromaDb data after indexer setup", { taskId: taskData.taskId, error: result2.error });
                                    }
                                    break;
                                }
                                else
                                {
                                    logger.warn(`Source directory still does not exist after indexer setup`, { sourceDir: retrySourceDir, taskId: taskData.taskId });
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                    continue;
                                }
                            }
                        }
                    }
                }
                
                else{
                // now we will have to setup the indexer
                await firstTimeIndex(taskData);
                // need to check if the task is still running, if not then we will not copy these things
                if(ds.taskId_task.has(taskData.taskId))
                {
                            //retrying to copy the stuff back again - check if source exists first
                let retrySourceDir = `/mnt/efs2/${organizationName}/${taskId}/chroma/`;
                
                let retryInterval = 10;
                let retryDelay = 2000;
                    for(let i = 0;i< retryInterval;i++)
                    {
                        let retryCheckResult = await ssh.executeCommand(`[ -d "${retrySourceDir}" ] && echo "exists" || echo "not_exists"`);
                        if(retryCheckResult.output.trim() === "exists")
                        {
                            // Remove old chroma folder in destination if exists before retry
                            await ssh.executeCommand(`sudo rm -rf ${chromaDataFolder}chroma`);
                            
                            let result2 = await ssh.executeCommand(`sudo cp -r ${retrySourceDir} ${chromaDataFolder}`); // this is the copy command
                            if(result2.success)
                            {
                                logger.success("Indexer setup complete, chromaDb data copied", { taskId: taskData.taskId });
                            }
                            else
                            {
                                logger.error("Failed to copy chromaDb data after indexer setup", { taskId: taskData.taskId, error: result2.error });
                            }
                            break;
                        }
                        else
                        {
                            logger.warn(`Source directory still does not exist after indexer setup`, { sourceDir: retrySourceDir, taskId: taskData.taskId });
                            await new Promise(resolve=> setTimeout(resolve,retryDelay));
                            continue;
                        }
                    }
                }
            }
            }
            


            //now starting the chroma server on the available ports
            if(ds.taskId_task.has(taskData.taskId))
            {
                let chromaServerDetails = await startChromaServer(taskId,ec2_instance_ip,organizationName);
                let chromaUrl  = `http://${ec2_instance_ip}:${chromaServerDetails?.chromaDbPort}`;
                taskData.chromaDbUrl = chromaUrl;

                //also starting the indexer in the watch mode for the workspace machine
                let runningLogFile = '/mnt/efs1/Indexer/logs';

                result = await ssh.executeCommand(`sudo mkdir -p ${runningLogFile}`);
                let command = `sudo npm run indexer ${taskData.folderPath} ${chromaServerDetails?.chromaDbPort} 1`;
                let ssh1 = new SSHClient('/mnt/efs2/Utilities/Indexer',ec2_instance_ip);
                ssh1.executeBackgroundCommand(command);
                taskData.indexerWatcherProcessInfo = ssh1; // storing the ssh client info to use it later for killing the process if needed
                logger.info("Indexer watcher process has been started successfully", { taskId: taskData.taskId });
                taskData.isIndexerRunning = true;// setting the flat to true so that the AI agent can use this..
                return chromaServerDetails;
            }

         
        }
        catch(ex)
        {
            logger.error("Exception in setting up chroma server", ex);
        }
        finally{
            await ssh.disconnect();
        }
    }
    async function startChromaServer(taskId:string,ec2_instance_ip:string,organizationName:string)
    {
        let chromaDataFolder = `/srv/${organizationName}/${taskId}/chroma/`;
        logger.info(`Starting Chroma server`, { taskId, organizationName });
         let ssh = new SSHClient('/',ec2_instance_ip); //setting the folder path to root.
            await ssh.connect();
          let result = await ssh.executeCommand(`for p in $(seq 1024 9000); do (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; break; }; done`);
            let availablePort = result.output.trim();

            let chromaDbName = `chroma_${taskId}`;

            result = await ssh.executeCommand(`docker run -d \
                                                --name ${chromaDbName} \
                                                -p ${availablePort}:8000 \
                                                -v ${chromaDataFolder}:/data \
                                                ghcr.io/chroma-core/chroma:latest
                                                `);
            if(result.success) {
                return {
                    chromaDbFolder: chromaDataFolder,
                    chromaDbPort: availablePort,
                    chromaDbName: chromaDbName
                }
            }        
            else {
                logger.error(`Failed to start Chroma server`, { taskId, error: result.error });
            }
            await ssh.disconnect();
    }
export interface ProjectInfo {
    path: string;
    collectionName: string;
}

export class SetupWorkspaceForSetup { 
    // this class will handle the setting up the workspace for the first init setup of the workspace.

    public organizationName: string;
    public folderPath: string;
    public workspaceName:string;
    public repoDetails: Record<string,RepoDetails> = {};
    public permissionScopes: Record<string,'Read'|'Write'> = {};
    userId: string;
    dbName: string;
    wpId:string;
    public tags:string[]= [];
    public description:string= "";
    public isDockerSet:boolean = false;
    public chromaDbPort:string = ""; // for the task
    public taskId : string = "";
    public userTerminalUrl:string = "";
    ec2_instance_ip:string; // this is the ec2 ip of the machine where the task and workspace is running, and not that of the indexer machine
    ec2_instance_id:string;
    abortController: any;
    DockerUserTerminalCommand:string=  "";
    isIndexerRunning:boolean =  false;
    public sessionId:any = null; // this is the chatSessionId of the workspace
     installDependenciesCommand : string= "";
    startProjectCommnad : string = "";
    runTestsCommand:string = ""; 
    systemPrompts:[]=[];
    startedAt:Date;
    constructor(dbName: string,organizationName: string, userId: string,ec2_instance_ip:string, ec2_id:string,workspaceName:string,wpId:string,taskId:string,description:string,tags:string[]){
        this.organizationName = organizationName;
        this.ec2_instance_ip = ec2_instance_ip;
        this.folderPath = "";
        this.tags = tags;
        this.startedAt= new Date();
        this.description = description;
        this.ec2_instance_id = ec2_id;
        this.workspaceName = workspaceName;
        this.dbName = dbName;
        this.taskId = taskId;
        this.workspaceName = workspaceName;
        this.userId = userId;
       
        this.wpId = wpId;

    }

    async setWpFolderPath()
    {
        //for the user we are setting the folderPath
        this.folderPath = `/mnt/efs1/${this.organizationName}/Workspaces/${this.wpId}`
    }
    // the first function would be to clone the github repo and then change the branch to the specified user branch
    async setupTaskPath()
    {
        this.folderPath = `/mnt/efs1/${this.organizationName}/Tasks/${this.taskId}`;
    }
    async removeContainerForWorkspace()
    {
         let ssh = new SSHClient('/',this.ec2_instance_ip);
        try{

           
             let result1 = await ssh.executeCommand(`sudo docker rm -f ${this.wpId}-user`);
            let dockerCommand = `image=$(sudo docker inspect -f '{{.Config.Image}}' ${this.wpId}) && \
                sudo docker rm -f ${this.wpId} && \
                sudo docker rmi "$image" `;
             let result = await ssh.executeCommand(dockerCommand);
             if(result.success)
             logger.info("Removal of container for workspace completed", { wpId: this.wpId });
        }
        catch(ex)
        {
            logger.error("Exception in removeContainerForWorkspace", ex);
        }
        finally{
            await ssh.disconnect();
        }
    }
    async removeWp()
    {
        let ssh = new SSHClient('/',this.ec2_instance_ip);
        try{

            
            let result = await ssh.executeCommand(`sudo rm -rf ${this.folderPath}`);
            if(result.success)
            {
                logger.success("Workspace removed successfully", { wpId: this.wpId });
            }
            //removing the container and the image as well
            let result1 = await ssh.executeCommand(`sudo docker rm -f ${this.wpId}-user`);
            let dockerCommand = `image=$(sudo docker inspect -f '{{.Config.Image}}' ${this.wpId}) && \
sudo docker rm -f ${this.wpId} && \
sudo docker rmi "$image" `;
             result = await ssh.executeCommand(dockerCommand);
            if(result.success)
            {
                logger.success("Docker container and image removed", { wpId: this.wpId });
                return;
            }
            logger.warn("Issue removing container and image of workspace", { wpId: this.wpId });
            releaseEC2Instance(this.ec2_instance_id as string, this.wpId,ds.EC2Type.Task);
        }
        catch(ex)
        {
            logger.error("Exception in removeWp", ex);
        }
        finally{
            await ssh.disconnect();
        }
    }

    async createWpDir() {
        try {
            await this.setWpFolderPath();
            let ssh2 = new SSHClient('/',this.ec2_instance_ip);

            let result = await ssh2.executeCommand(`sudo mkdir -p ${this.folderPath}`);
            await ssh2.disconnect();
            return this.folderPath;
        }
        catch (ex) {
            logger.error("Exception in createWpDir", ex);
        }
    }
     discoverProjects(parentFolder: string): ProjectInfo[] {
    const projects: ProjectInfo[] = [];
    
    logger.info(`Discovering projects in parent folder: ${parentFolder}`);
    
    if (!fs.existsSync(parentFolder)) {
        logger.error(`Parent folder does not exist: ${parentFolder}`);
        return projects;
    }
    
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(parentFolder);
    } catch (err) {
        logger.error(`Failed to read parent folder ${parentFolder}`, err);
        return projects;
    }
    
    for (const entry of entries) {
        const fullPath = path.join(parentFolder, entry);
        
        // Check if entry is a directory
        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (err) {
            logger.warn(`Failed to stat ${fullPath}`, err);
            continue;
        }
        
        if (!stat.isDirectory()) {
            logger.debug(`Skipping ${entry}: not a directory`);
            continue;
        }
        
        // Check for .git folder (mandatory)
        const gitPath = path.join(fullPath, '.git');
        if (!fs.existsSync(gitPath)) {
            logger.debug(`Skipping ${entry}: no .git folder found`);
            continue;
        }
        
        // Valid project found
        const collectionName = entry;
        projects.push({ path: fullPath, collectionName });
        logger.info(`✓ Discovered project: ${entry} at ${fullPath}`);
    }
    
    if (projects.length === 0) {
        logger.error('No valid projects found in parent folder. Each project must contain a .git folder.');
    } else {
        logger.info(`Found ${projects.length} valid project(s)`);
    }
    
    return projects;
}
    async SetupChromaAndIndexerForWorkspace()
    {
       // this function will run when the workspace is created for the first time, and this will be sync function
       // we will wait till the indexer is complete for the workspace. we will not start or let any user to start any task until the indexer
       // is complete

         let ec2Details = await getEC2Instance(this.wpId,ds.EC2Type.Indexer);
        logger.info(`Starting first time indexing`, { wpId: this.wpId });
        
       let chromaDbData:any = await startChromaServer(this.wpId,ec2Details.publicIp,this.organizationName) // this will start the chroma server 
       // running the indexer now
       let ssh = new SSHClient('/mnt/efs2/Utilities/Indexer',ec2Details.publicIp);
       
       // Create logs directory for indexer if it doesn't exist
       let logDir = `/mnt/efs1/Indexer/logs`;
       let logFile = `${logDir}/indexer_${this.wpId}_${Date.now()}.log`;
       await ssh.executeCommand(`sudo mkdir -p ${logDir}`);       await ssh.executeCommand(`sudo chmod -R 777 ${logDir}`);
       
       // Run indexer with live log output redirection
       let result = await ssh.executeCommand(`sudo npm run indexer ${this.folderPath} ${chromaDbData?.chromaDbPort} 0 > ${logFile} 2>&1`); // here the mode is to index it only the once and not edit the indexing files
       if(result.success)
       {
            logger.success(`Indexer completed`, { wpId: this.wpId, logFile });
       }
       else
       {
            logger.error(`Indexer failed`, { wpId: this.wpId, logFile, error: result.error });
       }
       //now copying back the stuff - first ensure destination directory exists

       let destinationDir = `/mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/chroma`; // /chroma 
       result = await ssh.executeCommand(`sudo mkdir -p ${destinationDir}`);
       result = await ssh.executeCommand(`sudo chmod -R 777 ${destinationDir}`);
       
       // Remove old chroma folder in destination if exists to ensure clean replacement
       result = await ssh.executeCommand(`sudo rm -rf ${destinationDir}chroma`);
       
       // Now copy the chroma db data
       result = await ssh.executeCommand(`sudo cp -r ${chromaDbData?.chromaDbFolder} ${destinationDir}`);
       
       // Verify the copy to EFS is complete for workspace
       if(result.success)
       {
            logger.info('Workspace chroma db data copy command completed, verifying...', { wpId: this.wpId });
            const chromaDestPath = destinationDir;
            const copyVerified = await verifyEFSCopy(ssh, chromaDbData?.chromaDbFolder, chromaDestPath, this.wpId);
            
            if (!copyVerified) {
                logger.error('Workspace chroma db data copy verification failed', { wpId: this.wpId });
                throw new Error('EFS copy verification failed for workspace');
            }
            logger.success('Workspace chroma db data successfully copied and verified on EFS', { wpId: this.wpId });
       }
       else
       {
            logger.error('Failed to copy workspace chroma db data', { wpId: this.wpId, error: result.error });
            throw new Error(`Copy command failed: ${result.error}`);
       }

       // now copying the .AIMetadata folder
       let ProjectData = this.discoverProjects(this.folderPath);
         for(let project of ProjectData)
         {
                let sourceAIMetadataFolder = path.join(project.path,'.AIMetadata');
                let destinationAIMetadataFolder = path.join(`/mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/`,project.collectionName);
                // Check if source .AIMetadata folder exists
                let checkAIMetadataResult = await ssh.executeCommand(`[ -d "${sourceAIMetadataFolder}" ] && echo "exists" || echo "not_exists"`);
                
                if(checkAIMetadataResult.output.trim() === "exists")
                {
                    // Remove old .AIMetadata folder in destination if exists to ensure clean replacement
                    await ssh.executeCommand(`sudo rm -rf ${destinationAIMetadataFolder}/.AIMetadata`);
                    
                    // Copy the .AIMetadata folder
                    let copyAIMetadataResult = await ssh.executeCommand(`sudo cp -r ${sourceAIMetadataFolder} ${destinationAIMetadataFolder}`);
                    
                    if(copyAIMetadataResult.success)
                    {
                        logger.success('.AIMetadata folder copied successfully', { project: project.collectionName, wpId: this.wpId });
                    }
                    else
                    {
                        logger.warn('Failed to copy .AIMetadata folder', { project: project.collectionName, wpId: this.wpId, error: copyAIMetadataResult.error });
                    }
                }
                else
                {
                    logger.info(`No .AIMetadata folder found for project: ${project.collectionName}`, { wpId: this.wpId });
                }
         }
       
       if(result.success)
       {
            logger.success('Chroma db data copied to EFS', { wpId: this.wpId });
       }
       else
       {
            logger.error('Failed to copy chroma db data', { wpId: this.wpId, error: result.error });
       }

    //    // now checking if there is any pending chroma setup for a task of this workspace where it might be waiting for chroma db to setup
    //    for(let task of ds.PendingTaskChromaData.get(this.wpId)||[])
    //    {
    //         // now copying the .AIMetadata folder and chroma db data for this task
    //         let taskSSH = new SSHClient('/',task.ec2InstanceIP); // getting the machine where the task is running
    //         let chromaDestinationDir = `/srv/${this.organizationName}/${task.taskId}/`; // /chroma
    //          // copying the chroma db data
    //         let copyChromaResult = await taskSSH.executeCommand(`sudo cp -r ${destinationDir} ${chromaDestinationDir}`);
    //         if(copyChromaResult.success)
    //         {
    //             logger.success('Chroma db data copied to task EFS', { taskId: task.taskId });
    //         }
    //         else
    //         {
    //             logger.error('Failed to copy chroma db data to task EFS', { taskId: task.taskId, error: copyChromaResult.error });
    //         }

    //         // copying the .AIMetadata folder for each project
    //         for(let project of ProjectData)
    //         {
    //             let sourceAIMetadataFolder = path.join(`/mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/`,project.collectionName,' .AIMetadata');
    //             let destinationAIMetadataFolder = path.join(task.folderPath,project.collectionName,' .AIMetadata');
    //             // now copy the .AIMetadata folder
    //             let copyAIMetadataResult = await taskSSH.executeCommand(`sudo cp -r ${sourceAIMetadataFolder} ${destinationAIMetadataFolder}`);
                
    //             if(copyAIMetadataResult.success)
    //             {
    //                 logger.success('.AIMetadata folder copied to task successfully', { project: project.collectionName, taskId: task.taskId });
    //             }
    //             else
    //             {
    //                 logger.warn('Failed to copy .AIMetadata folder to task', { project: project.collectionName, taskId: task.taskId, error: copyAIMetadataResult.error });
    //             }
    //         }           

    //     }
    //     ds.PendingTaskChromaData.delete(this.wpId);

       result = await ssh.executeCommand(`sudo rm -rf ${chromaDbData?.chromaDbFolder}`); // removing the chroma db folder from the indexer machine
       let command = `image=$(sudo docker inspect -f '{{.Config.Image}}' chroma_${this.wpId}) && \
        sudo docker rm -f chroma_${this.wpId} && \
        sudo docker rmi "$image" `
       result = await ssh.executeCommand(command); // removing the docker container and the image as well

        let ssh2 =  new SSHClient('/',this.ec2_instance_ip);
        let result1 = await ssh.executeCommand(`sudo rm -rf ${this.folderPath}`); // removing the workspace folder for saving the space.
            if(result1.success)
            {
                logger.success("Workspace removed successfully", { wpId: this.wpId });
            }
            // updating the mongodb that indexer is ready for this workspace now.

        
            let databaseService = DatabaseService.getInstance();
            await databaseService.ensureCollection(this.dbName, CollectionNames.WORKSPACES as any);
            let wpHandler = databaseService.getRepository<Workspaces>(this.dbName, CollectionNames.WORKSPACES);
            await wpHandler.updateOne({
                wpId: this.wpId
            },{
                $set:{
                 
                    isIndexerComplete: true
                }
            });

        // also we will be notifying all the sockets that the workspace is ready now. such that it can be updated in realtime.
        io.to(this.userId).emit('workspace_indexer_complete',{
            wpId: this.wpId,
            isIndexerComplete:true
        });
        await ssh.disconnect();
       await releaseEC2Instance(ec2Details.instanceId,this.wpId,ds.EC2Type.Indexer); //
    }
    async createTaskDir()
    {
         try {
            await this.setupTaskPath();
            let ssh2 = new SSHClient('/',this.ec2_instance_ip);

            let result = await ssh2.executeCommand(`sudo mkdir -p ${this.folderPath}`);
            await ssh2.disconnect();
            return this.folderPath;
        }
        catch (ex) {
            console.log("exception in ==>", ex);
        }
    }
    async cloneAndSetupBranch(repoName:string, branchName: string, workspaceBranch: string,mode:number, currRepoDetail?: any) {
        let repoDetails: RepoDetails = {} as RepoDetails;
            repoDetails.repoName = repoName;
            repoDetails.branchName = branchName;
            //await this.createWpDir();
            let ssh = new SSHClient(this.folderPath,this.ec2_instance_ip);
        try {

           
            
            await ssh.connect();
            //getting the installation token

              const installationId:any = Organization_AppInstallation.get(UserInfo.get(this.userId)?.organizationName as string)?.installationId;
           // const installationId: any = "91162955";



            //use this installation id to get the fresh installation token.
            let installationToken = await fetchInstallationToken(installationId); //got the installation token now, setting this in the cloned repo path and then changing the branch
            //getting the organization name for the installationId
            logger.info("got the installation token==>",installationToken);
            let GithubOrganizationName = await getGithubOrganizationName(installationId);
            // cloning the github repo using the this.ssh command
            logger.info("installation token is =>",  installationToken.token );
            logger.info("running the command=>",`sudo git clone https://x-access-token:${installationToken.token}@github.com/${GithubOrganizationName}/${repoName}.git`);
            let result = await ssh.executeCommand(`sudo git clone https://x-access-token:${installationToken.token}@github.com/${GithubOrganizationName}/${repoName}.git`);
            
            if (result.success) {
                logger.success("Repository cloned successfully", { repoName, branchName });

                
                this.repoDetails[repoName]=repoDetails;
            }
            else {
                logger.error("failed to clone the repo=>",result.output);
                logger.error("failed to clone the repo=>",result.error);
                throw result.output;
            }
            // so it has been some days since we have been working on this project 
            //doing the next step to change the branch to the required branch

            //first going inside the repo name folder, since now we are having a folder inside the workspace folder with the repo name

            // Try to checkout the branch, if it doesn't exist, create it from workspaceBranch
            result = await ssh.executeCommand(`cd ${repoName} && (sudo git checkout ${branchName} 2>/dev/null || sudo git checkout -b ${branchName} origin/${workspaceBranch})`);           
            if (result.success) {
               logger.success(`Checked out branch ${branchName} successfully`, { repoName, branchName });

                if(mode === 1) // when this has been called for task setup
                {
                result = await ssh.executeCommand(`cd ${repoName} && sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${GithubOrganizationName}/${repoName}.git`);
                result = await ssh.executeCommand(`cd ${repoName} && sudo git push -u origin ${branchName}`);
                await ssh.executeCommand(`cd ${repoName} && sudo git remote set-url origin https://github.com/${GithubOrganizationName}/${repoName}.git`);
                currRepoDetail.repoUrl = `http://github.com/${GithubOrganizationName}/${repoName}`;
                if (result.success) {
                    logger.success("Branch pushed to remote successfully", { repoName, branchName });
                } else {
                    logger.warn("Failed to push branch to remote", { repoName, branchName, error: result.error });
                }
            }
            }

            await ssh.disconnect();



        }
        catch (ex) {
            logger.error("Exception in cloneAndSetupBranch", { repoName, branchName, error: ex });
            throw ex;
        }
        finally{
            await ssh.disconnect();
        }
    }
    //updating the permissions of the given folder giving it all the permissions required
    async updateDirectoryPermissions(repoName:string) {
        let folderPath = this.folderPath + '/'+repoName;
            let ssh = new SSHClient(folderPath,this.ec2_instance_ip);
        try {
            
            await ssh.connect();

            // Update permissions excluding node_modules, Python virtual environments, and cache directories
            // This significantly reduces execution time by skipping large dependency folders
            const excludeDirs = "node_modules|venv|\\.venv|__pycache__|\\.git";
            
            // Update directory permissions
            let dirCommand = `find ${this.folderPath} -type d \\( -name "node_modules" -o -name "venv" -o -name ".venv" -o -name "__pycache__" -o -name ".git" \\) -prune -o -type d -exec sudo chmod 777 {} +`;
            let dirResult = await ssh.executeCommand(dirCommand);
            
            // Update file permissions
            let fileCommand = `find ${this.folderPath} \\( -path "*/node_modules/*" -o -path "*/venv/*" -o -path "*/.venv/*" -o -path "*/__pycache__/*" -o -path "*/.git/*" \\) -prune -o -type f -exec sudo chmod 777 {} +`;
            let fileResult = await ssh.executeCommand(fileCommand);
            
            if (dirResult.success && fileResult.success) {
                console.log("\n permission of the folder path updated successfully (excluding node_modules and Python modules)");
            } else {
                console.log("\n permission update completed with some warnings");
            }
            await ssh.disconnect();
        }
        catch (ex) {
            console.log("\n exception while updating the directory permissions==>", ex);
        }
        finally{
            await ssh.disconnect();
        }
    }
    async setSecrets(keys: string[],repoName:string) {
        let ssh = new SSHClient(this.folderPath,this.ec2_instance_ip);
        try {
            
          
            await ssh.connect();
            let secretManager = new SecretManager(this.dbName);
            let secrets = [];
            for (let key of keys) {
                const result: any = await secretManager.getSecret(key);
                if (result.success && result.secrets.data) {
                    secrets.push(result.secrets.data);
                }
            }

            let envContent = '';
            for (let secretJson of secrets) {
                for (let key in secretJson) {
                    envContent += `${key}=${secretJson[key]}\n`;
                }
            }
            this.repoDetails
            const envFilePath = `${this.folderPath}/${repoName}/.env`;
            let result = await ssh.executeCommand(`sudo cat > ${envFilePath} << 'EOF'\n${envContent}EOF`);
           if(result)
           {
            console.log("\n the secrets are set successfully");
            this.repoDetails[repoName].keys = keys;
           }
            await ssh.disconnect();
            console.log(`Secrets written to ${envFilePath}`);

        }
        catch (ex) {
            console.log("exception in setSecrets is==>", ex);
            throw ex;
        }
        finally{
            await ssh.disconnect();
        }
    }
    //setting up the docker container for the project now..

    async setDockerEnvironmentWorkspace(repoName:string) {
         let id = this.taskId === '' || this.taskId === undefined ? this.wpId : this.taskId;
            let chatHistoryPath = `${this.organizationName}/task/${id}/SetupAgentDocker/${uuidv4()}`;
            let agent = new Agent(1, this.folderPath, Operations.DOCKER_SETUP, this.ec2_instance_ip,chatHistoryPath,id,this.userId,AgentTypeEnum.MASTER_AGENT,[AccessRights.READ_FILES,AccessRights.WRITE_FILES,AccessRights.EXECUTE_COMMAND_TOOL],false); // the name of the created docker environment will be the base name of the folderPath given here.
            await agent.connect();
            this.abortController = new AbortController();
            await agent.run("Setup the docker environment for this project", [], Operations.DOCKER_SETUP,null as any,this.abortController.signal,null,repoName);
            
            //we will assume that the docker environment is set and the folder will now contain things like DockerFile and docker-compose.yml and we will be storing it in
            // /mnt/efs2/this.orgName/this.userId/WorkspaceData/WpId/docker/
            let ssh = new SSHClient('/',this.ec2_instance_ip);
            await ssh.executeCommand(`sudo mkdir -p /mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/docker/`);
            let result = await ssh.executeCommand(`sudo cp -r ${this.folderPath}/Dockerfile /mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/docker/`);
            result = await ssh.executeCommand(`sudo cp -r ${this.folderPath}/docker-compose.yml /mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/docker/`);
            await ssh.disconnect();
            console.log("the docker env is set");
            this.isDockerSet = true;
            await ssh.disconnect();
        
    }
    async startDockerEnvironmentTask(mode:any)
    {
        // this function will start the docker environment, first by copying the Dockerfile and dcoker-compose.yml to the task folder Path and then we will just have to
        // start the container 

        let ssh = new SSHClient(this.folderPath,this.ec2_instance_ip);
        await ssh.connect();
        let sourcePath = "";

        if(mode === TaskType.DYNAMIC_WORKSPACE)
        {
            sourcePath = `/mnt/efs2/General/`;
        }
        else if(mode === TaskType.WITH_WORKSPACE){
            sourcePath = `/mnt/efs2/${this.organizationName}/WorkspaceData/${this.wpId}/docker/`;
        }
        let result = await ssh.executeCommand(`sudo cp -r ${sourcePath}Dockerfile ${this.folderPath}/`);
        result = await ssh.executeCommand(`sudo cp -r ${sourcePath}docker-compose.yml ${this.folderPath}/`);
        if(result.success)
        {
            console.log("Docker files copied successfully to task folder");
        }
        else
        {
            console.log("Failed to copy Docker files to task folder:", result.error);
        }
        // now we will be starting the docker container using docker compose command
        let containerName = path.basename(this.folderPath);
        //getting the available port for the playwright in the host machine.

        let availablePortResult1 = await ssh.executeCommand("for p in $(seq 8900 9000); do (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; break; }; done");
        let availablePort = availablePortResult1.output.trim();

        let availablePort2 = await ssh.executeCommand(`exclude_ports=(${availablePort}); for p in $(seq 8900 9000); do [[ " \${exclude_ports[@]} " =~ " $p " ]] && continue; (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; break; }; done`);
        availablePort2 = availablePort2.output.trim();

        let availablePort3 =  await ssh.executeCommand(`exclude_ports=(${availablePort} ${availablePort2}); for p in $(seq 8900 9000); do [[ " \${exclude_ports[@]} " =~ " $p " ]] && continue; (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; break; }; done`);
        availablePort3 = availablePort3.output.trim();

        let result1 = await ssh.executeCommand(`sudo bash -c 'APPLICATION_PORT_1=${availablePort2} APPLICATION_PORT_2=${availablePort3} START_PLAYWRIGHT_SERVER=true PLAYWRIGHT_MOUNT=/mnt/efs2/Utilities/playwright-mcp PLAYWRIGHT_PORT=${availablePort} CONTAINER_NAME=${containerName} docker compose -p ${containerName} up -d'`);
        // starting the playwright server inside the container now.
        if(result1.success)
        {
            console.log("docker container started for the task setup successfully, this is the agent's docke container");
            return availablePort;
        }
        await ssh.disconnect();
        
    }

    

    async verifyCommands(commands: Record<string, string>,repoName:string): Promise<any> {
        //this will verify both commands to install the dependencies and to start the project
        let chatHistoryPath = `${this.organizationName}/workspace/${this.wpId}/VerifyCommands/${uuidv4()}`;
        let agent = new Agent(1, this.folderPath, Operations.COMMAND_VERIFY, this.ec2_instance_ip,chatHistoryPath,this.taskId,this.userId,AgentTypeEnum.MASTER_AGENT,[AccessRights.READ_FILES,AccessRights.EXECUTE_COMMAND_TOOL,AccessRights.WRITE_FILES],false); // the name of the created docker environment will be the base name of the folderPath given here.
        await agent.connect();
        let commandString = Object.entries(commands).map(([k, v]) => `${k}:${v}`).join(';');
        this.abortController = new AbortController();
        let verifyCommandResult = await agent.run(`Try executing these commands ${commandString} in the project ${repoName}`,
            [], Operations.COMMAND_VERIFY,null as any,this.abortController.signal,null,repoName);

      
        if (verifyCommandResult.result) {
            console.log("commands verified successfully");
            
            // ensure repo entry exists
            if (!this.repoDetails[repoName]) {
                this.repoDetails[repoName] = {} as RepoDetails;
            }
            // ensure commands is a Map and initialize if missing
            if (!this.repoDetails[repoName].commands) {
                this.repoDetails[repoName].commands = {};
            }
            // copy all command entries into the Map
            for (const [key, value] of Object.entries(commands)) {
                this.repoDetails[repoName].commands[key]= value;
            }
            //store these commands in the db so that they can be passsed back to the agent.
            return verifyCommandResult;
        }
        else {
            console.log("\n command verification failed due to the error=>", verifyCommandResult.error);
            return verifyCommandResult;
        }



    }
    

    async setPermissionScopes(permissionScopes: Record<string,any>)
    {
        this.permissionScopes = permissionScopes;
    }
    async removeUnstagedChanges(repoName:string,branchName:string)
    {
        try{
             let ssh2 = new SSHClient(this.folderPath + '/' + repoName, this.ec2_instance_ip);
            
             let result = await ssh2.executeCommand(`sudo git reset --hard && sudo git clean -fd`);
            if(result.success) {
                logger.success("Branch checkout successful", { repoName, branchName });
            } else {
                logger.error("Branch checkout failed", { repoName, branchName, error: result.error });
            }
            
            // Add .AIMetadata folder to .gitignore
            result = await ssh2.executeCommand(`grep -qxF "/.AIMetadata" .gitignore || echo "/.AIMetadata" | sudo tee -a .gitignore > /dev/null`);
            if (result.success) {
                logger.success(".AIMetadata added to .gitignore", { repoName });
            } else {
                logger.warn("Failed to add .AIMetadata to .gitignore", { repoName, error: result.error });
            }
        }
        catch(ex)
        {
            logger.error("\n exception while removing unstaged changes for repo==>",{repoName,error:ex});
        }
    }
    async finalizeTaskSelfHosted(folderPath:string,repoInfo:any[],socket:any,isSubTask:any,permissionScopes:any,metadata:any,branchName:any) // socket here is 
    {
        try{
        // this function will be used to call the socket responsible for setting up the environment locally
            let selfHostedSocket:any = ds.userId_orchestratorSocket.get(this.userId);
            if(selfHostedSocket)
            {
                let promise = new Promise((resolve,reject)=>{
                    selfHostedSocket.emit('run_local_task_setup',{folderPath: folderPath,
                        taskId: this.taskId,
                        repos: repoInfo,
                        newBranchName: branchName // this is in the format of the structure defined in PhantomX_Controller repository, we need to create that object to send to that
                    },(result:any)=>
                    {
                        if(result.success)
                        {
                            logger.success("setup is successful at the client's local machine");
                            resolve({
                                success:true
                            });
                        }
                        else{
                            logger.error("setup failed at the client's local machine=>",result.error);
                            reject({
                                success:false,
                                error: result.error
                            });
                        }   
                    })
                });
                let result =  await promise;

                
            let databaseService = DatabaseService.getInstance();
            await databaseService.ensureCollection(this.dbName,CollectionNames.TASKS as any);
            let taskHandler = databaseService.getRepository<Task>(this.dbName,CollectionNames.TASKS);
            let sessionId = uuidv4();
            let chatHistoryPath = `${this.organizationName}/task/${this.taskId}/${sessionId}`;

            //storing the first acitivity log that task has been started
            const userData = ds.UserInfo.get(this.userId);
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
            io.to(socket?.data.user.userId).emit('change_task_status', {
            taskId: this.taskId,
            status: TaskStatus.Waiting
            });
            
            if(isSubTask)
            {
                // we will be saving this in memory, since this is not a normal task
            }
            else{

            let result = await taskHandler.updateOne(
                {taskId: this.taskId},
                {
                    $set:{
                taskId: this.taskId,
                wpId: this.wpId,
                createdBy: this.userId,
                createdAt: new Date(),
                permissionScopes: permissionScopes as any,
                EC2InstanceIP: this.ec2_instance_ip,
                status: TaskStatus.Waiting,
                chromaDataFolderPath: "",
                AIMetadataFolderPath: "",
                chromaServerPort:8080,              
                metadata: metadata, 
                taskFolderPath: folderPath,
                sessionId_chatHistoryData: { [sessionId]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() } } as Record<string, ds.chatHistoryData>,
                branchName:branchName,
                wpName: this.workspaceName,
                repoDetails: repoInfo ,
                systemPrompts: []
            }});
            if(result)
            {
                // setting that we have started a task in the data structures              
                return {
                    workspaceName: this.workspaceName,
                    sessionId_chatHistoryData: { [sessionId]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() } } as Record<string, ds.chatHistoryData>};
            }
               
            
            else{
                logger.error("in Finalize Task Self hosted function==>", " no socket found for connecting to the local machine");
            }
        }
        }
    }
        catch(ex)
        {
            logger.error("error in the function finalizeTaskSelfHosted",ex);
            throw ex;
        }

    }

    async finalizeTask(permissionScopes:Record<string,any>,repoDetails: RepoDetails[],metadata:any,branchName:string, workspaceBranch: string,systemPrompts:[]=[],socket?:Socket,taskId?:any,isSubTask?:boolean,mode?:any)
    {
        try
        {
            if(systemPrompts === null || systemPrompts === undefined)
            {
                systemPrompts = [];
            }
            await this.createTaskDir();
            for (const val of repoDetails)
            {
                // handle each repo key (repo name) if needed
                try{
                await this.cloneAndSetupBranch(val.repoName,branchName, val.branchName, 1,val);
                await this.updateDirectoryPermissions(val.repoName);
                    if(!(val.keys===null||val.keys===undefined))
                    {
                        await this.setSecrets(val.keys,val.repoName);
                    }
                }
                catch(ex)
                {
                    console.log('exception while setting the repo==>',val.repoName);
                }

            }

            // adding CLAUDE.md file for the agent in the parent folder of the workspace
            let claudeFile = '';
            for(let val of systemPrompts)
            {
                let data:any = await systemPromptService.getSystemPrompt(val,this.userId);
                if(data.success)
                {
                claudeFile += data.prompt.content+"\n";
                }

            }
            claudeFile+="Commands for the project \n";

            for(let data of repoDetails)
            {

                if(data.commands!==undefined || data.commands!=null)
                {
                    var commands = Object.entries(data.commands);
                    claudeFile+="For the repository=>"+data.repoName+"\n";
                    for(let command of commands)
                    {
                        claudeFile+="-------------------------------------------------------------------\n";
                        claudeFile+=command[0]+":"+command[1];
                    }
                }
            }
            // the claudeFile text is ready now we just have to set this file
            let ssh = new SSHClient(this.folderPath,this.ec2_instance_ip);
            let result1 = await ssh.executeCommand(`
                sudo tee CLAUDE.md > /dev/null <<EOF
                ${claudeFile}
                EOF
                `);

            if(result1.success)
            {
                logger.success("CLAUDE.md is properly set to the folder path=>",this.folderPath);
            }
            else{
                logger.error("Error while setting CLAUDE.md to the folder path=>",this.folderPath);
            }
            for (const val of repoDetails)
            {
                await this.removeUnstagedChanges(val.repoName,branchName);
            }
            //starting the docker container now
            let playwrightPort = await this.startDockerEnvironmentTask(mode);

            let terminalUrl = await setupTerminalEnvironment(this.ec2_instance_ip,this.folderPath,this.taskId);

            // now installing the dependencies in the docker environment given..

            for(const val of repoDetails)
            {
                if(val?.commands?.["install-dependencies"])
                installDependencies(val.repoName,val.commands["install-dependencies"],this.folderPath,this.ec2_instance_ip);
                
                logger.info("\n started installing dependencies for==>",val.repoName);
            }

            let databaseService = DatabaseService.getInstance();
            
            await databaseService.ensureCollection(this.dbName,CollectionNames.TASKS as any);
            let taskHandler = databaseService.getRepository<Task>(this.dbName,CollectionNames.TASKS);
            let sessionId = uuidv4();
            let chatHistoryPath = `${this.organizationName}/task/${this.taskId}/${sessionId}`;

            //storing the first acitivity log that task has been started
            const userData = ds.UserInfo.get(this.userId);
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
            io.to(socket?.data.user.userId).emit('change_task_status', {
            taskId: taskId,
            status: TaskStatus.Waiting

        });
            
            if(isSubTask)
            {
                // we will be saving this in memory, since this is not a normal task
            }
            else{

            let result = await taskHandler.updateOne(
                {taskId: this.taskId},
                {
                    $set:{
                taskId: this.taskId,
                wpId: this.wpId,
                createdBy: this.userId,
                createdAt: new Date(),
                permissionScopes: permissionScopes as any,
                EC2InstanceIP: this.ec2_instance_ip,
                status: TaskStatus.Waiting,
                chromaDataFolderPath: "",
                AIMetadataFolderPath: "",
                chromaServerPort:8080,              
                metadata: metadata, 
                taskFolderPath: this.folderPath,
                sessionId_chatHistoryData: { [sessionId]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() } } as Record<string, ds.chatHistoryData>,
                branchName:branchName,
                wpName: this.workspaceName,
                repoDetails: repoDetails,
                systemPrompts: systemPrompts
            }});
            if(result)
            {
                // setting that we have started a task in the data structures              
                return {terminalUrl: terminalUrl,
                    repoDetails: repoDetails,
                    playwrightPort: playwrightPort,
                    workspaceName: this.workspaceName,
                    sessionId_chatHistoryData: { [sessionId]: { chatHistoryFileName: chatHistoryPath, CreatedDate: new Date() } } as Record<string, ds.chatHistoryData>};
            }
        }
            await ssh.disconnect();
        }
        catch(ex)
        {
            return {
                success:false,
                message: ex
            }
        }
    }


    async finalizeWorkspace()//this function will be used to setup the wp in the db
    {
        try {


            let databaseService = DatabaseService.getInstance();
            await databaseService.ensureCollection(this.dbName, CollectionNames.WORKSPACES as any);
            let wpHandler = databaseService.getRepository<Workspaces>(this.dbName, CollectionNames.WORKSPACES);
            
            let result = await wpHandler.insertOne({
                wpId: this.wpId,
                tags: this.tags,
                description:this.description,
                workspaceName: this.workspaceName,
                repoDetails: Object.values(this.repoDetails),
                createdBy: this.userId,
                permissionScopes: this.permissionScopes,
                createdOn: new Date(),
                isIndexerComplete:false,
                systemPrompts: this.systemPrompts,
                chatSessionId: this.sessionId
                
            });
            //logging
            if (result) {
                console.log("Workspace with id=>" + this.wpId + " is successfully created");
                
            }
            //logging the EC2 machine usage for that time.
            let ec2Usage  = new EC2MetricsService(this.dbName);
            let currentTime = new Date();
            let usageTime = ((currentTime.getTime())-(this.startedAt.getTime()))/(1000*60);
            ec2Usage.trackUsage({
                ec2InstanceId:this.ec2_instance_id,
                ec2Type: EC2Type.Task,
                usageTime: usageTime,
                userId:this.userId,
                organizationId:ds.UserInfo.get(this.userId)?.organizationId as any,
                wpId: this.wpId,
                groupedName: this.workspaceName,
                userName:ds.UserInfo.get(this.userId)?.userName as any


            }); // tracked.
            //releasing the EC2 instance now.
            await releaseEC2Instance(this.ec2_instance_id,this.wpId,ds.EC2Type.Task);
        
        }
        catch (ex) {
            console.log("while setting up the workspace, this error occured=>" + ex);
        }


    }
     // creating final function which will do everything, first to create the workspace
    
    
        
    





}
// (async () => {


//     let obj = new SetupWorkspaceForSetup("ai_playgrounds","Indexer","AI-PLAYGROUNDS","/mnt/efs1/AI_PLAYGROUNDS/001/","0e61e6cc-9ee4-4681-ad7a-6172548c6f54","3.85.8.152");

//     //await obj.createWpDir();
//     //await obj.cloneAndSetupBranch("master");
//     //await obj.updateDirectoryPermissions();
//    // await obj.setSecrets(["Indexer-env"]);

//    // await obj.setDockerEnvironment();

    

//     // await obj.verifyCommands({
//     //     "Install dependencies": " npm install --legacy-peer-deps",
//     //     "start project": "npm run indexer /mnt/efs1/AI_CODER_REMOTE 8080"
//     // });

//     await obj.setupChromaServer("test-task-001");
//     await obj.finalizeWorkspace({
//         "organization":"Write"
//     });




// })();
