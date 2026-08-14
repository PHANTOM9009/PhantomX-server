import * as ds from './../DataStructures';
import { S3Service } from './S3Service';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import * as dotenv from 'dotenv';
import { CollectionNames, IUser } from '../DataAccessLayer/models';
import { IKnowledgeBase, IKnowledgeBaseFile } from '../DataAccessLayer/models/knowledgeBase';
import { v4 as uuid4 } from 'uuid';
import * as crypto from 'crypto';
import * as path from 'path';
dotenv.config();

export class KnowledgeBaseService {
    static logger = new Logger('KnowledgeBaseService');

    /** IUser.dbName is optional; Mongo helpers require a concrete database name. */
    private static requireDbName(userData: IUser): string | null {
        const d = userData.dbName?.trim();
        return d ? d : null;
    }

    /**
     * Create a new knowledge base
     */
    static async createKnowledgeBase(
        userId: string,
        name: string,
        description: string,
        permissionScopes: Record<string, any>,
        metadata: {
            ownerType: 'user' | 'team' | 'organization';
            ownerId: string;
            tags?: string[];
        }
    ) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                this.logger.error('userData not found for creating knowledge base');
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                this.logger.error('userData missing dbName for creating knowledge base');
                return { success: false, error: 'user database not configured' };
            }

            const kbId = uuid4();
            const dbService = await getDBService();
            await dbService.ensureCollection(dbName, CollectionNames.KNOWLEDGE_BASES);
            await dbService.ensureCollection(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);

            let kbHandler = dbService.getRepository<IKnowledgeBase>(dbName, CollectionNames.KNOWLEDGE_BASES);

            const now = new Date();
            const kbData: Partial<IKnowledgeBase> = {
                kbId: kbId,
                name: name,
                description: description,
                ownerType: metadata.ownerType,
                ownerId: metadata.ownerId,
                createdBy: userId,
                permissionScopes: permissionScopes,
                createdAt: now,
                updatedAt: now,
                status: 'active',
                fileCount: 0,
                folderCount: 0,
                totalSizeBytes: 0,
                tags: metadata.tags || []
            };

            const result = await kbHandler.insertOne(kbData as any);
            if (result.acknowledged) {
                this.logger.success('knowledge base created successfully');
                return { success: true, kbId: kbId };
            } else {
                this.logger.error('failed to create knowledge base in mongodb');
                return { success: false, error: 'Database insert failed' };
            }
        } catch (ex) {
            this.logger.error('error while creating knowledge base', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Upload a file to a knowledge base
     */
    static async uploadFile(
        userId: string,
        kbId: string,
        fileBuffer: Buffer,
        fileName: string,
        relativePath: string,
        mimeType: string
    ) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            // Calculate file hash
            const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            const fileId = uuid4();
            const sizeBytes = fileBuffer.length;

            // Upload to S3
            const s3Key = `${userData.organizationName}/kb/${kbId}/${relativePath}`;
            const s3Service = new S3Service(process.env.KB_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            const uploadResult = await s3Service.uploadFile(s3Key, fileBuffer, undefined, mimeType);

            if (!uploadResult.success) {
                this.logger.error('failed to upload file to s3');
                return { success: false, error: 'S3 upload failed' };
            }

            // Save metadata to MongoDB
            const dbService = await getDBService();
            const fileHandler = dbService.getRepository<IKnowledgeBaseFile>(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);

            const now = new Date();
            const fileData: Partial<IKnowledgeBaseFile> = {
                kbId: kbId,
                fileId: fileId,
                relativePath: relativePath,
                fileName: fileName,
                mimeType: mimeType,
                sizeBytes: sizeBytes,
                sha256: hash,
                s3Key: s3Key,
                createdAt: now,
                updatedAt: now,
                uploadedBy: userId,
                tags: []
            };

            await fileHandler.insertOne(fileData as any);

            // Update KB statistics
            await this.updateKBStatistics(dbName, kbId);

            this.logger.success('file uploaded successfully to knowledge base');
            return { success: true, fileId: fileId };
        } catch (ex) {
            this.logger.error('error uploading file to knowledge base', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Upload multiple files (folder upload)
     */
    static async uploadMultipleFiles(
        userId: string,
        kbId: string,
        files: Array<{
            buffer: Buffer;
            fileName: string;
            relativePath: string;
            mimeType: string;
        }>
    ) {
        try {
            const results = [];
            for (const file of files) {
                const result = await this.uploadFile(
                    userId,
                    kbId,
                    file.buffer,
                    file.fileName,
                    file.relativePath,
                    file.mimeType
                );
                results.push({ ...result, fileName: file.fileName });
            }

            const successful = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            return {
                success: failed === 0,
                results: results,
                summary: { successful, failed, total: files.length }
            };
        } catch (ex) {
            this.logger.error('error uploading multiple files', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Get a knowledge base with its files
     */
    static async getKnowledgeBase(kbId: string, userId: string, includeFiles: boolean = true) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            const dbService = await getDBService();
            const kbHandler = dbService.getRepository<IKnowledgeBase>(dbName, CollectionNames.KNOWLEDGE_BASES);
            const kb: any = await kbHandler.findOne({ kbId: kbId });

            if (!kb) {
                return { success: false, error: 'knowledge base not found' };
            }

            let files: IKnowledgeBaseFile[] = [];
            if (includeFiles) {
                const fileHandler = dbService.getRepository<IKnowledgeBaseFile>(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);
                files = await fileHandler.find({ kbId: kbId });
            }

            return {
                success: true,
                knowledgeBase: {
                    kbId: kb.kbId,
                    name: kb.name,
                    description: kb.description,
                    ownerType: kb.ownerType,
                    ownerId: kb.ownerId,
                    permissionScopes: kb.permissionScopes,
                    createdAt: kb.createdAt,
                    updatedAt: kb.updatedAt,
                    status: kb.status,
                    fileCount: kb.fileCount,
                    folderCount: kb.folderCount,
                    totalSizeBytes: kb.totalSizeBytes,
                    tags: kb.tags,
                    files: files
                }
            };
        } catch (ex) {
            this.logger.error('error getting knowledge base', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Delete a knowledge base and all its files
     */
    static async deleteKnowledgeBase(kbId: string, userId: string) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            const dbService = await getDBService();
            const kbHandler = dbService.getRepository<IKnowledgeBase>(dbName, CollectionNames.KNOWLEDGE_BASES);
            const fileHandler = dbService.getRepository<IKnowledgeBaseFile>(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);

            // Get all files
            const files = await fileHandler.find({ kbId: kbId });

            // Delete files from S3
            const s3Service = new S3Service(process.env.KB_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            for (const file of files) {
                const key = file.s3Key;
                if (key) {
                    await s3Service.deleteFile(key);
                }
            }

            // Delete file records from MongoDB
            await fileHandler.deleteMany({ kbId: kbId });

            // Delete KB record
            const result = await kbHandler.deleteOne({ kbId: kbId });
            
            if (result.deletedCount && result.deletedCount > 0) {
                this.logger.success(`knowledge base ${kbId} deleted`);
                return { success: true };
            } else {
                return { success: false, error: 'failed to delete knowledge base' };
            }
        } catch (ex) {
            this.logger.error('error deleting knowledge base', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Delete a specific file from a knowledge base
     */
    static async deleteFile(kbId: string, fileId: string, userId: string) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            const dbService = await getDBService();
            const fileHandler = dbService.getRepository<IKnowledgeBaseFile>(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);

            const file: any = await fileHandler.findOne({ kbId: kbId, fileId: fileId });
            if (!file) {
                return { success: false, error: 'file not found' };
            }

            // Delete from S3
            const s3Service = new S3Service(process.env.KB_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            const s3Key = file.s3Key as string | undefined;
            if (s3Key) {
                await s3Service.deleteFile(s3Key);
            }

            // Delete from MongoDB
            await fileHandler.deleteOne({ fileId: fileId });

            // Update KB statistics
            await this.updateKBStatistics(dbName, kbId);

            return { success: true };
        } catch (ex) {
            this.logger.error('error deleting file from knowledge base', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Get all knowledge bases accessible to user
     */
    static async getAllKnowledgeBases(permissionScopeIds: string[], userId: string) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            const dbService = await getDBService();
            await dbService.ensureCollection(dbName, CollectionNames.KNOWLEDGE_BASES);
            const kbHandler = dbService.getRepository<IKnowledgeBase>(dbName, CollectionNames.KNOWLEDGE_BASES);

            const scopeIdsFromUser = Object.keys(userData.permissionScopes || {});
            const effectiveScopeIds = Array.from(
                new Set([...(permissionScopeIds || []), ...scopeIdsFromUser].filter(Boolean))
            );

            const filter: any = {};
            if (effectiveScopeIds.length > 0) {
                filter.$or = effectiveScopeIds.map((id: string) => ({
                    [`permissionScopes.${id}`]: { $exists: true }
                }));
            }

            const kbsByGroups =
                effectiveScopeIds.length > 0 ? await kbHandler.find(filter) : await kbHandler.find({});

            const ownershipOr: Record<string, unknown>[] = [
                { ownerId: userId },
                { createdBy: userId }
            ];
            if (effectiveScopeIds.length > 0) {
                ownershipOr.push({ ownerType: 'team', ownerId: { $in: effectiveScopeIds } });
            }

            const kbsByOwnership = await kbHandler.find({ $or: ownershipOr });

            const combined = [...kbsByGroups, ...kbsByOwnership];
            const kbDocs = Array.from(
                new Map(combined.map(item => [item._id.toString(), item])).values()
            );

            if (!kbDocs || kbDocs.length === 0) {
                return { success: true, knowledgeBases: [] };
            }

            const knowledgeBases = kbDocs.map(doc => ({
                kbId: doc.kbId,
                name: doc.name,
                description: doc.description,
                ownerType: doc.ownerType,
                ownerId: doc.ownerId,
                permissionScopes: doc.permissionScopes,
                status: doc.status,
                fileCount: doc.fileCount,
                folderCount: doc.folderCount,
                totalSizeBytes: doc.totalSizeBytes,
                tags: doc.tags,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt
            }));

            return { success: true, knowledgeBases };
        } catch (ex) {
            this.logger.error('error getting all knowledge bases', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Update knowledge base statistics
     */
    private static async updateKBStatistics(dbName: string, kbId: string) {
        try {
            const dbService = await getDBService();
            const fileHandler = dbService.getRepository<IKnowledgeBaseFile>(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);
            const kbHandler = dbService.getRepository<IKnowledgeBase>(dbName, CollectionNames.KNOWLEDGE_BASES);

            const files = await fileHandler.find({ kbId: kbId });
            const fileCount = files.length;
            const totalSizeBytes = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);

            // Count unique folders
            const folders = new Set(files.map(f => path.dirname(f.relativePath)));
            const folderCount = folders.size;

            await kbHandler.updateOne(
                { kbId: kbId },
                {
                    $set: {
                        fileCount: fileCount,
                        folderCount: folderCount,
                        totalSizeBytes: totalSizeBytes,
                        updatedAt: new Date()
                    }
                }
            );
        } catch (ex) {
            this.logger.error('error updating KB statistics', ex);
        }
    }

    /**
     * Download file content from knowledge base
     */
    static async downloadFile(kbId: string, fileId: string, userId: string) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            const dbService = await getDBService();
            const fileHandler = dbService.getRepository<IKnowledgeBaseFile>(dbName, CollectionNames.KNOWLEDGE_BASE_FILES);

            const file: any = await fileHandler.findOne({ kbId: kbId, fileId: fileId });
            if (!file) {
                return { success: false, error: 'file not found' };
            }

            // Download from S3
            const s3Service = new S3Service(process.env.KB_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            const dlKey = file.s3Key as string | undefined;
            if (!dlKey) {
                return { success: false, error: 'file has no S3 key' };
            }
            const fileResult = await s3Service.getFile(dlKey, undefined, true);

            if (!fileResult.success || !fileResult.data) {
                return { success: false, error: 'failed to download file from S3' };
            }

            return {
                success: true,
                data: fileResult.data,
                mimeType: file.mimeType,
                fileName: file.fileName
            };
        } catch (ex) {
            this.logger.error('error downloading file', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    /**
     * Update knowledge base metadata
     */
    static async updateKnowledgeBase(
        kbId: string,
        userId: string,
        updates: {
            name?: string;
            description?: string;
            tags?: string[];
            status?: 'active' | 'inactive' | 'syncing' | 'error';
            permissionScopes?: Record<string, any>;
        }
    ) {
        try {
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            const dbName = this.requireDbName(userData);
            if (!dbName) {
                return { success: false, error: 'user database not configured' };
            }

            const dbService = await getDBService();
            const kbHandler = dbService.getRepository<IKnowledgeBase>(dbName, CollectionNames.KNOWLEDGE_BASES);

            const updateFields: any = { updatedAt: new Date() };
            if (updates.name) updateFields.name = updates.name;
            if (updates.description !== undefined) updateFields.description = updates.description;
            if (updates.tags) updateFields.tags = updates.tags;
            if (updates.status) updateFields.status = updates.status;
            if (updates.permissionScopes) updateFields.permissionScopes = updates.permissionScopes;

            await kbHandler.updateOne(
                { kbId: kbId },
                { $set: updateFields }
            );

            return { success: true };
        } catch (ex) {
            this.logger.error('error updating knowledge base', ex);
            return { success: false, error: 'Internal error' };
        }
    }
}
