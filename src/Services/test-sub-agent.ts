/**
 * Test script for sub-agent swarm functionality
 * Tests: swarm_start_sub_agent -> wait for result
 */

import Agent from './agent-system';
import { Operations } from '../classes/OperationsEnum';
import * as ds from '../DataStructures';
import { v4 as uuidv4 } from 'uuid';
import { TaskStatus } from '../DataAccessLayer/models/Task';
import { EC2Type } from '../DataStructures';
import { AgentTypeEnum } from '../classes/AgentTypeEnum';
import { AccessRights } from '../classes/ModelAccessRights';

async function testSubAgent() {
    console.log('\n=== Sub-Agent Swarm Test ===\n');

    // Setup minimal task context
    const testTaskId = `test-task-${Date.now()}`;
    const testUserId = 'test-user-swarm';
    const testFolderPath = process.env.TEST_FOLDER_PATH || process.cwd();
    const testEc2Ip = process.env.TEST_EC2_IP || '';
    const mode = testEc2Ip ? 1 : 0;

    console.log(`Mode: ${mode === 1 ? 'SSH' : 'Local'}`);
    console.log(`Folder: ${testFolderPath}`);
    if (mode === 1) console.log(`EC2 IP: ${testEc2Ip}`);

    // Create task data structure
    const testTaskData: ds.RunningTaskData = {
        taskId: testTaskId,
        taskName: 'Sub-Agent Test Task',
        taskSessionId: uuidv4(),
        wpId: 'test-wp',
        organizationId: 'test-org',
        organizationName: 'TestOrg',
        playwrightUrl: '',
        startedByUserId: testUserId,
        folderPath: testFolderPath,
        ec2InstanceIP: testEc2Ip,
        startedAt: new Date(),
        status: TaskStatus.Running,
        createdBy: testUserId,
        sessionId_chatHistoryData: {},
        branchName: 'test-branch',
        assignedEc2InstanceId: 'test-ec2',
        repoDetails: [],
        workspaceName: 'test-workspace',
        isDependencyInstalled: false,
        EC2Type: EC2Type.Task,
        socketId: null,
        childTasks: []
    };

    // Register task in memory
    ds.taskId_task.set(testTaskId, testTaskData);

    // Create parent agent
    const chatHistoryFile = `test-swarm-${Date.now()}.json`;
    console.log('\nCreating parent agent...');
    
    const parentAgent = new Agent(
        mode,
        testFolderPath,
        Operations.CODING_AGENT,
        testEc2Ip,
        chatHistoryFile,
        testTaskId,
        testUserId,
        AgentTypeEnum.MASTER_AGENT,
        [AccessRights.READ_FILES, AccessRights.WRITE_FILES, AccessRights.EXECUTE_COMMAND_TOOL],
        false,
        undefined, // sharedMemoryPath
        undefined  // modelKey
    );

    testTaskData.Agent = parentAgent;

    try {
        console.log('Connecting parent agent...');
        await parentAgent.connect();
        console.log('✓ Parent agent connected\n');

        // Build swarm_start_sub_agent tool call
        const subAgentTask = 'List all TypeScript files in the current directory using ls command, then read the first 50 lines of package.json file';
        
        const toolCall = {
            id: uuidv4(),
            name: 'swarm_start_sub_agent',
            input: {
                prompt: subAgentTask,
                modelKey: 'Claude_Sonnet_45'
            }
        };

        console.log('Starting sub-agent with task:');
        console.log(`  "${subAgentTask}"\n`);
        console.log('Executing swarm_start_sub_agent...');

        const result = await parentAgent.executeToolWithoutLLM(toolCall, null);

        console.log('\n=== Sub-Agent Start Result ===');
        console.log(JSON.stringify(result, null, 2));

        if (result.success && result.agentId) {
            console.log(`\n✓ Sub-agent started successfully`);
            console.log(`  Agent ID: ${result.agentId}`);
            console.log(`  Session ID: ${result.sessionId}`);

            // Wait a bit for sub-agent to process
            console.log('\nWaiting 10 seconds for sub-agent to complete...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Check sub-agent status
            console.log('\nChecking sub-agent status...');
            const statusToolCall = {
                id: uuidv4(),
                name: 'swarm_get_sub_agent_status',
                input: {
                    agentId: result.agentId
                }
            };

            const statusResult = await parentAgent.executeToolWithoutLLM(statusToolCall, null);
            console.log('\n=== Sub-Agent Status ===');
            console.log(JSON.stringify(statusResult, null, 2));

            // Check message queue
            console.log('\nChecking parent agent message queue...');
            console.log(`Queue length: ${parentAgent.messageQueue?.length || 0}`);
            if (parentAgent.messageQueue && parentAgent.messageQueue.length > 0) {
                console.log('\n=== Messages from Sub-Agent ===');
                parentAgent.messageQueue.forEach((msg, idx) => {
                    console.log(`\nMessage ${idx + 1}:`);
                    console.log(msg);
                });
            }
        } else {
            console.error('\n✗ Failed to start sub-agent');
        }

    } catch (error) {
        console.error('\n✗ Error during test:', error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }
    } finally {
        console.log('\nCleaning up...');
        await parentAgent.disconnect();
        ds.taskId_task.delete(testTaskId);
        console.log('✓ Cleanup complete\n');
    }
}

// Run test
testSubAgent().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
