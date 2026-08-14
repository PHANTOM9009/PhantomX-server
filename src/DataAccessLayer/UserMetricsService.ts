import { MongoDBClient } from './MongoDBClient';
import { DatabaseService } from './DatabaseService';
import { IRepository } from './Repository';
import { CollectionNames } from './models/Collections';
import { UserMetricsAggregation, TaskCostBreakdown, WorkspaceCostBreakdown } from './models/userMetrics';
import { TaskWorkspaceCostAggregation } from './models/combinedMetrics';
import { Logger } from '../utils/Logger';
import { ObjectId, OptionalUnlessRequiredId } from 'mongodb';

/**
 * Service for aggregating and querying user-level cost metrics
 * Reads from Task_Workspace_Cost_Aggregation and creates User_Metrics_Aggregation
 */
export class UserMetricsService {
    private client: MongoDBClient;
    private dbService: DatabaseService;
    private logger: Logger;
    private DB_NAME: string;
    private repository: IRepository<UserMetricsAggregation> | null = null;
    private taskWorkspaceCostRepository: IRepository<TaskWorkspaceCostAggregation> | null = null;

    public constructor(dbName: string) {
        this.client = MongoDBClient.getInstance();
        this.dbService = DatabaseService.getInstance();
        this.logger = new Logger('UserMetricsService');
        this.DB_NAME = dbName;
    }

    /**
     * Get the repository for user metrics aggregation
     */
    private getRepository(): IRepository<UserMetricsAggregation> {
        if (!this.repository) {
            this.repository = this.dbService.getRepository<UserMetricsAggregation>(
                this.DB_NAME,
                CollectionNames.USER_METRICS_AGGREGATION
            );
        }
        return this.repository;
    }

    /**
     * Get the repository for task/workspace cost aggregations
     */
    private getTaskWorkspaceCostRepository(): IRepository<TaskWorkspaceCostAggregation> {
        if (!this.taskWorkspaceCostRepository) {
            this.taskWorkspaceCostRepository = this.dbService.getRepository<TaskWorkspaceCostAggregation>(
                this.DB_NAME,
                CollectionNames.TASK_WORKSPACE_COST_AGGREGATION
            );
        }
        return this.taskWorkspaceCostRepository;
    }

