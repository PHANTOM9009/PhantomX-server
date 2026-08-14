import * as jwt from 'jsonwebtoken';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { IRefreshToken } from '../DataAccessLayer/models/RefreshToken';
import { IRepository } from '../DataAccessLayer/Repository';
import { Response } from 'express';
import { IOrganization } from '../DataAccessLayer/models/Organization';
const { v4: uuidv4 } = require('uuid');
import {JwtType} from './../classes/JwtType'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const JWT_EXPIRES_IN = '24h';
// 100 years in days — effectively forever when DISABLE_TOKEN_EXPIRY=true
const REFRESH_TOKEN_EXPIRY_DAYS = process.env.DISABLE_TOKEN_EXPIRY === 'true' ? 36500 : 7;

export interface AuthDatabaseHandlers {
    databaseService: DatabaseService;
    userCredentialHandler: IRepository<IUserCredentials>;
    refreshTokenHandler: IRepository<IRefreshToken>;
}

export interface OrganizationDatabaseHandlers {
    databaseService: DatabaseService;
    organizationHandler: IRepository<IOrganization>;
}

export interface RefreshTokenResult {
    token: string;
    isExisting: boolean;
}

export interface UserCredentialInput {
    userName: string;
    email?: string;
    userId: string;
    password: string | null;
    databaseName?: string;
    setupComplete?: boolean;
    githubOauth?: boolean;
    githubMetadata?: {
        githubId: number;
        githubAccessToken: string;
    };
    invitedBy?: string;
    organizationRole?: string;
    metadata?: {
        geoIP?: {
            countryCode?: string;
            countryName?: string;
            registeredAt?: Date;
        };
        [key: string]: any;
    };
}

/**
 * Initialize database connection and get handlers for user credentials and refresh tokens
 * Uses singleton pattern - reuses existing connection
 */
export async function initializeAuthDatabase(): Promise<AuthDatabaseHandlers> {
    // Get singleton instance instead of creating new one
    const databaseService = DatabaseService.getInstance();
    
    // Connect only if not already connected (singleton ensures single connection)
    if (!databaseService.isConnected()) {
        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
    }
    
    await databaseService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
    await databaseService.ensureCollection(
        process.env.USER_CREDENTIAL_DB,
        process.env.USER_CREDENTIAL_COLLECTION
    );
    await databaseService.ensureCollection(
        process.env.USER_CREDENTIAL_DB,
        process.env.USER_REFRESH_TOKEN_COLLECTION
    );

    const userCredentialHandler = databaseService.getRepository<IUserCredentials>(
        process.env.USER_CREDENTIAL_DB,
        process.env.USER_CREDENTIAL_COLLECTION
    );

    const refreshTokenHandler = databaseService.getRepository<IRefreshToken>(
        process.env.USER_CREDENTIAL_DB,
        process.env.USER_REFRESH_TOKEN_COLLECTION
    );

    return {
        databaseService,
        userCredentialHandler,
        refreshTokenHandler
    };
}


export async function initializeOrganizationDatabase(): Promise<OrganizationDatabaseHandlers> {
    // Get singleton instance instead of creating new one
    const databaseService = DatabaseService.getInstance();
    
    // Connect only if not already connected (singleton ensures single connection)
    if (!databaseService.isConnected()) {
        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
    }
    
    await databaseService.ensureDatabase(process.env.ORGANIZATION_DB);
    await databaseService.ensureCollection(
        process.env.ORGANIZATION_DB,
        process.env.ORGANIZATION_COLLECTION
    );

    const organizationHandler = databaseService.getRepository<IOrganization>(
        process.env.ORGANIZATION_DB,
        process.env.ORGANIZATION_COLLECTION
    );

    return {
        databaseService,
        organizationHandler,
    };
}

/**
 * Find or create refresh token for a user
 * Handles existing valid tokens, expired tokens, and creating new ones
 */
