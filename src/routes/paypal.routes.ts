import express, { Router, Request, Response } from "express";
import { paypalWebhookService, PayPalWebhookEventType, PayPalWebhookEvent } from '../Services/PayPalWebhookService';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IPlan } from '../DataAccessLayer/models/Plans';
import { getPayPalService } from '../Services/PayPalService';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { ISubscriptionInfo } from '../DataAccessLayer/models/SubscriptionInfo';
import { initializeOrganizationDatabase } from '../Services/AuthTokenService';
// Lazy import to avoid circular dependency
let ioInstance: any = null;

import { createLogger } from '../utils/Logger';
import * as dotenv from 'dotenv';
const webhookLogger = createLogger('PayPalWebhook');
const routeLogger = createLogger('PayPalRoutes');

dotenv.config();

const router: Router = express.Router();
import {PlanInfo} from '../model/Plans';


// Parse JSON body for webhook
router.use('/webhook', express.json());

const skipCancellationProcessing = new Set<string>();

//==============FREE TRIAL ABUSE PREVENTION HELPER FUNCTIONS==============

/**
 * Check if a subscription has a free trial by examining its billing info cycle executions
 * A subscription is considered a free trial if it has a cycle execution with tenureType 'TRIAL'
 * @param paypalSubscription - The PayPal subscription object from the API or webhook
 * @returns Object with isFreeTrial boolean and subscriptionDetails
 */
function isFreeTrialSubscription(paypalSubscription: any): { isFreeTrial: boolean; subscriptionDetails?: any } {
    try {
        if (!paypalSubscription) {
            routeLogger.info('No PayPal subscription object provided');
            return { isFreeTrial: false };
        }
        
        // Check billingInfo.cycleExecutions (from subscription object)
        const billingInfo = paypalSubscription.billingInfo || paypalSubscription.billing_info;
        if (!billingInfo) {
            routeLogger.info(`Subscription ${paypalSubscription.id || 'unknown'} has no billingInfo`);
            return { isFreeTrial: false };
        }
        
        const cycleExecutions = billingInfo.cycleExecutions || billingInfo.cycle_executions;
        if (!cycleExecutions || !Array.isArray(cycleExecutions)) {
            routeLogger.info(`Subscription ${paypalSubscription.id || 'unknown'} has no cycleExecutions`);
            return { isFreeTrial: false };
        }
        
        // Check if any cycle execution has tenureType 'TRIAL'
        // PayPal API returns tenureType as 'TRIAL' or 'REGULAR' in cycleExecutions
        const hasTrialCycle = cycleExecutions.some((cycle: any) => {
            const tenureType = cycle.tenureType || cycle.tenure_type;
            const tenureTypeUpper = String(tenureType).toUpperCase();
            
            // Log for debugging
            if (tenureType) {
                routeLogger.info(`Checking cycle execution: tenureType=${tenureType}, sequence=${cycle.sequence}, cyclesCompleted=${cycle.cyclesCompleted}`);
            }
            
            // Check for 'TRIAL' tenure type
            const isTrial = tenureType === 'TRIAL' || 
                           tenureType === 'Trial' || 
                           tenureType === 'trial' ||
                           tenureTypeUpper === 'TRIAL';
            
            return isTrial;
        });
        
        if (hasTrialCycle) {
            routeLogger.info(`Subscription ${paypalSubscription.id || 'unknown'} has a free trial cycle`);
        }
        
        return { 
            isFreeTrial: hasTrialCycle, 
            subscriptionDetails: paypalSubscription 
        };
    } catch (error: any) {
        routeLogger.error(`Error checking if subscription is free trial:`, error);
        return { isFreeTrial: false };
    }
}

/**
 * Check if a PayPal email has already used a free trial subscription
 * Queries the SUBSCRIPTION_INFO collection in UserCredentials database
 */
async function checkFreeTrialUsageByEmail(payerEmail: string): Promise<{ hasUsedTrial: boolean; existingRecord?: ISubscriptionInfo }> {
    try {
        if (!payerEmail) {
            routeLogger.warn('No payer email provided for free trial check');
            return { hasUsedTrial: false };
        }
        
        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }
        
        const userCredentialsDb = process.env.USER_CREDENTIAL_DB;
        if (!userCredentialsDb) {
            routeLogger.error('USER_CREDENTIALS_DB environment variable is not set');
            return { hasUsedTrial: false };
        }
        
        await databaseService.ensureDatabase(userCredentialsDb);
        await databaseService.ensureCollection<ISubscriptionInfo>(userCredentialsDb, CollectionNames.SUBSCRIPTION_INFO);
        
        const subscriptionInfoRepo = databaseService.getRepository<ISubscriptionInfo>(userCredentialsDb, CollectionNames.SUBSCRIPTION_INFO);
        
        // Find any record with this payer email that used a free trial
        const existingRecord = await subscriptionInfoRepo.findOne({
            payerEmail: payerEmail.toLowerCase(),
            usageType: 'free_trial'
        });
        
        if (existingRecord) {
            routeLogger.info(`Found existing free trial usage for email ${payerEmail}, subscription: ${existingRecord.subscriptionId}`);
            return { hasUsedTrial: true, existingRecord };
        }
        
        return { hasUsedTrial: false };
    } catch (error: any) {
        routeLogger.error(`Error checking free trial usage for email ${payerEmail}:`, error);
        return { hasUsedTrial: false };
    }
}

/**
 * Record free trial usage in the SUBSCRIPTION_INFO collection
 * This prevents the same PayPal email from using free trials again
 */
async function recordFreeTrialUsage(data: {
    payerEmail: string;
    payerId?: string;
    planId: string;
    planName?: string;
    subscriptionId: string;
    organizationId: string;
    organizationName?: string;
    webhookEventId?: string;
}): Promise<boolean> {
    try {
        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }
        
        const userCredentialsDb = process.env.USER_CREDENTIAL_DB;
        if (!userCredentialsDb) {
            routeLogger.error('USER_CREDENTIALS_DB environment variable is not set');
            return false;
        }
        
        await databaseService.ensureDatabase(userCredentialsDb);
        await databaseService.ensureCollection<ISubscriptionInfo>(userCredentialsDb, CollectionNames.SUBSCRIPTION_INFO);
        
        const subscriptionInfoRepo = databaseService.getRepository<ISubscriptionInfo>(userCredentialsDb, CollectionNames.SUBSCRIPTION_INFO);
        
        const record: Partial<ISubscriptionInfo> = {
            payerEmail: data.payerEmail.toLowerCase(),
            payerId: data.payerId,
            planId: data.planId,
            planName: data.planName,
            subscriptionId: data.subscriptionId,
            organizationId: data.organizationId,
            organizationName: data.organizationName,
            activatedAt: new Date(),
            usageType: 'free_trial',
            isActive: true,
            webhookEventId: data.webhookEventId
        };
        
        await subscriptionInfoRepo.insertOne(record as ISubscriptionInfo);
        
        routeLogger.info(`Recorded free trial usage for email ${data.payerEmail}, subscription: ${data.subscriptionId}`);
        return true;
    } catch (error: any) {
        routeLogger.error(`Error recording free trial usage:`, error);
        return false;
    }
}

//==============END FREE TRIAL ABUSE PREVENTION HELPER FUNCTIONS==============


