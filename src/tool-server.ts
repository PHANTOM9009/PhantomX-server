
import * as express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import * as cors from 'cors';

// Import the tool classes
import { EditTool } from './Services/EditTool';
import { ReadFileTool } from './Services/ReadFileTool';

const app = express.default();
app.use(cors.default());

// Create HTTP server
const httpServer = createServer(app);

// Create Socket.IO server
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow any origin for flexibility
    methods: ["GET", "POST"],
    credentials: true
  }
});



// Create instances of the tools
const editTool = new EditTool();
const readFileTool = new ReadFileTool();

// Socket.IO event handlers
io.on('connection', (socket: Socket) => {
  console.log('Client connected:', socket.id);

  // Handle edit tool requests
  socket.on('remote_edit_request', async (data: { requestId: string, edits: any[] }) => {
    console.log(`Received edit request ${data.requestId} with ${data.edits.length} edits`);
    //printing the folderPath of the file names
    for (const edit of data.edits) {
      console.log("file path is==>",edit.filePath);
    }
    
    try {
      // Process the edit request using EditTool
      const result = await editTool.applyFinalEdit(data.edits);
      
      // Send the result back to the client
      socket.emit('remote_edit_response', {
        requestId: data.requestId,
        result: result
      });
      
      console.log(`Edit request ${data.requestId} processed successfully`);
    } catch (error) {
      console.error(`Error processing edit request ${data.requestId}:`, error);
      
      // Send error back to the client
      socket.emit('remote_edit_response', {
        requestId: data.requestId,
        result: [[data.requestId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`]]
      });
    }
  });

  // Handle read file tool requests
  socket.on('remote_read_request', async (data: { 
    requestId: string, 
    options: {
      targetFile: string;
      shouldReadEntireFile: boolean;
      startLineOneIndexed: number;
      endLineOneIndexedInclusive: number;
      explanation?: string;
    }
  }) => {
    console.log(`Received read file request ${data.requestId} for ${data.options.targetFile}`);
    
    try {
      // Process the read file request using ReadFileTool
      // Add the absolutePath property to the options object
      const modifiedOptions = {
        ...data.options,
        absolutePath: data.options.targetFile // The absolutePath is already set in agent-system.ts
      };
      
      const result = await readFileTool.readFile(modifiedOptions);
      
      // Send the result back to the client
      socket.emit('remote_read_response', {
        requestId: data.requestId,
        result: result
      });
      
      console.log(`Read file request ${data.requestId} processed successfully`);
    } catch (error) {
      console.error(`Error processing read file request ${data.requestId}:`, error);
      
      // Send error back to the client
      socket.emit('remote_read_response', {
        requestId: data.requestId,
        result: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  // Error handling
  socket.on('error', (error: Error) => {
    console.error('Socket error:', error);
  });
});

// Start the server
const PORT: number = parseInt(process.env.TOOL_SERVER_PORT || '8081', 10);
httpServer.listen(PORT, () => {
  console.log(`Tool server running on port ${PORT}`);
});

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('Shutting down tool server...');
  httpServer.close(() => {
    console.log('Tool server shut down successfully');
    process.exit(0);
  });
});
