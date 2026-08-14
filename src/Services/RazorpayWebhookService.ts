import { Request } from 'express';
import * as dotenv from 'dotenv';
import { createLogger } from '../utils/Logger';
import crypto from 'crypto';
const SmeeClient = require('smee-client');

const logger = createLogger('RazorpayWebhookService');

dotenv.config();

/**
 * Razorpay Webhook Event Types
 * https://razorpay.com/docs/webhooks/
 */
export enum RazorpayWebhookEventType {
    // Subscription Events
    SUBSCRIPTION_AUTHENTICATED = 'subscription.authenticated',
    SUBSCRIPTION_ACTIVATED = 'subscription.activated',
    SUBSCRIPTION_CHARGED = 'subscription.charged',
    SUBSCRIPTION_PENDING = 'subscription.pending',
    SUBSCRIPTION_HALTED = 'subscription.halted',
    SUBSCRIPTION_CANCELLED = 'subscription.cancelled',
    SUBSCRIPTION_COMPLETED = 'subscription.completed',
    SUBSCRIPTION_UPDATED = 'subscription.updated',
    SUBSCRIPTION_PAUSED = 'subscription.paused',
    SUBSCRIPTION_RESUMED = 'subscription.resumed',

    // Payment Events
    PAYMENT_AUTHORIZED = 'payment.authorized',
    PAYMENT_CAPTURED = 'payment.captured',
    PAYMENT_FAILED = 'payment.failed',
    PAYMENT_DISPUTE_CREATED = 'payment.dispute.created',
    PAYMENT_DISPUTE_WON = 'payment.dispute.won',
    PAYMENT_DISPUTE_LOST = 'payment.dispute.lost',

    // Order Events
    ORDER_PAID = 'order.paid',

    // Refund Events
    REFUND_CREATED = 'refund.created',
    REFUND_PROCESSED = 'refund.processed',
    REFUND_FAILED = 'refund.failed',

    // Invoice Events
    INVOICE_PAID = 'invoice.paid',
    INVOICE_EXPIRED = 'invoice.expired',
    INVOICE_PARTIALLY_PAID = 'invoice.partially_paid',
}

export interface RazorpayWebhookHandler {
    (event: RazorpayWebhookEvent): Promise<void> | void;
}

export interface RazorpayWebhookEvent {
    entity: string;
    account_id: string;
    event: string;
    contains: string[];
    payload: {
        subscription?: {
            entity: RazorpaySubscriptionPayload;
        };
        payment?: {
            entity: RazorpayPaymentPayload;
        };
        order?: {
            entity: RazorpayOrderPayload;
        };
        refund?: {
            entity: any;
        };
        invoice?: {
            entity: any;
        };
    };
    created_at: number;
}

export interface RazorpaySubscriptionPayload {
    id: string;
    entity: string;
    plan_id: string;
    status: string;
    current_start: number;
    current_end: number;
    ended_at: number | null;
    quantity: number;
    notes: Record<string, string>;
    charge_at: number;
    start_at: number;
    end_at: number | null;
    auth_attempts: number;
    total_count: number;
    paid_count: number;
    remaining_count: number;
    customer_notify: number;
    created_at: number;
    expire_by: number | null;
    short_url: string;
    has_scheduled_changes: boolean;
    change_scheduled_at: number | null;
    source: string;
    payment_method: string;
    offer_id: string | null;
    customer_id: string | null;
}

export interface RazorpayPaymentPayload {
    id: string;
    entity: string;
    amount: number;
    currency: string;
    status: string;
    order_id: string;
    invoice_id: string | null;
    international: boolean;
    method: string;
    amount_refunded: number;
    refund_status: string | null;
    captured: boolean;
    description: string;
    card_id: string | null;
    bank: string | null;
    wallet: string | null;
    vpa: string | null;
    email: string;
    contact: string;
    customer_id: string | null;
    notes: Record<string, string>;
    fee: number;
    tax: number;
    error_code: string | null;
    error_description: string | null;
    error_source: string | null;
    error_step: string | null;
    error_reason: string | null;
    acquirer_data: Record<string, any>;
    created_at: number;
}

export interface RazorpayOrderPayload {
    id: string;
    entity: string;
    amount: number;
    amount_paid: number;
    amount_due: number;
    currency: string;
    receipt: string;
    status: string;
    attempts: number;
    notes: Record<string, string>;
    created_at: number;
}

export class RazorpayWebhookService {
    private eventHandlers: Map<string, RazorpayWebhookHandler[]>;
    private webhookSecret: string;
    private smeeClient: any;
    private smeeUrl: string;

    constructor() {
        this.eventHandlers = new Map();
        this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
        this.smeeUrl = process.env.RAZORPAY_SMEE_URL || 'https://smee.io/SjCxepzox3vTtrU8';
    }

