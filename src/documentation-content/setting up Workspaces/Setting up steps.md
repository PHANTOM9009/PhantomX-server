# Workspace Setup Guide

Step-by-step instructions for creating and configuring a workspace in PhantomX.

## Prerequisites

- Completed organization setup
- Configured GitHub integration
- Created secrets (optional)
- Prepared system prompts (optional)

## Step 1: Repository Configuration

### Selecting Repository

1. Navigate to workspace creation
2. Select repository from dropdown
3. Only authorized repositories appear

### Selecting Origin Branch

Base branch from which all task branches are created.

Common choices: Development, Main/Master, Release, Staging

All tasks from this workspace create branches from this origin branch.

### Multi-Repository (Optional)

Add up to two repositories for frontend/backend, microservices, etc.

1. Complete first repository
2. Select "Add Another Repository"
3. Repeat process

## Step 2: Secret Selection

Secrets (API keys, database strings, credentials) stored in encrypted vault.

**Process:**
1. View available secrets (based on permissions)
2. Select one or more
3. Selected secrets set in .env file

Multiple selections combine into .env with unique keys.

**Skip if:** Project doesn't require secrets or will add manually later.

**Note:** Docker environment setup happens here (may take several minutes).

## Step 3: Command Verification

All commands optional but recommended for efficiency.

### Install Dependencies

Command to install project dependencies.

Examples: `npm install`, `pip install -r requirements.txt`, `mvn clean install -DskipTests`

Benefits: Automatic installation, consistent setup, reduced errors.

### Run Tests

Command to execute test suite.

Examples: `npm test`, `pytest`, `mvn test`, `go test ./...`

Benefits: Automated testing, early regression detection.

### Start Local Project

Command to start project locally.

Examples: `npm run dev`, `python manage.py runserver`, `docker-compose up`

Considerations: Ensure ports available, external services running.

Benefits: Real-time debugging, end-to-end verification.

### Skipping Commands

Skip if commands are complex, prefer manual setup, or still determining optimal commands.

Implications: Phantom discovers commands (more time/tokens).

## Step 4: System Prompt Selection

Select prompts to guide Phantom's behavior.

**Prompts provide:** Coding style, organization rules, PR formats, testing requirements.

**Process:**
1. View accessible prompts (org/team/personal)
2. Select one or multiple
3. Merged into AGENTS.md and CLAUDE.md

**Skip if:** No guidelines needed or using defaults.

## Step 5: Review and Creation

**Before creating:**
- Verify repository/branch selections
- Confirm secrets selected
- Check commands verified
- Review prompts

**Create:**
1. Click "Create Workspace"
2. System finalizes configuration
3. Workspace ready for use

## Best Practices

**Commands:** Test thoroughly, use fastest reliable commands, avoid interactive prompts.

**Secrets:** Select only necessary, verify values current, use least-privilege.

**Prompts:** Be specific, include examples, update regularly.

**Documentation:** Add description, note requirements, document purposes.

## Troubleshooting

**Repository Not Appearing:** Verify GitHub App installation, check permissions, refresh integration.

**Command Failures:** Check syntax, verify prerequisites, test manually.

**Secret Issues:** Verify permissions, check sharing settings, request access.

**Setup Delays:** Check network, verify Docker status, contact support if persists.
