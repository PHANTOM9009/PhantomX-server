import {
    EC2Client,
    RunInstancesCommand,
    StartInstancesCommand,
    StopInstancesCommand,
    TerminateInstancesCommand,
    DescribeInstancesCommand,
    RunInstancesCommandInput,
    StartInstancesCommandInput,
    StopInstancesCommandInput,
    TerminateInstancesCommandInput,
    DescribeInstancesCommandInput,
    Instance,
    _InstanceType,
    InstanceStateName,
    waitUntilInstanceExists
} from "@aws-sdk/client-ec2";
import * as dotenv from 'dotenv';
import * as ds from './../DataStructures';
import { Logger } from '../utils/Logger';
import { EC2Type } from "./../DataStructures";
dotenv.config();
/**
 * Configuration interface for creating EC2 instances
 * 
 * SSH Access Configuration:
 * - EC2 instances use SSH key-based authentication (NO username/password needed)
 * - The 'keyName' parameter specifies the AWS key pair for SSH access
 * - To connect: ssh -i /path/to/keypair.pem <username>@<instance-ip>
 * - Default usernames by AMI type:
 *   - Ubuntu: ubuntu
 *   - Amazon Linux: ec2-user
 *   - Red Hat: ec2-user
 *   - Debian: admin
 *   - SUSE: ec2-user
 */
export interface EC2InstanceConfig {
    /** AMI ID for the instance (e.g., ami-0c55b159cbfafe1f0) */
    amiId: string;
    /** Instance type (e.g., t2.micro, t3.medium) */
    instanceType: _InstanceType | string;
    /** 
     * SSH Key Pair name for passwordless SSH access
     * This key must exist in AWS EC2 Key Pairs in the target region
     * Download the .pem file when creating the key pair
     */
    keyName: string;
    /** Security group IDs (recommended over securityGroups) */
    securityGroupIds?: string[];
    /** Security group names (use securityGroupIds in VPC) */
    securityGroups?: string[];
    /** Subnet ID for VPC placement */
    subnetId?: string;
    /** User data script for instance initialization */
    userData?: string;
    /** Tags to apply to the instance */
    tags?: { Key: string; Value: string }[];
    /** Minimum number of instances to launch */
    minCount?: number;
    /** Maximum number of instances to launch */
    maxCount?: number;
    /** IAM instance profile for AWS permissions */
    iamInstanceProfile?: string;
    /** Enable EBS optimization */
    ebsOptimized?: boolean;
    /** Enable detailed CloudWatch monitoring */
    monitoring?: boolean;
    /** Prevent accidental termination */
    disableApiTermination?: boolean;
    /** Behavior when instance is shut down from OS */
    instanceInitiatedShutdownBehavior?: 'stop' | 'terminate';
    /** Initial state of instance after creation - 'stopped' (default) or 'running' */
    initialState?: 'running' | 'stopped';
    /** Root volume size in GB (default: 16) */
    volumeSize?: number;
    /** Root volume type (default: 'gp3') - gp2, gp3, io1, io2, st1, sc1 */
    volumeType?: 'gp2' | 'gp3' | 'io1' | 'io2' | 'st1' | 'sc1';
    /** Delete volume on instance termination (default: true) */
    deleteOnTermination?: boolean;
    /** IOPS for io1/io2/gp3 volumes */
    iops?: number;
    /** Throughput in MB/s for gp3 volumes (125-1000) */
    throughput?: number;
    /** Wait for UserData script to complete before returning (default: false) */
    waitForUserData?: boolean;
    /** Timeout for waiting for UserData completion in ms (default: 600000 - 10 minutes) */
    userDataTimeout?: number;
}

/**
 * EC2Service class for managing AWS EC2 instances
 * Provides methods to create, start, stop, terminate, and manage EC2 instances
 */
export class EC2Service {
    private ec2Client: EC2Client;
    private region: string;
    private logger: Logger;

