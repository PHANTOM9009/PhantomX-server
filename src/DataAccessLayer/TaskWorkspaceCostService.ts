import { MongoDBClient } from './MongoDBClient';
import { DatabaseService } from './DatabaseService';
import { IRepository } from './Repository';
import { CollectionNames } from './models/Collections';
import { TaskWorkspaceCostAggregation } from './models/combinedMetrics';
import { LLMMetricsAggregation, EC2MetricsAggregation } from './models/aggregatedMetrics';
import { Logger } from '../utils/Logger';
import { ObjectId, OptionalUnlessRequiredId } from 'mongodb';

/**
 * Service for combining LLM and EC2 costs into unified Task/Workspace cost view
 * Reads from LLM_Metrics_Aggregation and EC2_Metrics_Aggregation
 */
export class TaskWorkspaceCostService {
    private client: MongoDBClient;
    private dbService: DatabaseService;
    private logger: Logger;
    private DB_NAME: string;
    private repository: IRepository<TaskWorkspaceCostAggregation> | null = null;
    private llmAggRepository: IRepository<LLMMetricsAggregation> | null = null;
    private ec2AggRepository: IRepository<EC2MetricsAggregation> | null = null;

    public constructor(dbName: string) {
        this.client = MongoDBClient.getInstance();
        this.dbService = DatabaseService.getInstance();
        this.logger = new Logger('TaskWorkspaceCostService');
        this.DB_NAME = dbName;
    }

    /**
     * Get the repository for combined cost aggregation
     */
    private getRepository(): IRepository<TaskWorkspaceCostAggregation> {
        if (!this.repository) {
            this.repository = this.dbService.getRepository<TaskWorkspaceCostAggregation>(
                this.DB_NAME,
                CollectionNames.TASK_WORKSPACE_COST_AGGREGATION
            );
        }
        return this.repository;
    }

    /**
     * Get the repository for LLM aggregations
     */
    private getLLMAggRepository(): IRepository<LLMMetricsAggregation> {
        if (!this.llmAggRepository) {
            this.llmAggRepository = this.dbService.getRepository<LLMMetricsAggregation>(
                this.DB_NAME,
                CollectionNames.LLM_METRICS_AGGREGATION
            );
        }
        return this.llmAggRepository;
    }

    /**
     * Get the repository for EC2 aggregations
     */
    private getEC2AggRepository(): IRepository<EC2MetricsAggregation> {
        if (!this.ec2AggRepository) {
            this.ec2AggRepository = this.dbService.getRepository<EC2MetricsAggregation>(
                this.DB_NAME,
                CollectionNames.EC2_METRICS_AGGREGATION
            );
        }
        return this.ec2AggRepository;
    }

