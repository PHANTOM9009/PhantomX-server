import { getRepoList, getRepoBranch, fetchInstallationToken, getGithubOrganizationName } from './GithubAppFlow';
import * as ds from '../DataStructures';
const SSHClient = require('./ssh-client');
import { createLogger } from '../utils/Logger';
import { fileServerClientManager } from './FileServerClientManager';
import { Socket } from 'socket.io';
import { getDBService } from '../DataAccessLayer/db-connection';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { Task, TaskStatus } from '../DataAccessLayer/models/Task';

const logger = createLogger('GithubOperationsService');

export class GithubOperationsService {

    private updatePRMetadata(taskId: string, userId: string | undefined, prResult: any, taskData?: any) {
        if (!userId) return;

        (async () => {
            try {
                const dbService = await getDBService();
                const dbName = ds.UserInfo.get(userId)?.dbName;
                if (!dbName) throw new Error('User dbName not found');
                const taskRepository = dbService.getRepository(dbName, CollectionNames.TASKS);
                const task = await taskRepository.findOne({ taskId });
                let activityLog = Array.isArray(task?.metadata?.activityLog) ? task.metadata.activityLog : [];

                let gitChanges = (task?.metadata?.github) || {
                    totalAdditions: 0,
                    totalDeletions: 0,
                    totalChangedFiles: 0,
                    pullRequests: [],
                    commits: []
                };
                const prData = {
                    id: (prResult.prNumber || '').toString(),
                    number: prResult.prNumber,
                    title: prResult.prTitle,
                    description: undefined,
                    url: prResult.prUrl,
                    state: prResult.alreadyExists ? 'open' : 'open',
                    createdAt: prResult.createdAt,
                    updatedAt: undefined,
                    author: '',
                    authorName: '',
                    baseBranch: prResult.targetBranch,
                    headBranch: prResult.headBranch,
                    additions: 0,
                    deletions: 0,
                    changedFiles: 0
                };
                gitChanges.pullRequests.push(prData);

                const activityChange = {
                    id: `activity_${Date.now()}`,
                    type: "agent_pr_created",
                    description: `Phantom has created the pull request [PR #${prResult.prNumber}]`,
                    timestamp: new Date().toISOString(),
                    user: "phantom",
                    userName: "Phantom",
                    isAgent: true,
                    links: [
                        {
                            text: `PR #${prResult.prNumber}`,
                            url: prResult.prUrl,
                            type: "pr"
                        }
                    ],
                    metadata: {
                        prUrl: prResult.prUrl
                    }
                };
                activityLog.push(activityChange);

                const updateData: any = {
                    'metadata.github': gitChanges,
                    'metadata.activityLog': activityLog
                };

                if (taskData?.status) {
                    updateData.status = taskData.status;
                }

                await taskRepository.updateOne({ taskId }, { $set: updateData });
            } catch (err) {
                logger.error('Failed to update task metadata.github for PR', { taskId, err });
            }
        })();
    }


    private escapeSingleQuotedShell(value: string): string {
        return value.replace(/'/g, `'\\''`);
    }

    private async resolveBranchReference(
        ssh: any,
        repoName: string,
        branchName: string
    ): Promise<{
        requestedBranch: string;
        resolvedRef: string;
        displayBranch: string;
    }> {
        const requestedBranch = (branchName || '').trim();
        if (!requestedBranch) {
            throw new Error('Branch name is required');
        }

        const candidateRefs = requestedBranch.startsWith('origin/')
            ? [requestedBranch, requestedBranch.replace(/^origin\//, '')]
            : [requestedBranch, `origin/${requestedBranch}`];

        const uniqueCandidates = Array.from(new Set(candidateRefs.filter((candidate) => candidate.trim().length > 0)));

        for (const candidate of uniqueCandidates) {
            const safeCandidate = this.escapeSingleQuotedShell(candidate);
            const branchCheck = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse --verify '${safeCandidate}^{commit}' >/dev/null 2>&1 && echo "BRANCH_OK"`);

            if (branchCheck.success && (branchCheck.output || '').includes('BRANCH_OK')) {
                return {
                    requestedBranch,
                    resolvedRef: candidate,
                    displayBranch: candidate.replace(/^origin\//, '')
                };
            }
        }

        throw new Error(`Branch '${requestedBranch}' not found in repository '${repoName}'`);
    }

    /**
     * Get repository list for an installation
     */
    async getRepositoryList(installationId: number): Promise<{
        installationId: number;
        repositories: any[];
        count: number;
    }> {
        const repositories = await getRepoList(installationId);

        return {
            installationId,
            repositories,
            count: repositories.length
        };
    }

    /**
     * List branches for a repository
     */
    async listBranches(
        installationId: number,
        owner: string,
        repo: string
    ): Promise<{
        repo: string;
        branches: any[];
        count: number;
    }> {
        logger.info(`Fetching branches for ${owner}/${repo} (installation: ${installationId})`);

        const branches = await getRepoBranch(installationId, owner, repo);

        return {
            repo,
            branches,
            count: branches.length
        };
    }

