/**
 * StorageService - Unified service for managing files across storage providers
 */

import { StorageProvider, FileUploadConfig, FileDownloadConfig, FileGetConfig, StorageOperationResult, ListFilesResult, FileInfo, StorageProviderType } from './StorageProvider';
import { StorageProviderFactory, StorageProviderFactoryOptions } from './StorageProviderFactory';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('StorageService');

export class StorageService {
    private provider: StorageProvider;
    private providerType: StorageProviderType;

    constructor(options: StorageProviderFactoryOptions = {}) {
        this.provider = StorageProviderFactory.createProvider(options);
        this.providerType = options.providerType || StorageProviderFactory.detectProviderType();
    }

    async initialize(): Promise<void> {
        logger.info('Initializing StorageService', { provider: this.providerType });
        await this.provider.initialize();
    }

    async uploadFile(config: FileUploadConfig): Promise<StorageOperationResult> {
        return await this.provider.uploadFile(config);
    }

    async downloadFile(config: FileDownloadConfig): Promise<StorageOperationResult> {
        return await this.provider.downloadFile(config);
    }

    async getFile(config: FileGetConfig): Promise<StorageOperationResult> {
        return await this.provider.getFile(config);
    }

    async deleteFile(fileName: string, container?: string): Promise<StorageOperationResult> {
        return await this.provider.deleteFile(fileName, container);
    }

    async listFiles(prefix?: string, container?: string, maxResults?: number, continuationToken?: string): Promise<ListFilesResult> {
        return await this.provider.listFiles(prefix, container, maxResults, continuationToken);
    }

    async fileExists(fileName: string, container?: string): Promise<{ success: boolean; exists: boolean; error?: string }> {
        return await this.provider.fileExists(fileName, container);
    }

    async getFileInfo(fileName: string, container?: string): Promise<{ success: boolean; info?: FileInfo; error?: string }> {
        return await this.provider.getFileInfo(fileName, container);
    }

    async copyFile(sourceFileName: string, destinationFileName: string, sourceContainer?: string, destinationContainer?: string): Promise<StorageOperationResult> {
        return await this.provider.copyFile(sourceFileName, destinationFileName, sourceContainer, destinationContainer);
    }

    async generateSignedUrl(fileName: string, expirationSeconds: number, container?: string): Promise<{ success: boolean; url?: string; error?: string }> {
        return await this.provider.generateSignedUrl(fileName, expirationSeconds, container);
    }

    getProviderName(): string {
        return this.provider.getProviderName();
    }

    getProviderType(): StorageProviderType {
        return this.providerType;
    }

    getCapabilities() {
        return this.provider.getCapabilities();
    }

    getDefaultContainer(): string {
        return this.provider.getDefaultContainer();
    }

    setDefaultContainer(container: string): void {
        this.provider.setDefaultContainer(container);
    }

    static getAvailableProviders(): StorageProviderType[] {
        return StorageProviderFactory.getAvailableProviders();
    }

    static forS3(bucket?: string, region?: string): StorageService {
        return new StorageService({
            providerType: StorageProviderType.S3,
            defaultContainer: bucket,
            region
        });
    }

    static forAzureBlob(container?: string): StorageService {
        return new StorageService({
            providerType: StorageProviderType.AZURE_BLOB,
            defaultContainer: container
        });
    }
}
