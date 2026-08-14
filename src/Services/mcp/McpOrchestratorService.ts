import * as McpJira from './jiraMcpClient';
import { REMOTE_MCP_REGISTRY, type McpRemoteIntegrationId } from './integrationRegistry';
import { resolveOrgMcpContext, resolveRemoteBaseUrl } from './orgMcpCredentials';
import { RemoteMcpConnectionPool } from './remoteMcpSession';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('McpOrchestrator');

export interface OrchestratorListToolsResult {
    success: boolean;
    tools: any[];
    errors?: string[];
}

/**
 * Org-scoped MCP orchestration: Jira (existing proxy) + registered remote Streamable-HTTP MCPs (Linear, Figma, ...).
 * Tool names from remote servers are prefixed to avoid collisions (e.g. linear_create_issue).
 */
export class McpOrchestratorService {
    private readonly remotePool = new RemoteMcpConnectionPool();

    invalidateOrganizationCredentials(organizationId: string): void {
        this.remotePool.invalidateOrganization(organizationId);
    }

    handlesTool(toolName: string): boolean {
        if (!toolName) {
            return false;
        }
        if (toolName.includes('jira') || toolName.includes('confluence')) {
            return true;
        }
        for (const id of Object.keys(REMOTE_MCP_REGISTRY) as McpRemoteIntegrationId[]) {
            const prefix = `${REMOTE_MCP_REGISTRY[id].toolPrefix}_`;
            if (toolName.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    async listToolsForUser(userId: string): Promise<OrchestratorListToolsResult> {
        const tools: any[] = [];
        const errors: string[] = [];

        try {
            const jiraResult: any = await McpJira.listTools(userId);
            if (Array.isArray(jiraResult)) {
                /* legacy empty response from jiraMcpClient */
            } else if (jiraResult.success && Array.isArray(jiraResult.tools)) {
                tools.push(...jiraResult.tools);
            } else if (jiraResult?.error) {
                errors.push(`jira: ${jiraResult.error}`);
            }
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('not installed') && !msg.includes('ATLASSIAN_NOT_INSTALLED')) {
                errors.push(`jira: ${msg}`);
            }
        }

        const ctx = await resolveOrgMcpContext(userId);
        if (ctx) {
            for (const integrationId of Object.keys(REMOTE_MCP_REGISTRY) as McpRemoteIntegrationId[]) {
                const token = ctx.remoteTokens[integrationId];
                if (!token) {
                    continue;
                }
                const def = REMOTE_MCP_REGISTRY[integrationId];
                const baseUrl = resolveRemoteBaseUrl(integrationId);
                try {
                    const remoteTools = await this.remotePool.listTools(ctx.organizationId, integrationId, baseUrl, token);
                    for (const t of remoteTools) {
                        tools.push({
                            name: `${def.toolPrefix}_${t.name}`,
                            description: t.description,
                            input_schema: t.inputSchema,
                        });
                    }
                } catch (e: any) {
                    const msg = e?.message || String(e);
                    errors.push(`${integrationId}: ${msg}`);
                    logger.error('Remote MCP listTools failed', { integrationId, message: msg });
                }
            }
        }

        return {
            success: errors.length === 0 || tools.length > 0,
            tools,
            errors: errors.length ? errors : undefined,
        };
    }

    async executeTool(userId: string, toolName: string, input: Record<string, any> | undefined): Promise<unknown> {
        if (toolName.includes('jira') || toolName.includes('confluence')) {
            return McpJira.executeTool(toolName, userId, input ?? {});
        }

        const ctx = await resolveOrgMcpContext(userId);
        if (!ctx) {
            throw new Error('Organization MCP context not available');
        }

        for (const integrationId of Object.keys(REMOTE_MCP_REGISTRY) as McpRemoteIntegrationId[]) {
            const def = REMOTE_MCP_REGISTRY[integrationId];
            const prefix = `${def.toolPrefix}_`;
            if (toolName.startsWith(prefix)) {
                const originalName = toolName.slice(prefix.length);
                const token = ctx.remoteTokens[integrationId];
                if (!token) {
                    throw new Error(`No credential configured for ${integrationId}`);
                }
                const baseUrl = resolveRemoteBaseUrl(integrationId);
                return this.remotePool.callTool(ctx.organizationId, integrationId, baseUrl, token, originalName, input);
            }
        }

        throw new Error(`Unsupported MCP tool: ${toolName}`);
    }
}

export const mcpOrchestrator = new McpOrchestratorService();
