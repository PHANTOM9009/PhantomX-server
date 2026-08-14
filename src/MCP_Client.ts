

import {
    MessageParam,
    Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as dotenv from "dotenv";
import { Logger } from "./utils/Logger";
dotenv.config();

// Transport type for remote MCP connections
type RemoteTransport = SSEClientTransport | StreamableHTTPClientTransport;

export interface MCPConnectionOptions {
    /** Use SSE transport instead of HTTP (legacy mode) */
    useSSE?: boolean;
    /** Connection timeout in milliseconds */
    timeout?: number;
}

export class MCPClient {
    private mcp: Client;
    private transport: RemoteTransport | null = null;
    private tools: any[] = [];  // Using any[] for flexibility with MCP tool schema
    private serverUrl: string | null = null;
    private isConnected: boolean = false;
    private logger: Logger;

    constructor() {
        this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
        this.logger = new Logger('MCP_Client');
    }

    /**
     * Connect to a remote MCP server via HTTP or SSE transport
     * @param serverUrl - The base URL of the MCP server (e.g., "http://192.168.1.100:8080")
     * @param options - Connection options
     */
    async connectToServer(serverUrl: string, options: MCPConnectionOptions = {}) {
        try {
            const { useSSE = false, timeout = 30000 } = options;

            // Validate URL format
            let baseUrl: URL = '' as any;
            try {
                baseUrl = new URL(serverUrl);
            } catch {
                this.logger.error(`Invalid server URL: ${serverUrl}. Expected format: http://host:port`);
                return false;

            }

            this.serverUrl = serverUrl;

            // Create appropriate transport based on options
            if (useSSE) {
                // SSE transport (legacy) - uses /sse endpoint
                const sseUrl = new URL('/sse', baseUrl);
                console.log(`\n Connecting to MCP server via SSE: ${sseUrl.toString()}`);
                this.transport = new SSEClientTransport(sseUrl);
            } else {
                // HTTP transport (recommended) - uses /mcp endpoint
                const httpUrl = new URL(baseUrl);
                console.log(`\n Connecting to MCP server via HTTP: ${httpUrl.toString()}`);
                this.transport = new StreamableHTTPClientTransport(httpUrl);
            }

            // Connect to the server
            await this.mcp.connect(this.transport);
            this.isConnected = true;
            console.log("\n Connected to the MCP server");

            // Fetch available tools
            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                };
            });

            console.log(`\n Loaded ${this.tools.length} tools from MCP server`);
            return true;

        } catch (e) {
            this.isConnected = false;
            console.log("Failed to connect to MCP server: ", e);
            return false;

        }
    }

    /**
     * Disconnect from the MCP server and cleanup resources
     */
    async disconnect() {
        try {
            if (this.transport) {
                // For HTTP transport, terminate the session properly
                if (this.transport instanceof StreamableHTTPClientTransport) {
                    try {
                        await (this.transport as any).terminateSession?.();
                    } catch (e) {
                        // Ignore termination errors
                    }
                }

                await this.mcp.close();
                this.transport = null;
                this.isConnected = false;
                this.serverUrl = null;
                console.log("\n Disconnected from MCP server");
            }
        } catch (e) {
            console.log("Error during disconnect: ", e);
            // Reset state even on error
            this.transport = null;
            this.isConnected = false;
        }
    }

    /**
     * Check if currently connected to MCP server
     */
    isServerConnected(): boolean {
        return this.isConnected;
    }

    /**
     * Get the current server URL
     */
    getServerUrl(): string | null {
        return this.serverUrl;
    }

    /**
     * Get all available tools from the MCP server
     */
    async getAllTools() {
        try {
            if (!this.isConnected) {
                let connResult = await this.connectToServer(this.serverUrl as any); // we are connecting to the server again..
                if (!connResult) {
                    return {
                        success: false
                    }
                }
            }
            return {
                success: true,
                tools: await this.mcp.listTools()
            }
        }
        catch (ex) {
            this.logger.error('error in getAllTools==>', ex);
            return {
                success: false
            }
        }

    }

    /**
     * Execute a tool on the MCP server
     * @param toolRequest - The tool request containing name and input parameters
     */
    async getToolResult(toolRequest: any) {
        try {
            if (!this.isConnected) {
                let connResult = await this.connectToServer(this.serverUrl as any); // we are connecting to the server again..
                if (!connResult) {
                    return 'playwright server is not connected.. cannot fetch results now.';
                }
            }

            const args = {
                name: toolRequest.name,
                arguments: toolRequest.input as { [x: string]: unknown } | undefined
            };
            const result = await this.mcp.callTool(args);
            return result;
        }
        catch (ex) {
            this.logger.error('error in getToolResult==>', ex);
            return 'playwright server is not connected... cannot fetch results now.';
        }
    }

    /**
     * Get the list of cached tools (loaded during connection)
     */
    getCachedTools(): any[] {
        return this.tools;
    }
}

// (async()=>{
//     const client = new MCPClient();
//     await client.connectToServer("F:\\MCP servers\\Playwright-MCP\\playwright-mcp\\cli.js");

//     var result = await client.getToolResult({
//         name: "browser_navigate",
//         input:{
//             "url": "https://google.com"
//         }
//     });
//      result = await client.getToolResult({
//         name: "browser_take_screenshot",
//         input:{
//            fullPage:  false
//         }
//     });
//     result = await client.getToolResult({
//         name:"browser_snapshot",
//         input:{

//         }
//     });

// })();