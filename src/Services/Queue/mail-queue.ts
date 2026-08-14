import { QueueService, QueueWorker } from './index';
import path from 'path';
import { QueueJobOptions } from './types';
import { SendMail, SendInviteMail, SendVerifyEmailAddressMail, SendBulkInviteMail } from '../../socket-handlers/invite-mail.handler';


export const mailQueue = new QueueService({
  name: 'mail',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  }
});

export const mailWorker = new QueueWorker(
  mailQueue,
  async (job) => {
    const { data, name } = job;
    
    try {
      let result;
      
      switch (name) {
        case 'send-email':
          result = await SendMail(data);
          if (!result.success) {
            throw new Error(result.error || 'Email sending failed');
          }
          return result;
          
        case 'invite-email':
          result = await SendInviteMail(data);
          if (!result.success) {
            throw new Error(result.error || 'Invite email sending failed');
          }
          return result;
          
        case 'verify-email':
          result = await SendVerifyEmailAddressMail(data);
          if (!result.success) {
            throw new Error(result.error || 'Verification email sending failed');
          }
          return result;
          
        case 'bulk-invite-email':
          result = await SendBulkInviteMail(data);
          if (!result.success) {
            throw new Error(result.error || 'Bulk invite email sending failed');
          }
          return result;
          
        default:
          throw new Error(`Unknown job type: ${name}`);
      }
    } catch (error) {
      console.error(`[MailQueue] Job ${job.id} failed:`, error);
      throw error; 
    }
  },
  {
    autorun: true,
    useWorkerThreads: false,  //we can later enable it for workers
    workerScript: path.resolve(__dirname, 'workers/job-processor.thread.js'),
    handlerModule: path.resolve(__dirname, '../../socket-handlers/invite-mail.handler.ts')
  }
);

export async function queueMail(
  emailData: any, 
  options?: Partial<QueueJobOptions>
): Promise<string> {
  const job = await mailQueue.add('send-email', emailData, options);
  console.log(`[MailQueue] Email to ${emailData.to} queued with ID: ${job.id}`);
  return job.id;
}

export async function queueInviteMail(
  inviteData: any,
  options?: Partial<QueueJobOptions>
): Promise<string> {
  const job = await mailQueue.add('invite-email', inviteData, options);
  console.log(`[MailQueue] Invite email to ${inviteData.recipientEmail} queued with ID: ${job.id}`);
  return job.id;
}

export async function queueVerifyMail(
  verifyData: any,
  options?: Partial<QueueJobOptions>
): Promise<string> {
  const job = await mailQueue.add('verify-email', verifyData, options);
  console.log(`[MailQueue] Verification email to ${verifyData.recipientEmail} queued with ID: ${job.id}`);
  return job.id;
}

export async function queueMultipleInviteMail(
  bulkInviteData: any,
  options?: Partial<QueueJobOptions>
): Promise<string> {
  const job = await mailQueue.add('bulk-invite-email', bulkInviteData, options);
  console.log(`[MailQueue] Bulk invite emails to ${bulkInviteData.recipients?.length || 0} recipients queued with ID: ${job.id}`);
  return job.id;
}

mailQueue.on('completed', (job) => {
  console.log(`[MailQueue] Job ${job.id} completed successfully`);
});

mailQueue.on('failed', (job, error) => {
  console.error(`[MailQueue] Job ${job.id} failed:`, error.message);
});

mailQueue.on('retrying', (job) => {
  console.log(`[MailQueue] Retrying job ${job.id}, attempt ${job.attemptsMade} of ${job.attemptsMax}`);
});

// Log initialization
console.log('[MailQueue] Mail queue and worker initialized');
console.log(`[MailQueue] Worker is ${mailWorker.isActive() ? 'active' : 'inactive'} and ready to process emails`);
