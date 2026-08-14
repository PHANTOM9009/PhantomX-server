# VM Provider Abstraction Layer

This module provides a unified interface for managing virtual machines across different cloud providers (EC2, Azure, GCP, etc.).

## Architecture

The VM provider abstraction follows the same pattern as the LLM provider abstraction:

```
VMProvider (abstract interface)
├── EC2VMProvider (wraps existing EC2Service)
├── AzureVMProvider (Azure VM implementation)
└── [Future: GCPVMProvider]

VMProviderFactory (creates provider instances)
VMService (high-level unified service)
```

## Usage Examples

### 1. Using VMService (Recommended)

The `VMService` class provides the simplest interface:

```typescript
import { VMService } from './Services/vm-providers';

// Auto-detect provider from environment
const vmService = new VMService();
await vmService.initialize();

// Create an instance
const result = await vmService.createInstance({
    imageId: 'ami-0c55b159cbfafe1f0',
    instanceType: 't2.micro',
    keyName: 'my-key-pair',
    securityGroupIds: ['sg-12345678'],
    initialState: 'running',
    tags: [
        { key: 'Name', value: 'MyVM' },
        { key: 'Environment', value: 'dev' }
    ]
});

if (result.success) {
    console.log(`Instance created: ${result.instanceId}`);
    console.log(`Public IP: ${result.ipAddress}`);
}

// List instances
const listResult = await vmService.listInstances({
    states: ['running'],
    tags: [{ key: 'Environment', value: 'dev' }]
});

// Stop instance
await vmService.stopInstance(result.instanceId!);

// Start instance
await vmService.startInstance(result.instanceId!);

// Terminate instance
await vmService.terminateInstance(result.instanceId!);
```

### 2. Using Specific Provider

```typescript
import { VMService, VMProviderType } from './Services/vm-providers';

// Explicitly use EC2
const ec2Service = VMService.forEC2('us-east-1');
await ec2Service.initialize();

// Or Azure
const azureService = VMService.forAzure('eastus');
await azureService.initialize();
```

### 3. Using VMProviderFactory

```typescript
import { VMProviderFactory, VMProviderType } from './Services/vm-providers';

// Create EC2 provider
const provider = VMProviderFactory.createEC2Provider('us-west-2');
await provider.initialize();

// Create Azure provider
const azureProvider = VMProviderFactory.createAzureProvider('eastus');
await azureProvider.initialize();

// Auto-detect provider
const autoProvider = VMProviderFactory.createProvider();
```

### 4. Direct Provider Usage

```typescript
import { EC2VMProvider, VMProviderConfig } from './Services/vm-providers';

const config: VMProviderConfig = {
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
};

const provider = new EC2VMProvider(config);
await provider.initialize();

const result = await provider.createInstance({
    imageId: 'ami-12345',
    instanceType: 't2.micro',
    keyName: 'my-key'
});
```

## Environment Variables

### For EC2 (AWS)
```bash
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
VM_PROVIDER=ec2  # Optional: explicitly set provider
```

### For Azure
```bash
AZURE_SUBSCRIPTION_ID=your_subscription_id
AZURE_TENANT_ID=your_tenant_id
AZURE_CLIENT_ID=your_client_id
AZURE_CLIENT_SECRET=your_client_secret
AZURE_LOCATION=eastus
VM_PROVIDER=azure  # Optional: explicitly set provider
```

## Provider Auto-Detection

The factory automatically detects the provider based on:
1. `VM_PROVIDER` or `CLOUD_PROVIDER` environment variable
2. Available credentials (checks AWS and Azure credentials)
3. Defaults to EC2 if no explicit configuration

## Configuration Options

### VMInstanceConfig

```typescript
interface VMInstanceConfig {
    imageId: string;                    // Required: AMI ID (EC2) or Image ID (Azure)
    instanceType: string;               // Required: t2.micro (EC2) or Standard_B1s (Azure)
    keyName: string;                    // Required: SSH key name
    securityGroupIds?: string[];        // Security groups
    subnetId?: string;                  // Subnet ID
    userData?: string;                  // Initialization script
    tags?: { key: string; value: string }[];
    initialState?: 'running' | 'stopped';
    volumeSize?: number;                // Root volume size in GB
    volumeType?: string;                // Volume type
    waitForUserData?: boolean;          // Wait for init script
    userDataTimeout?: number;           // Timeout in ms
    // ... other options
}
```

## Migration from EC2Service

If you're currently using `EC2Service` directly, migration is simple:

### Before:
```typescript
import { EC2Service } from './Services/EC2Service';

const ec2 = new EC2Service('us-east-1');
const result = await ec2.createInstance({
    amiId: 'ami-12345',
    instanceType: 't2.micro',
    keyName: 'my-key'
});
```

### After:
```typescript
import { VMService } from './Services/vm-providers';

const vmService = VMService.forEC2('us-east-1');
await vmService.initialize();

const result = await vmService.createInstance({
    imageId: 'ami-12345',  // Note: amiId -> imageId
    instanceType: 't2.micro',
    keyName: 'my-key'
});
```

**Key differences:**
- `amiId` → `imageId`
- `iamInstanceProfile` → `iamRole`
- `ebsOptimized` → `optimized`
- Tags use `{key, value}` instead of `{Key, Value}`

## Azure Implementation Status

The Azure VM provider currently has stub implementations with clear TODO markers. To complete the Azure integration:

1. Install Azure SDK: `npm install @azure/arm-compute @azure/identity`
2. Implement methods in `AzureVMProvider.ts` following the TODO comments
3. Update tests

## Testing

```typescript
// Check available providers
const available = VMService.getAvailableProviders();
console.log('Available providers:', available);

// Get provider capabilities
const vmService = new VMService();
const caps = vmService.getCapabilities();
console.log('Capabilities:', caps);
```

## Benefits

1. **Provider Independence**: Switch between cloud providers without changing application code
2. **Consistent Interface**: Same methods work across all providers
3. **Easy Testing**: Mock providers for testing
4. **Future-Proof**: Add new providers without breaking existing code
5. **Type Safety**: Full TypeScript support with proper typing

## Future Enhancements

- Google Cloud Platform (GCP) provider
- Spot instance support
- Auto-scaling integration
- Load balancer management
- Custom image management
