// this will have every socket endpoint related to manipulation of workspace
import { SetupWorkspaceForSetup } from "../Services/SetupWorkspace";
import * as ds from '../DataStructures';
import { Server, Socket } from 'socket.io';
import { getEC2Instance,releaseEC2Instance } from "../Services/EC2Manager";
import { v4 as uuidv4 } from 'uuid';
import { getDBService } from "../DataAccessLayer/db-connection";
import { Workspaces } from "../DataAccessLayer/models/Workspaces";
import { CollectionNames, IGroup } from "../DataAccessLayer/models";
import { fileServerClientManager } from "../Services/FileServerClientManager";
import { UserInfo } from "../DataStructures";
import { DatabaseService } from "../DataAccessLayer/DatabaseService";
import { toolServerClientManager } from "../Services/ToolServerClientManager";
import { checkGithubInstallationId } from "../Services/AuthTokenService";
import {setupTerminalEnvironment,DeleteWorkspace} from './../Services/SetupWorkspace';
import { checkSubscription } from "../Services/SubscriptionService";
import { createLogger } from '../utils/Logger';
import { access } from "fs";
import { constraintHandlerClass } from "../Services/constraintsService";
import { constraintTypes } from "../model/Plans";
import { check_user_terminal } from "./task.handler";
import { pendingRetries } from "../routes/terminal.routes";

