
import { spawn } from 'child_process';
import * as path from 'path';

/**
 * Launcher script that starts both indexer.ts and interactive-chat.ts in separate Windows terminals
 * using PowerShell for better path handling
 * 
 * Usage: ts-node src/launcher.ts <mode> <folderPath>
 * 
 * @param mode - The mode to run in (passed to interactive-chat.ts)
 * @param folderPath - The folder path to index and use for chat
 */
async function main() {
    // Get command line arguments
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.error('Usage: ts-node src/launcher.ts <mode> <folderPath>');
        console.error('  mode: 0 for local, 1 for remote');
        console.error('  folderPath: Path to the folder to index and use for chat');
        console.error('  Note: If folderPath contains spaces, enclose it in double quotes');
        console.error('  Example: ts-node launcher.ts 0 "C:\My Projects\Code Folder"');
        process.exit(1);
    }
    
    const mode = args[0];
    const folderPath = path.resolve(args[1]); // Resolve to absolute path
    
    console.log(`Starting services with mode: ${mode} and folder path: ${folderPath}`);
    
    // Get the absolute path to the project root and scripts
    const projectRoot = path.resolve(__dirname, '..');
    const indexerPath = path.resolve(__dirname, 'indexer.ts');
    const chatPath = path.resolve(__dirname, 'interactive-chat.ts');
    
    console.log(`Project root: ${projectRoot}`);
    console.log(`Indexer path: ${indexerPath}`);
    console.log(`Chat path: ${chatPath}`);
    
    // Start indexer.ts in a new Windows terminal using PowerShell
    console.log('Starting indexer...');
    const indexerCommand = `Set-Location -Path '${projectRoot}'; ts-node '${indexerPath}' '${folderPath}'`;
    
// Start indexer.ts in a new Windows terminal
const indexerProcess = spawn('cmd.exe', [
  '/c', 'start', 'powershell.exe',
  '-NoExit',
  '-Command', `& {Set-Location -Path '${projectRoot}'; & ts-node '${indexerPath}' '${folderPath}'}`
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false
});
indexerProcess.unref();

// Start interactive-chat.ts in a new Windows terminal
const chatProcess = spawn('cmd.exe', [
  '/c', 'start', 'powershell.exe',
  '-NoExit',
  '-Command', `& {Set-Location -Path '${projectRoot}'; & ts-node '${chatPath}' ${mode} '${folderPath}'}`
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false
});
chatProcess.unref();
    
    // Handle chat process events
    chatProcess.on('error', (error) => {
        console.error(`Failed to start interactive chat: ${error.message}`);
    });
    
    console.log('Both services started in separate PowerShell terminals.');
    console.log('Close the terminal windows when you are done.');
}

if (require.main === module) {
    // Use the main function which runs processes in separate terminals in parallel
    main().catch(error => {
        console.error(`Unhandled error in launcher: ${error.message}`);
        process.exit(1);
    });
}
