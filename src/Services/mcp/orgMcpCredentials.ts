import * as crypto from 'crypto';
import { DatabaseService } from '../../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../../DataAccessLayer/models/Collections';
import { UserInfo } from '../../DataStructures';
import type { McpRemoteIntegrationId } from './integrationRegistry';
import { REMOTE_MCP_REGISTRY } from './integrationRegistry';
import { getRemoteMcpAccessTokenForUser } from './remoteMcpOAuthTokens';

export interface OrgMcpContext {
    organizationId: string;
    /** Resolved bearer tokens per remote integration (OAuth refresh, legacy API key, or env fallback) */
    remoteTokens: Partial<Record<McpRemoteIntegrationId, string>>;
}

function fingerprintToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Load org and resolve a valid access token for each registered remote MCP (Linear, Figma, …).
 */
export async function resolveOrgMcpContext(userId: string): Promise<OrgMcpContext | null> {
    if (!userId) {
        return null;
    }
    const userInfo = UserInfo.get(userId);
    if (!userInfo?.organizationId) {
        return null;
    }

    const dbService = DatabaseService.getInstance();
    if (!dbService.isConnected()) {
        await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
    }

    const orgRepo = dbService.getRepository<any>(process.env.ORGANIZATION_DB!, CollectionNames.ORGANIZATIONS);
    const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
    if (!organization) {
        return null;
    }

    const remoteTokens: Partial<Record<McpRemoteIntegrationId, string>> = {};

    for (const id of Object.keys(REMOTE_MCP_REGISTRY) as McpRemoteIntegrationId[]) {
        const result = await getRemoteMcpAccessTokenForUser(userId, id);
        if (result.success && result.accessToken) {
            remoteTokens[id] = result.accessToken;
        }
    }

    return {
        organizationId: userInfo.organizationId,
        remoteTokens,
    };
}

export function getRemoteMcpPoolKey(organizationId: string, integrationId: McpRemoteIntegrationId, token: string): string {
    return `${organizationId}:${integrationId}:${fingerprintToken(token)}`;
}

export function resolveRemoteBaseUrl(integrationId: McpRemoteIntegrationId): string {
    const entry = REMOTE_MCP_REGISTRY[integrationId];
    const fromEnv = process.env[entry.baseUrlEnvVar]?.trim();
    return fromEnv || entry.defaultBaseUrl;
}
