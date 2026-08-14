import { Server, Socket } from 'socket.io';
import * as ds from "./../DataStructures";
import { createLogger } from '../utils/Logger';
import { toolServerClientManager } from '../Services/ToolServerClientManager';
import { GithubOperationsService } from '../Services/GithubOperationsService';

const logger = createLogger('GitHubHandler');

/**
 * GitHub handler for socket events.
 * All git operations are delegated to the Tool Server via sendToolRequest.
 */
export async function github_handler(io: Server, socket: Socket) {

    // ── helpers ────────────────────────────────────────────────────────────────
  const githubService = new GithubOperationsService();
    const getId = () => {
        const user = socket.data.user;
        return user.wpId ?? user.taskId;
    };

    const getTaskInfo = () => ds.taskId_task.get(socket.data.user.taskId as any);

    const authGuard = (callback: Function): boolean => {
        if (!socket.data.user?.userId) {
            callback({ success: false, error: 'User not authenticated' });
            return false;
        }
        return true;
    };

    const taskGuard = (callback: Function): any => {
        const taskInfo = getTaskInfo();
        if (!taskInfo) {
            callback({ success: false, error: 'Invalid task ID' });
            return null;
        }
        return taskInfo;
    };

    // ── get_repo_list ──────────────────────────────────────────────────────────

    socket.on('get_repo_list', async (data: any, callback) => {
        try {
            if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const installationId = ds.Organization_AppInstallation.get(ds.UserInfo.get(socket.data.user.userId)?.organizationName as any)?.installationId;

            if (!installationId) {
                callback({
                    success: false,
                    error: 'Installation ID is required'
                });
                return;
            }
        const result = await githubService.getRepositoryList(installationId);
        callback({
                success: true,
                data: result
            });
        } catch (error: any) {
            logger.error('[get_repo_list] Error:', error);
            callback({ success: false, error: 'Failed to fetch repositories', message: error.message });
        }
    });

    // ── list_branches ──────────────────────────────────────────────────────────

    socket.on('list_branches', async (data: any, callback) => {
        try {
           if (!socket.data.user || !socket.data.user.userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
             const installationId:any = ds.Organization_AppInstallation.get(ds.UserInfo.get(socket.data.user.userId)?.organizationName as any)?.installationId;
            const owner:any = ds.Organization_AppInstallation.get(ds.UserInfo.get(socket.data.user.userId)?.organizationName as any)?.githubOrganizationName;
            const repo = data.repoName;
             if (!installationId || !owner || !repo) {
                callback({
                    success: false,
                    error: 'Installation ID, owner, and repo are required'
                });
            }
             const result = await githubService.listBranches(installationId, owner, repo);

            callback({
                success: true,
                data: result
            });
        } catch (error: any) {
            logger.error('[list_branches] Error:', error);
            callback({ success: false, error: 'Failed to fetch branches', message: error.message });
        }
    });

    // ── pull_repo ──────────────────────────────────────────────────────────────

    socket.on('pull_repo', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName } = data;
            const id = getId();

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_PullRepository', { repoName });

            logger.success('Git pull completed successfully', { repoName, branchName: result.branchName });
            callback({
                success: true,
                message: `Successfully pulled latest changes from ${result.branchName} branch`,
                data: result
            });
        } catch (error: any) {
            logger.error('[pull_repo] Error:', error);
            callback({ success: false, error: 'Failed to pull repository', message: error.message });
        }
    });

    // ── push_repo ──────────────────────────────────────────────────────────────

    socket.on('push_repo', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName } = data;
            const id = getId();

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_PushRepository', { repoName });

            callback({
                success: true,
                message: `Successfully pushed ${result.commitsAhead} commit(s) to ${result.branchName} branch`,
                data: result
            });
        } catch (error: any) {
            logger.error('[push_repo] Error:', error);
            callback({ success: false, error: error.message || 'Failed to push repository', message: error.message });
        }
    });

    // ── check_repo_status ─────────────────────────────────────────────────────

    socket.on('check_repo_status', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;

            const { repoName } = data;
            const id = getId();

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_CheckRepositoryStatus', { repoName });
            callback({ success: true, data: result });
        } catch (error: any) {
            logger.error('[check_repo_status] Error:', error);
            callback({ success: false, error: 'Failed to check repository status', message: error.message });
        }
    });

    // ── get_repo_history ──────────────────────────────────────────────────────

    socket.on('get_repo_history', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName, limit = 50 } = data;
            const id = getId();

            const remoteBranchName = taskInfo.repoDetails?.find((repo: any) => repo.repoName === repoName)?.branchName;

            if (!remoteBranchName) {
                callback({ success: false, error: 'Branch name not found for repo' });
                return;
            }

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_GetRepositoryHistory', {
                repoName,
                branch: remoteBranchName,
                maxCommits: limit
            });

            callback({ success: true, data: result });
        } catch (error: any) {
            logger.error('[get_repo_history] Error:', error);
            callback({ success: false, error: 'Failed to fetch repository history', message: error.message });
        }
    });

    // ── commit_local_changes ──────────────────────────────────────────────────

    socket.on('commit_local_changes', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName, commitMessage } = data;
            const id = getId();

            const remoteBranchName = taskInfo.repoDetails?.find((repo: any) => repo.repoName === repoName)?.branchName;

            if (!remoteBranchName) {
                callback({ success: false, error: 'Branch name not found for repo' });
                return;
            }

            const userInfo = ds.UserInfo.get(socket.data.user.userId);

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_CommitLocalChanges', {
                repoName,
                remoteBranchName,
                commitMessage,
                userInfo: { name: userInfo?.name, email: userInfo?.email }
            });

            callback({
                success: true,
                message: `Successfully committed ${result.changedFiles} file(s) to local branch`,
                data: result
            });
        } catch (error: any) {
            logger.error('[commit_local_changes] Error:', error);
            callback({ success: false, error: error.message || 'Failed to commit local changes', message: error.message });
        }
    });

    // ── create_pr ─────────────────────────────────────────────────────────────

    socket.on('create_pr', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName, title, body } = data;
            const id = getId();

            const repoDetail = taskInfo.repoDetails?.find((repo: any) => repo.repoName === repoName);
            const targetBranch = repoDetail?.branchName;

            if (!targetBranch) {
                callback({ success: false, error: 'Target branch not found for repo' });
                return;
            }

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_CreatePullRequest', {
                repoName,
                targetBranch,
                title,
                body
            });

            if (result.alreadyExists) {
                callback({ success: true, message: 'Pull request already exists', alreadyExists: true, data: result });
            } else {
                callback({ success: true, message: `Pull request #${result.prNumber} created successfully`, data: result });
            }
        } catch (error: any) {
            logger.error('[create_pr] Error:', error);

            let errorMessage = 'Failed to create pull request';
            if (error.status === 422) errorMessage = 'Pull request already exists or validation error';
            else if (error.status === 404) errorMessage = 'Repository or branch not found';
            else if (error.message) errorMessage = error.message;

            callback({ success: false, error: errorMessage, message: error.message, details: error.response?.data });
        }
    });

    // ── check_pr_exists ───────────────────────────────────────────────────────

    socket.on('check_pr_exists', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName } = data;
            const id = getId();

            const repoDetail = taskInfo.repoDetails?.find((repo: any) => repo.repoName === repoName);
            const targetBranch = repoDetail?.branchName;

            if (!targetBranch) {
                callback({ success: false, error: 'Target branch not found for repo' });
                return;
            }

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_CheckPullRequestExists', {
                repoName,
                targetBranch
            });

            callback({ success: true, prExists: result.prExists, data: result });
        } catch (error: any) {
            logger.error('[check_pr_exists] Error:', error);
            callback({ success: false, error: 'Failed to check if PR exists', message: error.message });
        }
    });

    // ── get_commit_details ────────────────────────────────────────────────────

    socket.on('get_commit_details', async (data: any, callback) => {
        try {
            if (!authGuard(callback)) return;
            const taskInfo = taskGuard(callback);
            if (!taskInfo) return;

            const { repoName, commitHash } = data;

            if (!commitHash) {
                callback({ success: false, error: 'Commit hash is required' });
                return;
            }

            const id = getId();

            const result = await toolServerClientManager.sendToolRequest(id, 'Github_GetCommitDetails', {
                repoName,
                commitHash
            });

            callback({ success: true, data: result });
        } catch (error: any) {
            logger.error('[get_commit_details] Error:', error);
            callback({ success: false, error: 'Failed to fetch commit details', message: error.message });
        }
    });
}
