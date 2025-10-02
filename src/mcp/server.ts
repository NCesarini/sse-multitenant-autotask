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
        this.logger.info('Handling list resources request');
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
        this.logger.info(`Handling read resource request for: ${request.params.uri}`);
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
        const tools = await this.toolHandler.listTools(); // No tenant context available during listTools
        
        this.logger.info(`📋 Listed ${tools.length} tools ${tools.map(t => t.name).join(', ')}` );
        
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
            this.logger.info('🏠 MCP tool call using single-tenant mode', {
              requestId,
              toolName: request.params.name
            });
          }
        }

        this.logger.info(`🔧 Handling tool call: ${request.params.name}`, { requestId });
        
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
### Company Operations
- **search_companies** - Search for companies with filters (read-only)
- **create_company** - Create a new company (write)
- **update_company** - Update company information (modify)

### Contact Operations
- **search_contacts** - Search for contacts with filters (read-only)
- **create_contact** - Create a new contact (write)
- **update_contact** - Update contact information (modify)

### Ticket Operations
- **search_tickets** - Search for tickets with filters (read-only)
- **create_ticket** - Create a new ticket (write)
- **update_ticket** - Update ticket information (modify)

### Project & Resource Operations
- **search_projects** - Search for projects (read-only)
- **search_resources** - Search for resources/employees with optional field-specific filters (firstName, lastName, email) (read-only)

### Time Management
- **create_time_entry** - Log time against a ticket or project (write)

### Utility Operations
- **test_connection** - Test Autotask API connectivity (read-only)
- **test_zone_information** - Test zone information discovery (read-only)

## ID-to-Name Mapping Tools:
- **get_company_name** - Get company name by ID (read-only)
- **get_resource_name** - Get resource name by ID (read-only)
- **get_mapping_cache_stats** - Get mapping cache statistics (read-only)
- **clear_mapping_cache** - Clear mapping cache (modify)
- **preload_mapping_cache** - Preload mapping cache for better performance (modify)

## Operation Types:
Each tool includes an operationType attribute indicating its data access pattern:
- **read**: Read-only operations that don't modify data
- **write**: Creates new records in Autotask
- **modify**: Updates existing records or system state

## Enhanced Features:
All search and detail tools automatically include human-readable names for company and resource IDs in the enhanced field of each result.

## Authentication:
This server requires valid Autotask API credentials. Ensure you have:
- AUTOTASK_USERNAME (API user email)
- AUTOTASK_SECRET (API secret key)
- AUTOTASK_INTEGRATION_CODE (integration code)

## User Impersonation:
The server supports user impersonation as per Autotask REST API documentation. When using multi-tenant mode, you can include an optional impersonationResourceId in the tenant credentials to act on behalf of a specific user. This is useful for:
- Creating entities that should be attributed to specific users rather than "API User"
- Maintaining proper audit trails and ownership
- Supporting applications that need to act on behalf of end users

## Access Control Modes:
The server supports access control modes to restrict operations per tenant session:
- **write** (default): Full access to all operations (read, write, modify)  
- **read**: Restricted to read-only operations only (searches, gets, tests)

Include the mode in tenant credentials to enforce restrictions:
- Mode "read" blocks all create, update, and modify operations
- Mode "write" allows all operations
- If no mode is specified, defaults to "write" for backward compatibility

Requirements for impersonation:
- Both the API user and the target user must have appropriate security permissions
- The target user's security level must allow impersonation
- The API user must have permission to impersonate for the specific entity types

For more information, visit: https://github.com/your-org/autotask-mcp
`.trim();
  }
}