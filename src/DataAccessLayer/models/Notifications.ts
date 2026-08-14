import { Document, ObjectId } from 'mongodb';

export interface INotification extends Document {
    _id?: ObjectId;
    notificationId: string;
    userId: string; 
    notificationStatus: 'pending' | 'sent' | 'read' | 'failed';
    createdAt: Date;
    metadata?: Record<string, any>; 
}
