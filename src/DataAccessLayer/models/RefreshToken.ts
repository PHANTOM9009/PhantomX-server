import { Document, ObjectId, Timestamp, UUID } from 'mongodb';

export interface IRefreshToken extends Document{
    _id?:ObjectId,
    userId:UUID,
    token:string,
    expiresOn:Date,
    revoked: boolean,
    createdOn: Date,
    updatedOn: Date

}