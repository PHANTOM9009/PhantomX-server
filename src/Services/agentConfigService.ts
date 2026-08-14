import * as ds from './../DataStructures';
import { S3Service } from './S3Service';
import { Logger } from '../utils/Logger';
import { getDBService } from '../DataAccessLayer/db-connection';
import * as dotenv from 'dotenv';
import { CollectionNames } from '../DataAccessLayer/models';
import { IAgentConfig } from '../DataAccessLayer/models/agentConfig';
import { v4 as uuid4 } from 'uuid';
dotenv.config();

export class AgentConfigService {
    static logger = new Logger('AgentConfigService');

    static async createAgent(
        yamlContent: string,
        userId: string,
        name: string,
        permissionScopes: Record<string, any>,
        metadata: {
            role?: string;
            description?: string;
            parentAgentId?: string | null;
            type: 'single' | 'multi';
            model?: string;
            tools?: string[];
            status?: 'active' | 'inactive' | 'draft';
        }
    ) {
        try {
            let s3Service = new S3Service(process.env.AGENT_CONFIG_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                this.logger.error('userData not found for creating agent config');
                return { success: false, error: 'user not found' };
            }

            const agentId = uuid4();
            const path = `${userData.organizationName}/agents/${agentId}.yaml`;
            
            let result = await s3Service.uploadFile(path, yamlContent, undefined, 'application/x-yaml');
            if (!result.success) {
                this.logger.error('agent config upload failed in s3 bucket');
                return { success: false, error: 'Failed to upload to S3' };
            }
            this.logger.success('Agent config upload succeeded in s3 bucket');

            // Update MongoDB
            let dbService = await getDBService();
            await dbService.ensureCollection(userData.dbName, CollectionNames.AGENT_CONFIGS);
            let agentHandler = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);

            const now = new Date();
            let val: Partial<IAgentConfig> = {
                agentId: agentId,
                name: name,
                role: metadata.role,
                description: metadata.description,
                parentAgentId: metadata.parentAgentId || null,
                filePath: path,
                permissionScopes: permissionScopes,
                createdBy: userId,
                createdAt: now,
                updatedAt: now,
                version: 1,
                type: metadata.type,
                model: metadata.model,
                tools: metadata.tools,
                status: metadata.status || 'draft'
            };

            let result1 = await agentHandler.insertOne(val as any);
            if (result1.acknowledged) {
                this.logger.success('agent config metadata is added in mongodb');
                return { success: true, agentId: agentId };
            } else {
                this.logger.error('failed to add agent metadata to mongodb');
                return { success: false, error: 'Database insert failed' };
            }
        } catch (ex) {
            this.logger.error('error while creating agent config', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    static async editAgent(
        agentId: string,
        userId: string,
        yamlContent?: string,
        permissionScopes?: Record<string, any>,
        metadata?: {
            name?: string;
            role?: string;
            description?: string;
            parentAgentId?: string | null;
            type?: 'single' | 'multi';
            model?: string;
            tools?: string[];
            status?: 'active' | 'inactive' | 'draft';
        }
    ) {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                this.logger.error('userData not found for editing agent');
                return { success: false, error: 'user not found' };
            }

            let handler = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);
            const agentData: any = await handler.findOne({ agentId: agentId });
            
            if (!agentData) {
                return { success: false, error: 'Agent not found' };
            }

            // Update YAML in S3 if provided
            if (yamlContent) {
                let s3Service = new S3Service(process.env.AGENT_CONFIG_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
                await s3Service.deleteFile(agentData.filePath);
                await s3Service.uploadFile(agentData.filePath, yamlContent, undefined, 'application/x-yaml');
            }

            // Update MongoDB metadata
            const updateFields: any = { 
                updatedAt: new Date(),
                version: (agentData.version || 1) + 1
            };
            
            if (permissionScopes) updateFields.permissionScopes = permissionScopes;
            if (metadata?.name) updateFields.name = metadata.name;
            if (metadata?.role) updateFields.role = metadata.role;
            if (metadata?.description) updateFields.description = metadata.description;
            if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'parentAgentId')) {
                updateFields.parentAgentId = metadata.parentAgentId ?? null;
            }
            if (metadata?.type) updateFields.type = metadata.type;
            if (metadata?.model) updateFields.model = metadata.model;
            if (metadata?.tools) updateFields.tools = metadata.tools;
            if (metadata?.status) updateFields.status = metadata.status;

