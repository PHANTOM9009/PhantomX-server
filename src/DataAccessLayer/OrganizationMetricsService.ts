import { MongoDBClient } from './MongoDBClient';
import { DatabaseService } from './DatabaseService';
import { IRepository } from './Repository';
import { CollectionNames } from './models/Collections';
import { OrganizationMetricsAggregation } from './models/organizationMetrics';
import { UserMetricsAggregation } from './models/userMetrics';
import { Logger } from '../utils/Logger';
import { ObjectId, OptionalUnlessRequiredId } from 'mongodb';

/**
 * Service for aggregating and querying organization-level cost metrics
 * Reads from User_Metrics_Aggregation and creates Organization_Metrics_Aggregation
 * Top of the cost metrics hierarchy
 */
export class OrganizationMetricsService {
    private client: MongoDBClient;
    private dbService: DatabaseService;
    private logger: Logger;
    private DB_NAME: string;
    private repository: IRepository<OrganizationMetricsAggregation> | null = null;
    private userMetricsRepository: IRepository<UserMetricsAggregation> | null = null;

    public constructor(dbName: string) {
        this.client = MongoDBClient.getInstance();
        this.dbService = DatabaseService.getInstance();
        this.logger = new Logger('OrganizationMetricsService');
        this.DB_NAME = dbName;
    }

    /**
     * Get the repository for organization metrics aggregation
     */
    private getRepository(): IRepository<OrganizationMetricsAggregation> {
        if (!this.repository) {
            this.repository = this.dbService.getRepository<OrganizationMetricsAggregation>(
                this.DB_NAME,
                CollectionNames.ORGANIZATION_METRICS_AGGREGATION
            );
        }
        return this.repository;
    }

    /**
     * Get the repository for user metrics aggregations
     */
    private getUserMetricsRepository(): IRepository<UserMetricsAggregation> {
        if (!this.userMetricsRepository) {
            this.userMetricsRepository = this.dbService.getRepository<UserMetricsAggregation>(
                this.DB_NAME,
                CollectionNames.USER_METRICS_AGGREGATION
            );
        }
        return this.userMetricsRepository;
    }

