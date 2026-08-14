import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { getDBService } from '../DataAccessLayer/db-connection';
import { IUser } from '../DataAccessLayer/models/User';
import { IRepository } from '../DataAccessLayer/Repository';
import * as dotenv from 'dotenv'
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { IRefreshToken } from '../DataAccessLayer/models/RefreshToken';
import cookieParser from "cookie-parser";
import { pendingInvites, pendingVerifications, PendingInviteData, PendingVerificationData } from '../DataStructures';
import { SendInviteMail, SendVerifyEmailAddressMail } from '../socket-handlers/invite-mail.handler';
import { VerifyPasswordResetLink, SendPasswordResetEmail, ResetPassword } from '../Services/UserManagmentService';
import {
    initializeAuthDatabase,
    initializeOrganizationDatabase,
    findOrCreateRefreshToken,
    createAccessToken,
    setRefreshTokenCookie,
    handleExistingUserAuth,
    handleNewUserAuth
} from '../Services/AuthTokenService';
import { JwtType } from '../classes/JwtType';


dotenv.config();
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const JWT_EXPIRES_IN = '24h';

const SALT_ROUNDS = 10;


router.post("/verifyEmail", async (req: any, res: any) => {
    if (process.env.ENABLE_NORMAL_LOGIN !== 'true') {
        return res.status(403).json({ success: false, error: 'Normal login is disabled on this server.' });
    }
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const { userCredentialHandler } = await initializeAuthDatabase();

        const existingUserByEmail = await userCredentialHandler.findOne({ email });
        if (existingUserByEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email already registered',
                code: 'EMAIL_EXISTS'
            });
        }

        const existingUserByUsername = await userCredentialHandler.findOne({ userName: email });
        if (existingUserByUsername) {
            return res.status(400).json({
                success: false,
                error: 'Email already registered as username',
                code: 'USERNAME_EXISTS'
            });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const verificationToken = uuidv4();

        const now = new Date();
        const expiryDate = new Date(now);
        expiryDate.setMinutes(expiryDate.getMinutes() + 30);

        const verificationData: PendingVerificationData = {
            email,
            password,
            otp,
            status: 'pending',
            createdAt: now,
            expiresAt: expiryDate,
            attempts: 0,
            metadata: {
                verificationToken
            }
        };

        pendingVerifications.set(verificationToken, verificationData);

        const emailResult = await SendVerifyEmailAddressMail({
            recipientEmail: email,
            otp: otp,
        });

        if (emailResult.success) {
            return res.status(200).json({
                success: true,
                message: 'Verification OTP sent successfully',
                data: {
                    verificationToken,
                    verifyToken: verificationToken,
                    email,
                    expiresAt: expiryDate
                }
            });
        } else {

            pendingVerifications.delete(verificationToken);
            return res.status(500).json({
                success: false,
                error: 'Failed to send verification email',
                details: emailResult.error
            });
        }

    } catch (error: any) {
        console.error('Error sending verification email:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
})


