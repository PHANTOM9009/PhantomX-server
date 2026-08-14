import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { IRepository } from '../DataAccessLayer/Repository';
import { Document, ObjectId } from 'mongodb';
import * as crypto from 'crypto';
import{SecretDocument} from './../DataAccessLayer/models/SecretDocument'
import * as dotenv from 'dotenv';
import { CollectionNames } from '../DataAccessLayer/models';
import { Collection } from 'chromadb';
import { Socket } from 'socket.io';
import { Logger } from '../utils/Logger';
dotenv.config();

export class SecretManager {
    private dbService: DatabaseService;
    private logger: Logger;
    private dbName: string;
    private collectionName: string;
    private encryptionKey: Buffer;
    private algorithm: string = 'aes-256-gcm';

    constructor(dbName:string,encryptionKey?: string) {
        this.logger = new Logger('SecretManager');
        this.dbService = DatabaseService.getInstance();
        this.dbName = dbName ;
        this.collectionName = CollectionNames.SECRETS;
        
        // Prioritize SECRET_ENCRYPTION_KEY for consistency with socket handlers
        const key = encryptionKey || process.env.SECRET_ENCRYPTION_KEY || process.env.WEBHOOK_SECRET;
        if (!key) {
            throw new Error('Encryption key must be provided either as parameter, SECRET_ENCRYPTION_KEY, or WEBHOOK_SECRET environment variable');
        }
        
        this.logger.info('SecretManager initialized', { 
            dbName, 
            keySource: encryptionKey ? 'parameter' : (process.env.SECRET_ENCRYPTION_KEY ? 'SECRET_ENCRYPTION_KEY' : 'WEBHOOK_SECRET')
        });
        
        this.encryptionKey = crypto.createHash('sha256').update(key).digest();
       
    }

