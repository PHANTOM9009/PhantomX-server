import { Server, Socket } from "socket.io";
import { getDBService } from '../DataAccessLayer/db-connection';
import { IOrganization } from '../DataAccessLayer/models/Organization';
import { IGroup } from '../DataAccessLayer/models/Groups';
import { IUser } from '../DataAccessLayer/models/User';
import { CollectionNames } from '../DataAccessLayer/models/Collections';
import { ObjectId } from 'mongodb';
import { IUserCredentials } from "../DataAccessLayer/models/UserCredentials";
import { initializeOrganizationDatabase } from "../Services/AuthTokenService";
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';
import { UserInfo } from "../DataStructures";
import { sendNotification } from "../Services/NotificationService";
import { Logger } from '../utils/Logger';

const logger = new Logger('GroupHandler');


export function group_handler(io: Server, socket: Socket) {
    const hasWritePermission = (userId: string, groupId: string) => {
        const currUserData = UserInfo.get(userId);
        if(currUserData?.permissionScopes && currUserData.permissionScopes[groupId].toLowerCase() === 'owner') {
            return true;
        }
        return false;
    }


    socket.on('get_all_groups', async (data: any, callback) => {
        try {
            const userId = socket.data.user.userId;
            
            if (!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            
            const dbService = await getDBService();
            
            const userCredentialsRepository = dbService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB, 
                process.env.USER_CREDENTIAL_COLLECTION
            );
            const userCredentials = await userCredentialsRepository.findOne({ userId: userId });
            if (!userCredentials) {
                callback({
                    success: false,
                    error: 'User credentials not found'
                });
                return;
            }
            
            const userData = userCredentials as any;
            const dbName = userData?.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const groups = await groupsRepository.find({});
            
            callback({
                success: true,
                groups: groups
            });
        } catch (error: any) {
            console.error('Error in get_all_groups handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while retrieving all groups'
            });
        }
    });
    socket.on('delete_member_group', async (data: any, callback) => {
        try {
            const { groupId, userId: memberUserId } = data;
            console.log("deleting member from group")
            console.log("groupId", groupId)
            console.log("memberUserId", memberUserId)
            
            if (!groupId) {
                callback({
                    success: false,
                    error: 'Group ID is required'
                });
                return;
            }
            
            if (!memberUserId) {
                callback({
                    success: false,
                    error: 'User ID is required'
                });
                return;
            }
            
            const currentUserId = socket.data.user.userId;
            if (!currentUserId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            
            const dbService = await getDBService();
            const currUserData = UserInfo.get(currentUserId);
            //check if user is owner of the group
            if(!hasWritePermission(currentUserId, groupId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to delete members from this group'
                });
                return;
            }

            const userCredentialsRepository = dbService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB, 
                process.env.USER_CREDENTIAL_COLLECTION
            );
            const userCredentials = await userCredentialsRepository.findOne({ userId: currentUserId });
            if (!userCredentials) {
                callback({
                    success: false,
                    error: 'User credentials not found'
                });
                return;
            }
            
            const userData = userCredentials as any;
            const dbName = userData?.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const group = await groupsRepository.findOne({ GroupId: groupId });
            if (!group) {
                callback({
                    success: false,
                    error: 'Group not found'
                });
                return;
            }
            
            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            const memberUser = await usersRepository.findOne({ userId: memberUserId });
            if (!memberUser) {
                callback({
                    success: false,
                    error: 'User to remove not found'
                });
                return;
            }
            if(memberUser.permissionScopes && memberUser.permissionScopes[groupId] === 'Owner') {
                callback({
                    success: false,
                    error: 'You cannot remove the owner of the group'
                });
                return;
            }
            if (!memberUser.permissionScopes || !(groupId in memberUser.permissionScopes)) {
                callback({
                    success: false,
                    error: 'User is not a member of this group'
                });
                return;
            }
            
            const currentUser = await usersRepository.findOne({ userId: currentUserId });
            if (!currentUser) {
                callback({
                    success: false,
                    error: 'Current user not found'
                });
                return;
            }
            
            const hasPermission = currentUser.permissionScopes && 
                                 currentUser.permissionScopes[groupId] === 'Owner';
            
            if (!hasPermission) {
                callback({
                    success: false,
                    error: 'You do not have permission to remove members from this group'
                });
                return;
            }
            
            if (memberUser.permissionScopes[groupId] === 'Owner') {
                const allUsers = await usersRepository.find({});
                const owners = allUsers.filter((user: IUser) => 
                    user.permissionScopes && 
                    user.permissionScopes[groupId] === 'Owner'
                );
                
                if (owners.length <= 1) {
                    callback({
                        success: false,
                        error: 'Cannot remove the last owner of the group'
                    });
                    return;
                }
            }
            
            await usersRepository.updateOne(
                { userId: memberUserId },
                { 
                    $unset: { 
                        [`permissionScopes.${groupId}`]: "" 
                    } 
                }
            );
            
            await groupsRepository.updateOne(
                { GroupId: groupId },
                { $inc: { MemberCount: -1 } }
            );
            
            callback({
                success: true,
                message: `User ${memberUserId} removed from group`,
                groupId: groupId,
                userId: memberUserId
            });
            
        } catch (error: any) {
            console.error('Error in delete_member_group handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while removing member from group'
            });
        }
    });

    socket.on('add_member_group', async (data: any, callback) => {
        try {
            const { groupId, userId: memberUserId, role } = data;
            console.log("adding member to group")
            console.log("groupId", groupId)
            console.log("memberUserId", memberUserId)
            console.log("role", role)
            if (!groupId) {
                callback({
                    success: false,
                    error: 'Group ID is required'
                });
                return;
            }
            
            if (!memberUserId) {
                callback({
                    success: false,
                    error: 'User ID is required'
                });
                return;
            }
            
            if (!role || (role !== 'Owner' && role !== 'Member')) {
                callback({
                    success: false,
                    error: 'Valid role is required (Owner or Member)'
                });
                return;
            }
            
            const currentUserId = socket.data.user.userId;
            if (!currentUserId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            if(!hasWritePermission(currentUserId, groupId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to add members to this group'
                });
                return;
            }
            
            const dbService = await getDBService();
            
            const userCredentialsRepository = dbService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB, 
                process.env.USER_CREDENTIAL_COLLECTION
            );
            const userCredentials = await userCredentialsRepository.findOne({ userId: currentUserId });
            if (!userCredentials) {
                callback({
                    success: false,
                    error: 'User credentials not found'
                });
                return;
            }
            
            const userData = userCredentials as any;
            const dbName = userData?.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const group = await groupsRepository.findOne({ GroupId: groupId });
            if (!group) {
                callback({
                    success: false,
                    error: 'Group not found'
                });
                return;
            }
            
            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            const memberUser = await usersRepository.findOne({ userId: memberUserId });
            if (!memberUser) {
                callback({
                    success: false,
                    error: 'User to add not found'
                });
                return;
            }
            
            const currentUser = await usersRepository.findOne({ userId: currentUserId });
            if (!currentUser) {
                callback({
                    success: false,
                    error: 'Current user not found'
                });
                return;
            }
            
            const hasPermission = currentUser.permissionScopes && 
                                 currentUser.permissionScopes[groupId] === 'Owner';
            
            if (!hasPermission) {
                callback({
                    success: false,
                    error: 'You do not have permission to add members to this group'
                });
                return;
            }
            
            // Update user's permission scopes
            await usersRepository.updateOne(
                { userId: memberUserId },
                { 
                    $set: { 
                        [`permissionScopes.${groupId}`]: role 
                    } 
                }
            );
            
            await groupsRepository.updateOne(
                { GroupId: groupId },
                { $inc: { MemberCount: 1 } }
            );
            

            sendNotification(memberUserId, {
                message: `${currentUser.userName} added you to the group ${group.GroupName} as ${role}`,
                
            });
            callback({
                success: true,
                message: `User ${memberUserId} added to group with role ${role}`,
                groupId: groupId,
                userId: memberUserId,
                role: role
            });
            
        } catch (error: any) {
            console.error('Error in add_member_group handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while adding member to group'
            });
        }
    });

    socket.on('get_group_members', async (data: any, callback) => {
        try {
            const { groupId } = data;
            console.log("getting group members")
            console.log("groupId", groupId)
            if (!groupId) {
                callback({
                    success: false,
                    error: 'Group ID is required'
                });
                return;
            }

            const userId = socket.data.user.userId;
            if (!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }

            const dbService = await getDBService();

            const userCredentialsRepository = dbService.getRepository<IUserCredentials>(
                process.env.USER_CREDENTIAL_DB, 
                process.env.USER_CREDENTIAL_COLLECTION
            );
            const userCredentials = await userCredentialsRepository.findOne({ userId: userId });
            if (!userCredentials) {
                callback({
                    success: false,
                    error: 'User credentials not found'
                });
                return;
            }

            const userData = userCredentials as any;
            const dbName = userData?.databaseName;
            if (!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }

            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const group = await groupsRepository.findOne({ GroupId: groupId });
            if (!group) {
                callback({
                    success: false,
                    error: 'Group not found'
                });
                return;
            }

            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            const users = await usersRepository.find({});

            const groupMembers = users.filter((user: IUser) => {
                if (!user.permissionScopes) return false;
                return groupId in user.permissionScopes;
            });

            const memberDetails = groupMembers.map((user: IUser) => {
                return {
                    userId: user.userId,
                    userName: user.userName,
                    name: user.firstName + ' ' + user.lastName,
                    email: user.email,
                    permissionLevel: user.permissionScopes?.[groupId] || 'Unknown'
                };
            });

            callback({
                success: true,
                groupName: group.GroupName,
                members: memberDetails
            });
        } catch (error: any) {
            console.error('Error in get_group_members handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while retrieving group members'
            });
        }
    });

    

    socket.on('get_user_groups', async (data: any, callback) => {
        try {
            const userId = socket.data.user.userId;
            console.log("getting user groups")
            
            if(!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const dbService = await getDBService();
            
            const userCredentialsRepository = dbService.getRepository<IUserCredentials>(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
            const userCredentials = await userCredentialsRepository.findOne({ userId: userId });
            if(!userCredentials) {
                callback({
                    success: false,
                    error: 'User credentials not found'
                });
                return;
            }
            
            const userData = userCredentials as any;
            const dbName = userData?.databaseName;
            if(!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            
            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            const user = await usersRepository.findOne({ userId: userId });
            if(!user) {
                callback({
                    success: false,
                    error: 'User not found'
                });
                return;
            }
            
            const permissionScopes = user.permissionScopes || {};
            const groupIds = Object.keys(permissionScopes);
            
            if(groupIds.length === 0) {
                callback({
                    success: true,
                    groups: []
                });
                return;
            }
            
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const groups = await groupsRepository.find({ GroupId: { $in: groupIds } });
            // const groupsWithPermissions = groups.map((group: IGroup) => {
            //     const groupId = group._id!.toString();
            //     return {
            //         ...group,
            //         permissionLevel: permissionScopes[groupId]
            //     };
            // });
            
            callback({
                success: true,
                groups: groups
            });
        } catch (error: any) {
            console.error('Error in get_user_groups handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while retrieving user groups'
            });
        }
    });

    socket.on('get_group_details', async (data: any, callback) => {
        try {
            const { groupId } = data;
            console.log("getting group details")
            console.log("groupId", groupId)

            if(!groupId) {
                callback({
                    success: false,
                    error: 'Group ID is required'
                });
                return;
            }
            const userId = socket.data.user.userId;
            if(!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const dbService = await getDBService();
            const dbName = UserInfo.get(userId)?.dbName;
            if(!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const group = await groupsRepository.findOne({ GroupId: groupId });
            if(!group) {
                callback({
                    success: false,
                    error: 'Group not found'
                });
                return;
            }
            callback({
                success: true,
                group: group
            });
        }
        catch (error: any) {
            console.error('Error in get_group_details handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while retrieving group details'
            });
        }
    });

    socket.on("update_user_permissions", async (data: any, callback) => {
        try {
            const { groupId, userId, role } = data;
            console.log("updating user permissions")
          if(!groupId || !userId || !role) {
            callback({
                success: false,
                error: 'Group ID, user ID, and role are required'
            });
            return;
          }
          if(!hasWritePermission(socket.data.user.userId, groupId)) {
            callback({
                success: false,
                error: 'You do not have permission to update user permissions'
            });
            return;
          }
          const dbService = await getDBService();
          const dbName = UserInfo.get(socket.data.user.userId)?.dbName;
          if(!dbName) {
            callback({
                success: false,
                error: 'User database not found'
            });
            return;
          }
          const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
          const user = await usersRepository.findOne({ userId: userId });
          if(user?.permissionScopes && user.permissionScopes[groupId] === 'Owner') {
            callback({
                success: false,
                error: 'You cannot update the permissions of the owner of the group'
            });
            return;
          }
          if(!user) {
            callback({
                success: false,
                error: 'User not found'
            });
            return;
          }
          await usersRepository.updateOne(
            { userId: userId },
            { 
                $set: { 
                    [`permissionScopes.${groupId}`]: role 
                } 
            }
          );
          callback({
            success: true,
            message: 'User permissions updated successfully'
          });
        }
        catch (error: any) {
            console.error('Error in update_user_permissions handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while updating user permissions'
            });
        }
    });


    socket.on("leave_group", async (data: any, callback) => {
        try {
            const { groupId } = data;
            console.log("leaving group")
            console.log("groupId", groupId)
            if(!groupId) {
                callback({
                    success: false,
                    error: 'Group ID is required'
                });
                return;
            }
            const userId = socket.data.user.userId;
            if(!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            const dbName = UserInfo.get(userId)?.dbName;
            if(!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const dbService = await getDBService();
            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            const user = await usersRepository.findOne({ userId: userId });
            if(!user) {
                callback({
                    success: false,
                    error: 'User not found'
                });
                return;
            }
            if(!user.permissionScopes || !user.permissionScopes[groupId]) {
                callback({
                    success: false,
                    error: 'User is not a member of this group'
                });
                return;
            }
            const response = await usersRepository.updateOne(
                { userId: userId },
                { 
                    $unset: { 
                        [`permissionScopes.${groupId}`]: "" 
                    } 
                }
            );
            if(response.modifiedCount > 0) {
                callback({
                    success: true,
                    message: 'User left group successfully'
                });
            }
            else
            {
                callback({
                    success: false,
                    error: 'Failed to leave group'
                });
                return;
            }
        }
        catch (error: any) {
            console.error('Error in leave_group handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while leaving group'
            });
        }
    });

    socket.on('create_group', async (data: any, callback) => {
        try {
            const { groupName, groupDescription } = data;
            const userId = socket.data.user.userId;
            if(!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
            }
            const groupId = uuidv4();
            const dbService = await getDBService();
                const userCredentialsRepository = dbService.getRepository<IUserCredentials>(process.env.USER_CREDENTIAL_DB, process.env.USER_CREDENTIAL_COLLECTION);
                const userCredentials = await userCredentialsRepository.findOne({ userId: userId });
                if(!userCredentials) {
                    callback({
                        success: false,
                        error: 'User credentials not found'
                    });
                return;
            }
            const userData = userCredentials as any;
            const dbName = userData?.databaseName;
            if(!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
            }
            await dbService.ensureDatabase(dbName);
            await dbService.ensureCollection(dbName, CollectionNames.GROUPS);
            const groupData: Omit<IGroup, '_id'> = {
                GroupId: groupId,
                GroupName: groupName,
                GroupDescription: groupDescription,
                CreatedBy: userId,
                CreatedOn: new Date(),
                MemberCount: 1
            };
            const groupRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const groupResult = await groupRepository.insertOne(groupData as IGroup);
            console.log('Group created:', groupResult);
            if(!groupResult.insertedId) {
                callback({
                    success: false,
                    error: 'Failed to create group'
                });
                return;
            }
            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            
            await usersRepository.updateOne(
                { userId: userId },
                { 
                    $set: { 
                        [`permissionScopes.${groupId}`]: 'Owner' 
                    } 
                }
            );
            
            callback({
                success: true,
                groupId: groupId,
                message: 'Group created successfully'
            });
        } catch (error: any) {
            console.error('Error in create_group handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while creating the group'
            });
        }
    });

    socket.on("delete_group", async (data: any, callback) => {
        try {
            const { groupId } = data;
            console.log("deleting group")
            console.log("groupId", groupId)
            if(!groupId) {
                callback({
                    success: false,
                    error: 'Group ID is required'
                });
                return;
            }
            if(!hasWritePermission(socket.data.user.userId, groupId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to delete this group'
                });
                return;
            }
            const dbService = await getDBService();
            const dbName = UserInfo.get(socket.data.user.userId)?.dbName;
            if(!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const group = await groupsRepository.findOne({ GroupId: groupId });
            //now we will also need to remove the permissionScope for this group from all the users to remove
            if(!group) {
                callback({
                    success: false,
                    error: 'Group not found'
                });
                return;
            }
            await groupsRepository.deleteOne({ GroupId: groupId });


            const usersRepository = dbService.getRepository<IUser>(dbName, CollectionNames.USERS);
            await usersRepository.updateMany(
                { [`permissionScopes.${groupId}`]: { $exists: true } },
                { $unset: { [`permissionScopes.${groupId}`]: "" } }
              );
            callback({
                success: true,
                message: 'Group deleted successfully',
                groupId: groupId
            });
        }
        catch (error: any) {
            console.error('Error in delete_group handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while deleting the group'
            });
        }
    });

    socket.on("update_group_details", async (data: any, callback) => {
        try {
            const { groupId, type, value } = data;
            console.log("updating group details")
            console.log("groupId", groupId)
            const userId = socket.data.user.userId;
            if(!userId) {
                callback({
                    success: false,
                    error: 'User not authenticated'
                });
                return;
            }
            if(!hasWritePermission(userId, groupId)) {
                callback({
                    success: false,
                    error: 'You do not have permission to update this group'
                });
                return;
            }
            const dbService = await getDBService();
            const dbName = UserInfo.get(userId)?.dbName;
            if(!dbName) {
                callback({
                    success: false,
                    error: 'User database not found'
                });
                return;
            }
            const groupsRepository = dbService.getRepository<IGroup>(dbName, CollectionNames.GROUPS);
            const group = await groupsRepository.findOne({ GroupId: groupId });
            if(!group) {
                callback({
                    success: false,
                    error: 'Group not found'
                });
                return;
            }
            let response: any;
            if(type === "name")
            {
                response = await groupsRepository.updateOne(
                    { GroupId: groupId },
                    { $set: { GroupName: value } }
                );
            }
            else if(type === "description")
            {
                response = await groupsRepository.updateOne(
                    { GroupId: groupId },
                    { $set: { GroupDescription: value } }
                );
            }
            else
            {
                callback({
                    success: false,
                    error: 'Invalid type'
                });
                return;
            }
            if(response.modifiedCount > 0) {
                callback({
                success: true,
                message: 'Group details updated successfully',
                groupId: groupId
            });
            }
            else
            {
                callback({
                    success: false,
                    error: 'Failed to update group details'
                });
            }
        }
        catch (error: any) {
            console.error('Error in update_group_details handler:', error);
            callback({
                success: false,
                error: error.message || 'An error occurred while updating group details'
            });
        }
    });

}
