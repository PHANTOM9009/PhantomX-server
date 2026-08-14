# Setting Up Integrations

PhantomX integrates with various third-party platforms to enhance development workflows and team collaboration. This guide covers available integrations and how to configure them.

## Available Integrations

### Currently Supported

The platform currently offers the following integrations:

1. **GitHub** - Version control and code repository management
2. **Jira** - Project management and issue tracking

### Coming Soon

The following integrations are planned for future releases:

3. **Slack** - Team communication and notifications
4. **Linear** - Modern issue tracking and project management
5. **Notion** - Documentation and knowledge management
6. **Microsoft Teams** - Enterprise team collaboration

## GitHub Integration

### Overview

GitHub integration is the foundational integration for PhantomX. It provides essential functionality for repository access, code management, and pull request workflows.

### Why GitHub Is Required

GitHub integration is mandatory for the following reasons:

**Repository Operations:**
- Clone repositories for workspace setup
- Access repository contents
- Create and manage branches
- Read and write code files

**Pull Request Management:**
- Create pull requests automatically
- Update pull request descriptions
- Add reviewers and labels
- Merge approved changes

**Collaboration:**
- Track code changes
- Review modifications
- Maintain version history
- Integrate with team workflows

### Setting Up GitHub Integration

#### Prerequisites

Before setting up GitHub integration:

- GitHub account with appropriate permissions
- Organization admin access (for organization repositories)
- Repository access for target projects

#### Installation Steps

**Step 1: Navigate to Integrations**
1. Log in to PhantomX platform
2. Go to Settings or Integrations section
3. Locate GitHub integration option

**Step 2: Authorize GitHub App**
1. Click "Connect GitHub" or "Install GitHub App"
2. Redirected to GitHub authorization page
3. Review requested permissions
4. Click "Authorize" to grant access

**Step 3: Select Repositories**
1. Choose which repositories to grant access to
2. Options include:
   - All repositories (current and future)
   - Selected repositories only
3. Confirm repository selection

**Step 4: Complete Installation**
1. Redirected back to PhantomX
2. Verify connection status shows as "Connected"
3. Repository list should populate

#### Required Permissions

The GitHub App requests the following permissions:

**Repository Permissions:**
- **Contents**: Read and write access to repository contents
- **Pull Requests**: Create and manage pull requests
- **Issues**: Read and write access to issues
- **Metadata**: Read repository metadata

**Organization Permissions:**
- **Members**: Read organization member information (if applicable)
- **Webhooks**: Receive notifications about repository events

**Why These Permissions Are Needed:**
- **Contents**: Allow agent to read and modify code
- **Pull Requests**: Enable automated PR creation
- **Issues**: Link tasks to GitHub issues
- **Metadata**: Access repository structure and information
- **Webhooks**: Real-time updates on repository changes

### Managing GitHub Integration

#### Adding More Repositories

To grant access to additional repositories:

1. Go to GitHub integration settings
2. Click "Configure" or "Manage repositories"
3. Redirected to GitHub App settings
4. Add or remove repositories
5. Save changes

#### Updating Permissions

If additional permissions are needed:

1. GitHub will prompt when required
2. Review new permission requests
3. Authorize if acceptable
4. Integration updated automatically

#### Disconnecting GitHub

To remove GitHub integration:

**Warning:** This will disable most platform functionality

1. Navigate to integration settings
2. Click "Disconnect" or "Revoke Access"
3. Confirm disconnection
4. GitHub access removed
5. Existing workspaces may become inaccessible

## Jira Integration

### Overview

Jira integration enables seamless connection between project management and development tasks. Link PhantomX tasks directly to Jira issues for better traceability.

### Benefits of Jira Integration

**Issue Tracking:**
- Link tasks to Jira tickets
- Automatic context import from tickets
- Update ticket status on task completion
- Maintain traceability

**Requirements Management:**
- Pull acceptance criteria from Jira
- Include ticket descriptions in task context
- Reference related issues
- Track progress in Jira

**Team Collaboration:**
- Unified view of work items
- Status synchronization
- Comment integration
- Notification coordination

### Setting Up Jira Integration

#### Prerequisites

- Jira account or Jira Cloud instance
- Appropriate Jira permissions
- Admin access to configure integration

#### Installation Steps

**Step 1: Navigate to Integrations**
1. Open PhantomX settings
2. Go to Integrations section
3. Find Jira integration option

**Step 2: Configure Connection**
1. Click "Connect Jira"
2. Choose Jira Cloud or Jira Server
3. Enter Jira instance URL
4. Provide authentication credentials

