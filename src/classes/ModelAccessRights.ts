export enum AccessRights 
{
    ALL,
    WRITE_FILES,
    READ_FILES,
    RAG_TOOLS ,
    GITHUB_TOOLS,
    EXECUTE_COMMAND_TOOL,
    
    SWARM_CHILD_TASK_TOOLS,
    SWARM_SUB_AGENT_TOOLS,
    TAVILY_WEB_SEARCH_TOOL,
    ATLASSIAN_TOOL,
    PLAYWRIGHT_TOOL
}
export const AcccessRightsSubAgent = [AccessRights.READ_FILES,AccessRights.RAG_TOOLS,AccessRights.GITHUB_TOOLS,AccessRights.EXECUTE_COMMAND_TOOL,AccessRights.TAVILY_WEB_SEARCH_TOOL,AccessRights.ATLASSIAN_TOOL,AccessRights.PLAYWRIGHT_TOOL];
export const AccessRightsChildAgent =[AccessRights.READ_FILES,AccessRights.WRITE_FILES,AccessRights.SWARM_SUB_AGENT_TOOLS,AccessRights.RAG_TOOLS,AccessRights.GITHUB_TOOLS,AccessRights.EXECUTE_COMMAND_TOOL,AccessRights.TAVILY_WEB_SEARCH_TOOL,AccessRights.ATLASSIAN_TOOL,AccessRights.PLAYWRIGHT_TOOL];

export const AccessRightsParentAgent = [AccessRights.ALL];