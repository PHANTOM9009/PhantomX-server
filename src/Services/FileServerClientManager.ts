import { Socket } from 'socket.io';
import { FolderRequest, FileRequest } from '../classes/file_server';
import { createLogger } from '../utils/Logger';

const logger = createLogger('FileServerClientManager');

/**
 * Manages multiple incoming file server connections for different workspaces/EC2 instances.
 * File servers now connect TO this server (reversed architecture).
 */
export class FileServerClientManager {
    private static instance: FileServerClientManager;

    // Maps id (taskId or wpId) -> { fileServerSocket: incoming Socket from file server, userSocket: user-facing Socket for response forwarding }
    private clients: Map<string, { fileServerSocket: Socket; userSocket: Socket | null }> = new Map();

    private constructor() {
        logger.info('FileServerClientManager initialized');
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): FileServerClientManager {
        if (!FileServerClientManager.instance) {
            FileServerClientManager.instance = new FileServerClientManager();
        }
        return FileServerClientManager.instance;
    }

    /**
     * Register an incoming file server connection.
     * Called from socket-server.ts when a file server connects to the /file-server namespace.
     * @param id - taskId or wpId sent by the file server in handshake query
     * @param fileServerSocket - the incoming Socket from the file server
     */
    public registerClient(id: string, fileServerSocket: Socket): void {
        if (this.clients.has(id)) {
            logger.warn(`File server already registered for id, replacing`, { id });
            const existing = this.clients.get(id)!;
            existing.fileServerSocket.removeAllListeners();
        }
        this.clients.set(id, { fileServerSocket, userSocket: null });
        logger.info(`File server registered`, { id });
    }

    /**
     * Get the registered file server socket for a given id.
     * Forwarding listeners are set up only once on the first call (mirrors original behaviour).
     * Signature is kept compatible with the old client-based approach so callers need no changes.
     * @param id - taskId or wpId
     * @param _ec2Ip - ignored (file server now connects to us)
     * @param socket - user-facing Socket; responses from the file server are forwarded here
     * @param _port - ignored
     * @param workspaceId - optional, used only for logging
     */
    public getOrCreateClient(id: string, _ec2Ip: string, socket: Socket, _port: number = 4002, workspaceId?: string): Socket | undefined {
        const entry = this.clients.get(id);

        if (!entry) {
            logger.warn(`No file server registered for id`, { id, workspaceId });
            return undefined;
        }

        const { fileServerSocket } = entry;

        if (!fileServerSocket.connected) {
            logger.warn(`File server socket disconnected for id, removing`, { id });
            this.clients.delete(id);
            return undefined;
        }

        // Set up forwarding listeners only once, just like the original implementation
        if (entry.userSocket === null) {
            logger.debug(`Setting up forwarding listeners`, { id, socketId: socket.id, workspaceId });

            fileServerSocket.on("folder_structure_response", async (data: FolderRequest) => {
               // logger.debug("Received folder structure response", { path: data.path });
                socket.emit('folder_structure_response', data);
            });
            fileServerSocket.on("file_content_response", async (data: any) => {
                const requestId = data.requestId || data.reqId;
             //   logger.debug("Received file content response", { requestId });
                socket.emit('file_content_response', { result: data.result, requestId: requestId });
            });
            fileServerSocket.on("file_process_response", async (data: FileRequest) => {
               // logger.debug("Received file process response", { path: data.path });
                socket.emit('file_process_response', data);
            });
            fileServerSocket.on("folder_structure_change_response", async (data: any) => {
               // logger.debug("Received folder structure change response");
                socket.emit('folder_structure_change_response', data);
            });
            fileServerSocket.on("file_content_change_response", async (data: any) => {
            //    logger.debug("Received file content change response");
                socket.emit('file_content_change_response', data);
            });
            fileServerSocket.on("git_changes_response", async (data: any) => {
            //    logger.debug("Received git changes response");
                socket.emit('git_changes_response', data);
            });
            fileServerSocket.on("merge_branch_response", async (data: any) => {
                logger.debug("Received merge branch response");
                socket.emit('merge_branch_response', data);
            });
            fileServerSocket.on("discard_file_changes_response", async (data: any) => {
              //  logger.debug("Received discard changes response");
                socket.emit('discard_file_changes_response', data);
            });
            fileServerSocket.on("file_diff_response", async (data: any) => {
                // logger.debug("Received file diff response");
                socket.emit('file_diff_response', data);
            });
            // Forward diagnostics updates from file server to client
            fileServerSocket.on("diagnostics_update", async (data: any) => {
                logger.debug("Received diagnostics update", { path: data.path });
                socket.emit('diagnostics_update', data);
            });

            entry.userSocket = socket;
        }

        return fileServerSocket;
    }

    /**
     * Remove a registered file server entry.
     * Extra params (_ec2Ip, _port) are kept for call-site compatibility but are ignored.
     */
    public removeClient(id: string, _ec2Ip?: string, _port: number = 4002): void {
        const entry = this.clients.get(id);
        if (entry) {
            logger.info(`Removing file server client`, { id });
            entry.fileServerSocket.removeAllListeners();
            this.clients.delete(id);
        }
    }

    /**
     * Remove all registered file server entries.
     */
    public disconnectAll(): void {
        logger.info(`Removing all file server clients`, { count: this.clients.size });
        for (const [key, entry] of this.clients.entries()) {
            logger.debug(`Removing client`, { key });
            entry.fileServerSocket.removeAllListeners();
        }
        this.clients.clear();
    }

    /**
     * Get all active connections
     * @returns Array of connection info
     */
    public getActiveConnections(): Array<{ key: string; connected: boolean; id: string }> {
        const connections: Array<{ key: string; connected: boolean; id: string }> = [];
        for (const [key, entry] of this.clients.entries()) {
            connections.push({
                key,
                connected: entry.fileServerSocket.connected,
                id: entry.fileServerSocket.id
            });
        }
        return connections;
    }

    /**
     * Get total number of managed clients
     */
    public getClientCount(): number {
        return this.clients.size;
    }
}

// Export singleton instance
export const fileServerClientManager = FileServerClientManager.getInstance();
