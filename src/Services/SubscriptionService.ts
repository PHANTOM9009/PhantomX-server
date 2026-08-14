import { Socket } from 'socket.io';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { UserInfo } from '../DataStructures';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Supported payment providers
 */
export type PaymentProvider = 'paypal' | 'razorpay' | 'none';

/**
 * Subscription check result
 */
export interface SubscriptionCheckResult {
    success: boolean;
    provider?: PaymentProvider;
    error?: {
        code: number;
        message: string;
    };
}

/**
 * Get the active payment provider for an organization
 * @param organization - The organization document
 * @returns The active payment provider or 'none'
 */
export function getActivePaymentProvider(organization: IOrganization): PaymentProvider {
    // Check Razorpay first (for Indian users)
    const razorpayMeta = organization.metadata?.razorpay;
    if (razorpayMeta?.subscriptionId && razorpayMeta?.status) {
        const activeStatuses = ['ACTIVE', 'AUTHENTICATED', 'PENDING'];
        if (activeStatuses.includes(razorpayMeta.status.toUpperCase())) {
            return 'razorpay';
        }
        // Check if subscription is still valid based on current_end date
        if (razorpayMeta.currentEnd) {
            const endDate = new Date(razorpayMeta.currentEnd);
            if (endDate.getTime() > Date.now()) {
                return 'razorpay';
            }
        }
    }

    // Check PayPal
    const paypalMeta = organization.metadata?.paypal;
    if (paypalMeta?.subscriptionId && paypalMeta?.status) {
        const activeStatuses = ['ACTIVE', 'APPROVED'];
        if (activeStatuses.includes(paypalMeta.status.toUpperCase())) {
            return 'paypal';
        }
        // Check if subscription is still valid based on nextBillingTime
        if (paypalMeta.subscription?.billingInfo?.nextBillingTime) {
            const nextBillingTime = new Date(paypalMeta.subscription.billingInfo.nextBillingTime);
            if (nextBillingTime.getTime() > Date.now()) {
                return 'paypal';
            }
        }
    }

    return 'none';
}

/**
 * Check if the user's organization has an active subscription (PayPal or Razorpay)
 * @param socket Socket.IO socket instance
 * @returns Object with success status and optional error information
 */
export async function checkSubscription(socket: Socket): Promise<SubscriptionCheckResult> {
    try {
        // Get user ID from socket
        const userId = socket.data.user?.userId;
        if (!userId) {
            return {
                success: false,
                error: {
                    code: 401,
                    message: 'User not authenticated'
                }
            };
        }

        // Get user info to access organization details
        const userInfo = UserInfo.get(userId);
        if (!userInfo || !userInfo.organizationId || !userInfo.organizationName) {
            return {
                success: false,
                error: {
                    code: 404,
                    message: 'User organization information not found'
                }
            };
        }

        // Get database service
        const databaseService = DatabaseService.getInstance();
        
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            return {
                success: false,
                error: {
                    code: 500,
                    message: 'ORGANIZATION_DB environment variable is not set'
                }
            };
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        // Find the organization
        const organization = await organizationRepository.findOne({ 
            OrganizationId: userInfo.organizationId 
        });

        if (!organization) {
            return {
                success: false,
                error: {
                    code: 404,
                    message: 'Organization not found'
                }
            };
        }

        // Get active payment provider
        const provider = getActivePaymentProvider(organization);

        if (provider === 'none') {
            return {
                success: false,
                provider: 'none',
                error: {
                    code: 410,
                    message: 'You dont have any active subscription. Please contact your admin'
                }
            };
        }

        return {
            success: true,
            provider: provider
        };

    } catch (error: any) {
        console.error('Error checking subscription:', error);
        return {
            success: false,
            error: {
                code: 500,
                message: 'Internal server error while checking subscription'
            }
        };
    }
}

/**
 * Check subscription status without socket (for webhook handlers)
 * @param organizationId - The organization ID to check
 * @returns Subscription check result
 */
export async function checkSubscriptionByOrgId(organizationId: string): Promise<SubscriptionCheckResult> {
    try {
        const databaseService = DatabaseService.getInstance();
        
        if (!databaseService.isConnected()) {
            await databaseService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
        }

        const orgDbName = process.env.ORGANIZATION_DB;
        if (!orgDbName) {
            return {
                success: false,
                error: {
                    code: 500,
                    message: 'ORGANIZATION_DB environment variable is not set'
                }
            };
        }

        await databaseService.ensureDatabase(orgDbName);
        await databaseService.ensureCollection<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organizationRepository = databaseService.getRepository<IOrganization>(orgDbName, CollectionNames.ORGANIZATIONS);

        const organization = await organizationRepository.findOne({ 
            OrganizationId: organizationId 
        });

        if (!organization) {
            return {
                success: false,
                error: {
                    code: 404,
                    message: 'Organization not found'
                }
            };
        }

        const provider = getActivePaymentProvider(organization);

        if (provider === 'none') {
            return {
                success: false,
                provider: 'none',
                error: {
                    code: 410,
                    message: 'No active subscription found'
                }
            };
        }

        return {
            success: true,
            provider: provider
        };

    } catch (error: any) {
        console.error('Error checking subscription by org ID:', error);
        return {
            success: false,
            error: {
                code: 500,
                message: 'Internal server error while checking subscription'
            }
        };
    }
}
