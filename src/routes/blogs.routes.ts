import express, { Request, Response, Router } from 'express';
import path from 'path';
import fs from 'fs/promises';

const router: Router = express.Router();

const BLOGS_CONTENT_DIR = path.join(__dirname, '../Blogs');

interface BlogPost {
    id: string;
    title: string;
    slug: string;
    file: string;
    excerpt: string;
    author: string;
    createdAt: string;
    tags: string[];
    featured?: boolean;
}

interface BlogIndex {
    blogs: BlogPost[];
}

// Helper function to read blog index (reads fresh each time)
async function getBlogIndex(): Promise<BlogIndex> {
    const indexPath = path.join(BLOGS_CONTENT_DIR, 'index.json');
    const indexContent = await fs.readFile(indexPath, 'utf-8');
    return JSON.parse(indexContent);
}

// Get all blogs with metadata (no auth required)
router.get('/', async (req: Request, res: Response): Promise<any> => {
    try {
        const index = await getBlogIndex();
        
        // Sort by createdAt descending
        const sortedBlogs = index.blogs.sort((a, b) => 
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        
        // Find featured blog
        const featured = sortedBlogs.find(blog => blog.featured) || sortedBlogs[0] || null;
        
        return res.json({ 
            success: true, 
            data: {
                blogs: sortedBlogs,
                featured: featured
            }
        });
    } catch (error: any) {
        console.error('Error fetching blogs:', error);
        return res.status(500).json({ success: false, error: 'Failed to load blogs' });
    }
});

// Get a single blog by slug (returns markdown content)
router.get('/:slug', async (req: Request, res: Response): Promise<any> => {
    try {
        const { slug } = req.params;
        
        // Read fresh index
        const index = await getBlogIndex();
        
        // Find the blog in our index
        const blog = index.blogs.find(b => b.slug === slug);
        
        if (!blog) {
            return res.status(404).json({ success: false, error: 'Blog post not found' });
        }
        
        // Read the markdown content
        const blogPath = path.join(BLOGS_CONTENT_DIR, blog.file);
        const markdownContent = await fs.readFile(blogPath, 'utf-8');
        
        return res.json({ 
            success: true, 
            data: {
                ...blog,
                content: markdownContent
            }
        });
    } catch (error: any) {
        console.error('Error reading blog post:', error);
        return res.status(500).json({ success: false, error: 'Failed to load blog post' });
    }
});

// Search blogs
router.get('/search', async (req: Request, res: Response): Promise<any> => {
    try {
        const query = req.query.q as string;
        
        if (!query || query.trim().length < 2) {
            return res.json({ success: true, data: [] });
        }
        
        const searchTerm = query.toLowerCase();
        const index = await getBlogIndex();
        const searchResults: BlogPost[] = [];
        
        // Search through all blogs
        for (const blog of index.blogs) {
            const titleMatch = blog.title.toLowerCase().includes(searchTerm);
            const excerptMatch = blog.excerpt.toLowerCase().includes(searchTerm);
            const tagMatch = blog.tags.some(tag => tag.toLowerCase().includes(searchTerm));
            
            if (titleMatch || excerptMatch || tagMatch) {
                searchResults.push(blog);
            }
        }
        
        return res.json({ success: true, data: searchResults });
    } catch (error: any) {
        console.error('Error searching blogs:', error);
        return res.status(500).json({ success: false, error: 'Search failed' });
    }
});

export default router;
