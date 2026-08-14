import { Server, Socket } from 'socket.io';
import { TaskService } from '../Services/TaskService';
import { TaskQueueService, TaskAction } from '../Services/TaskQueueService';
import {DatabaseService} from '../DataAccessLayer/DatabaseService';
import * as ds from '../DataStructures';
import { CollectionNames } from '../DataAccessLayer/models';
import { Task } from '../DataAccessLayer/models/Task';

export async function check_user_terminal(taskId: string, socket: Socket) {
    try{
        return TaskService.checkUserTerminal(taskId, socket);
    } catch (error) {
        console.error("Error checking user terminal:", error);
        throw error;
    }
}

export async function task_handler(io: Server, socket: Socket) {

    socket.on("get_task_github_data", async (data, callback) => {
        const result = await TaskService.getTaskGithubData(data, socket);
        callback(result);
    });

    socket.on("get_task_activity_log", async (data, callback) => {
        const result = await TaskService.getTaskActivityLog(data, socket);
        callback(result);
    });

    socket.on("update_task_notes", async (data, callback) => {
        const result = await TaskService.updateTaskNotes(data, socket);
        callback(result);
    });

    socket.on("get_task", async (data: any, callback) => {
        const result = await TaskService.getTask(data, socket);
        callback(result);
    });

    socket.on("task_alive_status", async (data: any, callback) => {
        const result = await TaskService.taskAliveStatus(data, socket);
        callback(result);
    });

    socket.on("setup_task", (data: any, callback) => {
        TaskQueueService.enqueue(data.taskId, { socket, data, action: TaskAction.Setup, callback });
    });

    socket.on("transfer_task", (data: any, callback) => {
        TaskQueueService.enqueue(data.taskId, { socket, io, data, action: TaskAction.Transfer, callback });
    });

    socket.on("start_task", (data: any, callback) => {
        TaskQueueService.enqueue(data.taskId, { socket, io, data, action: TaskAction.Start, callback });
    });

    socket.on("get_tasks", async (data: any, callback) => {
        const result = await TaskService.getTasks(data, socket);
        callback(result);
    });

    socket.on("get_workspace_tasks", async (data, callback) => {
        const result = await TaskService.getWorkspaceTasks(data, socket);
        callback(result);
    });
    socket.on("update_repo_branch",async(data:any,callback)=>{
        /*
        data will have the following structure:
        1. repoName:string
        2. branchName:string
        3. taskId:string
        */
      let dbService =await DatabaseService.getInstance();
        let taskHandler = dbService.getRepository<Task>(ds.UserInfo.get(socket.data.user.userId)?.dbName, CollectionNames.TASKS);
        let taskData:any = await taskHandler.findOne({taskId:data.taskId});
       let controllerSocket = ds.userId_orchestratorSocket.get(socket.data.user.userId);
        let result:any = await new Promise((resolve,reject)=>{
            controllerSocket?.emit('update_repo_branch',{repoName:data.repoName,branchName:data.branchName,taskFolderPath:taskData?.taskFolderPath},(result:any)=>{
                resolve(result);
            });
        });
     
        if(result.success)
        {
           let updateResult= await taskHandler.updateOne({taskId:data.taskId,
                "repoDetails.repoName":data.repoName
            },{
                $set:{
                    "repoDetails.$.branchName":data.branchName
                }
            })
            callback({success:true,message:"Repo and branch updated successfully"});
        }
        else
        {
            callback({success:false,message:"Failed to update repo and branch"+result.error});
        }
      
    });
    socket.on("abort_task", (data: any, callback) => {
        TaskQueueService.enqueue(data.taskId, { socket, data, action: TaskAction.Abort, callback });
    });
    socket.on("cold_kill_task", (data: any, callback) => {
        TaskQueueService.enqueue(data.taskId, { socket, data, action: TaskAction.ColdKill, callback });
    });
    socket.on("kill_task", (data: any, callback) => {
        TaskQueueService.enqueue(data.taskId, { socket, data, action: TaskAction.Kill, callback });
    });

    socket.on("delete_tasks", async (data, callback) => {
        const result = await TaskService.deleteTasks(data, socket);
        callback(result);
    });

    socket.on("rename_task", async (data: any, callback) => {
        const result = await TaskService.renameTask(data, socket);
        callback(result);
    });

    socket.on("getSubTasks",async (data:any,callback)=>{
        
    })
}
