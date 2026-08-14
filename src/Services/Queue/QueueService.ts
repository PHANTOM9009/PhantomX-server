
import { EventEmitter } from 'events';
import { 
  QueueJob, 
  QueueJobData, 
  QueueJobOptions, 
  QueueJobStatus,
  QueueConfig
} from './types';

export class QueueService extends EventEmitter {
  private queueName: string;
  private jobs: Map<string, QueueJob> = new Map();
  private defaultJobOptions: QueueJobOptions;
  private jobCounter: number = 0;

  constructor(config: QueueConfig) {
    super();
    this.queueName = config.name;
    this.defaultJobOptions = config.defaultJobOptions || {};
  }

  private generateJobId(): string {
    return `${this.queueName}-${Date.now()}-${++this.jobCounter}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private createJob<T = any>(name: string, data: T, options: QueueJobOptions = {}): QueueJob<T> {
    const now = new Date();
    const mergedOptions = { ...this.defaultJobOptions, ...options };
    const delay = mergedOptions.delay || 0;

    return {
      id: this.generateJobId(),
      name,
      queueName: this.queueName,
      data,
      status: delay > 0 ? QueueJobStatus.DELAYED : QueueJobStatus.WAITING,
      priority: mergedOptions.priority || 5,
      attemptsMade: 0,
      attemptsMax: mergedOptions.attempts || 3,
      processAfter: new Date(now.getTime() + delay),
      backoff: mergedOptions.backoff,
      timeout: mergedOptions.timeout,
      createdAt: now,
      updatedAt: now,
      removeOnComplete: mergedOptions.removeOnComplete !== undefined ? mergedOptions.removeOnComplete : false,
      removeOnFail: mergedOptions.removeOnFail !== undefined ? mergedOptions.removeOnFail : false
    };
  }

  async add<T = any>(name: string, data: T, options?: QueueJobOptions): Promise<QueueJob<T>> {
    const job = this.createJob(name, data, options);
    this.jobs.set(job.id, job);
    this.emit('added', job);
    if (job.status === QueueJobStatus.WAITING) this.emit('waiting', job);
    return job;
  }

  async getNextJob(): Promise<QueueJob | null> {
    const now = new Date();
    const eligible: QueueJob[] = [];

    for (const job of this.jobs.values()) {
      if (
        job.queueName === this.queueName &&
        (job.status === QueueJobStatus.WAITING || job.status === QueueJobStatus.DELAYED) &&
        job.processAfter <= now
      ) {
        eligible.push(job);
      }
    }

    if (eligible.length === 0) return null;

    eligible.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.processAfter.getTime() - b.processAfter.getTime());

    const job = eligible[0];
    job.status = QueueJobStatus.ACTIVE;
    job.attemptsMade++;
    job.processedOn = now;
    job.updatedAt = now;

    this.emit('active', job);
    return job;
  }

  async completeJob(jobId: string, result?: any): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.status = QueueJobStatus.COMPLETED;
    job.finishedOn = new Date();
    job.updatedAt = new Date();
    job.result = result;

    this.emit('completed', job, result);

    if (job.removeOnComplete) {
      this.jobs.delete(jobId);
      this.emit('removed', job);
    }

    return true;
  }

  async failJob(jobId: string, error: Error): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    const now = new Date();
    if (!job.stacktrace) job.stacktrace = [];
    job.stacktrace.push(error.stack || error.message);
    job.failedReason = error.message;
    job.updatedAt = now;

    //this is the logic to retry the job based on our retry logic
    if (job.attemptsMade < job.attemptsMax) {
      let retryDelay = 0;
      if (job.backoff) {
        retryDelay = job.backoff.type === 'exponential' 
          ? job.backoff.delay * Math.pow(2, job.attemptsMade - 1)
          : job.backoff.delay;
      }

      job.processAfter = new Date(now.getTime() + retryDelay);
      job.status = retryDelay > 0 ? QueueJobStatus.DELAYED : QueueJobStatus.WAITING;
      this.emit('retrying', job, error);
      return true;
    }

    job.status = QueueJobStatus.FAILED;
    job.finishedOn = now;
    this.emit('failed', job, error);

    if (job.removeOnFail) {
      this.jobs.delete(jobId);
      this.emit('removed', job);
    }

    return true;
  }

  async getStats() {
    const stats = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 };
    
    for (const job of this.jobs.values()) {
      if (job.queueName === this.queueName) {
        stats.total++;
        stats[job.status]++;
      }
    }
    
    return stats;
  }

  isEmpty(): boolean {
    for (const job of this.jobs.values()) {
      if (job.queueName === this.queueName) return false;
    }
    return true;
  }

  async close(): Promise<void> {
    this.removeAllListeners();
  }
}

