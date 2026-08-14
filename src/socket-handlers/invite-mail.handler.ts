import { Server, Socket } from 'socket.io';
import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';
import dotenv from 'dotenv';
import { createLogger } from '../utils/Logger';
dotenv.config();

const mailLogger = createLogger('MailService');

const sesClient = new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});

export interface EmailData {
    to: string | string[];
    subject: string;
    htmlBody?: string;
    textBody?: string;
    from?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
}

export interface InviteEmailData {
    recipientEmail: string;
    inviterName: string;
    organizationName: string;
    inviteToken: string;
    customMessage?: string;
    from?: string;
}

export interface BulkInviteEmailData {
    recipients: Array<{
        recipientEmail: string;
        inviteToken: string;
        inviteTokenId: string;
    }>;
    inviterName: string;
    organizationName: string;
    role?: string;
    customMessage?: string;
    from?: string;
}

export interface VerifyEmailData {
    recipientEmail: string;
    otp: string;
    userName?: string;
    from?: string;
}


export async function SendMail(emailData: EmailData): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
        if (!emailData.to || !emailData.subject) {
            throw new Error('Missing required fields: to and subject are required');
        }

        if (!emailData.htmlBody && !emailData.textBody) {
            throw new Error('Either htmlBody or textBody must be provided');
        }

        const toAddresses = Array.isArray(emailData.to) ? emailData.to : [emailData.to];
        const ccAddresses = emailData.cc ? (Array.isArray(emailData.cc) ? emailData.cc : [emailData.cc]) : undefined;
        const bccAddresses = emailData.bcc ? (Array.isArray(emailData.bcc) ? emailData.bcc : [emailData.bcc]) : undefined;
        const replyToAddresses = emailData.replyTo ? (Array.isArray(emailData.replyTo) ? emailData.replyTo : [emailData.replyTo]) : undefined;

        const params: SendEmailCommandInput = {
            Source: emailData.from || process.env.SES_FROM_EMAIL || 'phantomx@phantomx.dev',
            Destination: {
                ToAddresses: toAddresses,
                CcAddresses: ccAddresses,
                BccAddresses: bccAddresses
            },
            Message: {
                Subject: {
                    Data: emailData.subject,
                    Charset: 'UTF-8'
                },
                Body: {
                    ...(emailData.htmlBody && {
                        Html: {
                            Data: emailData.htmlBody,
                            Charset: 'UTF-8'
                        }
                    }),
                    ...(emailData.textBody && {
                        Text: {
                            Data: emailData.textBody,
                            Charset: 'UTF-8'
                        }
                    })
                }
            },
            ...(replyToAddresses && { ReplyToAddresses: replyToAddresses })
        };

        const command = new SendEmailCommand(params);
        const response = await sesClient.send(command);

        console.log('Email sent successfully:', response.MessageId);

        return {
            success: true,
            messageId: response.MessageId
        };

    } catch (error: any) {
        console.error('Error sending email:', error);
        return {
            success: false,
            error: error.message || 'Failed to send email'
        };
    }
}


