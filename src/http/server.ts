// HTTP Server for Autotask MCP
// Exposes REST endpoints while reusing existing MCP infrastructure

import express from 'express';
import cors from 'cors';
import { McpHttpBridge, HttpToolRequest } from './mcp-bridge.js';
import { SseManager } from './sse-manager.js';
import { Logger } from '../utils/logger.js';
import { loadEnvironmentConfig, mergeWithMcpConfig, createMultiTenantConfig } from '../utils/config.js';

export class AutotaskHttpServer {
  private app: express.Application;
  private bridge: McpHttpBridge;
  private sseManager: SseManager;
  private logger: Logger;
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    
    // Load configuration
    const envConfig = loadEnvironmentConfig();
    this.logger = new Logger(envConfig.logging.level, envConfig.logging.format);
    
    // Determine server configuration
    let mcpConfig;
    if (envConfig.multiTenant?.enabled) {
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

    // Initialize Express app and MCP bridge
    this.app = express();
    this.bridge = new McpHttpBridge(mcpConfig, this.logger);
    this.sseManager = new SseManager(this.bridge, this.logger);

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // CORS - allow all origins for development, restrict in production
    this.app.use(cors({
      origin: process.env.NODE_ENV === 'production' 
        ? process.env.ALLOWED_ORIGINS?.split(',') || false
        : true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging middleware
    this.app.use((req, _res, next) => {
      this.logger.debug(`HTTP ${req.method} ${req.path}`, {
        userAgent: req.get('User-Agent'),
        ip: req.ip
      });
      next();
    });

    // Error handling middleware
    this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      this.logger.error('HTTP server error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
      });
    });
  }

