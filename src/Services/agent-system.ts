// Converted from agent-system.js to TypeScript

// Maximum allowed image dimension in pixels for Bedrock API
const MAX_IMAGE_DIMENSION = 8000;

/**
 * Get image dimensions from base64 PNG data
 * Returns { width, height } or null if unable to parse4
 */
function getImageDimensionsFromBase64(base64Data: string): { width: number; height: number } | null {
    try {
        // Remove data URL prefix if present
        let cleanBase64 = base64Data;
        if (base64Data.startsWith('data:')) {
            const match = base64Data.match(/^data:[^;]+;base64,(.+)$/);
            if (match) {
                cleanBase64 = match[1];
            }
        }

        // Decode base64 to buffer
        const buffer = Buffer.from(cleanBase64, 'base64');

        // Check for PNG signature (89 50 4E 47 0D 0A 1A 0A)
        if (buffer.length >= 24 &&
            buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
            buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
            // PNG format - dimensions are in the IHDR chunk
            // IHDR chunk starts at byte 8 (after signature)
            // Format: length (4 bytes) + 'IHDR' (4 bytes) + width (4 bytes) + height (4 bytes)
            const width = buffer.readUInt32BE(16);
            const height = buffer.readUInt32BE(20);
            return { width, height };
        }

        // Check for JPEG signature (FF D8 FF)
        if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
            // JPEG format - need to parse through segments to find SOF marker
            let offset = 2;
            while (offset < buffer.length - 1) {
                if (buffer[offset] !== 0xFF) {
                    offset++;
                    continue;
                }
                const marker = buffer[offset + 1];
                // SOF markers: 0xC0-0xCF except 0xC4, 0xC8, 0xCC
                if ((marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    // Found SOF marker
                    // Format: FF marker length(2) precision(1) height(2) width(2)
                    if (offset + 9 <= buffer.length) {
                        const height = buffer.readUInt16BE(offset + 5);
                        const width = buffer.readUInt16BE(offset + 7);
                        return { width, height };
                    }
                }
                // Skip to next segment
                if (offset + 3 < buffer.length) {
                    const segmentLength = buffer.readUInt16BE(offset + 2);
                    offset += 2 + segmentLength;
                } else {
                    break;
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error parsing image dimensions:', error);
        return null;
    }
}

/**
 * Check if image dimensions exceed the maximum allowed size
 * Returns an error message if exceeded, null if within limits or unable to determine
 */
function checkImageDimensionLimit(base64Data: string): string | null {
    const dimensions = getImageDimensionsFromBase64(base64Data);
    if (dimensions) {
        if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
            return `Image dimensions (${dimensions.width}x${dimensions.height}) exceed the maximum allowed size of ${MAX_IMAGE_DIMENSION} pixels. The page is too large for a full-page screenshot. Please take the screenshot in smaller pieces by setting fullPage to false, or take screenshots of specific elements instead.`;
        }
    }
    return null;
}

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { LLMService, ModelResponse, ProviderType } from './providers';

import { sendEditToolRequest, sendReadFileRequest } from '../Implementation/Tool_Server';
import { ConversationSummarizer } from './conversation-summarizer';
import { AdaptiveCompressor, AgentState } from './adaptive-compressor';
import { ChatHistoryS3Service } from './ChatHistoryS3Service';
import { chromium } from 'playwright';
import { MCPClient } from '../MCP_Client'
import { startDockerContainer, getDockerContainerStatus } from './docker-tools';
import { getConnectedClient, io } from '../socket-server';
import { serverMode } from '../socket-server';
import { Socket } from 'socket.io'

// Feature flags for chat history storage
// SAVE_HISTORY_TO_S3: if 'true', conversation history is saved to and loaded from AWS S3
// SAVE_HISTORY_TO_LOCAL: if 'true', conversation history is saved to local chat-history folder
// If both are true: history is saved to both; S3 is always the source of truth for loading
// If only LOCAL is true: history is saved to and loaded from local folder only
const SAVE_HISTORY_TO_S3: boolean = process.env.SAVE_HISTORY_TO_S3 !== 'false';
const SAVE_HISTORY_TO_LOCAL: boolean = process.env.SAVE_HISTORY_TO_LOCAL === 'true';
const pl = require('./prompt_library');
const SSHClient = require('./ssh-client');

import { promises as fs } from 'fs';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { ChromaManager } from '../Implementation/ChromaManager';
import { Operations } from '../classes/OperationsEnum';
import * as dotenv from 'dotenv';
dotenv.config();
import * as ds from '../DataStructures';
import { createLogger } from '../utils/Logger';
import { mcpOrchestrator } from './mcp/McpOrchestratorService';
const logger = createLogger('AgentSystem');
import { LLMMetricsService } from '../DataAccessLayer/LLMMetricsService';
import { GithubOperationsService } from './GithubOperationsService';
import { getModelInfo } from './ModelInfoService';
import { available_models } from '../DataAccessLayer/models/ModelInformation';
import * as ModelInfo from './../DataAccessLayer/models/ModelInformation'
class LinuxCommandTool {
    ssh: any;
    constructor(ssh: any) {
        this.ssh = ssh;
    }
    async execute(command: string): Promise<any> {
        return await this.ssh.executeCommand(command);
    }
    async executeHostCommand(command: string): Promise<any> {
        return await this.ssh.executeHostCommand(command);
    }
}

import { spawn } from 'child_process';
import { Readable } from 'stream';
import { SSHClientCombined } from './ssh-client-combined';
import { getDBService } from '../DataAccessLayer/db-connection';
import { IOrganization } from '../DataAccessLayer/models';
import { error, log, timeStamp } from 'console';
import { CountTokensCommand } from '@aws-sdk/client-bedrock-runtime';
import { v4 as uuidv4 } from 'uuid';
import { TaskStatus } from '../DataAccessLayer/models/Task';
import { AgentTypeEnum } from '../classes/AgentTypeEnum';
import { AccessRights } from '../classes/ModelAccessRights';
import { countConversationTokens } from '../utils/TokenCounter';
import { RemoteToolExecutionService } from './remoteToolExecutionService';
import { toolServerClientManager } from './ToolServerClientManager';

interface WSLExecOptions {
    distro?: string;
    cwd?: string;
    stdinStream?: Readable;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
}

export class LocalWSLClient {
    private wslDistro: string;
    private wslDir: string;
    private backgroundProcesses: Record<number, any>;
    private nextProcessId: number;

    constructor(wslDistro = '', wslDir = '/mnt/') {
        this.wslDistro = wslDistro;
        this.wslDir = this.windowsToWslPath(wslDir);
        this.backgroundProcesses = {};
        this.nextProcessId = 1;
    }

    private windowsToWslPath(winPath: string): string {
        if (!winPath) return '/mnt/';
        if (winPath.startsWith('/mnt/')) return winPath;
        winPath = winPath.replace(/^"|"$/g, '');
        let pathPart = winPath.replace(/\\/g, '/');
        const match = pathPart.match(/^([a-zA-Z]):(.*)/);
        if (match) {
            const drive = match[1].toLowerCase();
            const rest = match[2].replace(/^\//, '');
            return `/mnt/${drive}/${rest}`;
        }
        return pathPart;
    }

    async connect(): Promise<boolean> {
        return true;
    }

    async disconnect(): Promise<boolean> {
        // Terminate all background processes
        for (const id of Object.keys(this.backgroundProcesses)) {
            const processInfo = this.backgroundProcesses[parseInt(id)];
            const processId = parseInt(id, 10);

            // Try to terminate the process if it's still running
            if (processInfo.status === 'running' && processInfo.pid) {
                try {
                    // Use a synchronous approach for cleanup during disconnect
                    await this.execWSL(`pkill -P ${processInfo.pid} || true; kill -9 ${processInfo.pid} || true`);

                    // Clean up the log file
                    await this.execWSL(`rm -f /tmp/bg-process-${processId}.log || true`);
                } catch (err) {
                    // Ignore errors during cleanup
                }
            } else {
                // Even if the process is not running, clean up its log file
                try {
                    await this.execWSL(`rm -f /tmp/bg-process-${processId}.log || true`);
                } catch (err) {
                    // Ignore errors during cleanup
                }
            }
        }

        return true;
    }

    /**
     * Execute a command in the background, allowing other commands to be executed in parallel
     * @param {string} command - The command to execute
     * @param {object} socket - Optional socket for real-time output
     * @param {string} processName - Optional name for the process (for easier reference)
     * @returns {Promise<object>} - Object containing process ID and initial status
     */
    async executeBackgroundCommand(command: string, socket: any = null, processName: string = ''): Promise<any> {
        return new Promise(async (resolve, reject) => {
            try {
                const processId = this.nextProcessId++;
                const processInfo = {
                    id: processId,
                    name: processName || `process-${processId}`,
                    command,
                    startTime: new Date(),
                    status: 'starting',
                    output: '',
                    errorOutput: '',
                    exitCode: null,
                    socket,
                    pid: null as number | null
                };

                // Store the process info
                this.backgroundProcesses[processId] = processInfo;

                // First ensure /tmp directory exists and has proper permissions
                await this.execWSL('sudo chmod 777 /tmp');

                // If folder path is specified, prepend cd command
                const fullCommand = this.wslDir
                    ? `cd "${this.wslDir}" 2>/dev/null && ${command}`
                    : command;

                // Create log file path
                const logFilePath = `/tmp/bg-process-${processId}.log`;

                // Create the log file with proper permissions before running the command
                await this.execWSL(`sudo touch ${logFilePath} && sudo chmod 666 ${logFilePath}`);

                // Use nohup to ensure the process continues even if the WSL session is terminated
                const backgroundCommand = `nohup bash -c '${fullCommand.replace(/'/g, "'\\''")}' > ${logFilePath} 2>&1 & echo $!`;

                // Execute the background command
                const result = await this.execWSL(backgroundCommand);
                const pidOutput = result.toString().trim();

                if (pidOutput && !isNaN(parseInt(pidOutput))) {
                    // Successfully started the background process
                    processInfo.pid = parseInt(pidOutput, 10);
                    processInfo.status = 'running';

                    // Verify the log file was created
                    const logFileCheck = await this.execWSL(`test -f ${logFilePath} && echo 'exists' || echo 'missing'`);
                    const logFileExists = logFileCheck.toString().trim() === 'exists';

                    if (!logFileExists) {
                        // If log file doesn't exist, try to create it again with sudo
                        await this.execWSL(`sudo touch ${logFilePath} && sudo chmod 666 ${logFilePath}`);
                    }

                    resolve({
                        success: true,
                        processId,
                        pid: processInfo.pid,
                        name: processInfo.name,
                        message: `Background process started with PID ${processInfo.pid}`,
                        logFile: logFilePath,
                        logFileCreated: logFileExists
                    });
                } else {
                    processInfo.status = 'error';
                    processInfo.errorOutput = 'Failed to get PID of background process';

                    resolve({
                        success: false,
                        processId,
                        error: processInfo.errorOutput,
                        output: pidOutput || ''
                    });
                }
            } catch (err: unknown) {
                reject(new Error(`Failed to start background process: ${err instanceof Error ? err.message : String(err)}`));
            }
        });
    }

    /**
     * Check if a background process is still running
     * @param {number} processId - The ID of the process to check
     * @returns {Promise<boolean>} - True if the process is running, false otherwise
     */
    async _checkProcessStatus(processId: number): Promise<boolean> {
        return new Promise(async (resolve) => {
            try {
                const processInfo = this.backgroundProcesses[processId];
                if (!processInfo || !processInfo.pid) {
                    resolve(false);
                    return;
                }

                const result = await this.execWSL(`ps -p ${processInfo.pid} > /dev/null && echo "running" || echo "terminated"`);
                const resultStr = result.toString().trim();
                const isRunning = resultStr === 'running';

                if (!isRunning && processInfo.status === 'running') {
                    processInfo.status = 'completed';
                }

                resolve(isRunning);
            } catch (err: unknown) {
                resolve(false);
            }
        });
    }

    /**
     * Terminate a background process
     * @param {number} processId - The ID of the process to terminate
     * @returns {Promise<object>} - Result of the termination attempt
     */
    async terminateBackgroundProcess(processId: number): Promise<any> {
        return new Promise(async (resolve) => {
            try {
                const processInfo = this.backgroundProcesses[processId];
                if (!processInfo || !processInfo.pid) {
                    resolve({
                        success: false,
                        message: `Process with ID ${processId} not found or has no PID`
                    });
                    return;
                }

                // First check if the process is still running
                const isRunning = await this._checkProcessStatus(processId);
                if (!isRunning) {
                    // Process is already terminated, but we still need to clean up the log file
                    const cleanupResult = await this.cleanupBackgroundProcessLog(processId);
                    resolve({
                        success: true,
                        message: `Process ${processId} is already terminated`,
                        logCleanup: cleanupResult
                    });
                    return;
                }

                // Kill the process and its children
                await this.execWSL(`pkill -P ${processInfo.pid} || true; kill ${processInfo.pid} || true`);

                // Verify the process was terminated
                setTimeout(async () => {
                    const stillRunning = await this._checkProcessStatus(processId);
                    if (stillRunning) {
                        // Try a more forceful termination
                        await this.execWSL(`pkill -9 -P ${processInfo.pid} || true; kill -9 ${processInfo.pid} || true`);
                        processInfo.status = 'terminated';

                        // Clean up the log file
                        const cleanupResult = await this.cleanupBackgroundProcessLog(processId);
                        resolve({
                            success: true,
                            message: `Process ${processId} forcefully terminated`,
                            logCleanup: cleanupResult
                        });
                    } else {
                        processInfo.status = 'terminated';

                        // Clean up the log file
                        const cleanupResult = await this.cleanupBackgroundProcessLog(processId);
                        resolve({
                            success: true,
                            message: `Process ${processId} terminated successfully`,
                            logCleanup: cleanupResult
                        });
                    }
                }, 500); // Wait a bit for the process to terminate
            } catch (err: unknown) {
                resolve({
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                    message: `Failed to terminate process ${processId}`
                });
            }
        });
    }

    /**
     * Get information about all background processes
     * @returns {object} - Object containing information about all background processes
     */
    getBackgroundProcesses(): Record<string, any> {
        const processes: Record<string, any> = {};

        // Create a simplified version of the process info for each process
        Object.keys(this.backgroundProcesses).forEach(id => {
            const process = this.backgroundProcesses[parseInt(id)];
            processes[id] = {
                id: parseInt(id, 10),
                name: process.name,
                command: process.command,
                pid: process.pid,
                status: process.status,
                startTime: process.startTime,
                outputLength: process.output ? process.output.length : 0,
                errorOutputLength: process.errorOutput ? process.errorOutput.length : 0
            };
        });

        return processes;
    }

    /**
     * Clean up the log file for a background process
     * @param {number} processId - The ID of the process
     * @returns {Promise<object>} - Promise resolving to the result of the cleanup operation
     */
    async cleanupBackgroundProcessLog(processId: number): Promise<any> {
        return new Promise(async (resolve) => {
            try {
                const processInfo = this.backgroundProcesses[processId];
                if (!processInfo) {
                    resolve({
                        success: false,
                        message: `Process with ID ${processId} not found`
                    });
                    return;
                }

                const logFilePath = `/tmp/bg-process-${processId}.log`;

                // Check if the log file exists and delete it with sudo if needed
                const result = await this.execWSL(`if [ -f "${logFilePath}" ]; then rm "${logFilePath}" 2>/dev/null || sudo rm "${logFilePath}" && echo "Log file deleted" || echo "Failed to delete log file"; else echo "Log file not found"; fi`);
                const output = result.toString().trim();

                if (output === 'Log file deleted') {
                    resolve({
                        success: true,
                        id: processId,
                        name: processInfo.name,
                        message: `Log file for process ${processId} deleted successfully`
                    });
                } else if (output === 'Log file not found') {
                    resolve({
                        success: true,
                        id: processId,
                        name: processInfo.name,
                        message: `Log file for process ${processId} not found`
                    });
                } else {
                    resolve({
                        success: false,
                        id: processId,
                        name: processInfo.name,
                        message: `Failed to delete log file for process ${processId}: ${output}`
                    });
                }
            } catch (err: unknown) {
                resolve({
                    success: false,
                    id: processId,
                    name: this.backgroundProcesses[processId]?.name || `process-${processId}`,
                    error: err instanceof Error ? err.message : String(err),
                    message: `Error while trying to delete log file for process ${processId}`
                });
            }
        });
    }

    /**
     * Get the output of a background process by reading directly from the log file
     * @param {number} processId - The ID of the process
     * @param {number} maxLines - Maximum number of lines to retrieve (0 for all lines)
     * @param {boolean} tailMode - If true, get the last maxLines, otherwise get from the beginning
     * @returns {Promise<object>} - Promise resolving to an object containing the process output and status
     */
    async getBackgroundProcessOutput(processId: number, maxLines: number = 0, tailMode: boolean = true): Promise<any> {
        return new Promise(async (resolve) => {
            try {
                const processInfo = this.backgroundProcesses[processId];
                if (!processInfo) {
                    resolve({
                        success: false,
                        message: `Process with ID ${processId} not found`
                    });
                    return;
                }

                // Check if the log file exists
                const logFilePath = `/tmp/bg-process-${processId}.log`;

                // First check if the log file exists, if not try to create it with proper permissions
                const fileExistsCheck = await this.execWSL(`test -f "${logFilePath}" && echo "exists" || echo "missing"`);
                if (fileExistsCheck.toString().trim() === 'missing') {
                    // Try to create the log file if it doesn't exist
                    await this.execWSL(`sudo touch "${logFilePath}" && sudo chmod 666 "${logFilePath}"`);
                }

                // Construct the command to read the log file
                let readCommand;
                if (maxLines > 0) {
                    // If maxLines is specified, use head or tail based on tailMode
                    readCommand = tailMode
                        ? `tail -n ${maxLines} ${logFilePath}`
                        : `head -n ${maxLines} ${logFilePath}`;
                } else {
                    // If maxLines is 0 or not specified, read the entire file
                    readCommand = `cat ${logFilePath}`;
                }

                // Execute the command to read the log file
                const result = await this.execWSL(`if [ -f "${logFilePath}" ]; then ${readCommand}; else echo "Log file not found"; fi`);
                const output = result.toString();

                // Check if the process is still running
                const isRunning = await this._checkProcessStatus(processId);

                // Update the status if needed
                if (isRunning && processInfo.status !== 'running') {
                    processInfo.status = 'running';
                } else if (!isRunning && processInfo.status === 'running') {
                    processInfo.status = 'completed';
                }

                resolve({
                    success: true,
                    id: processId,
                    name: processInfo.name,
                    command: processInfo.command,
                    pid: processInfo.pid,
                    status: processInfo.status,
                    startTime: processInfo.startTime,
                    output: output,
                    errorOutput: processInfo.errorOutput, // Keep any error output that was captured during startup
                    isLogFileRead: true,
                    maxLines: maxLines,
                    tailMode: tailMode
                });
            } catch (err: unknown) {
                resolve({
                    success: false,
                    id: processId,
                    name: this.backgroundProcesses[processId]?.name || `process-${processId}`,
                    error: err instanceof Error ? err.message : String(err),
                    message: `Failed to read log file for process ${processId}`
                });
            }
        });
    }

    /**
     * Runs any arbitrary bash script in WSL, feeding it via stdin.
     */
    private execWSL(
        script: string,
        opts: WSLExecOptions = {}
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const args: string[] = [];
            if (opts.distro || this.wslDistro) {
                args.push('-d', opts.distro ?? this.wslDistro);
            }
            args.push('bash', '-s', '--');

            const child = spawn('wsl', args);
            let collected = '';
            let stdErr = '';

            child.stdout.on('data', data => {
                if (opts.onStdout) opts.onStdout(data);
                else collected += data.toString();
            });
            child.stderr.on('data', data => {
                stdErr += data.toString();
                if (opts.onStderr) opts.onStderr(data);
            });

            child.on('error', reject);
            child.on('close', code => {
                if (code !== 0) {
                    const msg = `WSL exited with code ${code}` +
                        (stdErr ? `: ${stdErr.trim()}` : '');
                    return reject(new Error(msg));
                }
                if (!opts.onStdout) resolve(collected);
                else resolve('');
            });

            // feed script or stream into bash stdin
            if (opts.stdinStream) {
                opts.stdinStream.pipe(child.stdin);
            } else {
                const header = opts.cwd
                    ? `cd '${opts.cwd}'\n`
                    : `cd '${this.wslDir}'\n`;
                child.stdin.write(header + script);
                child.stdin.end();
            }
        });
    }

    /**
     * Execute any Linux command (single or multi-line) inside WSL.
     */
    async executeCommand(
        command: string
    ): Promise<string> {
        return this.execWSL(command, { cwd: this.wslDir });
    }
}
class LocalCommandTool {
    localClient: any;
    constructor(localClient: any) {
        this.localClient = localClient;
    }
    async execute(command: string): Promise<any> {
        return await this.localClient.executeCommand(command);
    }
}

type ToolResult = { id: string, result: any, type: string }; //here the type can be text, or image

type ToolCall = { id: string, input: any, name?: string };

export class Agent {
    agentId: string; // unqiue identifier for each agent.
    bedrock: BedrockRuntimeClient;

    collectionName: string;
    chromaManager: any;
    mode: number;
    localClient: any;
    linuxTool: any;
    linuxToolHostCommand: any; // to execute the commands on the host machine
    ec2_instance_ip: string;
    sshCombined: any;
    ssh: any;
    conversationHistory: any[];
    previousToolId: string;
    logFileName: string;
    completeConversationHistory: any[]; // Stores complete response with usage data
    completeLogFileName: string; // File name for complete history with usage
    modelName: string;
    modelId: string;
    modelKey: any;

    llmApiKey?: string; // Runtime-only provider key; never persisted or logged.

    isContextWindowFull: boolean = false;
    folderPath: string;
    toolId_toolNameMap: Map<string, string> = new Map<string, string>();
    conversationSummarizer: ConversationSummarizer;
    adaptiveCompressor: AdaptiveCompressor;

    uiLink: string;
    playwrightMcpClient: any;
    tavilyWebSearchMcpClient: any;
    containerName: string;
    taskId: string;
    userId: string;
    conversationHistoryFileName: string; // name for S3 file
    s3HistoryService: ChatHistoryS3Service; // S3 service for saving conversation history
    hasLoadedHistoryFromS3: boolean = false; // flag to track if history has been loaded from S3
    githubInstallationId: number | null; // GitHub App installation ID - set from database
    enableGithubTools: boolean; // flag to enable/disable GitHub tools
    playwrightUrl: string = "";
    operation: Operations;
    githubOperationsService: GithubOperationsService; // GitHub operations service
    isPlaywrightAvailable: boolean = false;
    totalInputTokens: number = 0;
    modelInfo: any;
    isHistoryReset: boolean = false;
    agentConversationHistory: any[] = []; // Separate history for agent only
    isTavilyWebSearchAvailable: boolean = false;
    tokenCounterClaude: any;
    chatSessionId: any; // Unique identifier for the chat session, used for metrics and tracking

    messageQueueArchive: any[] = []; // this will store the history of all the messages that are sent to the agent
    messageQueue: any[] = []; // this will store the messages that are coming, and will be deleted from the queue once the result is ready.
    agentStatus?: TaskStatus;
    abortController?: AbortController;
    parentAgent?: string; //id of the agent

    parentTaskId?: string; // id of the parent task
    currentStatusSummary: string = "idle"; // latest short status text for parent visibility
    currentStatusUpdatedAt?: string;
    currentToolName?: string;
    statusHistory: Array<{ status: string; toolName: string; updatedAt: string }> = [];

    agentType: AgentTypeEnum;
    sharedMemoryPath: any = "";

    isChildTask: boolean = false; //. this is to check if the agent object is of a child task or a parent task

    accessRights: any = []; // this is the list of the tools that should be given to a particular agent.


    constructor(mode: number, folderPath: string, operation: Operations, ec2_instance_ip: string, conversationHistoryName: string, taskId: string, userId: string, agentType: AgentTypeEnum, accessRights: any, isChildTask: boolean, sharedMemoryPath?: string, modelKey?: string, collectionName?: string, modelName?: string, uiLink?: string, enableGithubTools: boolean = true, sessionId?: string, agentId?: string) {
        // Type-safe credentials for BedrockRuntimeClient
        this.isChildTask = isChildTask;
        this.agentType = agentType;
        this.agentId = agentId || uuidv4(); // Generate a unique ID for the agent if not provided
        this.ec2_instance_ip = ec2_instance_ip;
        this.userId = userId;
        this.operation = operation;
        this.sharedMemoryPath = sharedMemoryPath;
        this.chatSessionId = sessionId;
        this.tokenCounterClaude = new BedrockRuntimeClient({ region: "us-east-1" });
        this.modelKey = modelKey;
        this.playwrightUrl = ds.taskId_task.get(taskId)?.playwrightUrl || "";// getting the playwright server url from the task data structure.
        this.accessRights = accessRights;
        this.taskId = taskId; // id of the task for which this agent is spawned.
        logger.info('Agent initialized', { taskId, operation, mode, modelName: modelName || 'claude-sonnet-3.7' });
        this.conversationSummarizer = new ConversationSummarizer('');//it will be using claude 3.5 sonnet
        this.adaptiveCompressor = new AdaptiveCompressor(this.conversationSummarizer);

        this.containerName = path.basename(folderPath);
        this.conversationHistoryFileName = conversationHistoryName;
        this.s3HistoryService = new ChatHistoryS3Service();
        this.enableGithubTools = enableGithubTools;
        this.githubOperationsService = new GithubOperationsService();
        this.githubInstallationId = null; // Will be set from database
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID_AI || '';
        this.playwrightMcpClient = new MCPClient();
        this.tavilyWebSearchMcpClient = new MCPClient();
        const enumKey = Object.entries(available_models).find(([k, v]) => v === modelKey)?.[0];
        this.modelName = enumKey || "Claude_Sonnet_46";
        this.modelId = "";

        // Initialize LLM Service for multi-provider support


        // Initialize UI link for screenshots
        this.uiLink = uiLink || '';

        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY_AI || '';
        this.bedrock = new BedrockRuntimeClient({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId,
                secretAccessKey,
                sessionToken: process.env.AWS_SESSION_TOKEN || undefined
            }
        });
        this.folderPath = folderPath;

        this.collectionName = collectionName || '';

        this.mode = mode || 0;
     
        this.conversationHistory = [];
        this.completeConversationHistory = []; // Initialize complete history
        this.previousToolId = "";
        this.logFileName = `conversation_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        this.completeLogFileName = `conversation_complete_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    }
    async setLLMModel(modelKey: string, apiKey?: string) // this can be an enum display value or a database modelKey
    {
        try {
            this.modelKey = modelKey;
            const enumKey = Object.entries(available_models).find(([, value]) => value === modelKey)?.[0];
            const requestedModelKey = enumKey || modelKey;
            const requestedModelInfo = await getModelInfo(requestedModelKey);

            if (!requestedModelInfo) {
                throw new Error(`Model information was not found for '${modelKey}'`);
            }

            this.modelName = requestedModelKey;
            this.modelInfo = requestedModelInfo;
            this.modelId = requestedModelInfo.modelId;
            this.llmApiKey = requestedModelInfo.providerType === 'openrouter' ? apiKey : undefined;
        }
        catch (ex) {
            logger.error('Error setting LLM model', { modelKey, error: ex instanceof Error ? ex.message : String(ex) });
            throw ex;
        }

    }
    async setChromaDBManager(projectName: string) {
        let taskData = ds.taskId_task.get(this.taskId);
        if (taskData?.chromaDbUrl == null) {
            logger.error('chromadb url is undefined or null');
            throw error("chroma db url is undefined or null");
        }

        this.chromaManager = new ChromaManager(projectName, taskData?.chromaDbUrl || '');
        logger.info('ChromaDB manager configured', { taskId: this.taskId, chromaUrl: taskData?.chromaDbUrl });

    }
    async saveConversationHistory(): Promise<void> {
        try {
            // Save to local filesystem if SAVE_HISTORY_TO_LOCAL flag is enabled
            if (SAVE_HISTORY_TO_LOCAL) {
                const logsDir = path.join(process.cwd(), 'logs');

                // Check if logs directory exists, create it if it doesn't
                if (!existsSync(logsDir)) {
                    mkdirSync(logsDir, { recursive: true });
                    // console.log('Created logs directory:', logsDir);
                }

                const logPath = path.join(logsDir, this.logFileName);

                // Get only the most recent message to append
                const lastMessageIndex = this.conversationHistory.length - 1;
                if (lastMessageIndex >= 0) {
                    const lastMessage = this.conversationHistory[lastMessageIndex];
                    // Check if there was a final_response tool_use before filtering
                    const hadFinalResponseTool = lastMessage.content.some(
                        (item: any) => item.type === "tool_use" && item.name === "final_response"
                    );

                    // Remove final_response tool_use
                    lastMessage.content = lastMessage.content.filter(
                        (item: any) => !(item.type === "tool_use" && item.name === "final_response")
                    );

                    // Only add extra text if:
                    // 1. final_response tool_use existed (first condition ran)
                    // 2. there is no text message
                    if (
                        hadFinalResponseTool &&
                        !lastMessage.content.some((item: any) => item.type === "text")
                    ) {
                        lastMessage.content.push({
                            type: "text",
                            text: "AI gave the final status of the task."
                        });
                    }

                    // Check if file exists to determine if we need to add a comma
                    let dataToAppend = JSON.stringify(lastMessage, null, 2);
                    let fileExists = existsSync(logPath);

                    if (!fileExists) {
                        // If file doesn't exist, create it with an array opening bracket
                        await fs.writeFile(logPath, '[\n' + dataToAppend + '\n]');
                    } else {
                        // If file exists, we need to replace the closing bracket with the new message
                        const fileContent = await fs.readFile(logPath, 'utf8');

                        if (fileContent.trim() === '[') {
                            // File only has opening bracket
                            await fs.appendFile(logPath, dataToAppend + '\n]');
                        } else {
                            // Remove the closing bracket, add comma + new message + closing bracket
                            // First, check if the file ends with ']'
                            if (fileContent.trim().endsWith(']')) {
                                // Remove the last character (']') from the file
                                const contentWithoutClosingBracket = fileContent.slice(0, -1).trimEnd();
                                // Write the updated content back to the file
                                await fs.writeFile(logPath, contentWithoutClosingBracket + ',\n' + dataToAppend + '\n]');
                            } else {
                                // Something is wrong with the file format, append properly
                                console.warn('Log file format is unexpected, appending message with comma');
                                await fs.appendFile(logPath, ',\n' + dataToAppend + '\n]');
                            }
                        }
                    }
                }
            }

            // Save to S3 if SAVE_HISTORY_TO_S3 flag is enabled
            if (SAVE_HISTORY_TO_S3) {
                await this.saveConversationHistoryToS3();
            }
            // Save to local if SAVE_HISTORY_TO_LOCAL flag is enabled
            if (SAVE_HISTORY_TO_LOCAL) {
                await this.saveConversationHistoryToLocal();
            }
            if (this.chatSessionId) {
                ds.temporaryChatData.delete(this.chatSessionId); // deleting the old session Id before getting the history saved.
            }
        } catch (error) {
            console.error('Error saving conversation history:', error);
        }
    }

    async saveConversationHistoryToS3(): Promise<void> {
        try {
            const s3Key = `${this.conversationHistoryFileName}`;

            // Get only the most recent message to append
            const lastMessageIndex = this.conversationHistory.length - 1;
            if (lastMessageIndex < 0) {
                return; // No messages to save
            }

            const lastMessage = this.conversationHistory[lastMessageIndex];

            // Check if file exists in S3
            const fileCheck = await this.s3HistoryService.fileExists(s3Key);

            if (!fileCheck.exists) {
                // File doesn't exist, create new file with array structure
                const initialContent = JSON.stringify([lastMessage], null, 2);
                const result = await this.s3HistoryService.storeFile(
                    s3Key,
                    initialContent,
                    undefined,
                    'application/json'
                );

                if (result.success) {
                    // console.log(`Created new conversation history file in S3: ${s3Key}`);
                } else {
                    console.error(`Failed to create conversation history in S3: ${result.error}`);
                }
            } else {
                // File exists, fetch current content and append new message
                const fileResult = await this.s3HistoryService.getFile(s3Key, undefined, false);

                if (fileResult.success && fileResult.content) {
                    // Parse existing content
                    const existingContent = fileResult.content.toString('utf-8');
                    let conversationArray: any[] = [];

                    if (this.isHistoryReset) {
                        // Skip older history once when reset is requested, then clear the flag
                        this.isHistoryReset = false;
                    } else {
                        try {
                            conversationArray = JSON.parse(existingContent);
                            if (!Array.isArray(conversationArray)) {
                                console.warn('S3 file content is not an array, resetting to new array');
                                conversationArray = [];
                            }
                        } catch (parseError) {
                            console.error('Failed to parse existing S3 content, starting fresh:', parseError);
                            conversationArray = [];
                        }
                    }

                    // Append new message
                    //checking if the last message is same as the last message in the conversation array to avoid duplicates in case of retries or multiple saves.
                    const lastSavedMessage = conversationArray.length > 0 ? conversationArray[conversationArray.length - 1] : null;
                    if (lastSavedMessage && JSON.stringify(lastSavedMessage) === JSON.stringify(lastMessage)) {
                        // console.log('Last message is the same as the last saved message in S3, skipping append to avoid duplicate');
                        return;
                    }
                    conversationArray.push(lastMessage);

                    // Store updated content
                    const updatedContent = JSON.stringify(conversationArray, null, 2);
                    const result = await this.s3HistoryService.storeFile(
                        s3Key,
                        updatedContent,
                        undefined,
                        'application/json'
                    );

                    if (result.success) {
                        // console.log(`Updated conversation history in S3: ${s3Key}`);
                    } else {
                        console.error(`Failed to update conversation history in S3: ${result.error}`);
                    }
                } else {
                    console.error(`Failed to retrieve existing conversation history from S3: ${fileResult.error}`);
                }
            }
        } catch (error) {
            console.error('Error saving conversation history to S3:', error);
        }
    }

    async loadConversationHistoryFromS3(): Promise<void> {
        try {
            const s3Key = `${this.conversationHistoryFileName}`;

            logger.info("getting chat history having the id=>", s3Key);
            // Check if file exists in S3
            const fileCheck = await this.s3HistoryService.fileExists(s3Key);

            if (!fileCheck.exists) {
                // console.log(`No existing conversation history found in S3: ${s3Key}`);
                return; // No history to load
            }

            // Fetch the conversation history from S3
            const fileResult = await this.s3HistoryService.getFile(s3Key, undefined, false);

            if (fileResult.success && fileResult.content) {
                const existingContent = fileResult.content.toString('utf-8');
                let conversationArray: any[] = [];

                try {
                    conversationArray = JSON.parse(existingContent);
                    if (!Array.isArray(conversationArray)) {
                        console.warn('S3 file content is not an array, skipping history load');
                        return;
                    }
                } catch (parseError) {
                    console.error('Failed to parse S3 conversation history:', parseError);
                    return;
                }

                // Prepend the loaded history to the beginning of conversationHistory
                if (conversationArray.length > 0) {
                    this.conversationHistory = [...conversationArray, ...this.conversationHistory];
                    // console.log(`Loaded ${conversationArray.length} messages from S3 conversation history`);
                }
            } else {
                console.error(`Failed to retrieve conversation history from S3: ${fileResult.error}`);
            }
        } catch (error) {
            console.error('Error loading conversation history from S3:', error);
        }
    }

    /**
     * Saves the last message of conversationHistory to local chat-history folder.
     *
     */
    async saveConversationHistoryToLocal(): Promise<void> {
        try {
            const localKey = `${this.chatSessionId}`;
            const historyDir = path.join(process.cwd(), 'chat-history');

            if (!existsSync(historyDir)) {
                mkdirSync(historyDir, { recursive: true });
            }

            const localPath = path.join(historyDir, localKey);

            const lastMessageIndex = this.conversationHistory.length - 1;
            if (lastMessageIndex < 0) {
                return; // No messages to save
            }

            const lastMessage = this.conversationHistory[lastMessageIndex];

            if (!existsSync(localPath)) {
                // File doesn't exist - create with array
                const initialContent = JSON.stringify([lastMessage], null, 2);
                await fs.writeFile(localPath, initialContent, 'utf-8');
            } else {
                // File exists - read, parse, append, write back
                const fileContent = await fs.readFile(localPath, 'utf-8');
                let conversationArray: any[] = [];

                if (this.isHistoryReset) {
                    // Reset requested: start fresh (isHistoryReset is cleared by the S3 method)
                    conversationArray = [];
                } else {
                    try {
                        conversationArray = JSON.parse(fileContent);
                        if (!Array.isArray(conversationArray)) {
                            console.warn('Local history file content is not an array, resetting to new array');
                            conversationArray = [];
                        }
                    } catch (parseError) {
                        console.error('Failed to parse existing local history content, starting fresh:', parseError);
                        conversationArray = [];
                    }
                }

                // Skip duplicate last message
                const lastSaved = conversationArray.length > 0 ? conversationArray[conversationArray.length - 1] : null;
                if (lastSaved && JSON.stringify(lastSaved) === JSON.stringify(lastMessage)) {
                    return;
                }

                conversationArray.push(lastMessage);
                await fs.writeFile(localPath, JSON.stringify(conversationArray, null, 2), 'utf-8');
            }
        } catch (error) {
            console.error('Error saving conversation history to local:', error);
        }
    }

    /**
     * Loads conversation history from the local chat-history folder.
     * Used when SAVE_HISTORY_TO_S3 is false and SAVE_HISTORY_TO_LOCAL is true.
     */
    async loadConversationHistoryFromLocal(): Promise<void> {
        try {
            const localKey = `${this.chatSessionId}`;
            const historyDir = path.join(process.cwd(), 'chat-history');
            const localPath = path.join(historyDir, localKey);

            logger.info("getting chat history from local, id=>", localKey);

            if (!existsSync(localPath)) {
                return; // No history to load
            }

            const fileContent = await fs.readFile(localPath, 'utf-8');
            let conversationArray: any[] = [];

            try {
                conversationArray = JSON.parse(fileContent);
                if (!Array.isArray(conversationArray)) {
                    console.warn('Local history file content is not an array, skipping history load');
                    return;
                }
            } catch (parseError) {
                console.error('Failed to parse local conversation history:', parseError);
                return;
            }

            if (conversationArray.length > 0) {
                this.conversationHistory = [...conversationArray, ...this.conversationHistory];
            }
        } catch (error) {
            console.error('Error loading conversation history from local:', error);
        }
    }


    /**
     * Saves the complete conversation history (including usage data) to local filesystem
     * This is separate from the S3 storage and stores the raw responseBody
     */
    async saveCompleteConversationHistoryLocal(): Promise<void> {
        try {
            // Save to local filesystem if SAVE_HISTORY_TO_LOCAL flag is enabled
            if (SAVE_HISTORY_TO_LOCAL) {
                const logsDir = path.join(process.cwd(), 'logs');

                // Check if logs directory exists, create it if it doesn't
                if (!existsSync(logsDir)) {
                    mkdirSync(logsDir, { recursive: true });
                }

                const logPath = path.join(logsDir, this.completeLogFileName);

                // Get only the most recent message to append
                const lastMessageIndex = this.completeConversationHistory.length - 1;
                if (lastMessageIndex >= 0) {
                    const lastMessage = this.completeConversationHistory[lastMessageIndex];

                    let dataToAppend = JSON.stringify(lastMessage, null, 2);
                    let fileExists = existsSync(logPath);

                    if (!fileExists) {
                        // If file doesn't exist, create it with an array opening bracket
                        await fs.writeFile(logPath, '[\n' + dataToAppend + '\n]');
                    } else {
                        // If file exists, we need to replace the closing bracket with the new message
                        const fileContent = await fs.readFile(logPath, 'utf8');

                        if (fileContent.trim() === '[') {
                            // File only has opening bracket
                            await fs.appendFile(logPath, dataToAppend + '\n]');
                        } else {
                            // Remove the closing bracket, add comma + new message + closing bracket
                            if (fileContent.trim().endsWith(']')) {
                                // Remove the last character (']') from the file
                                const contentWithoutClosingBracket = fileContent.slice(0, -1).trimEnd();
                                // Write the updated content back to the file
                                await fs.writeFile(logPath, contentWithoutClosingBracket + ',\n' + dataToAppend + '\n]');
                            } else {
                                // Something is wrong with the file format, append properly
                                console.warn('Complete log file format is unexpected, appending message with comma');
                                await fs.appendFile(logPath, ',\n' + dataToAppend + '\n]');
                            }
                        }
                    }

                    logger.info('Complete conversation history saved locally', {
                        taskId: this.taskId,
                        fileName: this.completeLogFileName,
                        messageCount: this.completeConversationHistory.length
                    });
                }
            }
        } catch (error) {
            console.error('Error saving complete conversation history locally:', error);
        }
    }

    /**
     * Saves the complete conversation history to S3 directly from conversationHistory array.
     * This replaces the entire file content instead of appending.
     * Useful when the user has aborted the chat and there's nothing new to add,
     * but we still want to ensure the complete history is saved.
     */
    async saveCompleteConversationHistoryToS3(): Promise<void> {
        try {
            if (!this.conversationHistory || this.conversationHistory.length === 0) {
                console.log('No conversation history to save');
                return;
            }

            const completeContent = JSON.stringify(this.conversationHistory, null, 2);

            // Save to S3 if flag is enabled
            if (SAVE_HISTORY_TO_S3) {
                const s3Key = `${this.conversationHistoryFileName}`;
                const result = await this.s3HistoryService.storeFile(
                    s3Key,
                    completeContent,
                    undefined,
                    'application/json'
                );
                if (result.success) {
                    console.log(`Successfully saved complete conversation history to S3: ${s3Key}`);
                } else {
                    console.error(`Failed to save complete conversation history to S3: ${result.error}`);
                }
            }

            // Also save to local if flag is enabled
            if (SAVE_HISTORY_TO_LOCAL) {
                const historyDir = path.join(process.cwd(), 'chat-history');
                if (!existsSync(historyDir)) {
                    mkdirSync(historyDir, { recursive: true });
                }
                const localPath = path.join(historyDir, `${this.conversationHistoryFileName}`);
                await fs.writeFile(localPath, completeContent, 'utf-8');
            }
        } catch (error) {
            console.error('Error saving complete conversation history to S3:', error);
        }
    }
    async connect(): Promise<void> {



    }
    async disconnect(): Promise<void> {
        await this.saveConversationHistory();

        // Disconnect MCP client
        if (this.playwrightMcpClient?.isServerConnected?.()) {
            await this.playwrightMcpClient.disconnect();
        }

        
    }

    /**
     * Cleans the conversation history by removing content from all tool_result messages
     * except for the last 10 messages which are kept intact.
     * This only affects the in-memory conversation history, not the log file.
     */
    // cleanConversationHistory(): void {
    //     const historyLength = this.conversationHistory.length;

    //     // Keep the last 10 messages intact
    //     const preserveCount = Math.min(10, historyLength);
    //     const startCleaningIndex = Math.max(0, historyLength - preserveCount);

    //     // Clean older messages (before the last 10)
    //     for (let i = 0; i < startCleaningIndex; i++) {
    //         const message = this.conversationHistory[i];

    //         // Check if it's a user message with tool results
    //         if (message.role === 'user' && Array.isArray(message.content)) {
    //             // Clean all tool results by removing their content
    //             message.content = message.content.map((item: any) => {
    //                 if (item.type === 'tool_result' && this.toolId_toolNameMap.has(item.tool_use_id) && this.toolId_toolNameMap.get(item.tool_use_id) != "StartBackgroundProcess") {
    //                     // Find the corresponding tool call to get the tool name if possible
    //                     const toolId = item.tool_use_id;
    //                     let toolName = '';

    //                     // Remove content from all tool results
    //                     return {
    //                         ...item,
    //                         content:
    //                             `[result removed to save context]`
    //                     };
    //                 }
    //                 return item;
    //             });
    //         }
    //     }

    //     // Note: This cleaning only affects the in-memory conversation history
    //     // The log file will still contain the complete conversation history
    //     // as each message is appended to the log file when it's added
    // }

    /**
     * Cleans browser and RAG tool results from conversation history to save context.
     * Only cleans tool results that are NOT in the last 10 messages.
     * Replaces their content with a message indicating removal.
     */
    loadToolId_toolNameMap() {
        for (const message of this.agentConversationHistory) {
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                message.content.forEach((item: any) => {
                    if (item.type === 'tool_use') {
                        this.toolId_toolNameMap.set(item.id, item.name);
                    }
                })
            }
        }
    }
    CleanAllToolResults() {
        for (const message of this.agentConversationHistory) {
            if (message.role === 'user' && Array.isArray(message.content)) {
                message.content = message.content.map((item: any) => {
                    if (item.type === 'tool_result') {
                        return {
                            ...item,
                            content: 'This result has been removed to save context'
                        }

                    }
                });
            }
        }
    }
    cleanBrowserAndRAGToolResults(): void { // this will also clean the tavily web search tool.
        const historyLength = this.agentConversationHistory.length;

        // Keep the last 10 messages intact
        const preserveCount = Math.min(10, historyLength);
        const startCleaningIndex = Math.max(0, historyLength - preserveCount);

        let browserToolsCleaned = 0;
        let ragToolsCleaned = 0;
        let tavilyToolsCleaned = 0;
        // Clean older messages (before the last 10)
        for (let i = 0; i < startCleaningIndex; i++) {
            const message = this.agentConversationHistory[i];

            // Check if it's a user message with tool results
            if (message.role === 'user' && Array.isArray(message.content)) {
                // Clean browser and RAG tool results
                message.content = message.content.map((item: any) => {
                    if (item.type === 'tool_result' && item.tool_use_id) {
                        // Get the tool name from the map
                        const toolName = this.toolId_toolNameMap.get(item.tool_use_id);

                        // Check if it's a browser-related tool
                        if (toolName && toolName.toLowerCase().includes('browser')) {
                            browserToolsCleaned++;
                            logger.info('Cleaning browser tool result from conversation history');
                            return {
                                ...item,
                                content: 'This result has been removed to save context'
                            };
                        }

                        // Check if it's a RAG tool
                        if (toolName && (toolName.toLowerCase().includes('rag') || toolName === 'RAG')) {
                            ragToolsCleaned++;
                            logger.info('Cleaning browser tool result from conversation history');
                            return {
                                ...item,
                                content: 'This result has been removed to save context'
                            };
                        }
                        if (toolName && toolName.toLowerCase().includes('tavily')) {
                            tavilyToolsCleaned++;
                            logger.info('cleaning tavily search tools');
                            return {
                                ...item,
                                content: 'This result has been removed to save context'
                            }


                        }
                    }
                    return item;
                });
            }
        }

        logger.info('Cleaned browser and RAG tool results from chat history', {
            totalMessages: historyLength,
            cleanedMessages: startCleaningIndex,
            preservedMessages: preserveCount,
            browserToolsCleaned: browserToolsCleaned,
            ragToolsCleaned: ragToolsCleaned
        });
    }
    async inovkeModelWithoutTool(prompt: any) {

    }

    /**
     * Takes a screenshot of the UI using Playwright
     * @returns {Promise<string>} - Base64 encoded screenshot
     */
    async takeScreenshot(): Promise<string> {
        if (!this.uiLink) {
            throw new Error('UI link is not set. Cannot take screenshot.');
        }

        try {
            // console.log(`Taking screenshot of UI at: ${this.uiLink}`);

            // Launch a browser with settings that mimic a real browser
            const browser = await chromium.launch({
                headless: true
            });

            try {
                // Create a new browser context with standard settings that preserve UI elements like scrollbars
                const context = await browser.newContext({
                    viewport: { width: 1920, height: 1080 },
                    deviceScaleFactor: 1,  // Standard scale factor (not increasing as it might affect scrollbar visibility)
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                });

                // Create a new page
                const page = await context.newPage();

                // Set standard headers
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
                });

                // Ensure we don't modify the page's CSS to hide scrollbars
                await page.addInitScript(() => {
                    // Remove any potential styles that might hide scrollbars
                    const styleSheets = document.styleSheets;
                    for (let i = 0; i < styleSheets.length; i++) {
                        try {
                            const rules = styleSheets[i].cssRules;
                            for (let j = 0; j < rules.length; j++) {
                                const rule = rules[j];
                                if (rule.cssText.includes('::-webkit-scrollbar') ||
                                    rule.cssText.includes('overflow: hidden') ||
                                    rule.cssText.includes('overflow:hidden')) {
                                    // Console log any scrollbar-hiding rules we find
                                    // console.log('Found scrollbar-hiding rule:', rule.cssText);
                                }
                            }
                        } catch (e) {
                            // Some stylesheets may not be accessible due to CORS
                            // console.log('Could not access stylesheet');
                        }
                    }
                });

                // console.log('Navigating to page...');
                // Navigate to the UI link
                await page.goto(this.uiLink, {
                    waitUntil: 'networkidle',
                    timeout: 60000 // 60 second timeout
                });

                // Wait for the page to fully render
                // console.log('Waiting for page to fully render...');
                await page.waitForTimeout(5000);

                // Scroll through the page to ensure all content is loaded
                // but preserve the final scroll position to show relevant parts of the UI
                // console.log('Scrolling through page to ensure all content is loaded...');
                await page.evaluate(() => {
                    return new Promise<void>((resolve) => {
                        let totalHeight = 0;
                        const distance = 100;
                        const timer = setInterval(() => {
                            const scrollHeight = document.body.scrollHeight;
                            window.scrollBy(0, distance);
                            totalHeight += distance;

                            if (totalHeight >= scrollHeight) {
                                clearInterval(timer);
                                // Don't scroll back to top - keep the position where scrollbars are visible
                                // window.scrollTo(0, 0); 
                                resolve();
                            }
                        }, 100);
                    });
                });

                // Create Screenshots directory if it doesn't exist
                const screenshotsDir = path.join(process.cwd(), 'Screenshots');
                if (!existsSync(screenshotsDir)) {
                    mkdirSync(screenshotsDir, { recursive: true });
                }

                // Generate a filename with timestamp
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = path.join(screenshotsDir, `screenshot-${timestamp}.jpg`);

                // Take a screenshot that preserves the page's appearance including scrollbars
                // console.log('Taking screenshot...');
                const screenshot = await page.screenshot({
                    type: 'jpeg',
                    quality: 90,
                    fullPage: false, // Don't use fullPage to ensure we capture what's currently visible with scrollbars
                    path: filename
                });

                // Now take a full page screenshot as well for reference
                const fullPageFilename = path.join(screenshotsDir, `screenshot-full-${timestamp}.jpg`);
                await page.screenshot({
                    type: 'jpeg',
                    quality: 90,
                    fullPage: true,
                    path: fullPageFilename
                });
                // console.log(`Full page screenshot also saved to: ${fullPageFilename}`);

                // Read the file and convert to base64 for return
                const fileBuffer = await fs.readFile(filename);
                const base64Data = fileBuffer.toString('base64');

                // console.log(`Screenshot saved to: ${filename}`);
                // console.log('Screenshot taken successfully');
                return base64Data;
            } finally {
                // Always ensure the browser is closed to prevent resource leaks
                await browser.close();
                // console.log('Browser closed');
            }
        } catch (error) {
            console.error('Error taking screenshot:', error);
            throw error;
        }
    }

    async removeCacheControl() {
        for (const val of this.agentConversationHistory) {
            Array.isArray(val?.content) && val.content.forEach((item: any) => item?.cache_control && delete item.cache_control);
            delete val.content.at(-1)?.["cache_control"]; // this is just for safety in case the upper logic does not work properly
        }
    }


    private normalizeAndCompressToolResult(toolName: string, rawResult: any): string {
        let normalizedResult = '';

        if (typeof rawResult === 'string') {
            normalizedResult = rawResult;
        } else {
            try {
                normalizedResult = JSON.stringify(rawResult);
            } catch {
                normalizedResult = String(rawResult ?? '');
            }
        }

        if (!normalizedResult) {
            return '';
        }

        return normalizedResult;
    }

    private async applyAdaptiveHistoryCompression(
        inputTokenCount: number,
        summarize?: boolean,
        fallbackPromptText?: string
    ): Promise<{ replacedWithSummaryPrompt: boolean; summaryPrompt?: any }> {
        if (summarize) {
            logger.info('Forced summarize requested, falling back to legacy summarization path');
            this.CleanAllToolResults();
            let current_summary = await this.conversationSummarizer.summarizeConversation(this.agentConversationHistory);
            this.isHistoryReset = true;
            this.conversationHistory.length = 0;
            this.agentConversationHistory.length = 0;

            const summaryPrompt = {
                role: 'user',
                content: [{
                    type: 'text',
                    text: fallbackPromptText
                        ? `${fallbackPromptText}\nHere is the summary==> ${current_summary}`
                        : `The previous agent has been working for a long time, without converging to a solution, so here is the summary of the previous conversation which happened, try to think why the approach did not work, and what should be changed from the previous approach,
                     continue using this approach if you find it will yield the result, else you should change the approach. Here is the summary==> ${current_summary}`
                }]
            };

            this.agentConversationHistory.push(summaryPrompt);
            this.conversationHistory.push(structuredClone(summaryPrompt));
            return { replacedWithSummaryPrompt: true, summaryPrompt };
        }

        const adaptiveState: AgentState = {
            conversationHistory: this.conversationHistory,
            agentConversationHistory: this.agentConversationHistory,
            inputTokenCount,
            maxTokens: this.modelInfo.max_input_tokens,
            toolIdMap: this.toolId_toolNameMap
        };

        const compressionResult = await this.adaptiveCompressor.applyAdaptiveCompression(adaptiveState);
        this.conversationHistory = compressionResult.conversationHistory;
        this.agentConversationHistory = compressionResult.agentConversationHistory;

        this.isHistoryReset = compressionResult.didReset;

        if (compressionResult.didReset && this.agentConversationHistory.length > 0) {
            const summaryPrompt = this.agentConversationHistory[this.agentConversationHistory.length - 1];
            if (this.conversationHistory.length === 0) {
                this.conversationHistory.push(structuredClone(summaryPrompt));
            }
            logger.info('Adaptive compression performed a full reset', {
                level: compressionResult.level
            });
            return {
                replacedWithSummaryPrompt: true,
                summaryPrompt
            };
        }

        logger.info('Adaptive compression applied without history reset', {
            level: compressionResult.level,
            stats: this.adaptiveCompressor.getStats()
        });

        return { replacedWithSummaryPrompt: false };
    }

    async invokeModel(prompt: any, isUserPromptAlreadyAdded?: boolean, isAttachments?: boolean, attachmentPrompt?: string, toolResults?: ToolResult[] | ToolResult, imageData?: any[], operation?: Operations, signal?: AbortSignal, subFolder?: string, summarize?: boolean, count?: number): Promise<any> {

        try {
            // Check if already aborted
            if (signal?.aborted) {
                return null;
            }

            if (!prompt && !toolResults) {
                throw new Error('Either prompt or toolResults must be provided');
            }


            let userPrompt: any = { role: 'user', content: [] };

            // here we will be doing three things, there are three cases
            /*
               1. when the incoming request is a tool result array, in that case we will not be sending imageData and prompt to the agent, only the tool results
               2. when the incoming request is a user request, then we will have two cases, eitehr simple text or with images, if simple text then we will only keep the text and nothing else
                3. when the incoming request is a user rouest along with the images, then we will be adding the images and the text entered by the user as well.
            */

            if (toolResults && Array.isArray(toolResults) && toolResults.length > 0) {
                let tool_results: Map<string, any> = new Map<string, any>();
                for (const toolResult of toolResults) {

                    let val = tool_results.get(toolResult.id) // it is coming again so push in the content
                    if (val) {
                        if (toolResult.type === "text") {
                            val.content.push({

                                type: "text",
                                text: toolResult.result

                            });
                        }
                        else if (toolResult.type === "image") {
                            val.content.push({

                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type: "image/png",
                                    data: toolResult.result
                                }


                            });
                        }
                    }
                    else {
                        // its a new record so it wont have content we have to create a new one

                        let detail = {
                            type: "tool_result",
                            tool_use_id: toolResult.id,
                            content: [] as any[]
                        };
                        if (toolResult.type === "text") {
                            detail.content.push({
                                type: "text",
                                text: toolResult.result
                            });
                        }
                        else if (toolResult.type === "image") {
                            detail.content.push({
                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type: "image/png",
                                    data: toolResult.result
                                }
                            })
                        }
                        tool_results.set(toolResult.id, detail);
                    }




                }
                userPrompt.content.push(...tool_results.values());

                // console.log(" user content is==>",userPrompt);
                this.agentConversationHistory.push(userPrompt);

            }
            else if (toolResults && typeof toolResults === 'object' && (toolResults as ToolResult).id) {

                let toolResult = toolResults as ToolResult;
                if (toolResult.type === "text") {
                    userPrompt.content.push({
                        type: "tool_result",
                        tool_use_id: toolResult.id,
                        content: [{
                            type: "text",
                            text: toolResult.result

                        }]
                    })
                }
                else if (toolResult.type === "image") {
                    userPrompt.content.push({

                        content: [
                            {
                                type: "text",
                                text: prompt
                            },

                            {
                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type: "image/png",
                                    data: toolResult.result
                                }
                            }
                        ]

                    });
                }
                this.agentConversationHistory.push(userPrompt);

            }


            //////////////////////setting the tools for the agent

            let playwright_mcp_tools: any = {};
            if (this.operation === Operations.CODING_AGENT && this.isPlaywrightAvailable && (this.accessRights.includes(AccessRights.PLAYWRIGHT_TOOL) || this.accessRights.includes(AccessRights.ALL))) {
                try {
                    playwright_mcp_tools = await this.playwrightMcpClient.getAllTools();
                    if (playwright_mcp_tools.success) {
                        for (let tool of playwright_mcp_tools.tools.tools) {
                            tool.input_schema = tool.inputSchema;
                            delete tool.inputSchema;
                            delete tool?.annotations;
                            delete tool?.annotation;

                        }

                        //got the tools of the current MCP server
                        playwright_mcp_tools.tools.tools[playwright_mcp_tools.tools.tools.length - 1]["cache_control"] = { type: "ephemeral" };
                    }
                }
                catch (ex) {
                    logger.error('error while getting tools for playwright mcp server');
                }
            }
            let tavilyWebSearchTools: any;
            if (this.operation === Operations.CODING_AGENT && this.isTavilyWebSearchAvailable && (this.accessRights.includes(AccessRights.TAVILY_WEB_SEARCH_TOOL) || this.accessRights.includes(AccessRights.ALL))) {
                try {
                    let tavilyWebSearchToolsResult = (await this.tavilyWebSearchMcpClient.getAllTools());
                    if (tavilyWebSearchToolsResult.success) {
                        tavilyWebSearchTools = tavilyWebSearchToolsResult.tools.tools;
                        for (let tool of tavilyWebSearchTools) {
                            tool["input_schema"] = tool["inputSchema"];
                            delete tool["inputSchema"];
                            delete tool["outputSchema"];
                            delete tool["_meta"];
                            delete tool["annotations"];
                        }
                    }
                }
                catch (ex) {
                    logger.error('error while getting tools from tavily server');
                }
            }

            let finalTools: any = [];

            if (this.accessRights.includes(AccessRights.EXECUTE_COMMAND_TOOL) || this.accessRights.includes(AccessRights.ALL)) {
                finalTools = finalTools.concat(pl.get_execute_command_prompt());
            }
            if (operation === Operations.CODING_AGENT && (this.accessRights.includes(AccessRights.READ_FILES) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.get_read_file_tool());
            }
            if (operation === Operations.CODING_AGENT && (this.accessRights.includes(AccessRights.WRITE_FILES) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.get_edit_file_tools());
            }

            if (ds.taskId_task.get(this.taskId)?.isIndexerRunning && (this.accessRights.includes(AccessRights.RAG_TOOLS) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.get_RAG_tool());
            }
            if (operation === Operations.CODING_AGENT && (this.accessRights.includes(AccessRights.EXECUTE_COMMAND_TOOL) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.getExecuteHostCommandTool());

                // here by calling the get swarm tools feature
                // finalTools = finalTools.concat(pl.getSwarmTools());
            }

            // Org-scoped MCP tools (Jira + registered remote MCPs: Linear, Figma, …)
            let customMCPTools: any;
            if (operation === Operations.CODING_AGENT) {
                try {
                    customMCPTools = await mcpOrchestrator.listToolsForUser(this.userId);
                    for (let tool of customMCPTools.tools) {
                        delete tool["inputSchema"];
                        delete tool["outputSchema"];
                        delete tool["_meta"];
                        delete tool["annotations"];
                    }
                }
                catch (ex) {
                    logger.error('error while fetching tools from MCP orchestrator for user', { userId: this.userId, error: ex });
                }
            }


            // fetching github tools
            if (this.enableGithubTools && operation === Operations.CODING_AGENT && (this.accessRights.includes(AccessRights.GITHUB_TOOLS) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.getGithubTools());
            }

            // fetching swarm tools
            if (operation === Operations.CODING_AGENT && (this.accessRights.includes(AccessRights.SWARM_SUB_AGENT_TOOLS) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.getSwarmSubAgentTools());

            }
            if (operation === Operations.CODING_AGENT && (this.accessRights.includes(AccessRights.SWARM_CHILD_TASK_TOOLS) || this.accessRights.includes(AccessRights.ALL))) {
                finalTools = finalTools.concat(pl.getSwarmChildTaskTools());

            }
            finalTools = finalTools.concat(pl.getActiveModelsTool());
            if (this.operation === Operations.CODING_AGENT) {
                if (tavilyWebSearchTools !== null && tavilyWebSearchTools !== undefined) {
                    finalTools = finalTools.concat(tavilyWebSearchTools); // appending those tools.
                }
                if (playwright_mcp_tools !== null && playwright_mcp_tools.tools !== undefined) {
                    finalTools = finalTools.concat(playwright_mcp_tools.tools.tools);
                }
            }

            let systemPromptText = pl.get_system_prompt(this.folderPath, operation, this.containerName, subFolder, this.ec2_instance_ip);

            if (this.isChildTask) {
                systemPromptText += pl.get_swarms_sub_agent_prompt();
                systemPromptText += pl.get_swarms_child_task_self(this.sharedMemoryPath, this.agentId);
            }
            else if (this.agentType === AgentTypeEnum.SUB_AGENT) {
                systemPromptText += pl.get_swarms_sub_agent_prompt_self(this.agentId);

            }
            else {
                systemPromptText += pl.get_swarms_sub_agent_prompt();
                systemPromptText += pl.get_swarms_child_agent_prompt();
            }




            // Use local tiktoken-based token counting instead of AWS CountTokensCommand
            // CountTokensCommand has a 200k token limit and doesn't work for OpenAI models
            let localTokenCount = 0;
            try {
                localTokenCount = countConversationTokens(
                    this.agentConversationHistory,
                    systemPromptText,
                    finalTools
                );
                logger.info('Local tiktoken count completed', { localTokenCount });
            } catch (error) {
                logger.error('Error in local token counting, falling back to totalInputTokens', { error });
            }

            // Use the higher of local count vs last known API-reported count for safety
            let inputTokenCount = localTokenCount;
            console.log('input tokens count for the current conversation is==>', inputTokenCount);

            const compressionOutput = await this.applyAdaptiveHistoryCompression(
                inputTokenCount,
                summarize,
                ` here is the summary of the previous conversation which happened, contine from the last goal of the summary.`
            );

            if (compressionOutput.replacedWithSummaryPrompt && compressionOutput.summaryPrompt) {
                userPrompt = compressionOutput.summaryPrompt;
            }

            if (compressionOutput.replacedWithSummaryPrompt) {
                await this.saveConversationHistory();// summary prompt is already added to both histories
            }
            else if (!isUserPromptAlreadyAdded) {
                this.conversationHistory.push(userPrompt);
                await this.saveConversationHistory();// because we have already saved it before/
            }

            // Also add to complete history
            this.completeConversationHistory.push({
                role: 'user',
                content: userPrompt.content,
                timestamp: new Date().toISOString()
            });


            await this.saveCompleteConversationHistoryLocal();

            if (this.conversationHistory.length >= 3)//deleting the last checkpoint set
            {
                logger.success('successfully deleted the cache control from the third last message');
                delete this.conversationHistory.at(-3).content.at(-1)?.["cache_control"];
                delete this.agentConversationHistory.at(-3).content.at(-1)?.["cache_control"];
            }
            if (this.conversationHistory.length > 0) {
                this.removeCacheControl();
                const lastConversation = this.conversationHistory.at(-1);
                const lastAgentConversation = this.agentConversationHistory.at(-1);

                const lastConversationItem = lastConversation?.content?.at(-1);
                const lastAgentItem = lastAgentConversation?.content?.at(-1);

                if (lastConversationItem != null && lastAgentItem != null) {
                    lastConversationItem["cache_control"] = { type: "ephemeral" };
                    lastAgentItem["cache_control"] = { type: "ephemeral" };
                }
            }




            this.cleanBrowserAndRAGToolResults();

            // Check abort before making API call
            if (signal?.aborted) {
                return null;
            }

            // Use LLM Service to invoke the model (supports Claude and OpenAI)

            const queuedIncomingMessages = Array.isArray(this.messageQueue) && this.messageQueue.length > 0
                ? this.messageQueue.splice(0, this.messageQueue.length)
                : [];

            if (queuedIncomingMessages.length > 0) {
                let targetUserMessage: any = null;

                if (Array.isArray(userPrompt.content) && userPrompt.content.length > 0) {
                    targetUserMessage = userPrompt;
                } else {
                    const lastHistoryMessage = this.agentConversationHistory[this.agentConversationHistory.length - 1];
                    if (lastHistoryMessage?.role === "user" && Array.isArray(lastHistoryMessage.content)) {
                        targetUserMessage = lastHistoryMessage;
                    }
                }

                if (!targetUserMessage) {
                    targetUserMessage = { role: "user", content: [] };
                    this.agentConversationHistory.push(targetUserMessage);
                    this.conversationHistory.push(targetUserMessage);

                }

                for (const queuedMessage of queuedIncomingMessages) {
                    const queuedText = typeof queuedMessage === "string"
                        ? queuedMessage
                        : JSON.stringify(queuedMessage);
                    targetUserMessage.content.push({
                        type: "text",
                        text: `Incoming message from queue: ${queuedText}`
                    });
                }
            }

            let llmService = new LLMService({
                modelKey: this.modelName,
                modelInfo: this.modelInfo,
                providerType: this.modelInfo?.providerType,
                apiKey: this.llmApiKey,
                apiEndpoint: this.modelInfo?.api_endpoint || this.modelInfo?.azure_api_endpoint,
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID_AI,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_AI,
                    sessionToken: process.env.AWS_SESSION_TOKEN
                }
            });
            const llmResponse = await llmService.invoke({
                maxTokens: 20000,
                systemPrompt: systemPromptText,
                messages: [...this.agentConversationHistory],
                tools: finalTools,
                thinking: this.modelInfo?.supportsThinking === false ? undefined : {
                    enabled: true,
                    budgetTokens: 10000
                },
                signal
            });

            if (llmResponse === null || signal?.aborted) {
                logger.error("Response from AI model is null or aborted");
                return null;
            }

            // Convert LLMService response to Claude format for backward compatibility
            // The raw response contains the original provider format
            const responseBody = llmResponse.rawResponse || {
                content: [],
                usage: llmResponse.usage,
                stop_reason: llmResponse.stopReason
            };


            // If provider is not Claude, we need to convert response format
            if (!llmService.isClaude()) {
                // Convert OpenAI format to Claude format for consistency
                const content: any[] = [];

                if (llmResponse.text) {
                    content.push({
                        type: 'text',
                        text: llmResponse.text
                    });
                }

                if (llmResponse.toolUse && llmResponse.tools.length > 0) {
                    for (const tool of llmResponse.tools) {
                        content.push({
                            type: 'tool_use',
                            id: tool.id,
                            name: tool.name,
                            input: tool.input
                        });
                    }
                }

                responseBody.content = content;
                responseBody.usage = {
                    input_tokens: llmResponse.usage.inputTokens,
                    output_tokens: llmResponse.usage.outputTokens,
                    cache_creation_input_tokens: llmResponse.usage.cacheCreationInputTokens || 0,
                    cache_read_input_tokens: llmResponse.usage.cacheReadInputTokens || 0
                };
                responseBody.stop_reason = llmResponse.stopReason;
            }

            // Store complete responseBody in complete history (includes usage data)
            this.completeConversationHistory.push({
                role: 'assistant',
                content: responseBody.content,
                usage: responseBody.usage,
                stop_reason: responseBody.stop_reason,
                stop_sequence: responseBody.stop_sequence,
                model: responseBody.model,
                timestamp: new Date().toISOString()
            });
            await this.saveCompleteConversationHistoryLocal();
            this.totalInputTokens = responseBody.usage.input_tokens + responseBody.usage.cache_creation_input_tokens + responseBody.usage.cache_read_input_tokens;

            console.log('Total input tokens from the llm response is==>', this.totalInputTokens);
            // Track LLM usage and cost in MongoDB time series
            try {
                const taskData = ds.taskId_task.get(this.taskId);
                const llmMetricsService = new LLMMetricsService(ds.UserInfo.get(this.userId)?.dbName as any);

                // Ensure the collection is initialized
                await llmMetricsService.initialize();
                let groupedName = this.taskId === taskData?.wpId ? taskData.workspaceName : taskData?.taskName;
                // Track usage with all relevant metadata
                llmMetricsService.trackUsage({
                    usage: responseBody.usage,
                    modelInfo: this.modelInfo,
                    userId: this.userId,
                    userName: ds.UserInfo.get(this.userId)?.userName as any,
                    groupedName: groupedName as any,
                    organizationId: taskData?.organizationId || 'unknown',
                    taskId: this.taskId,

                    wpId: taskData?.wpId || ''
                });
            } catch (metricsError) {
                // Log error but don't break the flow
                logger.error('Failed to track LLM metrics', metricsError);
            }

            this.agentConversationHistory.push({
                role: "assistant",
                content: responseBody.content
            });
            this.conversationHistory.push({
                role: "assistant",
                content: responseBody.content
            });
            await this.saveConversationHistory();
            if (!responseBody.content || !Array.isArray(responseBody.content)) {
                throw new Error('Invalid response from model');
            }

            //printing the thought process of the 

            const toolCalls = responseBody.content.filter((item: any) => item.type === "tool_use");
            if (toolCalls.length > 0) {
                //printing the thought process  of the model for tool invocation.
                const textContent = responseBody.content.find((item: any) => item.type === 'text')?.text;
                // console.log("\n AI thought process is==>", textContent);
                return {
                    tool_use: true,
                    tools: toolCalls.map((tc: any) => ({
                        id: tc.id,
                        input: tc.input,
                        name: tc.name

                    })),
                    text: textContent


                };
            }
            const textContent = responseBody.content.find((item: any) => item.type === 'text')?.text;
            return {
                tool_use: false,
                text: textContent || 'No content found in response'
            };
        }
        catch (ex) {
            logger.error("Error while invoking the LLM model==>", ex);
            if (count && count <= 3) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                return await this.invokeModel(prompt, false, isAttachments, attachmentPrompt, toolResults, imageData, operation, signal, subFolder, false, count ? count + 1 : 1);
            }

            return {
                tool_use: false,
                text: 'Error invoking model: ' + (ex instanceof Error ? ex.message : String(ex))
            }

        }
    }
    private getCurrentSocket(taskData: any, socket: Socket | null): any {
        if (taskData == null) {
            return null;
        }
        if (socket == null) {
            return null;
        }
        if (taskData.socketId === undefined || taskData.socketId === null) {
            return socket;

        }
        return io.sockets.sockets.get(taskData.socketId) as Socket;
    }

    private getLatestTaskSessionId(taskData: any): string | null {
        try {
            const sessionIdChatHistoryData = taskData?.sessionId_chatHistoryData;
            if (!sessionIdChatHistoryData || Object.keys(sessionIdChatHistoryData).length === 0) {
                return null;
            }

            const sessions = Object.entries(sessionIdChatHistoryData);
            const sortedSessions = sessions.sort((a: any, b: any) => {
                const getEffectiveDate = (session: any): Date => {
                    if (session.LastMessageSent) {
                        return session.LastMessageSent instanceof Date ? session.LastMessageSent : new Date(session.LastMessageSent);
                    }
                    return session.CreatedDate instanceof Date ? session.CreatedDate : new Date(session.CreatedDate);
                };
                return getEffectiveDate(b[1]).getTime() - getEffectiveDate(a[1]).getTime();
            });

            return sortedSessions[0][0];
        }
        catch {
            return null;
        }
    }


    private normalizeStatusExplanation(explanation: any): string {
        const fallback = "working on delegated task";
        if (!explanation || typeof explanation !== 'string') {
            return fallback;
        }

        const trimmed = explanation.trim().replace(/\s+/g, ' ');
        if (!trimmed) {
            return fallback;
        }

        const words = trimmed.split(' ').slice(0, 9);
        return words.join(' ');
    }

    private updateAgentCurrentStatus(toolName: string, explanation: any): void {
        const status = this.normalizeStatusExplanation(explanation);
        const updatedAt = new Date().toISOString();

        this.currentStatusSummary = status;
        this.currentStatusUpdatedAt = updatedAt;
        this.currentToolName = toolName;

        this.statusHistory.push({
            status,
            toolName,
            updatedAt
        });

        if (this.statusHistory.length > 20) {
            this.statusHistory = this.statusHistory.slice(this.statusHistory.length - 20);
        }
    }

    private getAgentCurrentStatusPayload(agent: any): any {
        return {
            statusSummary: agent?.currentStatusSummary || "idle",
            statusUpdatedAt: agent?.currentStatusUpdatedAt || null,
            currentToolName: agent?.currentToolName || null,
            recentStatusHistory: (agent?.statusHistory || []).slice(-5)
        };
    }


    private async handleSwarmToolCall(toolCall: any, socket: Socket | null): Promise<any> {
        try {
            const { TaskService } = require('./TaskService');
            const { MessageQueueService } = require('./swarms/messageQueue');
            const { PromptExecutionService } = require('./PromptExecutionService');
            const { activeControllers } = require('../socket-handlers/file-server.handler');
            const { TaskType } = require('../classes/TaskTypeEnum');
            const { CollectionNames } = require('../DataAccessLayer/models');

            if (toolCall.name === "swarm_start_sub_agent") {
                let agentId = uuidv4();
                const payload = {
                    taskId: this.taskId,
                    prompt: toolCall.input.prompt,
                    modelKey: toolCall.input.modelKey || this.modelKey,
                    parentId: this.agentId,
                    agentId: agentId
                };

                TaskService.startSubAgentInternal(payload);
                return {
                    success: true,
                    agentId: agentId,
                    message: "sub agent started, it will take atmost 3 minutes to reflect the started status."
                }
            }

            if (toolCall.name === "swarm_send_agent_message") {

                let rcvrAgentId = toolCall.input.agentId;
                let message = toolCall.input.message;
                if (rcvrAgentId && message) {
                    await MessageQueueService.addMessageToQueue(this.agentId, rcvrAgentId, message);
                    return {
                        success: true,
                        message: "message added to the queue of the given sub agent"
                    }
                }
                return {
                    success: false,
                    message: "agentId was wrong, failed to send the message to the sub agent"
                }


            }

            if (toolCall.name === "swarm_get_sub_agent_status") {
                const subAgent = ds.agentId_agent.get(toolCall.input.agentId);
                if (!subAgent) {
                    return {
                        success: false,
                        agentId: toolCall.input.agentId,
                        message: "Sub-agent not found"
                    };
                }
                const isRunning = activeControllers.has(toolCall.input.agentId);
                return {
                    success: true,
                    agentId: toolCall.input.agentId,
                    state: isRunning ? "running" : "waiting",
                    queueLength: subAgent.messageQueue?.length || 0,
                    archivedMessages: subAgent.messageQueueArchive?.length || 0,
                    parentTaskId: subAgent.parentTaskId || null,
                    parentAgentId: subAgent.parentAgent || null,
                    ...this.getAgentCurrentStatusPayload(subAgent)
                };
            }

            if (toolCall.name === "swarm_stop_sub_agent") {
                return await TaskService.stopSubAgent({
                    agentId: toolCall.input.agentId,
                    reason: toolCall.input.reason
                });
            }

            if (toolCall.name === "swarm_clean_sub_agent") {
                return await TaskService.cleanSubAgent(toolCall.input.agentId);
            }


            if (toolCall.name === "swarm_start_child_task") {

                const payload = {
                    ...toolCall.input,
                    modelKey: toolCall.input.modelKey || this.modelKey,

                };

                let newTaskId = uuidv4();
                payload.newTaskId = newTaskId;
                TaskService.startTaskInternal(payload, this.userId, this.taskId, this.agentId);
                return {
                    success: true,
                    message: "task is starting, it might take some time to reflect in the status api, check back after a few seconds.",
                    startedTaskId: newTaskId
                }
            }

            if (toolCall.name === "swarm_get_child_task_status") {
                const runningChildTask = ds.taskId_task.get(toolCall.input.taskId);
                if (runningChildTask) {
                    return {
                        success: true,
                        taskId: runningChildTask.taskId,
                        status: runningChildTask.status,
                        running: true,
                        latestSessionId: this.getLatestTaskSessionId(runningChildTask),
                        parentTaskId: runningChildTask.ParentTaskId || null,
                        agentId: runningChildTask.Agent?.agentId || null,
                        ...this.getAgentCurrentStatusPayload(runningChildTask.Agent)
                    };
                }

                const userData = ds.UserInfo.get(this.userId);
                if (!userData?.dbName) {
                    return {
                        success: false,
                        taskId: toolCall.input.taskId,
                        message: "User DB context not found"
                    };
                }

                const dbService = await getDBService();
                const taskRepository = dbService.getRepository(userData.dbName, CollectionNames.TASKS);
                const taskDoc: any = await taskRepository.findOne({ taskId: toolCall.input.taskId, createdBy: this.userId });

                if (!taskDoc) {
                    return {
                        success: false,
                        taskId: toolCall.input.taskId,
                        message: "Child task not found"
                    };
                }

                return {
                    success: true,
                    taskId: taskDoc.taskId,
                    status: taskDoc.status,
                    running: false,
                    parentTaskId: taskDoc.parentTaskId || null,
                    latestSessionId: this.getLatestTaskSessionId(taskDoc)
                };
            }

            if (toolCall.name === "swarm_send_child_task_message") {
                //getting the main agent id from the task and then sending the message 
                let agentId = ds.taskId_task.get(toolCall.input.taskId)?.Agent?.agentId;
                await MessageQueueService.addMessageToQueue(this.agentId, agentId, toolCall.input.message);
                const subAgent = ds.agentId_agent.get(toolCall.input.agentId);
                return {
                    success: true,
                    agentId: toolCall.input.agentId,
                    queued: true,
                    queueLength: subAgent?.messageQueue?.length || 0,
                    message: "Message sent to sub-agent"
                };
            }

            if (toolCall.name === "swarm_stop_child_task") {
                await TaskService.stopTask(toolCall.input.taskId);
                return {
                    success: true,
                    taskId: toolCall.input.taskId,
                    message: "Stop requested for child task"
                };
            }

            return {
                success: false,
                message: `Unknown swarm tool: ${toolCall.name}`
            };
        }
        catch (ex) {
            logger.error('Error while handling swarm tool call', ex);
            return {
                success: false,
                message: ex instanceof Error ? ex.message : String(ex)
            };
        }
    }


    public async executeToolWithoutLLM(toolCall: any, socket: Socket | null = null, signal?: AbortSignal): Promise<any> {
        try {
            if (signal?.aborted) {
                return {
                    success: false,
                    message: 'Operation aborted before tool execution'
                };
            }

            if (!toolCall || !toolCall.name) {
                return {
                    success: false,
                    message: 'Invalid tool call payload. Expected { name, input }'
                };
            }

            let result: any;
            this.toolId_toolNameMap.set(toolCall.id || uuidv4(), toolCall.name);
            this.updateAgentCurrentStatus(toolCall.name, toolCall.input?.explanation);

            if (toolCall.input && toolCall.input.command && toolCall.name === "Execute_commmand") {
                result = await this.linuxTool.execute(toolCall.input.command);
            }
            else if (toolCall.input && toolCall.input.command && toolCall.name === "Execute_commmand_host_machine") {
                result = await this.linuxTool.executeHostCommand(toolCall.input.command);
            }
            else if (toolCall.name === "StartBackgroundProcess") {
                const command = toolCall.input?.command;
                const processName = toolCall.input?.processName || '';
                const workingDirectory = toolCall.input?.workingDirectory || '';
                const fullCommand = workingDirectory
                    ? `cd "${workingDirectory}" && ${command}`
                    : command;

                if (this.mode === 0) {
                    result = await this.localClient.executeBackgroundCommand(fullCommand, null, processName);
                } else {
                    result = await this.sshCombined.executeBackgroundCommand(fullCommand, null, processName);
                }
            }
            else if (toolCall.name === "ListBackgroundProcesses") {
                if (this.mode === 0) {
                    result = this.localClient.getBackgroundProcesses();
                } else {
                    result = this.sshCombined.getBackgroundProcesses();
                }
            }
            else if (toolCall.name === "GetBackgroundProcessLogs") {
                const processId = toolCall.input?.processId;
                const maxLines = toolCall.input?.maxLines || 0;
                const tailMode = toolCall.input?.tailMode !== undefined ? toolCall.input.tailMode : true;

                if (this.mode === 0) {
                    result = await this.localClient.getBackgroundProcessOutput(processId, maxLines, tailMode);
                } else {
                    result = await this.sshCombined.getBackgroundProcessOutput(processId, maxLines, tailMode);
                }
            }
            else if (toolCall.name === "TerminateBackgroundProcess") {
                const processId = toolCall.input?.processId;

                if (this.mode === 0) {
                    result = await this.localClient.terminateBackgroundProcess(processId);
                } else {
                    result = await this.sshCombined.terminateBackgroundProcess(processId);
                }
            }
            else if (toolCall.name === "ReadFile") {
                const modifiedInput = { ...toolCall.input };
                let absolutePath = this.folderPath;
                if (!absolutePath.endsWith('/')) {
                    absolutePath += '/';
                }
                modifiedInput.targetFile = absolutePath + modifiedInput.targetFile.replace(/\\/g, '/');
                result = await sendReadFileRequest(this.taskId, modifiedInput, this.ec2_instance_ip);
            }
            else if (toolCall.name === "EditCodeFile") {
                const modifiedEdits = (toolCall.input?.edits || []).map((edit: any) => {
                    const modifiedEdit = { ...edit };
                    let absolutePath = this.folderPath;
                    if (!absolutePath.endsWith('/')) {
                        absolutePath += '/';
                    }
                    modifiedEdit.absolutePath = absolutePath + edit.filePath.replace(/\\/g, '/');
                    return modifiedEdit;
                });
                result = await sendEditToolRequest(this.taskId, modifiedEdits, this.ec2_instance_ip);
            }
            else if (toolCall.name.startsWith("swarm_")) {
                result = await this.handleSwarmToolCall(toolCall, socket);
            }
            else if (toolCall.name.includes("command_verify_result") || toolCall.name.includes("UserDockerTerminalResult")) {
                result = toolCall.input;
            }
            else {
                return {
                    success: false,
                    toolName: toolCall.name,
                    message: `Tool ${toolCall.name} is not supported in direct dev mode yet`
                };
            }

            return {
                success: true,
                toolName: toolCall.name,
                toolCallId: toolCall.id || null,
                result
            };
        }
        catch (error) {
            return {
                success: false,
                toolName: toolCall?.name || null,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private async makeAbortableAPICall(requestBody: any, signal?: AbortSignal): Promise<any> {
        // Check if signal is already aborted
        if (signal?.aborted) {
            return null;
        }

        // AWS SDK v3 natively supports AbortSignal
        // Pass the signal directly to the send method to actually abort the HTTP request
        const options = signal ? { abortSignal: signal } : {};

        try {
            const response = await this.bedrock.send(requestBody, options);
            return response;
        } catch (error: any) {
            // AWS SDK throws AbortError when request is aborted
            if (error.name === 'AbortError' || signal?.aborted) {
                return null;
            }
            logger.error("Error while calling bedrock send ( in the API call for the AI Model)=>", error);
            console.log("Error while calling bedrock send(in the API call for the AI model)=>", error);
            return null;
        }
    }
    async run(query: any, toolResults: ToolResult[] = [], operation: Operations, socket: Socket | null, signal?: AbortSignal, attachments?: any, subFolder?: string): Promise<any> {
        // Check abort at the start
        try {
            if (signal?.aborted) {
                return null;
            }
            //   logger.info('Agent run started', { taskId: this.taskId, operation, hasQuery: !!query });

            // Load conversation history from S3 on first run
            if (this.conversationHistory.length === 0) {
                //connecting to the ssh client first

                // this will run on the first run

                try {
                    //initializing the MCP_Client - connects to remote Playwright MCP server via HTTP
                    // PLAYWRIGHT_MCP_URL should be in format: http://host:port (e.g., http://192.168.1.100:8080)
                    this.modelInfo = await getModelInfo(this.modelName);
                    this.modelId = this.modelInfo?.modelId || '';

                    // Initialize LLM Service with model info

                    if (this.operation === Operations.CODING_AGENT) {
                        const mcpServerUrl = this.playwrightUrl;// url for the playwright server
                        if (mcpServerUrl) {
                            await this.playwrightMcpClient.connectToServer(mcpServerUrl + '/mcp');
                            this.isPlaywrightAvailable = true;
                        } else {
                            this.isPlaywrightAvailable = false;
                            console.warn('PLAYWRIGHT_MCP_URL not set, MCP client will not be connected');
                        }
                    }
                }
                catch (ex) {
                    this.isPlaywrightAvailable = false;
                    logger.error('Error connecting to MCP server', { taskId: this.taskId, error: ex instanceof Error ? ex.message : String(ex) });
                }
                //checking if the tavily web search is available or not
                try {

                    //connecting to the tavily web search api
                    if (this.operation === Operations.CODING_AGENT) {
                        await this.tavilyWebSearchMcpClient.connectToServer(`https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`);
                        this.isTavilyWebSearchAvailable = true;
                    }

                }
                catch (ex) {
                    this.isTavilyWebSearchAvailable = false;
                    logger.error('Error connecting to tavily web search mcp server=>', ex);

                }

                // Load conversation history based on flags:
                // If S3 is enabled, always load from S3 (S3 is source of truth when both flags are on)
                // If only local is enabled, load from local chat-history folder
                if (SAVE_HISTORY_TO_S3) {
                    await this.loadConversationHistoryFromS3();
                } else if (SAVE_HISTORY_TO_LOCAL) {
                    await this.loadConversationHistoryFromLocal();
                }

                // doing the same things again because something is wrong with the abort things things are not getting saved.
                if (this.conversationHistory.length >= 3)//deleting the last checkpoint set
                {
                    logger.success('successfully deleted the cache control from the third last message');
                    delete this.conversationHistory.at(-3).content.at(-1)?.["cache_control"];
                }
                if (this.conversationHistory?.[this.conversationHistory.length - 1]?.role === "user") {
                    // Properly remove the last element
                    this.conversationHistory.pop();
                }
                for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
                    if (this.conversationHistory[i]?.role === "assistant") {
                        let lastMsg = this.conversationHistory[i];
                        // removing the cache control block if any
                        if (!lastMsg.content.some((item: any) => item.type === 'text')) {
                            lastMsg.content.push(
                                {
                                    "type": "text",
                                    "text": "The last chat was terminated, so starting a new chat."
                                }
                            );
                        }
                        if (Array.isArray(lastMsg.content)) {
                            lastMsg.content = lastMsg.content.filter((item: any) => item.type !== "tool_use");
                        }
                        logger.info("got inside abort call to remove tool use for assistant");
                        break;
                    }
                }

                this.saveCompleteConversationHistoryToS3();
                this.saveCompleteConversationHistoryLocal();

                // now setting the deep copy of the incoming conversation history for the agent.
                this.agentConversationHistory = structuredClone(this.conversationHistory);// getting the cloned copy

                //creating toolId_toolName map from the existing conversation history
                this.loadToolId_toolNameMap();
            }
            //  logger.debug('Conversation history loaded from S3', { taskId: this.taskId });
            let attachmentPrompt = '';
            let FinalImageData: any = [];
            let isAttachments = false;

            if (attachments !== null && attachments !== undefined) {

                isAttachments = true;
                for (let attachment of attachments) {
                    if (attachment.type === 'file') {
                        attachmentPrompt += '\n the user has attached the following file as an attachment=> ' + attachment.value;
                    }
                    if (attachment.type === 'jira') {
                        attachmentPrompt += '\n the user has attached the following jira ticket as an attachment=> ' + attachment.value;
                    }
                    if (attachment.type === 'image') {
                        FinalImageData.push(attachment.value);
                    }
                }

            }

            if (query) {


                signal?.addEventListener("abort", () => {
                    logger.info("starting to run the abort LLM call code..");

                    if (this.conversationHistory.length >= 3)//deleting the last checkpoint set
                    {
                        logger.success('successfully deleted the cache control from the third last message');
                        delete this.conversationHistory.at(-3).content.at(-1)?.["cache_control"];
                    }
                    if (this.conversationHistory?.[this.conversationHistory.length - 1]?.role === "user") {
                        // Properly remove the last element
                        logger.success("deleted the last unwanted user message");
                        this.conversationHistory.pop();
                    }

                    if (this.conversationHistory?.[this.conversationHistory.length - 1]?.role === "assistant") {
                        let lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
                        // removing the cache control block if any
                        logger.success("deleted")
                        if (!lastMsg.content.some((item: any) => item.type === 'text')) {
                            lastMsg.content.push(
                                {
                                    "type": "text",
                                    "text": "The last chat was terminated, so starting a new chat."
                                }
                            );
                        }
                        if (Array.isArray(lastMsg.content)) {
                            lastMsg.content = lastMsg.content.filter((item: any) => item.type !== "tool_use");
                        }
                        logger.info("got inside to delete the tool use blocks for assistant");

                    }
                    this.saveCompleteConversationHistoryToS3();
                    this.saveCompleteConversationHistoryLocal();
                    this.agentConversationHistory = structuredClone(this.conversationHistory);// setting the updated agent conversation history

                }, { once: true });


                let userPrompt = { role: 'user', content: [] as any[] };
                if (FinalImageData && FinalImageData.length > 0) {
                    userPrompt.content = [
                        {
                            type: "text",
                            text: query
                        }];

                    for (let data of FinalImageData) { // adding images one by one,
                        // Parse data URL format: data:image/png;base64,iVBORw0KGgo...
                        let mediaType = "image/png"; // default
                        let base64Data = data;

                        if (data.startsWith("data:")) {
                            const match = data.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
                            if (match) {
                                mediaType = match[1]; // e.g., "image/png", "image/jpeg"
                                base64Data = match[2]; // extract base64 data without prefix
                            }
                        }

                        userPrompt.content.push({
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: mediaType,
                                data: base64Data
                            }
                        });
                    }
                    if (isAttachments && attachmentPrompt) {
                        let userPromptCopy = structuredClone(userPrompt);
                        userPromptCopy.content.push({
                            type: "text",
                            text: attachmentPrompt
                        });
                        this.agentConversationHistory.push(userPromptCopy);
                    }
                    else {
                        this.agentConversationHistory.push(userPrompt);
                    }



                }
                else {
                    userPrompt.content = [{
                        type: "text",
                        text: query
                    }];
                    if (isAttachments && attachmentPrompt) {
                        let userPromptCopy = structuredClone(userPrompt);
                        userPromptCopy.content.push({
                            type: "text",
                            text: attachmentPrompt
                        });
                        this.agentConversationHistory.push(userPromptCopy);
                    }
                    else {
                        this.agentConversationHistory.push(userPrompt);
                    }

                }

                this.conversationHistory.push(userPrompt);
                this.saveConversationHistory(); // saving the conaversation history 

            }
            //appending attachments in query





            // Check abort before invokin
            if (signal?.aborted) {
                this.playwrightMcpClient.disconnect();
                return null;
            }
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(this.userId);
            let organizationHandler = dbService.getRepository<IOrganization>('Organizations', 'Organizations');
            let orgData: any = await organizationHandler.findOne({
                OrganizationId: userData?.organizationId
            });
            this.githubInstallationId = orgData?.metadata?.github.installationId;
            let isUserPromptAlreadyAdded = query === null ? false : true;
            const response = await this.invokeModel(query, isUserPromptAlreadyAdded, isAttachments, attachmentPrompt, toolResults = toolResults, FinalImageData, operation, signal, subFolder, false, 1);

            FinalImageData = []; // emptying all the images, because the attachments will be shown to the agent only on the starting prompt of the user.

            let taskData = ds.taskId_task.get(this.taskId);


            if (response != null) {
                if (!response.tool_use) {
                    // AI's turn is complete (no more tools to use)
                    // Clean the conversation history for the next interaction
                    // this.cleanConversationHistory();
                    this.playwrightMcpClient.disconnect();
                    await this.disconnect();
                    return response;
                }
                else if (response.tool_use && Array.isArray(response.tools)) {
                    const toolResultsArr: ToolResult[] = [];
                    //creating response for chat window by going through each loop 

                    // Collect all tool calls and emit once before processing
                    const toolCallsArray: any[] = [];
                    toolCallsArray.push({
                        "type": "text",
                        "text": response?.text
                    });
                    for (const toolCall of response.tools) {
                        let toolCallInfo: any = {
                            tool_id: toolCall.id,
                            name: toolCall.name,
                            explanation: toolCall.input.explanation,
                            type: "tool_call"
                        };

                        // Add specific data based on tool type
                        if (toolCall.name === "Execute_commmand" && toolCall.input?.command) {
                            toolCallInfo.name = "Executing Command";
                            toolCallInfo.data = toolCall.input.command;
                        } else if (toolCall.name === "StartBackgroundProcess" && toolCall.input?.command) {
                            toolCallInfo.name = "Starting Background Process";
                            toolCallInfo.data = toolCall.input.command;
                        } else if (toolCall.name === "RAG" && toolCall.input?.query) {
                            toolCallInfo.name = "Searching indexed code";
                            toolCallInfo.data = "";
                        } else if (toolCall.name === "EditCodeFile" && toolCall.input?.edits) {
                            toolCallInfo.name = "Editing File";
                            // Get the first file path from edits
                            let absolutePath = this.folderPath;
                            if (!absolutePath.endsWith('/')) {
                                absolutePath += '/';
                            }
                            const firstEdit = toolCall.input.edits[0];
                            if (firstEdit && firstEdit.filePath) {
                                toolCallInfo.data = absolutePath + firstEdit.filePath.replace(/\\/g, '/');
                            } else {
                                toolCallInfo.data = "";
                            }
                        } else if (toolCall.name === "ReadFile" && toolCall.input?.targetFile) {
                            toolCallInfo.name = "Reading File";
                            let absolutePath = this.folderPath;
                            if (!absolutePath.endsWith('/')) {
                                absolutePath += '/';
                            }
                            toolCallInfo.data = absolutePath + toolCall.input.targetFile.replace(/\\/g, '/');
                        } else if (toolCall.name.includes("browser")) {
                            toolCallInfo.name = "Using Browser Tools";
                            toolCallInfo.data = "";
                        } else if (toolCall.name.startsWith("swarm_")) {
                            toolCallInfo.name = `Swarm: ${toolCall.name.replace("swarm_", "").replace(/_/g, " ")}`;
                            toolCallInfo.data = "";
                        } else {
                            toolCallInfo.data = "";
                        }

                        toolCallsArray.push(toolCallInfo);
                    }

                    // Emit all tool calls at once
                    if (response.tools.some((item: any) => item.name != 'final_response')) {
                        this.getCurrentSocket(taskData, socket)?.emit("thinking_response", toolCallsArray);
                    }

                    for (const toolCall of response.tools) {
                        // Check abort before each tool execution
                        if (signal?.aborted) {
                            new Error('Operation aborted durthrowing tool execution');
                        }
                        let result: any;
                        if (!(toolCall.name.includes("browser") || toolCall.name.includes("jira") || toolCall.name.includes("confluence")
                            || toolCall.name.includes("tavily") || toolCall.name.startsWith("swarm_") || toolCall.name == "get_available_models" || toolCall.name == "ReadFile" || toolCall.name == "EditCodeFile"))
                        // this means to execute the tool in the self hosted environment
                        {
                            let remoteToolSocket = toolServerClientManager.getClient(this.taskId);
                            let remoteToolExecutionService: any;
                            if (!remoteToolSocket) {
                                logger.error("no remote tool execution client is registered from the user end for this taskId=>", this.taskId);
                                result = "cannot execute the agent request because the remote tool execution client is not found for this given taskId, try in a few seconds, it must be starting, once started you will be able to execute the tools.";

                            }
                            else {

                                remoteToolExecutionService = new RemoteToolExecutionService(remoteToolSocket as any);
                                result = await remoteToolExecutionService.executeRemoteTool(toolCall, this.agentId);
                            }

                         
                            result = this.normalizeAndCompressToolResult(toolCall.name,result);

                        }
                        else {
                            this.toolId_toolNameMap.set(toolCall.id, toolCall.name);
                            this.updateAgentCurrentStatus(toolCall.name, toolCall.input?.explanation);
                            if (toolCall.input && toolCall.input.command && toolCall.name === "Execute_commmand") {
                                // // // console.log("\n AI is implementing the command tool ==>", toolCall.input.command);
                                try {

                                    let commandResult = await this.linuxTool.execute(toolCall.input.command);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, commandResult);
                                    // // console.log("the result of the command executed is==>",result);
                                } catch (err) {
                                    result = this.normalizeAndCompressToolResult(toolCall.name, `Error: ${err}`);
                                }
                            }
                            else if (toolCall.input && toolCall.input.command && toolCall.name === "Execute_commmand_host_machine") {
                                // console.log("\n AI is executing a command on the host machine ==>", toolCall.input.command);
                                try {
                                    let commandResult = await this.linuxTool.executeHostCommand(toolCall.input.command);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, commandResult);

                                } catch (err) {
                                    result = this.normalizeAndCompressToolResult(toolCall.name, `Error: ${err}`);
                                }
                            }
                            else if (toolCall.name === "StartBackgroundProcess") {
                                // console.log("\n AI is starting a background process ==>", toolCall.input.command);
                                try {
                                    // Prepare the parameters for executeBackgroundCommand
                                    const command = toolCall.input.command;
                                    const processName = toolCall.input.processName || '';
                                    const workingDirectory = toolCall.input.workingDirectory || '';

                                    // If working directory is specified, change to that directory before executing
                                    const fullCommand = workingDirectory
                                        ? `cd "${workingDirectory}" && ${command}`
                                        : command;

                                    let bgResult;
                                    // Execute the command in the background using the appropriate client
                                  
                                    result = JSON.stringify(bgResult);
                                    // console.log("Background process started with ID:", bgResult.processId);
                                } catch (err) {
                                    result = JSON.stringify(`Error starting background process: ${err}`);
                                }
                            } else if (toolCall.name === "ListBackgroundProcesses") {
                                // console.log("\n AI is listing background processes");

                                try {
                                    let processes;
                                    // Get background processes using the appropriate client
                                 
                                    result = JSON.stringify(processes);
                                    // console.log("Retrieved list of background processes");
                                } catch (err) {
                                    result = JSON.stringify(`Error listing background processes: ${err}`);
                                }
                            } else if (toolCall.name === "GetBackgroundProcessLogs") {
                                // console.log("\n AI is getting logs for background process ID:", toolCall.input.processId);
                                try {
                                    const processId = toolCall.input.processId;
                                    const maxLines = toolCall.input.maxLines || 0;
                                    const tailMode = toolCall.input.tailMode !== undefined ? toolCall.input.tailMode : true;

                                    let logs;
                                    // Get background process logs using the appropriate client
                                 
                                    result = JSON.stringify(logs);
                                    // console.log(`Retrieved ${maxLines > 0 ? maxLines : 'all'} lines of logs for process ${processId}`);
                                } catch (err) {
                                    result = JSON.stringify(`Error getting background process logs: ${err}`);
                                }
                            } else if (toolCall.name === "TerminateBackgroundProcess") {
                                // console.log("\n AI is terminating background process ID:", toolCall.input.processId);
                                try {
                                    const processId = toolCall.input.processId;

                                    let terminationResult;
                              
                                    result = JSON.stringify(terminationResult);
                                    // console.log(`Process ${processId} termination result:`, terminationResult.success ? 'Success' : 'Failed');
                                } catch (err) {
                                    result = JSON.stringify(`Error terminating background process: ${err}`);
                                }
                            } else if (toolCall.name === "RAG") {
                                // console.log("AI is calling RAG with the query==>", toolCall.input.query);
                                try {
                                    await this.setChromaDBManager(toolCall.input.projectName); // here we will setup the chroma manager connection.
                                    result = await this.chromaManager.queryCollection(toolCall.input.query, 5);
                                    //let allDocs = await this.chromaManager.getAllDocuments();
                                    result = this.normalizeAndCompressToolResult(toolCall.name, result);//only stringigying the RAG result.
                                    // console.log("result from the RAG came");
                                } catch (err) {
                                    result = this.normalizeAndCompressToolResult(toolCall.name, `Error: ${err}`);
                                }
                            } else if (toolCall.name === "StartDockerContainer") {
                                // console.log("\n AI is starting Docker containers using compose file:", toolCall.input.composeFilePath);
                                try {
                                    // Use the appropriate client based on mode
                                    let dockerResult;
                                    
                                    // console.log("Docker container management operation completed");
                                } catch (err) {
                                    result = JSON.stringify(`Error starting Docker containers: ${err}`);
                                }
                            } else if (toolCall.name === "GetDockerContainerStatus") {
                                // console.log("\n AI is getting Docker container status");
                                try {
                                    // Use the appropriate client based on mode
                                    let statusResult;
                                  

                                    // console.log("Docker container status operation completed");
                                } catch (err) {
                                    result = JSON.stringify(`Error getting Docker container status: ${err}`);
                                }
                            }
                            else if (toolCall.name == "EditCodeFile") {

                                try {
                                    // Send the edit request to the remote server instead of processing locally
                                    // Convert relative file paths to absolute paths by joining with folderPath
                                    const modifiedEdits = toolCall.input.edits.map((edit: any) => {
                                        // Create a copy of the edit object
                                        const modifiedEdit = { ...edit };
                                        modifiedEdit.absolutePath = edit.filePath;
                                        // Add absolutePath by joining folderPath with the relative filePath
                                        // Ensure the path is in Linux format

                                        return modifiedEdit;
                                    });

                                    let result1: [string, string][] = await sendEditToolRequest(this.taskId, modifiedEdits, this.ec2_instance_ip);
                                    result = JSON.stringify(result1);
                                    // console.log("Received edit result from remote server");
                                } catch (error) {
                                    console.error("Error sending edit request to remote server:", error);
                                    result = JSON.stringify(`Error: ${error}`);
                                }
                            }
                            else if (toolCall.name == "ReadFile") {
                                try {
                                    // Send the read file request to the remote server instead of processing locally
                                    // Create a copy of the input object
                                    const modifiedInput = { ...toolCall.input };

                                    result = await sendReadFileRequest(this.taskId, modifiedInput, this.ec2_instance_ip);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, result);
                                    // console.log("Received read file result from remote server");
                                } catch (error) {
                                    console.error("Error sending read file request to remote server:", error);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, `Error: ${error}`);
                                }
                            }
                            else if (toolCall.name == "TakeScreenshot" || toolCall.name == "GetScreenShot") {
                                // console.log("AI is taking a screenshot of the UI");
                                try {
                                    // Take a screenshot of the UI
                                    this.uiLink = toolCall.input.uiLink; //AI agent should return the link of the website where it is hosted.

                                    const screenshotBase64 = await this.takeScreenshot();

                                    // Add the screenshot to the tool results as an image
                                    toolResultsArr.push({
                                        id: toolCall.id,
                                        result: screenshotBase64,
                                        type: "image"
                                    });

                                    // Skip adding this result as text since we're adding it as an image
                                    continue;
                                } catch (error) {
                                    console.error("Error taking screenshot:", error);
                                    result = JSON.stringify(`Error taking screenshot: ${error}`);
                                }
                            }
                            else if (toolCall.name.includes("browser"))//invoking the playwright mcp server
                            {
                                try {
                                    result = await this.playwrightMcpClient.getToolResult(toolCall);
                                    for (let res of result.content) {
                                        //checking the content type
                                        if (res.type === "text") {
                                            toolResultsArr.push({
                                                id: toolCall.id,
                                                result: this.normalizeAndCompressToolResult(toolCall.name, res.text),
                                                type: "text"
                                            })
                                        }
                                        else if (res.type === "image") {
                                            // Check if image dimensions exceed the maximum allowed size
                                            const dimensionError = checkImageDimensionLimit(res.data);
                                            if (dimensionError) {
                                                // Image too large - return error message instead of image
                                                toolResultsArr.push({
                                                    id: toolCall.id,
                                                    result: this.normalizeAndCompressToolResult(toolCall.name, dimensionError),
                                                    type: "text"
                                                });
                                            } else {
                                                toolResultsArr.push({
                                                    id: toolCall.id,
                                                    result: res.data,
                                                    type: "image"
                                                });
                                            }
                                        }
                                    }
                                    continue;
                                }
                                catch (error) {
                                    console.error("Error invoking MCP tool:", error);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, `Error invoking MCP tool: ${error}`);
                                }
                            }
                            else if (toolCall.name === "get_available_models") {
                                try {
                                    const models = Object.values(ModelInfo.available_models).filter(
                                        (value) => typeof value === 'string' && value !== 'Amazon_tital_text_embeddings'
                                    );

                                    result = JSON.stringify(models);

                                }
                                catch (ex) {
                                    logger.error("error while implementing the tool =>" + toolCall.name + " exception is==>" + ex);
                                }
                            }
                            else if (toolCall.name.includes("jira") || toolCall.name.includes("confluence"))// for jira tools
                            {
                                try {
                                    const uid = this.getCurrentSocket(taskData, socket)?.data.user.userId || this.userId;
                                    const res = await mcpOrchestrator.executeTool(uid, toolCall.name, toolCall.input);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, res);
                                }
                                catch (ex) {
                                    result = this.normalizeAndCompressToolResult(toolCall.name, ex);
                                    logger.error('error while executing MCP orchestrator tool', { tool: toolCall.name, ex });
                                }
                            }
                            else if (toolCall.name.includes("tavily")) {
                                try {
                                    result = await this.tavilyWebSearchMcpClient.getToolResult(toolCall);
                                    for (let res of result.content) {
                                        //checking the content type
                                        if (res.type === "text") {
                                            toolResultsArr.push({
                                                id: toolCall.id,
                                                result: this.normalizeAndCompressToolResult(toolCall.name, res.text),
                                                type: "text"
                                            })
                                        }
                                        else if (res.type === "image") {
                                            // Check if image dimensions exceed the maximum allowed size
                                            const dimensionError = checkImageDimensionLimit(res.data);
                                            if (dimensionError) {
                                                // Image too large - return error message instead of image
                                                toolResultsArr.push({
                                                    id: toolCall.id,
                                                    result: this.normalizeAndCompressToolResult(toolCall.name, dimensionError),
                                                    type: "text"
                                                });
                                            } else {
                                                toolResultsArr.push({
                                                    id: toolCall.id,
                                                    result: res.data,
                                                    type: "image"
                                                });
                                            }
                                        }
                                    }
                                    continue;
                                }
                                catch (error) {
                                    logger.error("Error invoking tavily MCP tool:", error);
                                    result = this.normalizeAndCompressToolResult(toolCall.name, `Error invoking tavily MCP tool: ${error}`);
                                }
                            }

                            else if (toolCall.name.startsWith("Github_")) // for github tools
                            {
                                try {
                                    // Check if GitHub tools are enabled
                                    if (!this.enableGithubTools) {
                                        throw new Error('GitHub tools are not enabled for this agent');
                                    }

                                    // Check if installation ID is set
                                    if (!this.githubInstallationId) {
                                        throw new Error('GitHub installation ID is not set. Please set githubInstallationId property.');
                                    }

                                    const taskData = ds.taskId_task.get(this.taskId);
                                    if (!taskData) {
                                        throw new Error('Task data not found');
                                    }

                                    let githubResult;
                                    switch (toolCall.name) {
                                        case "Github_GetRepositoryList":
                                            githubResult = await this.githubOperationsService.getRepositoryList(
                                                this.githubInstallationId
                                            );
                                            break;



                                        case "Github_PullRepository":
                                            githubResult = await this.githubOperationsService.pullRepository(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                this.githubInstallationId,
                                                this.getCurrentSocket(taskData, socket)
                                            );
                                            break;

                                        case "Github_PushRepository":
                                            githubResult = await this.githubOperationsService.pushRepository(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                this.githubInstallationId,
                                                this.getCurrentSocket(taskData, socket)
                                            );
                                            break;

                                        case "Github_CheckRepositoryStatus":
                                            githubResult = await this.githubOperationsService.checkRepositoryStatus(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                this.githubInstallationId,
                                                this.getCurrentSocket(taskData, socket)
                                            );
                                            break;

                                        case "Github_GetRepositoryHistory":
                                            githubResult = await this.githubOperationsService.getRepositoryHistory(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                toolCall.input.branch || 'main',
                                                toolCall.input.maxCommits || 10
                                            );
                                            break;

                                        case "Github_CommitLocalChanges":
                                            // Get user info from the task data or socket
                                            const userInfo = {

                                            };
                                            githubResult = await this.githubOperationsService.commitLocalChanges(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                'main', // Default branch
                                                toolCall.input.commitMessage,
                                                userInfo,
                                                this.getCurrentSocket(taskData, socket),
                                                this.userId
                                            );
                                            break;

                                        case "Github_CreatePullRequest":
                                            githubResult = await this.githubOperationsService.createPullRequest(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                this.githubInstallationId,
                                                toolCall.input.targetBranch,
                                                toolCall.input.title,
                                                toolCall.input.body,
                                                this.getCurrentSocket(taskData, socket),
                                                this.userId
                                            );
                                            break;

                                        case "Github_CheckPullRequestExists":
                                            githubResult = await this.githubOperationsService.checkPullRequestExists(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                this.githubInstallationId,
                                                toolCall.input.targetBranch
                                            );
                                            break;

                                        case "Github_GetCommitDetails":
                                            githubResult = await this.githubOperationsService.getCommitDetails(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                toolCall.input.commitHash
                                            );
                                            break;

                                        case "Github_GetCommitList":
                                            githubResult = await this.githubOperationsService.getCommitList(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                toolCall.input.branch,
                                                toolCall.input.maxCommits || 100
                                            );
                                            break;

                                        case "Github_GetLatestCommitDiff":
                                            githubResult = await this.githubOperationsService.getLatestCommitDiff(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                toolCall.input.branch
                                            );
                                            break;

                                        case "Github_GetCommitDiffByHash":
                                            githubResult = await this.githubOperationsService.getCommitDiffByHash(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                toolCall.input.commitHash
                                            );
                                            break;

                                        case "Github_MergeBranchIntoBranch":
                                            githubResult = await this.githubOperationsService.mergeBranchIntoBranch(
                                                toolCall.input.repoName,
                                                this.taskId,
                                                taskData,
                                                this.githubInstallationId,
                                                toolCall.input.sourceBranch,
                                                toolCall.input.targetBranch,
                                                !!toolCall.input.pushToRemote,
                                                this.getCurrentSocket(taskData, socket)
                                            );
                                            break;

                                        case "Github_getRepositoryOriginBranch":
                                            githubResult = await this.githubOperationsService.getRepositoryOriginBranch(
                                                toolCall.input.repoName,
                                                this.taskId
                                            );
                                            break;

                                        default:
                                            throw new Error(`Unknown GitHub tool: ${toolCall.name}`);
                                    }

                                    result = this.normalizeAndCompressToolResult(toolCall.name, githubResult);
                                    logger.info(`GitHub tool ${toolCall.name} executed successfully`, { taskId: this.taskId });
                                }
                                catch (ex) {
                                    result = this.normalizeAndCompressToolResult(toolCall.name, { error: ex instanceof Error ? ex.message : String(ex) });
                                    logger.error("Error while implementing the GitHub tool=>" + toolCall.name + " the error is==>" + ex);
                                }
                            }
                            else if (toolCall.name.startsWith("swarm_")) {
                                const swarmResult = await this.handleSwarmToolCall(toolCall, this.getCurrentSocket(taskData, socket));
                                result = JSON.stringify(swarmResult);
                            }

                            else if (toolCall.name.includes("command_verify_result")) {
                                //return this tool Result
                                this.playwrightMcpClient.disconnect();
                                return toolCall.input;
                            }
                            else if (toolCall.name.includes("UserDockerTerminalResult")) {
                                this.playwrightMcpClient.disconnect();
                                return toolCall.input;
                            }

                            else {
                                result = 'No command input found, please output a linux command next time.';
                            }
                        }
                        result = this.normalizeAndCompressToolResult(toolCall.name, result);
                        toolResultsArr.push({
                            id: toolCall.id,
                            result: result,
                            type: "text"
                        });
                    }

                    // Collect all tool results and emit once after processing
                    const toolResultsArray: any[] = [];
                    for (const toolCall of response.tools) {
                        toolResultsArray.push({
                            tool_id: toolCall.id,
                            name: this.toolId_toolNameMap.get(toolCall.id) || toolCall.name,
                            result: "Success",
                            type: "tool_result"
                        });
                    }

                    // Emit all tool results at once
                    this.getCurrentSocket(taskData, socket)?.emit("thinking_response", toolResultsArray);

                    // Check abort before recursive call
                    if (signal?.aborted) {
                        this.playwrightMcpClient.disconnect();
                        return null;
                    }

                    return await this.run(null, toolResultsArr, operation, this.getCurrentSocket(taskData, socket) as any, signal, null, subFolder);
                }
                else {
                    this.playwrightMcpClient.disconnect();
                    return null;
                }
            }
            else {
                return null;
            }
        }
        catch (ex) {
            logger.error("\n Error while running run function of the agent=>" + ex);
        }
    }
}

// (async()=>{

//     const agent = new Agent(0,"",undefined,undefined,"http://52.91.139.24:3001");
//     await agent.takeScreenshot();

// })();


// console.log('Running original agent-system.ts');
export default Agent;


