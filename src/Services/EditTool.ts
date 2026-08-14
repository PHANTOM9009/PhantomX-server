import * as fs from 'fs';
import * as util from 'util';
import * as path from 'path';
const SSHClient = require('./ssh-client');

/**
 * Interface defining the structure for code editing operations
 */
interface CodeEdit {
  filePath: string;
  id: string;     // Path to the file to edit
  operation: 'insert' | 'replace' | 'delete';
  locationForInsertion: {
    startLine: number;        // Line number to start edit (1-indexed)
    endLine?: number;         // Line number to end edit (for replace/delete)
  };
  patchToBeEdited: string;
  content?: string;           // New content to insert/replace (not needed for delete)
  reason?: string;            // Optional documentation of why this edit is being made
}

interface CodeEditEx {
  filePath: string;
  absolutePath:string;
  id: string;         // Path to the file to edit
  operation: 'insert' | 'replace' | 'delete';
  locationForInsertion: {
    startLine: string;        // Line to start the edit from
    endLine?: string;         // Line to end the edit at
  };
  patchToBeEdited: string;
  content?: string;           // New content to insert/replace (not needed for delete)
  reason?: string;            // Optional documentation of why this edit is being made
}
function normalizeLine(line: string): string {
  const trimmedLine = line.trim();

  // strip whitespace entirely for comments
  if (trimmedLine.startsWith('//') ||
    trimmedLine.startsWith('/*') ||
    trimmedLine.startsWith('*/') ||
    trimmedLine.includes('/*') ||
    trimmedLine.includes('*/')) {
    return line.replace(/\s+/g, '');
  }

  // Process the line character by character to properly handle regex patterns
  let result = '';
  let segments = [];
  let currentSegment = { text: '', type: 'code' }; // Types: 'code', 'regex', 'string'
  let i = 0;
  let inRegex = false;
  let inString = false;
  let stringDelimiter = '';
  let escaped = false;

  // First pass: Identify segments (regex, strings, code)
  while (i < line.length) {
    const char = line[i];
    const nextChar = i < line.length - 1 ? line[i + 1] : '';

    // Handle string boundaries
    if (!inRegex && !escaped && (char === '"' || char === "'" || char === '`')) {
      if (inString && char === stringDelimiter) {
        // End of string
        currentSegment.text += char;
        segments.push(currentSegment);
        currentSegment = { text: '', type: 'code' };
        inString = false;
      } else if (!inString) {
        // Start of string
        if (currentSegment.text) {
          segments.push(currentSegment);
        }
        currentSegment = { text: char, type: 'string' };
        inString = true;
        stringDelimiter = char;
      } else {
        // Different string delimiter inside a string
        currentSegment.text += char;
      }
      escaped = false;
    }
    // Handle backslashes
    else if (char === '\\') {
      currentSegment.text += char;
      escaped = !escaped;
    }
    // Potential start of regex literal
    else if (!inString && !escaped && char === '/') {
      const before = line.substring(0, i).trim();
      const isRegexStart = before === '' ||
        /[=\(\[\{:,!&|?;]$/.test(before) ||
        /return\s*$/.test(before) ||
        /case\s*$/.test(before) ||
        /else\s*$/.test(before) ||
        /new\s*$/.test(before) ||
        /throw\s*$/.test(before) ||
        /=>\s*$/.test(before);

      if (isRegexStart && !inRegex) {
        // Start of regex
        if (currentSegment.text) {
          segments.push(currentSegment);
        }
        currentSegment = { text: char, type: 'regex' };
        inRegex = true;
      } else if (inRegex && !escaped) {
        // End of regex
        currentSegment.text += char;

        // Consume any regex flags
        let j = i + 1;
        while (j < line.length && /[gimsuy]/.test(line[j])) {
          currentSegment.text += line[j];
          j++;
        }

        segments.push(currentSegment);
        currentSegment = { text: '', type: 'code' };
        inRegex = false;
        i = j - 1;
      } else {
        // Just a slash in code or escaped slash in regex
        currentSegment.text += char;
      }
      escaped = false;
    }
    else {
      // Regular character
      currentSegment.text += char;
      escaped = false;
    }

    i++;
  }

  // Add the last segment if it has content
  if (currentSegment.text) {
    segments.push(currentSegment);
  }

  // Second pass: Process each segment according to its type
  for (const segment of segments) {
    if (segment.type === 'regex') {
      // Preserve regex patterns exactly as they are
      result += segment.text;
    } else if (segment.type === 'string') {
      // Preserve strings exactly as they are
      result += segment.text;
    } else {
      // For code segments, normalize by removing whitespace and escape sequences
      let normalizedCode = segment.text;

      // Strip all whitespace
      normalizedCode = normalizedCode.replace(/\s+/g, '');

      // Remove escape sequences in code (but not in regex or strings)
      normalizedCode = normalizedCode.replace(
        /\\(u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[nrtbfv0'"\\])/g,
        ''
      );

      result += normalizedCode;
    }
  }

  return result;
}

/**
 * Compare two code lines for semantic equality,
 * ignoring whitespace and escape‐sequence literals.
 *
 * @returns true if, after normalization, the two lines are identical.
 */
export function compareCodeLines(line1: string, line2: string): boolean {
  return normalizeLine(line1) === normalizeLine(line2);
}
/**
 * Class that provides file editing functionality
 */
export class EditTool {
  /**
   * Constructor for EditTool
   * No longer requires a folderPath parameter as we'll use absolute paths directly
   */
  constructor() {}
  public async applyFinalEdit(edits: CodeEditEx[]): Promise<[string, string][]> {
    let editResult: [string, string][] = [];
      
      for (let edit of edits) {
        // Use the absolutePath directly
        let finalPath:string = edit.absolutePath;
        //finding the line numbers from the line string and passing it to the applyEdit function
        if (!fs.existsSync(finalPath)) {
          editResult.push([edit.id, 'File not found: ' + finalPath]);
          return editResult; //returning since the operation failed...
        }
        
        // Check and update file permissions if needed
        const permissionResult = await this.checkAndUpdatePermissions(finalPath);
        if (permissionResult !== true) {
          editResult.push([edit.id, `Permission error: ${permissionResult}`]);
          return editResult; //returning since the operation failed...
        }
        
        const fileContent = fs.readFileSync(finalPath, 'utf8');
        const lines = fileContent.split('\n');
        let startLineIndex: number = 0;
        let endLineIndex: number = 0;
        if (edit.operation === "insert") {
          //we have to find the startLine only
          let startLines = edit.locationForInsertion.startLine.split('\n');
          let j = 0;
          for (let i = 0; i < lines.length; i++) {
            if (compareCodeLines(startLines[0], lines[i]))//the first line matches let's see if all other lines also match in continuation
            {
              if (startLines.length === 1) {
                //if length is one, then this is the startLine for this
                startLineIndex = i + 1;
                break;
              }
              let flag = 0;
              let ii = i;
              ii++;
              for (let j = 1; j < startLines.length && ii < lines.length; j++, ii++) {
                if (!compareCodeLines(startLines[j], lines[ii])) {
                  flag = 1;
                  break;
                }
              }
              if (flag === 0) {
                startLineIndex = i + startLines.length;// +1 since the lines should be 1 indexed.
                break;
              }
            }
          }

        }
        else {
          //if the operation is of delete or replace, we will follow the same logic for this too
          let block = edit.patchToBeEdited.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (compareCodeLines(block[0], lines[i])) {
              if (block.length === 1) {
                //if the block's length is 1, then the startLineIndexa nd endLineIndex will be the same
                startLineIndex = endLineIndex = i + 1;
                break;
              }
              let flag = 0;
              let ii = i;
              ii++;
              for (let j = 1; j < block.length && ii < lines.length; j++, ii++) {
                if (!compareCodeLines(block[j], lines[ii])) {
                  flag = 1;
                  break;
                }
              }
              if (flag === 0) {
                startLineIndex = i + 1;
                endLineIndex = i + block.length;
                break;
              }
            }
          }

        }

        try {
          editResult.push([edit.id, await this.applyEdit({
            id: edit.id,
            content: edit.content,
            filePath: finalPath,
            operation: edit.operation,
            reason: edit.reason,
            locationForInsertion: {
              startLine: startLineIndex,
              endLine: endLineIndex
            },
            patchToBeEdited: edit.patchToBeEdited
          })]);
        } catch (error) {
            console.log("Error applying edit:", error);
            editResult.push([edit.id, `Failed to apply edit: ${error} you should try rewriting the entire file`]);
            return editResult;
        
          
          
        }
      }
      return editResult;
    
  }
  public async applyEdit(edit: CodeEdit): Promise<string> {
    try {
      // Validate the edit request
      const validationError = this.validateEdit(edit);
      if (validationError) {
        throw `Validation failed: ${validationError}`;
      }

      // Check if file exists
      if (!fs.existsSync(edit.filePath)) {
        throw `File not found: ${edit.filePath}`;
      }
      
      // Check and update file permissions if needed
      const permissionResult = await this.checkAndUpdatePermissions(edit.filePath);
      if (permissionResult !== true) {
        throw `Permission error: ${permissionResult}`;
      }

      // Read the file content
      const fileContent = await fs.promises.readFile(edit.filePath, 'utf8');
      const lines = fileContent.split('\n');

      // Apply the edit based on operation type
      let newContent: string;
      switch (edit.operation) {
        case 'insert':
          newContent = this.performInsert(lines, edit.locationForInsertion.startLine, edit.content || '');
          break;
        case 'replace':
          newContent = this.performReplace(
            lines,
            edit.locationForInsertion.startLine,
            edit.locationForInsertion.endLine || edit.locationForInsertion.startLine,
            edit.content || ''
          );
          break;
        case 'delete':
          newContent = this.performDelete(
            lines,
            edit.locationForInsertion.startLine,
            edit.locationForInsertion.endLine || edit.locationForInsertion.startLine
          );
          break;
        default:
          throw `Unsupported operation: ${(edit as any).operation}`;
      }

      // Check if the operation returned an error message
      if (newContent.startsWith('ERROR:')) {
        throw newContent + " you should try rewriting the file";
      }


      try {
        // Write the modified content back to the file
        await fs.promises.writeFile(edit.filePath, newContent);
        return `Successfully applied ${edit.operation} operation to ${edit.filePath}`;
      } catch (error) {
       
          throw `Failed to write file: ${error},  you should try rewriting the file`;
        
      }
    } catch (error) {
     
        throw `Failed to apply edit: ${error}, you should try rewriting the file`;
     
    }
  }

  /**
   * Validates the edit request to ensure it has all required fields
   * @param edit The edit operation to validate
   * @returns A string with an error message if validation fails, or null if validation passes
   */
  private validateEdit(edit: CodeEdit): string | null {
    if (!edit.filePath) {
      return 'File path is required';
    }

    if (!edit.operation) {
      return 'Operation type is required';
    }

    if (!edit.locationForInsertion || typeof edit.locationForInsertion.startLine !== 'number') {
      return 'Start line number is required';
    }

    if (edit.operation !== 'delete' && !edit.content) {
      return 'Content is required for insert and replace operations';
    }

    if ((edit.operation === 'replace' || edit.operation === 'delete') &&
      edit.locationForInsertion.endLine &&
      edit.locationForInsertion.endLine < edit.locationForInsertion.startLine) {
      return 'End line cannot be before start line';
    }

    return null; // Validation passed
  }

  /**
   * Performs an insert operation
   * @param lines Array of file lines
   * @param startLine Line number where to insert (1-indexed)
   * @param content Content to insert
   * @returns The new file content as a string or an error message
   */
  private performInsert(lines: string[], startLine: number, content: string): string {
    try {
      // Convert to 0-indexed
      const lineIndex = startLine;

      // Ensure the line index is valid
      if (lineIndex < 0 || lineIndex > lines.length) {
        return `ERROR: Invalid line number: ${startLine}. File has ${lines.length} lines, you should consider rewriting the entire file.`;
      }

      // Insert the content at the specified line
      lines.splice(lineIndex, 0, ...content.split('\n'));

      return lines.join('\n');
    } catch (error) {
      if (error instanceof Error) {
        return `ERROR: Failed to perform insert: ${error.message}, you should consider rewriting the entire file`;
      }
      return 'ERROR: Failed to perform insert due to an unknown error, you should consider rewriting the entire file';
    }
  }

  /**
   * Performs a replace operation
   * @param lines Array of file lines
   * @param startLine Start line number (1-indexed)
   * @param endLine End line number (1-indexed)
   * @param content New content to replace the specified lines
   * @returns The new file content as a string or an error message
   */
  private performReplace(lines: string[], startLine: number, endLine: number, content: string): string {
    try {
      // Convert to 0-indexed
      const startIndex = startLine - 1;
      const endIndex = endLine - 1;

      // Ensure the line indices are valid
      if (startIndex < 0 || startIndex >= lines.length) {
        return `ERROR: Invalid start line: ${startLine}. File has ${lines.length} lines.`;
      }

      if (endIndex < 0 || endIndex >= lines.length) {
        return `ERROR: Invalid end line: ${endLine}. File has ${lines.length} lines.`;
      }

      // Replace the specified lines with the new content
      const contentLines = content.split('\n');
      lines.splice(startIndex, endIndex - startIndex + 1, ...contentLines);

      return lines.join('\n');
    } catch (error) {
      if (error instanceof Error) {
        return `ERROR: Failed to perform replace: ${error.message}, you should try to rewrite the entire file`;
      }
      return 'ERROR: Failed to perform replace due to an unknown error, you should try to rewrite the entire file';
    }
  }

  /**
   * Performs a delete operation
   * @param lines Array of file lines
   * @param startLine Start line number (1-indexed)
   * @param endLine End line number (1-indexed)
   * @returns The new file content as a string or an error message
   */
  private performDelete(lines: string[], startLine: number, endLine: number): string {
    try {
      // Convert to 0-indexed
      const startIndex = startLine - 1;
      const endIndex = endLine - 1;

      // Ensure the line indices are valid
      if (startIndex < 0 || startIndex >= lines.length) {
        return `ERROR: Invalid start line: ${startLine}. File has ${lines.length} lines.`;
      }

      if (endIndex < 0 || endIndex >= lines.length) {
        return `ERROR: Invalid end line: ${endLine}. File has ${lines.length} lines.`;
      }

      // Delete the specified lines
      lines.splice(startIndex, endIndex - startIndex + 1);

      return lines.join('\n');
    } catch (error) {
      if (error instanceof Error) {
        return `ERROR: Failed to perform delete: ${error.message}, you should try to rewrite the entire file`;
      }
      return 'ERROR: Failed to perform delete due to an unknown error';
    }
  }

  /**
   * Creates a backup of a file before editing
   * @param filePath Path to the file to backup
   * @returns The path to the backup file or an error message
   */
  public async createBackup(filePath: string): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${filePath}.${timestamp}.bak`;

      await fs.promises.copyFile(filePath, backupPath);
      return backupPath;
    } catch (error) {
      if (error instanceof Error) {
        return `Failed to create backup: ${error.message}`;
      }
      return 'Failed to create backup due to an unknown error';
    }
  }


  /**
   * Checks if the current user has write permissions for a file and updates them if needed
   * @param filePath Path to the file to check permissions for
   * @returns A promise that resolves to true if permissions are set correctly, or an error message
   */
  public async checkAndUpdatePermissions(filePath: string): Promise<boolean | string> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return `File not found: ${filePath}`;
      }

      // Check current permissions
      const stats = await fs.promises.stat(filePath);
      const currentMode = stats.mode;
      
      // Check if file is writable by the current user
      try {
        // Try to open the file for writing to check permissions
        await fs.promises.access(filePath, fs.constants.W_OK);
        return true; // File is already writable
      } catch (accessError) {
        // File is not writable, attempt to update permissions
        try {
          let sshclient = new SSHClient(filePath);
          await sshclient.executeCommand(`sudo chmod u+w "${filePath}"`);
          
          // Verify the permissions were updated successfully
          await fs.promises.access(filePath, fs.constants.W_OK);
          return true;
        } catch (chmodError) {
          return `Failed to update file permissions: ${chmodError instanceof Error ? chmodError.message : 'Unknown error'}`;
        }
      }
    } catch (error) {
      return `Error checking file permissions: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}


// (async()=>{

//   await EditTool.applyFinalEdit({
//           "filePath": "./src/prompt_library.js",
//           "operation": "replace",
//           "locationForInsertion":{"startLine":""},
//           "patchToBeEdited": "        {\n            \"name\": \"EditCodeFile\",\n            \"description\": \"Edits a code file by inserting, replacing, or deleting content at specific line.This object and all the objects given should be outputted in json format.\",\n            \"input_schema\": {\n                \"type\": \"object\",\n                \"required\": [\"filePath\", \"operation\"],\n                \"properties\": {\n                    \"filePath\": {\n                        \"type\": \"string\",\n                        \"description\": \"Path to the file to edit\"\n                    },\n                    \"operation\": {\n                        \"type\": \"string\",\n                        \"enum\": [\"insert\", \"replace\", \"delete\"],\n                        \"description\": \"Type of edit operation to perform\"\n                    },\n                    \"locationForInsertion\": {\n                        \"type\": \"object\",\n                        \"description\": \"this has to be json object, having the startLine only in json as the object.we will require the startLine after which the new patch of code will be added, to identify the startLine, you have to ouptut a set of lines so that we can infer the line number after which the change has to be made.\\\nremember, that the last line you output in startLine set will be the final line and after that line the insertion will happen, i repeat, only the last line in the startLine set.\\\nthe extra lines which you are outputting before the main startLine are used only to identify that one line after which the insertion will take place, so output least number of lines\\\nwhich can uniquely identify the insertion line.\",\n                        \"required\": [\"startLine\"],\n                        \"properties\": {\n                            \"startLine\": {\n                                \"type\": \"string\",\n                                \"description\": \"Lines(exact line as in the given code) where to start the edit, in case of insertion, the startLine will be the line after which the new content will be added.\"\n\n                            }\n                        }\n                    },\n                    \"patchToBeEdited\":\n                    {\n                        \"type\": \"string\",\n                        \"description\": \"this is the patch in the code file which has to be either replaced or deleted. If it has to be replaced, output the new code in content.\"\n                    },\n                    \"content\": {\n                        \"type\": \"string\",\n                        \"description\": \"New content to insert or replace (not needed for delete operations)\"\n                    },\n                    \"reason\": {\n                        \"type\": \"string\",\n                        \"description\": \"Optional documentation explaining why this edit is being made\"\n                    }\n                }\n            }\n        },",
//           "content": "        {\n            \"name\": \"EditCodeFile\",\n            \"description\": \"Edits a code file by inserting, replacing, or deleting content at specific line. This function accepts an array of edit objects.\",\n            \"input_schema\": {\n                \"type\": \"array\",\n                \"items\": {\n                    \"type\": \"object\",\n                    \"required\": [\"filePath\", \"operation\"],\n                    \"properties\": {\n                        \"filePath\": {\n                            \"type\": \"string\",\n                            \"description\": \"Path to the file to edit\"\n                        },\n                        \"operation\": {\n                            \"type\": \"string\",\n                            \"enum\": [\"insert\", \"replace\", \"delete\"],\n                            \"description\": \"Type of edit operation to perform\"\n                        },\n                        \"locationForInsertion\": {\n                            \"type\": \"object\",\n                            \"description\": \"this has to be json object, having the startLine only in json as the object.we will require the startLine after which the new patch of code will be added, to identify the startLine, you have to ouptut a set of lines so that we can infer the line number after which the change has to be made.\\\nremember, that the last line you output in startLine set will be the final line and after that line the insertion will happen, i repeat, only the last line in the startLine set.\\\nthe extra lines which you are outputting before the main startLine are used only to identify that one line after which the insertion will take place, so output least number of lines\\\nwhich can uniquely identify the insertion line.\",\n                            \"required\": [\"startLine\"],\n                            \"properties\": {\n                                \"startLine\": {\n                                    \"type\": \"string\",\n                                    \"description\": \"Lines(exact line as in the given code) where to start the edit, in case of insertion, the startLine will be the line after which the new content will be added.\"\n                                }\n                            }\n                        },\n                        \"patchToBeEdited\": {\n                            \"type\": \"string\",\n                            \"description\": \"this is the patch in the code file which has to be either replaced or deleted. If it has to be replaced, output the new code in content.\"\n                        },\n                        \"content\": {\n                            \"type\": \"string\",\n                            \"description\": \"New content to insert or replace (not needed for delete operations)\"\n                        },\n                        \"reason\": {\n                            \"type\": \"string\",\n                            \"description\": \"Optional documentation explaining why this edit is being made\"\n                        }\n                    }\n                }\n            }\n        },",
//           "reason": "Changed the EditCodeFile schema to accept an array of edit objects instead of a single object by changing the input_schema type from \"object\" to \"array\" and moving the object properties into the \"items\" property."
//         }

//   );
// })();



// Example usage:
/*
async function example() {
  try {
    // Optional: Create a backup before editing
    const backupPath = await EditTool.createBackup('/path/to/file.ts');
    console.log(`Backup created at: ${backupPath}`);
    
    // Apply an edit
    const result = await EditTool.applyEdit({
      filePath: '/path/to/file.ts',
      operation: 'insert',
      location: { startLine: 10 },
      content: 'console.log("New line inserted");',
      reason: 'Adding debug statement'
    });
    
    console.log(result);
  } catch (error) {
    console.error(error);
  }
}
*/