//plans webhooks are for our purposes only these are the plans that we have decided and will contain the updats when we update using paypal dashboard
async function handlePlanWebhook(event: PayPalWebhookEvent, eventType: string): Promise<void> {
    try {
        webhookLogger.info(`Processing ${eventType} webhook event: ${event.id}`);

        const planResource = event.resource;

        if (!planResource || !planResource.id) {
            webhookLogger.error('Invalid plan resource in webhook event');
            return;
        }

        const databaseService = DatabaseService.getInstance();

        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            routeLogger.error('ORGANIZATION_DB environment variable is not set');
            return;
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IPlan>(orgDbName, CollectionNames.PLANS);

        const plansRepository = databaseService.getRepository<IPlan>(orgDbName, CollectionNames.PLANS);

        const existingPlan = await plansRepository.findOne({ planId: planResource.id });

        const planData: IPlan = {
            planId: planResource.id,
            productId: planResource.product_id,
            name: planResource.name,
            description: planResource.description,
            status: planResource.status,
            billingCycles: planResource.billing_cycles,
            paymentPreferences: planResource.payment_preferences,
            taxes: planResource.taxes,
            createTime: planResource.create_time,
            updateTime: planResource.update_time,
            links: planResource.links,
            active: planResource.status === 'ACTIVE' || planResource.status === 'CREATED',
            webhookEventId: event.id,
            webhookEventTime: event.create_time,
            paypalResource: planResource
        };

        if (existingPlan) {
            webhookLogger.info(`Plan ${planResource.id} already exists in database, updating from ${eventType}...`);

            await plansRepository.updateOne(
                { planId: planResource.id },
                { $set: planData }
            );

            webhookLogger.success(`Plan ${planResource.id} updated successfully from ${eventType}`);
        } else {
            webhookLogger.info(`Plan ${planResource.id} not found in database, creating from ${eventType}...`);
            await plansRepository.insertOne(planData);
            webhookLogger.success(`Plan ${planResource.id} created successfully in organization database from ${eventType}`);
        }
    } catch (error: any) {
        webhookLogger.error(`Error handling ${eventType} webhook:`, error);
        throw error; 
    }
}

async function handlePlanCreatedWebhook(event: PayPalWebhookEvent): Promise<void> {
    await handlePlanWebhook(event, 'BILLING.PLAN.CREATED');
}

async function handlePlanUpdatedWebhook(event: PayPalWebhookEvent): Promise<void> {
    await handlePlanWebhook(event, 'BILLING.PLAN.UPDATED');
}

async function handlePlanActivatedWebhook(event: PayPalWebhookEvent): Promise<void> {
    await handlePlanWebhook(event, 'BILLING.PLAN.ACTIVATED');
}
async function handlePlanDeactivatedWebhook(event: PayPalWebhookEvent): Promise<void> {
    await handlePlanWebhook(event, 'BILLING.PLAN.DEACTIVATED');
}

paypalWebhookService.on(PayPalWebhookEventType.BILLING_PLAN_CREATED, handlePlanCreatedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.BILLING_PLAN_UPDATED, handlePlanUpdatedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.BILLING_PLAN_ACTIVATED, handlePlanActivatedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.BILLING_PLAN_DEACTIVATED, handlePlanDeactivatedWebhook);

/**
 * Common function to refresh subscription data from PayPal and update organization metadata
 * This ensures all subscription webhook events have the latest subscription state
 */
async function refreshSubscriptionInOrganization(subscriptionId: string, event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info(`Refreshing subscription ${subscriptionId} data from PayPal...`);

        const paypalService = getPayPalService();
        let subscriptionResult = await paypalService.showSubscriptionDetails(subscriptionId, "*");

        if (!subscriptionResult.success || !subscriptionResult.subscription) {
            routeLogger.error(`Failed to fetch subscription details from PayPal for ${subscriptionId}`);
            return;
        }

        let subscriptionData = subscriptionResult.subscription;
        const hasSubscriberInfo = subscriptionData.subscriber && 
            subscriptionData.subscriber.email_address && 
            subscriptionData.subscriber.payer_id;

        if (!hasSubscriberInfo) {
            routeLogger.info(`Subscriber information missing for subscription ${subscriptionId}, fetching directly from PayPal API...`);
            try {
                const directApiResult = await paypalService.fetchSubscriptionDetailsDirect(subscriptionId);
                const directSubscriber = directApiResult?.subscriber as any;
          
                if (directSubscriber && (directSubscriber.email_address || directSubscriber.payer_id)) {
                    subscriptionData = {
                        ...subscriptionData,
                        subscriber: {
                            ...subscriptionData.subscriber,
                            ...(directSubscriber.email_address && { email_address: directSubscriber.email_address }),
                            ...(directSubscriber.payer_id && { payer_id: directSubscriber.payer_id })
                        }
                    };
                    routeLogger.info(`Successfully fetched subscriber information for subscription ${subscriptionId}`);
                }
            } catch (directApiError: any) {
                routeLogger.warn(`Failed to fetch subscriber information directly from API for ${subscriptionId}:`, directApiError.message);
            }
        }

        routeLogger.info(`Fetched latest subscription data for ${subscriptionId}, status: ${subscriptionData.status}`);

        // Get database service
        const databaseService = DatabaseService.getInstance();

        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            routeLogger.error('ORGANIZATION_DB environment variable is not set');
            return;
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        // Try to find organization by subscription mapping first (for newly created subscriptions)
        const subscriptionMapping = paypalService.getSubscriptionMapping(subscriptionId);
        let organization: IOrganization | null = null;

        if (subscriptionMapping) {
            organization = await organizationRepository.findOne({
                OrganizationId: subscriptionMapping.organizationId
            });
            if (organization) {
                routeLogger.info(`Found organization via subscription mapping: ${subscriptionMapping.organizationName}`);
            }
        }

        // If not found via mapping, search for organization with this subscriptionId in metadata
        if (!organization) {
            // Use MongoDB query to find organization by subscriptionId in metadata
            organization = await organizationRepository.findOne({
                'metadata.paypal.subscriptionId': subscriptionId
            } as any);

            if (organization) {
                routeLogger.info(`Found organization via metadata search: ${organization.OrganizationName}`);
            }
        }

        if (!organization) {
            routeLogger.warn(`Organization not found for subscription ${subscriptionId}. Subscription may have been created outside of this application.`);
            return;
        }

        const existingPaypalMetadata = organization.metadata?.paypal || {};
        
        const existingNextBillingTime = existingPaypalMetadata.subscription?.billingInfo?.nextBillingTime;
        
        const newNextBillingTime = subscriptionData.billingInfo?.nextBillingTime;
        
        const preservedNextBillingTime = newNextBillingTime || existingNextBillingTime;
        
        let billingInfo: any = subscriptionData.billingInfo;
        if (billingInfo) {
            if (!billingInfo.nextBillingTime && preservedNextBillingTime) {
                billingInfo = {
                    ...billingInfo,
                    nextBillingTime: preservedNextBillingTime
                };
                subscriptionData.billingInfo = billingInfo;
            }
        } else if (preservedNextBillingTime) {
            billingInfo = {
                nextBillingTime: preservedNextBillingTime
            };
            subscriptionData.billingInfo = billingInfo;
        }

        const paypalMetadata = {
            subscriptionId: subscriptionId,
            subscription: subscriptionData, 
            status: subscriptionData.status,
            planId: subscriptionData.plan_id || subscriptionData.planId,
            startTime: subscriptionData.start_time || subscriptionData.startTime,
            createTime: subscriptionData.create_time || subscriptionData.createTime,
            updateTime: subscriptionData.update_time || subscriptionData.updateTime,
            links: subscriptionData.links,
            subscriber: subscriptionData.subscriber,
            billingInfo: billingInfo,
            webhookEventId: event.id,
            webhookEventTime: event.create_time,
            lastUpdatedAt: new Date()
        };

        // Update organization metadata with refreshed PayPal subscription info
        // Merge with existing paypal metadata to preserve any other fields
        const currentMetadata = organization.metadata || {};
        const updatedMetadata = {
            ...currentMetadata,
            paypal: {
                ...existingPaypalMetadata,
                ...paypalMetadata
            }
        };

        await organizationRepository.updateOne(
            { OrganizationId: organization.OrganizationId },
            { $set: { metadata: updatedMetadata } }
        );

        routeLogger.info(`Updated organization ${organization.OrganizationName} (${organization.OrganizationId}) with refreshed PayPal subscription ${subscriptionId} metadata. Status: ${subscriptionData.status}`);

    } catch (error: any) {
        routeLogger.error(`Error refreshing subscription ${subscriptionId} in organization:`, error);
        throw error;
    }
}

