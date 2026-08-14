import express, { Request, Response, Router } from 'express';
import { mcpOAuthSessions } from '../socket-handlers/mcp-oauth-sessions';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { encryptOrgSecret, getOrgEncryptionKey } from '../utils/orgSecretCrypto';
import {
    exchangeFigmaAuthorizationCode,
    exchangeLinearAuthorizationCode,
} from '../Services/mcp/remoteMcpOAuthTokens';
import type { McpRemoteIntegrationId } from '../Services/mcp/integrationRegistry';
import { mcpOrchestrator } from '../Services/mcp/McpOrchestratorService';
import { createLogger } from '../utils/Logger';

const router: Router = express.Router();
const mcpOAuthLog = createLogger('McpOAuthCallback');

function clientMeta(req: Request): { ip?: string; forwardedFor?: string } {
    const forwarded = req.get('x-forwarded-for');
    return {
        ip: req.ip || req.socket?.remoteAddress,
        forwardedFor: forwarded?.split(',')[0]?.trim(),
    };
}

function statePrefix(state: unknown): string | undefined {
    if (state == null || typeof state !== 'string') {
        return undefined;
    }
    return state.length <= 10 ? `${state.slice(0, 4)}…` : `${state.slice(0, 8)}…`;
}

function summarizeTokenResponse(tokenJson: any): Record<string, unknown> {
    return {
        hasAccessToken: Boolean(tokenJson?.access_token),
        hasRefreshToken: Boolean(tokenJson?.refresh_token),
        expiresIn: tokenJson?.expires_in,
        tokenType: tokenJson?.token_type,
    };
}

function appBaseUrl(): string {
    return (process.env.APP_URL || '').replace(/\/$/, '');
}

function linearRedirectUri(): string {
    return (
        process.env.LINEAR_OAUTH_REDIRECT_URI?.trim() ||
        `${appBaseUrl()}/api/auth/mcp/linear/callback`
    );
}

function figmaRedirectUri(): string {
    return (
        process.env.FIGMA_OAUTH_REDIRECT_URI?.trim() ||
        `${appBaseUrl()}/api/auth/mcp/figma/callback`
    );
}

async function persistOAuthFromTokenResponse(
    organizationId: string,
    integrationId: McpRemoteIntegrationId,
    tokenJson: any,
    scopes: string[]
): Promise<void> {
    const dbService = DatabaseService.getInstance();
    if (!dbService.isConnected()) {
        await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
    }
    const orgRepo = dbService.getRepository<IOrganization>(process.env.ORGANIZATION_DB!, CollectionNames.ORGANIZATIONS);
    const organization = await orgRepo.findOne({ OrganizationId: organizationId });
    if (!organization) {
        throw new Error('Organization not found');
    }

    const key = getOrgEncryptionKey();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
        throw new Error('No access_token in token response');
    }

    const meta = organization.metadata || {};
    const mcpIntegrations = { ...(meta.mcpIntegrations || {}) };
    const leewayMs = 60_000;
    const expiresIn = tokenJson.expires_in;
    const expiresAt =
        expiresIn != null && Number.isFinite(Number(expiresIn))
            ? new Date(Date.now() + Number(expiresIn) * 1000 - leewayMs)
            : new Date(Date.now() + 90 * 24 * 3600 * 1000 - leewayMs);

    const block: Record<string, any> = {
        authType: 'oauth',
        enabled: true,
        accessTokenEncrypted: encryptOrgSecret(accessToken, key),
        expiresAt,
        scopes,
        installedAt: new Date(),
        updatedAt: new Date(),
    };
    if (tokenJson.refresh_token) {
        block.refreshTokenEncrypted = encryptOrgSecret(String(tokenJson.refresh_token), key);
    }
    mcpIntegrations[integrationId] = block;

    await orgRepo.updateOne(
        { OrganizationId: organizationId },
        { $set: { metadata: { ...meta, mcpIntegrations } } }
    );

    mcpOrchestrator.invalidateOrganizationCredentials(organizationId);
}

function emitResult(
    session: { socket: any; organizationName: string } | undefined,
    payload: Record<string, any>
): void {
    if (session?.socket?.connected) {
        session.socket.emit('mcp_oauth_integration_result', payload);
    }
}

