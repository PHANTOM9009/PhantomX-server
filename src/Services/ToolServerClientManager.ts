import { Socket } from 'socket.io';
import * as ds from '../DataStructures';
import { io } from '../socket-server';
/**
 * Manages incoming Tool Server client connections.
 * Tool server clients (running on user machines) connect IN to this server
 * via the /tool-server namespace. Each connected socket is registered here
 * keyed by the id sent in the handshake auth (taskId / workspaceId).
 */
export class ToolServerClientManager {
    private static instance: ToolServerClientManager;

    // key: id (taskId or workspaceId), value: server-side Socket from the /tool-server namespace
    private clients: Map<string, Socket> = new Map();

    // pending edit requests: key = clientKey, value = Map<requestId, callback>
    private pendingEditRequests: Map<string, Map<string, (result: [string, string][]) => void>> = new Map();

    // pending read requests: key = clientKey, value = Map<requestId, callback>
    private pendingReadRequests: Map<string, Map<string, (result: string) => void>> = new Map();

    // Browser sockets subscribed to unsolicited Tool-server events, keyed by task/workspace id.
    private userSockets: Map<string, Set<Socket>> = new Map();


    private constructor() {
        console.log('[ToolServerClientManager] Initialized');
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ToolServerClientManager {
        if (!ToolServerClientManager.instance) {
            ToolServerClientManager.instance = new ToolServerClientManager();
        }
        return ToolServerClientManager.instance;
    }

    /**
     * Register an incoming tool server socket.
     * Called from the /tool-server namespace connection handler in socket-server.ts.
     * @param id - taskId or workspaceId sent by the tool server client in handshake auth
     * @param socket - the server-side socket.io Socket for this connection
     */
    public registerClient(id: string, socket: Socket): void {
        console.log(`[ToolServerClientManager] Registered tool server client for id: ${id} (socket: ${socket.id})`);
        this.clients.set(id, socket);

        // Initialise pending-request maps for this client
        this.pendingEditRequests.set(id, new Map());
        this.pendingReadRequests.set(id, new Map());

        // Wire up edit response listener
        socket.on('remote_edit_response', (data: { requestId: string; result: [string, string][] }) => {
            const pending = this.pendingEditRequests.get(id);
            if (pending) {
                const callback = pending.get(data.requestId);
                if (callback) {
                    pending.delete(data.requestId);
                    callback(data.result);
                }
            }
        });

        // Wire up read response listener
        socket.on('remote_read_response', (data: { requestId: string; result: string }) => {
            const pending = this.pendingReadRequests.get(id);
            if (pending) {
                const callback = pending.get(data.requestId);
                if (callback) {
                    pending.delete(data.requestId);
                    callback(data.result);
                }
            }
        });


        const forwardToUserSockets = (eventName: string, data: any) => {
           
            let socketId:any =  ds.taskId_task.get(data.taskId)?.socketId;
            let socket:any = io.sockets.sockets.get(socketId);
            if(socket)
            {
                socket.emit(eventName,data);
                
            }
        };

        socket.on('file_content_change_response', data => forwardToUserSockets('file_content_change_response', data));
        socket.on('folder_structure_change_response', data => forwardToUserSockets('folder_structure_change_response', data));
        socket.on('file_watcher_ready', data => forwardToUserSockets('file_watcher_ready', data));
        socket.on('file_watcher_error', data => forwardToUserSockets('file_watcher_error', data));

    }
    

    /**
     * Remove a tool server socket (called on disconnect).
     * @param id - taskId or workspaceId
     */
    public removeClient(id: string): void {
        console.log(`[ToolServerClientManager] Removed tool server client for id: ${id}`);
        this.clients.delete(id);
        this.pendingEditRequests.delete(id);
        this.pendingReadRequests.delete(id);
    }

    /**
     * Retrieve the live socket for a given id so callers can emit on it directly.
     * @param id - taskId or workspaceId
     * @returns The server-side Socket, or undefined if not connected
     */
    public getClient(id: string): Socket | undefined {
        return this.clients.get(id);
    }


    public subscribeUserSocket(id: string, socket: Socket): void {
        let subscribers = this.userSockets.get(id);
        if (!subscribers) {
            subscribers = new Set<Socket>();
            this.userSockets.set(id, subscribers);
        }
        subscribers.add(socket);
        console.log(`[ToolServerClientManager] Browser socket ${socket.id} subscribed to watcher events for id ${id}; subscribers=${subscribers.size}`);

    }

    public unsubscribeUserSocket(id: string, socket: Socket): void {
        const subscribers = this.userSockets.get(id);
        if (!subscribers) return;
        subscribers.delete(socket);
        if (subscribers.size === 0) this.userSockets.delete(id);
    }


    /**
     * Check whether a tool server client is currently connected.
     * @param id - taskId or workspaceId
     */
    public isConnected(id: string): boolean {
        const socket = this.clients.get(id);
        return socket ? socket.connected : false;
    }

    /**
     * Total number of connected tool server clients.
     */
    public getClientCount(): number {
        return this.clients.size;
    }

    public async sendEditToolRequest(id: string,
        edits: any[]
    ): Promise<[string, string][]> {
        const clientKey = id;
        const client = this.getClient(id);

        if (!client || !client.connected) {
            throw new Error(`[ToolServerClientManager] No connected tool server client for id: ${clientKey}`);
        }

        return new Promise((resolve, reject) => {
            // Generate a unique request ID
            const requestId = 'edit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            // Set a timeout to reject the promise if no response is received
            const timeoutId = setTimeout(() => {
                const pendingRequests = this.pendingEditRequests.get(clientKey);
                if (pendingRequests) {
                    pendingRequests.delete(requestId);
                }
                reject(new Error(`Edit request timed out after 30 seconds for ${clientKey}`));
            }, 30000);

            // Store the callback in the pending requests map
            const pendingRequests = this.pendingEditRequests.get(clientKey);
            if (pendingRequests) {
                pendingRequests.set(requestId, (result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                });
            }

            // Send the edit request to the tool server client
            client.emit('remote_edit_request', {
                requestId,
                edits
            });

            console.log(`[ToolServerClientManager] Sent edit request ${requestId} to ${clientKey}`);
        });
    }

    public async sendReadFileRequest(id: string,
        options: {
            targetFile: string;
            shouldReadEntireFile: boolean;
            startLineOneIndexed: number;
            endLineOneIndexedInclusive: number;
            explanation?: string;
        }
    ): Promise<string> {
        const clientKey = id;
        const client = this.getClient(id);

        if (!client || !client.connected) {
            throw new Error(`[ToolServerClientManager] No connected tool server client for id: ${clientKey}`);
        }

        return new Promise((resolve, reject) => {
            // Generate a unique request ID
            const requestId = 'read_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            // Set a timeout to reject the promise if no response is received
            const timeoutId = setTimeout(() => {
                const pendingRequests = this.pendingReadRequests.get(clientKey);
                if (pendingRequests) {
                    pendingRequests.delete(requestId);
                }
                reject(new Error(`Read file request timed out after 30 seconds for ${clientKey}`));
            }, 30000);

            // Store the callback in the pending requests map
            const pendingRequests = this.pendingReadRequests.get(clientKey);
            if (pendingRequests) {
                pendingRequests.set(requestId, (result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                });
            }

            // Send the read file request to the tool server client
            client.emit('remote_read_request', {
                requestId,
                options
            });

            console.log(`[ToolServerClientManager] Sent read file request ${requestId} to ${clientKey} for ${options.targetFile}`);
        });
    }

    /**
     * Send a generic tool execution request to the Tool Server using a
     * Socket.io acknowledgement callback — no pending maps, no requestId needed.
     * The tool server handles 'tool_request' and fires the callback directly.
     * @param id       - taskId or workspaceId
     * @param toolName - Tool to execute (e.g. 'Github_GetGitChanges')
     * @param input    - Input payload for the tool
     * @param timeoutMs - Timeout in ms (default: 30000)
     */
    public async sendToolRequest(id: string, toolName: string, input: Record<string, any>, timeoutMs: number = 30000): Promise<any> {
        const client = this.getClient(id);

        if (!client || !client.connected) {
            throw new Error(`[ToolServerClientManager] No connected tool server client for id: ${id}`);
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Tool request '${toolName}' timed out after ${timeoutMs}ms for id: ${id}`));
            }, timeoutMs);

            client.emit('tool_request', { toolName, input }, (result: any) => {
                clearTimeout(timeout);
                resolve(result);
            });

            console.log(`[ToolServerClientManager] Sent tool_request '${toolName}' to id: ${id}`);
        });
    }
}


// Export singleton instance
export const toolServerClientManager = ToolServerClientManager.getInstance();
