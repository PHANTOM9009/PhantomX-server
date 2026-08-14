
import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface defining the structure for file reading operations
 */
interface ReadFileOptions {
  targetFile: string;                      // relative path to the target file
  absolutePath:string;
  shouldReadEntireFile: boolean;         // Whether to read the entire file
  startLineOneIndexed: number;           // Start line number (1-indexed)
  endLineOneIndexedInclusive: number;   // End line number (1-indexed, inclusive)
  explanation?: string;                     // Optional explanation for the operation
}

/**
 * Class that provides file reading functionality
 */
export class ReadFileTool {
  /**
   * Constructor for ReadFileTool
   * No longer requires a folderPath parameter as we'll use absolute paths directly
   */
  constructor() {}

  /**
   * Reads the contents of a file within the specified line range
   * @param options The read operation options
   * @returns A promise that resolves to the file contents and summary
   */
  public async readFile(options: ReadFileOptions): Promise<string> {
    try {
      // Use the absolutePath directly
      const fullPath = options.absolutePath;

      // Validate the read request
      await this.validateReadOptions(options, fullPath);

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
      }

      // Read the file content
      const fileContent = await fs.promises.readFile(fullPath, 'utf8');
      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // If reading the entire file is requested
      if (options.shouldReadEntireFile) {
        // Check if the file has been edited or manually attached
        const fileName = path.basename(fullPath);
        
              
        // Check if the file is too large (more than 1000 lines)
        if (totalLines > 1000) {
          throw new Error(`File is too large to read entirely (${totalLines} lines). Please specify a line range.`);
        }
        
        return fileContent;
      }
      
      // If the file has fewer than 200 lines, read the entire file
      if (totalLines < 200) {
        return fileContent;
      }

      // Ensure the line indices are valid and adjust to read at least 200 lines when possible
      let startLine = Math.max(1, options.startLineOneIndexed);
      let endLine = Math.min(totalLines, options.endLineOneIndexedInclusive);
      
      // Adjust the range to ensure we read at least 200 lines when possible
      const adjustedRange = this.adjustLineRange(startLine, endLine, totalLines);
      startLine = adjustedRange.start;
      endLine = adjustedRange.end;

      // Convert to 0-indexed for array access
      const startIndex = startLine - 1;
      const endIndex = endLine - 1;

      // Extract the requested lines and return them without any summary
      const requestedLines = lines.slice(startIndex, endIndex + 1);
      return requestedLines.join('\n');
      
    } catch (error) {
      if (error instanceof Error) {
        return `Failed to read file: ${error.message}`;
      }
      return 'Failed to read file due to an unknown error';
    }
  }

  /**
   * Validates the read options to ensure they have all required fields and are within valid ranges
   * @param options The read options to validate
   * @param fullPath The full path to the file
   */
  private async validateReadOptions(options: ReadFileOptions, fullPath: string): Promise<void> {
    if (!options.targetFile) {
      throw new Error('Target file path is required');
    }

    if (typeof options.shouldReadEntireFile !== 'boolean') {
      throw new Error('should_read_entire_file must be a boolean');
    }

    if (!options.shouldReadEntireFile) {
      // Check if file exists before validating line numbers
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
      }
      
      // Get total line count
      const fileContent = await fs.promises.readFile(fullPath, 'utf8');
      const totalLines = fileContent.split('\n').length;
      if (typeof options.startLineOneIndexed !== 'number' || options.startLineOneIndexed < 1) {
        throw new Error('Start line must be a positive number');
      }

      if (typeof options.endLineOneIndexedInclusive !== 'number' || options.endLineOneIndexedInclusive < 1) {
        throw new Error('End line must be a positive number');
      }

      if (options.endLineOneIndexedInclusive < options.startLineOneIndexed) {
        throw new Error('End line cannot be before start line');
      }

      // Check if the requested range is within the allowed limits (max 250 lines, min 200 lines)
      const requestedLineCount = options.endLineOneIndexedInclusive - options.startLineOneIndexed + 1;
      if (requestedLineCount > 250) {
        throw new Error('Cannot read more than 250 lines at a time');
      }
      
      // Ensure minimum 200 lines are read when possible
      if (requestedLineCount < 200 && totalLines >= 200) {
        throw new Error('Must read at least 200 lines at a time unless the file is smaller');
      }
    }
  }

  /**
   * Gets the total number of lines in a file
   * @param filePath Path to the file
   * @returns The total number of lines in the file
   */
  public async getLineCount(filePath: string): Promise<number> {
    try {
      // Use the absolute path directly
      const fullPath = filePath;
      const fileContent = await fs.promises.readFile(fullPath, 'utf8');
      return fileContent.split('\n').length;
    } catch (error) {
      throw new Error(`Failed to get line count: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

 
  /**
   * Adjusts the line range to ensure we read at least 200 lines when possible
   * @param startLine The starting line number
   * @param endLine The ending line number
   * @param totalLines The total number of lines in the file
   * @returns An object with adjusted start and end line numbers
   */
  private adjustLineRange(startLine: number, endLine: number, totalLines: number): { start: number, end: number } {
    const requestedLineCount = endLine - startLine + 1;
    
    // If the file has fewer than 200 lines or the requested range is already at least 200 lines, return as is
    if (totalLines < 200 || requestedLineCount >= 200) {
      return { start: startLine, end: endLine };
    }
    
    // We need to expand the range to include at least 200 lines
    const linesToAdd = 200 - requestedLineCount;
    
    // Try to add lines evenly before and after the requested range
    const addBefore = Math.floor(linesToAdd / 2);
    const addAfter = linesToAdd - addBefore;
    
    // Calculate new start and end lines
    let newStart = Math.max(1, startLine - addBefore);
    let newEnd = Math.min(totalLines, endLine + addAfter);
    
    // If we couldn't add enough lines at one end, add more at the other end
    if (newStart > 1 && (newEnd - newStart + 1) < 200) {
      newStart = Math.max(1, newStart - (200 - (newEnd - newStart + 1)));
    } else if (newEnd < totalLines && (newEnd - newStart + 1) < 200) {
      newEnd = Math.min(totalLines, newEnd + (200 - (newEnd - newStart + 1)));
    }
    
    return { start: newStart, end: newEnd };
  }
}

// Example usage:
/*
async function example() {
  try {
    const readFileTool = new ReadFileTool('/path/to/base/folder');
    
    // Read a specific range of lines
    const result = await readFileTool.readFile({
      targetFile: 'path/to/file.ts',
      shouldReadEntireFile: false,
      startLineOneIndexed: 10,
      endLineOneIndexedInclusive: 50,
      explanation: 'Reading function implementation'
    });
    console.log(result);
    
    // Read the entire file
    const entireFile = await readFileTool.readFile({
      targetFile: 'path/to/file.ts',
      shouldReadEntireFile: true,
      startLineOneIndexed: 1,
      endLineOneIndexedInclusive: 1,
      explanation: 'Reading the entire file'
    });
    console.log(entireFile);
  } catch (error) {
    console.error('Error:', error);
  }
}
*/