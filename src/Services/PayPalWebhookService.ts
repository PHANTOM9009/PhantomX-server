import { Request } from 'express';
import * as dotenv from 'dotenv';
const SmeeClient = require('smee-client');
import { createLogger } from '../utils/Logger';

const logger = createLogger('PayPalWebhookService');

dotenv.config();

export enum PayPalWebhookEventType {
    // Subscription Events
    BILLING_SUBSCRIPTION_CREATED = 'BILLING.SUBSCRIPTION.CREATED',
    BILLING_SUBSCRIPTION_ACTIVATED = 'BILLING.SUBSCRIPTION.ACTIVATED',
    BILLING_SUBSCRIPTION_CANCELLED = 'BILLING.SUBSCRIPTION.CANCELLED',
    BILLING_SUBSCRIPTION_EXPIRED = 'BILLING.SUBSCRIPTION.EXPIRED',
    BILLING_SUBSCRIPTION_SUSPENDED = 'BILLING.SUBSCRIPTION.SUSPENDED',
    BILLING_SUBSCRIPTION_UPDATED = 'BILLING.SUBSCRIPTION.UPDATED',
    BILLING_SUBSCRIPTION_PAYMENT_FAILED = 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    
    // Payment Events
    PAYMENT_SALE_COMPLETED = 'PAYMENT.SALE.COMPLETED',
    PAYMENT_SALE_DENIED = 'PAYMENT.SALE.DENIED',
    PAYMENT_SALE_PENDING = 'PAYMENT.SALE.PENDING',
    PAYMENT_SALE_REFUNDED = 'PAYMENT.SALE.REFUNDED',
    PAYMENT_SALE_REVERSED = 'PAYMENT.SALE.REVERSED',
    
    // Plan Events
    BILLING_PLAN_CREATED = 'BILLING.PLAN.CREATED',
    BILLING_PLAN_UPDATED = 'BILLING.PLAN.UPDATED',
    BILLING_PLAN_ACTIVATED = 'BILLING.PLAN.ACTIVATED',
    BILLING_PLAN_DEACTIVATED = 'BILLING.PLAN.DEACTIVATED',
    
    // Capture Events
    PAYMENT_CAPTURE_COMPLETED = 'PAYMENT.CAPTURE.COMPLETED',
    PAYMENT_CAPTURE_DENIED = 'PAYMENT.CAPTURE.DENIED',
    PAYMENT_CAPTURE_PENDING = 'PAYMENT.CAPTURE.PENDING',
    PAYMENT_CAPTURE_REFUNDED = 'PAYMENT.CAPTURE.REFUNDED',
    PAYMENT_CAPTURE_REVERSED = 'PAYMENT.CAPTURE.REVERSED',
    
    // Checkout Order Events
    CHECKOUT_ORDER_APPROVED = 'CHECKOUT.ORDER.APPROVED',
    CHECKOUT_ORDER_COMPLETED = 'CHECKOUT.ORDER.COMPLETED',
    CHECKOUT_ORDER_SAVED = 'CHECKOUT.ORDER.SAVED',
    CHECKOUT_ORDER_VOIDED = 'CHECKOUT.ORDER.VOIDED',
    
    // Payment Order Events
    PAYMENT_ORDER_CREATED = 'PAYMENT.ORDER.CREATED',
    PAYMENT_ORDER_CANCELLED = 'PAYMENT.ORDER.CANCELLED',
}

export interface PayPalWebhookHandler {
    (event: PayPalWebhookEvent): Promise<void> | void;
}


export interface PayPalWebhookEvent {
    id: string;
    event_type: string;
    create_time: string;
    resource_type: string;
    resource_version?: string;
    resource: any;
    summary?: string;
    links?: Array<{
        href: string;
        rel: string;
        method: string;
    }>;
}

export class PayPalWebhookService {
    private eventHandlers: Map<string, PayPalWebhookHandler[]>;
    private webhookId: string;
    private smeeClient: any;
    private smeeUrl: string;

