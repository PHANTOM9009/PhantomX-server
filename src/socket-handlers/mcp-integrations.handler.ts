import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { UserInfo } from '../DataStructures';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { isRemoteMcpIntegrationId, type McpRemoteIntegrationId } from '../Services/mcp/integrationRegistry';
import { mcpOrchestrator } from '../Services/mcp/McpOrchestratorService';
import { mcpOAuthSessions } from './mcp-oauth-sessions';

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

/**
 * Owner-only: start browser OAuth for Linear or Figma MCP (tokens stored on org metadata).
 */
export function mcp_integrations_handler(_io: Server, socket: Socket) {
    socket.on('start_mcp_oauth', async (data: { integrationId?: string }, callback) => {
        try {
            if (typeof callback !== 'function') {
                return;
            }
            if (!socket.data.user?.userId) {
                callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const userInfo = UserInfo.get(userId);
            if (!userInfo?.organizationId || !userInfo.organizationName) {
                callback({ success: false, error: 'User organization information not found' });
                return;
            }

            const dbService = DatabaseService.getInstance();
            if (!dbService.isConnected()) {
                await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const userCredRepo = dbService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB!,
                process.env.USER_CREDENTIAL_COLLECTION!
            );
            const userCredentials = await userCredRepo.findOne({ userId });
            if (!userCredentials) {
                callback({ success: false, error: 'User credentials not found' });
                return;
            }
            if (userCredentials.organizationRole !== 'Owner') {
                callback({ success: false, error: 'Only organization owners can connect MCP integrations' });
                return;
            }

            const integrationId = data?.integrationId?.trim() as McpRemoteIntegrationId | undefined;
            if (!integrationId || !isRemoteMcpIntegrationId(integrationId)) {
                callback({ success: false, error: 'Invalid integrationId' });
                return;
            }

            const sessionId = uuidv4();
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

            mcpOAuthSessions.set(sessionId, {
                sessionId,
                provider: integrationId,
                userId,
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName,
                socket,
                createdAt: now,
                expiresAt,
            });

            if (integrationId === 'linear') {
                const clientId = process.env.LINEAR_OAUTH_CLIENT_ID || process.env.LINEAR_CLIENT_ID;
                if (!clientId) {
                    mcpOAuthSessions.delete(sessionId);
                    callback({ success: false, error: 'LINEAR_OAUTH_CLIENT_ID not configured' });
                    return;
                }
                const scope = process.env.LINEAR_OAUTH_SCOPES || 'read,write';
                const redirect = linearRedirectUri();
                if (!/^https?:\/\//i.test(redirect)) {
                    mcpOAuthSessions.delete(sessionId);
                    callback({
                        success: false,
                        error:
                            'Linear redirect URI must be a full URL. Set APP_URL (e.g. https://www.phantomx.dev) or LINEAR_OAUTH_REDIRECT_URI to match a Callback URL in your Linear app.',
                    });
                    return;
                }
                const authUrl =
                    `https://linear.app/oauth/authorize?` +
                    `client_id=${encodeURIComponent(clientId)}` +
                    `&redirect_uri=${encodeURIComponent(redirect)}` +
                    `&response_type=code` +
                    `&scope=${encodeURIComponent(scope)}` +
                    `&state=${encodeURIComponent(sessionId)}` +
                    `&prompt=consent`;
                callback({ success: true, authUrl, sessionId, integrationId });
                return;
            }

            if (integrationId === 'figma') {
                const clientId = process.env.FIGMA_OAUTH_CLIENT_ID || process.env.FIGMA_CLIENT_ID;
                if (!clientId) {
                    mcpOAuthSessions.delete(sessionId);
                    callback({ success: false, error: 'FIGMA_OAUTH_CLIENT_ID not configured' });
                    return;
                }
                const scope = process.env.FIGMA_OAUTH_SCOPES || 'file_content:read';
                const redirect = figmaRedirectUri();
                if (!/^https?:\/\//i.test(redirect)) {
                    mcpOAuthSessions.delete(sessionId);
                    callback({
                        success: false,
                        error:
                            'Figma redirect URI must be a full URL. Set APP_URL or FIGMA_OAUTH_REDIRECT_URI to match a redirect URL in your Figma OAuth app.',
                    });
                    return;
                }
                const authUrl =
                    `https://www.figma.com/oauth?` +
                    `client_id=${encodeURIComponent(clientId)}` +
                    `&redirect_uri=${encodeURIComponent(redirect)}` +
                    `&scope=${encodeURIComponent(scope)}` +
                    `&state=${encodeURIComponent(sessionId)}` +
                    `&response_type=code`;
                callback({ success: true, authUrl, sessionId, integrationId });
                return;
            }

            mcpOAuthSessions.delete(sessionId);
            callback({ success: false, error: 'Unsupported integration' });
        } catch (e: any) {
            console.error('[start_mcp_oauth]', e);
            callback({ success: false, error: e?.message || 'Unexpected error' });
        }
    });

    socket.on('clear_org_mcp_integration', async (data: { integrationId?: string }, callback) => {
        try {
            if (typeof callback !== 'function') {
                return;
            }
            if (!socket.data.user?.userId) {
                callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const userInfo = UserInfo.get(userId);
            if (!userInfo?.organizationId) {
                callback({ success: false, error: 'User organization information not found' });
                return;
            }

            const dbService = DatabaseService.getInstance();
            if (!dbService.isConnected()) {
                await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const userCredRepo = dbService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB!,
                process.env.USER_CREDENTIAL_COLLECTION!
            );
            const userCredentials = await userCredRepo.findOne({ userId });
            if (!userCredentials || userCredentials.organizationRole !== 'Owner') {
                callback({ success: false, error: 'Only organization owners can disconnect MCP integrations' });
                return;
            }

            const integrationId = data?.integrationId?.trim();
            if (!integrationId || !isRemoteMcpIntegrationId(integrationId)) {
                callback({ success: false, error: 'Invalid integrationId' });
                return;
            }

            const orgRepo = dbService.getRepository<any>(process.env.ORGANIZATION_DB!, CollectionNames.ORGANIZATIONS);
            const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
            if (!organization) {
                callback({ success: false, error: 'Organization not found' });
                return;
            }

            const meta = organization.metadata || {};
            const mcpIntegrations = { ...(meta.mcpIntegrations || {}) };
            delete mcpIntegrations[integrationId];

            await orgRepo.updateOne(
                { OrganizationId: userInfo.organizationId },
                { $set: { metadata: { ...meta, mcpIntegrations } } }
            );

            mcpOrchestrator.invalidateOrganizationCredentials(userInfo.organizationId);

            callback({ success: true, integrationId });
        } catch (e: any) {
            console.error('[clear_org_mcp_integration]', e);
            callback({ success: false, error: e?.message || 'Unexpected error' });
        }
    });

    socket.on('get_org_mcp_integrations_status', async (_data: unknown, callback) => {
        try {
            if (typeof callback !== 'function') {
                return;
            }
            if (!socket.data.user?.userId) {
                callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const userInfo = UserInfo.get(userId);
            if (!userInfo?.organizationId) {
                callback({ success: false, error: 'User organization information not found' });
                return;
            }

            const dbService = DatabaseService.getInstance();
            if (!dbService.isConnected()) {
                await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgRepo = dbService.getRepository<any>(process.env.ORGANIZATION_DB!, CollectionNames.ORGANIZATIONS);
            const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
            const mcp = organization?.metadata?.mcpIntegrations || {};

            const isConfigured = (block: any) =>
                block &&
                block.enabled !== false &&
                (Boolean(block.accessTokenEncrypted) ||
                    Boolean(block.refreshTokenEncrypted) ||
                    Boolean(block.apiKeyEncrypted));

            callback({
                success: true,
                integrations: {
                    linear: { configured: isConfigured(mcp.linear), authType: mcp.linear?.authType || null },
                    figma: { configured: isConfigured(mcp.figma), authType: mcp.figma?.authType || null },
                },
            });
        } catch (e: any) {
            console.error('[get_org_mcp_integrations_status]', e);
            callback({ success: false, error: e?.message || 'Unexpected error' });
        }
    });
}
