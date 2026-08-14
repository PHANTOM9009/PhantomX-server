/**
 * Queue Usage Examples
 * Demonstrates email and notification queues with worker threads
 */

import * as path from 'path';
import { QueueService, QueueWorker } from '../index';

// ============================================
// Email Queue Setup
// ============================================

export const emailQueue = new QueueService({
  name: 'email',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
  }
});

export const emailWorker = new QueueWorker(
  emailQueue,
  async () => {}, // Not used in worker thread mode
  {
    useWorkerThreads: true,
    workerScript: path.join(__dirname, '../workers/job-processor.thread.js'),
    autorun: true
  }
);



export const notificationQueue = new QueueService({
  name: 'notification',
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: true,
  }
});

export const notificationWorker = new QueueWorker(
  notificationQueue,
  async () => {}, // Not used in worker thread mode
  {
    useWorkerThreads: true,
    workerScript: path.join(__dirname, '../workers/job-processor.thread.js'),
    autorun: true
  }
);

// ============================================
// Helper Functions
// ============================================

export async function sendEmail(emailData: {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
}, priority: number = 5) {
  return await emailQueue.add('send-email', emailData, {
    priority,
    timeout: 30000
  });
}

export async function sendBulkEmails(emails: Array<{
  to: string;
  subject: string;
  body: string;
}>) {
  return await emailQueue.add('bulk-email', { emails }, {
    priority: 7,
    timeout: 60000
  });
}

export async function sendNotification(
  userId: string,
  title: string,
  message: string,
  options: {
    channels?: ('push' | 'sms' | 'in_app' | 'email')[];
    priority?: number;
    type?: string;
  } = {}
) {
  return await notificationQueue.add('notification', {
    userId,
    title,
    message,
    type: options.type || 'info',
    channels: options.channels || ['in_app']
  }, {
    priority: options.priority || 5,
    timeout: 15000
  });
}

export async function sendDelayedNotification(
  userId: string,
  title: string,
  message: string,
  delayMs: number,
  channels?: ('push' | 'sms' | 'in_app' | 'email')[]
) {
  return await notificationQueue.add('delayed-notification', {
    userId,
    title,
    message,
    channels: channels || ['in_app']
  }, {
    priority: 5,
    delay: delayMs,
    timeout: 15000
  });
}

// ============================================
// Event Listeners
// ============================================

emailQueue.on('completed', (job, result) => {
  console.log(`[Email] ✓ ${job.id} completed:`, result);
});

emailQueue.on('failed', (job, error) => {
  console.error(`[Email] ✗ ${job.id} failed:`, error.message);
});

notificationQueue.on('completed', (job, result) => {
  console.log(`[Notification] ✓ ${job.id} completed:`, result);
});

notificationQueue.on('failed', (job, error) => {
  console.error(`[Notification] ✗ ${job.id} failed:`, error.message);
});

// ============================================
// Graceful Shutdown
// ============================================

export async function shutdownQueues() {
  console.log('Shutting down queues...');
  await emailWorker.close();
  await notificationWorker.close();
  await emailQueue.close();
  await notificationQueue.close();
  console.log('Queues shut down successfully');
}

process.on('SIGINT', async () => {
  await shutdownQueues();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdownQueues();
  process.exit(0);
});

// ============================================
// Example Usage
// ============================================

/*
// Send email
await sendEmail({
  to: 'user@example.com',
  subject: 'Welcome!',
  body: 'Thanks for signing up!'
}, 1);

// Send notification
await sendNotification(
  'user123',
  'New Message',
  'You have a new message',
  {
    channels: ['push', 'in_app'],
    priority: 3
  }
);

// Send delayed notification (1 hour later)
await sendDelayedNotification(
  'user123',
  'Reminder',
  'Complete your profile!',
  60 * 60 * 1000,
  ['push', 'in_app']
);

// Get stats
const emailStats = await emailQueue.getStats();
const notifStats = await notificationQueue.getStats();
console.log('Email Queue:', emailStats);
console.log('Notification Queue:', notifStats);
*/

