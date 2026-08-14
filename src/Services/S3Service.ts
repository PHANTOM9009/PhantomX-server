import { 
    S3Client, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
    PutObjectCommandInput,
    GetObjectCommandInput,
    DeleteObjectCommandInput,
    ListObjectsV2CommandInput,
    HeadObjectCommandInput
} from "@aws-sdk/client-s3";
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { Logger } from '../utils/Logger';

/**
 * S3Service class for handling AWS S3 operations
 * Provides methods to upload, download, delete, and manage files in S3
 */
export class S3Service {
    private s3Client: S3Client;
    private defaultBucket: string;
    private region: string;
    private logger: Logger;

    /**
     * Initialize S3Service with AWS credentials and configuration
     * @param bucket - Default S3 bucket name (optional, can be overridden per operation)
     * @param region - AWS region (defaults to environment variable or 'us-east-1')
     */
    constructor(bucket?: string, region?: string) {
        this.logger = new Logger('S3Service');
        this.region = region || process.env.AWS_REGION || 'us-east-1';
        this.defaultBucket = bucket || process.env.CHAT_HISTORY_BUCKET || '';

        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY_AI || process.env.AWS_SECRET_ACCESS_KEY || '';
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID_AI || process.env.AWS_ACCESS_KEY_ID || '';

        this.s3Client = new S3Client({
            region: this.region,
            credentials: {
                accessKeyId,
                secretAccessKey,
                sessionToken: process.env.AWS_SESSION_TOKEN || undefined
            }
        });
    }

