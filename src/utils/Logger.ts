import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    SUCCESS = 2,
    WARN = 3,
    ERROR = 4,
    NONE = 5
}

export class Logger {
    private context: string;
    private static globalLogLevel: LogLevel = LogLevel.INFO;
    public userId: string = "";
    public organizationId: string = "";
    private static serverMode: number = 0; // 0 = dev (console), 1 = prod (file)
    private static logFilePath: string = '';


    constructor(context: string, userId?: string, organizationId?: string) {
        this.context = context;
        this.userId = userId as any;
        this.organizationId = organizationId as any;
    }

    static setGlobalLogLevel(level: LogLevel): void {
        Logger.globalLogLevel = level;
    }

    static setServerMode(mode: number): void {
        Logger.serverMode = mode;
        Logger.logFilePath = process.env.SERVER_LOG_FILE || '/tmp/server-logs.log';
        
        // If in production mode and log file path is set, ensure directory exists
        if (Logger.serverMode === 1 && Logger.logFilePath) {
            const logDir = path.dirname(Logger.logFilePath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }
    }

    static getServerMode(): number {
        return Logger.serverMode;
    }

    private getTimestamp(): string {
        const now = new Date();
        return now.toISOString();
    }

    private formatMessage(level: string, message: string, data?: any): string {
        const timestamp = this.getTimestamp();
        let formattedMsg = `[${timestamp}] [${level}] [${this.context}] ${message}`;

        if (data !== undefined) {
            formattedMsg += ` ${typeof data === 'object' ? JSON.stringify(data) : data}`;
        }

        return formattedMsg;
    }

    private writeLog(message: string): void {
        // Production mode: write to file
            if (Logger.logFilePath) {
                try {
                    // Append to log file with newline
                    fs.appendFileSync(Logger.logFilePath, message + '\n', 'utf8');
                } catch (error) {
                    // Fallback to console if file writing fails
                    console.error('Failed to write to log file:', error);
                    console.log(message);
                }
            } else {
                // Fallback to console if no log file path is configured
                console.log(message);
            }
        
    }

    debug(message: string, data?: any): void {
        if (Logger.globalLogLevel <= LogLevel.DEBUG) {
            const formattedMsg = this.formatMessage('DEBUG', message, data);
            if (Logger.serverMode === 0) {
                console.log(chalk.gray(formattedMsg));
            } else {
                this.writeLog(formattedMsg);
            }
        }
    }

    info(message: string, data?: any): void {
        if (Logger.globalLogLevel <= LogLevel.INFO) {
            const formattedMsg = this.formatMessage('INFO', message, data);
            if (Logger.serverMode === 0) {
                console.log(chalk.blue(formattedMsg));
            } else {
                this.writeLog(formattedMsg);
            }
        }
    }

    success(message: string, data?: any): void {
        if (Logger.globalLogLevel <= LogLevel.SUCCESS) {
            const formattedMsg = this.formatMessage('SUCCESS', message, data);
            if (Logger.serverMode === 0) {
                console.log(chalk.green(formattedMsg));
            } else {
                this.writeLog(formattedMsg);
            }
        }
    }

    warn(message: string, data?: any): void {
        if (Logger.globalLogLevel <= LogLevel.WARN) {
            const formattedMsg = this.formatMessage('WARN', message, data);
            if (Logger.serverMode === 0) {
                console.log(chalk.yellow(formattedMsg));
            } else {
                this.writeLog(formattedMsg);
            }
        }
    }

    error(message: string, error?: any): void {
        if (Logger.globalLogLevel <= LogLevel.ERROR) {
            const errorMsg = error instanceof Error
                ? `${error.message}\n${error.stack}`
                : error;
            const formattedMsg = this.formatMessage('ERROR', message, errorMsg);
            if (Logger.serverMode === 0) {
                console.error(chalk.red(formattedMsg));
            } else {
                this.writeLog(formattedMsg);
            }
        }
    }

    // Shorthand for logging operation start
    operation(operation: string): void {
        this.info(`Starting operation: ${operation}`);
    }

    // Shorthand for logging operation completion
    operationComplete(operation: string, duration?: number): void {
        const msg = duration
            ? `${operation} completed in ${duration}ms`
            : `${operation} completed`;
        this.success(msg);
    }
}

// Export a factory function for convenience
export const createLogger = (context: string): Logger => new Logger(context);
