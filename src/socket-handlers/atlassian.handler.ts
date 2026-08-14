import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { UserInfo } from '../DataStructures';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import SmeeClient from 'smee-client';
import fetch from 'node-fetch';
import * as crypto from 'crypto';
import { jiraSearch, jiraGetAllProjects } from '../Services/mcp/jiraMcpClient';
import * as dotenv from "dotenv";
dotenv.config();
export const atlassianOAuthSessions: Map<string, {
    sessionId: string;
    userId: string;
    organizationId: string;
    organizationName: string;
    socket: Socket;
    createdAt: Date;
    expiresAt: Date;
}> = new Map();


export async function atlassian_handler(io: Server, socket: Socket) {
    socket.on('start_atlassian_installation', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const userId = socket.data.user.userId;
            const userInfo = UserInfo.get(userId);

            if (!userInfo || !userInfo.organizationId || !userInfo.organizationName) {
                callback({
                    success: false,
                    error: 'User organization information not found'
                });
                return;
            }

            const databaseService = DatabaseService.getInstance();
            
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const userCredRepo = databaseService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB!,
                process.env.USER_CREDENTIAL_COLLECTION!
            );

            const userCredentials = await userCredRepo.findOne({ userId: userId });

            if (!userCredentials) {
                callback({
                    success: false,
                    error: 'User credentials not found'
                });
                return;
            }

            if (userCredentials.organizationRole !== 'Owner') {
                callback({
                    success: false,
                    error: 'Only organization owners can install Atlassian integration'
                });
                return;
            }

            const sessionId = uuidv4();
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); 

            atlassianOAuthSessions.set(sessionId, {
                sessionId,
                userId,
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName,
                socket: socket,
                createdAt: now,
                expiresAt
            });

            console.log(`[start_atlassian_installation] Created OAuth session ${sessionId} for user ${userId}, org: ${userInfo.organizationName}`);

            const CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
            const SCOPES = process.env.ATLASSIAN_SCOPES || 'read:jira-work write:jira-work read:jira-user offline_access';
            const REDIRECT_URI = process.env.ATLASSIAN_REDIRECT_URI || `${process.env.APP_URL}/api/auth/atlassian/callback`;

            if (!CLIENT_ID) {
                callback({
                    success: false,
                    error: 'Atlassian client ID not configured'
                });
                return;
            }

            const authUrl = `https://auth.atlassian.com/authorize?` +
                `audience=api.atlassian.com&client_id=${CLIENT_ID}` +
                `&scope=${encodeURIComponent(SCOPES)}` +
                `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
                `&state=${sessionId}` +
                `&response_type=code&prompt=consent`;

            callback({
                success: true,
                authUrl,
                sessionId
            });

        } catch (error: any) {
            console.error('[start_atlassian_installation] Error:', error);
            callback({
                success: false,
                error: 'Failed to start Atlassian installation',
                message: error.message
            });
        }
    });

    socket.on('is_atlassian_installed', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({ success: false, error: 'User not authenticated' });
                return;
            }

            const userId = socket.data.user.userId;
            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                callback({ success: false, error: 'Organization information not found' });
                return;
            }

            const databaseService = DatabaseService.getInstance();
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgRepo = databaseService.getRepository<any>(
                process.env.ORGANIZATION_DB!,
                process.env.ORGANIZATION_COLLECTION!
            );

            const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
            if (!organization) {
                callback({ success: true, installed: false, reason: 'ORGANIZATION_NOT_FOUND' });
                return;
            }

            const atlassianMeta = organization.metadata?.atlassian;
            if (!atlassianMeta) {
                callback({ success: true, installed: false, reason: 'NOT_INSTALLED' });
                return;
            }

            let accessTokenValid = false;
            if (atlassianMeta.expiresAt) {
                try {
                    const expires = new Date(atlassianMeta.expiresAt);
                    accessTokenValid = expires.getTime() > Date.now();
                } catch {}
            }

            const hasRefreshToken = !!atlassianMeta.refreshTokenEncrypted;
            const installed = hasRefreshToken;

            callback({
                success: true,
                installed,
                accessTokenValid,
                needsAccessTokenRefresh: installed && !accessTokenValid,
                details: installed ? {
                    tenantId: atlassianMeta.tenantId,
                    siteUrl: atlassianMeta.siteUrl,
                    siteName: atlassianMeta.siteName,
                    expiresAt: atlassianMeta.expiresAt,
                    scopes: atlassianMeta.scopes
                } : undefined
            });
        } catch (err: any) {
            console.error('[is_atlassian_installed] Error:', err);
            callback({ success: false, error: 'FAILED_TO_CHECK_INSTALLATION', message: err.message });
        }
    });

    // Disconnect Atlassian/Jira integration - Owner only
    socket.on('disconnect_atlassian_integration', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const userId = socket.data.user.userId;
            const userInfo = UserInfo.get(userId);

            if (!userInfo || !userInfo.organizationId || !userInfo.organizationName) {
                callback({
                    success: false,
                    error: 'User organization information not found'
                });
                return;
            }

            // Check if user is organization owner
            const organizationId = userInfo.organizationId;
            if (!userInfo.permissionScopes || userInfo.permissionScopes[organizationId] !== 'Owner') {
                callback({
                    success: false,
                    error: 'Only organization owners can disconnect integrations'
                });
                return;
            }

            const databaseService = DatabaseService.getInstance();
            
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgRepo = databaseService.getRepository<any>(
                process.env.ORGANIZATION_DB!,
                process.env.ORGANIZATION_COLLECTION!
            );

            // Remove the atlassian metadata from the organization
            const result = await orgRepo.updateOne(
                { OrganizationId: userInfo.organizationId },
                { $unset: { 'metadata.atlassian': '' } }
            );

            if (result.modifiedCount > 0) {
                console.log(`[disconnect_atlassian_integration] Successfully removed Atlassian integration for org: ${userInfo.organizationName}`);
                callback({
                    success: true,
                    message: 'Jira integration disconnected successfully'
                });
            } else {
                callback({
                    success: false,
                    error: 'No Jira integration found to disconnect'
                });
            }
        } catch (error: any) {
            console.error('[disconnect_atlassian_integration] Error:', error);
            callback({
                success: false,
                error: 'Failed to disconnect Jira integration',
                message: error.message
            });
        }
    });

    // Fetch Jira tickets for the organization (simple search)
    socket.on('get_tickets', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({ success: false, error: 'USER_NOT_AUTHENTICATED' });
                return;
            }

            const userId = socket.data.user.userId;
            let jql = data?.jql || '';
            const ticketId = data?.ticket;
            if (ticketId) {
                jql = `issue = ${ticketId}`;
            }
            const maxResults = Math.min(Math.max(Number(data?.maxResults) || 50, 1), 100);

            // Use MCP client to fetch Jira issues
            const mcpResult = await jiraSearch(userId, jql, { limit: maxResults });

            if (mcpResult.type === 'error') {
                callback({ 
                    success: false, 
                    error: mcpResult.error, 
                    statusCode: mcpResult.status_code, 
                    message: mcpResult.error 
                });
                return;
            }

            // Extract issues from MCP response
            const output = mcpResult.output || {};
            const issues = output.issues || [];

            callback({
                success: true,
                total: output.total || issues.length,
                issues: issues.map((i: any) => ({
                    id: i.id,
                    key: i.key,
                    summary: i.fields?.summary,
                    status: i.fields?.status?.name,
                    issuetype: i.fields?.issuetype?.name,
                    updated: i.fields?.updated,
                    created: i.fields?.created,
                }))
            });
        } catch (e: any) {
            console.error('[get_tickets] Error:', e);
            callback({ success: false, error: 'UNEXPECTED_ERROR', message: e.message });
        }
    });

    // Fetch all Jira projects for the organization
    socket.on('get_all_projects', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({ success: false, error: 'USER_NOT_AUTHENTICATED' });
                return;
            }
            const userId = socket.data.user.userId;
            const mcpResult = await jiraGetAllProjects(userId);
            if (mcpResult.type === 'error') {
                callback({ 
                    success: false, 
                    error: mcpResult.error, 
                    statusCode: mcpResult.status_code, 
                    message: mcpResult.error 
                });
                return;
            }
            const output = mcpResult.output || {};
            const projects = output.projects || [];
            callback({
                success: true,
                total: projects.length,
                projects
            });
        } catch (e: any) {
            console.error('[get_all_projects] Error:', e);
            callback({ success: false, error: 'UNEXPECTED_ERROR', message: e.message });
        }
    });
}


function decryptToken(encryptedToken: string, encryptionKey: string): string {
    const algorithm = 'aes-256-gcm';
    const [ivHex, authTagHex, encryptedData] = encryptedToken.split(':');
    if (!ivHex || !authTagHex || !encryptedData) {
        throw new Error('INVALID_TOKEN_FORMAT');
    }
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(ivHex, 'hex')) as crypto.DecipherGCM;
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function encryptToken(token: string, encryptionKey: string): string {
    const algorithm = 'aes-256-gcm';
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv) as crypto.CipherGCM;
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export interface AtlassianAccessTokenResult {
    success: boolean;
    accessToken?: string;
    refreshed?: boolean;
    statusCode?: number;
    error?: string;
    message?: string;
}

export async function getAtlassianAccessTokenForUser(userId: string): Promise<AtlassianAccessTokenResult> {
    try {
        let userInfo;
        if(!userId) {
            return { success: false, statusCode: 400, error: 'USER_ID_MISSING', message: 'User ID is required' };
        }
        userInfo = UserInfo.get(userId);
        if (!userInfo || !userInfo.organizationId) {
            return { success: false, statusCode: 400, error: 'ORG_INFO_NOT_FOUND', message: 'User organization information not found' };
        }

        const dbService = DatabaseService.getInstance();
        if (!dbService.isConnected()) {
            await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgRepo = dbService.getRepository<any>(
            process.env.ORGANIZATION_DB!,
            process.env.ORGANIZATION_COLLECTION!
        );

        const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
        if (!organization) {
            return { success: false, statusCode: 404, error: 'ORG_NOT_FOUND', message: 'Organization not found' };
        }

        const meta = organization.metadata?.atlassian;
        if (!meta) {
            return { success: false, statusCode: 404, error: 'ATLASSIAN_NOT_INSTALLED', message: 'Atlassian integration not installed' };
        }

        const encryptionKey = process.env.SECRET_ENCRYPTION_KEY || 'phantomx';

        let accessTokenDecrypted: string | null = null;
        const nowTs = Date.now();
        const expiresAtTs = meta.expiresAt ? new Date(meta.expiresAt).getTime() : 0;
        const isAccessTokenValid = expiresAtTs > nowTs + 5000; // 5s leeway

        if (isAccessTokenValid && meta.accessTokenEncrypted) {
            try {
                accessTokenDecrypted = decryptToken(meta.accessTokenEncrypted, encryptionKey);
                return { success: true, accessToken: accessTokenDecrypted, refreshed: false };
            } catch (e) {
                console.warn('[Atlassian] Failed to decrypt existing access token, attempting refresh');
            }
        }

        // Need to refresh
        if (!meta.refreshTokenEncrypted) {
            return { success: false, statusCode: 401, error: 'REFRESH_TOKEN_MISSING', message: 'Refresh token not available' };
        }

        let refreshToken: string;
        try {
            refreshToken = decryptToken(meta.refreshTokenEncrypted, encryptionKey);
        } catch (e: any) {
            return { success: false, statusCode: 401, error: 'REFRESH_TOKEN_DECRYPT_FAILED', message: e.message };
        }

        const CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
        const CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
        if (!CLIENT_ID || !CLIENT_SECRET) {
            return { success: false, statusCode: 500, error: 'MISSING_CLIENT_CONFIG', message: 'Atlassian client credentials not configured' };
        }

        const refreshResp = await fetch('https://auth.atlassian.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: refreshToken
            })
        });

        if (!refreshResp.ok) {
            let bodyText: string = '';
            try { bodyText = await refreshResp.text(); } catch {}
            let bodyJson: any = null;
            try { bodyJson = JSON.parse(bodyText); } catch {}
            if (bodyJson?.error === 'invalid_grant') {
                return { success: false, statusCode: 401, error: 'REFRESH_TOKEN_EXPIRED', message: 'Refresh token expired or invalid' };
            }
            return { success: false, statusCode: 401, error: 'REFRESH_FAILED', message: `Refresh failed: ${refreshResp.status}` };
        }

        const tokenJson: any = await refreshResp.json();
        if (!tokenJson.access_token || !tokenJson.expires_in) {
            return { success: false, statusCode: 401, error: 'INVALID_REFRESH_RESPONSE', message: 'Missing access_token/expires_in in refresh response' };
        }

        const newAccessEncrypted = encryptToken(tokenJson.access_token, encryptionKey);
        const newExpiresAt = new Date(Date.now() + tokenJson.expires_in * 1000);
        let update: any = {
            'metadata.atlassian.accessTokenEncrypted': newAccessEncrypted,
            'metadata.atlassian.expiresAt': newExpiresAt
        };
        if (tokenJson.refresh_token) {
            try {
                update['metadata.atlassian.refreshTokenEncrypted'] = encryptToken(tokenJson.refresh_token, encryptionKey);
            } catch (e) {
                console.warn('[Atlassian] Failed encrypt new refresh token');
            }
        }

        await orgRepo.updateOne(
            { OrganizationId: userInfo.organizationId },
            { $set: update }
        );

        return { success: true, accessToken: tokenJson.access_token, refreshed: true };
    } catch (err: any) {
        console.error('[getAtlassianAccessTokenForUser] Error:', err);
        return { success: false, statusCode: 500, error: 'UNEXPECTED_ERROR', message: err.message };
    }
}



