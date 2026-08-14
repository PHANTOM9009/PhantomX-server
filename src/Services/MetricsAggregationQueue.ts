import { QueueService } from './Queue/QueueService';
import { QueueWorker } from './Queue/QueueWorker';
import { QueueJob, QueueJobOptions } from './Queue/types';
import { Logger } from '../utils/Logger';
import { MetricsAggregationService, OrganizationAggregationResult } from './MetricsAggregationService';

/**
 * Job data structure for metrics aggregation queue
 */
export interface MetricsAggregationJobData {
    organizationId: string;
    organizationName: string;
    dbName: string;
    startDate: Date;
    endDate: Date;
    cronStartTime: Date; // When the cron job that created this task started
}

/**
 * Configuration for the metrics aggregation queue
 */
export interface MetricsQueueConfig {
    concurrency?: number;           // Number of concurrent workers (default: 10)
    retryAttempts?: number;        // Retry attempts per job (default: 2)
    retryDelayMs?: number;         // Delay between retries (default: 5000)
    timeoutMs?: number;            // Timeout per job (default: 300000 = 5 min)
}

/**
 * Queue manager for metrics aggregation with async worker pool
 */
export class MetricsAggregationQueue {
    private logger: Logger;
    private config: Required<MetricsQueueConfig>;
    private queue: QueueService;
    private workers: QueueWorker<MetricsAggregationJobData, OrganizationAggregationResult>[] = [];
    private aggregationService: MetricsAggregationService;
    private isInitialized: boolean = false;

    // Statistics
    private stats = {
        totalEnqueued: 0,
        totalProcessed: 0,
        totalSuccessful: 0,
        totalFailed: 0,
        currentlyProcessing: 0
    };

    constructor(config?: MetricsQueueConfig) {
        this.logger = new Logger('MetricsAggregationQueue');
        
        // Set default config
        this.config = {
            concurrency: config?.concurrency || 10,
            retryAttempts: config?.retryAttempts || 2,
            retryDelayMs: config?.retryDelayMs || 5000,
            timeoutMs: config?.timeoutMs || 300000
        };

        // Initialize queue service
        this.queue = new QueueService({
            name: 'metrics-aggregation',
            defaultJobOptions: {
                attempts: this.config.retryAttempts + 1, // +1 for initial attempt
                backoff: {
                    type: 'fixed',
                    delay: this.config.retryDelayMs
                },
                timeout: this.config.timeoutMs,
                removeOnComplete: true, // Clean up completed jobs
                removeOnFail: false     // Keep failed jobs for inspection
            }
        });

        // Initialize aggregation service (will be used by workers)
        // Note: concurrency is 1 because each worker processes one org at a time
        // The queue workers provide the concurrency control
        this.aggregationService = new MetricsAggregationService({
            concurrency: 1,
            retryAttempts: 0 // Retry is handled by queue
        });

        this.setupEventListeners();
        
    }

    /**
     * Setup event listeners for queue monitoring
     */
    private setupEventListeners(): void {
        this.queue.on('added', (job: QueueJob) => {
            this.stats.totalEnqueued++;
        });

        this.queue.on('active', (job: QueueJob) => {
            this.stats.currentlyProcessing++;
        });

        this.queue.on('completed', (job: QueueJob, result: OrganizationAggregationResult) => {
            this.stats.currentlyProcessing--;
            this.stats.totalProcessed++;
            this.stats.totalSuccessful++;
            
            // Log successful completion with details
            const jobData = job.data as MetricsAggregationJobData;
            this.logger.success(`✓ [Org: ${jobData.organizationName}] [DB: ${jobData.dbName}] Queue Job Completed`, {
                jobId: job.id,
                organizationId: jobData.organizationId,
                organizationName: jobData.organizationName,
                dbName: jobData.dbName,
                duration: `${result.duration / 1000}s`,
                processed: {
                    taskWorkspaces: result.taskWorkspaceCount,
                    users: result.userCount,
                    organizations: result.orgMetricsCount
                }
            });
        });

        this.queue.on('failed', (job: QueueJob, error: Error) => {
            this.stats.currentlyProcessing--;
            this.stats.totalProcessed++;
            this.stats.totalFailed++;
            
            const jobData = job.data as MetricsAggregationJobData;
            this.logger.error(`✗ [Org: ${jobData.organizationName}] [DB: ${jobData.dbName}] Queue Job Failed`, {
                jobId: job.id,
                organizationId: jobData.organizationId,
                organizationName: jobData.organizationName,
                dbName: jobData.dbName,
                error: error.message,
                attempts: job.attemptsMade,
                maxAttempts: job.attemptsMax,
                period: {
                    start: jobData.startDate.toISOString(),
                    end: jobData.endDate.toISOString()
                }
            });
        });

        this.queue.on('retrying', (job: QueueJob, error: Error) => {
            const jobData = job.data as MetricsAggregationJobData;
            this.logger.warn(`⟳ [Org: ${jobData.organizationName}] [DB: ${jobData.dbName}] Retrying job`, {
                jobId: job.id,
                attempt: job.attemptsMade + 1,
                maxAttempts: job.attemptsMax,
                error: error.message
            });
        });
    }

