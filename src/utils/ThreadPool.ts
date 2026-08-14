
import { Worker } from 'worker_threads';
import * as os from 'os';

/**
 * A thread pool utility that limits the number of concurrent worker threads
 * based on available CPU resources.
 */
export class ThreadPool {
  private maxThreads: number;
  private activeThreads: number = 0;
  private queue: Array<() => Promise<void>> = [];

  /**
   * Creates a new ThreadPool instance.
   * @param cpuPercentage Percentage of available CPU cores to use (0.0 to 1.0)
   */
  constructor(cpuPercentage: number = 0.25) {
    const availableCores = os.cpus().length;
    this.maxThreads = Math.max(1, Math.floor(availableCores * cpuPercentage));
    console.log(`ThreadPool initialized with ${this.maxThreads} max threads (${availableCores} cores available)`);
  }

  /**
   * Executes a worker thread task, respecting the thread pool limits.
   * @param workerPath Path to the worker script
   * @param workerData Data to pass to the worker
   * @param options Worker options
   * @returns A promise that resolves with the worker's result
   */
  async execute<T>(workerPath: string, workerData: any, options: any = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = async () => {
        this.activeThreads++;
        try {
          const worker = new Worker(workerPath, options);

          worker.on('message', (result) => {
            worker.terminate();
            this.activeThreads--; // Decrement counter when worker completes successfully
            this.processQueue(); // Process next queued task
            resolve(result);
          });

          worker.on('error', (err) => {
            worker.terminate();
            this.activeThreads--; // Decrement counter when worker errors
            this.processQueue(); // Process next queued task
            reject(err);
          });

          worker.on('exit', (code) => {
            if (code !== 0 && code !== null) {
              // Only handle abnormal exits that haven't been handled by message/error events
              if (worker.threadId) { // Check if the worker is still valid
                this.activeThreads--; // Safety measure for abnormal exits
                this.processQueue(); // Process next queued task
                reject(new Error(`Worker stopped with exit code ${code}`));
              }
            }
          });

          worker.postMessage(workerData);
        } catch (error) {
          this.activeThreads--;
          this.processQueue();
          reject(error);
        }
      };

      if (this.activeThreads < this.maxThreads) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  /**
   * Processes the next task in the queue if there are available threads.
   */
  private processQueue(): void {
    if (this.queue.length > 0 && this.activeThreads < this.maxThreads) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        nextTask().catch(err => {
          console.error('Error executing queued task:', err);
        });
      }
    }
  }

  /**
   * Executes multiple tasks in batches, respecting the thread pool limits.
   * @param tasks Array of task data to execute
   * @param workerPath Path to the worker script
   * @param options Worker options
   * @returns Promise that resolves with an array of results
   */
  async executeBatch<T, R>(tasks: T[], workerPath: string, options: any = {}): Promise<R[]> {
    const results: R[] = new Array(tasks.length);
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < tasks.length; i++) {
      const index = i; // Capture the current index in closure
      promises.push(
        new Promise<void>((resolve) => {
          const task = async () => {
            try {
              results[index] = await this.execute<R>(workerPath, tasks[index], options);
            } catch (error) {
              console.error(`Task execution error for task ${index}:`, error);
            } finally {
              resolve();
            }
          };
          
          if (this.activeThreads < this.maxThreads) {
            task();
          } else {
            this.queue.push(task);
          }
        })
      );
    }
    
    await Promise.all(promises);
    return results;
  }

  /**
   * Gets the current status of the thread pool.
   * @returns An object containing the current status of the thread pool
   */
  getStatus(): { maxThreads: number; activeThreads: number; queuedTasks: number } {
    return {
      maxThreads: this.maxThreads,
      activeThreads: this.activeThreads,
      queuedTasks: this.queue.length
    };
  }
}