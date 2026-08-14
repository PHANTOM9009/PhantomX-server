import readline from 'readline';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Agent from './agent-system';
import { Operations } from '../classes/OperationsEnum';
import { AgentTypeEnum } from '../classes/AgentTypeEnum';
import { AccessRights } from '../classes/ModelAccessRights';

type ToolCallPayload = {
    id: string;
    name: string;
    input: any;
};

class ToolDevPlugin {
    private rl: readline.Interface;
    private agent: Agent;
    private isRunning: boolean = true;

    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const mode = Number(process.env.TOOL_DEV_MODE || '1');
        const folderPath = process.env.TOOL_DEV_FOLDER_PATH || process.cwd();
        const ec2Ip = process.env.TOOL_DEV_EC2_IP || process.env.EC2_INSTANCE_IP || '';
        const chatHistoryName = process.env.TOOL_DEV_HISTORY_FILE || `tool-dev-plugin-${Date.now()}.json`;
        const taskId = process.env.TOOL_DEV_TASK_ID || `tool-dev-task-${Date.now()}`;
        const userId = process.env.TOOL_DEV_USER_ID || 'tool-dev-user';
        const modelKey = process.env.TOOL_DEV_MODEL_KEY;
        const enableGithubTools = (process.env.TOOL_DEV_ENABLE_GITHUB || 'false').toLowerCase() === 'true';

        if (mode === 1 && !ec2Ip) {
            throw new Error('TOOL_DEV_EC2_IP (or EC2_INSTANCE_IP) is required when TOOL_DEV_MODE=1');
        }