router.post("/verifyOTP", async (req: any, res: any) => {
    try {
        const { email, otp, verificationToken, verifyToken } = req.body;
        const tokenFromRequest = verificationToken || verifyToken;
        const normalizedEmail = typeof email === 'string' ? email.trim() : '';
        const normalizedOtp = typeof otp === 'string' ? otp.trim() : String(otp || '').trim();

        if (!normalizedEmail || !normalizedOtp || !tokenFromRequest) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                required: ['email', 'otp', 'verificationToken']
            });
        }

        const verificationData = pendingVerifications.get(tokenFromRequest);

        if (!verificationData) {
            return res.status(404).json({
                success: false,
                error: 'Verification not found or already used'
            });
        }

        if (verificationData.email !== normalizedEmail) {
            return res.status(400).json({
                success: false,
                error: 'Email mismatch'
            });
        }

        if (verificationData.expiresAt < new Date()) {
            verificationData.status = 'expired';
            pendingVerifications.delete(tokenFromRequest);
            return res.status(401).json({
                success: false,
                error: 'OTP has expired. Please request a new one.'
            });
        }

        if (verificationData.status === 'expired') {
            pendingVerifications.delete(tokenFromRequest);
            return res.status(401).json({
                success: false,
                error: 'OTP has expired. Please request a new one.'
            });
        }

        if (verificationData.status === 'verified') {
            return res.status(400).json({
                success: false,
                error: 'OTP has already been verified'
            });
        }

        // Check max attempts (5 attempts allowed)
        if (verificationData.attempts && verificationData.attempts >= 5) {
            verificationData.status = 'expired';
            pendingVerifications.delete(tokenFromRequest);
            return res.status(429).json({
                success: false,
                error: 'Maximum verification attempts exceeded. Please request a new OTP.'
            });
        }

        // Verify OTP
        if (verificationData.otp !== normalizedOtp) {
            verificationData.attempts = (verificationData.attempts || 0) + 1;
            const remainingAttempts = 5 - verificationData.attempts;

            return res.status(400).json({
                success: false,
                error: 'Invalid OTP',
                remainingAttempts: remainingAttempts
            });
        }

        // OTP is valid, mark as verified
        verificationData.status = 'verified';
        verificationData.verifiedAt = new Date();

        return res.status(200).json({
            success: true,
            message: 'OTP verified successfully',
            data: {
                email: verificationData.email,
                verifiedAt: verificationData.verifiedAt
            }
        });

    } catch (error: any) {
        console.error('Error verifying OTP:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});


router.post("/signup", async (req: any, res: any) => {
    let { userName, password } = req.body;
    if (!userName && req.body.email) {
        userName = req.body.email;
    }

    console.log('GeoIP headers received:', req.headers['x-country-code'], req.headers['x-country-name']);

    //for invite token based signup
    if (req.body.hasOwnProperty("inviteToken")) {
        const inviteTokenJWT = req.body.inviteToken;
        if (!inviteTokenJWT) {
            return res.status(400).json({
                success: false,
                error: 'Invite token is required'
            });
        }

        let decodedToken: JwtPayload | string;
        try {
            decodedToken = jwt.verify(inviteTokenJWT, JWT_SECRET);
        } catch (err: any) {
            return res.status(401).json({
                success: false,
                error: 'Token is invalid or expired'
            });
        }

        if (typeof decodedToken === 'string') {
            return res.status(400).json({
                success: false,
                error: 'Invalid token format'
            });
        }

        if (decodedToken.type !== JwtType.INVITE_VERIFICATION_TOKEN) {
            return res.status(400).json({
                success: false,
                error: 'Invalid token type'
            });
        }

        const inviteTokenId = decodedToken.inviteToken as string;
        if (!inviteTokenId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid invite token'
            });
        }

        const inviteData = pendingInvites.get(inviteTokenId);
        if (!inviteData) {
            return res.status(404).json({
                success: false,
                error: 'Invite not found or already used'
            });
        }

        if (inviteData.expiresAt < new Date()) {
            inviteData.status = 'expired';
            pendingInvites.delete(inviteTokenId);
            return res.status(401).json({
                success: false,
                error: 'Invite has expired'
            });
        }

        if (inviteData.status === 'expired') {
            pendingInvites.delete(inviteTokenId);
            return res.status(401).json({
                success: false,
                error: 'Invite has expired'
            });
        }

        if (inviteData.status === 'accepted') {
            return res.status(400).json({
                success: false,
                error: 'Invite has already been accepted'
            });
        }

        if (inviteData.status === 'declined') {
            return res.status(400).json({
                success: false,
                error: 'Invite has been declined'
            });
        }

        try {
            const { userCredentialHandler, refreshTokenHandler } = await initializeAuthDatabase();
            const { organizationHandler } = await initializeOrganizationDatabase();

            const organizationId = inviteData.organizationId;

            const organization = await organizationHandler.findOne({ OrganizationId: organizationId });

            if (!organization) {
                return res.status(404).json({
                    success: false,
                    error: 'Organization not found'
                });
            }

            if (!organization.dbName) {
                return res.status(500).json({
                    success: false,
                    error: 'Organization database not configured'
                });
            }

            const orgDbName = organization.dbName;

            if (!userName || !password) {
                return res.status(400).json({
                    success: false,
                    error: 'Email and password are required'
                });
            }

            const userEmail = userName;

            let existingUser = await userCredentialHandler.findOne({ email: userEmail });

            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    error: 'User with this email already exists'
                });
            }

            const userId = uuidv4();

            const dbService = await getDBService();
            await dbService.ensureDatabase(orgDbName);
            await dbService.ensureCollection(orgDbName, 'Users');

            const orgUsersHandler = dbService.getRepository<IUser>(orgDbName, 'Users');

            const existingOrgUser = await orgUsersHandler.findOne({ userId: userId });

            if (existingOrgUser) {
                pendingInvites.delete(inviteTokenId);
                return res.status(400).json({
                    success: false,
                    error: 'User is already a member of this organization'
                });
            }
            
            const newOrgUser: Partial<IUser> = {
                userName: "",
                userId: userId,
                email: userEmail,
                createdAt: new Date(),
                updatedAt: new Date(),
                active: true,
                organizationName: organization.OrganizationName,
                organizationId: organization.OrganizationId,
                permissionScopes: {
                },
                
                metadata: {
                    invitedBy: inviteData.metadata?.invitedBy,
                    invitedAt: new Date(),
                }
            };

            await orgUsersHandler.insertOne(newOrgUser as any);

            inviteData.status = 'accepted';
            pendingInvites.delete(inviteTokenId);

            // Extract GeoIP information from headers
            const countryCode = req.headers['x-country-code'] as string;
            const countryName = req.headers['x-country-name'] as string;
            const geoIPMetadata = (countryCode || countryName) ? {
                geoIP: {
                    countryCode: countryCode,
                    countryName: countryName,
                    registeredAt: new Date()
                }
            } : undefined;

            const authResult = await handleNewUserAuth(
                userCredentialHandler,
                refreshTokenHandler,
                {
                    userName: "",
                    userId: userId,
                    email: userEmail,
                    password: await bcrypt.hash(password, SALT_ROUNDS),
                    databaseName: orgDbName,
                    setupComplete: false,
                    invitedBy: inviteData.metadata?.invitedBy,
                    organizationRole: inviteData.role || 'Member',
                    ...(geoIPMetadata && { metadata: geoIPMetadata })
                },
                res,
                true
            );

            return res.status(200).json({
                success: true,
                message: 'Successfully joined organization',
                accessToken: authResult.accessToken,
                isDatabase: true,
                organizationName: organization.OrganizationName,
                userName: "",
                email: userEmail,
                type: JwtType.INVITE_VERIFICATION_TOKEN
            });

        } catch (error: any) {
            console.error('Error processing invite:', error);
            return res.status(500).json({
                success: false,
                error: 'Error processing invite',
                message: error.message
            });
        }
    }

    if (req.body.hasOwnProperty("verifyToken") || req.body.hasOwnProperty("verificationToken"))  //this is the case for email verification with OTP
    {
        //this is for OTP based signup
        const verifyToken = req.body.verifyToken || req.body.verificationToken;
        if (!verifyToken) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        try {
            const verificationToken = verifyToken; // Now it's just the UUID token

            const verificationData = pendingVerifications.get(verificationToken);

            if (!verificationData) {
                return res.status(400).json({
                    success: false,
                    error: 'Verification not found or already used'
                });
            }

            if (verificationData.expiresAt < new Date()) {
                pendingVerifications.delete(verificationToken);
                return res.status(400).json({
                    success: false,
                    error: 'Verification has expired'
                });
            }

            if (verificationData.status !== 'verified') {
                return res.status(400).json({
                    success: false,
                    error: 'Email not verified. Please verify your OTP first.'
                });
            }

            userName = verificationData.email;
            password = verificationData.password;

            pendingVerifications.delete(verificationToken);

            console.log(`Email verification successful for: ${userName}`);
        } catch (error) {
            console.error('Error processing verification token:', error);
            return res.status(500).json({
                success: false,
                error: 'Error processing verification token'
            });
        }
    }
    // Initialize database and handlers
    const { userCredentialHandler, refreshTokenHandler } = await initializeAuthDatabase();

    const existingUser = await userCredentialHandler.findOne({ userName: userName });

    if (existingUser) {
        // Handle existing user authentication
        const authResult = await handleExistingUserAuth(
            existingUser,
            refreshTokenHandler,
            res,
            false // secure cookie - commented in original
        );

        const message = authResult.isNewSession
            ? "New session created for existing user"
            : "User already exists, logged in with existing credentials";

        return res.json({ accessToken: authResult.accessToken, message, isDatabase: existingUser.databaseName === "" ? false : true });
    }

    // Handle new user registration
    const userid = uuidv4();
    const countryCode = req.headers['x-country-code'] as string;
    const countryName = req.headers['x-country-name'] as string;
    const geoIPMetadata = (countryCode || countryName) ? {
        geoIP: {
            countryCode: countryCode,
            countryName: countryName,
            registeredAt: new Date()
        }
    } : undefined;
    
    const authResult = await handleNewUserAuth(
        userCredentialHandler,
        refreshTokenHandler,
        {
            userName: userName.includes('@') ? "" : userName,
            userId: userid,
            email: userName.includes('@') ? userName : "",
            password: await bcrypt.hash(password, SALT_ROUNDS),
            databaseName: "",
            setupComplete: false,
            organizationRole: 'Owner',
            ...(geoIPMetadata && { metadata: geoIPMetadata })
        },
        res,
        true // secure cookie
    );

    res.json({
        accessToken: authResult.accessToken,
        isDatabase: false,
        userName: userName.includes('@') ? "" : userName,
        email: userName.includes('@') ? userName : "",
    });
});