**Step 3: Authenticate**
1. For Jira Cloud: OAuth authentication
2. For Jira Server: API token or username/password
3. Grant requested permissions
4. Verify connection

**Step 4: Configure Settings**
1. Select Jira projects to access
2. Configure field mappings
3. Set up status synchronization
4. Define update rules

#### Configuration Options

**Project Selection:**
- Choose which Jira projects to integrate
- All projects or specific projects
- Can be updated later

**Field Mapping:**
- Map Jira fields to PhantomX task fields
- Custom field support
- Default mappings provided

**Status Synchronization:**
- Define how statuses sync between systems
- Automatic or manual updates
- Bidirectional or one-way sync

### Using Jira Integration

#### Creating Tasks from Jira Issues

**Process:**
1. Start new task in PhantomX
2. Select "Link Jira Issue"
3. Search for Jira issue by key or title
4. Select issue
5. Task automatically populated with issue details

**Imported Information:**
- Issue title and description
- Acceptance criteria
- Related issues
- Current status
- Assigned user
- Labels and tags

#### Updating Jira from PhantomX

**Automatic Updates:**
- Task completion updates Jira status
- Comments can be synced
- Time tracking integration
- Status transitions

**Manual Updates:**
- Update Jira directly from task interface
- Add comments to issues
- Change status
- Update fields

### Managing Jira Integration

#### Modifying Configuration

To change Jira integration settings:

1. Navigate to integration settings
2. Click "Configure" on Jira integration
3. Modify desired settings
4. Save changes

#### Disconnecting Jira

To remove Jira integration:

1. Go to integration settings
2. Click "Disconnect" on Jira integration
3. Confirm disconnection
4. Integration removed
5. Existing linked tasks maintain reference but lose live sync

## Integration Best Practices

### Security

**Credential Management:**
- Use secure authentication methods
- Rotate credentials regularly
- Limit access to necessary permissions only
- Monitor integration usage

**Access Control:**
- Grant minimum required permissions
- Review integration access periodically
- Revoke unused integrations
- Audit integration activities

### Performance

**Efficient Usage:**
- Configure only needed integrations
- Select specific repositories/projects rather than all
- Optimize webhook configurations
- Monitor API rate limits

### Maintenance

**Regular Reviews:**
- Verify integrations function correctly
- Update configurations as needed
- Remove unused integrations
- Check for new features or updates

**Documentation:**
- Document integration purposes
- Note configuration choices
- Maintain troubleshooting guides
- Keep team informed of changes

## Troubleshooting

### GitHub Integration Issues

**Problem:** Repositories not appearing

**Solutions:**
- Verify GitHub App is installed
- Check repository permissions
- Refresh integration
- Reinstall GitHub App if needed

**Problem:** Cannot create pull requests

**Solutions:**
- Verify write permissions granted
- Check branch protection rules
- Confirm repository access
- Review GitHub App permissions

### Jira Integration Issues

**Problem:** Cannot find Jira issues

**Solutions:**
- Verify Jira connection is active
- Check project access permissions
- Confirm issue exists and is accessible
- Refresh Jira integration

**Problem:** Status updates not syncing

**Solutions:**
- Verify status mapping configuration
- Check webhook configuration
- Confirm network connectivity
- Review synchronization logs

### General Integration Issues

**Problem:** Integration shows as disconnected

**Solutions:**
- Check authentication credentials
- Verify service is accessible
- Reconnect integration
- Contact support if persists

**Problem:** Slow integration performance

**Solutions:**
- Check network connectivity
- Verify third-party service status
- Review rate limiting
- Optimize integration configuration

## Future Integrations

### Slack Integration (Coming Soon)

**Planned Features:**
- Task notifications
- Status updates
- Team alerts
- Bot commands

### Linear Integration (Coming Soon)

**Planned Features:**
- Issue linking
- Status synchronization
- Team workflows
- Project management

### Notion Integration (Coming Soon)

**Planned Features:**
- Documentation sync
- Knowledge base integration
- Note taking
- Team wikis

### Microsoft Teams Integration (Coming Soon)

**Planned Features:**
- Team notifications
- Status updates
- Channel integrations
- Enterprise features

## Conclusion

Proper integration setup enhances the PhantomX experience by connecting your existing tools and workflows. While GitHub integration is essential, additional integrations like Jira provide valuable enhancements to project management and team collaboration. Configure integrations carefully to balance functionality with security and performance considerations.