        this.agent = new Agent(
            mode,
            folderPath,
            Operations.CODING_AGENT,
            ec2Ip,
            chatHistoryName,
            taskId,
            userId,
            AgentTypeEnum.MASTER_AGENT,
            [AccessRights.READ_FILES, AccessRights.WRITE_FILES, AccessRights.EXECUTE_COMMAND_TOOL],
            false,
            undefined, // sharedMemoryPath
            modelKey,
            undefined, // collectionName
            undefined, // modelName
            undefined, // uiLink
            enableGithubTools
        );
    }

    private ask(question: string): Promise<string> {
        return new Promise((resolve) => {
            this.rl.question(question, (answer) => resolve(answer.trim()));
        });
    }

    private printBanner(): void {
        console.log('\n=== Tool Dev Plugin (No LLM) ===');
        console.log('Use this plugin to manually trigger tools for development/testing.');
        console.log('Each menu option builds a tool call and executes it via Agent.executeToolWithoutLLM().\n');
    }

    private printMenu(): void {
        console.log('\nSelect an option:');
        console.log('1) Execute_commmand');
        console.log('2) Execute_commmand_host_machine');
        console.log('3) StartBackgroundProcess');
        console.log('4) ListBackgroundProcesses');
        console.log('5) GetBackgroundProcessLogs');
        console.log('6) TerminateBackgroundProcess');
        console.log('7) ReadFile');
        console.log('8) EditCodeFile');
        console.log('9) swarm_start_sub_agent');
        console.log('10) swarm_send_agent_message');
        console.log('11) swarm_get_sub_agent_status');
        console.log('12) swarm_stop_sub_agent');
        console.log('13) swarm_get_agent_current_status');
        console.log('14) swarm_start_child_task');
        console.log('15) swarm_get_child_task_status');
        console.log('16) swarm_send_child_task_message');
        console.log('17) swarm_stop_child_task');
        console.log('18) Run raw tool JSON');
        console.log('q) Quit\n');
    }

    private async buildToolCall(choice: string): Promise<ToolCallPayload | null> {
        if (choice === '1') {
            const command = await this.ask('Enter command: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'Execute_commmand',
                input: {
                    command,
                    explanation: explanation || 'Manual tool dev plugin invocation'
                }
            };
        }

        if (choice === '2') {
            const confirm = await this.ask('This runs on host machine. Continue? (yes/no): ');
            if (confirm.toLowerCase() !== 'yes') {
                return null;
            }
            const command = await this.ask('Enter host command: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'Execute_commmand_host_machine',
                input: {
                    command,
                    explanation: explanation || 'Manual host command invocation'
                }
            };
        }

        if (choice === '3') {
            const command = await this.ask('Enter background command: ');
            const processName = await this.ask('Process name (optional): ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'StartBackgroundProcess',
                input: {
                    command,
                    processName,
                    explanation: explanation || 'Starting process from tool dev plugin'
                }
            };
        }

        if (choice === '4') {
            return {
                id: uuidv4(),
                name: 'ListBackgroundProcesses',
                input: {}
            };
        }

        if (choice === '5') {
            const processId = Number(await this.ask('Process ID: '));
            const maxLinesRaw = await this.ask('Max lines (0 for all, default 0): ');
            const tailModeRaw = await this.ask('Tail mode? (true/false, default true): ');
            return {
                id: uuidv4(),
                name: 'GetBackgroundProcessLogs',
                input: {
                    processId,
                    maxLines: maxLinesRaw ? Number(maxLinesRaw) : 0,
                    tailMode: tailModeRaw ? tailModeRaw.toLowerCase() === 'true' : true
                }
            };
        }

        if (choice === '6') {
            const processId = Number(await this.ask('Process ID: '));
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'TerminateBackgroundProcess',
                input: {
                    processId,
                    explanation: explanation || 'Terminate process from tool dev plugin'
                }
            };
        }

        if (choice === '7') {
            const targetFile = await this.ask('Relative target file path: ');
            const shouldReadEntireFileRaw = await this.ask('Read entire file? (true/false): ');
            const startLineRaw = await this.ask('Start line (ignored when entire file=true): ');
            const endLineRaw = await this.ask('End line (ignored when entire file=true): ');
            const explanation = await this.ask('Explanation: ');
            return {
                id: uuidv4(),
                name: 'ReadFile',
                input: {
                    targetFile,
                    shouldReadEntireFile: shouldReadEntireFileRaw.toLowerCase() === 'true',
                    startLineOneIndexed: startLineRaw ? Number(startLineRaw) : 1,
                    endLineOneIndexedInclusive: endLineRaw ? Number(endLineRaw) : 250,
                    explanation: explanation || 'Manual read from tool dev plugin'
                }
            };
        }

        if (choice === '8') {
            const filePath = await this.ask('Relative file path: ');
            const startLine = await this.ask('Unique start line block to insert after: ');
            const content = await this.ask('Content to insert: ');
            const explanation = await this.ask('Explanation: ');

            return {
                id: uuidv4(),
                name: 'EditCodeFile',
                input: {
                    edits: [
                        {
                            id: uuidv4(),
                            filePath,
                            operation: 'insert',
                            locationForInsertion: {
                                startLine
                            },
                            content,
                            reason: 'Manual edit from tool dev plugin'
                        }
                    ],
                    explanation: explanation || 'Manual edit from tool dev plugin'
                }
            };
        }

        if (choice === '9') {
            const agentId = await this.ask('Agent ID: ');
            const instructions = await this.ask('Instructions: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_start_sub_agent',
                input: {
                    agentId,
                    instructions,
                    explanation: explanation || 'Manual swarm start sub agent'
                }
            };
        }

        if (choice === '10') {
            const agentId = await this.ask('Agent ID: ');
            const message = await this.ask('Message: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_send_agent_message',
                input: {
                    agentId,
                    message,
                    explanation: explanation || 'Manual swarm send message'
                }
            };
        }

        if (choice === '11') {
            const agentId = await this.ask('Agent ID: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_get_sub_agent_status',
                input: {
                    agentId,
                    explanation: explanation || 'Manual swarm get status'
                }
            };
        }

        if (choice === '12') {
            const agentId = await this.ask('Agent ID: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_stop_sub_agent',
                input: {
                    agentId,
                    explanation: explanation || 'Manual swarm stop agent'
                }
            };
        }

        if (choice === '13') {
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_get_agent_current_status',
                input: {
                    explanation: explanation || 'Manual swarm get current status'
                }
            };
        }

        if (choice === '14') {
            const jiraTicketId = await this.ask('Jira Ticket ID (optional): ');
            const repositoryName = await this.ask('Repository Name (optional): ');
            const taskDescription = await this.ask('Task Description: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_start_child_task',
                input: {
                    jiraTicketId: jiraTicketId || undefined,
                    repositoryName: repositoryName || undefined,
                    taskDescription,
                    explanation: explanation || 'Manual swarm start child task'
                }
            };
        }

        if (choice === '15') {
            const childTaskId = await this.ask('Child Task ID: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_get_child_task_status',
                input: {
                    childTaskId,
                    explanation: explanation || 'Manual swarm get child task status'
                }
            };
        }

        if (choice === '16') {
            const childTaskId = await this.ask('Child Task ID: ');
            const message = await this.ask('Message: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_send_child_task_message',
                input: {
                    childTaskId,
                    message,
                    explanation: explanation || 'Manual swarm send child task message'
                }
            };
        }

        if (choice === '17') {
            const childTaskId = await this.ask('Child Task ID: ');
            const explanation = await this.ask('Explanation (optional): ');
            return {
                id: uuidv4(),
                name: 'swarm_stop_child_task',
                input: {
                    childTaskId,
                    explanation: explanation || 'Manual swarm stop child task'
                }
            };
        }

        if (choice === '18') {
            const rawJson = await this.ask('Paste raw tool JSON ({"name":"...","input":{...}}): ');
            const parsed = JSON.parse(rawJson);
            return {
                id: parsed.id || uuidv4(),
                name: parsed.name,
                input: parsed.input || {}
            };
        }

        return null;
    }

    private printResult(result: any): void {
        console.log('\nTool execution result:');
        console.log(JSON.stringify(result, null, 2));
    }

    public async start(): Promise<void> {
        this.printBanner();
        await this.agent.connect();
        console.log('Agent connected.\n');

        while (this.isRunning) {
            try {
                this.printMenu();
                const choice = await this.ask('Enter option: ');

                if (choice.toLowerCase() === 'q') {
                    this.isRunning = false;
                    break;
                }

                const toolCall = await this.buildToolCall(choice);
                if (!toolCall) {
                    console.log('No tool was executed.');
                    continue;
                }

                const result = await this.agent.executeToolWithoutLLM(toolCall, null);
                this.printResult(result);
            }
            catch (error) {
                console.error('Error during tool execution:', error instanceof Error ? error.message : String(error));
            }
        }

        await this.stop();
    }

    public async stop(): Promise<void> {
        await this.agent.disconnect();
        this.rl.close();
        console.log('Tool dev plugin stopped.');
    }
}

async function main(): Promise<void> {
    const plugin = new ToolDevPlugin();

    process.on('SIGINT', async () => {
        await plugin.stop();
        process.exit(0);
    });

    await plugin.start();
}

main().catch((error) => {
    console.error('Fatal error in tool dev plugin:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
