
import { MongoClient, ServerApiVersion,Db, Collection, Document, Filter, FindOptions, UpdateFilter, UpdateOptions, InsertOneOptions, BulkWriteOptions, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';
import {CollectionNames} from './models/Collections';
import { Logger } from '../utils/Logger';
dotenv.config();
/**
 * MongoDB Client Manager for handling database connections and operations
 */
export class MongoDBClient {
    private static instance: MongoDBClient;
    private client: MongoClient | null = null;
    private logger: Logger;
    // Removed currentDb - state should not be shared across requests
    
    private constructor() {
        this.logger = new Logger('MongoDBClient');
    }
    
    /**
     * Get the singleton instance of MongoDBClient
     */
    public static getInstance(): MongoDBClient {
        if (!MongoDBClient.instance) {
            MongoDBClient.instance = new MongoDBClient();
        }
        return MongoDBClient.instance;
    }
    
    /**
     * Connect to MongoDB server with connection pooling
     * @param connectionString MongoDB connection string
     */
    public async connect(connectionString: string): Promise<void> {
        // If already connected, don't create a new connection
        if (this.client) {
            return;
        }

        try {
            const options = {
                serverApi: {
                    version: ServerApiVersion.v1,
                    strict: true,
                    deprecationErrors: true,
                },
                // Connection pool settings
                maxPoolSize: 50,  // Maximum number of connections in the pool (default: 100)
                minPoolSize: 5,   // Minimum number of connections to maintain
                maxIdleTimeMS: 60000,  // Close connections that have been idle for 60 seconds
                
                // Timeout settings
                connectTimeoutMS: 10000,  // 10 seconds
                socketTimeoutMS: 45000,   // 45 seconds
                serverSelectionTimeoutMS: 10000,  // 10 seconds
                
                // Retry logic
                retryWrites: true,
                retryReads: true,
                
                // Monitoring
                monitorCommands: process.env.NODE_ENV === 'development',
            };

            this.client = await MongoClient.connect(connectionString, options);
            this.logger.success('Connected to MongoDB with connection pool (maxPoolSize: 50, minPoolSize: 5)');
            
            // Set up connection event listeners
            this.setupConnectionListeners();
        } catch (error) {
            this.logger.error('Failed to connect to MongoDB', error);
            throw error;
        }
    }

    /**
     * Setup connection event listeners for monitoring
     */
    private setupConnectionListeners(): void {
        if (!this.client) return;

        const client = this.client;

        // Connection pool monitoring - removed to reduce noise

        // Important events to always monitor
        client.on('error', (error) => {
            this.logger.error('MongoDB client error', error);
        });

        client.on('timeout', () => {
            this.logger.error('MongoDB connection timeout');
        });

        client.on('close', () => {
            this.client = null;
        });

    }
    
    /**
     * Disconnect from MongoDB server
     */
    public async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.close();
            this.client = null;
        }
    }
    
    /**
     * Check if client is connected
     */
    public isConnected(): boolean {
        return this.client !== null;
    }

    /**
     * Perform a health check on the connection
     * @returns Promise<boolean> True if connection is healthy
     */
    public async healthCheck(): Promise<boolean> {
        if (!this.client) {
            return false;
        }

        try {
            // Ping the admin database to check connection
            await this.client.db('admin').command({ ping: 1 });
            return true;
        } catch (error) {
            this.logger.error('MongoDB health check failed', error);
            return false;
        }
    }

    /**
     * Get connection pool statistics
     * @returns Connection pool information
     */
    public getPoolStats(): { isConnected: boolean; message: string } {
        if (!this.client) {
            return {
                isConnected: false,
                message: 'MongoDB client not connected'
            };
        }

        return {
            isConnected: true,
            message: 'MongoDB connection pool active (maxPoolSize: 50, minPoolSize: 5)'
        };
    }
    
    /**
     * Get MongoDB client instance
     */
    public getClient(): MongoClient {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        return this.client;
    }
    
    /**
     * Get a specific database (does not store state)
     * @param dbName Database name
     * @returns Database instance
     */
    public getDatabase(dbName: string): Db {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        return this.client.db(dbName);
    }
    
    
    /**
     * Get a collection from a specific database
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns Collection instance
     */
    public getCollection<T extends Document>(dbName: string, collectionName: string): Collection<T> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        return this.client.db(dbName).collection<T>(collectionName);
    }
    
    /**
     * List all databases
     */
    public async listDatabases(): Promise<string[]> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const adminDb = this.client.db('admin');
        const result = await adminDb.admin().listDatabases();
        return result.databases.map(db => db.name);
    }
    
    /**
     * Create a new database (in MongoDB, this actually means using a database)
     * @param dbName Database name
     * @returns Database instance
     */
    public async createDatabase(dbName: string): Promise<Db> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const db = this.client.db(dbName);
        // In MongoDB, a database is implicitly created when you first store data in that database
        await db.collection('_init').insertOne({ _id: new ObjectId('000000000000000000000000') });
        await db.collection('_init').deleteOne({ _id: new ObjectId('000000000000000000000000') });
        return db;
    }
    
    /**
     * Drop a database
     * @param dbName Database name
     */
    public async dropDatabase(dbName: string): Promise<boolean> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const db = this.client.db(dbName);
        return db.dropDatabase();
    }
    
    /**
     * Create a collection in a specific database
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns Collection instance
     */
    public async createCollection(dbName: string, collectionName: string): Promise<Collection> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const db = this.client.db(dbName);
        let result =  await db.createCollection(collectionName);
        //setting secondary indexes in the db. and setting it unique
        if(collectionName ===  process.env.USER_CREDENTIAL_COLLECTION || collectionName === CollectionNames.USERS)
        {
            result.createIndex({userId:1},{unique:true});
        }
        else if(collectionName === CollectionNames.ORGANIZATION)
        {
            result.createIndex({OrganizationId:1},{unique:true});
        }
        else if(collectionName === CollectionNames.NOTIFICATIONS)
        {
            result.createIndex({notificationId:1},{unique:true});
        }
        else if(collectionName === CollectionNames.TASKS)
        {

        }
        else if(collectionName === CollectionNames.GROUPS)
        {
            result.createIndex({GroupId:1},{unique:true});
        }
        else if(collectionName === CollectionNames.WORKSPACES)
        {
            
        }
        return result;
        

    }
    public async createTimeSeriesCollection(dbName:string,collectionName:string)
    {
        // creating a time series collection for the user
        try{ 
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        
        const db = this.client?.db(dbName);
        let result =  await db.createCollection(collectionName,{
            timeseries:{
                timeField : "timestamp",
                metaField: "tags",
                granularity:"minutes"
            }
        });
        return result;
    }
    catch(ex)
    {
        console.log("\n failed to create the time series collection due to the error=>",ex);
    }
        
    }
    /**
     * Ensure time series collection exists, create if it doesn't
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns Collection instance or null if error
     */
    public async ensureTimeSeriesCollection(dbName: string, collectionName: string) {
        try {
            if (!this.client) {
                throw new Error('MongoDB client not connected. Call connect() first.');
            }
            
            // First ensure database exists
            await this.ensureDatabase(dbName);
            
            const exists = await this.collectionExists(dbName, collectionName);
            
            if (!exists) {
                this.logger.info(`Creating time series collection: ${collectionName}`);
                return await this.createTimeSeriesCollection(dbName, collectionName);
            }
            
            return this.client.db(dbName).collection(collectionName);
        } catch (error: any) {
            // If collection already exists (error code 48), just return the collection
            if (error.codeName === 'NamespaceExists' || error.code === 48) {
                this.logger.info(`Time series collection ${collectionName} already exists`);
                return this.client?.db(dbName).collection(collectionName);
            }
            this.logger.error(`Failed to ensure time series collection: ${collectionName}`, error);
            return null;
        }
    }
    /**
     * Drop a collection from a specific database
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns Success boolean
     */
    public async dropCollection(dbName: string, collectionName: string): Promise<boolean> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const db = this.client.db(dbName);
        return await db.dropCollection(collectionName);
    }
    
    /**
     * List all collections in a specific database
     * @param dbName Database name
     * @returns Array of collection names
     */
    public async listCollections(dbName: string): Promise<string[]> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const db = this.client.db(dbName);
        const collections = await db.listCollections().toArray();
        return collections.map(collection => collection.name);
    }
    
    /**
     * Check if database exists
     * @param dbName Database name
     * @returns True if database exists, false otherwise
     */
    public async databaseExists(dbName: string): Promise<boolean> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const databases = await this.listDatabases();
        return databases.includes(dbName);
    }
    
    /**
     * Ensure database exists, create if it doesn't
     * @param dbName Database name
     * @returns Database instance
     */
    public async ensureDatabase(dbName: string): Promise<Db> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        
        const exists = await this.databaseExists(dbName);
        
        if (!exists) {
            return await this.createDatabase(dbName);
        }
        
        
       // console.log(`Database '${dbName}' already exists.`);
        return this.client.db(dbName);
    }
    
    /**
     * Check if collection exists in a database
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns True if collection exists, false otherwise
     */
    public async collectionExists(dbName: string, collectionName: string): Promise<boolean> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        const collections = await this.listCollections(dbName);
        return collections.includes(collectionName);
    }
    
    /**
     * Ensure collection exists in database, create if it doesn't
     * @param dbName Database name
     * @param collectionName Collection name
     * @returns Collection instance
     */
    public async ensureCollection<T extends Document>(dbName: string, collectionName: string): Promise<Collection<T>> {
        if (!this.client) {
            throw new Error('MongoDB client not connected. Call connect() first.');
        }
        
        // First ensure database exists
        await this.ensureDatabase(dbName);
        
        const exists = await this.collectionExists(dbName, collectionName);
        
        if (!exists) {
            await this.createCollection(dbName, collectionName);
        }
        
        
        return this.client.db(dbName).collection<T>(collectionName);
    }
}
