import { Document, ObjectId } from 'mongodb';

export interface IOrganization extends Document {
    _id?: ObjectId;
    OrganizationId: string;
    OrganizationName: string;
    dbName: string;
    CreatedBy: ObjectId;
    CreatedOn: Date;
    Tier?: string[]
    Active: boolean;
    metadata?: Record<string, any>;
}