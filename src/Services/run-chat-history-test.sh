#!/bin/bash

# Quick test runner for Chat History Services

echo "=================================="
echo "Chat History Service Test Runner"
echo "=================================="
echo ""

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠ Warning: .env file not found"
    echo "Make sure to set AWS credentials:"
    echo "  - AWS_ACCESS_KEY_ID"
    echo "  - AWS_SECRET_ACCESS_KEY"
    echo "  - S3_BUCKET or CHAT_HISTORY_BUCKET"
    echo ""
fi

# Run the test
echo "Running tests..."
echo ""

npx ts-node src/Services/ChatHistoryService.test_tempAI.ts

echo ""
echo "=================================="
