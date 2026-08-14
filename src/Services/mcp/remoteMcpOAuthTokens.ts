import fetch from 'node-fetch';
import { DatabaseService } from '../../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../../DataAccessLayer/models/Collections';
import { UserInfo } from '../../DataStructures';
import { encryptOrgSecret, decryptOrgSecret, getOrgEncryptionKey } from '../../utils/orgSecretCrypto';
import type { McpRemoteIntegrationId } from './integrationRegistry';
import { REMOTE_MCP_REGISTRY } from './integrationRegistry';

export interface OrgMcpIntegrationStored {
    enabled?: boolean;
    authType?: 'oauth' | 'api_key';
    apiKeyEncrypted?: string;
    accessTokenEncrypted?: string;
    refreshTokenEncrypted?: string;
    expiresAt?: Date;
    scopes?: string[];
    installedAt?: Date;
    updatedAt?: Date;
}

export interface RemoteMcpTokenResult {
    success: boolean;
    accessToken?: string;
    refreshed?: boolean;
    error?: string;
    statusCode?: number;
}

function envFallbackEnabled(): boolean {
    return String(process.env.MCP_INTEGRATIONS_ENV_FALLBACK || '').toLowerCase() === 'true';
}

async function persistOAuthTokens(
    organizationId: string,
    integrationId: McpRemoteIntegrationId,
    accessToken: string,
    refreshToken: string | undefined,
    expiresInSec: number | undefined
): Promise<void> {
    const dbService = DatabaseService.getInstance();
    if (!dbService.isConnected()) {
        await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
    }
    const orgRepo = dbService.getRepository<any>(process.env.ORGANIZATION_DB!, CollectionNames.ORGANIZATIONS);
    const organization = await orgRepo.findOne({ OrganizationId: organizationId });
    if (!organization) {
        return;
    }
    const key = getOrgEncryptionKey();
    const meta = organization.metadata || {};
    const mcpIntegrations = { ...(meta.mcpIntegrations || {}) };
    const block: OrgMcpIntegrationStored = {
        ...(mcpIntegrations[integrationId] || {}),
        authType: 'oauth',
        enabled: true,
        accessTokenEncrypted: encryptOrgSecret(accessToken, key),
        updatedAt: new Date(),
    };
    if (refreshToken) {
        block.refreshTokenEncrypted = encryptOrgSecret(refreshToken, key);
    }
    const leewayMs = 60_000;
    if (expiresInSec != null && Number.isFinite(expiresInSec)) {
        block.expiresAt = new Date(Date.now() + expiresInSec * 1000 - leewayMs);
    } else {
        block.expiresAt = new Date(Date.now() + 3600 * 1000 - leewayMs);
    }
    mcpIntegrations[integrationId] = block;
    await orgRepo.updateOne({ OrganizationId: organizationId }, { $set: { metadata: { ...meta, mcpIntegrations } } });
}

export async function exchangeLinearAuthorizationCode(code: string, redirectUri: string): Promise<any> {
    const clientId = process.env.LINEAR_OAUTH_CLIENT_ID || process.env.LINEAR_CLIENT_ID;
    const clientSecret = process.env.LINEAR_OAUTH_CLIENT_SECRET || process.env.LINEAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('LINEAR_OAUTH_CLIENT_ID / LINEAR_OAUTH_CLIENT_SECRET not configured');
    }
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
    });
    const res = await fetch('https://api.linear.app/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    const text = await res.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`Linear token exchange failed: ${res.status} ${text}`);
    }
    if (!res.ok) {
        throw new Error(json?.error_description || json?.error || `Linear token exchange failed: ${res.status}`);
    }
    return json;
}

export async function exchangeFigmaAuthorizationCode(code: string, redirectUri: string): Promise<any> {
    const clientId = process.env.FIGMA_OAUTH_CLIENT_ID || process.env.FIGMA_CLIENT_ID;
    const clientSecret = process.env.FIGMA_OAUTH_CLIENT_SECRET || process.env.FIGMA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('FIGMA_OAUTH_CLIENT_ID / FIGMA_OAUTH_CLIENT_SECRET not configured');
    }
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const body = new URLSearchParams({
        redirect_uri: redirectUri,
        code,
        grant_type: 'authorization_code',
    });
    const res = await fetch('https://api.figma.com/v1/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
        },
        body: body.toString(),
    });
    const text = await res.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`Figma token exchange failed: ${res.status} ${text}`);
    }
    if (!res.ok) {
        throw new Error(json?.error_description || json?.error || `Figma token exchange failed: ${res.status}`);
    }
    return json;
}

async function refreshLinearAccessToken(refreshTokenPlain: string): Promise<any> {
    const clientId = process.env.LINEAR_OAUTH_CLIENT_ID || process.env.LINEAR_CLIENT_ID;
    const clientSecret = process.env.LINEAR_OAUTH_CLIENT_SECRET || process.env.LINEAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Linear OAuth client not configured');
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenPlain,
        client_id: clientId,
        client_secret: clientSecret,
    });
    const res = await fetch('https://api.linear.app/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json?.error_description || json?.error || `Linear refresh failed: ${res.status}`);
    }
    return json;
}

