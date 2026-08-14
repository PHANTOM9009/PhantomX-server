import { PendingEmailResets, pendingEmailResets } from "../DataStructures";
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { IApiKey } from '../DataAccessLayer/models/ApiKey';
import { UserInfo } from '../DataStructures';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { queueMail } from './Queue/mail-queue';

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';


export async function SendPasswordResetEmail(email: string, userId?: string): Promise<{ success: boolean; message: string; resetToken?: string }> {
    try {
        if (!email || typeof email !== 'string') {
            throw new Error('Valid email is required');
        }


        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error('Invalid email format');
        }

        let uId = userId;
        const databaseService = DatabaseService.getInstance();

        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const userCredRepo = databaseService.getRepository<IUserCredentials>(
            process.env.USER_CREDENTIAL_DB!,
            process.env.USER_CREDENTIAL_COLLECTION!
        );

        let userDetails: IUserCredentials | null = null;

        if (!userId) {
            userDetails = await userCredRepo.findOne({ email: email.toLowerCase() });
            if (!userDetails) {
                return { success: true, message: 'If the email exists, a reset link will be sent' };
            }
            uId = userDetails.userId.toString();
        } else {
            userDetails = await userCredRepo.findOne({
                userId: userId as any,
                email: email.toLowerCase()
            });
            if (!userDetails) {
                return { success: true, message: 'If the email exists, a reset link will be sent' };
            }
        }

        if (!uId) {
            throw new Error('User ID could not be determined');
        }

        try {
            pendingEmailResets.forEach((value, key) => {
            if (value.status === 'verified' || Date.now() > value.expiresAt.getTime()) {
                pendingEmailResets.delete(key);
            }
        });
        }
        catch(cleanupError){
            console.error('Error during pending email resets cleanup:', cleanupError);
        }


        const existingReset = pendingEmailResets.get(uId);
        if (existingReset) {
            const timeSinceLastReset = Date.now() - existingReset.createdAt.getTime();
            const minResetInterval = 60000;

            if (timeSinceLastReset < minResetInterval) {
                return {
                    success: false,
                    message: 'Please wait before requesting another reset link'
                };
            }

            if (Date.now() > existingReset.expiresAt.getTime()) {
                pendingEmailResets.delete(uId);
            } else {
                pendingEmailResets.delete(uId);
            }
        }

        const resetToken = uuidv4();

        const accessToken = jwt.sign(
            {
                userId: uId,
                email: email.toLowerCase(),
                resetToken: resetToken,
                iat: Math.floor(Date.now() / 1000)
            },
            JWT_SECRET,
            { expiresIn: '10m' }
        );

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

        const pendingResetData: PendingEmailResets = {
            email: email.toLowerCase(),
            userId: uId,
            resetToken: resetToken,
            expiresAt: expiresAt,
            createdAt: now,
            status: 'pending',
            id: resetToken
        };

        pendingEmailResets.set(uId, pendingResetData);

        const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${accessToken}`;

        const emailData = {
            to: email.toLowerCase(),
            subject: 'Password Reset Request',
            from: process.env.SES_FROM_EMAIL || 'phantomx@phantomx.dev',
            htmlBody: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">Password Reset Request</h2>
                    <p>Hello,</p>
                    <p>You requested a password reset for your account. Click the button below to reset your password:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetUrl}" 
                           style="background-color: #007bff; color: white; padding: 12px 24px; 
                                  text-decoration: none; border-radius: 4px; display: inline-block;">
                            Reset Password
                        </a>
                    </div>
                    <p>This link will expire in 10 minutes for security reasons.</p>
                    <p>If you didn't request this password reset, please ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #666; font-size: 12px;">
                        If the button doesn't work, copy and paste this link into your browser:<br>
                        <a href="${resetUrl}">${resetUrl}</a>
                    </p>
                </div>
            `,
            textBody: `
Password Reset Request

Hello,

You requested a password reset for your account. Please click the link below to reset your password:

${resetUrl}

This link will expire in 10 minutes for security reasons.

If you didn't request this password reset, please ignore this email.
            `.trim()
        };

        try {
            const jobId = await queueMail(emailData);
            console.log(`Password reset email queued for ${email} with job ID: ${jobId}`);
        } catch (emailError: any) {
            console.error('Failed to queue password reset email:', emailError);
            // Don't fail the whole operation if email fails - the user can try again
        }

        return {
            success: true,
            message: 'Password reset link sent successfully',
            resetToken: accessToken
        };

    } catch (error: any) {
        console.error('SendPasswordResetEmail error:', error);
        return {
            success: false,
            message: 'An error occurred while processing your request'
        };
    }
}