/**
 * Handler for BILLING.SUBSCRIPTION.ACTIVATED event
 * Updates organization metadata with PayPal subscription information and notifies client
 */
//this is the actual function that will handle when users susbcribes to the susbcription
async function handleSubscriptionActivatedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing BILLING.SUBSCRIPTION.ACTIVATED webhook event:', event.id);

        const subscriptionResource = event.resource;

        if (!subscriptionResource || !subscriptionResource.id) {
            routeLogger.error('Invalid subscription resource in webhook event');
            return;
        }

        const subscriptionId = subscriptionResource.id;
        const planId = subscriptionResource.plan_id;

        // Get PayPalService singleton instance to access subscription mapping
        const paypalService = getPayPalService();
        const subscriptionMapping = paypalService.getSubscriptionMapping(subscriptionId);

        //==============FREE TRIAL ABUSE PREVENTION CHECK==============
        // Check if this subscription has a free trial and if the payer email has already used a free trial
        // Use subscription data from webhook event or fetch it if not available
        let subscriptionData = subscriptionResource;
        
        // If webhook resource doesn't have full subscription details, fetch it
        if (!subscriptionResource.billingInfo && !subscriptionResource.billing_info) {
            const subscriptionResult = await paypalService.showSubscriptionDetails(subscriptionId, "*");
            if (subscriptionResult.success && subscriptionResult.subscription) {
                subscriptionData = subscriptionResult.subscription;
            }
        }
        
        // Check if subscription has a free trial using billingInfo.cycleExecutions
        const { isFreeTrial, subscriptionDetails } = isFreeTrialSubscription(subscriptionData);
        
        if (isFreeTrial) {
            routeLogger.info(`Subscription ${subscriptionId} has a free trial. Checking for abuse...`);
            
            let payerEmail: string | undefined;
            let payerId: string | undefined;
            
            // Get payer email from subscription data
            const subscriber = subscriptionDetails?.subscriber || subscriptionData?.subscriber;
            if (subscriber) {
                payerEmail = subscriber.email_address || subscriber.emailAddress;
                payerId = subscriber.payer_id || subscriber.payerId;
            }
            
            // If still no email, try fetching subscription details directly
            if (!payerEmail) {
                try {
                    const directApiResult = await paypalService.fetchSubscriptionDetailsDirect(subscriptionId);
                    const directSubscriber = directApiResult?.subscriber as any;
                    if (directSubscriber) {
                        payerEmail = directSubscriber.email_address || directSubscriber.emailAddress;
                        payerId = directSubscriber.payer_id || directSubscriber.payerId;
                    }
                } catch (directApiError: any) {
                    routeLogger.warn(`Failed to fetch subscriber info directly for ${subscriptionId}:`, directApiError.message);
                }
            }
            
            if (payerEmail) {
                routeLogger.info(`Checking free trial usage for PayPal email: ${payerEmail}`);
                        const { hasUsedTrial, existingRecord } = await checkFreeTrialUsageByEmail(payerEmail);
                        
                        if (hasUsedTrial && existingRecord) {
                            routeLogger.warn(`FREE TRIAL ABUSE DETECTED: Email ${payerEmail} has already used a free trial.`);
                            routeLogger.warn(`Previous trial subscription: ${existingRecord.subscriptionId}, Organization: ${existingRecord.organizationName}`);
                            
                            const cancelResult = await paypalService.cancelSubscription(
                                subscriptionId,
                                'Free trial already used by this PayPal account. Only one free trial per PayPal email is allowed.'
                            );
                            
                            if (cancelResult.success) {
                                routeLogger.info(`Successfully cancelled abusive free trial subscription ${subscriptionId}`);
                                skipCancellationProcessing.add(subscriptionId);
                            } else {
                                routeLogger.error(`Failed to cancel abusive subscription ${subscriptionId}:`, cancelResult.error);
                            }
                            
                            if (subscriptionMapping && subscriptionMapping.socket && subscriptionMapping.socket.connected) {
                                try {
                                    subscriptionMapping.socket.emit('paypal:subscription_error', {
                                        success: false,
                                        subscriptionId: subscriptionId,
                                        error: 'FREE_TRIAL_ALREADY_USED',
                                        message: 'This PayPal account has already used a free trial subscription. Free trials are limited to one per PayPal account. Your subscription has been cancelled and any payment will be refunded.',
                                        payerEmail: payerEmail,
                                        previousUsage: {
                                            subscriptionId: existingRecord.subscriptionId,
                                            organizationName: existingRecord.organizationName,
                                            activatedAt: existingRecord.activatedAt
                                        }
                                    });
                                    routeLogger.info(`Sent free trial abuse notification to socket: ${subscriptionMapping.socket.id}`);
                                } catch (socketError: any) {
                                    routeLogger.error(`Error sending abuse notification to socket:`, socketError);
                                }
                            }
                            
                            if (subscriptionMapping) {
                                paypalService.removeSubscriptionMapping(subscriptionId);
                            }
                            
                            return;
                        }
                        
                        
                let orgId = subscriptionMapping?.organizationId;
                let orgName = subscriptionMapping?.organizationName;
                
                await recordFreeTrialUsage({
                    payerEmail: payerEmail,
                    payerId: payerId,
                    planId: planId,
                    planName: subscriptionDetails?.planId || planId,
                    subscriptionId: subscriptionId,
                    organizationId: orgId || 'unknown',
                    organizationName: orgName,
                    webhookEventId: event.id
                });
                
                // Update organization's isTrialUsed flag in metadata
                if (orgId && orgId !== 'unknown') {
                    try {
                        const trialDbService = DatabaseService.getInstance();
                        if (!trialDbService.isConnected()) {
                            await trialDbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                        }
                        const trialOrgDbName = process.env.ORGANIZATION_DB;
                        if (trialOrgDbName) {
                            await trialDbService.ensureDatabase(trialOrgDbName);
                            await trialDbService.ensureCollection<IOrganization>(trialOrgDbName, CollectionNames.ORGANIZATIONS);
                            const trialOrgRepo = trialDbService.getRepository<IOrganization>(trialOrgDbName, CollectionNames.ORGANIZATIONS);
                            
                            const trialOrg = await trialOrgRepo.findOne({ OrganizationId: orgId });
                            if (trialOrg) {
                                const currentMetadata = trialOrg.metadata || {};
                                const updatedMetadata = {
                                    ...currentMetadata,
                                    isTrialUsed: true,
                                    trialUsedAt: new Date(),
                                    trialPlanId: planId,
                                    trialPayerEmail: payerEmail
                                };
                                
                                await trialOrgRepo.updateOne(
                                    { OrganizationId: orgId },
                                    { $set: { metadata: updatedMetadata } }
                                );
                                routeLogger.info(`Updated isTrialUsed=true for organization ${orgId} (${orgName})`);
                            }
                        }
                    } catch (trialFlagError: any) {
                        routeLogger.error(`Error updating isTrialUsed flag for organization ${orgId}:`, trialFlagError);
                    }
                }
            } else {
                routeLogger.warn(`Could not retrieve payer email for subscription ${subscriptionId}. Proceeding without free trial check.`);
            }
        }
        //==============END FREE TRIAL ABUSE PREVENTION CHECK==============

        // Refresh subscription data from PayPal to ensure we have the latest state
        await refreshSubscriptionInOrganization(subscriptionId, event);

        // Get organization to update credits
        const databaseService = DatabaseService.getInstance();
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }
        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            routeLogger.error('ORGANIZATION_DB environment variable is not set');
            return;
        }
        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        // Find organization by subscription mapping or subscription ID in metadata
        let organization: IOrganization | null = null;
        if (subscriptionMapping) {
            organization = await organizationRepository.findOne({
                OrganizationId: subscriptionMapping.organizationId
            });
        }
        if (!organization) {
            organization = await organizationRepository.findOne({
                'metadata.paypal.subscriptionId': subscriptionId
            } as any);
        }

        if (organization && planId) {
            try {
                const { getDBService } = await import('../DataAccessLayer/db-connection');
                const dbService = await getDBService();
                const planHandler = dbService.getRepository<PlanInfo>('General', 'PlanConstraints');
                const planConstraints = await planHandler.findOne({ planId: planId });
                
                const subscriptionCredits = planConstraints?.constraints?.subscriptionCredits || 0;
                
            
                const metadata = organization.metadata || {};
                if (metadata.credits === undefined) {
                    metadata.credits = 0;
                }
                if (!metadata.paypal) {
                    metadata.paypal = {};
                }
                if (!metadata.paypal.creditTransactions) {
                    metadata.paypal.creditTransactions = [];
                }
                metadata.paypal.creditTransactions.push({
                    subscriptionId: subscriptionId,
                    planId: planId,
                    subscriptionCredits: subscriptionCredits,
                    timestamp: new Date(),
                    type: 'subscription_activation',
                    webhookEventId: event.id
                });

                await organizationRepository.updateOne(
                    { OrganizationId: organization.OrganizationId },
                    { $set: { metadata } }
                );
                routeLogger.info(`✅ Subscription Activation: Initialized credits to ${metadata.credits} for organization ${organization.OrganizationId} (${organization.OrganizationName}). SubscriptionCredits: ${subscriptionCredits}, Total available: ${subscriptionCredits + metadata.credits}`);
            } catch (creditError: any) {
                routeLogger.error(`Error updating credits for subscription activation:`, creditError);
            }
        }

        // If we have a mapping, notify the client via socket
        if (subscriptionMapping) {
            routeLogger.info(`Found subscription mapping for ${subscriptionId} -> Organization: ${subscriptionMapping.organizationName}`);

            // Notify the client via socket if socket is still connected
            if (subscriptionMapping.socket && subscriptionMapping.socket.connected) {
                try {
                    subscriptionMapping.socket.emit('paypal:subscription_activated', {
                        success: true,
                        subscriptionId: subscriptionId,
                        subscription: subscriptionResource,
                        organizationId: subscriptionMapping.organizationId,
                        organizationName: subscriptionMapping.organizationName,
                        message: 'Your PayPal subscription has been activated successfully'
                    });
                    routeLogger.info(`Sent subscription activation notification to socket: ${subscriptionMapping.socket.id}`);
                } catch (error: any) {
                    routeLogger.error(`Error sending notification to socket ${subscriptionMapping.socket.id}:`, error);
                }
            } else {
                routeLogger.warn(`No socket available to send notification for subscription ${subscriptionId}`);
            }
            paypalService.removeSubscriptionMapping(subscriptionId);
        } else {
            routeLogger.info(`No subscription mapping found for ${subscriptionId}. Organization metadata updated via refresh.`);
        }

    } catch (error: any) {
        routeLogger.error('Error handling subscription activated webhook:', error);
        throw error;
    }
}

