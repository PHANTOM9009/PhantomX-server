import { Server, Socket } from 'socket.io';
import { getDBService } from '../DataAccessLayer/db-connection';
import { IUser } from '../DataAccessLayer/models/User';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { UserInfo } from '../DataStructures';
import { initializeOrganizationDatabase } from '../Services/AuthTokenService';
import { DatabaseService } from '../DataAccessLayer';

export async function org_details_handler(io: Server, socket: Socket) {
    //helper function
    const checkOrgOwner = (userId: string) => {
        const userInfo = UserInfo.get(userId);
        if(userInfo?.permissionScopes && userInfo.permissionScopes[userInfo.organizationId].toLowerCase() === 'owner') {
            return true;
        }
        return false;
    }



    socket.on('get_organization_members', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            let databaseName = socket.data.user.databaseName;
            
            if (!databaseName) {
                const tempDbService = await getDBService();
                await tempDbService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
                
                const userCredentialHandler = tempDbService.getRepository<IUserCredentials>(
                    process.env.USER_CREDENTIAL_DB,
                    process.env.USER_CREDENTIAL_COLLECTION
                );
                
                const userCredentials = await userCredentialHandler.findOne({ userId: socket.data.user.userId });
                
                if (!userCredentials) {
                    callback({
                        success: false,
                        error: 'User database not found'
                    });
                    return;
                }
                
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
            
            const databaseService:DatabaseService = socket.data.user.dbService || await getDBService();
            
            await databaseService.ensureDatabase(databaseName);
            await databaseService.ensureCollection(databaseName, CollectionNames.USERS);
            
            const userRepository = databaseService.getRepository<IUser>(databaseName, CollectionNames.USERS);
            
            const users = await userRepository.find({});
            
            const organizationMembers = users.map(user => ({
                userId: user.userId,
                userName: user.userName || '',
                email: user.email || '',
                name: user.name || '',
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                active: user.active,
                createdAt: user.createdAt,
                permissionScopes: user.permissionScopes,
                metadata: user.metadata
            }));
            
            callback({
                success: true,
                data: {
                    members: organizationMembers,
                    totalCount: organizationMembers.length,
                    organizationName: socket.data.user.organizationName || users[0]?.organizationName
                }
            });
            
        } catch (error: any) {
            console.error('Error in get_organization_members handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("get_organization_data", async (data: any, callback) => {
        try {
            const userId = socket.data.user.userId;
            if (!userId) {
                callback({
                    success: false,
                    error: 'User ID not found'
                });
                return;
            }
            
            const userInfo = UserInfo.get(userId);
            
            if (!userInfo || !userInfo.organizationName) {
                callback({
                    success: false,
                    error: 'User or organization name not found in memory'
                });
                return;
            }
            
            const { organizationHandler } = await initializeOrganizationDatabase();
            const organization = await organizationHandler.findOne({ OrganizationName: userInfo.organizationName });
            
            if (!organization) {
                callback({
                    success: false,
                    error: 'Organization not found'
                });
                return;
            }
            
            callback({
                success: true,
                data: organization
            });
            
        } catch (error: any) {
            console.error('Error in get_organization_data handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("update_organization_data", async (data: any, callback) => {
        try {
            const userId = socket.data.user.userId;
            if (!userId) {
                callback({
                    success: false,
                    error: 'User ID not found'
                });
                return;
            }
            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationName) {
                callback({
                    success: false,
                    error: 'User or organization name not found in memory'
                });
                return;
            }
            const { organizationHandler } = await initializeOrganizationDatabase();
            const organization = await organizationHandler.findOne({ OrganizationName: userInfo.organizationName });
            if (!organization) {
                callback({
                    success: false,
                    error: 'Organization not found'
                });
                return;
            }
            if(!checkOrgOwner(userId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to update organization data'
                });
                return;
            }
            //here user can only update the metadata of the organization
            const { metadata } = data;
            if(!metadata) {
                callback({
                    success: false,
                    error: 'Metadata not found'
                });
                return;
            }
            const result = await organizationHandler.updateOne({ OrganizationName: userInfo.organizationName }, { $set: { metadata } });
            if(result.modifiedCount === 0) {
                callback({
                    success: false,
                    error: 'Failed to update organization data'
                });
                return;
            }
            callback({
                success: true,
                message: 'Organization data updated successfully'
            });
        } catch (error: any) {
            console.error('Error in update_organization_data handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("is_free_trial_used", async (data: any, callback) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const userInfo = UserInfo.get(userId);
            
            if (!userInfo || !userInfo.organizationName) {
                callback({
                    success: false,
                    error: 'User or organization name not found in memory'
                });
                return;
            }

            const { organizationHandler } = await initializeOrganizationDatabase();
            const organization = await organizationHandler.findOne({ OrganizationName: userInfo.organizationName });
            
            if (!organization) {
                callback({
                    success: false,
                    error: 'Organization not found'
                });
                return;
            }

            const isTrialUsed = organization.metadata?.hasOwnProperty('paypal') || organization.metadata?.hasOwnProperty('razorpay') || false;
            let alreadyHadSubscription = organization.metadata?.hasOwnProperty('paypal') && organization.metadata?.paypal?.subscriptionId !== null && organization.metadata?.paypal?.subscriptionId !== undefined;
            alreadyHadSubscription = alreadyHadSubscription || (organization.metadata?.hasOwnProperty('razorpay') && organization.metadata?.razorpay?.subscriptionId !== null && organization.metadata?.razorpay?.subscriptionId !== undefined);
            callback({
                success: true,
                data: {
                    isTrialUsed: isTrialUsed,
                    alreadyHadSubscription: alreadyHadSubscription
                }
            });
            
        } catch (error: any) {
            console.error('Error in is_free_trial_used handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

}
