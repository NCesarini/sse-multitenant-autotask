#!/usr/bin/env node

// HTTP Server Entry Point for Autotask MCP
// Starts the Express.js server with HTTP endpoints

import { AutotaskHttpServer } from './http/server.js';

async function main() {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3999;
    const server = new AutotaskHttpServer(port);

    // Set up graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nReceived SIGTERM, shutting down gracefully...');
      process.exit(0);
    });

    // Start the HTTP server
    await server.start();

  } catch (error) {
    console.error('Failed to start Autotask HTTP Server:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the server
main().catch((error) => {
  console.error('Failed to start HTTP server:', error);
  process.exit(1);
}); 