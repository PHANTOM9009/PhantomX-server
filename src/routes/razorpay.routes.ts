import express, { Router, Request, Response } from "express";
import { razorpayWebhookService, RazorpayWebhookEventType, RazorpayWebhookEvent } from '../Services/RazorpayWebhookService';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { ISubscriptionInfo } from '../DataAccessLayer/models/SubscriptionInfo';
import { RazorpayService } from '../Services/RazorpayService';
import { createLogger } from '../utils/Logger';
import * as dotenv from 'dotenv';

const webhookLogger = createLogger('RazorpayWebhook');
const routeLogger = createLogger('RazorpayRoutes');

dotenv.config();

const router: Router = express.Router();

// Store io instance for socket notifications
let ioInstance: any = null;

// Singleton Razorpay service
let razorpayService: RazorpayService | null = null;

export function getRazorpayService(): RazorpayService {
    if (!razorpayService) {
        razorpayService = new RazorpayService();
    }
    return razorpayService;
}

export function setIOInstance(io: any): void {
    ioInstance = io;
}

// Parse raw body for webhook signature verification
router.use('/webhook', express.raw({ type: 'application/json' }));

// ==================== HELPER FUNCTIONS ====================

/**
 * Helper to check if notes object has valid organizationId
 */
function hasValidOrgId(notes: any): notes is Record<string, string> & { organizationId: string } {
    return notes && 
           typeof notes === 'object' && 
           !Array.isArray(notes) && 
           Object.keys(notes).length > 0 &&
           typeof notes.organizationId === 'string' &&
           notes.organizationId.length > 0;
}

/**
 * Find organization by Razorpay subscription ID in database
 */
async function findOrganizationByRazorpaySubscription(subscriptionId: string): Promise<IOrganization | null> {
    try {
        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return null;

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        return await organizationRepository.findOne({
            'metadata.razorpay.subscriptionId': subscriptionId
        });
    } catch (error: any) {
        webhookLogger.error('Error finding organization by subscription:', error);
        return null;
    }
}

/**
 * Get subscription ID from invoice via Razorpay API
 */
async function getSubscriptionIdFromInvoice(invoiceId: string): Promise<string | null> {
    try {
        const razorpay = getRazorpayService();
        const result = await razorpay.getInvoiceDetails(invoiceId);
        
        if (result.success && result.invoice?.subscription_id) {
            webhookLogger.info(`Got subscription ID ${result.invoice.subscription_id} from invoice ${invoiceId}`);
            return result.invoice.subscription_id;
        }
        return null;
    } catch (error: any) {
        webhookLogger.error(`Error getting subscription from invoice ${invoiceId}:`, error);
        return null;
    }
}

/**
 * Get organization info from subscription via Razorpay API
 * This fetches the subscription from Razorpay to get the notes
 */
async function getOrgInfoFromSubscriptionAPI(subscriptionId: string): Promise<{ organizationId: string; organizationName?: string; planId?: string } | null> {
    try {
        const razorpay = getRazorpayService();
        const result = await razorpay.getSubscriptionDetails(subscriptionId);
        
        if (result.success && result.subscription) {
            const notes = result.subscription.notes;
            webhookLogger.info(`Subscription ${subscriptionId} notes from API:`, JSON.stringify(notes));
            
            if (hasValidOrgId(notes)) {
                return {
                    organizationId: notes.organizationId,
                    organizationName: notes.organizationName,
                    planId: notes.planId
                };
            }
        }
        return null;
    } catch (error: any) {
        webhookLogger.error(`Error getting org info from subscription API ${subscriptionId}:`, error);
        return null;
    }
}

/**
 * MAIN ORGANIZATION LOOKUP FROM WEBHOOK EVENT
 * This is the primary function to get organization info from any webhook event.
 * It intelligently extracts org info based on what's available in the webhook.
 * 
 * Priority order:
 * 1. subscription.notes from webhook payload (most reliable for subscription events)
 * 2. In-memory subscription mapping
 * 3. payment.notes from webhook payload
 * 4. Invoice -> Subscription -> Notes lookup via API
 * 5. Order mapping (for credit purchases)
 * 6. Razorpay API fetch for subscription notes
 * 7. Database lookup by subscriptionId
 */
