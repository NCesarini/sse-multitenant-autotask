// HTTP-to-MCP Bridge
// Provides HTTP endpoints while reusing existing MCP infrastructure

import { AutotaskService } from '../services/autotask.service.js';
import { EnhancedAutotaskToolHandler } from '../handlers/enhanced.tool.handler.js';
import { AutotaskResourceHandler } from '../handlers/resource.handler.js';
import { Logger } from '../utils/logger.js';
import { McpServerConfig } from '../types/mcp.js';

export interface HttpToolRequest {
  arguments: Record<string, any>;
  tenant?: {
    tenantId?: string;
    username: string;
    secret: string;
    integrationCode: string;
    apiUrl?: string;
    sessionId?: string;
    impersonationResourceId?: number;
    mode?: 'read' | 'write';
  };
}

export interface HttpToolResponse {
  success: boolean;
  data?: any;
  error?: string;
  timestamp: string;
}

export class McpHttpBridge {
  private autotaskService: AutotaskService;
  private toolHandler: EnhancedAutotaskToolHandler;
  private resourceHandler: AutotaskResourceHandler;
  private logger: Logger;

  constructor(config: McpServerConfig, logger: Logger) {
    this.logger = logger;
    this.autotaskService = new AutotaskService(config, logger);
    this.toolHandler = new EnhancedAutotaskToolHandler(this.autotaskService, logger);
    this.resourceHandler = new AutotaskResourceHandler(this.autotaskService, logger);
  }

  /**
   * Execute a tool call via HTTP request
   */
  async callTool(toolName: string, request: HttpToolRequest): Promise<HttpToolResponse> {
    try {
      this.logger.debug(`HTTP tool call: ${toolName}`, { 
        args: this.sanitizeArgsForLogging(request.arguments),
        hasTenant: !!request.tenant 
      });

      // Prepare arguments with tenant context
      const toolArgs = { ...request.arguments };
      if (request.tenant) {
        toolArgs._tenant = request.tenant;
      }

      // Execute tool using existing MCP handler
      const result = await this.toolHandler.callTool(toolName, toolArgs);

      // Convert MCP result to HTTP response
      return {
        success: !result.isError,
        data: result.content,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error(`HTTP tool call failed: ${toolName}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get list of available tools
   */
  async getAvailableTools() {
    try {
      const tools = await this.toolHandler.listTools();
      return {
        success: true,
        data: tools,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Failed to get available tools:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get list of available resources
   */
  async getAvailableResources() {
    try {
      const resources = await this.resourceHandler.listResources();
      return {
        success: true,
        data: resources,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Failed to get available resources:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Read a specific resource
   */
  async readResource(uri: string) {
    try {
      const content = await this.resourceHandler.readResource(uri);
      return {
        success: true,
        data: content,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error(`Failed to read resource ${uri}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Test connection for a specific tenant
   */
  async testConnection(tenant?: HttpToolRequest['tenant']): Promise<HttpToolResponse> {
    const request: HttpToolRequest = {
      arguments: {}
    };
    
    if (tenant) {
      request.tenant = tenant;
    }
    
    return this.callTool('test_connection', request);
  }

  /**
   * Get server health status
   */
  async getHealthStatus() {
    try {
      // Test basic functionality without tenant (single-tenant mode)
      const isHealthy = await this.autotaskService.testConnection();
      
      return {
        success: true,
        data: {
          status: isHealthy ? 'healthy' : 'degraded',
          timestamp: new Date().toISOString(),
          multiTenant: !!this.autotaskService['isMultiTenant']
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        data: {
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Sanitize arguments for logging (remove sensitive data)
   */
  private sanitizeArgsForLogging(args: Record<string, any>): Record<string, any> {
    const sanitized = { ...args };
    
    // Remove sensitive tenant credentials from logs
    if (sanitized._tenant) {
      sanitized._tenant = {
        ...sanitized._tenant,
        secret: '[REDACTED]',
        username: sanitized._tenant.username ? `${sanitized._tenant.username.substring(0, 3)}***` : undefined
      };
    }
    
    return sanitized;
  }
} 