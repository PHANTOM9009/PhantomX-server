import { Client, Configuration, Environment, SubscriptionsController, OrdersController, PatchOp, IntervalUnit, ExperienceContextShippingPreference, CaptureType, ApplicationContextUserAction, OrderApplicationContextUserAction, CheckoutPaymentIntent, TenureType, SetupFeeFailureAction } from '@paypal/paypal-server-sdk';
import { Socket } from 'socket.io';
import * as dotenv from 'dotenv';

dotenv.config();
import { createLogger } from '../utils/Logger';

const logger = createLogger('PayPalService');

/**
 * PayPal Service for managing plans and subscriptions
 * Supports all PayPal billing plan and subscription operations
 */
/**
 * Interface for storing subscription to organization mapping
 */
export interface SubscriptionOrgMapping {
    subscriptionId: string;
    userId: string;
    organizationId: string;
    organizationName: string;
    dbName?: string;
    createdAt: Date;
    socketId?: string; 
    socket?: Socket;
}

export interface OrderOrgMapping {
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
        checkoutOrderApproved?: { timestamp: Date; status: string };
        paymentCaptureCompleted?: { timestamp: Date; captureId: string };
        paymentCaptureDenied?: { timestamp: Date; reason?: string };
        paymentCapturePending?: { timestamp: Date };
        paymentCaptureRefunded?: { timestamp: Date; refundId?: string };
        paymentCaptureReversed?: { timestamp: Date };
    };
}

export class PayPalService {
    private client: Client;
    private subscriptionsController: SubscriptionsController;
    private ordersController: OrdersController;
    private subscriptionOrgMap: Map<string, SubscriptionOrgMapping>;
    private orderOrgMap: Map<string, OrderOrgMapping>;

    constructor() {
        const clientId = process.env.PAYPAL_CLIENT_ID;
        const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
        const environment = process.env.PAYPAL_ENVIRONMENT || 'sandbox';

        if (!clientId || !clientSecret) {
            throw new Error('PayPal credentials not found. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in environment variables.');
        }

        const config: Partial<Configuration> = {
            environment: environment === 'production' ? Environment.Production : Environment.Sandbox,
            clientCredentialsAuthCredentials: {
                oAuthClientId: clientId,
                oAuthClientSecret: clientSecret,
            },
        };

        this.client = new Client(config);
        this.subscriptionsController = new SubscriptionsController(this.client);
        this.ordersController = new OrdersController(this.client);
        this.subscriptionOrgMap = new Map();
        this.orderOrgMap = new Map();
        logger.info('PayPalService initialized', { environment });
    }

