import { Document, ObjectId } from 'mongodb';
import { GroupedByType, AggregationPeriod } from './aggregatedMetrics';

/**
 * Combined Task and Workspace Cost Aggregation Schema
 * Combines LLM and EC2 costs for a unified view
 */
export interface TaskWorkspaceCostAggregation extends Document {
    _id: ObjectId;
    
    // Aggregation period
    aggregationPeriod: AggregationPeriod;
    name:string; //either task Name or wpName
    // Grouping info (from LLM/EC2 aggregations)
    groupedBy: GroupedByType;  // 'TaskId' or 'wpId'
    groupedId: string;  // The actual TaskId or wpId value
    
    // User and organization for reference/filtering
    userId: string;
    organizationId: string;
    userName:string;
    groupedName:string;
    // Combined costs (MAIN DATA)
    llmCost: number;    // Total LLM cost from LLM_Metrics_Aggregation
    ec2Cost: number;    // Total EC2 cost from EC2_Metrics_Aggregation
    netCost: number;    // llmCost + ec2Cost
    
    // Breakdown details (optional, for quick reference)
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
    
    // Metadata
    createdAt: Date;
    updatedAt: Date;
}