async function handleOAuthCallback(
    req: Request,
    res: Response,
    provider: McpRemoteIntegrationId,
    exchangeFn: (code: string, redirectUri: string) => Promise<any>,
    redirectUri: string,
    scopesForStorage: string[]
): Promise<void> {
    const { code, state, error, error_description } = req.query;

    mcpOAuthLog.info('callback hit', {
        provider,
        path: req.path,
        originalUrl: req.originalUrl?.split('?')[0],
        redirectUri,
        ...clientMeta(req),
        oauthError: error ? String(error) : undefined,
        errorDescription:
            error_description != null ? String(error_description).slice(0, 500) : undefined,
        hasCode: Boolean(code),
        statePrefix: statePrefix(state),
    });

    if (error) {
        const sessionId = state as string;
        const session = sessionId ? mcpOAuthSessions.get(sessionId) : undefined;
        mcpOAuthLog.warn('provider returned error in callback', {
            provider,
            oauthError: String(error),
            errorDescription:
                error_description != null ? String(error_description).slice(0, 500) : undefined,
            statePrefix: statePrefix(sessionId),
            hadSocketSession: Boolean(session),
        });
        emitResult(session, {
            success: false,
            provider,
            error: String(error),
            message: error_description ? String(error_description) : String(error),
        });
        if (sessionId) {
            mcpOAuthSessions.delete(sessionId);
        }
        res.status(400).send(htmlError(`Authorization error: ${error}`));
        return;
    }

    if (!code || !state) {
        mcpOAuthLog.warn('missing code or state', {
            provider,
            hasCode: Boolean(code),
            hasState: Boolean(state),
        });
        res.status(400).send(htmlError('Missing code or state'));
        return;
    }

    const sessionId = state as string;
    const session = mcpOAuthSessions.get(sessionId);
    if (!session || session.provider !== provider) {
        mcpOAuthLog.warn('invalid or stale oauth session', {
            provider,
            statePrefix: statePrefix(sessionId),
            sessionFound: Boolean(session),
            sessionProvider: session?.provider,
        });
        res.status(400).send(htmlError('Session expired or invalid. Start the connection again.'));
        return;
    }

    if (new Date() > session.expiresAt) {
        mcpOAuthLog.warn('oauth session expired', {
            provider,
            organizationId: session.organizationId,
            statePrefix: statePrefix(sessionId),
            expiresAt: session.expiresAt.toISOString(),
        });
        mcpOAuthSessions.delete(sessionId);
        emitResult(session, { success: false, provider, error: 'SESSION_EXPIRED' });
        res.status(400).send(htmlError('Session expired'));
        return;
    }

    mcpOAuthSessions.delete(sessionId);

    mcpOAuthLog.info('exchanging code for tokens', {
        provider,
        organizationId: session.organizationId,
        organizationName: session.organizationName,
        redirectUri,
        scopesCount: scopesForStorage.length,
    });

    try {
        const tokenJson = await exchangeFn(String(code), redirectUri);
        mcpOAuthLog.info('token exchange response', {
            provider,
            organizationId: session.organizationId,
            ...summarizeTokenResponse(tokenJson),
        });
        await persistOAuthFromTokenResponse(session.organizationId, provider, tokenJson, scopesForStorage);
        mcpOAuthLog.success('oauth persisted and orchestrator cache invalidated', {
            provider,
            organizationId: session.organizationId,
            organizationName: session.organizationName,
        });
        emitResult(session, {
            success: true,
            provider,
            organizationId: session.organizationId,
            organizationName: session.organizationName,
        });
        res.send(htmlSuccess(provider));
    } catch (e: any) {
        mcpOAuthLog.error('token exchange or persist failed', e);
        emitResult(session, {
            success: false,
            provider,
            error: e?.message || 'TOKEN_EXCHANGE_FAILED',
        });
        res.status(500).send(htmlError(e?.message || 'Token exchange failed'));
    }
}

function htmlError(msg: string): string {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><h2>Something went wrong</h2><p>${escapeHtml(
        msg
    )}</p><p>You can close this window.</p></body></html>`;
}

function htmlSuccess(provider: string): string {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;text-align:center"><h2 style="color:#28a745">Connected</h2><p>${escapeHtml(
        provider
    )} is connected. You can close this window.</p></body></html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

router.get('/linear/callback', async (req: Request, res: Response) => {
    const scopes = (process.env.LINEAR_OAUTH_SCOPES || 'read,write').split(/[,\s]+/).filter(Boolean);
    await handleOAuthCallback(req, res, 'linear', exchangeLinearAuthorizationCode, linearRedirectUri(), scopes);
});

router.get('/figma/callback', async (req: Request, res: Response) => {
    const scopes = (process.env.FIGMA_OAUTH_SCOPES || 'file_content:read')
        .split(/[,\s]+/)
        .filter(Boolean);
    await handleOAuthCallback(req, res, 'figma', exchangeFigmaAuthorizationCode, figmaRedirectUri(), scopes);
});

export default router;
