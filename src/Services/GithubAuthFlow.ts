import express from "express";
import type { Request, Response } from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { spawnSync, exec } from "child_process";
import * as dotenv from 'dotenv';
import fs from 'fs';
import { serverMode } from "../socket-server";

// Load environment variables from the root .env file
dotenv.config();
// Types
const SmeeClient = require('smee-client')

const smee = new SmeeClient({
  source: 'https://smee.io/pIZGABFchezKlej',
  target: 'http://localhost:4000/webhooks/github',
  logger: console
});
const events = smee.start();

interface InstallationRecord {
  account: {
    login: string;
    id: number;
    type: string;
    [key: string]: any;
  };
  token: string;
  expiresAt: Date;
}

interface GitHubWebhookRequest extends Request {
  body: any;
}

// OAuth token store
interface OAuthTokenRecord {
  accessToken: string;
  tokenType: string;
  scope: string;
  refreshToken?: string;
  expiresAt?: Date;
  userId?: string;
}


// OAuth state store for CSRF protection
interface OAuthStateRecord {
  state: string;
  createdAt: Date;
  expiresAt: Date;
}

// In-memory stores (replace with persistent store in production)
const installations: Record<number, InstallationRecord> = {};
const oauthTokens: Record<string, OAuthTokenRecord> = {};
const oauthStates: Record<string, OAuthStateRecord> = {}; // Store states for validation

// GitHub App Configuration
const APP_ID: any = process.env.GITHUB_APP_ID;
const PRIVATE_KEY_PATH: any = process.env.GITHUB_PRIVATE_KEY_PATH;
const WEBHOOK_SECRET: any = process.env.WEHOOK_SECRET;

// OAuth 2.0 Configuration
const OAUTH_CLIENT_ID: any = process.env.GITHUB_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET: any = process.env.GITHUB_OAUTH_CLIENT_SECRET;


// Validations for GitHub App
if (!APP_ID) {
  throw new Error("GITHUB_APP_ID not set");
}
if (!PRIVATE_KEY_PATH) {
  throw new Error("GITHUB_PRIVATE_KEY_PATH not set");
}
if (!WEBHOOK_SECRET) {
  console.warn("Warning: WEBHOOK_SECRET not set; you should set it to verify webhooks");
}

// Function to read private key from file
function readPrivateKeyFromFile(filePath: string): string {
  try {
    console.log(`Attempting to read private key from: ${filePath}`);

    let normalizedPath = filePath;
    if (filePath.includes(':\\')) {
      const isWsl = process.env.WSL_DISTRO_NAME || process.env.IS_WSL;
      if (isWsl) {
        const driveLetter = filePath.charAt(0).toLowerCase();
        const pathWithoutDrive = filePath.substring(2).replace(/\\/g, '/');
        normalizedPath = `/mnt/${driveLetter}${pathWithoutDrive}`;
        console.log(`Converted Windows path to WSL path: ${normalizedPath}`);
      }
    }

    return fs.readFileSync(normalizedPath, 'utf8');
  } catch (error) {
    console.error(`Error reading private key: ${error}`);
    throw new Error(`Failed to read private key from file ${filePath}: ${error}`);
  }
}

const app = express();
app.use(
  bodyParser.json({
    verify: (req: any, res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

function verifyWebhookSignature(req: Request, secret: string): boolean {
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) {
    return false;
  }
  const raw = (req as any).rawBody as Buffer;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(raw);
  const expected = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ============ GitHub App Functions ============

function generateAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: parseInt(APP_ID, 10),
  };
  const privateKey = readPrivateKeyFromFile(PRIVATE_KEY_PATH);
  const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });
  return token;
}

export async function fetchInstallationToken(installationId: number): Promise<{ token: string; expires_at: string }> {
  const jwtToken = generateAppJwt();
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Error fetching installation token: ${resp.status} : ${body}`);
  }
  const body = (await resp.json()) as any;
  return {
    token: body.token,
    expires_at: body.expires_at,
  };
}

// ============ OAuth 2.0 Functions ============


// Clean up expired OAuth states (runs periodically)
function cleanupExpiredStates(): void {
  const now = new Date();
  let cleanedCount = 0;
  
  for (const [state, record] of Object.entries(oauthStates)) {
    if (record.expiresAt <= now) {
      delete oauthStates[state];
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} expired OAuth state(s)`);
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredStates, 10 * 60 * 1000);

