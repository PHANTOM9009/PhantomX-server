import express, { Request, Response, Router } from "express";
import fetch from "node-fetch";
import { atlassianOAuthSessions } from "../socket-handlers/atlassian.handler";
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import * as crypto from 'crypto';
import { Logger } from '../utils/Logger';

const router: Router = express.Router();
const logger = new Logger('AtlassianAuthRoutes');

const DEFAULT_JIRA_WEBHOOK_EVENTS: string[] = [
    'jira:issue_created',
    'jira:issue_updated',
    'jira:issue_deleted'
];

interface JiraWebhookRegistrationInput {
    cloudId: string;
    accessToken: string;
    webhookTargetUrl: string;
    organizationId: string;
    organizationName: string;
    jqlFilter: string;
}

interface JiraWebhookRegistrationResult {
    success: boolean;
    attemptedAt: Date;
    jiraWebhookApiUrl: string;
    webhookTargetUrl: string;
    events: string[];
    jqlFilter?: string;
    statusCode?: number;
    webhookId?: string | number;
    responseBody?: any;
    error?: string;
}

function getWebhookEventsFromConfig(): string[] {
    const configured = process.env.ATLASSIAN_WEBHOOK_EVENTS;
    if (!configured) {
        return DEFAULT_JIRA_WEBHOOK_EVENTS;
    }

    const parsed = configured
        .split(',')
        .map((eventName) => eventName.trim())
        .filter(Boolean);

    if (parsed.length === 0) {
        return DEFAULT_JIRA_WEBHOOK_EVENTS;
    }

    return Array.from(new Set(parsed));
}

function getWebhookJqlFilterFromConfig(): string | null {
    const jqlFilter = process.env.ATLASSIAN_WEBHOOK_JQL_FILTER?.trim();
    if (jqlFilter && jqlFilter.length > 0) {
        return jqlFilter;
    }

    return null;
}

function buildProjectScopedWebhookJql(projectKeys: string[]): string {
    const uniqueKeys = Array.from(new Set(projectKeys.filter(Boolean)));

    if (uniqueKeys.length === 0) {
        throw new Error('NO_PROJECT_KEYS_AVAILABLE_FOR_WEBHOOK_JQL');
    }

    const escapedKeys = uniqueKeys.map((key) => key.replace(/"/g, '\\"'));

    if (escapedKeys.length === 1) {
        return `project = "${escapedKeys[0]}"`;
    }

    return `project in (${escapedKeys.map((key) => `"${key}"`).join(', ')})`;
}

function parseApiResponse(responseText: string): any {
    if (!responseText) {
        return null;
    }

    try {
        return JSON.parse(responseText);
    } catch {
        return responseText;
    }
}

function extractCreatedWebhookIds(parsedBody: any): Array<string | number> {
    if (!parsedBody) {
        return [];
    }

    const ids: Array<string | number> = [];

    const collectIds = (node: any) => {
        if (!node) {
            return;
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                collectIds(item);
            }
            return;
        }

        if (node.createdWebhookId !== undefined && node.createdWebhookId !== null) {
            ids.push(node.createdWebhookId);
        }

        if (Array.isArray(node.createdWebhookIds)) {
            ids.push(...node.createdWebhookIds.filter((id: any) => id !== undefined && id !== null));
        }

        if (Array.isArray(node.webhookRegistrationResult)) {
            for (const resultItem of node.webhookRegistrationResult) {
                collectIds(resultItem);
            }
        } else if (node.webhookRegistrationResult) {
            collectIds(node.webhookRegistrationResult);
        }
    };

    collectIds(parsedBody);

    return Array.from(new Set(ids));
}

function extractWebhookRegistrationErrors(parsedBody: any): string[] {
    if (!parsedBody) {
        return [];
    }

    const errors: string[] = [];

    const collectErrors = (node: any) => {
        if (!node) {
            return;
        }

        if (typeof node === 'string') {
            errors.push(node);
            return;
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                collectErrors(item);
            }
            return;
        }

        if (Array.isArray(node.errors)) {
            for (const err of node.errors) {
                if (typeof err === 'string') {
                    errors.push(err);
                }
            }
        }

        if (typeof node.error === 'string') {
            errors.push(node.error);
        }

        if (typeof node.message === 'string' && node.createdWebhookId === undefined) {
            errors.push(node.message);
        }

        if (Array.isArray(node.webhookRegistrationResult)) {
            for (const resultItem of node.webhookRegistrationResult) {
                collectErrors(resultItem);
            }
        }
    };

    collectErrors(parsedBody);
    return Array.from(new Set(errors));
}


