// Enable debugging if launched with --inspect or --debug flag
if (process.execArgv.some(arg => arg.includes('--inspect') || arg.includes('--debug'))) {
    console.log('Debugger is attached. Ready for debugging SSH Client.');
}
import { ExecutionEnvironment } from '../classes/ExecutionEnvironment';
import { Client, ClientChannel } from 'ssh2';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

// Enum for execution environments


interface ProcessInfo {
    id: number;
    name: string;
    command: string;
    client: Client;
    startTime: Date;
    status: 'starting' | 'running' | 'completed' | 'terminated' | 'error';
    output: string;
    errorOutput: string;
    exitCode: number | null;
    socket: any; // We'll leave this as any for now
    pid?: string;
    logFilePath?: string;
    processIdPath?:string;
    isDockerProcess: boolean;
    monitorClient?: Client;
}

interface CommandResult {
    success: boolean;
    output: string;
    error?: string;
    command?: string;
    code?: number;
    message?: string;
}

interface BackgroundProcessStartResult {
    success: boolean;
    processId: number;
    pid?: string;
    name?: string;
    message?: string;
    error?: string;
    output?: string;
}

interface ProcessStatus {
    id: number;
    name: string;
    command: string;
    pid?: string;
    status: string;
    startTime: Date;
    outputLength: number;
    errorOutputLength: number;
    isDockerProcess: boolean;
    environment: string;
}

interface LogSizeResult {
    success: boolean;
    id?: number;
    name?: string;
    fileSize?: string;
    lineCount?: number;
    logFilePath?: string;
    environment?: ExecutionEnvironment;
    isDockerProcess?: boolean;
    message?: string;
    error?: string;
}

interface ProcessOutputResult {
    success: boolean;
    id?: number;
    name?: string;
    command?: string;
    pid?: string;
    status?: string;
    startTime?: Date;
    output?: string;
    errorOutput?: string;
    isLogFileRead?: boolean;
    maxLines?: number;
    tailMode?: boolean;
    environment?: ExecutionEnvironment;
    isDockerProcess?: boolean;
    message?: string;
    error?: string;
}

interface LogCleanupResult {
    success: boolean;
    id?: number;
    name?: string;
    message: string;
    error?: string;
}

interface TerminationResult {
    success: boolean;
    message: string;
    logCleanup?: LogCleanupResult;
    error?: string;
}

interface SSHConfig {
    host: string;
    username: string;
    privateKey: Buffer;
    keepaliveInterval: number;
    keepaliveCountMax: number;
}

class SSHClientCombined {
    private folderPath: string;
    private environment: ExecutionEnvironment;
    private config: SSHConfig;
    private client: Client;
    private isConnected: boolean;
    private reconnectAttempts: number;
    private maxReconnectAttempts: number;
    private reconnectDelay: number;
    private lastActivity: number;
    private activityCheckInterval: NodeJS.Timeout | null;
    private backgroundProcesses: Record<string, ProcessInfo>;
    private nextProcessId: number;
    private ec2_instance_ip:string;

    /**
     * Create a new SSH client
     * @param {string} folderPath - The folder path on the remote system or Docker container name
     * @param {ExecutionEnvironment} environment - The execution environment (ExecutionEnvironment.EC2 or ExecutionEnvironment.DOCKER)
     */
    constructor(folderPath: string, ec2_instance_ip:string, environment: ExecutionEnvironment = ExecutionEnvironment.DOCKER) {
        this.folderPath = folderPath;
        this.environment = environment;
        this.ec2_instance_ip = ec2_instance_ip;
        this.config = {
            host: ec2_instance_ip,
            username: 'ubuntu', // default for Amazon Linux AMIs
            privateKey: fs.readFileSync(process.env.SSH_KEY_PATH || ''),
            keepaliveInterval: 60000, // Send keepalive packet every 60 seconds
            keepaliveCountMax: 60 // Allow up to 60 missed keepalives (60 minutes)
        };
        this.client = new Client();
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000; // 5 seconds initial delay
        this.lastActivity = Date.now();
        this.activityCheckInterval = null;
        this.backgroundProcesses = {}; // Track background processes by ID
        this.nextProcessId = 1; // Counter for generating unique process IDs
    }

    async connect(): Promise<CommandResult | void> {
        return new Promise((resolve) => {
            // Reset reconnect attempts on manual connect
            this.reconnectAttempts = 0;

            this._setupConnection(resolve);
        });
    }

