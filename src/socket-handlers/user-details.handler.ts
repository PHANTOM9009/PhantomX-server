import { Server, Socket } from 'socket.io';
import { getDBService } from '../DataAccessLayer/db-connection';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { IUser } from '../DataAccessLayer/models/User';
import { INotification } from '../DataAccessLayer/models/Notifications';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import jwt from 'jsonwebtoken';
import { getOAuthUserEmail, getOAuthUserInfo, getUserOrgs, revokeOAuthToken } from '../Services/GithubOAuthFlow';
import {
    oauthTokens, oauthTempState, pendingInvites, PendingInviteData, oauthStates, pendingGithubAppInstall,
    UserInfo,
    globalDatabaseService
} from '../DataStructures';
import { v4 as uuidv4 } from 'uuid';
import {

    validateOAuthState,
    generateOAuthAuthorizationUrl,
    exchangeOAuthCode,
    getValidOAuthToken,
    validateToken,

} from "../Services/GithubOAuthFlow";
import { checkGithubInstallationId, initializeOrganizationDatabase } from '../Services/AuthTokenService';
import { SendInviteMail } from './invite-mail.handler';
import { queueInviteMail, queueMultipleInviteMail } from '../Services/Queue/mail-queue';
import { generateAppInstallationUrl } from '../Services/GithubAppFlow';
import { JwtType } from '../classes/JwtType';
import { DatabaseService } from '../DataAccessLayer';
import { IOrganization } from '../DataAccessLayer/models';
import { constraintHandlerClass } from '../Services/constraintsService';
import { constraintTypes } from '../model/Plans';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
export async function user_details_handler(io: Server, socket: Socket, connectedClients: Map<string, any>) {
    // Handle whoami request to get user details

    const isOrgOwner = (userId: string) => {
        const userInfo = UserInfo.get(userId);
        const organizationId = userInfo?.organizationId;
        if (organizationId && userInfo?.permissionScopes && userInfo.permissionScopes[organizationId] === 'Owner') {
            return true;
        }
        return false;
    }

    socket.on('whoami', async (data: any, callback) => {
        try {
            // Check if user data exists in socket
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { userId, userName, email } = socket.data.user;

            //First, get the database name if not already in socket data
            let databaseName = socket.data.user.databaseName;

            if (!databaseName) {
                //If database name is not in socket data, fetch it from user credentials
                const tempDbService = await getDBService();
                await tempDbService.ensureDatabase(process.env.USER_CREDENTIAL_DB);

                const userCredentialHandler = tempDbService.getRepository<IUserCredentials>(
                    process.env.USER_CREDENTIAL_DB,
                    process.env.USER_CREDENTIAL_COLLECTION
                );

                const userCredentials = await userCredentialHandler.findOne({ userId });

                if (!userCredentials) {
                    callback({
                        success: false,
                        error: 'User database not found'
                    });
                    return;
                }

                // Check if setup is complete
                if (userCredentials.setupComplete === false) {
                    callback({
                        success: false,
                        error: 'User setup not complete',
                        code: 'SETUP_INCOMPLETE'
                    });
                    return;
                }

                if (!userCredentials.databaseName) {
                    callback({
                        success: false,
                        error: 'User database not found',
                        code: 500
                    });
                    return;
                }
                databaseName = userCredentials.databaseName;
                socket.data.user.databaseName = databaseName;
            }

            const databaseService: DatabaseService = socket.data.user.dbService || await getDBService();

            await databaseService.ensureDatabase(databaseName);
            await databaseService.ensureCollection(databaseName, CollectionNames.USERS);

            const userRepository = databaseService.getRepository<IUser>(databaseName, CollectionNames.USERS);
            console.log("userName is ===>", userName);
            console.log("dataBaseName is ===>", databaseName);
            const user = await userRepository.findOne({ userId });
            //setting the planId after taking it out from the organiztionDb,
           
            if (!user) {
                callback({
                    success: false,
                    error: 'User not found in organization database'
                });
                return;
            }

            let orgHandler = databaseService.getRepository<IOrganization>('Organizations', 'Organizations');

            let orgData = await orgHandler.findOne({
                OrganizationId: user.organizationId
            }); // organizationData

            const resolvedPlanId = orgData?.metadata?.paypal?.subscription?.planId ?? orgData?.metadata?.razorpay?.planId ?? orgData?.metadata?.razorpay?.subscription?.plan_Id ?? 'Essential';

            UserInfo.set(userId, { ...user, dbName: databaseName, planId: resolvedPlanId } as any);

            const userDetails = {
                userId: userId,
                userName: user.userName,
                email: user.email,
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                databaseName,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
                lastLogin: user.lastLogin,
                active: user.active,
                metadata: user.metadata,
                dbName: databaseName,
                permissionScopes: user.permissionScopes,
                organizationId: user.organizationId,
                organizationName: user.organizationName,
                planId: orgData?.metadata?.paypal?.subscription?.planId ?? orgData?.metadata?.razorpay?.planId ?? orgData?.metadata?.razorpay?.subscription?.plan_Id ?? 'Essential'
            };
            callback({
                success: true,
                data: userDetails
            });

        } catch (error) {
            console.error('Error in whoami handler:', error);
            callback({
                success: false,
                error: 'Internal server error'
            });
        }
    });

    socket.on("get_setup_data", async (data: any, callback) => {

        //getting the data of github if the user is logged in
        let userId = socket.data.user.userId;
        if (userId == null) {
            console.log("userId not found");
        }
        if (oauthTokens[userId] != undefined && oauthTokens[userId] != null) {

            let githubToken = oauthTokens[userId]?.accessToken;
            let userData = await getOAuthUserInfo(githubToken);
            let userEmail = await getOAuthUserEmail(githubToken);

            let finalData = {
                isGithub: true,
                email: userEmail[0]?.email,
                userName: userData?.login,
                firstName: userData?.name?.split(' ')[0],
                lastName: userData?.name?.split(' ')[1]
            }
            callback(finalData);
        }
        else {
            //else the user has not logged in from github then in this case this is a normal signup, lets fetch the email only

            let userCredential = globalDatabaseService.getRepository<IUserCredentials>(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
            let userData = await userCredential.findOne({ userId: socket.data.user.userId });

            // For name-auth accounts the stored email is a fake @phantomx.internal placeholder.
            // Return an empty email so the setup form starts blank and the user types their real one.
            // Pre-fill firstName/lastName from metadata if they were stored during name-auth.
            const isNameAuth = userData?.metadata?.isNameAuth === true;
            const finalData: any = {
                isGithub: false,
                email: isNameAuth ? '' : (userData?.email || ''),
                firstName: userData?.metadata?.firstName || '',
                lastName:  userData?.metadata?.lastName  || '',
                userName:  isNameAuth ? '' : (userData?.userName || '')  // don't pre-fill the derived john_doe username
            };
            callback(finalData);
        }

    });
    socket.on("connect_github", async (data: any, callback) => {
        let userId = socket.data.user.userId;
        let uniqueId = uuidv4();

        oauthStates[uniqueId] = {
            state: uniqueId,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        };
        oauthTempState.set(uniqueId, { userId: userId, socket: socket });
        const authUrl = generateOAuthAuthorizationUrl(uniqueId);
        callback({ success: true, message: "Github connection successful", authUrl: authUrl });
    });
    socket.on("get_github_organizations", async (data: any, callback) => {
        console.log("getting organization data");
        let userId = socket.data.user.userId;
        let githubToken = oauthTokens[userId]?.accessToken;
        console.log("githubToken is ===>", githubToken);
        let finalData = await getUserOrgs(githubToken);
        console.log("finalData is ===>", finalData);
        callback(finalData);

    });
    socket.on("install_github_application", async (data: any, callback) => {

        let state = uuidv4();
        let githubURL = generateAppInstallationUrl(state);
        pendingGithubAppInstall.set(state, [socket.data.user.userId, socket] as any);

        callback({
            installUrl: githubURL
        });


    });
    socket.on("is_github_app_installed", async (data: any, callback) => {

        let userId = socket.data.user.userId;
        let organizationName: any = UserInfo.get(userId)?.organizationName;
        //now checking if in the organizationName DB there exists a key in github having installationToken as a key

        let check = await checkGithubInstallationId(organizationName);
        callback({
            installed: check.hasInstallationId,
            githubOrganizationName: check.githubOrganizationName || null
        });
    });

  

    socket.on("get_github_disconnect_url", async (data: any, callback) => {
        try {
            const userId = socket.data.user.userId;
            const organizationName: any = UserInfo.get(userId)?.organizationName;
            if (!isOrgOwner(userId)) {
                callback({
                    success: false,
                    message: 'Permission denied: user is not an organization owner'
                });
                return;
            }

            if (!organizationName) {
                callback({
                    success: false,
                    message: 'Organization not found'
                });
                return;
            }

            const check = await checkGithubInstallationId(organizationName);

            if (!check.hasInstallationId || !check.installationId) {
                callback({
                    success: false,
                    message: 'GitHub installation not found'
                });
                return;
            }

            // Get GitHub organization name from metadata
            const databaseService = DatabaseService.getInstance();
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
            }
            await databaseService.ensureDatabase(process.env.ORGANIZATION_DB);
            await databaseService.ensureCollection(process.env.ORGANIZATION_DB, process.env.ORGANIZATION_COLLECTION);

            const organizationHandler = databaseService.getRepository<any>(
                process.env.ORGANIZATION_DB,
                process.env.ORGANIZATION_COLLECTION
            );

            const organization = await organizationHandler.findOne({ OrganizationName: organizationName });
            const githubOrgName = organization?.metadata?.github?.githubOrganizationName;

            if (!githubOrgName) {
                callback({
                    success: false,
                    message: 'GitHub organization name not found'
                });
                return;
            }

            // Construct the GitHub settings URL
            const disconnectUrl = `https://github.com/organizations/${githubOrgName}/settings/installations/${check.installationId}`;

            callback({
                success: true,
                disconnectUrl: disconnectUrl
            });
        } catch (error: any) {
            console.error('Error in get_github_disconnect_url handler:', error);
            callback({
                success: false,
                message: `Error getting GitHub disconnect URL: ${error.message}`
            });
        }
    });
    socket.on("revoke_github_oauth", async (data: any, callback) => {
        try {
            const userId = socket.data.user.userId;

            if (!userId) {
                callback({
                    success: false,
                    message: 'User not authenticated'
                });
                return;
            }

            const tokenRecord = oauthTokens[userId];

            if (!tokenRecord || !tokenRecord.accessToken) {
                callback({
                    success: false,
                    message: 'No GitHub OAuth token found for user'
                });
                return;
            }

            const result = await revokeOAuthToken(tokenRecord.accessToken);

            if (result.success) {
                delete oauthTokens[userId];
                console.log(`[user-details.handler] GitHub OAuth revoked for user: ${userId}`);
            }

            callback(result);
        } catch (error: any) {
            console.error('Error in revoke_github_oauth handler:', error);
            callback({
                success: false,
                message: `Error revoking GitHub OAuth: ${error.message}`
            });
        }
    });
    socket.on("invite_user", async (data: any, callback) => {
        try {

            let cresult: any = await constraintHandlerClass.constraintHandler(socket.data.user.userId, constraintTypes.TeamMembers);
            if (!cresult.success) {
                callback({
                    success: false,
                    message: cresult.message,
                    error: cresult.message
                })
            }


            if (!socket.data.user || !socket.data.user.userId) {
                if (typeof callback === 'function') {
                    callback({
                        success: false,
                        error: 'User not authenticated'
                    });
                }
                return;
            }

            if (typeof callback !== 'function') {
                console.error('Callback is not a function');
                return;
            }

            const { emails, role, organizationId, organizationName, inviterEmail, inviterName } = data;

            if (!emails || !organizationId || !organizationName) {
                callback({
                    success: false,
                    error: 'Missing required fields: email, organizationId, and organizationName are required'
                });
                return;
            }

            const databaseService = socket.data.user.dbService || await getDBService();

            const databaseName = socket.data.user.databaseName;
            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            await databaseService.ensureDatabase(databaseName);
            await databaseService.ensureCollection(databaseName, CollectionNames.USERS);

            const userRepository = databaseService.getRepository(databaseName, CollectionNames.USERS);

            // Handle both single email (string) and multiple emails (array)
            const emailArray = Array.isArray(emails) ? emails : [emails];
            const inviterNameValue = inviterName || socket.data.user.userName || 'Admin';
            const inviterEmailValue = inviterEmail || socket.data.user.email || 'admin@organization.com';
            const roleValue = role || 'Member';

            const existingUsers: string[] = [];
            for (const emailItem of emailArray) {
                const existingUser = await userRepository.findOne({ email: emailItem });
                if (existingUser) {
                    existingUsers.push(emailItem);
                }
            }

            if (existingUsers.length > 0) {
                callback({
                    success: false,
                    error: `User(s) with email(s) already exist in the organization: ${existingUsers.join(', ')}`,
                    code: 'USER_EXISTS',
                    existingEmails: existingUsers
                });
                return;
            }

            const now = new Date();
            const expiryDate = new Date(now);
            expiryDate.setDate(expiryDate.getDate() + 7);

            const inviteDataList: PendingInviteData[] = [];
            const inviteTokens: string[] = [];
            const accessTokens: string[] = [];

            for (const emailItem of emailArray) {
                const inviteToken = uuidv4();
                const accessToken = jwt.sign(
                    {
                        inviteToken,
                        email: emailItem,
                        organizationId,
                        type: JwtType.INVITE_VERIFICATION_TOKEN
                    },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );

                const inviteData: PendingInviteData = {
                    invitedUserId: inviteToken,
                    recipientEmail: emailItem,
                    accessToken,
                    organizationId,
                    organizationName,
                    inviterEmail: inviterEmailValue,
                    inviterName: inviterNameValue,
                    status: 'pending',
                    createdAt: now,
                    expiresAt: expiryDate,
                    role: roleValue,
                    metadata: {
                        inviteToken,
                        accessToken,
                        invitedBy: socket.data.user.userId
                    }
                };

                pendingInvites.set(inviteToken, inviteData);
                inviteDataList.push(inviteData);
                inviteTokens.push(inviteToken);
                accessTokens.push(accessToken);
            }

            if (emailArray.length === 1) {
                console.log(`Queueing invitation email to ${emailArray[0]} for organization ${organizationName}`);

                const jobId = await queueInviteMail({
                    recipientEmail: emailArray[0],
                    inviterName: inviterNameValue,
                    organizationName,
                    inviteToken: accessTokens[0],
                    customMessage: `You've been invited to join as a ${roleValue.toLowerCase()}.`
                }, {
                    priority: 2,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 3000 }
                });

                console.log(`Invitation email queued successfully for ${emailArray[0]} with job ID: ${jobId}`);

                callback({
                    success: true,
                    message: 'Invitation email queued successfully',
                    data: {
                        inviteToken: inviteTokens[0],
                        accessToken: accessTokens[0],
                        email: emailArray[0],
                        organizationId,
                        role: roleValue,
                        expiresAt: expiryDate,
                        jobId
                    }
                });
            } else {
                console.log(`Queueing bulk invitation emails to ${emailArray.length} recipients for organization ${organizationName}`);
                const bulkInviteData = inviteDataList.map((inviteData, index) => ({
                    recipientEmail: inviteData.recipientEmail,
                    inviteToken: inviteData.accessToken,
                    inviteTokenId: inviteTokens[index]
                }));

                const jobId = await queueMultipleInviteMail({
                    recipients: bulkInviteData,
                    inviterName: inviterNameValue,
                    organizationName,
                    role: roleValue,
                    customMessage: `You've been invited to join as a ${roleValue.toLowerCase()}.`
                }, {
                    priority: 2,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 3000 }
                });
                console.log(`Bulk invitation emails queued successfully for ${emailArray.length} recipients with job ID: ${jobId}`);
                callback({
                    success: true,
                    message: `Invitation emails queued successfully for ${emailArray.length} recipient(s)`,
                    data: {
                        inviteTokens,
                        accessTokens,
                        emails: emailArray,
                        organizationId,
                        role: roleValue,
                        expiresAt: expiryDate,
                        jobId,
                        count: emailArray.length
                    }
                });
            }

        } catch (error: any) {
            console.error('Error in invite_user handler:', error);
            if (typeof callback === 'function') {
                callback({
                    success: false,
                    error: 'Internal server error',
                    message: error.message
                });
            }
        }
    });
    socket.on("cancel_user_invite", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                if (typeof callback === 'function') callback({ success: false, error: 'User not authenticated' });
                return;
            }
            if (typeof callback !== 'function') {
                console.error('Callback is not a function for cancel_user_invite');
                return;
            }
            const email: string = data?.email;
            if (!email || typeof email !== 'string') {
                callback({ success: false, error: 'Missing required field: email' });
                return;
            }

            const lowered = email.trim().toLowerCase();
            const removed: Array<{ inviteToken: string; recipientEmail: string }> = [];

            for (const [token, invite] of pendingInvites.entries()) {
                try {
                    const recip = (invite && invite.recipientEmail) as string | undefined;
                    if (!recip) continue;
                    if (recip.trim().toLowerCase() === lowered) {
                        pendingInvites.delete(token);
                        removed.push({ inviteToken: token, recipientEmail: recip });
                    }
                } catch (ex) {
                    console.warn('Malformed pending invite entry for token', token, ex);
                }
            }

            if (removed.length === 0) {
                callback({ success: false, message: 'No pending invite found for this email' });
                return;
            }
            callback({ success: true, removedCount: removed.length, removed });
        } catch (error: any) {
            console.error('Error in cancel_user_invite handler:', error);
            if (typeof callback === 'function') callback({ success: false, error: error.message || 'Internal server error' });
        }
    });
    socket.on("get_notifications", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const userId = socket.data.user.userId;
            const databaseName = socket.data.user.databaseName;

            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            const databaseService = socket.data.user.dbService || globalDatabaseService;

            await databaseService.ensureDatabase(databaseName);
            await databaseService.ensureCollection(databaseName, CollectionNames.NOTIFICATIONS);

            const notificationsRepo = databaseService.getRepository(
                databaseName,
                CollectionNames.NOTIFICATIONS
            );

            const query: any = { userId };

            if (data?.status && Array.isArray(data.status)) {
                query.notificationStatus = { $in: data.status };
            } else if (data?.status) {
                query.notificationStatus = data.status;
            }

            const limit = data?.limit || 20;
            const skip = data?.page ? (data.page - 1) * limit : 0;

            const sort = data?.sort || { createdAt: -1 };

            const notifications = await notificationsRepo.find(query, {
                sort,
                limit,
                skip
            });

            const total = await notificationsRepo.count(query);

            callback({
                success: true,
                data: {
                    notifications,
                    pagination: {
                        total,
                        page: data?.page || 1,
                        limit,
                        pages: Math.ceil(total / limit)
                    }
                }
            });

        } catch (error: any) {
            console.error('Error in get_notifications handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });
    socket.on("mark_notification_read", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { notificationId } = data;
            if (!notificationId) {
                callback({
                    success: false,
                    error: 'Missing notificationId'
                });
                return;
            }

            const userId = socket.data.user.userId;
            const databaseName = socket.data.user.databaseName;

            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            const databaseService = socket.data.user.dbService || globalDatabaseService;

            const notificationsRepo = databaseService.getRepository(
                databaseName,
                CollectionNames.NOTIFICATIONS
            );

            const result = await notificationsRepo.updateOne(
                { notificationId, userId },
                { $set: { notificationStatus: 'read' } }
            );

            if (result.modifiedCount > 0) {
                callback({
                    success: true,
                    message: 'Notification marked as read'
                });
            } else {
                callback({
                    success: false,
                    error: 'Notification not found or already read'
                });
            }

        } catch (error: any) {
            console.error('Error in mark_notification_read handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });
    socket.on("mark_all_notifications_read", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const userId = socket.data.user.userId;
            const databaseName = socket.data.user.databaseName;

            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            // Get database service
            const databaseService = socket.data.user.dbService || globalDatabaseService;

            // Get notifications repository
            const notificationsRepo = databaseService.getRepository(
                databaseName,
                CollectionNames.NOTIFICATIONS
            );

            // Update all unread notifications
            const result = await notificationsRepo.update(
                {
                    userId,
                    notificationStatus: { $in: ['pending', 'sent'] }
                },
                { $set: { notificationStatus: 'read' } },
                { multi: true }
            );

            callback({
                success: true,
                message: 'All notifications marked as read',
                count: result.modifiedCount
            });

        } catch (error: any) {
            console.error('Error in mark_all_notifications_read handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("delete_notification", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const { notificationId } = data;
            if (!notificationId) {
                callback({
                    success: false,
                    error: 'Missing notificationId'
                });
                return;
            }
            const userId = socket.data.user.userId;
            const dbName = UserInfo.get(userId)?.dbName || socket.data.user.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const databaseService = socket.data.user.dbService || globalDatabaseService;
            await databaseService.ensureDatabase(dbName);
            await databaseService.ensureCollection(dbName, CollectionNames.NOTIFICATIONS);
            const notificationsRepo = databaseService.getRepository(
                dbName,
                CollectionNames.NOTIFICATIONS
            );
            const result = await notificationsRepo.deleteOne({ notificationId, userId });
            if (result.deletedCount > 0) {
                callback({
                    success: true,
                    message: 'Notification deleted successfully'
                });
            } else {
                callback({
                    success: false,
                    error: 'Notification not found'
                });
            }
        } catch (error: any) {
            console.error('Error in delete_notification handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("delete_all_notifications", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }
            const userId = socket.data.user.userId;
            const dbName = UserInfo.get(userId)?.dbName || socket.data.user.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const databaseService = socket.data.user.dbService || globalDatabaseService;
            await databaseService.ensureDatabase(dbName);
            await databaseService.ensureCollection(dbName, CollectionNames.NOTIFICATIONS);
            const notificationsRepo = databaseService.getRepository(
                dbName,
                CollectionNames.NOTIFICATIONS
            );
            const result = await notificationsRepo.deleteMany({ userId });
            if (result.deletedCount > 0) {
                callback({
                    success: true,
                    message: 'All notifications deleted successfully'
                });
            } else {
                callback({
                    success: false,
                    error: 'No notifications found'
                });
            }
        }
        catch (error: any) {
            console.error('Error in delete_all_notifications handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });


    //get pending invites for the user
    socket.on("get_pending_invites", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const userId = socket.data.user.userId;
            const userPendingInvites = Array.from(pendingInvites.values())
                .filter(invite =>
                    invite.status === 'pending' &&
                    invite.metadata &&
                    invite.metadata.invitedBy === userId
                );

            callback({
                success: true,
                pendingInvites: userPendingInvites.map(invite => ({
                    recipientEmail: invite.recipientEmail,
                    organizationId: invite.organizationId,
                    organizationName: invite.organizationName,
                    createdAt: invite.createdAt,
                    expiresAt: invite.expiresAt,
                    status: invite.status
                }))
            });

        } catch (error: any) {
            console.error('Error in get_pending_invites handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("check_organization_name", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { organizationName } = data;

            if (!organizationName || typeof organizationName !== 'string') {
                callback({
                    success: false,
                    error: 'Organization name is required and must be a string'
                });
                return;
            }

            const databaseService = await getDBService();
            const orgDbName = process.env.ORGANIZATION_DB;
            if (!orgDbName) {
                callback({
                    success: false,
                    error: 'ORGANIZATION_DB not configured'
                });
                return;
            }
            
            await databaseService.ensureDatabase(orgDbName);
            await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
            const organizationRepo = databaseService.getRepository<IOrganization>(
                orgDbName,
                CollectionNames.ORGANIZATIONS
            );

            const existingOrg = await organizationRepo.findOne({
                OrganizationName: { $regex: new RegExp(`^${organizationName}$`, 'i') }
            });

            if (existingOrg) {
                callback({
                    success: true,
                    isAvailable: false,
                    message: 'Organization name is already taken'
                });
                return;
            }

            // Also check if the sanitized database name already exists
            const sanitizedDbName = organizationName
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_{2,}/g, '_')
                .replace(/^_|_$/g, '');
            
            const dbExists = await databaseService.databaseExists(sanitizedDbName);
            if (dbExists) {
                callback({
                    success: false,
                    isAvailable: false,
                    message: 'Organization name is already taken (database exists)'
                });
                return;
            }

            callback({
                success: true,
                isAvailable: true,
                message: 'Organization name is available'
            });

        } catch (error: any) {
            console.error('Error in check_organization_name handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });


    socket.on("get_user_details", async (data: any, callback) => {
        try {
            //  console.log("getting user details for user id ===>", data.userId);
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const { userId } = data;
            const currUserId = socket.data.user.userId;
            const userInfo = UserInfo.get(currUserId);
            const dbName = userInfo?.dbName || socket.data.user.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const databaseService = socket.data.user.dbService || globalDatabaseService;
            await databaseService.ensureDatabase(dbName);
            await databaseService.ensureCollection(dbName, CollectionNames.USERS);
            const userRepository = databaseService.getRepository(dbName, CollectionNames.USERS);
            const user = await userRepository.findOne({ userId });
            if (!user) {
                callback({
                    success: false,
                    error: 'User not found'
                });
                return;
            }
            callback({
                success: true,
                user: user
            });
        }
        catch (error: any) {
            console.error('Error in get_user_details handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("update_user_org_permission_role", async (data: any, callback) => {
        try {
            const { userId, role } = data;
            console.log("updating user org permissions")
            if (!userId || !role) {
                callback({
                    success: false,
                    error: 'User ID and role are required'
                });
                return;
            }
            const currUserData = UserInfo.get(socket.data.user.userId);
            const dbName = UserInfo.get(socket.data.user.userId)?.dbName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const databaseService = socket.data.user.dbService || globalDatabaseService;
            await databaseService.ensureDatabase(dbName);
            await databaseService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
            await databaseService.ensureCollection(dbName, CollectionNames.USERS);
            const userRepository = databaseService.getRepository(dbName, CollectionNames.USERS);
            const userCredentialsRepository = databaseService.getRepository(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
            const user = await userRepository.findOne({ userId });

            if (!user) {
                callback({
                    success: false,
                    error: 'User not found'
                });
            }
            if (!isOrgOwner(socket.data.user.userId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to update user org permissions'
                });
                return;
            }
            await userRepository.updateOne(
                { userId },
                {
                    $set: {
                        [`permissionScopes.${currUserData?.organizationId || ''}`]:
                            role.toLowerCase() === "owner" ? "Owner" : "Member"
                    }
                }
            );
            const result = await userCredentialsRepository.updateOne({ userId }, { $set: { organizationRole: role } });
            if (result.modifiedCount === 0) {
                callback({
                    success: false,
                    error: 'Failed to update user org permissions'
                });
                return;
            }
            callback({
                success: true,
                message: 'User org permissions updated successfully'
            });
        }
        catch (error: any) {
            console.error('Error in update_user_org_permission_role handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }

    });

    socket.on("delete_user_from_org", async (data: any, callback) => {
        try {
            const { userId } = data;
            console.log("deleting user from org")
            console.log("userId", userId)
            if (!userId) {
                callback({
                    success: false,
                    error: 'User ID is required'
                });
                return;
            }

            const dbName = UserInfo.get(socket.data.user.userId)?.dbName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const databaseService = socket.data.user.dbService || globalDatabaseService;
            await databaseService.ensureDatabase(dbName);
            await databaseService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
            await databaseService.ensureCollection(dbName, CollectionNames.USERS);
            const userRepository = databaseService.getRepository(dbName, CollectionNames.USERS);
            const userCredentialsRepository = databaseService.getRepository(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
            const user = await userRepository.findOne({ userId });
            if (!user) {
                callback({
                    success: false,
                    error: 'User not found'
                });
                return;
            }
            if (!isOrgOwner(socket.data.user.userId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to delete users from org'
                });
                return;
            }
            const result = await userRepository.deleteOne({ userId });
            if (result.deletedCount === 0) {
                callback({
                    success: false,
                    error: 'Failed to delete user from org'
                });
                return;
            }
            //if user is removed frmo organization he will need to do his setup again
            const result2 = await userCredentialsRepository.updateOne({ userId }, { $set: { databaseName: null, setupComplete: false, organizationRole: null, githubOauth: false, invitedBy: null } });
            if (result2.modifiedCount === 0) {
                callback({
                    success: false,
                    error: 'Failed to update user credentials'
                });
                return;
            }

            callback({
                success: true,
                message: 'User deleted from org successfully'
            });
        }
        catch (error: any) {
            console.error('Error in delete_user_from_org handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("update_user_profile", async (data: IUser, callback) => {
        try {
            const { profile } = data;
            console.log("updating user profile")
            console.log("profile", profile)
            const currUserId = socket.data.user.userId;
            const userInfo = UserInfo.get(currUserId);
            const dbName = userInfo?.dbName || socket.data.user.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const databaseService = socket.data.user.dbService || globalDatabaseService;
            await databaseService.ensureDatabase(dbName);
            await databaseService.ensureCollection(dbName, CollectionNames.USERS);
            const userRepository = databaseService.getRepository(dbName, CollectionNames.USERS);
            const user = await userRepository.findOne({ userId: currUserId });
            if (!user) {
                callback({
                    success: false,
                    error: 'User not found'
                });
                return;
            }
            const result = await userRepository.updateOne({ userId: currUserId }, { $set: { ...profile } });
            if (result.modifiedCount === 0) {
                callback({
                    success: false,
                    error: 'Failed to update user profile'
                });
                return;
            }
            callback({
                success: true,
                message: 'User profile updated successfully'
            });
        }
        catch (error: any) {
            console.error('Error in update_user_profile handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });
}