  private setupRoutes() {
    // Health check endpoint
    this.app.get('/health', async (_req, res) => {
      try {
        const health = await this.bridge.getHealthStatus();
        res.status(health.success ? 200 : 503).json(health);
      } catch (error) {
        res.status(503).json({
          success: false,
          data: { status: 'unhealthy', error: 'Health check failed' },
          timestamp: new Date().toISOString()
        });
      }
    });

    // Get available tools
    this.app.get('/api/autotask/tools', async (_req, res) => {
      try {
        const result = await this.bridge.getAvailableTools();
        res.json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Failed to get available tools',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Get available resources
    this.app.get('/api/autotask/resources', async (_req, res) => {
      try {
        const result = await this.bridge.getAvailableResources();
        res.json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Failed to get available resources',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Read a specific resource
    this.app.get('/api/autotask/resources/*', async (req, res) => {
      try {
        const resourceUri = (req.params as any)[0]; // Gets everything after /resources/
        const result = await this.bridge.readResource(`autotask://${resourceUri}`);
        res.json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Failed to read resource',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Execute a tool
    this.app.post('/api/autotask/tools/:toolName', async (req, res) => {
      try {
        const { toolName } = req.params;
        const request: HttpToolRequest = req.body;

        // Validate request structure
        if (!request.arguments || typeof request.arguments !== 'object') {
          res.status(400).json({
            success: false,
            error: 'Invalid request: arguments field is required and must be an object',
            timestamp: new Date().toISOString()
          });
          return;
        }

        const result = await this.bridge.callTool(toolName, request);
        res.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Tool execution failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Test connection endpoint
    this.app.post('/api/autotask/test-connection', async (req, res) => {
      try {
        const { tenant } = req.body;
        const result = await this.bridge.testConnection(tenant);
        res.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Connection test failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // SSE Endpoints

    // SSE Stream endpoint
    this.app.get('/api/autotask/stream/:tenantId?', (req, res) => {
      try {
        const tenantId = req.params.tenantId;
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        this.sseManager.addClient(clientId, res, tenantId);
        
        // Keep connection alive with heartbeat
        const heartbeat = setInterval(() => {
          this.sseManager.sendToClient(clientId, {
            event: 'heartbeat',
            data: { timestamp: new Date().toISOString() }
          });
        }, 30000);

        res.on('close', () => {
          clearInterval(heartbeat);
        });

      } catch (error) {
        this.logger.error('SSE connection failed:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to establish SSE connection',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Start polling for a tenant
    this.app.post('/api/autotask/stream/start-polling', async (req, res) => {
      try {
        const { tenant, intervalMs = 30000 } = req.body;
        
        if (!tenant) {
          return res.status(400).json({
            success: false,
            error: 'Tenant credentials required',
            timestamp: new Date().toISOString()
          });
        }

        const pollId = await this.sseManager.startPolling(tenant, intervalMs);
        
        return res.json({
          success: true,
          data: { pollId, intervalMs },
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start polling',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Stop polling
    this.app.post('/api/autotask/stream/stop-polling', (req, res) => {
      try {
        const { pollId } = req.body;
        
        if (!pollId) {
          return res.status(400).json({
            success: false,
            error: 'Poll ID required',
            timestamp: new Date().toISOString()
          });
        }

        const stopped = this.sseManager.stopPolling(pollId);
        
        return res.json({
          success: stopped,
          data: { pollId, stopped },
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          error: 'Failed to stop polling',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Broadcast message to SSE clients
    this.app.post('/api/autotask/stream/broadcast', (req, res) => {
      try {
        const { message, tenantId } = req.body;
        
        if (!message) {
          return res.status(400).json({
            success: false,
            error: 'Message is required',
            timestamp: new Date().toISOString()
          });
        }

        const sentCount = this.sseManager.broadcast(message, tenantId);
        
        return res.json({
          success: true,
          data: { sentCount, tenantId },
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          error: 'Failed to broadcast message',
          timestamp: new Date().toISOString()
        });
      }
    });

    // SSE client statistics
    this.app.get('/api/autotask/stream/stats', (_req, res) => {
      try {
        const stats = this.sseManager.getStats();
        res.json({
          success: true,
          data: stats,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Failed to get SSE stats',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Convenience endpoints for common operations
    
    // Search companies
    this.app.post('/api/autotask/companies/search', async (req, res) => {
      try {
        const { searchTerm, isActive, pageSize, tenant } = req.body;
        const result = await this.bridge.callTool('search_companies', {
          arguments: { searchTerm, isActive, pageSize },
          tenant
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Company search failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Search tickets
    this.app.post('/api/autotask/tickets/search', async (req, res) => {
      try {
        const { searchTerm, status, assignedResourceID, companyId, pageSize, tenant } = req.body;
        const result = await this.bridge.callTool('search_tickets', {
          arguments: { searchTerm, status, assignedResourceID, companyId, pageSize },
          tenant
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Ticket search failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Create ticket
    this.app.post('/api/autotask/tickets', async (req, res) => {
      try {
        const { title, description, companyID, priority, status, tenant, ...otherArgs } = req.body;
        const result = await this.bridge.callTool('create_ticket', {
          arguments: { title, description, companyID, priority, status, ...otherArgs },
          tenant
        });
        res.status(result.success ? 201 : 400).json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Ticket creation failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // API documentation endpoint
    this.app.get('/api/docs', (_req, res) => {
      res.json({
        name: 'Autotask MCP HTTP API',
        version: '1.0.0',
        description: 'REST API for Autotask PSA integration with multi-tenant support and Server-Sent Events',
        endpoints: {
          // Standard HTTP endpoints
          'GET /health': 'Server health check',
          'GET /api/autotask/tools': 'List available tools',
          'GET /api/autotask/resources': 'List available resources',
          'GET /api/autotask/resources/*': 'Read specific resource',
          'POST /api/autotask/tools/:toolName': 'Execute a tool',
          'POST /api/autotask/test-connection': 'Test API connection',
          'POST /api/autotask/companies/search': 'Search companies',
          'POST /api/autotask/tickets/search': 'Search tickets',
          'POST /api/autotask/tickets': 'Create ticket',
          
          // Server-Sent Events endpoints
          'GET /api/autotask/stream/:tenantId?': 'Open SSE connection for real-time updates',
          'POST /api/autotask/stream/start-polling': 'Start polling Autotask data for real-time updates',
          'POST /api/autotask/stream/stop-polling': 'Stop polling for a specific poll ID',
          'POST /api/autotask/stream/broadcast': 'Broadcast message to SSE clients',
          'GET /api/autotask/stream/stats': 'Get SSE client statistics'
        },
        multiTenant: {
          enabled: true,
          description: 'Include tenant credentials in request body for multi-tenant mode'
        },
        serverSentEvents: {
          enabled: true,
          description: 'Real-time streaming of Autotask data via Server-Sent Events',
          events: [
            'connected - Initial connection established',
            'heartbeat - Keep-alive ping every 30 seconds',
            'tickets-update - Real-time ticket updates',
            'operation-complete - Notification when operations finish',
            'polling-error - Errors during data polling',
            'subscription-updated - Event subscription changes'
          ]
        }
      });
    });

    // Catch-all 404 handler
    this.app.use('*', (_req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        message: 'See /api/docs for available endpoints',
        timestamp: new Date().toISOString()
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.app.listen(this.port, () => {
          this.logger.info(`Autotask HTTP Server started on port ${this.port}`);
          this.logger.info(`API Documentation: http://localhost:${this.port}/api/docs`);
          this.logger.info(`Health Check: http://localhost:${this.port}/health`);
          resolve();
        });
      } catch (error) {
        this.logger.error('Failed to start HTTP server:', error);
        reject(error);
      }
    });
  }
} 