import 'dotenv/config';
import * as express from 'express';
import { createServer } from 'http';
import { DefaultEventsMap, Server, Socket } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import * as cors from 'cors';
import { FolderStructureImplementation } from './Implementation/FolderStructureImplementation';
import cookieParser from "cookie-parser";
const SSHClient = require('./Services/ssh-client');
const { ChromaManager } = require('./Implementation/ChromaManager');
import { file_server_handler } from './socket-handlers/file-server.handler'
import authRoutes from './routes/auth.routes';
import { socketAuthMiddleware } from './middlewares/socket-auth.middleware';

import { authenticateJWT } from './middlewares/auth.middleware';
import { initialSetup_handler } from './socket-handlers/initialSetup.handler';
import { user_details_handler } from './socket-handlers/user-details.handler';
import { org_details_handler } from './socket-handlers/org-details.handler';
import { invite_mail_handler, testSendEmail, testSendInviteEmail } from './socket-handlers/invite-mail.handler';
import githubroutes from './routes/github.auth.routes';
import atlassianRoutes from './routes/atlassian.auth.routes';
import mcpOAuthRoutes from './routes/mcp-oauth.routes';
import docsRoutes from './routes/docs.routes';
import blogsRoutes from './routes/blogs.routes';
import terminalRoutes, { proxy as terminalProxy } from './routes/terminal.routes';

import { UserName_Socket, Ec2Details, FreeEc2Pool, FreeIndexerEc2Pool, Organization_AppInstallation, GithubAppInstallationDetails, PendingWorkspaces, userId_task, socket_task, WorkspaceId_EC2Ip, WorkspaceId_FileServerPort, userId_sockets } from './DataStructures';
import { group_handler } from './socket-handlers/groups.handler';
import { secret_manager_handler } from './socket-handlers/secret-manager.handler';
import { workspace_handler } from './socket-handlers/workspace.handler';
import { task_handler } from './socket-handlers/task.handler';
import { paypal_handler } from './socket-handlers/paypal.handler';
import { razorpay_handler } from './socket-handlers/razorpay.handler';
import * as db from './DataAccessLayer/db-connection';
import { github_handler } from './socket-handlers/github.handler';
import { atlassian_handler, } from './socket-handlers/atlassian.handler';
import { mcp_integrations_handler } from './socket-handlers/mcp-integrations.handler';
import { fileServerClientManager } from './Services/FileServerClientManager';
import * as ds from './DataStructures';
import { toolServerClientManager } from './Services/ToolServerClientManager';
import { paypalWebhookService } from './Services/PayPalWebhookService';
import { razorpayWebhookService } from './Services/RazorpayWebhookService';
// Initialize mail queue on import (auto-starts worker)
import './Services/Queue/mail-queue';
import { EC2Service } from './Services/EC2Service';
import { EC2 } from '@aws-sdk/client-ec2';
import { IOrganization } from './DataAccessLayer/models';
import { Logger } from './utils/Logger';

// Parse command line arguments for server mode
// Mode 0: Development (logs to console)
// Mode 1: Production (logs to file specified in SERVER_LOG_FILE env variable)
export const serverMode = parseInt(process.argv[2] || '0', 10);
if (serverMode !== 0 && serverMode !== 1) {
    console.error('Invalid server mode. Use 0 for dev or 1 for prod.');
    process.exit(1);
}

// Set the server mode in Logger before any logger instances are created
Logger.setServerMode(serverMode);
console.log(`Server starting in ${serverMode === 0 ? 'DEVELOPMENT' : 'PRODUCTION'} mode`);
if (serverMode === 1) {
    console.log(`Production logs will be written to: ${process.env.SERVER_LOG_FILE || 'console (SERVER_LOG_FILE not set)'}`);
}
import { CleanTask, coldKillTask } from './Services/SetupWorkspace';
import { system_prompt_handler } from './socket-handlers/systemPromptHandler';
import { agent_config_handler } from './socket-handlers/agentConfigHandler';
import { knowledge_base_handler } from './socket-handlers/knowledgeBaseHandler';