/**
 * Handler for BILLING.SUBSCRIPTION.CANCELLED event
 * Updates organization metadata with cancelled subscription status
 */
async function handleSubscriptionCancelledWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing BILLING.SUBSCRIPTION.CANCELLED webhook event:', event.id);

        const subscriptionResource = event.resource;

        if (!subscriptionResource || !subscriptionResource.id) {
            routeLogger.error('Invalid subscription resource in webhook event');
            return;
        }

        const subscriptionId = subscriptionResource.id;

        if (skipCancellationProcessing.has(subscriptionId)) {
            skipCancellationProcessing.delete(subscriptionId);
            return;
        }

        // Refresh subscription data from PayPal to ensure we have the latest state
        await refreshSubscriptionInOrganization(subscriptionId, event);

        routeLogger.info(`Subscription ${subscriptionId} cancelled and organization metadata updated`);

    } catch (error: any) {
        routeLogger.error('Error handling subscription cancelled webhook:', error);
        throw error;
    }
}

/**
 * Generic handler for all subscription webhook events
 * Refreshes subscription data from PayPal and updates organization metadata
 */
async function handleSubscriptionWebhook(event: PayPalWebhookEvent, eventType: string): Promise<void> {
    try {
        routeLogger.info(`Processing ${eventType} webhook event:`, event.id);

        const subscriptionResource = event.resource;

        if (!subscriptionResource || !subscriptionResource.id) {
            routeLogger.error('Invalid subscription resource in webhook event');
            return;
        }

        const subscriptionId = subscriptionResource.id;

        if (eventType === 'BILLING.SUBSCRIPTION.CREATED') {
               const paypalService = getPayPalService();

            const subscriptionMapping = paypalService.getSubscriptionMapping(subscriptionId);
            if(subscriptionMapping && subscriptionMapping.socket) {
                subscriptionMapping.socket.emit("paypal:subscription_created", { created: true });
            }
        }
        await refreshSubscriptionInOrganization(subscriptionId, event);

        routeLogger.info(`Subscription ${subscriptionId} updated from ${eventType} event`);

    } catch (error: any) {
        routeLogger.error(`Error handling ${eventType} webhook:`, error);
        throw error;
    }
}

