export interface UserContactInfo {
    workEmail: string;
    companyName: string;
    role: string;
    companySize: string;
    message: string;
    submittedAt?: Date;
    status?: 'pending' | 'contacted' | 'closed';
}
