import { SecretManager } from './SecretManager';
import { DatabaseService } from '../DataAccessLayer/DatabaseService';

async function testSecretManager() {
    console.log('Starting SecretManager tests...\n');

    const dbService = new DatabaseService();
    await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || 'mongodb://localhost:27017');

    const testDbName = 'test_secrets_db';
    const testCollectionName = 'test_secrets_collection';
    const testEncryptionKey = 'test-encryption-key-for-testing-only';

    const secretManager = new SecretManager(
        dbService,
        testDbName,
        testCollectionName,
        testEncryptionKey
    );

    try {
        console.log('Test 1: Create a secret');
        const testSecret = {
            username: 'admin',
            password: 'super-secret-password',
            api_key: 'sk_test_123456789',
            nested: {
                value: 'nested-value',
                array: [1, 2, 3]
            }
        };
        const createResult = await secretManager.createSecret('test-secret-1', testSecret);
        console.log('Create result:', createResult);
        console.assert(createResult.success === true, 'Create should succeed');

        console.log('\nTest 2: Get the secret');
        const getResult = await secretManager.getSecret('test-secret-1');
        console.log('Get result:', getResult);
        console.assert(getResult.success === true, 'Get should succeed');
        console.assert(JSON.stringify(getResult.data) === JSON.stringify(testSecret), 'Data should match');

        console.log('\nTest 3: Update the secret');
        const updatedSecret = { ...testSecret, password: 'new-password' };
        const updateResult = await secretManager.updateSecret('test-secret-1', updatedSecret);
        console.log('Update result:', updateResult);
        console.assert(updateResult.success === true, 'Update should succeed');

        console.log('\nTest 4: Verify update');
        const getUpdatedResult = await secretManager.getSecret('test-secret-1');
        console.log('Get updated result:', getUpdatedResult);
        console.assert(getUpdatedResult.data.password === 'new-password', 'Password should be updated');

        console.log('\nTest 5: List secrets');
        const listResult = await secretManager.listSecrets();
        console.log('List result:', listResult);
        console.assert(listResult.success === true, 'List should succeed');
        console.assert(listResult.keys?.includes('test-secret-1'), 'Should include test-secret-1');

        console.log('\nTest 6: Check existence');
        const exists = await secretManager.secretExists('test-secret-1');
        console.log('Exists:', exists);
        console.assert(exists === true, 'Secret should exist');

        console.log('\nTest 7: Upsert new secret');
        const upsertResult = await secretManager.upsertSecret('test-secret-2', { value: 'test' });
        console.log('Upsert new result:', upsertResult);
        console.assert(upsertResult.success === true, 'Upsert new should succeed');

        console.log('\nTest 8: Upsert existing secret');
        const upsertExistingResult = await secretManager.upsertSecret('test-secret-2', { value: 'updated' });
        console.log('Upsert existing result:', upsertExistingResult);
        console.assert(upsertExistingResult.success === true, 'Upsert existing should succeed');

        console.log('\nTest 9: Get all secrets');
        const allSecretsResult = await secretManager.getAllSecrets();
        console.log('All secrets result:', allSecretsResult);
        console.assert(allSecretsResult.success === true, 'Get all should succeed');
        console.assert(allSecretsResult.secrets?.length === 2, 'Should have 2 secrets');

        console.log('\nTest 10: Delete a secret');
        const deleteResult = await secretManager.deleteSecret('test-secret-1');
        console.log('Delete result:', deleteResult);
        console.assert(deleteResult.success === true, 'Delete should succeed');

        console.log('\nTest 11: Verify deletion');
        const getDeletedResult = await secretManager.getSecret('test-secret-1');
        console.log('Get deleted result:', getDeletedResult);
        console.assert(getDeletedResult.success === false, 'Should not find deleted secret');

        console.log('\nTest 12: Try to create duplicate');
        const duplicateResult = await secretManager.createSecret('test-secret-2', { value: 'duplicate' });
        console.log('Duplicate result:', duplicateResult);
        console.assert(duplicateResult.success === false, 'Should not create duplicate');

        console.log('\n--- Cleanup ---');
        await secretManager.deleteSecret('test-secret-2');
        await dbService.dropCollection(testDbName, testCollectionName);
        
        console.log('\n✅ All tests passed!');
    } catch (error) {
        console.error('\n❌ Test failed:', error);
    } finally {
        await dbService.disconnect();
    }
}

testSecretManager().catch(console.error);