    /**
     * Verify webhook signature
     */
    verifyWebhook(req: Request, body: string | Buffer): boolean {
        try {
            const signature = req.headers['x-razorpay-signature'] as string;
            
            if (!signature) {
                logger.error('Missing x-razorpay-signature header');
                return false;
            }

            if (!this.webhookSecret) {
                logger.error('RAZORPAY_WEBHOOK_SECRET not configured');
                return false;
            }

            const bodyString = Buffer.isBuffer(body) ? body.toString('utf8') : body;
            
            const expectedSignature = crypto
                .createHmac('sha256', this.webhookSecret)
                .update(bodyString)
                .digest('hex');

            const isValid = crypto.timingSafeEqual(
                Buffer.from(expectedSignature),
                Buffer.from(signature)
            );

            if (!isValid) {
                logger.error('Webhook signature verification failed');
            }

            return isValid;
        } catch (error: any) {
            logger.error('Error verifying webhook:', error);
            return false;
        }
    }

    /**
     * Register an event handler
     */
    on(eventType: RazorpayWebhookEventType | string, handler: RazorpayWebhookHandler): void {
        if (!this.eventHandlers.has(eventType)) {
            this.eventHandlers.set(eventType, []);
        }
        this.eventHandlers.get(eventType)!.push(handler);
    }

    /**
     * Process a webhook event
     */
    async processWebhookEvent(event: RazorpayWebhookEvent): Promise<void> {
        const handlers = this.eventHandlers.get(event.event) || [];
        
        // Also check for wildcard handlers
        const wildcardHandlers = this.eventHandlers.get('*') || [];

        const allHandlers = [...handlers, ...wildcardHandlers];

        if (allHandlers.length === 0) {
            logger.info(`No handlers registered for event type: ${event.event}`);
            return;
        }

        // Execute all handlers for this event type
        await Promise.all(
            allHandlers.map(async (handler) => {
                try {
                    await handler(event);
                } catch (error) {
                    logger.error(`Error processing webhook event ${event.event}:`, error);
                }
            })
        );
    }

    /**
     * Handle incoming webhook request
     */
    async handleWebhook(req: Request, body: any): Promise<{ success: boolean; error?: string }> {
        try {
            const bodyString = Buffer.isBuffer(body) ? body.toString('utf8') : 
                              typeof body === 'string' ? body : JSON.stringify(body);

            // Verify webhook signature
            // if (!this.verifyWebhook(req, bodyString)) {
            //     return {
            //         success: false,
            //         error: 'Webhook verification failed'
            //     };
            // }

            // Parse the body as JSON
            let event: RazorpayWebhookEvent;
            try {
                event = typeof body === 'object' ? body : JSON.parse(bodyString);
            } catch (parseError: any) {
                return {
                    success: false,
                    error: 'Invalid JSON in webhook body'
                };
            }

            if (!event.event) {
                return {
                    success: false,
                    error: 'Invalid webhook event structure'
                };
            }

            logger.info(`Processing Razorpay webhook event: ${event.event}`);

            // Process the event
            await this.processWebhookEvent(event);

            return {
                success: true
            };
        } catch (error: any) {
            logger.error('Error handling webhook:', error);
            return {
                success: false,
                error: error.message || 'Unknown error'
            };
        }
    }

    /**
     * Get event handlers for a specific event type
     */
    getHandlers(eventType: string): RazorpayWebhookHandler[] {
        return this.eventHandlers.get(eventType) || [];
    }

    /**
     * Remove all handlers for an event type
     */
    removeHandlers(eventType: string): void {
        this.eventHandlers.delete(eventType);
    }

    /**
     * Remove a specific handler
     */
    removeHandler(eventType: string, handler: RazorpayWebhookHandler): void {
        const handlers = this.eventHandlers.get(eventType);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Initialize Smee client for local webhook forwarding
     * @param localWebhookUrl The local URL to forward webhooks to
     */
    initializeSmee(localWebhookUrl: string): void {
        try {
            if (this.smeeClient) {
                logger.info('Smee client already initialized, stopping existing client...');
                this.smeeClient.stop();
            }

            logger.info(`Initializing Razorpay Smee client: ${this.smeeUrl} -> ${localWebhookUrl}`);

            const events = new SmeeClient({
                source: this.smeeUrl,
                target: localWebhookUrl,
                logger: console
            });

            this.smeeClient = events.start();

            logger.info('Razorpay Smee client started successfully');
        } catch (error: any) {
            logger.error('Error initializing Razorpay Smee client:', error);
        }
    }

    /**
     * Stop Smee client
     */
    stopSmee(): void {
        if (this.smeeClient) {
            try {
                this.smeeClient.stop();
                logger.info('Razorpay Smee client stopped');
            } catch (error: any) {
                logger.error('Error stopping Razorpay Smee client:', error);
            }
        }
    }
}

// Export singleton instance
export const razorpayWebhookService = new RazorpayWebhookService();

