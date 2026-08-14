
const { Client } = require('ssh2');
const fs = require('fs');
require('dotenv').config();
const path = require('path');
const { Logger } = require('../utils/Logger');

class SSHClient {
    constructor(folderPath, ec2_instance_ip, options = {}) {
        this.logger = new Logger('SSHClient');
        this.folderPath = folderPath;
        this.ec2_instance_ip = ec2_instance_ip;
        this.config = {
            host: ec2_instance_ip,
            username: 'ubuntu', // default for Amazon Linux AMIs
            privateKey: fs.readFileSync(process.env.SSH_KEY_PATH,'utf8' ),
            keepaliveInterval: 60000, // Send keepalive packet every 60 seconds
            keepaliveCountMax: 60, // Allow up to 60 missed keepalives (60 minutes)
            readyTimeout: options.readyTimeout || 60000 // 60 second timeout for initial connection
        };

        this.client = new Client();
        this.isConnected = false;
        this.reconnectAttempts = 0;
        // Make maxReconnectAttempts configurable with default of 5
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
        // Make reconnectDelay configurable with default of 10 seconds
        this.reconnectDelay = options.reconnectDelay || 10000;
        // Support for exponential backoff
        this.useExponentialBackoff = options.useExponentialBackoff || false;
        this.lastActivity = Date.now();
        this.activityCheckInterval = null;
        this.backgroundProcesses = {}; // Track background processes by ID
        this.nextProcessId = 1; // Counter for generating unique process IDs
    }


    /**
     * Check if SSH port (22) is reachable on the host
     * This is a lightweight check before attempting full SSH connection
     * @param {number} timeout - Timeout in milliseconds (default: 5000)
     * @returns {Promise<boolean>} - True if port is reachable, false otherwise
     */
    async isPortReachable(timeout = 5000) {
        return new Promise((resolve) => {
            const net = require('net');
            const socket = new net.Socket();
            
            let isResolved = false;
            
            const cleanup = () => {
                if (!isResolved) {
                    isResolved = true;
                    socket.destroy();
                }
            };
            
            socket.setTimeout(timeout);
            
            socket.on('connect', () => {
                cleanup();
                resolve(true);
            });
            
            socket.on('timeout', () => {
                cleanup();
                resolve(false);
            });
            
            socket.on('error', () => {
                cleanup();
                resolve(false);
            });
            
            socket.connect(22, this.ec2_instance_ip);
        });
    }


    /**
     * Check if SSH port (22) is reachable on the host
     * @param {number} timeout - Timeout in milliseconds (default: 5000)
     * @returns {Promise<boolean>} - True if port is reachable, false otherwise
     */
    async isPortReachable(timeout = 5000) {
        return new Promise((resolve) => {
            const net = require('net');
            const socket = new net.Socket();
            
            let isResolved = false;
            
            const cleanup = () => {
                if (!isResolved) {
                    isResolved = true;
                    socket.destroy();
                }
            };
            
            socket.setTimeout(timeout);
            
            socket.on('connect', () => {
                cleanup();
                resolve(true);
            });
            
            socket.on('timeout', () => {
                cleanup();
                resolve(false);
            });
            
            socket.on('error', () => {
                cleanup();
                resolve(false);
            });
            
            socket.connect(22, this.ec2_instance_ip);
        });
    }
    //function to check if a directory exists if not then it will create that dir
    async ensureDirectoryExists(dirPath) {
        return new Promise((resolve, reject) => {
            this.executeCommand(`[ -d "${dirPath}" ] && echo "exists" || echo "fuck"`)


                .then(result => {
                    if (result.output.includes("exists")) {
                        // Directory exists, set permissions to 777
                        this.executeCommand(`sudo chmod 777 "${dirPath}"`)
                            .then(chmodResult => {
                                if (chmodResult.success) {
                                    resolve(true);
                                } else {
                                    reject(new Error(`Failed to set permissions: ${chmodResult.error}`));
                                }
                            })
                            .catch(err => reject(err));
                    } else {
                        // Directory does not exist, create it and set permissions
                        this.executeCommand(`sudo mkdir -p "${dirPath}"`)
                            .then(mkdirResult => {
                                if (mkdirResult.success) {
                                    // Set permissions to 777 after creating directory
                                    this.executeCommand(`sudo chmod 777 "${dirPath}"`)
                                        .then(chmodResult => {
                                            if (chmodResult.success) {
                                                resolve(true);
                                            } else {
                                                reject(new Error(`Failed to set permissions: ${chmodResult.error}`));
                                            }
                                        })
                                        .catch(err => reject(err));
                                } else {
                                    reject(new Error(`Failed to create directory: ${mkdirResult.error}`));
                                }
                            })
                            .catch(err => reject(err));
                    }   
                });
        });
    }

