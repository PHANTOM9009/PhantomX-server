import { getDBService } from "../DataAccessLayer/db-connection";
import { CollectionNames, IOrganization, IUser } from "../DataAccessLayer/models";
import { Task } from "../DataAccessLayer/models/Task";
import { Workspaces } from "../DataAccessLayer/models/Workspaces";
import { constraintTypes } from "../model/Plans";
import { Logger } from "../utils/Logger";
import * as ds from './../DataStructures'
import { OrganizationMetricsService } from './../DataAccessLayer/OrganizationMetricsService';

export class constraintHandlerClass {

    static logger = new Logger('ConstraintHandler');

    static async constraintHandler(userId: string, constraintType: constraintTypes) {
        try {
            // PAYWALL KILL-SWITCH: if DISABLE_PAYWALL=true in .env, bypass all plan constraints
            if (process.env.DISABLE_PAYWALL === 'true') {
                return {
                    success: true,
                    message: 'Paywall disabled via DISABLE_PAYWALL env flag'
                };
            }
            let currentPlan = ds.UserInfo.get(userId)?.planId;
            if(currentPlan==='GOD')
            {
                return {
                    success:true,
                    message:'God mode activated'
                }
            }
            let planConstraints = ds.PlanInfo[currentPlan as any];
            let dbService = await getDBService();
            let userInfo = ds.UserInfo.get(userId);
            // if (constraintType === constraintTypes.WorkspaceConstraints) {
            //     let allowedWorkspaces = planConstraints.constraints.WorkspaceConstraints.numberOfWorkspaces;
            //     //getting the current workspaces
            //     let wpHandler = await dbService.getRepository<Workspaces>(userInfo?.dbName, CollectionNames.WORKSPACES);
            //     let wpCount = await wpHandler.count();
            //     if (wpCount + 1 > allowedWorkspaces) {
            //         return {
            //             success: false,
            //             message: "Allowed Workspaces limit reached, please update your plan or delete existing workspaces to continue.",
            //             status: 510
            //         }
            //     }

            // }
             if (constraintType === constraintTypes.executePrompt) {
                //checking the current money in the account against the current usage.
                //finding the current credits in total for this month 
                let organizationHandler = dbService.getRepository<IOrganization>('Organizations', 'Organizations');
                let orgData = await organizationHandler.findOne({
                    OrganizationId: userInfo?.organizationId
                });
                let topUpCredits = orgData?.metadata?.credits ?? 0;
                let subscriptionCredits = planConstraints?.constraints?.subscriptionCredits || 0;

                let totalCredits = subscriptionCredits + topUpCredits;
                // getting the current usage
                let orgMetrics = new OrganizationMetricsService(userInfo?.dbName as any);
                const now = new Date();

                // Start of current month at 12:00 AM
                const startDate = new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    1,
                    0, 0, 0, 0
                );

                // Today at 12:00 AM
                const endDate = new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate(),
                    0, 0, 0, 0
                );

                // const startDate = new Date(2025, 11, 28, 0, 0, 0, 0);  // Dec = 11
                // const endDate = new Date(2025, 11, 31, 0, 0, 0, 0);


                let data: any = await orgMetrics.getAggregatedOrganizationMetrics(userInfo?.organizationId as any, startDate, endDate);

                if (data.totalNetCost >= totalCredits) {
                    return {
                        success: false,
                        message: "Your credit balance is now 0, please top up or update your plan.",
                        status: 510
                    }
                }

            }

            else if (constraintType === constraintTypes.TotalTasks) {

                let allowedTasks = planConstraints.constraints.WorkspaceConstraints.numberOfTasks;
                //getting the current running tasks
                let tasks = ds.userId_task.get(userId) as any;

                if (tasks?.length > allowedTasks) {
                    return {
                        success: false,
                        message: "Allowed parallel tasks limit reached, please update your plan or stop running tasks to continue.",
                        status: 510
                    }
                }

            }
            else if (constraintType === constraintTypes.TeamMembers) {
                let totalMembers = planConstraints.constraints.TeamMembers.maxTeamMembers;
                let userHandler = await dbService.getRepository<IUser>(userInfo?.dbName, CollectionNames.USERS);
                let userCount = await userHandler.count();
                if (userCount + 1 > totalMembers) {
                    return {
                        success: false,
                        message: "Allowed number of users in an organization reached, please update your plan.",
                        status: 510
                    }
                }

            }
            return {
                success: true,
                message: 'done'
            }
        }
        catch (ex) {
            this.logger.error(' error in constrainHandler function=>', ex);
        }
    }
}