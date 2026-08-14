import cron, { ScheduledTask } from 'node-cron';
import * as ds from './../DataStructures';
import { Logger } from '../utils/Logger';
import * as dotenv from "dotenv";
import { EC2Service } from './EC2Service';
import { EC2Type } from './../DataStructures';
dotenv.config();


export class EC2Reaper {
    public logger: Logger;
    cronTask: ScheduledTask | null = null;

    constructor() {
        this.logger = new Logger('EC2ReaperService');
    }
    async EC2Reaper() {
        try {
            let ec2Service = new EC2Service();
            for (const [key, value] of ds.Ec2Id_Map) {
                if (value.EC2Type === EC2Type.Task? (ds.FreeEc2Pool.size() >= (process.env.MAX_DEV_INSTANCES  as any)) : (ds.FreeIndexerEc2Pool.size() >= (process.env.MAX_INDEXER_INSTANCES as any) ))
                {
                    let time = (Math.abs(new Date().getTime() - value.startedAt.getTime()));
                    if ((value.numberOfRunningTasks === 0) && (time > parseInt(process.env.MAX_REAPING_TIME as any) * 60 * 1000)) {
                        // if the machine has been on for half an hour, and has no running tasks, lets kill it
                        ec2Service.terminateInstance(value.instanceId);

                        // also removing the ec2 information from given ds
                        ds.Ec2Id_Map.delete(value.instanceId);
                        ds.FreeEc2Pool.remove(value.instanceId);
                        ds.FreeIndexerEc2Pool.remove(value.instanceId);

                        this.logger.info('successfully initiated the termination of the free EC2=>', value.instanceId);
                    }
                    else{
                        this.logger.info('not reaping the machine, since it has running tasks or it has not reached the max reaping time=>', value.instanceId);
                        this.logger.info('debug info for EC2Reaper service =>',`number of running tasks=>${value.numberOfRunningTasks} and 
                           running time is=> ${time}`)
                    }
                }
                else{
                    this.logger.info('not reaping the machine, since this is the only machine..');
                }
            }
        }
        catch (ex) {
            this.logger.error('error while reaping the EC2 instances=>', ex);
        }

    }
    async start() {
        this.logger.info('starting the cron job for EC2Reaper service at the interval=>', process.env.EC2_REPAER_CRON_JOB);
        this.cronTask = cron.schedule(
            process.env.EC2_REPAER_CRON_JOB as any,
            async () => {
                this.EC2Reaper();
            }

        );
    }
}