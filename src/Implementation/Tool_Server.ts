// this file has the supporting functions for using the tool server tools/**

import { toolServerClientManager } from '../Services/ToolServerClientManager';



/**
 * Send edit tool request to the Tool Server
 * @param edits - Array of edit operations
 * @param ec2Ip - IP address of the EC2 instance (optional, defaults to env variable)
 * @param port - Port number (default: 8081)
 * @returns Promise that resolves with the edit results
 */
export async function sendEditToolRequest(id:string,
    edits: any[],
    ec2Ip?: string,
    port: number = 8081
): Promise<[string, string][]> {
    const ip = ec2Ip || process.env.EC2_INSTANCE_IP || 'localhost';
    return toolServerClientManager.sendEditToolRequest(id, edits);
}

/**
 * Function to send ReadFileTool request to remote server and get response
 * @param options - Read file options
 * @param ec2Ip - IP address of the EC2 instance (optional, defaults to env variable)
 * @param port - Port number (default: 8081)
 * @returns Promise that resolves with the file content
 */
export async function sendReadFileRequest(
    id:string,
    options: {
        targetFile: string;
        shouldReadEntireFile: boolean;
        startLineOneIndexed: number;
        endLineOneIndexedInclusive: number;
        explanation?: string;
    },
    ec2Ip?: string,
    port: number = 8081
): Promise<string> {
    const ip = ec2Ip || process.env.EC2_INSTANCE_IP || 'localhost';
    return toolServerClientManager.sendReadFileRequest(id,options);
}
