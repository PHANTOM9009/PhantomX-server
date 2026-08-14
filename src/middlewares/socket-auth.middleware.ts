import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

export const socketAuthMiddleware = (socket: Socket, next: (err?: Error) => void) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
        return next(new Error('Authentication token required'));
    }

    jwt.verify(token as string, JWT_SECRET, (err: any, decoded: any) => {
        if (err) {
            return next(new Error('Invalid or expired token'));
        }

        socket.data.user = {
            userName: decoded.userName,
            userId: decoded.userId,
            email: decoded.userName.includes('@') ? decoded.userName : "",
        };

        next();
    });
};