    /**
     * Aggregate user metrics from Task_Workspace_Cost_Aggregation
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async aggregateAndSave(startDate: Date, endDate: Date): Promise<{ success: boolean; aggregatedCount: number; error?: string }> {
        try {
            const repo = this.getRepository();
            const taskWpCostRepo = this.getTaskWorkspaceCostRepository();

            // Fetch all task/workspace cost aggregations for the period
            const costAggregations = await taskWpCostRepo.find({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            // Group by userId
            // Key: `${userId}_${organizationId}`
            const userMap = new Map<string, any>();

            for (const costAgg of costAggregations) {
                const key = `${costAgg.userId}_${costAgg.organizationId}`;

                if (!userMap.has(key)) {
                    userMap.set(key, {
                        userId: costAgg.userId,
                        organizationId: costAgg.organizationId,
                        totalLLMCost: 0,
                        userName:costAgg.userName,
                        totalEC2Cost: 0,
                        totalNetCost: 0,
                        taskBreakdown: [] as TaskCostBreakdown[],
                        workspaceBreakdown: [] as WorkspaceCostBreakdown[],
                        aggregatedLLMDetails: {
                            totalInputTokens: 0,
                            totalOutputTokens: 0,
                            totalCacheWriteTokens: 0,
                            totalCacheReadTokens: 0,
                            totalRequests: 0,
                            uniqueModelIds: [] as string[]
                        },
                        aggregatedEC2Details: {
                            totalUsageTime: 0,
                            totalInstanceCount: 0,
                            uniqueInstances: [] as string[],
                            uniqueEC2Types: [] as string[]
                        }
                    });
                }

                const userEntry = userMap.get(key);

                // Add to totals
                userEntry.totalLLMCost += costAgg.llmCost;
                userEntry.totalEC2Cost += costAgg.ec2Cost;
                userEntry.totalNetCost += costAgg.netCost;

                // Create breakdown entry
                if (costAgg.groupedBy === 'TaskId') {
                    userEntry.taskBreakdown.push({
                        taskId: costAgg.groupedId,
                        llmCost: costAgg.llmCost,
                        ec2Cost: costAgg.ec2Cost,
                        netCost: costAgg.netCost,
                        llmDetails: costAgg.llmDetails,
                        ec2Details: costAgg.ec2Details
                    });
                } else if (costAgg.groupedBy === 'wpId') {
                    userEntry.workspaceBreakdown.push({
                        wpId: costAgg.groupedId,
                        llmCost: costAgg.llmCost,
                        ec2Cost: costAgg.ec2Cost,
                        netCost: costAgg.netCost,
                        llmDetails: costAgg.llmDetails,
                        ec2Details: costAgg.ec2Details
                    });
                }

                // Aggregate LLM details
                if (costAgg.llmDetails) {
                    userEntry.aggregatedLLMDetails.totalInputTokens += costAgg.llmDetails.totalInputTokens || 0;
                    userEntry.aggregatedLLMDetails.totalOutputTokens += costAgg.llmDetails.totalOutputTokens || 0;
                    userEntry.aggregatedLLMDetails.totalCacheWriteTokens += costAgg.llmDetails.totalCacheWriteTokens || 0;
                    userEntry.aggregatedLLMDetails.totalCacheReadTokens += costAgg.llmDetails.totalCacheReadTokens || 0;
                    userEntry.aggregatedLLMDetails.totalRequests += costAgg.llmDetails.requestCount || 0;

                    // Merge unique model IDs
                    if (costAgg.llmDetails.modelIds && costAgg.llmDetails.modelIds.length > 0) {
                        const existingModels = new Set(userEntry.aggregatedLLMDetails.uniqueModelIds);
                        costAgg.llmDetails.modelIds.forEach(modelId => existingModels.add(modelId));
                        userEntry.aggregatedLLMDetails.uniqueModelIds = Array.from(existingModels);
                    }
                }

                // Aggregate EC2 details
                if (costAgg.ec2Details) {
                    userEntry.aggregatedEC2Details.totalUsageTime += costAgg.ec2Details.totalUsageTime || 0;
                    userEntry.aggregatedEC2Details.totalInstanceCount += costAgg.ec2Details.instanceCount || 0;

                    // Merge unique instances
                    if (costAgg.ec2Details.uniqueInstances && costAgg.ec2Details.uniqueInstances.length > 0) {
                        const existingInstances = new Set(userEntry.aggregatedEC2Details.uniqueInstances);
                        costAgg.ec2Details.uniqueInstances.forEach(instance => existingInstances.add(instance));
                        userEntry.aggregatedEC2Details.uniqueInstances = Array.from(existingInstances);
                    }

                    // Merge unique EC2 types
                    if (costAgg.ec2Details.ec2Types && costAgg.ec2Details.ec2Types.length > 0) {
                        const existingTypes = new Set(userEntry.aggregatedEC2Details.uniqueEC2Types);
                        costAgg.ec2Details.ec2Types.forEach(type => existingTypes.add(type));
                        userEntry.aggregatedEC2Details.uniqueEC2Types = Array.from(existingTypes);
                    }
                }
            }

            // Save user metrics
            let aggregatedCount = 0;
            for (const [key, userMetrics] of userMap.entries()) {
                const userDoc: OptionalUnlessRequiredId<UserMetricsAggregation> = {
                    aggregationPeriod: {
                        startDate: startDate,
                        endDate: endDate
                    },
                    userId: userMetrics.userId,
                    userName:userMetrics.userName,
                    organizationId: userMetrics.organizationId,
                    totalLLMCost: userMetrics.totalLLMCost,
                    totalEC2Cost: userMetrics.totalEC2Cost,
                    totalNetCost: userMetrics.totalNetCost,
                    taskCount: userMetrics.taskBreakdown.length,
                    workspaceCount: userMetrics.workspaceBreakdown.length,
                    taskBreakdown: userMetrics.taskBreakdown,
                    workspaceBreakdown: userMetrics.workspaceBreakdown,
                    aggregatedLLMDetails: userMetrics.aggregatedLLMDetails,
                    aggregatedEC2Details: userMetrics.aggregatedEC2Details,
                    createdAt: new Date(),
                    updatedAt: new Date()
                } as any;

                // Check if user aggregation already exists for this period
                const existing = await repo.findOne({
                    'aggregationPeriod.startDate': startDate,
                    'aggregationPeriod.endDate': endDate,
                    userId: userMetrics.userId,
                    organizationId: userMetrics.organizationId
                } as any);

                if (existing) {
                    // Update existing
                    await repo.updateOne(
                        { _id: existing._id } as any,
                        { $set: { ...userDoc, updatedAt: new Date() } } as any
                    );
                } else {
                    // Insert new
                    await repo.insertOne(userDoc);
                }

                aggregatedCount++;
            }
            return { success: true, aggregatedCount };
        } catch (error) {
            this.logger.error('Failed to aggregate user metrics', error);
            return {
                success: false,
                aggregatedCount: 0,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get total cost for a user in a given period
     * @param userId User ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getUserTotalCost(userId: string, startDate: Date, endDate: Date): Promise<number> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            const totalCost = userMetrics.reduce((sum, metric) => sum + metric.totalNetCost, 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get user total cost', error);
            return 0;
        }
    }

    /**
     * Get cost breakdown (LLM vs EC2) for a user
     * @param userId User ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getUserCostBreakdown(userId: string, startDate: Date, endDate: Date): Promise<{
        totalLLMCost: number;
        totalEC2Cost: number;
        totalNetCost: number;
        periodCount: number;
    }> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            const breakdown = {
                totalLLMCost: userMetrics.reduce((sum, metric) => sum + metric.totalLLMCost, 0),
                totalEC2Cost: userMetrics.reduce((sum, metric) => sum + metric.totalEC2Cost, 0),
                totalNetCost: userMetrics.reduce((sum, metric) => sum + metric.totalNetCost, 0),
                periodCount: userMetrics.length
            };

            return breakdown;
        } catch (error) {
            this.logger.error('Failed to get user cost breakdown', error);
            return {
                totalLLMCost: 0,
                totalEC2Cost: 0,
                totalNetCost: 0,
                periodCount: 0
            };
        }
    }

    /**
     * Get costs per task for a user
     * @param userId User ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getUserCostByTask(userId: string, startDate: Date, endDate: Date): Promise<TaskCostBreakdown[]> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Aggregate tasks across all periods
            const taskMap = new Map<string, TaskCostBreakdown>();
            for (const metrics of userMetrics) {
                for (const task of metrics.taskBreakdown) {
                    if (taskMap.has(task.taskId)) {
                        const existing = taskMap.get(task.taskId)!;
                        existing.llmCost += task.llmCost;
                        existing.ec2Cost += task.ec2Cost;
                        existing.netCost += task.netCost;
                    } else {
                        taskMap.set(task.taskId, { ...task });
                    }
                }
            }

            return Array.from(taskMap.values());
        } catch (error) {
            this.logger.error('Failed to get user cost by task', error);
            return [];
        }
    }

    /**
     * Get costs per workspace for a user
     * @param userId User ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getUserCostByWorkspace(userId: string, startDate: Date, endDate: Date): Promise<WorkspaceCostBreakdown[]> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Aggregate workspaces across all periods
            const wpMap = new Map<string, WorkspaceCostBreakdown>();
            for (const metrics of userMetrics) {
                for (const wp of metrics.workspaceBreakdown) {
                    if (wpMap.has(wp.wpId)) {
                        const existing = wpMap.get(wp.wpId)!;
                        existing.llmCost += wp.llmCost;
                        existing.ec2Cost += wp.ec2Cost;
                        existing.netCost += wp.netCost;
                    } else {
                        wpMap.set(wp.wpId, { ...wp });
                    }
                }
            }

            return Array.from(wpMap.values());
        } catch (error) {
            this.logger.error('Failed to get user cost by workspace', error);
            return [];
        }
    }

    /**
     * Get top spending users in an organization
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     * @param limit Number of users to return (default 10)
     */
    public async getTopSpendingUsers(
        organizationId: string,
        startDate: Date,
        endDate: Date,
        limit: number = 10
    ): Promise<Array<{
        userId: string;
        totalNetCost: number;
        totalLLMCost: number;
        totalEC2Cost: number;
        taskCount: number;
        workspaceCount: number;
    }>> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Group by userId and sum costs
            const userCostMap = new Map<string, any>();
            for (const metrics of userMetrics) {
                if (!userCostMap.has(metrics.userId)) {
                    userCostMap.set(metrics.userId, {
                        userId: metrics.userId,
                        totalNetCost: 0,
                        totalLLMCost: 0,
                        totalEC2Cost: 0,
                        taskCount: 0,
                        workspaceCount: 0
                    });
                }

                const userCost = userCostMap.get(metrics.userId);
                userCost.totalNetCost += metrics.totalNetCost;
                userCost.totalLLMCost += metrics.totalLLMCost;
                userCost.totalEC2Cost += metrics.totalEC2Cost;
                userCost.taskCount += metrics.taskCount;
                userCost.workspaceCount += metrics.workspaceCount;
            }

