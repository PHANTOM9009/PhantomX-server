import crypto from "crypto";
import fetch from "node-fetch";
import * as dotenv from 'dotenv';
import {oauthTokens,oauthStates,OAuthTokenRecord,OAuthStateRecord} from '../DataStructures';
dotenv.config();
import { serverMode } from "../socket-server";


// In-memory stores


// Token management functions
export function setOAuthToken(userId: string, token: OAuthTokenRecord): void {
  console.log('[GithubOAuthFlow] Setting token for user:', userId);
  oauthTokens[userId] = token;
  console.log('[GithubOAuthFlow] Token set. Total users:', Object.keys(oauthTokens).length);
  console.log('[GithubOAuthFlow] All userIds:', Object.keys(oauthTokens));
}

export function getOAuthToken(userId: string): OAuthTokenRecord | undefined {
  console.log('[GithubOAuthFlow] Getting token for user:', userId);
  console.log('[GithubOAuthFlow] Available userIds:', Object.keys(oauthTokens));
  const token = oauthTokens[userId];
  console.log('[GithubOAuthFlow] Token found:', token ? 'YES' : 'NO');
  return token;
}

export function deleteOAuthToken(userId: string): void {
  console.log('[GithubOAuthFlow] Deleting token for user:', userId);
  delete oauthTokens[userId];
}

export function getAllOAuthTokens(): Record<string, OAuthTokenRecord> {
  console.log('[GithubOAuthFlow] Getting all tokens. Count:', Object.keys(oauthTokens).length);
  return oauthTokens;
}

export function setOAuthState(state: string, record: OAuthStateRecord): void {
  oauthStates[state] = record;
}

export function getOAuthState(state: string): OAuthStateRecord | undefined {
  return oauthStates[state];
}

export function deleteOAuthState(state: string): void {
  delete oauthStates[state];
}

// OAuth 2.0 Configuration
const OAUTH_CLIENT_ID: any = process.env.GITHUB_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET: any = process.env.GITHUB_OAUTH_CLIENT_SECRET;

// Clean up expired OAuth states
export function cleanupExpiredStates(): void {
  const now = new Date();
  let cleanedCount = 0;
  
  for (const [state, record] of Object.entries(oauthStates)) {
    if (record.expiresAt <= now) {
      deleteOAuthState(state);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`[GithubOAuthFlow] Cleaned up ${cleanedCount} expired OAuth state(s)`);
  }
}

// Run cleanup every 10 minutes
//setInterval(cleanupExpiredStates, 10 * 60 * 1000);

// Validate OAuth state
export function validateOAuthState(state: string): boolean {
  const record = getOAuthState(state);
  
  if (!record) {
    console.warn(`[GithubOAuthFlow] OAuth state not found: ${state}`);
    return false;
  }
  
  const now = new Date();
  if (record.expiresAt <= now) {
    console.warn(`[GithubOAuthFlow] OAuth state expired: ${state}`);
    deleteOAuthState(state);
    return false;
  }
  
  deleteOAuthState(state);
  return true;
}

export function generateOAuthAuthorizationUrl(state?: string): string {
  if (!OAUTH_CLIENT_ID) {
    throw new Error('GITHUB_OAUTH_CLIENT_ID not configured');
  }

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri:`http://localhost:4001/api/auth/github/callback`,
    scope: 'repo read:user user user:email admin:org',
    state: state || crypto.randomBytes(16).toString('hex'),
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeOAuthCode(code: string): Promise<OAuthTokenRecord> {
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

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope,
    createdAt: new Date(),
  };
}

export async function getValidOAuthToken(userId: string): Promise<string> {
  const tokenRecord = getOAuthToken(userId);

  if (!tokenRecord) {
    throw new Error('User not authenticated. Please log in again.');
  }

  return tokenRecord.accessToken;
}

// Check if token is still valid by making a test API call
export async function validateToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    
    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function getOAuthUserInfo(accessToken: string): Promise<any> {
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

export async function getOAuthUserEmail(accessToken: string): Promise<any> { // will reutrn the email of the user.
  const response = await fetch('https://api.github.com/user/emails', {
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
export async function getUserOrgs(accessToken:string):Promise<any>{

   try {
     
  
      const response = await fetch(`https://api.github.com/user/orgs`, {
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
      return {
        organizations: orgs
      };
    
    } catch (error: any) {
      console.error('Error fetching organizations:', error);
      return {error:true,message:error};
    }

}

export async function revokeOAuthToken(accessToken: string): Promise<{success: boolean, message: string}> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('OAuth credentials not configured');
  }

  try {
    const response = await fetch(`https://api.github.com/applications/${OAUTH_CLIENT_ID}/grant`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64')}`,
        'Accept': 'application/vnd.github+json',
      },
      body: JSON.stringify({
        access_token: accessToken
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to revoke token: ${response.status} - ${errorText}`);
      return {
        success: false,
        message: `Failed to revoke token: ${response.status} - ${errorText}`
      };
    }

    console.log('[GithubOAuthFlow] Token revoked successfully');
    return {
      success: true,
      message: 'Token revoked successfully. User will need to re-authorize on next login.'
    };
  } catch (error: any) {
    console.error('Error revoking token:', error);
    return {
      success: false,
      message: `Error revoking token: ${error.message}`
    };
  }
}