async function resolveProjectKeysForWebhook(cloudId: string, accessToken: string): Promise<string[]> {
    const projectKeys: string[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
        const projectsApiUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search?maxResults=${maxResults}&startAt=${startAt}&orderBy=name`;

        const projectsResponse = await fetch(projectsApiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        });

        if (!projectsResponse.ok) {
            const responseText = await projectsResponse.text();
            throw new Error(`PROJECT_DISCOVERY_FAILED_${projectsResponse.status}: ${responseText}`);
        }

        const projectsBody: any = await projectsResponse.json();
        const values: any[] = Array.isArray(projectsBody?.values) ? projectsBody.values : [];

        for (const project of values) {
            if (project?.key) {
                projectKeys.push(project.key);
            }
        }

        const isLast = Boolean(projectsBody?.isLast);
        const fetchedCount = values.length;
        const total = typeof projectsBody?.total === 'number' ? projectsBody.total : undefined;

        if (isLast || fetchedCount === 0) {
            break;
        }

        startAt += fetchedCount;

        if (typeof total === 'number' && startAt >= total) {
            break;
        }
    }

    const uniqueProjectKeys = Array.from(new Set(projectKeys));

    if (uniqueProjectKeys.length === 0) {
        throw new Error('PROJECT_KEYS_NOT_FOUND_FOR_WEBHOOK_FILTER');
    }

    return uniqueProjectKeys;
}


async function registerJiraWebhook(input: JiraWebhookRegistrationInput): Promise<JiraWebhookRegistrationResult> {
    const webhookEvents = getWebhookEventsFromConfig();
    const jqlFilter = input.jqlFilter;
    const jiraWebhookApiUrl = `https://api.atlassian.com/ex/jira/${input.cloudId}/rest/api/3/webhook`;

    const webhookDefinition: any = {
        events: webhookEvents,
        jqlFilter
    };

    const requestBody: any = {
        url: input.webhookTargetUrl,
        webhooks: [webhookDefinition]
    };

    logger.info('[Atlassian Webhook Registration] Attempting webhook registration', {
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        jiraWebhookApiUrl,
        webhookTargetUrl: input.webhookTargetUrl,
        requestBody,
        events: webhookEvents,
        jqlFilter: jqlFilter || 'NONE'
    });

    try {
        const registrationResponse = await fetch(jiraWebhookApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${input.accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const responseText = await registrationResponse.text();
        const parsedBody = parseApiResponse(responseText);
        const createdWebhookIds = extractCreatedWebhookIds(parsedBody);
        const registrationErrors = extractWebhookRegistrationErrors(parsedBody);

        if (!registrationResponse.ok) {
            logger.warn('[Atlassian Webhook Registration] Webhook creation failed', {
                organizationId: input.organizationId,
                organizationName: input.organizationName,
                statusCode: registrationResponse.status,
                statusText: registrationResponse.statusText,
                responseHeaders: {
                    contentType: registrationResponse.headers.get('content-type'),
                    requestId: registrationResponse.headers.get('x-request-id')
                },
                responseBody: parsedBody
            });

            return {
                success: false,
                attemptedAt: new Date(),
                jiraWebhookApiUrl,
                webhookTargetUrl: input.webhookTargetUrl,
                events: webhookEvents,
                jqlFilter,
                statusCode: registrationResponse.status,
                responseBody: parsedBody,
                error: `Webhook registration failed with status ${registrationResponse.status}`
            };
        }

        if (createdWebhookIds.length === 0) {
            logger.warn('[Atlassian Webhook Registration] Registration response did not contain created webhook IDs', {
                organizationId: input.organizationId,
                organizationName: input.organizationName,
                statusCode: registrationResponse.status,
                responseBody: parsedBody,
                extractedErrors: registrationErrors
            });

            return {
                success: false,
                attemptedAt: new Date(),
                jiraWebhookApiUrl,
                webhookTargetUrl: input.webhookTargetUrl,
                events: webhookEvents,
                jqlFilter,
                statusCode: registrationResponse.status,
                responseBody: parsedBody,
                error: registrationErrors.length > 0
                    ? `Webhook registration rejected: ${registrationErrors.join('; ')}`
                    : 'Webhook registration response did not include created webhook IDs'
            };
        }

        if (registrationErrors.length > 0) {
            logger.warn('[Atlassian Webhook Registration] Webhook registered with warnings', {
                organizationId: input.organizationId,
                organizationName: input.organizationName,
                createdWebhookIds,
                warnings: registrationErrors,
                statusCode: registrationResponse.status
            });
        }

        logger.success('[Atlassian Webhook Registration] Webhook registered successfully', {
            organizationId: input.organizationId,
            organizationName: input.organizationName,
            createdWebhookIds,
            statusCode: registrationResponse.status,
            webhookTargetUrl: input.webhookTargetUrl,
            eventCount: webhookEvents.length
        });

        return {
            success: true,
            attemptedAt: new Date(),
            jiraWebhookApiUrl,
            webhookTargetUrl: input.webhookTargetUrl,
            events: webhookEvents,
            jqlFilter,
            statusCode: registrationResponse.status,
            webhookId: createdWebhookIds[0],
            responseBody: parsedBody
        };
    } catch (error: any) {
        logger.error('[Atlassian Webhook Registration] Unexpected error while creating webhook', {
            organizationId: input.organizationId,
            organizationName: input.organizationName,
            message: error?.message,
            stack: error?.stack
        });

        return {
            success: false,
            attemptedAt: new Date(),
            jiraWebhookApiUrl,
            webhookTargetUrl: input.webhookTargetUrl,
            events: webhookEvents,
            jqlFilter,
            error: error?.message || 'UNKNOWN_WEBHOOK_REGISTRATION_ERROR'
        };
    }
}

router.get('/callback', async (req: Request, res: Response): Promise<any> => {
    let session: any = null;
    
    try {
        const { code, state, error } = req.query;

        if (error) {
            console.error('[Atlassian OAuth] Error from Atlassian:', error);
            
            const sessionId = state as string;
            const session = sessionId ? atlassianOAuthSessions.get(sessionId) : null;
            if (session?.socket && session.socket.connected) {
                session.socket.emit('atlassian_integration_result', {
                    success: false,
                    message: `Authorization error: ${error}`,
                    error: String(error)
                });
                atlassianOAuthSessions.delete(sessionId);
            }
            
            return res.status(400).send(`
                <html>
                    <body>
                        <h2>Atlassian Authorization Error</h2>
                        <p>Error: ${error}</p>
                        <p>Please close this window and try again.</p>
                    </body>
                </html>
            `);
        }

        if (!code || !state) {
            console.error('[Atlassian OAuth] Missing code or state parameter');
            
            const sessionId = state as string;
            const session = sessionId ? atlassianOAuthSessions.get(sessionId) : null;
            if (session?.socket && session.socket.connected) {
                session.socket.emit('atlassian_integration_result', {
                    success: false,
                    message: 'Missing required parameters',
                    error: 'MISSING_PARAMETERS'
                });
                atlassianOAuthSessions.delete(sessionId);
            }
            
            return res.status(400).send(`
                <html>
                    <body>
                        <h2>Invalid Request</h2>
                        <p>Missing required parameters.</p>
                        <p>Please close this window and try again.</p>
                    </body>
                </html>
            `);
        }

        const sessionId = state as string;

        session = atlassianOAuthSessions.get(sessionId);

        if (!session) {
            console.error('[Atlassian OAuth] Session not found or expired:', sessionId);
            return res.status(400).send(`
                <html>
                    <body>
                        <h2>Session Expired</h2>
                        <p>Your authorization session has expired or is invalid.</p>
                        <p>Please close this window and start the installation process again.</p>
                    </body>
                </html>
            `);
        }

        if (new Date() > session.expiresAt) {
            if (session.socket && session.socket.connected) {
                session.socket.emit('atlassian_integration_result', {
                    success: false,
                    message: 'Session expired',
                    error: 'SESSION_EXPIRED'
                });
            }
            atlassianOAuthSessions.delete(sessionId);
            console.error('[Atlassian OAuth] Session expired:', sessionId);
            return res.status(400).send(`
                <html>
                    <body>
                        <h2>Session Expired</h2>
                        <p>Your authorization session has expired.</p>
                        <p>Please close this window and start the installation process again.</p>
                    </body>
                </html>
            `);
        }

        atlassianOAuthSessions.delete(sessionId);

        console.log(`[Atlassian OAuth] Processing callback for session ${sessionId}, user: ${session.userId}, org: ${session.organizationName}`);

        const CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
        const CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
        const REDIRECT_URI = process.env.ATLASSIAN_REDIRECT_URI || `${process.env.APP_URL}/api/auth/atlassian/callback`;

        if (!CLIENT_ID || !CLIENT_SECRET) {
            if (session.socket && session.socket.connected) {
                session.socket.emit('atlassian_integration_result', {
                    success: false,
                    message: 'Server configuration error',
                    error: 'MISSING_CREDENTIALS'
                });
            }
            console.error('[Atlassian OAuth] Missing client credentials');
            return res.status(500).send(`
                <html>
                    <body>
                        <h2>Configuration Error</h2>
                        <p>Server configuration error. Please contact support.</p>
                    </body>
                </html>
            `);
        }

        const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            })
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error('[Atlassian OAuth] Token exchange failed:', tokenResponse.status, errorText);
            return res.status(500).send(`
                <html>
                    <body>
                        <h2>Token Exchange Failed</h2>
                        <p>Failed to exchange authorization code for access token.</p>
                        <p>Please close this window and try again.</p>
                    </body>
                </html>
            `);
        }

        const tokenJson: any = await tokenResponse.json();

        console.log('[Atlassian OAuth] Successfully exchanged code for tokens');

        const resourcesResponse = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
            headers: {
                'Authorization': `Bearer ${tokenJson.access_token}`,
                'Accept': 'application/json'
            }
        });

        if (!resourcesResponse.ok) {
            const errorText = await resourcesResponse.text();
            console.error('[Atlassian OAuth] Failed to get accessible resources:', resourcesResponse.status, errorText);
            return res.status(500).send(`
                <html>
                    <body>
                        <h2>Failed to Retrieve Resources</h2>
                        <p>Could not retrieve your Atlassian sites.</p>
                        <p>Please close this window and try again.</p>
                    </body>
                </html>
            `);
        }

        const resources: any[] = await resourcesResponse.json();

        if (!resources || resources.length === 0) {
            console.error('[Atlassian OAuth] No accessible resources found');
            return res.status(400).send(`
                <html>
                    <body>
                        <h2>No Accessible Resources</h2>
                        <p>No Jira sites found for your account.</p>
                        <p>Please ensure you have access to at least one Jira site.</p>
                    </body>
                </html>
            `);
        }

        const resource = resources[0];
        console.log(`[Atlassian OAuth] Found resource: ${resource.name} (${resource.id})`);

        const encryptionKey = process.env.SECRET_ENCRYPTION_KEY || 'phantomx';
        const accessTokenEncrypted = encryptToken(tokenJson.access_token, encryptionKey);
        const refreshTokenEncrypted = tokenJson.refresh_token 
            ? encryptToken(tokenJson.refresh_token, encryptionKey) 
            : undefined;

        // Prepare Atlassian metadata
        const atlassianMetadata: any = {
            tenantId: resource.id,
            siteUrl: resource.url,
            siteName: resource.name,
            userId: session.userId,
            accessTokenEncrypted,
            scopes: tokenJson.scope.split(' '),
            expiresAt: new Date(Date.now() + tokenJson.expires_in * 1000),
            installedAt: new Date(),
            meta: { 
                tokenJson: {
                    ...tokenJson,
                    access_token: '[ENCRYPTED]',
                    refresh_token: tokenJson.refresh_token ? '[ENCRYPTED]' : undefined
                },
                resources 
            }
        };

        if (refreshTokenEncrypted) {
            atlassianMetadata.refreshTokenEncrypted = refreshTokenEncrypted;
        }

        const databaseService = DatabaseService.getInstance();
        
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            console.error('[Atlassian OAuth] ORGANIZATION_DB not configured');
            return res.status(500).send(`
                <html>
                    <body>
                        <h2>Configuration Error</h2>
                        <p>Server configuration error. Please contact support.</p>
                    </body>
                </html>
            `);
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organization = await organizationRepository.findOne({ 
            OrganizationId: session.organizationId 
        });

        if (!organization) {
            console.error('[Atlassian OAuth] Organization not found:', session.organizationId);
            return res.status(404).send(`
                <html>
                    <body>
                        <h2>Organization Not Found</h2>
                        <p>Could not find your organization.</p>
                        <p>Please contact support.</p>
                    </body>
                </html>
            `);
        }

        const configuredWebhookTargetUrl = process.env.ATLASSIAN_WEBHOOK_TARGET_URL?.trim() || '';
        const webhookBaseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
        const webhookTargetUrl = configuredWebhookTargetUrl || (webhookBaseUrl ? `${webhookBaseUrl}/api/auth/atlassian/webhook` : '');
        let webhookRegistrationResult: JiraWebhookRegistrationResult;

        logger.info('[Atlassian Webhook Registration] Resolved webhook target URL', {
            organizationId: session.organizationId,
            organizationName: session.organizationName,
            configuredWebhookTargetUrl: configuredWebhookTargetUrl || 'NONE',
            appUrlDerivedTarget: webhookBaseUrl ? `${webhookBaseUrl}/api/auth/atlassian/webhook` : 'NONE',
            finalWebhookTargetUrl: webhookTargetUrl || 'NONE'
        });

        if (!webhookTargetUrl) {
            logger.warn('[Atlassian Webhook Registration] Skipping webhook registration because callback URL base is not configured', {
                organizationId: session.organizationId,
                organizationName: session.organizationName,
                requiredEnvVars: ['ATLASSIAN_WEBHOOK_TARGET_URL or APP_URL']
            });

            webhookRegistrationResult = {
                success: false,
                attemptedAt: new Date(),
                jiraWebhookApiUrl: `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/webhook`,
                webhookTargetUrl: '',
                events: getWebhookEventsFromConfig(),
                jqlFilter: undefined,
                error: 'WEBHOOK_TARGET_URL_NOT_CONFIGURED'
            };
        } else {
            let jqlFilterForWebhook = getWebhookJqlFilterFromConfig();

            if (!jqlFilterForWebhook) {
                try {
                    const projectKeysForWebhook = await resolveProjectKeysForWebhook(resource.id, tokenJson.access_token);
                    jqlFilterForWebhook = buildProjectScopedWebhookJql(projectKeysForWebhook);

                    logger.info('[Atlassian Webhook Registration] Auto-generated org-wide project JQL filter', {
                        organizationId: session.organizationId,
                        organizationName: session.organizationName,
                        projectCount: projectKeysForWebhook.length,
                        sampleProjectKeys: projectKeysForWebhook.slice(0, 10),
                        generatedJqlFilter: jqlFilterForWebhook
                    });
                } catch (projectDiscoveryError: any) {
                    logger.warn('[Atlassian Webhook Registration] Failed to auto-discover projects for webhook JQL', {
                        organizationId: session.organizationId,
                        organizationName: session.organizationName,
                        message: projectDiscoveryError?.message
                    });
                    jqlFilterForWebhook = 'project IS NOT EMPTY';
                }
            }

            webhookRegistrationResult = await registerJiraWebhook({
                cloudId: resource.id,
                accessToken: tokenJson.access_token,
                webhookTargetUrl,
                organizationId: session.organizationId,
                organizationName: session.organizationName,
                jqlFilter: jqlFilterForWebhook
            });
        }

        atlassianMetadata.webhook = {
            enabled: webhookRegistrationResult.success,
            ...webhookRegistrationResult
        };

        const currentMetadata = organization.metadata || {};
        const updatedMetadata = {
            ...currentMetadata,
            atlassian: atlassianMetadata
        };

        await organizationRepository.updateOne(
            { OrganizationId: session.organizationId },
            { $set: { metadata: updatedMetadata } }
        );

        logger.success('[Atlassian OAuth] Successfully stored Atlassian credentials and webhook registration metadata', {
            organizationName: session.organizationName,
            organizationId: session.organizationId,
            jiraSiteUrl: resource.url,
            webhookRegistered: webhookRegistrationResult.success,
            webhookStatusCode: webhookRegistrationResult.statusCode,
            webhookId: webhookRegistrationResult.webhookId
        });

        // Emit success event to the original socket
        if (session.socket && session.socket.connected) {
            session.socket.emit('atlassian_integration_result', {
                success: true,
                message: 'Atlassian integration successful',
                data: {
                    tenantId: resource.id,
                    siteUrl: resource.url,
                    siteName: resource.name,
                    organizationId: session.organizationId,
                    organizationName: session.organizationName
                }
            });
            console.log(`[Atlassian OAuth] Emitted success event to socket ${session.socket.id}`);
        }

        // Success response
        return res.send(`
            <html>
                <head>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            max-width: 600px;
                            margin: 50px auto;
                            padding: 20px;
                            text-align: center;
                        }
                        .success { color: #28a745; }
                        .info {
                            background-color: #f8f9fa;
                            padding: 15px;
                            border-radius: 5px;
                            margin: 20px 0;
                        }
                        .countdown { font-size: 14px; color: #6c757d; margin-top: 20px; }
                        .manual-close { font-size: 12px; color: #999; margin-top: 8px; }
                    </style>
                </head>
                <body>
                    <h1 class="success">✓ Atlassian Integration Successful!</h1>
                    <div class="info">
                        <p><strong>Organization:</strong> ${session.organizationName}</p>
                        <p><strong>Jira Site:</strong> ${resource.name}</p>
                        <p><strong>Site URL:</strong> ${resource.url}</p>
                    </div>
                    <p class="countdown">This window will close automatically in <span id="countdown">5</span> seconds...</p>
                    <p class="manual-close">If it does not close, you can close it manually.</p>
                    <script>
                        (function(){
                            let countdown = 5;
                            function tick(){
                                const el = document.getElementById('countdown');
                                if(el){ el.textContent = countdown; }
                                if(countdown <= 0){
                                    // Attempt to notify opener (in case close is blocked)
                                    try { window.opener && window.opener.postMessage({ type: 'ATLASSIAN_INTEGRATION_COMPLETED' }, '*'); } catch(e) {}
                                    try { window.close(); } catch(e) {}
                                    return;
                                }
                                countdown--;
                            }
                            document.addEventListener('DOMContentLoaded', () => {
                                tick();
                                setInterval(tick, 1000);
                            });
                        })();
                    </script>
                </body>
            </html>
        `);

    } catch (error: any) {
        console.error('[Atlassian OAuth] Callback error:', error);
        
        if (session?.socket && session.socket.connected) {
            session.socket.emit('atlassian_integration_result', {
                success: false,
                message: 'An unexpected error occurred during installation',
                error: error.message || 'UNKNOWN_ERROR'
            });
        }
        
        return res.status(500).send(`
            <html>
                <body>
                    <h2>Installation Failed</h2>
                    <p>An unexpected error occurred during the installation process.</p>
                    <p>Error: ${error.message}</p>
                    <p>Please close this window and try again.</p>
                </body>
            </html>
        `);
    }
});

