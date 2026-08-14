import { Socket } from 'socket.io';
import type { McpRemoteIntegrationId } from '../Services/mcp/integrationRegistry';

export type McpOAuthProvider = McpRemoteIntegrationId;

/** Pending browser OAuth flows for Linear/Figma MCP (same pattern as Atlassian). */
export const mcpOAuthSessions: Map<
    string,
    {
        sessionId: string;
        provider: McpOAuthProvider;
        userId: string;
        organizationId: string;
        organizationName: string;
        socket: Socket;
        createdAt: Date;
        expiresAt: Date;
    }
> = new Map();