    /**
     * Store subscription to organization mapping
     * This is used to identify which organization a subscription belongs to when webhooks arrive
     * @param subscriptionId PayPal subscription ID
     * @param mapping Organization and user information
     * @param socket Optional socket instance for sending notifications
     */
    storeSubscriptionMapping(subscriptionId: string, mapping: Omit<SubscriptionOrgMapping, 'subscriptionId' | 'createdAt' | 'socketId' | 'socket'>, socket?: Socket): void {
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
    getSubscriptionMapping(subscriptionId: string): SubscriptionOrgMapping | undefined {
        return this.subscriptionOrgMap.get(subscriptionId);
    }

    /**
     * Remove subscription mapping (after activation or cancellation)
     */
    removeSubscriptionMapping(subscriptionId: string): void {
        this.subscriptionOrgMap.delete(subscriptionId);
        logger.info('Subscription mapping removed', { subscriptionId });
    }

    /**
     * 1. Create Plan
     * Creates a new billing plan
     */
    async createPlan(planData: {
        productId: string;
        name: string;
        description: string;
        billingCycles: Array<{
            frequency: {
                intervalUnit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
                intervalCount: number;
            };
            tenureType: 'REGULAR' | 'TRIAL';
            sequence: number;
            totalCycles?: number;
            pricingScheme: {
                fixedPrice: {
                    value: string;
                    currencyCode: string;
                };
            };
        }>;
        paymentPreferences?: {
            autoBillOutstanding?: boolean;
            setupFee?: {
                value: string;
                currencyCode: string;
            };
            setupFeeFailureAction?: 'CONTINUE' | 'CANCEL';
            paymentFailureThreshold?: number;
        };
        taxes?: {
            percentage: string;
            inclusive?: boolean;
        };
    }): Promise<{ success: boolean; planId?: string; plan?: any; error?: any }> {
        try {
            const response = await this.subscriptionsController.createBillingPlan({
                prefer: 'return=representation',
                body: {
                    productId: planData.productId,
                    name: planData.name,
                    description: planData.description,
                    billingCycles: planData.billingCycles.map(cycle => ({
                        frequency: {
                            intervalUnit: cycle.frequency.intervalUnit as IntervalUnit,
                            intervalCount: cycle.frequency.intervalCount
                        },
                        tenureType: cycle.tenureType === 'REGULAR' ? TenureType.Regular : TenureType.Trial,
                        sequence: cycle.sequence,
                        totalCycles: cycle.totalCycles,
                        pricingScheme: {
                            fixedPrice: {
                                value: cycle.pricingScheme.fixedPrice.value,
                                currencyCode: cycle.pricingScheme.fixedPrice.currencyCode
                            }
                        }
                    })),
                    paymentPreferences: planData.paymentPreferences ? {
                        autoBillOutstanding: planData.paymentPreferences.autoBillOutstanding,
                        setupFee: planData.paymentPreferences.setupFee ? {
                            value: planData.paymentPreferences.setupFee.value,
                            currencyCode: planData.paymentPreferences.setupFee.currencyCode
                        } : undefined,
                        setupFeeFailureAction: planData.paymentPreferences.setupFeeFailureAction === 'CONTINUE' ? SetupFeeFailureAction.Continue : planData.paymentPreferences.setupFeeFailureAction === 'CANCEL' ? SetupFeeFailureAction.Cancel : undefined,
                        paymentFailureThreshold: planData.paymentPreferences.paymentFailureThreshold
                    } : {
                        autoBillOutstanding: true
                    },
                    taxes: planData.taxes ? {
                        percentage: planData.taxes.percentage,
                        inclusive: planData.taxes.inclusive
                    } : undefined
                }
            });
            
            return {
                success: true,
                planId: response.result.id,
                plan: response.result
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
     * 2. List Plans
     * Lists all billing plans
     */
     async listPlans(params?: {
        productId?: string;
        pageSize?: number;
        page?: number;
        totalRequired?: boolean;
    }): Promise<{ success: boolean; plans?: any[]; totalPages?: number; error?: any }> {
        try {
            const response = await this.subscriptionsController.listBillingPlans({
                prefer: 'return=representation',
                productId: params?.productId,
                pageSize: params?.pageSize ?? 20,  
                page: params?.page,
                totalRequired: params?.totalRequired ?? true 
            });
            
            return {
                success: true,
                plans: response.result.plans || [],
                totalPages: response.result.totalPages
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
     * 3. Show Plan Details
     * Gets details of a specific plan
     */
    async showPlanDetails(planId: string): Promise<{ success: boolean; plan?: any; error?: any }> {
        try {
            const response = await this.subscriptionsController.getBillingPlan(planId);
            
            return {
                success: true,
                plan: response.result
            };
        } catch (error: any) {
            logger.error('Error getting plan details:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 4. Update Plan
     * Updates a billing plan (only certain fields can be updated)
     */
    async updatePlan(planId: string, updateData: Array<{
        op: 'replace' | 'add' | 'remove';
        path: string;
        value: any;
    }>): Promise<{ success: boolean; plan?: any; error?: any }> {
        try {
            await this.subscriptionsController.patchBillingPlan({
                id: planId,
                body: updateData.map(item => ({
                    op: item.op === 'replace' ? PatchOp.Replace : item.op === 'add' ? PatchOp.Add : PatchOp.Remove,
                    path: item.path,
                    value: item.value
                }))
            });
            
            // Fetch updated plan
            return await this.showPlanDetails(planId);
        } catch (error: any) {
            logger.error('Error updating plan:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 5. Activate Plan
     * Activates a billing plan
     */
    async activatePlan(planId: string): Promise<{ success: boolean; error?: any }> {
        try {
            await this.subscriptionsController.activateBillingPlan(planId);
            
            return {
                success: true
            };
        } catch (error: any) {
            logger.error('Error activating plan:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 6. Deactivate Plan
     * Deactivates a billing plan
     */
    async deactivatePlan(planId: string): Promise<{ success: boolean; error?: any }> {
        try {
            await this.subscriptionsController.deactivateBillingPlan(planId);
            
            return {
                success: true
            };
        } catch (error: any) {
            logger.error('Error deactivating plan:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 7. Update Pricing
     * Updates pricing for a plan
     */
    async updatePricing(planId: string, pricingUpdates: Array<{
        billingCycleSequence: number;
        pricingScheme: {
            fixedPrice?: {
                value: string;
                currencyCode: string;
            };
        };
    }>): Promise<{ success: boolean; plan?: any; error?: any }> {
        try {
            await this.subscriptionsController.updateBillingPlanPricingSchemes({
                id: planId,
                body: {
                    pricingSchemes: pricingUpdates.map(update => ({
                        billingCycleSequence: update.billingCycleSequence,
                        pricingScheme: {
                            fixedPrice: update.pricingScheme.fixedPrice ? {
                                value: update.pricingScheme.fixedPrice.value,
                                currencyCode: update.pricingScheme.fixedPrice.currencyCode
                            } : undefined
                        }
                    }))
                }
            });
            
            // Fetch updated plan
            return await this.showPlanDetails(planId);
        } catch (error: any) {
            logger.error('Error updating pricing:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 8. Create Subscription
     * Creates a new subscription
     */
    async createSubscription(subscriptionData: {
        planId: string;
        startTime?: string;
        subscriber?: {
            name?: {
                givenName?: string;
                surname?: string;
            };
            emailAddress?: string;
            shippingAddress?: any;
        };
        applicationContext?: {
            brandName?: string;
            locale?: string;
            shippingPreference?: 'GET_FROM_FILE' | 'NO_SHIPPING' | 'SET_PROVIDED_ADDRESS';
            userAction?: 'SUBSCRIBE_NOW' | 'CONTINUE';
            paymentMethod?: {
                payerSelected?: string;
                payeePreferred?: string;
            };
            returnUrl?: string;
            cancelUrl?: string;
        };
        customId?: string;
    }): Promise<{ success: boolean; subscriptionId?: string; links?: any[]; subscription?: any; error?: any }> {
        try {
            const response = await this.subscriptionsController.createSubscription({
                prefer: 'return=representation',
                body: {
                    planId: subscriptionData.planId,
                    startTime: subscriptionData.startTime || new Date(Date.now() + 60000).toISOString(),
                    subscriber: subscriptionData.subscriber ? {
                        name: subscriptionData.subscriber.name ? {
                            givenName: subscriptionData.subscriber.name.givenName,
                            surname: subscriptionData.subscriber.name.surname
                        } : undefined,
                        shippingAddress: subscriptionData.subscriber.shippingAddress
                    } : undefined,
                    applicationContext: subscriptionData.applicationContext ? {
                        brandName: subscriptionData.applicationContext.brandName,
                        locale: subscriptionData.applicationContext.locale,
                        shippingPreference: subscriptionData.applicationContext.shippingPreference === 'GET_FROM_FILE' ? ExperienceContextShippingPreference.GetFromFile : 
                                          subscriptionData.applicationContext.shippingPreference === 'NO_SHIPPING' ? ExperienceContextShippingPreference.NoShipping :
                                          subscriptionData.applicationContext.shippingPreference === 'SET_PROVIDED_ADDRESS' ? ExperienceContextShippingPreference.SetProvidedAddress : undefined,
                        userAction: subscriptionData.applicationContext.userAction === 'SUBSCRIBE_NOW' ? ApplicationContextUserAction.SubscribeNow : 
                                   subscriptionData.applicationContext.userAction === 'CONTINUE' ? ApplicationContextUserAction.Continue : undefined,
                        paymentMethod: subscriptionData.applicationContext.paymentMethod?.payeePreferred ? {
                            payeePreferred: subscriptionData.applicationContext.paymentMethod.payeePreferred as any
                        } : undefined,
                        returnUrl: subscriptionData.applicationContext.returnUrl || '',
                        cancelUrl: subscriptionData.applicationContext.cancelUrl || ''
                    } : undefined,
                    customId: subscriptionData.customId
                }
            });
            
            return {
                success: true,
                subscriptionId: response.result.id,
                links: response.result.links,
                subscription: response.result
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
     * 9. List Subscriptions
     * Lists all subscriptions
     */
    async listSubscriptions(params?: {
        planIds?: string;
        statuses?: string;
        createdAfter?: string;
        createdBefore?: string;
        statusUpdatedBefore?: string;
        statusUpdatedAfter?: string;
        filter?: string;
        pageSize?: number;
        page?: number;
        customerIds?: string[];
    }): Promise<{ success: boolean; subscriptions?: any[]; totalPages?: number; error?: any }> {
        try {
            const response = await this.subscriptionsController.listSubscriptions({
                planIds: params?.planIds,
                statuses: params?.statuses,
                createdAfter: params?.createdAfter,
                createdBefore: params?.createdBefore,
                statusUpdatedBefore: params?.statusUpdatedBefore,
                statusUpdatedAfter: params?.statusUpdatedAfter,
                filter: params?.filter,
                pageSize: params?.pageSize,
                page: params?.page,
                customerIds: params?.customerIds
            });
            
            return {
                success: true,
                subscriptions: response.result.subscriptions || [],
                totalPages: undefined // SubscriptionCollection doesn't have totalPages property
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
     * Get PayPal OAuth access token for direct API calls
     */
    private async getAccessToken(): Promise<string> {
        const clientId = process.env.PAYPAL_CLIENT_ID;
        const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
        const environment = process.env.PAYPAL_ENVIRONMENT || 'sandbox';
        const baseUrl = environment === 'production' 
            ? 'https://api-m.paypal.com' 
            : 'https://api-m.sandbox.paypal.com';

        // Create Basic Auth header
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Authorization': `Basic ${credentials}`
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get PayPal access token: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        return data.access_token;
    }

    /**
     * Fetch subscription details directly from PayPal API (bypasses SDK limitations)
     * This ensures we get full subscriber information including email_address and payer_id
     */
    async fetchSubscriptionDetailsDirect(subscriptionId: string): Promise<any> {
        try {
            const accessToken = await this.getAccessToken();
            const environment = process.env.PAYPAL_ENVIRONMENT || 'sandbox';
            const baseUrl = environment === 'production' 
                ? 'https://api-m.paypal.com' 
                : 'https://api-m.sandbox.paypal.com';

            const response = await fetch(`${baseUrl}/v1/billing/subscriptions/${subscriptionId}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to fetch subscription from PayPal API: ${response.status} ${errorText}`);
            }

            const subscriptionData = await response.json();
            return subscriptionData;
        } catch (error: any) {
            logger.error('Error fetching subscription details directly from API', { subscriptionId, error: error.message });
            throw error;
        }
    }

    /**
     * 10. Show Subscription Details
     * Gets details of a specific subscription
     */
    async showSubscriptionDetails(subscriptionId: string, fields?: string): Promise<{ success: boolean; subscription?: any; error?: any }> {
        try {
            const response = await this.subscriptionsController.getSubscription({
                id: subscriptionId,
            });
            const data = JSON.parse(response.body as string);
            let subscription: any = { status: data.status, ...response.result };

            const subscriber: any = subscription.subscriber;
            const hasSubscriberInfo = subscriber && 
                subscriber.email_address && 
                subscriber.payer_id;

            if (!hasSubscriberInfo) {
                logger.info('Subscriber information missing from SDK response, fetching directly from API', { subscriptionId });
                try {
                    const directApiData = await this.fetchSubscriptionDetailsDirect(subscriptionId);
                    const directSubscriber = directApiData.subscriber as any;
                    if (directSubscriber && (directSubscriber.email_address || directSubscriber.payer_id)) {
                        subscription = {
                            ...subscription,
                            subscriber: {
                                ...(subscription.subscriber as any),
                                ...(directSubscriber.email_address && { email_address: directSubscriber.email_address }),
                                ...(directSubscriber.payer_id && { payer_id: directSubscriber.payer_id })
                            }
                        };
                    }
                } catch (directApiError: any) {
                    logger.warn('Failed to fetch subscription from direct API, using SDK data', { 
                        subscriptionId, 
                        error: directApiError.message 
                    });
                }
            }

            return {
                success: true,
                subscription: subscription
            };
        } catch (error: any) {
            logger.error('Error getting subscription details:', error);
            // If SDK fails, try direct API call as fallback
            try {
                logger.info('SDK call failed, attempting direct API call', { subscriptionId });
                const directApiData = await this.fetchSubscriptionDetailsDirect(subscriptionId);
                return {
                    success: true,
                    subscription: directApiData
                };
            } catch (directApiError: any) {
                return {
                    success: false,
                    error: error.message || error
                };
            }
        }
    }

    /**
     * 11. Revise Plan or Quantity of Subscription
     * Revises a subscription (change plan or quantity)
     */
    async reviseSubscription(subscriptionId: string, revisionData: {
        planId?: string;
        quantity?: string;
        shippingAmount?: {
            value: string;
            currencyCode: string;
        };
        shippingAddress?: any;
        applicationContext?: {
            brandName?: string;
            locale?: string;
            shippingPreference?: 'GET_FROM_FILE' | 'NO_SHIPPING' | 'SET_PROVIDED_ADDRESS';
            returnUrl?: string;
            cancelUrl?: string;
        };
    }): Promise<{ success: boolean; subscriptionId?: string; links?: any[]; subscription?: any; error?: any }> {
        try {
            const response = await this.subscriptionsController.reviseSubscription({
                id: subscriptionId,
                body: {
                    planId: revisionData.planId,
                    quantity: revisionData.quantity,
                    shippingAmount: revisionData.shippingAmount ? {
                        value: revisionData.shippingAmount.value,
                        currencyCode: revisionData.shippingAmount.currencyCode
                    } : undefined,
                    shippingAddress: revisionData.shippingAddress,
                    applicationContext: revisionData.applicationContext ? {
                        brandName: revisionData.applicationContext.brandName,
                        locale: revisionData.applicationContext.locale,
                        shippingPreference: revisionData.applicationContext.shippingPreference === 'GET_FROM_FILE' ? ExperienceContextShippingPreference.GetFromFile : 
                                          revisionData.applicationContext.shippingPreference === 'NO_SHIPPING' ? ExperienceContextShippingPreference.NoShipping :
                                          revisionData.applicationContext.shippingPreference === 'SET_PROVIDED_ADDRESS' ? ExperienceContextShippingPreference.SetProvidedAddress : undefined,
                        returnUrl: revisionData.applicationContext.returnUrl || '',
                        cancelUrl: revisionData.applicationContext.cancelUrl || ''
                    } : undefined
                }
            });
            
            return {
                success: true,
                subscriptionId: subscriptionId, // Use input subscriptionId since ModifySubscriptionResponse doesn't have id
                links: response.result.links,
                subscription: response.result
            };
        } catch (error: any) {
            logger.error('Error revising subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 12. Suspend Subscription
     * Suspends a subscription
     */
    async suspendSubscription(subscriptionId: string, reason?: string): Promise<{ success: boolean; error?: any }> {
        try {
            await this.subscriptionsController.suspendSubscription({
                id: subscriptionId,
                body: {
                    reason: reason || 'Suspended by merchant'
                }
            });
            
            return {
                success: true
            };
        } catch (error: any) {
            logger.error('Error suspending subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 13. Cancel Subscription
     * Cancels a subscription
     */
    async cancelSubscription(subscriptionId: string, reason?: string): Promise<{ success: boolean; error?: any }> {
        try {
            await this.subscriptionsController.cancelSubscription({
                id: subscriptionId,
                body: {
                    reason: reason || 'Cancelled by merchant'
                }
            });
            
            return {
                success: true
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
     * 14. Activate Subscription
     * Activates a suspended subscription
     */
    async activateSubscription(subscriptionId: string, reason?: string): Promise<{ success: boolean; error?: any }> {
        try {
            await this.subscriptionsController.activateSubscription({
                id: subscriptionId,
                body: {
                    reason: reason || 'Activated by merchant'
                }
            });
            
            return {
                success: true
            };
        } catch (error: any) {
            logger.error('Error activating subscription:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 15. Capture Authorized Payment on Subscription
     * Captures an authorized payment for a subscription
     */
    async captureAuthorizedPayment(subscriptionId: string, captureData: {
        note: string;
        captureType?: 'OUTSTANDING_BALANCE' | 'OUTSTANDING_BALANCE_AND_LAST_FAILED_PAYMENT';
        amount: {
            value: string;
            currencyCode: string;
        };
    }): Promise<{ success: boolean; captureId?: string; capture?: any; error?: any }> {
        try {
            const response = await this.subscriptionsController.captureSubscription({
                id: subscriptionId,
                body: {
                    note: captureData.note,
                    captureType: CaptureType.OutstandingBalance, // PayPal SDK only supports OutstandingBalance
                    amount: {
                        value: captureData.amount.value,
                        currencyCode: captureData.amount.currencyCode
                    }
                }
            });
            
            return {
                success: true,
                capture: response.result
            };
        } catch (error: any) {
            logger.error('Error capturing authorized payment:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 16. Get Transactions for Subscription
     * Gets transaction history for a subscription
     */
    async getSubscriptionTransactions(subscriptionId: string, params: {
        startTime: string;
        endTime: string;
    }): Promise<{ success: boolean; transactions?: any[]; error?: any }> {
        try {
            const response = await this.subscriptionsController.listSubscriptionTransactions({
                id: subscriptionId,
                startTime: params.startTime,
                endTime: params.endTime
            });
            
            return {
                success: true,
                transactions: response.result.transactions || []
            };
        } catch (error: any) {
            logger.error('Error getting subscription transactions:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    //==============ORDER MANAGEMENT METHODS==============

    /**
     * Store order to organization mapping
     * Used to track which organization an order belongs to when webhooks arrive
     */
    storeOrderMapping(orderId: string, mapping: Omit<OrderOrgMapping, 'orderId' | 'createdAt' | 'socketId' | 'socket'>, socket?: Socket): void {
        this.orderOrgMap.set(orderId, {
            orderId,
            ...mapping,
            socketId: socket?.id,
            socket: socket,
            createdAt: new Date()
        });
        logger.info('Order mapping stored', { orderId, organizationName: mapping.organizationName, credits: mapping.credits, socketId: socket?.id });
    }

    /**
     * Get order to organization mapping
     */
    getOrderMapping(orderId: string): OrderOrgMapping | undefined {
        return this.orderOrgMap.get(orderId);
    }

    /**
     * Remove order mapping (after capture or cancellation)
     */
    removeOrderMapping(orderId: string): void {
        this.orderOrgMap.delete(orderId);
        logger.info('Order mapping removed', { orderId });
    }

    updateOrderWebhookState(
        orderId: string, 
        state: 'checkoutOrderApproved' | 'paymentCaptureCompleted' | 'paymentCaptureDenied' | 'paymentCapturePending' | 'paymentCaptureRefunded' | 'paymentCaptureReversed',
        data: { timestamp?: Date; status?: string; captureId?: string; reason?: string; refundId?: string }
    ): boolean {
        const mapping = this.orderOrgMap.get(orderId);
        if (!mapping) {
            logger.error('Cannot update webhook state - order mapping not found', { orderId, state });
            return false;
        }

        if (!mapping.webhookStates) {
            mapping.webhookStates = {};
        }

        mapping.webhookStates[state] = {
            timestamp: data.timestamp || new Date(),
            ...(data.status && { status: data.status }),
            ...(data.captureId && { captureId: data.captureId }),
            ...(data.reason && { reason: data.reason }),
            ...(data.refundId && { refundId: data.refundId })
        } as any;

        logger.info('Order webhook state updated', { orderId, state, data });
        return true;
    }

    /**
     * Get all order mappings (for admin/status checking)
     */
    getAllOrderMappings(): Map<string, OrderOrgMapping> {
        return this.orderOrgMap;
    }

    /**
     * Get order mapping with full webhook state information
     */
    getOrderMappingWithStates(orderId: string): { 
        mapping: OrderOrgMapping | null; 
        states: { [key: string]: any };
        statesSummary: string[];
    } {
        const mapping = this.orderOrgMap.get(orderId);
        if (!mapping) {
            return { mapping: null, states: {}, statesSummary: [] };
        }

        const states = mapping.webhookStates || {};
        const statesSummary = Object.entries(states)
            .filter(([_, value]) => value !== undefined)
            .map(([key, _]) => key);

        return {
            mapping: {
                ...mapping,
                socket: undefined // Remove socket reference for serialization
            },
            states,
            statesSummary
        };
    }

    /**
     * 17. Create Order
     * Creates a PayPal order for purchasing credits
     */
    async createOrder(orderData: {
        amount: {
            currencyCode: string;
            value: string;
        };
        description?: string;
        returnUrl?: string;
        cancelUrl?: string;
    }): Promise<{ success: boolean; orderId?: string; links?: any[]; order?: any; error?: any }> {
        try {
            const response = await this.ordersController.createOrder({
                body: {
                    intent: CheckoutPaymentIntent.Capture,
                    purchaseUnits: [{
                        amount: {
                            currencyCode: orderData.amount.currencyCode,
                            value: orderData.amount.value
                        },
                        description: orderData.description || 'Purchase credits'
                    }],
                    applicationContext: {
                        brandName: 'AI Coder',
                        locale: 'en-US',
                        userAction: OrderApplicationContextUserAction.PayNow,
                        returnUrl: orderData.returnUrl || `${process.env.PAYPAL_RETURN_URL || process.env.APP_URL}/paypal/orders/success`,
                        cancelUrl: orderData.cancelUrl || `${process.env.PAYPAL_CANCEL_URL || process.env.APP_URL}/paypal/orders/cancel`
                    }
                }
            });

            return {
                success: true,
                orderId: response.result.id,
                links: response.result.links,
                order: response.result
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
     * 18. Get Order Details
     * Shows details of a specific order
     */
    async getOrderDetails(orderId: string): Promise<{ success: boolean; order?: any; error?: any }> {
        try {
            const response = await this.ordersController.getOrder({
                id: orderId
            });

            return {
                success: true,
                order: response.result
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
     * 19. Capture Order Payment
     * Captures payment for an approved order
     */
    async captureOrder(orderId: string): Promise<{ success: boolean; captureId?: string; status?: string; order?: any; error?: any }> {
        try {
            const response = await this.ordersController.captureOrder({
                id: orderId,
                body: {}
            });

            return {
                success: true,
                captureId: response.result.purchaseUnits?.[0]?.payments?.captures?.[0]?.id,
                status: response.result.status,
                order: response.result
            };
        } catch (error: any) {
            logger.error('Error capturing order:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }

    /**
     * 20. Authorize Order Payment
     * Authorizes payment for an order (without capturing)
     */
    async authorizeOrder(orderId: string): Promise<{ success: boolean; authorizationId?: string; status?: string; order?: any; error?: any }> {
        try {
            const response = await this.ordersController.authorizeOrder({
                id: orderId,
                body: {}
            });

            return {
                success: true,
                authorizationId: response.result.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id,
                status: response.result.status,
                order: response.result
            };
        } catch (error: any) {
            logger.error('Error authorizing order:', error);
            return {
                success: false,
                error: error.message || error
            };
        }
    }
}

// Export singleton instance to ensure subscription mapping persists across requests
let paypalServiceInstance: PayPalService | null = null;

export function getPayPalService(): PayPalService {
    if (!paypalServiceInstance) {
        paypalServiceInstance = new PayPalService();
    }
    return paypalServiceInstance;
}