export async function VerifyPasswordResetLink(token: string): Promise<{ isValid: boolean; userId?: string; email?: string; error?: string }> {
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;

        if (!decoded || !decoded.userId || !decoded.email || !decoded.resetToken) {
            return { isValid: false, error: 'Invalid token format' };
        }

        const { userId, email, resetToken } = decoded;

        const pendingReset = pendingEmailResets.get(userId);
        if (!pendingReset) {
            return { isValid: false, error: 'Reset request not found or already used' };
        }

        if (pendingReset.resetToken !== resetToken) {
            return { isValid: false, error: 'Invalid reset token' };
        }

        const now = new Date();
        if (now > pendingReset.expiresAt) {
            pendingEmailResets.delete(userId);
            return { isValid: false, error: 'Reset link has expired' };
        }

        if (pendingReset.email.toLowerCase() !== email.toLowerCase()) {
            return { isValid: false, error: 'Email mismatch' };
        }

        if (pendingReset.status !== 'pending') {
            return { isValid: false, error: 'Reset request already processed' };
        }

        const databaseService = DatabaseService.getInstance();

        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const userCredRepo = databaseService.getRepository<IUserCredentials>(
            process.env.USER_CREDENTIAL_DB!,
            process.env.USER_CREDENTIAL_COLLECTION!
        );

        const userDetails = await userCredRepo.findOne({
            userId: userId,
            email: email.toLowerCase()
        });

        if (!userDetails) {
            pendingEmailResets.delete(userId);
            return { isValid: false, error: 'User not found' };
        }

        // Set status to verified instead of deleting
        pendingReset.status = 'verified';
        pendingEmailResets.set(userId, pendingReset);

        return {
            isValid: true,
            userId: userId,
            email: email
        };

    } catch (jwtError: any) {
        if (jwtError.name === 'TokenExpiredError') {
            return { isValid: false, error: 'Reset link has expired' };
        } else if (jwtError.name === 'JsonWebTokenError') {
            return { isValid: false, error: 'Invalid reset token' };
        } else if (jwtError.name === 'NotBeforeError') {
            return { isValid: false, error: 'Reset token not active yet' };
        }

        console.error('Password reset verification error:', jwtError);
        return { isValid: false, error: 'Token verification failed' };
    }
}