    /**
     * Aggregate organization metrics from User_Metrics_Aggregation
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async aggregateAndSave(startDate: Date, endDate: Date): Promise<{ success: boolean; aggregatedCount: number; error?: string }> {
        try {
            const repo = this.getRepository();
            const userMetricsRepo = this.getUserMetricsRepository();

            // Fetch all user metrics for the period
            const userMetrics = await userMetricsRepo.find({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            // Group by organizationId
            const orgMap = new Map<string, any>();

            for (const userMetric of userMetrics) {
                const orgId = userMetric.organizationId;

                if (!orgMap.has(orgId)) {
                    orgMap.set(orgId, {
                        organizationId: orgId,
                        totalLLMCost: 0,
                        totalEC2Cost: 0,
                        totalNetCost: 0,
                        userCount: 0,
                        totalTaskCount: 0,
                        totalWorkspaceCount: 0,
                        uniqueUsers: new Set<string>()
                    });
                }

                const orgEntry = orgMap.get(orgId);

                // Add to totals
                orgEntry.totalLLMCost += userMetric.totalLLMCost;
                orgEntry.totalEC2Cost += userMetric.totalEC2Cost;
                orgEntry.totalNetCost += userMetric.totalNetCost;
                orgEntry.totalTaskCount += userMetric.taskCount;
                orgEntry.totalWorkspaceCount += userMetric.workspaceCount;
                
                // Track unique users
                orgEntry.uniqueUsers.add(userMetric.userId);
            }

            // Save organization metrics
            let aggregatedCount = 0;
            for (const [orgId, orgMetrics] of orgMap.entries()) {
                const orgDoc: OptionalUnlessRequiredId<OrganizationMetricsAggregation> = {
                    aggregationPeriod: {
                        startDate: startDate,
                        endDate: endDate
                    },
                    organizationId: orgMetrics.organizationId,
                    totalLLMCost: orgMetrics.totalLLMCost,
                    totalEC2Cost: orgMetrics.totalEC2Cost,
                    totalNetCost: orgMetrics.totalNetCost,
                    userCount: orgMetrics.uniqueUsers.size,
                    totalTaskCount: orgMetrics.totalTaskCount,
                    totalWorkspaceCount: orgMetrics.totalWorkspaceCount,
                    createdAt: new Date(),
                    updatedAt: new Date()
                } as any;

                // Check if organization aggregation already exists for this period
                const existing = await repo.findOne({
                    'aggregationPeriod.startDate': startDate,
                    'aggregationPeriod.endDate': endDate,
                    organizationId: orgMetrics.organizationId
                } as any);

                if (existing) {
                    // Update existing
                    await repo.updateOne(
                        { _id: existing._id } as any,
                        { $set: { ...orgDoc, updatedAt: new Date() } } as any
                    );
                } else {
                    // Insert new
                    await repo.insertOne(orgDoc);
                }

                aggregatedCount++;
            }
            return { success: true, aggregatedCount };
        } catch (error) {
            this.logger.error('Failed to aggregate organization metrics', error);
            return {
                success: false,
                aggregatedCount: 0,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get total cost for an organization in a given period
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getOrganizationTotalCost(organizationId: string, startDate: Date, endDate: Date): Promise<number> {
        try {
            const repo = this.getRepository();
            const orgMetrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            const totalCost = orgMetrics.reduce((sum, metric) => sum + metric.totalNetCost, 0);
            return totalCost;
        } catch (error) {
            this.logger.error('Failed to get organization total cost', error);
            return 0;
        }
    }

    /**
     * Get cost breakdown (LLM vs EC2) for an organization
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getOrganizationCostBreakdown(organizationId: string, startDate: Date, endDate: Date): Promise<{
        totalLLMCost: number;
        totalEC2Cost: number;
        totalNetCost: number;
        periodCount: number;
        totalUserCount: number;
        totalTaskCount: number;
        totalWorkspaceCount: number;
    }> {
        try {
            const repo = this.getRepository();
            const orgMetrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Track unique users across periods
            const uniqueUsers = new Set<string>();
            const userMetricsRepo = this.getUserMetricsRepository();
            const userMetrics = await userMetricsRepo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);
            
            userMetrics.forEach(um => uniqueUsers.add(um.userId));

            const breakdown = {
                totalLLMCost: orgMetrics.reduce((sum, metric) => sum + metric.totalLLMCost, 0),
                totalEC2Cost: orgMetrics.reduce((sum, metric) => sum + metric.totalEC2Cost, 0),
                totalNetCost: orgMetrics.reduce((sum, metric) => sum + metric.totalNetCost, 0),
                periodCount: orgMetrics.length,
                totalUserCount: uniqueUsers.size,
                totalTaskCount: orgMetrics.reduce((sum, metric) => sum + metric.totalTaskCount, 0),
                totalWorkspaceCount: orgMetrics.reduce((sum, metric) => sum + metric.totalWorkspaceCount, 0)
            };

            return breakdown;
        } catch (error) {
            this.logger.error('Failed to get organization cost breakdown', error);
            return {
                totalLLMCost: 0,
                totalEC2Cost: 0,
                totalNetCost: 0,
                periodCount: 0,
                totalUserCount: 0,
                totalTaskCount: 0,
                totalWorkspaceCount: 0
            };
        }
    }

    /**
     * Compare organization costs between two time periods
     * @param organizationId Organization ID
     * @param period1Start Period 1 start date
     * @param period1End Period 1 end date
     * @param period2Start Period 2 start date
     * @param period2End Period 2 end date
     */
    public async compareOrganizationCosts(
        organizationId: string,
        period1Start: Date,
        period1End: Date,
        period2Start: Date,
        period2End: Date
    ): Promise<{
        period1: {
            totalLLMCost: number;
            totalEC2Cost: number;
            totalNetCost: number;
            userCount: number;
            taskCount: number;
            workspaceCount: number;
        };
        period2: {
            totalLLMCost: number;
            totalEC2Cost: number;
            totalNetCost: number;
            userCount: number;
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
            userCountDiff: number;
            taskCountDiff: number;
            workspaceCountDiff: number;
        };
    }> {
        try {
            const repo = this.getRepository();

            // Get period 1 metrics
            const period1Metrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: period1Start } as any,
                'aggregationPeriod.endDate': { $lte: period1End } as any
            } as any);

            // Get period 2 metrics
            const period2Metrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: period2Start } as any,
                'aggregationPeriod.endDate': { $lte: period2End } as any
            } as any);

            // Aggregate period 1
            const period1 = {
                totalLLMCost: period1Metrics.reduce((sum, m) => sum + m.totalLLMCost, 0),
                totalEC2Cost: period1Metrics.reduce((sum, m) => sum + m.totalEC2Cost, 0),
                totalNetCost: period1Metrics.reduce((sum, m) => sum + m.totalNetCost, 0),
                userCount: period1Metrics.reduce((sum, m) => sum + m.userCount, 0),
                taskCount: period1Metrics.reduce((sum, m) => sum + m.totalTaskCount, 0),
                workspaceCount: period1Metrics.reduce((sum, m) => sum + m.totalWorkspaceCount, 0)
            };

            // Aggregate period 2
            const period2 = {
                totalLLMCost: period2Metrics.reduce((sum, m) => sum + m.totalLLMCost, 0),
                totalEC2Cost: period2Metrics.reduce((sum, m) => sum + m.totalEC2Cost, 0),
                totalNetCost: period2Metrics.reduce((sum, m) => sum + m.totalNetCost, 0),
                userCount: period2Metrics.reduce((sum, m) => sum + m.userCount, 0),
                taskCount: period2Metrics.reduce((sum, m) => sum + m.totalTaskCount, 0),
                workspaceCount: period2Metrics.reduce((sum, m) => sum + m.totalWorkspaceCount, 0)
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
                    : 0,
                userCountDiff: period2.userCount - period1.userCount,
                taskCountDiff: period2.taskCount - period1.taskCount,
                workspaceCountDiff: period2.workspaceCount - period1.workspaceCount
            };

            return { period1, period2, difference };
        } catch (error) {
            this.logger.error('Failed to compare organization costs', error);
            return {
                period1: { totalLLMCost: 0, totalEC2Cost: 0, totalNetCost: 0, userCount: 0, taskCount: 0, workspaceCount: 0 },
                period2: { totalLLMCost: 0, totalEC2Cost: 0, totalNetCost: 0, userCount: 0, taskCount: 0, workspaceCount: 0 },
                difference: { llmCostDiff: 0, ec2CostDiff: 0, netCostDiff: 0, llmCostPercent: 0, ec2CostPercent: 0, netCostPercent: 0, userCountDiff: 0, taskCountDiff: 0, workspaceCountDiff: 0 }
            };
        }
    }

    /**
     * Get top spending organizations
     * @param startDate Start date
     * @param endDate End date
     * @param limit Number of organizations to return (default 10)
     */
    public async getTopSpendingOrganizations(
        startDate: Date,
        endDate: Date,
        limit: number = 10
    ): Promise<Array<{
        organizationId: string;
        totalNetCost: number;
        totalLLMCost: number;
        totalEC2Cost: number;
        userCount: number;
        totalTaskCount: number;
        totalWorkspaceCount: number;
    }>> {
        try {
            const repo = this.getRepository();
            const orgMetrics = await repo.find({
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Group by organizationId and sum costs
            const orgCostMap = new Map<string, any>();
            for (const metrics of orgMetrics) {
                if (!orgCostMap.has(metrics.organizationId)) {
                    orgCostMap.set(metrics.organizationId, {
                        organizationId: metrics.organizationId,
                        totalNetCost: 0,
                        totalLLMCost: 0,
                        totalEC2Cost: 0,
                        userCount: 0,
                        totalTaskCount: 0,
                        totalWorkspaceCount: 0
                    });
                }

                const orgCost = orgCostMap.get(metrics.organizationId);
                orgCost.totalNetCost += metrics.totalNetCost;
                orgCost.totalLLMCost += metrics.totalLLMCost;
                orgCost.totalEC2Cost += metrics.totalEC2Cost;
                orgCost.userCount += metrics.userCount;
                orgCost.totalTaskCount += metrics.totalTaskCount;
                orgCost.totalWorkspaceCount += metrics.totalWorkspaceCount;
            }

            // Sort by totalNetCost descending and limit
            const topOrgs = Array.from(orgCostMap.values())
                .sort((a, b) => b.totalNetCost - a.totalNetCost)
                .slice(0, limit);

            return topOrgs;
        } catch (error) {
            this.logger.error('Failed to get top spending organizations', error);
            return [];
        }
    }

    /**
     * Get organization metrics for a specific period
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getOrganizationMetrics(organizationId: string, startDate: Date, endDate: Date): Promise<OrganizationMetricsAggregation[]> {
        try {
            const repo = this.getRepository();
            const metrics = await repo.find({
                organizationId: organizationId,
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            return metrics;
        } catch (error) {
            this.logger.error('Failed to get organization metrics', error);
            return [];
        }
    }

    /**
     * Get aggregated organization metrics as a single record for a specific period
     * This function takes the array from getOrganizationMetrics and aggregates it into one record
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     * @returns Single aggregated record with summed metrics
     */
    public async getAggregatedOrganizationMetrics(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<{
        organizationId: string;
        totalLLMCost: number;
        totalEC2Cost: number;
        totalNetCost: number;
        totalUserCount: number;
        totalTaskCount: number;
        totalWorkspaceCount: number;
        periodCount: number;
        aggregationPeriod: {
            startDate: Date;
            endDate: Date;
        };
        averageLLMCostPerPeriod: number;
        averageEC2CostPerPeriod: number;
        averageNetCostPerPeriod: number;
    }> {
        try {
            // Get the array of organization metrics
            const metricsArray = await this.getOrganizationMetrics(organizationId, startDate, endDate);

            // If no data found, return zeros
            if (!metricsArray || metricsArray.length === 0) {
                this.logger.warn('No metrics found for organization', { organizationId, startDate, endDate });
                return {
                    organizationId: organizationId,
                    totalLLMCost: 0,
                    totalEC2Cost: 0,
                    totalNetCost: 0,
                    totalUserCount: 0,
                    totalTaskCount: 0,
                    totalWorkspaceCount: 0,
                    periodCount: 0,
                    aggregationPeriod: {
                        startDate: startDate,
                        endDate: endDate
                    },
                    averageLLMCostPerPeriod: 0,
                    averageEC2CostPerPeriod: 0,
                    averageNetCostPerPeriod: 0
                };
            }

            // Aggregate all metrics into a single record
            const aggregated = metricsArray.reduce(
                (acc, metric) => {
                    acc.totalLLMCost += metric.totalLLMCost;
                    acc.totalEC2Cost += metric.totalEC2Cost;
                    acc.totalNetCost += metric.totalNetCost;
                    acc.totalUserCount += metric.userCount;
                    acc.totalTaskCount += metric.totalTaskCount;
                    acc.totalWorkspaceCount += metric.totalWorkspaceCount;
                    acc.periodCount += 1;
                    return acc;
                },
                {
                    totalLLMCost: 0,
                    totalEC2Cost: 0,
                    totalNetCost: 0,
                    totalUserCount: 0,
                    totalTaskCount: 0,
                    totalWorkspaceCount: 0,
                    periodCount: 0
                }
            );

            // Calculate averages per period
            const averageLLMCostPerPeriod = aggregated.periodCount > 0 
                ? aggregated.totalLLMCost / aggregated.periodCount 
                : 0;
            const averageEC2CostPerPeriod = aggregated.periodCount > 0 
                ? aggregated.totalEC2Cost / aggregated.periodCount 
                : 0;
            const averageNetCostPerPeriod = aggregated.periodCount > 0 
                ? aggregated.totalNetCost / aggregated.periodCount 
                : 0;

            this.logger.info('Aggregated organization metrics into single record', {
                organizationId,
                periodCount: aggregated.periodCount,
                totalNetCost: aggregated.totalNetCost.toFixed(2)
            });

            return {
                organizationId: organizationId,
                totalLLMCost: aggregated.totalLLMCost,
                totalEC2Cost: aggregated.totalEC2Cost,
                totalNetCost: aggregated.totalNetCost,
                totalUserCount: aggregated.totalUserCount,
                totalTaskCount: aggregated.totalTaskCount,
                totalWorkspaceCount: aggregated.totalWorkspaceCount,
                periodCount: aggregated.periodCount,
                aggregationPeriod: {
                    startDate: startDate,
                    endDate: endDate
                },
                averageLLMCostPerPeriod: averageLLMCostPerPeriod,
                averageEC2CostPerPeriod: averageEC2CostPerPeriod,
                averageNetCostPerPeriod: averageNetCostPerPeriod
            };
        } catch (error) {
            this.logger.error('Failed to get aggregated organization metrics', error);
            return {
                organizationId: organizationId,
                totalLLMCost: 0,
                totalEC2Cost: 0,
                totalNetCost: 0,
                totalUserCount: 0,
                totalTaskCount: 0,
                totalWorkspaceCount: 0,
                periodCount: 0,
                aggregationPeriod: {
                    startDate: startDate,
                    endDate: endDate
                },
                averageLLMCostPerPeriod: 0,
                averageEC2CostPerPeriod: 0,
                averageNetCostPerPeriod: 0
            };
        }
    }

    /**
     * Re-aggregate: Delete existing organization metrics for the period and create new ones
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async reAggregate(startDate: Date, endDate: Date): Promise<{ success: boolean; error?: string }> {
        try {
            const repo = this.getRepository();

            // Delete existing organization metrics for this period
            await repo.deleteMany({
                'aggregationPeriod.startDate': startDate,
                'aggregationPeriod.endDate': endDate
            } as any);

            this.logger.info('Deleted existing organization metrics for period', { startDate, endDate });

            // Create new organization metrics
            const result = await this.aggregateAndSave(startDate, endDate);
            return result;
        } catch (error) {
            this.logger.error('Failed to re-aggregate organization metrics', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Get all organizations with costs in a given period
     * @param startDate Start date
     * @param endDate End date
     */
    public async getOrganizationsWithCosts(
        startDate: Date,
        endDate: Date
    ): Promise<string[]> {
        try {
            const repo = this.getRepository();
            const orgMetrics = await repo.find({
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            // Get unique organization IDs
            const uniqueOrgs = Array.from(new Set(orgMetrics.map(m => m.organizationId)));
            return uniqueOrgs;
        } catch (error) {
            this.logger.error('Failed to get organizations with costs', error);
            return [];
        }
    }

    /**
     * Get average cost per user for an organization
     * @param organizationId Organization ID
     * @param startDate Start date
     * @param endDate End date
     */
    public async getAverageCostPerUser(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<{
        averageLLMCostPerUser: number;
        averageEC2CostPerUser: number;
        averageNetCostPerUser: number;
        totalUsers: number;
        totalCost: number;
    }> {
        try {
            const breakdown = await this.getOrganizationCostBreakdown(organizationId, startDate, endDate);

            if (breakdown.totalUserCount === 0) {
                return {
                    averageLLMCostPerUser: 0,
                    averageEC2CostPerUser: 0,
                    averageNetCostPerUser: 0,
                    totalUsers: 0,
                    totalCost: 0
                };
            }

            return {
                averageLLMCostPerUser: breakdown.totalLLMCost / breakdown.totalUserCount,
                averageEC2CostPerUser: breakdown.totalEC2Cost / breakdown.totalUserCount,
                averageNetCostPerUser: breakdown.totalNetCost / breakdown.totalUserCount,
                totalUsers: breakdown.totalUserCount,
                totalCost: breakdown.totalNetCost
            };
        } catch (error) {
            this.logger.error('Failed to get average cost per user', error);
            return {
                averageLLMCostPerUser: 0,
                averageEC2CostPerUser: 0,
                averageNetCostPerUser: 0,
                totalUsers: 0,
                totalCost: 0
            };
        }
    }

    /**
     * Get all organization metrics across all organizations for a period
     * Useful for global analytics
     * @param startDate Start date
     * @param endDate End date
     */
    public async getAllOrganizationMetrics(
        startDate: Date,
        endDate: Date
    ): Promise<{
        totalOrganizations: number;
        totalCost: number;
        totalLLMCost: number;
        totalEC2Cost: number;
        totalUsers: number;
        totalTasks: number;
        totalWorkspaces: number;
        organizations: OrganizationMetricsAggregation[];
    }> {
        try {
            const repo = this.getRepository();
            const allMetrics = await repo.find({
                'aggregationPeriod.startDate': { $gte: startDate } as any,
                'aggregationPeriod.endDate': { $lte: endDate } as any
            } as any);

            const uniqueOrgs = new Set(allMetrics.map(m => m.organizationId));

            return {
                totalOrganizations: uniqueOrgs.size,
                totalCost: allMetrics.reduce((sum, m) => sum + m.totalNetCost, 0),
                totalLLMCost: allMetrics.reduce((sum, m) => sum + m.totalLLMCost, 0),
                totalEC2Cost: allMetrics.reduce((sum, m) => sum + m.totalEC2Cost, 0),
                totalUsers: allMetrics.reduce((sum, m) => sum + m.userCount, 0),
                totalTasks: allMetrics.reduce((sum, m) => sum + m.totalTaskCount, 0),
                totalWorkspaces: allMetrics.reduce((sum, m) => sum + m.totalWorkspaceCount, 0),
                organizations: allMetrics
            };
        } catch (error) {
            this.logger.error('Failed to get all organization metrics', error);
            return {
                totalOrganizations: 0,
                totalCost: 0,
                totalLLMCost: 0,
                totalEC2Cost: 0,
                totalUsers: 0,
                totalTasks: 0,
                totalWorkspaces: 0,
                organizations: []
            };
        }
    }


    /**
     * Get daily costs for an organization in a given date range (for bar graph)
     * Aggregates hourly data into daily buckets
     * @param organizationId Organization ID
     * @param startDate Start date (00:00:00)
     * @param endDate End date (23:59:59.999)
     * @returns Array of daily cost data
     */
    public async getDailyCostsForDateRange(
        organizationId: string,
        startDate: Date,
        endDate: Date
    ): Promise<Array<{
        date: string;
        llmCost: number;
        ec2Cost: number;
        netCost: number;
        taskCount: number;
        wpCount: number;
    }>> {
        try {
            const repo = this.getRepository();

            // MongoDB aggregation pipeline to group by day
            const pipeline = [
                // Match organization and date range
                {
                    $match: {
                        organizationId: organizationId,
                        'aggregationPeriod.startDate': { $gte: startDate, $lte: endDate }
                    }
                },
                // Add a field for the day (YYYY-MM-DD)
                {
                    $addFields: {
                        day: {
                            $dateToString: {
                                format: '%Y-%m-%d',
                                date: '$aggregationPeriod.startDate'
                            }
                        }
                    }
                },
                // Group by day and sum costs
                {
                    $group: {
                        _id: '$day',
                        llmCost: { $sum: '$totalLLMCost' },
                        ec2Cost: { $sum: '$totalEC2Cost' },
                        netCost: { $sum: '$totalNetCost' },
                        taskCount: { $sum: '$totalTaskCount' },
                        wpCount: { $sum: '$totalWorkspaceCount' }
                    }
                },
                // Sort by date
                {
                    $sort: { _id: 1 }
                },
                // Format output
                {
                    $project: {
                        _id: 0,
                        date: '$_id',
                        llmCost: 1,
                        ec2Cost: 1,
                        netCost: 1,
                        taskCount: 1,
                        wpCount: 1
                    }
                }
            ];

            const results = await repo.aggregate(pipeline) as Array<{
                date: string;
                llmCost: number;
                ec2Cost: number;
                netCost: number;
                taskCount: number;
                wpCount: number;
            }>;
            
            this.logger.info('Retrieved daily costs for organization', {
                organizationId,
                dayCount: results.length
            });

            return results;
        } catch (error) {
            this.logger.error('Failed to get daily costs for date range', error);
            return [];
        }
    }
}

export default OrganizationMetricsService;
