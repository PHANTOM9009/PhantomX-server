import * as ds from './../DataStructures';
import { Server, Socket } from 'socket.io';
import { AgentConfigService } from '../Services/agentConfigService';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import { CollectionNames } from '../DataAccessLayer/models';
import { IAgentConfig } from '../DataAccessLayer/models/agentConfig';
import * as dotenv from 'dotenv';
dotenv.config();

const logger = new Logger('agentConfigHandler');

export async function agent_config_handler(io: Server, socket: Socket) {

    const hasWriteAccess = async (userId: string, agentId: string): Promise<boolean> => {
        try {
            const userData = ds.UserInfo.get(userId);
            if (!userData) return false;

            const dbService = await getDBService();
            await dbService.ensureCollection(userData.dbName, CollectionNames.AGENT_CONFIGS);
            const agentRepository = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);
            const agent = await agentRepository.findOne({ agentId: agentId });

            if (!agent) return false;

            if (agent.createdBy === userId) return true;

            if (agent.permissionScopes) {
                return Object.keys(agent.permissionScopes).some((groupId: string) => 
                    (userData.permissionScopes?.hasOwnProperty(groupId) || userData.userId === groupId) &&
                    agent.permissionScopes[groupId].toLowerCase() === 'write'
                );
            }

            return false;
        } catch (err) {
            logger.error('Error checking write access:', err);
            return false;
        }
    };

    socket.on('create_agent', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { yamlContent, name, permissionScopes, metadata } = data;
            
            if (!yamlContent || !name || !metadata || !metadata.type) {
                callback && callback({ success: false, error: 'Missing required fields' });
                return;
            }

            const result = await AgentConfigService.createAgent(
                yamlContent,
                userId,
                name,
                permissionScopes || {},
                metadata
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in create_agent', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('edit_agent', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { agentId, yamlContent, permissionScopes, metadata } = data;
            
            if (!agentId) {
                callback && callback({ success: false, error: 'Missing agentId' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, agentId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            const result = await AgentConfigService.editAgent(
                agentId,
                userId,
                yamlContent,
                permissionScopes,
                metadata
            );
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in edit_agent', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('get_agent', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { agentId } = data;
            
            if (!agentId) {
                callback && callback({ success: false, error: 'Missing agentId' });
                return;
            }

            const result = await AgentConfigService.getAgent(agentId, userId);
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in get_agent', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('delete_agent', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { agentId } = data;
            
            if (!agentId) {
                callback && callback({ success: false, error: 'Missing agentId' });
                return;
            }

            // Check write access
            const hasAccess = await hasWriteAccess(userId, agentId);
            if (!hasAccess) {
                callback && callback({ success: false, error: 'You don\'t have write access' });
                return;
            }

            const result = await AgentConfigService.deleteAgent(agentId, userId);
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in delete_agent', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('get_all_agents', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { permissionScopeIds } = data;
            
            const result = await AgentConfigService.getAllAgents(permissionScopeIds || [], userId);
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in get_all_agents', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });

    socket.on('get_agent_tree', async (data: any, callback: Function) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback && callback({ success: false, error: 'User not authenticated' });
                return;
            }
            const userId = socket.data.user.userId;
            const { rootAgentId } = data;
            
            if (!rootAgentId) {
                callback && callback({ success: false, error: 'Missing rootAgentId' });
                return;
            }

            const result = await AgentConfigService.getAgentTree(rootAgentId, userId);
            callback && callback(result);
        } catch (err: any) {
            logger.error('error in get_agent_tree', err);
            callback && callback({ success: false, error: err.message || 'internal error' });
        }
    });
}