    private encrypt(data: string): { encryptedData: string; iv: string; authTag: string } {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv) as crypto.CipherGCM;
        
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return {
            encryptedData: encrypted,
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex')
        };
    }

    private decrypt(encryptedData: string, iv: string, authTag: string): string {
        try {
            const decipher = crypto.createDecipheriv(
                this.algorithm,
                this.encryptionKey,
                Buffer.from(iv, 'hex')
            ) as crypto.DecipherGCM;
            
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));
            
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            return decrypted;
        } catch (error) {
            // Enhanced error message to help diagnose the issue
            if (error instanceof Error) {
                if (error.message.includes('Unsupported state or unable to authenticate data')) {
                    throw new Error(
                        'Decryption failed: The encryption key used to decrypt does not match the key used to encrypt. ' +
                        'This usually happens when the SECRET_ENCRYPTION_KEY or WEBHOOK_SECRET environment variable has changed. ' +
                        'Original error: ' + error.message
                    );
                }
                throw new Error(`Decryption failed: ${error.message}`);
            }
            throw error;
        }
    }

    async createSecret(key: string, secretJson: any,permissionScopes:Record<string,any>, userId: string): Promise<{ success: boolean; id?: ObjectId; error?: string }> {
        try {
            
                await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);

            const exists = await this.secretExists(key);
            if (exists) {
                return { success: false, error: `Secret with key '${key}' already exists` };
            }

            const jsonString = JSON.stringify(secretJson);
            const { encryptedData, iv, authTag } = this.encrypt(jsonString);
            
            const secretDoc: Partial<SecretDocument> = {
                key,
                encryptedData,
                iv,
                authTag,
                createdAt: new Date(),
                updatedAt: new Date(),
                permissionScopes:permissionScopes,
                createdBy: userId
            };

            const result = await repository.insertOne(secretDoc as any);
            
            return { success: true, id: result.insertedId };
        } catch (error) {
            this.logger.error('Error creating secret', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }

    async getAllSecrets(permissionScopeIds: string[], userId: string): Promise<{ success: boolean; secrets?: Array<any>; error?: string }> {
        try {
            // Build query to filter by permissionScopes
            // Assuming permissionScopes is an object with ids as keys or an array containing the ids
            const filter: any = {};
            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);
            // Check if any of the permissionScopeIds exist in permissionScopes field
            // This uses MongoDB's dot notation to search within the permissionScopes object
            if (permissionScopeIds && permissionScopeIds.length > 0) {
                // Build OR conditions for each permissionScopeId
                filter.$or = permissionScopeIds.map(id => ({
                    [`permissionScopes.${id}`]: { $exists: true }
                }));
            }
            const secretDocsByGroups = await repository.find(filter);
            const secretsCreatedByUser = await repository.find({ createdBy: userId });
            const combined = [...secretDocsByGroups, ...secretsCreatedByUser];
            const secretDocs = Array.from(
              new Map(combined.map(item => [item._id.toString(), item])).values()
            );

            if (!secretDocs || secretDocs.length === 0) {
                return { success: false, error: 'No secrets found with matching permissionScopeIds' };
            }

            // Decrypt all secrets and build result array with complete document info
            const secrets = [];
            for (const doc of secretDocs) {
                try {
                    const decryptedString = this.decrypt(
                        doc.encryptedData,
                        doc.iv,
                        doc.authTag
                    );
                    const decryptedData = JSON.parse(decryptedString);
                    
                    const filteredPermissionScopes: Record<string, string> = doc.permissionScopes;
                    //not using filtered permissions as then in the users we are missing the permissions of other users

                    // if (doc.permissionScopes && permissionScopeIds.length > 0) {
                    //    Object.keys(doc.permissionScopes).forEach((key: string) => {
                    //     if (permissionScopeIds.includes(key)) {
                    //         filteredPermissionScopes[key] = doc.permissionScopes[key];
                    //     }
                    //    });
                    // }
                    
                    secrets.push({
                        _id: doc._id,
                        key: doc.key,
                        data: decryptedData,
                        permissionScopes: filteredPermissionScopes,
                        createdAt: doc.createdAt,
                        createdBy: doc.createdBy,
                        updatedAt: doc.updatedAt
                    });
                } catch (decryptError) {
                    this.logger.error(`Error decrypting secret with key '${doc.key}'`, decryptError);
                }
            }
            
            return { success: true, secrets };
        } catch (error) {
            this.logger.error('Error getting secrets', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }

    async updateSecret(key: string, secretJson: any): Promise<{ success: boolean; error?: string }> {
        try {

            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);
            const exists = await this.secretExists(key);
            if (!exists) {
                return { success: false, error: `Secret with key '${key}' not found` };
            }

            const jsonString = JSON.stringify(secretJson);
            const { encryptedData, iv, authTag } = this.encrypt(jsonString);

            const result = await repository.updateOne(
                { key } as any,
                {
                    $set: {
                        encryptedData,
                        iv,
                        authTag,
                        updatedAt: new Date()
                    }
                } as any
            );

            if (result.modifiedCount === 0) {
                return { success: false, error: 'Secret not updated' };
            }

            return { success: true };
        } catch (error) {
            this.logger.error('Error updating secret', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }
    async updateSecretPermissions(key:string,permissionScopes:Record<string,any>)
    {
        try{
            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);
            const exists = await this.secretExists(key);
            if (!exists) {
                return { success: false, error: `Secret with key '${key}' not found` };
            }
            const result = await repository.updateOne({key} as any,
                {
                    $set:{
                        permissionScopes:permissionScopes,
                        updatedAt: new Date()
                    }
                }
            );
            if(result.modifiedCount===0)
            {
                return { success: false, error: 'Secret permissions not updated' };
            }

            return { success: true };
        }
        catch(ex)
        {
            this.logger.error('Error updating secret permissions', ex);
            return { 
                success: false, 
                error: ex instanceof Error ? ex.message : 'Unknown error occurred' 
            };
        }
    }

    async deleteSecret(key: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);
            const result = await repository.deleteOne({ key } as any);
            
            if (result.deletedCount === 0) {
                return { success: false, error: `Secret with key '${key}' not found` };
            }

            return { success: true };
        } catch (error) {
            this.logger.error('Error deleting secret', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }

    async listSecrets(): Promise<{ success: boolean; keys?: string[]; error?: string }> {
        try {
            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);

            const secrets = await repository.find({});
            const keys = secrets.map(secret => secret.key);
            
            return { success: true, keys };
        } catch (error) {
            this.logger.error('Error listing secrets', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }

    async secretExists(key: string): Promise<boolean> {
        try {
            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);
            return await repository.exists({ key } as any);
        } catch (error) {
            this.logger.error('Error checking secret existence', error);
            return false;
        }
    }

    async getSecret(key:string) {
        try {
            await this.dbService.ensureDatabase(this.dbName);
                await this.dbService.ensureCollection(this.dbName,CollectionNames.SECRETS);
             let repository = this.dbService.getRepository<SecretDocument>(this.dbName, this.collectionName);
            const secretDoc:any = await repository.findOne({key:key}as any);
            let secretData = {};
                try {
                    const decryptedString = this.decrypt(secretDoc.encryptedData, secretDoc.iv, secretDoc.authTag);
                    const jsonData = JSON.parse(decryptedString);

                     secretData = {
                        key: secretDoc.key,
                        data: jsonData,
                        permissionScopes: secretDoc.permissionScopes,
                        createdAt: secretDoc.createdAt,
                        updatedAt: secretDoc.updatedAt
                    }
                    return { success: true,  secrets: secretData };
                    
                } catch (decryptError) {
                    this.logger.error(`Error decrypting secret with key '${secretDoc.key}'`, decryptError);
                    return { 
                        success: false, 
                        error: decryptError instanceof Error ? decryptError.message : 'Decryption failed' 
                    };
                }
            }

            
         catch (error) {
            console.error('Error getting all secrets:', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }

    async upsertSecret(key: string, secretJson: any,permissionScopes:Record<string,any>, userId?: string): Promise<{ success: boolean; id?: ObjectId; error?: string }> {
        try {
            const exists = await this.secretExists(key);
            
            if (exists) {
                const updateResult = await this.updateSecret(key, secretJson);
                return { success: updateResult.success, error: updateResult.error };
            } else {
                return await this.createSecret(key, secretJson,permissionScopes, userId || "");
            }
        } catch (error) {
            console.error('Error upserting secret:', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error occurred' 
            };
        }
    }
}
