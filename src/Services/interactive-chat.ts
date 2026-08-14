import readline from 'readline';
import Agent from './agent-system';
import {AIDiffFinder} from './ai-diff-finder';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {ChromaClient} from 'chromadb'
import{Operations} from '../classes/OperationsEnum'
import { AgentTypeEnum } from '../classes/AgentTypeEnum';
import { AccessRights } from '../classes/ModelAccessRights';
const SSHClient = require('./ssh-client');

let indexerFlag = true;//this is the flag which tells if the indexer feature has to be used
let canIndexerBeUsed = false; //this is the flag which tells if the  chroma db collection is created for the the LLM to use
// Terminal styling utilities
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',
    hidden: '\x1b[8m',
    
    fg: {
        black: '\x1b[30m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        crimson: '\x1b[38m'
    },
    
    bg: {
        black: '\x1b[40m',
        red: '\x1b[41m',
        green: '\x1b[42m',
        yellow: '\x1b[43m',
        blue: '\x1b[44m',
        magenta: '\x1b[45m',
        cyan: '\x1b[46m',
        white: '\x1b[47m',
        crimson: '\x1b[48m'
    }
};

// Terminal styling helper functions
const style = {
    title: (text: string) => `${colors.bright}${colors.fg.cyan}${text}${colors.reset}`,
    subtitle: (text: string) => `${colors.fg.magenta}${text}${colors.reset}`,
    success: (text: string) => `${colors.fg.green}${text}${colors.reset}`,
    error: (text: string) => `${colors.fg.red}${text}${colors.reset}`,
    warning: (text: string) => `${colors.fg.yellow}${text}${colors.reset}`,
    info: (text: string) => `${colors.fg.blue}${text}${colors.reset}`,
    highlight: (text: string) => `${colors.bright}${colors.fg.yellow}${text}${colors.reset}`,
    dim: (text: string) => `${colors.dim}${text}${colors.reset}`,
    userPrompt: (text: string) => `${colors.fg.green}${text}${colors.reset}`,
    aiResponse: (text: string) => `${colors.fg.cyan}${text}${colors.reset}`,
    separator: () => `${colors.dim}${'─'.repeat(process.stdout.columns || 80)}${colors.reset}`,
    boxedTitle: (title: string) => {
        const padding = 2;
        const width = (process.stdout.columns || 80) - (padding * 2);
        const titleLine = ` ${title} `;
        const leftFill = '═'.repeat(Math.max(0, Math.floor((width - titleLine.length) / 2)));
        const rightFill = '═'.repeat(Math.max(0, Math.ceil((width - titleLine.length) / 2)));
        return `${colors.fg.cyan}${leftFill}${colors.bright}${titleLine}${colors.reset}${colors.fg.cyan}${rightFill}${colors.reset}`;
    }
};

// Loading spinner animation
class Spinner {
    private frames: string[];
    private interval: NodeJS.Timeout | null = null;
    private currentFrame: number = 0;
    private text: string;
    private isSpinning: boolean = false;
    
    constructor(text: string = 'Processing') {
        this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.text = text;
    }
    
    start(): void {
        if (this.isSpinning) return;
        this.isSpinning = true;
        process.stdout.write('\x1b[?25l'); // Hide cursor
        
        this.interval = setInterval(() => {
            const frame = this.frames[this.currentFrame];
            process.stdout.write(`\r${colors.fg.cyan}${frame}${colors.reset} ${this.text}...`);
            this.currentFrame = (this.currentFrame + 1) % this.frames.length;
        }, 80);
    }
    
    stop(): void {
        if (!this.isSpinning) return;
        clearInterval(this.interval as NodeJS.Timeout);
        process.stdout.write('\r\x1b[K'); // Clear line
        process.stdout.write('\x1b[?25h'); // Show cursor
        this.isSpinning = false;
    }
    
    setText(text: string): void {
        this.text = text;
    }
}

