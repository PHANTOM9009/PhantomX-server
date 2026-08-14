/**
 * Heap Helper Utilities for EC2 Pool Management
 * 
 * This file provides utility functions for working with Heap-based EC2 pools.
 * The EC2 pools use min heaps to always get the instance with the least running tasks.
 */

import { Heap } from 'heap-js';
import { Ec2Details } from '../DataStructures';

/**
 * Find an EC2 instance in a heap by instance ID
 * @param heap - The heap to search in
 * @param instanceId - The instance ID to find
 * @returns The EC2 instance if found, undefined otherwise
 */
export function findInstanceInHeap(
    heap: Heap<Ec2Details>, 
    instanceId: string
): Ec2Details | undefined {
    return heap.toArray().find(ec2 => ec2.instanceId === instanceId);
}

/**
 * Update an EC2 instance in the heap and maintain heap property
 * @param heap - The heap containing the instance
 * @param instanceId - The instance ID to update
 * @param updateFn - Function to update the instance
 * @returns true if instance was found and updated, false otherwise
 */
export function updateInstanceInHeap(
    heap: Heap<Ec2Details>,
    instanceId: string,
    updateFn: (instance: Ec2Details) => void
): boolean {
    const heapArray = heap.toArray();
    const instance = heapArray.find(ec2 => ec2.instanceId === instanceId);
    
    if (!instance) {
        return false;
    }
    
    updateFn(instance);
    heap.init(heapArray); // Rebuild heap to maintain heap property
    return true;
}

/**
 * Remove an EC2 instance from the heap
 * @param heap - The heap to remove from
 * @param instanceId - The instance ID to remove
 * @returns The removed instance if found, undefined otherwise
 */
export function removeInstanceFromHeap(
    heap: Heap<Ec2Details>,
    instanceId: string
): Ec2Details | undefined {
    const heapArray = heap.toArray();
    const index = heapArray.findIndex(ec2 => ec2.instanceId === instanceId);
    
    if (index === -1) {
        return undefined;
    }
    
    const [removed] = heapArray.splice(index, 1);
    heap.init(heapArray); // Rebuild heap
    return removed;
}

/**
 * Get all instances from heap that match a condition
 * @param heap - The heap to filter
 * @param predicate - Filter function
 * @returns Array of matching instances
 */
export function filterHeapInstances(
    heap: Heap<Ec2Details>,
    predicate: (instance: Ec2Details) => boolean
): Ec2Details[] {
    return heap.toArray().filter(predicate);
}

/**
 * Get the instance with the least running tasks without removing it
 * @param heap - The heap to peek at
 * @returns The instance with least tasks, or undefined if heap is empty
 */
export function peekLeastLoadedInstance(
    heap: Heap<Ec2Details>
): Ec2Details | undefined {
    return heap.peek();
}

/**
 * Get heap statistics
 * @param heap - The heap to analyze
 * @param maxTasksPerInstance - Maximum tasks per instance
 * @returns Statistics object
 */
export function getHeapStatistics(
    heap: Heap<Ec2Details>,
    maxTasksPerInstance: number = 2
): {
    total: number;
    available: number;
    inUse: number;
    minLoad: number;
    maxLoad: number;
    avgLoad: number;
} {
    const instances = heap.toArray();
    const total = heap.size();
    const available = instances.filter(
        ec2 => ec2.numberOfRunningTasks < maxTasksPerInstance
    ).length;
    const inUse = instances.reduce((sum, ec2) => sum + ec2.numberOfRunningTasks, 0);
    
    const loads = instances.map(ec2 => ec2.numberOfRunningTasks);
    const minLoad = loads.length > 0 ? Math.min(...loads) : 0;
    const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;
    const avgLoad = loads.length > 0 ? inUse / total : 0;
    
    return {
        total,
        available,
        inUse,
        minLoad,
        maxLoad,
        avgLoad
    };
}

/**
 * Check if heap has capacity for new tasks
 * @param heap - The heap to check
 * @param maxTasksPerInstance - Maximum tasks per instance
 * @returns true if heap has capacity, false otherwise
 */
export function hasCapacity(
    heap: Heap<Ec2Details>,
    maxTasksPerInstance: number = 2
): boolean {
    if (heap.size() === 0) {
        return false;
    }
    
    const leastLoaded = heap.peek();
    return leastLoaded !== undefined && 
           leastLoaded.numberOfRunningTasks < maxTasksPerInstance;
}

/**
 * Debug: Print heap state
 * @param heap - The heap to print
 * @param name - Name of the heap for logging
 */
export function debugPrintHeap(heap: Heap<Ec2Details>, name: string = 'Heap'): void {
    console.log(`\n=== ${name} Debug Info ===`);
    console.log(`Size: ${heap.size()}`);
    
    if (heap.size() === 0) {
        console.log('Empty heap');
        return;
    }
    
    console.log('Top (least loaded):', heap.peek());
    console.log('All instances:');
    heap.toArray()
        .sort((a, b) => a.numberOfRunningTasks - b.numberOfRunningTasks)
        .forEach(ec2 => {
            console.log(`  ${ec2.instanceId}: ${ec2.numberOfRunningTasks} tasks, IP: ${ec2.publicIp}`);
        });
    console.log('===================\n');
}

/**
 * Validate heap integrity (for testing/debugging)
 * @param heap - The heap to validate
 * @returns true if heap is valid min heap, false otherwise
 */
export function validateMinHeap(heap: Heap<Ec2Details>): boolean {
    const arr = heap.toArray();
    
    for (let i = 0; i < arr.length; i++) {
        const leftChild = 2 * i + 1;
        const rightChild = 2 * i + 2;
        
        if (leftChild < arr.length && 
            arr[i].numberOfRunningTasks > arr[leftChild].numberOfRunningTasks) {
            return false;
        }
        
        if (rightChild < arr.length && 
            arr[i].numberOfRunningTasks > arr[rightChild].numberOfRunningTasks) {
            return false;
        }
    }
    
    return true;
}
