import { Server, Socket } from 'socket.io';
import { PayPalService } from '../Services/PayPalService';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IPlan } from '../DataAccessLayer/models/Plans';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { IUserCredentials } from '../DataAccessLayer/models/UserCredentials';
import { UserInfo } from '../DataStructures';
import { initializeOrganizationDatabase } from '../Services/AuthTokenService';
import { v4 as uuidv4 } from 'uuid';
/**
 * PayPal Socket Handler
 * Exposes PayPal subscription and plan management endpoints to clients via Socket.IO
 */
import { getPayPalService } from '../Services/PayPalService';
import { PlanInfo } from '../model/Plans';
import * as dotenv from "dotenv";
import { getDBService } from '../DataAccessLayer/db-connection';
import { createLogger } from '../utils/Logger';

const logger = createLogger('PayPalHandler');

dotenv.config();
export async function paypal_handler(io: Server, socket: Socket) {
    socket.on('paypal:check_active_plan', async (data: any, callback: (result: any) => void) => {
        try {
            // PAYWALL KILL-SWITCH: if DISABLE_PAYWALL=true in .env, always return active
            if (process.env.DISABLE_PAYWALL === 'true') {
                return callback({
                    success: true,
                    isActive: true,
                    status: 'ACTIVE',
                    subscriptionId: null,
                    expiresAt: null,
                    provider: 'disabled'
                });
            }
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

            // Get user credentials to check user's country code
            const userCredentialDb = process.env.USER_CREDENTIAL_DB;
            const userCredentialCollection = process.env.USER_CREDENTIAL_COLLECTION;
            if (!userCredentialDb || !userCredentialCollection) {
                return callback({
                    success: false,
                    error: 'USER_CREDENTIAL_DB or USER_CREDENTIAL_COLLECTION not configured'
                });
            }

            await databaseService.ensureDatabase(userCredentialDb);
            await databaseService.ensureCollection<IUserCredentials>(userCredentialDb, userCredentialCollection);

            const userCredentialsRepository = databaseService.getRepository<IUserCredentials>(userCredentialDb, userCredentialCollection);
            const userCredentials = await userCredentialsRepository.findOne({ userId: userId });

            if (!userCredentials) {
                return callback({
                    success: false,
                    error: 'User credentials not found'
                });
            }

            // Get country code from user's metadata (not organization's creator)
            const userCountryCode = userCredentials.metadata?.geoIP?.countryCode;
            const provider = (userCountryCode === 'IN') ? 'razorpay' : 'paypal';
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
            const organization = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });

            if (!organization) {
                return callback({
                    success: false,
                    error: 'Organization not found'
                });
            }

            const creatorCountryCode = organization.metadata?.creatorGeoIP?.countryCode;

            // Check Razorpay subscription for Indian users
            if (creatorCountryCode === 'IN') {
                const razorpayMeta = organization.metadata?.razorpay;
                if (razorpayMeta?.subscriptionId) {
                    let isActive = razorpayMeta.status === 'ACTIVE' || razorpayMeta.status === 'AUTHENTICATED';
                    let expiresAt = null;

                    if (razorpayMeta.trialEndDate) {
                        expiresAt = razorpayMeta.trialEndDate;
                        const now = Date.now();
                        if (new Date(expiresAt).getTime() > now) {
                            isActive = true;
                        }
                    }

                    return callback({
                        success: true,
                        isActive,
                        status: razorpayMeta.status || null,
                        subscriptionId: razorpayMeta.subscriptionId,
                        expiresAt,
                        provider: 'razorpay'
                    });
                }
                // If no Razorpay subscription, user needs to subscribe
                if (razorpayMeta) {
                    return callback({
                        success: true,
                        isActive: false,
                        status: null,
                        subscriptionId: null,
                        expiresAt: null,
                        provider: provider,
                        needsSubscription: true
                    });
                }
            }

            // Check PayPal subscription for non-Indian users
            const paypalMeta = organization.metadata?.paypal;
            let isActive = paypalMeta?.status === 'ACTIVE';
            let expiresAt = null;
            if (paypalMeta?.subscription?.billingInfo?.nextBillingTime) {
                expiresAt = paypalMeta.subscription.billingInfo.nextBillingTime;
                const now = Date.now();
                if (new Date(expiresAt).getTime() > now) {
                    isActive = true;
                }
            }
            return callback({
                success: true,
                isActive,
                status: paypalMeta?.status || null,
                subscriptionId: paypalMeta?.subscriptionId || null,
                expiresAt,
                provider: provider
            });
        } catch (error: any) {
            return callback({
                success: false,
                error: error.message || 'Failed to check active plan'
            });
        }
    });
    // Get PayPal service singleton instance
    const paypalService = getPayPalService();
    socket.on('paypal:create_plan', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Create plan request received');
            const result = await paypalService.createPlan(data);
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error creating plan:', error);
            callback({
                success: false,
                error: error.message || 'Failed to create plan'
            });
        }
    });

    socket.on('paypal:list_plans', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: List plans request received');
            const result = await paypalService.listPlans(data);
            let dbService = await getDBService();
            let planHanlder = await dbService.getRepository<PlanInfo>('General', 'PlanConstraints');
            let plans = await planHanlder.find();
            // let finalPlans=[];
            // for(let plan of plans)
            // {
            //     finalPlans.push({
            //         planName: plan.planName,
            //         AllowedWorkspaces:plan.constraints.WorkspaceConstraints.numberOfWorkspaces,
            //         AllowedTasks: plan.constraints.TotalTasks.numberOfTasks,
            //         AllowedTeamMembers: plan.constraints.TeamMembers.maxTeamMembers,
            //         credits: plan.constraints.subscriptionCredits
            //     });
            // }
            let finResult = {
                success: true,
                constraints: plans,
                plans: result.plans
            }
            // if (result.success && result.plans && Array.isArray(result.plans)) {
            //     try {
            //         const enrichedPlans = result.plans.map((plan: any) => {
            //             const rawName = (plan.name || plan.product_name || '').toString().trim();
            //             const nameLower = rawName.toLowerCase();

            //             const matchKey = Object.keys(Plans).find(k => {
            //                 const kLower = k.toLowerCase();
            //                 return kLower === nameLower || nameLower.includes(kLower) || kLower.includes(nameLower);
            //             });

            //             if (matchKey) {
            //                 return {
            //                     ...plan,
            //                     metadata: Plans[matchKey]
            //                 };
            //             }

            //             return plan;
            //         });

            //         result.plans = enrichedPlans;
            //     } catch (error: any) {
            //         console.error('Error enriching plans with local Plans mapping:', error);
            //     }
            // }
            callback(finResult);
        } catch (error: any) {
            logger.error('PayPal: Error listing plans:', error);
            callback({
                success: false,
                error: error.message || 'Failed to list plans'
            });
        }
    });

    socket.on('paypal:get_plan', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Get plan request received for:', data.planId);
            if (!data.planId) {
                return callback({
                    success: false,
                    error: 'planId is required'
                });
            }
            const result = await paypalService.showPlanDetails(data.planId);
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error getting plan details:', error);
            callback({
                success: false,
                error: error.message || 'Failed to get plan details'
            });
        }
    });

    socket.on('paypal:create_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Create subscription request received');
            if (!data.planId) {
                return callback({
                    success: false,
                    error: 'planId is required'
                });
            }

            // Get current user and organization information
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId || !userInfo.organizationName) {
                return callback({
                    success: false,
                    error: 'User organization information not found'
                });
            }

            // Check if the plan has a free trial
            const planResult = await paypalService.showPlanDetails(data.planId);
            if (planResult.success && planResult.plan) {
                // Check if plan has trial billing cycles
                const billingCycles = planResult.plan.billing_cycles || planResult.plan.billingCycles;
                if (billingCycles && Array.isArray(billingCycles)) {
                    const hasTrialCycle = billingCycles.some((cycle: any) => {
                        const tenureType = cycle.tenure_type || cycle.tenureType;
                        const tenureTypeUpper = String(tenureType).toUpperCase();
                        return tenureType === 'TRIAL' ||
                            tenureType === 'Trial' ||
                            tenureType === 'trial' ||
                            tenureTypeUpper === 'TRIAL';
                    });

                    // If plan has a free trial, check if organization has already used one
                    if (hasTrialCycle) {
                        logger.info(`Plan ${data.planId} has a free trial. Checking organization trial usage...`);

                        const { organizationHandler } = await initializeOrganizationDatabase();
                        const organization = await organizationHandler.findOne({
                            OrganizationName: userInfo.organizationName
                        });

                        if (organization && organization.metadata?.isTrialUsed === true) {
                            logger.info(`Organization ${userInfo.organizationName} has already used a free trial`);
                            return callback({
                                success: false,
                                error: 'FREE_TRIAL_ALREADY_USED',
                                message: 'Free trial already used for this organization. Only one free trial per organization is allowed.'
                            });
                        }
                    }
                }
            }

            // Create subscription
            const result = await paypalService.createSubscription(data);

            // If subscription was created successfully, store the mapping with socket
            if (result.success && result.subscriptionId) {
                paypalService.storeSubscriptionMapping(result.subscriptionId, {
                    userId: userId,
                    organizationId: userInfo.organizationId,
                    organizationName: userInfo.organizationName,
                    dbName: userInfo.dbName
                }, socket);
                logger.info(`Stored subscription mapping for ${result.subscriptionId} -> Organization: ${userInfo.organizationName}, Socket: ${socket.id}`);
            }

            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error creating subscription:', error);
            callback({
                success: false,
                error: error.message || 'Failed to create subscription'
            });
        }
    });

    socket.on('paypal:list_subscriptions', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: List subscriptions request received');
            const result = await paypalService.listSubscriptions(data);
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error listing subscriptions:', error);
            callback({
                success: false,
                error: error.message || 'Failed to list subscriptions'
            });
        }
    });

    socket.on('paypal:get_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            let subscriptionId = data.subscriptionId;

            // Get userId early
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            // If subscriptionId is not provided, get it from organization metadata
            if (!subscriptionId) {
                console.log('PayPal: Subscription ID not provided, fetching from organization metadata');

                const userInfo = UserInfo.get(userId);
                if (!userInfo || !userInfo.organizationId || !userInfo.organizationName) {
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
                        error: 'ORGANIZATION_DB environment variable is not set'
                    });
                }

                await databaseService.ensureDatabase(orgDbName);
                await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

                const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

                // Find the organization
                const organization = await organizationRepository.findOne({
                    OrganizationId: userInfo.organizationId
                });

                if (!organization) {
                    return callback({
                        success: false,
                        error: 'Organization not found'
                    });
                }

                // Get subscriptionId from metadata.paypal
                if (organization.metadata?.paypal?.subscriptionId) {
                    subscriptionId = organization.metadata.paypal.subscriptionId;
                    logger.info(`Found subscription ID from organization metadata: ${subscriptionId}`);
                } else {
                    return callback({
                        success: false,
                        error: 'No subscription found for this organization. Please provide subscriptionId or activate a subscription first.'
                    });
                }
            }

            logger.info('PayPal: Get subscription request received for:', subscriptionId);

            const result = await paypalService.showSubscriptionDetails(
                subscriptionId,
                data.fields || "*" //get all fields if not specified,
            );

            // ===== TEMPORARY: Check if organization creator is from India (IN) and add flag =====
            // TODO: Remove this temporary workaround once proper plan is in place
            try {
                const userInfo = UserInfo.get(userId);
                if (userInfo?.organizationId) {
                    const databaseService = DatabaseService.getInstance();
                    if (!databaseService.isConnected()) {
                        await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
                    }

                    const orgDbName = process.env.ORGANIZATION_DB;
                    if (orgDbName) {
                        await databaseService.ensureDatabase(orgDbName);
                        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
                        const organization = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });

                        if (organization?.metadata?.creatorGeoIP?.countryCode === 'IN') {
                            (result as any).isIn = true;
                            console.log(`[TEMPORARY] Added isIn flag for Indian organization ${organization.OrganizationId}`);
                        }
                    }
                }
            } catch (geoCheckError: any) {
                console.error('Error checking organization country code:', geoCheckError);
            }
            // ===== END TEMPORARY =====

            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error getting subscription details:', error);
            callback({
                success: false,
                error: error.message || 'Failed to get subscription details'
            });
        }
    });

    socket.on('paypal:revise_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Revise subscription request received for:', data.subscriptionId);
            if (!data.subscriptionId) {
                return callback({
                    success: false,
                    error: 'subscriptionId is required'
                });
            }
            const { subscriptionId, ...revisionData } = data;
            const result = await paypalService.reviseSubscription(subscriptionId, revisionData);
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error revising subscription:', error);
            callback({
                success: false,
                error: error.message || 'Failed to revise subscription'
            });
        }
    });

    socket.on('paypal:suspend_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Suspend subscription request received for:', data.subscriptionId);
            if (!data.subscriptionId) {
                return callback({
                    success: false,
                    error: 'subscriptionId is required'
                });
            }
            const result = await paypalService.suspendSubscription(
                data.subscriptionId,
                data.reason
            );
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error suspending subscription:', error);
            callback({
                success: false,
                error: error.message || 'Failed to suspend subscription'
            });
        }
    });

    socket.on('paypal:cancel_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Cancel subscription request received for:', data.subscriptionId);
            if (!data.subscriptionId) {
                return callback({
                    success: false,
                    error: 'subscriptionId is required'
                });
            }
            const result = await paypalService.cancelSubscription(
                data.subscriptionId,
                data.reason
            );
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error cancelling subscription:', error);
            callback({
                success: false,
                error: error.message || 'Failed to cancel subscription'
            });
        }
    });

    socket.on('paypal:activate_subscription', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Activate subscription request received for:', data.subscriptionId);
            if (!data.subscriptionId) {
                return callback({
                    success: false,
                    error: 'subscriptionId is required'
                });
            }
            const result = await paypalService.activateSubscription(
                data.subscriptionId,
                data.reason
            );
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error activating subscription:', error);
            callback({
                success: false,
                error: error.message || 'Failed to activate subscription'
            });
        }
    });

    socket.on('paypal:capture_payment', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Capture payment request received for:', data.subscriptionId);
            if (!data.subscriptionId) {
                return callback({
                    success: false,
                    error: 'subscriptionId is required'
                });
            }
            if (!data.note || !data.amount) {
                return callback({
                    success: false,
                    error: 'note and amount are required'
                });
            }
            const { subscriptionId, ...captureData } = data;
            const result = await paypalService.captureAuthorizedPayment(subscriptionId, captureData);
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error capturing payment:', error);
            callback({
                success: false,
                error: error.message || 'Failed to capture payment'
            });
        }
    });

    socket.on('paypal:get_subscription_transactions', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Get subscription transactions request received for:', data.subscriptionId);
            if (!data.subscriptionId) {
                return callback({
                    success: false,
                    error: 'subscriptionId is required'
                });
            }
            if (!data.startTime || !data.endTime) {
                return callback({
                    success: false,
                    error: 'startTime and endTime are required'
                });
            }
            const result = await paypalService.getSubscriptionTransactions(data.subscriptionId, {
                startTime: data.startTime,
                endTime: data.endTime
            });
            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error getting subscription transactions:', error);
            callback({
                success: false,
                error: error.message || 'Failed to get subscription transactions'
            });
        }
    });

    //==============ORDER MANAGEMENT HANDLERS==============
    //handler for creating PayPal order for purchasing credits
    socket.on('paypal:create_order', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Create order request received');

            if (!data.organizationId || !data.userId || !data.credits || !data.amount) {
                return callback({
                    success: false,
                    error: 'Missing required fields: organizationId, userId, credits, amount'
                });
            }

            const userId = socket.data.user?.userId;
            if (!userId || userId !== data.userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated or userId mismatch'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || userInfo.organizationId !== data.organizationId) {
                return callback({
                    success: false,
                    error: 'Organization access denied'
                });
            }

            const uniqueOrderId = uuidv4();
            const baseUrl = process.env.PAYPAL_RETURN_BASE_URL || process.env.APP_URL;
            const returnUrl = `${baseUrl}/paypal/order?id=${uniqueOrderId}`;
            const cancelUrl = `${baseUrl}/paypal/order/cancel?id=${uniqueOrderId}`;

            const result = await paypalService.createOrder({
                amount: {
                    currencyCode: data.amount.currencyCode || 'USD',
                    value: data.amount.value
                },
                description: `Purchase ${data.credits} credits for organization ${userInfo.organizationName}`,
                returnUrl: returnUrl,
                cancelUrl: cancelUrl
            });

            if (result.success && result.orderId) {
                paypalService.storeOrderMapping(result.orderId, {
                    userId: userId,
                    organizationId: data.organizationId,
                    organizationName: userInfo.organizationName,
                    credits: data.credits,
                    amount: {
                        value: data.amount.value,
                        currencyCode: data.amount.currencyCode || 'USD'
                    },
                    dbName: userInfo.dbName || process.env.ORGANIZATION_DB || '',
                    id: uniqueOrderId
                }, socket);

                const approvalLink = result.links?.find((l: any) => l.rel === 'approve')?.href;

                logger.info(`Order created - PayPal ID: ${result.orderId}, Credits: ${data.credits}, Socket: ${socket.id}`);

                return callback({
                    success: true,
                    orderId: result.orderId,
                    approvalLink: approvalLink,
                    links: result.links
                });
            } else {
                return callback({
                    success: false,
                    error: result.error || 'Failed to create order'
                });
            }
        } catch (error: any) {
            logger.error('PayPal: Error creating order:', error);
            return callback({
                success: false,
                error: error.message || 'Failed to create order'
            });
        }
    });


    socket.on('paypal:get_order', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Get order request received for:', data.orderId);

            if (!data.orderId) {
                return callback({
                    success: false,
                    error: 'orderId is required'
                });
            }

            //Get latest order details from PayPal
            const result = await paypalService.getOrderDetails(data.orderId);

            //Add our tracking info if available
            const orderMapping = paypalService.getOrderMapping(data.orderId);
            if (result.success && orderMapping) {
                result.order.credits = orderMapping.credits;
                result.order.organizationId = orderMapping.organizationId;
                result.order.organizationName = orderMapping.organizationName;
            }

            callback(result);
        } catch (error: any) {
            logger.error('PayPal: Error getting order details:', error);
            callback({
                success: false,
                error: error.message || 'Failed to get order details'
            });
        }
    });


    socket.on('get_credits', async (data: any, callback: (result: any) => void) => {
        try {
            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    total: 0,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || !userInfo.organizationId) {
                return callback({
                    success: false,
                    total: 0,
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
                    total: 0,
                    error: 'ORGANIZATION_DB not configured'
                });
            }

            await databaseService.ensureDatabase(orgDbName);
            await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
            const organization = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });

            if (!organization) {
                return callback({
                    success: false,
                    total: 0,
                    error: 'Organization not found'
                });
            }

            const credits = organization.metadata?.credits || 0;
            let subscriptionCredits = 0;
            let planId = organization.metadata?.paypal?.planId || organization.metadata?.paypal?.subscription?.planId || organization.metadata?.razorpay?.planId || organization.metadata?.razorpay?.subscription?.planId;
            if (!planId) {
                const maxA = 20; 
                const poll = 500; 
                for (let a = 0; a < maxA; a++) {
                    await new Promise(resolve => setTimeout(resolve, poll));
                    const updatedOrg = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });
                    if (updatedOrg) {
                        planId = updatedOrg.metadata?.paypal?.planId || 
                                 updatedOrg.metadata?.paypal?.subscription?.planId || 
                                 updatedOrg.metadata?.razorpay?.planId || 
                                 updatedOrg.metadata?.razorpay?.subscription?.planId;
                        
                        if (planId) {
                            break; 
                        }
                    }
                }
                if (!planId) {
                    return callback({
                        success: false,
                        total: 0,
                        error: 'PlanId not found'
                    });
                }
            }
            
            if (planId) {
                try {
                    const dbService = await getDBService();
                    const planHandler = dbService.getRepository<PlanInfo>('General', 'PlanConstraints');
                    const planConstraints = await planHandler.findOne({ planId: planId });
                    subscriptionCredits = planConstraints?.constraints?.subscriptionCredits || 0;
                } catch (planError: any) {
                    logger.warn('Error fetching plan constraints:', planError);
                }
            }
            const total = subscriptionCredits + credits;

            callback({
                success: true,
                total: total
            });
        } catch (error: any) {
            logger.error('Error getting credits:', error);
            callback({
                success: false,
                total: 0,
                error: error.message || 'Failed to get credits'
            });
        }
    });

    //Handler for getting organization credits (detailed version)
    socket.on('paypal:get_credits', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Get credits request received');

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

            await databaseService.ensureDatabase(orgDbName);
            await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
            const organization = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });

            if (!organization) {
                return callback({
                    success: false,
                    error: 'Organization not found'
                });
            }

            // Get credits from top-ups (payment captures)
            const credits = organization.metadata?.credits || 0;

            // Get subscription credits from plan constraints
            let subscriptionCredits = 0;
            let planId = organization.metadata?.paypal?.planId || organization.metadata?.razorpay?.planId;

            // If planId is undefined, poll for it asynchronously (non-blocking)
            // This allows multiple requests to be processed in parallel
            if (!planId) {
                const maxAttempts = 20; // 10 seconds total (20 * 0.5s)
                const pollInterval = 500; // 0.5 seconds in milliseconds
                
                // Non-blocking polling: setTimeout allows event loop to process other tasks
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    // Yield to event loop - allows other operations to run in parallel
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    
                    // Re-fetch organization to get latest metadata (non-blocking DB query)
                    const updatedOrg = await organizationRepository.findOne({ OrganizationId: userInfo.organizationId });
                    if (updatedOrg) {
                        planId = updatedOrg.metadata?.paypal?.planId || updatedOrg.metadata?.razorpay?.planId;
                        
                        if (planId) {
                            logger.info(`PlanId found after ${(attempt + 1) * 0.5} seconds of polling`);
                            break; // Exit early when found
                        }
                    }
                }
                
                if (!planId) {
                    logger.warn(`PlanId not found after ${maxAttempts * 0.5} seconds of polling, proceeding without subscription credits`);
                }
            }

            if (planId) {
                try {
                    const dbService = await getDBService();
                    const planHandler = dbService.getRepository<PlanInfo>('General', 'PlanConstraints');
                    const planConstraints = await planHandler.findOne({ planId: planId });
                    subscriptionCredits = planConstraints?.constraints?.subscriptionCredits || 0;
                } catch (planError: any) {
                    logger.warn('Error fetching plan constraints:', planError);
                }
            }

            // Total credits shown to UI = subscriptionCredits + credits (top-ups)
            const totalCredits = subscriptionCredits + credits;

            const transactions = organization.metadata?.paypal?.creditTransactions || [];

            callback({
                success: true,
                organizationId: userInfo.organizationId,
                organizationName: userInfo.organizationName,
                credits: totalCredits,
                subscriptionCredits: subscriptionCredits,
                topUpCredits: credits,
                totalTransactions: transactions.length,
                recentTransactions: transactions.slice(-10).reverse() //Last 10 transactions
            });
        } catch (error: any) {
            logger.error('PayPal: Error getting credits:', error);
            callback({
                success: false,
                error: error.message || 'Failed to get credits'
            });
        }
    });

    //Handler for deducting credits (for task execution)
    socket.on('paypal:deduct_credits', async (data: any, callback: (result: any) => void) => {
        try {
            logger.info('PayPal: Deduct credits request received');

            if (!data.credits || !data.organizationId) {
                return callback({
                    success: false,
                    error: 'credits and organizationId are required'
                });
            }

            const userId = socket.data.user?.userId;
            if (!userId) {
                return callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }

            const userInfo = UserInfo.get(userId);
            if (!userInfo || userInfo.organizationId !== data.organizationId) {
                return callback({
                    success: false,
                    error: 'Organization access denied'
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

            await databaseService.ensureDatabase(orgDbName);
            await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

            const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);
            const organization = await organizationRepository.findOne({ OrganizationId: data.organizationId });

            if (!organization) {
                return callback({
                    success: false,
                    error: 'Organization not found'
                });
            }

            const currentCredits = organization.metadata?.credits || 0;

            if (currentCredits < data.credits) {
                return callback({
                    success: false,
                    error: `Insufficient credits. Available: ${currentCredits}, Required: ${data.credits}`
                });
            }

            //Deduct credits
            const metadata = organization.metadata || {};
            metadata.credits = currentCredits - data.credits;

            if (!metadata.paypal) {
                metadata.paypal = {};
            }

            if (!metadata.paypal.creditTransactions) {
                metadata.paypal.creditTransactions = [];
            }

            metadata.paypal.creditTransactions.push({
                credits: -data.credits,
                previousBalance: currentCredits,
                newBalance: currentCredits - data.credits,
                reason: data.reason || 'Task execution',
                timestamp: new Date(),
                type: 'deduction'
            });

            await organizationRepository.updateOne(
                { OrganizationId: data.organizationId },
                { $set: { metadata } }
            );

            logger.info(`Deducted ${data.credits} credits from organization ${data.organizationId}. New balance: ${currentCredits - data.credits}`);

            //Emit credits updated event
            socket.emit('paypal:credits_updated', {
                organizationId: data.organizationId,
                credits: currentCredits - data.credits,
                change: -data.credits
            });

            callback({
                success: true,
                message: `Deducted ${data.credits} credits`,
                previousBalance: currentCredits,
                newBalance: currentCredits - data.credits
            });
        } catch (error: any) {
            logger.error('PayPal: Error deducting credits:', error);
            callback({
                success: false,
                error: error.message || 'Failed to deduct credits'
            });
        }
    });
}
