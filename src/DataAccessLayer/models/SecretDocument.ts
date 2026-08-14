export  interface SecretDocument extends Document {
    key: string;
    encryptedData: string;
    iv: string;
    authTag: string;
    createdAt: Date;
    updatedAt: Date;
    createdBy:string;
    permissionScopes:Record<string,'Read'|'Write'> // this can have organization ID as well as Group IDs
    //permission scopes will be of type:
    // id_of_<org,group> : [Read,Write]

}
