import { MongoDBClient } from './MongoDBClient';
import { DatabaseService } from './DatabaseService';
import { IRepository } from './Repository';
import { CollectionNames } from './models/Collections';
import { EC2Metrics, Tag, ResourceType } from './models/usageMetrics';
import { EC2MetricsAggregation, GroupedByType } from './models/aggregatedMetrics';
import { EC2Information, c5xlarge, c5a2xlarge } from './models/EC2Information';
import { Logger } from '../utils/Logger';
import { ObjectId, OptionalUnlessRequiredId } from 'mongodb';
import * as ds from './../DataStructures'
/**
 * Service for tracking and storing EC2 usage metrics and costs
 */
export class EC2MetricsService {
    private static instance: EC2MetricsService;
    private client: MongoDBClient;
    private dbService: DatabaseService;
    private logger: Logger;
    private DB_NAME: string; // Database for all usage metrics
    private repository: IRepository<EC2Metrics> | null = null;
    private aggregationRepository: IRepository<EC2MetricsAggregation> | null = null;

    public constructor(dbName: string) {
        this.client = MongoDBClient.getInstance();
        this.dbService = DatabaseService.getInstance();
        this.logger = new Logger('EC2MetricsService');
        this.DB_NAME = dbName;
    }

    /**
     * Get the repository for EC2 metrics
     */
    private getRepository(): IRepository<EC2Metrics> {
        if (!this.repository) {
            this.repository = this.dbService.getRepository<EC2Metrics>(
                this.DB_NAME,
                CollectionNames.EC2_METRICS
            );
        }
        return this.repository;
    }


    /**
     * Get the repository for EC2 metrics aggregation
     */
    private getAggregationRepository(): IRepository<EC2MetricsAggregation> {
        if (!this.aggregationRepository) {
            this.aggregationRepository = this.dbService.getRepository<EC2MetricsAggregation>(
                this.DB_NAME,
                CollectionNames.EC2_METRICS_AGGREGATION
            );
        }
        return this.aggregationRepository;
    }

    /**
     * Initialize the EC2 metrics collection (time series)
     */
    public async initialize(): Promise<void> {
        try {
            await this.client.ensureTimeSeriesCollection(this.DB_NAME, CollectionNames.EC2_METRICS);
            this.logger.success('EC2 Metrics collection initialized');
        } catch (error) {
            this.logger.error('Failed to initialize EC2 Metrics collection', error);
        }
    }

    /**
     * Calculate EC2 cost based on usage time and instance type
     * @param usageTime Usage time in minutes
     * @param ec2Info EC2 instance pricing information
     * @returns Calculated cost in dollars
     */
    private calculateCost(usageTime: number, ec2Info: EC2Information): number {
        // Convert minutes to hours and calculate cost
        const usageHours = usageTime / 60;
        const cost = usageHours * ec2Info.per_hour_cost;
        return (cost/2);
    }

    /**
     * Get EC2 instance info by type
     * @param ec2Type EC2 instance type identifier
     * @returns EC2Information object with pricing details
     */
    private getEC2Info(ec2Type: ds.EC2Type): EC2Information {
        // Map EC2 types to their pricing
        switch (ec2Type) {
            case ds.EC2Type.Task:
                return c5xlarge;
            case ds.EC2Type.Indexer:
                return c5a2xlarge;
            default:
                // Default fallback to c5.xlarge
                this.logger.warn(`Unknown EC2 type: ${ec2Type}, defaulting to c5.xlarge`);
                return c5xlarge;
        }
    }