router.post("/login", async (req: any, res: any) => {
    if (process.env.ENABLE_NORMAL_LOGIN !== 'true') {
        return res.status(403).json({ success: false, error: 'Normal login is disabled on this server.' });
    }
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required',
                code: 'MISSING_FIELDS'
            });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email format',
                code: 'INVALID_EMAIL'
            });
        }
        const { userCredentialHandler, refreshTokenHandler } = await initializeAuthDatabase();

        let existingUser = await userCredentialHandler.findOne({ email: email });

        if (!existingUser) {
            existingUser = await userCredentialHandler.findOne({ userName: email });
        }

        if (!existingUser) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password',
                code: 'INVALID_CREDENTIALS'
            });
        }

        if (!existingUser.password) {
            return res.status(400).json({
                success: false,
                error: 'This account uses OAuth authentication.',
                code: 'OAUTH_ACCOUNT'
            });
        }

        const isPasswordValid = await bcrypt.compare(password, existingUser.password);

        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password',
                code: 'INVALID_CREDENTIALS'
            });
        }

        const refreshTokenResult = await findOrCreateRefreshToken(
            existingUser.userId as any,
            refreshTokenHandler
        );

        const accessToken = createAccessToken(
            existingUser.userName || existingUser.email || email,
            existingUser.userId as any
        );

        setRefreshTokenCookie(res, refreshTokenResult.token, true);

        return res.status(200).json({
            success: true,
            accessToken: accessToken,
            isDatabase: existingUser.databaseName && existingUser.databaseName !== "",
            userName: existingUser.userName || "",
            email: existingUser.email || email,
            githubOauth: existingUser.githubOauth || false,
            message: 'Login successful'
        });

    } catch (error: any) {
        console.error('Login error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error during login',
            message: error.message,
            code: 'SERVER_ERROR'
        });
    }
});


