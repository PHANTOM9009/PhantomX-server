import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * AES-256-GCM encrypt — same wire format as Atlassian org tokens:
 * `${ivHex}:${authTagHex}:${ciphertextHex}`
 */
export function encryptOrgSecret(plaintext: string, encryptionKey: string): string {
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptOrgSecret(encryptedPayload: string, encryptionKey: string): string {
    const [ivHex, authTagHex, encryptedData] = encryptedPayload.split(':');
    if (!ivHex || !authTagHex || !encryptedData) {
        throw new Error('INVALID_ORG_SECRET_FORMAT');
    }
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex')) as crypto.DecipherGCM;
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

export function getOrgEncryptionKey(): string {
    return process.env.SECRET_ENCRYPTION_KEY || 'phantomx';
}