    /**
     * Track and store EC2 usage metrics
     * @param params Tracking parameters
     */
    public async trackUsage(params: {
        ec2InstanceId: string;
        ec2Type: ds.EC2Type;
        usageTime: number; // in minutes
        userId: string;
        organizationId: string;
        userName:string;
        groupedName:string;
        taskId?: string;
        wpId?: string;
    }): Promise<void> {
        try {
            this.initialize();
            const { ec2InstanceId, ec2Type, usageTime, userId, organizationId, taskId, wpId } = params;

            // Get EC2 pricing info
            const ec2Info = this.getEC2Info(ec2Type);

            // Calculate cost
            const netCost = this.calculateCost(usageTime, ec2Info);

            // Prepare tags
            const tags: Tag = {
                organizationId: organizationId,
                userId: userId,
                resourceType: ResourceType.EC2
            };

            // Prepare metrics document
            const metricsDoc: OptionalUnlessRequiredId<EC2Metrics> = {
                timestamp: new Date(),
                tags: tags,
                TaskId: taskId || '',
                wpId: wpId || '',
                ec2_instance_id: ec2InstanceId,
                usageTime: usageTime,
                ec2_type: ec2Type,
                net_ec2_cost: netCost
            } as any;

            // Insert using repository pattern
            const repo = this.getRepository();
            let result = await repo.insertOne(metricsDoc);
            if(result.acknowledged)
            {
                this.logger.success("successfully tracked EC2 details=>",metricsDoc);
            }
            this.logger.info('EC2 usage tracked', {
                taskId,
                wpId,
                userId,
                instanceId: ec2InstanceId,
                cost: netCost.toFixed(6),
                usageTime: usageTime,
                ec2Type: ec2Type
            });
        } catch (error) {
            this.logger.error('Failed to track EC2 usage', error);
            // Don't throw - we don't want to break the main flow if metrics tracking fails
        }
    }

    /**
     * Get usage metrics for a specific user
     * @param userId User ID
     * @param startDate Start date for filtering
     * @param endDate End date for filtering
     */
    public async getUserMetrics(userId: string, startDate?: Date, endDate?: Date): Promise<any[]> {
        try {
            const repo = this.getRepository();
            
            const filter: any = {
                'tags.userId': userId
            };

            if (startDate || endDate) {
                filter.timestamp = {};
                if (startDate) filter.timestamp.$gte = startDate;
                if (endDate) filter.timestamp.$lte = endDate;
            }

            const metrics = await repo.find(filter);
            return metrics;
        } catch (error) {
            this.logger.error('Failed to get user metrics', error);
            return [];
        }
    }

    /**
     * Get aggregated cost for a user
     * @param userId User ID
     * @param startDate Start date for filtering
     * @param endDate End date for filtering
     */
    public async getUserTotalCost(userId: string, startDate?: Date, endDate?: Date): Promise<number> {
        try {
            const metrics = await this.getUserMetrics(userId, startDate, endDate);
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_ec2_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get user total cost', error);
            return 0;
        }
    }

    /**
     * Get aggregated usage time for a user (in minutes)
     * @param userId User ID
     * @param startDate Start date for filtering
     * @param endDate End date for filtering
     */
    public async getUserTotalUsageTime(userId: string, startDate?: Date, endDate?: Date): Promise<number> {
        try {
            const metrics = await this.getUserMetrics(userId, startDate, endDate);
            const totalTime = metrics.reduce((sum, metric) => sum + (metric.usageTime || 0), 0);
            return totalTime;
        } catch (error) {
            this.logger.error('Failed to get user total usage time', error);
            return 0;
        }
    }

    /**
     * Get aggregated cost for an organization
     * @param organizationId Organization ID
     * @param startDate Start date for filtering
     * @param endDate End date for filtering
     */
    public async getOrganizationTotalCost(organizationId: string, startDate?: Date, endDate?: Date): Promise<number> {
        try {
            const repo = this.getRepository();
            
            const filter: any = {
                'tags.organizationId': organizationId
            };

            if (startDate || endDate) {
                filter.timestamp = {};
                if (startDate) filter.timestamp.$gte = startDate;
                if (endDate) filter.timestamp.$lte = endDate;
            }

            const metrics = await repo.find(filter);
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_ec2_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get organization total cost', error);
            return 0;
        }
    }

    /**
     * Get task-specific metrics
     * @param taskId Task ID
     */
    public async getTaskMetrics(taskId: string): Promise<any[]> {
        try {
            const repo = this.getRepository();
            const metrics = await repo.find({ TaskId: taskId } as any);
            return metrics;
        } catch (error) {
            this.logger.error('Failed to get task metrics', error);
            return [];
        }
    }

    /**
     * Get total cost for a task
     * @param taskId Task ID
     */
    public async getTaskTotalCost(taskId: string): Promise<number> {
        try {
            const metrics = await this.getTaskMetrics(taskId);
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_ec2_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get task total cost', error);
            return 0;
        }
    }