async function getOrganizationFromWebhook(
    event: RazorpayWebhookEvent
): Promise<{ organizationId: string; organizationName?: string; planId?: string; subscriptionId?: string; socket?: any } | null> {
    const razorpay = getRazorpayService();
    const subscription = event.payload.subscription?.entity;
    const payment = event.payload.payment?.entity;
    const order = event.payload.order?.entity;
    
    webhookLogger.info(`Looking up organization for event: ${event.event}`);
    webhookLogger.info(`Event contains: ${event.contains?.join(', ') || 'unknown'}`);
    
    // 1. BEST SOURCE: subscription.notes from webhook payload
    // When Razorpay sends subscription events, the subscription entity includes notes
    // which we set when creating the subscription (organizationId, planId, etc.)
    if (subscription) {
        webhookLogger.info(`Subscription entity found: ${subscription.id}`);
        webhookLogger.info(`Subscription notes raw:`, JSON.stringify(subscription.notes));
        
        if (hasValidOrgId(subscription.notes)) {
            webhookLogger.info(`SUCCESS: Found organizationId in subscription.notes: ${subscription.notes.organizationId}`);
            
            // Also check for socket from in-memory mapping
            const mapping = razorpay.getSubscriptionMapping(subscription.id);
            
            return {
                organizationId: subscription.notes.organizationId,
                organizationName: subscription.notes.organizationName,
                planId: subscription.notes.planId || subscription.plan_id,
                subscriptionId: subscription.id,
                socket: mapping?.socket
            };
        }
        
        // 2. Try in-memory mapping for this subscription
        const mapping = razorpay.getSubscriptionMapping(subscription.id);
        if (mapping) {
            webhookLogger.info(`SUCCESS: Found in-memory mapping for subscription: ${subscription.id}`);
            return {
                organizationId: mapping.organizationId,
                organizationName: mapping.organizationName,
                subscriptionId: subscription.id,
                socket: mapping.socket
            };
        }
        
        // 3. Try Razorpay API to fetch subscription with notes
        const apiResult = await getOrgInfoFromSubscriptionAPI(subscription.id);
        if (apiResult) {
            webhookLogger.info(`SUCCESS: Found org info via API for subscription: ${subscription.id}`);
            return {
                ...apiResult,
                subscriptionId: subscription.id
            };
        }
        
        // 4. Try database lookup
        const org = await findOrganizationByRazorpaySubscription(subscription.id);
        if (org) {
            webhookLogger.info(`SUCCESS: Found organization in database for subscription: ${subscription.id}`);
            return {
                organizationId: org.OrganizationId,
                organizationName: org.OrganizationName,
                subscriptionId: subscription.id
            };
        }
    }
    
    // 5. Check payment entity if no subscription or subscription lookup failed
    if (payment) {
        webhookLogger.info(`Payment entity found: ${payment.id}`);
        webhookLogger.info(`Payment notes raw:`, JSON.stringify(payment.notes));
        webhookLogger.info(`Payment invoice_id: ${payment.invoice_id}, order_id: ${payment.order_id}`);
        
        // 5a. Check payment.notes
        if (hasValidOrgId(payment.notes)) {
            webhookLogger.info(`SUCCESS: Found organizationId in payment.notes: ${payment.notes.organizationId}`);
            return {
                organizationId: payment.notes.organizationId,
                organizationName: payment.notes.organizationName,
                subscriptionId: payment.notes.subscriptionId,
                planId: payment.notes.planId
            };
        }
        
        // 5b. If payment has invoice_id, trace to subscription
        if (payment.invoice_id) {
            webhookLogger.info(`Payment has invoice_id: ${payment.invoice_id}, fetching subscription...`);
            const subscriptionId = await getSubscriptionIdFromInvoice(payment.invoice_id);
            
            if (subscriptionId) {
                webhookLogger.info(`Got subscriptionId ${subscriptionId} from invoice`);
                
                // Try in-memory mapping
                const mapping = razorpay.getSubscriptionMapping(subscriptionId);
                if (mapping) {
                    webhookLogger.info(`SUCCESS: Found in-memory mapping via invoice->subscription`);
                    return {
                        organizationId: mapping.organizationId,
                        organizationName: mapping.organizationName,
                        subscriptionId: subscriptionId,
                        socket: mapping.socket
                    };
                }
                
                // Try API
                const apiResult = await getOrgInfoFromSubscriptionAPI(subscriptionId);
                if (apiResult) {
                    webhookLogger.info(`SUCCESS: Found org info via API (invoice->subscription)`);
                    return {
                        ...apiResult,
                        subscriptionId
                    };
                }
                
                // Try database
                const org = await findOrganizationByRazorpaySubscription(subscriptionId);
                if (org) {
                    webhookLogger.info(`SUCCESS: Found organization in database via invoice->subscription`);
                    return {
                        organizationId: org.OrganizationId,
                        organizationName: org.OrganizationName,
                        subscriptionId
                    };
                }
            }
        }
        
        // 5c. If payment has order_id, check order mapping (for credit purchases)
        if (payment.order_id) {
            const orderMapping = razorpay.getOrderMapping(payment.order_id);
            if (orderMapping) {
                webhookLogger.info(`SUCCESS: Found order mapping for order: ${payment.order_id}`);
                return {
                    organizationId: orderMapping.organizationId,
                    organizationName: orderMapping.organizationName,
                    socket: orderMapping.socket
                };
            }
        }
    }
    
    // 6. Check order entity (for order.paid events)
    if (order) {
        webhookLogger.info(`Order entity found: ${order.id}`);
        webhookLogger.info(`Order notes raw:`, JSON.stringify(order.notes));
        
        // Check order.notes
        if (hasValidOrgId(order.notes)) {
            webhookLogger.info(`SUCCESS: Found organizationId in order.notes: ${order.notes.organizationId}`);
            return {
                organizationId: order.notes.organizationId,
                organizationName: order.notes.organizationName
            };
        }
        
        // Check order mapping
        const orderMapping = razorpay.getOrderMapping(order.id);
        if (orderMapping) {
            webhookLogger.info(`SUCCESS: Found order mapping for order: ${order.id}`);
            return {
                organizationId: orderMapping.organizationId,
                organizationName: orderMapping.organizationName,
                socket: orderMapping.socket
            };
        }
    }
    
    webhookLogger.warn(`FAILED: Could not find organization for event: ${event.event}`);
    return null;
}