    /**
     * Job processor function - processes a single organization
     * This is called by queue workers for each job
     * 
     * OPTIMIZED: Now calls aggregateOrganization() directly
     * instead of aggregateBatch() with single org
     */
    private async processJob(job: QueueJob<MetricsAggregationJobData>): Promise<OrganizationAggregationResult> {
        const { organizationId, organizationName, dbName, startDate, endDate, cronStartTime } = job.data;

        try {
            // Direct single organization processing
            const result = await this.aggregationService.aggregateOrganization(
                organizationId,
                dbName,
                organizationName,
                startDate,
                endDate
            );

            if (!result.success) {
                throw new Error(result.error || 'Unknown error during aggregation');
            }

            return result;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }

    /**
     * Initialize and start worker pool
     */
    public async start(): Promise<void> {
        if (this.isInitialized) {
            this.logger.warn('Queue workers already initialized');
            return;
        }


        // Create worker pool
        for (let i = 0; i < this.config.concurrency; i++) {
            const worker = new QueueWorker<MetricsAggregationJobData, OrganizationAggregationResult>(
                this.queue,
                this.processJob.bind(this), // ← Bind 'this' context
                {
                    useWorkerThreads: false, // Use async processing in main thread (I/O bound)
                    autorun: true
                }
            );

            this.workers.push(worker);
        }

        this.isInitialized = true;
        // Workers started successfully
    }

    /**
     * Enqueue a single organization for metrics aggregation
     */
    public async enqueueOrganization(
        organizationId: string,
        organizationName: string,
        dbName: string,
        startDate: Date,
        endDate: Date,
        cronStartTime: Date,
        options?: QueueJobOptions
    ): Promise<QueueJob<MetricsAggregationJobData>> {
        const jobData: MetricsAggregationJobData = {
            organizationId,
            organizationName,
            dbName,
            startDate,
            endDate,
            cronStartTime
        };

        const job = await this.queue.add(
            `aggregate-${organizationId}`,
            jobData,
            options
        );

        return job;
    }

    /**
     * Enqueue multiple organizations at once (for cron job)
     */
    public async enqueueBatch(
        organizations: Array<{
            organizationId: string;
            organizationName: string;
            dbName: string;
        }>,
        startDate: Date,
        endDate: Date,
        cronStartTime: Date
    ): Promise<{
        totalEnqueued: number;
        jobIds: string[];
    }> {

        const jobIds: string[] = [];

        for (const org of organizations) {
            const job = await this.enqueueOrganization(
                org.organizationId,
                org.organizationName,
                org.dbName,
                startDate,
                endDate,
                cronStartTime
            );
            jobIds.push(job.id);
        }

        this.logger.info('➤ Batch enqueued successfully', {
            totalOrganizations: organizations.length,
            period: {
                start: startDate.toISOString(),
                end: endDate.toISOString()
            },
            cronStartTime: cronStartTime.toISOString()
        });

        return {
            totalEnqueued: organizations.length,
            jobIds
        };
    }

    /**
     * Get queue statistics
     */
    public async getStats() {
        const queueStats = await this.queue.getStats();
        
        return {
            ...this.stats,
            queue: queueStats,
            workers: {
                total: this.workers.length,
                active: this.workers.filter(w => w.isActive()).length,
                processing: this.workers.filter(w => w.isCurrentlyProcessing()).length
            }
        };
    }

    /**
     * Get detailed status
     */
    public getStatus() {
        return {
            isInitialized: this.isInitialized,
            config: this.config,
            workersCount: this.workers.length,
            activeWorkers: this.workers.filter(w => w.isActive()).length,
            stats: this.stats
        };
    }

    /**
     * Stop all workers and close queue
     */
    public async stop(): Promise<void> {
        if (!this.isInitialized) {
            this.logger.warn('Queue workers not initialized');
            return;
        }


        // Close all workers
        for (let i = 0; i < this.workers.length; i++) {
            await this.workers[i].close();
        }

        this.workers = [];
        await this.queue.close();
        this.isInitialized = false;

        this.logger.success('All workers stopped successfully');
    }

    /**
     * Get queue instance (for advanced operations)
     */
    public getQueue(): QueueService {
        return this.queue;
    }
}

export default MetricsAggregationQueue;
