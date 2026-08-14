/**
 * StorageProvider - Abstract interface for cloud storage providers (S3, Azure Blob, GCS, etc.)
 * 
 * This module provides a unified interface for different storage providers,
 * following the same pattern as VMProvider and LLMProvider abstractions.
 */

import { Readable } from 'stream';

// ================== Common Types ==================

/**
 * Standard file upload configuration
 */
export interface FileUploadConfig {
    /** File name/key in storage */
    fileName: string;
    /** File content (Buffer, string, Readable stream, or file path) */
    fileContent: Buffer | string | Readable;
    /** Container/bucket name */
    container?: string;
    /** MIME content type */
    contentType?: string;
    /** Custom metadata */
    metadata?: Record<string, string>;
    /** Access level (public, private) */
    accessLevel?: 'public' | 'private';
}

/**
 * Standard file download configuration
 */
export interface FileDownloadConfig {
    /** File name/key in storage */
    fileName: string;
    /** Local destination path */
    destinationPath: string;
    /** Container/bucket name */
    container?: string;
}

/**
 * Standard file get configuration
 */
export interface FileGetConfig {
    /** File name/key in storage */
    fileName: string;
    /** Container/bucket name */
    container?: string;
    /** Return as buffer instead of stream */
    returnAsBuffer?: boolean;
}

/**
 * Standard file info
 */
export interface FileInfo {
    /** File name/key */
    name: string;
    /** File size in bytes */
    size?: number;
    /** Last modified date */
    lastModified?: Date;
    /** Content type */
    contentType?: string;
    /** ETag or version identifier */
    etag?: string;
    /** Custom metadata */
    metadata?: Record<string, string>;
}

/**
 * Standard operation result
 */
export interface StorageOperationResult {
    success: boolean;
    key?: string;
    container?: string;
    path?: string;
    data?: Buffer | Readable;
    contentType?: string;
    error?: string;
}

/**
 * List files result
 */
export interface ListFilesResult {
    success: boolean;
    files?: FileInfo[];
    count?: number;
    continuationToken?: string;
    error?: string;
}

/**
 * Provider configuration
 */
export interface StorageProviderConfig {
    /** Default container/bucket name */
    defaultContainer?: string;
    /** Provider region/location */
    region?: string;
    /** Provider credentials */
    credentials?: {
        // AWS credentials
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
        // Azure credentials
        accountName?: string;
        accountKey?: string;
        connectionString?: string;
        sasToken?: string;
    };
    /** Additional provider-specific settings */
    settings?: Record<string, any>;
}

// ================== Abstract Provider Interface ==================

/**
 * Abstract base class for storage providers
 * Each provider must implement these methods to handle their specific APIs
 */
export abstract class StorageProvider {
    protected config: StorageProviderConfig;
    protected defaultContainer: string;
    protected region: string;

    constructor(config: StorageProviderConfig) {
        this.config = config;
        this.defaultContainer = config.defaultContainer || '';
        this.region = config.region || 'us-east-1';
    }

    /**
     * Initialize the provider (establish connections, validate credentials, etc.)
     */
    abstract initialize(): Promise<void>;

    /**
     * Upload a file to storage
     * @param config - Upload configuration
     * @returns Promise with upload result
     */
    abstract uploadFile(config: FileUploadConfig): Promise<StorageOperationResult>;

    /**
     * Download a file from storage and save to local filesystem
     * @param config - Download configuration
     * @returns Promise with download result
     */
    abstract downloadFile(config: FileDownloadConfig): Promise<StorageOperationResult>;

    /**
     * Get file content from storage without saving to disk
     * @param config - Get file configuration
     * @returns Promise with file content as stream or buffer
     */
    abstract getFile(config: FileGetConfig): Promise<StorageOperationResult>;

    /**
     * Delete a file from storage
     * @param fileName - File name/key to delete
     * @param container - Container/bucket name (optional)
     * @returns Promise with delete result
     */
    abstract deleteFile(fileName: string, container?: string): Promise<StorageOperationResult>;

    /**
     * List files in storage
     * @param prefix - Optional prefix to filter files
     * @param container - Container/bucket name (optional)
     * @param maxResults - Maximum number of results
     * @param continuationToken - Token for pagination
     * @returns Promise with list of files
     */
    abstract listFiles(
        prefix?: string,
        container?: string,
        maxResults?: number,
        continuationToken?: string
    ): Promise<ListFilesResult>;

    /**
     * Check if a file exists
     * @param fileName - File name/key to check
     * @param container - Container/bucket name (optional)
     * @returns Promise with existence result
     */
    abstract fileExists(fileName: string, container?: string): Promise<{ success: boolean; exists: boolean; error?: string }>;

    /**
     * Get file metadata/info
     * @param fileName - File name/key
     * @param container - Container/bucket name (optional)
     * @returns Promise with file info
     */
    abstract getFileInfo(fileName: string, container?: string): Promise<{ success: boolean; info?: FileInfo; error?: string }>;

    /**
     * Copy a file within storage or between containers
     * @param sourceFileName - Source file name/key
     * @param destinationFileName - Destination file name/key
     * @param sourceContainer - Source container (optional)
     * @param destinationContainer - Destination container (optional)
     * @returns Promise with copy result
     */
    abstract copyFile(
        sourceFileName: string,
        destinationFileName: string,
        sourceContainer?: string,
        destinationContainer?: string
    ): Promise<StorageOperationResult>;

    /**
     * Generate a signed URL for temporary access
     * @param fileName - File name/key
     * @param expirationSeconds - URL expiration time in seconds
     * @param container - Container/bucket name (optional)
     * @returns Promise with signed URL
     */
    abstract generateSignedUrl(
        fileName: string,
        expirationSeconds: number,
        container?: string
    ): Promise<{ success: boolean; url?: string; error?: string }>;

    /**
     * Get the provider name
     */
    abstract getProviderName(): string;

    /**
     * Get provider-specific capabilities
     */
    abstract getCapabilities(): {
        supportsSignedUrls: boolean;
        supportsMetadata: boolean;
        supportsVersioning: boolean;
        supportsPublicAccess: boolean;
    };

    /**
     * Get default container name
     */
    getDefaultContainer(): string {
        return this.defaultContainer;
    }

    /**
     * Set default container name
     */
    setDefaultContainer(container: string): void {
        this.defaultContainer = container;
    }
}

// ================== Provider Type Enum ==================

export enum StorageProviderType {
    S3 = 's3',
    AZURE_BLOB = 'azure_blob',
    GCS = 'gcs'
}

/**
 * Helper function to get content type from file extension
 */
export function getContentTypeFromExtension(extension: string): string {
    const contentTypes: Record<string, string> = {
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.zip': 'application/zip',
        '.mp4': 'video/mp4',
        '.mp3': 'audio/mpeg'
    };

    return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
}