// Register webhook handlers for subscription events
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_ACTIVATED, handleSubscriptionActivatedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_CANCELLED, handleSubscriptionCancelledWebhook);
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_CREATED, (event) => handleSubscriptionWebhook(event, 'BILLING.SUBSCRIPTION.CREATED'));
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_UPDATED, (event) => handleSubscriptionWebhook(event, 'BILLING.SUBSCRIPTION.UPDATED'));
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_EXPIRED, (event) => handleSubscriptionWebhook(event, 'BILLING.SUBSCRIPTION.EXPIRED'));
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_SUSPENDED, (event) => handleSubscriptionWebhook(event, 'BILLING.SUBSCRIPTION.SUSPENDED'));
paypalWebhookService.on(PayPalWebhookEventType.BILLING_SUBSCRIPTION_PAYMENT_FAILED, (event) => handleSubscriptionWebhook(event, 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'));

//==============PAYMENT CAPTURE WEBHOOKS==============

//Handler for PAYMENT.CAPTURE.COMPLETED webhook
async function handlePaymentCaptureCompletedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing PAYMENT.CAPTURE.COMPLETED webhook event:', event.id);
        const captureResource = event.resource;
        if (!captureResource || !captureResource.id) {
            routeLogger.error('Invalid capture resource in webhook event');
            return;
        }

        routeLogger.info(`Payment capture ${captureResource.id} completed successfully`);

        const supplementaryData = captureResource.supplementary_data;
        const paypalService = getPayPalService();

        if (supplementaryData && supplementaryData.related_ids && supplementaryData.related_ids.order_id) {
            const orderId = supplementaryData.related_ids.order_id;

            paypalService.updateOrderWebhookState(orderId, 'paymentCaptureCompleted', {
                timestamp: new Date(),
                captureId: captureResource.id
            });
            const orderMapping = paypalService.getOrderMapping(orderId);
            if (orderMapping) {
                routeLogger.info(`Payment captured for order ${orderId}. Processing credit addition...`);
                const databaseService = DatabaseService.getInstance();
                if (!databaseService.isConnected()) {
                    await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                }
                const orgDbName = process.env.ORGANIZATION_DB;
                if (!orgDbName) {
                    routeLogger.error('ORGANIZATION_DB environment variable is not set');
                    return;
                }
                await databaseService.ensureDatabase(orgDbName);
                await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                const organization = await organizationRepository.findOne({ OrganizationId: orderMapping.organizationId });
                if (organization) {
                    const currentCredits = (organization.metadata?.credits !== undefined && organization.metadata?.credits !== null) 
                        ? organization.metadata.credits 
                        : 0;
                    
                    // Add credits for top-up (not set, since this is a purchase)
                    const updatedCredits = currentCredits + orderMapping.credits;
                    
                    const metadata = organization.metadata || {};
                    if (!metadata.paypal) {
                        metadata.paypal = {};
                    }
                    metadata.credits = updatedCredits;
                    
                    if (!metadata.paypal.creditTransactions) {
                        metadata.paypal.creditTransactions = [];
                    }
                    metadata.paypal.creditTransactions.push({
                        orderId: orderId,
                        captureId: captureResource.id,
                        credits: orderMapping.credits,
                        previousBalance: currentCredits,
                        newBalance: updatedCredits,
                        timestamp: new Date(),
                        type: 'purchase',
                        webhookEventId: event.id
                    });
                    await organizationRepository.updateOne(
                        { OrganizationId: orderMapping.organizationId },
                        { $set: { metadata } }
                    );
                    routeLogger.info(`✅ Webhook: Added ${orderMapping.credits} credits to organization ${orderMapping.organizationId} (${orderMapping.organizationName}). Previous: ${currentCredits}, New balance: ${updatedCredits}`);
                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:order_captured', {
                                success: true,
                                orderId: orderId,
                                captureId: captureResource.id,
                                credits: orderMapping.credits,
                                newBalance: updatedCredits,
                                message: `Successfully purchased ${orderMapping.credits} credits`
                            });
                            routeLogger.info(`Sent capture notification to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }
                } else {
                    routeLogger.warn(`Organization not found for order ${orderId}. Organization ID: ${orderMapping.organizationId}`);
                }
            } else {
                routeLogger.warn(`No order mapping found for PayPal order ${orderId}`);
            }
        }
    } catch (error: any) {
        routeLogger.error('Error handling payment capture completed webhook:', error);
        throw error;
    }
}

//Handler for PAYMENT.CAPTURE.DENIED webhook
async function handlePaymentCaptureDeniedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing PAYMENT.CAPTURE.DENIED webhook event:', event.id);

        const captureResource = event.resource;
        if (!captureResource || !captureResource.id) {
            routeLogger.error('Invalid capture resource in webhook event');
            return;
        }

        routeLogger.info(`Payment capture ${captureResource.id} denied, reason: ${captureResource.status_details?.reason}`);

        //Notify client if socket available
        const paypalService = getPayPalService();
        const supplementaryData = captureResource.supplementary_data;

        if (supplementaryData && supplementaryData.related_ids && supplementaryData.related_ids.order_id) {
            const orderId = supplementaryData.related_ids.order_id;
            const orderMapping = paypalService.getOrderMapping(orderId);

            if (orderMapping) {
                //Update webhook state instead of removing mapping
                paypalService.updateOrderWebhookState(orderId, 'paymentCaptureDenied', {
                    timestamp: new Date(),
                    reason: captureResource.status_details?.reason
                });

                if (orderMapping.socket && orderMapping.socket.connected) {
                    try {
                        orderMapping.socket.emit('paypal:order_denied', {
                            success: false,
                            orderId: orderId,
                            captureId: captureResource.id,
                            reason: captureResource.status_details?.reason,
                            message: 'Payment was denied'
                        });
                    } catch (error) {
                        routeLogger.error('Error sending socket notification:', error);
                    }
                }
            }
        }
    } catch (error: any) {
        routeLogger.error('Error handling payment capture denied webhook:', error);
        throw error;
    }
}

//Handler for PAYMENT.CAPTURE.PENDING webhook
async function handlePaymentCapturePendingWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing PAYMENT.CAPTURE.PENDING webhook event:', event.id);

        const captureResource = event.resource;
        if (!captureResource || !captureResource.id) {
            routeLogger.error('Invalid capture resource in webhook event');
            return;
        }

        routeLogger.info(`Payment capture ${captureResource.id} is pending, reason: ${captureResource.status_details?.reason}`);

        const paypalService = getPayPalService();
        const supplementaryData = captureResource.supplementary_data;

        if (supplementaryData && supplementaryData.related_ids && supplementaryData.related_ids.order_id) {
            const orderId = supplementaryData.related_ids.order_id;

            //Update webhook state instead of removing mapping
            paypalService.updateOrderWebhookState(orderId, 'paymentCapturePending', {
                timestamp: new Date()
            });
        }
    } catch (error: any) {
        routeLogger.error('Error handling payment capture pending webhook:', error);
        throw error;
    }
}

//Handler for PAYMENT.CAPTURE.REFUNDED webhook
async function handlePaymentCaptureRefundedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing PAYMENT.CAPTURE.REFUNDED webhook event:', event.id);

        const refundResource = event.resource;
        if (!refundResource || !refundResource.id) {
            routeLogger.error('Invalid refund resource in webhook event');
            return;
        }

        routeLogger.info(`Payment refund ${refundResource.id} processed, amount: ${refundResource.amount?.value} ${refundResource.amount?.currency_code}`);

        const databaseService = DatabaseService.getInstance();

        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            routeLogger.error('ORGANIZATION_DB not configured');
            return;
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizations = await organizationRepository.find({
            'metadata.paypal.creditTransactions.captureId': refundResource.id
        } as any);

        if (organizations && organizations.length > 0) {
            const organization = organizations[0];
            const metadata = organization.metadata || {};
            const transactions = metadata.paypal?.creditTransactions || [];

            const originalTransaction = transactions.find((t: any) => t.captureId === refundResource.id);

            if (originalTransaction && originalTransaction.credits > 0) {
                const currentCredits = metadata.credits || 0;
                const refundedCredits = originalTransaction.credits;
                const updatedCredits = Math.max(0, currentCredits - refundedCredits);

                metadata.credits = updatedCredits;

                if (!metadata.paypal.creditTransactions) {
                    metadata.paypal.creditTransactions = [];
                }

                metadata.paypal.creditTransactions.push({
                    refundId: refundResource.id,
                    captureId: refundResource.id,
                    credits: -refundedCredits,
                    previousBalance: currentCredits,
                    newBalance: updatedCredits,
                    timestamp: new Date(),
                    type: 'refund',
                    webhookEventId: event.id
                });

                await organizationRepository.updateOne(
                    { OrganizationId: organization.OrganizationId },
                    { $set: { metadata } }
                );

                routeLogger.info(`Refunded ${refundedCredits} credits from organization ${organization.OrganizationId}. New balance: ${updatedCredits}`);
                const paypalService = getPayPalService();
                if (originalTransaction.orderId) {
                    paypalService.updateOrderWebhookState(originalTransaction.orderId, 'paymentCaptureRefunded', {
                        timestamp: new Date(),
                        refundId: refundResource.id
                    });
                }
            }
        }
    } catch (error: any) {
        routeLogger.error('Error handling payment capture refunded webhook:', error);
        throw error;
    }
}

//Handler for PAYMENT.CAPTURE.REVERSED webhook
async function handlePaymentCaptureReversedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing PAYMENT.CAPTURE.REVERSED webhook event:', event.id);

        const captureResource = event.resource;
        if (!captureResource || !captureResource.id) {
            routeLogger.error('Invalid capture resource in webhook event');
            return;
        }

        routeLogger.info(`Payment capture ${captureResource.id} reversed`);

        const paypalService = getPayPalService();
        const supplementaryData = captureResource.supplementary_data;

        if (supplementaryData && supplementaryData.related_ids && supplementaryData.related_ids.order_id) {
            const orderId = supplementaryData.related_ids.order_id;

            //Update webhook state instead of removing mapping
            paypalService.updateOrderWebhookState(orderId, 'paymentCaptureReversed', {
                timestamp: new Date()
            });
        }
        //Similar handling as refund - deduct credits if applicable (to be implemented)
    } catch (error: any) {
        routeLogger.error('Error handling payment capture reversed webhook:', error);
        throw error;
    }
}

//Register payment capture webhook handlers
paypalWebhookService.on(PayPalWebhookEventType.PAYMENT_CAPTURE_COMPLETED, handlePaymentCaptureCompletedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.PAYMENT_CAPTURE_DENIED, handlePaymentCaptureDeniedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.PAYMENT_CAPTURE_PENDING, handlePaymentCapturePendingWebhook);
paypalWebhookService.on(PayPalWebhookEventType.PAYMENT_CAPTURE_REFUNDED, handlePaymentCaptureRefundedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.PAYMENT_CAPTURE_REVERSED, handlePaymentCaptureReversedWebhook);

//==============CHECKOUT ORDER WEBHOOKS==============

//Handler for CHECKOUT.ORDER.APPROVED webhook - triggers when customer approves order
async function handleCheckoutOrderApprovedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing CHECKOUT.ORDER.APPROVED webhook event:', event.id);

        const orderResource = event.resource;
        if (!orderResource || !orderResource.id) {
            routeLogger.error('Invalid order resource in webhook event');
            return;
        }

        const orderId = orderResource.id;
        routeLogger.info(`Checkout order ${orderId} approved by customer. Status: ${orderResource.status}`);

        //Get order data from PayPalService mapping
        const paypalService = getPayPalService();
        const orderMapping = paypalService.getOrderMapping(orderId);

        if (orderMapping) {
            paypalService.updateOrderWebhookState(orderId, 'checkoutOrderApproved', {
                timestamp: new Date(),
                status: orderResource.status
            });

            routeLogger.info(`Order ${orderId} marked as approved and ready for capture`);

            //Notify client via socket if available
            if (orderMapping.socket && orderMapping.socket.connected) {
                try {
                    orderMapping.socket.emit('paypal:order_approved', {
                        orderId: orderId,
                        status: orderResource.status,
                        message: 'Order approved by customer. Ready for capture.'
                    });
                    routeLogger.info(`Sent order approved notification to socket: ${orderMapping.socket.id}`);
                } catch (error) {
                    routeLogger.error('Error sending order approved notification:', error);
                }
            }
        } else {
            routeLogger.warn(`Order mapping not found for approved order ${orderId}. Order may have been created outside socket flow.`);
        }
    } catch (error: any) {
        routeLogger.error('Error handling checkout order approved webhook:', error);
        throw error;
    }
}

//Handler for CHECKOUT.ORDER.COMPLETED webhook - triggers after order is captured
//only used for logging/tracking purposes
async function handleCheckoutOrderCompletedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing CHECKOUT.ORDER.COMPLETED webhook event:', event.id);

        const orderResource = event.resource;
        if (!orderResource || !orderResource.id) {
            routeLogger.error('Invalid order resource in webhook event');
            return;
        }

        const orderId = orderResource.id;
        routeLogger.info(`Checkout order ${orderId} completed. Status: ${orderResource.status}`);
        routeLogger.info('NOTE: Credits already added by PAYMENT.CAPTURE.COMPLETED webhook');

        //Get order mapping for logging purposes
        const paypalService = getPayPalService();
        const orderMapping = paypalService.getOrderMapping(orderId);

        if (orderMapping) {
            routeLogger.info(`Order ${orderId} completion confirmed for organization ${orderMapping.organizationName}`);

            //Send completion notification via socket if available
            if (orderMapping.socket && orderMapping.socket.connected) {
                try {
                    orderMapping.socket.emit('paypal:order_completed', {
                        success: true,
                        orderId: orderId,
                        credits: orderMapping.credits,
                        message: `Order ${orderId} completed successfully`
                    });
                    routeLogger.info(`Sent order completed notification to socket: ${orderMapping.socket.id}`);
                } catch (error) {
                    routeLogger.error('Error sending socket notification:', error);
                }
            }
        } else {
            routeLogger.info(`Order ${orderId} completed (no mapping found - may have been cleaned up)`);
        }
    } catch (error: any) {
        routeLogger.error('Error handling checkout order completed webhook:', error);
        throw error;
    }
}

//Handler for CHECKOUT.ORDER.SAVED webhook - triggers when order is saved
async function handleCheckoutOrderSavedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing CHECKOUT.ORDER.SAVED webhook event:', event.id);

        const orderResource = event.resource;
        if (!orderResource || !orderResource.id) {
            routeLogger.error('Invalid order resource in webhook event');
            return;
        }

        routeLogger.info(`Checkout order ${orderResource.id} saved. Status: ${orderResource.status}`);
    } catch (error: any) {
        routeLogger.error('Error handling checkout order saved webhook:', error);
        throw error;
    }
}

//Handler for CHECKOUT.ORDER.VOIDED webhook - triggers when order is voided
async function handleCheckoutOrderVoidedWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
        routeLogger.info('Processing CHECKOUT.ORDER.VOIDED webhook event:', event.id);

        const orderResource = event.resource;
        if (!orderResource || !orderResource.id) {
            routeLogger.error('Invalid order resource in webhook event');
            return;
        }

        const orderId = orderResource.id;
        routeLogger.info(`Checkout order ${orderId} voided. Status: ${orderResource.status}`);
        const paypalService = getPayPalService();
        paypalService.removeOrderMapping(orderId);
        //Note: Order mapping cleanup will be handled elsewhere
    } catch (error: any) {
        routeLogger.error('Error handling checkout order voided webhook:', error);
        throw error;
    }
}

//these are the webhooks for the orders that we are going to be using for credits
paypalWebhookService.on(PayPalWebhookEventType.CHECKOUT_ORDER_APPROVED, handleCheckoutOrderApprovedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.CHECKOUT_ORDER_COMPLETED, handleCheckoutOrderCompletedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.CHECKOUT_ORDER_SAVED, handleCheckoutOrderSavedWebhook);
paypalWebhookService.on(PayPalWebhookEventType.CHECKOUT_ORDER_VOIDED, handleCheckoutOrderVoidedWebhook);

router.get('/order/status/:uniqueOrderId', async (req: any, res: any) => {
    try {
        const { uniqueOrderId } = req.params;
        const paypalService = getPayPalService();

        if (!uniqueOrderId) {
            return res.status(400).json({
                success: false,
                error: 'Missing uniqueOrderId parameter'
            });
        }

        routeLogger.info(`Order status check requested for unique ID: ${uniqueOrderId}`);

        let orderMapping = null;
        let paypalOrderId = null;

        for (const [orderId, mapping] of paypalService.getAllOrderMappings()) {
            if (mapping.id === uniqueOrderId) {
                orderMapping = mapping;
                paypalOrderId = orderId;
                break;
            }
        }

        if (!orderMapping || !paypalOrderId) {
            return res.status(404).json({
                success: false,
                error: 'Order not found or already processed',
                message: 'This order may have already been completed or cancelled'
            });
        }

        routeLogger.info(`Found order mapping: PayPal Order ID ${paypalOrderId}, Organization: ${orderMapping.organizationName}`);
        const orderDetails = await paypalService.getOrderDetails(paypalOrderId);

        if (!orderDetails.success) {
            return res.status(500).json({
                success: false,
                error: 'Failed to retrieve order details from PayPal',
                message: orderDetails.error
            });
        }

        const paypalStatus = orderDetails.order?.status;
        routeLogger.info(`PayPal order status: ${paypalStatus}`);

        const webhookStates = orderMapping.webhookStates || {};

        const waitForWebhookState = async (
            stateName: 'checkoutOrderApproved' | 'paymentCaptureCompleted' | 'paymentCaptureDenied' | 'paymentCapturePending' | 'paymentCaptureRefunded' | 'paymentCaptureReversed',
            maxWaitSeconds: number = 30
        ): Promise<boolean> => {
            const startTime = Date.now();
            const pollInterval = 500;

            while (Date.now() - startTime < maxWaitSeconds * 1000) {
                const currentMapping = paypalService.getOrderMapping(paypalOrderId);
                if (currentMapping?.webhookStates?.[stateName]) {
                    routeLogger.info(`Webhook state '${stateName}' confirmed`);
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            routeLogger.info(`Timeout waiting for webhook state '${stateName}'`);
            return false;
        };

        switch (paypalStatus) {
            case 'CREATED':
                return res.status(200).json({
                    success: false,
                    status: 'CREATED',
                    message: 'Order was created but not approved by customer',
                    orderId: paypalOrderId,
                    organizationId: orderMapping.organizationId,
                    credits: orderMapping.credits
                });

            case 'SAVED':
                return res.status(200).json({
                    success: false,
                    status: 'SAVED',
                    message: 'Order was saved but not approved',
                    orderId: paypalOrderId,
                    organizationId: orderMapping.organizationId,
                    credits: orderMapping.credits
                });

            case 'APPROVED':
                routeLogger.info('Order approved, waiting for approval webhook confirmation...');
                await waitForWebhookState('checkoutOrderApproved', 15);
                routeLogger.info('Order approved webhook received. Now capturing payment...');
                const captureResult = await paypalService.captureOrder(paypalOrderId);

                if (!captureResult.success) {
                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:payment_confirmed', {
                                success: false,
                                orderId: paypalOrderId,
                                error: captureResult.error,
                                message: 'Failed to capture payment'
                            });
                            routeLogger.info(`Sent payment failure notification to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }

                    return res.status(500).json({
                        success: false,
                        status: 'CAPTURE_FAILED',
                        message: 'Failed to capture payment',
                        error: captureResult.error,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        credits: orderMapping.credits
                    });
                }

                routeLogger.info(`Payment captured successfully for order ${paypalOrderId}. Status: ${captureResult.status}`);

                routeLogger.info('Waiting for payment capture webhook confirmation...');
                const captureWebhookConfirmed = await waitForWebhookState('paymentCaptureCompleted', 30);

                if (captureWebhookConfirmed) {
                    const finalMapping = paypalService.getOrderMapping(paypalOrderId);
                    const response = {
                        success: true,
                        status: 'COMPLETED',
                        message: `Successfully purchased ${orderMapping.credits} credits`,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        organizationName: orderMapping.organizationName,
                        credits: orderMapping.credits,
                        amount: orderMapping.amount,
                        captureId: finalMapping?.webhookStates?.paymentCaptureCompleted?.captureId || captureResult.captureId,
                        webhookStates: finalMapping?.webhookStates || {}
                    };

                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:payment_confirmed', {
                                success: true,
                                orderId: paypalOrderId,
                                credits: orderMapping.credits,
                                message: `Successfully purchased ${orderMapping.credits} credits`
                            });
                            routeLogger.info(`Sent payment confirmation to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }

                    routeLogger.info(`Removing order mapping for completed order: ${paypalOrderId}`);
                    paypalService.removeOrderMapping(paypalOrderId);

                    return res.status(200).json(response);
                } else {
                    // case of webhook tiemout errors 
                    routeLogger.info('Webhook confirmation timeout. Checking database for credit addition...');

                    try {
                        const databaseService = DatabaseService.getInstance();

                        if (!databaseService.isConnected()) {
                            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                        }


                        const orgDbName = process.env.ORGANIZATION_DB;
                        if (!orgDbName) {
                            routeLogger.error('ORGANIZATION_DB environment variable is not set');
                            return res.status(500).json({
                                success: false,
                                error: 'ORGANIZATION_DB environment variable is not set',
                                message: 'Server misconfiguration'
                            });
                        }
                        await databaseService.ensureDatabase(orgDbName);
                        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                        const org = await organizationRepository.findOne({ OrganizationId: orderMapping.organizationId });

                        if (org) {
                            const transactions = org.metadata?.paypal?.creditTransactions || [];
                            const orderTransaction = transactions.find((t: any) => t.orderId === paypalOrderId);

                            if (orderTransaction) {
                                //Credits were added by webhook after all!
                                routeLogger.info('Credits confirmed via database check - webhook processed successfully');

                                const response = {
                                    success: true,
                                    status: 'COMPLETED',
                                    message: `Successfully purchased ${orderMapping.credits} credits`,
                                    orderId: paypalOrderId,
                                    organizationId: orderMapping.organizationId,
                                    organizationName: orderMapping.organizationName,
                                    credits: orderMapping.credits,
                                    amount: orderMapping.amount,
                                    captureId: captureResult.captureId,
                                    note: 'Credits confirmed via database verification'
                                };

                                // Notify via socket
                                if (orderMapping.socket && orderMapping.socket.connected) {
                                    try {
                                        orderMapping.socket.emit('paypal:payment_confirmed', {
                                            success: true,
                                            orderId: paypalOrderId,
                                            credits: orderMapping.credits,
                                            message: `Successfully purchased ${orderMapping.credits} credits`
                                        });
                                    } catch (error) {
                                        routeLogger.error('Error sending socket notification:', error);
                                    }
                                }

                                paypalService.removeOrderMapping(paypalOrderId);
                                return res.status(200).json(response);
                            }
                        }
                    } catch (dbError) {
                        routeLogger.error('Error checking database for credit confirmation:', dbError);
                    }

                    //Still pending - webhook hasn't processed yet
                    return res.status(200).json({
                        success: true,
                        status: 'CAPTURE_PENDING_CONFIRMATION',
                        message: `Payment captured. ${orderMapping.credits} credits will be added shortly.`,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        organizationName: orderMapping.organizationName,
                        credits: orderMapping.credits,
                        amount: orderMapping.amount,
                        captureId: captureResult.captureId,
                        note: 'Credits will be added once payment capture webhook is confirmed'
                    });
                }

            case 'COMPLETED':
                routeLogger.info('Order completed, waiting for capture webhook confirmation...');
                const captureConfirmed = await waitForWebhookState('paymentCaptureCompleted', 30);

                if (captureConfirmed) {
                    const finalMapping = paypalService.getOrderMapping(paypalOrderId);
                    const response = {
                        success: true,
                        status: 'COMPLETED',
                        message: `Successfully purchased ${orderMapping.credits} credits`,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        organizationName: orderMapping.organizationName,
                        credits: orderMapping.credits,
                        amount: orderMapping.amount,
                        captureId: finalMapping?.webhookStates?.paymentCaptureCompleted?.captureId,
                        webhookStates: finalMapping?.webhookStates || {}
                    };

                    // Notify via socket if available
                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:payment_confirmed', {
                                success: true,
                                orderId: paypalOrderId,
                                credits: orderMapping.credits,
                                message: `Successfully purchased ${orderMapping.credits} credits`
                            });
                            routeLogger.info(`Sent payment confirmation to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }

                    // Remove order mapping after successful completion
                    routeLogger.info(`Removing order mapping for completed order: ${paypalOrderId}`);
                    paypalService.removeOrderMapping(paypalOrderId);

                    return res.status(200).json(response);
                } else {
                    //Webhook timeout - Check database directly as fallback
                    routeLogger.info('Webhook confirmation timeout. Checking database for credit addition...');

                    try {
                        const databaseService = DatabaseService.getInstance();

                        if (!databaseService.isConnected()) {
                            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                        }

                        await databaseService.ensureDatabase(orderMapping.dbName);
                        await databaseService.ensureCollection<IOrganization>(orderMapping.dbName, CollectionNames.ORGANIZATIONS);

                        const organizationRepository = databaseService.getRepository<IOrganization>(orderMapping.dbName, CollectionNames.ORGANIZATIONS);
                        const org = await organizationRepository.findOne({ OrganizationId: orderMapping.organizationId });

                        if (org) {
                            const transactions = org.metadata?.paypal?.creditTransactions || [];
                            const orderTransaction = transactions.find((t: any) => t.orderId === paypalOrderId);

                            if (orderTransaction) {
                                //Credits were added by webhook after all!
                                routeLogger.info('Credits confirmed via database check - webhook processed successfully');

                                const finalMapping = paypalService.getOrderMapping(paypalOrderId);
                                const response = {
                                    success: true,
                                    status: 'COMPLETED',
                                    message: `Successfully purchased ${orderMapping.credits} credits`,
                                    orderId: paypalOrderId,
                                    organizationId: orderMapping.organizationId,
                                    organizationName: orderMapping.organizationName,
                                    credits: orderMapping.credits,
                                    amount: orderMapping.amount,
                                    captureId: finalMapping?.webhookStates?.paymentCaptureCompleted?.captureId,
                                    note: 'Credits confirmed via database verification'
                                };

                                // Notify via socket
                                if (orderMapping.socket && orderMapping.socket.connected) {
                                    try {
                                        orderMapping.socket.emit('paypal:payment_confirmed', {
                                            success: true,
                                            orderId: paypalOrderId,
                                            credits: orderMapping.credits,
                                            message: `Successfully purchased ${orderMapping.credits} credits`
                                        });
                                    } catch (error) {
                                        routeLogger.error('Error sending socket notification:', error);
                                    }
                                }

                                paypalService.removeOrderMapping(paypalOrderId);
                                return res.status(200).json(response);
                            }
                        }
                    } catch (dbError) {
                        routeLogger.error('Error checking database for credit confirmation:', dbError);
                    }

                    // Capture webhook not received yet, but order is complete
                    return res.status(200).json({
                        success: true,
                        status: 'COMPLETED',
                        message: `Order completed. ${orderMapping.credits} credits will be added shortly.`,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        organizationName: orderMapping.organizationName,
                        credits: orderMapping.credits,
                        amount: orderMapping.amount,
                        note: 'Credits will be added once payment capture is confirmed'
                    });
                }

            case 'VOIDED':
                // Notify via socket about voided order
                if (orderMapping.socket && orderMapping.socket.connected) {
                    try {
                        orderMapping.socket.emit('paypal:payment_confirmed', {
                            success: false,
                            orderId: paypalOrderId,
                            message: 'Order was voided'
                        });
                        routeLogger.info(`Sent voided notification to socket: ${orderMapping.socket.id}`);
                    } catch (error) {
                        routeLogger.error('Error sending socket notification:', error);
                    }
                }

                // Order was voided
                const response = {
                    success: false,
                    status: 'VOIDED',
                    message: 'Order was voided',
                    orderId: paypalOrderId,
                    organizationId: orderMapping.organizationId,
                    credits: orderMapping.credits
                };

                // Remove mapping for voided order
                routeLogger.info(`Removing order mapping for voided order: ${paypalOrderId}`);
                paypalService.removeOrderMapping(paypalOrderId);

                return res.status(200).json(response);

            case 'PAYER_ACTION_REQUIRED':
                // Additional payer action required
                return res.status(200).json({
                    success: false,
                    status: 'PAYER_ACTION_REQUIRED',
                    message: 'Additional action required from payer',
                    orderId: paypalOrderId,
                    organizationId: orderMapping.organizationId,
                    credits: orderMapping.credits
                });

            default:
                // Check for denied/pending/refunded states in webhook states
                if (webhookStates.paymentCaptureDenied) {
                    // Notify via socket about denied payment
                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:payment_confirmed', {
                                success: false,
                                orderId: paypalOrderId,
                                reason: webhookStates.paymentCaptureDenied.reason,
                                message: 'Payment was denied'
                            });
                            routeLogger.info(`Sent denied notification to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }

                    const deniedResponse = {
                        success: false,
                        status: 'DENIED',
                        message: 'Payment was denied',
                        reason: webhookStates.paymentCaptureDenied.reason,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        credits: orderMapping.credits,
                        webhookStates
                    };

                    // Remove mapping for denied payment
                    routeLogger.info(`Removing order mapping for denied payment: ${paypalOrderId}`);
                    paypalService.removeOrderMapping(paypalOrderId);

                    return res.status(200).json(deniedResponse);
                }

                if (webhookStates.paymentCapturePending) {
                    return res.status(200).json({
                        success: false,
                        status: 'PENDING',
                        message: 'Payment is pending',
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        credits: orderMapping.credits,
                        webhookStates
                    });
                }

                if (webhookStates.paymentCaptureRefunded) {
                    // Notify via socket about refunded payment
                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:payment_confirmed', {
                                success: false,
                                orderId: paypalOrderId,
                                refundId: webhookStates.paymentCaptureRefunded.refundId,
                                message: 'Payment was refunded'
                            });
                            routeLogger.info(`Sent refunded notification to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }

                    const refundedResponse = {
                        success: false,
                        status: 'REFUNDED',
                        message: 'Payment was refunded',
                        refundId: webhookStates.paymentCaptureRefunded.refundId,
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        credits: orderMapping.credits,
                        webhookStates
                    };

                    // Remove mapping for refunded payment
                    routeLogger.info(`Removing order mapping for refunded payment: ${paypalOrderId}`);
                    paypalService.removeOrderMapping(paypalOrderId);

                    return res.status(200).json(refundedResponse);
                }

                if (webhookStates.paymentCaptureReversed) {
                    // Notify via socket about reversed payment
                    if (orderMapping.socket && orderMapping.socket.connected) {
                        try {
                            orderMapping.socket.emit('paypal:payment_confirmed', {
                                success: false,
                                orderId: paypalOrderId,
                                message: 'Payment was reversed'
                            });
                            routeLogger.info(`Sent reversed notification to socket: ${orderMapping.socket.id}`);
                        } catch (error) {
                            routeLogger.error('Error sending socket notification:', error);
                        }
                    }

                    const reversedResponse = {
                        success: false,
                        status: 'REVERSED',
                        message: 'Payment was reversed',
                        orderId: paypalOrderId,
                        organizationId: orderMapping.organizationId,
                        credits: orderMapping.credits,
                        webhookStates
                    };

                    // Remove mapping for reversed payment
                    routeLogger.info(`Removing order mapping for reversed payment: ${paypalOrderId}`);
                    paypalService.removeOrderMapping(paypalOrderId);

                    return res.status(200).json(reversedResponse);
                }

                // Unknown status
                return res.status(200).json({
                    success: false,
                    status: paypalStatus || 'UNKNOWN',
                    message: `Order status: ${paypalStatus || 'Unknown'}`,
                    orderId: paypalOrderId,
                    organizationId: orderMapping.organizationId,
                    credits: orderMapping.credits,
                    webhookStates
                });
        }

    } catch (error: any) {
        routeLogger.error('Error checking order status:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to check order status',
            message: error.message || 'Internal server error'
        });
    }
});

