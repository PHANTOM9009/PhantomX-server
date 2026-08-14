/**
 * Simple test/example file for VM Provider abstraction
 * 
 * This demonstrates how to use the new VM provider abstraction layer
 * Run with: npx ts-node src/Services/vm-providers/test-vm-provider.ts
 */

import { VMService, VMProviderFactory, VMProviderType } from './index';

async function main() {
    console.log('=== VM Provider Abstraction Test ===\n');

    // 1. Check available providers
    console.log('1. Checking available providers...');
    const availableProviders = VMService.getAvailableProviders();
    console.log('   Available providers:', availableProviders);
    console.log('   EC2 available:', VMProviderFactory.isEC2Available());
    console.log('   Azure available:', VMProviderFactory.isAzureAvailable());
    console.log('');

    // 2. Create a VM service (auto-detect provider)
    console.log('2. Creating VM service with auto-detection...');
    const vmService = new VMService();
    await vmService.initialize();
    console.log('   Provider:', vmService.getProviderName());
    console.log('   Provider type:', vmService.getProviderType());
    console.log('');

    // 3. Check capabilities
    console.log('3. Checking provider capabilities...');
    const capabilities = vmService.getCapabilities();
    console.log('   Spot instances:', capabilities.supportsSpotInstances);
    console.log('   Auto-scaling:', capabilities.supportsAutoScaling);
    console.log('   Load balancing:', capabilities.supportsLoadBalancing);
    console.log('   Custom images:', capabilities.supportsCustomImages);
    console.log('');

    // 4. List existing instances (if any)
    console.log('4. Listing existing instances...');
    const listResult = await vmService.listInstances({
        states: ['running', 'stopped']
    });

    if (listResult.success) {
        console.log(`   Found ${listResult.count} instances:`);
        listResult.instances?.forEach((instance, i) => {
            console.log(`   ${i + 1}. ${instance.id} - ${instance.state} - ${instance.instanceType}`);
            console.log(`      IP: ${instance.publicIpAddress || 'N/A'}`);
        });
    } else {
        console.log('   Error listing instances:', listResult.error);
    }
    console.log('');

    // 5. Example: Create instance (commented out to avoid actually creating)
    console.log('5. Example instance creation (not executed):');
    console.log(`
    const result = await vmService.createInstance({
        imageId: 'ami-0c55b159cbfafe1f0',
        instanceType: 't2.micro',
        keyName: 'my-key-pair',
        securityGroupIds: ['sg-12345678'],
        initialState: 'running',
        tags: [
            { key: 'Name', value: 'TestVM' },
            { key: 'Environment', value: 'dev' }
        ]
    });
    `);
    console.log('');

    // 6. Provider-specific examples
    console.log('6. Provider-specific service creation:');
    console.log('   EC2Service:');
    const ec2Service = VMService.forEC2('us-east-1');
    console.log('   - Created EC2 service for region us-east-1');
    
    console.log('   Azure Service:');
    console.log('   - Would create: VMService.forAzure("eastus")');
    console.log('');

    console.log('=== Test Complete ===');
}

// Run if executed directly
if (require.main === module) {
    main().catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
}

export { main as testVMProvider };