/**
 * Get organization ID from subscription - comprehensive lookup
 * Used when we already have a subscriptionId but need org info
 */
async function getOrganizationIdFromSubscription(
    subscriptionId: string, 
    notes?: Record<string, string>
): Promise<{ organizationId: string; organizationName?: string; planId?: string; socket?: any } | null> {
    const razorpay = getRazorpayService();
    
    // 1. Try notes from webhook payload (if provided and valid)
    if (hasValidOrgId(notes)) {
        webhookLogger.info(`Using organizationId from provided notes: ${notes.organizationId}`);
        const mapping = razorpay.getSubscriptionMapping(subscriptionId);
        return {
            organizationId: notes.organizationId,
            organizationName: notes.organizationName,
            planId: notes.planId,
            socket: mapping?.socket
        };
    }
    
    // 2. Try in-memory mapping
    const mapping = razorpay.getSubscriptionMapping(subscriptionId);
    if (mapping) {
        webhookLogger.info(`Found in-memory mapping for subscription: ${subscriptionId}`);
        return {
            organizationId: mapping.organizationId,
            organizationName: mapping.organizationName,
            socket: mapping.socket
        };
    }
    
    // 3. Try Razorpay API
    const apiResult = await getOrgInfoFromSubscriptionAPI(subscriptionId);
    if (apiResult) {
        webhookLogger.info(`Found org info via Razorpay API for subscription: ${subscriptionId}`);
        return apiResult;
    }
    
    // 4. Try database lookup
    const org = await findOrganizationByRazorpaySubscription(subscriptionId);
    if (org) {
        webhookLogger.info(`Found organization by subscription ID in database: ${org.OrganizationId}`);
        return {
            organizationId: org.OrganizationId,
            organizationName: org.OrganizationName
        };
    }
    
    webhookLogger.warn(`Could not find organization for subscription: ${subscriptionId}`);
    return null;
}

/**
 * Record subscription info for tracking
 */
async function recordSubscriptionInfo(data: {
    payerEmail: string;
    planId: string;
    subscriptionId: string;
    organizationId: string;
    organizationName?: string;
    provider: 'razorpay' | 'paypal';
    usageType: 'free_trial' | 'subscription' | 'credit_purchase';
}): Promise<boolean> {
    try {
        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const userCredentialsDb = process.env.USER_CREDENTIAL_DB;
        if (!userCredentialsDb) return false;

        await databaseService.ensureDatabase(userCredentialsDb);
        await databaseService.ensureCollection<ISubscriptionInfo>(userCredentialsDb, CollectionNames.SUBSCRIPTION_INFO);

        const subscriptionInfoRepo = databaseService.getRepository<ISubscriptionInfo>(userCredentialsDb, CollectionNames.SUBSCRIPTION_INFO);

        const record: Partial<ISubscriptionInfo> = {
            payerEmail: data.payerEmail?.toLowerCase() || '',
            planId: data.planId,
            subscriptionId: data.subscriptionId,
            organizationId: data.organizationId,
            organizationName: data.organizationName,
            activatedAt: new Date(),
            usageType: data.usageType,
            isActive: true,
            provider: data.provider
        };

        await subscriptionInfoRepo.insertOne(record as ISubscriptionInfo);
        return true;
    } catch (error: any) {
        webhookLogger.error('Error recording subscription info:', error);
        return false;
    }
}