    /**
     * Upload a file to S3
     * @param fileName - Name/key for the file in S3
     * @param fileContent - File content (Buffer, string, or file path)
     * @param bucket - S3 bucket name (optional, uses default if not provided)
     * @param contentType - MIME type of the file (optional)
     * @returns Promise with upload result
     */
    async uploadFile(
        fileName: string, 
        fileContent: Buffer | string | Readable, 
        bucket?: string,
        contentType?: string
    ): Promise<{ success: boolean; key: string; bucket: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            
            if (!targetBucket) {
                throw new Error('Bucket name is required. Provide it in constructor or as parameter.');
            }

            let body: Buffer | Readable | string;
            
            // If fileContent is a file path (string that looks like a path)
            if (typeof fileContent === 'string' && (fileContent.includes('/') || fileContent.includes('\\'))) {
                if (fs.existsSync(fileContent)) {
                    body = fs.createReadStream(fileContent);
                    
                    // Auto-detect content type if not provided
                    if (!contentType) {
                        const ext = path.extname(fileContent).toLowerCase();
                        contentType = this.getContentType(ext);
                    }
                } else {
                    // If path doesn't exist, treat as string content
                    body = fileContent;
                }
            } else {
                body = fileContent;
            }

            const params: PutObjectCommandInput = {
                Bucket: targetBucket,
                Key: fileName,
                Body: body,
                ContentType: contentType
            };

            const command = new PutObjectCommand(params);
            await this.s3Client.send(command);

            return {
                success: true,
                key: fileName,
                bucket: targetBucket
            };
        } catch (error: any) {
            this.logger.error('Error uploading file to S3', error);
            return {
                success: false,
                key: fileName,
                bucket: bucket || this.defaultBucket,
                error: error.message || 'Unknown error occurred during upload'
            };
        }
    }

    /**
     * Download a file from S3 and save it to local filesystem
     * @param fileName - Name/key of the file in S3
     * @param destinationPath - Local path where file should be saved
     * @param bucket - S3 bucket name (optional, uses default if not provided)
     * @returns Promise with download result
     */
    async downloadFile(
        fileName: string, 
        destinationPath: string, 
        bucket?: string
    ): Promise<{ success: boolean; path: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            
            if (!targetBucket) {
                throw new Error('Bucket name is required. Provide it in constructor or as parameter.');
            }

            // Get file content from S3
            const fileContent = await this.getFile(fileName, bucket);

            if (!fileContent.success || !fileContent.data) {
                return {
                    success: false,
                    path: destinationPath,
                    error: fileContent.error || 'Failed to get file from S3'
                };
            }

            // Create directory if it doesn't exist
            const dir = path.dirname(destinationPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write file to local filesystem
            if (fileContent.data instanceof Readable) {
                // Stream to file
                const writeStream = fs.createWriteStream(destinationPath);
                await new Promise<void>((resolve, reject) => {
                    (fileContent.data as Readable).pipe(writeStream);
                    writeStream.on('finish', () => resolve());
                    writeStream.on('error', reject);
                });
            } else {
                // Write buffer directly
                fs.writeFileSync(destinationPath, fileContent.data);
            }

            return {
                success: true,
                path: destinationPath
            };
        } catch (error: any) {
            this.logger.error('Error downloading file from S3', error);
            return {
                success: false,
                path: destinationPath,
                error: error.message || 'Unknown error occurred during download'
            };
        }
    }

    /**
     * Get file content from S3 without saving to disk
     * @param fileName - Name/key of the file in S3
     * @param bucket - S3 bucket name (optional, uses default if not provided)
     * @param returnAsBuffer - If true, converts stream to buffer (default: false)
     * @returns Promise with file content as Readable stream or Buffer
     */
    async getFile(
        fileName: string, 
        bucket?: string,
        returnAsBuffer: boolean = false
    ): Promise<{ success: boolean; data?: Buffer | Readable; contentType?: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            
            if (!targetBucket) {
                throw new Error('Bucket name is required. Provide it in constructor or as parameter.');
            }

            const params: GetObjectCommandInput = {
                Bucket: targetBucket,
                Key: fileName
            };

            const command = new GetObjectCommand(params);
            const response = await this.s3Client.send(command);

            if (!response.Body) {
                return {
                    success: false,
                    error: 'File body is empty'
                };
            }

            const body = response.Body as Readable;

            if (returnAsBuffer) {
                // Convert stream to buffer
                const chunks: Buffer[] = [];
                for await (const chunk of body) {
                    chunks.push(Buffer.from(chunk));
                }
                const buffer = Buffer.concat(chunks);

                return {
                    success: true,
                    data: buffer,
                    contentType: response.ContentType
                };
            }

            return {
                success: true,
                data: body,
                contentType: response.ContentType
            };
        } catch (error: any) {
            this.logger.error('Error getting file from S3', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while getting file'
            };
        }
    }

    /**
     * Delete a file from S3
     * @param fileName - Name/key of the file in S3
     * @param bucket - S3 bucket name (optional, uses default if not provided)
     * @returns Promise with deletion result
     */
    async deleteFile(
        fileName: string, 
        bucket?: string
    ): Promise<{ success: boolean; key: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            
            if (!targetBucket) {
                throw new Error('Bucket name is required. Provide it in constructor or as parameter.');
            }

            const params: DeleteObjectCommandInput = {
                Bucket: targetBucket,
                Key: fileName
            };

            const command = new DeleteObjectCommand(params);
            await this.s3Client.send(command);

            return {
                success: true,
                key: fileName
            };
        } catch (error: any) {
            console.error('Error deleting file from S3:', error);
            return {
                success: false,
                key: fileName,
                error: error.message || 'Unknown error occurred during deletion'
            };
        }
    }

    /**
     * List files in S3 bucket
     * @param prefix - Filter files by prefix (optional)
     * @param bucket - S3 bucket name (optional, uses default if not provided)
     * @param maxKeys - Maximum number of keys to return (default: 1000)
     * @returns Promise with list of files
     */
    async listFiles(
        prefix?: string, 
        bucket?: string,
        maxKeys: number = 1000
    ): Promise<{ success: boolean; files?: Array<{ key: string; size: number; lastModified: Date }>; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            
            if (!targetBucket) {
                throw new Error('Bucket name is required. Provide it in constructor or as parameter.');
            }

            const params: ListObjectsV2CommandInput = {
                Bucket: targetBucket,
                Prefix: prefix,
                MaxKeys: maxKeys
            };

            const command = new ListObjectsV2Command(params);
            const response = await this.s3Client.send(command);

            const files = (response.Contents || []).map(item => ({
                key: item.Key || '',
                size: item.Size || 0,
                lastModified: item.LastModified || new Date()
            }));

            return {
                success: true,
                files
            };
        } catch (error: any) {
            console.error('Error listing files from S3:', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while listing files'
            };
        }
    }

    /**
     * Check if a file exists in S3
     * @param fileName - Name/key of the file in S3
     * @param bucket - S3 bucket name (optional, uses default if not provided)
     * @returns Promise with existence check result
     */
    async fileExists(
        fileName: string, 
        bucket?: string
    ): Promise<{ exists: boolean; metadata?: any; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            
            if (!targetBucket) {
                throw new Error('Bucket name is required. Provide it in constructor or as parameter.');
            }

            const params: HeadObjectCommandInput = {
                Bucket: targetBucket,
                Key: fileName
            };

            const command = new HeadObjectCommand(params);
            const response = await this.s3Client.send(command);

            return {
                exists: true,
                metadata: {
                    contentType: response.ContentType,
                    contentLength: response.ContentLength,
                    lastModified: response.LastModified,
                    etag: response.ETag
                }
            };
        } catch (error: any) {
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                return {
                    exists: false
                };
            }

            console.error('Error checking file existence in S3:', error);
            return {
                exists: false,
                error: error.message || 'Unknown error occurred while checking file existence'
            };
        }
    }

    /**
     * Get MIME type based on file extension
     * @param extension - File extension (with or without dot)
     * @returns MIME type string
     */
    private getContentType(extension: string): string {
        const ext = extension.toLowerCase().replace('.', '');
        const mimeTypes: { [key: string]: string } = {
            'txt': 'text/plain',
            'html': 'text/html',
            'css': 'text/css',
            'js': 'application/javascript',
            'json': 'application/json',
            'xml': 'application/xml',
            'pdf': 'application/pdf',
            'zip': 'application/zip',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'svg': 'image/svg+xml',
            'mp4': 'video/mp4',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav'
        };

        return mimeTypes[ext] || 'application/octet-stream';
    }

    /**
     * Get the S3 client instance
     * @returns S3Client instance
     */
    public getClient(): S3Client {
        return this.s3Client;
    }

    /**
     * Get the default bucket name
     * @returns Default bucket name
     */
    public getDefaultBucket(): string {
        return this.defaultBucket;
    }

    /**
     * Set the default bucket name
     * @param bucket - New default bucket name
     */
    public setDefaultBucket(bucket: string): void {
        this.defaultBucket = bucket;
    }
}

// Export a default instance for convenience
export default S3Service;