    constructor() {
        this.eventHandlers = new Map();
        this.webhookId = process.env.PAYPAL_WEBHOOK_ID || '49R94134BS7927917';
        this.smeeUrl = process.env.SMEE_URL || 'https://smee.io/VYMXB0YTzUU37Bc';
    }

    /**
     * Verify webhook using webhook ID
     * Checks if webhook ID is configured (basic validation)
     */
    verifyWebhook(req: Request): boolean {
        // Check webhook ID is configured
        if (!this.webhookId) {
            logger.error('PAYPAL_WEBHOOK_ID not configured');
            return false;
        }

        // Basic validation - check if request has PayPal-like structure
        // Note: Without signature verification, this is a basic check
        // In production, you should use PayPal's webhook verification API or signature verification
        logger.info(`Webhook received. Webhook ID configured: ${this.webhookId}`);
        return true;
    }


    on(eventType: PayPalWebhookEventType | string, handler: PayPalWebhookHandler): void {
        if (!this.eventHandlers.has(eventType)) {
            this.eventHandlers.set(eventType, []);
        }
        this.eventHandlers.get(eventType)!.push(handler);
    }

    /**
     * Process a webhook event
     */
    async processWebhookEvent(event: PayPalWebhookEvent): Promise<void> {
        const handlers = this.eventHandlers.get(event.event_type) || [];
        
        // Also check for wildcard handlers
        const wildcardHandlers = this.eventHandlers.get('*') || [];

        const allHandlers = [...handlers, ...wildcardHandlers];

        if (allHandlers.length === 0) {
            logger.info(`No handlers registered for event type: ${event.event_type}`);
            return;
        }

        // Execute all handlers for this event type
        await Promise.all(
            allHandlers.map(async (handler) => {
                try {
                    await handler(event);
                } catch (error) {
                    logger.error(`Error processing webhook event ${event.id}:`, error);
                }
            })
        );
    }
    /**
     * Handle incoming webhook request
     * @param req Express request object
     * @param body Webhook body (can be Buffer or parsed JSON)
     */
    async handleWebhook(req: Request, body: any): Promise<{ success: boolean; error?: string }> {
        try {
            // Verify webhook (basic webhook ID check)
            if (!this.verifyWebhook(req)) {
                return {
                    success: false,
                    error: 'Webhook verification failed'
                };
            }

            // Parse the body as JSON if it's a Buffer, otherwise use as-is
            let event: PayPalWebhookEvent;
            if (Buffer.isBuffer(body)) {
                try {
                    event = JSON.parse(body.toString('utf8'));
                } catch (parseError: any) {
                    return {
                        success: false,
                        error: 'Invalid JSON in webhook body'
                    };
                }
            } else {
                event = body;
            }

            if (!event.id || !event.event_type) {
                return {
                    success: false,
                    error: 'Invalid webhook event structure'
                };
            }

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
    getHandlers(eventType: string): PayPalWebhookHandler[] {
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
    removeHandler(eventType: string, handler: PayPalWebhookHandler): void {
        const handlers = this.eventHandlers.get(eventType);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

 
    initializeSmee(localWebhookUrl: string): void {
        try {
            if (this.smeeClient) {
                logger.info('Smee client already initialized, stopping existing client...');
                this.smeeClient.stop();
            }

            logger.info(`Initializing Smee client: ${this.smeeUrl} -> ${localWebhookUrl}`);
            
            const events = new SmeeClient({
                source: this.smeeUrl,
                target: localWebhookUrl,
                logger: console
            });

            this.smeeClient = events.start();

            logger.success('Smee client started successfully');
        } catch (error: any) {
            logger.error('Error initializing Smee client:', error);
        }
    }

    /**
     * Stop Smee client
     */
    stopSmee(): void {
        if (this.smeeClient) {
            try {
                this.smeeClient.stop();
                logger.info('Smee client stopped');
            } catch (error: any) {
                logger.error('Error stopping Smee client:', error);
            }
        }
    }
}

// Export singleton instance
export const paypalWebhookService = new PayPalWebhookService();

