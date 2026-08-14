# Tasks

Tasks are individual work units where Phantom completes specific development objectives in isolated environments.

## Overview

- Tasks are private to the user who creates them
- Each task operates in its own isolated environment
- Created from shared or private workspaces
- Multiple users can work simultaneously from the same workspace

## Working Modes

**Interactive Mode:**
- Real-time code editor access
- Live terminal interface
- Direct collaboration with agent
- Immediate feedback

**Background Mode:**
- Runs autonomously while minimized
- No active supervision required
- Notifications upon completion
- Resume interactive mode anytime

## Task Creation

**Starting a Task:**
1. Select a workspace
2. Choose branch to create task branch from
3. Provide task description or ticket reference
4. Specify working mode
5. Start task

**Branch Creation:**
- New branch automatically created from workspace origin branch
- Named according to task identifier
- Task will not start if branch already exists
- Branch cannot be changed once created

## Task Interface

**Code Editor:**
- Syntax highlighting
- File navigation and search
- Multi-file editing
- Diff view for modifications

**Terminal:**
- Direct command execution
- Package installation
- Script running
- Log viewing

**Custom Modifications:**
- Edit files directly
- Run custom commands
- Install additional dependencies
- Test changes manually

## Task Lifecycle

**Active Development:**
- AI agent works on objectives
- Changes made to task branch
- Progress tracked and logged
- Status updates provided

**Minimized Operation:**
- Continues in background
- Resources managed efficiently
- Progress saved automatically

**Completion:**
- Summary of changes
- List of modified files
- Test results
- Option to raise pull request

## Usage Patterns

**One-Time Tasks (Recommended):**
- Implementing specific features
- Fixing individual bugs
- Addressing Jira tickets
- Small to medium changes

Workflow: Create task → Complete work → Review → Raise PR → Discard task

**Extended Tasks:**
- Create task on main/development branch
- Work iteratively without discarding
- Make multiple rounds of changes
- Accumulate related changes

## Integration

**Jira Integration:**
- Link tasks to Jira tickets
- Automatically fetch ticket details
- Update status on completion

**Pull Request Workflow:**
- AI can generate PR with description
- Manual PR creation via GitHub section
- Automatic change summary

## Best Practices

**Task Scope:**
- Keep focused on specific objectives
- Avoid overly broad definitions
- Break large features into multiple tasks

**Task Descriptions:**
- State objective clearly
- Include acceptance criteria
- Reference documentation
- Specify constraints

**Resource Management:**
- Minimize active tasks
- Use background mode for long operations
- Discard completed tasks promptly

## Troubleshooting

**Task Won't Start:**
- Branch already exists - delete or rename existing branch
- Verify workspace setup
- Check permissions

**Agent Not Progressing:**
- Provide more detailed requirements
- Check configurations
- Review agent logs