    /**
     * Combine LLM and EC2 aggregated data and save to unified collection
     * Reads from LLM_Metrics_Aggregation and EC2_Metrics_Aggregation
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async aggregateAndSave(startDate: Date, endDate: Date): Promise<{ success: boolean; aggregatedCount: number; error?: string }> {
        try {
            const repo = this.getRepository();
            const llmAggRepo = this.getLLMAggRepository();
            const ec2AggRepo = this.getEC2AggRepository();

            // Fetch LLM aggregations for the period
            const llmAggregations = await llmAggRepo.find({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            // Fetch EC2 aggregations for the period
            const ec2Aggregations = await ec2AggRepo.find({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            // Create a map to combine data
            // Key: `${groupedId}_${userId}_${organizationId}`
            const combinedMap = new Map<string, any>();

            // Process LLM aggregations
            // Multiple records may exist for same key (e.g., hourly aggregations in a daily query)
            // We ADD costs instead of replacing to handle this case
            for (const llm of llmAggregations) {
                const key = `${llm.groupedId}_${llm.userId}_${llm.organizationId}`;
                
                if (!combinedMap.has(key)) {
                    combinedMap.set(key, {
                        groupedBy: llm.groupedBy,
                        groupedId: llm.groupedId,
                        userId: llm.userId,
                        userName:llm?.userName,
                        groupedName: llm?.groupedName,
                        organizationId: llm.organizationId,
                        llmCost: 0,
                        ec2Cost: 0,
                        llmDetails: {
                            totalInputTokens: 0,
                            totalOutputTokens: 0,
                            totalCacheWriteTokens: 0,
                            totalCacheReadTokens: 0,
                            requestCount: 0,
                            modelIds: []
                        },
                        ec2Details: {
                            totalUsageTime: 0,
                            instanceCount: 0,
                            uniqueInstances: [],
                            ec2Types: []
                        }
                    });
                }

                const entry = combinedMap.get(key);
                
                // ADD costs (not replace) to handle multiple records for same key
                entry.llmCost += llm.totalCost;
                
                // Aggregate details
                if (entry.llmDetails) {
                    entry.llmDetails.totalInputTokens += llm.totalInputTokens;
                    entry.llmDetails.totalOutputTokens += llm.totalOutputTokens;
                    entry.llmDetails.totalCacheWriteTokens += llm.totalCacheWriteTokens;
                    entry.llmDetails.totalCacheReadTokens += llm.totalCacheReadTokens;
                    entry.llmDetails.requestCount += llm.requestCount;
                    
                    // Merge model IDs (unique)
                    if (llm.modelIds && llm.modelIds.length > 0) {
                        const existingModels = new Set(entry.llmDetails.modelIds);
                        llm.modelIds.forEach(modelId => existingModels.add(modelId));
                        entry.llmDetails.modelIds = Array.from(existingModels);
                    }
                }
            }

            // Process EC2 aggregations
            // Multiple records may exist for same key (e.g., hourly aggregations in a daily query)
            // We ADD costs instead of replacing to handle this case
            for (const ec2 of ec2Aggregations) {
                const key = `${ec2.groupedId}_${ec2.userId}_${ec2.organizationId}`;
                
                if (!combinedMap.has(key)) {
                    combinedMap.set(key, {
                        groupedBy: ec2.groupedBy,
                        groupedId: ec2.groupedId,
                        userId: ec2.userId,
                        organizationId: ec2.organizationId,
                        llmCost: 0,
                        userName: ec2?.userName,
                        groupedName:ec2?.groupedName,
                        ec2Cost: 0,
                        llmDetails: {
                            totalInputTokens: 0,
                            totalOutputTokens: 0,
                            totalCacheWriteTokens: 0,
                            totalCacheReadTokens: 0,
                            requestCount: 0,
                            modelIds: []
                        },
                        ec2Details: {
                            totalUsageTime: 0,
                            instanceCount: 0,
                            uniqueInstances: [],
                            ec2Types: []
                        }
                    });
                }

                const entry = combinedMap.get(key);
                
                // ADD costs (not replace) to handle multiple records for same key
                entry.ec2Cost += ec2.totalCost;
                
                // Aggregate details
                if (entry.ec2Details) {
                    entry.ec2Details.totalUsageTime += ec2.totalUsageTime;
                    entry.ec2Details.instanceCount += ec2.instanceCount;
                    
                    // Merge unique instances
                    if (ec2.uniqueInstances && ec2.uniqueInstances.length > 0) {
                        const existingInstances = new Set(entry.ec2Details.uniqueInstances);
                        ec2.uniqueInstances.forEach(instance => existingInstances.add(instance));
                        entry.ec2Details.uniqueInstances = Array.from(existingInstances);
                    }
                    
                    // Merge EC2 types (unique)
                    if (ec2.ec2Types && ec2.ec2Types.length > 0) {
                        const existingTypes = new Set(entry.ec2Details.ec2Types);
                        ec2.ec2Types.forEach(type => existingTypes.add(type));
                        entry.ec2Details.ec2Types = Array.from(existingTypes);
                    }
                }
            }

            // Save combined results
            let aggregatedCount = 0;
            for (const [key, combined] of combinedMap.entries()) {
                const netCost = combined.llmCost + combined.ec2Cost;

                const combinedDoc: OptionalUnlessRequiredId<TaskWorkspaceCostAggregation> = {
                    aggregationPeriod: {
                        startDate: startDate,
                        endDate: endDate
                    },
                    groupedBy: combined.groupedBy,
                    userName:combined.userName,
                    groupedName:combined.groupedName,
                    groupedId: combined.groupedId,
                    userId: combined.userId,
                    organizationId: combined.organizationId,
                    llmCost: combined.llmCost,
                    ec2Cost: combined.ec2Cost,
                    netCost: netCost,
                    llmDetails: combined.llmDetails,
                    ec2Details: combined.ec2Details,
                    createdAt: new Date(),
                    updatedAt: new Date()
                } as any;

                // Check if combined aggregation already exists
                const existing = await repo.findOne({
                    'aggregationPeriod.startDate': startDate,
                    'aggregationPeriod.endDate': endDate,
                    groupedId: combined.groupedId,
                    userId: combined.userId,
                    organizationId: combined.organizationId
                } as any);

                if (existing) {
                    // Overwrite existing
                    await repo.updateOne(
                        { _id: existing._id } as any,
                        { $set: { ...combinedDoc, updatedAt: new Date() } } as any
                    );
                } else {
                    // Insert new
                    await repo.insertOne(combinedDoc);
                }

                aggregatedCount++;
            }
            return { success: true, aggregatedCount };
        } catch (error) {
            this.logger.error('Failed to aggregate combined costs', error);
            return {
                success: false,
                aggregatedCount: 0,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get combined aggregated cost data
     * @param startDate Optional start date filter
     * @param endDate Optional end date filter
     * @param groupedId Optional specific TaskId or wpId
     */
    public async getCombinedData(
        startDate?: Date,
        endDate?: Date,
        groupedId?: string
    ): Promise<TaskWorkspaceCostAggregation[]> {
        try {
            const repo = this.getRepository();
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

            const results = await repo.find(filter);
            return results;
        } catch (error) {
            this.logger.error('Failed to get combined cost data', error);
            return [];
        }
    }