// Validate OAuth state
function validateOAuthState(state: string): boolean {
  const record = oauthStates[state];
  
  if (!record) {
    console.warn(`OAuth state not found: ${state}`);
    return false;
  }
  
  const now = new Date();
  if (record.expiresAt <= now) {
    console.warn(`OAuth state expired: ${state}`);
    delete oauthStates[state];
    return false;
  }
  
  // State is valid, delete it (one-time use)
  delete oauthStates[state];
  return true;
}

function generateOAuthAuthorizationUrl(state?: string): string {
  if (!OAUTH_CLIENT_ID) {
    throw new Error('GITHUB_OAUTH_CLIENT_ID not configured');
  }

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_url:`${process.env.APP_URL}/v1/oauth/callback`,
    scope: 'repo,user,read:org',
    state: state || crypto.randomBytes(16).toString('hex'),
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeOAuthCode(code: string): Promise<OAuthTokenRecord> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('OAuth credentials not configured');
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code: code

    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange code: ${response.status} - ${errorText}`);
  }

  const data: any = await response.json();

  if (data.error) {
    throw new Error(`OAuth error: ${data.error_description || data.error}`);
  }

  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined;

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

async function refreshOAuthToken(refreshToken: string): Promise<OAuthTokenRecord> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('OAuth credentials not configured');
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} - ${errorText}`);
  }

  const data: any = await response.json();

  if (data.error) {
    throw new Error(`OAuth refresh error: ${data.error_description || data.error}`);
  }

  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined;

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

async function getValidOAuthToken(userId: string): Promise<string> {
  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    throw new Error('User not authenticated');
  }

  // Check if token is expired or about to expire (within 5 minutes)
  if (tokenRecord.expiresAt) {
    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

    if (tokenRecord.expiresAt <= fiveMinutesFromNow) {
      console.log(`Token expired or expiring soon for user ${userId}, refreshing...`);

      if (!tokenRecord.refreshToken) {
        throw new Error('Token expired and no refresh token available');
      }

      // Refresh the token
      const newTokenData = await refreshOAuthToken(tokenRecord.refreshToken);
      newTokenData.userId = userId;
      oauthTokens[userId] = newTokenData;

      console.log(`Token refreshed successfully for user ${userId}`);
      return newTokenData.accessToken;
    }
  }

  return tokenRecord.accessToken;
}

async function getOAuthUserInfo(accessToken: string): Promise<any> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get user info: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// ============ OAuth 2.0 Routes ============

