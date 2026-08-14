import { execSync } from 'child_process';
//this will be main server used for indexing the workspaces
import * as fs from 'fs';
import * as path from 'path';
import { chunkEditor } from '../Implementation/chunkEditing';
import { chunkStructure, chunkGroupStructure } from '../classes/chunk_structure';
import { ChromaManager } from '../Implementation/ChromaManager';
const crypto = require('crypto');
const { spawnSync } = require('child_process');
import { Worker } from 'worker_threads';
import { start } from 'repl';
import { ThreadPool } from '../utils/ThreadPool';
import * as os from 'os';

let checkInterval: NodeJS.Timeout | null = null; // for the daemon function which will poll if there are any git changes

// Create a thread pool with 75% of available CPU cores
const threadPool = new ThreadPool(0.25);

// Debug flag to enable debug mode for all workers
const DEBUG_MODE = false;

// Helper function to get worker options with debug flags
function getWorkerOptions(baseOptions: any = {}) {
    if (DEBUG_MODE) {
        // Create a new options object
        const newOptions = { ...baseOptions };
        
        // Initialize execArgv if it doesn't exist
        if (!newOptions.execArgv) {
            newOptions.execArgv = [];
        } else if (!Array.isArray(newOptions.execArgv)) {
            // Convert to array if it's not already
            newOptions.execArgv = [newOptions.execArgv];
        }
        
        // Add debug flag
      //  newOptions.execArgv.push('--inspect-brk');
        
        return newOptions;
    }
    return baseOptions;
}

function readGitignore(root: string): string[] {
    const gitignorePath = path.join(root, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];
    const lines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
    console.log("\n found .gitIgnore files....");
    return lines
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.replace(/\/$/, ''));
}
function shouldIgnore(file: string, ignoreList: string[]): boolean {
    return ignoreList.some(pattern => {
        if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
        if (pattern.startsWith('*')) return file.endsWith(pattern.slice(1));
        return file.includes(pattern);
    });
}
function walk(dir: string, ignoreList: string[], files: string[] = []): string[] {

    for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        if (shouldIgnore(entry, ignoreList)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            files = walk(fullPath, ignoreList, files);
        }
        else if (entry.endsWith('.js') || entry.endsWith('.ts') || entry.endsWith('.jsx') || entry.endsWith('.tsx') || entry.endsWith('.py')) {
            files.push(fullPath);
        }
    }
    return files;
}
// Returns the current git branch name for the given directory (or process.cwd() if not provided)
function getGitBranchName(repoPath?: string): string | null {
    try {
        const cwd = repoPath || process.cwd();
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
        return branch;
    } catch (err) {
        return null;
    }
}
function loadMetadata(metaPath: string): Map<string, [chunkGroupStructure[], string]> {
    const metaDir = path.dirname(metaPath);
    if (!fs.existsSync(metaDir)) {
        fs.mkdirSync(metaDir, { recursive: true });
    }
    if (!fs.existsSync(metaPath)) return new Map<string, [chunkGroupStructure[], string]>();
    try {
        // Parse as Map from JSON
        const obj = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        // Ensure each value is a tuple [chunkGroupStructure[], string]
        return new Map(Object.entries(obj));
    } catch {
        return new Map<string, [chunkGroupStructure[], string]>();
    }
}

/**
 * Stages all files (except those ignored by .gitignore) in the given repository folder.
 * @param folder The absolute path to the git repository root.
 */
function stageAllFiles(folder: string): void {
    const { spawnSync } = require('child_process');
    const result = spawnSync('git', ['add', '.'], {
        encoding: 'utf8',
        cwd: folder
    });
    if (result.error) {
        throw new Error(`Failed to stage files: ${result.error.message}`);
    }
    if (result.stderr) {
        console.error(result.stderr);
    } else {
        console.log('All files staged successfully.');
    }
}
/**
 * Returns an object with three arrays: edited, added, and removed files, each with filePath and diff hash.
 * Example return: { edited: [{filePath, hash}], added: [{filePath, hash}], removed: [{filePath, hash}] }
 */