class InteractiveChatbot {
    agent_ec2: any;
    agent_docker:any;
    rl: readline.Interface;
    folderPath: string;
    aiDiffFinder: AIDiffFinder;
    chatHistory: {role: string, content: string}[] = [];
    spinner: Spinner;
    sshClient:any;
    ec2_instance_ip:string;
    constructor(mode: number, folderPath: string, collectionName: string, ec2_instance_ip:string) {
        this.ec2_instance_ip = ec2_instance_ip;
        let sampleChatPath = 'sampleChatPath/1';
        this.agent_ec2 = new Agent(mode, folderPath, Operations.DOCKER_SETUP, ec2_instance_ip, sampleChatPath, '', '', AgentTypeEnum.MASTER_AGENT, [AccessRights.READ_FILES, AccessRights.WRITE_FILES, AccessRights.EXECUTE_COMMAND_TOOL], false);
        this.agent_docker = new Agent(mode, folderPath, Operations.CODING_AGENT, ec2_instance_ip, sampleChatPath, '', '', AgentTypeEnum.MASTER_AGENT, [AccessRights.READ_FILES, AccessRights.WRITE_FILES, AccessRights.EXECUTE_COMMAND_TOOL], false);
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `${style.userPrompt('👤 You:')} `
        });
        this.folderPath = folderPath;
        this.aiDiffFinder = new AIDiffFinder(folderPath);
        this.spinner = new Spinner();
        this.sshClient = new SSHClient(folderPath,ec2_instance_ip);
    }

    async start() {
        try {
            // Display welcome banner
            this.displayWelcomeBanner();
            
            this.spinner.setText('Connecting to remote server');
            this.spinner.start();
            await this.agent_ec2.connect();
            await this.agent_docker.connect();
            this.spinner.stop();
            
            console.log(`\n${style.success('🤖 Connected!')} `);
            console.log(`${style.info('ℹ️  Type')} ${style.highlight('"exit"')} ${style.info('or press')} ${style.highlight('Ctrl+C')} ${style.info('to quit.')}\n`);

            console.log("\n setting up the docker container..");

            

//           await this.agent_ec2.run("setup the docker container for the project as instructed",[],Operations.DOCKER_SETUP); //for setting up the docker container for the project..


            this.rl.prompt();

            this.rl.on('line', async (line: string) => {
                if (line.toLowerCase() === 'exit') {
                    await this.cleanup();
                    return;
                }

                // Add user message to chat history
                this.chatHistory.push({ role: 'user', content: line });
                
                console.log(style.separator());

                try {
                    this.spinner.setText('Processing your request');
                    this.spinner.start();
//here we are sending the request to the server
                    const result = await this.agent_docker.run(line,[],Operations.CODING_AGENT);
//here we are sending the request for the server
                    
                    
                    this.spinner.stop();
                    
                    console.log(`\n${style.success('🤖 Processing complete!')}\n`);
                    console.log(`${style.aiResponse('🤖 Response:')}\n${result}\n`);
                    
                    // Add agent response to chat history
                    this.chatHistory.push({ role: 'agent', content: result });

                    // Save the current chat history to a file with unique GUID
                    await this.saveChatHistory();

                    // After LLM reply, check for AI diffs
                 //   this.spinner.setText('Checking for file changes');
                    this.spinner.start();
                  //  const diffs = await this.aiDiffFinder.getAIDiffs();
                    this.spinner.stop();
                    
                    // if (diffs.length > 0) {
                    //     // Display all diffs first
                    //     const filesWithDiff = [];
                    //     console.log(style.boxedTitle('File Changes Detected'));
                        
                    //     for (const { file, diff } of diffs) {
                    //         if (diff && diff.trim().length > 0) {
                    //             console.log(`\n${style.subtitle('📝 Diff for file:')} ${style.highlight(file)}\n`);
                    //             // Highlight additions and deletions in the diff
                    //             const formattedDiff = diff.split('\n').map(line => {
                    //                 if (line.startsWith('+')) return style.success(line);
                    //                 if (line.startsWith('-')) return style.error(line);
                    //                 return line;
                    //             }).join('\n');
                    //             console.log(formattedDiff);
                    //             filesWithDiff.push(file);
                    //         }
                    //     }
                        
                    //     console.log(style.separator());
                        
                    //     // Now, for each file, ask user if they want to keep the change
                    //     const tempAIMap = new Map();
                    //     for (const file of filesWithDiff) {
                    //         const answer = await this.promptUserYesNo(`${style.highlight('?')} Do you want to keep the AI changes for file ${style.highlight(file)}? (yes/no): `);
                    //         tempAIMap.set(file, answer);
                    //     }
                        
                    //     if (tempAIMap.size > 0) {
                    //         this.spinner.setText('Applying file changes');
                    //         this.spinner.start();
                    //         const results = await this.aiDiffFinder.applyTempAIToOriginals(tempAIMap);
                    //         this.spinner.stop();
                            
                    //         for (const { file, replaced } of results) {
                    //             if (replaced) {
                    //                 console.log(`${style.success('✅ Applied AI changes to:')} ${file}`);
                    //             } else {
                    //                 console.log(`${style.warning('❌ Discarded AI changes for:')} ${file}`);
                    //             }
                    //         }
                    //     }
                    // }
                } catch (error: any) {
                    this.spinner.stop();
                    console.error(`\n${style.error('❌ Error:')} ${error.message}\n`);
                    // Add error to chat history
                    this.chatHistory.push({ role: 'system', content: `Error: ${error.message}` });
                }

                console.log(style.separator());
                this.rl.prompt();
            });

            this.rl.on('close', async () => {
                await this.cleanup();
            });

        } catch (error: any) {
            this.spinner.stop();
            console.error(`\n${style.error('❌ Connection error:')} ${error.message}`);
            await this.cleanup();
        }
    }

    // Display a welcome banner
    displayWelcomeBanner() {
        const title = 'AI Terminal Assistant';
        console.clear();
        console.log('\n' + style.boxedTitle(title) + '\n');
        console.log(`${style.info('Welcome to the interactive AI terminal assistant!')}`);
        console.log(`${style.dim('This tool helps you interact with the system using natural language.')}\n`);
    }

    // Helper to prompt user for yes/no and return boolean
    async promptUserYesNo(question: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.rl.question(question, (answer: string) => {
                answer = answer.trim().toLowerCase();
                resolve(answer === 'yes' || answer === 'y');
            });
        });
    }

    // Generate a unique GUID
    generateGuid(): string {
        return crypto.randomUUID();
    }

    // Save the current chat history to a file with a unique GUID
    async saveChatHistory(): Promise<void> {
        try {
            const guid = this.generateGuid();
            const historyDir = path.join(this.folderPath, 'chat-history');
            
            // Create the history directory if it doesn't exist
            if (!fs.existsSync(historyDir)) {
                fs.mkdirSync(historyDir, { recursive: true });
            }
            
            const filename = path.join(historyDir, `history-${guid}.json`);
            const chatData = {
                timestamp: new Date().toISOString(),
                history: this.chatHistory
            };
            
            fs.writeFileSync(filename, JSON.stringify(chatData, null, 2), 'utf8');
            console.log(`${style.dim('💾 Chat history saved to:')} ${filename}`);
        } catch (error: any) {
            console.error(`\n${style.error('❌ Error saving chat history:')} ${error.message}`);
        }
    }

    async cleanup() {
        this.spinner.setText('Disconnecting from server');
        this.spinner.start();
        await this.agent_docker.disconnect();
        this.spinner.stop();
        
        // Save chat history one final time before exiting
        if (this.chatHistory.length > 0) {
            await this.saveChatHistory();
        }
        
        console.log(`\n${style.success('👋 Goodbye!')}\n`);
        process.exit(0);
    }
}

// Main entry point: pass command-line arguments to main
async function main(args: string[]) {
    // You can use args as needed, e.g., pass to chatbot or for config
    let mode = parseInt(args[0],10);
    let folderPath = args[1];
    let ec2_instance_ip = process.env.EC2_INSTANCE_IP || 'localhost';
    console.log(`${style.dim('mode=>')} ${mode}`);
    console.log(`${style.dim('folderPath=>')} ${folderPath}`);
    let collectionName = path.basename(folderPath); // getting the last name of the folder as the collection name

    const chatbot = new InteractiveChatbot(mode, folderPath,collectionName,ec2_instance_ip);
    //checking if the indexer is ready i.e if the collection is really created.
    let chromaManager = new ChromaClient({
        path: "http://localhost:8080"
    })
    const collections = await chromaManager.listCollections();
    canIndexerBeUsed = collections.some(collection=>collection ===collectionName);
    await chatbot.start();
}

if (require.main === module) {
    // Pass command-line arguments (excluding node and script path) to main
    main(process.argv.slice(2));
    //main(["0","F:\\current projects\\AI_CODER"]);
}