    /**
     * Get combined data filtered by organization
     * @param organizationId Organization ID
     * @param startDate Optional start date filter
     * @param endDate Optional end date filter
     */
    public async getCombinedDataByOrganization(
        organizationId: string,
        startDate?: Date,
        endDate?: Date
    ): Promise<TaskWorkspaceCostAggregation[]> {
        try {
            const repo = this.getRepository();
            const filter: any = {
                organizationId: organizationId
            };

            if (startDate) {
                filter['aggregationPeriod.startDate'] = { $gte: startDate };
            }
            if (endDate) {
                filter['aggregationPeriod.endDate'] = { $lte: endDate };
            }

            const results = await repo.find(filter);
            return results;
        } catch (error) {
            this.logger.error('Failed to get combined cost data by organization', error);
            return [];
        }
    }

    /**
     * Get combined data filtered by user
     * @param userId User ID
     * @param startDate Optional start date filter
     * @param endDate Optional end date filter
     */
    public async getCombinedDataByUser(
        userId: string,
        startDate?: Date,
        endDate?: Date
    ): Promise<TaskWorkspaceCostAggregation[]> {
        try {
            const repo = this.getRepository();
            const filter: any = {
                userId: userId
            };

            if (startDate) {
                filter['aggregationPeriod.startDate'] = { $gte: startDate };
            }
            if (endDate) {
                filter['aggregationPeriod.endDate'] = { $lte: endDate };
            }

            const results = await repo.find(filter);
            return results;
        } catch (error) {
            this.logger.error('Failed to get combined cost data by user', error);
            return [];
        }
    }