import { metrics_handler } from './socket-handlers/metrics.handler';
import axios from 'axios';
import { TaskStatus } from './DataAccessLayer/models/Task';
import {LLMMetricsService} from './DataAccessLayer/LLMMetricsService';
import {EC2MetricsService} from './DataAccessLayer/EC2MetricsService';
import {TaskWorkspaceCostService} from './DataAccessLayer/TaskWorkspaceCostService';
import {UserMetricsService} from './DataAccessLayer/UserMetricsService';
import {OrganizationMetricsService} from './DataAccessLayer/OrganizationMetricsService';
import {MetricsAggregationCron} from './Services/MetricsAggregationCron';
import {PayPalService} from './Services/PayPalService';
import { LLMInfo } from './DataAccessLayer/models/ModelInformation';
import { PlanInfo} from './model/Plans';
import {MCPClient} from './MCP_Client';
import { EC2Reaper } from './Services/EC2ReaperService';
import { TaskReaper } from './Services/TaskReaperService';
import { TaskAction, TaskQueueService } from './Services/TaskQueueService';
import { decipherApiKey } from './Services/UserManagmentService';
type Express = express.Express;

interface ClientData {
    socket: Socket;
    connected: Date;
    data?: any;
}

export let is_atlassian_mcp_available = false;
// Main server variables
const PORT: number = parseInt(process.env.PORT || '4001', 10);

// Logger instance - mode is already set above
let logger = new Logger("Socket-server");
let io: Server;
let httpServer: ReturnType<typeof createServer>;
let connectedClients: Map<string, ClientData> = new Map();
let connectedClientsArray: Socket[] = [];


/*
* Initialize socket server code
*/


async function initialize() {
   
   //starting the cron job for aggregating the cost metrics.
    let metricsCron = new MetricsAggregationCron();
   // metricsCron.triggerManual(new Date(new Date().setDate(new Date().getDate() - 1)),new Date());
    // metricsCron.start();

    
    let EC2ReaperCron = new EC2Reaper();
   //EC2ReaperCron.start(); //

    // Initialize TaskReaper for cleaning up non-running tasks
    let taskReaperCron = new TaskReaper();
  // taskReaperCron.start();

  //  await temporaryStuff();

    // for initializing many things
    let ec2Service = new EC2Service();

    // Load Task EC2 instances
    let taskInstances = await ec2Service.listInstances({
        state: ['running'],
        tags: [{
            key: 'Name',
            value: 'DevInstance'
        }]
    }) as Ec2Details[];
    // Push each instance to the heap (heap maintains order automatically)
    taskInstances.forEach(instance => {
        FreeEc2Pool.push(instance);
        ds.Ec2Id_Map.set(instance.instanceId, instance); // setting both the things
    });


    console.log(`Loaded ${taskInstances.length} Task EC2 instances into heap pool`);

    // Load Indexer EC2 instances
    let indexerInstances = await ec2Service.listInstances({
        state: ['running'],
        tags: [{
            key: 'Name',
            value: 'IndexerInstance'
        }]
    }) as Ec2Details[];
    // Push each instance to the heap (heap maintains order automatically)
    indexerInstances.forEach(instance => {
        ds.Ec2Id_Map.set(instance.instanceId, instance);
        FreeIndexerEc2Pool.push(instance)
    });
    console.log(`Loaded ${indexerInstances.length} Indexer EC2 instances into heap pool`);

    //bringing organization_githubOrg data in memory from the memory

    let dbConnection = db.getDBService();
    let org = (await dbConnection).getRepository<IOrganization>(process.env.ORGANIZATION_DB, process.env.ORGANIZATION_COLLECTION);
    let orgData: IOrganization[] = await org.find();

    for (let i of orgData) {
        let githubData: GithubAppInstallationDetails = {
            githubOrganizationName: i.metadata?.github?.githubOrganizationName,
            appId: i.metadata?.github?.app_id,
            installationId: i.metadata?.github?.installationId as number
        };

        Organization_AppInstallation.set(i.OrganizationName, githubData);
    }
    let planHandler = (await dbConnection).getRepository<PlanInfo>('General','PlanConstraints');
    let planInfo = await planHandler.find();
    // Convert array of plan documents to Record<string, any> with planId as key
    const planMap = planInfo.reduce((acc, plan) => {
        acc[plan.planId] = plan;
        return acc;
    }, {} as Record<string, any>);
    // Mutate the existing exported object instead of reassigning a readonly binding
    if (typeof ds.PlanInfo === 'object' && ds.PlanInfo !== null) {
        Object.keys(ds.PlanInfo).forEach(k => delete (ds.PlanInfo as any)[k]);
        Object.assign(ds.PlanInfo as any, planMap);
    } else {
        (ds as any).PlanInfo = planMap;
    }
    
    console.log(`Loaded ${planInfo.length} plan configurations from database`);
    console.log('Available plans:', Object.keys(ds.PlanInfo).join(', '));
    try {
        //checking if jira atlassian server exists
        const resp = await axios.get(`${process.env.MCP_ATLASSIAN_BASE_URL}/health`);
        if (resp?.status === 200) {
            logger.info("Jira MCP server is available");
            is_atlassian_mcp_available = true;
        }
    }

    
    catch(ex)
    {
        logger.error("Jira MCP server threw the error=>",ex);
    }
//     //aggregating the data
//     let dbService =await db.getDBService();
//    await dbService.dropCollection('ai_playgrounds','EC2_Metrics_Aggregation');
//     await dbService.dropCollection('ai_playgrounds','EC2_Metrics');
//     await dbService.dropCollection('ai_playgrounds','LLM_Metrics');
//     await dbService.dropCollection('ai_playgrounds','Task_Workspace_Cost_Aggregation');
//     await dbService.dropCollection('ai_playgronds','LLM_Metrics_Aggregation');
//     await dbService.dropCollection('ai_playgrounds','User_Metrics_Aggregation');
//     await dbService.dropCollection('ai_playgrounds','Organization_Metrics_Aggregation');
//     let startDate = new Date(new Date().setDate(new Date().getDate() - 3));
//     let endDate = new Date();

//     metricsCron.triggerManual(startDate,endDate);

//     let LLMAggregation = new LLMMetricsService('ai_playgrounds');
//     await LLMAggregation.aggregateAndSave(startDate,endDate);

//     let EC2Aggregation =  new EC2MetricsService('ai_playgrounds');
//     await EC2Aggregation.aggregateAndSave(startDate,endDate);
    
//     //aggregating for the task and workspace costs.
//     let TaskWpAggregation = new TaskWorkspaceCostService('ai_playgrounds');
//     await TaskWpAggregation.aggregateAndSave(startDate,endDate);

//     let userCostAggregation = new UserMetricsService('ai_playgrounds');
//     await userCostAggregation.aggregateAndSave(startDate,endDate);

//     let orgCostAggregation =  new OrganizationMetricsService('ai_playgrounds');
//     await orgCostAggregation.aggregateAndSave(startDate,endDate);
    
    


}



