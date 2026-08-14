import { Document, ObjectId, Timestamp, UUID } from 'mongodb';

export interface githubData
{
    githubId:string,
    githubAccessToken:string
}
export interface IUserCredentials extends Document
{
    _id?: ObjectId,
    userName: string,
    userId: UUID //this will be the primary key to identify all the users.
    password: string,
    email:string,
    databaseName: string,
    createdOn: Date,
    githubMetadata?: githubData,
    setupComplete: boolean,
    invitedBy: string,
    organizationRole: "Owner" | "Member",
    metadata?: {
        geoIP?: {
            countryCode?: string,
            countryName?: string,
            registeredAt?: Date
        },
        [key: string]: any
    }
}