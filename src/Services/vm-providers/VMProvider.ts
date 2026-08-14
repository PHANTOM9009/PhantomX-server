/**
 * VMProvider - Abstract interface for VM providers (EC2, Azure VM, etc.)
 * 
 * This module provides a unified interface for different VM providers,
 * following the same pattern as LLMProvider abstraction.
 */

// ================== Common Types ==================

/**
 * Standard VM instance configuration
 */
export interface VMInstanceConfig {
    /** Image/AMI ID for the instance */
    imageId: string;
    /** Instance type/size (e.g., t2.micro for EC2, Standard_B1s for Azure) */
    instanceType: string;
    /** SSH Key name/path for authentication */
    keyName: string;
    /** Security group IDs or Network Security Group names */
    securityGroupIds?: string[];
    /** Subnet ID or virtual network subnet */
    subnetId?: string;
    /** User data script for instance initialization */
    userData?: string;
    /** Tags/labels to apply to the instance */
    tags?: { key: string; value: string }[];
    /** Minimum number of instances to launch */
    minCount?: number;
    /** Maximum number of instances to launch */
    maxCount?: number;
    /** IAM role or managed identity for permissions */
    iamRole?: string;
    /** Enable optimized storage/networking */
    optimized?: boolean;
    /** Enable detailed monitoring */
    monitoring?: boolean;
    /** Prevent accidental termination */
    disableTermination?: boolean;
    /** Initial state after creation - 'stopped' or 'running' */
    initialState?: 'running' | 'stopped';
    /** Root volume size in GB */
    volumeSize?: number;
    /** Root volume type */
    volumeType?: string;
    /** Delete volume on instance termination */
    deleteOnTermination?: boolean;
    /** Wait for UserData script to complete */
    waitForUserData?: boolean;
    /** Timeout for waiting for UserData completion in ms */
    userDataTimeout?: number;
}

/**
 * Standard VM instance information
 */
export interface VMInstance {
    /** Unique instance identifier */
    id: string;
    /** Instance name */
    name?: string;
    /** Public IP address */
    publicIpAddress?: string;
    /** Private IP address */
    privateIpAddress?: string;
    /** Public DNS name */
    publicDnsName?: string;
    /** Current state (running, stopped, terminated, etc.) */
    state?: string;
    /** Instance type/size */
    instanceType?: string;
    /** Availability zone/region */
    availabilityZone?: string;
    /** Launch time */
    launchTime?: Date;
    /** Tags/labels */
    tags?: { key: string; value: string }[];
    /** Platform (linux, windows, etc.) */
    platform?: string;
    /** Raw provider-specific data */
    rawData?: any;
}

/**
 * Standard operation result
 */
export interface VMOperationResult {
    success: boolean;
    instanceId?: string;
    instance?: VMInstance;
    ipAddress?: string;
    publicDns?: string;
    error?: string;
    region?: string;
    previousState?: string;
    currentState?: string;
}

/**
 * Instance listing filters
 */
export interface VMListFilters {
    /** Filter by instance IDs */
    instanceIds?: string[];
    /** Filter by state */
    states?: string[];
    /** Filter by tags */
    tags?: { key: string; value: string }[];
    /** Filter by custom criteria (provider-specific) */
    custom?: Record<string, any>;
}

/**
 * Provider configuration
 */
export interface VMProviderConfig {
    /** Provider region/location */
    region?: string;
    /** Provider credentials */
    credentials?: {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
        subscriptionId?: string;
        tenantId?: string;
        clientId?: string;
        clientSecret?: string;
    };
    /** Additional provider-specific settings */
    settings?: Record<string, any>;
}

// ================== Abstract Provider Interface ==================

/**
 * Abstract base class for VM providers
 * Each provider must implement these methods to handle their specific APIs
 */
export abstract class VMProvider {
    protected config: VMProviderConfig;
    protected region: string;

    constructor(config: VMProviderConfig) {
        this.config = config;
        this.region = config.region || 'us-east-1';
    }

    /**
     * Initialize the provider (establish connections, validate credentials, etc.)
     */
    abstract initialize(): Promise<void>;

    /**
     * Create a new VM instance
     * @param config - Instance configuration
     * @returns Promise with instance creation result
     */
    abstract createInstance(config: VMInstanceConfig): Promise<VMOperationResult>;

    /**
     * Start a stopped VM instance
     * @param instanceId - Instance ID to start
     * @returns Promise with start operation result
     */
    abstract startInstance(instanceId: string): Promise<VMOperationResult>;