async function getChangedFilesWithDiffHash(folder: string): Promise<{
    edited: { filePath: string, hash: string }[],
    added: { filePath: string, hash: string }[],
    removed: { filePath: string, hash: string }[]
}> {
    const crypto = require('crypto');
    const { spawnSync } = require('child_process');
    let edited: { filePath: string, hash: string }[] = [];
    let added: { filePath: string, hash: string }[] = [];
    let removed: { filePath: string, hash: string }[] = [];

    // Get status of files (A=added, D=deleted, M=modified)
    const statusResult = spawnSync('git', ['diff', '--cached', '--name-status'], {
        encoding: 'utf8',
        cwd: folder
    });
    if (statusResult.error) {
        throw new Error(`Failed to get git diff status: ${statusResult.error.message}`);
    }
    const lines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        const [status, ...fileParts] = line.split(/\s+/);
        const filePath = fileParts.join(' ');
        if (!filePath) continue;
        // Get the diff for this file
        const diffResult = spawnSync('git', ['diff','--cached' ,'--unified=0', filePath], {
            encoding: 'utf8',
            cwd: folder
        });
        if (diffResult.error) {
            throw new Error(`Failed to get git diff for ${filePath}: ${diffResult.error.message}`);
        }
        const diffText = diffResult.stdout;
        const hash = crypto.createHash('sha256').update(diffText, 'utf8').digest('hex');
        if (status === 'M') {
            edited.push({ filePath, hash });
        } else if (status === 'A') {
            added.push({ filePath, hash });
        } else if (status === 'D') {
            removed.push({ filePath, hash });
        }
    }
    //filtering out the files from edited, added and removed which belong in the ignore list 
    edited = edited.filter(file => !shouldIgnore(file.filePath, ignoreList));
    added = added.filter(file => !shouldIgnore(file.filePath, ignoreList));
    removed = removed.filter(file => !shouldIgnore(file.filePath, ignoreList));

    return { edited, added, removed };
}

let gitChangeMetadata: Map<string, string> = new Map<string, string>(); // the last git change hash for the file for which the update in the db was made

function loadGitChangeMetadata(metaPath: string): Map<string, string> {
    const metaDir = path.dirname(metaPath);
    if (!fs.existsSync(metaDir)) {
        fs.mkdirSync(metaDir, { recursive: true });
    }
    if (!fs.existsSync(metaPath)) return new Map<string, string>();
    try {
        const obj = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return new Map(Object.entries(obj));
    } catch {
        return new Map<string, string>();
    }
}
async function StartWatching(seconds: number, folder: string, chunkWorkerPath: string, collectionName: string) {

    if (checkInterval) return; // Already watching
    checkInterval = setInterval(async () => {
        //finding the files that have been added/removed and edited
        stageAllFiles(folder);//staging all the files
        const { edited, added, removed } = await getChangedFilesWithDiffHash(folder); //getting all the changed files.

        //for adding the new files
        let toBeAddedFiles: string[] = [];
        for (let file of added) {
            if (gitChangeMetadata.get(file.filePath) !== file.hash) {
                toBeAddedFiles.push(file.filePath);
                gitChangeMetadata.set(file.filePath, file.hash);

            }
        }
        //it will run only when the file is not added in the gitChangeMetadata or the diff hash has changed.
        if (toBeAddedFiles.length > 0 && !firstUpdateFlag) {
            let hashMap: Map<string, string> = await getFilesHash(toBeAddedFiles);
            let chunkResult = await addFileToIndex(toBeAddedFiles, chunkWorkerPath, collectionName);
            //updating the new files and adding them in the IndexMetadata
            for (let [filePath, chunkGroupTuple] of chunkResult) {
                IndexMetadata.set(filePath, [chunkGroupTuple, hashMap.get(filePath) ?? ""]);
            }
        }
        //for editing the existing files
        let toBeEditedFiles: string[] = [];
        for (let file of edited) {
            if (gitChangeMetadata.get(file.filePath) != file.hash) {
                toBeEditedFiles.push(file.filePath);
                gitChangeMetadata.set(file.filePath, file.hash);
            }
        }
        if (toBeEditedFiles.length > 0 && !firstUpdateFlag) {
            let hashMap: Map<string, string> = await getFilesHash(toBeEditedFiles);
            let chunkResult = await editFileForIndex(toBeEditedFiles, chunkWorkerPath, collectionName);
            for (let [filePath, chunkGroupTuple] of chunkResult) {
                IndexMetadata.set(filePath, [chunkGroupTuple, hashMap.get(filePath) ?? ""]);

            }
        }

        //for removing the deleted files
        let toBeRemoved: string[] = [];
        for (let file of removed) {
            if (gitChangeMetadata.get(file.filePath) != file.hash) {
                toBeRemoved.push(file.filePath);
                gitChangeMetadata.set(file.filePath, file.hash);
            }
        }
        if (toBeRemoved.length > 0 && !firstUpdateFlag) {
            await removedFileFromIndex(toBeRemoved, chunkWorkerPath, collectionName);
        }
        if(firstUpdateFlag)
        {
            firstUpdateFlag = false;
        }

    }, seconds); // Check every 5 seconds
}