async function refreshFigmaAccessToken(refreshTokenPlain: string): Promise<any> {
    const clientId = process.env.FIGMA_OAUTH_CLIENT_ID || process.env.FIGMA_CLIENT_ID;
    const clientSecret = process.env.FIGMA_OAUTH_CLIENT_SECRET || process.env.FIGMA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Figma OAuth client not configured');
    }
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const body = new URLSearchParams({
        refresh_token: refreshTokenPlain,
    });
    const res = await fetch('https://api.figma.com/v1/oauth/refresh', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
        },
        body: body.toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json?.error_description || json?.error || `Figma refresh failed: ${res.status}`);
    }
    return json;
}

/**
 * Resolve a valid Bearer token for Linear/Figma MCP: OAuth (with refresh) or legacy apiKeyEncrypted or env fallback.
 */
export async function getRemoteMcpAccessTokenForUser(
    userId: string,
    integrationId: McpRemoteIntegrationId
): Promise<RemoteMcpTokenResult> {
    try {
        if (!userId) {
            return { success: false, error: 'USER_ID_MISSING', statusCode: 400 };
        }
        const userInfo = UserInfo.get(userId);
        if (!userInfo?.organizationId) {
            return { success: false, error: 'ORG_INFO_NOT_FOUND', statusCode: 400 };
        }

        const dbService = DatabaseService.getInstance();
        if (!dbService.isConnected()) {
            await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }
        const orgRepo = dbService.getRepository<any>(process.env.ORGANIZATION_DB!, CollectionNames.ORGANIZATIONS);
        const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
        if (!organization) {
            return { success: false, error: 'ORG_NOT_FOUND', statusCode: 404 };
        }

        const meta = organization.metadata || {};
        const block = meta.mcpIntegrations?.[integrationId] as OrgMcpIntegrationStored | undefined;
        if (!block || block.enabled === false) {
            if (envFallbackEnabled()) {
                const fromEnv = process.env[REMOTE_MCP_REGISTRY[integrationId].envFallbackTokenVar]?.trim();
                if (fromEnv) {
                    return { success: true, accessToken: fromEnv };
                }
            }
            return { success: false, error: 'MCP_INTEGRATION_NOT_CONFIGURED', statusCode: 404 };
        }

        const key = getOrgEncryptionKey();

        const useOAuth =
            block.authType === 'oauth' || Boolean(block.accessTokenEncrypted || block.refreshTokenEncrypted);

        if (!useOAuth && block.apiKeyEncrypted) {
            try {
                const k = decryptOrgSecret(block.apiKeyEncrypted, key);
                return { success: true, accessToken: k };
            } catch {
                return { success: false, error: 'DECRYPT_FAILED', statusCode: 500 };
            }
        }

        if (useOAuth) {
            const now = Date.now();
            const exp = block.expiresAt ? new Date(block.expiresAt).getTime() : 0;
            const hasValidAccess = block.accessTokenEncrypted && exp > now + 5000;

            if (hasValidAccess) {
                try {
                    const access = decryptOrgSecret(block.accessTokenEncrypted!, key);
                    return { success: true, accessToken: access, refreshed: false };
                } catch {
                    /* fall through to refresh */
                }
            }

            if (!block.refreshTokenEncrypted) {
                return { success: false, error: 'REFRESH_TOKEN_MISSING', statusCode: 401 };
            }

            let refreshPlain: string;
            try {
                refreshPlain = decryptOrgSecret(block.refreshTokenEncrypted, key);
            } catch {
                return { success: false, error: 'REFRESH_DECRYPT_FAILED', statusCode: 500 };
            }

            try {
                const tokenJson =
                    integrationId === 'linear'
                        ? await refreshLinearAccessToken(refreshPlain)
                        : await refreshFigmaAccessToken(refreshPlain);

                const newAccess = tokenJson.access_token;
                if (!newAccess) {
                    return { success: false, error: 'INVALID_REFRESH_RESPONSE', statusCode: 401 };
                }
                const newRefresh = tokenJson.refresh_token || refreshPlain;
                await persistOAuthTokens(
                    userInfo.organizationId,
                    integrationId,
                    newAccess,
                    newRefresh,
                    tokenJson.expires_in
                );
                return { success: true, accessToken: newAccess, refreshed: true };
            } catch (e: any) {
                return {
                    success: false,
                    error: e?.message || 'REFRESH_FAILED',
                    statusCode: 401,
                };
            }
        }

        if (envFallbackEnabled()) {
            const fromEnv = process.env[REMOTE_MCP_REGISTRY[integrationId].envFallbackTokenVar]?.trim();
            if (fromEnv) {
                return { success: true, accessToken: fromEnv };
            }
        }

        return { success: false, error: 'NO_CREDENTIAL', statusCode: 404 };
    } catch (err: any) {
        return { success: false, error: err?.message || 'UNEXPECTED_ERROR', statusCode: 500 };
    }
}