router.post("/refresh", async (req: any, res: any) => {
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
        return res.status(401).json({ message: "Refresh token required, please login", routeToLogin: true });
    }

    let databaseService = await getDBService();
    await databaseService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
    await databaseService.ensureCollection(process.env.USER_CREDENTIAL_DB, process.env.USER_REFRESH_TOKEN_COLLECTION);

    let refreshTokenHandler = databaseService.getRepository<IRefreshToken>(process.env.USER_CREDENTIAL_DB, process.env.USER_REFRESH_TOKEN_COLLECTION);

    const tokenData = await refreshTokenHandler.findOne({
        token: refreshToken,
        revoked: false
    });

    if (!tokenData) {
        return res.status(401).json({ message: "Invalid refresh token, please login", routeToLogin: true });
    }

    if (process.env.DISABLE_TOKEN_EXPIRY !== 'true' && tokenData.expiresOn < new Date()) {
        return res.status(401).json({ message: "Refresh token expired, please login", routeToLogin: true });
    }

    let userCredentialHandler = databaseService.getRepository<IUserCredentials>(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
    const user = await userCredentialHandler.findOne({ userId: tokenData.userId });

    if (!user) {
        return res.status(401).json({ message: "User not found, please login", routeToLogin: true });
    }

    const accessToken = createAccessToken(user.userName || '', user.userId as any);

    res.json({ accessToken });
});