/**
 * Process files in batches of specified size
 * @param files Array of files to process
 * @param batchSize Number of files to process in each batch
 * @param processFn Function to process each batch
 * @returns Combined results from all batches
 */
async function processBatches<T, R>(files: T[], batchSize: number, processFn: (batch: T[]) => Promise<R[]>): Promise<R[]> {
    const totalFiles = files.length;
    const batches = Math.ceil(totalFiles / batchSize);
    let allResults: R[] = [];
    
    console.log(`Processing ${totalFiles} files in ${batches} batches of ${batchSize}`);
    
    for (let i = 0; i < totalFiles; i += batchSize) {
        const batchNumber = Math.floor(i / batchSize) + 1;
        const end = Math.min(i + batchSize, totalFiles);
        const batch = files.slice(i, end);
        
        console.log(`Processing batch ${batchNumber}/${batches} (${batch.length} files)`);
        const batchResults = await processFn(batch);
        allResults = allResults.concat(batchResults);
        console.log(`Completed batch ${batchNumber}/${batches}`);
    }
    
    console.log(`All ${batches} batches processed successfully`);
    return allResults;
}

async function addFileToIndex(newFiles: string[], chunkWorkerPath: string, collectionName: string): Promise<Map<string, chunkGroupStructure[]>> {
    let chunkResult = new Map<string, chunkGroupStructure[]>();
    const BATCH_SIZE = 20;
    
    console.log(`Starting to add ${newFiles.length} files to index in batches of ${BATCH_SIZE}`);
    
    // Process files in batches
    await processBatches(newFiles, BATCH_SIZE, async (batchFiles) => {
        // Prepare tasks for thread pool
        const tasks = batchFiles.map(filePath => {
            const sourceCode = fs.readFileSync(filePath, 'utf8');
            return {
                filePath,
                sourceCode,
                collectionName,
                function: 'CREATE'
            };
        });
        
        console.log(`Preparing ${tasks.length} worker(s) for adding files in debug mode`);
        
        // Execute tasks using thread pool with debug options
        const results = await threadPool.executeBatch<any, any>(
            tasks,
            chunkWorkerPath,
            getWorkerOptions({ execArgv: ['-r', 'ts-node/register'] })
        );
        
        // Process results
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result && result.success) {
                chunkResult.set(batchFiles[i], result.chunkGroup);
                console.log(`Worker completed successfully for file: ${batchFiles[i]}`);
            } else {
                console.log(`Worker completed with no success for file: ${batchFiles[i]}`);
            }
        }
        
        return results;
    });
    
    console.log(`Completed adding ${newFiles.length} files to index`);
    return chunkResult;
}

