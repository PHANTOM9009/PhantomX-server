import { TaskWorkspaceCostService } from '../DataAccessLayer/TaskWorkspaceCostService';
import { UserMetricsService } from '../DataAccessLayer/UserMetricsService';
import { OrganizationMetricsService } from '../DataAccessLayer/OrganizationMetricsService';
import { Logger } from '../utils/Logger';
import pLimit from 'p-limit';
import LLMMetricsService from '../DataAccessLayer/LLMMetricsService';
import EC2MetricsService from '../DataAccessLayer/EC2MetricsService';

/**
 * Configuration for metrics aggregation
 */
export interface MetricsAggregationConfig {
    concurrency?: number;      // Number of organizations to process in parallel (default: 10)
    retryAttempts?: number;    // Number of retry attempts for failed orgs (default: 2)
    retryDelayMs?: number;     // Delay between retries in milliseconds (default: 5000)
    timeoutMs?: number;        // Timeout for each org aggregation in milliseconds (default: 300000 = 5 min)
}



/**
 * Result of aggregating a single organization
 */
export interface OrganizationAggregationResult {
    organizationId: string;
    organizationName?: string;
    dbName: string;
    success: boolean;
    duration: number;
    startDate: Date;
    endDate: Date;
    taskWorkspaceCount?: number;
    userCount?: number;
    orgMetricsCount?: number;
    error?: string;
    attemptNumber: number;
}

/**
 * Summary of entire aggregation batch
 */
export interface AggregationBatchSummary {
    totalOrganizations: number;
    successful: number;
    failed: number;
    totalDuration: number;
    startTime: Date;
    endTime: Date;
    results: OrganizationAggregationResult[];
    failedOrganizations: string[];
}

/**
 * Service for handling batched parallel metrics aggregation across multiple organizations
 */
export class MetricsAggregationService {
    private logger: Logger;
    private config: Required<MetricsAggregationConfig>;
    private currentBatch: AggregationBatchSummary | null = null;
    private isRunning: boolean = false;

    constructor(config?: MetricsAggregationConfig) {
        this.logger = new Logger('MetricsAggregationService');
        
        // Set default config
        this.config = {
            concurrency: config?.concurrency || 10,
            retryAttempts: config?.retryAttempts || 2,
            retryDelayMs: config?.retryDelayMs || 5000,
            timeoutMs: config?.timeoutMs || 300000  // 5 minutes per org
        };

    }

    /**
     * Check if aggregation is currently running
     */
    public getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get the current/last batch summary
     */
    public getCurrentBatchSummary(): AggregationBatchSummary | null {
        return this.currentBatch;
    }
    /**
     * Public method to aggregate a single organization (for queue workers)
     * This method is optimized for processing one organization at a time
     * without the overhead of batch processing and p-limit
     * 
     * @param orgId Organization ID
     * @param dbName Database name
     * @param orgName Organization name (optional, for logging)
     * @param startDate Start date for aggregation
     * @param endDate End date for aggregation
     * @returns Promise<OrganizationAggregationResult>
     */
    public async aggregateOrganization(
        orgId: string,
        dbName: string,
        orgName: string | undefined,
        startDate: Date,
        endDate: Date
    ): Promise<OrganizationAggregationResult> {
        return await this.aggregateSingleOrganization(
            orgId,
            dbName,
            orgName,
            startDate,
            endDate,
            1  // First attempt
        );
    }

