import express, { Request, Response, Router } from 'express';
import * as ds from '../DataStructures';
import httpProxy from 'http-proxy';
import { IncomingMessage, ServerResponse } from 'http';

const router: Router = express.Router();

const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    timeout: 30000,
    proxyTimeout: 30000
});

export const pendingRetries = new Map<string, {
    req: Request;
    res: Response;
    target: string;
    originalUrl: string;
    retryCount: number;
    maxRetries: number;
    retryDelay: number;
}>();

const MAX_RETRIES = 50;
const RETRY_DELAY = 500;
const MAX_RETRY_DELAY = 10000;

proxy.on('error', (err: any, req: any, res: any) => {
    console.error('Proxy error:', err);

    const requestKey = req.__retryKey;

    const isRetryableError = err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.message?.includes('connect') ||
        err.message?.includes('ECONNREFUSED');

    if (requestKey && isRetryableError) {
        const retryInfo = pendingRetries.get(requestKey);

        if (retryInfo && !res.headersSent) {
            retryInfo.retryCount++;
            const delay = Math.min(
                retryInfo.retryDelay * Math.pow(2, retryInfo.retryCount - 1),
                MAX_RETRY_DELAY
            );

            console.log(`[Terminal Proxy Retry] Attempt ${retryInfo.retryCount} failed for ${retryInfo.target}. Retrying in ${delay}ms...`);

            setTimeout(() => {
                if (retryInfo.res.writable && !retryInfo.res.headersSent) {
                    try {
                        retryInfo.req.url = retryInfo.originalUrl;
                        proxy.web(retryInfo.req, retryInfo.res, {
                            target: retryInfo.target
                        });
                    } catch (retryError) {
                        console.error('Error during retry attempt:', retryError);
                    }
                }
            }, delay);
            return;
        }
    }

    if (!res || res.headersSent) {
        return;
    }

    try {
        if (typeof res.status === 'function') {
            res.status(502).json({
                success: false,
                error: 'Failed to connect to terminal server',
                message: err.message
            });
        } else if (typeof res.writeHead === 'function') {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to connect to terminal server',
                message: err.message
            }));
        }
    } catch (writeError) {
        console.error('Failed to send error response:', writeError);
    }
});

proxy.on('proxyRes', (proxyRes: any, req: any, res: any) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    const requestKey = (req as any).__retryKey;
    if (requestKey) {
        pendingRetries.delete(requestKey);
    }
});

function proxyWithRetry(req: Request, res: Response, target: string, originalUrl: string, id: string, maxRetries: number = MAX_RETRIES): void {
    const requestKey = id;
    (req as any).__retryKey = requestKey;

    pendingRetries.set(requestKey, {
        req,
        res,
        target,
        originalUrl,
        retryCount: 0,
        maxRetries,
        retryDelay: RETRY_DELAY
    });

    try {
        req.url = originalUrl;
        proxy.web(req, res, { target });
    } catch (error: any) {
        console.error('Error initiating proxy request:', error);
    }
}

router.all('/resolve-terminal/token', (req: Request, res: Response): void => {
    const referer = req.headers.referer || req.headers.referrer;
    let terminalUrl: string | undefined;

    if (referer) {
        try {
            const refererStr = Array.isArray(referer) ? referer[0] : referer;
            if (refererStr) {
                const refererUrl = new URL(refererStr);
                const id = refererUrl.searchParams.get('id');

                if (id) {
                    const taskData = ds.taskId_task.get(id);
                    terminalUrl = taskData?.userDockerTerminalUrl;
                    if (!terminalUrl) {
                        res.status(400).json({
                            success: false,
                            error: 'Unable to determine terminal from Referer header'
                        });
                        return;
                    }
                    proxyWithRetry(req, res, terminalUrl as any, '/token', id as any);
                }

            }
        } catch (e) {
            console.error('Error parsing referer for /token:', e);
        }
    }



    console.log(`[Terminal Proxy Token] Proxying /token request to terminal: ${terminalUrl}`);


});

router.all('/resolve-terminal', (req: Request, res: Response): void => {
    const id = req.query.id as string;
    if (!id) {
        res.status(400).json({
            success: false,
            error: ' ID is required. Please provide "id" as a query parameter.'
        });
        return;
    }

    const taskData = ds.taskId_task.get(id);
    if (!taskData) {
        res.status(404).json({
            success: false,
            error: `Task with ID "${id}" not found.`
        });
        return;
    }

    const terminalUrl = taskData.userDockerTerminalUrl;
    if (!terminalUrl) {
        res.status(404).json({
            success: false,
            error: `Terminal URL not found for task "${id}". Terminal may not be initialized yet.`
        });
        return;
    }

    console.log(`[Terminal Proxy] Proxying request for task ${id} to terminal: ${terminalUrl}`);

    proxyWithRetry(req, res, terminalUrl, '/',id);
});


export default router;
export { proxy };