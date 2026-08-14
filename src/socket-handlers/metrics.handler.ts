import { Server, Socket } from 'socket.io';
import { Logger } from '../utils/Logger';
import { OrganizationMetricsService } from '../DataAccessLayer/OrganizationMetricsService';
import { UserMetricsService } from '../DataAccessLayer/UserMetricsService';
import { TaskWorkspaceCostService } from '../DataAccessLayer/TaskWorkspaceCostService';
import * as ds from './../DataStructures';
const logger = new Logger('MetricsHandler');

export async function metrics_handler(io: Server, socket: Socket) {
    
    /**
     * Get organization daily costs for bar graph
     * Input: { organizationId: string, startDate: Date, endDate: Date }
     * Output: { success: boolean, data: Array<{date, llmCost, ec2Cost, netCost, taskCount, wpCount}> }
     */
    socket.on('get_organization_daily_costs', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { organizationId, startDate, endDate } = data;

            if (!organizationId || !startDate || !endDate) {
                callback({
                    success: false,
                    error: 'Missing required parameters: organizationId, startDate, endDate'
                });
                return;
            }

            // Convert string dates to Date objects and set time boundaries (UTC)
            const start = new Date(startDate);
            start.setUTCHours(0, 0, 0, 0);
            
            const end = new Date(endDate);
            end.setUTCHours(23, 59, 59, 999);


            // TODO: Replace with actual database name
            const databaseName = ds.UserInfo.get(socket.data.user.userId)?.dbName;
            
            const orgMetricsService = new OrganizationMetricsService(databaseName as any);
            const dailyCosts = await orgMetricsService.getDailyCostsForDateRange(
                organizationId,
                start,
                end
            );

            callback({
                success: true,
                data: dailyCosts
            });

        } catch (error: any) {
            logger.error('Error in get_organization_daily_costs handler', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    /**
     * Get users cost grid for dashboard
     * Input: { organizationId: string, startDate: Date, endDate: Date }
     * Output: { success: boolean, data: Array<{userId, userName, llmCost, ec2Cost, netCost, taskCount, wpCount}> }
     */
    socket.on('get_users_cost_grid', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { organizationId, startDate, endDate } = data;

            if (!organizationId || !startDate || !endDate) {
                callback({
                    success: false,
                    error: 'Missing required parameters: organizationId, startDate, endDate'
                });
                return;
            }

            // Convert string dates to Date objects and set time boundaries (UTC)
            const start = new Date(startDate);
            start.setUTCHours(0, 0, 0, 0);
            
            const end = new Date(endDate);
            end.setUTCHours(23, 59, 59, 999);


            // TODO: Replace with actual database name
            const databaseName = ds.UserInfo.get(socket.data.user.userId)?.dbName;
            
            const userMetricsService = new UserMetricsService(databaseName as any);
            const usersCostGrid = await userMetricsService.getUsersCostGrid(
                organizationId,
                start,
                end
            );

            callback({
                success: true,
                data: usersCostGrid
            });

        } catch (error: any) {
            logger.error('Error in get_users_cost_grid handler', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });

    /**
     * Get tasks and workspaces cost grid for dashboard
     * Input: { organizationId: string, startDate: Date, endDate: Date }
     * Output: { success: boolean, data: Array<{id, name, type, userId, userName, llmCost, ec2Cost, netCost}> }
     */
    socket.on('get_tasks_workspaces_grid', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const { organizationId, startDate, endDate } = data;

            if (!organizationId || !startDate || !endDate) {
                callback({
                    success: false,
                    error: 'Missing required parameters: organizationId, startDate, endDate'
                });
                return;
            }

            // Convert string dates to Date objects and set time boundaries (UTC)
            const start = new Date(startDate);
            start.setUTCHours(0, 0, 0, 0);
            
            const end = new Date(endDate);
            end.setUTCHours(23, 59, 59, 999);


            // TODO: Replace with actual database name
            const databaseName = ds.UserInfo.get(socket.data.user.userId)?.dbName;
            
            const taskWpCostService = new TaskWorkspaceCostService(databaseName as any);
            const tasksWorkspacesGrid = await taskWpCostService.getTasksWorkspacesGrid(
                organizationId,
                start,
                end
            );

            callback({
                success: true,
                data: tasksWorkspacesGrid
            });

        } catch (error: any) {
            logger.error('Error in get_tasks_workspaces_grid handler', error);
            callback({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    });
}
