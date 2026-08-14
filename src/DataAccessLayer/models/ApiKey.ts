import { Document, ObjectId } from 'mongodb';

/**
 * Represents a stored API key record in the organisation's user database.
 * The raw key is NEVER stored — only its SHA-256 hash is persisted.
 */
export interface IApiKey extends Document {
    _id?: ObjectId;
    /** SHA-256 hex digest of the raw API key */
    keyHash: string;
    /** Owner of this key */
    userId: string;
    /** Human-readable label so the user can identify the key (e.g. "CI pipeline key") */
    label: string;
    /** When this key was created */
    createdAt: Date;
    /** Hard expiry timestamp — null means never expires */
    expiresAt: Date | null;
    /** Soft-revocation flag — set to true to instantly invalidate the key */
    isRevoked: boolean;
    /** Last time this key was successfully used (updated on every valid request) */
    databaseName:string;

    lastUsedAt?: Date;
}
