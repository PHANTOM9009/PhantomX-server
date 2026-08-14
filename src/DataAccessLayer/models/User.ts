
import { Document, ObjectId } from 'mongodb';

/**
 * User model interface
 */
export interface IUser extends Document {
    _id?: ObjectId;
    userName: string;
    userId:string;
    name:string;
    email:string;
    createdAt: Date;
    updatedAt: Date;
    lastLogin?: Date;
    active: boolean;
    organizationName:string;
    organizationId:string;
    organizationPermission:'Owner'|'Member';
    metadata?: Record<string, any>;
    dbName?: string,
    planId?:string, // this is the plan id of the organization hence of the user
    permissionScopes: Record<string, 'Owner' | 'Member'>; //the ids will only be of groups.
}
