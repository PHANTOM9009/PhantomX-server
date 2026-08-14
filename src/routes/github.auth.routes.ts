import express, { Request, Response, Router } from "express";
import bcrypt from 'bcrypt';
import jwt, { JwtPayload } from 'jsonwebtoken';
import crypto from "crypto";
import fetch from "node-fetch";
import { spawnSync, exec } from "child_process";
import {

  validateOAuthState,
  generateOAuthAuthorizationUrl,
  exchangeOAuthCode,
  getValidOAuthToken,
  validateToken,
  getOAuthUserEmail,
  getOAuthUserInfo,
} from "../Services/GithubOAuthFlow";
import {
  InstallationRecord,
  installations,
  WEBHOOK_SECRET,
  APP_ID,
  PRIVATE_KEY_PATH,
  verifyWebhookSignature,
  fetchInstallationToken,
  generateAppJwt,
  readPrivateKeyFromFile,
  getGithubOrganizationName,
  getRepoList,
  getRepoBranch

} from "../Services/GithubAppFlow";

import { githubData } from '../DataAccessLayer/models/UserCredentials';
import {
  user_github, user_userDetails, partialOAuthData, oauthTokens,
  oauthStates,
  oauthTempState,
  UserInfo,
  GithubAppInstallationDetails,
  pendingInvites,
  pendingInviteJWT
} from "./../DataStructures";
const { v4: uuidv4 } = require('uuid');
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { IRefreshToken } from '../DataAccessLayer/models/RefreshToken';
import {
  initializeAuthDatabase,
  findOrCreateRefreshToken,
  createAccessToken,
  setRefreshTokenCookie,
  handleExistingUserAuth,
  handleNewUserAuth,
  updateGithubAccessToken,
  updateGithubInstallationId,
  deleteGithubInstallationId,
  initializeOrganizationDatabase
} from '../Services/AuthTokenService';
import { Organization_AppInstallation, UserName_Socket, pendingGithubAppInstall } from "./../DataStructures";
import { generateAppInstallationUrl } from "../Services/GithubAppFlow";
import { IUser } from "../DataAccessLayer/models/User";
import { getDBService } from "../DataAccessLayer/db-connection";
import { CollectionNames } from "../DataAccessLayer/models/Collections";
import * as dotenv from "dotenv";
import { Logger } from "../utils/Logger";
dotenv.config();


const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const JWT_EXPIRES_IN = '24h';

const SALT_ROUNDS = 10;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

const router: Router = express.Router();

// testingDebug logging on module load
console.log('=== Routes Module Loaded ===');
console.log('oauthTokens type:', typeof oauthTokens);
console.log('oauthTokens value:', oauthTokens);
console.log('oauthTokens === undefined?', oauthTokens === undefined);
console.log('oauthStates type:', typeof oauthStates);
console.log('============================');
// OAuth Routes

