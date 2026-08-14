import { Document, ObjectId } from 'mongodb';

/**
 * Interface for tracking subscription usage in the SUBSCRIPTION_INFO collection
 * Used to prevent abuse of free trial subscriptions by tracking payer emails
 * Supports both PayPal and Razorpay payment providers
 */
export interface ISubscriptionInfo extends Document {
    _id?: ObjectId;
    
    // Payer email address (unique identifier for free trial tracking)
    payerEmail: string;
    
    // PayPal payer ID or Razorpay customer ID
    payerId?: string;
    
    // Plan ID that was used for the subscription
    planId: string;
    
    // Plan name for reference
    planName?: string;
    
    // Subscription ID from PayPal or Razorpay
    subscriptionId: string;
    
    // Organization that used this subscription
    organizationId: string;
    organizationName?: string;
    
    // When the subscription was activated
    activatedAt: Date;
    
    // Type of subscription usage
    usageType: 'free_trial' | 'subscription' | 'credit_purchase';
    
    // Payment provider
    provider?: 'paypal' | 'razorpay';
    
    // Whether the subscription is still active
    isActive: boolean;
    
    // When the subscription was cancelled (if applicable)
    cancelledAt?: Date;
    
    // Webhook event that triggered this record
    webhookEventId?: string;
    
    // Any additional metadata
    metadata?: Record<string, any>;
}