router.post("/checkAuth", async (req: any, res: any) => {
    const refreshToken = req.cookies.refreshToken;
    console.log("refreshToken is==>", refreshToken);

    if (!refreshToken) {
        return res.status(401).json({ message: "Refresh token not present", authenticated: false });
    }

    let databaseService = await getDBService();
    await databaseService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
    await databaseService.ensureCollection(process.env.USER_CREDENTIAL_DB, process.env.USER_REFRESH_TOKEN_COLLECTION);

    let refreshTokenHandler = databaseService.getRepository<IRefreshToken>(process.env.USER_CREDENTIAL_DB, process.env.USER_REFRESH_TOKEN_COLLECTION);

    const tokenData = await refreshTokenHandler.findOne({
        token: refreshToken,
        revoked: false
    });

    if (!tokenData) {
        return res.status(401).json({ message: "Invalid refresh token", authenticated: false });
    }

    if (process.env.DISABLE_TOKEN_EXPIRY !== 'true' && tokenData.expiresOn < new Date()) {
        return res.status(401).json({ message: "Refresh token expired", authenticated: false });
    }

    let userCredentialHandler = databaseService.getRepository<IUserCredentials>(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
    const user = await userCredentialHandler.findOne({ userId: tokenData.userId });

    if (!user) {
        return res.status(401).json({ message: "User not found", authenticated: false });
    }

    const accessToken = createAccessToken(user.userName || '', user.userId as any);

    res.json({ accessToken, authenticated: true, email: user.email, userName: user.userName, githubOauth: user.githubOauth, invitedBy: user.invitedBy });
});


router.post("/logout", async (req: any, res: any) => {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
        return res.status(200).json({ message: "Already logged out" });
    }

    try {
        let databaseService = await getDBService();
        await databaseService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
        await databaseService.ensureCollection(process.env.USER_CREDENTIAL_DB, process.env.USER_REFRESH_TOKEN_COLLECTION);

        let refreshTokenHandler = databaseService.getRepository<IRefreshToken>(
            process.env.USER_CREDENTIAL_DB,
            process.env.USER_REFRESH_TOKEN_COLLECTION
        );
        await refreshTokenHandler.updateOne(
            { token: refreshToken },
            { $set: { revoked: true, updatedOn: new Date() } }
        );
        res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: true,
            sameSite: "none"
        });

        return res.status(200).json({ message: "Logged out successfully" });
    } catch (error) {
        console.error("Logout error:", error);

        res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: true,
            sameSite: "None"
        });
        return res.status(500).json({ message: "Error during logout, but cookies cleared" });
    }
});

router.post("/verifyToken", async (req: any, res: any) => {
    try {
        const { token } = req.body;
        console.log("token is==>", token);
        if (!token) {
            return res.status(400).json({ valid: false, error: 'Token is required' });
        }

        let decodedToken: JwtPayload | string;
        try {
            decodedToken = jwt.verify(token, JWT_SECRET);
        } catch (err: any) {
            return res.status(401).json({ valid: false, error: 'Token is invalid or expired' });
        }

        if (typeof decodedToken === 'string') {
            return res.status(400).json({ valid: false, error: 'Invalid token format' });
        }

        const tokenType = decodedToken.type !== undefined ? decodedToken.type : JwtType.ACCESS_TOKEN;
        console.log("token type is==>", tokenType);
        switch (tokenType) {
            case JwtType.ACCESS_TOKEN:
                if (!decodedToken.userName || !decodedToken.userId) {
                    return res.status(400).json({ valid: false, error: 'Invalid access token' });
                }
                return res.status(200).json({ valid: true });

            case JwtType.EMAIL_VERIFICATION_TOKEN:
                const verificationToken = decodedToken.verificationToken as string;
                if (!verificationToken) {
                    return res.status(400).json({ valid: false, error: 'Invalid verification token' });
                }

                const verificationData = pendingVerifications.get(verificationToken);
                if (!verificationData || verificationData.expiresAt < new Date() || verificationData.status === 'expired') {
                    return res.status(401).json({ valid: false, error: 'Verification not found or expired' });
                }
                return res.status(200).json({ valid: true });

            case JwtType.INVITE_VERIFICATION_TOKEN:
                console.log("invite token is==>", decodedToken);
                const inviteToken = decodedToken.inviteToken as string;
                if (!inviteToken) {
                    return res.status(400).json({ valid: false, error: 'Invalid invite token' });
                }

                const inviteData = pendingInvites.get(inviteToken);
                if (!inviteData || inviteData.expiresAt < new Date() ||
                    inviteData.status === 'expired' || inviteData.status === 'accepted' ||
                    inviteData.status === 'declined') {
                    return res.status(401).json({ valid: false, error: 'Invite not found, expired, or already used' });
                }

                return res.status(200).json({
                    valid: true,
                    email: inviteData.recipientEmail,
                    organizationName: inviteData.organizationName
                });

            default:
                return res.status(400).json({ valid: false, error: 'Unknown token type' });
        }

    } catch (error: any) {
        console.error('Token verification error:', error);
        return res.status(500).json({ valid: false, error: 'Internal server error' });
    }
});

//password reset routes
router.post("/sendPasswordReset", async (req: any, res: any) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }
        const result = await SendPasswordResetEmail(email);
        if (result.success) {
            return res.status(200).json({
                success: true,
                message: result.message
            });
        } else {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

    } catch (error: any) {
        console.error('Send password reset endpoint error:', error);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while processing your request'
        });
    }
});