// ==================== WEBHOOK HANDLERS ====================

/**
 * Handle subscription activated webhook
 * Called when a subscription becomes active after payment
 */
async function handleSubscriptionActivated(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) {
            webhookLogger.error('No subscription in activated event');
            return;
        }

        webhookLogger.info(`Processing subscription.activated for: ${subscription.id}`);
        
        // Use the main webhook lookup function which prioritizes subscription.notes
        const orgInfo = await getOrganizationFromWebhook(event);

        if (!orgInfo) {
            webhookLogger.error(`No org info found for subscription: ${subscription.id}. Cannot activate subscription.`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            webhookLogger.error('ORGANIZATION_DB not configured');
            return;
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        // Get plan details from notes or orgInfo
        const planId = subscription.notes?.planId || orgInfo.planId || subscription.plan_id;

        // Get existing organization to preserve creditTransactions
        const existingOrg = await organizationRepository.findOne({ OrganizationId: orgInfo.organizationId });
        const existingCreditTransactions = existingOrg?.metadata?.razorpay?.creditTransactions || [];

        // Update organization with active subscription (preserve creditTransactions)
        // NOTE: We explicitly preserve creditTransactions to not lose purchase history
        // NOTE: We use $unset only to remove paypal metadata (cannot use both $set and $unset on same field)
        const updateResult = await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.subscriptionId': subscription.id,
                    'metadata.razorpay.status': 'ACTIVE',
                    'metadata.razorpay.planId': planId,
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.activatedAt': new Date(),
                    'metadata.razorpay.currentStart': subscription.current_start ? new Date(subscription.current_start * 1000) : null,
                    'metadata.razorpay.currentEnd': subscription.current_end ? new Date(subscription.current_end * 1000) : null,
                    'metadata.razorpay.creditTransactions': existingCreditTransactions
                },
                $unset: {
                    'metadata.paypal': 1
                }
            }
        );

        webhookLogger.info(`Subscription activated for org ${orgInfo.organizationId}, matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount}`);

        // Notify client via socket if available
        if (orgInfo.socket && orgInfo.socket.connected) {
            orgInfo.socket.emit('razorpay:subscription_activated', {
                success: true,
                subscriptionId: subscription.id,
                status: 'ACTIVE',
                planId: planId
            });
        }

        // Record subscription info for tracking
        await recordSubscriptionInfo({
            payerEmail: subscription.notes?.email || '',
            planId: planId,
            subscriptionId: subscription.id,
            organizationId: orgInfo.organizationId,
            organizationName: orgInfo.organizationName,
            provider: 'razorpay',
            usageType: 'subscription'
        });

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.activated:', error);
    }
}

/**
 * Handle subscription charged webhook
 * Called when a recurring payment is successful
 */
async function handleSubscriptionCharged(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        const payment = event.payload.payment?.entity;

        if (!subscription) {
            webhookLogger.error('No subscription in charged event');
            return;
        }

        webhookLogger.info(`Processing subscription.charged for: ${subscription.id}`);

        // Use the main webhook lookup function
        const orgInfo = await getOrganizationFromWebhook(event);

        if (!orgInfo) {
            webhookLogger.warn(`No org info found for charged subscription: ${subscription.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        // Update subscription with new billing cycle info
        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'ACTIVE',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.currentStart': subscription.current_start ? new Date(subscription.current_start * 1000) : null,
                    'metadata.razorpay.currentEnd': subscription.current_end ? new Date(subscription.current_end * 1000) : null,
                    'metadata.razorpay.lastPayment': payment ? {
                        paymentId: payment.id,
                        amount: payment.amount,
                        currency: payment.currency,
                        paidAt: new Date(payment.created_at * 1000)
                    } : null
                }
            }
        );

        webhookLogger.info(`Subscription charged updated for org ${orgInfo.organizationId}`);

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.charged:', error);
    }
}

/**
 * Handle subscription cancelled webhook
 */
async function handleSubscriptionCancelled(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.cancelled for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) {
            webhookLogger.warn(`No org info found for cancelled subscription: ${subscription.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'CANCELLED',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.cancelledAt': new Date()
                }
            }
        );

        webhookLogger.info(`Subscription cancelled for org ${orgInfo.organizationId}`);

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.cancelled:', error);
    }
}

