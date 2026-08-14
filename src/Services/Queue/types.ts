/**
 * Queue Types and Interfaces
 */

export interface QueueJobData {
  [key: string]: any;
}

export interface QueueJobOptions {
  priority?: number; 
  delay?: number; 
  attempts?: number; 
  backoff?: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
  timeout?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

export enum QueueJobStatus {
  WAITING = 'waiting',
  DELAYED = 'delayed',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export interface QueueJob<T = any> {
  id: string;
  name: string;
  queueName: string;
  data: T;
  status: QueueJobStatus;
  priority: number;
  attemptsMade: number;
  attemptsMax: number;
  processAfter: Date;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
  timeout?: number;
  failedReason?: string;
  stacktrace?: string[];
  processedOn?: Date;
  finishedOn?: Date;
  createdAt: Date;
  updatedAt: Date;
  removeOnComplete: boolean;
  removeOnFail: boolean;
  result?: any;
}

export interface QueueConfig {
  name: string;
  defaultJobOptions?: QueueJobOptions;
}

export interface WorkerOptions {
  useWorkerThreads?: boolean;
  workerScript?: string;
  autorun?: boolean;
  handlerModule?: string;
}

export type JobProcessor<T = any, R = any> = (job: QueueJob<T>) => Promise<R> | R;