app.get('/oauth/authorize', (req: Request, res: Response) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    
    // Store state with expiration (10 minutes)
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    oauthStates[state] = {
      state,
      createdAt: now,
      expiresAt,
    };
    
    console.log(`Generated OAuth state: ${state}, expires at: ${expiresAt.toISOString()}`);
    
    const authUrl = generateOAuthAuthorizationUrl(state);
    
    // Open browser instead of redirecting
    const platform = process.platform;
    let command: string;
    
    if (platform === 'win32') {
      command = `start "" "${authUrl}"`;
    } else if (platform === 'darwin') {
      command = `open "${authUrl}"`;
    } else {
      command = `xdg-open "${authUrl}"`;
    }
    
    exec(command, (error) => {
      if (error) {
        console.error('Error opening browser:', error);
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Browser opened for authorization. Please complete the OAuth flow.',
      authUrl: authUrl,
      state: state // Return state for debugging (optional)
    });
  } catch (error: any) {
    console.error('Error generating OAuth URL:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/oauth/callback', async (req: Request, res: Response): Promise<any> => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `OAuth error: ${error}` });
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  // Validate state parameter for CSRF protection
  if (!state || typeof state !== 'string') {
    console.error('OAuth callback: Missing or invalid state parameter');
    return res.status(400).json({ 
      error: 'Invalid request: Missing or invalid state parameter',
      details: 'State parameter is required for security validation'
    });
  }

  // Verify the state matches what we generated
  if (!validateOAuthState(state)) {
    console.error(`OAuth callback: State validation failed for state: ${state}`);
    return res.status(403).json({ 
      error: 'State validation failed',
      details: 'The state parameter does not match or has expired. This could indicate a CSRF attack. Please try authenticating again.'
    });
  }

  console.log(`OAuth callback: State validated successfully: ${state}`);

  try {
    const tokenData = await exchangeOAuthCode(code as string);
    const userInfo = await getOAuthUserInfo(tokenData.accessToken);

    const userId = userInfo.login;
    tokenData.userId = userId;
    oauthTokens[userId] = tokenData;

    console.log(`OAuth flow completed for user: ${userId}`);

    return res.json({
      success: true,
      user: {
        login: userInfo.login,
        id: userInfo.id,
        name: userInfo.name,
        email: userInfo.email,
      },
      message: 'Authentication successful',
    });
  } catch (error: any) {
    console.error('Error in OAuth callback:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/oauth/repos/:userId', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;

  try {
    // Get valid token (will auto-refresh if needed)
    const accessToken = await getValidOAuthToken(userId);

    const response = await fetch('https://api.github.com/user/repos?per_page=100', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch repos: ${response.status} - ${errorText}`);
    }

    const repos = await response.json();
    return res.json({
      userId,
      repositories: repos.map((r: any) => ({
        name: r.full_name,
        private: r.private,
        url: r.html_url,
      })),
    });
  } catch (error: any) {
    console.error('Error fetching repos:', error);
    return res.status(500).json({ error: error.message });
  }
});

// OAuth 2.0: Get user organizations
app.get('/oauth/orgs/:userId', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;

  try {
    // Get valid token (will auto-refresh if needed)
    const accessToken = await getValidOAuthToken(userId);

    const response = await fetch('https://api.github.com/user/orgs', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch organizations: ${response.status} - ${errorText}`);
    }

    const orgs = await response.json();
    return res.json({
      userId,
      organizations: orgs.map((org: any) => ({
        login: org.login,
        id: org.id,
        url: org.url,
        avatarUrl: org.avatar_url,
        description: org.description,
      })),
    });
  } catch (error: any) {
    console.error('Error fetching organizations:', error);
    return res.status(500).json({ error: error.message });
  }
});


app.post('/oauth/clone/:userId/:owner/:repo', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;
  const owner = req.params.owner;
  const repo = req.params.repo;

  try {
    // Get valid token (will auto-refresh if needed)
    const accessToken = await getValidOAuthToken(userId);

    const cloneUrl = `https://oauth2:${accessToken}@github.com/${owner}/${repo}.git`;
    console.log('Cloning repository with OAuth token...');

    const result = spawnSync('git', ['clone', cloneUrl], { stdio: 'inherit' });

    if (result.status !== 0) {
      return res.status(500).send(`git clone failed with status ${result.status}`);
    }

    return res.status(200).json({ success: true, message: 'Repository cloned successfully' });
  } catch (error: any) {
    console.error('Error during git clone:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============ GitHub App Webhook Endpoint ============

// OAuth 2.0: Manually refresh token
app.post('/oauth/refresh/:userId', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;
  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    return res.status(404).json({ error: 'User not authenticated' });
  }

  if (!tokenRecord.refreshToken) {
    return res.status(400).json({ error: 'No refresh token available' });
  }

  try {
    const newTokenData = await refreshOAuthToken(tokenRecord.refreshToken);
    newTokenData.userId = userId;
    oauthTokens[userId] = newTokenData;

    console.log(`Token manually refreshed for user: ${userId}`);

    return res.json({
      success: true,
      message: 'Token refreshed successfully',
      expiresAt: newTokenData.expiresAt,
    });
  } catch (error: any) {
    console.error('Error refreshing token:', error);
    return res.status(500).json({ error: error.message });
  }
});

// OAuth 2.0: Get token status
app.get('/oauth/status/:userId', (req: Request, res: Response): any => {
  const userId = req.params.userId;
  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    return res.status(404).json({ error: 'User not authenticated' });
  }

  const now = new Date();
  const isExpired = tokenRecord.expiresAt ? tokenRecord.expiresAt <= now : false;
  const timeToExpiry = tokenRecord.expiresAt ? tokenRecord.expiresAt.getTime() - now.getTime() : null;

  return res.json({
    userId: tokenRecord.userId,
    hasRefreshToken: !!tokenRecord.refreshToken,
    expiresAt: tokenRecord.expiresAt,
    isExpired,
    timeToExpiryMs: timeToExpiry,
    scope: tokenRecord.scope,
  });
});


