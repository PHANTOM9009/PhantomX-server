/**
 * Queue Worker - Processes jobs sequentially in a dedicated worker thread
 * Simplified version: One worker = One thread = Sequential job processing
 */

import { Worker } from 'worker_threads';
import { QueueService } from './QueueService';
import { QueueJob, JobProcessor, WorkerOptions } from './types';

import path from 'path';

export class QueueWorker<T = any, R = any> {
  private queue: QueueService;
  private processor: JobProcessor<T, R>;
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private processingInterval?: NodeJS.Timeout;
  private useWorkerThreads: boolean;
  private workerScript?: string;
  private worker?: Worker;

  constructor(queue: QueueService, processor: JobProcessor<T, R>, options: WorkerOptions = {}) {
    this.queue = queue;
    this.processor = processor;
    this.useWorkerThreads = options.useWorkerThreads || false;
    this.workerScript = options.workerScript;

    if (this.useWorkerThreads && !this.workerScript) {
      throw new Error('workerScript required when useWorkerThreads is true');
    }

    if (this.useWorkerThreads && this.workerScript) {
      const handlerModulePath = (options as any)?.handlerModule
        ? path.resolve((options as any).handlerModule)
        : undefined;

      const workerData: any = {};
      if (handlerModulePath) workerData.handlerModule = handlerModulePath;

      this.worker = new Worker(this.workerScript, { workerData });
      console.log(`[QueueWorker] Worker thread created for queue: ${queue['queueName']}`);
    }
    this.setupEventListeners();
    if (options.autorun !== false) {
      this.run();
    }
  }
  private setupEventListeners(): void {
    this.queue.on('waiting', () => {
      if (this.isRunning && !this.isProcessing) {
        this.processNextJob();
      }
    });

    this.queue.on('completed', () => {
      if (this.isRunning && !this.isProcessing) {
        this.processNextJob();
      }
    });

    this.queue.on('failed', () => {
      if (this.isRunning && !this.isProcessing) {
        this.processNextJob();
      }
    });
  }

  private async processJobInWorkerThread(job: QueueJob<T>): Promise<void> {
    if (!this.worker) {
      return this.processJobInMainThread(job);
    }

    return new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.worker) {
          this.worker.removeAllListeners('message');
          this.worker.removeAllListeners('error');
        }
      };

      if (job.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          this.queue.failJob(job.id, new Error(`Job timed out after ${job.timeout}ms`))
            .then(() => reject(new Error('Job timeout')))
            .catch(reject);
        }, job.timeout);
      }

      this.worker!.once('message', async (result: any) => {
        cleanup();
        try {
          if (result.error) {
            await this.queue.failJob(job.id, new Error(result.error));
          } else {
            await this.queue.completeJob(job.id, result.data);
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.worker!.once('error', async (error: Error) => {
        cleanup();
        try {
          await this.queue.failJob(job.id, error);
          reject(error);
        } catch (err) {
          reject(err);
        }
      });

      this.worker!.postMessage({ job });
    });
  }

  private async processJobInMainThread(job: QueueJob<T>): Promise<void> {
    try {
      let timeoutId: NodeJS.Timeout | undefined;
      let processorPromise: Promise<R>;

      if (job.timeout) {
        processorPromise = Promise.race([
          Promise.resolve(this.processor(job)),
          new Promise<R>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Job timed out after ${job.timeout}ms`));
            }, job.timeout);
          })
        ]);
      } else {
        processorPromise = Promise.resolve(this.processor(job));
      }

      const result = await processorPromise;
      if (timeoutId) clearTimeout(timeoutId);
      await this.queue.completeJob(job.id, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.queue.failJob(job.id, err);
    }
  }

  private async processJob(job: QueueJob<T>): Promise<void> {
    if (this.useWorkerThreads) {
      return this.processJobInWorkerThread(job);
    } else {
      return this.processJobInMainThread(job);
    }
  }

  private async processNextJob(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    try {
      const job = await this.queue.getNextJob();
      
      if (job) {
        this.isProcessing = true;
        await this.processJob(job);
        this.isProcessing = false;
        
        if (this.isRunning) {
          this.processNextJob();
        }
      }
    } catch (error) {
      this.isProcessing = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.queue.emit('error', err);
      console.error(`Error processing job:`, err);
    }
  }

  run(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    
    this.processingInterval = setInterval(() => {
      if (this.isRunning && !this.isProcessing) {
        this.processNextJob();
      }
    }, 100);

    this.processNextJob();
  }

  async close(): Promise<void> {
    this.isRunning = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.worker) {
      await this.worker.terminate();
      this.worker = undefined;
      console.log('[QueueWorker] Worker thread terminated');
    }
  }

  isActive(): boolean {
    return this.isRunning;
  }
  
  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }
}