    async connect() {
        return new Promise((resolve) => {
            // Reset reconnect attempts on manual connect
            this.reconnectAttempts = 0;
            
            this._setupConnection(resolve);
        });
    }
    
    _setupConnection(resolve) {
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
                
                // If a folder path is specified, verify it exists
                if (this.folderPath) {
                    this.executeCommand(`[ -d "${this.folderPath}" ] && echo "Directory exists" || echo "Directory does not exist"`)
                        .then(result => {
                            if (result.output.includes("Directory exists")) {
                                //console.log(`Working directory set to: ${this.folderPath}`);
                            } else {
                                this.logger.warn(`Directory ${this.folderPath} does not exist on remote server`);
                            }
                            if (resolve) resolve();
                        });
                } else {
                    if (resolve) resolve();
                }
            })
            .on('error', (err) => {
                const errorMsg = this._formatError(err);
                this.logger.error('SSH connection error', errorMsg," the ec2 instance ip that it is trying to connect is==>",this.ec2_instance_ip);
                this.isConnected = false;
                
                // Instead of rejecting, resolve with an error status
                if (resolve) {
                    resolve({
                        success: false,
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
                
             //   this._attemptReconnect();
            })
            .connect(this.config);
    }
    
    // Helper method to format errors properly
    _formatError(err) {
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
    
    _attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            
            // Use exponential backoff if enabled, otherwise fixed delay
            let delay = this.reconnectDelay;
            if (this.useExponentialBackoff) {
                // Exponential backoff: delay increases with each attempt
                // Formula: baseDelay * (2 ^ (attempt - 1))
                // E.g., with 10s base: 10s, 20s, 40s, 80s, 160s...
                delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
                // Cap maximum delay at 120 seconds
                delay = Math.min(delay, 120000);
            }
            
            //this.logger.warn(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay/1000} seconds...`);
            
            setTimeout(() => {
              //  this.logger.info(`Reconnecting now (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                this.client = new Client(); // Create a new client instance
                this._setupConnection();
            }, delay);
        } else {
            this.logger.error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts to ${this.ec2_instance_ip}`);
        }
    }
    
    _checkActivity() {
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
    
    executeCommand(command, socket) {
        try {
            // Update last activity timestamp
            this.lastActivity = Date.now();
            
            return new Promise((resolve) => {
                // Check if client exists and is connected
                if (!this.isConnected || !this.client) {
                    //console.log('SSH client is not connected. Attempting to reconnect...');
                    
                    // Try to reconnect and then execute the command
                    this.connect()
                        .then(() => {
                            // Retry the command after successful reconnection
                            this.executeCommand(command, socket)
                                .then(resolve)
                                .catch(err => {
                                    resolve({
                                        success: false,
                                        output: '',
                                        error: `Failed to execute after reconnect: ${this._formatError(err)}`,
                                        command: command,
                                        code: -1
                                    });
                                });
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
                
                // Add sudo to the command if it doesn't already start with sudo
                const sudoCommand = command;
                
                // If folder path is specified, prepend cd command
                const fullCommand = this.folderPath 
                    ? `cd "${this.folderPath}" 2>/dev/null && ${sudoCommand}`
                    : sudoCommand;
                
                // Wrap exec call in try-catch to handle synchronous errors
                try {
                    this.client.exec(fullCommand, (err, stream) => {
                        if (err) {
                            // If there's an error executing the command, it might be due to a broken connection
                            this.isConnected = false;
                            this.logger.error(`SSH exec error for command "${command}": ${this._formatError(err)}`);
                            
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

                        stream
                            .on('data', (data) => {
                                try {
                                    const chunk = data.toString();
                                    //process.stdout.write(chunk); // Stream output in real-time

                                    if (socket) {
                                       // socket.emit('thinking_response2', { data: chunk });
                                    }

                                    output += chunk;
                                    
                                    // Update last activity timestamp
                                    this.lastActivity = Date.now();
                                } catch (err) {
                                    this.logger.error(`Error in stream data handler: ${this._formatError(err)}`);
                                }
                            })
                            .on('close', (code) => {
                                try {
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
                                } catch (err) {
                                    this.logger.error(`Error in stream close handler: ${this._formatError(err)}`);
                                    resolve({
                                        success: false,
                                        output: output,
                                        error: `Stream close error: ${this._formatError(err)}`,
                                        command: command,
                                        code: -1
                                    });
                                }
                            })
                            .on('error', (err) => {
                                this.logger.error(`Stream error: ${this._formatError(err)}`);
                                this.isConnected = false;
                                resolve({
                                    success: false,
                                    output: output,
                                    error: `Stream error: ${this._formatError(err)}`,
                                    command: command,
                                    code: -1
                                });
                            })
                            .stderr.on('data', (data) => {
                                try {
                                    const chunk = data.toString();
                                  //  process.stderr.write(chunk); // Stream error output in real-time

                                    // Optionally, send error output to the client via the socket
                                    if (socket) {
                                       // socket.emit('thinking_response2', { data: chunk, error: true });
                                    }

                                    errorOutput += chunk;
                                    
                                    // Update last activity timestamp
                                    this.lastActivity = Date.now();
                                } catch (err) {
                                    this.logger.error(`Error in stderr data handler: ${this._formatError(err)}`);
                                }
                            });
                    });
                } catch (execError) {
                    // Catch synchronous errors from client.exec()
                    this.isConnected = false;
                    this.logger.error(`Synchronous exec error for command "${command}": ${this._formatError(execError)}`);
                    
                    resolve({
                        success: false,
                        output: '',
                        error: `Exec failed: ${this._formatError(execError)}`,
                        command: command,
                        code: -1
                    });
                }
            });
        } catch(ex) {
            this.logger.error(`Exception in executeCommand for command "${command}": ${this._formatError(ex)}`);
            
            // Return a rejected promise with error information
            return Promise.resolve({
                success: false,
                output: '',
                error: `Command execution failed: ${this._formatError(ex)}`,
                command: command,
                code: -1
            });
        }
    }

    disconnect() {
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
                    // Use a synchronous approach for cleanup during disconnect
                    this.executeCommand(`pkill -P ${processInfo.pid} || true; kill -9 ${processInfo.pid} || true`);
                    
                    // Clean up the log file
                    this.executeCommand(`rm -f /tmp/bg-process-${processId}.log || true`);
                } catch (err) {
                    // Ignore errors during cleanup
                }
            } else {
                // Even if the process is not running, clean up its log file
                try {
                    this.executeCommand(`rm -f /tmp/bg-process-${processId}.log || true`);
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
     * @param {object} socket - Optional socket for real-time output
     * @param {string} processName - Optional name for the process (for easier reference)
     * @returns {Promise<object>} - Object containing process ID and initial status
     */
    executeBackgroundCommand(command, socket, processName = '') {
        try{
        return new Promise((resolve, reject) => {
            // Update last activity timestamp
            this.lastActivity = Date.now();
            
            if (!this.isConnected) {
                this.connect()
                    .then(() => {
                        this.executeBackgroundCommand(command, socket, processName)
                            .then(resolve)
                            .catch(reject);
                    })
                    .catch(err => {
                        reject(new Error(`Failed to reconnect: ${this._formatError(err)}`));
                    });
                return;
            }
            
            // Create a new SSH connection for this background process
            const bgClient = new Client();
            const processId = this.nextProcessId++;
            const processInfo = {
                id: processId,
                name: processName || `process-${processId}`,
                command,
                client: bgClient,
                startTime: new Date(),
                status: 'starting',
                output: '',
                errorOutput: '',
                exitCode: null,
                socket
            };
            
            // Store the process info
            this.backgroundProcesses[processId] = processInfo;
            
            bgClient
                .on('ready', async() => {
                    // Add sudo to the command if it doesn't already start with sudo
                    const sudoCommand = command ;
                    
                    // If folder path is specified, prepend cd command
                    const fullCommand = this.folderPath 
                        ? `cd "${this.folderPath}" 2>/dev/null && ${sudoCommand}`
                        : sudoCommand;
                    
                    // Use nohup to ensure the process continues even if the SSH session is terminated
                    // Use a unique log file for each background process
                    let finalPath = this.folderPath + `/tmp/bg-process-${processId}.log`;
                    await this.ensureDirectoryExists(this.folderPath + '/tmp');
                    const backgroundCommand = `nohup bash -c '${fullCommand.replace(/'/g, "'\\''")}' > ${finalPath} 2>&1 & echo $!`;

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
                            .on('data', (data) => {
                                pidOutput += data.toString().trim();
                            })
                            .on('close', (code) => {
                                if (code === 0 && pidOutput) {
                                    // Successfully started the background process
                                    processInfo.pid = parseInt(pidOutput, 10);
                                    processInfo.status = 'running';
                                    
                                    // Start monitoring the process output only if a socket is provided for real-time updates
                                    if (socket) {
                                        this._monitorBackgroundProcess(processId);
                                    }
                                    
                                    resolve({
                                        success: true,
                                        processId,
                                        pid: processInfo.pid,
                                        name: processInfo.name,
                                        message: `Background process started with PID ${processInfo.pid}`
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
                            .stderr.on('data', (data) => {
                                const errorData = data.toString();
                                processInfo.errorOutput += errorData;
                                
                                if (socket) {
                                  //  socket.emit('thinking_response2', { data: errorData, error: true });
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
    catch(ex)
    {
        this.logger.error("Error in ExecuteBackgroundCommand the command was==>"+command+" The error is==>"+ex);
    }
    }
    
    /**
     * Monitor the output of a background process
     * @param {number} processId - The ID of the process to monitor
     * @private
     */
    _monitorBackgroundProcess(processId) {
        const processInfo = this.backgroundProcesses[processId];
        if (!processInfo || processInfo.status !== 'running') return;
        
        // Create a new client for monitoring
        const monitorClient = new Client();
        processInfo.monitorClient = monitorClient;
        
        monitorClient
            .on('ready', () => {
                // Command to tail the log file and check if the process is still running
                const monitorCommand = `tail -f /tmp/bg-process-${processId}.log & PID=${processInfo.pid}; (ps -p $PID > /dev/null || echo "Process terminated") && sleep 1`;
                
                monitorClient.exec(monitorCommand, (err, stream) => {
                    if (err) {
                        processInfo.errorOutput += `\nMonitoring error: ${this._formatError(err)}`;
                        monitorClient.end();
                        return;
                    }
                    
                    stream
                        .on('data', (data) => {
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
                        .stderr.on('data', (data) => {
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
    _checkProcessStatus(processId) {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId];
            if (!processInfo || !processInfo.pid) {
                resolve(false);
                return;
            }
            
            this.executeCommand(`ps -p ${processInfo.pid} > /dev/null && echo "running" || echo "terminated"`)
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
     * @returns {Promise<object>} - Result of the termination attempt
     */
    terminateBackgroundProcess(processId) {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId];
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
                    
                    // Kill the process and its children
                this.executeCommand(
  `sudo bash -c 'PID=${processInfo.pid}; descendants=(); queue=("\$PID"); while [ \${#queue[@]} -gt 0 ]; do p="\${queue[0]}"; queue=("\${queue[@]:1}"); for c in \$(pgrep -P "\$p" || true); do descendants+=("\$c"); queue+=("\$c"); done; done; if [ \${#descendants[@]} -gt 0 ]; then printf "%s\n" "\${descendants[@]}" | xargs -r kill -9 2>/dev/null || true; fi; kill -9 "\$PID" 2>/dev/null || true'`
).

                        then(() => {
                            // Verify the process was terminated
                            setTimeout(() => {
                                this._checkProcessStatus(processId)
                                    .then(stillRunning => {
                                        if (stillRunning) {
                                            // Try a more forceful termination
                                           this.executeCommand(
  `sudo bash -c 'PID=${processInfo.pid}; descendants=(); queue=("\$PID"); while [ \${#queue[@]} -gt 0 ]; do p="\${queue[0]}"; queue=("\${queue[@]:1}"); for c in \$(pgrep -P "\$p" || true); do descendants+=("\$c"); queue+=("\$c"); done; done; if [ \${#descendants[@]} -gt 0 ]; then printf "%s\n" "\${descendants[@]}" | xargs -r kill -9 2>/dev/null || true; fi; kill -9 "\$PID" 2>/dev/null || true'`
).then(() => {
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
     * @returns {object} - Object containing information about all background processes
     */
    getBackgroundProcesses() {
        const processes = {};
        
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
                errorOutputLength: process.errorOutput.length
            };
        });
        
        return processes;
    }
    
    /**
     * Get the output of a background process by reading directly from the log file
     * @param {number} processId - The ID of the process
     * @param {number} maxLines - Maximum number of lines to retrieve (0 for all lines)
     * @param {boolean} tailMode - If true, get the last maxLines, otherwise get from the beginning
     * @returns {Promise<object>} - Promise resolving to an object containing the process output and status
     */
    /**
     * Get the size of a background process's log file
     * @param {number} processId - The ID of the process
     * @returns {Promise<object>} - Promise resolving to an object containing the log file size information
     */
    /**
     * Clean up the log file for a background process
     * @param {number} processId - The ID of the process
     * @returns {Promise<object>} - Promise resolving to the result of the cleanup operation
     */
    cleanupBackgroundProcessLog(processId) {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId];
            if (!processInfo) {
                resolve({
                    success: false,
                    message: `Process with ID ${processId} not found`
                });
                return;
            }
            
            const logFilePath = `/tmp/bg-process-${processId}.log`;
             let finalPath = this.folderPath+"/"+ logFilePath;
            // Check if the log file exists and delete it
            this.executeCommand(`if [ -f "${finalPath}" ]; then rm "${finalPath}" && echo "Log file deleted" || echo "Failed to delete log file"; else echo "Log file not found"; fi`)
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
    

    getBackgroundProcessLogSize(processId) {
        return new Promise((resolve) => {
            const processInfo = this.backgroundProcesses[processId];
            if (!processInfo) {
                resolve({
                    success: false,
                    message: `Process with ID ${processId} not found`
                });
                return;
            }
            
            // Check the log file size
            const logFilePath = `/tmp/bg-process-${processId}.log`;
            let finalPath = this.folderPath + "/" + logFilePath;
            this.executeCommand(`if [ -f "${finalPath}" ]; then du -h "${finalPath}" | cut -f1; wc -l "${finalPath}" | awk '{print $1}'; else echo "Log file not found"; fi`)
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
                        finalPath
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
    

    getBackgroundProcessOutput(processId, maxLines = 0, tailMode = true) {
        return new Promise((resolve) => {
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
            let finalPath = this.folderPath + "/" + logFilePath;
            // Construct the command to read the log file
            let readCommand;
            if (maxLines > 0) {
                // If maxLines is specified, use head or tail based on tailMode
                readCommand = tailMode 
                    ? `tail -n ${maxLines} ${finalPath}` 
                    : `head -n ${maxLines} ${finalPath}`;
            } else {
                // If maxLines is 0 or not specified, read the entire file
                readCommand = `cat ${finalPath}`;
            }
            
            // Execute the command to read the log file
            this.executeCommand(`if [ -f "${finalPath}" ]; then ${readCommand}; else echo "Log file not found"; fi`)
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
                                tailMode: tailMode
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


if (require.main === module) {
    main();
}

module.exports = SSHClient;