import { Document, ObjectId } from 'mongodb';
import { AggregationPeriod } from './aggregatedMetrics';

/**
 * Breakdown for individual task costs
 */
export interface TaskCostBreakdown {
    taskId: string;
    llmCost: number;
    ec2Cost: number;
    netCost: number;
    
    // Additional details
    llmDetails?: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheWriteTokens: number;
        totalCacheReadTokens: number;
        requestCount: number;
        modelIds: string[];
    };
    
    ec2Details?: {
        totalUsageTime: number;  // in minutes
        instanceCount: number;
        uniqueInstances: string[];
        ec2Types: string[];
    };
}

/**
 * Breakdown for individual workspace costs
 */
export interface WorkspaceCostBreakdown {
    wpId: string;
    llmCost: number;
    ec2Cost: number;
    netCost: number;
    
    // Additional details
    llmDetails?: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheWriteTokens: number;
        totalCacheReadTokens: number;
        requestCount: number;
        modelIds: string[];
    };
    
    ec2Details?: {
        totalUsageTime: number;  // in minutes
        instanceCount: number;
        uniqueInstances: string[];
        ec2Types: string[];
    };
}

/**
 * User Metrics Aggregation Schema
 * Aggregates costs from Task_Workspace_Cost_Aggregation grouped by userId
 */
export interface UserMetricsAggregation extends Document {
    _id: ObjectId;
    
    // Aggregation period
    aggregationPeriod: AggregationPeriod;
    userName:string;
    // User identification
    userId: string;
    organizationId: string;
    
    // Total aggregated costs
    totalLLMCost: number;
    totalEC2Cost: number;
    totalNetCost: number;
    
    // Counts
    taskCount: number;
    workspaceCount: number;
    
    // Detailed breakdowns
    taskBreakdown: TaskCostBreakdown[];
    workspaceBreakdown: WorkspaceCostBreakdown[];
    
    // Overall aggregated details
    aggregatedLLMDetails: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheWriteTokens: number;
        totalCacheReadTokens: number;
        totalRequests: number;
        uniqueModelIds: string[];
    };
    
    aggregatedEC2Details: {
        totalUsageTime: number;  // in minutes
        totalInstanceCount: number;
        uniqueInstances: string[];
        uniqueEC2Types: string[];
    };
    
    // Metadata
    createdAt: Date;
    updatedAt: Date;
}
