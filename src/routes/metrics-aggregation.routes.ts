import express, { Request, Response } from 'express';
import { MetricsAggregationCron } from '../Services/MetricsAggregationCron';

const router = express.Router();

// Singleton instance of the cron job (will be initialized in main server)
let metricsAggregationCron: MetricsAggregationCron | null = null;

/**
 * Initialize the metrics aggregation cron
 * This should be called once when the server starts
 */
export async function initializeMetricsAggregationCron(config?: any): Promise<void> {
    if (!metricsAggregationCron) {
        metricsAggregationCron = new MetricsAggregationCron(config);
        await metricsAggregationCron.start();
    }
}

/**
 * Get the metrics aggregation cron instance
 */
export function getMetricsAggregationCron(): MetricsAggregationCron | null {
    return metricsAggregationCron;
}

/**
 * Middleware to check if cron is initialized
 */
const checkCronInitialized = (req: Request, res: Response, next: express.NextFunction): void => {
    if (!metricsAggregationCron) {
        res.status(503).json({
            success: false,
            error: 'Metrics aggregation cron is not initialized'
        });
        return;
    }
    next();
};

/**
 * GET /api/admin/metrics-aggregation/status
 * Get the current status of metrics aggregation
 */
router.get('/status', checkCronInitialized, async (req: Request, res: Response) => {
    try {
        const status = await metricsAggregationCron!.getStatus();
        
        res.json({
            success: true,
            status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * GET /api/admin/metrics-aggregation/statistics
 * Get detailed statistics of the queue and workers
 */
router.get('/statistics', checkCronInitialized, async (req: Request, res: Response) => {
    try {
        const statistics = await metricsAggregationCron!.getStatistics();
        
        res.json({
            success: true,
            statistics
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * GET /api/admin/metrics-aggregation/last-run
 * Get details of the last aggregation run
 */
router.get('/last-run', checkCronInitialized, async (req: Request, res: Response): Promise<void> => {
    try {
        const status = await metricsAggregationCron!.getStatus();
        
        if (!status.lastRunTime) {
            res.json({
                success: true,
                message: 'No aggregation has been run yet',
                lastRun: null
            });
            return;
        }

        res.json({
            success: true,
            lastRun: {
                time: status.lastRunTime,
                enqueuedCount: status.lastEnqueuedCount,
                queueStatus: status.queueStatus
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * POST /api/admin/metrics-aggregation/trigger
 * Manually trigger metrics aggregation
 */
router.post('/trigger', checkCronInitialized, async (req: Request, res: Response): Promise<void> => {
    try {
        const { startDate, endDate } = req.body;
        
        const start = startDate ? new Date(startDate) : undefined;
        const end = endDate ? new Date(endDate) : undefined;

        // Validate dates
        if (start && end && start >= end) {
            res.status(400).json({
                success: false,
                error: 'startDate must be before endDate'
            });
            return;
        }

        // Trigger aggregation and get result
        const result = await metricsAggregationCron!.triggerManual(start, end);

        res.json({
            success: true,
            message: 'Aggregation jobs enqueued successfully',
            result: {
                totalEnqueued: result.totalEnqueued,
                startDate: result.startDate,
                endDate: result.endDate,
                cronStartTime: result.cronStartTime
            },
            note: 'Check /api/admin/metrics-aggregation/status for progress'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * GET /api/admin/metrics-aggregation/queue
 * Get queue instance statistics
 */
router.get('/queue', checkCronInitialized, async (req: Request, res: Response) => {
    try {
        const queue = metricsAggregationCron!.getQueue();
        const stats = await queue.getStats();
        const status = queue.getStatus();

        res.json({
            success: true,
            queue: {
                stats,
                status
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * POST /api/admin/metrics-aggregation/start
 * Start the cron job if it's stopped
 */
router.post('/start', checkCronInitialized, async (req: Request, res: Response) => {
    try {
        await metricsAggregationCron!.start();
        
        res.json({
            success: true,
            message: 'Metrics aggregation cron and workers started'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * POST /api/admin/metrics-aggregation/stop
 * Stop the cron job
 */
router.post('/stop', checkCronInitialized, async (req: Request, res: Response) => {
    try {
        await metricsAggregationCron!.stop();
        
        res.json({
            success: true,
            message: 'Metrics aggregation cron and workers stopped'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

/**
 * GET /api/admin/metrics-aggregation/health
 * Health check endpoint
 */
router.get('/health', async (req: Request, res: Response) => {
    const isInitialized = metricsAggregationCron !== null;
    let status = null;
    
    if (isInitialized) {
        try {
            status = await metricsAggregationCron!.getStatus();
        } catch (error) {
            // Ignore error for health check
        }
    }
    
    const health = {
        initialized: isInitialized,
        cronRunning: status?.isRunning || false,
        queueInitialized: status?.queueStatus?.workers?.total > 0 || false,
        activeWorkers: status?.queueStatus?.workers?.active || 0,
        currentlyProcessing: status?.queueStatus?.currentlyProcessing || 0,
        lastRunTime: status?.lastRunTime || null,
        lastEnqueuedCount: status?.lastEnqueuedCount || 0
    };

    const httpStatus = isInitialized ? 200 : 503;
    
    res.status(httpStatus).json({
        success: isInitialized,
        health
    });
});

export default router;
