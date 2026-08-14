/**
 * Centralized database connection management
 * Use this file to get database service instance instead of creating new ones
 */

import { DatabaseService } from './DatabaseService';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import * as dotenv from 'dotenv';

const logger = new Logger('DB-Connection');
dotenv.config();

// Singleton database service instance
let dbServiceInstance: DatabaseService | null = null;
let isConnecting = false;
let connectionPromise: Promise<void> | null = null;

/**
 * Get the global database service instance
 * Ensures only one connection is established across the application
 * @returns DatabaseService instance
 */
export async function getDBService(): Promise<DatabaseService> {
    // If we have an instance and it's connected, return it
    if (dbServiceInstance && dbServiceInstance.isConnected()) {
        return dbServiceInstance;
    }

    // If we're already connecting, wait for that to complete
    if (isConnecting && connectionPromise) {
        await connectionPromise;
        return dbServiceInstance!;
    }

    // Start new connection
    isConnecting = true;
    connectionPromise = connectDB();
    
    try {
        await connectionPromise;
        return dbServiceInstance!;
    } finally {
        isConnecting = false;
        connectionPromise = null;
    }
}

/**
 * Internal function to establish database connection
 */
async function connectDB(): Promise<void> {
    try {
        dbServiceInstance = DatabaseService.getInstance();
        
        if (!dbServiceInstance.isConnected()) {
            let connectionString = process.env.MONGODB_CONNECTION_STRING_DEV || '';

            // When running inside Docker, localhost refers to the container itself.
            // Replace it with host.docker.internal so it points to the host machine
            // where the local MongoDB server is actually running.
            const isDocker = fs.existsSync('/.dockerenv');
            if (isDocker && connectionString.includes('localhost')) {
                connectionString = connectionString.replace('localhost', 'host.docker.internal');
                logger.info('Docker environment detected — MongoDB host rewritten to host.docker.internal');
            }

            await dbServiceInstance.connect(connectionString);
            logger.success('Database connection established');
        }
    } catch (error) {
        logger.error('Error establishing database connection', error);
        dbServiceInstance = null;
        throw error;
    }
}

/**
 * Check if database service is connected
 * @returns boolean
 */
export function isDBConnected(): boolean {
    return dbServiceInstance !== null && dbServiceInstance.isConnected();
}

/**
 * Disconnect from database
 */
export async function disconnectDB(): Promise<void> {
    if (dbServiceInstance) {
        await dbServiceInstance.disconnect();
        dbServiceInstance = null;
    }
}

/**
 * Perform health check on database connection
 */
export async function dbHealthCheck(): Promise<boolean> {
    if (!dbServiceInstance) {
        return false;
    }
    return await dbServiceInstance.healthCheck();
}
