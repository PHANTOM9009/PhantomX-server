import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface for StartDockerContainer tool input
 */
interface StartDockerContainerInput {
  composeFilePath: string;           // Path to Docker Compose file (required)
  serviceNames?: string[];           // Specific services to start (optional)
  environment?: Record<string, string>; // Environment variables (optional)
  detached?: boolean;               // Run in detached mode (default: true)
  buildImages?: boolean;            // Build images before starting (default: false)
  forceRecreate?: boolean;          // Force recreation of containers (default: false)
  additionalFlags?: string;         // Any additional docker-compose flags
}

/**
 * Interface for Docker container operation result
 */
interface DockerResult {
  success: boolean;
  containerIds?: string[];
  output: string;
  error?: string;
  command: string;
}

/**
 * Validates that the Docker Compose file exists at the specified path
 * @param sshClient - SSH client for remote execution
 * @param composeFilePath - Path to the Docker Compose file
 * @returns Promise<boolean> - Whether the file exists
 */
async function validateComposeFile(sshClient: any, composeFilePath: string): Promise<boolean> {
  try {
    const result = await sshClient.executeCommand(`test -f "${composeFilePath}" && echo "exists" || echo "not found"`);
    return result.output.trim() === 'exists';
  } catch (err) {
    console.error('Error validating compose file:', err);
    return false;
  }
}

/**
 * Builds a Docker Compose command based on the provided parameters
 * @param input - StartDockerContainer input parameters
 * @returns string - The constructed Docker Compose command
 */
function buildDockerComposeCommand(input: StartDockerContainerInput): string {
  // Start with the base command
  let command = `docker-compose -f "${input.composeFilePath}" up`;
  
  // Add detached mode flag (default to true if not specified)
  if (input.detached !== false) {
    command += ' -d';
  }
  
  // Add build flag if specified
  if (input.buildImages === true) {
    command += ' --build';
  }
  
  // Add force recreate flag if specified
  if (input.forceRecreate === true) {
    command += ' --force-recreate';
  }
  
  // Add additional flags if specified
  if (input.additionalFlags) {
    command += ` ${input.additionalFlags}`;
  }
  
  // Add environment variables if specified
  let envVars = '';
  if (input.environment && Object.keys(input.environment).length > 0) {
    for (const [key, value] of Object.entries(input.environment)) {
      envVars += `${key}="${value}" `;
    }
  }
  
  // Add service names if specified
  if (input.serviceNames && input.serviceNames.length > 0) {
    command += ' ' + input.serviceNames.join(' ');
  }
  
  // Prepend environment variables to the command
  if (envVars) {
    command = `${envVars}${command}`;
  }
  
  return command;
}

/**
 * Parse container IDs from Docker Compose output
 * @param output - Output from Docker Compose command
 * @returns string[] - Array of container IDs
 */
function parseContainerIds(output: string): string[] {
  const containerIds: string[] = [];
  const lines = output.split('\n');
  
  // Look for container IDs in the output
  for (const line of lines) {
    // Docker Compose typically outputs "Creating container_name ... done"
    // or "Container ID: xxxxxx"
    const match = line.match(/Container (ID: )?([0-9a-f]{12})/i) || 
                 line.match(/Created Container ([0-9a-f]{12})/i);
    if (match && match[2]) {
      containerIds.push(match[2]);
    }
  }
  
  return containerIds;
}

/**
 * Start Docker containers using Docker Compose
 * @param sshClient - SSH client for remote execution
 * @param input - StartDockerContainer input parameters
 * @returns Promise<DockerResult> - Result of the operation
 */
export async function startDockerContainer(sshClient: any, input: StartDockerContainerInput): Promise<DockerResult> {
  try {
    // Validate the compose file exists
    const fileExists = await validateComposeFile(sshClient, input.composeFilePath);
    if (!fileExists) {
      return {
        success: false,
        output: '',
        error: `Docker Compose file not found at path: ${input.composeFilePath}`,
        command: ''
      };
    }
    
    // Build the Docker Compose command
    const command = buildDockerComposeCommand(input);
    
    // Execute the command
    console.log(`Executing Docker Compose command: ${command}`);
    const result = await sshClient.executeCommand(command);
    
    // Extract container IDs from the output if available
    const containerIds = parseContainerIds(result.output);
    
    // Return the result
    return {
      success: result.success,
      containerIds,
      output: result.output,
      error: result.error,
      command
    };
  } catch (err) {
    return {
      success: false,
      output: '',
      error: `Error executing Docker Compose command: ${err}`,
      command: ''
    };
  }
}

/**
 * Interface for GetDockerContainerStatus tool input
 */
interface GetDockerContainerStatusInput {
  containerIds?: string[];       // Optional container IDs to filter (if not provided, all containers are returned)
  format?: 'table' | 'json';     // Output format (default: table)
}

/**
 * Get the status of running Docker containers
 * @param sshClient - SSH client for remote execution
 * @param input - Optional input parameters for filtering and formatting
 * @returns Promise<string> - Container status information
 */
export async function getDockerContainerStatus(sshClient: any, input?: GetDockerContainerStatusInput): Promise<string> {
  try {
    // Default command to get container status in table format
    let command = 'docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"';
    
    // If input is provided, handle the options
    if (input) {
      // If containerIds are provided, filter the results
      if (input.containerIds && input.containerIds.length > 0) {
        // Filter by container IDs
        const containerFilter = input.containerIds.join('|');
        command = `docker ps --filter "id=${containerFilter}" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"`;                                
      }
      
      // If format is json, use json format
      if (input.format === 'json') {
        command = command.replace('table', 'json');
      }
    }
    
    console.log(`Executing Docker status command: ${command}`);
    const result = await sshClient.executeCommand(command);
    return result.output;
  } catch (err) {
    return `Error getting container status: ${err}`;
  }
}

/**
 * List all Docker Compose files in the project
 * @param sshClient - SSH client for remote execution
 * @param projectPath - Path to the project
 * @returns Promise<string[]> - List of Docker Compose files
 */
export async function findDockerComposeFiles(sshClient: any, projectPath: string): Promise<string[]> {
  try {
    const result = await sshClient.executeCommand(
      `find "${projectPath}" -name "docker-compose*.y*ml" | sort`
    );
    
    if (!result.success) {
      return [];
    }
    
    return result.output
      .split('\n')
      .filter((line: string) => line.trim().length > 0);
  } catch (err) {
    console.error('Error finding Docker Compose files:', err);
    return [];
  }
}