/**
 * Handle subscription halted webhook (payment failures)
 */
async function handleSubscriptionHalted(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.halted for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) return;

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'HALTED',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.haltedAt': new Date()
                }
            }
        );

        webhookLogger.info(`Subscription halted for org ${orgInfo.organizationId}`);

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.halted:', error);
    }
}

/**
 * Handle subscription paused webhook
 */
async function handleSubscriptionPaused(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.paused for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) return;

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'PAUSED',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.pausedAt': new Date()
                }
            }
        );

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.paused:', error);
    }
}

/**
 * Handle subscription resumed webhook
 */
async function handleSubscriptionResumed(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.resumed for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) return;

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'ACTIVE',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.resumedAt': new Date()
                }
            }
        );

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.resumed:', error);
    }
}

/**
 * Handle order.paid webhook (for one-time credit purchases)
 */
async function handleOrderPaid(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const order = event.payload.order?.entity;
        const payment = event.payload.payment?.entity;

        if (!order) {
            webhookLogger.error('No order in order.paid event');
            return;
        }

        webhookLogger.info(`Processing order.paid for: ${order.id}`);
        webhookLogger.info(`Order notes:`, JSON.stringify(order.notes));

        const razorpay = getRazorpayService();
        let mapping = razorpay.getOrderMapping(order.id);

        // If no in-memory mapping, try to get from order notes
        if (!mapping) {
            const orderNotes = order.notes;
            if (orderNotes && typeof orderNotes === 'object' && !Array.isArray(orderNotes) && orderNotes.organizationId) {
                webhookLogger.info(`Using organizationId from order notes: ${orderNotes.organizationId}`);
                const credits = parseInt(orderNotes.credits || '0', 10);
                
                if (credits > 0) {
                    const databaseService = DatabaseService.getInstance();
                    if (!databaseService.isConnected()) {
                        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                    }

                    const orgDbName = process.env.ORGANIZATION_DB;
                    if (!orgDbName) return;

                    const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

                    const org = await organizationRepository.findOne({ OrganizationId: orderNotes.organizationId });
                    if (!org) {
                        webhookLogger.error(`Organization not found: ${orderNotes.organizationId}`);
                        return;
                    }

                    const currentCredits = org.metadata?.credits || 0;
                    const newCredits = currentCredits + credits;

                    const creditTransaction = {
                        id: order.receipt || order.id,
                        orderId: order.id,
                        paymentId: payment?.id,
                        credits: credits,
                        amount: { value: (order.amount / 100).toString(), currencyCode: order.currency },
                        status: 'completed',
                        purchasedAt: new Date()
                    };

                    await organizationRepository.updateOne(
                        { OrganizationId: orderNotes.organizationId },
                        {
                            $set: {
                                'metadata.credits': newCredits
                            },
                            $push: {
                                'metadata.razorpay.creditTransactions': creditTransaction
                            } as any
                        }
                    );

                    webhookLogger.info(`Credits added for org ${orderNotes.organizationId}: ${credits} (total: ${newCredits})`);
                    return;
                }
            }
            
            webhookLogger.warn(`No mapping found for order: ${order.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const org = await organizationRepository.findOne({ OrganizationId: mapping.organizationId });
        if (!org) {
            webhookLogger.error(`Organization not found: ${mapping.organizationId}`);
            return;
        }

        const currentCredits = org.metadata?.credits || 0;
        const newCredits = currentCredits + mapping.credits;

        const creditTransaction = {
            id: mapping.id,
            orderId: order.id,
            paymentId: payment?.id,
            credits: mapping.credits,
            amount: mapping.amount,
            status: 'completed',
            purchasedAt: new Date()
        };

        await organizationRepository.updateOne(
            { OrganizationId: mapping.organizationId },
            {
                $set: {
                    'metadata.credits': newCredits
                },
                $push: {
                    'metadata.razorpay.creditTransactions': creditTransaction
                } as any
            }
        );

        webhookLogger.info(`Credits added for org ${mapping.organizationId}: ${mapping.credits} (total: ${newCredits})`);

        razorpay.updateOrderWebhookState(order.id, 'paymentCaptured', {
            timestamp: new Date(),
            paymentId: payment?.id
        });

        if (mapping.socket && mapping.socket.connected) {
            mapping.socket.emit('razorpay:credits_added', {
                success: true,
                orderId: order.id,
                credits: mapping.credits,
                totalCredits: newCredits
            });
        }

    } catch (error: any) {
        webhookLogger.error('Error handling order.paid:', error);
    }
}

/**
 * Handle payment.failed webhook
 */
async function handlePaymentFailed(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const payment = event.payload.payment?.entity;
        if (!payment) return;

        webhookLogger.info(`Processing payment.failed for: ${payment.id}`);

        // Use the main webhook lookup function
        const orgInfo = await getOrganizationFromWebhook(event);
        
        if (orgInfo) {
            webhookLogger.info(`Payment failed for org ${orgInfo.organizationId}`);
            
            if (orgInfo.socket && orgInfo.socket.connected) {
                orgInfo.socket.emit('razorpay:payment_failed', {
                    success: false,
                    paymentId: payment.id,
                    error: payment.error_description || 'Payment failed'
                });
            }
        }

        // Also check order mapping for credit purchases
        if (payment.order_id) {
            const razorpay = getRazorpayService();
            const mapping = razorpay.getOrderMapping(payment.order_id);

            if (mapping) {
                razorpay.updateOrderWebhookState(payment.order_id, 'paymentFailed', {
                    timestamp: new Date(),
                    reason: payment.error_description || 'Payment failed'
                });

                if (mapping.socket && mapping.socket.connected) {
                    mapping.socket.emit('razorpay:payment_failed', {
                        success: false,
                        orderId: payment.order_id,
                        error: payment.error_description || 'Payment failed'
                    });
                }
            }
        }

    } catch (error: any) {
        webhookLogger.error('Error handling payment.failed:', error);
    }
}

/**
 * Handle payment.authorized webhook
 * Called when a payment is authorized (first event for subscription payments)
 */
async function handlePaymentAuthorized(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const payment = event.payload.payment?.entity;
        if (!payment) {
            webhookLogger.error('No payment in payment.authorized event');
            return;
        }

        webhookLogger.info(`Processing payment.authorized for payment: ${payment.id}`);
        webhookLogger.info(`Event contains: ${event.contains?.join(', ') || 'unknown'}`);

        // Use the main webhook lookup function which handles all cases
        const orgInfo = await getOrganizationFromWebhook(event);
        
        if (orgInfo) {
            webhookLogger.info(`Payment authorized for org: ${orgInfo.organizationId}`);
            
            if (orgInfo.socket && orgInfo.socket.connected) {
                orgInfo.socket.emit('razorpay:payment_authorized', {
                    success: true,
                    paymentId: payment.id,
                    subscriptionId: orgInfo.subscriptionId,
                    status: 'PAYMENT_AUTHORIZED',
                    message: 'Payment authorized, waiting for subscription activation'
                });
            }
        } else {
            // For payment.authorized, it's OK if we can't find org immediately
            // The subscription.activated webhook will follow with org info
            webhookLogger.info(`Payment authorized but org not found yet. Payment: ${payment.id}. Will be processed with subscription webhook.`);
        }

        webhookLogger.info(`Payment authorized: ${payment.id}, amount: ${payment.amount}, method: ${payment.method}`);

    } catch (error: any) {
        webhookLogger.error('Error handling payment.authorized:', error);
    }
}

/**
 * Handle payment.captured webhook
 * Called when a payment is captured
 */
async function handlePaymentCaptured(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const payment = event.payload.payment?.entity;
        if (!payment) {
            webhookLogger.error('No payment in payment.captured event');
            return;
        }

        webhookLogger.info(`Processing payment.captured for payment: ${payment.id}, amount: ${payment.amount}`);
        webhookLogger.info(`Event contains: ${event.contains?.join(', ') || 'unknown'}`);

        // Use the main webhook lookup function
        const orgInfo = await getOrganizationFromWebhook(event);
        
        if (orgInfo) {
            webhookLogger.info(`Payment captured for org: ${orgInfo.organizationId}, subscriptionId: ${orgInfo.subscriptionId}`);
        } else {
            // For payment.captured, it's OK if we can't find org
            // The subscription webhook with org info may have already been processed or will follow
            webhookLogger.info(`Payment captured but org not found. Payment: ${payment.id}`);
        }

    } catch (error: any) {
        webhookLogger.error('Error handling payment.captured:', error);
    }
}

/**
 * Handle subscription.authenticated webhook
 * Called when a subscription is authenticated (before activation)
 */
async function handleSubscriptionAuthenticated(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) {
            webhookLogger.error('No subscription in subscription.authenticated event');
            return;
        }

        webhookLogger.info(`Processing subscription.authenticated for: ${subscription.id}`);

        // Use the main webhook lookup function
        const orgInfo = await getOrganizationFromWebhook(event);

        if (!orgInfo) {
            webhookLogger.warn(`No org info found for authenticated subscription: ${subscription.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            webhookLogger.error('ORGANIZATION_DB not configured');
            return;
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const planId = subscription.notes?.planId || orgInfo.planId || subscription.plan_id;

        // Get existing organization to preserve creditTransactions
        const existingOrg = await organizationRepository.findOne({ OrganizationId: orgInfo.organizationId });
        const existingCreditTransactions = existingOrg?.metadata?.razorpay?.creditTransactions || [];

        // Update organization with authenticated (pending) subscription status (preserve creditTransactions)
        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.subscriptionId': subscription.id,
                    'metadata.razorpay.status': 'AUTHENTICATED',
                    'metadata.razorpay.planId': planId,
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.authenticatedAt': new Date(),
                    'metadata.razorpay.creditTransactions': existingCreditTransactions
                }
            }
        );

        webhookLogger.info(`Subscription authenticated for org ${orgInfo.organizationId}, waiting for activation`);

        if (orgInfo.socket && orgInfo.socket.connected) {
            orgInfo.socket.emit('razorpay:subscription_authenticated', {
                success: true,
                subscriptionId: subscription.id,
                status: 'AUTHENTICATED',
                planId: planId,
                message: 'Subscription authenticated, waiting for first payment'
            });
        }

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.authenticated:', error);
    }
}