async function editFileForIndex(dirtyFiles: string[], chunkWorkerPath: string, collectionName: string): Promise<Map<string, chunkGroupStructure[]>> {
    let chunkResult: Map<string, chunkGroupStructure[]> = new Map();
    const BATCH_SIZE = 20;
    
    console.log(`Starting to edit ${dirtyFiles.length} files in batches of ${BATCH_SIZE}`);
    
    // Process files in batches
    await processBatches(dirtyFiles, BATCH_SIZE, async (batchFiles) => {
        // Prepare tasks for thread pool
        const tasks = batchFiles.map(filePath => {
            const sourceCode = fs.readFileSync(filePath, 'utf8');
            const oldMeta = IndexMetadata.get(filePath);
            return {
                function: 'UPDATE',
                filePath,
                IndexMetadata: oldMeta ? oldMeta[0] : undefined,
                newSource: sourceCode,
                collectionName
            };
        });
        
        console.log(`Preparing ${tasks.length} worker(s) for editing files in debug mode`);
        
        // Execute tasks using thread pool with debug options
        const results = await threadPool.executeBatch<any, any>(
            tasks,
            chunkWorkerPath,
            getWorkerOptions({ execArgv: ['-r', 'ts-node/register'] })
        );
        
        // Process results
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result && result.success) {
                chunkResult.set(batchFiles[i], result.chunkGroup);
                console.log(`Worker completed successfully for file: ${batchFiles[i]}`);
            } else {
                console.log(`Worker completed with no success for file: ${batchFiles[i]}`);
            }
        }
        
        return results;
    });
    
    console.log(`Completed editing ${dirtyFiles.length} files`);
    return chunkResult;
}

async function getFilesHash(files: string[]): Promise<Map<string, string>> {
    try {
        const hashMap = new Map<string, string>();
        const workerPath = path.join(__dirname, 'worker-hasher.js');
        const BATCH_SIZE = 20;
        
        console.log(`Starting to hash ${files.length} files in batches of ${BATCH_SIZE}`);
        
        // Process files in batches
        await processBatches(files, BATCH_SIZE, async (batchFiles) => {
            // Prepare tasks for thread pool
            const tasks = batchFiles.map(filePath => {
                try {
                    const text = fs.readFileSync(filePath, 'utf8');
                    return { filePath, text };
                } catch (fileError) {
                    console.error(`Error reading file ${filePath}:`, fileError);
                    return { filePath, text: '' }; // Return empty text on error
                }
            });
            
            console.log(`Preparing ${tasks.length} worker(s) for hashing files in debug mode`);
            
            // Execute tasks using thread pool with debug options
            const results = await threadPool.executeBatch<any, any>(
                tasks, 
                workerPath, 
                getWorkerOptions({})
            );
            
            // Process results
            for (const result of results) {
                if (result && result.filePath && result.hash) {
                    hashMap.set(result.filePath, result.hash);
                    console.log(`Successfully hashed file: ${result.filePath}`);
                } else if (result && result.filePath) {
                    console.log(`Failed to hash file: ${result.filePath}`);
                }
            }
            
            return results;
        });
        
        console.log(`Completed hashing ${files.length} files`);
        return hashMap;
    } catch (error) {
        console.error("Error in getFilesHash:", error);
        return new Map<string, string>();
    }
}

async function removedFileFromIndex(removedFiles: string[], chunkWorkerPath: string, collectionName: string) {
    let chunkResult: Map<string, chunkGroupStructure[]> = new Map();
    const BATCH_SIZE = 20;
    
    console.log(`Starting to remove ${removedFiles.length} files in batches of ${BATCH_SIZE}`);
    
    // Process files in batches
    await processBatches(removedFiles, BATCH_SIZE, async (batchFiles) => {
        // Prepare tasks for thread pool
        const tasks = batchFiles.map(filePath => {
            const metaTuple = IndexMetadata.get(filePath);
            const meta: chunkGroupStructure[] = metaTuple ? metaTuple[0] : [];
            return {
                function: 'DELETE',
                filePath,
                collectionName,
                chunkGroup: meta
            };
        });
        
        console.log(`Preparing ${tasks.length} worker(s) for removing files in debug mode`);
        
        // Execute tasks using thread pool with debug options
        const results = await threadPool.executeBatch<any, any>(
            tasks,
            chunkWorkerPath,
            getWorkerOptions({ execArgv: ['-r', 'ts-node/register'] })
        );
        
        // Process results and remove from IndexMetadata
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result && result.success) {
                chunkResult.set(batchFiles[i], result.chunkGroup);
                console.log(`Worker completed successfully for removing file: ${batchFiles[i]}`);
            } else {
                console.log(`Worker completed with no success for removing file: ${batchFiles[i]}`);
            }
            // Remove from IndexMetadata regardless of success
            IndexMetadata.delete(batchFiles[i]);
        }
        
        return results;
    });
    
    console.log(`Completed removing ${removedFiles.length} files`);
    return chunkResult;
}

