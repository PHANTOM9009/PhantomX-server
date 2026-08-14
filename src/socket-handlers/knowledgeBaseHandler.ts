import * as ds from './../DataStructures';
import { Server, Socket } from 'socket.io';
import { KnowledgeBaseService } from '../Services/knowledgeBaseService';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import { CollectionNames } from '../DataAccessLayer/models';
import { IKnowledgeBase } from '../DataAccessLayer/models/knowledgeBase';
import * as dotenv from 'dotenv';
dotenv.config();

const logger = new Logger('knowledgeBaseHandler');

export async function knowledge_base_handler(io: Server, socket: Socket) {

    const hasWriteAccess = async (userId: string, kbId: string): Promise<boolean> => {
        try {
            const userData = ds.UserInfo.get(userId);
            if (!userData) return false;

            const dbService = await getDBService();
            await dbService.ensureCollection(userData.dbName, CollectionNames.KNOWLEDGE_BASES);
            const kbRepository = dbService.getRepository<IKnowledgeBase>(userData.dbName, CollectionNames.KNOWLEDGE_BASES);
            const kb = await kbRepository.findOne({ kbId: kbId });

            if (!kb) return false;

            // Check if user is owner
            if (kb.ownerId === userId) return true;

            if (kb.createdBy === userId) return true;

            // Check permission scopes
            if (kb.permissionScopes) {
                return Object.keys(kb.permissionScopes).some((groupId: string) => 
                    (userData.permissionScopes?.hasOwnProperty(groupId) || userData.userId === groupId) &&
                    kb.permissionScopes[groupId].toLowerCase() === 'write'
                );
            }

            return false;
        } catch (err) {
            logger.error('Error checking write access:', err);
            return false;
        }
    };

    socket.on('create_knowledge_base', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { name, description, permissionScopes, metadata } = data;
            
            if (!name || !metadata || !metadata.ownerType || !metadata.ownerId) {
                callback && callback({ success: false, error: 'Missing required fields' });
                return;
            }

            const result = await KnowledgeBaseService.createKnowledgeBase(
                userId,
                name,
                description || '',
                permissionScopes || {},
                metadata
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in create_knowledge_base', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('upload_file_to_kb', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId, fileBuffer, fileName, relativePath, mimeType } = data;
            
            if (!kbId || !fileBuffer || !fileName || !relativePath) {
                callback && callback({ success: false, error: 'Missing required fields' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, kbId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            // Convert base64 to buffer if needed
            let buffer: Buffer;
            if (typeof fileBuffer === 'string') {
                buffer = Buffer.from(fileBuffer, 'base64');
            } else {
                buffer = Buffer.from(fileBuffer);
            }

            const result = await KnowledgeBaseService.uploadFile(
                userId,
                kbId,
                buffer,
                fileName,
                relativePath,
                mimeType || 'application/octet-stream'
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in upload_file_to_kb', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('upload_multiple_files_to_kb', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId, files } = data;
            
            if (!kbId || !files || !Array.isArray(files)) {
                callback && callback({ success: false, error: 'Missing required fields' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, kbId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            // Convert files
            const processedFiles = files.map((file: any) => {
                let buffer: Buffer;
                if (typeof file.buffer === 'string') {
                    buffer = Buffer.from(file.buffer, 'base64');
                } else {
                    buffer = Buffer.from(file.buffer);
                }
                return {
                    buffer: buffer,
                    fileName: file.fileName,
                    relativePath: file.relativePath,
                    mimeType: file.mimeType || 'application/octet-stream'
                };
            });

            const result = await KnowledgeBaseService.uploadMultipleFiles(
                userId,
                kbId,
                processedFiles
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in upload_multiple_files_to_kb', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('get_knowledge_base', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId, includeFiles } = data;
            
            if (!kbId) {
                callback && callback({ success: false, error: 'Missing kbId' });
                return;
            }

            const result = await KnowledgeBaseService.getKnowledgeBase(
                kbId,
                userId,
                includeFiles !== false
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in get_knowledge_base', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('delete_knowledge_base', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId } = data;
            
            if (!kbId) {
                callback && callback({ success: false, error: 'Missing kbId' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, kbId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            const result = await KnowledgeBaseService.deleteKnowledgeBase(kbId, userId);
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in delete_knowledge_base', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('delete_file_from_kb', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId, fileId } = data;
            
            if (!kbId || !fileId) {
                callback && callback({ success: false, error: 'Missing required fields' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, kbId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            const result = await KnowledgeBaseService.deleteFile(kbId, fileId, userId);
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in delete_file_from_kb', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('get_all_knowledge_bases', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { permissionScopeIds } = data;
            
            const result = await KnowledgeBaseService.getAllKnowledgeBases(
                permissionScopeIds || [],
                userId
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in get_all_knowledge_bases', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('download_file_from_kb', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId, fileId } = data;
            
            if (!kbId || !fileId) {
                callback && callback({ success: false, error: 'Missing required fields' });
                return;
            }

            const result = await KnowledgeBaseService.downloadFile(kbId, fileId, userId);
            
            if (result.success && result.data) {
                // Convert buffer to base64 for transmission
                const base64Data = (result.data as Buffer).toString('base64');
                callback && callback({
                    success: true,
                    data: base64Data,
                    mimeType: result.mimeType,
                    fileName: result.fileName
                });
            } else {
                callback && callback(result);
            }
        } catch (err: any) {
            logger.error('error in download_file_from_kb', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('update_knowledge_base', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { kbId, updates } = data;
            
            if (!kbId) {
                callback && callback({ success: false, error: 'Missing kbId' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, kbId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            const result = await KnowledgeBaseService.updateKnowledgeBase(
                kbId,
                userId,
                updates || {}
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in update_knowledge_base', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });
}