/**
 * GET /paypal/order/cancel/:uniqueOrderId
 * Handle cancelled orders - removes mapping and returns cancel status
 */
router.get('/order/cancel/:uniqueOrderId', async (req: any, res: any) => {
    try {
        const { uniqueOrderId } = req.params;
        const paypalService = getPayPalService();

        if (!uniqueOrderId) {
            return res.status(400).json({
                success: false,
                error: 'Missing uniqueOrderId parameter'
            });
        }

        routeLogger.info(`Order cancellation received for unique ID: ${uniqueOrderId}`);

        // Find order mapping by unique ID
        let orderMapping = null;
        let paypalOrderId = null;

        for (const [orderId, mapping] of paypalService.getAllOrderMappings()) {
            if (mapping.id === uniqueOrderId) {
                orderMapping = mapping;
                paypalOrderId = orderId;
                break;
            }
        }

        if (!orderMapping || !paypalOrderId) {
            return res.status(404).json({
                success: false,
                error: 'Order not found or already processed',
                message: 'This order may have already been completed or cancelled'
            });
        }

        routeLogger.info(`Found cancelled order: PayPal Order ID ${paypalOrderId}, Organization: ${orderMapping.organizationName}`);

        // Remove order mapping
        paypalService.removeOrderMapping(paypalOrderId);
        routeLogger.info(`Removed order mapping for cancelled order: ${paypalOrderId}`);

        return res.status(200).json({
            success: false,
            status: 'CANCELLED',
            message: 'Order was cancelled by customer',
            orderId: paypalOrderId,
            organizationId: orderMapping.organizationId,
            organizationName: orderMapping.organizationName,
            credits: orderMapping.credits
        });

    } catch (error: any) {
        routeLogger.error('Error handling order cancellation:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to handle order cancellation',
            message: error.message || 'Internal server error'
        });
    }
});

router.post('/webhook', async (req: any, res: any) => {
    try {
        const body = req.body;
        routeLogger.info(`Processing webhook event:`, body);
        // Handle webhook
        const result = await paypalWebhookService.handleWebhook(req, body);

        if (result.success) {
            return res.status(200).json({ success: true, message: 'Webhook processed successfully' });
        } else {
            return res.status(400).json({ success: false, error: result.error });
        }
    } catch (error: any) {
        routeLogger.error('Webhook error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});


export default router;

