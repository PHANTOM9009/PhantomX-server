import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
    CopyObjectCommand
} from "@aws-sdk/client-s3";
import { Readable } from 'stream';

/**
 * ChatHistoryS3Service - Optimized S3 service for chat history operations
 * Handles frequent append operations, file edits, and blob storage management
 */
export class ChatHistoryS3Service {
    private s3Client: S3Client;
    private defaultBucket: string;
    private region: string;
    private cache: Map<string, { content: Buffer; lastModified: Date }>;
    private cacheTimeout: number = 5 * 60 * 1000; // 5 minutes
    private fileLocks: Map<string, Promise<any>>;

    /**
     * Initialize ChatHistoryS3Service
     * @param bucket - S3 bucket name
     * @param region - AWS region
     * @param enableCache - Enable in-memory caching for frequent operations
     */
    constructor(bucket?: string, region?: string, enableCache: boolean = false) {
        this.region = region || process.env.AWS_REGION || 'us-east-1';
        this.defaultBucket = process.env.CHAT_HISTORY_BUCKET || '';

        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';

        this.s3Client = new S3Client({
            region: this.region,
            credentials: {
                accessKeyId,
                secretAccessKey,
                sessionToken: process.env.AWS_SESSION_TOKEN || undefined
            }
        });

        this.cache = enableCache ? new Map() : new Map();
        this.fileLocks = new Map();
    }

    /**
     * Get file content from S3
     * @param key - S3 object key
     * @param bucket - S3 bucket (optional)
     * @param useCache - Use cached version if available
     * @returns File content as Buffer
     */
    async getFile(
        key: string,
        bucket?: string,
        useCache: boolean = true
    ): Promise<{ success: boolean; content?: Buffer; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            // Check cache first
            if (useCache && this.cache.has(key)) {
                const cached = this.cache.get(key)!;
                const age = Date.now() - cached.lastModified.getTime();
                if (age < this.cacheTimeout) {
                    return { success: true, content: cached.content };
                }
                this.cache.delete(key);
            }

            const command = new GetObjectCommand({
                Bucket: targetBucket,
                Key: key
            });

            const response = await this.s3Client.send(command);
            if (!response.Body) {
                return { success: false, error: 'Empty response body' };
            }

            const stream = response.Body as Readable;
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                chunks.push(Buffer.from(chunk));
            }
            const content = Buffer.concat(chunks);

            // Update cache
            if (useCache) {
                this.cache.set(key, { content, lastModified: new Date() });
            }

