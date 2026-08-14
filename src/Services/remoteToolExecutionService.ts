// we will be remotely calling the tool execution
import {Socket} from 'socket.io-client';
import * as ds from '../DataStructures';

export  class RemoteToolExecutionService
{
    socket:Socket; // this will be the client socket that will be used to communicate with the remote tool execution server
    constructor(socket:Socket)
    {
        this.socket = socket;
    }

    async executeRemoteTool(toolCall:any,agentId:string)
    {
      
        
            let payload = {
                id: agentId,
                toolCall:{
                    name: toolCall.name,
                    input: toolCall.input // sending the input to the tool server as is.

                }
            }
            //wrapping this in the promist such that this function returns only when the result from the server has come                      
        

           return new Promise((resolve, reject) => {
                this.socket.emit("selfhosted_tool_request", payload, async (result: any) => {
                  resolve(result); // returning the result directly.
                });
            });
    }

}