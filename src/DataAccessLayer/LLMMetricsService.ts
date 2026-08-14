import { MongoDBClient } from './MongoDBClient';
import { DatabaseService } from './DatabaseService';
import { IRepository } from './Repository';
import { CollectionNames } from './models/Collections';
import { llmMetrics, Tag, ResourceType } from './models/usageMetrics';
import { LLMMetricsAggregation, GroupedByType } from './models/aggregatedMetrics';
import { LLMInfo } from './models/ModelInformation';
import { Logger } from '../utils/Logger';
import { ObjectId, OptionalUnlessRequiredId } from 'mongodb';
import { getModelInfo } from '../Services/ModelInfoService';

/**
 * Service for tracking and storing LLM usage metrics and costs
 */
export class LLMMetricsService {
    private static instance: LLMMetricsService;
    private client: MongoDBClient;
    private dbService: DatabaseService;
    private logger: Logger;
    private  DB_NAME:string; // Database for all usage metrics
    private repository: IRepository<llmMetrics> | null = null;
    private aggregationRepository: IRepository<LLMMetricsAggregation> | null = null;

    public constructor(dbName:string) {
        this.client = MongoDBClient.getInstance();
        this.dbService = DatabaseService.getInstance();
        this.logger = new Logger('LLMMetricsService');
        this.DB_NAME = dbName;
    }

    /**
     * Get singleton instance
     */
    

    /**
     * Get the repository for LLM metrics
     */
    private getRepository(): IRepository<llmMetrics> {
        if (!this.repository) {
            this.repository = this.dbService.getRepository<llmMetrics>(
                this.DB_NAME,
                CollectionNames.LLM_METRICS
            );
        }
        return this.repository;
    }


    /**
     * Get the repository for LLM metrics aggregation
     */
    private getAggregationRepository(): IRepository<LLMMetricsAggregation> {
        if (!this.aggregationRepository) {
            this.aggregationRepository = this.dbService.getRepository<LLMMetricsAggregation>(
                this.DB_NAME,
                CollectionNames.LLM_METRICS_AGGREGATION
            );
        }
        return this.aggregationRepository;
    }

    /**
     * Initialize the LLM metrics collection (time series)
     */
    public async initialize(): Promise<void> {
        try {
            await this.client.ensureTimeSeriesCollection(this.DB_NAME, CollectionNames.LLM_METRICS);
            this.logger.success('LLM Metrics collection initialized');
        } catch (error) {
            this.logger.error('Failed to initialize LLM Metrics collection', error);
        }
    }

    /**
     * Calculate cost based on usage and model pricing
     * @param usage Usage data from AWS Bedrock
     * @param modelInfo Model pricing information
     * @returns Calculated cost in dollars
     */
    private calculateCost(usage: any, modelInfo: LLMInfo): number {
        let cost = 0;

        // Input tokens cost (per 1000 tokens)
        if (usage.input_tokens) {
            cost += (usage.input_tokens / 1000) * modelInfo.price_per_input_token;
        }

        // Cache creation (write) tokens cost
        if (usage.cache_creation_input_tokens) {
            cost += (usage.cache_creation_input_tokens / 1000) * modelInfo.price_cache_write;
        }

        // Cache read tokens cost
        if (usage.cache_read_input_tokens) {
            cost += (usage.cache_read_input_tokens / 1000) * modelInfo.price_cache_read;
        }

        // Output tokens cost
        if (usage.output_tokens) {
            cost += (usage.output_tokens / 1000) * modelInfo.price_per_output_token;
        }

        return cost;
    }

    /**
     * Get model info by model ID
     * @param modelId Model identifier
     * @returns LLMInfo object with pricing details
     */
    private async getModelInfo(modelId: string): Promise<LLMInfo> {
        return (await getModelInfo(modelId)) as any;
    }

