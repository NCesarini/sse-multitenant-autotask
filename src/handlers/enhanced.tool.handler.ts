/**
 * Enhanced Autotask Tool Handler with ID-to-Name Mapping
 * Extends the base tool handler to include automatic mapping of company and resource IDs to names
 */

import { McpTool, McpToolResult } from '../types/mcp.js';
import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from '../utils/logger.js';
import { MappingService } from '../utils/mapping.service.js';
import { AutotaskCredentials, TenantContext } from '../types/mcp.js';

export class EnhancedAutotaskToolHandler {
  private autotaskService: AutotaskService;
  private mappingService: MappingService | null = null;
  private logger: Logger;

  constructor(autotaskService: AutotaskService, logger: Logger) {
    this.autotaskService = autotaskService;
    this.logger = logger;
  }

  /**
   * Get mapping service instance (singleton)
   */
  private async getMappingService(): Promise<MappingService> {
    if (!this.mappingService) {
      this.mappingService = await MappingService.getInstance(this.autotaskService, this.logger);
    }
    return this.mappingService;
  }

  /**
   * Extract tenant context from tool arguments
   */
  private extractTenantContext(args: Record<string, any>): TenantContext | undefined {
    // Check if tenant credentials are provided in the arguments
    if (args._tenant || args.tenant || args.credentials) {
      const tenantData = args._tenant || args.tenant || args.credentials;
      
      if (tenantData.username && tenantData.secret && tenantData.integrationCode) {
        const credentials: AutotaskCredentials = {
          username: tenantData.username,
          secret: tenantData.secret,
          integrationCode: tenantData.integrationCode,
          apiUrl: tenantData.apiUrl
        };

        const tenantContext: TenantContext = {
          tenantId: tenantData.tenantId || `tenant_${credentials.username}`,
          credentials,
          sessionId: tenantData.sessionId
        };

        // Remove tenant data from args to avoid passing to service methods
        delete args._tenant;
        delete args.tenant;
        delete args.credentials;

        return tenantContext;
      }
    }

    return undefined;
  }



  async listTools(): Promise<McpTool[]> {
    return [
      // Company tools
      {
        name: 'search_companies',
        description: 'Search for companies in Autotask with filters and enhanced name resolution',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: {
              type: 'string',
              description: 'Search term to filter companies by name'
            },
            isActive: {
              type: 'boolean',
              description: 'Filter by active status'
            },
            pageSize: {
              type: 'number',
              description: 'Number of results to return (max 500, default: unlimited for complete results)',
              minimum: 1,
              maximum: 500
            },
            // Multi-tenant support
            _tenant: {
              type: 'object',
              description: 'Tenant authentication credentials (for multi-tenant mode)',
              properties: {
                tenantId: { type: 'string', description: 'Unique tenant identifier' },
                username: { type: 'string', description: 'Autotask API username' },
                secret: { type: 'string', description: 'Autotask API secret' },
                integrationCode: { type: 'string', description: 'Autotask integration code' },
                apiUrl: { type: 'string', description: 'Optional Autotask API URL' },
                sessionId: { type: 'string', description: 'Optional session identifier' }
              },
              required: ['username', 'secret', 'integrationCode']
            }
          }
        }
      },
      {
        name: 'create_company',
        description: 'Create a new company in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            companyName: {
              type: 'string',
              description: 'Company name'
            },
            companyType: {
              type: 'number',
              description: 'Company type ID'
            },
            phone: {
              type: 'string',
              description: 'Phone number'
            },
            fax: {
              type: 'string',
              description: 'Fax number'
            },
            address1: {
              type: 'string',
              description: 'Address line 1'
            },
            address2: {
              type: 'string',
              description: 'Address line 2'
            },
            city: {
              type: 'string',
              description: 'City'
            },
            state: {
              type: 'string',
              description: 'State/Province'
            },
            postalCode: {
              type: 'string',
              description: 'Postal/ZIP code'
            },
            country: {
              type: 'string',
              description: 'Country'
            },
            ownerResourceID: {
              type: 'number',
              description: 'Owner resource ID'
            },
            _tenant: {
              type: 'object',
              description: 'Tenant authentication credentials (for multi-tenant mode)',
              properties: {
                tenantId: { type: 'string' },
                username: { type: 'string' },
                secret: { type: 'string' },
                integrationCode: { type: 'string' },
                apiUrl: { type: 'string' },
                sessionId: { type: 'string' }
              },
              required: ['username', 'secret', 'integrationCode']
            }
          },
          required: ['companyName', 'companyType']
        }
      },
      // Test connection tool
      {
        name: 'test_connection',
        description: 'Test connectivity to the Autotask API',
        inputSchema: {
          type: 'object',
          properties: {
            _tenant: {
              type: 'object',
              description: 'Tenant authentication credentials (for multi-tenant mode)',
              properties: {
                tenantId: { type: 'string' },
                username: { type: 'string' },
                secret: { type: 'string' },
                integrationCode: { type: 'string' },
                apiUrl: { type: 'string' },
                sessionId: { type: 'string' }
              },
              required: ['username', 'secret', 'integrationCode']
            }
          }
        }
      }
    ];
  }

  async callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
    try {
      this.logger.debug(`Calling tool: ${name}`, { args: this.sanitizeArgsForLogging(args) });

      // Extract tenant context from arguments
      const tenantContext = this.extractTenantContext(args);
      
      switch (name) {
        case 'search_companies':
          return await this.searchCompanies(args, tenantContext);
        
        case 'create_company':
          return await this.createCompany(args, tenantContext);
        
        case 'test_connection':
          return await this.testConnection(tenantContext);

        // Add other tool cases here...

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      this.logger.error(`Tool call failed: ${name}`, error);
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
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

  private async searchCompanies(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'companyName',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.isActive === 'boolean') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'isActive',
          op: 'eq',
          value: args.isActive
        });
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const companies = await this.autotaskService.searchCompanies(options, tenantContext);
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedCompanies = await Promise.all(
        companies.map(async (company: any) => {
          const enhanced: any = { ...company };
          
          // Add owner resource name if available
          if (company.ownerResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = await mappingService.getResourceName(company.ownerResourceID);
            } catch (error) {
              this.logger.debug(`Failed to map owner resource ID ${company.ownerResourceID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.ownerResourceName = `Unknown (${company.ownerResourceID})`;
            }
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedCompanies.length > 0 
        ? `Found ${enhancedCompanies.length} companies:\n\n${enhancedCompanies.map(company => 
            `ID: ${company.id}\nName: ${company.companyName}\nType: ${company.companyType}\nActive: ${company.isActive}\nOwner: ${company._enhanced?.ownerResourceName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No companies found matching the criteria';

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to search companies: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createCompany(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const companyData = { ...args };
      
      const companyId = await this.autotaskService.createCompany(companyData, tenantContext);
      
      return {
        content: [{
          type: 'text',
          text: `Company created successfully with ID: ${companyId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to create company: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async testConnection(tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const isConnected = await this.autotaskService.testConnection(tenantContext);
      
      const message = isConnected 
        ? tenantContext 
          ? `✅ Successfully connected to Autotask API for tenant: ${tenantContext.tenantId}`
          : '✅ Successfully connected to Autotask API'
        : tenantContext
          ? `❌ Failed to connect to Autotask API for tenant: ${tenantContext.tenantId}`
          : '❌ Failed to connect to Autotask API';

      return {
        content: [{
          type: 'text',
          text: message
        }],
        isError: !isConnected
      };
    } catch (error) {
      throw new Error(`Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
} 