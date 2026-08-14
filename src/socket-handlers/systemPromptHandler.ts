
import * as ds from './../DataStructures';
import { Server, Socket } from 'socket.io';
import { systemPromptService } from '../Services/systemPromptService';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import * as dotenv from 'dotenv';
import { CollectionNames } from '../DataAccessLayer/models';
import { systemPrompt } from '../DataAccessLayer/models/systemPrompt';
dotenv.config();

const logger = new Logger('systemPromptHandler');

export async function system_prompt_handler(io: Server, socket: Socket) {
	

	const hasWriteAccess = async (userId: string, promptId: string): Promise<boolean> => {
		try {
			const userData = ds.UserInfo.get(userId);
			if (!userData) return false;

			const dbService = await getDBService();
			await dbService.ensureCollection(userData.dbName, CollectionNames.SYSTEM_PROMPT);
			const promptRepository = dbService.getRepository<systemPrompt>(userData.dbName, CollectionNames.SYSTEM_PROMPT);
			const prompt = await promptRepository.findOne({ promptId: promptId });

			if (!prompt) return false;

			if (prompt.createdBy === userId) return true;

			if (prompt.permissionScopes) {
				return Object.keys(prompt.permissionScopes).some((groupId: string) => 
					(userData.permissionScopes?.hasOwnProperty(groupId) || userData.userId === groupId) &&
					prompt.permissionScopes[groupId].toLowerCase() === 'write'
				);
			}

			return false;
		} catch (err) {
			logger.error('Error checking write access:', err);
			return false;
		}
	};

	socket.on('create_system_prompt', async (data: any, callback: Function) => {
		try {
			if (!socket.data.user || !socket.data.user.userId) {
				callback && callback({ success: false, error: 'User not authenticated' });
				return;
			}
			const userId = socket.data.user.userId;
			const { prompt, promptName, permissionScopes } = data;
			if (!prompt || !promptName) {
				callback && callback({ success: false, error: 'Missing prompt or promptName' });
				return;
			}

			const result = await systemPromptService.createSystemPrompt(prompt, userId, promptName, permissionScopes || {});
			callback && callback(result);
		} catch (err: any) {
			logger.error('error in create_system_prompt', err);
			callback && callback({ success: false, error: err.message || 'internal error' });
		}
	});

	socket.on('edit_system_prompt', async (data: any, callback: Function) => {
		try {
			if (!socket.data.user || !socket.data.user.userId) {
				callback && callback({ success: false, error: 'User not authenticated' });
				return;
			}
			const userId = socket.data.user.userId;
			const { promptId, prompt, permissionScopes } = data;
			if (!promptId) {
				callback && callback({ success: false, error: 'Missing promptId' });
				return;
			}

			// Check write access
			const hasAccess = await hasWriteAccess(userId, promptId);
			if (!hasAccess) {
				callback && callback({ success: false, error: 'You don\'t have write access' });
				return;
			}

			if (permissionScopes) await systemPromptService.editPermissionScopes(promptId, userId, permissionScopes);
			if (prompt) await systemPromptService.editSystemPrompt(prompt, userId, promptId);
			callback && callback({ success: true });
		} catch (err: any) {
			logger.error('error in edit_system_prompt', err);
			callback && callback({ success: false, error: err.message || 'internal error' });
		}
	});

	socket.on('get_system_prompt', async (data: any, callback: Function) => {
		try {
			if (!socket.data.user || !socket.data.user.userId) {
				callback && callback({ success: false, error: 'User not authenticated' });
				return;
			}
			const userId = socket.data.user.userId;
			const { promptId } = data;
			if (!promptId) {
				callback && callback({ success: false, error: 'Missing promptId' });
				return;
			}

			const result = await systemPromptService.getSystemPrompt(promptId, userId);
			callback && callback(result);
		} catch (err: any) {
			logger.error('error in get_system_prompt', err);
			callback && callback({ success: false, error: err.message || 'internal error' });
		}
	});

	socket.on('delete_system_prompt', async (data: any, callback: Function) => {
		try {
			if (!socket.data.user || !socket.data.user.userId) {
				callback && callback({ success: false, error: 'User not authenticated' });
				return;
			}
			const userId = socket.data.user.userId;
			const { promptId } = data;
			if (!promptId) {
				callback && callback({ success: false, error: 'Missing promptId' });
				return;
			}

			// Check write access
			const hasAccess = await hasWriteAccess(userId, promptId);
			if (!hasAccess) {
				callback && callback({ success: false, error: 'You don\'t have write access' });
				return;
			}

			const result = await systemPromptService.deleteSystemPrompt(promptId, userId);
			callback && callback(result);
		} catch (err: any) {
			logger.error('error in delete_system_prompt', err);
			callback && callback({ success: false, error: err.message || 'internal error' });
		}
	});



	socket.on('get_all_prompts', async (data: any, callback: Function) => {
		try {
			if (!socket.data.user || !socket.data.user.userId) {
				callback && callback({ success: false, error: 'User not authenticated' });
				return;
			}
			const userId = socket.data.user.userId;
			const { permissionScopeIds } = data;
			
			const result = await systemPromptService.getAllPrompts(permissionScopeIds || [], userId);
			callback && callback(result);
		} catch (err: any) {
			logger.error('error in get_all_prompts', err);
			callback && callback({ success: false, error: err.message || 'internal error' });
		}
	});

}

