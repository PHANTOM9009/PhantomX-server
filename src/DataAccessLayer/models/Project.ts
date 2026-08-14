
import { Document, ObjectId } from 'mongodb';

/**
 * Project model interface
 */
export interface IProject extends Document {
    _id?: ObjectId;
    name: string;
    description: string;
    ownerId: ObjectId | string;
    members: Array<{
        userId: ObjectId | string;
        role: string;
    }>;
    createdAt: Date;
    updatedAt: Date;
    status: 'active' | 'archived' | 'completed';
    metadata?: Record<string, any>;
}