    /**
     * Stop a running VM instance
     * @param instanceId - Instance ID to stop
     * @param force - Force stop if true
     * @returns Promise with stop operation result
     */
    abstract stopInstance(instanceId: string, force?: boolean): Promise<VMOperationResult>;

    /**
     * Terminate/delete a VM instance
     * @param instanceId - Instance ID to terminate
     * @returns Promise with terminate operation result
     */
    abstract terminateInstance(instanceId: string): Promise<VMOperationResult>;

    /**
     * Get detailed information about a specific instance
     * @param instanceId - Instance ID to describe
     * @returns Promise with instance details
     */
    abstract describeInstance(instanceId: string): Promise<VMOperationResult>;

    /**
     * Get the current state of an instance
     * @param instanceId - Instance ID to check
     * @returns Promise with state information
     */
    abstract getInstanceState(instanceId: string): Promise<{ success: boolean; state?: string; error?: string }>;

    /**
     * Get the public IP of an instance
     * @param instanceId - Instance ID to check
     * @returns Promise with IP information
     */
    abstract getPublicIp(instanceId: string): Promise<{ success: boolean; ipAddress?: string; error?: string }>;

    /**
     * List VM instances with optional filters
     * @param filters - Optional filters for listing
     * @returns Promise with list of instances
     */
    abstract listInstances(filters?: VMListFilters): Promise<{
        success: boolean;
        instances?: VMInstance[];
        count?: number;
        error?: string;
    }>;

    /**
     * Wait for instance to reach a specific state
     * @param instanceId - Instance ID to monitor
     * @param targetState - Desired state
     * @param timeout - Timeout in milliseconds
     * @param pollInterval - Polling interval in milliseconds
     * @returns Promise that resolves when state is reached
     */
    abstract waitForInstanceState(
        instanceId: string,
        targetState: string,
        timeout?: number,
        pollInterval?: number
    ): Promise<{ success: boolean; state?: string; error?: string }>;

    /**
     * Get the provider name
     */
    abstract getProviderName(): string;

    /**
     * Get provider-specific capabilities
     */
    abstract getCapabilities(): {
        supportsSpotInstances: boolean;
        supportsAutoScaling: boolean;
        supportsLoadBalancing: boolean;
        supportsCustomImages: boolean;
    };
}

// ================== Provider Type Enum ==================

export enum VMProviderType {
    EC2 = 'ec2',
    AZURE = 'azure',
    GCP = 'gcp'
}

/**
 * Helper function to map EC2-specific config to standard VMInstanceConfig
 */
export function mapEC2ConfigToStandard(ec2Config: any): VMInstanceConfig {
    return {
        imageId: ec2Config.amiId,
        instanceType: ec2Config.instanceType,
        keyName: ec2Config.keyName,
        securityGroupIds: ec2Config.securityGroupIds,
        subnetId: ec2Config.subnetId,
        userData: ec2Config.userData,
        tags: ec2Config.tags?.map((tag: any) => ({ key: tag.Key, value: tag.Value })),
        minCount: ec2Config.minCount,
        maxCount: ec2Config.maxCount,
        iamRole: ec2Config.iamInstanceProfile,
        optimized: ec2Config.ebsOptimized,
        monitoring: ec2Config.monitoring,
        disableTermination: ec2Config.disableApiTermination,
        initialState: ec2Config.initialState,
        volumeSize: ec2Config.volumeSize,
        volumeType: ec2Config.volumeType,
        deleteOnTermination: ec2Config.deleteOnTermination,
        waitForUserData: ec2Config.waitForUserData,
        userDataTimeout: ec2Config.userDataTimeout
    };
}

/**
 * Helper function to map standard VMInstance to EC2 format
 */
export function mapStandardInstanceToEC2(vmInstance: VMInstance): any {
    return {
        InstanceId: vmInstance.id,
        PublicIpAddress: vmInstance.publicIpAddress,
        PrivateIpAddress: vmInstance.privateIpAddress,
        PublicDnsName: vmInstance.publicDnsName,
        State: { Name: vmInstance.state },
        InstanceType: vmInstance.instanceType,
        Placement: { AvailabilityZone: vmInstance.availabilityZone },
        LaunchTime: vmInstance.launchTime,
        Tags: vmInstance.tags?.map(tag => ({ Key: tag.key, Value: tag.value })),
        Platform: vmInstance.platform,
        ...vmInstance.rawData
    };
}
