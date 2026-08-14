/**
 * Standard collection names used across all tenant databases
 * This ensures consistency in collection naming across multiple databases
 */
export enum CollectionNames {
    ORGANIZATION = 'Organization',
    ORGANIZATIONS = 'Organizations',  // Collection for storing multiple organizations
    GROUPS = 'Groups',
    USERS = 'Users',
    WORKSPACES = 'Workspaces',
    TASKS = 'Tasks',
    NOTIFICATIONS = 'Notifications',  
    SECRETS = 'Secrets',
    PLANS = 'Plans',
    SYSTEM_PROMPT= 'System_Prompt',
    LLM_METRICS = 'LLM_Metrics',  // Time series collection for LLM usage and cost tracking
    EC2_METRICS = 'EC2_Metrics',  // Time series collection for EC2 usage and cost tracking
    LLM_METRICS_AGGREGATION = 'LLM_Metrics_Aggregation',  // Aggregated LLM metrics by TaskId/wpId
    EC2_METRICS_AGGREGATION = 'EC2_Metrics_Aggregation',  // Aggregated EC2 metrics by TaskId/wpId
    TASK_WORKSPACE_COST_AGGREGATION = 'Task_Workspace_Cost_Aggregation',  // Combined LLM + EC2 costs by TaskId/wpId
    USER_METRICS_AGGREGATION = 'User_Metrics_Aggregation',  // Aggregated user costs from Task_Workspace_Cost_Aggregation grouped by userId
    ORGANIZATION_METRICS_AGGREGATION = 'Organization_Metrics_Aggregation',  // Aggregated organization costs from User_Metrics_Aggregation grouped by organizationId
    SUBSCRIPTION_INFO = "Subscription_Info",
    USER_CONTACT_INFO = 'UserContactInfo',  // Contact form submissions from enterprise inquiries
    AGENT_CONFIGS = 'Agent_Configs',  // Agent YAML configurations
    KNOWLEDGE_BASES = 'Knowledge_Bases',  // Knowledge base metadata
    KNOWLEDGE_BASE_FILES = 'Knowledge_Base_Files',  // Knowledge base file entries
    API_KEYS = 'API_Keys'  // Per-organisation API key records (stores hash, never the raw key)
}