            // Sort by totalNetCost descending and limit
            const topUsers = Array.from(userCostMap.values())
                .sort((a, b) => b.totalNetCost - a.totalNetCost)
                .slice(0, limit);

            return topUsers;
        } catch (error) {
            this.logger.error('Failed to get top spending users', error);
            return [];
        }
    }

    /**
     * Compare user costs between two time periods
     * @param userId User ID
     * @param period1Start Period 1 start date
     * @param period1End Period 1 end date
     * @param period2Start Period 2 start date
     * @param period2End Period 2 end date
     */
    public async compareUserCosts(
        userId: string,
        period1Start: Date,
        period1End: Date,
        period2Start: Date,
        period2End: Date
    ): Promise<{
        period1: {
            totalLLMCost: number;
            totalEC2Cost: number;
            totalNetCost: number;
            taskCount: number;
            workspaceCount: number;
        };
        period2: {
            totalLLMCost: number;
            totalEC2Cost: number;
            totalNetCost: number;
            taskCount: number;
            workspaceCount: number;
        };
        difference: {
            llmCostDiff: number;
            ec2CostDiff: number;
            netCostDiff: number;
            llmCostPercent: number;
            ec2CostPercent: number;
            netCostPercent: number;
        };
    }> {
        try {
            const repo = this.getRepository();

            // Get period 1 metrics
            const period1Metrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: period1Start } as any,
                'aggregationPeriod.endDate': { $lte: period1End } as any
            } as any);

            // Get period 2 metrics
            const period2Metrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: period2Start } as any,
                'aggregationPeriod.endDate': { $lte: period2End } as any
            } as any);

            // Aggregate period 1
            const period1 = {
                totalLLMCost: period1Metrics.reduce((sum, m) => sum + m.totalLLMCost, 0),
                totalEC2Cost: period1Metrics.reduce((sum, m) => sum + m.totalEC2Cost, 0),
                totalNetCost: period1Metrics.reduce((sum, m) => sum + m.totalNetCost, 0),
                taskCount: period1Metrics.reduce((sum, m) => sum + m.taskCount, 0),
                workspaceCount: period1Metrics.reduce((sum, m) => sum + m.workspaceCount, 0)
            };

            // Aggregate period 2
            const period2 = {
                totalLLMCost: period2Metrics.reduce((sum, m) => sum + m.totalLLMCost, 0),
                totalEC2Cost: period2Metrics.reduce((sum, m) => sum + m.totalEC2Cost, 0),
                totalNetCost: period2Metrics.reduce((sum, m) => sum + m.totalNetCost, 0),
                taskCount: period2Metrics.reduce((sum, m) => sum + m.taskCount, 0),
                workspaceCount: period2Metrics.reduce((sum, m) => sum + m.workspaceCount, 0)
            };

            // Calculate differences
            const difference = {
                llmCostDiff: period2.totalLLMCost - period1.totalLLMCost,
                ec2CostDiff: period2.totalEC2Cost - period1.totalEC2Cost,
                netCostDiff: period2.totalNetCost - period1.totalNetCost,
                llmCostPercent: period1.totalLLMCost > 0 
                    ? ((period2.totalLLMCost - period1.totalLLMCost) / period1.totalLLMCost) * 100 
                    : 0,
                ec2CostPercent: period1.totalEC2Cost > 0 
                    ? ((period2.totalEC2Cost - period1.totalEC2Cost) / period1.totalEC2Cost) * 100 
                    : 0,
                netCostPercent: period1.totalNetCost > 0 
                    ? ((period2.totalNetCost - period1.totalNetCost) / period1.totalNetCost) * 100 
                    : 0
            };

            return { period1, period2, difference };
        } catch (error) {
            this.logger.error('Failed to compare user costs', error);
            return {
                period1: { totalLLMCost: 0, totalEC2Cost: 0, totalNetCost: 0, taskCount: 0, workspaceCount: 0 },
                period2: { totalLLMCost: 0, totalEC2Cost: 0, totalNetCost: 0, taskCount: 0, workspaceCount: 0 },
                difference: { llmCostDiff: 0, ec2CostDiff: 0, netCostDiff: 0, llmCostPercent: 0, ec2CostPercent: 0, netCostPercent: 0 }
            };
        }
    }

    /**
     * Get user metrics for a specific period
     * @param userId User ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getUserMetrics(userId: string, startDate: Date, endDate: Date): Promise<UserMetricsAggregation[]> {
        try {
            const repo = this.getRepository();
            const metrics = await repo.find({
                userId: userId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            return metrics;
        } catch (error) {
            this.logger.error('Failed to get user metrics', error);
            return [];
        }
    }

    /**
     * Re-aggregate: Delete existing user metrics for the period and create new ones
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async reAggregate(startDate: Date, endDate: Date): Promise<{ success: boolean; error?: string }> {
        try {
            const repo = this.getRepository();

            // Delete existing user metrics for this period
            await repo.deleteMany({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            this.logger.info('Deleted existing user metrics for period', { startDate, endDate });

            // Create new user metrics
            const result = await this.aggregateAndSave(startDate, endDate);
            return result;
        } catch (error) {
            this.logger.error('Failed to re-aggregate user metrics', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get all users with costs in a given period for an organization
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getUsersWithCosts(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<string[]> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Get unique user IDs
            const uniqueUsers = Array.from(new Set(userMetrics.map(m => m.userId)));
            return uniqueUsers;
        } catch (error) {
            this.logger.error('Failed to get users with costs', error);
            return [];
        }
    }

    /**
     * Get total organization cost from all users
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getOrganizationTotalCost(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<{
        totalLLMCost: number;
        totalEC2Cost: number;
        totalNetCost: number;
        userCount: number;
    }> {
        try {
            const repo = this.getRepository();
            const userMetrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            const uniqueUsers = new Set(userMetrics.map(m => m.userId));
            
            const orgCost = {
                totalLLMCost: userMetrics.reduce((sum, m) => sum + m.totalLLMCost, 0),
                totalEC2Cost: userMetrics.reduce((sum, m) => sum + m.totalEC2Cost, 0),
                totalNetCost: userMetrics.reduce((sum, m) => sum + m.totalNetCost, 0),
                userCount: uniqueUsers.size
            };

            return orgCost;
        } catch (error) {
            this.logger.error('Failed to get organization total cost', error);
            return {
                totalLLMCost: 0,
                totalEC2Cost: 0,
                totalNetCost: 0,
                userCount: 0
            };
        }
    }


    /**
     * Get users cost grid for dashboard
     * Returns all users in an organization with their costs and counts
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     * @returns Array of user cost data
     */
    public async getUsersCostGrid(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<Array<{
        userId: string;
        userName: string;
        llmCost: number;
        ec2Cost: number;
        netCost: number;
        taskCount: number;
        wpCount: number;
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
                // Group by userId and sum costs
                {
                    $group: {
                        _id: '$userId',
                        llmCost: { $sum: '$totalLLMCost' },
                        ec2Cost: { $sum: '$totalEC2Cost' },
                        netCost: { $sum: '$totalNetCost' },
                        taskCount: { $sum: '$taskCount' },
                        wpCount: { $sum: '$workspaceCount' }
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
                        userId: '$_id',
                        userName: '$_id', // Placeholder - will be replaced with actual name
                        llmCost: 1,
                        ec2Cost: 1,
                        netCost: 1,
                        taskCount: 1,
                        wpCount: 1
                    }
                }
            ];

            const results = await repo.aggregate(pipeline) as Array<{
                userId: string;
                userName: string;
                llmCost: number;
                ec2Cost: number;
                netCost: number;
                taskCount: number;
                wpCount: number;
            }>;
            
            this.logger.info('Retrieved users cost grid for organization', {
                organizationId,
                userCount: results.length
            });

            return results;
        } catch (error) {
            this.logger.error('Failed to get users cost grid', error);
            return [];
        }
    }
}

export default UserMetricsService;
