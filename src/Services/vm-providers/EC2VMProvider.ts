/**
 * EC2VMProvider - EC2 implementation of VMProvider
 * 
 * This wraps the existing EC2Service and adapts it to the VMProvider interface
 */

import { VMProvider, VMProviderConfig, VMInstanceConfig, VMOperationResult, VMInstance, VMListFilters } from './VMProvider';
import { EC2Service, EC2InstanceConfig } from '../EC2Service';
import { Instance } from '@aws-sdk/client-ec2';
import { createLogger } from '../../utils/Logger';

const logger = createLogger('EC2VMProvider');

export class EC2VMProvider extends VMProvider {
    private ec2Service: EC2Service;

    constructor(config: VMProviderConfig) {
        super(config);
        this.ec2Service = new EC2Service(config.region);
    }

    async initialize(): Promise<void> {
        // EC2Service initializes itself in constructor
        logger.info('EC2VMProvider initialized', { region: this.region });
    }

    async createInstance(config: VMInstanceConfig): Promise<VMOperationResult> {
        // Convert standard config to EC2-specific config
        const ec2Config: EC2InstanceConfig = {
            amiId: config.imageId,
            instanceType: config.instanceType,
            keyName: config.keyName,
            securityGroupIds: config.securityGroupIds,
            subnetId: config.subnetId,
            userData: config.userData,
            tags: config.tags?.map(tag => ({ Key: tag.key, Value: tag.value })),
            minCount: config.minCount,
            maxCount: config.maxCount,
            iamInstanceProfile: config.iamRole,
            ebsOptimized: config.optimized,
            monitoring: config.monitoring,
            disableApiTermination: config.disableTermination,
            initialState: config.initialState,
            volumeSize: config.volumeSize,
            volumeType: config.volumeType as any,
            deleteOnTermination: config.deleteOnTermination,
            waitForUserData: config.waitForUserData,
            userDataTimeout: config.userDataTimeout
        };

        const result = await this.ec2Service.createInstance(ec2Config);

        if (result.success && result.instance) {
            return {
                success: true,
                instanceId: result.instanceId,
                instance: this.convertEC2InstanceToStandard(result.instance),
                ipAddress: result.ipAddress,
                publicDns: result.publicDns,
                region: result.region
            };
        }

        return {
            success: false,
            error: result.error
        };
    }

    async startInstance(instanceId: string): Promise<VMOperationResult> {
        const result = await this.ec2Service.startInstance(instanceId);
        
        return {
            success: result.success,
            instanceId: result.instanceId,
            previousState: result.previousState,
            currentState: result.currentState,
            error: result.error
        };
    }

    async stopInstance(instanceId: string, force: boolean = false): Promise<VMOperationResult> {
        const result = await this.ec2Service.stopInstance(instanceId, force);
        
        return {
            success: result.success,
            instanceId: result.instanceId,
            previousState: result.previousState,
            currentState: result.currentState,
            error: result.error
        };
    }

    async terminateInstance(instanceId: string): Promise<VMOperationResult> {
        const result = await this.ec2Service.terminateInstance(instanceId);
        
        return {
            success: result.success,
            instanceId: result.instanceId,
            previousState: result.previousState,
            currentState: result.currentState,
            error: result.error
        };
    }

    async describeInstance(instanceId: string): Promise<VMOperationResult> {
        const result = await this.ec2Service.describeInstance(instanceId);
        
        if (result.success && result.instance) {
            const convertedInstance = this.convertEC2InstanceToStandard(result.instance);
            return {
                success: true,
                instanceId: instanceId,
                instance: convertedInstance,
                ipAddress: convertedInstance.publicIpAddress,
                publicDns: convertedInstance.publicDnsName,
                region: convertedInstance.availabilityZone
            };
        }

        return {
            success: false,
            error: result.error
        };
    }

    async getInstanceState(instanceId: string): Promise<{ success: boolean; state?: string; error?: string }> {
        return await this.ec2Service.getInstanceState(instanceId);
    }

    async getPublicIp(instanceId: string): Promise<{ success: boolean; ipAddress?: string; error?: string }> {
        return await this.ec2Service.getPublicIp(instanceId);
    }

    async listInstances(filters?: VMListFilters): Promise<{
        success: boolean;
        instances?: VMInstance[];
        count?: number;
        error?: string;
    }> {
        try {
            // Convert standard filters to EC2 filters
            const ec2Filters: any = {};
            
            if (filters?.instanceIds) {
                ec2Filters.instanceIds = filters.instanceIds;
            }
            
            if (filters?.states) {
                ec2Filters.states = filters.states;
            }
            
            if (filters?.tags) {
                ec2Filters.tags = filters.tags.map(tag => ({ key: tag.key, value: tag.value }));
            }

            // EC2Service.listInstances returns Ec2Details[] directly, not wrapped in result object
            const ec2DetailsArray = await this.ec2Service.listInstances(ec2Filters);
            
            // Convert Ec2Details to VMInstance
            const instances: VMInstance[] = [];
            for (const ec2Detail of ec2DetailsArray) {
                const describeResult = await this.ec2Service.describeInstance(ec2Detail.instanceId);
                if (describeResult.success && describeResult.instance) {
                    instances.push(this.convertEC2InstanceToStandard(describeResult.instance));
                }
            }
            
            return {
                success: true,
                instances: instances,
                count: instances.length
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to list instances'
            };
        }
    }

    async waitForInstanceState(
        instanceId: string,
        targetState: string,
        timeout: number = 300000,
        pollInterval: number = 5000
    ): Promise<{ success: boolean; state?: string; error?: string }> {
        // Cast targetState to InstanceStateName for EC2Service
        return await this.ec2Service.waitForInstanceState(instanceId, targetState as any, timeout, pollInterval);
    }

    getProviderName(): string {
        return 'EC2';
    }

    getCapabilities() {
        return {
            supportsSpotInstances: true,
            supportsAutoScaling: true,
            supportsLoadBalancing: true,
            supportsCustomImages: true
        };
    }

    /**
     * Convert EC2 Instance object to standard VMInstance format
     */
    private convertEC2InstanceToStandard(ec2Instance: Instance): VMInstance {
        return {
            id: ec2Instance.InstanceId || '',
            name: ec2Instance.Tags?.find(tag => tag.Key === 'Name')?.Value,
            publicIpAddress: ec2Instance.PublicIpAddress,
            privateIpAddress: ec2Instance.PrivateIpAddress,
            publicDnsName: ec2Instance.PublicDnsName,
            state: ec2Instance.State?.Name,
            instanceType: ec2Instance.InstanceType,
            availabilityZone: ec2Instance.Placement?.AvailabilityZone,
            launchTime: ec2Instance.LaunchTime,
            tags: ec2Instance.Tags?.map(tag => ({ key: tag.Key || '', value: tag.Value || '' })),
            platform: ec2Instance.Platform || 'linux',
            rawData: ec2Instance
        };
    }
}
