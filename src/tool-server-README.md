
# Tool Server

This server handles file editing and reading operations for the socket-server.ts application. It provides a Socket.IO interface for remote file operations.

## Overview

The tool server listens on port 8080 (by default) and processes two main types of requests:

1. **Edit File Requests** - Handles requests to insert, replace, or delete content in files
2. **Read File Requests** - Handles requests to read file contents with various options

## How It Works

The tool server uses the existing `EditTool` and `ReadFileTool` classes to perform file operations. It communicates with the socket-server.ts client using Socket.IO events.

### Socket.IO Events

#### Incoming Events

- `remote_edit_request` - Receives edit requests with an array of edit operations
- `remote_read_request` - Receives read file requests with file path and line range options

#### Outgoing Events

- `remote_edit_response` - Sends back the results of edit operations
- `remote_read_response` - Sends back the file contents or error messages

## Configuration

The tool server can be configured using environment variables:

- `BASE_FOLDER_PATH` - The base folder path for file operations (defaults to current working directory)
- `TOOL_SERVER_PORT` - The port to run the server on (defaults to 8080)

## Running the Server

To run the tool server:

```bash
npm run tool-server
```

For debugging:

```bash
npm run tool-server:debug
```

## Integration with socket-server.ts

The socket-server.ts file connects to this tool server as a client and sends requests for file operations. The tool server processes these requests and sends back the results.

## OS Compatibility

The tool server uses Node.js's `fs` module and `path` module, which handle path differences between operating systems automatically. This makes the server compatible with both Windows and Linux environments.
