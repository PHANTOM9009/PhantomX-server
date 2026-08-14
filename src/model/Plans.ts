export interface WorkspaceConstraints
{
   numberOfWorkspaces:number;
}
export interface ParallelTasks
{
  numberOfParallelTasks:number;
}
export interface TotalTasks
{
    numberOfTasks:number;
}
export interface TeamMembers
{

  maxTeamMembers:number;

}

export enum constraintTypes{
  WorkspaceConstraints,
  ParallelTasks,
  TotalTasks,
  TeamMembers,
  executePrompt
}


export interface PlanInfo {

  planId:string; // PayPal ID of the plan
  razorpayPlanId?:string; // Razorpay ID of the plan (for Indian users)
  constraints:Record<string,any>;
  planName:string;

}

/**
 * Razorpay plan mapping for Indian users
 * These should be created in the Razorpay dashboard and mapped here
 */
export interface RazorpayPlanMapping {
  [paypalPlanId: string]: {
    razorpayPlanId: string;
    priceInr: number; // Price in INR (paise)
  };
}
