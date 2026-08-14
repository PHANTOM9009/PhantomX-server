import cron, { ScheduledTask } from 'node-cron';
import { MetricsAggregationQueue } from './MetricsAggregationQueue';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import { IOrganization } from '../DataAccessLayer/models';
import * as dotenv from "dotenv";
dotenv.config();

// Logging has been optimized to reduce verbosity while maintaining error tracking
// Only critical errors, warnings, and final success messages are logged
/**
 * Configuration for the metrics aggregation cron job
 */
export interface MetricsCronConfig {
    enabled?: boolean;              // Enable/disable cron (default: true)
    schedule?: string;              // Cron schedule (default: '0 * * * *' - every hour)
    concurrency?: number;           // Number of orgs to process in parallel (default: 10)
    retryAttempts?: number;         // Retry attempts for failed orgs (default: 2)
    alertOnFailureThreshold?: number; // Alert if failures exceed this % (default: 10)
    runOnStartup?: boolean;         // Run aggregation on startup (default: false)
}

/**
 * Organization data structure for aggregation
 */
interface OrganizationData {
    organizationId: string;
    organizationName: string;
    dbName: string;
    subscriptionTier?: string;
}

/**
 * Cron job manager for metrics aggregation
 */
export class MetricsAggregationCron {
    private logger: Logger;
    private config: Required<MetricsCronConfig>;
    private cronTask: ScheduledTask | null = null;
    private aggregationQueue: MetricsAggregationQueue;
    private dbService: DatabaseService;
    private lastRunTime: Date | null = null;
    private lastEnqueuedCount: number = 0;

    constructor(config?: MetricsCronConfig) {
        this.logger = new Logger('MetricsAggregationCron');
        this.dbService = DatabaseService.getInstance();

        // Set default config
        this.config = {
            enabled: config?.enabled !== undefined ? config.enabled : true,
            schedule: process.env.CRON_JOB_TIMER as any || config?.schedule, //Every hour
            concurrency: config?.concurrency || 10,
            retryAttempts: config?.retryAttempts || 2,
            alertOnFailureThreshold: config?.alertOnFailureThreshold || 10,
            runOnStartup: config?.runOnStartup || false
        };

        // Initialize aggregation queue with worker pool
        this.aggregationQueue = new MetricsAggregationQueue({
            concurrency: this.config.concurrency,
            retryAttempts: this.config.retryAttempts
        });

    }

    /**
     * Get all organizations from the database
     * This needs to be implemented based on your database structure
     */
    private async getAllOrganizations(): Promise<OrganizationData[]> {
        try {
            // Get all unique organizations from UserInfo map
            const organizations: OrganizationData[] = [];
           //fetching the organizations from db
            let dbService = await getDBService();
            let handler = dbService.getRepository<IOrganization>('Organizations','Organizations');
            let orgData = await handler.find();
 
            for(let data of orgData)
            {
                organizations.push({
                    organizationId: data.OrganizationId,
                    organizationName:data.organizationName,
                    dbName: data.dbName
                })
            }
            return organizations;

            
        } catch (error) {
            this.logger.error('Failed to get organizations', error);
            throw error;
        }
    }

    /**
     * Calculate the time period for aggregation
     * Returns the previous completed hour
     */
    private getAggregationPeriod(): { startDate: Date; endDate: Date } {
         const now = new Date();

        // End date: start of current hour
        const endDate = new Date(now);
        endDate.setMinutes(0, 0, 0);
        endDate.setMilliseconds(-1);  // Last millisecond of previous hour

        // Start date: 1 hour before end date
        const startDate = new Date(endDate);
        startDate.setHours(startDate.getHours() - 1); // for every 15 minutes.
        startDate.setMilliseconds(1);  // First millisecond of the hour

        return { startDate, endDate };


       


    }