/**
 * Handle invoice.paid webhook
 * Called when an invoice is paid (for subscriptions)
 */
async function handleInvoicePaid(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const invoice = event.payload.invoice?.entity;
        if (!invoice) {
            webhookLogger.error('No invoice in invoice.paid event');
            return;
        }

        const invoiceData = invoice as any;
        webhookLogger.info(`Processing invoice.paid for invoice: ${invoiceData.id}`);

        const subscriptionId = invoiceData.subscription_id;
        if (subscriptionId) {
            webhookLogger.info(`Invoice paid for subscription: ${subscriptionId}, amount: ${invoiceData.amount}`);
            
            // Use the main webhook lookup or fallback to subscription lookup
            const orgInfo = await getOrganizationFromWebhook(event) || await getOrganizationIdFromSubscription(subscriptionId);
            if (orgInfo) {
                webhookLogger.info(`Invoice paid for org: ${orgInfo.organizationId}`);
            }
        }

    } catch (error: any) {
        webhookLogger.error('Error handling invoice.paid:', error);
    }
}

// ==================== REGISTER WEBHOOK HANDLERS ====================

/**
 * Handle subscription.pending webhook
 * Called when a subscription payment is pending
 */
async function handleSubscriptionPending(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.pending for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) {
            webhookLogger.warn(`No org info found for pending subscription: ${subscription.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'PENDING',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.pendingAt': new Date()
                }
            }
        );

        webhookLogger.info(`Subscription pending for org ${orgInfo.organizationId}`);

        if (orgInfo.socket && orgInfo.socket.connected) {
            orgInfo.socket.emit('razorpay:subscription_pending', {
                success: true,
                subscriptionId: subscription.id,
                status: 'PENDING',
                message: 'Subscription payment is pending'
            });
        }

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.pending:', error);
    }
}

/**
 * Handle subscription.completed webhook
 * Called when a subscription completes all billing cycles
 */
async function handleSubscriptionCompleted(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.completed for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) {
            webhookLogger.warn(`No org info found for completed subscription: ${subscription.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.status': 'COMPLETED',
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.completedAt': new Date()
                }
            }
        );

        webhookLogger.info(`Subscription completed for org ${orgInfo.organizationId}`);

        if (orgInfo.socket && orgInfo.socket.connected) {
            orgInfo.socket.emit('razorpay:subscription_completed', {
                success: true,
                subscriptionId: subscription.id,
                status: 'COMPLETED',
                message: 'Subscription has completed all billing cycles'
            });
        }

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.completed:', error);
    }
}