// Initialize express and create the HTTP server
console.log('Initializing socket server...');
const app: Express = express.default();

let corsOptions = {
    origin: [
        (process.env.APP_URL || '').replace(/\/$/, '').trim(),
        'https://www.oppie.in',
    ].filter((o) => o.length > 0),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Set-Cookie']
}
app.use(cors.default(corsOptions));
app.use(express.json());

app.use(cookieParser());
// GitHub OAuth routes — only mounted when ENABLE_GITHUB_LOGIN=true
if (process.env.ENABLE_GITHUB_LOGIN === 'true') {
    app.use('/api/auth/github', githubroutes);
} else {
    app.use('/api/auth/github', (_req: any, res: any) => {
        res.status(403).json({ success: false, error: 'GitHub login is disabled on this server.' });
    });
}
app.use('/api/auth/atlassian', atlassianRoutes);
app.use('/api/auth/mcp', mcpOAuthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/paypal', require('./routes/paypal.routes').default);
app.use('/api/razorpay', require('./routes/razorpay.routes').default);
app.use('/api/docs', docsRoutes);
app.use('/api/blogs', blogsRoutes);
app.use('/api/terminal', terminalRoutes);

app.use(authenticateJWT as any);
// All routes defined below this line will be protected

// Create HTTP and Socket.IO servers
httpServer = createServer(app);
io = new Server(httpServer, {
    cors: corsOptions,
    // Increase timeouts for development/debugging
    pingTimeout: 120000,        // 2 minutes - how long to wait for pong response
    pingInterval: 60000,        // 1 minute - how often to send ping
    connectTimeout: 120000,     // 2 minutes - connection timeout
    // For production, you might want lower values:
    // pingTimeout: 60000,      // 1 minute
    // pingInterval: 25000,     // 25 seconds (default)
    // connectTimeout: 45000,   // 45 seconds (default)
});

// Initialize connection to file server

// Handle WebSocket upgrades for terminal proxy (required for ttyd)
httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    
    if (process.env.TERMINAL_PROXY_URL && !url.startsWith(process.env.TERMINAL_PROXY_URL)) {
        console.error("Terminal proxy URL is not starting with the correct URL");
        console.log("Terminal proxy URL is:", process.env.TERMINAL_PROXY_URL);
        console.log("URL is:", url);
        return; 
    }

    try {
        const baseUrl = process.env.APP_URL || process.env.BASE_URL || 
                       (req.headers.host ? `http://${req.headers.host}` : 'http://localhost');
        
        const parsedUrl = new URL(url, baseUrl);
        const taskId = parsedUrl.searchParams.get('id');
        
        if (!taskId) {
           // console.error('Terminal WebSocket upgrade failed: No task ID provided');
            socket.destroy();
            return;
        }

        const taskData = ds.taskId_task.get(taskId);
        
        if (!taskData || !taskData.userDockerTerminalUrl) {
            console.error(`Terminal WebSocket upgrade failed: Task ${taskId} not found or no terminal URL`);
            socket.destroy();
            return;
        }
        req.url = '/ws';
        terminalProxy.ws(req, socket, head, { 
            target: taskData.userDockerTerminalUrl 
        });
    } catch (error) {
        console.error('Error handling terminal WebSocket upgrade:', error);
        socket.destroy();
    }
});

