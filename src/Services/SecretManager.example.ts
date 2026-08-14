import { SecretManager } from './SecretManager';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';

async function exampleUsage() {
    const dbService = new DatabaseService();
    await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || 'mongodb://localhost:27017');

    const secretManager = new SecretManager(
        dbService,
        'myDatabase',
        'secrets',
        'my-super-secret-encryption-key-32-chars'
    );

    const envSecrets = {
        DATABASE_URL: 'mongodb://localhost:27017/myapp',
        API_KEY: 'sk_test_123456789',
        JWT_SECRET: 'jwt-secret-key',
        AWS_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
        AWS_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    };

    console.log('Creating secret...');
    const createResult = await secretManager.createSecret('production-env', envSecrets);
    console.log('Create result:', createResult);

    console.log('\nGetting secret...');
    const getResult = await secretManager.getSecret('production-env');
    console.log('Get result:', getResult);

    console.log('\nUpdating secret...');
    const updatedSecrets = {
        ...envSecrets,
        NEW_API_ENDPOINT: 'https://api.example.com'
    };
    const updateResult = await secretManager.updateSecret('production-env', updatedSecrets);
    console.log('Update result:', updateResult);

    console.log('\nListing all secrets...');
    const listResult = await secretManager.listSecrets();
    console.log('List result:', listResult);

    console.log('\nChecking if secret exists...');
    const exists = await secretManager.secretExists('production-env');
    console.log('Exists:', exists);

    console.log('\nGetting all secrets...');
    const allSecrets = await secretManager.getAllSecrets();
    console.log('All secrets:', allSecrets);

    console.log('\nUpserting secret...');
    const upsertResult = await secretManager.upsertSecret('staging-env', {
        DATABASE_URL: 'mongodb://localhost:27017/staging',
        API_KEY: 'sk_test_staging'
    });
    console.log('Upsert result:', upsertResult);

    console.log('\nDeleting secret...');
    const deleteResult = await secretManager.deleteSecret('production-env');
    console.log('Delete result:', deleteResult);

    await dbService.disconnect();
}

exampleUsage().catch(console.error);
