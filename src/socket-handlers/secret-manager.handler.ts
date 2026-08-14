import { Server, Socket } from 'socket.io';
import { SecretManager } from '../Services/SecretManager';
import { UserInfo } from '../DataStructures';
import * as dotenv from 'dotenv';
dotenv.config();
export async function secret_manager_handler(io: Server, socket: Socket) {
    
    socket.on('create_secret', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { key, secretData, permissionScopes } = data;
            if (!key || !secretData) {
                callback({
                    success: false,
                    error: 'Missing required fields: key and secretData are required'
                });
                return;
            }

            const databaseName = socket.data.user.databaseName;
            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName, encryptionKey);

            const result = await secretManager.createSecret(key, secretData, permissionScopes || {}, socket.data.user.userId);

            if (result?.success) {
                io.emit('secret_created', { key });
            }

            callback(result);

        } catch (error: any) {
            console.error('Error in create_secret handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on('get_secrets', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            // now we will fetch the permission scopes of the current user
            let userData = UserInfo.get(socket.data.user.userId);
            let permissionScopesIds = Object.keys(userData?.permissionScopes as any) ; 
            permissionScopesIds.push(userData?.userId as string);
            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(userData?.dbName as any, encryptionKey);

            const result = await secretManager.getAllSecrets(permissionScopesIds, socket.data.user.userId);
            callback(result);

        } catch (error: any) {
            console.error('Error in get_secret handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on('update_secret', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { key, secretData } = data;

            if (!key || !secretData) {
                callback({
                    success: false,
                    error: 'Missing required fields: key and secretData are required'
                });
                return;
            }

            let databaseName = UserInfo.get(socket.data.user.userId)?.dbName;

            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName as any, encryptionKey);

            const result = await secretManager.updateSecret(key, secretData);

            if (result?.success) {
                io.emit('secret_updated', { key });
            }

            callback(result);

        } catch (error: any) {
            console.error('Error in update_secret handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on('delete_secret', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { key } = data;

            if (!key) {
                callback({
                    success: false,
                    error: 'Missing required field: key is required'
                });
                return;
            }

         let databaseName = UserInfo.get(socket.data.user.userId)?.dbName;

            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName as any, encryptionKey);

            const result = await secretManager.deleteSecret(key);

            if (result?.success) {
                io.emit('secret_deleted', { key });
            }

            callback(result);

        } catch (error: any) {
            console.error('Error in delete_secret handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on('list_secrets', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const databaseName = socket.data.user.databaseName;
            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName, encryptionKey);

            const result = await secretManager.listSecrets();

            callback(result);

        } catch (error: any) {
            console.error('Error in list_secrets handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on('upsert_secret', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { key, secretData, permissionScopes } = data;

            if (!key || !secretData) {
                callback({
                    success: false,
                    error: 'Missing required fields: key and secretData are required'
                });
                return;
            }

          let databaseName = UserInfo.get(socket.data.user.userId)?.dbName;

            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName as any, encryptionKey);

            const result = await secretManager.upsertSecret(key, secretData, permissionScopes || {});

            callback(result);

        } catch (error: any) {
            console.error('Error in upsert_secret handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on('secret_exists', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { key } = data;

            if (!key) {
                callback({
                    success: false,
                    error: 'Missing required field: key is required'
                });
                return;
            }

          let databaseName = UserInfo.get(socket.data.user.userId)?.dbName;

            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName as any, encryptionKey);

            const exists = await secretManager.secretExists(key);

            callback({
                success: true,
                exists
            });

        } catch (error: any) {
            console.error('Error in secret_exists handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });



    socket.on('update_secret_permissions', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { key, permissionScopes } = data;

            if (!key || !permissionScopes) {
                callback({
                    success: false,
                    error: 'Missing required fields: key and permissionScopes are required'
                });
                return;
            }

            // Check if permissionScopes is a valid object
            if (typeof permissionScopes !== 'object' || permissionScopes === null || Array.isArray(permissionScopes)) {
                callback({
                    success: false,
                    error: 'permissionScopes must be an object with permission scope IDs as keys'
                });
                return;
            }

            // Get the database name from UserInfo
            let databaseName = UserInfo.get(socket.data.user.userId)?.dbName;
            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            // Create a SecretManager instance
            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName, encryptionKey);

            // Call the updateSecretPermissions method
            const result = await secretManager.updateSecretPermissions(key, permissionScopes);

            callback(result);

        } catch (error: any) {
            console.error('Error in update_secret_permissions handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    socket.on("get_secret_by_key", async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const { key } = data;
            if (!key) {
                callback({
                    success: false,
                    error: 'Missing required field: key is required'
                });
                return;
            }
            const databaseName = socket.data.user.databaseName;
            if (!databaseName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
            const secretManager = new SecretManager(databaseName, encryptionKey);
            const result = await secretManager.getSecret(key);
            callback(result);
        } catch (error: any) {
            console.error('Error in get_secret_by_key handler:', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });
}