router.post("/verifyPasswordToken", async (req: any, res: any) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({
                success: false,
                valid: false,
                message: 'Token is required'
            });
        }

        const result = await VerifyPasswordResetLink(token);
        
        if (result.isValid) {
            return res.status(200).json({
                success: true,
                valid: true,
                message: 'Token is valid',
                userId: result.userId,
                email: result.email
            });
        } else {
            return res.status(400).json({
                success: false,
                valid: false,
                message: result.error || 'Token is invalid'
            });
        }

    } catch (error: any) {
        console.error('Verify password token endpoint error:', error);
        return res.status(500).json({
            success: false,
            valid: false,
            message: 'An error occurred while verifying the token'
        });
    }
});

router.post("/resetPassword", async (req: any, res: any) => {
    try {
        const { accessToken, newPassword } = req.body;

        if (!accessToken) {
            return res.status(400).json({
                success: false,
                message: 'Access token is required'
            });
        }

        if (!newPassword) {
            return res.status(400).json({
                success: false,
                message: 'New password is required'
            });
        }

        const result = await ResetPassword(accessToken, newPassword);
        
        if (result.success) {
            return res.status(200).json({
                success: true,
                message: result.message
            });
        } else {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

    } catch (error: any) {
        console.error('Reset password endpoint error:', error);
        return res.status(500).json({
            success: false,
            message: 'An error occurred while processing your request'
        });
    }
});

/**
 * Name-only auth endpoint (signup + login in one).
 * Enabled only when ENABLE_NORMAL_LOGIN=true.
 * Input: { firstName, lastName }
 * - If a user with that derived userName already exists  -> log them in
 * - Otherwise                                           -> create account, log them in
 * Tokens never expire when DISABLE_TOKEN_EXPIRY=true.
 */
router.post("/name-auth", async (req: any, res: any) => {
    if (process.env.ENABLE_NORMAL_LOGIN !== 'true') {
        return res.status(403).json({ success: false, error: 'Normal login is disabled on this server.' });
    }
    try {
        const { firstName, lastName } = req.body;
        if (!firstName || !lastName) {
            return res.status(400).json({ success: false, error: 'firstName and lastName are required.' });
        }

        // Derive a stable userName from the name
        const normalizedFirst = firstName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedLast  = lastName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        const userName = `${normalizedFirst}_${normalizedLast}`;

        const { userCredentialHandler, refreshTokenHandler } = await initializeAuthDatabase();

        // Check if user already exists
        let existingUser = await userCredentialHandler.findOne({ userName });

        if (existingUser) {
            // LOGIN path
            const authResult = await handleExistingUserAuth(existingUser, refreshTokenHandler, res, true);
            return res.status(200).json({
                success: true,
                accessToken: authResult.accessToken,
                isDatabase: !!(existingUser.databaseName && existingUser.databaseName !== ''),
                userName: existingUser.userName,
                email: existingUser.email,
                isNew: false
            });
        }

        // SIGNUP path — auto-generate everything except the name
        const userId   = uuidv4();
        const shortId  = userId.split('-')[0];  // e.g. "a1b2c3d4"
        const autoEmail = `${userName}.${shortId}@phantomx.internal`;

        const countryCode = req.headers['x-country-code'] as string;
        const countryName = req.headers['x-country-name'] as string;
        const geoIPMetadata = (countryCode || countryName) ? {
            geoIP: { countryCode, countryName, registeredAt: new Date() }
        } : undefined;

        const authResult = await handleNewUserAuth(
            userCredentialHandler,
            refreshTokenHandler,
            {
                userName,
                userId,
                email: autoEmail,
                password: '',          // no password for name-only accounts
                databaseName: '',
                setupComplete: false,
                organizationRole: 'Owner',
                metadata: {
                    // Store real names so get_setup_data can pre-fill the setup form
                    firstName: firstName.trim(),
                    lastName: lastName.trim(),
                    isNameAuth: true,   // flag to identify name-auth accounts
                    ...(geoIPMetadata?.geoIP && { geoIP: geoIPMetadata.geoIP })
                }
            },
            res,
            true
        );

        return res.status(200).json({
            success: true,
            accessToken: authResult.accessToken,
            isDatabase: false,
            userName,
            email: autoEmail,
            isNew: true
        });
    } catch (error: any) {
        console.error('name-auth error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});

export default router;