/**
 * Handle subscription.updated webhook
 * Called when a subscription is updated
 */
async function handleSubscriptionUpdated(event: RazorpayWebhookEvent): Promise<void> {
    try {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return;

        webhookLogger.info(`Processing subscription.updated for: ${subscription.id}`);

        const orgInfo = await getOrganizationFromWebhook(event);
        if (!orgInfo) {
            webhookLogger.warn(`No org info found for updated subscription: ${subscription.id}`);
            return;
        }

        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) return;

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        // Update subscription data while preserving status
        await organizationRepository.updateOne(
            { OrganizationId: orgInfo.organizationId },
            {
                $set: {
                    'metadata.razorpay.subscription': subscription,
                    'metadata.razorpay.planId': subscription.plan_id,
                    'metadata.razorpay.currentStart': subscription.current_start ? new Date(subscription.current_start * 1000) : null,
                    'metadata.razorpay.currentEnd': subscription.current_end ? new Date(subscription.current_end * 1000) : null,
                    'metadata.razorpay.updatedAt': new Date()
                }
            }
        );

        webhookLogger.info(`Subscription updated for org ${orgInfo.organizationId}`);

        if (orgInfo.socket && orgInfo.socket.connected) {
            orgInfo.socket.emit('razorpay:subscription_updated', {
                success: true,
                subscriptionId: subscription.id,
                message: 'Subscription has been updated'
            });
        }

    } catch (error: any) {
        webhookLogger.error('Error handling subscription.updated:', error);
    }
}


razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_AUTHENTICATED, handleSubscriptionAuthenticated);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_ACTIVATED, handleSubscriptionActivated);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_CHARGED, handleSubscriptionCharged);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_PENDING, handleSubscriptionPending);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_HALTED, handleSubscriptionHalted);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_PAUSED, handleSubscriptionPaused);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_RESUMED, handleSubscriptionResumed);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_CANCELLED, handleSubscriptionCancelled);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_COMPLETED, handleSubscriptionCompleted);
razorpayWebhookService.on(RazorpayWebhookEventType.SUBSCRIPTION_UPDATED, handleSubscriptionUpdated);
razorpayWebhookService.on(RazorpayWebhookEventType.ORDER_PAID, handleOrderPaid);
razorpayWebhookService.on(RazorpayWebhookEventType.PAYMENT_AUTHORIZED, handlePaymentAuthorized);
razorpayWebhookService.on(RazorpayWebhookEventType.PAYMENT_CAPTURED, handlePaymentCaptured);
razorpayWebhookService.on(RazorpayWebhookEventType.PAYMENT_FAILED, handlePaymentFailed);
razorpayWebhookService.on(RazorpayWebhookEventType.INVOICE_PAID, handleInvoicePaid);

// ==================== ROUTES ====================

/**
 * Webhook endpoint for Razorpay
 */
router.post('/webhook', async (req: Request, res: Response) => {
    try {
        webhookLogger.info('Received Razorpay webhook');

        const result = await razorpayWebhookService.handleWebhook(req, req.body);

        if (result.success) {
            res.status(200).json({ status: 'ok' });
        } else {
            webhookLogger.error('Webhook processing failed:', result.error);
            res.status(400).json({ error: result.error });
        }
    } catch (error: any) {
        webhookLogger.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get Razorpay key ID for client initialization
 */
router.get('/config', (req: Request, res: Response) => {
    const razorpay = getRazorpayService();
    res.json({
        keyId: razorpay.getKeyId()
    });
});

/**
 * Verify payment signature (called by client after payment)
 */
router.post('/verify-payment', express.json(), async (req: Request, res: Response): Promise<void> => {
    try {
        const { orderId, paymentId, signature, type } = req.body;

        if (!orderId || !paymentId || !signature) {
            res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
            return;
        }

        const razorpay = getRazorpayService();
        let isValid = false;

        if (type === 'subscription') {
            isValid = razorpay.verifySubscriptionPaymentSignature({
                subscriptionId: orderId,
                paymentId,
                signature
            });
        } else {
            isValid = razorpay.verifyPaymentSignature({
                orderId,
                paymentId,
                signature
            });
        }

        if (isValid) {
            res.json({ success: true, verified: true });
        } else {
            res.status(400).json({ success: false, error: 'Invalid signature' });
        }
    } catch (error: any) {
        routeLogger.error('Payment verification error:', error);
        res.status(500).json({ success: false, error: 'Verification failed' });
    }
});

export default router;
