/**
 * VM Providers Module
 * 
 * Provides a unified interface for managing virtual machines across different cloud providers
 * (EC2, Azure, GCP, etc.) following the provider abstraction pattern.
 */

export * from './VMProvider';
export * from './EC2VMProvider';
export * from './AzureVMProvider';
export * from './VMProviderFactory';
export { VMService } from './VMService';
