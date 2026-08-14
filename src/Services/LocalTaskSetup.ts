import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as dotenv from 'dotenv';
dotenv.config();
const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommandResult {
    success: boolean;
    output: string;
    error: string;
}

interface RepoSetupParams {
    repoName: string;
    branchName: string;
    githubToken: any;       // GitHub installation / PAT token (caller's responsibility to fetch)
    githubOrgName: string;     // GitHub organisation name
    envContent: string;        // Raw content to write to .env (caller builds this; no DB access here)
}

export interface LocalTaskParams {
   folderPath:string;
    wpId: string;
    taskId:string;
    dockerFolder:string;
    repos: RepoSetupParams[];
    // dockerSourcePath is derived from the standard path convention:
    // /mnt/efs2/<org>/<userId>/WorkspaceData/<wpId>/docker/
    // taskFolderPath is derived from:
    // /mnt/efs1/<org>/<userId>/Tasks/<taskId>
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Runs a shell command locally and returns a result object
 * that mirrors what SSHClient.executeCommand returns, so the
 * rest of the logic stays identical.
 */
const BASH_SHELL = process.platform === 'win32' ? 'bash' : '/bin/bash';

async function runCommand(command: string, cwd?: string): Promise<CommandResult> {
    try { 
        // NOTE: We intentionally do NOT pass `cwd` to execAsync.
        // On Windows, execAsync resolves `cwd` using the Windows kernel before spawning
        // the shell, so WSL paths like /mnt/f/... cause ENOENT immediately.
        // Instead we prepend `cd "<cwd>" &&` so the directory change happens
        // inside WSL bash, where WSL paths are fully valid.
        const normalizedCwd = cwd ? cwd.replace(/\\/g, '/') : undefined;
        const fullCommand = normalizedCwd ? `cd "${normalizedCwd}" && ${command}` : command;
        const { stdout, stderr } = await execAsync(fullCommand, { shell: BASH_SHELL });
        return {
            success: true,
            output: stdout + (stderr ? '\n' + stderr : ''),
            error: stderr
        };
    } catch (err: any) {
        return {
            success: false,
            output: err.stdout ?? '',
            error: err.stderr ?? err.message ?? String(err)
        };
    }
}

// ─── Step 1 ── Create task directory ─────────────────────────────────────────

/**
 * Creates the task working directory locally.
 * Equivalent of createTaskDir() via SSH.
 */
export async function createTaskDir(taskFolderPath: string): Promise<string> {
    console.log(`[createTaskDir] Creating task directory: ${taskFolderPath}`);

    const result = await runCommand(`mkdir -p ${taskFolderPath}`);
    if (result.success) {
        console.log(`[createTaskDir] Directory created successfully: ${taskFolderPath}`);
    } else {
        console.error(`[createTaskDir] Failed to create directory: ${result.error}`);
    }
    return taskFolderPath;
}

// ─── Step 2 ── Clone repo and checkout branch ─────────────────────────────────

/**
 * Clones a GitHub repo into taskFolderPath and checks out the given branch.
 * Also appends /.AIMetadata to .gitignore.
 * Equivalent of cloneAndSetupBranch() via SSH.
 */
export async function cloneAndSetupBranch(
    taskFolderPath: string,
    repoName: string,
    branchName: string,
    githubToken: string,
    githubOrgName: string
): Promise<void> {
    console.log(`[cloneAndSetupBranch] Cloning ${repoName} → branch ${branchName}`);

    // Clone
    // const cloneResult = await runCommand(
    //     `git clone https://x-access-token:${githubToken}@github.com/${githubOrgName}/${repoName}.git`,
    //     taskFolderPath
    // );

    // if (!cloneResult.success) {
    //     console.error(`[cloneAndSetupBranch] Clone failed: ${cloneResult.error}`);
    //     throw new Error(cloneResult.error);
    // }
    console.log(`[cloneAndSetupBranch] Cloned successfully`);

    // Checkout branch
    const checkoutResult = await runCommand(
        `git checkout ${branchName}`,
        path.posix.join(taskFolderPath, repoName)
    );

    if (checkoutResult.success) {
        console.log(`[cloneAndSetupBranch] Checked out branch: ${branchName}`);
    } else {
        console.error(`[cloneAndSetupBranch] Branch checkout failed: ${checkoutResult.error}`);
    }

    // Add .AIMetadata to .gitignore
    const gitignoreResult = await runCommand(
        `echo "/.AIMetadata" >> .gitignore`,
        path.posix.join(taskFolderPath, repoName)
    );

    if (gitignoreResult.success) {
        console.log(`[cloneAndSetupBranch] .AIMetadata added to .gitignore`);
    } else {
        console.warn(`[cloneAndSetupBranch] Failed to update .gitignore: ${gitignoreResult.error}`);
    }
}

// ─── Step 3 ── Update directory permissions ───────────────────────────────────

/**
 * Recursively grants full permissions on the task folder.
 * Equivalent of updateDirectoryPermissions() via SSH.
 */
export async function updateDirectoryPermissions(taskFolderPath: string): Promise<void> {
    console.log(`[updateDirectoryPermissions] chmod -R 777 ${taskFolderPath}`);

    const result = await runCommand(`chmod -R 777 ${taskFolderPath}`);
    if (result.success) {
        console.log(`[updateDirectoryPermissions] Permissions updated`);
    } else {
        console.error(`[updateDirectoryPermissions] Failed: ${result.error}`);
    }
}

// ─── Step 4 ── Write .env secrets file ───────────────────────────────────────

/**
 * Writes the provided envContent string to <taskFolderPath>/<repoName>/.env.
 * The caller is responsible for building envContent (no DB access in this file).
 * Equivalent of setSecrets() via SSH.
 */
export async function setSecrets(
    taskFolderPath: string,
    repoName: string,
    envContent: string
): Promise<void> {
    const envFilePath = path.posix.join(taskFolderPath, repoName, '.env');
    console.log(`[setSecrets] Writing .env to ${envFilePath}`);

    try {
        // Write via Node fs so there's no shell quoting complexity
        fs.writeFileSync(envFilePath, envContent, { encoding: 'utf-8' });
        console.log(`[setSecrets] Secrets written to ${envFilePath}`);
    } catch (err: any) {
        console.error(`[setSecrets] Failed to write .env: ${err.message}`);
        throw err;
    }
}

// ─── Step 5 ── Start Docker environment (task container) ──────────────────────

/**
 * Copies Dockerfile + docker-compose.yml from the workspace docker store into
 * the task folder and starts the container with docker compose.
 * Equivalent of startDockerEnvironmentTask() via SSH.
 */
export async function startDockerEnvironmentTask(
    taskFolderPath: string,
    taskId:string,
    dockerFolderPath:string  
): Promise<void> {
    const dockerSourcePath = dockerFolderPath;
    const containerName = taskId;// the task Id will be the name of the running container.

    console.log(`[startDockerEnvironmentTask] Copying docker files from ${dockerSourcePath}`);

    // Copy Dockerfile
    const copyDockerfile = await runCommand(
        `cp -r ${dockerSourcePath}Dockerfile ${taskFolderPath}/`
    );
    if (!copyDockerfile.success) {
        console.error(`[startDockerEnvironmentTask] Failed to copy Dockerfile: ${copyDockerfile.error}`);
    }

    // Copy docker-compose.yml
    const copyCompose = await runCommand(
        `cp -r ${dockerSourcePath}docker-compose.yml ${taskFolderPath}/`
    );
    if (copyCompose.success) {
        console.log(`[startDockerEnvironmentTask] Docker files copied successfully`);
    } else {
        console.error(`[startDockerEnvironmentTask] Failed to copy docker-compose.yml: ${copyCompose.error}`);
    }

    // Start container with docker compose
    console.log(`[startDockerEnvironmentTask] Starting container: ${containerName}`);
    const composeResult = await runCommand(
        `CONTAINER_NAME=${containerName} TASK_FOLDER_PATH=${taskFolderPath} docker compose -p ${containerName} up -d`,
        taskFolderPath
    );

    if (composeResult.success) {
        console.log(`[startDockerEnvironmentTask] Container started: ${containerName}`);
    } else {
        console.error(`[startDockerEnvironmentTask] docker compose failed: ${composeResult.error}`);
    }
}

// ─── Step 6 ── Setup user terminal (ttyd) ─────────────────────────────────────

/**
 * Finds a free port in the 8900-9000 range locally, then starts a ttyd
 * terminal docker container bound to that port.
 * Equivalent of setupTerminalEnvironment() via SSH.
 */
export async function setupTerminalEnvironment(
    taskFolderPath: string,
    taskId: string
): Promise<string> {
    console.log(`[setupTerminalEnvironment] Finding free port for task ${taskId}`);

    // Find available port (same shell one-liner as the original)
    const portResult = await runCommand(
        `for p in $(seq 8900 9000); do (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; break; }; done`
    );

    const availablePort = portResult.output.trim();
    if (!availablePort) {
        console.error(`[setupTerminalEnvironment] Could not find a free port in range 8900-9000`);
        return '';
    }
    console.log(`[setupTerminalEnvironment] Using port ${availablePort}`);

    const name = path.posix.basename(taskFolderPath);
    const imageName = name;

    // Start user terminal container (same docker run command as original)
    const terminalResult = await runCommand(
        `docker run -dit --name ${name}-user -p ${availablePort}:${availablePort} ` +
        `-v ${taskFolderPath}:/app -w /app ${imageName} bash -c ` +
        `"apt update && apt install -y wget && ` +
        `wget -qO /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && ` +
        `chmod +x /usr/local/bin/ttyd && ` +
        `ttyd -p ${availablePort} -i 0.0.0.0 --writable bash -ic ` +
        `'echo -e \"\\033]10;#FFFFFF\\007\\033]11;#000000\\007\"; exec bash'"`
    );

    if (terminalResult.success) {
        const terminalUrl = `http://localhost:${availablePort}`;
        console.log(`[setupTerminalEnvironment] Terminal started at ${terminalUrl}`);
        return terminalUrl;
    } else {
        console.error(`[setupTerminalEnvironment] Failed to start terminal: ${terminalResult.error}`);
        return '';
    }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Local equivalent of finalizeTask().
 * Runs all setup steps locally (no SSH, no DB writes).
 *
 * @returns terminalUrl - the URL of the started ttyd terminal, or '' on failure
 */
export async function finalizeTaskLocally(params: LocalTaskParams) {
    const { folderPath, wpId, repos } = params;

    // Derive the task folder path (same convention as the original)
    const taskFolderPath = folderPath;

    try {
        // Step 1 — Create task directory
        await createTaskDir(taskFolderPath);

        // Step 2, 3, 4 — Per repo: clone, permissions, secrets
        for (const repo of repos) {
            try {
                await cloneAndSetupBranch(
                    taskFolderPath,
                    repo.repoName,
                    repo.branchName,
                    repo.githubToken,
                    repo.githubOrgName
                );
                await updateDirectoryPermissions(taskFolderPath);
             //   await setSecrets(taskFolderPath, repo.repoName, repo.envContent);
            } catch (ex) {
                console.error(`[finalizeTaskLocally] Error setting up repo ${repo.repoName}:`, ex);
                // Continue with other repos (same behaviour as original)
            }
        }

        // Step 5 — Start docker container for the task
        await startDockerEnvironmentTask(taskFolderPath,params.taskId,params.dockerFolder);

        // Step 6 — Start user terminal
     //   const terminalUrl = await setupTerminalEnvironment(taskFolderPath, taskId);

    } catch (ex) {
        console.error(`[finalizeTaskLocally] Fatal error:`, ex);
        return '';
    }
}

// ─── Debug Runner ─────────────────────────────────────────────────────────────
// Runs ONLY when this file is executed directly (e.g. via VS Code debugger).
// Set breakpoints anywhere above, select "Debug LocalTaskSetup" in the
// Run & Debug panel, then press F5.
// Fill in the values below with your actual test data before running.
if (require.main === module) {
    const testParams: LocalTaskParams = {
       folderPath:"/mnt/f/PhantomX-workspace",
       dockerFolder:"/mnt/f/PhantomX_Permanent_Storage/docker/",
       taskId:"first_task",
        wpId: 'your-wp-id',
        repos: [
            {
                repoName: 'AI_CODER_REMOTE',
                branchName: 'main',
                githubToken: process.env.GITHUB_PAT,
                githubOrgName: 'AI-PLAYGROUNDS',
                envContent: 'API_KEY=test\nDEBUG=true\n' // this is the content of env variables.
            }
        ]
    };

    finalizeTaskLocally(testParams)
        .then((terminalUrl) => {
            console.log('Done. Terminal URL:', terminalUrl);
        })
        .catch((err) => {
            console.error('Error:', err);
        });
}
