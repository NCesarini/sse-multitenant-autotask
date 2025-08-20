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
    this.logger.debug('🔍 Extracting tenant context from tool arguments', {
      hasArgs: !!args,
      argKeys: Object.keys(args || {}),
      has_tenant: !!(args && args._tenant),
      hasTenant: !!(args && args.tenant),
      hasCredentials: !!(args && args.credentials)
    });

    // Check if tenant credentials are provided in the arguments
    if (args._tenant || args.tenant || args.credentials) {
      const tenantData = args._tenant || args.tenant || args.credentials;
      
      this.logger.info('🏢 Found tenant data in arguments', {
        dataSource: args._tenant ? '_tenant' : args.tenant ? 'tenant' : 'credentials',
        hasUsername: !!tenantData.username,
        hasSecret: !!tenantData.secret,
        hasIntegrationCode: !!tenantData.integrationCode,
        hasApiUrl: !!tenantData.apiUrl,
        hasTenantId: !!tenantData.tenantId,
        hasSessionId: !!tenantData.sessionId,
        tenantId: tenantData.tenantId,
        username: tenantData.username ? `${tenantData.username.substring(0, 3)}***` : undefined,
        apiUrl: tenantData.apiUrl
      });
      
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

        this.logger.info('✅ Successfully extracted tenant context', {
          tenantId: tenantContext.tenantId,
          username: credentials.username ? `${credentials.username.substring(0, 3)}***` : undefined,
          hasApiUrl: !!credentials.apiUrl,
          sessionId: tenantContext.sessionId
        });

        // Remove tenant data from args to avoid passing to service methods
        delete args._tenant;
        delete args.tenant;
        delete args.credentials;

        this.logger.debug('🧹 Cleaned tenant data from arguments', {
          remainingArgKeys: Object.keys(args)
        });

        return tenantContext;
      } else {
        this.logger.warn('⚠️ Incomplete tenant credentials found', {
          hasUsername: !!tenantData.username,
          hasSecret: !!tenantData.secret,
          hasIntegrationCode: !!tenantData.integrationCode,
          missingFields: [
            !tenantData.username && 'username',
            !tenantData.secret && 'secret',
            !tenantData.integrationCode && 'integrationCode'
          ].filter(Boolean)
        });
      }
    } else {
      this.logger.debug('🏠 No tenant credentials found - using single-tenant mode');
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
      {
        name: 'update_company',
        description: 'Update an existing company in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'Company ID to update'
            },
            companyName: {
              type: 'string',
              description: 'Company name'
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
          required: ['id']
        }
      },

      // Contact tools
      {
        name: 'search_contacts',
        description: 'Search for contacts in Autotask with filters',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: {
              type: 'string',
              description: 'Search term to filter contacts by name or email'
            },
            companyId: {
              type: 'number',
              description: 'Filter by company ID'
            },
            isActive: {
              type: 'boolean',
              description: 'Filter by active status'
            },
            pageSize: {
              type: 'number',
              description: 'Number of results to return (max 500)',
              minimum: 1,
              maximum: 500
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
          }
        }
      },
      {
        name: 'create_contact',
        description: 'Create a new contact in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            companyID: {
              type: 'number',
              description: 'Company ID for the contact'
            },
            firstName: {
              type: 'string',
              description: 'First name'
            },
            lastName: {
              type: 'string',
              description: 'Last name'
            },
            emailAddress: {
              type: 'string',
              description: 'Email address'
            },
            phone: {
              type: 'string',
              description: 'Phone number'
            },
            title: {
              type: 'string',
              description: 'Job title'
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
          required: ['companyID', 'firstName', 'lastName']
        }
      },
      {
        name: 'update_contact',
        description: 'Update an existing contact in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'Contact ID to update'
            },
            firstName: {
              type: 'string',
              description: 'First name'
            },
            lastName: {
              type: 'string',
              description: 'Last name'
            },
            emailAddress: {
              type: 'string',
              description: 'Email address'
            },
            phone: {
              type: 'string',
              description: 'Phone number'
            },
            title: {
              type: 'string',
              description: 'Job title'
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
          required: ['id']
        }
      },

      // Ticket tools
      {
        name: 'search_tickets',
        description: 'Search for tickets in Autotask with filters',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: {
              type: 'string',
              description: 'Search term to filter tickets by number or title'
            },
            status: {
              type: 'number',
              description: 'Filter by status ID'
            },
            companyId: {
              type: 'number',
              description: 'Filter by company ID'
            },
            assignedResourceID: {
              type: 'number',
              description: 'Filter by assigned resource ID'
            },
            unassigned: {
              type: 'boolean',
              description: 'Filter for unassigned tickets'
            },
            pageSize: {
              type: 'number',
              description: 'Number of results to return (max 500)',
              minimum: 1,
              maximum: 500
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
          }
        }
      },
      {
        name: 'create_ticket',
        description: 'Create a new ticket in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            companyID: {
              type: 'number',
              description: 'Company ID for the ticket'
            },
            title: {
              type: 'string',
              description: 'Ticket title'
            },
            description: {
              type: 'string',
              description: 'Ticket description'
            },
            priority: {
              type: 'number',
              description: 'Priority level'
            },
            status: {
              type: 'number',
              description: 'Status ID'
            },
            assignedResourceID: {
              type: 'number',
              description: 'Assigned resource ID'
            },
            contactID: {
              type: 'number',
              description: 'Contact ID'
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
          required: ['companyID', 'title']
        }
      },
      {
        name: 'update_ticket',
        description: 'Update an existing ticket in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'Ticket ID to update'
            },
            title: {
              type: 'string',
              description: 'Ticket title'
            },
            description: {
              type: 'string',
              description: 'Ticket description'
            },
            priority: {
              type: 'number',
              description: 'Priority level'
            },
            status: {
              type: 'number',
              description: 'Status ID'
            },
            assignedResourceID: {
              type: 'number',
              description: 'Assigned resource ID'
            },
            resolution: {
              type: 'string',
              description: 'Ticket resolution'
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
          required: ['id']
        }
      },

      // Time Entry tools
      {
        name: 'create_time_entry',
        description: 'Log time against a ticket or project in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            ticketID: {
              type: 'number',
              description: 'Ticket ID (if logging time against a ticket)'
            },
            projectID: {
              type: 'number',
              description: 'Project ID (if logging time against a project)'
            },
            resourceID: {
              type: 'number',
              description: 'Resource ID (person logging time)'
            },
            dateWorked: {
              type: 'string',
              description: 'Date worked (YYYY-MM-DD format)'
            },
            startDateTime: {
              type: 'string',
              description: 'Start date/time (ISO format)'
            },
            endDateTime: {
              type: 'string',
              description: 'End date/time (ISO format)'
            },
            hoursWorked: {
              type: 'number',
              description: 'Hours worked'
            },
            summaryNotes: {
              type: 'string',
              description: 'Summary of work performed'
            },
            internalNotes: {
              type: 'string',
              description: 'Internal notes'
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
          required: ['resourceID', 'dateWorked', 'hoursWorked']
        }
      },

      // Project tools
      {
        name: 'search_projects',
        description: 'Search for projects in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: {
              type: 'string',
              description: 'Search term to filter projects by name'
            },
            companyId: {
              type: 'number',
              description: 'Filter by company ID'
            },
            status: {
              type: 'number',
              description: 'Filter by status'
            },
            pageSize: {
              type: 'number',
              description: 'Number of results to return (max 100)',
              minimum: 1,
              maximum: 100
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
          }
        }
      },

      // Resource tools
      {
        name: 'search_resources',
        description: 'Search for resources (employees) in Autotask',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: {
              type: 'string',
              description: 'Search term to filter resources by name'
            },
            isActive: {
              type: 'boolean',
              description: 'Filter by active status'
            },
            pageSize: {
              type: 'number',
              description: 'Number of results to return (max 500)',
              minimum: 1,
              maximum: 500
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
          }
        }
      },

      // ID-to-Name Mapping tools
      {
        name: 'get_company_name',
        description: 'Get company name by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'Company ID'
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
          required: ['id']
        }
      },
      {
        name: 'get_resource_name',
        description: 'Get resource name by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'Resource ID'
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
          required: ['id']
        }
      },
      {
        name: 'get_mapping_cache_stats',
        description: 'Get mapping cache statistics',
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
      },
      {
        name: 'clear_mapping_cache',
        description: 'Clear mapping cache',
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
      },
      {
        name: 'preload_mapping_cache',
        description: 'Preload mapping cache for better performance',
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
      },

      // Zone information test tool
      {
        name: 'test_zone_information',
        description: 'Test Autotask zone information discovery to debug API URL issues',
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
    const startTime = Date.now();
    const toolCallId = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      this.logger.info(`🛠️ Tool call started: ${name}`, {
        toolCallId,
        toolName: name,
        argsProvided: Object.keys(args || {}),
        argCount: Object.keys(args || {}).length,
        timestamp: new Date().toISOString()
      }); 

      this.logger.info('ARGS', args);
      
      // Enhanced debugging for tenant context
      this.logger.info('🔍 DETAILED ARGS ANALYSIS', {
        toolCallId,
        argsType: typeof args,
        argsKeys: args ? Object.keys(args) : 'null/undefined',
        hasUnderscore_tenant: args ? '_tenant' in args : false,
        hasTenant: args ? 'tenant' in args : false,
        hasCredentials: args ? 'credentials' in args : false,
        argValues: {
          _tenant: args?._tenant ? 'present' : 'missing',
          tenant: args?.tenant ? 'present' : 'missing', 
          credentials: args?.credentials ? 'present' : 'missing'
        }
      });
      
      // Log each top-level property in args for debugging
      if (args && typeof args === 'object') {
        for (const [key, value] of Object.entries(args)) {
          this.logger.info(`🔍 ARG[${key}]`, {
            type: typeof value,
            isObject: typeof value === 'object' && value !== null,
            hasSubKeys: typeof value === 'object' && value !== null ? Object.keys(value) : 'n/a',
            preview: key.includes('secret') || key.includes('password') ? '[REDACTED]' : 
                    typeof value === 'string' ? value.substring(0, 50) : 
                    typeof value === 'object' ? '[object]' : value
          });
        }
      }

      // Extract tenant context from arguments
      const tenantContext = this.extractTenantContext(args);
      
      if (tenantContext) {
        this.logger.info(`🏢 Tool call using multi-tenant mode`, {
          toolCallId,
          toolName: name,
          tenantId: tenantContext.tenantId,
          sessionId: tenantContext.sessionId
        });
      } else {
        this.logger.info(`🏠 Tool call using single-tenant mode`, {
          toolCallId,
          toolName: name
        });
      }
      
      let result: McpToolResult;
      
      switch (name) {
        // Company tools
        case 'search_companies':
          this.logger.debug(`📊 Executing search_companies`, { toolCallId });
          result = await this.searchCompanies(args, tenantContext);
          break;
        
        case 'create_company':
          this.logger.debug(`➕ Executing create_company`, { toolCallId });
          result = await this.createCompany(args, tenantContext);
          break;

        case 'update_company':
          this.logger.debug(`✏️ Executing update_company`, { toolCallId });
          result = await this.updateCompany(args, tenantContext);
          break;

        // Contact tools
        case 'search_contacts':
          this.logger.debug(`📊 Executing search_contacts`, { toolCallId });
          result = await this.searchContacts(args, tenantContext);
          break;

        case 'create_contact':
          this.logger.debug(`➕ Executing create_contact`, { toolCallId });
          result = await this.createContact(args, tenantContext);
          break;

        case 'update_contact':
          this.logger.debug(`✏️ Executing update_contact`, { toolCallId });
          result = await this.updateContact(args, tenantContext);
          break;

        // Ticket tools
        case 'search_tickets':
          this.logger.debug(`📊 Executing search_tickets`, { toolCallId });
          result = await this.searchTickets(args, tenantContext);
          break;

        case 'create_ticket':
          this.logger.debug(`➕ Executing create_ticket`, { toolCallId });
          result = await this.createTicket(args, tenantContext);
          break;

        case 'update_ticket':
          this.logger.debug(`✏️ Executing update_ticket`, { toolCallId });
          result = await this.updateTicket(args, tenantContext);
          break;

        // Time Entry tools
        case 'create_time_entry':
          this.logger.debug(`⏰ Executing create_time_entry`, { toolCallId });
          result = await this.createTimeEntry(args, tenantContext);
          break;

        // Project tools
        case 'search_projects':
          this.logger.debug(`📊 Executing search_projects`, { toolCallId });
          result = await this.searchProjects(args, tenantContext);
          break;

        // Resource tools
        case 'search_resources':
          this.logger.debug(`📊 Executing search_resources`, { toolCallId });
          result = await this.searchResources(args, tenantContext);
          break;

        // ID-to-Name Mapping tools
        case 'get_company_name':
          this.logger.debug(`🏷️ Executing get_company_name`, { toolCallId });
          result = await this.getCompanyName(args, tenantContext);
          break;

        case 'get_resource_name':
          this.logger.debug(`🏷️ Executing get_resource_name`, { toolCallId });
          result = await this.getResourceName(args, tenantContext);
          break;

        case 'get_mapping_cache_stats':
          this.logger.debug(`📈 Executing get_mapping_cache_stats`, { toolCallId });
          result = await this.getMappingCacheStats(args, tenantContext);
          break;

        case 'clear_mapping_cache':
          this.logger.debug(`🗑️ Executing clear_mapping_cache`, { toolCallId });
          result = await this.clearMappingCache(args, tenantContext);
          break;

        case 'preload_mapping_cache':
          this.logger.debug(`🚀 Executing preload_mapping_cache`, { toolCallId });
          result = await this.preloadMappingCache(args, tenantContext);
          break;
        
        case 'test_connection':
          this.logger.debug(`🔗 Executing test_connection`, { toolCallId });
          result = await this.testConnection(tenantContext);
          break;

        case 'test_zone_information':
          this.logger.debug(`🌐 Executing test_zone_information`, { toolCallId });
          result = await this.testZoneInformation(tenantContext);
          break;

        default:
          this.logger.error(`❌ Unknown tool: ${name}`, { toolCallId, toolName: name });
          throw new Error(`Unknown tool: ${name}`);
      }

      const executionTime = Date.now() - startTime;
      const contentLength = result.content && result.content.length > 0 && result.content[0] && result.content[0].type === 'text' 
        ? (result.content[0] as any).text.length 
        : 0;
        
      this.logger.info(`✅ Tool call completed successfully: ${name}`, {
        toolCallId,
        toolName: name,
        executionTimeMs: executionTime,
        resultType: result.isError ? 'error' : 'success',
        contentLength
      });

      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logger.error(`❌ Tool call failed: ${name}`, {
        toolCallId,
        toolName: name,
        executionTimeMs: executionTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
      };
    }
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

  private async updateCompany(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const companyData = { ...args };
      const companyId = companyData.id;
      delete companyData.id; // Remove ID from data for update

      await this.autotaskService.updateCompany(companyId, companyData, tenantContext);

      return {
        content: [{
          type: 'text',
          text: `Company updated successfully with ID: ${companyId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to update company: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchContacts(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'firstName',
          op: 'contains',
          value: args.searchTerm
        }, {
          field: 'lastName',
          op: 'contains',
          value: args.searchTerm
        }, {
          field: 'emailAddress',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.companyId === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'companyID',
          op: 'eq',
          value: args.companyId
        });
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

      const contacts = await this.autotaskService.searchContacts(options, tenantContext);
      this.logger.info(`🏢 Found ${contacts.length} contacts`, {
        tenant: tenantContext,
        sessionId: tenantContext?.sessionId
      });
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedContacts = await Promise.all(
        contacts.map(async (contact: any) => {
          const enhanced: any = { ...contact };
          
          // Add company name if available
          if (contact.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(contact.companyID);
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${contact.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${contact.companyID})`;
            }
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedContacts.length > 0 
        ? `Found ${enhancedContacts.length} contacts:\n\n${enhancedContacts.map(contact => 
            `ID: ${contact.id}\nName: ${contact.firstName} ${contact.lastName}\nEmail: ${contact.emailAddress}\nCompany: ${contact._enhanced?.companyName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No contacts found matching the criteria';

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to search contacts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createContact(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const contactData = { ...args };
      
      const contactId = await this.autotaskService.createContact(contactData, tenantContext);
      
      return {
        content: [{
          type: 'text',
          text: `Contact created successfully with ID: ${contactId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to create contact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateContact(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const contactData = { ...args };
      const contactId = contactData.id;
      delete contactData.id; // Remove ID from data for update

      await this.autotaskService.updateContact(contactId, contactData, tenantContext);

      return {
        content: [{
          type: 'text',
          text: `Contact updated successfully with ID: ${contactId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to update contact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchTickets(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'title',
          op: 'contains',
          value: args.searchTerm
        }, {
          field: 'number',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.status === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'status',
          op: 'eq',
          value: args.status
        });
      }
      
      if (typeof args.companyId === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'companyID',
          op: 'eq',
          value: args.companyId
        });
      }
      
      if (typeof args.assignedResourceID === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'assignedResourceID',
          op: 'eq',
          value: args.assignedResourceID
        });
      }
      
      if (typeof args.unassigned === 'boolean') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'assignedResourceID',
          op: 'eq',
          value: null // Unassigned tickets have no assigned resource
        });
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const tickets = await this.autotaskService.searchTickets(options, tenantContext);
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedTickets = await Promise.all(
        tickets.map(async (ticket: any) => {
          const enhanced: any = { ...ticket };
          
          // Add company name if available
          if (ticket.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(ticket.companyID);
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${ticket.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${ticket.companyID})`;
            }
          }

          // Add assigned resource name if available
          if (ticket.assignedResourceID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.assignedResourceName = await mappingService.getResourceName(ticket.assignedResourceID);
            } catch (error) {
              this.logger.debug(`Failed to map assigned resource ID ${ticket.assignedResourceID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.assignedResourceName = `Unknown (${ticket.assignedResourceID})`;
            }
          }

          // Note: Contact name mapping would require additional implementation
          if (ticket.contactID) {
            enhanced._enhanced = enhanced._enhanced || {};
            enhanced._enhanced.contactName = `Contact ID: ${ticket.contactID}`;
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedTickets.length > 0 
        ? `Found ${enhancedTickets.length} tickets:\n\n${enhancedTickets.map(ticket => 
            `ID: ${ticket.id}\nNumber: ${ticket.ticketNumber}\nTitle: ${ticket.title}\nStatus: ${ticket.status}\nCompany: ${ticket._enhanced?.companyName || 'Unknown'}\nAssigned: ${ticket._enhanced?.assignedResourceName || 'Unassigned'}\nContact: ${ticket._enhanced?.contactName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No tickets found matching the criteria';

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to search tickets: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTicket(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const ticketData = { ...args };
      
      const ticketId = await this.autotaskService.createTicket(ticketData, tenantContext);
      
      return {
        content: [{
          type: 'text',
          text: `Ticket created successfully with ID: ${ticketId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to create ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateTicket(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const ticketData = { ...args };
      const ticketId = ticketData.id;
      delete ticketData.id; // Remove ID from data for update

      await this.autotaskService.updateTicket(ticketId, ticketData, tenantContext);

      return {
        content: [{
          type: 'text',
          text: `Ticket updated successfully with ID: ${ticketId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to update ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTimeEntry(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const timeEntryData = { ...args };
      
      const timeEntryId = await this.autotaskService.createTimeEntry(timeEntryData, tenantContext);
      
      return {
        content: [{
          type: 'text',
          text: `Time entry created successfully with ID: ${timeEntryId}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to create time entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchProjects(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'projectName',
          op: 'contains',
          value: args.searchTerm
        }];
      }
      
      if (typeof args.companyId === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'companyID',
          op: 'eq',
          value: args.companyId
        });
      }
      
      if (typeof args.status === 'number') {
        if (!options.filter) options.filter = [];
        options.filter.push({
          field: 'status',
          op: 'eq',
          value: args.status
        });
      }
      
      if (args.pageSize) {
        options.pageSize = args.pageSize;
      }

      const projects = await this.autotaskService.searchProjects(options, tenantContext);
      
      // Enhanced results with mapped names
      const mappingService = await this.getMappingService();
      const enhancedProjects = await Promise.all(
        projects.map(async (project: any) => {
          const enhanced: any = { ...project };
          
          // Add company name if available
          if (project.companyID) {
            try {
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = await mappingService.getCompanyName(project.companyID);
            } catch (error) {
              this.logger.debug(`Failed to map company ID ${project.companyID}:`, error);
              enhanced._enhanced = enhanced._enhanced || {};
              enhanced._enhanced.companyName = `Unknown (${project.companyID})`;
            }
          }
          
          return enhanced;
        })
      );

      const resultsText = enhancedProjects.length > 0 
        ? `Found ${enhancedProjects.length} projects:\n\n${enhancedProjects.map(project => 
            `ID: ${project.id}\nName: ${project.projectName}\nCompany: ${project._enhanced?.companyName || 'Unknown'}\n`
          ).join('\n')}`
        : 'No projects found matching the criteria';

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to search projects: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async searchResources(args: Record<string, any>, tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const options: any = {};
      
      if (args.searchTerm) {
        options.filter = [{
          field: 'firstName',
          op: 'contains',
          value: args.searchTerm
        }, {
          field: 'lastName',
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

      const resources = await this.autotaskService.searchResources(options, tenantContext);
      
      // Enhanced results with mapped names
      const enhancedResources = resources.map((resource: any) => {
        const enhanced: any = { ...resource };
        
        // Add resource name
        enhanced._enhanced = enhanced._enhanced || {};
        enhanced._enhanced.resourceName = `${resource.firstName} ${resource.lastName}`.trim();
        
        return enhanced;
      });

      const resultsText = enhancedResources.length > 0 
        ? `Found ${enhancedResources.length} resources:\n\n${enhancedResources.map(resource => 
            `ID: ${resource.id}\nName: ${resource.firstName} ${resource.lastName}\nActive: ${resource.isActive}\n`
          ).join('\n')}`
        : 'No resources found matching the criteria';

      return {
        content: [{
          type: 'text',
          text: resultsText
        }]
      };
    } catch (error) {
      throw new Error(`Failed to search resources: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getCompanyName(args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const companyId = args.id;
      if (typeof companyId !== 'number') {
        throw new Error('Company ID must be provided');
      }

      const mappingService = await this.getMappingService();
      const companyName = await mappingService.getCompanyName(companyId);
      
      return {
        content: [{
          type: 'text',
          text: `Company name for ID ${companyId}: ${companyName || 'Unknown'}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to get company name: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getResourceName(args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const resourceId = args.id;
      if (typeof resourceId !== 'number') {
        throw new Error('Resource ID must be provided');
      }

      const mappingService = await this.getMappingService();
      const resourceName = await mappingService.getResourceName(resourceId);
      
      return {
        content: [{
          type: 'text',
          text: `Resource name for ID ${resourceId}: ${resourceName || 'Unknown'}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to get resource name: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getMappingCacheStats(_args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const mappingService = await this.getMappingService();
      const stats = mappingService.getCacheStats();
      
      return {
        content: [{
          type: 'text',
          text: `Mapping Cache Statistics:\n\n` +
                `Companies:\n` +
                `  - Count: ${stats.companies.count}\n` +
                `  - Last Updated: ${stats.companies.lastUpdated}\n` +
                `  - Is Valid: ${stats.companies.isValid}\n\n` +
                `Resources:\n` +
                `  - Count: ${stats.resources.count}\n` +
                `  - Last Updated: ${stats.resources.lastUpdated}\n` +
                `  - Is Valid: ${stats.resources.isValid}`
        }]
      };
    } catch (error) {
      throw new Error(`Failed to get mapping cache stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async clearMappingCache(_args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const mappingService = await this.getMappingService();
      mappingService.clearCache();
      
      return {
        content: [{
          type: 'text',
          text: 'Mapping cache cleared successfully.'
        }]
      };
    } catch (error) {
      throw new Error(`Failed to clear mapping cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async preloadMappingCache(_args: Record<string, any>, _tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      const mappingService = await this.getMappingService();
      await mappingService.preloadCaches();
      
      return {
        content: [{
          type: 'text',
          text: 'Mapping cache preloaded successfully.'
        }]
      };
    } catch (error) {
      throw new Error(`Failed to preload mapping cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async testConnection(tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      // DEBUG: Show what we actually received
      this.logger.info('🔗 TEST_CONNECTION DEBUG', {
        hasTenantContext: !!tenantContext,
        tenantContextKeys: tenantContext ? Object.keys(tenantContext) : 'none',
        tenantId: tenantContext?.tenantId,
        hasCredentials: !!(tenantContext?.credentials)
      });

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

  private async testZoneInformation(tenantContext?: TenantContext): Promise<McpToolResult> {
    try {
      this.logger.info('🌐 TEST_ZONE_INFORMATION DEBUG', {
        hasTenantContext: !!tenantContext,
        tenantContextKeys: tenantContext ? Object.keys(tenantContext) : 'none',
        tenantId: tenantContext?.tenantId,
        hasCredentials: !!(tenantContext?.credentials)
      });

      const zoneInfo = await this.autotaskService.testZoneInformation(tenantContext);
      
      if (zoneInfo) {
        const message = tenantContext 
          ? `✅ Successfully discovered Autotask zone information for tenant: ${tenantContext.tenantId}\n\n` +
            `Zone URL: ${zoneInfo.url || 'N/A'}\n` +
            `Web URL: ${zoneInfo.webUrl || 'N/A'}\n` +
            `Full Zone Info: ${JSON.stringify(zoneInfo, null, 2)}`
          : `✅ Successfully discovered Autotask zone information\n\n` +
            `Zone URL: ${zoneInfo.url || 'N/A'}\n` +
            `Web URL: ${zoneInfo.webUrl || 'N/A'}\n` +
            `Full Zone Info: ${JSON.stringify(zoneInfo, null, 2)}`;

        return {
          content: [{
            type: 'text',
            text: message
          }]
        };
      } else {
        const message = tenantContext
          ? `❌ Failed to discover Autotask zone information for tenant: ${tenantContext.tenantId}`
          : '❌ Failed to discover Autotask zone information';

        return {
          content: [{
            type: 'text',
            text: message
          }],
          isError: true
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const message = tenantContext 
        ? `❌ Zone information test failed for tenant ${tenantContext.tenantId}: ${errorMessage}`
        : `❌ Zone information test failed: ${errorMessage}`;

      return {
        content: [{
          type: 'text',
          text: message
        }],
        isError: true
      };
    }
  }
} 