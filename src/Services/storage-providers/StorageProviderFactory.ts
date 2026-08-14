/**
 * StorageProviderFactory - Factory class to create storage provider instances
 */

import { StorageProvider, StorageProviderConfig, StorageProviderType } from './StorageProvider';
import { S3StorageProvider } from './S3StorageProvider';
import { AzureBlobStorageProvider } from './AzureBlobStorageProvider';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('StorageProviderFactory');

export interface StorageProviderFactoryOptions {
    providerType?: StorageProviderType;
    defaultContainer?: string;
    region?: string;
    credentials?: {
        // AWS
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
        // Azure
        accountName?: string;
        accountKey?: string;
        connectionString?: string;
        sasToken?: string;
    };
    settings?: Record<string, any>;
}

export class StorageProviderFactory {
    static createProvider(options: StorageProviderFactoryOptions = {}): StorageProvider {
        const providerType = options.providerType || this.detectProviderType();
        
        const config: StorageProviderConfig = {
            defaultContainer: options.defaultContainer,
            region: options.region,
            credentials: options.credentials,
            settings: options.settings
        };

        logger.info('Creating storage provider', { providerType, container: config.defaultContainer });

        switch (providerType) {
            case StorageProviderType.S3:
                return new S3StorageProvider(config);
            
            case StorageProviderType.AZURE_BLOB:
                return new AzureBlobStorageProvider(config);
            
            default:
                logger.warn('Unknown provider type, defaulting to S3', { providerType });
                return new S3StorageProvider(config);
        }
    }

    static detectProviderType(): StorageProviderType {
        const envProvider = process.env.STORAGE_PROVIDER || process.env.CLOUD_PROVIDER;
        if (envProvider) {
            const normalized = envProvider.toLowerCase();
            if (normalized === 's3' || normalized === 'aws') {
                return StorageProviderType.S3;
            }
            if (normalized === 'azure' || normalized === 'azure_blob') {
                return StorageProviderType.AZURE_BLOB;
            }
        }

        // Auto-detect based on credentials
        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
            return StorageProviderType.S3;
        }

        if (process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_ACCOUNT_NAME) {
            return StorageProviderType.AZURE_BLOB;
        }

        logger.info('No provider specified, defaulting to S3');
        return StorageProviderType.S3;
    }

    static createS3Provider(bucket?: string, region?: string): StorageProvider {
        return this.createProvider({
            providerType: StorageProviderType.S3,
            defaultContainer: bucket || process.env.CHAT_HISTORY_BUCKET,
            region: region || process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID_AI || process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_AI || process.env.AWS_SECRET_ACCESS_KEY,
                sessionToken: process.env.AWS_SESSION_TOKEN
            }
        });
    }

    static createAzureBlobProvider(container?: string): StorageProvider {
        return this.createProvider({
            providerType: StorageProviderType.AZURE_BLOB,
            defaultContainer: container || process.env.AZURE_STORAGE_CONTAINER,
            credentials: {
                accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
                accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
                connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
                sasToken: process.env.AZURE_STORAGE_SAS_TOKEN
            }
        });
    }

    static isS3Available(): boolean {
        return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    }

    static isAzureBlobAvailable(): boolean {
        return !!(
            process.env.AZURE_STORAGE_CONNECTION_STRING ||
            (process.env.AZURE_STORAGE_ACCOUNT_NAME && process.env.AZURE_STORAGE_ACCOUNT_KEY)
        );
    }

    static getAvailableProviders(): StorageProviderType[] {
        const providers: StorageProviderType[] = [];
        
        if (this.isS3Available()) {
            providers.push(StorageProviderType.S3);
        }
        
        if (this.isAzureBlobAvailable()) {
            providers.push(StorageProviderType.AZURE_BLOB);
        }
        
        return providers;
    }
}

export * from './StorageProvider';
export { S3StorageProvider } from './S3StorageProvider';
export { AzureBlobStorageProvider } from './AzureBlobStorageProvider';