async function stopWatching() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

let ignoreList: string[] = [];
let IndexMetadata: Map<string, [chunkGroupStructure[], string]> = new Map<string, [chunkGroupStructure[], string]>();

let firstUpdateFlag: boolean = false;//this is the flag which notifies the git diff checker service that the things have been updated and we dont need to update the things again for the first time, so for the first time we will only add the gitDiffMetadata but not really update the things


async function main(folder:string) {
/*
starting the initialization process
*/
    
    console.log("the input folder is==>",folder);
    console.log("Debug mode is " + (DEBUG_MODE ? "ENABLED" : "DISABLED") + " for all worker threads");
    
    let branchName = getGitBranchName(folder);

    const metaPath = path.join(folder, ".AIMetadata", "IndexMetadata_" + branchName + ".json");
    IndexMetadata = loadMetadata(metaPath);

    const gitMetaPath = path.join(folder, ".AIMetadata", "gitDiffMetadata_" + branchName + ".json");
    gitChangeMetadata = loadGitChangeMetadata(gitMetaPath);

    let collectionName = path.basename(folder); // getting the last name of the folder as the collection name

    // On process exit, write IndexMetaData and gitChangeMetadata to their respective files
    const saveMetaData = () => {
        try {
            // Convert Map to object for JSON serialization
            const obj = Object.fromEntries(IndexMetadata);
            fs.writeFileSync(metaPath, JSON.stringify(obj, null, 2), 'utf8');
            console.log('IndexMetaData saved successfully.');
        } catch (err) {
            console.error('Failed to save IndexMetaData:', err);
        }
        try {
            const obj = Object.fromEntries(gitChangeMetadata);
            fs.writeFileSync(gitMetaPath, JSON.stringify(obj, null, 2), 'utf8');
            console.log('gitChangeMetadata saved successfully.');
        } catch (err) {
            console.error('Failed to save gitChangeMetadata:', err);
        }
    };

    // Handle Ctrl+C (SIGINT) to stop watching, save metadata, and exit
    process.on('SIGINT', async () => {
        console.log('\nCaught interrupt signal (Ctrl+C). Stopping watcher and saving metadata...');
        await stopWatching();
        saveMetaData();
        console.log('Exiting.');
        process.exit(0);
    });

    //getting all the files out of workspace folder, excluding the .gitIgnore Files
    const DEFAULT_IGNORES = [
        'node_modules', '.git', 'AI_CODE_SERVER', 'logs', 'chat-history', 'dist', 'coverage', '.vscode', '.DS_Store', 'package-lock.json', 'yarn.lock', '.env', '.cache', '.nyc_output', '.next', 'out', 'bower_components', 'jspm_packages', 'web_modules', '.parcel-cache', '.docusaurus', '.serverless', '.fusebox', '.dynamodb', '.tern-port', '.vscode-test', '.yarn', '.pnpm-debug.log', '.eslintcache', '.stylelintcache', '.rpt2_cache', '.rts2_cache_cjs', '.rts2_cache_es', '.rts2_cache_umd', '.node_repl_history', '*.tgz', '*.tsbuildinfo', '*.lcov', '*.log', '*.seed', '*.pid', '*.pid.lock', '*.json', '*.md', '*.txt', '*.csv', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.ico', '*.lock-wscript', 'README.md', 'LICENSE', 'LICENSE.txt', 'yarn-error.log', 'npm-debug.log', 'lerna-debug.log', 'report.*.json', 'lib-cov', '.grunt', '.env.*', '.nuxt', 'dist', '.vuepress', '.temp', '.docusaurus', '.serverless', '.fusebox', '.dynamodb', '.tern-port', '.vscode-test', '.yarn', '.pnp.*', '*_tempAI.*'
    ];
    ignoreList = [...DEFAULT_IGNORES, ...readGitignore(folder)];
    const files = walk(folder, ignoreList); //now these are the usable files in the given workspace.

    // Hash files in parallel using worker threads
    let dirtyFiles: string[] = [];
    let newFiles: string[] = [];
    let removedFiles: string[] = [];
    const hashMap: Map<string, string> = await getFilesHash(files); //it is the map of the filePath to the hash of the file content

    if (IndexMetadata.size > 0) {
        //it means that metadata exists so, we need to reconcile the file i.e we need to check if the existing metadata in the files
        // are equal to the current files in the folder. we will match hashes of the file content to check if any files needs to be rehased.
        // hashMap now contains filePath => sha256 hash
        // ... you can use hashMap as needed ...

        for (const [filePath, hash] of hashMap.entries()) {
            const meta = IndexMetadata.get(filePath);
            if (!meta) {
                newFiles.push(filePath);
            } else if (meta[1] !== hash) {
                dirtyFiles.push(filePath);
            }
        }
        for (const [filePath] of IndexMetadata.entries()) {
            if (!hashMap.has(filePath)) {
                removedFiles.push(filePath);
            }
        }

        //rechunking the dirty files again.
        // Rechunk dirty files in parallel using chunkEditing worker

    }

    else {
        //setting all the files in the folder as dirty
        newFiles.push(...files);
    }
    const chunkWorkerPath = path.join(__dirname, 'Implementation', 'chunkEditing.ts');
    let chunkResult: Map<string, chunkGroupStructure[]> = new Map<string, chunkGroupStructure[]>();
    if (dirtyFiles.length > 0) {
        chunkResult = await editFileForIndex(dirtyFiles, chunkWorkerPath, collectionName);

        //updating the dirty files or adding the new files if there were no files.
        for (let [filePath, chunkGroupTuple] of chunkResult) {
            if (IndexMetadata.has(filePath)) {
                //if the file exists in the metadata, we will update the chunkGroup and hash
                IndexMetadata.set(filePath, [chunkGroupTuple, hashMap.get(filePath) ?? ""]);
            }
        }
        firstUpdateFlag = firstUpdateFlag || true;
    }
    if (newFiles.length > 0) {
        chunkResult = await addFileToIndex(newFiles, chunkWorkerPath, collectionName);
        //updating the new files and adding them in the IndexMetadata
        for (let [filePath, chunkGroupTuple] of chunkResult) {
            IndexMetadata.set(filePath, [chunkGroupTuple, hashMap.get(filePath) ?? ""]);
        }
        firstUpdateFlag = firstUpdateFlag || true;
    }
    //now updating the files which have to be removed from the indexMetadata and also removing them from the chroma index.

    if (removedFiles.length > 0) {
        chunkResult = await removedFileFromIndex(removedFiles, chunkWorkerPath, collectionName);
        firstUpdateFlag = firstUpdateFlag || true;
    }



/*
Initialization ends...
*/
console.log("\n initialization ends");

    await StartWatching(30*60*1000, folder, chunkWorkerPath, collectionName); //the indexer will run after every 15 minutes.
    saveMetaData();


}
// Export the main function so it can be used by other modules
export { main };

if (require.main === module) {
    // Pass command-line arguments (excluding node and script path) to main
    const folderPath = process.argv[2];
    console.log("\n the args recved by indexer are==>"+process.argv[2]);
    if (!folderPath) {
        console.error("Error: Folder path is required");
        process.exit(1);
    }
    main(folderPath).catch(error => {
        console.error("Error in indexer:", error);
        process.exit(1);
    });
}
