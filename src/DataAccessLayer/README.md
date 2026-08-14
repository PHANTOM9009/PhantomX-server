
# MongoDB Data Access Layer

This is a generic Data Access Layer (DAL) for MongoDB that provides a clean interface for database operations. It includes functionality for database and collection management, CRUD operations, and advanced querying.

## Features

- Singleton MongoDB client manager for connection handling
- Generic repository pattern for type-safe database operations
- Database management (create/drop databases, collections)
- CRUD operations with error handling
- Support for advanced queries (pagination, aggregation, etc.)
- Transaction support

## Installation

Ensure that you have the MongoDB Node.js driver installed:

```bash
npm install mongodb
```

## Structure

- `MongoDBClient.ts`: Singleton class for managing MongoDB connections
- `Repository.ts`: Generic repository interface and implementation
- `DatabaseService.ts`: High-level service for database operations
- `models/`: Directory for data models
- `tests.ts`: Test file with examples

## Usage

### Basic Connection

```typescript
import { DatabaseService } from './DataAccessLayer';

async function main() {
  const dbService = new DatabaseService();
  
  try {
    await dbService.connect('mongodb://localhost:27017');
    console.log('Connected to MongoDB');
    
    // Use a specific database
    dbService.useDatabase('my_database');
    
    // List collections
    const collections = await dbService.listCollections();
    console.log('Collections:', collections);
  } catch (error) {
    console.error('Database error:', error);
  } finally {
    await dbService.disconnect();
  }
}

main().catch(console.error);
```

### Using Repositories for CRUD Operations

```typescript
import { DatabaseService } from './DataAccessLayer';
import { IUser } from './DataAccessLayer/models/User';

async function userExample() {
  const dbService = new DatabaseService();
  
  try {
    await dbService.connect('mongodb://localhost:27017');
    dbService.useDatabase('my_database');
    
    // Get a repository for the 'users' collection
    const userRepository = dbService.getRepository<IUser>('users');
    
    // Create a user
    const newUser = {
      userName: 'johndoe',
      email: 'john@example.com',
      password: 'hashed_password',
      roles: ['user'],
      createdAt: new Date(),
      updatedAt: new Date(),
      active: true
    };
    
    const result = await userRepository.insertOne(newUser);
    console.log(`User created with ID: ${result.insertedId}`);
    
    // Find users
    const users = await userRepository.find({ active: true });
    console.log(`Found ${users.length} active users`);
    
    // Update a user
    await userRepository.updateOne(
      { userName: 'johndoe' },
      { $set: { lastLogin: new Date() } }
    );
    
    // Delete a user
    await userRepository.deleteOne({ userName: 'johndoe' });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbService.disconnect();
  }
}
```

### Pagination Example

```typescript
import { DatabaseService } from './DataAccessLayer';
import { IUser } from './DataAccessLayer/models/User';

async function paginationExample() {
  const dbService = new DatabaseService();
  
  try {
    await dbService.connect('mongodb://localhost:27017');
    dbService.useDatabase('my_database');
    
    const userRepository = dbService.getRepository<IUser>('users');
    
    // Get users with pagination
    const page = 1;
    const pageSize = 10;
    const result = await userRepository.findWithPagination(
      { active: true }, // filter
      page,
      pageSize,
      { createdAt: -1 } // sort by creation date, newest first
    );
    
    console.log(`Page ${result.page} of ${result.totalPages}`);
    console.log(`Showing ${result.data.length} of ${result.total} total users`);
    
    // Display users
    result.data.forEach(user => {
      console.log(`- ${user.userName} (${user.email})`);
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbService.disconnect();
  }
}
```

### Aggregation Example

```typescript
import { DatabaseService } from './DataAccessLayer';
import { IUser } from './DataAccessLayer/models/User';

async function aggregationExample() {
  const dbService = new DatabaseService();
  
  try {
    await dbService.connect('mongodb://localhost:27017');
    dbService.useDatabase('my_database');
    
    const userRepository = dbService.getRepository<IUser>('users');
    
    // Group users by role and count them
    const roleCounts = await userRepository.aggregate([
      { $match: { active: true } },
      { $unwind: "$roles" },
      { $group: { _id: "$roles", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    console.log('Users by role:');
    roleCounts.forEach(role => {
      console.log(`${role._id}: ${role.count} users`);
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await dbService.disconnect();
  }
}
```

## Testing

A test file `tests.ts` is provided with examples of how to use the Data Access Layer. To run the tests:

1. Ensure MongoDB is running on localhost:27017
2. Run individual test functions or the full test suite

```typescript
import { testConnection, runAllTests } from './DataAccessLayer/tests';

// Run a specific test
testConnection().catch(console.error);

// Or run all tests
// runAllTests().catch(console.error);
```

## Best Practices

1. Always close database connections when done (use try/finally)
2. Use the repository pattern for clean, type-safe database operations
3. Define proper interfaces for your data models
4. Use transactions for operations that need to be atomic
5. Handle errors appropriately

## License

MIT
