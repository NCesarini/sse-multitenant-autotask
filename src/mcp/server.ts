// Main MCP Server Implementation
// Handles the Model Context Protocol server setup and integration with Autotask

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from '../utils/logger.js';
import { McpServerConfig } from '../types/mcp.js';
import { AutotaskResourceHandler } from '../handlers/resource.handler.js';
import { EnhancedAutotaskToolHandler } from '../handlers/enhanced.tool.handler.js';

export class AutotaskMcpServer {
  private server: Server;
  private autotaskService: AutotaskService;
  private resourceHandler: AutotaskResourceHandler;
  private toolHandler: EnhancedAutotaskToolHandler;
  private logger: Logger;

  constructor(config: McpServerConfig, logger: Logger) {
    this.logger = logger;
    
    // Initialize the MCP server
    this.server = new Server(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          resources: {
            subscribe: false,
            listChanged: true
          },
          tools: {
            listChanged: true
          }
        },
        instructions: this.getServerInstructions()
      }
    );

    // Initialize Autotask service
    this.autotaskService = new AutotaskService(config, logger);
    
    // Initialize handlers
    this.resourceHandler = new AutotaskResourceHandler(this.autotaskService, logger);
    this.toolHandler = new EnhancedAutotaskToolHandler(this.autotaskService, logger);

    this.setupHandlers();
  }

  /**
   * Set up all MCP request handlers
   */
  private setupHandlers(): void {
    this.logger.info('Setting up MCP request handlers...');

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        this.logger.debug('Handling list resources request');
        const resources = await this.resourceHandler.listResources();
        return { resources };
      } catch (error) {
        this.logger.error('Failed to list resources:', error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list resources: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Read a specific resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        this.logger.debug(`Handling read resource request for: ${request.params.uri}`);
        const content = await this.resourceHandler.readResource(request.params.uri);
        return { contents: [content] };
      } catch (error) {
        this.logger.error(`Failed to read resource ${request.params.uri}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read resource: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        this.logger.debug('Handling list tools request');
        const tools = await this.toolHandler.listTools();
        return { tools };
      } catch (error) {
        this.logger.error('Failed to list tools:', error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list tools: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Call a tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const startTime = Date.now();
      const requestId = `mcp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        this.logger.info('🔧 MCP tool call received', {
          requestId,
          toolName: request.params.name,
          hasArguments: !!request.params.arguments,
          argumentKeys: request.params.arguments ? Object.keys(request.params.arguments) : [],
          timestamp: new Date().toISOString()
        });

        // Check for tenant information in arguments
        if (request.params.arguments) {
          const args = request.params.arguments;
          const hasTenant = args._tenant || args.tenant || args.credentials;
          
          if (hasTenant) {
            const tenantInfo = (args._tenant || args.tenant || args.credentials) as any;
            this.logger.info('🏢 MCP tool call includes tenant credentials', {
              requestId,
              toolName: request.params.name,
              tenantId: tenantInfo.tenantId,
              username: tenantInfo.username ? `${tenantInfo.username.substring(0, 3)}***` : undefined,
              hasSecret: !!tenantInfo.secret,
              hasIntegrationCode: !!tenantInfo.integrationCode,
              hasApiUrl: !!tenantInfo.apiUrl
            });
          } else {
            this.logger.debug('🏠 MCP tool call using single-tenant mode', {
              requestId,
              toolName: request.params.name
            });
          }
        }

        this.logger.debug(`🔧 Handling tool call: ${request.params.name}`, { requestId });
        
        // Enhanced debugging for tenant context flow
        this.logger.info('🔧 MCP SERVER ARGS DEBUG', {
          requestId,
          toolName: request.params.name,
          arguments: request.params.arguments,
        });
        
        const result = await this.toolHandler.callTool(
          request.params.name,
          request.params.arguments || {}
        );
        
        const executionTime = Date.now() - startTime;
        this.logger.info('✅ MCP tool call completed', {
          requestId,
          toolName: request.params.name,
          success: !result.isError,
          executionTimeMs: executionTime,
          hasContent: !!result.content,
          contentCount: result.content?.length || 0
        });

        return {
          content: result.content,
          isError: result.isError
        };
      } catch (error) {
        const executionTime = Date.now() - startTime;
        this.logger.error(`❌ MCP tool call failed: ${request.params.name}`, {
          requestId,
          toolName: request.params.name,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          errorObject: error,
          executionTimeMs: executionTime
        });
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to call tool: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    this.logger.info('MCP request handlers set up successfully');
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    this.logger.info('Starting Autotask MCP Server...');
    
    const transport = new StdioServerTransport();
    
    // Set up error handling
    this.server.onerror = (error) => {
      this.logger.error('MCP Server error:', error);
    };

    // Set up initialization callback
    this.server.oninitialized = () => {
      this.logger.info('MCP Server initialized and ready to serve requests');
    };

    // Connect to transport
    await this.server.connect(transport);
    this.logger.info('Autotask MCP Server started and connected to stdio transport');
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping Autotask MCP Server...');
    await this.server.close();
    this.logger.info('Autotask MCP Server stopped');
  }

  /**
   * Get server instructions for clients
   */
  private getServerInstructions(): string {
    return `
# Autotask MCP Server

This server provides access to Kaseya Autotask PSA data and operations through the Model Context Protocol.

## Available Resources:
- **autotask://companies/{id}** - Get company details by ID
- **autotask://companies** - List all companies
- **autotask://contacts/{id}** - Get contact details by ID  
- **autotask://contacts** - List all contacts
- **autotask://tickets/{id}** - Get ticket details by ID
- **autotask://tickets** - List all tickets

## Available Tools:
- **search_companies** - Search for companies with filters
- **create_company** - Create a new company
- **update_company** - Update company information
- **search_contacts** - Search for contacts with filters
- **create_contact** - Create a new contact
- **update_contact** - Update contact information
- **search_tickets** - Search for tickets with filters
- **create_ticket** - Create a new ticket
- **update_ticket** - Update ticket information
- **create_time_entry** - Log time against a ticket or project
- **test_connection** - Test Autotask API connectivity

## ID-to-Name Mapping Tools:
- **get_company_name** - Get company name by ID
- **get_resource_name** - Get resource name by ID
- **get_mapping_cache_stats** - Get mapping cache statistics
- **clear_mapping_cache** - Clear mapping cache
- **preload_mapping_cache** - Preload mapping cache for better performance

## Enhanced Features:
All search and detail tools automatically include human-readable names for company and resource IDs in the enhanced field of each result.

## Authentication:
This server requires valid Autotask API credentials. Ensure you have:
- AUTOTASK_USERNAME (API user email)
- AUTOTASK_SECRET (API secret key)
- AUTOTASK_INTEGRATION_CODE (integration code)

For more information, visit: https://github.com/your-org/autotask-mcp
`.trim();
  }
}