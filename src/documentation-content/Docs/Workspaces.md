# Workspaces

Workspaces are reusable environment configurations that define complete setup for AI-assisted development tasks.

## Overview

A workspace captures all necessary settings, credentials, repositories, and commands required for consistent development environments. Once configured, workspaces can be shared across your organization.

## Workspace Components

### Environment Configuration
- Repository configurations
- Branch specifications
- Environment variables and secrets
- System prompts and coding guidelines
- Dependency installation commands
- Test execution commands
- Local server startup commands

### Repository Settings
- Include one or two repositories
- Define base branch for task creation
- All tasks use this origin branch
- Access permissions configuration

### Secrets Management
- Choose from organization-accessible secrets
- Select multiple secret sets
- Automatically populated in .env files
- Available to all tasks

### System Prompts
- Organization-wide coding standards
- Project-specific conventions
- Code style requirements
- Automatically converted to AGENTS.md and CLAUDE.md files
- Multiple prompts can be combined

### Command Configuration

**Dependency Installation:**
- Install project dependencies (npm install, pip install, etc.)
- Verified before saving
- Re-executed for each new task

**Test Execution:**
- Run project test suites
- Framework-specific configurations
- Used for automated verification

**Local Server Startup:**
- Start development servers
- Port configurations
- Used for debugging and testing

## Creating a Workspace

**Workflow:**
1. Repository configuration
2. Secret selection
3. Environment setup
4. Command verification
5. System prompt selection
6. Final review and creation

**Naming:**
- Use descriptive, meaningful names
- Include project or feature identifiers
- Make purpose clear

## Workspace Sharing

**Shared Workspaces:**
- Consistent environments for team
- Reduced setup time
- Standardized configurations
- Set visibility (private or shared)

**Private Workspaces:**
- Experimental configurations
- Personal preferences
- Testing new setups

## Using Workspaces

**Starting a Task:**
1. Select workspace
2. Provide task description
3. Review inherited configuration
4. Start task

**What Happens:**
- New branch created from origin branch
- Repository cloned
- Secrets set in .env files
- Dependencies installed
- System prompts applied

**Configuration Overrides:**
Tasks inherit all workspace settings. Some can be modified:
- Additional environment variables
- Runtime command execution
- Temporary configuration changes

Immutable in tasks:
- Repository and branch selection
- Core workspace configuration
- Shared system prompts

## Command Verification

**Benefits:**
- Reduced setup time
- Fewer initialization errors
- Consistent environment preparation
- Saved tokens and resources

**Examples:**

Dependency Installation:
```
npm install
pip install -r requirements.txt
mvn clean install
```

Test Commands:
```
npm test
pytest
mvn test
```

Server Commands:
```
npm run dev
python manage.py runserver
docker-compose up
```

## Multi-Repository Workspaces

- Support up to two repositories
- Each independently configured
- Separate origin branches
- Coordinated secret access
- Both repositories available in task environment

## Best Practices

**Command Optimization:**
- Test commands thoroughly
- Use specific versions where needed
- Keep commands simple

**Secret Management:**
- Include only necessary secrets
- Use least-privilege access
- Rotate regularly

**System Prompt Design:**
- Be specific and clear
- Include examples
- Update as standards evolve

**Regular Maintenance:**
- Update commands periodically
- Verify secrets are current
- Remove deprecated configurations

## Troubleshooting

**Workspace Creation Failures:**
- Verify repository permissions
- Check secret configurations
- Review command syntax

**Task Initialization Problems:**
- Verify command correctness
- Check secret values
- Ensure branch doesn't exist