            return { success: true, content };
        } catch (error: any) {
            if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                return { success: false, error: 'File not found' };
            }
            console.error('Error getting file from S3:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Store/upload file to S3
     * @param key - S3 object key
     * @param content - File content (Buffer or string)
     * @param bucket - S3 bucket (optional)
     * @param contentType - MIME type
     * @returns Upload result
     */
    async storeFile(
        key: string,
        content: Buffer | string,
        bucket?: string,
        contentType?: string
    ): Promise<{ success: boolean; key: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            const body = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

            const command = new PutObjectCommand({
                Bucket: targetBucket,
                Key: key,
                Body: body,
                ContentType: contentType || this.getContentType(key)
            });

            await this.s3Client.send(command);

            // Update cache
            this.cache.set(key, { content: body, lastModified: new Date() });

            return { success: true, key };
        } catch (error: any) {
            console.error('Error storing file to S3:', error);
            return { success: false, key, error: error.message };
        }
    }

    /**
     * Append content to existing file in S3
     * Optimized for chat history - downloads, appends, and uploads
     * @param key - S3 object key
     * @param content - Content to append
     * @param bucket - S3 bucket (optional)
     * @param separator - Separator between existing and new content (default: newline)
     * @returns Append result
     */
    async appendToFile(
        key: string,
        content: string | Buffer,
        bucket?: string,
        separator: string = '\n'
    ): Promise<{ success: boolean; key: string; error?: string }> {
        // Use file lock to prevent concurrent writes
        const lockKey = `${bucket || this.defaultBucket}:${key}`;
        
        // Wait for any existing operation on this file
        if (this.fileLocks.has(lockKey)) {
            await this.fileLocks.get(lockKey);
        }

        // Create new lock
        const operationPromise = this._performAppend(key, content, bucket, separator);
        this.fileLocks.set(lockKey, operationPromise);

        try {
            const result = await operationPromise;
            return result;
        } finally {
            this.fileLocks.delete(lockKey);
        }
    }

    /**
     * Internal method to perform append operation
     */
    private async _performAppend(
        key: string,
        content: string | Buffer,
        bucket?: string,
        separator: string = '\n'
    ): Promise<{ success: boolean; key: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            // Get existing file content
            const existingFile = await this.getFile(key, bucket, true);
            
            let newContent: Buffer;
            const appendBuffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

            if (existingFile.success && existingFile.content) {
                // File exists, append to it
                const separatorBuffer = Buffer.from(separator, 'utf-8');
                newContent = Buffer.concat([existingFile.content, separatorBuffer, appendBuffer]);
            } else {

                // File doesn't exist, create new
                newContent = appendBuffer;
            }

            // Upload the updated content
            const result = await this.storeFile(key, newContent, bucket);
            return result;
        } catch (error: any) {
            console.error('Error appending to file in S3:', error);
            return { success: false, key, error: error.message };
        }
    }

    /**
     * Edit file content in S3
     * @param key - S3 object key
     * @param editFn - Function that receives current content and returns modified content
     * @param bucket - S3 bucket (optional)
     * @returns Edit result
     */
    async editFile(
        key: string,
        editFn: (content: string) => string,
        bucket?: string
    ): Promise<{ success: boolean; key: string; error?: string }> {
        const lockKey = `${bucket || this.defaultBucket}:${key}`;
        
        if (this.fileLocks.has(lockKey)) {
            await this.fileLocks.get(lockKey);
        }

        const operationPromise = this._performEdit(key, editFn, bucket);
        this.fileLocks.set(lockKey, operationPromise);

        try {
            const result = await operationPromise;
            return result;
        } finally {
            this.fileLocks.delete(lockKey);
        }
    }

    /**
     * Internal method to perform edit operation
     */
    private async _performEdit(
        key: string,
        editFn: (content: string) => string,
        bucket?: string
    ): Promise<{ success: boolean; key: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            // Get existing file
            const existingFile = await this.getFile(key, bucket, true);
            if (!existingFile.success || !existingFile.content) {
                return { success: false, key, error: 'File not found or empty' };
            }

            // Apply edit function
            const currentContent = existingFile.content.toString('utf-8');
            const newContent = editFn(currentContent);

            // Store updated content
            const result = await this.storeFile(key, newContent, bucket);
            return result;
        } catch (error: any) {
            console.error('Error editing file in S3:', error);
            return { success: false, key, error: error.message };
        }
    }

    /**
     * Replace specific content in a file
     * @param key - S3 object key
     * @param searchValue - Content to search for (string or RegExp)
     * @param replaceValue - Replacement content
     * @param bucket - S3 bucket (optional)
     * @returns Replace result
     */
    async replaceInFile(
        key: string,
        searchValue: string | RegExp,
        replaceValue: string,
        bucket?: string
    ): Promise<{ success: boolean; key: string; replacements: number; error?: string }> {
        try {
            let replacementCount = 0;
            
            const result = await this.editFile(
                key,
                (content) => {
                    if (typeof searchValue === 'string') {
                        const original = content;
                        const updated = content.split(searchValue).join(replaceValue);
                        replacementCount = (original.length - updated.length) / (searchValue.length - replaceValue.length || 1);
                        return updated;
                    } else {
                        const matches = content.match(searchValue);
                        replacementCount = matches ? matches.length : 0;
                        return content.replace(searchValue, replaceValue);
                    }
                },
                bucket
            );

            return { ...result, replacements: replacementCount };
        } catch (error: any) {
            console.error('Error replacing in file:', error);
            return { success: false, key, replacements: 0, error: error.message };
        }
    }

    /**
     * Remove/delete file from S3
     * @param key - S3 object key
     * @param bucket - S3 bucket (optional)
     * @returns Deletion result
     */
    async removeFile(
        key: string,
        bucket?: string
    ): Promise<{ success: boolean; key: string; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            const command = new DeleteObjectCommand({
                Bucket: targetBucket,
                Key: key
            });

            await this.s3Client.send(command);

            // Remove from cache
            this.cache.delete(key);

            return { success: true, key };
        } catch (error: any) {
            console.error('Error removing file from S3:', error);
            return { success: false, key, error: error.message };
        }
    }

    /**
     * List files in S3 bucket with optional prefix
     * @param prefix - Key prefix filter
     * @param bucket - S3 bucket (optional)
     * @param maxKeys - Maximum keys to return
     * @returns List of files
     */
    async listFiles(
        prefix?: string,
        bucket?: string,
        maxKeys: number = 1000
    ): Promise<{ success: boolean; files?: Array<{ key: string; size: number; lastModified: Date }>; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            const command = new ListObjectsV2Command({
                Bucket: targetBucket,
                Prefix: prefix,
                MaxKeys: maxKeys
            });

            const response = await this.s3Client.send(command);

            const files = (response.Contents || []).map(item => ({
                key: item.Key || '',
                size: item.Size || 0,
                lastModified: item.LastModified || new Date()
            }));

            return { success: true, files };
        } catch (error: any) {
            console.error('Error listing files from S3:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if file exists in S3
     * @param key - S3 object key
     * @param bucket - S3 bucket (optional)
     * @returns Existence check result
     */
    async fileExists(
        key: string,
        bucket?: string
    ): Promise<{ exists: boolean; metadata?: any; error?: string }> {
        try {
            const targetBucket = bucket || this.defaultBucket;
            if (!targetBucket) {
                throw new Error('Bucket name is required');
            }

            const command = new HeadObjectCommand({
                Bucket: targetBucket,
                Key: key
            });

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
                return { exists: false };
            }
            return { exists: false, error: error.message };
        }
    }

    /**
     * Copy file within S3 or between buckets
     * @param sourceKey - Source object key
     * @param destKey - Destination object key
     * @param sourceBucket - Source bucket (optional)
     * @param destBucket - Destination bucket (optional)
     * @returns Copy result
     */
    async copyFile(
        sourceKey: string,
        destKey: string,
        sourceBucket?: string,
        destBucket?: string
    ): Promise<{ success: boolean; sourceKey: string; destKey: string; error?: string }> {
        try {
            const srcBucket = sourceBucket || this.defaultBucket;
            const dstBucket = destBucket || this.defaultBucket;

            if (!srcBucket || !dstBucket) {
                throw new Error('Bucket names are required');
            }

            const command = new CopyObjectCommand({
                CopySource: `${srcBucket}/${sourceKey}`,
                Bucket: dstBucket,
                Key: destKey
            });

            await this.s3Client.send(command);

            return { success: true, sourceKey, destKey };
        } catch (error: any) {
            console.error('Error copying file in S3:', error);
            return { success: false, sourceKey, destKey, error: error.message };
        }
    }

    /**
     * Batch append - append content to multiple files
     * @param operations - Array of append operations
     * @returns Results for each operation
     */
    async batchAppend(
        operations: Array<{ key: string; content: string | Buffer; bucket?: string; separator?: string }>
    ): Promise<Array<{ success: boolean; key: string; error?: string }>> {
        const results = await Promise.all(
            operations.map(op => this.appendToFile(op.key, op.content, op.bucket, op.separator))
        );
        return results;
    }

    /**
     * Batch store - store multiple files
     * @param operations - Array of store operations
     * @returns Results for each operation
     */
    async batchStore(
        operations: Array<{ key: string; content: Buffer | string; bucket?: string; contentType?: string }>
    ): Promise<Array<{ success: boolean; key: string; error?: string }>> {
        const results = await Promise.all(
            operations.map(op => this.storeFile(op.key, op.content, op.bucket, op.contentType))
        );
        return results;
    }

    /**
     * Batch delete - delete multiple files
     * @param keys - Array of object keys to delete
     * @param bucket - S3 bucket (optional)
     * @returns Results for each operation
     */
    async batchDelete(
        keys: string[],
        bucket?: string
    ): Promise<Array<{ success: boolean; key: string; error?: string }>> {
        const results = await Promise.all(
            keys.map(key => this.removeFile(key, bucket))
        );
        return results;
    }

    /**
     * Clear cache for a specific key or all keys
     * @param key - Specific key to clear (optional, clears all if not provided)
     */
    clearCache(key?: string): void {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
    }

    /**
     * Get cache statistics
     * @returns Cache stats
     */
    getCacheStats(): { size: number; keys: string[] } {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }

    /**
     * Get content type based on file extension
     */
    private getContentType(key: string): string {
        const ext = key.split('.').pop()?.toLowerCase() || '';
        const mimeTypes: { [key: string]: string } = {
            'txt': 'text/plain',
            'json': 'application/json',
            'html': 'text/html',
            'css': 'text/css',
            'js': 'application/javascript',
            'xml': 'application/xml',
            'pdf': 'application/pdf',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'svg': 'image/svg+xml',
            'log': 'text/plain',
            'md': 'text/markdown'
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    /**
     * Get S3 client instance
     */
    getClient(): S3Client {
        return this.s3Client;
    }

    /**
     * Get default bucket name
     */
    getDefaultBucket(): string {
        return this.defaultBucket;
    }

    /**
     * Set default bucket name
     */
    setDefaultBucket(bucket: string): void {
        this.defaultBucket = bucket;
    }
}

export default ChatHistoryS3Service;
