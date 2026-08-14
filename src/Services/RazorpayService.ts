import Razorpay from 'razorpay';
import { Socket } from 'socket.io';
import * as dotenv from 'dotenv';
import { createLogger } from '../utils/Logger';
import crypto from 'crypto';

dotenv.config();

const logger = createLogger('RazorpayService');

/**
 * Interface for storing subscription to organization mapping
 */
export interface RazorpaySubscriptionOrgMapping {
    subscriptionId: string;
    userId: string;
    organizationId: string;
    organizationName: string;
    dbName?: string;
    createdAt: Date;
    socketId?: string;
    socket?: Socket;
}

/**
 * Interface for storing order to organization mapping (for one-time payments/credits)
 */
export interface RazorpayOrderOrgMapping {
    orderId: string;
    userId: string;
    organizationId: string;
    organizationName: string;
    credits: number;
    amount: {
        value: string;
        currencyCode: string;
    };
    dbName?: string;
    createdAt: Date;
    socketId?: string;
    socket?: Socket;
    id: string;
    webhookStates?: {
        paymentCaptured?: { timestamp: Date; paymentId: string };
        paymentFailed?: { timestamp: Date; reason?: string };
    };
}

/**
 * Razorpay subscription status types
 */
export type RazorpaySubscriptionStatus = 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired';

/**
 * RazorpayService for managing subscriptions and payments
 * Supports subscription management and one-time payments for Indian users
 */
export class RazorpayService {
    private razorpay: Razorpay;
    private subscriptionOrgMap: Map<string, RazorpaySubscriptionOrgMapping>;
    private orderOrgMap: Map<string, RazorpayOrderOrgMapping>;
    private keyId: string;
    private keySecret: string;

    constructor() {
        this.keyId = process.env.RAZORPAY_KEY_ID || '';
        this.keySecret = process.env.RAZORPAY_KEY_SECRET || '';

        if (!this.keyId || !this.keySecret) {
            logger.warn('Razorpay credentials not found. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in environment variables.');
        }

        this.razorpay = new Razorpay({
            key_id: this.keyId,
            key_secret: this.keySecret,
        });

        this.subscriptionOrgMap = new Map();
        this.orderOrgMap = new Map();
        logger.info('RazorpayService initialized');
    }

    /**
     * Get the public key ID for client-side initialization
     */
    getKeyId(): string {
        return this.keyId;
    }

    /**
     * Store subscription to organization mapping
     */
    storeSubscriptionMapping(
        subscriptionId: string,
        mapping: Omit<RazorpaySubscriptionOrgMapping, 'subscriptionId' | 'createdAt' | 'socketId' | 'socket'>,
        socket?: Socket
    ): void {
        this.subscriptionOrgMap.set(subscriptionId, {
            subscriptionId,
            ...mapping,
            socketId: socket?.id,
            socket: socket,
            createdAt: new Date()
        });
        logger.info('Subscription mapping stored', { subscriptionId, organizationName: mapping.organizationName, socketId: socket?.id });
    }

    /**
     * Get subscription to organization mapping
     */
    getSubscriptionMapping(subscriptionId: string): RazorpaySubscriptionOrgMapping | undefined {
        return this.subscriptionOrgMap.get(subscriptionId);
    }

    /**
     * Remove subscription mapping
     */
    removeSubscriptionMapping(subscriptionId: string): void {
        this.subscriptionOrgMap.delete(subscriptionId);
        logger.info('Subscription mapping removed', { subscriptionId });
    }

    /**
     * Store order to organization mapping
     */
    storeOrderMapping(
        orderId: string,
        mapping: Omit<RazorpayOrderOrgMapping, 'orderId' | 'createdAt' | 'socketId' | 'socket'>,
        socket?: Socket
    ): void {
        this.orderOrgMap.set(orderId, {
            orderId,
            ...mapping,
            socketId: socket?.id,
            socket: socket,
            createdAt: new Date()
        });
        logger.info('Order mapping stored', { orderId, organizationName: mapping.organizationName });
    }

    /**
     * Get order to organization mapping
     */
    getOrderMapping(orderId: string): RazorpayOrderOrgMapping | undefined {
        return this.orderOrgMap.get(orderId);
    }

    /**
     * Remove order mapping
     */
    removeOrderMapping(orderId: string): void {
        this.orderOrgMap.delete(orderId);
        logger.info('Order mapping removed', { orderId });
    }

