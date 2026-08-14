import fetch from 'node-fetch';
import { DatabaseService } from '../../DataAccessLayer/DatabaseService';
import { CollectionNames } from '../../DataAccessLayer/models/Collections';
import { UserInfo } from '../../DataStructures';
import { getAtlassianAccessTokenForUser } from '../../socket-handlers/atlassian.handler';
import * as dotenv from 'dotenv';
dotenv.config();
export interface McpExecuteOptions {
  endpoint?: string; 
  session_id?: string;
}

export interface McpResponse<T=any> {
  type: string;
  tools?: any[];
  name?: string;
  output?: T;
  error?: string;
  status_code?: number;
}

interface AtlassianAuth {
  cloudId: string;
  accessToken: string;
}

const DEFAULT_ENDPOINT = `${process.env.MCP_ATLASSIAN_BASE_URL}/mcp`;

async function getAtlassianAuthForUser(userId: string): Promise<AtlassianAuth> {
  if (!userId) {
    throw Object.assign(new Error('User ID is required'), { status_code: 400 });
  }

  const userInfo = UserInfo.get(userId);
  if (!userInfo || !userInfo.organizationId) {
    throw Object.assign(new Error('User organization information not found'), { status_code: 400 });
  }

  const dbService = DatabaseService.getInstance();
  if (!dbService.isConnected()) {
    await dbService.connect(process.env.MONGODB_CONNECTION_STRING_DEV || '');
  }

  const orgRepo = dbService.getRepository<any>(
    process.env.ORGANIZATION_DB!,
    CollectionNames.ORGANIZATIONS
  );

  const organization = await orgRepo.findOne({ OrganizationId: userInfo.organizationId });
  if (!organization) {
    throw Object.assign(new Error('Organization not found'), { status_code: 404 });
  }

  const atlassianMeta = organization.metadata?.atlassian;
  if (!atlassianMeta || !atlassianMeta.tenantId) {
    throw Object.assign(new Error('Atlassian integration not installed'), { status_code: 404 });
  }
  const tokenResult = await getAtlassianAccessTokenForUser(userId);
  if (!tokenResult.success || !tokenResult.accessToken) {
    const err = new Error(tokenResult.message || tokenResult.error || 'Failed to get access token');
    throw Object.assign(err, { status_code: tokenResult.statusCode || 401 });
  }

  return {
    cloudId: atlassianMeta.tenantId,
    accessToken: tokenResult.accessToken
  };
}

export async function listTools(userId: string, opts: McpExecuteOptions = {}){
  try {
    const endpoint = (opts.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '/') ;
    const atlassianAuth = await getAtlassianAuthForUser(userId);
    
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${atlassianAuth.accessToken}`,
        'X-Atlassian-Cloud-Id': atlassianAuth.cloudId
      },
      body: JSON.stringify({ 
        type: 'list_tools', 
        session_id: opts.session_id || ('session-' + Date.now())
      })
    });
    const data = await res.json();
    if(res.status === 200)
    {
      return{tools: data.tools,
        success: true
      }; // outputting the tools
    }
    else{
      return [];
    }
  } catch (e: any) {
    return {
      success: false,
      type: 'error',
      error: e.message || 'AUTH_RESOLUTION_FAILED',
      status_code: e.status_code || 500
    };
  }
}

export async function executeTool<T=any>(name: string, userId: string, parameters: Record<string, any> = {}, opts: McpExecuteOptions = {}): Promise<McpResponse<T>> {
  try {
    const endpoint = (opts.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '/') ;
    const atlassianAuth = await getAtlassianAuthForUser(userId);
    
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${atlassianAuth.accessToken}`,
        'X-Atlassian-Cloud-Id': atlassianAuth.cloudId
      },
      body: JSON.stringify({ 
        type: 'execute_tool', 
        name, 
        parameters, 
        session_id: opts.session_id || ('session-' + Date.now())
      })
    });

    const json = await res.json();
    return json as McpResponse<T>;
  } catch (e: any) {
    return {
      type: 'error',
      error: e.message || 'AUTH_RESOLUTION_FAILED',
      status_code: e.status_code || 500
    } as McpResponse<T>;
  }
}

// Convenience wrappers for common Jira tools
export async function jiraGetIssue(userId: string, issue_key: string, params: Record<string, any> = {}, opts?: McpExecuteOptions) {
  return executeTool('jira_get_issue', userId,  { issue_key, ...params }, opts);
}

export async function jiraSearch(userId: string, jql: string, params: Record<string, any> = {}, opts?: McpExecuteOptions) {
  return executeTool('jira_search', userId, { jql, ...params }, opts);
}

export async function jiraGetProjectIssues(userId: string, project_key: string, params: Record<string, any> = {}, opts?: McpExecuteOptions) {
  return executeTool('jira_get_project_issues', userId, { project_key, ...params }, opts);
}

export async function jiraGetTransitions(userId: string, issue_key: string, opts?: McpExecuteOptions) {
  return executeTool('jira_get_transitions', userId, { issue_key }, opts);
}

export async function jiraGetWorklog(userId: string, issue_key: string, opts?: McpExecuteOptions) {
  return executeTool('jira_get_worklog', userId, { issue_key }, opts);
}

export async function jiraGetAllProjects(userId: string, opts?: McpExecuteOptions) {
  return executeTool('jira_get_all_projects', userId, {}, opts);
}
