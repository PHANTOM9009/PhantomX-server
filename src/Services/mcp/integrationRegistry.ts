/**
 * Declarative registry for remote Streamable-HTTP MCP integrations.
 * Add new entries here to expose more org-scoped MCP servers to the agent.
 */

export const MCP_INTEGRATION_IDS = ['linear', 'figma'] as const;
export type McpRemoteIntegrationId = (typeof MCP_INTEGRATION_IDS)[number];

export interface RemoteMcpRegistryEntry {
    id: McpRemoteIntegrationId;
    /** Prefix for tool names exposed to the model (e.g. create_issue -> linear_create_issue) */
    toolPrefix: string;
    /** Env var for MCP base URL (must include /mcp path if required by host) */
    baseUrlEnvVar: string;
    defaultBaseUrl: string;
    /** Plain env fallback key when MCP_INTEGRATIONS_ENV_FALLBACK=true and org has no secret */
    envFallbackTokenVar: string;
}

export const REMOTE_MCP_REGISTRY: Record<McpRemoteIntegrationId, RemoteMcpRegistryEntry> = {
    linear: {
        id: 'linear',
        toolPrefix: 'linear',
        baseUrlEnvVar: 'MCP_LINEAR_BASE_URL',
        defaultBaseUrl: 'https://mcp.linear.app/mcp',
        envFallbackTokenVar: 'LINEAR_API_KEY',
    },
    figma: {
        id: 'figma',
        toolPrefix: 'figma',
        baseUrlEnvVar: 'MCP_FIGMA_BASE_URL',
        defaultBaseUrl: 'https://mcp.figma.com/mcp',
        envFallbackTokenVar: 'FIGMA_API_KEY',
    },
};

export function isRemoteMcpIntegrationId(id: string): id is McpRemoteIntegrationId {
    return (MCP_INTEGRATION_IDS as readonly string[]).includes(id);
}
