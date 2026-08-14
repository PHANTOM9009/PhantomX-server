/**
 * VMService - Unified service for managing VMs across providers
 * 
 * This service provides a high-level interface for VM operations,
 * abstracting away provider-specific details.
 */

import { VMProvider, VMInstanceConfig, VMOperationResult, VMInstance, VMListFilters, VMProviderType } from './VMProvider';
import { VMProviderFactory, VMProviderFactoryOptions } from './VMProviderFactory';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('VMService');

export class VMService {
    private provider: VMProvider;
    private providerType: VMProviderType;

    /**
     * Create a new VMService instance
     * @param options - Provider configuration options
     */
    constructor(options: VMProviderFactoryOptions = {}) {
        this.provider = VMProviderFactory.createProvider(options);
        this.providerType = options.providerType || VMProviderFactory.detectProviderType();
    }

    /**
     * Initialize the VM service
     */
    async initialize(): Promise<void> {
        logger.info('Initializing VMService', { provider: this.providerType });
        await this.provider.initialize();
    }

    /**
     * Create a new VM instance
     */
    async createInstance(config: VMInstanceConfig): Promise<VMOperationResult> {
        logger.info('Creating VM instance', { 
            provider: this.providerType,
            instanceType: config.instanceType 
        });
        return await this.provider.createInstance(config);
    }

    /**
     * Start a stopped VM instance
     */
    async startInstance(instanceId: string): Promise<VMOperationResult> {
        logger.info('Starting VM instance', { provider: this.providerType, instanceId });
        return await this.provider.startInstance(instanceId);
    }

    /**
     * Stop a running VM instance
     */
    async stopInstance(instanceId: string, force: boolean = false): Promise<VMOperationResult> {
        logger.info('Stopping VM instance', { provider: this.providerType, instanceId, force });
        return await this.provider.stopInstance(instanceId, force);
    }

    /**
     * Terminate/delete a VM instance
     */
    async terminateInstance(instanceId: string): Promise<VMOperationResult> {
        logger.info('Terminating VM instance', { provider: this.providerType, instanceId });
        return await this.provider.terminateInstance(instanceId);
    }

    /**
     * Get detailed information about a specific instance
     */
    async describeInstance(instanceId: string): Promise<VMOperationResult> {
        return await this.provider.describeInstance(instanceId);
    }

    /**
     * Get the current state of an instance
     */
    async getInstanceState(instanceId: string): Promise<{ success: boolean; state?: string; error?: string }> {
        return await this.provider.getInstanceState(instanceId);
    }

    /**
     * Get the public IP of an instance
     */
    async getPublicIp(instanceId: string): Promise<{ success: boolean; ipAddress?: string; error?: string }> {
        return await this.provider.getPublicIp(instanceId);
    }

    /**
     * List VM instances with optional filters
     */
    async listInstances(filters?: VMListFilters): Promise<{
        success: boolean;
        instances?: VMInstance[];
        count?: number;
        error?: string;
    }> {
        return await this.provider.listInstances(filters);
    }

    /**
     * Wait for instance to reach a specific state
     */
    async waitForInstanceState(
        instanceId: string,
        targetState: string,
        timeout?: number,
        pollInterval?: number
    ): Promise<{ success: boolean; state?: string; error?: string }> {
        return await this.provider.waitForInstanceState(instanceId, targetState, timeout, pollInterval);
    }

    /**
     * Get the provider name
     */
    getProviderName(): string {
        return this.provider.getProviderName();
    }

    /**
     * Get provider type
     */
    getProviderType(): VMProviderType {
        return this.providerType;
    }

    /**
     * Get provider capabilities
     */
    getCapabilities() {
        return this.provider.getCapabilities();
    }

    /**
     * Get available providers based on environment
     */
    static getAvailableProviders(): VMProviderType[] {
        return VMProviderFactory.getAvailableProviders();
    }

    /**
     * Create a VMService instance for EC2
     */
    static forEC2(region?: string): VMService {
        return new VMService({
            providerType: VMProviderType.EC2,
            region
        });
    }

    /**
     * Create a VMService instance for Azure
     */
    static forAzure(region?: string): VMService {
        return new VMService({
            providerType: VMProviderType.AZURE,
            region
        });
    }
}