const logger = createLogger('TaskHandler');
export async function workspace_handler(io: Server, socket: Socket) {

    const checkWorkspaceAccess = async (userId: string, workspaceId: string, dbService: DatabaseService) => {
        const userInfo = UserInfo.get(userId as string);
        const workspaceRepository = dbService.getRepository<Workspaces>(userInfo?.dbName as string, CollectionNames.WORKSPACES);
        const currWorkspace = await workspaceRepository.findOne({ wpId: workspaceId });
        //checking if the user is part of a group that has write access or is the owner of the workspace
        if(currWorkspace?.createdBy === userId) {
            return true;
        }
        return Object.keys(currWorkspace?.permissionScopes as any).some((groupId: string) => 
               (userInfo?.permissionScopes.hasOwnProperty(groupId) || userInfo?.userId === groupId || currWorkspace?.createdBy === userId) &&
               currWorkspace?.permissionScopes[groupId].toLowerCase() === 'write'
        );
    }


    socket.on("is_workspace_setup_in_progress", async (data: any, callback) => {
        const wpId = data.workspaceId;
        const is_workspace_setup_in_progress = ds.PendingWorkspaces.get(socket)?.wpId === wpId;
        callback({
            success: true,
            is_workspace_setup_in_progress: is_workspace_setup_in_progress
        });
    })
    socket.on("start_workspace_setup", async (data: any, callback) => {
        /*
        * the data will be
        data: {
             workspaceName: <string> // name of the workspace entered by the user
             permissionScopes:Record<string,string> // permission scope
             tags: string[]
             description:string
        }
        */
        try {
            // Check if organization has active subscription
            // const subscriptionCheck = await checkSubscription(socket);
            // if (!subscriptionCheck.success) {
            //     return callback({
            //         success: false,
            //         status: subscriptionCheck.error?.code || 410,
            //         message: subscriptionCheck.error?.message || 'You dont have any active subscription. Please contact your admin'
            //     });
            // }

            let cresult:any = await constraintHandlerClass.constraintHandler(socket.data.user.userId, constraintTypes.WorkspaceConstraints);
            if(!cresult.success)
            {
                callback({
                    success:false,
                    message: cresult.message
                })
            }


            let wpId = uuidv4();
            let ec2Details: ds.Ec2Details = await getEC2Instance(wpId,ds.EC2Type.Task);

            let userData = ds.UserInfo.get(socket.data.user.userId as string);
            if (!userData) {
                throw new Error("User data not found");
            }
            //before setting up the workspace we will need to check that if the github is set up for the organization or not
            const orgName = userData.organizationName;
            const githubInstallation = await checkGithubInstallationId(orgName);
            if(!githubInstallation.hasInstallationId) {
                callback({
                    success: false,
                    status: 400,
                    message: "Github installation not found for the organization, please install the github app first"
                });
                return;
            }
            //creating folder

            let setupWorkspace = new SetupWorkspaceForSetup(userData.dbName as string, userData.organizationName, socket.data.user.userId as string, ec2Details.publicIp,
               ec2Details.instanceId, data.workspaceName, wpId,"",data?.description,data?.tags
            );
            setupWorkspace.setPermissionScopes(data.permissionScopes);
            let folderPath = await setupWorkspace.createWpDir();
            ds.PendingWorkspaces.set(socket, setupWorkspace);

            //setting the information of the newly started task
            const newWorkspaceData = {
                wpId: wpId,
                startedByUserId: socket.data.user.userId,
                folderPath: folderPath as any,
                organizationId: ds.UserInfo.get(socket.data.user.userId)?.organizationId as any,
                organizationName: ds.UserInfo.get(socket.data.user.userId)?.organizationName as any,
                taskId: "",
                ec2InstanceIP: ec2Details.publicIp,
                startedAt: new Date().toDateString(),
                status: 'running',
                assignedEc2InstanceId : ec2Details.instanceId// assigning the ec2 id
            };
            const existingTasks = ds.userId_task.get(socket.data.user.userId) || [];
            existingTasks.push(newWorkspaceData as any);
            ds.userId_task.set(socket.data.user.userId, existingTasks);
            ds.taskId_task.set(wpId, newWorkspaceData as any);
            socket.data.user.wpId = wpId;


            callback({
                success: true,
                message: "workspace setup started successfully",
                wpId: wpId,
                folderPath: folderPath
            })
        }
        catch (ex) {
            callback({
                success: false,
                message: "workspace setup failed",

            });
        }
    });

    socket.on("setup_repo", async (data: any, callback) => {

        /*
        * data: {
            repoName: <> // name of the repo to be cloned
            branchName: <> // name of the branch to be cloned
        }
        */
        try {
            //getting the free EC2 isntances

            let setupWorkspace: any = ds.PendingWorkspaces.get(socket);

            await setupWorkspace.cloneAndSetupBranch(data.repoName, data.branchName,0);
            await setupWorkspace.updateDirectoryPermissions(data.repoName);

            callback({
                success: true,
                message: "repo setup successfully"
            });
        }
        catch (ex: any) {
            callback({
                success: false,
                error: ex.message
            });
        }



    });
    socket.on("set_secrets", async (data: any, callback) => {
        /*
        * data:{
            secrets: <> // array of the keys of the secrets which have to be added in the repo
            repoName: <> // name of the repo we are working with
        }
        */

        try {
            let setupWorkspace = ds.PendingWorkspaces.get(socket);
            if (!setupWorkspace) {
                throw new Error("No pending workspace setup found for this socket, make sure you have called setup_repo endpoint first");
            }
            await setupWorkspace.setSecrets(data.secrets, data.repoId);
            await setupWorkspace.setDockerEnvironmentWorkspace(data.repoId);
            let userTerminalIp = await setupTerminalEnvironment(setupWorkspace.ec2_instance_ip,setupWorkspace.folderPath,setupWorkspace.wpId);

             check_user_terminal(setupWorkspace.wpId,socket);
            callback({
                success: true,
                message: "Secrets set successfully and docker container set successfully",
                terminalIp: userTerminalIp
            })
        }
        catch (ex: any) {
            callback({
                success: false,
                error: ex.message
            })
        }
    });

    socket.on("verify_commands", async (data: any, callback) => {
        // comamnds will be of type Record<string,string> here the key will the purpose of the command and the value will be the command, 
        // it can have commands for installation, build and run , and run tests
        /*
        * data:{
             commands: Record<string,string> // here the key is the purpose of the command rand the value will be the command itself
             repoName: <> // name of the repo we are working on
        }
        */

        try {
            let setupWorkspace = ds.PendingWorkspaces.get(socket);
            if (!setupWorkspace) {
                throw new Error("No pending workspace setup found for this socket, make sure you have called setup_repo endpoint first");
            }
         //   let commandVerificationResult = await setupWorkspace.verifyCommands(data.commands, data.repoName);
                callback({
                    success: true,
                    message: "commands saved successfully"
                });
           

        }
        catch (ex) {
            callback({
                success: false,
                message: ex
            })
        }


    });
    socket.on('set_prompts',async(data:any,callback)=>{

        /*
        data will be 
        {
            prompts:[
                {
                    promptId: "id of the prompt",
                    promptName: "name of the prompt"
                }
            ]
        }
        */
        try{

            let setupWorkspace: any = ds.PendingWorkspaces.get(socket);
            for(var prompt of data.prompts)
            {
                setupWorkspace.systemPrompts.push(prompt.promptId);
            }
            callback({
                success:true
            });

        }
        catch(ex)
        {
            logger.error('error while setting the prompts while init the workspace=>',ex);
            callback({
                success:false
            })
        }
    });
    socket.on('previous_repo_complete',async(data:any,callback:any)=>{
        /*
        * data will be:
        {
            repoName: <> // name of the previously setup repo,
            workspaceName:<>
            index: repoIndex
        }
        */
       try{
        //removing the docker container for the previous repo
            let setupWorkspace: any = ds.PendingWorkspaces.get(socket);
        await setupWorkspace.removeContainerForWorkspace();
       }
       catch(ex)
       {
        logger.error('error while removing the container for the previous repo during workspace setup==>',ex);
       }
        
    });
    socket.on("finalize_workspace", async (data: any, callback) => {

        /*
        * here the data will be 
        system_prompt_1 : (file name)
        */
        try {

            // now we will be doing some magic here
            let setupWorkspace = ds.PendingWorkspaces.get(socket);
            if (!setupWorkspace) {
                throw new Error("No pending workspace setup found for this socket");
            }
            await setupWorkspace.finalizeWorkspace();
            setupWorkspace.removeWp();

            //creating a CLAUDE.md file, involving the system prompt1 ( company instructions if any) + system prompt2 (workspace instructions if any) +
            // commands given by the user, for running and other stuff


            ds.PendingWorkspaces.delete(socket);
            // Remove the workspace task from the array
            const userTasks = ds.userId_task.get(socket.data.user.userId);
            if (userTasks && setupWorkspace) {
                const filteredTasks = userTasks.filter(task => task.wpId !== setupWorkspace.wpId);
                if (filteredTasks.length > 0) {
                    ds.userId_task.set(socket.data.user.userId, filteredTasks);
                } else {
                    ds.userId_task.delete(socket.data.user.userId);
                }
            }
            let wpData:any = ds.taskId_task.get(socket.data.user.wpId);
           

            //removing the connection from the file server when done
          //  fileServerClientManager.removeClient(wpData.wpId,ds.taskId_task.get(socket.data.user.wpId)?.ec2InstanceIP as string); // conection with the file server is teared down now.
            //toolServerClientManager.removeClient(wpData.wpId,ds.taskId_task.get(socket.data.user.wpId)?.ec2InstanceIP as string);
           
            ds.taskId_task.delete(socket.data.user.wpId);
             socket.data.user.wpId = null;


            callback({
                success: true,
                wpId: setupWorkspace.wpId,
                isIndexerComplete: false
            });

        }
        catch (ex) {
            callback({
                success: false,
                message: ex
            });
        }
    });
    socket.on("abort", async (data: any, callback) => {
        try {
            let setupWorkspace = ds.PendingWorkspaces.get(socket);
            if (!setupWorkspace) {
                throw new Error("No pending workspace setup found for this socket");
            }
            // aborting the AI calls if any
            if(setupWorkspace.abortController)
            {
                setupWorkspace.abortController.abort(); // aborting AI calls if any.
            }
            await setupWorkspace.removeWp();
            // Remove the workspace task from the array
            const userTasks = ds.userId_task.get(socket.data.user.userId);
            if (userTasks && setupWorkspace) {
                const filteredTasks = userTasks.filter(task => task.wpId !== setupWorkspace.wpId);
                if (filteredTasks.length > 0) {
                    ds.userId_task.set(socket.data.user.userId, filteredTasks);
                } else {
                    ds.userId_task.delete(socket.data.user.userId);
                }
            }
             let wpData:any = ds.taskId_task.get(socket.data.user.wpId);
            if(wpData)
            {   
                releaseEC2Instance(wpData.assignedEc2InstanceId as string,wpData.wpId,ds.EC2Type.Task);
            }

            fileServerClientManager.removeClient(socket.data.user.userId); // conection with the file server is teared down now.
             toolServerClientManager.removeClient(socket.data.user.userId);
            ds.taskId_task.delete(wpData?.wpId as any); 
            ds.PendingWorkspaces.delete(socket);
            socket.data.user.wpId = null;

            //aborting the pending proxy for proxy terminal URL
            pendingRetries.delete(setupWorkspace.wpId);

            callback({
                success: true,
                wpId: setupWorkspace.wpId
            })
        }
        catch (ex) {
            callback({
                success: false,
                message: ex
            });
        }
    });

    socket.on("get_workspaces", async (data: any, callback) => {
        try {
            let userData = ds.UserInfo.get(socket.data.user.userId as string);
            if (!userData) {
                throw new Error("User data not found");
            }
            const dbService = await getDBService();
            const workspacesRepository = dbService.getRepository<Workspaces>(userData.dbName as string, CollectionNames.WORKSPACES);
            let permissionScopeIds = Object.keys(userData?.permissionScopes as any);
            permissionScopeIds.push(userData?.userId as string);
            if (!permissionScopeIds.length) {
                callback({
                    success: false,
                    message: "No permission scopes found"
                });
                return;
            }
            const filter = {
                $or: permissionScopeIds.map(id => ({
                    [`permissionScopes.${id}`]: { $exists: true }
                }))
            }
            let workspacesByGroups = await workspacesRepository.find(filter);
            let workspacesCreatedByUser = await workspacesRepository.find({ createdBy: userData?.userId });
            const combined = [...workspacesByGroups, ...workspacesCreatedByUser];
            const workspaces = Array.from(
                new Map(combined.map(item => [item._id.toString(), item])).values()
            );
            // for (const workspace of workspaces) {
            //     const filteredPermissionScopes: Record<string, 'Read' | 'Write'> = {};
            //     Object.keys(workspace.permissionScopes).forEach((key: string) => {
            //         if (permissionScopeIds.includes(key)) {
            //             filteredPermissionScopes[key] = workspace.permissionScopes[key];
            //         }
            //     });
            //     workspace.permissionScopes = filteredPermissionScopes;
            // }
            callback({
                success: true,
                workspaces: workspaces
            });
        }
        catch (ex) {
            callback({
                success: false,
                message: ex
            });
        }
    });


    socket.on("update_workspace_details", async (data: any, callback) => {
        try {
            const {workspaceUpdateData} = data;
            const userInfo = UserInfo.get(socket.data.user.userId as string);
            if (!userInfo) {
                throw new Error("User information not found");
            }
            const dbService = await getDBService();
            if(!await checkWorkspaceAccess(userInfo.userId, workspaceUpdateData.wpId, dbService)) {
                callback({
                    success: false,
                    message: "You do not have access to update this workspace"
                });
                return;
            }
            let updateResult;
            switch(workspaceUpdateData.type) {
                case "description":
                    updateResult = await dbService.getRepository<Workspaces>(userInfo.dbName as string, CollectionNames.WORKSPACES).updateOne({ wpId: workspaceUpdateData.wpId }, { $set: { description: workspaceUpdateData.description } });
                    break;
                case "tags":
                    updateResult = await dbService.getRepository<Workspaces>(userInfo.dbName as string, CollectionNames.WORKSPACES).updateOne({ wpId: workspaceUpdateData.wpId }, { $set: { tags: workspaceUpdateData.tags } });
                    break;
                case "permissionScopes":
                    updateResult = await dbService.getRepository<Workspaces>(userInfo.dbName as string, CollectionNames.WORKSPACES).updateOne({ wpId: workspaceUpdateData.wpId }, { $set: { permissionScopes: workspaceUpdateData.permissionScopes } });
                    break;
                default:
                    callback({
                        success: false,
                        message: "Invalid workspace update type"
                    });
                    return;
            }
            if(updateResult.modifiedCount === 0) {
                callback({
                    success: false,
                    message: "Failed to update workspace"
                });
                return;
            }
            
            callback({
                success: true,
                message: "Workspace description updated successfully"
            });
        }
        catch (ex) {
            callback({
                success: false,
                message: ex
            });
        }
    });
    socket.on("delete_workspaces",async(data,callback)=>{
        try{
            const dbService = await getDBService();
            const accessDenied = [];
            for(var wpId of data.wpIds)
            {
                if(!await checkWorkspaceAccess(socket.data.user.userId, wpId, dbService)) {
                    accessDenied.push(wpId);
                }
                await DeleteWorkspace(socket,wpId);
            }
            logger.info("\n workspaces have been deleted successfully==>");
            let callbackMessage = data.wpIds.length > 0 ? "All Workspaces deleted successfully" : "Workspace deleted successfully";
            if(accessDenied.length > 0) {
                callbackMessage += `. However, you did not have access to some workspaces`;
                if(accessDenied.length === data.wpIds.length) {
                    callbackMessage = "You do not have access to delete any of the specified workspaces";
                }
            }
            callback({
                success:true,
                message:callbackMessage
            });
        }
        catch(ex)
        {
            logger.error("\n error while deleting the workspces==>",ex);
            callback({
                success:false,
                messge:ex
            });
        }
    });

}