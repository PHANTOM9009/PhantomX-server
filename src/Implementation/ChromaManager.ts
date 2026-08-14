import * as dotenv from 'dotenv';
dotenv.config();
import { ChromaClient, Collection, Metadata, IEmbeddingFunction } from 'chromadb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { v4 as uuidv4 } from 'uuid';

import * as path from 'path';
import { chunkStructure, chunkGroupStructure } from '../classes/chunk_structure';
import Parser from 'tree-sitter';
type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONObject | JSONArray;
interface JSONObject { [key: string]: JSONValue; }
interface JSONArray extends Array<JSONValue> { }

interface CodeChunkMetadata extends JSONObject {
    filePath: string;

    hash: string;

    startRow: number;
    endRow: number;
    timestamp: string;
}

class BedrockEmbedder implements IEmbeddingFunction {
    private bedrock: BedrockRuntimeClient;

    constructor() {
        this.bedrock = new BedrockRuntimeClient({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID_AI || '',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_AI || ''
            }
        });
    }

    async generate(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map(async (text) => {
            try {
                let body = {
                    "inputText": text,
                }
                const command = new InvokeModelCommand({
                    modelId: 'amazon.titan-embed-text-v2:0',
                    contentType: 'application/json',
                    accept: 'application/json',
                    body: JSON.stringify(body)
                });

                const response = await this.bedrock.send(command);
                const embedding = JSON.parse(new TextDecoder().decode(response.body));
                return embedding.embedding;
            } catch (error) {
                console.error('Failed to generate embedding:', error);
                throw error;
            }
        }));
    }

    // Required for ChromaDB embedding function serialization
    getConfig() {
        return {
            provider: 'aws-bedrock',
            model: 'amazon.titan-embed-text-v2:0',
            region: process.env.AWS_REGION || 'us-east-1',
        };
    }

    public name: string = 'BedrockEmbedder';
}

import * as fs from 'fs';
export class ChromaManager {
private client: ChromaClient;
    private collection!: Collection;
    private embedder: BedrockEmbedder;
    private  collectionName:string;

    constructor(collectionName:string, chromaDbUrl:string) {
        this.client = new ChromaClient({
            path: chromaDbUrl  // Default ChromaDB server address
        });
        this.embedder = new BedrockEmbedder();
       
        this.collectionName = collectionName;
    }

    async deleteChunks(removedChunks: chunkGroupStructure[]): Promise<boolean> {
        try
        {
            if(!this.collection)
            {
                await this.initialize();
            }
              if(removedChunks.length>0)
            {
            await this.collection.delete({
                where: { "hash": { "$in": removedChunks.map(chunk => chunk.contentHash) } }
            });
            console.log(`removed ${removedChunks.length} chunks from ChromaDB`);
        }
        return true;
            
        }
        catch(error)
        {
            console.error('Failed to initialize ChromaDB:', error);
            throw error;
        }
    }
    /**
     * Update the ChromaDB collection by removing and adding code chunks.
     * @param removedChunks Array of chunkStructure to remove (by contentHash)
     * @param addedChunks Array of chunkStructure to add
     */

    async updateChunks(removedChunks: chunkGroupStructure[], addedChunks: chunkGroupStructure[], sourceCode: string): Promise<void> {
        if (!this.collection) {
            await this.initialize();
        }
        // Remove chunks by hash (contentHash is stored as 'hash' in metadata)

        try {
            if(removedChunks.length>0)
            {
            await this.collection.delete({
                where: { "hash": { "$in": removedChunks.map(chunk => chunk.contentHash) } }
            });
            console.log(`removed ${removedChunks.length} chunks from ChromaDB`);
        }
        if(addedChunks.length >0)
        {
           await  this.addCodeChunk(addedChunks, sourceCode);
            console.log(`added ${addedChunks.length} new chunks to ChromaDB`);
        }      
        } catch (error) {
            console.error('Failed to update chunks:', error);
            throw error;
        }
    }

