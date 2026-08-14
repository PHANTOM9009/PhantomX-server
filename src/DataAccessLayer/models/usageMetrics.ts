import{Document,ObjectId} from'mongodb';
export enum ResourceType{
    LLM='LLM',
    EC2='EC2',
    EmbeddingModel = 'EmbeddingModel',
    Storage='Storage',
    Others= 'Others'
}
export interface Tag{
    organizationId:string;
    userId:string;
    resourceType:ResourceType;
}
export interface llmMetrics extends Document{ // the same interface class will be used for embedding model logs as well
    _id:ObjectId,
    timestamp:Date,
    tags:Tag;
    TaskId:string; // if there is a task
    wpId:string; // if the cost is about a workspace creation
    modelId:string; // id of the model used

    input_tokens:number;
    cache_creation_input_tokens: number; // cache write tokens from AWS Bedrock
    cache_read_input_tokens:number;
    output_tokens:number;

    net_cost:number; // this is the net cost for that request


}
export interface EC2Metrics extends Document{
    _id:ObjectId,
    timestamp:Date,
    tags:Tag,
    TaskId:string;
    wpId:string;

    ec2_instance_id:string; // we have 2 types of EC2, one for task, and another for indexing.
    usageTime: number; // in minutes
    ec2_type:string; 
    net_ec2_cost:number; // net ec2 cost for that time.
}
// storage cost for efs will be 0.6 dollars per GB
// at the end of the month the cost of the storage will also be added.
