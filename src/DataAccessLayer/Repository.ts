
import { Collection, Document, Filter, FindOptions, InsertOneOptions, OptionalUnlessRequiredId, UpdateFilter, DeleteOptions, UpdateOptions, InsertOneResult, UpdateResult, DeleteResult, ObjectId, Sort, AggregateOptions, WithId } from 'mongodb';
import { MongoDBClient } from './MongoDBClient';
import { Logger } from '../utils/Logger';

/**
 * Interface for generic repository operations
 */
export interface IRepository<T extends Document> {
    // Basic CRUD operations
    findById(id: string): Promise<WithId<T> | null>;
    findOne(filter: Filter<T>): Promise<WithId<T> | null>;
    find(filter?: Filter<T>, options?: FindOptions): Promise<WithId<T>[]>;
    insertOne(doc: OptionalUnlessRequiredId<T>, options?: InsertOneOptions): Promise<InsertOneResult>;
    insertMany(docs: OptionalUnlessRequiredId<T>[], options?: InsertOneOptions): Promise<number>;
    updateOne(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions): Promise<UpdateResult>;
    updateMany(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions): Promise<UpdateResult>;
    deleteOne(filter: Filter<T>, options?: DeleteOptions): Promise<DeleteResult>;
    deleteMany(filter: Filter<T>, options?: DeleteOptions): Promise<DeleteResult>;
    count(filter?: Filter<T>): Promise<number>;
    
    // Advanced operations
    findWithPagination(filter: Filter<T>, page: number, pageSize: number, sort?: Sort): Promise<{ data: WithId<T>[], total: number, page: number, pageSize: number, totalPages: number }>;
    aggregate<U extends Document = Document>(pipeline: Document[], options?: AggregateOptions): Promise<U[]>;
    distinct(field: string, filter?: Filter<T>): Promise<any[]>;
    exists(filter: Filter<T>): Promise<boolean>;
    findAndModify(filter: Filter<T>, update: UpdateFilter<T>, options?: { returnDocument?: 'before' | 'after', upsert?: boolean }): Promise<WithId<T> | null>;
}

/**
 * Generic repository implementation for MongoDB
 */
export class MongoRepository<T extends Document> implements IRepository<T> {
    private collection: Collection<T>;
    private logger: Logger;
    
    /**
     * Create a new MongoRepository instance
     * @param dbName Database name
     * @param collectionName Collection name
     */
    constructor(dbName: string, collectionName: string) {
        this.logger = new Logger('MongoRepository');
        const client = MongoDBClient.getInstance();
        this.collection = client.getCollection<T>(dbName, collectionName);
    }
    
    /**
     * Get the underlying MongoDB collection
     */
    public getCollection(): Collection<T> {
        return this.collection;
    }
    
    /**
     * Find a document by its ID
     * @param id Document ID
     */
    public async findById(id: string): Promise<WithId<T> | null> {
        try {
            let objectId: ObjectId;
            try {
                objectId = new ObjectId(id);
            } catch (e) {
                return null; // Invalid ObjectId format
            }
            return await this.collection.findOne({ _id: objectId } as Filter<T>);
        } catch (error) {
            this.logger.error(`Error finding document by ID ${id}`, error);
            throw error;
        }
    }
    
    /**
     * Find a single document matching the filter
     * @param filter Query filter
     */
    public async findOne(filter: Filter<T>): Promise<WithId<T> | null> {
        try {
            return await this.collection.findOne(filter);
        } catch (error) {
            this.logger.error('Error finding document', error);
            throw error;
        }
    }
    
    /**
     * Find documents matching the filter
     * @param filter Query filter
     * @param options Find options
     */
    public async find(filter?: Filter<T>, options?: FindOptions): Promise<WithId<T>[]> {
        try {
            const cursor = this.collection.find(filter ?? {}, options);
            return await cursor.toArray();
        } catch (error) {
            this.logger.error('Error finding documents', error);
            throw error;
        }
    }
    
    /**
     * Insert a single document
     * @param doc Document to insert
     * @param options Insert options
     */
    public async insertOne(doc: OptionalUnlessRequiredId<T>, options?: InsertOneOptions): Promise<InsertOneResult> {
        try {
            return await this.collection.insertOne(doc, options);
        } catch (error) {
            this.logger.error('Error inserting document', error);
            throw error;
        }
    }
    
    /**
     * Insert multiple documents
     * @param docs Documents to insert
     * @param options Insert options
     */
    public async insertMany(docs: OptionalUnlessRequiredId<T>[], options?: InsertOneOptions): Promise<number> {
        try {
            const result = await this.collection.insertMany(docs, options);
            return result.insertedCount;
        } catch (error) {
            this.logger.error('Error inserting documents', error);
            throw error;
        }
    }
    