    async initialize() {
        try {            // Get or create collection with custom embedding function
            this.collection = await this.client.getOrCreateCollection({
                name: this.collectionName,
                metadata: {
                    description: "Code chunks collection with custom embeddings",
                    distance_function: "cosine"  // Use cosine similarity for distance calculations
                },
                embeddingFunction: this.embedder
            });

            console.log('ChromaDB collection initialized');
        } catch (error) {
            console.error('Failed to initialize ChromaDB:', error);
            throw error;
        }
    }
    public getTextFromRange(start: Parser.Point, end: Parser.Point, newSource: string): string {
        const startLine = start.row;
        const endLine = end.row;
        const startChar = start.column;
        const endChar = end.column;

        const lines = newSource.split('\n');
        const selectedLines = lines.slice(startLine, endLine + 1);
        if (selectedLines.length === 0) {
            return '';
        }
        return selectedLines.join('\n');
    }
    // Overload signatures
    async addCodeChunk(metadata: chunkGroupStructure, sourceCode: string): Promise<void>;
    async addCodeChunk(metadataArray: chunkGroupStructure[], sourceCode: string): Promise<void>;
    // Implementation
    public async addCodeChunk(metadataOrArray: chunkGroupStructure | chunkGroupStructure[], sourceCode: string): Promise<void> {
        
        try {
            if (!this.collection) {
            await this.initialize();
        }
            if (Array.isArray(metadataOrArray)) {
                // Handle array of chunks
                const ids: string[] = [];
                const documents: string[] = [];
                const metadatas: Metadata[] = [];
                for (const metadata1 of metadataOrArray) {
                    const metadata: CodeChunkMetadata = {
                        filePath: path.normalize(metadata1.filePath),
                        hash: metadata1.contentHash,

                        startRow: metadata1.chunkStartPosition.row,
                        endRow: metadata1.chunkEndPosition.row,


                        timestamp: new Date().toISOString()
                    };
                    ids.push(uuidv4()); // Generate a unique ID for each chunk
                    const text = this.getTextFromRange(metadata1.chunkStartPosition, metadata1.chunkEndPosition, sourceCode);
                    documents.push(text);
                    metadatas.push(metadata as Metadata);
                }
                await this.collection.add({
                    ids: ids,
                    documents: documents,
                    metadatas: metadatas
                });
                console.log(`Successfully added ${ids.length} code chunks to ChromaDB`);
            } else {
                // Handle single chunk
                const metadata: CodeChunkMetadata = {
                    filePath: path.normalize(metadataOrArray.filePath),
                    hash: metadataOrArray.contentHash,

                    startRow: metadataOrArray.chunkStartPosition.row,
                    endRow: metadataOrArray.chunkEndPosition.row,


                    timestamp: new Date().toISOString()
                };
                const text = this.getTextFromRange(metadataOrArray.chunkStartPosition, metadataOrArray.chunkEndPosition, sourceCode);
                await this.collection.add({
                    ids: [uuidv4()], // Generate a unique ID for the chunk
                    documents: [text],
                    metadatas: [metadata as Metadata]
                });
                console.log('Successfully added code chunk to ChromaDB');
            }
        } catch (error) {
            console.error('Failed to add code chunk(s):', error);
            throw error;
        }
    }

    async queryCollection(queryContent: string, topK: number = 5) {
        try {
            if (!this.collection) {
                await this.initialize();
            }
            const results = await this.collection.query({
                queryTexts: [queryContent],
                nResults: topK
            });

            if (!results.distances || !results.documents || !results.metadatas) {
                throw new Error('Invalid query results');
            }

            return {
                documents: results.documents[0],
                metadatas: results.metadatas[0] as CodeChunkMetadata[],
                distances: results.distances[0] || []
            };
        } catch (error) {
            console.error('Failed to query collection:', error);
            throw error;
        }
    }

    async deleteCollection() {
        try {
            if (!this.collection) {
                await this.initialize();
            }
            await this.client.deleteCollection({
                name: this.collectionName
            });
            console.log('Collection deleted successfully');
        } catch (error) {
            console.error('Failed to delete collection:', error);
            throw error;
        }
    }

    /**
     * Export all documents and their metadata from the collection to a JSON file.
     * @param outputPath Path to the output JSON file
     */
    async exportAllDocumentsToJson(outputPath: string): Promise<void> {
        if (!this.collection) {
            await this.initialize();
        }
        try {
            // ChromaDB collections may not have a direct 'get all' method, so we use get() with no filter
            const results = await this.collection.get({});
            const data = [];
            const docs = results.documents || [];
            const metas = results.metadatas || [];
            for (let i = 0; i < docs.length; i++) {
                data.push({
                    document: docs[i],
                    metadata: metas[i]
                });
            }
            // Prepend current directory to the output file name
            const fullPath = path.join(process.cwd(), outputPath);
            fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`Exported ${data.length} documents to ${fullPath}`);
        } catch (error) {
            console.error('Failed to export documents:', error);
            throw error;
        }
    }
}
