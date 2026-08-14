# Quick Start Guide - VM Provider Abstraction

## 5-Minute Getting Started

### 1. Basic Usage

```typescript
import { VMService } from './Services/vm-providers';

// Create service (auto-detects EC2 from environment)
const vmService = new VMService();
await vmService.initialize();

// List instances
const result = await vmService.listInstances();
console.log(`Found ${result.count} instances`);

// Create instance
const createResult = await vmService.createInstance({
    imageId: 'ami-0c55b159cbfafe1f0',
    instanceType: 't2.micro',
    keyName: 'my-ssh-key',
    initialState: 'running'
});

// Control instance
await vmService.stopInstance(createResult.instanceId);
await vmService.startInstance(createResult.instanceId);
await vmService.terminateInstance(createResult.instanceId);
```

### 2. Check What's Available

```typescript
import { VMService } from './Services/vm-providers';

// Check available providers
const available = VMService.getAvailableProviders();
// Returns: ['ec2'] or ['ec2', 'azure'] depending on credentials

// Create service
const vmService = new VMService();
console.log('Using provider:', vmService.getProviderName()); // "EC2" or "Azure"
```

### 3. Use Specific Provider

```typescript
// Force EC2
const ec2Service = VMService.forEC2('us-west-2');

// Force Azure (when implemented)
const azureService = VMService.forAzure('eastus');
```

### 4. Environment Variables

For EC2:
```bash
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret
export AWS_REGION=us-east-1
```

For Azure:
```bash
export AZURE_SUBSCRIPTION_ID=your_sub
export AZURE_TENANT_ID=your_tenant
export AZURE_CLIENT_ID=your_client
export AZURE_CLIENT_SECRET=your_secret
```

## Common Operations

### List Instances with Filters

```typescript
// Running instances only
const running = await vmService.listInstances({
    states: ['running']
});

// Filter by tags
const devInstances = await vmService.listInstances({
    tags: [{ key: 'Environment', value: 'dev' }]
});

// Specific instances
const specific = await vmService.listInstances({
    instanceIds: ['i-12345', 'i-67890']
});
```

### Create with Options

```typescript
const result = await vmService.createInstance({
    imageId: 'ami-12345',
    instanceType: 't3.medium',
    keyName: 'my-key',
    
    // Optional settings
    securityGroupIds: ['sg-12345'],
    subnetId: 'subnet-12345',
    volumeSize: 30,  // GB
    volumeType: 'gp3',
    initialState: 'stopped',  // or 'running'
    
    // Tags
    tags: [
        { key: 'Name', value: 'MyServer' },
        { key: 'Environment', value: 'production' }
    ],
    
    // Wait for initialization
    waitForUserData: true,
    userDataTimeout: 600000  // 10 minutes
});
```

### Wait for State

```typescript
// Start instance and wait for it to be running
await vmService.startInstance(instanceId);
await vmService.waitForInstanceState(
    instanceId,
    'running',
    300000,  // 5 minute timeout
    5000     // Check every 5 seconds
);
```

### Get Instance Details

```typescript
// Get full details
const details = await vmService.describeInstance(instanceId);
if (details.success) {
    console.log('Instance:', details.instance);
    console.log('Public IP:', details.instance.publicIpAddress);
    console.log('State:', details.instance.state);
}

// Just get IP
const ipResult = await vmService.getPublicIp(instanceId);
console.log('IP:', ipResult.ipAddress);

// Just get state
const stateResult = await vmService.getInstanceState(instanceId);
console.log('State:', stateResult.state);
```

## Error Handling

```typescript
const result = await vmService.createInstance({...});

if (!result.success) {
    console.error('Error:', result.error);
    return;
}

console.log('Success! Instance ID:', result.instanceId);
console.log('Public IP:', result.ipAddress);
```

## Run the Test

```bash
cd /app/AI_CODER_REMOTE
npx ts-node src/Services/vm-providers/test-vm-provider.ts
```

## Key Differences from EC2Service

| EC2Service | VMService |
|------------|-----------|
| `amiId` | `imageId` |
| `iamInstanceProfile` | `iamRole` |
| `ebsOptimized` | `optimized` |
| `{Key, Value}` tags | `{key, value}` tags |

## Documentation

- **Full guide**: `src/Services/vm-providers/README.md`
- **Implementation details**: `VM_PROVIDER_IMPLEMENTATION.md`
- **Test/example**: `src/Services/vm-providers/test-vm-provider.ts`

## Need Help?

1. Check the README for detailed examples
2. Look at the test file for working code
3. All provider methods have JSDoc comments
4. Check implementation summary for architecture details
