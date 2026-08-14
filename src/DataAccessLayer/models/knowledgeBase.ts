import { Document, ObjectId } from 'mongodb';

export interface IKnowledgeBase extends Document {
    _id?: ObjectId;
    kbId: string;
    name: string;
    description?: string;
    ownerType: 'user' | 'team' | 'organization';
    ownerId: string;
    /** User who created the KB; used for listing/access when ownerId is a team/org id. */
    createdBy?: string;
    permissionScopes: Record<string, 'Read' | 'Write'>;
    createdAt: Date;
    updatedAt: Date;
    status: 'active' | 'inactive' | 'syncing' | 'error';
    // Statistics (computed)
    fileCount: number;
    folderCount: number;
    totalSizeBytes: number;
    tags: string[];
}

export interface IKnowledgeBaseFile extends Document {
    _id?: ObjectId;
    kbId: string;
    fileId: string;
    relativePath: string;  // path relative to KB root
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256?: string;  // file hash for change detection
    s3Key: string;  // full S3 key
    createdAt: Date;
    updatedAt: Date;
    uploadedBy: string;  // userId
    tags: string[];
}
