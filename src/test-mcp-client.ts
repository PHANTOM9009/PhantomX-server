/**
 * Test file for MCP Client remote connection
 * Usage: npx ts-node src/test-mcp-client.ts <server-url>
 * Example: npx ts-node src/test-mcp-client.ts http://192.168.1.100:8080
 */

import { MCPClient } from './MCP_Client';

async function testMCPClient() {
    const serverUrl = process.argv[2] || process.env.PLAYWRIGHT_MCP_URL;
    
    if (!serverUrl) {
        console.error('Usage: npx ts-node src/test-mcp-client.ts <server-url>');
        console.error('Example: npx ts-node src/test-mcp-client.ts http://192.168.1.100:8080');
        process.exit(1);
    }

    console.log(`Testing MCP Client connection to: ${serverUrl}`);
    
    const client = new MCPClient();
    
    try {
        // Test 1: Connect to server
        console.log('\n--- Test 1: Connecting to server ---');
        await client.connectToServer(serverUrl);
        console.log('Connection successful!');
        console.log('Is connected:', client.isServerConnected());
        console.log('Server URL:', client.getServerUrl());
        
        // Test 2: List tools
        console.log('\n--- Test 2: Listing tools ---');
        const tools = await client.getAllTools();
        const toolList: any[] = (tools.tools as unknown as any[]) ?? [];
        console.log(`Found ${toolList.length} tools:`);
        toolList.slice(0, 10).forEach((tool: any) => {
            console.log(`  - ${tool.name}: ${tool.description?.substring(0, 60)}...`);
        });
        if (toolList.length > 10) {
            console.log(`  ... and ${toolList.length - 10} more tools`);
        }
        
        // Test 3: Navigate to a page
        console.log('\n--- Test 3: Browser navigation ---');
        const navResult = await client.getToolResult({
            name: 'browser_navigate',
            input: { url: 'https://example.com' }
        });
        console.log('Navigation result:', JSON.stringify(navResult, null, 2).substring(0, 500));
        
        // Test 4: Take a snapshot
        console.log('\n--- Test 4: Browser snapshot ---');
        const snapshotResult = await client.getToolResult({
            name: 'browser_snapshot',
            input: {}
        });
        console.log('Snapshot result (truncated):', JSON.stringify(snapshotResult, null, 2).substring(0, 500));
        
        // Test 5: Disconnect
        console.log('\n--- Test 5: Disconnecting ---');
        await client.disconnect();
        console.log('Disconnected successfully!');
        console.log('Is connected:', client.isServerConnected());
        
        console.log('\n=== All tests passed! ===');
        
    } catch (error) {
        console.error('\nTest failed with error:', error);
        
        // Try to disconnect on error
        try {
            await client.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }
        
        process.exit(1);
    }
}

testMCPClient();
