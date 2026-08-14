import { Server, Socket } from 'socket.io';
import { TaskService } from './TaskService';
import { coldKillTask } from './SetupWorkspace';
import { PromptExecutionService } from './PromptExecutionService';
import { Logger } from '../utils/Logger';

const logger = new Logger('TaskQueueService');
export enum TaskAction {
    Start = 'start',
    Setup = 'setup',
    Kill = 'kill',
    Transfer = 'transfer',
    Abort = 'abort',
    ColdKill = 'coldKill',
    ExecutePrompt = 'executePrompt',
}

export interface TaskQueueItem {
    socket: Socket;
    io?: Server;
    data: any;
    action: TaskAction;
    activeControllers?: Map<string, AbortController>;
    callback: (...args: any[]) => void;
}

class QueueNode<T> {
    value: T;
    next: QueueNode<T> | null = null;
    constructor(value: T) {
        this.value = value;
    }
}

class Queue<T> {
    private head: QueueNode<T> | null = null;
    private tail: QueueNode<T> | null = null;
    private _size = 0;

    enqueue(item: T): void {
        const node = new QueueNode(item);
        if (this.tail) {
            this.tail.next = node;
            this.tail = node;
        } else {
            this.head = this.tail = node;
        }
        this._size++;
    }

    dequeue(): T | undefined {
        if (!this.head) return undefined;
        const value = this.head.value;
        this.head = this.head.next;
        if (!this.head) this.tail = null;
        this._size--;
        return value;
    }

    peek(): T | undefined {
        return this.head?.value;
    }

    get size(): number {
        return this._size;
    }

    get isEmpty(): boolean {
        return this._size === 0;
    }
}

interface TaskQueueState {
    queue: Queue<TaskQueueItem>;
    processing: boolean;
}

//taskId -> queue Map
const taskQueues: Map<string, TaskQueueState> = new Map();

function getOrCreateState(taskId: string): TaskQueueState {
    let state = taskQueues.get(taskId);
    if (!state) {
        state = { queue: new Queue<TaskQueueItem>(), processing: false };
        taskQueues.set(taskId, state);
    }
    return state;
}

//we can add other taskactions directly here later 
async function executeAction(item: TaskQueueItem): Promise<any> {
    switch (item.action) {
        case TaskAction.Setup:
            return TaskService.setupTask(item.data, item.socket);
        case TaskAction.Start:
            return TaskService.startTask(item.data, item.socket, item.io!);
        case TaskAction.Transfer:
            return TaskService.transferTask(item.data, item.socket, item.io!);
        case TaskAction.Kill:
            return TaskService.killTask(item.data, item.socket);
        case TaskAction.Abort:
            return TaskService.abortTask(item.data, item.socket);
        case TaskAction.ColdKill:
            return coldKillTask(item.socket,item?.data?.taskId);
        case TaskAction.ExecutePrompt:
            return PromptExecutionService.executePromptWorkspace(item.data, item.socket, item.activeControllers!, logger);
        default:
            throw new Error(`Unknown task action: ${item.action}`);
    }
}

async function  processQueue(taskId: string): Promise<void> {
    const state = taskQueues.get(taskId);
    if (!state || state.processing) return;

    state.processing = true;

    while (!state.queue.isEmpty) {
        const item = state.queue.dequeue()!;
        try {
            const result = await executeAction(item);
            item.callback(result);
        } catch (error) {
            logger.error(`Error processing ${item.action} for task ${taskId}:`, error);
            item.callback({ success: false, error: (error as Error).message });
        }
    }

    state.processing = false;
    if (state.queue.isEmpty) {
        taskQueues.delete(taskId);
    }
}



export class TaskQueueService {

    static enqueue(taskId: string, item: TaskQueueItem): void {
        const state = getOrCreateState(taskId);
        state.queue.enqueue(item);
        processQueue(taskId);
    }
}