    /**
     * Get total net cost for a period
     * @param startDate Start date
     * @param endDate End date
     */
    public async getTotalNetCost(startDate: Date, endDate: Date): Promise<number> {
        try {
            const data = await this.getCombinedData(startDate, endDate);
            const totalCost = data.reduce((sum, item) => sum + item.netCost, 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get total net cost', error);
            return 0;
        }
    }

    /**
     * Get cost breakdown (LLM vs EC2) for a period
     * @param startDate Start date
     * @param endDate End date
     */
    public async getCostBreakdown(startDate: Date, endDate: Date): Promise<{
        totalLLMCost: number;
        totalEC2Cost: number;
        totalNetCost: number;
        recordCount: number;
    }> {
        try {
            const data = await this.getCombinedData(startDate, endDate);
            
            const breakdown = {
                totalLLMCost: data.reduce((sum, item) => sum + item.llmCost, 0),
                totalEC2Cost: data.reduce((sum, item) => sum + item.ec2Cost, 0),
                totalNetCost: data.reduce((sum, item) => sum + item.netCost, 0),
                recordCount: data.length
            };

            return breakdown;
        } catch (error) {
            this.logger.error('Failed to get cost breakdown', error);
            return {
                totalLLMCost: 0,
                totalEC2Cost: 0,
                totalNetCost: 0,
                recordCount: 0
            };
        }
    }

    /**
     * Re-aggregate: Delete existing combined aggregations for the period and create new ones
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async reAggregate(startDate: Date, endDate: Date): Promise<{ success: boolean; error?: string }> {
        try {
            const repo = this.getRepository();

            // Delete existing combined aggregations for this period
            await repo.deleteMany({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            this.logger.info('Deleted existing combined aggregations for period', { startDate, endDate });

            // Create new combined aggregations
            const result = await this.aggregateAndSave(startDate, endDate);
            return result;
        } catch (error) {
            this.logger.error('Failed to re-aggregate combined costs', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get top N most expensive tasks/workspaces
     * @param startDate Start date
     * @param endDate End date
     * @param limit Number of results (default 10)
     */
    public async getTopExpensive(
        startDate: Date,
        endDate: Date,
        limit: number = 10
    ): Promise<TaskWorkspaceCostAggregation[]> {
        try {
            const data = await this.getCombinedData(startDate, endDate);
            
            // Sort by netCost descending and limit
            const topExpensive = data
                .sort((a, b) => b.netCost - a.netCost)
                .slice(0, limit);

            return topExpensive;
        } catch (error) {
            this.logger.error('Failed to get top expensive tasks/workspaces', error);
            return [];
        }
    }


    /**
     * Get tasks and workspaces cost grid for dashboard
     * Returns all tasks/workspaces with their costs
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     * @returns Array of task/workspace cost data
     */
    public async getTasksWorkspacesGrid(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<Array<{
        id: string;
        name: string;
        type: string;
        userId: string;
        userName: string;
        llmCost: number;
        ec2Cost: number;
        netCost: number;
    }>> {
        try {
            const repo = this.getRepository();

            // MongoDB aggregation pipeline
            const pipeline = [
                // Match organization and date range
                {
                    $match: {
                        organizationId: organizationId,
                        'aggregationPeriod.startDate': { $gte: startDate, $lte: endDate }
                    }
                },
                // Group by groupedId (task/workspace) and userId
                {
                    $group: {
                        _id: {
                            id: '$groupedId',
                            type: '$groupedBy',
                            userId: '$userId'
                        },
                        llmCost: { $sum: '$llmCost' },
                        ec2Cost: { $sum: '$ec2Cost' },
                        netCost: { $sum: '$netCost' }
                    }
                },
                // Sort by netCost descending
                {
                    $sort: { netCost: -1 }
                },
                // Format output
                {
                    $project: {
                        _id: 0,
                        id: '$_id.id',
                        name: '$_id.id', // Placeholder - will be replaced with actual name
                        type: {
                            $cond: {
                                if: { $eq: ['$_id.type', 'TaskId'] },
                                then: 'task',
                                else: 'workspace'
                            }
                        },
                        userId: '$_id.userId',
                        userName: '$_id.userId', // Placeholder - will be replaced with actual name
                        llmCost: 1,
                        ec2Cost: 1,
                        netCost: 1
                    }
                }
            ];

            const results = await repo.aggregate(pipeline) as Array<{
                id: string;
                name: string;
                type: string;
                userId: string;
                userName: string;
                llmCost: number;
                ec2Cost: number;
                netCost: number;
            }>;
            
            this.logger.info('Retrieved tasks/workspaces cost grid for organization', {
                organizationId,
                itemCount: results.length
            });

            return results;
        } catch (error) {
            this.logger.error('Failed to get tasks/workspaces cost grid', error);
            return [];
        }
    }
}

export default TaskWorkspaceCostService;