// Apply socket authentication middleware
io.use(socketAuthMiddleware);

// ── Tool-server namespace ──────────────────────────────────────────────────
// Tool server clients (running on user machines) connect here using an API key.
// They are completely separate from the UI clients above and use their own
// auth middleware. Each connection registers itself in ToolServerClientManager
// keyed by the id it sends in handshake auth.
const toolServerNamespace = io.of('/tool-server');
//toolServerNamespace.use(toolServerAuthMiddleware as any);
toolServerNamespace.on('connection', (socket: Socket) => {
    const id: any = socket.handshake.query.id;  // this id will be the task id given by the client given to it by the process which started it.
    console.log(`[ToolServer] Client connected — id: ${id}, socket: ${socket.id}`);
    toolServerClientManager.registerClient(id, socket);

    socket.on('disconnect', (reason) => {
        console.log(`[ToolServer] Client disconnected — id: ${id}, reason: ${reason}`);
        toolServerClientManager.removeClient(id);
    });
});
// ──────────────────────────────────────────────────────────────────────────

// ── File-server namespace ─────────────────────────────────────────────────
// File servers (running on EC2 instances) connect here using an API key.
// They identify themselves via handshake query `id` (taskId or wpId).
// Once connected they are registered in FileServerClientManager so that
// file-server.handler.ts can emit requests to them and receive responses.
const fileServerNamespace = io.of('/file-server');
//fileServerNamespace.use(fileServerAuthMiddleware as any);
fileServerNamespace.on('connection', (socket: Socket) => {
    const id: string = socket.handshake.query.id as string;
    console.log(`[FileServer] Client connected — id: ${id}, socket: ${socket.id}`);
    fileServerClientManager.registerClient(id, socket);

    socket.on('disconnect', (reason) => {
        console.log(`[FileServer] Client disconnected — id: ${id}, reason: ${reason}`);
        fileServerClientManager.removeClient(id);
    });
});
// ──────────────────────────────────────────────────────────────────────────

// ── Controller namespace ─────────────────────────────────────────────────u──
// PhantomX_Controller clients (running on local Windows/WSL machines) connect
// here. They identify themselves via handshake query `id` (CONTROLLER_ID).
// The server can later emit commands (e.g. run_local_task_setup) to them.
const controllerNamespace = io.of('/controller');
controllerNamespace.on('connection', async (socket: Socket) => {
     const id: string = socket.handshake.query.id as string;
    console.log(`[Controller] Client connected — id: ${id}, socket: ${socket.id}`);

   
        // the user is valid then set it
        ds.userId_orchestratorSocket.set(id,socket); // setting the socket for connecting it to later.
    
    
    socket.on('disconnect', (reason) => {
        console.log(`[Controller] Client disconnected — id: ${id}, reason: ${reason}`);
    });
});
// ───── ─ ─ ─ ─ ─ ─ ───── ─ ─ ─ ─ ───── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ── ──────── ─ ─ ─ ─ ─ ───── ─ ─ ─ ─ ─ ─ ─ ─ ───────────