export async function ResetPassword(token: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
        if (!token || typeof token !== 'string') {
            return { success: false, message: 'Valid token is required' };
        }

        if (!newPassword || typeof newPassword !== 'string') {
            return { success: false, message: 'Password is required' };
        }

        if (newPassword.length < 8) {
            return { success: false, message: 'Password must be at least 8 characters long' };
        }

        const hasUpperCase = /[A-Z]/.test(newPassword);
        const hasLowerCase = /[a-z]/.test(newPassword);
        const hasNumbers = /\d/.test(newPassword);
        const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(newPassword);

        if (!hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) {
            return { 
                success: false, 
                message: 'Password must contain at least one uppercase letter, lowercase letter, number, and special character' 
            };
        }

        let userId: string;
        let email: string;
        let resetToken: string;
        try {
            const decoded = jwt.verify(token, JWT_SECRET) as any;
            if (!decoded || !decoded.userId || !decoded.email || !decoded.resetToken) {
                return { success: false, message: 'Invalid token format' };
            }
            userId = decoded.userId;
            email = decoded.email;
            resetToken = decoded.resetToken;
        } catch (jwtError: any) {
            if (jwtError.name === 'TokenExpiredError') {
                return { success: false, message: 'Reset link has expired' };
            }
            return { success: false, message: 'Invalid reset token' };
        }

        const pendingReset = pendingEmailResets.get(userId);
        if (!pendingReset) {
            return { success: false, message: 'Reset request not found or already processed' };
        }

        if (pendingReset.resetToken !== resetToken) {
            return { success: false, message: 'Invalid reset token' };
        }

        const now = new Date();
        if (now > pendingReset.expiresAt) {
            pendingEmailResets.delete(userId);
            return { success: false, message: 'Reset link has expired' };
        }

        if (pendingReset.email.toLowerCase() !== email.toLowerCase()) {
            return { success: false, message: 'Invalid reset request' };
        }

        if (pendingReset.status !== 'verified') {
            return { success: false, message: 'Reset request must be verified before password can be changed' };
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const userCredRepo = databaseService.getRepository<IUserCredentials>(
            process.env.USER_CREDENTIAL_DB!,
            process.env.USER_CREDENTIAL_COLLECTION!
        );

        const existingUser = await userCredRepo.findOne({
            userId: userId as any,
            email: email.toLowerCase()
        });

        if (!existingUser) {
            pendingEmailResets.delete(userId);
            return { success: false, message: 'User not found' };
        }

        const bcrypt = require('bcrypt');
        const isSamePassword = await bcrypt.compare(newPassword, existingUser.password);
        if (isSamePassword) {
            return { success: false, message: 'New password must be different from your current password' };
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        const updateResult = await userCredRepo.updateOne(
            { userId: userId as any },
            { 
                $set: { 
                    password: hashedPassword, 
                    updatedAt: new Date(),
                    passwordChangedAt: new Date(),
                    sessionInvalidatedAt: new Date()
                } 
            }
        );

        if (updateResult.modifiedCount === 0) {
            return { success: false, message: 'Failed to update password' };
        }

        pendingReset.status = 'completed';
        pendingEmailResets.set(userId, pendingReset);

        setTimeout(() => {
            pendingEmailResets.delete(userId);
        }, 60000); 

        console.log(`Password successfully reset for user ${userId} (${email})`);
        return {
            success: true,
            message: 'Password reset successfully. Please log in with your new password.'
        };

    } catch (error: any) {
        console.error('ResetPassword error:', error);
        return {
            success: false,
            message: 'An error occurred while resetting your password'
        };
    }
}

// ─── Internal helper ────────────────────────────────────────────────────────

/**
 * SHA-256 hash of the raw API key string.
 * This is what gets stored in the DB — the raw key is never persisted.
 */
function hashApiKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Mints a new API key for a user and persists a SHA-256 hash of it in the
 * organisation's user database.  The raw key is returned exactly once —
 * it is never stored and cannot be recovered afterwards.
 *
 * @param userId      - The user who owns this key.
 * @param userDbName  - The organisation's database name (IUserCredentials.databaseName).
 * @param expiresIn   - Expiry expressed as milliseconds from now, or null for no expiry.
 * @param label       - Human-readable name for the key (e.g. "CI pipeline").
 * @returns The raw API key string (show to the user once and discard).
 */
export async function mintApiKey(
    userId: string,
    userDbName: string,
    expiresIn: number | null,
    label: string = 'API Key'
): Promise<{ success: boolean; rawKey?: string; error?: string }> {
    try {
        if (!userId || typeof userId !== 'string') {
            return { success: false, error: 'Valid userId is required' };
        }
        if (!userDbName || typeof userDbName !== 'string') {
            return { success: false, error: 'Valid userDbName is required' };
        }

        // Generate a cryptographically secure random 32-byte key, hex-encoded (64 chars)
        const rawKey = crypto.randomBytes(32).toString('hex');
        const keyHash = hashApiKey(rawKey);

        const now = new Date();
        const expiresAt: Date | null = expiresIn !== null ? new Date(now.getTime() + expiresIn) : null;

        const apiKeyRecord: Omit<IApiKey, '_id'> = {
            keyHash,
            userId,
            label: label.trim() || 'API Key',
            createdAt: now,
            expiresAt,
            isRevoked: false,
            databaseName: userDbName
        };

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        await databaseService.ensureCollection("UserCredentials", CollectionNames.API_KEYS);
        const apiKeyRepo = databaseService.getRepository<IApiKey>("UserCredentials", CollectionNames.API_KEYS);
        await apiKeyRepo.insertOne(apiKeyRecord as any);

        console.log(`API key minted for user ${userId} in db ${userDbName}, expires: ${expiresAt ?? 'never'}`);
        return { success: true, rawKey };

    } catch (error: any) {
        console.error('mintApiKey error:', error);
        return { success: false, error: 'Failed to mint API key' };
    }
}

/**
 * Verifies an incoming raw API key against the hashed records in the
 * organisation's user database.  Updates `lastUsedAt` on every successful hit.
 *
 * @param rawKey     - The raw API key string sent by the caller.
 * @param userDbName - The organisation's database name (IUserCredentials.databaseName).
 * @returns Verification result with the owning userId when valid.
 */
export async function decipherApiKey(
    rawKey: string,
    
): Promise<{ valid: boolean; userId?: string; error?: string }> {
    try {
        if (!rawKey || typeof rawKey !== 'string') {
            return { valid: false, error: 'API key is required' };
        }
        let userDbName = "UserCredentials";
        if (!userDbName || typeof userDbName !== 'string') {
            return { valid: false, error: 'Valid userDbName is required' };
        }

        const keyHash = hashApiKey(rawKey);

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const apiKeyRepo = databaseService.getRepository<IApiKey>(userDbName, CollectionNames.API_KEYS);
        const record = await apiKeyRepo.findOne({ keyHash });

        if (!record) {
            return { valid: false, error: 'Invalid API key' };
        }

        if (record.isRevoked) {
            return { valid: false, error: 'API key has been revoked' };
        }

        if (record.expiresAt !== null && new Date() > record.expiresAt) {
            return { valid: false, error: 'API key has expired' };
        }

        // Fire-and-forget: update lastUsedAt without blocking the response
        apiKeyRepo.updateOne(
            { keyHash } as any,
            { $set: { lastUsedAt: new Date() } } as any
        ).catch((err: any) => console.error('Failed to update lastUsedAt:', err));

        return { valid: true, userId: record.userId };

    } catch (error: any) {
        console.error('decipherApiKey error:', error);
        return { valid: false, error: 'API key verification failed' };
    }
}

/**
 * Revokes an API key immediately by setting isRevoked = true.
 * The record remains in the DB for audit purposes.
 *
 * @param rawKey     - The raw API key to revoke (the user provides this).
 * @param userDbName - The organisation's database name.
 */
export async function revokeApiKey(
    rawKey: string,
    userDbName: string
): Promise<{ success: boolean; error?: string }> {
    try {
        if (!rawKey || typeof rawKey !== 'string') {
            return { success: false, error: 'API key is required' };
        }

        const keyHash = hashApiKey(rawKey);

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const apiKeyRepo = databaseService.getRepository<IApiKey>(userDbName, CollectionNames.API_KEYS);
        const result = await apiKeyRepo.updateOne(
            { keyHash } as any,
            { $set: { isRevoked: true } } as any
        );

        if (result.matchedCount === 0) {
            return { success: false, error: 'API key not found' };
        }

        return { success: true };

    } catch (error: any) {
        console.error('revokeApiKey error:', error);
        return { success: false, error: 'Failed to revoke API key' };
    }
}

