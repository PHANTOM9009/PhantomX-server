import { Node } from '../classes/folder_structure';
const SSHClient = require('../Services/ssh-client');

interface SSHCommandResult {
    success: boolean;
    output?: string;
    error?: string;
}

interface FolderStructure {
    [key: string]: Node;
}

export class FolderStructureImplementation {
    private sshClient: typeof SSHClient;
    private ec2_instance_ip:string;
    constructor(ec2_instance_ip:string) {
        this.ec2_instance_ip = ec2_instance_ip;
        this.sshClient = new SSHClient(ec2_instance_ip);
    }
    public sortObjectByChildrenAndTitle(items: FolderStructure): FolderStructure {
        const sortedKeys = Object.keys(items).sort((a: string, b: string): number => {
            const aIsFolder = items[a].children && Object.keys(items[a].children).length > 0 ? 0 : 1;
            const bIsFolder = items[b].children && Object.keys(items[b].children).length > 0 ? 0 : 1;

            if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;

            const aTitle = items[a].title ?? "";
            const bTitle = items[b].title ?? "";

            return aTitle.localeCompare(bTitle, undefined, { sensitivity: "base" });
        });

        const sortedObj: FolderStructure = {};
        for (const key of sortedKeys) {
            const currentItem = items[key];

            const sortedChildren =
                currentItem.children && Object.keys(currentItem.children).length > 0
                    ? this.sortObjectByChildrenAndTitle(currentItem.children)
                    : {};

            sortedObj[key] = {
                ...currentItem,
                children: sortedChildren,
            };
        }

        return sortedObj;
    }


