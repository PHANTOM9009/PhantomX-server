/**
 * CLI script to mint an API key for a user.
 *
 * Usage:
 *   ts-node src/scripts/mintApiKey_tempAI.ts <userId> <userDbName> [label]
 *
 * Arguments:
 *   userId      - The user's unique identifier
 *   userDbName  - The organisation's MongoDB database name (IUserCredentials.databaseName)
 *   label       - (optional) Human-readable label for the key, default: "API Key"
 *
 * The key is minted with NO expiry (never expires).
 *
 * Example:
 *   ts-node src/scripts/mintApiKey_tempAI.ts user_abc123 org_phantomx_db "CI pipeline key"
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { mintApiKey } from '../Services/UserManagmentService';

async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.error('\n❌  Usage: ts-node src/scripts/mintApiKey_tempAI.ts <userId> <userDbName> [label]\n');
        console.error("  userId      — the user's unique identifier");
        console.error('  userDbName  — the organisation\'s MongoDB database name');
        console.error('  label       — (optional) human-readable key label, default: "API Key"\n');
        process.exit(1);
    }

    const userId     = args[0];
    const userDbName = args[1];
    const label      = args[2] ?? 'API Key';

    console.log('\n⏳  Minting API key...');
    console.log(`   userId      : ${userId}`);
    console.log(`   userDbName  : ${userDbName}`);
    console.log(`   label       : ${label}`);
    console.log(`   expiresIn   : never\n`);

    const result = await mintApiKey(userId, userDbName, null, label);

    if (!result.success || !result.rawKey) {
        console.error(`\n❌  Failed to mint API key: ${result.error}\n`);
        process.exit(1);
    }

    console.log('✅  API key minted successfully!\n');
    console.log('┌─────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│  ⚠️   Copy this key now — it will NEVER be shown again                           │');
    console.log('├─────────────────────────────────────────────────────────────────────────────────┤');
    console.log(`│  Key : ${result.rawKey}  │`);
    console.log('└─────────────────────────────────────────────────────────────────────────────────┘\n');

    process.exit(0);
}

main().catch((err) => {
    console.error('\n❌  Unexpected error:', err);
    process.exit(1);
});
