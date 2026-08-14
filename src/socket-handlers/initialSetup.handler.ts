import { Server, Socket } from "socket.io";
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { IUser } from '../DataAccessLayer/models/User';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { ObjectId } from 'mongodb';
import { IUserCredentials } from "../DataAccessLayer/models/UserCredentials";
import { initializeOrganizationDatabase } from "../Services/AuthTokenService";
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';
import { sendNotification } from "../Services/NotificationService";

dotenv.config();



/**
 * Sanitizes organization name to create a valid database name
 */
function sanitizeDbName(orgName: string): string {
    return orgName
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '');
}

export async function initialSetup_handler(io: Server, socket: Socket, connectedClients: any) {
    console.log("Initial setup handler");
    
    socket.on('setup_complete', async (data: any) => {
        console.log("Profile setup handler");
        console.log("Data is==>", data);

        try {
            const setupType = data.type !== undefined ? data.type : 0;
            if (setupType === 1) {
                console.log("Profile-only update");
                
                if (!data.profile) {
                    socket.emit('setup_response', {
                        success: false,
                        error: 'Missing required field: profile'
                    });
                    return;
                }
                
                const { profile } = data;
                
                if (!socket.data.user || !socket.data.user.userId) {
                    socket.emit('setup_response', {
                        success: false,
                        error: 'User not authenticated'
                    });
                    return;
                }
                
                const dbService = DatabaseService.getInstance();
                
                if (!dbService.isConnected()) {
                    await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
                }
                
                // Get user's database name from credentials
                await dbService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
                await dbService.ensureCollection(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
                
                const userCredentialRepository = dbService.getRepository<IUserCredentials>(
                    process.env.USER_CREDENTIAL_DB,
                    process.env.USER_CREDENTIAL_COLLECTION
                );
                
                const userCredentials = await userCredentialRepository.findOne({ userId: socket.data.user.userId });
                
                if (!userCredentials || !userCredentials.databaseName) {
                    socket.emit('setup_response', {
                        success: false,
                        error: 'User database not found'
                    });
                    return;
                }
                
                const dbName = userCredentials.databaseName;
                
                // Connect to user's database and update profile
                await dbService.ensureDatabase(dbName);
                await dbService.ensureCollection(dbName, CollectionNames.USERS);
                
                const userRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
                
                // Query the main organization database to find the organization with matching dbName
                const {organizationHandler} = await initializeOrganizationDatabase();
                
                // Find the organization that matches this dbName
                const organization = await organizationHandler.findOne({ dbName: dbName });
                const orgId = organization?.OrganizationId;
            
                // Find the user
                const existingUser = await userRepository.findOne({ userId: socket.data.user.userId });
                
                if (!existingUser) {
                    socket.emit('setup_response', {
                        success: false,
                        error: 'User not found in organization database'
                    });
                    return;
                }                

                const updateResult = await userRepository.updateOne(
                    { userId: socket.data.user.userId },
                    { 
                        $set: { 
                            userName: profile.userName || profile.username,
                            userId: socket.data.user.userId,
                            firstName: profile.firstName,
                            lastName: profile.lastName,
                            updatedAt: new Date(),
                            permissionScopes: {
                                [orgId as string]: userCredentials.organizationRole || 'Member'
                            },
                            metadata: {
                                ...existingUser.metadata,
                                phone: profile.phone,
                                jobTitle: profile.jobTitle,
                                company: profile.company,
                                department: profile.department,
                                role: profile.role,
                                avatar: profile.avatar,
                                bio: profile.bio,
                                githubConnected: profile.githubConnected,
                                slackConnected: profile.slackConnected,
                                jiraConnected: profile.jiraConnected,
                                pushNotifications: false,
                                emailNotifications: false,
                                teamsNotification: false,
                                defaultLanguage: 'en',
                                timezone: 'UTC'
                            }
                        } 
                    }
                );
                
                if (!updateResult) {
                    socket.emit('setup_response', {
                        success: false,
                        error: 'Failed to update user profile'
                    });
                    return;
                }
                
                // Set setupComplete to true and sync real email + chosen username
                // (critical for name-auth users whose credentials had a placeholder email)
                const chosenEmail    = profile.email    || '';
                const chosenUsername = profile.username || profile.userName || '';
                const credUpdate: any = { setupComplete: true };
                if (chosenEmail)    credUpdate.email    = chosenEmail;
                if (chosenUsername) credUpdate.userName = chosenUsername;
                await userCredentialRepository.updateOne(
                    { userId: socket.data.user.userId },
                    { $set: credUpdate }
                );

                if (organization && !organization.metadata?.creatorGeoIP && userCredentials?.metadata?.geoIP) {
                    try {
                        const creatorCountryCode = userCredentials.metadata.geoIP.countryCode;
                        const creatorCountryName = userCredentials.metadata.geoIP.countryName;
                        
                        if (creatorCountryCode || creatorCountryName) {
                            await organizationHandler.updateOne(
                                { OrganizationId: organization.OrganizationId },
                                {
                                    $set: {
                                        'metadata.creatorGeoIP': {
                                            countryCode: creatorCountryCode,
                                            countryName: creatorCountryName,
                                            recordedAt: new Date()
                                        }
                                    }
                                }
                            );
                            console.log(`Updated organization ${organization.OrganizationId} with creator country: ${creatorCountryCode} (${creatorCountryName})`);
                        }
                    } catch (orgUpdateError) {
                        console.error('Error updating organization with creator country:', orgUpdateError);
                    }
                }
                
                const inviterId = userCredentials.invitedBy;
                if(inviterId)
                {
                    await sendNotification(inviterId, {
                        message: `${profile.firstName} ${profile.lastName} has accepted the invitation`,
                        userId: socket.data.user.userId
                    });
                }
                socket.emit('setup_response', {
                    success: true,
                    message: 'User profile updated successfully',
                    data: {
                        userId: socket.data.user.userId
                    }
                });
                
                return;
            }
            
            //full organization setup (original logic)
            if (!data.profile || !data.organization) {
                socket.emit('setup_response', {
                    success: false,
                    error: 'Missing required fields: profile, organization'
                });
                return;
            }

            const { profile, organization, billing } = data;

            if (!organization.organizationName) {
                socket.emit('setup_response', {
                    success: false,
                    error: 'Organization name is required'
                });
                return;
            }

            const dbService = DatabaseService.getInstance();
            
            if (!dbService.isConnected()) {
                await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV);
            }
            
            const dbName = sanitizeDbName(organization.organizationName);

            const dbExists = await dbService.databaseExists(dbName);
            if (dbExists) {
                socket.emit('setup_response', {
                    success: false,
                    error: 'Organization already exists'
                });
                return;
            }

            console.log(`Creating database: ${dbName}`);
            await dbService.ensureDatabase(dbName);
            socket.data.user.databaseName = dbName;

            console.log(`Creating organization: ${organization.organizationName}`);
            const {organizationHandler} = await initializeOrganizationDatabase();
            const orgId = uuidv4();
            
            let creatorCountryCode: string | undefined;
            let creatorCountryName: string | undefined;
            try {
                await dbService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
                await dbService.ensureCollection(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
                const userCredRepository = dbService.getRepository<IUserCredentials>(
                    process.env.USER_CREDENTIAL_DB,
                    process.env.USER_CREDENTIAL_COLLECTION
                );
                const creatorCredentials = await userCredRepository.findOne({ userId: socket.data.user.userId });
                if (creatorCredentials?.metadata?.geoIP) {
                    creatorCountryCode = creatorCredentials.metadata.geoIP.countryCode;
                    creatorCountryName = creatorCredentials.metadata.geoIP.countryName;
                    console.log(`Organization creator is from: ${creatorCountryCode} (${creatorCountryName})`);
                }
            } catch (geoError) {
                console.error('Error fetching creator country information:', geoError);
            }
            
            // Build base metadata
            const baseMetadata: any = {
                organizationType: organization.organizationType,
                industry: organization.industry,
                companySize: organization.companySize,
                website: organization.website,
                description: organization.description,
                address: organization.address,
                city: organization.city,
                state: organization.state,
                zipCode: organization.zipCode,
                country: organization.country,
                phone: organization.phone,
                email: organization.email,
                foundedYear: organization.foundedYear,
                isPublic: organization.isPublic,
                logo: organization.logo,
                // Store creator's country information for organization-level features
                creatorGeoIP: (creatorCountryCode || creatorCountryName) ? {
                    countryCode: creatorCountryCode,
                    countryName: creatorCountryName,
                    recordedAt: new Date()
                } : undefined
            };
            const organizationData: Omit<IOrganization, '_id'> = {
                OrganizationId: orgId,
                OrganizationName: organization.organizationName,
                dbName: dbName,
                CreatedBy: socket.data.user.userId,
                CreatedOn: new Date(),
                Tier: ['one'], 
                Active: true,
                metadata: baseMetadata
            };

            const orgResult = await organizationHandler.insertOne(organizationData as IOrganization);
            console.log('Organization created:', orgResult);
            if(!orgResult.insertedId)
            {
                socket.emit('setup_response', {
                    success: false,
                    error: 'Failed to create organization'
                });
                return;
            }

            socket.data.user.organizationId = orgId;
            console.log(`Creating collection: ${CollectionNames.USERS}`);
            await dbService.ensureCollection(dbName, CollectionNames.USERS);
            const userData: Omit<IUser, '_id'> = {
                userName: profile.username,
                userId: socket.data.user.userId,
                firstName: profile.firstName,
                lastName: profile.lastName,
                email: profile.email,
                organizationName: organization.organizationName,
                organizationId: orgId,
                createdAt: new Date(),
                updatedAt: new Date(),
                active: true,
                permissionScopes: {
                    [orgId]: "Owner",
                },
                metadata: {
                    email: profile.email,
                    phone: profile.phone,
                    jobTitle: profile.jobTitle,
                    company: profile.company,
                    department: profile.department,
                    role: profile.role,
                    avatar: profile.avatar,
                    bio: profile.bio,
                    githubConnected: profile.githubConnected,
                    slackConnected: profile.slackConnected,
                    jiraConnected: profile.jiraConnected,
                    pushNotifications: false,
                    emailNotifications: false,
                    teamsNotification: false,
                    defaultLanguage: 'en',
                    timezone: 'UTC'
                }
            };


            const userRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            const userResult = await userRepository.insertOne(userData as any);
            console.log('User created:', userResult);

            if (socket.data.user && socket.data.user.userId) {
                try {
                    await dbService.ensureDatabase(process.env.USER_CREDENTIAL_DB);
                    await dbService.ensureCollection(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
                    
                    const mainUserCredentialRepository = dbService.getRepository<IUserCredentials>(
                        process.env.USER_CREDENTIAL_DB, 
                        process.env.USER_CREDENTIAL_COLLECTION
                    );
                    
                    // Also sync email and chosen username back to UserCredentials
                    // (critical for name-auth users whose credentials had a placeholder email)
                    const chosenEmail    = profile.email    || '';
                    const chosenUsername = profile.username || profile.userName || '';
                    const credUpdate: any = { databaseName: dbName, setupComplete: true };
                    if (chosenEmail)    credUpdate.email    = chosenEmail;
                    if (chosenUsername) credUpdate.userName = chosenUsername;
                    await mainUserCredentialRepository.updateOne(
                        { userId: socket.data.user.userId },
                        { $set: credUpdate }
                    );
                    
                    console.log(`Updated user credentials with database name: ${dbName} for user: ${socket.data.user.userId}`);
                    socket.data.user.databaseName = dbName;
                } catch (updateError) {
                    console.error('Error updating user credentials with database name:', updateError);
                }
            }
            
            socket.emit('setup_response', {
                success: true,
                message: 'Organization and user setup completed successfully',
                data: {
                    databaseName: dbName,
                    organizationId: orgResult.insertedId,
                    userId: userResult.insertedId
                }
            });

        } catch (error) {
            console.error('Error in setup_complete handler:', error);
            socket.emit('setup_response', {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            });
        }
    });
    //

    socket.on("email_verified", async (data: any, callback: Function) => {
        

    });

    socket.on("invite_accepted", async (data: any, callback: Function) => {
      
    });

}