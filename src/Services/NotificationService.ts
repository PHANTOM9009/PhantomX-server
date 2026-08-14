import { v4 as uuidv4 } from 'uuid';
import { io } from '../socket-server';
import { globalDatabaseService, UserInfo } from '../DataStructures';
import { INotification, CollectionNames, IUserCredentials } from '../DataAccessLayer/models';
import { getDBService } from '../DataAccessLayer/db-connection';

export async function sendNotification(
  userIds: string | string[],
  metadata: Record<string, any>
): Promise<void> {
  const userIdArray = Array.isArray(userIds) ? userIds : [userIds];
  const results: INotification[] = [];
  const errors: { userId: string, error: any }[] = [];

  await Promise.all(userIdArray.map(async (userId) => {
    try {
      if (!userId) {
        throw new Error(`User info not found for userId: ${userId}`);
      }
      const tempDbService = await getDBService();
      await tempDbService.ensureDatabase(process.env.USER_CREDENTIAL_DB);

      const userCredentialHandler = tempDbService.getRepository<IUserCredentials>(
          process.env.USER_CREDENTIAL_DB,
          process.env.USER_CREDENTIAL_COLLECTION
      );

      const userCredentials = await userCredentialHandler.findOne({ userId: userId as any });      
      const databaseName = userCredentials?.databaseName;
      
      if (!databaseName) {
        throw new Error(`Organization name not found for userId: ${userId}`);
      }

      await globalDatabaseService.ensureDatabase(databaseName);
      await globalDatabaseService.ensureCollection(databaseName, CollectionNames.NOTIFICATIONS);

      const notificationsRepo = globalDatabaseService.getRepository<INotification>(
        databaseName,
        CollectionNames.NOTIFICATIONS
      );

      const notificationDoc: Partial<INotification> = {
        notificationId: uuidv4(),
        userId,
        notificationStatus: 'pending',
        createdAt: new Date(),
        metadata
      };

      const result = await notificationsRepo.insertOne(notificationDoc as any);
      
      io.to(userId).emit('notification', {
        notificationId: notificationDoc.notificationId,
        userId: notificationDoc.userId,
        notificationStatus: notificationDoc.notificationStatus,
        createdAt: notificationDoc.createdAt,
        metadata: notificationDoc.metadata
      });

      console.log(`[NotificationService] Notification ${notificationDoc.notificationId} sent to user ${userId}`);
    } catch (error) {
      console.error(`[NotificationService] Failed to send notification to user ${userId}:`, error);
      errors.push({ userId, error });
    }
  }));
}