app.post("/webhooks/github", async (req: Request, res: Response): Promise<any> => {
  if (WEBHOOK_SECRET) {
    const ok = verifyWebhookSignature(req, WEBHOOK_SECRET);
    if (!ok) {
      console.warn("Webhook signature mismatch");
      return res.status(401).send("Invalid signature");
    }
  }

  const event = req.headers["x-github-event"];
  const payload = req.body;

  try {
    if (event === "installation" && payload.action === "created") {
      const installation = payload.installation;
      const installationId: number = installation.id;
      const account = installation.account;

      console.log("New installation:", installationId, account.login);

      const { token, expires_at } = await fetchInstallationToken(installationId);
      installations[installationId] = {
        account,
        token,
        expiresAt: new Date(expires_at),
      };

      return res.status(200).json({ ok: true });
    }

    if (event === "installation" && payload.action === "deleted") {
      const installationId: number = payload.installation.id;
      delete installations[installationId];
      return res.status(200).send("deleted");
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("Error handling webhook:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============ GitHub App Routes ============

// Get all installations
app.get("/app/installations", async (req: Request, res: Response): Promise<any> => {
  try {
    const installationsList = Object.entries(installations).map(([id, record]) => ({
      installationId: parseInt(id),
      accountLogin: record.account.login,
      accountId: record.account.id,
      accountType: record.account.type,
      tokenExpiry: record.expiresAt,
    }));

    return res.json({
      success: true,
      count: installationsList.length,
      installations: installationsList,
    });
  } catch (err: any) {
    console.error("Error listing installations:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Get organization details for a specific installation
app.get("/app/installation/:installationId/org", async (req: Request, res: Response): Promise<any> => {
  const installationId = parseInt(req.params.installationId, 10);
  const rec = installations[installationId];
  
  if (!rec) {
    return res.status(404).json({ error: "Installation not found" });
  }

  // Check if token is expired and refresh if needed
  const now = new Date();
  if (!rec.token || rec.expiresAt <= now) {
    try {
      const { token, expires_at } = await fetchInstallationToken(installationId);
      rec.token = token;
      rec.expiresAt = new Date(expires_at);
      installations[installationId] = rec;
    } catch (err: any) {
      console.error("Failed to refresh token:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    let orgDetails: any = null;
    
    // Check if the installation is for an organization or a user
    if (rec.account.type === "Organization") {
      // Fetch detailed organization information
      const orgLogin = rec.account.login;
      const orgResponse = await fetch(`https://api.github.com/orgs/${orgLogin}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${rec.token}`,
          Accept: "application/vnd.github+json",
        },
      });

      if (!orgResponse.ok) {
        const txt = await orgResponse.text();
        throw new Error(`Failed to fetch organization details: ${orgResponse.status} : ${txt}`);
      }

      orgDetails = await orgResponse.json();

      // Fetch organization members count
      const membersResponse = await fetch(`https://api.github.com/orgs/${orgLogin}/members?per_page=1`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${rec.token}`,
          Accept: "application/vnd.github+json",
        },
      });

      let membersCount = 0;
      if (membersResponse.ok) {
        const linkHeader = membersResponse.headers.get('link');
        if (linkHeader) {
          // Parse the Link header to get the last page number
          const lastPageMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
          if (lastPageMatch) {
            membersCount = parseInt(lastPageMatch[1], 10);
          } else {
            const members = await membersResponse.json();
            membersCount = members.length;
          }
        } else {
          const members = await membersResponse.json();
          membersCount = members.length;
        }
      }

      return res.json({
        success: true,
        installationId,
        type: "organization",
        organization: {
          login: orgDetails.login,
          id: orgDetails.id,
          name: orgDetails.name,
          description: orgDetails.description,
          avatarUrl: orgDetails.avatar_url,
          url: orgDetails.html_url,
          blog: orgDetails.blog,
          location: orgDetails.location,
          email: orgDetails.email,
          publicRepos: orgDetails.public_repos,
          publicGists: orgDetails.public_gists,
          followers: orgDetails.followers,
          following: orgDetails.following,
          createdAt: orgDetails.created_at,
          updatedAt: orgDetails.updated_at,
          totalPrivateRepos: orgDetails.total_private_repos,
          ownedPrivateRepos: orgDetails.owned_private_repos,
          membersCount: membersCount,
          type: orgDetails.type,
        },
      });
    } else if (rec.account.type === "User") {
      // Fetch user information
      const userLogin = rec.account.login;
      const userResponse = await fetch(`https://api.github.com/users/${userLogin}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${rec.token}`,
          Accept: "application/vnd.github+json",
        },
      });

      if (!userResponse.ok) {
        const txt = await userResponse.text();
        throw new Error(`Failed to fetch user details: ${userResponse.status} : ${txt}`);
      }

      const userDetails = await userResponse.json();

      return res.json({
        success: true,
        installationId,
        type: "user",
        user: {
          login: userDetails.login,
          id: userDetails.id,
          name: userDetails.name,
          bio: userDetails.bio,
          avatarUrl: userDetails.avatar_url,
          url: userDetails.html_url,
          blog: userDetails.blog,
          location: userDetails.location,
          email: userDetails.email,
          publicRepos: userDetails.public_repos,
          publicGists: userDetails.public_gists,
          followers: userDetails.followers,
          following: userDetails.following,
          createdAt: userDetails.created_at,
          updatedAt: userDetails.updated_at,
          type: userDetails.type,
        },
      });
    } else {
      return res.status(400).json({ 
        error: "Unknown account type",
        accountType: rec.account.type 
      });
    }
  } catch (err: any) {
    console.error("Error fetching organization/user details:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/list-repos/:installationId", async (req: Request, res: Response): Promise<any> => {
  const installationId = parseInt(req.params.installationId, 10);
  const rec = installations[installationId];
  if (!rec) {
    return res.status(404).json({ error: "Installation not found" });
  }

  const now = new Date();
  if (!rec.token || rec.expiresAt <= now) {
    try {
      const { token, expires_at } = await fetchInstallationToken(installationId);
      rec.token = token;
      rec.expiresAt = new Date(expires_at);
      installations[installationId] = rec;
    } catch (err: any) {
      console.error("Failed to refresh token:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const reposResp = await fetch("https://api.github.com/installation/repositories", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${rec.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!reposResp.ok) {
      const txt = await reposResp.text();
      throw new Error(`Repos list failed: ${reposResp.status} : ${txt}`);
    }
    const reposData = await reposResp.json();
    const repos = reposData.repositories as any[];

    let firstContents: any[] = [];
    if (repos.length > 0) {
      const first = repos[0];
      const owner = first.owner.login;
      const name = first.name;
      const contentsUrl = `https://api.github.com/repos/${owner}/${name}/contents`;
      const contResp = await fetch(contentsUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${rec.token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!contResp.ok) {
        const txt = await contResp.text();
        throw new Error(`Contents fetch failed: ${contResp.status} : ${txt}`);
      }
      firstContents = await contResp.json();
    }

    return res.json({
      installationId,
      repositories: repos.map((r) => r.full_name),
      firstRepoContents: firstContents,
    });
  } catch (err: any) {
    console.error("Error in list-repos:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/clone/:installationId/:owner/:repo", async (req: Request, res: Response): Promise<any> => {
  const installationId = parseInt(req.params.installationId, 10);
  const owner = req.params.owner;
  const repo = req.params.repo;

  const rec = installations[installationId];
  if (!rec) {
    return res.status(404).json({ error: "Installation not found" });
  }

  const now = new Date();
  if (rec.expiresAt <= now) {
    try {
      const { token, expires_at } = await fetchInstallationToken(installationId);
      rec.token = token;
      rec.expiresAt = new Date(expires_at);
      installations[installationId] = rec;
    } catch (err: any) {
      console.error("Failed to refresh token:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  const cloneUrl = `https://x-access-token:${rec.token}@github.com/${owner}/${repo}.git`;
  console.log("Cloning URL:", cloneUrl);

  try {
    const result = spawnSync("git", ["clone", cloneUrl], { stdio: "inherit" });
    if (result.status !== 0) {
      return res.status(500).send(`git clone failed with status ${result.status}`);
    }
    return res.status(200).send("Cloned");
  } catch (err: any) {
    console.error("Error during git clone:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