    async getFolderStructure(path: string): Promise<{ success: boolean; data?: FolderStructure; error?: string }> {
        try {
            if (!path) {
                throw new Error('Path is required');
            }
            console.log("Getting folder structure for path:", path);
            // Connect to SSH if not already connected
            await this.sshClient.connect();

            // Get folder structure using ls command with details, excluding node_modules
            const command = `find ${path} -not -path '*/node_modules/*' -not -path '*/node_modules' -exec stat -c '%s,%Y,%U,%y,%u,%n' {} \\;`;
            const result = await this.sshClient.executeCommand(command) as SSHCommandResult;

            if (!result.success || !result.output) {
                throw new Error(result.error || 'Failed to get folder structure');
            }

            const folderStructure: FolderStructure = {};
            const lines = result.output.split('\n').filter((line: string) => line.trim());

            for (const line of lines) {
                const [size, createTime, createdBy, modTime, modifiedBy, path] = line.split(',');

                if (!path) continue; // Skip invalid entries
                if (path.includes('node_modules')) continue; // Extra check to skip any node_modules entries
                if (path.includes('package-lock.json')) continue; // Skip package-lock.json
                if (path.includes('.git')) continue; // Skip .git directories
                // Create Node instance for this file/folder
                const node = new Node(
                    parseInt(size) || 0,
                    new Date(parseInt(createTime) * 1000),
                    createdBy || '',
                    new Date(modTime),
                    modifiedBy || '',
                    '', // Empty content for now,
                    '',
                    {} // Empty children object
                );

                // Add to structure with full path as key
                folderStructure[path] = node;
            }

            // Build parent-child relationships
            Object.keys(folderStructure).forEach((path) => {
                const parentPath = path.substring(0, path.lastIndexOf('/'));
                if (parentPath && folderStructure[parentPath]) {
                    folderStructure[parentPath].children[path] = folderStructure[path];
                    folderStructure[path].title = path.slice(parentPath.length + 1);
                }
                else folderStructure[path].title = path;
                folderStructure[path].address = path;
            });

            // sorting the folder
            const sortedFolderStructure = this.sortObjectByChildrenAndTitle(folderStructure)
            return {
                success: true,
                data: sortedFolderStructure
            };

        } catch (error: unknown) {
            console.error('Error getting folder structure:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    async getFileContent(filePath: string): Promise<{ success: boolean; data?: Node; error?: string }> {
        try {
            if (!filePath) {
                throw new Error('File path is required');
            }

            // Connect to SSH if not already connected
            await this.sshClient.connect();

            // First get the file stats
            const statCommand = `stat -c '%s,%Y,%U,%y,%u' "${filePath}"`;
            const statResult = await this.sshClient.executeCommand(statCommand) as SSHCommandResult;

            if (!statResult.success || !statResult.output) {
                throw new Error(statResult.error || 'Failed to get file stats');
            }

            const [size, createTime, createdBy, modTime, modifiedBy] = statResult.output.split(',');

            // Now get the file content
            const contentCommand = `cat "${filePath}"`;
            const contentResult = await this.sshClient.executeCommand(contentCommand) as SSHCommandResult;

            if (!contentResult.success) {
                throw new Error(contentResult.error || 'Failed to read file content');
            }

            // Create Node instance with file details and content
            const node = new Node(
                parseInt(size) || 0,
                new Date(parseInt(createTime) * 1000),
                createdBy || '',
                new Date(modTime),
                modifiedBy || '',
                '', // Empty fileContent
                '',
                {} // Empty children object
            );

            // Set the content
            node.content = contentResult.output || '';

            return {
                success: true,
                data: node
            };

        } catch (error: unknown) {
            console.error('Error getting file content:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Deletes a file or directory with elevated privileges
     * @param filePath Path to the file or directory to delete
     * @returns Object indicating success or error
     */
    async deleteFile(filePath: string): Promise<{ success: boolean; error?: string }> {
        try {
            if (!filePath) {
                throw new Error("File path is required");
            }

            await this.sshClient.connect();

            // Use sudo rm -rf to handle both files and directories with elevated privileges
            const command = `sudo rm -rf "${filePath}"`;
            const result = await this.sshClient.executeCommand(command);

            if (!result.success) {
                throw new Error(result.error || "Failed to delete file or directory");
            }

            return { success: true };
        } catch (error: unknown) {
            console.error("Error deleting file or directory:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }

    /**
     * Renames a file or folder with elevated privileges
     * @param oldPath Current path of the file or folder
     * @param newPath New path for the file or folder
     * @returns Object indicating success or error
     */
    async renameFileOrFolder(
        oldPath: string,
        newPath: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            if (!oldPath || !newPath) {
                console.log("Error while renaming file or folder: oldPath or newPath is missing");
                throw new Error("Both old and new file paths are required");
            }
            console.log("Renaming file or folder from", oldPath, "to", newPath);
            await this.sshClient.connect();

            // Use sudo mv to rename files or folders with elevated privileges
            const command = `sudo mv "${oldPath}" "${newPath}"`;
            const result = await this.sshClient.executeCommand(command);

            if (!result.success) {
                throw new Error(result.error || "Failed to rename file or folder");
            }

            return { success: true };
        } catch (error: unknown) {
            console.error("Error renaming file or folder:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }

    async getSearchResults(searchText: string, searchFolder?: string): Promise<{ success: boolean; data?: any; error?: string }> {
        try {
            // Connect to SSH if not already connected
            await this.sshClient.connect();

            // Get search results using grep command
            const command = `sudo find Workspace -type d \\( -name 'node_modules' -o -name '.*' \\) -prune -false -o -type f -exec grep -nH -e "${searchText}" {} +`;
            const result = await this.sshClient.executeCommand(command) as SSHCommandResult;

            if (!result.success || !result.output) {
                throw new Error(result.error || 'Failed to get search results');
            }

            const searchResults = result.output.split('\n').filter(line => line.trim());
            return {
                success: true,
                data: searchResults
            };

        } catch (error: unknown) {
            console.error('Error getting search results:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Creates a new empty file with elevated privileges
     * @param filePath Path where the file should be created
     * @returns Object indicating success or error
     */
    async createFile(filePath: string): Promise<{ success: boolean; error?: string }> {
        try {
            if (!filePath) {
                throw new Error('File path is required');
            }

            // Connect to SSH if not already connected
            await this.sshClient.connect();

            // Create the file using sudo for elevated privileges
            const command = `sudo touch "${filePath}"`;
            const result = await this.sshClient.executeCommand(command) as SSHCommandResult;

            if (!result.success) {
                throw new Error(result.error || 'Failed to create file');
            }

            return { success: true };
        } catch (error: unknown) {
            console.error('Error creating file:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Saves content to a file with elevated privileges
     * @param filePath Path where the file should be saved
     * @param content Content to be written to the file
     * @returns Object indicating success or error
     */
  async saveFile(
        filePath: string,
        changes: Array<{
          range: {
            startLine: number;
            startColumn: number;
            endLine: number;
            endColumn: number;
          };
          insertedText: string;
          timestamp: string;
          version: number;
        }>
      ): Promise<{ success: boolean; error?: string }> {
        try {
          if (!filePath) throw new Error("File path is required");
          if (!Array.isArray(changes) || changes.length === 0) {
            throw new Error("Changes array must not be empty");
          }
      
          await this.sshClient.connect();
      
          const contentResult = await this.sshClient.executeCommand(`cat "${filePath}"`);
          if (!contentResult.success) {
            throw new Error(contentResult.error || "Failed to read file content");
          }
      
          let lines = contentResult.output?.split("\n") ?? [];
      
          const sortedChanges = [...changes].sort((a, b) => a.version - b.version);
      
          for (const change of sortedChanges) {
            const { range, insertedText } = change;
            const { startLine, startColumn, endLine, endColumn } = range;
      
            // Convert to 0-based indices
            const startLineIndex = startLine - 1;
            const endLineIndex = endLine - 1;
            const startColIndex = startColumn - 1;
            const endColIndex = endColumn - 1;
      
            // Pad missing lines if required
            while (lines.length <= endLineIndex) {
              lines.push("");
            }
      
            const before = lines[startLineIndex]?.slice(0, startColIndex) ?? "";
            const after = lines[endLineIndex]?.slice(endColIndex) ?? "";
            const insertedLines = insertedText.split("\n");
      
            if (insertedText === "" && startLine === endLine && startColIndex === endColIndex) {
              // No-op, skip
              continue;
            }
      
            if (insertedLines.length === 1) {
              // Single-line change (insert/replace/delete)
              lines.splice(
                startLineIndex,
                endLineIndex - startLineIndex + 1,
                before + insertedLines[0] + after
              );
            } else {
              // Multi-line insert/replace
              const newLines = [
                before + insertedLines[0],
                ...insertedLines.slice(1, -1),
                insertedLines[insertedLines.length - 1] + after,
              ];
              lines.splice(startLineIndex, endLineIndex - startLineIndex + 1, ...newLines);
            }
          }
      
          const newContent = lines.join("\n");
      
          // Safely overwrite file using base64 to avoid shell escaping issues
          const base64Content = Buffer.from(newContent, "utf-8").toString("base64");
          const writeCommand = `echo "${base64Content}" | base64 -d | sudo tee "${filePath}" > /dev/null`;
          const writeResult = await this.sshClient.executeCommand(writeCommand);
      
          if (!writeResult.success) {
            throw new Error(writeResult.error || "Failed to write file content");
          }
      
          return { success: true };
        } catch (error: unknown) {
          console.error("Error saving file:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred",
          };
        }
      }

    async disconnect(): Promise<void> {
        if (this.sshClient) {
            this.sshClient.disconnect();
        }
    }
}
