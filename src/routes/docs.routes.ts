import express, { Request, Response, Router } from 'express';
import path from 'path';
import fs from 'fs/promises';

const router: Router = express.Router();

const DOCS_CONTENT_DIR = path.join(__dirname, '../documentation-content');
import { getPayPalService } from '../Services/PayPalService';
import { PlanInfo } from '../model/Plans';
import { getDBService } from '../DataAccessLayer/db-connection';
import { Plan } from '@paypal/paypal-server-sdk';

import { UserContactInfo } from '../model/UserContactInfo';
import { CollectionNames } from '../DataAccessLayer/models/Collections';

//this is a paypal route
router.get('/public/paypal/plans', async (req: Request, res: Response): Promise<void> => {
    try {
        const paypalService = getPayPalService();
        const query = req.query || {};
        const result = await paypalService.listPlans(query as any);
        //getting the plan information from mongodb
        let dbService = await getDBService();
        let planHanlder = await dbService.getRepository<PlanInfo>('General','PlanConstraints');
        let plans = await planHanlder.find();
        // let finalPlans=[];
        // for(let plan of plans)
        // {
        //     finalPlans.push({
        //         planName: plan.planName,
        //         AllowedWorkspaces:plan.constraints.WorkspaceConstraints.numberOfWorkspaces,
        //         AllowedTasks: plan.constraints.TotalTasks.numberOfTasks,
        //         AllowedTeamMembers: plan.constraints.TeamMembers.maxTeamMembers,
        //         credits: plan.constraints.subscriptionCredits
        //     });
        // }
        let finResult = {
            constraints: plans,
            plans: result.plans
        }
        res.json(finResult);
    } catch (error: any) {
        console.error('Public PayPal: Error listing plans:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to list plans' });
    }
});


// Public endpoint to handle enterprise contact form submissions
router.post('/public/contact/enterprise', async (req: Request, res: Response): Promise<void> => {
    try {
        const { workEmail, companyName, role, companySize, message } = req.body;

        // Validate required fields
        if (!workEmail || !companyName || !role || !companySize || !message) {
            res.status(400).json({ 
                success: false, 
                error: 'All fields are required' 
            });
            return;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(workEmail)) {
            res.status(400).json({ 
                success: false, 
                error: 'Invalid email address' 
            });
            return;
        }

        const dbService = await getDBService();
        
        const dbName = 'General';
        await dbService.ensureDatabase(dbName);
        await dbService.ensureCollection(dbName, CollectionNames.USER_CONTACT_INFO);
        
        const contactRepo = dbService.getRepository<UserContactInfo>(dbName, CollectionNames.USER_CONTACT_INFO);
        
        // Create contact info document
        const contactInfo: UserContactInfo = {
            workEmail,
            companyName,
            role,
            companySize,
            message,
            submittedAt: new Date(),
            status: 'pending'
        };

        await contactRepo.insertOne(contactInfo);

        console.log(`✅ Enterprise contact form submitted: ${workEmail} from ${companyName}`);
        
        res.json({ 
            success: true, 
            message: 'Thank you for your interest! Our team will contact you within 24 hours.' 
        });
    } catch (error: any) {
        console.error('Error submitting contact form:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to submit contact form. Please try again later.' 
        });
    }
});


// Get documentation structure/navigation
router.get('/structure', async (req: Request, res: Response): Promise<any> => {
    try {
        const indexPath = path.join(DOCS_CONTENT_DIR, 'index.json');
        const indexContent = await fs.readFile(indexPath, 'utf-8');
        const structure = JSON.parse(indexContent);
        
        return res.json({ success: true, data: structure });
    } catch (error: any) {
        console.error('Error reading docs structure:', error);
        return res.status(500).json({ success: false, error: 'Failed to load documentation structure' });
    }
});

// Get specific documentation page by slug (returns markdown content)
// Using a simple route parameter that accepts the full slug path
router.get('/page/:slug', async (req: Request, res: Response): Promise<any> => {
    try {
        const slug = req.params.slug || 'introduction';
        
        // Load the index to find the correct file
        const indexPath = path.join(DOCS_CONTENT_DIR, 'index.json');
        const indexContent = await fs.readFile(indexPath, 'utf-8');
        const structure = JSON.parse(indexContent);
        
        // Find the page in the structure
        let pageFile: string | null = null;
        let pageTitle: string = '';
        
        for (const section of structure.sections) {
            const page = section.pages.find((p: any) => p.slug === slug);
            if (page) {
                pageFile = page.file;
                pageTitle = page.title;
                break;
            }
        }
        
        if (!pageFile) {
            return res.status(404).json({ success: false, error: 'Documentation page not found' });
        }
        
        // Read the markdown content
        const pagePath = path.join(DOCS_CONTENT_DIR, pageFile);
        const markdownContent = await fs.readFile(pagePath, 'utf-8');
        
        return res.json({ 
            success: true, 
            data: {
                title: pageTitle,
                slug: slug,
                content: markdownContent,
                type: 'markdown'
            }
        });
    } catch (error: any) {
        console.error('Error reading docs page:', error);
        return res.status(500).json({ success: false, error: 'Failed to load documentation page' });
    }
});

// Search documentation
router.get('/search', async (req: Request, res: Response): Promise<any> => {
    try {
        const query = req.query.q as string;
        
        if (!query || query.trim().length < 2) {
            return res.json({ success: true, data: [] });
        }
        
        const searchResults: any[] = [];
        const searchTerm = query.toLowerCase();
        
        // Load structure
        const indexPath = path.join(DOCS_CONTENT_DIR, 'index.json');
        const indexContent = await fs.readFile(indexPath, 'utf-8');
        const structure = JSON.parse(indexContent);
        
        // Search through all pages
        for (const section of structure.sections) {
            for (const page of section.pages) {
                try {
                    const pagePath = path.join(DOCS_CONTENT_DIR, page.file);
                    const content = await fs.readFile(pagePath, 'utf-8');
                    
                    // Search in title and content
                    const titleMatch = page.title.toLowerCase().includes(searchTerm);
                    const contentMatch = content.toLowerCase().includes(searchTerm);
                    
                    if (titleMatch || contentMatch) {
                        // Extract a snippet around the search term
                        let excerpt = '';
                        if (contentMatch) {
                            const index = content.toLowerCase().indexOf(searchTerm);
                            const start = Math.max(0, index - 50);
                            const end = Math.min(content.length, index + 100);
                            excerpt = '...' + content.substring(start, end) + '...';
                        }
                        
                        searchResults.push({
                            title: page.title,
                            slug: page.slug,
                            section: section.title,
                            excerpt: excerpt || content.substring(0, 150) + '...'
                        });
                    }
                } catch (err) {
                    // Skip if file not found
                    continue;
                }
            }
        }
        
        return res.json({ success: true, data: searchResults });
    } catch (error: any) {
        console.error('Error searching docs:', error);
        return res.status(500).json({ success: false, error: 'Search failed' });
    }
});

export default router;