export async function findOrCreateRefreshToken(
    userId: string,
    refreshTokenHandler: IRepository<IRefreshToken>
): Promise<RefreshTokenResult> {
    // Check for existing refresh token
    const existingRefreshToken = await refreshTokenHandler.findOne({
        userId: userId as any,
        revoked: false
    });

    // If exists and valid, return it
    if (existingRefreshToken && existingRefreshToken.expiresOn > new Date()) {
        return {
            token: existingRefreshToken.token,
            isExisting: true
        };
    }

    // Generate new refresh token
    const newRefreshToken = uuidv4();
    const expiresOn = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // If existing token found (but expired or revoked), update it
    if (existingRefreshToken) {
        await refreshTokenHandler.updateOne(
            { userId: userId as any },
            {
                $set: {
                    token: newRefreshToken,
                    expiresOn: expiresOn,
                    revoked: false,
                    updatedOn: new Date()
                }
            }
        );
    } else {
        // Create new refresh token document
        const refreshTokenObject: Omit<IRefreshToken, '_id'> = {
            userId: userId,
            token: newRefreshToken,
            expiresOn: expiresOn,
            createdOn: new Date(),
            revoked: false,
            updatedOn: new Date()
        };
        await refreshTokenHandler.insertOne(refreshTokenObject as any);
    }

    return {
        token: newRefreshToken,
        isExisting: false
    };
}

/**
 * Create JWT access token for a user
 */
export function createAccessToken(userName: string, userId: string): string {
    const payload = {
        userName: userName,
        userId: userId,
        type: JwtType.ACCESS_TOKEN
    };
    // When DISABLE_TOKEN_EXPIRY=true, omit expiresIn so the JWT has no exp claim (never expires)
    if (process.env.DISABLE_TOKEN_EXPIRY === 'true') {
        return jwt.sign(payload, JWT_SECRET);
    }
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Set refresh token cookie with standard configuration
 */
export function setRefreshTokenCookie(
    res: Response,
    refreshToken: string,
    secure: boolean = true
): void {
    res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: secure,
        sameSite: "none" as const,
        // REFRESH_TOKEN_EXPIRY_DAYS is already 36500 (100yr) when DISABLE_TOKEN_EXPIRY=true
        maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    });
}

/**
 * Create a new user credential entry in the database
 */
export async function createUserCredential(
    userCredentialHandler: IRepository<IUserCredentials>,
    userInput: UserCredentialInput
): Promise<any> {
    const userCredential: Omit<IUserCredentials, '_id'> = {
        userName:userInput?.userName?.includes('@')?"":userInput.userName,
        email: userInput?.email ? userInput?.email : !userInput.userName.includes('@')?"":userInput.userName,
        userId: userInput.userId,
        githubOauth: userInput.githubOauth || false,
        password: userInput.password,
        databaseName: userInput.databaseName || "",
        setupComplete: userInput.setupComplete !== undefined ? userInput.setupComplete : false,
        createdOn: new Date(),
        ...(userInput.githubMetadata && { githubMetadata: userInput.githubMetadata }),
        ...(userInput.invitedBy && { invitedBy: userInput.invitedBy }),
        ...(userInput.organizationRole && { organizationRole: userInput.organizationRole }),
        ...(userInput.metadata && { metadata: userInput.metadata })
    };

    const result = await userCredentialHandler.insertOne(userCredential as any);
    console.log("User credentials added to DB:", result);
    return result;
}

/**
 * Handle authentication for existing user
 * Returns access token and sets cookie
 */
export async function handleExistingUserAuth(
    existingUser: IUserCredentials,
    refreshTokenHandler: IRepository<IRefreshToken>,
    res: Response,
    cookieSecure: boolean = true
): Promise<{ accessToken: string; refreshToken: string; isNewSession: boolean }> {
    const refreshTokenResult = await findOrCreateRefreshToken(
        existingUser.userId as any,
        refreshTokenHandler
    );

    const accessToken = createAccessToken(existingUser.userName as any, existingUser.userId as any);
    setRefreshTokenCookie(res, refreshTokenResult.token, cookieSecure);

    return {
        accessToken,
        refreshToken: refreshTokenResult.token,
        isNewSession: !refreshTokenResult.isExisting
    };
}

/**
 * Handle authentication for new user
 * Creates user, refresh token, access token, and sets cookie
 */
export async function handleNewUserAuth(
    userCredentialHandler: IRepository<IUserCredentials>,
    refreshTokenHandler: IRepository<IRefreshToken>,
    userInput: UserCredentialInput,
    res: Response,
    cookieSecure: boolean = true
): Promise<{ accessToken: string; userId: string, refreshToken: string }> {
    // Create user credential
    await createUserCredential(userCredentialHandler, userInput);

    // Create refresh token
    const refreshTokenResult = await findOrCreateRefreshToken(
        userInput.userId,
        refreshTokenHandler
    );

    // Create access token
    const accessToken = createAccessToken(userInput.userName, userInput.userId);

    // Set cookie
    setRefreshTokenCookie(res, refreshTokenResult.token, cookieSecure);

    return {
        accessToken,
        userId: userInput.userId,
        refreshToken: refreshTokenResult.token
    };
}

