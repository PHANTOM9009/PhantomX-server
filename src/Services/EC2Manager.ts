// this file will manage the EC2 instances for running user tasks
import { EC2Service } from './EC2Service';
import * as dotenv from 'dotenv';
dotenv.config();

import * as ds from '../DataStructures';
import { EC2 } from '@aws-sdk/client-ec2';

let ec2ServiceInstance = new EC2Service();

function getMaxWorkersPerEc2(ec2Type: ds.EC2Type): number {
    if (ec2Type === ds.EC2Type.Indexer) {
        return parseInt(process.env.MAX_WORKERS_PER_EC2_INDEXER || process.env.MAX_WORKERS_PER_EC2 || '2');
    }
    return parseInt(process.env.MAX_WORKERS_PER_EC2 || '2');
}



export async function getEC2Instance(taskId: string, ec2Type: ds.EC2Type): Promise<ds.Ec2Details | any> { //here taskId and wpId will be analogous to each other

    try {
        // Determine which pool to use based on EC2 type
        const targetPool = ec2Type === ds.EC2Type.Indexer ? ds.FreeIndexerEc2Pool : ds.FreeEc2Pool;

        console.log("current EC2 status==>\n free EC2=>" + ds.FreeEc2Pool.size() + " \n total EC2 ==>" + ds.Ec2Id_Map.size);
        //check the current queue if, it has any free instances then use that.
        if (targetPool.size() > 0) {
            // in this case just take the ip address of that machine along with the id of the instance and return it and update its value in the queue
            // pop() gets the EC2 instance with LEAST running tasks (min heap)

            let ec2Data: ds.Ec2Details = targetPool.pop() as ds.Ec2Details;
            ec2Data.numberOfRunningTasks += 1;

            if (ec2Data.numberOfRunningTasks < getMaxWorkersPerEc2(ec2Type)) {
                ec2Data.runningTaskIds?.push(taskId);
                targetPool.push(ec2Data); // push it back, heap will reorder automatically

            }
            return ec2Data;




        }
        else {
            // we have to start the new EC2 instance and add it in the queue and return its details
           // console.log("going to start new instances...");
            let result = await ec2ServiceInstance.createInstance(
                {
                    amiId: process.env.EC2_AMI_ID as any,
                    instanceType: ec2Type === ds.EC2Type.Task ? process.env.EC2_INSTANCE_TYPE : process.env.INDEXER_INSTANCE_TYPE as any,
                    keyName: process.env.EC2_KEY_NAME as any,
                    securityGroupIds: (process.env.EC2_SECURITY_GROUP_IDS as any).split(','),
                    userData: "",
                    volumeSize: 16, // 16GB root volume
                    volumeType: 'gp3', // gp3 is faster and cheaper than gp2
                    waitForUserData: true,       // ✅ Wait for UserData script completion
                    userDataTimeout: 600000,     // 10 minutes timeout
                    tags: [
                        { Key: 'Name', Value: ec2Type === ds.EC2Type.Task ? 'DevInstance' : 'IndexerInstance' },
                        { Key: 'Environment', Value: 'Development' },
                        { Key: 'CreatedBy', Value: 'EC2Service' }
                    ]

                }
            );

            if (!result.success) {
                console.error("Error creating EC2 instance:", result.error);
                return {
                    error: result.error
                }
            }
            // now we have the empty instance which has all the things which is required
            let ec2Details: ds.Ec2Details = {
                EC2Type: ec2Type,
                instanceId: result.instanceId as string,
                publicIp: result.ipAddress as string,
                publicDns: result.publicDns as string,
                startedAt: new Date(),
                region: result.region as string,
                numberOfRunningTasks: 1,
                runningTaskIds: [taskId]
            };

            // Push to the appropriate pool based on EC2 type
            // Heap will automatically maintain min heap property
            ds.Ec2Id_Map.set(result.instanceId as any, ec2Details);

            if (ec2Type === ds.EC2Type.Indexer) {
                ds.FreeIndexerEc2Pool.push(ec2Details);
            } else {
                ds.FreeEc2Pool.push(ec2Details);
            }

            return ec2Details;



        }
    }
    catch (ex) {

        console.log("\n error in getEc2Instance==>",ex);
    }
}

/**
 * Release an EC2 instance back to the appropriate pool after a task completes
 * @param instanceId - The EC2 instance ID to release
 * @param taskId - The task ID that was using the instance
 * @param ec2Type - Type of EC2 instance (Task or Indexer)
 */
export async function releaseEC2Instance(instanceId: string, taskId: string, ec2Type: ds.EC2Type): Promise<boolean> {
    try {
        // Determine which pool to use based on EC2 type
        const targetPool = ec2Type === ds.EC2Type.Indexer ? ds.FreeIndexerEc2Pool : ds.FreeEc2Pool;

        // Find the instance in the Ec2 map
        let instance: any = ds.Ec2Id_Map.get(instanceId);
        instance.numberOfRunningTasks = instance?.numberOfRunningTasks - 1;

        instance.runningTaskIds = (instance.runningTaskIds as string[]).filter((task: string): boolean => task !== taskId);

        if (!targetPool.has(instanceId)) {
            targetPool.push(instance);
        }
        console.log("successfully released Ec2=>" + instanceId + " for the task=>" + taskId);
        return true;

    } catch (error) {
        console.error(`Error releasing EC2 instance ${instanceId}:`, error);
        return false;
    }
}

/**
 * Get pool statistics for monitoring
 */
export function getPoolStatistics(): {
    task: { total: number; available: number; inUse: number };
    indexer: { total: number; available: number; inUse: number };
} {
    const taskPoolArray = ds.FreeEc2Pool.toArray();
    const taskStats = {
        total: ds.FreeEc2Pool.size(),
        available: taskPoolArray.filter(ec2 => ec2.numberOfRunningTasks < getMaxWorkersPerEc2(ds.EC2Type.Task)).length,
        inUse: taskPoolArray.reduce((sum, ec2) => sum + ec2.numberOfRunningTasks, 0)
    };

    const indexerPoolArray = ds.FreeIndexerEc2Pool.toArray();
    const indexerStats = {
        total: ds.FreeIndexerEc2Pool.size(),
        available: indexerPoolArray.filter(ec2 => ec2.numberOfRunningTasks < getMaxWorkersPerEc2(ds.EC2Type.Indexer)).length,
        inUse: indexerPoolArray.reduce((sum, ec2) => sum + ec2.numberOfRunningTasks, 0)
    };

    return {
        task: taskStats,
        indexer: indexerStats
    };
}

// (async()=>{
// let ec2 = new EC2Service();
//  let result = await ec2ServiceInstance.createInstance(
//             {
//                 amiId: process.env.EC2_AMI_ID as any,
//                 instanceType: process.env.EC2_INSTANCE_TYPE as any,
//                 keyName: process.env.EC2_KEY_NAME as any,
//                 securityGroupIds: (process.env.EC2_SECURITY_GROUP_IDS as any).split(','),
//                 userData: "",
//                 tags:[
//                     { Key:'Name',Value: 'DevInstance'},
//                     {Key: 'Environment',Value: 'Development'},
//                     {Key: 'CreatedBy', Value:  'EC2Service'}
//                 ]

//             }
//         );

// })();
