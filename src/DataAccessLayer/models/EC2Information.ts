export interface EC2Information
{
    ec2Type:string;
    per_hour_cost: number

}
export const c5xlarge: EC2Information = {
    ec2Type: "c5.xlarge",
    per_hour_cost: 0.17
}
export const c5a2xlarge:EC2Information = {
    ec2Type: "c5a.2xlarge",
    per_hour_cost: 0.308
}