/**
 * Update GitHub access token in user credentials
 */
export async function updateGithubAccessToken(
    userCredentialHandler: IRepository<IUserCredentials>,
    userId: string,
    githubAccessToken: string
): Promise<void> {
    await userCredentialHandler.updateOne(
        { userId: userId as any },
        {
            $set: {
                "githubMetadata.githubAccessToken": githubAccessToken
            }
        }
    );
}
export async function updateGithubInstallationId(orgName: string, data: Record<string, any>) {

    //to update the github installation token ID in the organization DB
    const databaseService = DatabaseService.getInstance();
    
    if (!databaseService.isConnected()) {
        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
    }
    
    await databaseService.ensureDatabase(process.env.ORGANIZATION_DB);
    await databaseService.ensureCollection(process.env.ORGANIZATION_DB, process.env.ORGANIZATION_COLLECTION);

     const organizationHandler = databaseService.getRepository<IOrganization>(
        process.env.ORGANIZATION_DB,
        process.env.ORGANIZATION_COLLECTION
    );
    // Build the $set object dynamically for each key in data
    const setObject: Record<string, any> = {};
    for (const key in data) {
        if (data.hasOwnProperty(key)) {
            setObject[`metadata.${key}`] = data[key];
        }
    }

    await organizationHandler.updateOne(
        { OrganizationName: orgName },
        { $set: setObject }
    );


}

export async function deleteGithubInstallationId(installationId: string) {

    //to delete the github installation token ID from the organization DB metadata
    const databaseService = DatabaseService.getInstance();
    
    if (!databaseService.isConnected()) {
        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
    }
    
    await databaseService.ensureDatabase(process.env.ORGANIZATION_DB);
    await databaseService.ensureCollection(process.env.ORGANIZATION_DB, process.env.ORGANIZATION_COLLECTION);

    const organizationHandler = databaseService.getRepository<IOrganization>(
        process.env.ORGANIZATION_DB,
        process.env.ORGANIZATION_COLLECTION
    );
    console.log("\n in github auth token service. DeleteGithubInstallationId, the installation id is=>",installationId);
    await organizationHandler.updateOne(
        {"metadata.github.installationId": String(installationId) },
        { $unset: { "metadata.github": "" } }
    );


}

/**
 * Check if GitHub installation ID exists and is not empty/null
 * @param orgName Organization name to check
 * @returns Object with status and installationId if exists
 */
export async function checkGithubInstallationId(orgName: string): Promise<{
    exists: boolean;
    hasGithubKey: boolean;
    hasInstallationId: boolean;
    installationId?: string | number;
    githubOrganizationName?: string;
}> {
    const databaseService = DatabaseService.getInstance();
    
    if (!databaseService.isConnected()) {
        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
    }
    
    await databaseService.ensureDatabase(process.env.ORGANIZATION_DB);
    await databaseService.ensureCollection(process.env.ORGANIZATION_DB, process.env.ORGANIZATION_COLLECTION);

    const organizationHandler = databaseService.getRepository<IOrganization>(
        process.env.ORGANIZATION_DB,
        process.env.ORGANIZATION_COLLECTION
    );

    const organization = await organizationHandler.findOne({ OrganizationName: orgName });

    if (!organization) {
        return {
            exists: false,
            hasGithubKey: false,
            hasInstallationId: false
        };
    }

    // Check if metadata exists
    if (!organization.metadata) {
        return {
            exists: true,
            hasGithubKey: false,
            hasInstallationId: false
        };
    }

    // Check if github key exists in metadata
    if (!organization.metadata.github) {
        return {
            exists: true,
            hasGithubKey: false,
            hasInstallationId: false
        };
    }

    // Check if installationId exists and is not null/empty
    const installationId = organization.metadata.github.installationId;
    const githubOrganizationName = organization.metadata.github.githubOrganizationName;
    const hasInstallationId = installationId !== null && 
                               installationId !== undefined && 
                               installationId !== '';

    return {
        exists: true,
        hasGithubKey: true,
        hasInstallationId,
        installationId: hasInstallationId ? installationId : undefined,
        githubOrganizationName: githubOrganizationName || undefined
    };
}