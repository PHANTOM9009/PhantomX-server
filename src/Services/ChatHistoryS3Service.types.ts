/**
 * Type definitions for ChatHistoryS3Service
 */

export interface S3ServiceConfig {
    bucket?: string;
    region?: string;
    enableCache?: boolean;
}

export interface S3FileResult {
    success: boolean;
    content?: Buffer;
    error?: string;
}

export interface S3OperationResult {
    success: boolean;
    key: string;
    error?: string;
}

export interface S3ReplaceResult extends S3OperationResult {
    replacements: number;
}

export interface S3CopyResult {
    success: boolean;
    sourceKey: string;
    destKey: string;
    error?: string;
}

export interface S3FileMetadata {
    contentType?: string;
    contentLength?: number;
    lastModified?: Date;
    etag?: string;
}

export interface S3ExistsResult {
    exists: boolean;
    metadata?: S3FileMetadata;
    error?: string;
}

export interface S3FileInfo {
    key: string;
    size: number;
    lastModified: Date;
}

export interface S3ListResult {
    success: boolean;
    files?: S3FileInfo[];
    error?: string;
}

export interface AppendOperation {
    key: string;
    content: string | Buffer;
    bucket?: string;
    separator?: string;
}

export interface StoreOperation {
    key: string;
    content: Buffer | string;
    bucket?: string;
    contentType?: string;
}

export interface CacheStats {
    size: number;
    keys: string[];
}

export interface ChatMessage {
    id?: string;
    timestamp: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata?: Record<string, any>;
}

export interface ChatConversation {
    conversationId: string;
    userId: string;
    startedAt: string;
    lastMessageAt?: string;
    messages: ChatMessage[];
    metadata?: Record<string, any>;
}

export interface ChatHistoryQuery {
    userId?: string;
    conversationId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
}
