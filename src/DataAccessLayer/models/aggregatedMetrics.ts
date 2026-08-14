import { Document, ObjectId } from 'mongodb';

/**
 * Type for indicating what field was used for grouping
 */
export type GroupedByType = 'TaskId' | 'wpId';

/**
 * Aggregation period definition
 */
export interface AggregationPeriod {
    startDate: Date;
    endDate: Date;
}

/**
 * Base interface for aggregated metrics
 */
export interface BaseAggregatedMetrics extends Document {
    _id: ObjectId;
    aggregationPeriod: AggregationPeriod;
    groupedBy: GroupedByType;
    groupedId: string;  // The actual TaskId or wpId value
    groupedName:string; // name of the task or the wp
    userName:string;
    // User and organization for reference/filtering
    userId: string;
    organizationId: string;
    
    // Metadata
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Aggregated LLM Metrics Schema
 */
export interface LLMMetricsAggregation extends BaseAggregatedMetrics {
    // Aggregated cost data
    totalCost: number;
    
    // Token usage aggregations
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheWriteTokens: number;
    totalCacheReadTokens: number;
    
    // Request count
    requestCount: number;
    
    // Additional metadata
    modelIds: string[];  // List of unique model IDs used
    firstTimestamp: Date;  // First request timestamp
    lastTimestamp: Date;   // Last request timestamp
}

/**
 * Aggregated EC2 Metrics Schema
 */
export interface EC2MetricsAggregation extends BaseAggregatedMetrics {
    // Aggregated cost data
    totalCost: number;
    
    // Usage aggregations
    totalUsageTime: number;  // in minutes
    
    // Instance tracking
    instanceCount: number;  // Number of tracking records
    uniqueInstances: string[];  // List of unique EC2 instance IDs
    ec2Types: string[];  // List of EC2 types used
    
    // Additional metadata
    firstTimestamp: Date;
    lastTimestamp: Date;
}
