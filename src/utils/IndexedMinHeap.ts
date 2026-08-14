/**
 * Indexed Min Heap for EC2 Pool Management
 * 
 * This implementation provides O(log n) operations for:
 * - Insert
 * - Delete minimum
 * - Delete by ID
 * - Update by ID
 * 
 * It maintains a Map to track element positions for efficient lookups.
 */

import { Ec2Details } from '../DataStructures';

export class IndexedMinHeap {
    private heap: Ec2Details[] = [];
    private indexMap: Map<string, number> = new Map(); // instanceId -> heap index
    
    constructor() {}
    
    /**
     * Get the number of elements in the heap
     * Time: O(1)
     */
    size(): number {
        return this.heap.length;
    }
    
    /**
     * Check if heap is empty
     * Time: O(1)
     */
    isEmpty(): boolean {
        return this.heap.length === 0;
    }
    
    /**
     * Get the minimum element without removing it
     * Time: O(1)
     */
    peek(): Ec2Details | undefined {
        return this.heap[0];
    }
    
    /**
     * Add an element to the heap
     * Time: O(log n)
     */
    push(instance: Ec2Details): void {
        this.heap.push(instance);
        const index = this.heap.length - 1;
        this.indexMap.set(instance.instanceId, index);
        this.bubbleUp(index);
    }
    
    /**
     * Remove and return the minimum element
     * Time: O(log n)
     */
    pop(): Ec2Details | undefined {
        if (this.heap.length === 0) return undefined;
        
        const min = this.heap[0];
        this.indexMap.delete(min.instanceId);
        
        const last = this.heap.pop()!;
        
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.indexMap.set(last.instanceId, 0);
            this.bubbleDown(0);
        }
        
        return min;
    }
    
    /**
     * Remove an element by instanceId
     * Time: O(log n)
     */
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
            
            // Decide whether to bubble up or down
            if (last.numberOfRunningTasks < oldValue) {
                this.bubbleUp(index);
            } else {
                this.bubbleDown(index);
            }
        }
        
        return removed;
    }
    
    /**
     * Update an instance and maintain heap property
     * Time: O(log n)
     */
    update(instanceId: string, updateFn: (instance: Ec2Details) => void): boolean {
        const index = this.indexMap.get(instanceId);
        if (index === undefined) return false;
        
        const instance = this.heap[index];
        const oldValue = instance.numberOfRunningTasks;
        
        updateFn(instance);
        
        // Reorder heap based on change
        if (instance.numberOfRunningTasks < oldValue) {
            this.bubbleUp(index);
        } else if (instance.numberOfRunningTasks > oldValue) {
            this.bubbleDown(index);
        }
        
        return true;
    }
    
    /**
     * Check if an instance exists in the heap
     * Time: O(1)
     */
    has(instanceId: string): boolean {
        return this.indexMap.has(instanceId);
    }
    
    /**
     * Get an instance by ID without removing it
     * Time: O(1)
     */
    get(instanceId: string): Ec2Details | undefined {
        const index = this.indexMap.get(instanceId);
        return index !== undefined ? this.heap[index] : undefined;
    }
    
    /**
     * Convert heap to array (not sorted)
     * Time: O(n)
     */
    toArray(): Ec2Details[] {
        return [...this.heap];
    }
    
    /**
     * Clear all elements
     * Time: O(1)
     */
    clear(): void {
        this.heap = [];
        this.indexMap.clear();
    }
    
    /**
     * Initialize heap from array
     * Time: O(n)
     */
    init(instances: Ec2Details[]): void {
        this.heap = [...instances];
        this.indexMap.clear();
        
        // Build index map
        for (let i = 0; i < this.heap.length; i++) {
            this.indexMap.set(this.heap[i].instanceId, i);
        }
        
        // Heapify: start from last parent and bubble down
        for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
            this.bubbleDown(i);
        }
    }
    
    // ============ Private Helper Methods ============
    
    private bubbleUp(index: number): void {
        const element = this.heap[index];
        
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            const parent = this.heap[parentIndex];
            
            if (element.numberOfRunningTasks >= parent.numberOfRunningTasks) {
                break;
            }
            
            // Swap with parent
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
            let minIndex = index;
            const leftChild = 2 * index + 1;
            const rightChild = 2 * index + 2;
            
            if (leftChild < length && 
                this.heap[leftChild].numberOfRunningTasks < this.heap[minIndex].numberOfRunningTasks) {
                minIndex = leftChild;
            }
            
            if (rightChild < length && 
                this.heap[rightChild].numberOfRunningTasks < this.heap[minIndex].numberOfRunningTasks) {
                minIndex = rightChild;
            }
            
            if (minIndex === index) break;
            
            // Swap with minimum child
            const child = this.heap[minIndex];
            this.heap[index] = child;
            this.indexMap.set(child.instanceId, index);
            
            index = minIndex;
        }
        
        this.heap[index] = element;
        this.indexMap.set(element.instanceId, index);
    }
    
    /**
     * Validate heap property (for testing)
     */
    validate(): boolean {
        for (let i = 0; i < Math.floor(this.heap.length / 2); i++) {
            const leftChild = 2 * i + 1;
            const rightChild = 2 * i + 2;
            
            if (leftChild < this.heap.length && 
                this.heap[i].numberOfRunningTasks > this.heap[leftChild].numberOfRunningTasks) {
                return false;
            }
            
            if (rightChild < this.heap.length && 
                this.heap[i].numberOfRunningTasks > this.heap[rightChild].numberOfRunningTasks) {
                return false;
            }
        }
        
        // Validate index map
        for (const [instanceId, index] of this.indexMap.entries()) {
            if (this.heap[index].instanceId !== instanceId) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Debug print heap state
     */
    debug(name: string = 'Heap'): void {
        console.log(`\n=== ${name} Debug ===`);
        console.log(`Size: ${this.size()}`);
        console.log(`Min: ${this.peek()?.instanceId} (${this.peek()?.numberOfRunningTasks} tasks)`);
        console.log('All instances:');
        this.heap.forEach((ec2, idx) => {
            console.log(`  [${idx}] ${ec2.instanceId}: ${ec2.numberOfRunningTasks} tasks`);
        });
        console.log(`Valid: ${this.validate()}`);
        console.log('==================\n');
    }
}