router.get('/authorize', (req: any, res: any) => {
  try {
    const inviteTokenJWT: any = req.query.inviteToken;
    const state = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    console.log('[Authorize] About to store state');
    console.log('[Authorize] oauthStates is undefined?', oauthStates === undefined);

    oauthStates[state] = {
      state,
      createdAt: now,
      expiresAt,
    };
    if(inviteTokenJWT)pendingInviteJWT.set(state, inviteTokenJWT);
    console.log(`Generated OAuth state: ${state}, expires at: ${expiresAt.toISOString()}`);

    const authUrl = generateOAuthAuthorizationUrl(state);

    // const platform = process.platform;
    // let command: string;

    // if (platform === 'win32') {
    //   command = `start "" "${authUrl}"`;
    // } else if (platform === 'darwin') {
    //   command = `open "${authUrl}"`;
    // } else {
    //   command = `xdg-open "${authUrl}"`;
    // }

    // exec(command, (error) => {
    //   if (error) {
    //     console.error('Error opening browser:', error);
    //   }
    // });

    // Return JSON instead of redirect to avoid CORS issues
    // Frontend will handle the redirect using window.location.href
    return res.json({
      success: true,
      message: 'Authorization URL generated successfully',
      authUrl: authUrl,
      state: state
    });
  } catch (error: any) {
    console.error('Error generating OAuth URL:', error);
    res.status(500).json({ error: error.message });
  }
});
router.get('/completeAuth', async (req: any, res: any): Promise<any> => {
  let tempCode = req.query.code;
  //now based on the code we will send the refresh token and access token
  const { userCredentialHandler, refreshTokenHandler } = await initializeAuthDatabase();
  let userData = partialOAuthData.get(tempCode);
  if (userData == null) {
    return res.error({ error: true, message: "invalid request cannot find the code required for authentication" });
  }
  //setting the refersh token in the cookies..
  res.cookie("refreshToken", userData.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "none" as const,
    maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  });
  res.json({ accessToken: userData.accessToken });



});
router.get('/callback', async (req: any, res: any): Promise<any> => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `OAuth error: ${error}` });
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  if (!state || typeof state !== 'string') {
    console.error('OAuth callback: Missing or invalid state parameter');
    return res.status(400).json({
      error: 'Invalid request: Missing or invalid state parameter',
      details: 'State parameter is required for security validation'
    });
  }

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
    if (oauthTempState.get(state)) {
      let uu: any = oauthTempState.get(state).userId;
      oauthTokens[uu]=tokenData;
      const socket = oauthTempState.get(state).socket;
      socket.emit("github_connection_successfull", {
        success: true,
        message: "Github connection successful",
        userId: uu,
        accessToken: tokenData.accessToken,
      })
      return;

    }
    user_github.set(userInfo.login, {
      githubId: userInfo.id,
      githubAccessToken: tokenData.accessToken
    });
    const githubUsername = userInfo.login;
    tokenData.userId = githubUsername;



    if (oauthTokens === undefined) {
      console.error('[Callback] CRITICAL: oauthTokens is undefined!');
      return res.status(500).json({ error: 'Storage not initialized' });
    }

    console.log(`OAuth flow completed for user: ${githubUsername}`);

    //now checking if the user exists or not
    const { userCredentialHandler, refreshTokenHandler } = await initializeAuthDatabase();

    const existingUser = await userCredentialHandler.findOne({ userName: userInfo.login });

    //creating a code
    let tempCode = uuidv4();

    //invite case if the user is invited and he tries to register using github
    let inviteJWT = pendingInviteJWT.get(state);
    let inviteData = null;
    let inviteTokenId = null;
    let orgDbName = null;
    if (inviteJWT) {
      let decodedToken: JwtPayload | string;
      decodedToken = jwt.verify(inviteJWT, JWT_SECRET);
      if (typeof decodedToken === 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid token format'
        });
      }
      inviteTokenId = decodedToken.inviteToken as string;
      inviteData = pendingInvites.get(inviteTokenId);
    }

    if (existingUser) {
      // Handle existing user authentication with common service
      if (inviteData) {
        //in this case the user is already part of orgnization and he is trying to register through invitation so we will return 
        return res.redirect(`${process.env.APP_URL}/register?token=${inviteJWT}&errCode=400`);
      }
      oauthTokens[existingUser.userId.toString()] = tokenData;
      const authResult = await handleExistingUserAuth(
        existingUser,
        refreshTokenHandler,
        res,
        false // secure cookie - commented in original
      );
      console.log("\n THE USER ID IS=>", existingUser.userId);
      partialOAuthData.set(tempCode, {
        userName: userInfo.login,
        userId: existingUser.userId,
        accessToken: authResult.accessToken,
        refreshToken: authResult.refreshToken
      });

      // Update GitHub access token in user metadata
      await userCredentialHandler.updateOne(
        { userId: existingUser.userId },
        {
          $set: {
            "githubMetadata.githubAccessToken": tokenData.accessToken
          }
        }
      );

      // Redirect based on database setup status
      if (!existingUser.databaseName) {
        return res.redirect(`${process.env.APP_URL}/setup?code=${tempCode}`);
      } else {
        return res.redirect(`${process.env.APP_URL}/dashboard?code=${tempCode}`);
      }
    } else {
      // Handle new user creation with common service
      const userid = uuidv4();
      oauthTokens[userid.toString()] = tokenData;
      const userEmail = await getOAuthUserEmail(tokenData.accessToken);
      if(inviteData)
      {
        const { organizationHandler } = await initializeOrganizationDatabase();
        const organizationId = inviteData.organizationId;
        const organization = await organizationHandler.findOne({ OrganizationId: organizationId });      
        if(!organization || !organization.dbName){
          return res.redirect(`${process.env.APP_URL}/register?token=${inviteJWT}&errCode=401`);
        }
        orgDbName = organization.dbName;
        const dbService = await getDBService();
        await dbService.ensureDatabase(orgDbName);
        await dbService.ensureCollection(orgDbName, 'Users');
        const orgUsersHandler = dbService.getRepository<IUser>(orgDbName, 'Users');
        const newOrgUser: Partial<IUser> = {
          userName: userInfo.login,
          userId: userid,
          email: userEmail[0]?.email,
          createdAt: new Date(),
          updatedAt: new Date(),
          active: true,
          organizationName: organization.OrganizationName,
          organizationId: organization.OrganizationId,
          permissionScopes: {
            [organizationId]: inviteData.role as 'Owner' | 'Member' || 'Member'
          },
          metadata: {
              invitedBy: inviteData.metadata?.invitedBy,
              invitedAt: new Date(),
          }
      
        };
        await orgUsersHandler.insertOne(newOrgUser as any);
        inviteTokenId && pendingInvites.delete(inviteTokenId);
        inviteTokenId && pendingInviteJWT.delete(inviteTokenId);
      }

      const countryCode = req.headers['x-country-code'] as string;
      const countryName = req.headers['x-country-name'] as string;
      const geoIPMetadata = (countryCode || countryName) ? {
        geoIP: {
          countryCode: countryCode,
          countryName: countryName,
          registeredAt: new Date()
        }
      } : undefined;

      let authResult = await handleNewUserAuth(
        userCredentialHandler,
        refreshTokenHandler,
        {
          userName: userInfo.login,
          userId: userid,
          password: null,
          email: userEmail[0]?.email,
          githubOauth: true,
          databaseName: orgDbName ? orgDbName : "",
          githubMetadata: {
            githubId: userInfo.id,
            githubAccessToken: tokenData.accessToken
          },
          invitedBy: inviteData?.metadata?.invitedBy,
          organizationRole: inviteData?.role as 'Owner' | 'Member' || 'Owner',
          ...(geoIPMetadata && { metadata: geoIPMetadata })
        },
        res,
        true // secure cookie
      );

      partialOAuthData.set(tempCode, {
        userName: userInfo.login,
        userId: userid,
        accessToken: authResult.accessToken,
        refreshToken: authResult.refreshToken
      });

      return res.redirect(`${process.env.APP_URL}/setup?code=${tempCode}`);
    }
  } catch (error: any) {
    console.error('Error in OAuth callback:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/repos/:userId', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;

  try {
    console.log('[Repos] Request for user:', userId);
    console.log('[Repos] oauthTokens is undefined?', oauthTokens === undefined);
    console.log('[Repos] Keys in storage:', Object.keys(oauthTokens || {}));

    const accessToken = await getValidOAuthToken(userId);

    const response = await fetch('https://api.github.com/user/repos?per_page=100', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        delete oauthTokens[userId];
        return res.status(401).json({
          error: 'Token expired or invalid',
          message: 'Please re-authenticate',
          requiresLogin: true
        });
      }
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

router.get('/orgs/:userId', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;

  try {
    const accessToken = await getValidOAuthToken(userId);

    const response = await fetch(`https://api.github.com/user/orgs`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        delete oauthTokens[userId];
        return res.status(401).json({
          error: 'Token expired or invalid',
          message: 'Please re-authenticate',
          requiresLogin: true
        });
      }
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

router.get('/user', async (req: Request, res: Response): Promise<any> => {
  const userId: any = req.query.userId;

  console.log('[User] Request for userId:', userId);
  console.log('[User] oauthTokens is undefined?', oauthTokens === undefined);

  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    return res.status(404).json({ error: 'User not authenticated' });
  }

  const isValid = await validateToken(tokenRecord.accessToken);

  if (!isValid) {
    delete oauthTokens[userId];
    return res.json({
      userId: tokenRecord.userId,
      authenticated: false,
      valid: false,
      scope: tokenRecord.scope,
      createdAt: tokenRecord.createdAt,
      message: 'Token is invalid or expired. Please re-authenticate.',
    });
  }

  return res.json({ data: await getOAuthUserInfo(tokenRecord.accessToken) });
});
router.get('/userEmail', async (req: Request, res: Response): Promise<any> => {
  const userId: any = req.query.userId;

  console.log('[User] Request for userId:', userId);
  console.log('[User] oauthTokens is undefined?', oauthTokens === undefined);

  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    return res.status(404).json({ error: 'User not authenticated' });
  }

  const isValid = await validateToken(tokenRecord.accessToken);

  if (!isValid) {
    delete oauthTokens[userId];
    return res.json({
      userId: tokenRecord.userId,
      authenticated: false,
      valid: false,
      scope: tokenRecord.scope,
      createdAt: tokenRecord.createdAt,
      message: 'Token is invalid or expired. Please re-authenticate.',
    });
  }

  return res.json({ data: await getOAuthUserEmail(tokenRecord.accessToken) });
});
router.post('/clone/:userId/:owner/:repo', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;
  const owner = req.params.owner;
  const repo = req.params.repo;

  try {
    const accessToken = await getValidOAuthToken(userId);

    const isValid = await validateToken(accessToken);
    if (!isValid) {
      delete oauthTokens[userId];
      return res.status(401).json({
        error: 'Token expired or invalid',
        message: 'Please re-authenticate',
        requiresLogin: true
      });
    }

    const cloneUrl = `https://oauth2:${accessToken}@github.com/${owner}/${repo}.git`;
    console.log('Cloning repository with OAuth token...');

    const result = spawnSync('git', ['clone', cloneUrl], { stdio: 'inherit' });

    if (result.status !== 0) {
      return res.status(500).send(`git clone failed with status ${result.status}`);
    }

    return res.status(200).json({ success: true, message: 'Repository cloned successfully' });
  } catch (error: any) {
    console.error('Error during git clone:', error);
    if (error.message.includes('not authenticated')) {
      return res.status(401).json({
        error: error.message,
        requiresLogin: true
      });
    }
    return res.status(500).json({ error: error.message });
  }
});

router.get('/status/:userId', async (req: Request, res: Response): Promise<any> => {
  const userId = req.params.userId;

  console.log('[Status] Request for userId:', userId);
  console.log('[Status] oauthTokens is undefined?', oauthTokens === undefined);
  console.log('[Status] Keys in storage:', Object.keys(oauthTokens || {}));

  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    return res.status(404).json({ error: 'User not authenticated' });
  }

  const isValid = await validateToken(tokenRecord.accessToken);

  if (!isValid) {
    delete oauthTokens[userId];
    return res.json({
      userId: tokenRecord.userId,
      authenticated: false,
      valid: false,
      scope: tokenRecord.scope,
      createdAt: tokenRecord.createdAt,
      message: 'Token is invalid or expired. Please re-authenticate.',
    });
  }

  return res.json({
    userId: tokenRecord.userId,
    authenticated: true,
    valid: true,
    scope: tokenRecord.scope,
    createdAt: tokenRecord.createdAt,
    message: 'Token is valid',
  });
});

router.post('/logout/:userId', (req: Request, res: Response): any => {
  const userId = req.params.userId;
  const tokenRecord = oauthTokens[userId];

  if (!tokenRecord) {
    return res.status(404).json({ error: 'User not authenticated' });
  }

  delete oauthTokens[userId];
  console.log(`User ${userId} logged out successfully`);

  return res.json({
    success: true,
    message: 'Logged out successfully',
  });
});
//////////////////////////--------------------------------------ROUTES FOR GITHUB APPLICATION----------------------------//////////////
// routes for github application:

router.get("/getOrganizationName", async (req: any, res: any) => {
  let installationId = req.query.installationId;

  let organizationName = await getGithubOrganizationName(installationId as any);
  return res.json({
    organizationName: organizationName
  });
});
router.get("/getRepoList", async (req: any, res: any) => {

  let installationId = req.query.installationId;
  let result = await getRepoList(installationId);
  return res.json(result);

});
router.get("/listBranches", async (req: any, res: any) => {

  let owner = req.query.owner;
  let installationId = req.query.installationId;
  let repo = req.query.repo;
  let result = await getRepoBranch(installationId, owner, repo);
  return res.json(result);

});
router.post("/githubAppInstall", async (req: any, res: any): Promise<any> => {

  let state = uuidv4();
  let githubURL = generateAppInstallationUrl(state);
  // const platform = process.platform;
  //   let command: string;

  //   if (platform === 'win32') {
  //     command = `start "" "${githubURL}"`;
  //   } else if (platform === 'darwin') {
  //     command = `open "${githubURL}"`;
  //   } else {
  //     command = `xdg-open "${githubURL}"`;
  //   }

  //   exec(command, (error) => {
  //     if (error) {
  //       console.error('Error opening browser:', error);
  //     }
  //   });

  // return res.json({
  //   message: "opened the browser in the new tab"
  // });



  return res.json({
    success: true,
    installUrl: githubURL
  });


});
router.get("/applicationCallback", async (req: any, res: any): Promise<any> => {

  let state = req.query.state;
  let installationId = req.query.installation_id;
  let setup_action = req.query.setup_action;


  //checking that the state is of which user
    const pending = pendingGithubAppInstall.get(state);
    if (pending) {
      //getting the socket of this user
      const [userId, socket] = pending as [any, any];
  
      const userData: any = UserInfo.get(userId);
      if (!userData) {
        console.warn("applicationCallback: userData is empty for state", state, "userId:", userId);
        return res.status(400).send("Invalid installation callback state");
      }
  
      const organizationName = userData.organizationName;
  
  
  
      let githubOrgName = await getGithubOrganizationName(installationId);
      const data: Record<string, any> = {
        github: {
          installationId: installationId,
          app_id: "",
          githubOrganizationName: githubOrgName
        }
      }
      //now saving this data in the organization DB
      Organization_AppInstallation.set(organizationName, {
        installationId: installationId,
        appId: "",
        githubOrganizationName: githubOrgName
      });
      //getting the Github organization name from the endpoint
      updateGithubInstallationId(organizationName, data); //updating the token
  
  
      socket.emit("github_app_installed", {
        success: true,
        githubOrganizationName: githubOrgName
      });
  
    }

});
router.post("/webhooks/github", async (req: Request, res: Response): Promise<any> => {
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
    // if (event === "installation" && payload.action === "created") {
    //   const installation = payload.installation;
    //   const installationId: number = installation.id;
    //   const account = installation.account;
    //   const orgId = account.id;//we will save this thing.

    //   const organization = account.login;
    //   Organization_InstallationID.set(organization,installationId);
    //   const data:Record<string,any> = {
    //     github: {
    //       installationId : installationId,
    //       app_id: installation?.app_id
    //     }
    //   }
    //   //now saving this data in the organization DB

    //   updateGithubInstallationId(organization,data); //updating the token
    //   let senderUserName = payload?.sender?.login;
    //   //getting the socket of the connected user
    //   let socket = UserName_Socket.get(senderUserName);
    //   socket?.emit("github_application_connected",true);


    //   console.log("New installation:", installationId, account.login);

    //   const { token, expires_at } = await fetchInstallationToken(installationId);
    //   installations[installationId] = {
    //     account,
    //     token,
    //     expiresAt: new Date(expires_at),
    //   };

    //   return res.status(200).json({ ok: true });
    // }
    let logger = new Logger("github auth routes");
    logger.info("github webhook came");

    if (event === "installation" && payload.action === "deleted") {
      const installationId: number = payload.installation.id;
      delete installations[installationId];
      Organization_AppInstallation.delete(payload.installation.account.login);
      logger.info("github delete application webhook came");
      deleteGithubInstallationId(payload.installation.id);//this will remove the installation ID from the org db.
      return res.status(200).send("deleted");
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("Error handling webhook:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Get all installations
router.get("/router/installations", async (req: Request, res: Response): Promise<any> => {
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
router.get("/router/installation/:installationId/org", async (req: Request, res: Response): Promise<any> => {
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
    if (rec.account.type === "Organization") {
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

      const orgDetails = await orgResponse.json();

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

// List repositories for installation
router.get("/list-repos/:installationId", async (req: Request, res: Response): Promise<any> => {
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

// Clone repository
router.post("/clone/:installationId/:owner/:repo", async (req: Request, res: Response): Promise<any> => {
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




export default router;