    private _setupConnection(resolve?: (value: CommandResult | void) => void): void {
        // Clear any existing activity check interval
        if (this.activityCheckInterval) {
            clearInterval(this.activityCheckInterval);
        }

        this.client
            .on('ready', () => {
                //console.log('SSH Connection established!');
                this.isConnected = true;
                this.lastActivity = Date.now();
                this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection

                // Set up activity check interval (every 5 minutes)
                this.activityCheckInterval = setInterval(() => this._checkActivity(), 5 * 60 * 1000);

                if (this.folderPath) {
                    if (this.environment === ExecutionEnvironment.DOCKER) {
                        // For Docker: Verify container exists and is running
                        // Run this directly on the EC2 host instead of inside the Docker container
                        const containerName = path.basename(this.folderPath);
                        this.executeHostCommand(`sudo /usr/bin/docker ps --filter "name=${containerName}" --format '{{.Names}}' | grep -q "${containerName}" && echo "Container exists" || echo "Container does not exist"`)
                            .then(result => {
                                if (result.output.includes("Container exists")) {
                                    //console.log(`Docker container set to: ${containerName}`);
                                } else {
                                    console.warn(`Warning: Docker container ${containerName} does not exist or is not running.`);
                                }
                                if (resolve) resolve();
                            });
                    } else {
                        // For EC2: Verify directory exists
                        this.executeCommand(`[ -d "${this.folderPath}" ] && echo "Directory exists" || echo "Directory does not exist"`)
                            .then(result => {
                                if (result.output.includes("Directory exists")) {
                                    //console.log(`Working directory set to: ${this.folderPath}`);
                                } else {
                                    console.warn(`Warning: Directory ${this.folderPath} does not exist on the remote server.`);
                                }
                                if (resolve) resolve();
                            });
                    }
                } else {
                    if (resolve) resolve();
                }
            })
            .on('error', (err) => {
                const errorMsg = this._formatError(err);
                console.error('SSH connection error:', errorMsg);
                this.isConnected = false;

                // Instead of rejecting, resolve with an error status
                if (resolve) {
                    resolve({
                        success: false,
                        output: '',
                        error: errorMsg,
                        message: 'Failed to establish SSH connection'
                    });
                }

                this._attemptReconnect();
            })
            .on('close', () => {
                //console.log('SSH connection closed');
                this.isConnected = false;

                // Clear the activity check interval
                if (this.activityCheckInterval) {
                    clearInterval(this.activityCheckInterval);
                    this.activityCheckInterval = null;
                }

               // this._attemptReconnect();
            })
            .on('end', () => {
                //console.log('SSH connection ended');
                this.isConnected = false;

                // Clear the activity check interval
                if (this.activityCheckInterval) {
                    clearInterval(this.activityCheckInterval);
                    this.activityCheckInterval = null;
                }

              //  this._attemptReconnect();
            })
            .connect(this.config);
    }

    // Helper method to format errors properly
    private _formatError(err: any): string {
        if (!err) return 'Unknown error';

        if (typeof err === 'string') return err;

        if (err instanceof Error) {
            return err.stack || err.message || String(err);
        }

        if (err.error) {
            // Handle our custom error objects
            return typeof err.error === 'string' ? err.error : this._formatError(err.error);
        }

        try {
            return JSON.stringify(err, null, 2);
        } catch (e) {
            return String(err);
        }
    }

