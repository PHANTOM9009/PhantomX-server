import { Server, Socket } from 'socket.io';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { UserInfo } from '../DataStructures';
import { RazorpayService } from '../Services/RazorpayService';
import { getDBService } from '../DataAccessLayer/db-connection';
import { PlanInfo } from '../model/Plans';
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';
import { createLogger } from '../utils/Logger';

const logger = createLogger('RazorpayHandler');

dotenv.config();

// Singleton Razorpay service
let razorpayService: RazorpayService | null = null;

function getRazorpayService(): RazorpayService {
    if (!razorpayService) {
        razorpayService = new RazorpayService();
    }
    return razorpayService;
}

export async function razorpay_handler(io: Server, socket: Socket) {
    /**
     * Get Razorpay configuration (key ID for client)
     */
    socket.on('razorpay:get_config', async (data: any, callback: (result: any) => void) => {
        try {
            const razorpay = getRazorpayService();
            return callback({
                success: true,
                keyId: razorpay.getKeyId()
            });
        } catch (error: any) {
            logger.error('Error getting Razorpay config:', error);
            return callback({
                success: false,
                error: error.message || 'Failed to get config'
            });
        }
    });

    /**
     * List Razorpay plans with constraints
     * Returns plans from Razorpay API merged with plan constraints from database
     */
    socket.on('razorpay:list_plans', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('Razorpay: List plans request received');
            const razorpay = getRazorpayService();
            
            // Get plans from Razorpay API
            const result = await razorpay.listPlans(data);
            
            // Get plan constraints from database
            let dbService = await getDBService();
            let planHandler = await dbService.getRepository<PlanInfo>('General', 'PlanConstraints');
            let plans = await planHandler.find();
            
            // Filter to only include plans that have razorpayPlanId
            const razorpayPlans = plans.filter(plan => plan.planId);
            
            let finResult = {
                success: true,
                constraints: razorpayPlans,
                plans: result && result.plans && result.plans?.filter((p1) => razorpayPlans.some(p2 => p2.planId === p1.id)) || []
            };
            
            callback(finResult);
        } catch (error: any) {
            logger.error('Razorpay: Error listing plans:', error);
            callback({
                success: false,
                error: error.message || 'Failed to list plans'
            });
        }
    });

    /**
     * Get details of a specific plan
     */
    socket.on('razorpay:get_plan', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('Razorpay: Get plan request received for:', data.planId);
            if (!data.planId) {
                return callback({
                    success: false,
                    error: 'planId is required'
                });
            }
            
            const razorpay = getRazorpayService();
            const result = await razorpay.getPlanDetails(data.planId);
            
            if (result.success && result.plan) {
                // Also get plan constraints from database if available
                let dbService = await getDBService();
                let planHandler = await dbService.getRepository<PlanInfo>('General', 'PlanConstraints');
                let dbPlan = await planHandler.findOne({ razorpayPlanId: data.planId });
                
                callback({
                    success: true,
                    plan: result.plan,
                    constraints: dbPlan || null
                });
            } else {
                callback(result);
            }
        } catch (error: any) {
            logger.error('Razorpay: Error getting plan details:', error);
            callback({
                success: false,
                error: error.message || 'Failed to get plan details'
            });
        }
    });

    /**
     * Create a subscription for a plan
     * Supports 7-day free trial for Essential plan
     */
    socket.on('razorpay:create_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            const { planId, razorpayPlanId, email, contact, planName } = data;
            if (!planId || !razorpayPlanId) {
                return callback({
                    success: false,
                    error: 'Missing required fields: planId, razorpayPlanId'
                });
            }

            const razorpay = getRazorpayService();
            
            // Check if this is an Essential plan eligible for free trial
            const TRIAL_PLAN_NAME = 'Essential';
            const TRIAL_DAYS = 7;
            let isTrialEligible = false;
            let startAt: number | undefined = undefined;
            
            // Determine plan name - either from data or fetch from Razorpay
            let effectivePlanName = planName;
            if (!effectivePlanName) {
                // Try to get plan name from Razorpay
                const planDetails = await razorpay.getPlanDetails(razorpayPlanId);
                if (planDetails.success && planDetails.plan?.item?.name) {
                    effectivePlanName = planDetails.plan.item.name;
                }
            }
            
            // Check if plan is Essential (case-insensitive)
            const isEssentialPlan = effectivePlanName && 
                effectivePlanName.toLowerCase().trim() === TRIAL_PLAN_NAME.toLowerCase();
            
            if (isEssentialPlan) {
                // Check if organization has already used free trial
                const databaseService = DatabaseService.getInstance();
                if (!databaseService.isConnected()) {
                    await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                }
                
                const orgDbName = process.env.ORGANIZATION_DB;
                if (orgDbName) {
                    await databaseService.ensureDatabase(orgDbName);
                    await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                    
                    const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                    const existingOrg = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });
                    
                    // Check if trial has been used (via PayPal or Razorpay)
                    const hasUsedTrial = existingOrg?.metadata?.isTrialUsed === true ||
                        existingOrg?.metadata?.razorpay?.trialUsed === true ||
                        (existingOrg?.metadata?.razorpay?.subscriptionId !== null && 
                         existingOrg?.metadata?.razorpay?.subscriptionId !== undefined) ||
                        (existingOrg?.metadata?.paypal?.subscriptionId !== null && 
                         existingOrg?.metadata?.paypal?.subscriptionId !== undefined);
                    
                    if (!hasUsedTrial) {
                        isTrialEligible = true;
                        // Set start_at to 7 days from now (Unix timestamp in seconds)
                        const trialEndDate = new Date();
                        trialEndDate.setDate(trialEndDate.getDate() + TRIAL_DAYS);
                        startAt = Math.floor(trialEndDate.getTime() / 1000);
                        
                        logger.info(`Essential plan eligible for ${TRIAL_DAYS}-day free trial for org ${userInfo.organizationId}`);
                    } else {
                        logger.info(`Organization ${userInfo.organizationId} has already used free trial`);
                    }
                }
            }

            // Create subscription in Razorpay
            // IMPORTANT: Notes are critical for webhook processing
            // These notes are attached to the subscription and will be available
            // in all webhook events related to this subscription
            const subscriptionNotes: Record<string, string> = {
                planId: planId,
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName || '',
                userId: userId,
                email: email || '',
                createdAt: new Date().toISOString(),
                planName: effectivePlanName || ''
            };
            
            // Add trial info to notes if applicable
            if (isTrialEligible) {
                subscriptionNotes.hasFreeTrial = 'true';
                subscriptionNotes.trialDays = TRIAL_DAYS.toString();
            }
            
            logger.info(`Creating subscription with notes:`, JSON.stringify(subscriptionNotes));
            
            const subscriptionParams: any = {
                planId: razorpayPlanId,
                totalCount: 0, // Infinite billing cycles
                customerNotify: 1,
                notes: subscriptionNotes
            };
            
            // If eligible for trial, set start_at to delay first billing
            if (isTrialEligible && startAt) {
                subscriptionParams.startAt = startAt;
                logger.info(`Setting subscription start_at to ${new Date(startAt * 1000).toISOString()} (${TRIAL_DAYS}-day trial)`);
            }
            
            const result = await razorpay.createSubscription(subscriptionParams);

            if (!result.success || !result.subscriptionId) {
                return callback({
                    success: false,
                    error: result.error || 'Failed to create subscription'
                });
            }

            // Store mapping for webhook processing
            razorpay.storeSubscriptionMapping(result.subscriptionId, {
                userId: userId,
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName || '',
                dbName: userInfo.dbName
            }, socket);

            logger.info(`Subscription created: ${result.subscriptionId} for org ${userInfo.organizationId}${isTrialEligible ? ' (with free trial)' : ''}`);

            return callback({
                success: true,
                subscriptionId: result.subscriptionId,
                shortUrl: result.shortUrl,
                subscription: result.subscription,
                hasFreeTrial: isTrialEligible,
                trialDays: isTrialEligible ? TRIAL_DAYS : 0
            });

        } catch (error: any) {
            logger.error('Error creating subscription:', error);
            return callback({
                success: false,
                error: error.message || 'Failed to create subscription'
            });
        }
    });

    /**
     * Verify subscription payment after client-side checkout
     */
    socket.on('razorpay:verify_subscription_payment', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            // Support both Razorpay standard format (razorpay_*) and camelCase format
            const subscriptionId = data.razorpay_subscription_id || data.subscriptionId;
            const paymentId = data.razorpay_payment_id || data.paymentId;
            const signature = data.razorpay_signature || data.signature;
            const planId = data.planId;
            
            if (!subscriptionId || !paymentId || !signature) {
                logger.error('Missing required fields for payment verification:', { subscriptionId: !!subscriptionId, paymentId: !!paymentId, signature: !!signature });
                return callback({
                    success: false,
                    error: 'Missing required fields'
                });
            }

            const razorpay = getRazorpayService();

            // Verify signature
            const isValid = razorpay.verifySubscriptionPaymentSignature({
                subscriptionId,
                paymentId,
                signature
            });

            if (!isValid) {
                return callback({
                    success: false,
                    error: 'Invalid payment signature'
                });
            }

            // Get subscription details
            const subDetails = await razorpay.getSubscriptionDetails(subscriptionId);
            if (!subDetails.success) {
                return callback({
                    success: false,
                    error: 'Failed to get subscription details'
                });
            }

            // Update organization with subscription
            const databaseService = DatabaseService.getInstance();
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgDbName = process.env.ORGANIZATION_DB;
            if (!orgDbName) {
                return callback({
                    success: false,
                    error: 'ORGANIZATION_DB not configured'
                });
            }

            await databaseService.ensureDatabase(orgDbName);
            await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

            // Get existing organization to preserve creditTransactions
            const existingOrg = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });
            const existingCreditTransactions = existingOrg?.metadata?.razorpay?.creditTransactions || [];

            // Check if subscription has a trial (start_at is in the future)
            const subscriptionData = subDetails.subscription;
            const hasFreeTrial = subscriptionData?.start_at && (subscriptionData.start_at * 1000) > Date.now();
            const trialEndDate = hasFreeTrial ? new Date(subscriptionData.start_at * 1000) : null;
            
            // Determine status based on trial
            const status = hasFreeTrial ? 'TRIAL' : 'ACTIVE';

            // Update organization with Razorpay subscription and remove PayPal if exists
            // NOTE: We preserve existing creditTransactions to not lose purchase history
            const updateData: any = {
                $set: {
                    'metadata.razorpay.subscriptionId': subscriptionId,
                    'metadata.razorpay.status': status,
                    'metadata.razorpay.planId': planId,
                    'metadata.razorpay.subscription': subDetails.subscription,
                    'metadata.razorpay.activatedAt': new Date(),
                    'metadata.razorpay.creditTransactions': existingCreditTransactions,
                    'metadata.razorpay.trialUsed': true, // Mark trial as used
                    'metadata.isTrialUsed': true // Global trial used flag
                },
                $unset: {
                    'metadata.paypal': 1
                }
            };
            
            // Add trial-specific fields if applicable
            if (hasFreeTrial && trialEndDate) {
                updateData.$set['metadata.razorpay.hasFreeTrial'] = true;
                updateData.$set['metadata.razorpay.trialEndDate'] = trialEndDate;
                updateData.$set['metadata.razorpay.trialStartDate'] = new Date();
                logger.info(`Subscription ${subscriptionId} has ${Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))}-day free trial ending on ${trialEndDate.toISOString()}`);
            }
            
            await organizationRepository.updateOne(
                { OrganizationId: userInfo.organizationId },
                updateData
            );

            logger.info(`Subscription verified and activated for org ${userInfo.organizationId}${hasFreeTrial ? ' (with free trial)' : ''}`);

            return callback({
                success: true,
                subscriptionId: subscriptionId,
                status: status,
                hasFreeTrial: hasFreeTrial,
                trialEndDate: trialEndDate?.toISOString() || null
            });

        } catch (error: any) {
            logger.error('Error verifying subscription payment:', error);
            return callback({
                success: false,
                error: error.message || 'Verification failed'
            });
        }
    });

    /**
     * Create an order for one-time credit purchase
     */
    socket.on('razorpay:create_credit_order', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            const { credits, amount } = data;
            if (!credits || !amount) {
                return callback({
                    success: false,
                    error: 'Missing required fields: credits, amount'
                });
            }

            const razorpay = getRazorpayService();
            const orderId = uuidv4();

            // IMPORTANT: Notes are critical for webhook processing
            // These notes are attached to the order and will be available
            // in all webhook events related to this order
            const orderNotes = {
                credits: credits.toString(),
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName || '',
                userId: userId,
                type: 'credit_purchase',
                createdAt: new Date().toISOString()
            };
            
            logger.info(`Creating order with notes:`, JSON.stringify(orderNotes));
            
            // Create order in Razorpay (amount in paise)
            const result = await razorpay.createOrder({
                amount: Math.round(amount * 100), // Convert to paise
                currency: 'INR',
                receipt: orderId,
                notes: orderNotes
            });

            if (!result.success || !result.orderId) {
                return callback({
                    success: false,
                    error: result.error || 'Failed to create order'
                });
            }

            // Store mapping for webhook processing
            razorpay.storeOrderMapping(result.orderId, {
                userId: userId,
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName || '',
                credits: credits,
                amount: {
                    value: amount.toString(),
                    currencyCode: 'INR'
                },
                dbName: userInfo.dbName,
                id: orderId
            }, socket);

            logger.info(`Credit order created: ${result.orderId} for org ${userInfo.organizationId}`);

            return callback({
                success: true,
                orderId: result.orderId,
                order: result.order
            });

        } catch (error: any) {
            logger.error('Error creating credit order:', error);
            return callback({
                success: false,
                error: error.message || 'Failed to create order'
            });
        }
    });

    /**
     * Verify credit order payment
     */
    socket.on('razorpay:verify_credit_payment', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            // Support both Razorpay standard format (razorpay_*) and camelCase format
            const orderId = data.razorpay_order_id || data.orderId;
            const paymentId = data.razorpay_payment_id || data.paymentId;
            const signature = data.razorpay_signature || data.signature;
            
            if (!orderId || !paymentId || !signature) {
                logger.error('Missing required fields for credit payment verification:', { orderId: !!orderId, paymentId: !!paymentId, signature: !!signature });
                return callback({
                    success: false,
                    error: 'Missing required fields'
                });
            }

            const razorpay = getRazorpayService();

            // Verify signature
            const isValid = razorpay.verifyPaymentSignature({
                orderId,
                paymentId,
                signature
            });

            if (!isValid) {
                return callback({
                    success: false,
                    error: 'Invalid payment signature'
                });
            }

            // Get order mapping for credits
            const mapping = razorpay.getOrderMapping(orderId);
            if (!mapping) {
                return callback({
                    success: false,
                    error: 'Order not found'
                });
            }

            // Update organization credits
            const databaseService = DatabaseService.getInstance();
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgDbName = process.env.ORGANIZATION_DB;
            if (!orgDbName) {
                return callback({
                    success: false,
                    error: 'ORGANIZATION_DB not configured'
                });
            }

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

            // Get current credits
            const org = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });
            if (!org) {
                return callback({
                    success: false,
                    error: 'Organization not found'
                });
            }

            const currentCredits = org.metadata?.credits || 0;
            const newCredits = currentCredits + mapping.credits;

            // Record the credit transaction
            const creditTransaction = {
                id: mapping.id,
                orderId: orderId,
                paymentId: paymentId,
                credits: mapping.credits,
                amount: mapping.amount,
                status: 'completed',
                purchasedAt: new Date()
            };

            // Update credits
            await organizationRepository.updateOne(
                { OrganizationId: userInfo.organizationId },
                {
                    $set: {
                        'metadata.credits': newCredits
                    },
                    $push: {
                        'metadata.razorpay.creditTransactions': creditTransaction
                    } as any
                }
            );

            // Remove mapping after successful processing
            razorpay.removeOrderMapping(orderId);

            logger.info(`Credits added for org ${userInfo.organizationId}: ${mapping.credits} (total: ${newCredits})`);

            return callback({
                success: true,
                credits: mapping.credits,
                totalCredits: newCredits
            });

        } catch (error: any) {
            logger.error('Error verifying credit payment:', error);
            return callback({
                success: false,
                error: error.message || 'Verification failed'
            });
        }
    });

    /**
     * Cancel subscription
     */
    socket.on('razorpay:cancel_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            // Get organization's current subscription
            const databaseService = DatabaseService.getInstance();
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgDbName = process.env.ORGANIZATION_DB;
            if (!orgDbName) {
                return callback({
                    success: false,
                    error: 'ORGANIZATION_DB not configured'
                });
            }

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
            const org = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });

            if (!org?.metadata?.razorpay?.subscriptionId) {
                return callback({
                    success: false,
                    error: 'No active Razorpay subscription found'
                });
            }

            const razorpay = getRazorpayService();
            const { cancelAtCycleEnd = true } = data;

            // Cancel subscription in Razorpay
            const result = await razorpay.cancelSubscription(
                org.metadata.razorpay.subscriptionId,
                cancelAtCycleEnd
            );

            if (!result.success) {
                return callback({
                    success: false,
                    error: result.error || 'Failed to cancel subscription'
                });
            }

            // Update organization status
            await organizationRepository.updateOne(
                { OrganizationId: userInfo.organizationId },
                {
                    $set: {
                        'metadata.razorpay.status': cancelAtCycleEnd ? 'PENDING_CANCELLATION' : 'CANCELLED',
                        'metadata.razorpay.cancelledAt': new Date(),
                        'metadata.razorpay.cancelAtCycleEnd': cancelAtCycleEnd
                    }
                }
            );

            logger.info(`Subscription cancelled for org ${userInfo.organizationId}`);

            return callback({
                success: true,
                status: cancelAtCycleEnd ? 'PENDING_CANCELLATION' : 'CANCELLED'
            });

        } catch (error: any) {
            logger.error('Error cancelling subscription:', error);
            return callback({
                success: false,
                error: error.message || 'Failed to cancel subscription'
            });
        }
    });

    /**
     * Get subscription details
     */
    socket.on('razorpay:get_subscription_details', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            const databaseService = DatabaseService.getInstance();
            if (!databaseService.isConnected()) {
                await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
            }

            const orgDbName = process.env.ORGANIZATION_DB;
            if (!orgDbName) {
                return callback({
                    success: false,
                    error: 'ORGANIZATION_DB not configured'
                });
            }

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
            const org = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });

            if (!org?.metadata?.razorpay) {
                return callback({
                    success: true,
                    hasSubscription: false
                });
            }

            const razorpayMeta = org.metadata.razorpay;


            return callback({
                success: true,
                hasSubscription: true,
                subscription: {
                    id: razorpayMeta.subscriptionId,
                    subscriptionId: razorpayMeta.subscriptionId,
                    status: razorpayMeta.status,
                    plan_id: razorpayMeta.planId,
                    planId: razorpayMeta.planId,
                    current_start: razorpayMeta.currentStart,
                    current_end: razorpayMeta.currentEnd,
                    creditTransactions: razorpayMeta.creditTransactions || []
                }
            });

        } catch (error: any) {
            logger.error('Error getting subscription details:', error);
            return callback({
                success: false,
                error: error.message || 'Failed to get details'
            });
        }
    });
}