    /**
     * Track and store LLM usage metrics
     * @param params Tracking parameters
     */
    public async trackUsage(params: {
        usage: any;
        modelInfo: any; // here the model ID is the name of the model which we have given in our db, like claude_sonnet_45 something like that.
        userId: string;
        organizationId: string;
        userName:string;
        groupedName:string;// either task name of wp name
        taskId?: string;
        wpId?: string;
    }): Promise<void> {
        try {
            this.initialize();
            const { usage, modelInfo, userId, organizationId, taskId, wpId } = params;

            // Get model pricing info
            

            // Calculate cost
            const netCost = this.calculateCost(usage, modelInfo);

            // Prepare tags
            const tags: Tag = {
                organizationId: organizationId,
                userId: userId,
                resourceType: ResourceType.LLM
            };

            // Prepare metrics document
            const metricsDoc: OptionalUnlessRequiredId<llmMetrics> = {
                timestamp: new Date(),
                tags: tags,
                TaskId: taskId || '',
                wpId: wpId || '',
                modelId: modelInfo.modelId,
                input_tokens: usage.input_tokens || 0,
                cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
                cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                net_cost: netCost
            } as any;

            // Insert using repository pattern
            const repo = this.getRepository();
            await repo.insertOne(metricsDoc);

            this.logger.info('LLM usage tracked', {
                taskId,
                userId,
                cost: netCost.toFixed(6),
                tokens: {
                    input: usage.input_tokens,
                    cache_write: usage.cache_creation_input_tokens,
                    cache_read: usage.cache_read_input_tokens,
                    output: usage.output_tokens
                }
            });
        } catch (error) {
            this.logger.error('Failed to track LLM usage', error);
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
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get user total cost', error);
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
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_cost || 0), 0);
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
            const totalCost = metrics.reduce((sum, metric) => sum + (metric.net_cost || 0), 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get task total cost', error);
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
     * Aggregate LLM metrics for a given time period and save to aggregation collection
     * Logic: If TaskId === wpId, group by wpId. If different, group by TaskId.
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async aggregateAndSave(startDate: Date, endDate: Date): Promise<{ success: boolean; aggregatedCount: number; error?: string }> {
        try {
            const repo = this.getRepository();
            const aggRepo = this.getAggregationRepository();

            // Build aggregation pipeline
            // Logic: If TaskId === wpId, use wpId. Else use TaskId
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
                                // If TaskId equals wpId, use wpId (groupedBy: 'wpId')
                                if: { $eq: ['$TaskId', '$wpId'] },
                                then: { type: 'wpId', value: '$wpId' },
                                // Else if TaskId is not empty, use TaskId
                                else: {
                                    $cond: {
                                        if: { $and: [{ $ne: ['$TaskId', ''] }, { $ne: ['$TaskId', null] }] },
                                        then: { type: 'TaskId', value: '$TaskId' },
                                        // Otherwise use wpId
                                        else: { type: 'wpId', value: '$wpId' }
                                    }
                                }
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
                        totalCost: { $sum: '$net_cost' },
                        totalInputTokens: { $sum: '$input_tokens' },
                        totalOutputTokens: { $sum: '$output_tokens' },
                        totalCacheWriteTokens: { $sum: '$cache_creation_input_tokens' },
                        totalCacheReadTokens: { $sum: '$cache_read_input_tokens' },
                        requestCount: { $sum: 1 },
                        modelIds: { $addToSet: '$modelId' },
                        firstTimestamp: { $min: '$timestamp' },
                        lastTimestamp: { $max: '$timestamp' }
                    }
                }
            ];

            const results = await repo.aggregate(pipeline);

            // Save aggregated results to aggregation collection
            let aggregatedCount = 0;
            for (const result of results) {
                const aggregationDoc: OptionalUnlessRequiredId<LLMMetricsAggregation> = {
                    aggregationPeriod: {
                        startDate: startDate,
                        endDate: endDate
                    },
                    groupedBy: result._id.type as GroupedByType,
                    groupedId: result._id.value,
                    userId: result._id.userId,
                    organizationId: result._id.organizationId,
                    totalCost: result.totalCost,
                    totalInputTokens: result.totalInputTokens,
                    totalOutputTokens: result.totalOutputTokens,
                    totalCacheWriteTokens: result.totalCacheWriteTokens,
                    totalCacheReadTokens: result.totalCacheReadTokens,
                    requestCount: result.requestCount,
                    modelIds: result.modelIds,
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
            this.logger.error('Failed to aggregate LLM metrics', error);
            return {
                success: false,
                aggregatedCount: 0,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get aggregated LLM metrics data (already saved in aggregation collection)
     * @param startDate Optional start date filter
     * @param endDate Optional end date filter
     * @param groupedId Optional specific TaskId or wpId
     */
    public async getAggregatedData(
        startDate?: Date,
        endDate?: Date,
        groupedId?: string
    ): Promise<LLMMetricsAggregation[]> {
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
            this.logger.error('Failed to get aggregated LLM data', error);
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

            this.logger.info('Deleted existing LLM aggregations for period', { startDate, endDate });

            // Create new aggregations
            const result = await this.aggregateAndSave(startDate, endDate);
            return result;
        } catch (error) {
            this.logger.error('Failed to re-aggregate LLM metrics', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }
}

export default LLMMetricsService;