    /**
     * Get total usage time for a task (in minutes)
     * @param taskId Task ID
     */
    public async getTaskTotalUsageTime(taskId: string): Promise<number> {
        try {
            const metrics = await this.getTaskMetrics(taskId);
            const totalTime = metrics.reduce((sum, metric) => sum + (metric.usageTime || 0), 0);
            return totalTime;
        } catch (error) {
            this.logger.error('Failed to get task total usage time', error);
            return 0;
        }
    }

    /**
     * Get workspace-specific metrics
     * @param wpId Workspace ID
     */
    public async getWorkspaceMetrics(wpId: string): Promise<any[]> {
        try {
            const repo = this.getRepository();
            const metrics = await repo.find({ wpId: wpId } as any);
            return metrics;
        } catch (error) {
            this.logger.error('Failed to get workspace metrics', error);
            return [];
        }
    }

    /**
     * Get total cost for a workspace
     * @param wpId Workspace ID
     */
    public async getWorkspaceTotalCost(wpId: string): Promise<number> {
        try {
            const metrics = await this.getWorkspaceMetrics(wpId);
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_ec2_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get workspace total cost', error);
            return 0;
        }
    }

    /**
     * Get total usage time for a workspace (in minutes)
     * @param wpId Workspace ID
     */
    public async getWorkspaceTotalUsageTime(wpId: string): Promise<number> {
        try {
            const metrics = await this.getWorkspaceMetrics(wpId);
            const totalTime = metrics.reduce((sum, metric) => sum + (metric.usageTime || 0), 0);
            return totalTime;
        } catch (error) {
            this.logger.error('Failed to get workspace total usage time', error);
            return 0;
        }
    }

    /**
     * Get metrics for a specific EC2 instance
     * @param ec2InstanceId EC2 Instance ID
     * @param startDate Start date for filtering
     * @param endDate End date for filtering
     */
    public async getInstanceMetrics(ec2InstanceId: string, startDate?: Date, endDate?: Date): Promise<any[]> {
        try {
            const repo = this.getRepository();
            
            const filter: any = {
                ec2_instance_id: ec2InstanceId
            };

            if (startDate || endDate) {
                filter.timestamp = {};
                if (startDate) filter.timestamp.$gte = startDate;
                if (endDate) filter.timestamp.$lte = endDate;
            }

            const metrics = await repo.find(filter);
            return metrics;
        } catch (error) {
            this.logger.error('Failed to get instance metrics', error);
            return [];
        }
    }

    /**
     * Get total cost for a specific EC2 instance
     * @param ec2InstanceId EC2 Instance ID
     * @param startDate Start date for filtering
     * @param endDate End date for filtering
     */
    public async getInstanceTotalCost(ec2InstanceId: string, startDate?: Date, endDate?: Date): Promise<number> {
        try {
            const metrics = await this.getInstanceMetrics(ec2InstanceId, startDate, endDate);
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_ec2_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get instance total cost', error);
            return 0;
        }
    }

    /**
     * Get metrics with aggregation using repository's aggregate method
     * @param pipeline Aggregation pipeline
     */
    public async getAggregatedMetrics(pipeline: any[]): Promise<any[]> {
        try {
            const repo = this.getRepository();
            return await repo.aggregate(pipeline);
        } catch (error) {
            this.logger.error('Failed to get aggregated metrics', error);
            return [];
        }
    }