export async function SendInviteMail(inviteData: InviteEmailData): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
        const { recipientEmail, inviterName, organizationName, inviteToken, customMessage, from } = inviteData;

        const inviteUrl = `${process.env.APP_URL || 'https://example.com'}/accept-invite?token=${inviteToken}`;

        const htmlBody = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9f9f9;
        }
        .header {
            background-color: #4CAF50;
            color: white;
            padding: 20px;
            text-align: center;
            border-radius: 5px 5px 0 0;
        }
        .content {
            background-color: white;
            padding: 30px;
            border-radius: 0 0 5px 5px;
        }
        .button {
            display: inline-block;
            padding: 12px 24px;
            background-color: #4CAF50;
            color: white;
            text-decoration: none;
            border-radius: 4px;
            margin: 20px 0;
        }
        .footer {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>You're Invited!</h1>
        </div>
        <div class="content">
            <p>Hello,</p>
            <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong>.</p>
            ${customMessage ? `<p>${customMessage}</p>` : ''}
            <p>Click the button below to accept the invitation and get started:</p>
            <center>
                <a href="${inviteUrl}" class="button">Accept Invitation</a>
            </center>
            <p>If you have any questions, please don't hesitate to reach out.</p>
            <p>Best regards,<br>${organizationName} Team</p>
        </div>
        <div class="footer">
            <p>This is an automated email. Please do not reply directly to this message.</p>
        </div>
    </div>
</body>
</html>
        `;

        const textBody = `
You're Invited!

Hello,

${inviterName} has invited you to join ${organizationName}.

${customMessage ? customMessage + '\n\n' : ''}
To accept the invitation, please visit: ${inviteUrl}

If you have any questions, please don't hesitate to reach out.

Best regards,
${organizationName} Team

---
This is an automated email. Please do not reply directly to this message.
        `;

        return await SendMail({
            to: recipientEmail,
            subject: `Invitation to join ${organizationName}`,
            htmlBody,
            textBody,
            from
        });

    } catch (error: any) {
        console.error('Error sending invite email:', error);
        return {
            success: false,
            error: error.message || 'Failed to send invite email'
        };
    }
}

export async function SendBulkInviteMail(bulkInviteData: BulkInviteEmailData): Promise<{ 
    success: boolean; 
    messageId?: string; 
    status?: Array<{ email: string; status: string; messageId?: string; error?: string }>;
    error?: string;
}> {
    try {
        const { recipients, inviterName, organizationName, role, customMessage, from } = bulkInviteData;

        if (!recipients || recipients.length === 0) {
            throw new Error('Recipients array is required and cannot be empty');
        }

        const BATCH_SIZE = 10; 
        const allStatus: Array<{ email: string; status: string; messageId?: string; error?: string }> = [];
        for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
            const batch = recipients.slice(i, i + BATCH_SIZE);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const batchPromises = batch.map(async (recipient) => {
                try {
                    const inviteUrl = `${process.env.APP_URL || 'https://example.com'}/accept-invite?token=${recipient.inviteToken}`;

                    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9f9f9;
        }
        .header {
            background-color: #4CAF50;
            color: white;
            padding: 20px;
            text-align: center;
            border-radius: 5px 5px 0 0;
        }
        .content {
            background-color: white;
            padding: 30px;
            border-radius: 0 0 5px 5px;
        }
        .button {
            display: inline-block;
            padding: 12px 24px;
            background-color: #4CAF50;
            color: white;
            text-decoration: none;
            border-radius: 4px;
            margin: 20px 0;
        }
        .footer {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>You're Invited!</h1>
        </div>
        <div class="content">
            <p>Hello,</p>
            <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong>.</p>
            ${customMessage ? `<p>${customMessage}</p>` : ''}
            <p>Click the button below to accept the invitation and get started:</p>
            <center>
                <a href="${inviteUrl}" class="button">Accept Invitation</a>
            </center>
            <p>If you have any questions, please don't hesitate to reach out.</p>
            <p>Best regards,<br>${organizationName} Team</p>
        </div>
        <div class="footer">
            <p>This is an automated email. Please do not reply directly to this message.</p>
        </div>
    </div>
</body>
</html>
                    `;

                    const textBody = `
You're Invited!

Hello,

${inviterName} has invited you to join ${organizationName}.

${customMessage ? customMessage + '\n\n' : ''}
To accept the invitation, please visit: ${inviteUrl}

If you have any questions, please don't hesitate to reach out.

Best regards,
${organizationName} Team

---
This is an automated email. Please do not reply directly to this message.
                    `;

                    const params: SendEmailCommandInput = {
                        Source: from || process.env.SES_FROM_EMAIL || 'phantomx@phantomx.dev',
                        Destination: {
                            ToAddresses: [recipient.recipientEmail]
                        },
                        Message: {
                            Subject: {
                                Data: `Invitation to join ${organizationName}`,
                                Charset: 'UTF-8'
                            },
                            Body: {
                                Html: {
                                    Data: htmlBody,
                                    Charset: 'UTF-8'
                                },
                                Text: {
                                    Data: textBody,
                                    Charset: 'UTF-8'
                                }
                            }
                        }
                    };

                    const command = new SendEmailCommand(params);
                    const response = await sesClient.send(command);

                    return {
                        email: recipient.recipientEmail,
                        status: 'Success',
                        messageId: response.MessageId
                    };
                } catch (error: any) {
                    return {
                        email: recipient.recipientEmail,
                        status: 'Failed',
                        error: error.message || 'Failed to send email'
                    };
                }
            });
            const batchResults = await Promise.all(batchPromises);
            allStatus.push(...batchResults);

            const batchSuccesses = batchResults.filter(r => r.status === 'Success').length;
            const batchFailures = batchResults.filter(r => r.status !== 'Success');

            mailLogger.info(`Bulk email batch ${batchNumber} completed: ${batchSuccesses} succeeded, ${batchFailures.length} failed`);

            if (batchFailures.length > 0) {
                mailLogger.warn(`Bulk email batch ${batchNumber} had ${batchFailures.length} failures`, batchFailures);
            }
        }

        const overallFailures = allStatus.filter(s => s.status !== 'Success');
        const overallSuccesses = allStatus.filter(s => s.status === 'Success');

        if (overallFailures.length > 0) {
            mailLogger.warn(`Bulk email had ${overallFailures.length} total failures out of ${recipients.length} recipients`);
        }

        mailLogger.info(`Bulk invite email completed: ${overallSuccesses.length} succeeded, ${overallFailures.length} failed out of ${recipients.length} total`);

        return {
            success: overallFailures.length < recipients.length,
            status: allStatus
        };

    } catch (error: any) {
        mailLogger.error('Error sending bulk invite email', error);
        return {
            success: false,
            error: error.message || 'Failed to send bulk invite email',
            status: bulkInviteData.recipients?.map((r: { recipientEmail: string; inviteToken: string; inviteTokenId: string }) => ({
                email: r.recipientEmail,
                status: 'Failed',
                error: error.message || 'Failed to send bulk invite email'
            })) || []
        };
    }
}

