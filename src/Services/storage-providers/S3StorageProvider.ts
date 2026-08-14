/**
 * S3StorageProvider - S3 implementation of StorageProvider
 * 
 * This wraps the existing S3Service and adapts it to the StorageProvider interface
 */

import { StorageProvider, StorageProviderConfig, FileUploadConfig, FileDownloadConfig, FileGetConfig, StorageOperationResult, ListFilesResult, FileInfo } from './StorageProvider';
import { S3Service } from '../S3Service';
import { GetObjectCommand, S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '../../utils/Logger';

// Dynamically import presigner if available
let getSignedUrl: any;
try {
    const presigner = require('@aws-sdk/s3-request-presigner');
    getSignedUrl = presigner.getSignedUrl;
} catch (e) {
    // Module not installed, signed URLs will not be available
    getSignedUrl = null;
}

const logger = createLogger('S3StorageProvider');

export class S3StorageProvider extends StorageProvider {
    private s3Service: S3Service;
    private s3Client: S3Client;

    constructor(config: StorageProviderConfig) {
        super(config);
        this.s3Service = new S3Service(config.defaultContainer, config.region);
        
        // Create S3 client for advanced operations
        this.s3Client = new S3Client({
            region: config.region || process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: config.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID_AI || process.env.AWS_ACCESS_KEY_ID || '',
                secretAccessKey: config.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY_AI || process.env.AWS_SECRET_ACCESS_KEY || '',
                sessionToken: config.credentials?.sessionToken || process.env.AWS_SESSION_TOKEN
            }
        });
    }

    async initialize(): Promise<void> {
        logger.info('S3StorageProvider initialized', { region: this.region, bucket: this.defaultContainer });
    }

    async uploadFile(config: FileUploadConfig): Promise<StorageOperationResult> {
        const result = await this.s3Service.uploadFile(
            config.fileName,
            config.fileContent,
            config.container || this.defaultContainer,
            config.contentType
        );

        return {
            success: result.success,
            key: result.key,
            container: result.bucket,
            error: result.error
        };
    }

    async downloadFile(config: FileDownloadConfig): Promise<StorageOperationResult> {
        const result = await this.s3Service.downloadFile(
            config.fileName,
            config.destinationPath,
            config.container || this.defaultContainer
        );

        return {
            success: result.success,
            path: result.path,
            error: result.error
        };
    }

    async getFile(config: FileGetConfig): Promise<StorageOperationResult> {
        const result = await this.s3Service.getFile(
            config.fileName,
            config.container || this.defaultContainer,
            config.returnAsBuffer
        );

        return {
            success: result.success,
            data: result.data,
            contentType: result.contentType,
            error: result.error
        };
    }

    async deleteFile(fileName: string, container?: string): Promise<StorageOperationResult> {
        const result = await this.s3Service.deleteFile(
            fileName,
            container || this.defaultContainer
        );

        return {
            success: result.success,
            key: fileName,
            container: container || this.defaultContainer,
            error: result.error
        };
    }

    async listFiles(
        prefix?: string,
        container?: string,
        maxResults?: number,
        continuationToken?: string
    ): Promise<ListFilesResult> {
        const result = await this.s3Service.listFiles(
            prefix,
            container || this.defaultContainer,
            maxResults
        );

        if (!result.success) {
            return {
                success: false,
                error: result.error
            };
        }

        // Convert S3 file list to standard FileInfo format
        const files: FileInfo[] = (result.files || []).map(file => ({
            name: file.key || '',
            size: file.size,
            lastModified: file.lastModified
        }));

        return {
            success: true,
            files: files,
            count: files.length
        };
    }

    async fileExists(fileName: string, container?: string): Promise<{ success: boolean; exists: boolean; error?: string }> {
        const result = await this.s3Service.fileExists(
            fileName,
            container || this.defaultContainer
        );

        return {
            success: true,
            exists: result.exists || false,
            error: result.error
        };
    }

    async getFileInfo(fileName: string, container?: string): Promise<{ success: boolean; info?: FileInfo; error?: string }> {
        try {
            const targetBucket = container || this.defaultContainer;
            
            if (!targetBucket) {
                return {
                    success: false,
                    error: 'Container/bucket name is required'
                };
            }

            // Use S3Service to check if file exists and get metadata
            const existsResult = await this.s3Service.fileExists(fileName, targetBucket);
            
            if (!existsResult.exists) {
                return {
                    success: false,
                    error: existsResult.error || 'File not found'
                };
            }

            // Use metadata from fileExists result
            const info: FileInfo = {
                name: fileName,
                size: existsResult.metadata?.contentLength,
                lastModified: existsResult.metadata?.lastModified,
                contentType: existsResult.metadata?.contentType,
                etag: existsResult.metadata?.etag
            };

            return {
                success: true,
                info: info
            };
        } catch (error: any) {
            logger.error('Error getting file info', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred'
            };
        }
    }

    async copyFile(
        sourceFileName: string,
        destinationFileName: string,
        sourceContainer?: string,
        destinationContainer?: string
    ): Promise<StorageOperationResult> {
        try {
            const sourceBucket = sourceContainer || this.defaultContainer;
            const destBucket = destinationContainer || this.defaultContainer;

            if (!sourceBucket || !destBucket) {
                return {
                    success: false,
                    error: 'Source and destination containers are required'
                };
            }

            const copyCommand = new CopyObjectCommand({
                Bucket: destBucket,
                CopySource: `${sourceBucket}/${sourceFileName}`,
                Key: destinationFileName
            });

            await this.s3Client.send(copyCommand);

            return {
                success: true,
                key: destinationFileName,
                container: destBucket
            };
        } catch (error: any) {
            logger.error('Error copying file', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while copying file'
            };
        }
    }

    async generateSignedUrl(
        fileName: string,
        expirationSeconds: number,
        container?: string
    ): Promise<{ success: boolean; url?: string; error?: string }> {
        try {
            if (!getSignedUrl) {
                return {
                    success: false,
                    error: 'Signed URL generation requires @aws-sdk/s3-request-presigner package. Please install it: npm install @aws-sdk/s3-request-presigner'
                };
            }

            const targetBucket = container || this.defaultContainer;

            if (!targetBucket) {
                return {
                    success: false,
                    error: 'Container/bucket name is required'
                };
            }

            const command = new GetObjectCommand({
                Bucket: targetBucket,
                Key: fileName
            });

            const signedUrl = await getSignedUrl(this.s3Client, command, {
                expiresIn: expirationSeconds
            });

            return {
                success: true,
                url: signedUrl
            };
        } catch (error: any) {
            logger.error('Error generating signed URL', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while generating signed URL'
            };
        }
    }

    getProviderName(): string {
        return 'S3';
    }

    getCapabilities() {
        return {
            supportsSignedUrls: true,
            supportsMetadata: true,
            supportsVersioning: true,
            supportsPublicAccess: true
        };
    }
}