    private _attemptReconnect(): void {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

            //console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay/1000} seconds...`);

            setTimeout(() => {
                //console.log(`Reconnecting now (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                this.client = new Client(); // Create a new client instance
                this._setupConnection();
            }, delay);
        } else {
            console.error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts.`);
        }
    }

    private _checkActivity(): void {
        const inactiveTime = (Date.now() - this.lastActivity) / 1000 / 60; // in minutes
        //console.log(`SSH connection inactive for ${inactiveTime.toFixed(1)} minutes`);

        // If inactive for more than 55 minutes, send a keepalive command
        if (inactiveTime > 55) {
            //console.log('Sending keepalive command to prevent timeout...');
            this.executeCommand('echo "keepalive"')
                .then(() => {
                    //console.log('Keepalive command successful');
                });
        }
    }

    /**
     * Execute a command directly on the EC2 host without attempting to run it in a Docker container
     * @param {string} command - The command to execute on the EC2 host
     * @returns {Promise<CommandResult>} - Promise resolving to the command execution result
     */
    executeHostCommand(command: string): Promise<CommandResult> {
        return new Promise((resolve) => {
            // Update last activity timestamp
            this.lastActivity = Date.now();

            if (!this.isConnected) {
                // Try to reconnect and then execute the command
                this.connect()
                    .then(() => {
                        // Retry the command after successful reconnection
                        this.executeHostCommand(command)
                            .then(result => resolve(result));
                    })
                    .catch(err => {
                        // Instead of rejecting, resolve with error information
                        resolve({
                            success: false,
                            output: '',
                            error: `Failed to reconnect: ${this._formatError(err)}`,
                            command: command,
                            code: -1
                        });
                    });

                return;
            }

            // Execute directly on EC2 host without Docker wrapping
            command = this.folderPath ? 
`cd "${this.folderPath}" 2>/dev/null && ${command}`
                : command;
            this.client.exec(command, (err, stream) => {
                if (err) {
                    // If there's an error executing the command, it might be due to a broken connection
                    this.isConnected = false;

                    // Instead of rejecting, resolve with error information
                    resolve({
                        success: false,
                        output: '',
                        error: this._formatError(err),
                        command: command,
                        code: -1
                    });
                    return;
                }

                let output = '';
                let errorOutput = '';
                let timeoutOccurred = false;

                // Set up 2-minute timeout
                const timeout = setTimeout(() => {
                    timeoutOccurred = true;
                    stream.destroy();
                    resolve({
                        success: false,
                        output: output,
                        error: 'Command execution timeout: The command is taking longer than 2 minutes. Please try using background tasks for long-running operations.',
                        command: command,
                        code: -2
                    });
                }, 120000); // 2 minutes

                stream
                    .on('data', (data: Buffer) => {
                        const chunk = data.toString();
                        output += chunk;

                        // Update last activity timestamp
                        this.lastActivity = Date.now();
                    })
                    .on('close', (code: number) => {
                        // Clear timeout if command completes
                        clearTimeout(timeout);
                        
                        // Don't resolve if timeout already occurred
                        if (timeoutOccurred) return;

                        // Update last activity timestamp
                        this.lastActivity = Date.now();

                        const combinedOutput = output + (errorOutput ? '\n' + errorOutput : '');

                        resolve({
                            success: code === 0,
                            output: combinedOutput,
                            error: errorOutput,
                            command: command,
                            code: code
                        });
                    })
                    .stderr.on('data', (data: Buffer) => {
                        const chunk = data.toString();
                        errorOutput += chunk;

                        // Update last activity timestamp
                        this.lastActivity = Date.now();
                    });
            });
        });
    }

    executeCommand(command: string, socket?: any): Promise<CommandResult> {
        return new Promise((resolve) => {
            // Update last activity timestamp
            this.lastActivity = Date.now();

            if (!this.isConnected) {
                //console.log('SSH client is not connected. Attempting to reconnect...');

                // Try to reconnect and then execute the command
                this.connect()
                    .then(() => {
                        // Retry the command after successful reconnection
                        this.executeCommand(command, socket)
                            .then(result => resolve(result));
                    })
                    .catch(err => {
                        // Instead of rejecting, resolve with error information
                        resolve({
                            success: false,
                            output: '',
                            error: `Failed to reconnect: ${this._formatError(err)}`,
                            command: command,
                            code: -1
                        });
                    });

                return;
            }

            // Construct the command based on environment
            let fullCommand: string;

            if (this.environment === ExecutionEnvironment.DOCKER && this.folderPath) {
                // For Docker: Execute in container
                const containerName = path.basename(this.folderPath);
                command = `cd /app 2>/dev/null && ${command}`;
                const escapedCommand = command.replace(/'/g, "'\\''");

                fullCommand = `sudo /usr/bin/docker exec -i ${containerName} bash -c '${escapedCommand}'`;
            } else {
                // For EC2: Execute with cd prefix if folder path provided
                fullCommand = this.folderPath
                    ? `cd "${this.folderPath}" 2>/dev/null && ${command}`
                    : command;
            }

            this.client.exec(fullCommand, (err, stream) => {
                if (err) {
                    // If there's an error executing the command, it might be due to a broken connection
                    this.isConnected = false;

                    // Instead of rejecting, resolve with error information
                    resolve({
                        success: false,
                        output: '',
                        error: this._formatError(err),
                        command: command,
                        code: -1
                    });
                    return;
                }

                let output = '';
                let errorOutput = '';
                let timeoutOccurred = false;

                // Set up 2-minute timeout
                const timeout = setTimeout(() => {
                    timeoutOccurred = true;
                    stream.destroy();
                    
                    // Send timeout notification to socket if available
                    if (socket) {
                        socket.emit('thinking_response2', { 
                            data: '\n[TIMEOUT] Command execution exceeded 2 minutes\n', 
                            error: true 
                        });
                    }
                    
                    resolve({
                        success: false,
                        output: output,
                        error: 'Command execution timeout: The command is taking longer than 2 minutes. Please try using background tasks for long-running operations.',
                        command: command,
                        code: -2
                    });
                }, 120000); // 2 minutes

                stream
                    .on('data', (data: Buffer) => {
                        const chunk = data.toString();
                        //process.stdout.write(chunk); // Stream output in real-time

                        if (socket) {
                            socket.emit('thinking_response2', { data: chunk });
                        }

                        output += chunk;

                        // Update last activity timestamp
                        this.lastActivity = Date.now();
                    })
                    .on('close', (code: number) => {
                        // Clear timeout if command completes
                        clearTimeout(timeout);
                        
                        // Don't resolve if timeout already occurred
                        if (timeoutOccurred) return;

                        // Update last activity timestamp
                        this.lastActivity = Date.now();

                        const combinedOutput = output + (errorOutput ? '\n' + errorOutput : '');

                        resolve({
                            success: code === 0,
                            output: combinedOutput,
                            error: errorOutput,
                            command: command,
                            code: code
                        });
                    })
                    .stderr.on('data', (data: Buffer) => {
                        const chunk = data.toString();
                        //  process.stderr.write(chunk); // Stream error output in real-time

                        // Optionally, send error output to the client via the socket
                        if (socket) {
                            socket.emit('thinking_response2', { data: chunk, error: true });
                        }

                        errorOutput += chunk;

                        // Update last activity timestamp
                        this.lastActivity = Date.now();
                    });
            });
        });
    }

    disconnect(): void {
        // Clear the activity check interval
        if (this.activityCheckInterval) {
            clearInterval(this.activityCheckInterval);
            this.activityCheckInterval = null;
        }

        // Terminate all background processes
        Object.keys(this.backgroundProcesses).forEach(id => {
            const processInfo = this.backgroundProcesses[id];
            const processId = parseInt(id, 10);

            // Try to terminate the process if it's still running
            if (processInfo.status === 'running' && processInfo.pid) {
                try {
                    if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                        const containerName = path.basename(this.folderPath);
                        // Kill process inside the Docker container
                        this.executeHostCommand(`sudo docker exec -i ${containerName} bash -c "kill -9 $(cat ${processInfo.pid}) || true"`);

                        // Clean up the log file inside the container
                        this.executeHostCommand(`sudo docker exec -i ${containerName} bash -c "rm -f /tmp/bg-process-${processId}.log || true"`);
                    } else {
                        // For EC2: Use standard process termination
                        this.executeCommand(`pkill -P $(cat ${processInfo.pid}) || true; kill -9 $(cat ${processInfo.pid}) || true`);
                        this.executeCommand(`rm -f /tmp/bg-process-${processId}.log || true`);
                    }
                } catch (err) {
                    // Ignore errors during cleanup
                }
            } else {
                // Even if the process is not running, clean up its log file
                try {
                    if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                        const containerName = path.basename(this.folderPath);
                        this.executeHostCommand(`sudo docker exec -i ${containerName} bash -c "rm -f /tmp/bg-process-${processId}.log || true"`);
                    } else {
                        this.executeCommand(`rm -f /tmp/bg-process-${processId}.log || true`);
                    }
                } catch (err) {
                    // Ignore errors during cleanup
                }
            }

            // Clean up clients
            if (processInfo.client) processInfo.client.end();
            if (processInfo.monitorClient) processInfo.monitorClient.end();
        });

        if (this.isConnected) {
            this.client.end();
            this.isConnected = false;
            //console.log('SSH connection manually disconnected');
        }
    }

    /**
     * Execute a command in the background, allowing other commands to be executed in parallel
     * @param {string} command - The command to execute
     * @param {any} socket - Optional socket for real-time output
     * @param {string} processName - Optional name for the process (for easier reference)
     * @returns {Promise<BackgroundProcessStartResult>} - Object containing process ID and initial status
     */
    executeBackgroundCommand(command: string, socket?: any, processName: string = ''): Promise<BackgroundProcessStartResult> {
        return new Promise((resolve, reject) => {
            // Update last activity timestamp
            this.lastActivity = Date.now();

            if (!this.isConnected) {
                this.connect()
                    .then(() => {
                        this.executeBackgroundCommand(command, socket, processName)
                            .then(result => resolve(result))
                            .catch(err => reject(err));
                    })
                    .catch(err => {
                        reject(new Error(`Failed to reconnect: ${this._formatError(err)}`));
                    });
                return;
            }

            // Create a new SSH connection for this background process
            const bgClient = new Client();
            const processId = this.nextProcessId++;
            const processInfo: ProcessInfo = {
                id: processId,
                name: processName || `process-${processId}`,
                command,
                client: bgClient,
                startTime: new Date(),
                status: 'starting',
                output: '',
                errorOutput: '',
                exitCode: null,
                socket,
                isDockerProcess: this.environment === ExecutionEnvironment.DOCKER && !!this.folderPath
            };

            // Store the process info
            this.backgroundProcesses[processId.toString()] = processInfo;

            bgClient
                .on('ready', () => {
                    const logFilePath = `/tmp/bg-process-${processId}.log`;
                    const pidFilePath = `/tmp/bg-process-${processId}.pid`;
                    let backgroundCommand: string;

                    if (this.environment === ExecutionEnvironment.DOCKER && this.folderPath) {
                        // For Docker: Execute the command inside the container and capture its PID
                        const containerName = path.basename(this.folderPath);

                        command = `cd /app 2>/tmp/error-log.txt && ${command}`;

                        const escapedCommand = command.replace(/'/g, "'\\''");
                        backgroundCommand = `sudo docker exec -i ${containerName} bash -c '${escapedCommand} > ${logFilePath} 2>&1 & echo $! > ${pidFilePath}'`;

                    } else {
                        // For EC2: Use standard background execution
                        // If folder path is specified, prepend cd command
                        const fullCommand = this.folderPath
                            ? `cd "${this.folderPath}" 2>/dev/null && ${command}`
                            : command;

                        backgroundCommand = `nohup bash -c '${fullCommand.replace(/'/g, "'\\''")}' > "${logFilePath}" 2>&1 & echo $! > "${pidFilePath}"`;
                    }

                    bgClient.exec(backgroundCommand, (err, stream) => {
                        if (err) {
                            processInfo.status = 'error';
                            processInfo.errorOutput = this._formatError(err);

                            // Clean up the client
                            bgClient.end();

                            resolve({
                                success: false,
                                processId,
                                error: processInfo.errorOutput,
                                message: 'Failed to start background process'
                            });
                            return;
                        }

                        let pidOutput = '';

                        stream
                            .on('data', (data: Buffer) => {
                                pidOutput += data.toString().trim();
                            })
                            .on('close', async (code: number) => {
                                if (code === 0) {
                                    // Successfully started the background process
                                    //getting the pid from the pid file
                                    let pid_result = await this.executeCommand(`cat ${pidFilePath}`);


                                    processInfo.pid = pid_result.output.trim();
                                    processInfo.status = 'running';
                                    processInfo.logFilePath = logFilePath;
                                    processInfo.processIdPath = pidFilePath;

                                    // Start monitoring the process output only if a socket is provided for real-time updates
                                    if (socket) {
                                        this._monitorBackgroundProcess(processId);
                                    }

                                    const envType = this.environment === ExecutionEnvironment.DOCKER ? 'Docker container' : 'EC2';
                                    resolve({
                                        success: true,
                                        processId,
                                        pid: processInfo.pid,
                                        name: processInfo.name,
                                        message: `Background process started with PID  ${processInfo.pid} in ${envType}`
                                    });
                                } else {
                                    processInfo.status = 'error';
                                    processInfo.exitCode = code;

                                    // Clean up the client
                                    bgClient.end();

                                    resolve({
                                        success: false,
                                        processId,
                                        error: `Failed to start background process (exit code: ${code})`,
                                        output: pidOutput
                                    });
                                }
                            })
                            .stderr.on('data', (data: Buffer) => {
                                const errorData = data.toString();
                                processInfo.errorOutput += errorData;

                                if (socket) {
                                    socket.emit('thinking_response2', { data: errorData, error: true });
                                }
                            });
                    });
                })
                .on('error', (err) => {
                    processInfo.status = 'error';
                    processInfo.errorOutput = this._formatError(err);

                    resolve({
                        success: false,
                        processId,
                        error: processInfo.errorOutput,
                        message: 'Failed to establish SSH connection for background process'
                    });
                })
                .connect(this.config);
        });
    }

    /**
     * Monitor the output of a background process
     * @param {number} processId - The ID of the process to monitor
     * @private
     */
    private _monitorBackgroundProcess(processId: number): void {
        const processInfo = this.backgroundProcesses[processId.toString()];
        if (!processInfo || processInfo.status !== 'running') return;

        // Create a new client for monitoring
        const monitorClient = new Client();
        processInfo.monitorClient = monitorClient;

        monitorClient
            .on('ready', () => {
                let monitorCommand: string;

                if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                    // For Docker: Monitor the process inside the container`
                    const containerName = path.basename(this.folderPath);
                    monitorCommand = `sudo /usr/bin/docker exec -i ${containerName} bash -c 'tail -f ${processInfo.logFilePath} & PID=${processInfo.pid}; while ps -p \$PID > /dev/null 2>&1; do sleep 1; done; echo "Process terminated"'`;
                } else {
                    // For EC2: Standard process monitoring
                    monitorCommand = `tail -f ${processInfo.logFilePath} & PID=${processInfo.pid}; (ps -p $PID > /dev/null || echo "Process terminated") && sleep 1`;
                }

                monitorClient.exec(monitorCommand, (err, stream) => {
                    if (err) {
                        processInfo.errorOutput += `\nMonitoring error: ${this._formatError(err)}`;
                        monitorClient.end();
                        return;
                    }

                    stream
                        .on('data', (data: Buffer) => {
                            const output = data.toString();
                            processInfo.output += output;

                            // Send output to socket if available
                            if (processInfo.socket) {
                                processInfo.socket.emit('thinking_response2', {
                                    data: output,
                                    processId,
                                    processName: processInfo.name
                                });
                            }

                            // Check if the process has terminated
                            if (output.includes('Process terminated')) {
                                processInfo.status = 'completed';
                                monitorClient.end();
                            }
                        })
                        .on('close', () => {
                            // The monitoring command has ended
                            // This might happen if the tail command is interrupted
                            // We'll check if the process is still running
                            this._checkProcessStatus(processId);
                        })
                        .stderr.on('data', (data: Buffer) => {
                            const errorData = data.toString();
                            processInfo.errorOutput += errorData;

                            if (processInfo.socket) {
                                processInfo.socket.emit('thinking_response2', {
                                    data: errorData,
                                    error: true,
                                    processId,
                                    processName: processInfo.name
                                });
                            }
                        });
                });
            })
            .on('error', (err) => {
                processInfo.errorOutput += `\nMonitoring connection error: ${this._formatError(err)}`;
            })
            .connect(this.config);
    }

    /**
     * Check if a background process is still running
     * @param {number} processId - The ID of the process to check
     * @returns {Promise<boolean>} - True if the process is running, false otherwise
     * @private
     */
    _checkProcessStatus(processId: number): Promise<boolean> {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId.toString()];
            if (!processInfo || !processInfo.pid) {
                resolve(false);
                return;
            }

            let command: string;
            if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                // For Docker: Check process status inside the container
                const containerName = path.basename(this.folderPath);
                command = `sudo /usr/bin/docker exec -i ${containerName} bash -c "ps -p ${processInfo.pid} > /dev/null && echo 'running' || echo 'terminated'"`;
            } else {
                // For EC2: Standard process status check
                command = `ps -p ${processInfo.pid} > /dev/null && echo "running" || echo "terminated"`;
            }

            this.executeHostCommand(command)
                .then(result => {
                    const isRunning = result.output.trim() === 'running';
                    if (!isRunning && processInfo.status === 'running') {
                        processInfo.status = 'completed';

                        // Clean up the monitor client if it exists
                        if (processInfo.monitorClient) {
                            processInfo.monitorClient.end();
                        }
                    }
                    resolve(isRunning);
                })
                .catch(() => {
                    resolve(false);
                });
        });
    }

    /**
     * Terminate a background process
     * @param {number} processId - The ID of the process to terminate
     * @returns {Promise<TerminationResult>} - Result of the termination attempt
     */
    terminateBackgroundProcess(processId: number): Promise<TerminationResult> {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId.toString()];
            if (!processInfo || !processInfo.pid) {
                resolve({
                    success: false,
                    message: `Process with ID ${processId} not found or has no PID`
                });
                return;
            }

            // First check if the process is still running
            this._checkProcessStatus(processId)
                .then(isRunning => {
                    if (!isRunning) {
                        // Process is already terminated, but we still need to clean up the log file
                        this.cleanupBackgroundProcessLog(processId)
                            .then(cleanupResult => {
                                resolve({
                                    success: true,
                                    message: `Process ${processId} is already terminated`,
                                    logCleanup: cleanupResult
                                });
                            });
                        return;
                    }

                    let killCommand: string;
                    if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                        // For Docker: Kill the process inside the container and all its descendants
                        const containerName = path.basename(this.folderPath);
                        killCommand = `sudo docker exec -i ${containerName} bash -c 'PID=${processInfo.pid}; descendants=(); queue=("\$PID"); while [ \${#queue[@]} -gt 0 ]; do p="\${queue[0]}"; queue=("\${queue[@]:1}"); for c in \$(pgrep -P "\$p" || true); do descendants+=("\$c"); queue+=("\$c"); done; done; if [ \${#descendants[@]} -gt 0 ]; then printf "%s\\n" "\${descendants[@]}" | xargs -r kill -9 2>/dev/null || true; fi; kill -9 "\$PID" 2>/dev/null && rm -f ${processInfo.processIdPath} || true'`;
                    } else {
                        // For EC2: Kill all descendant processes recursively then the parent
                        killCommand = `sudo bash -c 'PID=${processInfo.pid}; descendants=(); queue=("\$PID"); while [ \${#queue[@]} -gt 0 ]; do p="\${queue[0]}"; queue=("\${queue[@]:1}"); for c in \$(pgrep -P "\$p" || true); do descendants+=("\$c"); queue+=("\$c"); done; done; if [ \${#descendants[@]} -gt 0 ]; then printf "%s\\n" "\${descendants[@]}" | xargs -r kill -9 2>/dev/null || true; fi; kill -9 "\$PID" 2>/dev/null && rm -f ${processInfo.processIdPath} || true'`;
                    }

                    // Kill the process
                    this.executeHostCommand(killCommand)
                        .then(() => {
                            // Verify the process was terminated
                            setTimeout(() => {
                                this._checkProcessStatus(processId)
                                    .then(stillRunning => {
                                        if (stillRunning) {
                                            // Try a more forceful termination
                                            let forceKillCommand: string;
                                            if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                                                // Force kill inside Docker container and all its descendants
                                                const containerName = path.basename(this.folderPath);
                                                forceKillCommand = `sudo /usr/bin/docker exec -i ${containerName} bash -c 'PID=${processInfo.pid}; descendants=(); queue=("\$PID"); while [ \${#queue[@]} -gt 0 ]; do p="\${queue[0]}"; queue=("\${queue[@]:1}"); for c in \$(pgrep -P "\$p" || true); do descendants+=("\$c"); queue+=("\$c"); done; done; if [ \${#descendants[@]} -gt 0 ]; then printf "%s\\n" "\${descendants[@]}" | xargs -r kill -9 2>/dev/null || true; fi; kill -9 "\$PID" 2>/dev/null && rm -f ${processInfo.processIdPath} || true'`;
                                            } else {
                                                // For EC2: Force kill all descendant processes recursively then the parent
                                                forceKillCommand = `sudo bash -c 'PID=${processInfo.pid}; descendants=(); queue=("\$PID"); while [ \${#queue[@]} -gt 0 ]; do p="\${queue[0]}"; queue=("\${queue[@]:1}"); for c in \$(pgrep -P "\$p" || true); do descendants+=("\$c"); queue+=("\$c"); done; done; if [ \${#descendants[@]} -gt 0 ]; then printf "%s\\n" "\${descendants[@]}" | xargs -r kill -9 2>/dev/null || true; fi; kill -9 "\$PID" 2>/dev/null && rm -f ${processInfo.processIdPath} || true'`;
                                            }

                                            this.executeCommand(forceKillCommand)
                                                .then(() => {
                                                    processInfo.status = 'terminated';

                                                    // Clean up clients
                                                    if (processInfo.client) processInfo.client.end();
                                                    if (processInfo.monitorClient) processInfo.monitorClient.end();
                                                    // Clean up the log file
                                                    this.cleanupBackgroundProcessLog(processId)
                                                        .then(cleanupResult => {
                                                            resolve({
                                                                success: true,
                                                                message: `Process ${processId} forcefully terminated`,
                                                                logCleanup: cleanupResult
                                                            });
                                                        });
                                                });
                                        } else {
                                            processInfo.status = 'terminated';

                                            // Clean up clients
                                            if (processInfo.client) processInfo.client.end();
                                            if (processInfo.monitorClient) processInfo.monitorClient.end();

                                            // Clean up the log file
                                            this.cleanupBackgroundProcessLog(processId)
                                                .then(cleanupResult => {
                                                    resolve({
                                                        success: true,
                                                        message: `Process ${processId} terminated successfully`,
                                                        logCleanup: cleanupResult
                                                    });
                                                });
                                        }
                                    });
                            }, 500); // Wait a bit for the process to terminate
                        })
                        .catch(err => {
                            resolve({
                                success: false,
                                error: this._formatError(err),
                                message: `Failed to terminate process ${processId}`
                            });
                        });
                });
        });
    }

    /**
     * Get information about all background processes
     * @returns {Record<string, ProcessStatus>} - Object containing information about all background processes
     */
    getBackgroundProcesses(): Record<string, ProcessStatus> {
        const processes: Record<string, ProcessStatus> = {};

        // Create a simplified version of the process info for each process
        Object.keys(this.backgroundProcesses).forEach(id => {
            const process = this.backgroundProcesses[id];
            processes[id] = {
                id: parseInt(id, 10),
                name: process.name,
                command: process.command,
                pid: process.pid,
                status: process.status,
                startTime: process.startTime,
                outputLength: process.output.length,
                errorOutputLength: process.errorOutput.length,
                isDockerProcess: process.isDockerProcess,
                environment: process.isDockerProcess ? 'Docker' : 'EC2'
            };
        });

        return processes;
    }

    /**
     * Clean up the log file for a background process
     * @param {number} processId - The ID of the process
     * @returns {Promise<LogCleanupResult>} - Promise resolving to the result of the cleanup operation
     */
    cleanupBackgroundProcessLog(processId: number): Promise<LogCleanupResult> {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId.toString()];
            if (!processInfo) {
                resolve({
                    success: false,
                    message: `Process with ID ${processId} not found`
                });
                return;
            }

            const logFilePath = `/tmp/bg-process-${processId}.log`;
            let command: string;

            if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                // For Docker: Delete the log file inside the container
                const containerName = path.basename(this.folderPath);
                command = `sudo /usr/bin/docker exec -i ${containerName} bash -c 'if [ -f "${logFilePath}" ]; then rm "${logFilePath}" && echo "Log file deleted" || echo "Failed to delete log file"; else echo "Log file not found"; fi'`;
            } else {
                // For EC2: Standard log file cleanup
                command = `if [ -f "${logFilePath}" ]; then rm "${logFilePath}" && echo "Log file deleted" || echo "Failed to delete log file"; else echo "Log file not found"; fi`;
            }

            // Check if the log file exists and delete it
            this.executeHostCommand(command)
                .then(result => {
                    const output = result.output.trim();

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
                })
                .catch(err => {
                    resolve({
                        success: false,
                        id: processId,
                        name: processInfo.name,
                        error: this._formatError(err),
                        message: `Error while trying to delete log file for process ${processId}`
                    });
                });
        });
    }

    /**
     * Get the size of a background process's log file
     * @param {number} processId - The ID of the process
     * @returns {Promise<LogSizeResult>} - Promise resolving to an object containing the log file size information
     */
    getBackgroundProcessLogSize(processId: number): Promise<LogSizeResult> {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId.toString()];
            if (!processInfo) {
                resolve({
                    success: false,
                    message: `Process with ID ${processId} not found`
                });
                return;
            }

            // Check the log file size
            const logFilePath = `/tmp/bg-process-${processId}.log`;
            let command: string;

            if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                // For Docker: Check log file size inside the container
                const containerName = path.basename(this.folderPath);
                command = `sudo /usr/bin/docker exec -i ${containerName} bash -c 'if [ -f "${logFilePath}" ]; then du -h "${logFilePath}" | cut -f1; wc -l "${logFilePath}" | cut -d" " -f1; else echo "Log file not found"; fi'`;
            } else {
                // For EC2: Standard log file size check
                command = `if [ -f "${logFilePath}" ]; then du -h "${logFilePath}" | cut -f1; wc -l "${logFilePath}" | cut -d" " -f1; else echo "Log file not found"; fi`;
            }

            this.executeHostCommand(command)
                .then(result => {
                    const output = result.output.trim().split('\n');
                    if (output[0] === 'Log file not found') {
                        resolve({
                            success: false,
                            id: processId,
                            name: processInfo.name,
                            message: 'Log file not found'
                        });
                        return;
                    }

                    const fileSize = output[0];
                    const lineCount = parseInt(output[1], 10);

                    resolve({
                        success: true,
                        id: processId,
                        name: processInfo.name,
                        fileSize,
                        lineCount,
                        logFilePath,
                        environment: this.environment,
                        isDockerProcess: processInfo.isDockerProcess
                    });
                })
                .catch(err => {
                    resolve({
                        success: false,
                        id: processId,
                        name: processInfo.name,
                        error: this._formatError(err),
                        message: `Failed to get log file size for process ${processId}`
                    });
                });
        });
    }

    /**
     * Get the output of a background process by reading directly from the log file
     * @param {number} processId - The ID of the process
     * @param {number} maxLines - Maximum number of lines to retrieve (0 for all lines)
     * @param {boolean} tailMode - If true, get the last maxLines, otherwise get from the beginning
     * @returns {Promise<ProcessOutputResult>} - Promise resolving to an object containing the process output and status
     */
    getBackgroundProcessOutput(processId: number, maxLines: number = 0, tailMode: boolean = true): Promise<ProcessOutputResult> {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId.toString()];
            if (!processInfo) {
                resolve({
                    success: false,
                    message: `Process with ID ${processId} not found`
                });
                return;
            }

            // Check if the log file exists
            const logFilePath = `/tmp/bg-process-${processId}.log`;

            // Construct the command to read the log file
            let readCommand: string;
            if (maxLines > 0) {
                // If maxLines is specified, use head or tail based on tailMode
                readCommand = tailMode
                    ? `tail -n ${maxLines} ${logFilePath}`
                    : `head -n ${maxLines} ${logFilePath}`;
            } else {
                // If maxLines is 0 or not specified, read the entire file
                readCommand = `cat ${logFilePath}`;
            }

            let command: string;
            if (this.environment === ExecutionEnvironment.DOCKER && processInfo.isDockerProcess) {
                // For Docker: Read log file inside the container
                const containerName = path.basename(this.folderPath);
                command = `sudo /usr/bin/docker exec -i ${containerName} bash -c 'if [ -f "${logFilePath}" ]; then ${readCommand}; else echo "Log file not found"; fi'`;
            } else {
                // For EC2: Standard log file reading
                command = `if [ -f "${logFilePath}" ]; then ${readCommand}; else echo "Log file not found"; fi`;
            }

            // Execute the command to read the log file
            this.executeHostCommand(command)
                .then(result => {
                    // Check if the process is still running
                    this._checkProcessStatus(processId)
                        .then(isRunning => {
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
                                output: result.output,
                                errorOutput: processInfo.errorOutput, // Keep any error output that was captured during startup
                                isLogFileRead: true,
                                maxLines: maxLines,
                                tailMode: tailMode,
                                environment: this.environment,
                                isDockerProcess: processInfo.isDockerProcess
                            });
                        });
                })
                .catch(err => {
                    resolve({
                        success: false,
                        id: processId,
                        name: processInfo.name,
                        error: this._formatError(err),
                        message: `Failed to read log file for process ${processId}`
                    });
                });
        });
    }
}

// Example usage with comprehensive tests
// (async () => {
//     await main();
// })();
export { SSHClientCombined };