    /**
     * Execute the aggregation job
     * Now it only enqueues jobs without waiting for completion
     */
    private async executeAggregation(): Promise<void> {
        const jobStartTime = Date.now();
        const cronStartTime = new Date();

        try {

            // Get database service and repository
            let dbService = await getDBService();
            await dbService.ensureCollection('General', 'CostAggregationLastRan');
            let repo = dbService.getRepository('General', 'CostAggregationLastRan');

            // Get the last run time from database
            let results = await repo.find();
            let startDate: Date;
            const intervalMinutes = parseInt(process.env.COST_AGGREGATION_INTERVAL_MINUTES || '15', 10);
            if (results.length > 0 && results[0].Time) {
                // Start from last run time + 1 millisecond
                startDate = new Date(results[0].Time);
                startDate.setMilliseconds(startDate.getMilliseconds() + 1);
            } else {
                // No previous run found, start from 1 hour ago
                startDate = new Date();
               // startDate.setHours(startDate.getHours() - intervalMinutes/60 );
                startDate.setMinutes(startDate.getMinutes() - intervalMinutes); 
               startDate.setSeconds(0, 0);
            }

            // Get interval from environment variable (default to 15 minutes)
            
            
            // Calculate end date as startDate + interval minutes
            // const endDate = new Date(startDate);
            // endDate.setMinutes(endDate.getMinutes() + intervalMinutes);
          //  endDate.setMilliseconds(endDate.getMilliseconds() - 1); // Last millisecond of the interval
        
            let endDate = cronStartTime;
            endDate.setSeconds(0, 0); // Round down to nearest minute
            // Update the CostAggregationLastRan collection with the new endDate
            if (results.length > 0) {
                // Update existing record
                await repo.updateOne(
                    {},
                    {
                        $set: {
                            "Time": endDate,
                            "CronStartTime": cronStartTime
                        }
                    }
                );
            } else {
                // Insert new record
                await repo.insertOne({
                    "Time": endDate,
                    "CronStartTime": cronStartTime
                });
            }

            // Get all organizations
            const organizations = await this.getAllOrganizations();

            if (organizations.length === 0) {
                this.logger.warn('No organizations found for aggregation');
                return;
            }

            // Enqueue all organizations to the queue (non-blocking)
            const result = await this.aggregationQueue.enqueueBatch(
                organizations,
                startDate,
                endDate,
                cronStartTime
            );

            // Store last run info
            this.lastRunTime = cronStartTime;
            this.lastEnqueuedCount = result.totalEnqueued;

            const totalDuration = Date.now() - jobStartTime;

            this.logger.success('Scheduled metrics aggregation jobs enqueued', {
                duration: totalDuration,
                organizations: result.totalEnqueued,
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                cronStartTime: cronStartTime.toISOString()
            });

        } catch (error) {
            this.logger.error('Failed to enqueue aggregation jobs', error);
            throw error;
        }
    }

    /**
     * Start the cron job and queue workers
     */
    public async start(): Promise<void> {
        if (!this.config.enabled) {
            this.logger.info('Metrics aggregation cron is disabled');
            return;
        }

        if (this.cronTask) {
            this.logger.warn('Cron job is already running');
            return;
        }

        // Validate cron schedule
        if (!cron.validate(this.config.schedule)) {
            throw new Error(`Invalid cron schedule: ${this.config.schedule}`);
        }

        // Start the queue workers first
        await this.aggregationQueue.start();


        // Create cron task
        this.cronTask = cron.schedule(
            this.config.schedule,
            async () => {
                try {
                    await this.executeAggregation();
                } catch (error) {
                    this.logger.error('Cron job execution failed', error);
                }
            },
            {
                timezone: 'UTC'  // Use UTC for consistency
            }
        );

        this.logger.success('Metrics aggregation cron started');

        // Run on startup if configured
        if (this.config.runOnStartup) {
            setTimeout(async () => {
                try {
                    await this.executeAggregation();
                } catch (error) {
                    this.logger.error('Startup aggregation failed', error);
                }
            }, 5000);  // Wait 5 seconds after startup
        }
    }

    /**
     * Stop the cron job and queue workers
     */
    public async stop(): Promise<void> {
        if (!this.cronTask) {
            this.logger.warn('Cron job is not running');
            return;
        }

        this.cronTask.stop();
        this.cronTask = null;

        // Stop queue workers
        await this.aggregationQueue.stop();

    }

    /**
     * Manually trigger aggregation (enqueues jobs)
     */
    public async triggerManual(startDate?: Date, endDate?: Date): Promise<{
        totalEnqueued: number;
        jobIds: string[];
        startDate: Date;
        endDate: Date;
        cronStartTime: Date;
    }> {

        const cronStartTime = new Date();

        // Use provided dates or calculate default period
        const period = startDate && endDate
            ? { startDate, endDate }
            : this.getAggregationPeriod();

        const organizations = await this.getAllOrganizations();

        const result = await this.aggregationQueue.enqueueBatch(
            organizations,
            period.startDate,
            period.endDate,
            cronStartTime
        );

        this.lastRunTime = cronStartTime;
        this.lastEnqueuedCount = result.totalEnqueued;

        return {
            ...result,
            startDate: period.startDate,
            endDate: period.endDate,
            cronStartTime
        };
    }

    /**
     * Get status of the cron job and queue
     */
    public async getStatus(): Promise<{
        isRunning: boolean;
        queueStatus: any;
        config: Required<MetricsCronConfig>;
        lastRunTime: Date | null;
        lastEnqueuedCount: number;
        nextRunTime: Date | null;
    }> {
        let nextRunTime: Date | null = null;

        // Calculate next run time based on cron schedule
        if (this.cronTask) {
            // This is a simplified calculation - for exact next run time,
            // you'd need a library like 'cron-parser'
            const now = new Date();
            nextRunTime = new Date(now);
            nextRunTime.setHours(now.getHours() + 1, 0, 0, 0);
        }

        const queueStats = await this.aggregationQueue.getStats();

        return {
            isRunning: this.cronTask !== null,
            queueStatus: queueStats,
            config: this.config,
            lastRunTime: this.lastRunTime,
            lastEnqueuedCount: this.lastEnqueuedCount,
            nextRunTime
        };
    }

    /**
     * Get detailed statistics from queue
     */
    public async getStatistics() {
        return await this.aggregationQueue.getStats();
    }

    /**
     * Get queue instance for advanced operations
     */
    public getQueue(): MetricsAggregationQueue {
        return this.aggregationQueue;
    }
}

export default MetricsAggregationCron;
