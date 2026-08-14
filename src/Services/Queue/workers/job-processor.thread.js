
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

let externalHandlers = {};
if (workerData && workerData.handlerModule) {
  try {
    const resolved = path.resolve(workerData.handlerModule);
    if (resolved.endsWith('.ts')) {
      try {
        require('ts-node/register');
      } catch (e) {
        console.warn('[Worker] ts-node not available — cannot load TypeScript handler module:', e && e.message);
      }
    }
    let mod = require(resolved);
    if (mod && mod.default && (typeof mod.default === 'object' || typeof mod.default === 'function')) {
      mod = mod.default;
    }
    externalHandlers = mod || {};
  } catch (err) {
    console.error('[Worker] Failed to load handlerModule', workerData.handlerModule, err && err.message);
  }
}


async function handleSendEmail(data) {
  console.log(`[Worker] Sending email to: ${data.to}`);
  

  
  await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate
  
  return {
    success: true,
    messageId: `msg-${Date.now()}`,
    sentAt: new Date().toISOString()
  };
}

async function handleBulkEmail(data) {
  console.log(`[Worker] Sending ${data.emails.length} bulk emails`);
  
  for (const email of data.emails) {
    await handleSendEmail(email);
  }
  
  return {
    success: true,
    sent: data.emails.length,
    sentAt: new Date().toISOString()
  };
}

async function handleNotification(data) {
  console.log(`[Worker] Sending notification to user: ${data.userId}`);
  
  const { userId, title, message, channels = ['in_app'] } = data;
  const results = [];
  
  for (const channel of channels) {
    switch (channel) {
      case 'push':
        await sendPush(userId, title, message);
        results.push('push');
        break;
      case 'sms':
        await sendSMS(userId, message);
        results.push('sms');
        break;
      case 'in_app':
        await saveInApp(userId, title, message);
        results.push('in_app');
        break;
      case 'email':
        await sendEmailNotif(userId, title, message);
        results.push('email');
        break;
    }
  }
  
  return {
    success: true,
    channels: results,
    sentAt: new Date().toISOString()
  };
}

async function sendPush(userId, title, message) {
  await new Promise(resolve => setTimeout(resolve, 200));
  console.log(`  → Push sent to ${userId}`);
}

async function sendSMS(userId, message) {
  await new Promise(resolve => setTimeout(resolve, 300));
  console.log(`  → SMS sent to ${userId}`);
}

async function saveInApp(userId, title, message) {
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(`  → In-app notification saved for ${userId}`);
}

async function sendEmailNotif(userId, title, message) {
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log(`  → Email notification sent to ${userId}`);
}


const jobHandlers = {
  'send-email': externalHandlers.SendMail || externalHandlers['send-email'] || handleSendEmail,
  'invite-email': externalHandlers.SendInviteMail || externalHandlers['invite-email'] || handleSendEmail,
  'verify-email': externalHandlers.SendVerifyEmailAddressMail || externalHandlers['verify-email'] || handleSendEmail,
  'bulk-invite-email': externalHandlers.SendBulkInviteMail || externalHandlers['bulk-invite-email'] || handleBulkEmail,
  'bulk-email': externalHandlers.SendBulkInviteMail || externalHandlers['bulk-email'] || handleBulkEmail,
  'notification': externalHandlers.Notification || externalHandlers.notification || handleNotification,
  'delayed-notification': externalHandlers.Notification || externalHandlers.notification || handleNotification,
  'bulk-notification': externalHandlers.Notification || externalHandlers.notification || handleNotification,
};


if (parentPort) {
  parentPort.on('message', async (message) => {
    const { job } = message;
    const jobName = job.data.__jobName || job.name;
    
    try {
      console.log(`[Worker ${process.pid}] Processing: ${jobName} (${job.id})`);
      
      const handler = jobHandlers[jobName];
      
      if (!handler) {
        throw new Error(`No handler found for job type: ${jobName}`);
      }
      
      const result = await handler(job.data);
      
      console.log(`[Worker ${process.pid}] ✓ ${jobName} completed`);
      
      parentPort.postMessage({ 
        data: result,
        jobId: job.id,
        jobName: jobName
      });
      
    } catch (error) {
      console.error(`[Worker ${process.pid}] ✗ ${jobName} failed:`, error.message);
      
      parentPort.postMessage({ 
        error: error.message || String(error),
        stack: error.stack,
        jobId: job.id,
        jobName: jobName
      });
    }
  });
  
  console.log(`[Worker ${process.pid}] Ready`);
}

