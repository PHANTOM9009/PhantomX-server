/**
 * VMProviderFactory - Factory class to create VM provider instances
 * 
 * This factory determines the appropriate provider based on:
 * - Explicit provider type
 * - Environment variables
 * - Configuration
 */

import { VMProvider, VMProviderConfig, VMProviderType } from './VMProvider';
import { EC2VMProvider } from './EC2VMProvider';
import { AzureVMProvider } from './AzureVMProvider';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('VMProviderFactory');

export interface VMProviderFactoryOptions {
    providerType?: VMProviderType;
    region?: string;
    credentials?: {
        // AWS credentials
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
        // Azure credentials
        subscriptionId?: string;
        tenantId?: string;
        clientId?: string;
        clientSecret?: string;
    };
    settings?: Record<string, any>;
}

export class VMProviderFactory {
    /**
     * Create a VM provider instance based on the options
     */
    static createProvider(options: VMProviderFactoryOptions = {}): VMProvider {
        const providerType = options.providerType || this.detectProviderType();
        
        const config: VMProviderConfig = {
            region: options.region,
            credentials: options.credentials,
            settings: options.settings
        };

        logger.info('Creating VM provider', { 
            providerType, 
            region: config.region 
        });

        switch (providerType) {
            case VMProviderType.EC2:
                return new EC2VMProvider(config);
            
            case VMProviderType.AZURE:
                return new AzureVMProvider(config);
            
            default:
                // Default to EC2 for backward compatibility
                logger.warn('Unknown provider type, defaulting to EC2', { providerType });
                return new EC2VMProvider(config);
        }
    }

    /**
     * Detect the provider type from environment variables
     */
    static detectProviderType(): VMProviderType {
        // Check environment variable for explicit provider
        const envProvider = process.env.VM_PROVIDER || process.env.CLOUD_PROVIDER;
        if (envProvider) {
            const normalized = envProvider.toLowerCase();
            if (normalized === 'ec2' || normalized === 'aws') {
                return VMProviderType.EC2;
            }
            if (normalized === 'azure') {
                return VMProviderType.AZURE;
            }
            if (normalized === 'gcp' || normalized === 'google') {
                return VMProviderType.GCP;
            }
        }

        // Auto-detect based on available credentials
        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
            return VMProviderType.EC2;
        }

        if (process.env.AZURE_SUBSCRIPTION_ID && process.env.AZURE_TENANT_ID) {
            return VMProviderType.AZURE;
        }

        // Default to EC2
        logger.info('No provider specified, defaulting to EC2');
        return VMProviderType.EC2;
    }

    /**
     * Create an EC2 provider instance
     */
    static createEC2Provider(region?: string): VMProvider {
        return this.createProvider({
            providerType: VMProviderType.EC2,
            region: region || process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                sessionToken: process.env.AWS_SESSION_TOKEN
            }
        });
    }

    /**
     * Create an Azure provider instance
     */
    static createAzureProvider(region?: string): VMProvider {
        return this.createProvider({
            providerType: VMProviderType.AZURE,
            region: region || process.env.AZURE_LOCATION || 'eastus',
            credentials: {
                subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
                tenantId: process.env.AZURE_TENANT_ID,
                clientId: process.env.AZURE_CLIENT_ID,
                clientSecret: process.env.AZURE_CLIENT_SECRET
            }
        });
    }

    /**
     * Check if EC2 credentials are available
     */
    static isEC2Available(): boolean {
        return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    }

    /**
     * Check if Azure credentials are available
     */
    static isAzureAvailable(): boolean {
        return !!(
            process.env.AZURE_SUBSCRIPTION_ID &&
            process.env.AZURE_TENANT_ID &&
            process.env.AZURE_CLIENT_ID &&
            process.env.AZURE_CLIENT_SECRET
        );
    }

    /**
     * Get list of available providers based on environment
     */
    static getAvailableProviders(): VMProviderType[] {
        const providers: VMProviderType[] = [];
        
        if (this.isEC2Available()) {
            providers.push(VMProviderType.EC2);
        }
        
        if (this.isAzureAvailable()) {
            providers.push(VMProviderType.AZURE);
        }
        
        return providers;
    }
}

// Export all VM provider-related types and classes
export * from './VMProvider';
export { EC2VMProvider } from './EC2VMProvider';
export { AzureVMProvider } from './AzureVMProvider';
