import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../../utils/Logger';
import type { McpRemoteIntegrationId } from './integrationRegistry';
import { getRemoteMcpPoolKey } from './orgMcpCredentials';

const logger = createLogger('RemoteMcpSession');

const SESSION_TTL_MS = parseInt(process.env.MCP_REMOTE_SESSION_TTL_MS || '300000', 10);

interface PooledSession {
    client: Client;
    transport: StreamableHTTPClientTransport;
    expiresAt: number;
}

/**
 * Reuses Streamable HTTP MCP sessions per org + integration + token fingerprint
 * to avoid reconnecting on every agent turn.
 */
export class RemoteMcpConnectionPool {
    private entries = new Map<string, PooledSession>();

    private async closeSession(sess: PooledSession): Promise<void> {
        try {
            await (sess.transport as any).terminateSession?.();
        } catch {
            /* ignore */
        }
        try {
            await sess.client.close();
        } catch {
            /* ignore */
        }
    }

    /**
     * Drop every pooled connection for an organization (e.g. after credential rotation).
     */
    invalidateOrganization(organizationId: string): void {
        const prefix = `${organizationId}:`;
        for (const [key, sess] of this.entries.entries()) {
            if (key.startsWith(prefix)) {
                void this.closeSession(sess);
                this.entries.delete(key);
            }
        }
    }

    private async getSession(
        organizationId: string,
        integrationId: McpRemoteIntegrationId,
        baseUrl: string,
        bearerToken: string
    ): Promise<PooledSession> {
        const mapKey = getRemoteMcpPoolKey(organizationId, integrationId, bearerToken);
        const now = Date.now();
        const existing = this.entries.get(mapKey);
        if (existing && existing.expiresAt > now) {
            existing.expiresAt = now + SESSION_TTL_MS;
            return existing;
        }
        if (existing) {
            await this.closeSession(existing);
            this.entries.delete(mapKey);
        }

        const url = new URL(baseUrl);
        const transport = new StreamableHTTPClientTransport(url, {
            requestInit: {
                headers: {
                    Authorization: `Bearer ${bearerToken}`,
                },
            },
        });
        const client = new Client({ name: 'ai-coder-mcp-orchestrator', version: '1.0.0' });
        await client.connect(transport);
        const sess: PooledSession = {
            client,
            transport,
            expiresAt: now + SESSION_TTL_MS,
        };
        this.entries.set(mapKey, sess);
        return sess;
    }

    async listTools(
        organizationId: string,
        integrationId: McpRemoteIntegrationId,
        baseUrl: string,
        bearerToken: string
    ): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
        const sess = await this.getSession(organizationId, integrationId, baseUrl, bearerToken);
        try {
            const result = await sess.client.listTools();
            return result.tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
            }));
        } catch (e) {
            logger.error('listTools failed', { integrationId, error: e instanceof Error ? e.message : String(e) });
            throw e;
        }
    }

    async callTool(
        organizationId: string,
        integrationId: McpRemoteIntegrationId,
        baseUrl: string,
        bearerToken: string,
        toolName: string,
        args: Record<string, unknown> | undefined
    ): Promise<unknown> {
        const sess = await this.getSession(organizationId, integrationId, baseUrl, bearerToken);
        try {
            return await sess.client.callTool({
                name: toolName,
                arguments: args ?? {},
            });
        } catch (e) {
            logger.error('callTool failed', { integrationId, toolName, error: e instanceof Error ? e.message : String(e) });
            throw e;
        }
    }
}
