#!/usr/bin/env node
// SSE Server Entry Point for Autotask MCP
// Implements Server-Sent Events transport as an alternative to STDIO

import express from 'express';
import cors from 'cors';
import { AutotaskMcpServer } from './mcp/server.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Logger } from './utils/logger.js';
import { loadEnvironmentConfig, mergeWithMcpConfig, createMultiTenantConfig } from './utils/config.js';

export class AutotaskSseServer {
  private app: express.Application;
  private mcpServer: AutotaskMcpServer;
  private logger: Logger;
  private port: number;
  private transports: Map<string, SSEServerTransport> = new Map();

  constructor(port: number = 3999) {
    this.port = port;
    this.logger = new Logger();
    this.app = express();

    // Load configuration
    const envConfig = loadEnvironmentConfig();
    let mcpConfig;

    if (envConfig.multiTenant?.enabled) {
      // Multi-tenant configuration
      const configOptions: any = {
        name: envConfig.server.name,
        version: envConfig.server.version
      };
      if (envConfig.multiTenant.defaultApiUrl) {
        configOptions.defaultApiUrl = envConfig.multiTenant.defaultApiUrl;
      }
      if (envConfig.multiTenant.clientPoolSize) {
        configOptions.clientPoolSize = envConfig.multiTenant.clientPoolSize;
      }
      if (envConfig.multiTenant.sessionTimeout) {
        configOptions.sessionTimeout = envConfig.multiTenant.sessionTimeout;
      }
      mcpConfig = createMultiTenantConfig(configOptions);
    } else {
      mcpConfig = mergeWithMcpConfig(envConfig);
    }

    // Initialize MCP server
    this.mcpServer = new AutotaskMcpServer(mcpConfig, this.logger);

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Enable CORS for web clients
    this.app.use(cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control']
    }));

    // Parse JSON
    this.app.use(express.json());

    // Request logging
    this.app.use((req, _res, next) => {
      this.logger.info(`${req.method} ${req.path}`, {
        headers: req.headers,
        query: req.query
      });
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        transport: 'SSE',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // SSE endpoint - establishes the Server-Sent Events connection
    this.app.get('/sse', (_req, res) => {
      try {
        this.logger.info('New SSE connection request');

        // Create SSE transport with POST endpoint for client messages
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = transport.sessionId;

        this.logger.info(`Created SSE transport with session ID: ${sessionId}`);

        // Store transport for message handling
        this.transports.set(sessionId, transport);

        // Handle client disconnect
        res.on('close', () => {
          this.logger.info(`SSE connection closed for session: ${sessionId}`);
          this.transports.delete(sessionId);
        });

        res.on('error', (error) => {
          this.logger.error(`SSE connection error for session ${sessionId}:`, error);
          this.transports.delete(sessionId);
        });

        // Connect MCP server to this transport
        this.mcpServer['server'].connect(transport).catch((error: any) => {
          this.logger.error(`Failed to connect MCP server to SSE transport:`, error);
          this.transports.delete(sessionId);
        });

      } catch (error) {
        this.logger.error('Failed to establish SSE connection:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to establish SSE connection',
          timestamp: new Date().toISOString()
        });
      }
    });

    // POST endpoint - handles client-to-server messages
    this.app.post('/messages', async (req, res) => {
      try {
        const sessionId = req.query.sessionId as string;
        
        if (!sessionId) {
          return res.status(400).json({
            success: false,
            error: 'Session ID required',
            timestamp: new Date().toISOString()
          });
        }

        const transport = this.transports.get(sessionId);
        if (!transport) {
          return res.status(404).json({
            success: false,
            error: 'Session not found',
            timestamp: new Date().toISOString()
          });
        }

        this.logger.debug(`Handling message for session ${sessionId}:`, req.body);

        // Handle the message through the SSE transport
        await transport.handlePostMessage(req, res, req.body);
        return;

      } catch (error) {
        this.logger.error('Failed to handle POST message:', error);
        return res.status(500).json({
          success: false,
          error: 'Internal server error',
          timestamp: new Date().toISOString()
        });
      }
    });

    // API documentation endpoint
    this.app.get('/api/docs', (_req, res) => {
      res.json({
        name: 'Autotask MCP SSE Server',
        version: '1.0.0',
        description: 'Autotask PSA integration via MCP with Server-Sent Events transport',
        transport: 'SSE (Server-Sent Events)',
        endpoints: {
          'GET /health': 'Server health check',
          'GET /sse': 'Establish SSE connection for MCP communication',
          'POST /messages': 'Send MCP messages to server (used by MCP clients)',
          'GET /api/docs': 'This documentation'
        },
        usage: {
          'Client Connection': 'Connect to GET /sse to establish SSE stream',
          'Send Messages': 'POST to /messages with sessionId query parameter',
          'MCP Protocol': 'All messages follow JSON-RPC 2.0 format as per MCP specification'
        },
        multiTenant: {
          enabled: process.env.MULTI_TENANT_ENABLED === 'true',
          description: 'Include tenant credentials in MCP tool arguments for multi-tenant mode'
        }
      });
    });

    // List active SSE sessions (for debugging)
    this.app.get('/api/sessions', (_req, res) => {
      const sessions = Array.from(this.transports.keys()).map(sessionId => ({
        sessionId,
        connected: true,
        timestamp: new Date().toISOString()
      }));

      res.json({
        success: true,
        data: {
          activeSessions: sessions.length,
          sessions
        },
        timestamp: new Date().toISOString()
      });
    });

    // Handle 404s
    this.app.use('*', (_req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        availableEndpoints: ['/health', '/sse', '/messages', '/api/docs', '/api/sessions'],
        timestamp: new Date().toISOString()
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.port, () => {
        this.logger.info(`Autotask MCP SSE Server started on port ${this.port}`);
        this.logger.info(`SSE endpoint: http://localhost:${this.port}/sse`);
        this.logger.info(`Messages endpoint: http://localhost:${this.port}/messages`);
        this.logger.info(`Health check: http://localhost:${this.port}/health`);
        this.logger.info(`Documentation: http://localhost:${this.port}/api/docs`);
        
        if (process.env.MULTI_TENANT_ENABLED === 'true') {
          this.logger.info('Multi-tenant mode enabled - provide credentials in tool arguments');
        }
        
        resolve();
      });
    });
  }

  // Add method to get the underlying MCP server (for access to tools/resources)
  getMcpServer(): AutotaskMcpServer {
    return this.mcpServer;
  }

  // Get the underlying Express server
  getServer(): express.Application {
    return this.app;
  }
}

// Main function when run directly
async function main() {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3999;
    const server = new AutotaskSseServer(port);

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nReceived SIGTERM, shutting down gracefully...');
      process.exit(0);
    });

    await server.start();
  } catch (error) {
    console.error('Failed to start Autotask MCP SSE Server:', error);
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
} 