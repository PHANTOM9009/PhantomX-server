import { Ec2Details } from '../DataStructures';

/**
 * Indexed Heap - supports both Min and Max heap
 * O(log n) for push, pop, update, remove
 * O(1) for get, has
 */
export class IndexedHeap {
    private heap: Ec2Details[] = [];
    private indexMap: Map<string, number> = new Map();
    private isMaxHeap: boolean;
    
    constructor(isMaxHeap: boolean = true) {
        this.isMaxHeap = isMaxHeap; // true = max heap (most tasks at top)
    }
    
    size(): number { return this.heap.length; }
    isEmpty(): boolean { return this.heap.length === 0; }
    peek(): Ec2Details | undefined { return this.heap[0]; }
    
    push(instance: Ec2Details): void {
        this.heap.push(instance);
        this.indexMap.set(instance.instanceId, this.heap.length - 1);
        this.bubbleUp(this.heap.length - 1);
    }
    
    pop(): Ec2Details | undefined {
        if (this.heap.length === 0) return undefined;
        
        const top = this.heap[0];
        this.indexMap.delete(top.instanceId);
        const last = this.heap.pop()!;
        
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.indexMap.set(last.instanceId, 0);
            this.bubbleDown(0);
        }
        
        return top;
    }
    
    // O(log n) - Remove by instanceId
    remove(instanceId: string): Ec2Details | undefined {
        const index = this.indexMap.get(instanceId);
        if (index === undefined) return undefined;
        
        const removed = this.heap[index];
        this.indexMap.delete(instanceId);
        const last = this.heap.pop()!;
        
        if (index < this.heap.length) {
            const oldValue = this.heap[index].numberOfRunningTasks;
            this.heap[index] = last;
            this.indexMap.set(last.instanceId, index);
            
            if (this.shouldGoUp(last.numberOfRunningTasks, oldValue)) {
                this.bubbleUp(index);
            } else {
                this.bubbleDown(index);
            }
        }
        
        return removed;
    }
    
    // O(log n) - Update and reheapify
    update(instanceId: string, updateFn: (instance: Ec2Details) => void): boolean {
        const index = this.indexMap.get(instanceId);
        if (index === undefined) return false;
        
        const instance = this.heap[index];
        const oldValue = instance.numberOfRunningTasks;
        updateFn(instance);
        
        if (this.shouldGoUp(instance.numberOfRunningTasks, oldValue)) {
            this.bubbleUp(index);
        } else if (instance.numberOfRunningTasks !== oldValue) {
            this.bubbleDown(index);
        }
        
        return true;
    }
    
    // O(1) - Check if exists
    has(instanceId: string): boolean {
        return this.indexMap.has(instanceId);
    }
    
    // O(1) - Get by ID
    get(instanceId: string): Ec2Details | undefined {
        const index = this.indexMap.get(instanceId);
        return index !== undefined ? this.heap[index] : undefined;
    }
    
    toArray(): Ec2Details[] {
        return [...this.heap];
    }
    
    clear(): void {
        this.heap = [];
        this.indexMap.clear();
    }
    
    init(instances: Ec2Details[]): void {
        this.heap = [...instances];
        this.indexMap.clear();
        
        for (let i = 0; i < this.heap.length; i++) {
            this.indexMap.set(this.heap[i].instanceId, i);
        }
        
        for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
            this.bubbleDown(i);
        }
    }
    
    private shouldGoUp(newVal: number, oldVal: number): boolean {
        // Max heap: if value increased, bubble up
        // Min heap: if value decreased, bubble up
        return this.isMaxHeap ? (newVal > oldVal) : (newVal < oldVal);
    }
    
    private compare(a: number, b: number): boolean {
        // Max heap: a > b (parent should be greater)
        // Min heap: a < b (parent should be smaller)
        return this.isMaxHeap ? (a > b) : (a < b);
    }
    
    private bubbleUp(index: number): void {
        const element = this.heap[index];
        
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            const parent = this.heap[parentIndex];
            
            if (!this.compare(element.numberOfRunningTasks, parent.numberOfRunningTasks)) break;
            
            this.heap[index] = parent;
            this.indexMap.set(parent.instanceId, index);
            index = parentIndex;
        }
        
        this.heap[index] = element;
        this.indexMap.set(element.instanceId, index);
    }
    
    private bubbleDown(index: number): void {
        const length = this.heap.length;
        const element = this.heap[index];
        
        while (true) {
            let targetIndex = index;
            const leftChild = 2 * index + 1;
            const rightChild = 2 * index + 2;
            
            if (leftChild < length && 
                this.compare(this.heap[leftChild].numberOfRunningTasks, this.heap[targetIndex].numberOfRunningTasks)) {
                targetIndex = leftChild;
            }
            
            if (rightChild < length && 
                this.compare(this.heap[rightChild].numberOfRunningTasks, this.heap[targetIndex].numberOfRunningTasks)) {
                targetIndex = rightChild;
            }
            
            if (targetIndex === index) break;
            
            const child = this.heap[targetIndex];
            this.heap[index] = child;
            this.indexMap.set(child.instanceId, index);
            index = targetIndex;
        }
        
        this.heap[index] = element;
        this.indexMap.set(element.instanceId, index);
    }
}
