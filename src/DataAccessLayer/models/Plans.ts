import { Document, ObjectId } from 'mongodb';


export interface IPlan extends Document {
    _id?: ObjectId;
    
    planId: string; 
    
    productId?: string; 
    name?: string;
    description?: string;   
    status?: string;
    
    billingCycles?: Array<{
        frequency?: {
            intervalUnit?: string;
            intervalCount?: number;
        };
        tenureType?: string; 
        sequence?: number;
        totalCycles?: number;
        pricingScheme?: {
            fixedPrice?: {
                value?: string;
                currencyCode?: string;
            };
            tieredPricing?: any;
        };
    }>;
    
    paymentPreferences?: {
        autoBillOutstanding?: boolean;
        setupFee?: {
            value?: string;
            currencyCode?: string;
        };
            setupFeeFailureAction?: string; 
        paymentFailureThreshold?: number;
    };
    
    taxes?: {
        percentage?: string;
        inclusive?: boolean;
    };

    createTime?: string; 
    updateTime?: string; 
    
    links?: Array<{
        href?: string;
        rel?: string;
        method?: string;
    }>;
    
    webhookEventId?: string;
    webhookEventTime?: string; 
    
    active?: boolean;   
    
    paypalResource?: Record<string, any>; 

    metadata?: Record<string, any>;
}