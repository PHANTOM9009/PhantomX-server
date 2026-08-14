import { Document, ObjectId } from 'mongodb';

export interface IAgentConfig extends Document {
    _id?: ObjectId;
    agentId: string;
    name: string;
    role?: string;
    description?: string;
    parentAgentId?: string | null;  // null for root agents
    filePath: string;  // S3 path to YAML
    permissionScopes: Record<string, 'Read' | 'Write'>;
    createdBy: string;  // userId
    createdAt: Date;
    updatedAt: Date;
    version: number;
    // Additional metadata
    type: 'single' | 'multi';  // single agent or multi-agent orchestration
    model?: string;  // LLM model if single agent
    tools?: string[];  // tool names if single agent
    status?: 'active' | 'inactive' | 'draft';
}