    /**
     * Update a single document
     * @param filter Query filter
     * @param update Update operations
     * @param options Update options
     */
    public async updateOne(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions): Promise<UpdateResult> {
        try {
            return await this.collection.updateOne(filter, update, options);
        } catch (error) {
            this.logger.error('Error updating document', error);
            throw error;
        }
    }
    
    /**
     * Update multiple documents
     * @param filter Query filter
     * @param update Update operations
     * @param options Update options
     */
    public async updateMany(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions): Promise<UpdateResult> {
        try {
            return await this.collection.updateMany(filter, update, options);
        } catch (error) {
            this.logger.error('Error updating documents', error);
            throw error;
        }
    }
    
    /**
     * Delete a single document
     * @param filter Query filter
     * @param options Delete options
     */
    public async deleteOne(filter: Filter<T>, options?: DeleteOptions): Promise<DeleteResult> {
        try {
            return await this.collection.deleteOne(filter, options);
        } catch (error) {
            this.logger.error('Error deleting document', error);
            throw error;
        }
    }
    
    /**
     * Delete multiple documents
     * @param filter Query filter
     * @param options Delete options
     */
    public async deleteMany(filter: Filter<T>, options?: DeleteOptions): Promise<DeleteResult> {
        try {
            return await this.collection.deleteMany(filter, options);
        } catch (error) {
            this.logger.error('Error deleting documents', error);
            throw error;
        }
    }
    
    /**
     * Count documents matching the filter
     * @param filter Query filter
     */
    public async count(filter: Filter<T> = {}): Promise<number> {
        try {
            return await this.collection.countDocuments(filter);
        } catch (error) {
            this.logger.error('Error counting documents', error);
            throw error;
        }
    }
    
    /**
     * Find documents with pagination
     * @param filter Query filter
     * @param page Page number (1-based)
     * @param pageSize Number of items per page
     * @param sort Sort specification
     */
    public async findWithPagination(
        filter: Filter<T> = {}, 
        page: number = 1, 
        pageSize: number = 10,
        sort?: Sort
    ): Promise<{ data: WithId<T>[], total: number, page: number, pageSize: number, totalPages: number }> {
        try {
            const skip = (page - 1) * pageSize;
            const total = await this.collection.countDocuments(filter);
            const totalPages = Math.ceil(total / pageSize);
            
            let cursor = this.collection.find(filter ?? {})
                .skip(skip)
                .limit(pageSize);
                
            if (sort) {
                cursor = cursor.sort(sort);
            }
            
            const data = await cursor.toArray();
            
            return {
                data,
                total,
                page,
                pageSize,
                totalPages
            };
        } catch (error) {
            this.logger.error('Error finding documents with pagination', error);
            throw error;
        }
    }
    
    /**
     * Run an aggregation pipeline
     * @param pipeline Aggregation pipeline stages
     * @param options Aggregation options
     */
    public async aggregate<U extends Document = Document>(pipeline: Document[], options?: AggregateOptions): Promise<U[]> {
        try {
            const result = await this.collection.aggregate<U>(pipeline, options).toArray();
            return result;
        } catch (error) {
            this.logger.error('Error running aggregation pipeline', error);
            throw error;
        }
    }
    
    /**
     * Get distinct values for a field
     * @param field Field name
     * @param filter Query filter
     */
    public async distinct(field: string, filter?: Filter<T>): Promise<any[]> {
        try {
            return await this.collection.distinct(field, filter ?? {} as Filter<T>);
        } catch (error) {
            this.logger.error(`Error getting distinct values for field ${field}`, error);
            throw error;
        }
    }
    
    /**
     * Check if any document matches the filter
     * @param filter Query filter
     */
    public async exists(filter: Filter<T>): Promise<boolean> {
        try {
            const count = await this.collection.countDocuments(filter, { limit: 1 });
            return count > 0;
        } catch (error) {
            this.logger.error('Error checking document existence', error);
            throw error;
        }
    }
    
    /**
     * Find a document and update it in one operation
     * @param filter Query filter
     * @param update Update operations
     * @param options Options for findAndModify
     */
    public async findAndModify(
        filter: Filter<T>,
        update: UpdateFilter<T>,
        options?: { returnDocument?: 'before' | 'after', upsert?: boolean }
    ): Promise<WithId<T> | null> {
        try {
            const result = await this.collection.findOneAndUpdate(
                filter,
                update,
                {
                    returnDocument: options?.returnDocument === 'after' ? 'after' : 'before',
                    upsert: options?.upsert || false
                }
            );
            return result?.value ?? null;
        } catch (error) {
            this.logger.error('Error in findAndModify operation', error);
            throw error;
        }
    }
}