    /**
     * Aggregate metrics for a single organization
     * @param orgId Organization ID
     * @param dbName Database name
     * @param orgName Organization name (optional, for logging)
     * @param startDate Start date for aggregation
     * @param endDate End date for aggregation
     * @param attemptNumber Current attempt number
     */
    private async aggregateSingleOrganization(
        orgId: string,
        dbName: string,
        orgName: string | undefined,
        startDate: Date,
        endDate: Date,
        attemptNumber: number
    ): Promise<OrganizationAggregationResult> {
        const startTime = Date.now();
        const logContext = `[Org: ${orgName || orgId}] [DB: ${dbName}]`;

        try {
            // step 0 : Aggregate EC2Metrics and LLM Metrics
            const llmMetricsAgg = new LLMMetricsService(dbName);
            await llmMetricsAgg.aggregateAndSave(startDate, endDate);

            // aggregating ec2 metrcis
            const ec2MetricsAgg = new EC2MetricsService(dbName);
            await ec2MetricsAgg.aggregateAndSave(startDate, endDate);
            

            // Step 1: Aggregate Task/Workspace costs
            const taskWpService = new TaskWorkspaceCostService(dbName);
            const taskWpResult = await this.executeWithTimeout(
                taskWpService.aggregateAndSave(startDate, endDate),
                this.config.timeoutMs,
                'Task/Workspace aggregation'
            );

            if (!taskWpResult.success) {
                throw new Error(`Task/Workspace aggregation failed: ${taskWpResult.error}`);
            }


            // Step 2: Aggregate User metrics
            const userService = new UserMetricsService(dbName);
            const userResult = await this.executeWithTimeout(
                userService.aggregateAndSave(startDate, endDate),
                this.config.timeoutMs,
                'User metrics aggregation'
            );

            if (!userResult.success) {
                throw new Error(`User metrics aggregation failed: ${userResult.error}`);
            }


            // Step 3: Aggregate Organization metrics
            const orgService = new OrganizationMetricsService(dbName);
            const orgResult = await this.executeWithTimeout(
                orgService.aggregateAndSave(startDate, endDate),
                this.config.timeoutMs,
                'Organization metrics aggregation'
            );

            if (!orgResult.success) {
                throw new Error(`Organization metrics aggregation failed: ${orgResult.error}`);
            }

            // Get detailed cost breakdown
            const costBreakdown = await orgService.getOrganizationCostBreakdown(orgId, startDate, endDate);

            // Final comprehensive log
            this.logger.success(`${logContext} Metrics Aggregation Completed Successfully`, {
                organizationId: orgId,
                organizationName: orgName || 'Unknown',
                dbName,
                duration: `${(Date.now() - startTime) / 1000}s`,
                period: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString()
                },
                processed: {
                    taskWorkspaces: taskWpResult.aggregatedCount,
                    users: userResult.aggregatedCount,
                    organizations: orgResult.aggregatedCount
                },
                costBreakdown: {
                    totalLLMCost: `$${costBreakdown.totalLLMCost.toFixed(4)}`,
                    totalEC2Cost: `$${costBreakdown.totalEC2Cost.toFixed(4)}`,
                    totalNetCost: `$${costBreakdown.totalNetCost.toFixed(4)}`,
                    totalUsers: costBreakdown.totalUserCount,
                    totalTasks: costBreakdown.totalTaskCount,
                    totalWorkspaces: costBreakdown.totalWorkspaceCount
                },
                attemptNumber
            });

            return {
                organizationId: orgId,
                organizationName: orgName,
                dbName,
                success: true,
                duration: Date.now() - startTime,
                startDate,
                endDate,
                taskWorkspaceCount: taskWpResult.aggregatedCount,
                userCount: userResult.aggregatedCount,
                orgMetricsCount: orgResult.aggregatedCount,
                attemptNumber
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            this.logger.error(`${logContext} Aggregation Failed (attempt ${attemptNumber})`, {
                organizationId: orgId,
                organizationName: orgName || 'Unknown',
                dbName,
                error: errorMessage,
                duration: `${(Date.now() - startTime) / 1000}s`,
                period: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString()
                }
            });

            return {
                organizationId: orgId,
                organizationName: orgName,
                dbName,
                success: false,
                duration: Date.now() - startTime,
                startDate,
                endDate,
                error: errorMessage,
                attemptNumber
            };
        }
    }

    /**
     * Execute a promise with timeout
     */
    private async executeWithTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        operationName: string
    ): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>((_, reject) =>
                setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
            )
        ]);
    }

    /**
     * Retry failed organization aggregation
     */
    private async retryOrganization(
        orgId: string,
        dbName: string,
        orgName: string | undefined,
        startDate: Date,
        endDate: Date,
        previousAttempts: number
    ): Promise<OrganizationAggregationResult> {
        const logContext = `[Org: ${orgName || orgId}] [DB: ${dbName}]`;
        this.logger.warn(`${logContext} Retrying aggregation (attempt ${previousAttempts + 1})`);
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));

        return this.aggregateSingleOrganization(
            orgId,
            dbName,
            orgName,
            startDate,
            endDate,
            previousAttempts + 1
        );
    }

    /**
     * Aggregate metrics for multiple organizations in batches
     * @param organizations Array of organization info
     * @param startDate Start date for aggregation period
     * @param endDate End date for aggregation period
     */
    public async aggregateBatch(
        organizations: Array<{
            organizationId: string;
            dbName: string;
            organizationName?: string;
        }>,
        startDate: Date,
        endDate: Date
    ): Promise<AggregationBatchSummary> {
        if (this.isRunning) {
            throw new Error('Aggregation batch is already running. Please wait for it to complete.');
        }

        this.isRunning = true;
        const batchStartTime = Date.now();


        // Initialize batch summary
        this.currentBatch = {
            totalOrganizations: organizations.length,
            successful: 0,
            failed: 0,
            totalDuration: 0,
            startTime: new Date(),
            endTime: new Date(),
            results: [],
            failedOrganizations: []
        };

        try {
            // Create concurrency limiter
            const limit = pLimit(this.config.concurrency);

            // Process all organizations with controlled concurrency
            const results = await Promise.allSettled(
                organizations.map(org =>
                    limit(async () => {
                        let result = await this.aggregateSingleOrganization(
                            org.organizationId,
                            org.dbName,
                            org.organizationName,
                            startDate,
                            endDate,
                            1
                        );

                        // Retry if failed
                        let retryCount = 0;
                        while (!result.success && retryCount < this.config.retryAttempts) {

                            result = await this.retryOrganization(
                                org.organizationId,
                                org.dbName,
                                org.organizationName,
                                startDate,
                                endDate,
                                result.attemptNumber
                            );

                            retryCount++;
                        }

                        return result;
                    })
                )
            );

            // Process results
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    const orgResult = result.value;
                    this.currentBatch.results.push(orgResult);

                    if (orgResult.success) {
                        this.currentBatch.successful++;
                    } else {
                        this.currentBatch.failed++;
                        this.currentBatch.failedOrganizations.push(orgResult.organizationId);
                    }
                } else {
                    // Promise itself was rejected (shouldn't happen with our error handling, but just in case)
                    this.currentBatch.failed++;
                    this.logger.error('Unexpected promise rejection', result.reason);
                }
            }

            this.currentBatch.totalDuration = Date.now() - batchStartTime;
            this.currentBatch.endTime = new Date();

            // Calculate total costs across all successful organizations
            let totalCosts = {
                llm: 0,
                ec2: 0,
                net: 0
            };
            
            const successfulOrgs = this.currentBatch.results.filter(r => r.success);
            
            // Log summary
            this.logger.success('✓ Batch Aggregation Completed', {
                period: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString()
                },
                organizations: {
                    total: this.currentBatch.totalOrganizations,
                    successful: this.currentBatch.successful,
                    failed: this.currentBatch.failed,
                    successRate: ((this.currentBatch.successful / this.currentBatch.totalOrganizations) * 100).toFixed(2) + '%'
                },
                duration: `${(this.currentBatch.totalDuration / 1000).toFixed(2)}s`,
                averagePerOrg: `${(this.currentBatch.totalDuration / this.currentBatch.totalOrganizations / 1000).toFixed(2)}s`
            });

            // Log failed organizations if any
            if (this.currentBatch.failed > 0) {
                const failedDetails = this.currentBatch.results
                    .filter(r => !r.success)
                    .map(r => ({
                        orgName: r.organizationName || 'Unknown',
                        orgId: r.organizationId,
                        dbName: r.dbName,
                        error: r.error,
                        attempts: r.attemptNumber
                    }));

                this.logger.error('✗ Failed Organizations Details', {
                    count: this.currentBatch.failed,
                    failures: failedDetails
                });
            }

            return this.currentBatch;

        } catch (error) {
            this.logger.error('Batch aggregation failed with unexpected error', error);
            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Get failed organizations from the last batch for retry
     */
    public getFailedOrganizations(): string[] {
        return this.currentBatch?.failedOrganizations || [];
    }

    /**
     * Get aggregation statistics
     */
    public getStatistics(): {
        isRunning: boolean;
        lastBatch: {
            totalOrganizations: number;
            successful: number;
            failed: number;
            successRate: string;
            totalDuration: number;
            averageDurationPerOrg: number;
            startTime: Date;
            endTime: Date;
        } | null;
    } {
        if (!this.currentBatch) {
            return {
                isRunning: this.isRunning,
                lastBatch: null
            };
        }

        return {
            isRunning: this.isRunning,
            lastBatch: {
                totalOrganizations: this.currentBatch.totalOrganizations,
                successful: this.currentBatch.successful,
                failed: this.currentBatch.failed,
                successRate: ((this.currentBatch.successful / this.currentBatch.totalOrganizations) * 100).toFixed(2) + '%',
                totalDuration: this.currentBatch.totalDuration,
                averageDurationPerOrg: this.currentBatch.totalDuration / this.currentBatch.totalOrganizations,
                startTime: this.currentBatch.startTime,
                endTime: this.currentBatch.endTime
            }
        };
    }
}

export default MetricsAggregationService;
