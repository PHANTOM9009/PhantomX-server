import { Document, ObjectId } from 'mongodb';


export interface IGroup extends Document {
    _id?: ObjectId;
    GroupId: string;
    GroupName: string;
    CreatedBy: string;
    CreatedOn: Date;
    GroupDescription: string;
    MemberCount: number;
}