router.post('/webhook', async (req: Request, res: Response): Promise<any> => {
    try {
        const eventType = (req.headers['x-atlassian-webhook-event'] || req.headers['x-atlassian-webhook-identifier'] || 'UNKNOWN_EVENT') as string;
        const retryCount = req.headers['x-atlassian-webhook-retry'];
        const webhookIdentifier = req.headers['x-atlassian-webhook-identifier'];
        const traceId = req.headers['x-b3-traceid'];

        logger.info('[Atlassian Webhook] Event received', {
            eventType,
            webhookIdentifier,
            retryCount,
            traceId,
            userAgent: req.headers['user-agent'],
            contentType: req.headers['content-type']
        });

        const payload = req.body;
        const payloadPreview = typeof payload === 'object' && payload !== null
            ? {
                webhookEvent: (payload as any).webhookEvent,
                timestamp: (payload as any).timestamp,
                issue: (payload as any).issue
                    ? {
                        id: (payload as any).issue.id,
                        key: (payload as any).issue.key,
                        self: (payload as any).issue.self
                    }
                    : undefined,
                comment: (payload as any).comment
                    ? {
                        id: (payload as any).comment.id,
                        self: (payload as any).comment.self
                    }
                    : undefined,
                changelog: (payload as any).changelog
                    ? {
                        id: (payload as any).changelog.id,
                        itemsCount: Array.isArray((payload as any).changelog.items)
                            ? (payload as any).changelog.items.length
                            : 0
                    }
                    : undefined
            }
            : payload;

        logger.info('[Atlassian Webhook] Payload preview', payloadPreview);

        return res.status(200).json({
            success: true,
            message: 'Webhook event received'
        });
    } catch (error: any) {
        logger.error('[Atlassian Webhook] Failed to process webhook payload', {
            message: error?.message,
            stack: error?.stack
        });

        return res.status(500).json({
            success: false,
            error: 'WEBHOOK_PROCESSING_FAILED'
        });
    }
});



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


export function decryptToken(encryptedToken: string, encryptionKey: string): string {
    const algorithm = 'aes-256-gcm';
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    
    const parts = encryptedToken.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted token format');
    }
    
    const [ivHex, authTagHex, encryptedData] = parts;
    
    const decipher = crypto.createDecipheriv(
        algorithm,
        key,
        Buffer.from(ivHex, 'hex')
    ) as crypto.DecipherGCM;
    
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

export default router;