    /**
     * Pull repository from remote
     */
    async pullRepository(
        repoName: string,
        taskId: string,
        taskInfo: any,
        installationId: number,
        socket: Socket
    ): Promise<{
        taskId: string;
        repoName: string;
        branchName: string;
        lastCommit: string;
        mergeConflicts: any;
    }> {
        const folderPath = taskInfo.folderPath;
        const installationToken = await fetchInstallationToken(installationId);
        const gitOrgName = await getGithubOrganizationName(installationId);

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            // Get current local branch name
            let result = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse --abbrev-ref HEAD`);
            if (!result.success) {
                throw new Error(`Failed to get current branch: ${result.error}`);
            }
            const currentBranch = result.output.trim();

            logger.info('starting git pull operation', { taskId, repoName, currentBranch });

            // Set remote url with token
            result = await ssh.executeCommand(`cd ${repoName} && sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${gitOrgName}/${repoName}.git`);
            if (!result.success) {
                throw new Error(`Failed to set remote URL: ${result.error}`);
            }

            result = await ssh.executeCommand(`cd ${repoName} && sudo git fetch origin`);
            if (!result.success) {
                throw new Error(`Failed to fetch from remote: ${result.error}`);
            }

            result = await ssh.executeCommand(`cd ${repoName} && sudo git pull --no-rebase origin ${currentBranch}`);
            if (!result.success && result.code !== 128) {
                throw new Error(`Failed to pull branch ${currentBranch}: ${result.error}`);
            }

            await ssh.executeCommand(`cd ${repoName} && sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git`);

            logger.success('Git pull completed successfully', { taskId, repoName, currentBranch });

            // Get merge conflicts
            const mergeConflicts = await this.getMergeConflicts(socket, taskId, taskInfo, repoName);

            return {
                taskId,
                repoName,
                branchName: currentBranch,
                lastCommit: result.output.trim(),
                mergeConflicts
            };
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Push repository to remote
     */
    async pushRepository(
        repoName: string,
        taskId: string,
        taskInfo: any,
        installationId: number,
        socket?: Socket
    ): Promise<{
        taskId: string;
        repoName: string;
        branchName: string;
        commitHash: string;
        commitsAhead: number;
        pushedAt: string;
    }> {
        const folderPath = taskInfo.folderPath;
        const installationToken = await fetchInstallationToken(installationId);
        const gitOrgName = await getGithubOrganizationName(installationId);

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Starting git push operation', { taskId, repoName });

            // Combine all commands into a single SSH call
            const combinedCommand = `
                cd ${repoName} &&
                BRANCH=$(sudo git rev-parse --abbrev-ref HEAD) &&
                COMMITS_AHEAD=$(sudo git rev-list --count origin/$BRANCH..HEAD 2>/dev/null || echo 0) &&
                if [ "$COMMITS_AHEAD" = "0" ]; then
                    echo "ERROR:NO_COMMITS";
                    exit 1;
                fi &&
                sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${gitOrgName}/${repoName}.git &&
                sudo git push origin $BRANCH &&
                sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git &&
                COMMIT_HASH=$(sudo git rev-parse HEAD) &&
                echo "BRANCH:$BRANCH" &&
                echo "COMMITS_AHEAD:$COMMITS_AHEAD" &&
                echo "COMMIT_HASH:$COMMIT_HASH"
            `.replace(/\n\s+/g, ' ');

            const result = await ssh.executeCommand(combinedCommand);

            if (!result.success) {
                if (result.output && result.output.includes('ERROR:NO_COMMITS')) {
                    throw new Error('No commits to push');
                }
                throw new Error('Failed to push repository');
            }

            // Parse output
            const output = result.output;
            const branchMatch = output.match(/BRANCH:([^\n]+)/);
            const commitsAheadMatch = output.match(/COMMITS_AHEAD:(\d+)/);
            const commitHashMatch = output.match(/COMMIT_HASH:([a-f0-9]+)/);

            const currentBranch = branchMatch ? branchMatch[1].trim() : 'unknown';
            const commitsAhead = commitsAheadMatch ? parseInt(commitsAheadMatch[1]) : 0;
            const commitHash = commitHashMatch ? commitHashMatch[1].trim() : 'unknown';

            logger.success('Git push completed successfully', { taskId, repoName, currentBranch, commitHash, commitsAhead });

            // Emit socket event to refresh repo on client (only when called by AI agent)
            if (socket) {
                socket.emit('refresh_repo', { repoName, taskId });
            }

            return {
                taskId,
                repoName,
                branchName: currentBranch,
                commitHash,
                commitsAhead,
                pushedAt: new Date().toISOString()
            };
        } finally {
            await ssh.disconnect();
        }
    }
    public async getRepositoryOriginBranch(repoName: string, taskId: string) {
        try {
            let taskData = ds.taskId_task.get(taskId);
            let repoDetail = taskData?.repoDetails.find(val => val.repoName === repoName);
            if (repoDetail) {
                return repoDetail.branchName;
            }
            else {
                return "Error while finding the origin branch";
            }

        }
        catch (ex) {
            logger.error('error in getRepositoryOriginBranch', ex);
        }

    }
    /**
     * Check repository status
     */
    async checkRepositoryStatus(
        repoName: string,
        taskId: string,
        taskInfo: any,
        installationId: number,
        socket: Socket
    ): Promise<{
        taskId: string;
        repoName: string;
        branchName: string;
        currentCommitHash: string;
        remoteCommitHash: string;
        commitsBehind: number;
        commitsAhead: number;
        hasUncommittedChanges: boolean;
        isUpToDate: boolean;
        needsPull: boolean;
        needsPush: boolean;
        mergeConflicts: any;
        status: string;
    }> {
        const folderPath = taskInfo.folderPath;
        const installationToken = await fetchInstallationToken(installationId);
        const gitOrgName = await getGithubOrganizationName(installationId);

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Checking repository status', { taskId, repoName });

            // Combine all git commands into a single SSH call
            const combinedCommand = `
                cd ${repoName} &&
                BRANCH=$(sudo git rev-parse --abbrev-ref HEAD) &&
                sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${gitOrgName}/${repoName}.git &&
                sudo git fetch origin &&
                sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git &&
                BEHIND=$(sudo git rev-list --count HEAD..origin/$BRANCH 2>/dev/null || echo 0) &&
                AHEAD=$(sudo git rev-list --count origin/$BRANCH..HEAD 2>/dev/null || echo 0) &&
                STATUS=$(sudo git status --porcelain) &&
                CURRENT_HASH=$(sudo git rev-parse HEAD) &&
                REMOTE_HASH=$(sudo git rev-parse origin/$BRANCH 2>/dev/null || echo unknown) &&
                echo "BRANCH:$BRANCH" &&
                echo "BEHIND:$BEHIND" &&
                echo "AHEAD:$AHEAD" &&
                echo "STATUS:$STATUS" &&
                echo "CURRENT:$CURRENT_HASH" &&
                echo "REMOTE:$REMOTE_HASH"
            `.replace(/\n\s+/g, ' ');

            const result = await ssh.executeCommand(combinedCommand);

            if (!result.success) {
                throw new Error('Failed to check repository status');
            }

            // Parse the output
            const output = result.output;
            const branchMatch = output.match(/BRANCH:([^\n]+)/);
            const behindMatch = output.match(/BEHIND:(\d+)/);
            const aheadMatch = output.match(/AHEAD:(\d+)/);
            const statusMatch = output.match(/STATUS:([\s\S]*?)(?=CURRENT:|$)/);
            const currentMatch = output.match(/CURRENT:([a-f0-9]+)/);
            const remoteMatch = output.match(/REMOTE:([a-f0-9]+|unknown)/);

            const currentBranch = branchMatch ? branchMatch[1].trim() : 'unknown';
            const commitsBehind = behindMatch ? parseInt(behindMatch[1]) : 0;
            const commitsAhead = aheadMatch ? parseInt(aheadMatch[1]) : 0;
            const statusOutput = statusMatch ? statusMatch[1].trim() : '';
            const hasUncommittedChanges = statusOutput.length > 0;
            const currentCommitHash = currentMatch ? currentMatch[1].trim() : 'unknown';
            const remoteCommitHash = remoteMatch ? remoteMatch[1].trim() : 'unknown';

            const isUpToDate = commitsBehind === 0 && commitsAhead === 0;
            const needsPull = commitsBehind > 0;
            const needsPush = commitsAhead > 0;

            logger.info('Repository status checked', {
                taskId,
                repoName,
                commitsBehind,
                commitsAhead,
                hasUncommittedChanges,
                isUpToDate
            });

            // Check for merge conflicts
            const mergeConflicts = await this.getMergeConflicts(socket, taskId, taskInfo, repoName);

            return {
                taskId,
                repoName,
                branchName: currentBranch,
                currentCommitHash,
                remoteCommitHash,
                commitsBehind,
                commitsAhead,
                hasUncommittedChanges,
                isUpToDate,
                needsPull,
                needsPush,
                mergeConflicts,
                status: isUpToDate ? 'up-to-date' : (needsPull && needsPush ? 'diverged' : needsPull ? 'behind' : 'ahead')
            };
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Get repository history
     */
    async getRepositoryHistory(
        repoName: string,
        taskId: string,
        taskInfo: any,
        remoteBranchName: string,
        limit: number = 50
    ): Promise<{
        taskId: string;
        repoName: string;
        currentBranch: string;
        latestCommitHash: string;
        totalCommits: number;
        reflog: any[];
        commits: any[];
        summary: any;
    }> {
        const folderPath = taskInfo.folderPath;
        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Fetching repository history', { taskId, repoName, remoteBranchName, limit });

            const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50;

            let targetBranch = (remoteBranchName || '').trim();
            if (!targetBranch) {
                const branchResult = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse --abbrev-ref HEAD`);
                if (!branchResult.success) {
                    throw new Error(`Failed to resolve current branch: ${branchResult.error || branchResult.output || 'Unknown error'}`);
                }
                targetBranch = branchResult.output.trim();
            }

            const resolvedBranch = await this.resolveBranchReference(ssh, repoName, targetBranch);
            const safeResolvedRef = this.escapeSingleQuotedShell(resolvedBranch.resolvedRef);

            // Get reflog with detailed information
            let result = await ssh.executeCommand(`cd ${repoName} && sudo git reflog -${safeLimit} --date=iso`);
            if (!result.success) {
                throw new Error(`Failed to fetch reflog: ${result.error}`);
            }

            const reflogEntries = result.output.trim().split('\n').filter((line: any) => line.trim());

            // Get commit log with detailed information
            result = await ssh.executeCommand(`cd ${repoName} && sudo git log '${safeResolvedRef}' -${safeLimit} --pretty=format:"%H|%an|%ae|%ad|%s" --date=iso`);
            if (!result.success) {
                throw new Error(`Failed to fetch commit log for branch '${resolvedBranch.displayBranch}': ${result.error || result.output || 'Unknown error'}`);
            }
            const commitLog = result.output.trim() ? result.output.trim().split('\n').filter((line: any) => line.trim()) : [];

            // Parse reflog entries
            const parsedReflog = reflogEntries.map((entry: any) => {
                // Format: hash HEAD@{n}: action: message
                const match = entry.match(/^([a-f0-9]+)\s+HEAD@\{(\d+)\}:\s+(.+?):\s+(.+)$/);
                if (match) {
                    const [, hash, index, action, message] = match;

                    // Determine action type
                    let actionType = 'unknown';
                    let actionDetails = {};

                    if (action.includes('commit')) {
                        actionType = 'commit';
                        actionDetails = { type: action.includes('initial') ? 'initial' : 'regular' };
                    } else if (action.includes('pull')) {
                        actionType = 'pull';
                        const branchMatch = message.match(/from (.+)/);
                        actionDetails = { source: branchMatch ? branchMatch[1] : 'unknown' };
                    } else if (action.includes('merge')) {
                        actionType = 'merge';
                        actionDetails = { message: message };
                    } else if (action.includes('checkout')) {
                        actionType = 'checkout';
                        const branchMatch = message.match(/to (.+)/);
                        actionDetails = { branch: branchMatch ? branchMatch[1] : message };
                    } else if (action.includes('rebase')) {
                        actionType = 'rebase';
                    } else if (action.includes('reset')) {
                        actionType = 'reset';
                        actionDetails = { target: message };
                    } else if (action.includes('clone')) {
                        actionType = 'clone';
                    }

                    return {
                        hash: hash.substring(0, 7),
                        fullHash: hash,
                        index: parseInt(index),
                        action: actionType,
                        actionRaw: action,
                        message: message,
                        details: actionDetails
                    };
                }
                return null;
            }).filter((entry: any) => entry !== null);

            // Parse commit log
            const parsedCommits = commitLog.map((commit: any) => {
                const [hash, author, email, date, message] = commit.split('|');
                return {
                    hash: hash.substring(0, 7),
                    fullHash: hash,
                    author,
                    email,
                    date,
                    message
                };
            });

            const currentBranch = resolvedBranch.displayBranch;

            // Get latest commit info
            result = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse '${safeResolvedRef}'`);
            const latestCommitHash = result.success ? result.output.trim() : 'unknown';

            // Get repository statistics
            result = await ssh.executeCommand(`cd ${repoName} && sudo git rev-list --count '${safeResolvedRef}'`);
            const totalCommits = result.success ? parseInt(result.output.trim()) : 0;

            logger.success('Repository history fetched successfully', {
                taskId,
                repoName,
                branchName: resolvedBranch.displayBranch,
                reflogEntries: parsedReflog.length,
                commits: parsedCommits.length
            });

            return {
                taskId,
                repoName,
                currentBranch,
                latestCommitHash,
                totalCommits,
                reflog: parsedReflog,
                commits: parsedCommits,
                summary: {
                    totalReflogEntries: parsedReflog.length,
                    totalCommitsShown: parsedCommits.length,
                    actionTypes: {
                        commits: parsedReflog.filter((e: any) => e.action === 'commit').length,
                        pulls: parsedReflog.filter((e: any) => e.action === 'pull').length,
                        merges: parsedReflog.filter((e: any) => e.action === 'merge').length,
                        checkouts: parsedReflog.filter((e: any) => e.action === 'checkout').length,
                        resets: parsedReflog.filter((e: any) => e.action === 'reset').length,
                        rebases: parsedReflog.filter((e: any) => e.action === 'rebase').length
                    }
                }
            };
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Commit local changes
     */
    async commitLocalChanges(
        repoName: string,
        taskId: string,
        taskInfo: any,
        remoteBranchName: string,
        commitMessage: string,
        userInfo: any,
        socket?: Socket,
        userId?: string
    ): Promise<{
        taskId: string;
        repoName: string;
        branchName: string;
        commitMessage: string;
        commitHash: string;
        shortHash: string;
        changedFiles: number;
        author: string;
        email: string;
        committedAt: string;
    }> {
        const folderPath = taskInfo.folderPath;
        let commitMsg = commitMessage;
        if (!commitMessage) {
            commitMsg = 'Auto-commit by AI-Playgrounds Bot';
        }

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Starting local commit operation', { taskId, repoName, remoteBranchName, commitMessage });

            // Escape commit message for shell safety
            const commitAuthorName = userInfo?.name || 'Phantom';
            const commitAuthorEmail = userInfo?.email || 'noreply@ai-playgrounds.com';
            const escapedCommitMsg = commitMsg.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
            const escapedAuthorName = commitAuthorName.replace(/"/g, '\\"');
            const escapedAuthorEmail = commitAuthorEmail.replace(/"/g, '\\"');

            // Combine all commands into a single SSH call
            const combinedCommand = `
                cd ${repoName} &&
                sudo git config user.name "${escapedAuthorName}" &&
                sudo git config user.email "${escapedAuthorEmail}" &&
                STATUS=$(sudo git status --porcelain) &&
                if [ -z "$STATUS" ]; then
                    echo "ERROR:NO_CHANGES";
                    exit 1;
                fi &&
                CHANGED_FILES=$(echo "$STATUS" | wc -l) &&
                sudo git add . &&
                sudo git commit -m "${escapedCommitMsg}" &&
                COMMIT_HASH=$(sudo git rev-parse HEAD) &&
                SHORT_HASH=$(sudo git rev-parse --short HEAD) &&
                echo "CHANGED_FILES:$CHANGED_FILES" &&
                echo "COMMIT_HASH:$COMMIT_HASH" &&
                echo "SHORT_HASH:$SHORT_HASH"
            `.replace(/\n\s+/g, ' ');

            const result = await ssh.executeCommand(combinedCommand);

            if (!result.success) {
                if (result.output && result.output.includes('ERROR:NO_CHANGES')) {
                    throw new Error('No changes to commit');
                }
                throw new Error('Failed to commit local changes');
            }

            // Parse output
            const output = result.output;
            const changedFilesMatch = output.match(/CHANGED_FILES:(\d+)/);
            const commitHashMatch = output.match(/COMMIT_HASH:([a-f0-9]+)/);
            const shortHashMatch = output.match(/SHORT_HASH:([a-f0-9]+)/);

            const changedFiles = changedFilesMatch ? parseInt(changedFilesMatch[1]) : 0;
            const commitHash = commitHashMatch ? commitHashMatch[1].trim() : 'unknown';
            const shortHash = shortHashMatch ? shortHashMatch[1].trim() : commitHash.substring(0, 7);

            logger.success('Local commit completed successfully', { taskId, repoName, commitHash, changedFiles });

            const resultData = {
                taskId,
                repoName,
                branchName: remoteBranchName,
                commitMessage,
                commitHash,
                shortHash,
                changedFiles,
                author: commitAuthorName,
                email: commitAuthorEmail,
                committedAt: new Date().toISOString()
            };

            // Emit socket event to refresh repo on client (only when called by AI agent)
            if (socket) {
                socket.emit('refresh_repo', { repoName, taskId });
            }

            // Update database asynchronously (non-blocking)
            if (userId) {
                (async () => {
                    try {
                        const dbService = await getDBService();
                        const dbName = ds.UserInfo.get(userId)?.dbName;
                        if (!dbName) throw new Error('User dbName not found');
                        const taskRepository = dbService.getRepository(dbName, CollectionNames.TASKS);
                        const task = await taskRepository.findOne({ taskId });
                        let gitChanges = (task?.metadata?.github) || {
                            totalAdditions: 0,
                            totalDeletions: 0,
                            totalChangedFiles: 0,
                            pullRequests: [],
                            commits: []
                        };
                        const commitObj = {
                            id: shortHash,
                            sha: commitHash,
                            message: commitMessage,
                            author: commitAuthorEmail,
                            authorName: commitAuthorName,
                            timestamp: resultData.committedAt,
                            url: undefined,
                            additions: changedFiles,
                            deletions: 0,
                            changedFiles: changedFiles,
                            files: []
                        };
                        gitChanges.commits.push(commitObj);
                        gitChanges.totalChangedFiles += changedFiles;
                        await taskRepository.updateOne({ taskId }, { $set: { 'metadata.github': gitChanges } });
                    } catch (err) {
                        logger.error('Failed to update task metadata.github for commit', { taskId, err });
                    }
                })();
            }

            return resultData;
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Create pull request
     */
    async createPullRequest(
        repoName: string,
        taskId: string,
        taskInfo: any,
        installationId: number,
        targetBranch: string,
        title?: string,
        body?: string,
        socket?: Socket,
        userId?: string
    ): Promise<{
        taskId: string;
        repoName: string;
        headBranch: string;
        targetBranch: string;
        prNumber: number;
        prUrl: string;
        prTitle: string;
        commitsAhead: number;
        createdAt: string;
        alreadyExists?: boolean;
    }> {
        const folderPath = taskInfo.folderPath;
        const installationToken = await fetchInstallationToken(installationId);
        const gitOrgName = await getGithubOrganizationName(installationId);

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Creating pull request', { taskId, repoName, targetBranch });

            // Combine commands into a single SSH call, with remote URL set/unset
            const combinedCommand = `
                cd ${repoName} &&
                sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${gitOrgName}/${repoName}.git &&
                HEAD_BRANCH=$(sudo git rev-parse --abbrev-ref HEAD) &&
                sudo git fetch origin ${targetBranch} 2>/dev/null &&
                COMMITS_AHEAD=$(sudo git rev-list --count origin/${targetBranch}..$HEAD_BRANCH 2>/dev/null || echo 0) &&
                if [ "$COMMITS_AHEAD" = "0" ]; then
                    echo "ERROR:NO_COMMITS:$HEAD_BRANCH";
                    sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git;
                    exit 1;
                fi &&
                echo "HEAD_BRANCH:$HEAD_BRANCH" &&
                echo "COMMITS_AHEAD:$COMMITS_AHEAD" &&
                sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git
            `.replace(/\n\s+/g, ' ');

            let result = await ssh.executeCommand(combinedCommand);

            const output = result.output || '';
            const headBranchMatch = output.match(/HEAD_BRANCH:([^\n]+)/);
            const commitsAheadMatch = output.match(/COMMITS_AHEAD:(\d+)/);
            const errorMatch = output.match(/ERROR:NO_COMMITS:([^\n]+)/);

            let headBranch = headBranchMatch ? headBranchMatch[1].trim() : 'unknown';
            const commitsAhead = commitsAheadMatch ? parseInt(commitsAheadMatch[1]) : 0;

            if (!result.success && errorMatch) {
                headBranch = errorMatch[1].trim();
            }

            const { Octokit } = require('@octokit/rest');
            const octokit = new Octokit({
                auth: installationToken.token
            });

            // Always check for existing PR first even if there are no new commits
            try {
                const existingPRs = await octokit.pulls.list({
                    owner: gitOrgName,
                    repo: repoName,
                    head: `${gitOrgName}:${headBranch}`,
                    base: targetBranch,
                    state: 'open'
                });

                if (existingPRs.data.length > 0) {
                    const existingPR = existingPRs.data[0];
                    logger.info('Pull request already exists', {
                        taskId,
                        repoName,
                        prNumber: existingPR.number,
                        prUrl: existingPR.html_url
                    });

                    const resultData = {
                        taskId,
                        repoName,
                        headBranch,
                        targetBranch,
                        prNumber: existingPR.number,
                        prUrl: existingPR.html_url,
                        prTitle: existingPR.title,
                        commitsAhead,
                        createdAt: existingPR.created_at,
                        alreadyExists: true
                    };

                    // Emit socket event to refresh PR status on client
                    if (socket) {
                        socket.emit('refresh_pr_status', { repoName, taskId, prNumber: existingPR.number });
                    }

                    // Update database asynchronously (non-blocking)
                    this.updatePRMetadata(taskId, userId, resultData);

                    return resultData;
                }
            } catch (fetchError: any) {
                logger.error('Failed to check for existing PR', fetchError);
            }

            // No existing PR found - check if we have commits to create one
            if (!result.success) {
                if (errorMatch) {
                    throw new Error(`No commits to create PR. Branch '${headBranch}' is not ahead of '${targetBranch}'`);
                }
                throw new Error('Failed to prepare pull request');
            }

            // Create new PR
            const prTitle = title || `Merge ${headBranch} into ${targetBranch}`;
            const prBody = body || `This pull request merges changes from ${headBranch} into ${targetBranch}.\n\nCreated by AI-Playgrounds`;

            try {
                const prResponse = await octokit.pulls.create({
                    owner: gitOrgName,
                    repo: repoName,
                    title: prTitle,
                    body: prBody,
                    head: headBranch,
                    base: targetBranch
                });

                const prUrl = prResponse.data.html_url;
                const prNumber = prResponse.data.number;

                logger.success('Pull request created successfully', {
                    taskId,
                    repoName,
                    prNumber,
                    prUrl
                });
                taskInfo.status = TaskStatus.Completed;
                taskInfo.nonRunningSince = new Date();
                //updating the task status in the db
                let dbService = await getDBService();
                let taskHanlder = dbService.getRepository<Task>(ds.UserInfo.get(userId as any)?.dbName, CollectionNames.TASKS);
                taskHanlder.updateOne({
                    taskId: taskId
                },
                    {
                        "$set": {
                            status: TaskStatus.Completed
                        }
                    });
                const resultData = {
                    taskId,
                    repoName,
                    headBranch,
                    targetBranch,
                    prNumber,
                    prUrl,
                    prTitle,
                    commitsAhead,
                    createdAt: new Date().toISOString()
                };

                // Emit socket event to refresh PR status on client
                if (socket) {
                    socket.emit('refresh_pr_status', { repoName, taskId, prNumber });
                }

                // Update database asynchronously (non-blocking)
                this.updatePRMetadata(taskId, userId, resultData);

                return resultData;
            } catch (prError: any) {
                // Check if PR already exists
                if (prError.status === 422) {
                    // Fetch existing PR
                    try {
                        const existingPRs = await octokit.pulls.list({
                            owner: gitOrgName,
                            repo: repoName,
                            head: `${gitOrgName}:${headBranch}`,
                            base: targetBranch,
                            state: 'open'
                        });

                        if (existingPRs.data.length > 0) {
                            const existingPR = existingPRs.data[0];
                            logger.info('Pull request already exists', {
                                taskId,
                                repoName,
                                prNumber: existingPR.number,
                                prUrl: existingPR.html_url
                            });

                            const resultData = {
                                taskId,
                                repoName,
                                headBranch,
                                targetBranch,
                                prNumber: existingPR.number,
                                prUrl: existingPR.html_url,
                                prTitle: existingPR.title,
                                commitsAhead,
                                createdAt: existingPR.created_at,
                                alreadyExists: true
                            };

                            // Emit socket event to refresh PR status on client
                            if (socket) {
                                socket.emit('refresh_pr_status', { repoName, taskId, prNumber: existingPR.number });
                            }

                            // Update database asynchronously (non-blocking)
                            this.updatePRMetadata(taskId, userId, resultData);

                            return resultData;
                        }
                    } catch (fetchError) {
                        logger.error('Failed to fetch existing PR', fetchError);
                    }
                }
                throw prError;
            }
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Check if pull request exists
     */
    async mergeBranchIntoBranch(
        repoName: string,
        taskId: string,
        taskInfo: any,
        installationId: number,
        sourceBranch: string,
        targetBranch: string,
        pushToRemote: boolean = false,
        socket?: Socket
    ): Promise<{
        taskId: string;
        repoName: string;
        sourceBranch: string;
        targetBranch: string;
        merged: boolean;
        hasConflicts: boolean;
        conflictFiles: string[];
        currentBranch: string;
        commitHash?: string;
        pushedToRemote: boolean;
        mergedAt: string;
        message: string;
    }> {
        const folderPath = taskInfo.folderPath;
        const installationToken = await fetchInstallationToken(installationId);
        const gitOrgName = await getGithubOrganizationName(installationId);

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            const trimmedSourceBranch = (sourceBranch || '').trim();
            const trimmedTargetBranch = (targetBranch || '').trim();

            if (!trimmedSourceBranch || !trimmedTargetBranch) {
                throw new Error('Both sourceBranch and targetBranch are required');
            }

            if (trimmedSourceBranch === trimmedTargetBranch) {
                throw new Error('sourceBranch and targetBranch cannot be the same');
            }

            logger.info('Starting branch merge operation', {
                taskId,
                repoName,
                sourceBranch: trimmedSourceBranch,
                targetBranch: trimmedTargetBranch,
                pushToRemote
            });

            let result = await ssh.executeCommand(`cd ${repoName} && sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${gitOrgName}/${repoName}.git`);
            if (!result.success) {
                throw new Error(`Failed to set authenticated remote URL: ${result.error || result.output || 'Unknown error'}`);
            }

            const fetchResult = await ssh.executeCommand(`cd ${repoName} && sudo git fetch origin --prune`);
            if (!fetchResult.success) {
                throw new Error(`Failed to fetch remote branches: ${fetchResult.error || fetchResult.output || 'Unknown error'}`);
            }

            const resolvedSource = await this.resolveBranchReference(ssh, repoName, trimmedSourceBranch);
            const resolvedTarget = await this.resolveBranchReference(ssh, repoName, trimmedTargetBranch);

            const targetLocalBranch = resolvedTarget.displayBranch;
            const safeTargetLocalBranch = this.escapeSingleQuotedShell(targetLocalBranch);
            const safeSourceRef = this.escapeSingleQuotedShell(resolvedSource.resolvedRef);

            const prepareBranchCommand = `
                cd ${repoName} &&
                TARGET_LOCAL='${safeTargetLocalBranch}' &&
                if sudo git show-ref --verify --quiet "refs/heads/$TARGET_LOCAL"; then
                    sudo git checkout "$TARGET_LOCAL";
                elif sudo git show-ref --verify --quiet "refs/remotes/origin/$TARGET_LOCAL"; then
                    sudo git checkout -b "$TARGET_LOCAL" "origin/$TARGET_LOCAL";
                else
                    echo "ERROR:TARGET_BRANCH_NOT_CHECKOUTABLE";
                    exit 1;
                fi &&
                if sudo git show-ref --verify --quiet "refs/remotes/origin/$TARGET_LOCAL"; then
                    sudo git pull --ff-only origin "$TARGET_LOCAL" 2>/dev/null || true;
                fi
            `.replace(/\n\s+/g, ' ');

            result = await ssh.executeCommand(prepareBranchCommand);
            if (!result.success) {
                throw new Error(`Failed to prepare target branch for merge: ${result.error || result.output || 'Unknown error'}`);
            }

            const mergeCommand = `cd ${repoName} && SOURCE_REF='${safeSourceRef}' && sudo git merge --no-ff --no-edit "$SOURCE_REF"`;
            const mergeResult = await ssh.executeCommand(mergeCommand);

            if (!mergeResult.success) {
                const conflictResult = await ssh.executeCommand(`cd ${repoName} && sudo git diff --name-only --diff-filter=U`);
                const conflictFiles = (conflictResult.output || '')
                    .split('\n')
                    .map((line: string) => line.trim())
                    .filter((line: string) => line.length > 0);

                if (conflictFiles.length > 0) {
                    logger.warn('Merge completed with conflicts', {
                        taskId,
                        repoName,
                        sourceBranch: resolvedSource.displayBranch,
                        targetBranch: targetLocalBranch,
                        conflictFiles
                    });

                    return {
                        taskId,
                        repoName,
                        sourceBranch: resolvedSource.displayBranch,
                        targetBranch: targetLocalBranch,
                        merged: false,
                        hasConflicts: true,
                        conflictFiles,
                        currentBranch: targetLocalBranch,
                        pushedToRemote: false,
                        mergedAt: new Date().toISOString(),
                        message: `Merge has conflicts. Resolve conflicts in target branch '${targetLocalBranch}'.`
                    };
                }

                throw new Error(`Failed to merge branches: ${mergeResult.error || mergeResult.output || 'Unknown error'}`);
            }

            const summaryResult = await ssh.executeCommand(`cd ${repoName} && COMMIT_HASH=$(sudo git rev-parse HEAD) && CURRENT_BRANCH=$(sudo git rev-parse --abbrev-ref HEAD) && echo "COMMIT_HASH:$COMMIT_HASH" && echo "CURRENT_BRANCH:$CURRENT_BRANCH"`);
            if (!summaryResult.success) {
                throw new Error(`Merge succeeded but failed to fetch merge summary: ${summaryResult.error || summaryResult.output || 'Unknown error'}`);
            }

            const summaryOutput = summaryResult.output || '';
            const commitHashMatch = summaryOutput.match(/COMMIT_HASH:([^\n]+)/);
            const currentBranchMatch = summaryOutput.match(/CURRENT_BRANCH:([^\n]+)/);
            const commitHash = commitHashMatch ? commitHashMatch[1].trim() : '';
            const currentBranch = currentBranchMatch ? currentBranchMatch[1].trim() : targetLocalBranch;

            let pushedToRemote = false;
            if (pushToRemote) {
                const pushResult = await ssh.executeCommand(`cd ${repoName} && sudo git push origin '${safeTargetLocalBranch}'`);
                if (!pushResult.success) {
                    throw new Error(`Merge succeeded but push failed: ${pushResult.error || pushResult.output || 'Unknown error'}`);
                }
                pushedToRemote = true;
            }

            logger.success('Branch merge completed successfully', {
                taskId,
                repoName,
                sourceBranch: resolvedSource.displayBranch,
                targetBranch: targetLocalBranch,
                commitHash,
                pushedToRemote
            });

            if (socket) {
                socket.emit('refresh_repo', { repoName, taskId });
            }

            return {
                taskId,
                repoName,
                sourceBranch: resolvedSource.displayBranch,
                targetBranch: targetLocalBranch,
                merged: true,
                hasConflicts: false,
                conflictFiles: [],
                currentBranch,
                commitHash,
                pushedToRemote,
                mergedAt: new Date().toISOString(),
                message: pushedToRemote
                    ? `Merged '${resolvedSource.displayBranch}' into '${targetLocalBranch}' and pushed to remote.`
                    : `Merged '${resolvedSource.displayBranch}' into '${targetLocalBranch}' locally.`
            };
        } finally {
            try {
                await ssh.executeCommand(`cd ${repoName} && sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git`);
            }
            catch (restoreError) {
                logger.error('Failed to restore unauthenticated remote URL after merge operation', {
                    taskId,
                    repoName,
                    error: restoreError instanceof Error ? restoreError.message : String(restoreError)
                });
            }
            await ssh.disconnect();
        }
    }

    async checkPullRequestExists(
        repoName: string,
        taskId: string,
        taskInfo: any,
        installationId: number,
        targetBranch: string
    ): Promise<{
        taskId: string;
        repoName: string;
        headBranch: string;
        targetBranch: string;
        prExists: boolean;
        prNumber?: number;
        prUrl?: string;
        prTitle?: string;
        commitsAhead: number;
        createdAt?: string;
    }> {
        const folderPath = taskInfo.folderPath;
        const installationToken = await fetchInstallationToken(installationId);
        const gitOrgName = await getGithubOrganizationName(installationId);

        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Checking if PR exists', { taskId, repoName, targetBranch });

            // Get current branch and commits ahead
            const combinedCommand = `
                cd ${repoName} &&
                sudo git remote set-url origin https://x-access-token:${installationToken.token}@github.com/${gitOrgName}/${repoName}.git &&
                HEAD_BRANCH=$(sudo git rev-parse --abbrev-ref HEAD) &&
                sudo git fetch origin ${targetBranch} &&
                COMMITS_AHEAD=$(sudo git rev-list --count origin/${targetBranch}..$HEAD_BRANCH 2>/dev/null || echo 0) &&
                sudo git remote set-url origin https://github.com/${gitOrgName}/${repoName}.git &&
                echo "HEAD_BRANCH:$HEAD_BRANCH" &&
                echo "COMMITS_AHEAD:$COMMITS_AHEAD"
            `.replace(/\n\s+/g, ' ');

            const result = await ssh.executeCommand(combinedCommand);

            // Check for command execution failure
            if (!result.success) {
                logger.error('Failed to check PR status', {
                    taskId,
                    repoName,
                    error: result.error,
                    code: result.code,
                    output: result.output
                });
                throw new Error(`Failed to check PR status: ${result.error}`);
            }

            const output = result.output || '';
            const headBranchMatch = output.match(/HEAD_BRANCH:([^\n]+)/);
            const commitsAheadMatch = output.match(/COMMITS_AHEAD:(\d+)/);

            const headBranch = headBranchMatch ? headBranchMatch[1].trim() : 'unknown';
            const commitsAhead = commitsAheadMatch ? parseInt(commitsAheadMatch[1]) : 0;

            logger.info('Branch info retrieved', { taskId, headBranch, commitsAhead });

            // Check for existing PR
            const { Octokit } = require('@octokit/rest');
            const octokit = new Octokit({
                auth: installationToken.token
            });

            const existingPRs = await octokit.pulls.list({
                owner: gitOrgName,
                repo: repoName,
                head: `${gitOrgName}:${headBranch}`,
                base: targetBranch,
                state: 'open'
            });

            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                logger.info('Pull request exists', {
                    taskId,
                    repoName,
                    prNumber: existingPR.number,
                    prUrl: existingPR.html_url
                });

                return {
                    taskId,
                    repoName,
                    headBranch,
                    targetBranch,
                    prExists: true,
                    prNumber: existingPR.number,
                    prUrl: existingPR.html_url,
                    prTitle: existingPR.title,
                    commitsAhead,
                    createdAt: existingPR.created_at
                };
            } else {
                logger.info('No pull request found', { taskId, repoName, headBranch, targetBranch });

                return {
                    taskId,
                    repoName,
                    headBranch,
                    targetBranch,
                    prExists: false,
                    commitsAhead
                };
            }
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Get commit list with commit IDs for a branch
     */
    async getCommitList(
        repoName: string,
        taskId: string,
        taskInfo: any,
        branchName?: string,
        limit: number = 100
    ): Promise<{
        taskId: string;
        repoName: string;
        branchName: string;
        totalCommits: number;
        commits: Array<{
            hash: string;
            fullHash: string;
            author: string;
            email: string;
            date: string;
            message: string;
        }>;
    }> {
        const folderPath = taskInfo.folderPath;
        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Fetching commit list', { taskId, repoName, branchName, limit });

            const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100;

            let targetBranch = (branchName || '').trim();
            if (!targetBranch) {
                const branchResult = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse --abbrev-ref HEAD`);
                if (!branchResult.success) {
                    throw new Error(`Failed to resolve current branch: ${branchResult.error || branchResult.output || 'Unknown error'}`);
                }
                targetBranch = branchResult.output.trim();
            }

            const resolvedBranch = await this.resolveBranchReference(ssh, repoName, targetBranch);
            const safeResolvedRef = this.escapeSingleQuotedShell(resolvedBranch.resolvedRef);

            const logResult = await ssh.executeCommand(`cd ${repoName} && sudo git log '${safeResolvedRef}' -${safeLimit} --pretty=format:"%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s" --date=iso`);
            if (!logResult.success) {
                throw new Error(`Failed to fetch commit list: ${logResult.error || logResult.output || 'Unknown error'}`);
            }

            const commitLines = (logResult.output || '').trim()
                ? logResult.output.trim().split('\n').filter((line: any) => line.trim())
                : [];

            const commits = commitLines
                .map((line: any) => {
                    const [fullHash, hash, author, email, date, ...messageParts] = line.split('\x1f');
                    return {
                        hash: (hash || '').trim(),
                        fullHash: (fullHash || '').trim(),
                        author: (author || '').trim(),
                        email: (email || '').trim(),
                        date: (date || '').trim(),
                        message: messageParts.join('\x1f').trim()
                    };
                })
                .filter((commit: any) => commit.fullHash);

            logger.success('Commit list fetched successfully', {
                taskId,
                repoName,
                branchName: resolvedBranch.displayBranch,
                commits: commits.length
            });

            return {
                taskId,
                repoName,
                branchName: resolvedBranch.displayBranch,
                totalCommits: commits.length,
                commits
            };
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Get latest commit diff for a given branch
     */
    async getLatestCommitDiff(
        repoName: string,
        taskId: string,
        taskInfo: any,
        branchName?: string
    ): Promise<{
        taskId: string;
        repoName: string;
        branchName: string;
        commit: {
            hash: string;
            fullHash: string;
            author: string;
            email: string;
            date: string;
            message: string;
        };
        diff: string;
        summary: {
            filesChanged: number;
            totalAdditions: number;
            totalDeletions: number;
            totalChanges: number;
        };
    }> {
        const folderPath = taskInfo.folderPath;
        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Fetching latest commit diff', { taskId, repoName, branchName });

            let targetBranch = (branchName || '').trim();
            if (!targetBranch) {
                const branchResult = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse --abbrev-ref HEAD`);
                if (!branchResult.success) {
                    throw new Error(`Failed to resolve current branch: ${branchResult.error || branchResult.output || 'Unknown error'}`);
                }
                targetBranch = branchResult.output.trim();
            }

            const resolvedBranch = await this.resolveBranchReference(ssh, repoName, targetBranch);
            const safeResolvedRef = this.escapeSingleQuotedShell(resolvedBranch.resolvedRef);

            const commitInfoResult = await ssh.executeCommand(`cd ${repoName} && sudo git show --no-patch --pretty=format:"%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s" --date=iso '${safeResolvedRef}'`);
            if (!commitInfoResult.success) {
                throw new Error(`Failed to fetch latest commit information: ${commitInfoResult.error || commitInfoResult.output || 'Unknown error'}`);
            }

            const commitInfo = (commitInfoResult.output || '').trim();
            if (!commitInfo) {
                throw new Error(`No commits found on branch '${resolvedBranch.displayBranch}'`);
            }

            const [fullHash, hash, author, email, date, ...messageParts] = commitInfo.split('\x1f');
            const commitMessage = messageParts.join('\x1f').trim();
            const safeCommitHash = this.escapeSingleQuotedShell((fullHash || '').trim());

            const diffResult = await ssh.executeCommand(`cd ${repoName} && sudo git show --pretty=format:"" '${safeCommitHash}'`);
            if (!diffResult.success) {
                throw new Error(`Failed to fetch diff for commit '${hash}': ${diffResult.error || diffResult.output || 'Unknown error'}`);
            }

            const statsResult = await ssh.executeCommand(`cd ${repoName} && sudo git show --numstat --pretty="" '${safeCommitHash}'`);
            if (!statsResult.success) {
                throw new Error(`Failed to fetch commit stats for '${hash}': ${statsResult.error || statsResult.output || 'Unknown error'}`);
            }

            const statLines = (statsResult.output || '').trim()
                ? statsResult.output.trim().split('\n').filter((line: any) => line.trim())
                : [];

            let totalAdditions = 0;
            let totalDeletions = 0;

            for (const line of statLines) {
                const [additionsRaw, deletionsRaw] = line.split('\t');
                const additions = additionsRaw === '-' ? 0 : parseInt(additionsRaw, 10) || 0;
                const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0;
                totalAdditions += additions;
                totalDeletions += deletions;
            }

            logger.success('Latest commit diff fetched successfully', {
                taskId,
                repoName,
                branchName: resolvedBranch.displayBranch,
                commitHash: hash,
                filesChanged: statLines.length
            });

            return {
                taskId,
                repoName,
                branchName: resolvedBranch.displayBranch,
                commit: {
                    hash: (hash || '').trim(),
                    fullHash: (fullHash || '').trim(),
                    author: (author || '').trim(),
                    email: (email || '').trim(),
                    date: (date || '').trim(),
                    message: commitMessage
                },
                diff: diffResult.output || '',
                summary: {
                    filesChanged: statLines.length,
                    totalAdditions,
                    totalDeletions,
                    totalChanges: totalAdditions + totalDeletions
                }
            };
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Get diff for a specific commit hash
     */
    async getCommitDiffByHash(
        repoName: string,
        taskId: string,
        taskInfo: any,
        commitHash: string
    ): Promise<{
        taskId: string;
        repoName: string;
        commit: {
            hash: string;
            fullHash: string;
            author: string;
            email: string;
            date: string;
            message: string;
        };
        diff: string;
        summary: {
            filesChanged: number;
            totalAdditions: number;
            totalDeletions: number;
            totalChanges: number;
        };
    }> {
        const folderPath = taskInfo.folderPath;
        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            const requestedCommit = (commitHash || '').trim();
            if (!requestedCommit) {
                throw new Error('commitHash is required');
            }

            logger.info('Fetching commit diff by hash', { taskId, repoName, commitHash: requestedCommit });

            const sanitizedCommitHash = requestedCommit.replace(/'/g, `'\\''`);
            const commitCheck = await ssh.executeCommand(`cd ${repoName} && sudo git rev-parse --verify '${sanitizedCommitHash}^{commit}' >/dev/null 2>&1 && echo "COMMIT_OK"`);
            if (!commitCheck.success || !(commitCheck.output || '').includes('COMMIT_OK')) {
                throw new Error(`Commit '${requestedCommit}' not found in repository '${repoName}'`);
            }

            const commitInfoResult = await ssh.executeCommand(`cd ${repoName} && sudo git show --no-patch --pretty=format:"%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s" --date=iso '${sanitizedCommitHash}'`);
            if (!commitInfoResult.success) {
                throw new Error(`Failed to fetch commit information: ${commitInfoResult.error || commitInfoResult.output || 'Unknown error'}`);
            }

            const commitInfo = (commitInfoResult.output || '').trim();
            if (!commitInfo) {
                throw new Error(`No commit metadata found for '${requestedCommit}'`);
            }

            const [fullHash, hash, author, email, date, ...messageParts] = commitInfo.split('\x1f');
            const commitMessage = messageParts.join('\x1f').trim();

            const diffResult = await ssh.executeCommand(`cd ${repoName} && sudo git show --pretty=format:"" '${sanitizedCommitHash}'`);
            if (!diffResult.success) {
                throw new Error(`Failed to fetch diff for commit '${requestedCommit}': ${diffResult.error || diffResult.output || 'Unknown error'}`);
            }

            const statsResult = await ssh.executeCommand(`cd ${repoName} && sudo git show --numstat --pretty="" '${sanitizedCommitHash}'`);
            if (!statsResult.success) {
                throw new Error(`Failed to fetch commit stats for '${requestedCommit}': ${statsResult.error || statsResult.output || 'Unknown error'}`);
            }

            const statLines = (statsResult.output || '').trim()
                ? statsResult.output.trim().split('\n').filter((line: any) => line.trim())
                : [];

            let totalAdditions = 0;
            let totalDeletions = 0;

            for (const line of statLines) {
                const [additionsRaw, deletionsRaw] = line.split('\t');
                const additions = additionsRaw === '-' ? 0 : parseInt(additionsRaw, 10) || 0;
                const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0;
                totalAdditions += additions;
                totalDeletions += deletions;
            }

            logger.success('Commit diff fetched successfully', {
                taskId,
                repoName,
                commitHash: hash,
                filesChanged: statLines.length
            });

            return {
                taskId,
                repoName,
                commit: {
                    hash: (hash || '').trim(),
                    fullHash: (fullHash || '').trim(),
                    author: (author || '').trim(),
                    email: (email || '').trim(),
                    date: (date || '').trim(),
                    message: commitMessage
                },
                diff: diffResult.output || '',
                summary: {
                    filesChanged: statLines.length,
                    totalAdditions,
                    totalDeletions,
                    totalChanges: totalAdditions + totalDeletions
                }
            };
        } finally {
            await ssh.disconnect();
        }
    }

    /**
     * Get commit details
     */
    async getCommitDetails(
        repoName: string,
        taskId: string,
        taskInfo: any,
        commitHash: string
    ): Promise<{
        taskId: string;
        repoName: string;
        commit: {
            hash: string;
            fullHash: string;
            author: string;
            email: string;
            date: string;
            message: string;
        };
        files: Array<{
            filename: string;
            additions: number;
            deletions: number;
            changes: number;
            status: string;
        }>;
        summary: {
            totalFiles: number;
            totalAdditions: number;
            totalDeletions: number;
            totalChanges: number;
            filesByStatus: {
                added: number;
                modified: number;
                deleted: number;
                binary: number;
            };
        };
    }> {
        const folderPath = taskInfo.folderPath;
        const ssh = new SSHClient(folderPath, taskInfo.ec2InstanceIP);
        await ssh.connect();

        try {
            logger.info('Fetching commit details', { taskId, repoName, commitHash });

            // Get commit information and file changes in a single SSH call
            const combinedCommand = `
                cd ${repoName} &&
                COMMIT_INFO=$(sudo git show --no-patch --pretty=format:"%H|%h|%an|%ae|%ad|%s" --date=iso ${commitHash}) &&
                FILE_STATS=$(sudo git show --stat --pretty="" --numstat ${commitHash}) &&
                echo "COMMIT_INFO:$COMMIT_INFO" &&
                echo "FILE_STATS_START" &&
                echo "$FILE_STATS" &&
                echo "FILE_STATS_END"
            `.replace(/\n\s+/g, ' ');

            const result = await ssh.executeCommand(combinedCommand);

            if (!result.success) {
                throw new Error('Failed to fetch commit details');
            }

            // Parse commit info
            const output = result.output;
            const commitInfoMatch = output.match(/COMMIT_INFO:([^\n]+)/);

            if (!commitInfoMatch) {
                throw new Error('Failed to parse commit information');
            }

            const [fullHash, shortHash, author, email, date, message] = commitInfoMatch[1].split('|');

            // Parse file statistics
            const fileStatsMatch = output.match(/FILE_STATS_START\n([\s\S]*?)FILE_STATS_END/);
            const fileStatsRaw = fileStatsMatch ? fileStatsMatch[1].trim() : '';

            const modifiedFiles: Array<{
                filename: string;
                additions: number;
                deletions: number;
                changes: number;
                status: string;
            }> = [];

            let totalAdditions = 0;
            let totalDeletions = 0;

            if (fileStatsRaw) {
                const lines = fileStatsRaw.split('\n').filter((line: any) => line.trim());

                for (const line of lines) {
                    // Format: additions\tdeletions\tfilename
                    const parts = line.split('\t');
                    if (parts.length >= 3) {
                        const additions = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
                        const deletions = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
                        const filename = parts[2];

                        // Determine file status
                        let status = 'modified';
                        if (additions > 0 && deletions === 0) {
                            status = 'added';
                        } else if (additions === 0 && deletions > 0) {
                            status = 'deleted';
                        } else if (parts[0] === '-' && parts[1] === '-') {
                            status = 'binary';
                        }

                        modifiedFiles.push({
                            filename,
                            additions,
                            deletions,
                            changes: additions + deletions,
                            status
                        });

                        totalAdditions += additions;
                        totalDeletions += deletions;
                    }
                }
            }

            logger.success('Commit details fetched successfully', {
                taskId,
                repoName,
                commitHash: shortHash,
                filesModified: modifiedFiles.length
            });

            return {
                taskId,
                repoName,
                commit: {
                    hash: shortHash,
                    fullHash,
                    author,
                    email,
                    date,
                    message
                },
                files: modifiedFiles,
                summary: {
                    totalFiles: modifiedFiles.length,
                    totalAdditions,
                    totalDeletions,
                    totalChanges: totalAdditions + totalDeletions,
                    filesByStatus: {
                        added: modifiedFiles.filter(f => f.status === 'added').length,
                        modified: modifiedFiles.filter(f => f.status === 'modified').length,
                        deleted: modifiedFiles.filter(f => f.status === 'deleted').length,
                        binary: modifiedFiles.filter(f => f.status === 'binary').length
                    }
                }
            };
        } finally {
            await ssh.disconnect();
        }
    }


    /**
     * Helper method to get merge conflicts
     */
    private async getMergeConflicts(socket: Socket, taskId: string, taskInfo: any, repoName: string): Promise<any> {
        return new Promise((resolve) => {
            let id: string = (socket.data.user.wpId == undefined || socket.data.user.wpId == null) ? taskId : socket.data.user.wpId;
            let fileServerClient:any = fileServerClientManager.getOrCreateClient(id, taskInfo.ec2InstanceIP as any, socket);
            fileServerClient.emit("get_merge_conflicts", { repoName: repoName }, (mergeData: any) => {
                resolve(mergeData);
            });
        });
    }
}
