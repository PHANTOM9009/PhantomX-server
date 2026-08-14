import { Socket } from "socket.io";


export interface FolderRequest {
    reqId: string;
    path: string;
}

export interface FileRequest {
    reqId: string;
    path: string;
}

export interface MessageData {
    [key: string]: any;
}

export interface ClientData {
    socket: Socket;
    connected: Date;
    data?: any;
}
