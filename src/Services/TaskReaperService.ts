import cron, { ScheduledTask } from 'node-cron';
import * as ds from './../DataStructures';
import { Logger } from '../utils/Logger';
import * as dotenv from "dotenv";
import { TaskStatus } from './../DataAccessLayer/models/Task';
dotenv.config();

export class TaskReaper {
    public logger: Logger;
    cronTask: ScheduledTask | null = null;

    constructor() {
        this.logger = new Logger('TaskReaperService');
    }

    async TaskReaper() {
        try {
            const timeThresholdMinutes = parseInt(process.env.TASK_REAPER_TIME_THRESHOLD as string) || 60; // default 60 minutes (1 hour)
            const timeThresholdMs = timeThresholdMinutes * 60 * 1000;
            const currentTime = new Date().getTime();

            this.logger.info('Running TaskReaper - checking for non-running tasks', {
                timeThresholdMinutes,
                totalTasks: ds.taskId_task.size
            });

            // Iterate through all running tasks
            for (const [key,taskData] of ds.taskId_task.entries()) {
                try {
                    // Check if task status is not Running
                    if (taskData.status !== TaskStatus.Running) {
                        if (!taskData.nonRunningSince) {
                            taskData.nonRunningSince = new Date();
                        }

                        const nonRunningDuration = currentTime - taskData.nonRunningSince.getTime();
                        const nonRunningDurationMinutes = Math.floor(nonRunningDuration / (60 * 1000));

                        this.logger.info('Found non-running task', {
                            taskId: taskData.taskId,
                            taskName: taskData.taskName,
                            status: taskData.status,
                            ageMinutes: nonRunningDurationMinutes,
                            thresholdMinutes: timeThresholdMinutes
                        });

                        // Check if task has been non-running for more than threshold
                        if (nonRunningDuration > timeThresholdMs) {
                            this.logger.info('Task exceeds threshold - initiating hard kill', {
                                taskId: taskData.taskId,
                                taskName: taskData.taskName,
                                status: taskData.status,
                                ageMinutes: nonRunningDurationMinutes
                            });

                            // Create a mock socket object for CleanTask function
                            // CleanTask requires socket for user data
                            const mockSocket: any = {
                                data: {
                                    user: {
                                        userId: taskData.createdBy,
                                        taskId: taskData.taskId
                                    }
                                },
                                id: taskData.socketId || 'reaper-socket'
                            };

                            // Perform hard kill using CleanTask
                            const { CleanTask } = await import('./SetupWorkspace');
                            await CleanTask(mockSocket as any, taskData.taskId, taskData.status);

                            this.logger.success('Successfully reaped task', {
                                taskId: taskData.taskId,
                                taskName: taskData.taskName,
                                previousStatus: taskData.status
                            });
                        } else {
                            this.logger.info('Task not yet ready for reaping', {
                                taskId: taskData.taskId,
                                remainingMinutes: Math.floor((timeThresholdMs - nonRunningDuration) / (60 * 1000))
                            });
                        }
                    }
                } catch (taskError) {
                    this.logger.error('Error processing task in reaper', {
                        taskId: taskData.taskId,
                        error: taskError
                    });
                }
            }

            this.logger.info('TaskReaper cycle completed');
        } catch (ex) {
            this.logger.error('Error in TaskReaper main loop', ex);
        }
    }

    async start() {
        const cronSchedule = process.env.TASK_REAPER_CRON_JOB || '*/5 * * * *'; // default every 5 minutes
        this.logger.info('Starting TaskReaper cron job', {
            schedule: cronSchedule,
            timeThreshold: `${process.env.TASK_REAPER_TIME_THRESHOLD || 60} minutes`
        });

        this.cronTask = cron.schedule(
            cronSchedule,
            async () => {
                await this.TaskReaper();
            }
        );

        this.logger.success('TaskReaper cron job started successfully');
    }

    async stop() {
        if (this.cronTask) {
            this.cronTask.stop();
            this.logger.info('TaskReaper cron job stopped');
        }
    }
}