export async function SendVerifyEmailAddressMail(verifyData: VerifyEmailData): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
        const { recipientEmail, otp, userName, from } = verifyData;

        const htmlBody = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9f9f9;
        }
        .header {
            background-color: #2196F3;
            color: white;
            padding: 20px;
            text-align: center;
            border-radius: 5px 5px 0 0;
        }
        .content {
            background-color: white;
            padding: 30px;
            border-radius: 0 0 5px 5px;
        }
        .otp-box {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            margin: 30px 0;
            text-align: center;
            border-radius: 10px;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .otp-code {
            font-size: 36px;
            font-weight: bold;
            letter-spacing: 8px;
            font-family: 'Courier New', monospace;
            margin: 10px 0;
        }
        .warning-box {
            background-color: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .footer {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Verify Your Email Address</h1>
        </div>
        <div class="content">
            <p>Hello${userName ? ` ${userName}` : ''},</p>
            <p>Thank you for signing up! Please use the following One-Time Password (OTP) to verify your email address and complete your registration.</p>
            
            <div class="otp-box">
                <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">Your Verification Code</div>
                <div class="otp-code">${otp}</div>
                <div style="font-size: 12px; opacity: 0.8; margin-top: 10px;">Enter this code on the registration page</div>
            </div>
            
            <div class="warning-box">
                <strong>⏰ Important:</strong> This OTP will expire in 30 minutes. For your security, do not share this code with anyone.
            </div>
            
            <p>If you didn't create an account, you can safely ignore this email.</p>
        </div>
        <div class="footer">
            <p>This is an automated email. Please do not reply directly to this message.</p>
            <p>&copy; ${new Date().getFullYear()} PhantomX. All rights reserved.</p>
        </div>
    </div>
</body>
</html>
        `;

        const textBody = `
Verify Your Email Address

Hello${userName ? ` ${userName}` : ''},

Thank you for signing up! Please use the following One-Time Password (OTP) to verify your email address and complete your registration.

Your Verification Code: ${otp}

Enter this code on the registration page to continue.

IMPORTANT: This OTP will expire in 30 minutes. For your security, do not share this code with anyone.

If you didn't create an account, you can safely ignore this email.

---
This is an automated email. Please do not reply directly to this message.
        `;

        return await SendMail({
            to: recipientEmail,
            subject: 'Your Email Verification Code',
            htmlBody,
            textBody,
            from
        });

    } catch (error: any) {
        console.error('Error sending verification email:', error);
        return {
            success: false,
            error: error.message || 'Failed to send verification email'
        };
    }
}

export async function invite_mail_handler(io: Server, socket: Socket) {

    socket.on('send_email', async (data: EmailData, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                if (typeof callback === 'function') {
                    callback({
                        success: false,
                        error: 'User not authenticated'
                    });
                }
                return;
            }

            console.log(`User ${socket.data.user.userName} is queueing email to ${data.to}`);

            if (typeof callback !== 'function') {
                console.error('Callback is not a function');
                return;
            }
            const { queueMail } = await import('../Services/Queue/mail-queue');
            const jobId = await queueMail(data, {
                priority: 1,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 }
            });

            callback({
                success: true,
                jobId,
                message: 'Email queued successfully'
            });

        } catch (error: any) {
            console.error('Error in send_email handler:', error);
            if (typeof callback === 'function') {
                callback({
                    success: false,
                    error: error.message || 'Internal server error'
                });
            }
        }
    });


    socket.on('send_invite_email', async (data: {
        recipientEmail: string;
        inviterName?: string;
        organizationName?: string;
        organizationId?: string;
        inviteToken?: string;
        customMessage?: string;
    }, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                if (typeof callback === 'function') {
                    callback({
                        success: false,
                        error: 'User not authenticated'
                    });
                }
                return;
            }

            if (typeof callback !== 'function') {
                console.error('Callback is not a function');
                return;
            }

            if (!data.recipientEmail) {
                callback({
                    success: false,
                    error: 'Recipient email is required'
                });
                return;
            }

            const inviterName = data.inviterName || socket.data.user.userName || 'A team member';
            const organizationName = data.organizationName || 'our organization';
            const inviteToken = data.inviteToken || `invite_${Date.now()}_${Math.random().toString(36).substring(7)}`;

            // Queue the invite email with automatic retry
            const { queueInviteMail } = await import('../Services/Queue/mail-queue');
            const jobId = await queueInviteMail({
                recipientEmail: data.recipientEmail,
                inviterName,
                organizationName,
                inviteToken,
                customMessage: data.customMessage
            }, {
                priority: 2,
                attempts: 5,
                backoff: { type: 'exponential', delay: 3000 }
            });

            console.log(`Invitation email queued for ${data.recipientEmail} by ${socket.data.user.userName}`);

            callback({
                success: true,
                jobId,
                inviteToken,
                message: 'Invitation email queued successfully'
            });

        } catch (error: any) {
            console.error('Error in send_invite_email handler:', error);
            if (typeof callback === 'function') {
                callback({
                    success: false,
                    error: error.message || 'Internal server error'
                });
            }
        }
    });
}

//==================== TEST FUNCTIONS ====================

export async function testSendEmail() {
    console.log('Testing SendMail function...');
    const result = await SendMail({
        to: 'anchitrana4@gmail.com',
        subject: 'Test Email',
        textBody: 'This is a test email using the SendMail function.',
        htmlBody: '<h2>Test Email</h2><p>This is a test email using the SendMail function.</p>'
    });
    console.log('SendMail test result:', result);
}

export async function testSendInviteEmail() {
    console.log('Testing SendInviteMail function...');

    const result = await SendInviteMail({
        recipientEmail: 'anchitrana4@gmail.com',
        inviterName: 'Aniket',
        organizationName: 'PhantomX Dev',
        inviteToken: 'test_invite_token_123',
        customMessage: 'We are excited to have you join our development team!'
    });

    console.log('SendInviteMail test result:', result);
}

export async function testSendVerifyEmail() {
    console.log('Testing SendVerifyEmailAddressMail function...');

    const result = await SendVerifyEmailAddressMail({
        recipientEmail: 'anchitrana4@gmail.com',
        otp: '123456',
        userName: 'John Doe'
    });

    console.log('SendVerifyEmailAddressMail test result:', result);
}

// Uncomment to test the functions
// testSendEmail();
// testSendInviteEmail();
// testSendVerifyEmail();