// Set up socket connection handling
io.on('connection', async (socket: Socket) => {
    console.log('Client connected:', socket.id);
    connectedClientsArray.push(socket);
    // Store the socket connection  
    connectedClients.set(socket.id, {
        socket: socket,
        connected: new Date()
    });

    const userId = socket.data.user.userId;

    UserName_Socket.set(socket.data.user.userName, socket);
socket.join(userId);

    // Track multiple sockets per user
    if (!userId_sockets.has(userId)) {
        userId_sockets.set(userId, []);
    }
    const userSockets = userId_sockets.get(userId);
    if (userSockets && !userSockets.find(s => s.id === socket.id)) {
        userSockets.push(socket);
        console.log(`Added socket to userId_sockets. User ${userId} now has ${userSockets.length} socket(s)`);
    }

    // Monitor ping/pong for debugging
    socket.on('ping', () => {
        console.log(`[${socket.id}] Ping received from client`);
    });

    socket.on('pong', (latency: number) => {
        console.log(`[${socket.id}] Pong received - Latency: ${latency}ms`);
    });

    // Send custom heartbeat for very long operations
    const heartbeatInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('server_heartbeat', { timestamp: Date.now() });
        }
    }, 30000); // Every 30 secondsp

    // Store interval for cleanup
    (socket as any).heartbeatInterval = heartbeatInterval;


    // Handle socket disconnection
    socket.on('disconnect', async (reason) => {

        let taskId = socket.data.user.taskId; // storing it.


        socket.leave(userId);
        console.log('Client disconnected:', socket.id, 'Reason:', reason);

        // Clear heartbeat interval
        if ((socket as any).heartbeatInterval) {
            clearInterval((socket as any).heartbeatInterval);
        }
        ds.PendingWorkspaces.delete(socket);
        let taskData = ds.taskId_task.get(socket.data.user.taskId);
        if (taskData && (taskData.status === TaskStatus.Running || taskData.status === TaskStatus.Starting)) {
            // cold killing the task
            await coldKillTask(socket,taskId); // we have added the the taskId in PendingTaskDeletions here

        }
         else if (taskData && taskData.status !== TaskStatus.Running && taskData.socketId === socket.id) { // this third condition is to check if the socket which is getting disconnected really owns that task or no
            TaskQueueService.enqueue(taskData.taskId, { socket, data: taskData, action: TaskAction.Kill, callback: () => {} });
        }
        let sockets = ds.userId_sockets.get(socket.data.user.userId);
        sockets = sockets?.filter(sock => sock != socket);
        ds.userId_sockets.set(socket.data.user.userId, sockets as any);


        console.log('=== Cleanup completed for disconnected socket ===');
    });

    file_server_handler(io, socket, connectedClients);
    initialSetup_handler(io, socket, connectedClients);
    user_details_handler(io, socket, connectedClients);
    org_details_handler(io, socket);
    invite_mail_handler(io, socket);
    group_handler(io, socket);
    secret_manager_handler(io, socket);
    github_handler(io, socket);
    atlassian_handler(io, socket);
    mcp_integrations_handler(io, socket);
    workspace_handler(io, socket);
    task_handler(io, socket);
    paypal_handler(io, socket);
    razorpay_handler(io, socket);
    system_prompt_handler(io, socket)
    agent_config_handler(io, socket);
    knowledge_base_handler(io, socket);

    metrics_handler(io, socket);
});

export function getConnectedClient(): Socket {
    //  console.log("Connected clients array", connectedClientsArray.length);
    return connectedClientsArray[0];
}

initialize().then(() => {
    httpServer.listen(PORT, () => {
        console.log(`Socket.IO server running on port ${PORT}`);

        // Initialize Smee client for PayPal webhook forwarding after server starts
        const localPaypalWebhookUrl = `http://localhost:${PORT}/api/paypal/webhook`;
        paypalWebhookService.initializeSmee(localPaypalWebhookUrl);

        // Initialize Smee client for Razorpay webhook forwarding after server starts
        const localRazorpayWebhookUrl = `http://localhost:${PORT}/api/razorpay/webhook`;
        razorpayWebhookService.initializeSmee(localRazorpayWebhookUrl);

        // Initialize Smee client for Atlassian webhook forwarding (TEMPORARY - for local development)
        try {
            const atlassianSmeeSource = process.env.ATLASSIAN_SMEE_SOURCE?.trim();
            if (atlassianSmeeSource) {
                const SmeeClient = require('smee-client');
                const atlassianSmeeTarget = `http://localhost:${PORT}/api/auth/atlassian/webhook`;
                const atlassianSmee = new SmeeClient({
                    source: atlassianSmeeSource,
                    target: atlassianSmeeTarget,
                    logger: console
                });
                atlassianSmee.start();
                logger.info('[Smee Client] Atlassian webhook tunnel initialized', {
                    source: atlassianSmeeSource,
                    target: atlassianSmeeTarget
                });
            } else {
                logger.info('[Smee Client] ATLASSIAN_SMEE_SOURCE not configured; skipping Atlassian Smee initialization');
            }
        } catch (error: any) {
            logger.warn('[Smee Client] Failed to initialize Atlassian Smee client', {
                error: error?.message || 'smee-client package may not be installed'
            });
        }
    });
});

// Start the server


// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down socket server...');
    paypalWebhookService.stopSmee();
    razorpayWebhookService.stopSmee();

    io.close(() => {
        console.log('Socket.IO server closed');
        httpServer.close(() => {
            console.log('HTTP server closed');
            process.exit(0);
        });
    });
});

// Export server instances for potential programmatic usage
export { io, httpServer };
