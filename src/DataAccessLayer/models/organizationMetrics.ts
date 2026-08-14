import { Document, ObjectId } from 'mongodb';
import { AggregationPeriod } from './aggregatedMetrics';

/**
 * Organization Metrics Aggregation Schema
 * Aggregates costs from User_Metrics_Aggregation grouped by organizationId
 * Simple totals without detailed breakdowns - top of the hierarchy
 */
export interface OrganizationMetricsAggregation extends Document {
    _id: ObjectId;
    
    // Aggregation period
    aggregationPeriod: AggregationPeriod;
    
    // Organization identification
    organizationId: string;
    
    // Total aggregated costs (sum of all users in the organization)
    totalLLMCost: number;
    totalEC2Cost: number;
    totalNetCost: number;
    
    // Counts
    userCount: number;           // Number of unique users who incurred costs
    totalTaskCount: number;      // Sum of all users' task counts
    totalWorkspaceCount: number; // Sum of all users' workspace counts
    
    // Metadata
    createdAt: Date;
    updatedAt: Date;
}
