/**
 * For each tempAI/original pair, if replaceOriginal is true, replace the original file's contents
 * with the tempAI file, then delete the tempAI file. If false, just delete the tempAI file.
 * Returns an array of {file, replaced: boolean}
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

/**
 * AIDiffFinder traverses a directory, finds files with '_tempAI' suffix,
 * matches them with their original counterparts, and returns the git diff output.
 */

export class AIDiffFinder {
    baseDir: string;
    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    // Recursively traverse directory and collect all files
    private async getAllFiles(dir: string): Promise<string[]> {
        const dirName = path.basename(dir);
        // Skip the 'dist' folder as we don't want to track those files
        if (dirName === "dist") {
            return [];
        }
        
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        let files: string[] = [];
        for (const dirent of dirents) {
            const res = path.resolve(dir, dirent.name);
            if (dirent.isDirectory()) {
                files = files.concat(await this.getAllFiles(res));
            } else {
                files.push(res);
            }
        }
        return files;
    }

    // Find pairs of AI-generated and original files
    private async findAIPairs(): Promise<{ aiFile: string, origFile: string }[]> {
        const allFiles = await this.getAllFiles(this.baseDir);
        const pairs: { aiFile: string, origFile: string }[] = [];
        for (const file of allFiles) {
            const parsed = path.parse(file);
            if (parsed.name.endsWith('_tempAI')) {
                const origName = parsed.name.replace(/_tempAI$/, '');
                const origFile = path.join(parsed.dir, origName + parsed.ext);
                if (allFiles.includes(origFile)) {
                    pairs.push({ aiFile: file, origFile });
                }
                else {
                    pairs.push({ aiFile: file, origFile: '' });
                }
            }
        }
        return pairs;
    }

    // Run git diff --no-index --color=always and return diff output
    private async getDiff(file1: string, file2: string): Promise<string> {
        const execAsync = promisify(exec);
        try {
            const { stdout } = await execAsync(`git diff --no-index --color=always "${file1}" "${file2}"`);
            return stdout;
        } catch (err: any) {
            // git diff returns non-zero exit code if files differ, so still return stdout
            return err.stdout || err.message || String(err);
        }
    }

    /**
     * Returns array of {file, diff} for all AI-generated/original pairs
     */
    async getAIDiffs(): Promise<{ file: string, diff: string }[]> {
        const pairs = await this.findAIPairs();
        const results: { file: string, diff: string }[] = [];
        for (const { aiFile, origFile } of pairs) {
            if (origFile.length > 0) {
                const diff = await this.getDiff(origFile, aiFile);
                results.push({ file: aiFile, diff });
            }
            else {
                results.push({ file: aiFile, diff: 'it is a new file, check if it is correct.' });
            }

        }
        return results;
    }
   
    public getNameUntilLastUnderscore(filePath: string): string {
        
        const lastUnderscore = filePath.lastIndexOf('_');
        if (lastUnderscore === -1) return filePath;
        const extension = path.extname(filePath);
        return filePath.substring(0, lastUnderscore) + extension;
    }
    public async applyTempAIToOriginals(tempAIMap: Map<string, boolean>): Promise<{ file: string, replaced: boolean }[]> {
        const allPairs = await this.findAIPairs();
        // Create a lookup for tempAI file to origFile
        const aiToOrig = new Map<string, string>();
        for (const { aiFile, origFile } of allPairs) {
            aiToOrig.set(aiFile, origFile);
        }
        const results: { file: string, replaced: boolean }[] = [];
        for (const [aiFile, replaceOriginal] of tempAIMap.entries()) {
            let origFile: string = aiToOrig.get(aiFile) || '';
            let replaced = false;
            try {
                if (replaceOriginal) {
                    const aiContent = await fs.readFile(aiFile);
                    origFile.length>0 ? origFile=origFile : origFile = this.getNameUntilLastUnderscore(aiFile);
                    await fs.writeFile(origFile, aiContent);
                    replaced = true;
                }
                await fs.unlink(aiFile);
            } catch (err) {
                console.error(`Failed to process tempAI file: ${aiFile}`, err);
            }
            results.push({ file: aiFile, replaced });
        }
        return results;
    }
}

// Example usage (uncomment to run directly):
// (async () => {
//     const finder = new AIDiffFinder('path/to/your/folder');
//     const diffs = await finder.getAIDiffs();
//     console.log(diffs);
// })();