            await handler.updateOne(
                { agentId: agentId },
                { $set: updateFields }
            );

            return { success: true };
        } catch (ex) {
            this.logger.error('error while editing agent', ex);
            return { success: false, error: 'Internal error' };
        }
    }

    static async getAgent(agentId: string, userId: string) {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                this.logger.error('userData not found for getAgent');
                return { success: false, error: 'user not found' };
            }

            let handler = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);
            const data: any = await handler.findOne({ agentId: agentId });
            if (!data) {
                this.logger.error(`agent config metadata not found for ${agentId}`);
                return { success: false, error: 'agent not found' };
            }

            const s3Service = new S3Service(process.env.AGENT_CONFIG_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            const fileResult = await s3Service.getFile(data.filePath, undefined, true);
            if (!fileResult.success || !fileResult.data) {
                this.logger.error(`failed to retrieve agent file from s3: ${fileResult.error}`);
                return { success: false, error: fileResult.error || 'failed to get agent file' };
            }

            let yamlContent: string;
            if (Buffer.isBuffer(fileResult.data)) {
                yamlContent = (fileResult.data as Buffer).toString('utf-8');
            } else {
                const chunks: Buffer[] = [];
                for await (const chunk of (fileResult.data as any)) {
                    chunks.push(Buffer.from(chunk));
                }
                yamlContent = Buffer.concat(chunks).toString('utf-8');
            }

            const agentObject = {
                _id: data._id,
                agentId: data.agentId,
                name: data.name,
                role: data.role,
                description: data.description,
                parentAgentId: data.parentAgentId,
                yamlContent: yamlContent,
                permissionScopes: data.permissionScopes,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                createdBy: data.createdBy,
                filePath: data.filePath,
                version: data.version,
                type: data.type,
                model: data.model,
                tools: data.tools,
                status: data.status
            };

            return { success: true, agent: agentObject };
        } catch (err: any) {
            this.logger.error('error in getAgent', err);
            return { success: false, error: err.message || 'unknown error' };
        }
    }

    static async deleteAgent(agentId: string, userId: string) {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                this.logger.error('userData not found for deleteAgent');
                return { success: false, error: 'user not found' };
            }

            let handler = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);
            const data: any = await handler.findOne({ agentId: agentId });
            if (!data) {
                this.logger.error(`agent config metadata not found for deletion: ${agentId}`);
                return { success: false, error: 'agent not found' };
            }

            // Delete from S3
            const s3Service = new S3Service(process.env.AGENT_CONFIG_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
            const deleteResult = await s3Service.deleteFile(data.filePath);
            if (!deleteResult.success) {
                this.logger.error(`failed to delete agent file from s3: ${deleteResult.error}`);
                return { success: false, error: deleteResult.error || 'failed to delete s3 file' };
            }

            // Delete from MongoDB
            const delDbRes = await handler.deleteOne({ agentId: agentId });
            if (delDbRes.deletedCount && delDbRes.deletedCount > 0) {
                this.logger.success(`agent config ${agentId} deleted from db and s3`);
                return { success: true };
            } else {
                this.logger.error(`failed to delete agent config metadata for ${agentId}`);
                return { success: false, error: 'failed to delete metadata' };
            }
        } catch (err: any) {
            this.logger.error('error in deleteAgent', err);
            return { success: false, error: err.message || 'unknown error' };
        }
    }

    static async getAllAgents(permissionScopeIds: string[], userId: string): Promise<{ success: boolean; agents?: Array<any>; error?: string }> {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                this.logger.error('userData not found for getAllAgents');
                return { success: false, error: 'user not found' };
            }

            await dbService.ensureCollection(userData.dbName, CollectionNames.AGENT_CONFIGS);
            let handler = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);
            
            const filter: any = {};
            if (permissionScopeIds && permissionScopeIds.length > 0) {
                filter.$or = permissionScopeIds.map(id => ({
                    [`permissionScopes.${id}`]: { $exists: true }
                }));
            }

            const agentsByGroups = await handler.find(filter);
            const agentsCreatedByUser = await handler.find({ createdBy: userId });
            
            const combined = [...agentsByGroups, ...agentsCreatedByUser];
            const agentDocs = Array.from(
                new Map(combined.map(item => [item._id.toString(), item])).values()
            );

            if (!agentDocs || agentDocs.length === 0) {
                return { success: true, agents: [] };
            }

            const agents = agentDocs.map(doc => ({
                agentId: doc.agentId,
                name: doc.name,
                role: doc.role,
                description: doc.description,
                parentAgentId: doc.parentAgentId,
                permissionScopes: doc.permissionScopes || {},
                type: doc.type,
                model: doc.model,
                tools: doc.tools,
                status: doc.status,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt,
                version: doc.version
            }));

            return { success: true, agents };
        } catch (error: any) {
            this.logger.error('Error getting all agents', error);
            return { 
                success: false, 
                error: error.message || 'unknown error' 
            };
        }
    }

    private static extractYamlScalar(rawLine: string): string {
        const value = rawLine.split(':').slice(1).join(':').trim();
        if (value.startsWith('"') && value.endsWith('"')) {
            return value.slice(1, -1).replace(/\\"/g, '"');
        }
        return value;
    }

    private static async getYamlContentFromS3(filePath: string): Promise<string | null> {
        const s3Service = new S3Service(process.env.AGENT_CONFIG_BUCKET || process.env.SYSTEM_PROMPT_BUCKET);
        const fileResult = await s3Service.getFile(filePath, undefined, true);
        if (!fileResult.success || !fileResult.data) {
            return null;
        }

        if (Buffer.isBuffer(fileResult.data)) {
            return (fileResult.data as Buffer).toString('utf-8');
        }

        const chunks: Buffer[] = [];
        for await (const chunk of (fileResult.data as any)) {
            chunks.push(Buffer.from(chunk));
        }

        return Buffer.concat(chunks).toString('utf-8');
    }

    private static async buildSyntheticTreeFromMultiYaml(rootAgent: any): Promise<{ tree: any; agents: Array<any> } | null> {
        const yamlContent = await this.getYamlContentFromS3(rootAgent.filePath);
        if (!yamlContent || !yamlContent.includes('orchestration:')) {
            return null;
        }

        const lines = yamlContent.split('\n');
        const nodes: Array<any> = [];
        const edges: Array<{ from: string; to: string }> = [];

        let section: 'nodes' | 'edges' | null = null;
        let currentNode: any = null;
        let currentEdgeFrom: string | null = null;

        const flushNode = () => {
            if (!currentNode) return;
            currentNode.name = currentNode.name || currentNode.agentId;
            currentNode.description = currentNode.description || '';
            currentNode.role = currentNode.description || currentNode.role || '';
            currentNode.type = 'single';
            currentNode.status = 'active';
            currentNode.createdAt = rootAgent.createdAt;
            currentNode.updatedAt = rootAgent.updatedAt;
            currentNode.version = 1;
            nodes.push(currentNode);
            currentNode = null;
        };

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed === 'nodes:') {
                flushNode();
                section = 'nodes';
                continue;
            }

            if (trimmed === 'edges:') {
                flushNode();
                section = 'edges';
                continue;
            }

            if (section === 'nodes') {
                const nodeStartMatch = trimmed.match(/^- id:\s*"([^"]+)"$/) || trimmed.match(/^- id:\s*([^\s]+)$/);
                if (nodeStartMatch) {
                    flushNode();
                    currentNode = {
                        agentId: nodeStartMatch[1],
                        parentAgentId: rootAgent.agentId,
                        tools: []
                    };
                    continue;
                }

                if (!currentNode) {
                    continue;
                }

                if (trimmed.startsWith('name:')) {
                    currentNode.name = this.extractYamlScalar(trimmed);
                    continue;
                }

                if (trimmed.startsWith('description:')) {
                    currentNode.description = this.extractYamlScalar(trimmed);
                    continue;
                }

                if (trimmed.startsWith('model:')) {
                    currentNode.model = this.extractYamlScalar(trimmed);
                    continue;
                }

                if (trimmed.startsWith('- "')) {
                    currentNode.tools.push(trimmed.replace(/^-\s*"/, '').replace(/"$/, ''));
                    continue;
                }
            }

            if (section === 'edges') {
                const fromMatch = trimmed.match(/^- from:\s*"([^"]+)"$/) || trimmed.match(/^- from:\s*([^\s]+)$/);
                if (fromMatch) {
                    currentEdgeFrom = fromMatch[1];
                    continue;
                }

                const toMatch = trimmed.match(/^to:\s*"([^"]+)"$/) || trimmed.match(/^to:\s*([^\s]+)$/);
                if (toMatch && currentEdgeFrom) {
                    edges.push({ from: currentEdgeFrom, to: toMatch[1] });
                    currentEdgeFrom = null;
                }
            }
        }

        flushNode();

        if (nodes.length === 0) {
            return null;
        }

        const parentMap: Record<string, string | null> = {};
        nodes.forEach(node => {
            parentMap[node.agentId] = rootAgent.agentId;
        });

        const assignedParents = new Set<string>();
        for (const edge of edges) {
            if (!parentMap.hasOwnProperty(edge.to)) continue;
            if (assignedParents.has(edge.to)) continue;
            parentMap[edge.to] = edge.from;
            assignedParents.add(edge.to);
        }

        nodes.forEach(node => {
            node.parentAgentId = parentMap[node.agentId] ?? rootAgent.agentId;
        });

        const allAgents = [
            {
                ...rootAgent,
                parentAgentId: rootAgent.parentAgentId ?? null
            },
            ...nodes.filter(node => node.agentId !== rootAgent.agentId)
        ];

        const byId = new Map<string, any>();
        allAgents.forEach(agent => byId.set(agent.agentId, agent));
        const dedupedAgents = Array.from(byId.values());

        const buildTree = (agentId: string): any => {
            const agent = dedupedAgents.find(a => a.agentId === agentId);
            if (!agent) return null;

            const children = dedupedAgents
                .filter(a => a.parentAgentId === agentId)
                .map(child => buildTree(child.agentId))
                .filter(Boolean);

            return {
                agentId: agent.agentId,
                name: agent.name,
                role: agent.role,
                type: agent.type,
                children: children.length > 0 ? children : undefined
            };
        };

        return {
            tree: buildTree(rootAgent.agentId),
            agents: dedupedAgents
        };
    }

    static async getAgentTree(rootAgentId: string, userId: string): Promise<{ success: boolean; tree?: any; agents?: Array<any>; error?: string }> {
        try {
            let dbService = await getDBService();
            let userData = ds.UserInfo.get(userId);
            if (!userData) {
                return { success: false, error: 'user not found' };
            }

            let handler = dbService.getRepository<IAgentConfig>(userData.dbName, CollectionNames.AGENT_CONFIGS);

            // Get root agent
            const rootAgent: any = await handler.findOne({ agentId: rootAgentId });
            if (!rootAgent) {
                return { success: false, error: 'root agent not found' };
            }

            // Recursively get all children
            let allAgents: Array<any> = [];
            const queue = [rootAgentId];
            const visited = new Set<string>();

            while (queue.length > 0) {
                const currentId = queue.shift()!;
                if (visited.has(currentId)) continue;
                visited.add(currentId);

                const agent: any = await handler.findOne({ agentId: currentId });
                if (agent) {
                    allAgents.push(agent);
                    // Find children
                    const children = await handler.find({ parentAgentId: currentId });
                    children.forEach(child => queue.push(child.agentId));
                }
            }

            const nonRootAgents = allAgents.filter(agent => agent.agentId !== rootAgentId);
            const shouldReconstructFromYaml = rootAgent.type === 'multi' && (
                nonRootAgents.length === 0 || nonRootAgents.every(agent => !agent.parentAgentId)
            );

            if (shouldReconstructFromYaml) {
                const syntheticTree = await this.buildSyntheticTreeFromMultiYaml(rootAgent);
                if (syntheticTree) {
                    return {
                        success: true,
                        tree: syntheticTree.tree,
                        agents: syntheticTree.agents
                    };
                }
            }

            // Build tree structure
            const buildTree = (agentId: string): any => {
                const agent = allAgents.find(a => a.agentId === agentId);
                if (!agent) return null;

                const children = allAgents
                    .filter(a => a.parentAgentId === agentId)
                    .map(child => buildTree(child.agentId))
                    .filter(Boolean);

                return {
                    agentId: agent.agentId,
                    name: agent.name,
                    role: agent.role,
                    type: agent.type,
                    children: children.length > 0 ? children : undefined
                };
            };

            const tree = buildTree(rootAgentId);

            return { success: true, tree, agents: allAgents };
        } catch (error: any) {
            this.logger.error('Error getting agent tree', error);
            return { success: false, error: error.message || 'unknown error' };
        }
    }
}