    /**
     * Update order webhook state
     */
    updateOrderWebhookState(orderId: string, state: string, data: any): void {
        const mapping = this.orderOrgMap.get(orderId);
        if (mapping) {
            if (!mapping.webhookStates) {
                mapping.webhookStates = {};
            }
            (mapping.webhookStates as any)[state] = data;
        }
    }

    // ==================== PLAN MANAGEMENT ====================

    /**
     * Create a new plan in Razorpay
     */
    async createPlan(planData: {
        period: 'daily' | 'weekly' | 'monthly' | 'yearly';
        interval: number;
        item: {
            name: string;
            amount: number; // in paise (multiply INR by 100)
            currency: string;
            description?: string;
        };
        notes?: Record<string, string>;
    }): Promise<{ success: boolean; planId?: string; plan?: any; error?: any }> {
        try {
            const plan = await this.razorpay.plans.create({
                period: planData.period,
                interval: planData.interval,
                item: planData.item,
                notes: planData.notes || {}
            });

            logger.info('Plan created successfully', { planId: plan.id });
            return {
                success: true,
                planId: plan.id,
                plan
            };
        } catch (error: any) {
            logger.error('Error creating plan:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * List all plans
     */
    async listPlans(params?: { count?: number; skip?: number }): Promise<{ success: boolean; plans?: any[]; error?: any }> {
        try {
            const plans = await this.razorpay.plans.all({
                count: params?.count || 20,
                skip: params?.skip || 0
            });

            return {
                success: true,
                plans: plans.items || []
            };
        } catch (error: any) {
            logger.error('Error listing plans:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Get plan details
     */
    async getPlanDetails(planId: string): Promise<{ success: boolean; plan?: any; error?: any }> {
        try {
            const plan = await this.razorpay.plans.fetch(planId);
            return {
                success: true,
                plan
            };
        } catch (error: any) {
            logger.error('Error getting plan details:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    // ==================== SUBSCRIPTION MANAGEMENT ====================

    /**
     * Create a new subscription
     */
    async createSubscription(subscriptionData: {
        planId: string;
        totalCount?: number; // Number of billing cycles (0 for infinite)
        quantity?: number;
        customerNotify?: 0 | 1;
        startAt?: number; // Unix timestamp
        expireBy?: number; // Unix timestamp
        notes?: Record<string, string>;
        offerId?: string;
    }): Promise<{ success: boolean; subscriptionId?: string; shortUrl?: string; subscription?: any; error?: any }> {
        try {
            // CRITICAL: Validate that notes contain organizationId
            // This is required for webhook processing to identify the organization
            const notes = subscriptionData.notes || {};
            
            if (!notes.organizationId) {
                logger.error('CRITICAL: createSubscription called without organizationId in notes!', { notes });
                return {
                    success: false,
                    error: 'organizationId is required in notes for subscription creation'
                };
            }
            
            logger.info('Creating subscription with notes:', JSON.stringify(notes));
            
            const expireBy = subscriptionData.expireBy ?? (() => {
                const d = new Date();
                d.setFullYear(d.getFullYear() + 5);
                return Math.floor(d.getTime() / 1000);
            })();

            const subscription = await this.razorpay.subscriptions.create({
                plan_id: subscriptionData.planId,
                total_count: subscriptionData.totalCount || 12, // 0 for infinite
                quantity: subscriptionData.quantity || 1,
                customer_notify: subscriptionData.customerNotify ?? 1,
                start_at: subscriptionData.startAt,
                expire_by: expireBy,
                notes: notes,
                offer_id: subscriptionData.offerId
            });

            // Log the created subscription to verify notes were set
            logger.info('Subscription created successfully', { 
                subscriptionId: subscription.id,
                notesSet: JSON.stringify(subscription.notes)
            });
            
            // Verify notes were actually set on the subscription
            if (!subscription.notes || !subscription.notes.organizationId) {
                logger.warn('WARNING: Subscription created but notes may not have been set properly', {
                    subscriptionId: subscription.id,
                    expectedNotes: notes,
                    actualNotes: subscription.notes
                });
            }
            
            return {
                success: true,
                subscriptionId: subscription.id,
                shortUrl: subscription.short_url,
                subscription
            };
        } catch (error: any) {
            logger.error('Error creating subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Get subscription details
     */
    async getSubscriptionDetails(subscriptionId: string): Promise<{ success: boolean; subscription?: any; error?: any }> {
        try {
            const subscription = await this.razorpay.subscriptions.fetch(subscriptionId);
            return {
                success: true,
                subscription
            };
        } catch (error: any) {
            logger.error('Error getting subscription details:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * List all subscriptions
     */
    async listSubscriptions(params?: { count?: number; skip?: number }): Promise<{ success: boolean; subscriptions?: any[]; error?: any }> {
        try {
            const subscriptions = await this.razorpay.subscriptions.all({
                count: params?.count || 20,
                skip: params?.skip || 0
            });

            return {
                success: true,
                subscriptions: subscriptions.items || []
            };
        } catch (error: any) {
            logger.error('Error listing subscriptions:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Cancel a subscription
     */
    async cancelSubscription(subscriptionId: string, cancelAtCycleEnd: boolean = false): Promise<{ success: boolean; subscription?: any; error?: any }> {
        try {
            const subscription = await this.razorpay.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
            logger.info('Subscription cancelled successfully', { subscriptionId, cancelAtCycleEnd });
            return {
                success: true,
                subscription
            };
        } catch (error: any) {
            logger.error('Error cancelling subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Pause a subscription
     */
    async pauseSubscription(subscriptionId: string): Promise<{ success: boolean; subscription?: any; error?: any }> {
        try {
            const subscription = await this.razorpay.subscriptions.pause(subscriptionId);
            logger.info('Subscription paused successfully', { subscriptionId });
            return {
                success: true,
                subscription
            };
        } catch (error: any) {
            logger.error('Error pausing subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Resume a paused subscription
     */
    async resumeSubscription(subscriptionId: string): Promise<{ success: boolean; subscription?: any; error?: any }> {
        try {
            const subscription = await this.razorpay.subscriptions.resume(subscriptionId);
            logger.info('Subscription resumed successfully', { subscriptionId });
            return {
                success: true,
                subscription
            };
        } catch (error: any) {
            logger.error('Error resuming subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Update a subscription
     */
    async updateSubscription(subscriptionId: string, updateData: {
        planId?: string;
        quantity?: number;
        remainingCount?: number;
        startAt?: number;
        scheduleChangeAt?: 'now' | 'cycle_end';
        offerIdWithRemove?: string;
    }): Promise<{ success: boolean; subscription?: any; error?: any }> {
        try {
            const updatePayload: any = {};
            if (updateData.planId) updatePayload.plan_id = updateData.planId;
            if (updateData.quantity) updatePayload.quantity = updateData.quantity;
            if (updateData.remainingCount) updatePayload.remaining_count = updateData.remainingCount;
            if (updateData.startAt) updatePayload.start_at = updateData.startAt;
            if (updateData.scheduleChangeAt) updatePayload.schedule_change_at = updateData.scheduleChangeAt;
            if (updateData.offerIdWithRemove) updatePayload.offer_id = updateData.offerIdWithRemove;

            const subscription = await this.razorpay.subscriptions.update(subscriptionId, updatePayload);
            logger.info('Subscription updated successfully', { subscriptionId });
            return {
                success: true,
                subscription
            };
        } catch (error: any) {
            logger.error('Error updating subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    // ==================== ORDER MANAGEMENT (for one-time payments) ====================

    /**
     * Create an order for one-time payment (credit purchase)
     */
    async createOrder(orderData: {
        amount: number; // in paise
        currency: string;
        receipt: string;
        notes?: Record<string, string>;
    }): Promise<{ success: boolean; orderId?: string; order?: any; error?: any }> {
        try {
            // CRITICAL: Validate that notes contain organizationId
            // This is required for webhook processing to identify the organization
            const notes = orderData.notes || {};
            
            if (!notes.organizationId) {
                logger.error('CRITICAL: createOrder called without organizationId in notes!', { notes });
                return {
                    success: false,
                    error: 'organizationId is required in notes for order creation'
                };
            }
            
            logger.info('Creating order with notes:', JSON.stringify(notes));
            
            const order = await this.razorpay.orders.create({
                amount: orderData.amount,
                currency: orderData.currency,
                receipt: orderData.receipt,
                notes: notes
            });

            logger.info('Order created successfully', { 
                orderId: order.id,
                notesSet: JSON.stringify(order.notes)
            });
            
            return {
                success: true,
                orderId: order.id,
                order
            };
        } catch (error: any) {
            logger.error('Error creating order:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Get order details
     */
    async getOrderDetails(orderId: string): Promise<{ success: boolean; order?: any; error?: any }> {
        try {
            const order = await this.razorpay.orders.fetch(orderId);
            return {
                success: true,
                order
            };
        } catch (error: any) {
            logger.error('Error getting order details:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Get payments for an order
     */
    async getOrderPayments(orderId: string): Promise<{ success: boolean; payments?: any[]; error?: any }> {
        try {
            const payments = await this.razorpay.orders.fetchPayments(orderId);
            return {
                success: true,
                payments: payments.items || []
            };
        } catch (error: any) {
            logger.error('Error getting order payments:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    // ==================== PAYMENT VERIFICATION ====================

    /**
     * Verify payment signature for orders
     */
    verifyPaymentSignature(params: {
        orderId: string;
        paymentId: string;
        signature: string;
    }): boolean {
        try {
            const generatedSignature = crypto
                .createHmac('sha256', this.keySecret)
                .update(`${params.orderId}|${params.paymentId}`)
                .digest('hex');

            return generatedSignature === params.signature;
        } catch (error: any) {
            logger.error('Error verifying payment signature:', error);
            return false;
        }
    }

    /**
     * Verify subscription payment signature
     */
    verifySubscriptionPaymentSignature(params: {
        subscriptionId: string;
        paymentId: string;
        signature: string;
    }): boolean {
        try {
            const generatedSignature = crypto
                .createHmac('sha256', this.keySecret)
                .update(`${params.paymentId}|${params.subscriptionId}`)
                .digest('hex');

            return generatedSignature === params.signature;
        } catch (error: any) {
            logger.error('Error verifying subscription payment signature:', error);
            return false;
        }
    }

    /**
     * Verify webhook signature
     */
    verifyWebhookSignature(body: string, signature: string, secret?: string): boolean {
        try {
            const webhookSecret = secret || process.env.RAZORPAY_WEBHOOK_SECRET || '';
            const generatedSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(body)
                .digest('hex');

            return generatedSignature === signature;
        } catch (error: any) {
            logger.error('Error verifying webhook signature:', error);
            return false;
        }
    }

    // ==================== PAYMENT MANAGEMENT ====================

    /**
     * Get payment details
     */
    async getPaymentDetails(paymentId: string): Promise<{ success: boolean; payment?: any; error?: any }> {
        try {
            const payment = await this.razorpay.payments.fetch(paymentId);
            return {
                success: true,
                payment
            };
        } catch (error: any) {
            logger.error('Error getting payment details:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Capture a payment
     */
    async capturePayment(paymentId: string, amount: number, currency: string): Promise<{ success: boolean; payment?: any; error?: any }> {
        try {
            const payment = await this.razorpay.payments.capture(paymentId, amount, currency);
            logger.info('Payment captured successfully', { paymentId });
            return {
                success: true,
                payment
            };
        } catch (error: any) {
            logger.error('Error capturing payment:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * Refund a payment
     */
    async refundPayment(paymentId: string, amount?: number, notes?: Record<string, string>): Promise<{ success: boolean; refund?: any; error?: any }> {
        try {
            const refundData: any = { notes: notes || {} };
            if (amount) refundData.amount = amount;

            const refund = await this.razorpay.payments.refund(paymentId, refundData);
            logger.info('Payment refunded successfully', { paymentId });
            return {
                success: true,
                refund
            };
        } catch (error: any) {
            logger.error('Error refunding payment:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    // ==================== INVOICES ====================

    /**
     * Get invoices for a subscription
     */

    /**
     * Get invoice details by ID
     */
    async getInvoiceDetails(invoiceId: string): Promise<{ success: boolean; invoice?: any; error?: any }> {
        try {
            const invoice = await this.razorpay.invoices.fetch(invoiceId);
            return {
                success: true,
                invoice
            };
        } catch (error: any) {
            logger.error('Error getting invoice details:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }
    async getSubscriptionInvoices(subscriptionId: string): Promise<{ success: boolean; invoices?: any[]; error?: any }> {
        try {
            const invoices = await this.razorpay.invoices.all({
                subscription_id: subscriptionId
            });
            return {
                success: true,
                invoices: invoices.items || []
            };
        } catch (error: any) {
            logger.error('Error getting subscription invoices:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }
}

// Singleton instance
let razorpayServiceInstance: RazorpayService | null = null;

export function getRazorpayService(): RazorpayService {
    if (!razorpayServiceInstance) {
        razorpayServiceInstance = new RazorpayService();
    }
    return razorpayServiceInstance;
}

export default RazorpayService;

