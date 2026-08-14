
import { MongoDBClient } from './MongoDBClient';
import { MongoRepository, IRepository } from './Repository';
import { Collection, Document, Db } from 'mongodb';

/**
 * Service class for database operations
 * Uses singleton pattern to ensure only one instance is used throughout the application
 */
export class DatabaseService {
    private static instance: DatabaseService;
    private client: MongoDBClient;
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {
        this.client = MongoDBClient.getInstance();
    }

    /**
     * Get the singleton instance of DatabaseService
     * @returns DatabaseService instance
     */
    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }
    
    /**
     * Connect to MongoDB
     * @param connectionString MongoDB connection string
     */
    public async connect(connectionString: any): Promise<void> {
        await this.client.connect(connectionString);
    }
    
    /**
     * Disconnect from MongoDB
     */
    public async disconnect(): Promise<void> {
        await this.client.disconnect();
    }
    
    /**
     * Check if connected to MongoDB
     */
    public isConnected(): boolean {
        return this.client.isConnected();
    }

    /**
     * Perform a health check on the MongoDB connection
     * @returns Promise<boolean> True if connection is healthy
     */
    public async healthCheck(): Promise<boolean> {
        return await this.client.healthCheck();
    }

    /**
     * Get connection pool statistics
     * @returns Connection pool information
     */
    public getPoolStats(): { isConnected: boolean; message: string } {
        return this.client.getPoolStats();
    }
    
    /**
     * Get a database
     * @param dbName Database name
     */
    public getDatabase(dbName: string): Db {
        return this.client.getDatabase(dbName);
    }
    
    /**
     * Create a new database
     * @param dbName Database name
     */
    public async createDatabase(dbName: string): Promise<Db> {
        return await this.client.createDatabase(dbName);
    }
    
    /**
     * Drop a database
     * @param dbName Database name
     */
    public async dropDatabase(dbName: string): Promise<boolean> {
        return await this.client.dropDatabase(dbName);
    }
    
    /**
     * List all databases
     */
    public async listDatabases(): Promise<string[]> {
        return await this.client.listDatabases();
    }
    
    /**
     * Create a collection in a specific database
     * @param dbName Database name
     * @param collectionName Collection name
     */
    public async createCollection(dbName: string, collectionName: string): Promise<Collection> {
        return await this.client.createCollection(dbName, collectionName);
    }
    
    /**
     * Drop a collection from a specific database
     * @param dbName Database name
     * @param collectionName Collection name
     */
    public async dropCollection(dbName: string, collectionName: string): Promise<boolean> {
        return await this.client.dropCollection(dbName, collectionName);
    }
    
    /**
     * List all collections in a specific database
     * @param dbName Database name
     */
    public async listCollections(dbName: string): Promise<string[]> {
        return await this.client.listCollections(dbName);
    }
    
    /**
     * Get a repository for a collection
     * @param dbName Database name
     * @param collectionName Collection name
     */
    public getRepository<T extends Document>(dbName: any, collectionName: any): IRepository<T> {
        return new MongoRepository<T>(dbName, collectionName);
    }

    
    /**
     * Check if database exists
     * @param dbName Database name
     * @returns True if database exists, false otherwise
     */
    public async databaseExists(dbName: string): Promise<boolean> {
        return await this.client.databaseExists(dbName);
    }
    
    /**
     * Ensure database exists, create if it doesn't
     * @param dbName Database name
     * @returns Database instance
     */
    public async ensureDatabase(dbName: any): Promise<Db> {
        return await this.client.ensureDatabase(dbName);
    }
    
    /**
     * Check if collection exists in a database
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns True if collection exists, false otherwise
     */
    public async collectionExists(dbName: string, collectionName: string): Promise<boolean> {
        return await this.client.collectionExists(dbName, collectionName);
    }
    
    /**
     * Ensure collection exists in database, create if it doesn't
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns Collection instance
     */
    public async ensureCollection<T extends Document>(dbName: any, collectionName: any): Promise<Collection<T>> {
        return await this.client.ensureCollection<T>(dbName, collectionName);
    }
    
    /**
     * Execute a database operation within a transaction
     * @param operation Function that performs database operations
     */
    public async withTransaction<T>(operation: (client: MongoDBClient) => Promise<T>): Promise<T> {
        const session = this.client.getClient().startSession();
        
        try {
            let result: T;
            await session.withTransaction(async () => {
                result = await operation(this.client);
            });
            return result!;
        } finally {
            await session.endSession();
        }
    }
}