    /**
     * Platform-agnostic delay function that works reliably on both Windows and Linux
     * Uses setImmediate in addition to setTimeout to ensure event loop processing
     * @param ms - Milliseconds to delay
     */
    private async delay(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                // Force at least one event loop cycle with setImmediate
                setImmediate(() => {
                    resolve();
                });
            }, ms);
            
            // Ensure timer doesn't prevent process exit, but still waits properly
            // This is important for Linux where timer behavior can differ
            // TypeScript: timer is NodeJS.Timeout in Node.js environment
            if (typeof timer === 'object' && timer && 'ref' in timer) {
                (timer as any).ref(); // Explicitly keep the timer referenced
            }
        });
    }

    /**
     * Initialize EC2Service with AWS credentials and configuration
     * @param region - AWS region (defaults to environment variable or 'us-east-1')
     */
    constructor(region?: string) {
        this.logger = new Logger('EC2Service');
        this.region = region || process.env.AWS_REGION || 'us-east-1';

        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';

        this.ec2Client = new EC2Client({
            region: this.region,
            credentials: {
                accessKeyId,
                secretAccessKey,
                sessionToken: process.env.AWS_SESSION_TOKEN || undefined
            }
        });
    }

  

    /**
     * Initialize and get all EC2 instances with the name 'DevInstance'
     * Returns information about those instances similar to createInstance
     * @returns Promise with array of DevInstance details
     */
    async init(): Promise<{
        success: boolean;
        instances?: Array<{
            instanceId: string;
            ipAddress?: string;
            publicDns?: string;
            region?: string;
            state?: string;
            privateIp?: string;
            instanceType?: string;
            launchTime?: Date;
        }>;
        count?: number;
        error?: string;
    }> {
        try {
            // Get all instances with the tag Name=DevInstance using private method
            const result = await this.getRawInstances({
                tags: [{ key: 'Name', value: 'DevInstance' }]
            });

            if (!result.success) {
                return {
                    success: false,
                    error: result.error || 'Failed to list instances'
                };
            }

            if (!result.instances || result.instances.length === 0) {
                return {
                    success: true,
                    instances: [],
                    count: 0
                };
            }

            // Map instances to the same format as createInstance returns
            const instanceDetails = result.instances.map(instance => ({
                instanceId: instance.InstanceId || '',
                ipAddress: instance.PublicIpAddress,
                publicDns: instance.PublicDnsName,
                region: instance.Placement?.AvailabilityZone,
                state: instance.State?.Name,
                privateIp: instance.PrivateIpAddress,
                instanceType: instance.InstanceType,
                launchTime: instance.LaunchTime
            }));

            return {
                success: true,
                instances: instanceDetails,
                count: instanceDetails.length
            };
        } catch (error: any) {
            this.logger.error('Error initializing DevInstance instances', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while initializing instances'
            };
        }
    }

    /**
     * Create a new EC2 instance with SSH key-based authentication
     * 
     * SSH Access:
     * - The instance will be created with the specified SSH key pair (config.keyName)
     * - NO username/password is required or created
     * - Connect using: ssh -i /path/to/keypair.pem <username>@<public-ip>
     * - Ensure your security group allows inbound SSH (port 22) from your IP
     * 
     * @param config - Instance configuration including keyName for SSH access
     * @returns Promise with instance creation result including instanceId and public IP
     */
    async createInstance(config: EC2InstanceConfig): Promise<{
        success: boolean;
        instanceId?: string;
        instance?: Instance;
        ipAddress?:string;
        publicDns?:string;
        error?: string;
        region?:string;
    }> {
        try {
            // Validate required parameters
            if (!config.amiId) {
                throw new Error('AMI ID is required');
            }
            if (!config.instanceType) {
                throw new Error('Instance type is required');
            }
            if (!config.keyName) {
                throw new Error('Key pair name is required');
            }

            


            // Prepare user data (encode to base64 if provided)
            config.userData = this.generateUserDataScript(true, true, []);

            let userData: string | undefined = undefined;

            if (config.userData) {
                userData = Buffer.from(config.userData).toString('base64');
            }

            // Prepare tags
            const tagSpecifications = config.tags ? [{
                ResourceType: 'instance' as const,
                Tags: config.tags
            }] : undefined;

            // Configure root volume (storage)
            const volumeSize = config.volumeSize || 16; // Default 16GB
            const volumeType = config.volumeType || 'gp3'; // Default gp3 (faster and cheaper than gp2)
            const deleteOnTermination = config.deleteOnTermination !== undefined ? config.deleteOnTermination : true;

            const blockDeviceMappings = [{
                DeviceName: '/dev/sda1', // For Ubuntu/Amazon Linux (use /dev/xvda for some AMIs)
                Ebs: {
                    VolumeSize: volumeSize,
                    VolumeType: volumeType,
                    DeleteOnTermination: deleteOnTermination,
                    // Add IOPS if specified and volume type supports it
                    ...(config.iops && ['io1', 'io2', 'gp3'].includes(volumeType) ? { Iops: config.iops } : {}),
                    // Add throughput if specified and volume type is gp3
                    ...(config.throughput && volumeType === 'gp3' ? { Throughput: config.throughput } : {}),
                }
            }];

            const params: RunInstancesCommandInput = {
                ImageId: config.amiId,
                InstanceType: config.instanceType as _InstanceType,
                KeyName: config.keyName,
                MinCount: config.minCount || 1,
                MaxCount: config.maxCount || 1,
                SecurityGroupIds: config.securityGroupIds,
                SecurityGroups: config.securityGroups,
                SubnetId: config.subnetId,
                UserData: userData,
                TagSpecifications: tagSpecifications,
                BlockDeviceMappings: blockDeviceMappings,
                IamInstanceProfile: config.iamInstanceProfile ? {
                    Name: config.iamInstanceProfile
                } : undefined,
                EbsOptimized: config.ebsOptimized,
                Monitoring: config.monitoring ? {
                    Enabled: config.monitoring
                } : undefined,
                DisableApiTermination: config.disableApiTermination,
                InstanceInitiatedShutdownBehavior: config.instanceInitiatedShutdownBehavior
            };

            const command = new RunInstancesCommand(params);
            const response = await this.ec2Client.send(command);

          //  console.log('\n in createInstance got the response from aws ==>');
            
            const instance = response.Instances?.[0];
            if (!instance || !instance.InstanceId) {
                throw new Error('Failed to create instance - no instance data returned');
            }
          //  console.log('\n the returned instance response is=>',JSON.stringify(instance));
            const instanceId = instance.InstanceId;
            const desiredState = config.initialState || 'running';

            if (desiredState === 'stopped') {
                await this.waitForInstanceState(instanceId, 'running', 180000, 3000);
                
                const stopResult = await this.stopInstance(instanceId);
                if (!stopResult.success) {
                }
                
                await this.waitForInstanceState(instanceId, 'stopped', 180000, 3000);
            }
            else{
                await this.waitForInstanceState(instanceId,'running',180000,3000);
            }
            const finalInstanceDetails = await this.describeInstance(instanceId);
            const publicIp = finalInstanceDetails.instance?.PublicIpAddress;

            // Wait for UserData script completion if requested
            if (config.waitForUserData && desiredState === 'running') {
              //  console.log("\n waiting for the user script to be completed");
                if (!publicIp) {
                } else {
                    const userDataTimeout = config.userDataTimeout || 600000; // 10 minutes default
                    const waitResult = await this.waitForUserDataCompletion(publicIp, userDataTimeout);
                    
                    if (!waitResult.success) {
                        this.logger.warn(`UserData script did not complete: ${waitResult.error}`);
                        // Note: We don't fail the instance creation, just log the warning
                        // The instance is created successfully, but scripts may not be ready
                    } else {
                    }
                }
            }

            return {
                success: true,
                instanceId: instanceId,
                instance: finalInstanceDetails.instance || instance,
                ipAddress: publicIp,
                publicDns: finalInstanceDetails.instance?.PublicDnsName,
                region: finalInstanceDetails.instance?.Placement?.AvailabilityZone
            };
        } catch (error: any) {
            console.error('Error creating EC2 instance:', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while creating instance'
            };
        }
    }

    /**
     * Start a stopped EC2 instance
     * 
     * When the instance starts, the Docker containers will automatically start via the systemd service
     * that was configured during instance creation. The systemd service runs the Docker startup script
     * from generateDockerStartupScript() on every boot.
     * 
     * The Docker startup script will:
     * - Wait for Docker daemon to be ready
     * - Pull latest Docker images
     * - Stop and remove old containers
     * - Start new containers
     * - Log the completion to /var/log/docker-startup.log
     * 
     * @param instanceId - Instance ID to start
     * @returns Promise with start operation result
     */
    async startInstance(instanceId: string): Promise<{
        success: boolean;
        instanceId: string;
        previousState?: string;
        currentState?: string;
        error?: string;
    }> {
        try {
            if (!instanceId) {
                throw new Error('Instance ID is required');
            }

            const params: StartInstancesCommandInput = {
                InstanceIds: [instanceId]
            };

            const command = new StartInstancesCommand(params);
            const response = await this.ec2Client.send(command);

            const instanceState = response.StartingInstances?.[0];
            
            // Note: The Docker containers will start automatically via the systemd service
            // configured during instance creation. No additional action needed here.
            
            return {
                success: true,
                instanceId: instanceId,
                previousState: instanceState?.PreviousState?.Name,
                currentState: instanceState?.CurrentState?.Name
            };
        } catch (error: any) {
            console.error('Error starting EC2 instance:', error);
            return {
                success: false,
                instanceId: instanceId,
                error: error.message || 'Unknown error occurred while starting instance'
            };
        }
    }

    /**
     * Stop a running EC2 instance
     * @param instanceId - Instance ID to stop
     * @param force - Force stop the instance (default: false)
     * @returns Promise with stop operation result
     */
    async stopInstance(instanceId: string, force: boolean = false): Promise<{
        success: boolean;
        instanceId: string;
        previousState?: string;
        currentState?: string;
        error?: string;
    }> {
        try {
            if (!instanceId) {
                throw new Error('Instance ID is required');
            }

            const params: StopInstancesCommandInput = {
                InstanceIds: [instanceId],
                Force: force
            };

            const command = new StopInstancesCommand(params);
            const response = await this.ec2Client.send(command);

            const instanceState = response.StoppingInstances?.[0];
            
            return {
                success: true,
                instanceId: instanceId,
                previousState: instanceState?.PreviousState?.Name,
                currentState: instanceState?.CurrentState?.Name
            };
        } catch (error: any) {
            console.error('Error stopping EC2 instance:', error);
            return {
                success: false,
                instanceId: instanceId,
                error: error.message || 'Unknown error occurred while stopping instance'
            };
        }
    }

    /**
     * Terminate (delete) an EC2 instance
     * @param instanceId - Instance ID to terminate
     * @returns Promise with termination result
     */
    async terminateInstance(instanceId: string): Promise<{
        success: boolean;
        instanceId: string;
        previousState?: string;
        currentState?: string;
        error?: string;
    }> {
        try {
            if (!instanceId) {
                throw new Error('Instance ID is required');
            }

            const params: TerminateInstancesCommandInput = {
                InstanceIds: [instanceId]
            };

            const command = new TerminateInstancesCommand(params);
            const response = await this.ec2Client.send(command);

            const instanceState = response.TerminatingInstances?.[0];
            
            return {
                success: true,
                instanceId: instanceId,
                previousState: instanceState?.PreviousState?.Name,
                currentState: instanceState?.CurrentState?.Name
            };
        } catch (error: any) {
            console.error('Error terminating EC2 instance:', error);
            return {
                success: false,
                instanceId: instanceId,
                error: error.message || 'Unknown error occurred while terminating instance'
            };
        }
    }

    /**
     * Get details of a specific EC2 instance
     * Uses AWS SDK waiter to handle race conditions when instance is just created
     * 
     * @param instanceId - Instance ID to describe
     * @param waitForExistence - Whether to wait for instance to exist in AWS (default: true)
     * @param maxWaitTime - Maximum wait time in seconds (default: 60)
     * @returns Promise with instance details
     */
    async describeInstance(
        instanceId: string,
        waitForExistence: boolean = true,
        maxWaitTime: number = 60
    ): Promise<{
        success: boolean;
        instance?: Instance;
        error?: string;
    }> {
        try {
            if (!instanceId) {
                throw new Error('Instance ID is required');
            }

            // If waitForExistence is enabled, use AWS waiter to handle race condition
            if (waitForExistence) {
                this.logger.info(`Waiting for instance ${instanceId} to exist in AWS...`);
                
                try {
                    // Use AWS SDK waiter to wait until instance exists
                    const waiterResult = await waitUntilInstanceExists(
                        {
                            client: this.ec2Client,
                            maxWaitTime: maxWaitTime, // Maximum wait time in seconds
                            minDelay: 1, // Minimum delay between attempts (seconds)
                            maxDelay: 5  // Maximum delay between attempts (seconds)
                        },
                        { InstanceIds: [instanceId] }
                    );

                    if (waiterResult.state !== 'SUCCESS') {
                        this.logger.warn(`Instance waiter did not succeed: ${waiterResult.state}`);
                    } else {
                        this.logger.info(`Instance ${instanceId} now exists in AWS`);
                    }
                } catch (waiterError: any) {
                    // Waiter timed out or failed, but let's try to describe anyway
                    this.logger.warn(`Waiter error (will try describe anyway): ${waiterError.message}`);
                }
            }

            const params: DescribeInstancesCommandInput = {
                InstanceIds: [instanceId]
            };

            const command = new DescribeInstancesCommand(params);
            const response = await this.ec2Client.send(command);

            const instance = response.Reservations?.[0]?.Instances?.[0];
            
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            return {
                success: true,
                instance: instance
            };
        } catch (error: any) {
            this.logger.error('Error describing EC2 instance', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while describing instance'
            };
        }
    }

    async getInstanceState(instanceId: string): Promise<{
        success: boolean;
        state?: InstanceStateName;
        stateCode?: number;
        error?: string;
    }> {
        try {
            if (!instanceId) {
                throw new Error('Instance ID is required');
            }

            const result = await this.describeInstance(instanceId);
            
            if (!result.success || !result.instance) {
                return {
                    success: false,
                    error: result.error || 'Failed to get instance state'
                };
            }

            return {
                success: true,
                state: result.instance.State?.Name,
                stateCode: result.instance.State?.Code
            };
        } catch (error: any) {
            console.error('Error getting EC2 instance state:', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while getting instance state'
            };
        }
    }

    async getPublicIp(instanceId: string): Promise<{
        success: boolean;
        publicIp?: string;
        privateIp?: string;
        reason?: string;
        error?: string;
    }> {
        try {
            if (!instanceId) {
                throw new Error('Instance ID is required');
            }

            const result = await this.describeInstance(instanceId);
            
            if (!result.success || !result.instance) {
                return {
                    success: false,
                    error: result.error || 'Failed to get instance details'
                };
            }

            const instance = result.instance;
            const publicIp = instance.PublicIpAddress;
            const privateIp = instance.PrivateIpAddress;

            if (!publicIp) {
                let reason = 'No public IP assigned. Possible reasons:\n';
                reason += '1. Subnet has "Auto-assign public IPv4" disabled\n';
                reason += '2. Instance in private subnet (no Internet Gateway)\n';
                reason += '3. Instance was stopped (public IPs are ephemeral)\n';
                reason += '4. VPC/subnet routing not configured for internet access\n';
                reason += '\nPrivate IP: ' + (privateIp || 'N/A');
                
                return {
                    success: false,
                    privateIp: privateIp,
                    reason: reason
                };
            }

            return {
                success: true,
                publicIp: publicIp,
                privateIp: privateIp
            };
        } catch (error: any) {
            console.error('Error getting public IP:', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while getting public IP'
            };
        }
    }

    /**
     * Private method to get raw EC2 instances with filters
     * Used internally when raw Instance data is needed
     * @param filters - Optional filters for listing instances
     * @returns Promise with list of raw Instance objects
     */
    private async getRawInstances(filters?: {
        state?: InstanceStateName[];
        tags?: { key: string; value: string }[];
        instanceIds?: string[];
    }): Promise<{
        success: boolean;
        instances?: Instance[];
        count?: number;
        error?: string;
    }> {
        try {
            const params: DescribeInstancesCommandInput = {};

            // Build filters
            if (filters) {
                params.Filters = [];

                if (filters.state && filters.state.length > 0) {
                    params.Filters.push({
                        Name: 'instance-state-name',
                        Values: filters.state
                    });
                }

                if (filters.tags && filters.tags.length > 0) {
                    filters.tags.forEach(tag => {
                        params.Filters!.push({
                            Name: `tag:${tag.key}`,
                            Values: [tag.value]
                        });
                    });
                }

                if (filters.instanceIds && filters.instanceIds.length > 0) {
                    params.InstanceIds = filters.instanceIds;
                }
            }

            const command = new DescribeInstancesCommand(params);
            const response = await this.ec2Client.send(command);

            const instances: Instance[] = [];
            response.Reservations?.forEach(reservation => {
                if (reservation.Instances) {
                    instances.push(...reservation.Instances);
                }
            });

            return {
                success: true,
                instances: instances,
                count: instances.length
            };
        } catch (error: any) {
            console.error('Error getting raw EC2 instances:', error);
            return {
                success: false,
                error: error.message || 'Unknown error occurred while getting instances'
            };
        }
    }

        /**
     * List EC2 instances with optional filters
     * @param filters - Optional filters for listing instances
     * @returns Promise with list of instances
     */
    async listInstances(filters?: {
        state?: InstanceStateName[];
        tags?: { key: string; value: string }[];
        instanceIds?: string[];
    }): Promise<ds.Ec2Details[]> {
        try {
            // Use the private method to get raw instances
            const result = await this.getRawInstances(filters);

            if (!result.success || !result.instances) {
                console.log("error while fetching the instances");
              return  [] as any;
            }

            // Map raw instances to FreeEc2Details format
            const freeEc2Details = result.instances.map(instance => ({
                instanceId: instance.InstanceId || '',
                publicIp: instance.PublicIpAddress || '',
                publicDns: instance.PublicDnsName,
                region: instance.Placement?.AvailabilityZone || this.region,
                numberOfRunningTasks: 0,
                startedAt: new Date(),
                EC2Type : instance.InstanceType == process.env.EC2_INSTANCE_TYPE ? EC2Type.Task : EC2Type.Indexer,
                runningTaskIds: []
            }));

            return freeEc2Details as any;
        } catch (error: any) {
            console.error('Error listing EC2 instances:', error);
            return [] as any;
        }
    }

    /**
     * Helper method to create a user data script for installing common tools
     * This script also ensures SSH is configured for key-based authentication only
     * 
     * IMPORTANT: This user data script runs ONLY on first instance launch.
     * To run Docker containers on every instance start, this script creates a systemd service
     * that automatically executes the Docker startup script on every boot.
     * 
     * @param includeDocker - Include Docker installation (default: true)
     * @param includeGit - Include Git installation (default: true)
     * @param customCommands - Additional custom commands to run
     * @returns User data script as string
     */
    generateUserDataScript(
        includeDocker: boolean = true,
        includeGit: boolean = true,
        customCommands?: string[]
    ): string {
        const LOG_FILE = '/var/log/user-data.log';
        let script = '#!/bin/bash\n\n';
        
        script += '# Initialize log file\n';
        script += `LOG_FILE="${LOG_FILE}"\n`;
        script += 'echo "===========================================" >> $LOG_FILE\n';
        script += 'echo "User Data Script Started: $(date)" >> $LOG_FILE\n';
        script += 'echo "===========================================" >> $LOG_FILE\n\n';
        
        script += '# Update system packages\n';
        script += 'echo "[$(date)] Updating system packages..." >> $LOG_FILE\n';
        script += 'sudo apt-get update -y >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] System packages updated successfully" >> $LOG_FILE\n\n';

        script += '# Ensure SSH is configured for key-based authentication only (no password)\n';
        script += 'echo "[$(date)] Configuring SSH for key-based authentication..." >> $LOG_FILE\n';
        script += 'sudo sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/g" /etc/ssh/sshd_config >> $LOG_FILE 2>&1\n';
        script += 'sudo sed -i "s/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/g" /etc/ssh/sshd_config >> $LOG_FILE 2>&1\n';
        script += 'sudo sed -i "s/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/g" /etc/ssh/sshd_config >> $LOG_FILE 2>&1\n';
        script += 'sudo systemctl restart sshd >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] SSH configuration completed" >> $LOG_FILE\n\n';

        if (includeGit) {
            script += '# Install Git\n';
            script += 'echo "[$(date)] Installing Git..." >> $LOG_FILE\n';
            script += 'sudo apt-get install -y git >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Git installed successfully" >> $LOG_FILE\n\n';
        }

        // Install Node.js and TypeScript
        script+= '#installing ripgrep command';
        script+='sudo apt install ripgrep';
        script += '# Install Node.js (LTS version)\n';
        script += 'echo "[$(date)] Installing Node.js LTS..." >> $LOG_FILE\n';
        script += 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - >> $LOG_FILE 2>&1\n';
        script += 'sudo apt-get install -y nodejs >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] Node.js installed successfully" >> $LOG_FILE\n\n';
        
        script += '# Install TypeScript globally\n';
        script += 'echo "[$(date)] Installing TypeScript and ts-node..." >> $LOG_FILE\n';
        script += 'sudo npm install -g typescript >> $LOG_FILE 2>&1\n';
        script += 'sudo npm install -g ts-node >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] TypeScript installed successfully" >> $LOG_FILE\n\n';
        
        script += '# Verify installations\n';
        script += 'echo "[$(date)] Verifying installations..." >> $LOG_FILE\n';
        script += 'echo "Node version: $(node --version)" >> $LOG_FILE 2>&1\n';
        script += 'echo "NPM version: $(npm --version)" >> $LOG_FILE 2>&1\n';
        script += 'echo "TypeScript version: $(tsc --version)" >> $LOG_FILE 2>&1\n\n';

        if (includeDocker) {
            script += '# Install Docker\n';
            script += 'echo "[$(date)] Installing Docker dependencies..." >> $LOG_FILE\n';
            script += 'sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Adding Docker GPG key..." >> $LOG_FILE\n';
            script += 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add - >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Adding Docker repository..." >> $LOG_FILE\n';
            script += 'sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Updating package list..." >> $LOG_FILE\n';
            script += 'sudo apt-get update -y >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Installing Docker CE..." >> $LOG_FILE\n';
            script += 'sudo apt-get install -y docker-ce docker-ce-cli containerd.io >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Starting Docker service..." >> $LOG_FILE\n';
            script += 'sudo systemctl start docker >> $LOG_FILE 2>&1\n';
            script += 'sudo systemctl enable docker >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Adding ubuntu user to docker group..." >> $LOG_FILE\n';
            script += 'sudo usermod -aG docker ubuntu >> $LOG_FILE 2>&1\n';
            script += 'echo "[$(date)] Docker installation completed" >> $LOG_FILE\n\n';
            
        //     script += '# Create Docker startup script that runs on every boot\n';
        //     script += 'sudo cat > /usr/local/bin/docker-startup.sh << \'DOCKER_SCRIPT_EOF\'\n';
        //     script += this.generateDockerStartupScript();
        //     script += 'DOCKER_SCRIPT_EOF\n\n';
            
        //     script += '# Make the Docker startup script executable\n';
        //     script += 'sudo chmod +x /usr/local/bin/docker-startup.sh\n\n';
            
        //     script += '# Create systemd service to run Docker startup script on every boot\n';
        //     script += 'sudo cat > /etc/systemd/system/docker-containers.service << \'SERVICE_EOF\'\n';
        //     script += '[Unit]\n';
        //     script += 'Description=Start Docker Containers on Boot\n';
        //     script += 'After=docker.service\n';
        //     script += 'Requires=docker.service\n';
        //     script += '\n';
        //     script += '[Service]\n';
        //     script += 'Type=oneshot\n';
        //     script += 'ExecStart=/usr/local/bin/docker-startup.sh\n';
        //     script += 'RemainAfterExit=yes\n';
        //     script += '\n';
        //     script += '[Install]\n';
        //     script += 'WantedBy=multi-user.target\n';
        //     script += 'SERVICE_EOF\n\n';
            
        //     script += '# Enable the systemd service to run on every boot\n';
        //     script += 'sudo systemctl daemon-reload\n';
        //     script += 'sudo systemctl enable docker-containers.service\n\n';
         }
         script += 'sudo git config --global core.autocrlf false\n\n';
         script+= 'sudo git config --global core.safecrlf false\n\n';
         script+= 'sudo git config --global core.filemode false\n\n';
        script += '# Install NFS client for EFS mounting\n';
        script += 'echo "[$(date)] Installing NFS client..." >> $LOG_FILE\n';
        script += 'sudo apt-get install -y nfs-common >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] NFS client installed successfully" >> $LOG_FILE\n\n';

        script += '# Create mount directories for EFS\n';
        script += 'echo "[$(date)] Creating EFS mount directories..." >> $LOG_FILE\n';
        script += 'sudo mkdir -p /mnt/efs1 >> $LOG_FILE 2>&1\n';
        script += 'sudo mkdir -p /mnt/efs2 >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] EFS mount directories created" >> $LOG_FILE\n\n';

        script += '# Mount EFS volumes\n';
        script += `EFS1_ID="${process.env.EFS1_ID || ''}"\n`;
        script += `EFS2_ID="${process.env.EFS2_ID || ''}"\n`;
        script += 'AWS_REGION="' + this.region + '"\n\n';

        script += 'if [ -n "$EFS1_ID" ]; then\n';
        script += '  echo "[$(date)] Mounting EFS1: $EFS1_ID" >> $LOG_FILE\n';
        script += '  sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport $EFS1_ID.efs.$AWS_REGION.amazonaws.com:/ /mnt/efs1 >> $LOG_FILE 2>&1\n';
        script += '  echo "$EFS1_ID.efs.$AWS_REGION.amazonaws.com:/ /mnt/efs1 nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" | sudo tee -a /etc/fstab >> $LOG_FILE 2>&1\n';
        script += '  echo "[$(date)] EFS1 mounted successfully" >> $LOG_FILE\n';
        script += 'else\n';
        script += '  echo "[$(date)] EFS1_ID not provided, skipping EFS1 mount" >> $LOG_FILE\n';
        script += 'fi\n\n';

        script += 'if [ -n "$EFS2_ID" ]; then\n';
        script += '  echo "[$(date)] Mounting EFS2: $EFS2_ID" >> $LOG_FILE\n';
        script += '  sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport $EFS2_ID.efs.$AWS_REGION.amazonaws.com:/ /mnt/efs2 >> $LOG_FILE 2>&1\n';
        script += '  echo "$EFS2_ID.efs.$AWS_REGION.amazonaws.com:/ /mnt/efs2 nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" | sudo tee -a /etc/fstab >> $LOG_FILE 2>&1\n';
        script += '  echo "[$(date)] EFS2 mounted successfully" >> $LOG_FILE\n';
        script += 'else\n';
        script += '  echo "[$(date)] EFS2_ID not provided, skipping EFS2 mount" >> $LOG_FILE\n';
        script += 'fi\n\n';

        script += '# Set permissions for EFS mount points\n';
        script += 'echo "[$(date)] Setting permissions for EFS mount points..." >> $LOG_FILE\n';
        script += 'sudo chmod 777 /mnt/efs1 >> $LOG_FILE 2>&1\n';
        script += 'sudo chmod 777 /mnt/efs2 >> $LOG_FILE 2>&1\n';
        script += 'echo "[$(date)] Permissions set successfully" >> $LOG_FILE\n\n';
        
        script += '# starting the tool server for AI Coder\n';
        script += 'echo "[$(date)] Starting AI Coder tool server..." >> $LOG_FILE\n';
        script += 'cd /mnt/efs2/Utilities/Tool-server && sudo npm run tool-server >> $LOG_FILE 2>&1 &\n';
        script += 'echo "[$(date)] Tool server started in background (PID: $!)" >> $LOG_FILE\n\n';
        
        script  += '# starting the file server for the UI to get the files from the ec2\n';
        script += 'echo "[$(date)] Starting file server..." >> $LOG_FILE\n';
        script += 'cd /mnt/efs2/Utilities/file-server/AI_CODER_FILE_SERVER && sudo npm run start-file-server >> $LOG_FILE 2>&1 &\n';
        script += 'echo "[$(date)] File server started in background (PID: $!)" >> $LOG_FILE\n\n';

        if (customCommands && customCommands.length > 0) {
            script += '# Custom commands\n';
            script += 'echo "[$(date)] Executing custom commands..." >> $LOG_FILE\n';
            customCommands.forEach(cmd => {
                script += `echo "[$(date)] Running: ${cmd}" >> $LOG_FILE\n`;
                script += `${cmd} >> $LOG_FILE 2>&1\n`;
            });
            script += 'echo "[$(date)] Custom commands completed" >> $LOG_FILE\n\n';
        }

        script += '# Log completion\n';
        script += 'echo "===========================================" >> $LOG_FILE\n';
        script += 'echo "User data script completed at $(date)" >> $LOG_FILE\n';
        script += 'echo "===========================================" >> $LOG_FILE\n\n';
        
        script += '# Create completion marker file\n';
        script += 'echo "[$(date)] Creating completion marker file..." >> $LOG_FILE\n';
        script += 'sudo touch /var/lib/cloud/instance/user-data-finished\n';
        script += 'echo "COMPLETED_AT=$(date +%s)" | sudo tee /var/lib/cloud/instance/user-data-finished\n';
        script += 'echo "[$(date)] User data script FULLY COMPLETED" >> $LOG_FILE\n';

        return script;
    }

    /**
     * Generate security group rules for SSH access
     * Creates an ingress rule to allow SSH (port 22) from specified CIDR blocks
     * 
     * @param allowedCidrBlocks - Array of CIDR blocks to allow SSH from (default: ['0.0.0.0/0'] - all IPs)
     *                            For security, specify your IP: ['your.ip.address/32']
     * @returns Security group rule configuration for SSH
     */
    getSSHSecurityGroupRule(allowedCidrBlocks: string[] = ['0.0.0.0/0']) {
        return {
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            IpRanges: allowedCidrBlocks.map(cidr => ({ CidrIp: cidr, Description: 'SSH access' }))
        };
    }

    /**
     * Get SSH connection command for an instance
     * Helper method to generate the correct SSH command
     * 
     * @param instancePublicIp - Public IP address of the instance
     * @param keyPath - Path to the SSH private key f
     * le (.pem)
     * @param username - SSH username (default: 'ubuntu' for Ubuntu AMIs)
     * @returns SSH connection command string\     * 
     * Example usage:
     * const sshCommand = ec2Service.getSSHCommand('54.123.45.67', '~/.ssh/my-key.pem');
     * // Returns: ssh -i ~/.ssh/my-key.pem ubuntu@54.123.45.67
     */
    getSSHCommand(instancePublicIp: string, keyPath: string, username: string = 'ubuntu'): string {
        return `ssh -i ${keyPath} ${username}@${instancePublicIp}`;
    }

    /**
     * Get the default SSH username for common AMI types
     * 
     * @param amiName - Name or description of the AMI
     * @returns Default username for the AMI type
     */
    getDefaultUsername(amiName: string): string {
        const lowerName = amiName.toLowerCase();
        
        if (lowerName.includes('ubuntu')) return 'ubuntu';
        if (lowerName.includes('amazon') || lowerName.includes('amzn')) return 'ec2-user';
        if (lowerName.includes('redhat') || lowerName.includes('rhel')) return 'ec2-user';
        if (lowerName.includes('centos')) return 'centos';
        if (lowerName.includes('debian')) return 'admin';
        if (lowerName.includes('suse')) return 'ec2-user';
        if (lowerName.includes('fedora')) return 'fedora';
        
        // Default to ubuntu if unknown
        return 'ubuntu';
    }

    /**
     * Wait for instance to reach a specific state
     * @param instanceId - Instance ID to wait for
     * @param targetState - Target state to wait for
     * @param timeoutMs - Timeout in milliseconds (default: 300000 - 5 minutes)
     * @param pollIntervalMs - Polling interval in milliseconds (default: 5000)
     * @returns Promise with result
     */
    async waitForInstanceState(
        instanceId: string,
        targetState: InstanceStateName,
        timeoutMs: number = 300000,
        pollIntervalMs: number = 5000
    ): Promise<{
        success: boolean;
        currentState?: string;
        error?: string;
    }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const result = await this.describeInstance(instanceId);

            if (!result.success) {
                return {
                    success: false,
                    error: result.error
                };
            }

            const currentState = result.instance?.State?.Name;
            
            if (currentState === targetState) {
                return {
                    success: true,
                    currentState: currentState
                };
            }

            // Wait before next poll
            await this.delay(pollIntervalMs);
        }

        return {
            success: false,
            error: `Timeout waiting for instance to reach state: ${targetState}`
        };
    }


    /**
     * Wait for UserData script to complete execution
     * Polls the instance via SSH to check for the completion marker file
     * 
     * Enhanced with:
     * - Port reachability check before SSH attempts
     * - Configurable SSH retry attempts for initial boot phase
     * - Exponential backoff for connection attempts
     * - Better error categorization and logging
     * 
     * @param instancePublicIp - Public IP address of the instance
     * @param timeoutMs - Timeout in milliseconds (default: 600000 - 10 minutes)
     * @param pollIntervalMs - Polling interval in milliseconds (default: 10000 - 10 seconds)
     * @returns Promise with result
     */
    async waitForUserDataCompletion(
        instancePublicIp: string,
        timeoutMs: number = 600000,
        pollIntervalMs: number = 10000
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
        duration?: number;
    }> {
        const startTime = Date.now();
        let sshPortReached = false;
        let consecutiveSSHFailures = 0;
        
        this.logger.info(`[UserData] Waiting for script completion on ${instancePublicIp}...`);
        this.logger.info(`[UserData] Timeout: ${Math.floor(timeoutMs/1000)}s, Poll interval: ${Math.floor(pollIntervalMs/1000)}s`);
        
        // Import SSH client
        const SSHClient = require('./ssh-client');
        
        while (Date.now() - startTime < timeoutMs) {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            
            try {
                // First, check if SSH port is reachable (lightweight check)
                if (!sshPortReached) {
                  //  this.logger.info(`[UserData] [${elapsed}s] Checking if SSH port (22) is reachable...`);
                    const tempSSH = new SSHClient('/tmp', instancePublicIp, {
                        maxReconnectAttempts: 1,
                        reconnectDelay: 1000
                    });
                    
                    const portReachable = await tempSSH.isPortReachable(5000);
                    
                    if (!portReachable) {
                        this.logger.warn(`[UserData] [${elapsed}s] SSH port not reachable yet, will retry...`);
                        await this.delay(pollIntervalMs);
                        continue;
                    }
                    
                  //  this.logger.info(`[UserData] [${elapsed}s] ✅ SSH port is reachable!`);
                    sshPortReached = true;
                }
                
                // Now attempt SSH connection with higher retry count for initial phase
                // During EC2 boot, SSH service might restart multiple times
                const sshOptions = {
                    maxReconnectAttempts: 15, // Increased from 5 to 15
                    reconnectDelay: 5000, // 5 seconds base delay
                    useExponentialBackoff: true, // Enable exponential backoff
                    readyTimeout: 30000 // 30 second timeout for connection
                };
                
                const ssh = new SSHClient('/tmp', instancePublicIp, sshOptions);
                
                try {
                  //  this.logger.info(`[UserData] [${elapsed}s] Attempting SSH connection...`);
                    const connectResult = await ssh.connect();
                    
                    // Check if connection failed
                    if (connectResult && connectResult.success === false) {
                        consecutiveSSHFailures++;
                        this.logger.warn(`[UserData] [${elapsed}s] SSH connection failed (attempt ${consecutiveSSHFailures}): ${connectResult.error}`);
                        
                        // If we have too many consecutive failures, reset port reachability flag
                        if (consecutiveSSHFailures >= 5) {
                            this.logger.warn(`[UserData] [${elapsed}s] Too many SSH failures, will recheck port reachability...`);
                            sshPortReached = false;
                            consecutiveSSHFailures = 0;
                        }
                        
                        await this.delay(pollIntervalMs);
                        continue;
                    }
                    
                    // Connection successful, reset failure counter
                    consecutiveSSHFailures = 0;
                    this.logger.info(`[UserData] [${elapsed}s] ✅ SSH connected successfully!`);
                    
                    // Check if completion marker file exists
                   // this.logger.info(`[UserData] [${elapsed}s] Checking for UserData completion marker...`);
                    const result = await ssh.executeCommand(
                        'test -f /var/lib/cloud/instance/user-data-finished && echo "COMPLETED" || echo "NOT_COMPLETED"'
                    );
                    
                    if (result.output.trim() === 'COMPLETED') {
                        const duration = Date.now() - startTime;
                        this.logger.info(`[UserData] ✅ Script completed! Duration: ${Math.floor(duration / 1000)}s`);
                        
                        // Get completion timestamp
                        const completionInfo = await ssh.executeCommand(
                            'cat /var/lib/cloud/instance/user-data-finished 2>/dev/null || echo "No timestamp"'
                        );
                        
                        ssh.disconnect();
                        
                        return {
                            success: true,
                            message: `UserData script completed successfully in ${Math.floor(duration / 1000)} seconds. Completion info: ${completionInfo.output.trim()}`,
                            duration: duration
                        };
                    } else {
                        this.logger.info(`[UserData] [${elapsed}s] ⏳ UserData script still running...`);
                    }
                    
                    ssh.disconnect();
                } catch (sshError: any) {
                    consecutiveSSHFailures++;
                    // SSH connection might fail initially while instance is booting
                    this.logger.warn(`[UserData] [${elapsed}s] 🔌 SSH error (attempt ${consecutiveSSHFailures}): ${sshError.message || String(sshError)}`);
                    
                    // If too many failures, reset port check
                    if (consecutiveSSHFailures >= 5) {
                        this.logger.warn(`[UserData] [${elapsed}s] Resetting port reachability check due to repeated failures`);
                        sshPortReached = false;
                        consecutiveSSHFailures = 0;
                    }
                }
                
            } catch (error: any) {
                this.logger.warn(`[UserData] [${elapsed}s] ⚠️  Polling error (will retry): ${error.message || String(error)}`);
            }
            
            // Use dynamic wait time based on whether we've reached SSH or not
            const waitTime = sshPortReached ? pollIntervalMs : Math.min(pollIntervalMs, 5000);
            this.logger.info(`[UserData] [${elapsed}s] Waiting ${waitTime}ms before next poll...`);
            await this.delay(waitTime);
        }
        
        // Timeout reached
        const duration = Date.now() - startTime;
        this.logger.error(`[UserData] ❌ Timeout after ${Math.floor(duration / 1000)}s`);
        this.logger.error(`[UserData] SSH port reached: ${sshPortReached}, Consecutive failures: ${consecutiveSSHFailures}`);
        return {
            success: false,
            error: `Timeout waiting for UserData script completion after ${Math.floor(duration / 1000)} seconds. SSH port reached: ${sshPortReached}`,
            duration: duration
        };
    }


    /**
     * Generate Docker startup script that runs Docker containers
     * This script is designed to be executed on every instance boot via systemd service
     * 
     * The script will:
     * - Wait for Docker daemon to be ready
     * - Pull latest Docker images from registry
     * - Stop and remove existing containers
     * - Start new containers with specified configurations
     * - Log the completion
     * 
     * @returns Shell script as string to start Docker containers
     */
    generateDockerStartupScript(): string {
        let script = '#!/bin/bash\n\n';
        
        script += '# Docker container startup script\n';
        script += '# This script runs on every instance boot\n\n';
        
        script += '# Wait for Docker to be ready\n';
        script += 'while ! docker info >/dev/null 2>&1; do\n';
        script += '    echo "Waiting for Docker to start..."\n';
        script += '    sleep 2\n';
        script += 'done\n\n';
        
        script += '# Pull Docker images (customize these with your actual images)\n';
        script += 'echo "Pulling Docker images..."\n';
        script += '# docker pull your-registry/image1:latest\n';
        script += '# docker pull your-registry/image2:latest\n';
        script += '# docker pull your-registry/image3:latest\n\n';
        
        script += '# Stop and remove existing containers if they exist\n';
        script += 'echo "Cleaning up old containers..."\n';
        script += '# docker stop container1 2>/dev/null || true\n';
        script += '# docker rm container1 2>/dev/null || true\n';
        script += '# docker stop container2 2>/dev/null || true\n';
        script += '# docker rm container2 2>/dev/null || true\n\n';
        
        script += '# Start Docker containers (customize these with your actual containers)\n';
        script += 'echo "Starting Docker containers..."\n';
        script += '# docker run -d --name container1 --restart=always -p 8080:8080 your-registry/image1:latest\n';
        script += '# docker run -d --name container2 --restart=always -p 8081:8081 your-registry/image2:latest\n\n';
        
        script += '# Verify containers are running\n';
        script += 'echo "Docker containers status:"\n';
        script += 'docker ps\n\n';
        
        script += '# Log completion\n';
        script += 'echo "Docker startup script completed at $(date)" >> /var/log/docker-startup.log\n';
        
        return script;
    }
}