    /**
     * Aggregate EC2 metrics for a given time period and save to aggregation collection
     * Logic: Group by whichever field is not empty (TaskId or wpId)
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async aggregateAndSave(startDate: Date, endDate: Date): Promise<{ success: boolean; aggregatedCount: number; error?: string }> {
        try {
            const repo = this.getRepository();
            const aggRepo = this.getAggregationRepository();

            // Build aggregation pipeline
            // Logic: Use TaskId if not empty, else use wpId
            const pipeline = [
                // Stage 1: Filter by time range
                {
                    $match: {
                        timestamp: {
                            $gte: startDate,
                            $lte: endDate
                        },
                        $or: [
                            { TaskId: { $exists: true, $ne: '' } },
                            { wpId: { $exists: true, $ne: '' } }
                        ]
                    }
                },
                // Stage 2: Add computed field for grouping logic
                {
                    $addFields: {
                        groupByField: {
                            $cond: {
                                // If TaskId is not empty, use TaskId
                                if: { $and: [{ $ne: ['$TaskId', ''] }, { $ne: ['$TaskId', null] }] },
                                then: { type: 'TaskId', value: '$TaskId' },
                                // Otherwise use wpId
                                else: { type: 'wpId', value: '$wpId' }
                            }
                        }
                    }
                },
                // Stage 3: Group by the computed field
                {
                    $group: {
                        _id: {
                            type: '$groupByField.type',
                            value: '$groupByField.value',
                            userId: '$tags.userId',
                            organizationId: '$tags.organizationId'
                        },
                        totalCost: { $sum: '$net_ec2_cost' },
                        totalUsageTime: { $sum: '$usageTime' },
                        instanceCount: { $sum: 1 },
                        uniqueInstances: { $addToSet: '$ec2_instance_id' },
                        ec2Types: { $addToSet: '$ec2_type' },
                        firstTimestamp: { $min: '$timestamp' },
                        lastTimestamp: { $max: '$timestamp' }
                    }
                }
            ];

            const results = await repo.aggregate(pipeline);

            // Save aggregated results to aggregation collection
            let aggregatedCount = 0;
            for (const result of results) {
                const aggregationDoc: OptionalUnlessRequiredId<EC2MetricsAggregation> = {
                    aggregationPeriod: {
                        startDate: startDate,
                        endDate: endDate
                    },
                    groupedBy: result._id.type as GroupedByType,
                    groupedId: result._id.value,
                    userId: result._id.userId,
                    organizationId: result._id.organizationId,
                    totalCost: result.totalCost,
                    totalUsageTime: result.totalUsageTime,
                    instanceCount: result.instanceCount,
                    uniqueInstances: result.uniqueInstances,
                    ec2Types: result.ec2Types,
                    firstTimestamp: result.firstTimestamp,
                    lastTimestamp: result.lastTimestamp,
                    createdAt: new Date(),
                    updatedAt: new Date()
                } as any;

                // Check if aggregation already exists for this period and groupedId
                const existing = await aggRepo.findOne({
                    'aggregationPeriod.startDate': startDate,
                    'aggregationPeriod.endDate': endDate,
                    groupedId: result._id.value,
                    userId: result._id.userId,
                    organizationId: result._id.organizationId
                } as any);

                if (existing) {
                    // Overwrite existing
                    await aggRepo.updateOne(
                        { _id: existing._id } as any,
                        { $set: { ...aggregationDoc, updatedAt: new Date() } } as any
                    );
                } else {
                    // Insert new
                    await aggRepo.insertOne(aggregationDoc);
                }

                aggregatedCount++;
            }
            return { success: true, aggregatedCount };
        } catch (error) {
            this.logger.error('Failed to aggregate EC2 metrics', error);
            return {
                success: false,
                aggregatedCount: 0,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get aggregated EC2 metrics data (already saved in aggregation collection)
     * @param startDate Optional start date filter
     * @param endDate Optional end date filter
     * @param groupedId Optional specific TaskId or wpId
     */
    public async getAggregatedData(
        startDate?: Date,
        endDate?: Date,
        groupedId?: string
    ): Promise<EC2MetricsAggregation[]> {
        try {
            const aggRepo = this.getAggregationRepository();
            const filter: any = {};

            if (startDate) {
                filter['aggregationPeriod.startDate'] = { $gte: startDate };
            }
            if (endDate) {
                filter['aggregationPeriod.endDate'] = { $lte: endDate };
            }
            if (groupedId) {
                filter.groupedId = groupedId;
            }

            const results = await aggRepo.find(filter);
            return results;
        } catch (error) {
            this.logger.error('Failed to get aggregated EC2 data', error);
            return [];
        }
    }

    /**
     * Re-aggregate: Delete existing aggregations for the period and create new ones
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async reAggregate(startDate: Date, endDate: Date): Promise<{ success: boolean; error?: string }> {
        try {
            const aggRepo = this.getAggregationRepository();

            // Delete existing aggregations for this period
            await aggRepo.deleteMany({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            this.logger.info('Deleted existing EC2 aggregations for period', { startDate, endDate });

            // Create new aggregations
            const result = await this.aggregateAndSave(startDate, endDate);
            return result;
        } catch (error) {
            this.logger.error('Failed to re-aggregate EC2 metrics', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }
}

export default EC2MetricsService;
