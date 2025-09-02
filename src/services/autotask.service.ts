// Autotask Service Layer
// Wraps the autotask-node client with our specific types and error handling

import { AutotaskClient } from 'autotask-node';
import { 
  AutotaskCompany, 
  AutotaskContact, 
  AutotaskTicket, 
  AutotaskTimeEntry,
  AutotaskProject,
  AutotaskResource,
  AutotaskConfigurationItem,
  AutotaskContract,
  AutotaskInvoice,
  AutotaskTask,
  AutotaskQueryOptions,
  AutotaskTicketNote,
  AutotaskProjectNote,
  AutotaskCompanyNote,
  AutotaskTicketAttachment,
  AutotaskExpenseReport,
  AutotaskExpenseItem,
  AutotaskQuote,
  AutotaskBillingCode,
  AutotaskDepartment,
  AutotaskQueryOptionsExtended
} from '../types/autotask';
import { McpServerConfig, AutotaskCredentials, TenantContext } from '../types/mcp';
import { Logger } from '../utils/logger';

// New: Client pool management for multi-tenant support
interface ClientPoolEntry {
  client: AutotaskClient;
  tenantId: string;
  lastUsed: Date;
  credentials: AutotaskCredentials;
}

export class AutotaskService {
  private client: AutotaskClient | null = null;
  private logger: Logger;
  private config: McpServerConfig;
  private initializationPromise: Promise<void> | null = null;
  
  // New: Multi-tenant support
  private isMultiTenant: boolean;
  private clientPool: Map<string, ClientPoolEntry> = new Map();
  private readonly poolSize: number;
  private readonly sessionTimeout: number;

  constructor(config: McpServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.isMultiTenant = config.multiTenant?.enabled ?? false;
    this.poolSize = config.multiTenant?.clientPoolSize ?? 50;
    this.sessionTimeout = config.multiTenant?.sessionTimeout ?? 30 * 60 * 1000; // 30 minutes

    if (!this.isMultiTenant) {
      // Single-tenant mode: initialize immediately if credentials available
      if (config.autotask?.username && config.autotask?.secret && config.autotask?.integrationCode) {
        this.logger.info('Single-tenant mode: credentials provided, will initialize on first use');
      }
    } else {
      this.logger.info('Multi-tenant mode enabled', { 
        poolSize: this.poolSize, 
        sessionTimeout: this.sessionTimeout 
      });
      // Start cleanup interval for expired clients
      this.startClientCleanup();
    }
  }
 

  /**
   * Get or create Autotask client for tenant
   */
  private async getClientForTenant(tenantContext?: TenantContext): Promise<AutotaskClient> {
    if (!this.isMultiTenant) {
      // Single-tenant mode: use default client
      this.logger.info('🏠 Using single-tenant mode - getting default client');
      return this.ensureClient();
    }

    this.logger.info('🏢 Multi-tenant mode enabled - processing tenant context', {
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      hasCredentials: !!tenantContext?.credentials,
      sessionId: tenantContext?.sessionId
    });

    if (!tenantContext?.credentials) {
      this.logger.error('❌ Multi-tenant mode requires tenant credentials but none provided');
      throw new Error('Multi-tenant mode requires tenant credentials');
    }

    const tenantId = tenantContext.tenantId;
    const cacheKey = this.getTenantCacheKey(tenantContext.credentials);

    this.logger.info('🔍 Checking client pool for tenant', {
      tenantId,
      cacheKey: cacheKey.substring(0, 8) + '...',
      poolSize: this.clientPool.size,
      poolKeys: Array.from(this.clientPool.keys()).map(k => k.substring(0, 8) + '...')
    });

    // Check if we have a cached client for this tenant
    const poolEntry = this.clientPool.get(cacheKey);
    if (poolEntry && this.isClientValid(poolEntry)) {
      poolEntry.lastUsed = new Date();
      this.logger.info(`♻️ Using cached client for tenant: ${tenantId}`, {
        tenantId,
        cacheKey: cacheKey.substring(0, 8) + '...',
        clientAge: Date.now() - poolEntry.lastUsed.getTime(),
        poolSize: this.clientPool.size
      });
      return poolEntry.client;
    }

    if (poolEntry && !this.isClientValid(poolEntry)) {
      this.logger.info('⏰ Cached client expired for tenant, removing from pool', {
        tenantId,
        cacheKey: cacheKey.substring(0, 8) + '...',
        lastUsed: poolEntry.lastUsed
      });
      this.clientPool.delete(cacheKey);
    }

    // Create new client for tenant
    this.logger.info(`🆕 Creating new Autotask client for tenant: ${tenantId}`, {
      tenantId,
      username: tenantContext.credentials.username ? `${tenantContext.credentials.username.substring(0, 3)}***` : undefined,
      hasApiUrl: !!tenantContext.credentials.apiUrl,
      apiUrl: tenantContext.credentials.apiUrl,
      poolSizeBefore: this.clientPool.size
    });
    
    const client = await this.createTenantClient(tenantContext.credentials, tenantContext.impersonationResourceId);

    // Store in pool (with size limit)
    this.managePoolSize();
    this.clientPool.set(cacheKey, {
      client,
      tenantId,
      lastUsed: new Date(),
      credentials: tenantContext.credentials
    });

    this.logger.info(`✅ Client created and cached for tenant: ${tenantId}`, {
      tenantId,
      cacheKey: cacheKey.substring(0, 8) + '...',
      poolSizeAfter: this.clientPool.size
    });

    return client;
  }

  /**
   * Create cache key for tenant credentials
   */
  private getTenantCacheKey(credentials: AutotaskCredentials): string {
    // Create a hash-like key from credentials (excluding sensitive data from logs)
    const keyData = `${credentials.username}:${credentials.integrationCode}:${credentials.apiUrl || 'auto'}`;
    return Buffer.from(keyData).toString('base64').substring(0, 16);
  }

  /**
   * Check if cached client is still valid
   */
  private isClientValid(poolEntry: ClientPoolEntry): boolean {
    const now = new Date();
    const timeSinceLastUsed = now.getTime() - poolEntry.lastUsed.getTime();
    return timeSinceLastUsed < this.sessionTimeout;
  }

  /**
   * Manage client pool size
   */
  private managePoolSize(): void {
    if (this.clientPool.size >= this.poolSize) {
      // Remove oldest client
      let oldestKey = '';
      let oldestTime = new Date();

      for (const [key, entry] of this.clientPool.entries()) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.logger.info(`Removing oldest client from pool: ${oldestKey}`);
        this.clientPool.delete(oldestKey);
      }
    }
  }

  /**
   * Start periodic cleanup of expired clients
   */
  private startClientCleanup(): void {
    setInterval(() => {
      const now = new Date();
      const expiredKeys: string[] = [];

      for (const [key, entry] of this.clientPool.entries()) {
        const timeSinceLastUsed = now.getTime() - entry.lastUsed.getTime();
        if (timeSinceLastUsed > this.sessionTimeout) {
          expiredKeys.push(key);
        }
      }

      expiredKeys.forEach(key => {
        this.logger.info(`Removing expired client from pool: ${key}`);
        this.clientPool.delete(key);
      });

      if (expiredKeys.length > 0) {
        this.logger.info(`Cleaned up ${expiredKeys.length} expired clients from pool`);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  /**
   * Create Autotask client for specific tenant
   */
  private async createTenantClient(credentials: AutotaskCredentials, impersonationResourceId?: number): Promise<AutotaskClient> {
    try {
      const { username, secret, integrationCode, apiUrl } = credentials;
      
      this.logger.info('Creating Autotask client for tenant...', { 
        impersonationResourceId: impersonationResourceId ? `[Resource ID: ${impersonationResourceId}]` : undefined,
        credentials: {
          username,
          secret: secret ? `${secret.substring(0, 3)}***${secret.substring(secret.length - 3)}` : undefined,
          integrationCode,
          apiUrl: apiUrl || 'auto-discovery'
        }
      });

      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required Autotask credentials: username, secret, and integrationCode are required');
      }

      this.logger.info('Creating Autotask client for tenant...', { 
        impersonationResourceId: impersonationResourceId ? `[Resource ID: ${impersonationResourceId}]` : undefined 
      });
      
      const authConfig: any = {
        username,
        secret,
        integrationCode
      };
      
      // API URL resolution logic with detailed logging
      if (apiUrl) {
        authConfig.apiUrl = apiUrl;
        this.logger.info(`Using explicit API URL: ${apiUrl}`, { 
          source: 'tenant-credentials',
          apiUrl 
        });
      } else if (this.config.multiTenant?.defaultApiUrl) {
        authConfig.apiUrl = this.config.multiTenant.defaultApiUrl;
        this.logger.info(`Using default API URL: ${this.config.multiTenant.defaultApiUrl}`, { 
          source: 'multi-tenant-config',
          apiUrl: this.config.multiTenant.defaultApiUrl 
        });
      } else {
        this.logger.info('Using autotask-node auto-discovery for API URL', { 
          source: 'auto-discovery',
          note: 'Library will discover zone automatically'
        });
      }

      // Add impersonation header if provided
      if (impersonationResourceId) {
        authConfig.headers = {
          'ImpersonationResourceId': impersonationResourceId.toString()
        };
        this.logger.info(`Added impersonation header for resource ID: ${impersonationResourceId}`, {
          impersonationResourceId,
          tenantUsername: username ? `${username.substring(0, 3)}***` : undefined
        });
      }

      this.logger.info('Creating Autotask client with configuration:', {
        username: username ? `${username.substring(0, 8)}***` : undefined,
        hasSecret: !!secret,
        integrationCode,
        apiUrl: authConfig.apiUrl || 'auto-discovery',
        hasImpersonation: !!impersonationResourceId
      });

      const client = await AutotaskClient.create(authConfig);
      
      this.logger.info('✅ Tenant Autotask client created successfully', {
        username: username ? `${username.substring(0, 8)}***` : undefined,
        finalApiUrl: authConfig.apiUrl || 'discovered',
        hasImpersonation: !!impersonationResourceId
      });
      
      return client;
    } catch (error) {
      this.logger.error('❌ Failed to create tenant Autotask client:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        username: credentials.username ? `${credentials.username.substring(0, 8)}***` : undefined,
        hasSecret: !!credentials.secret,
        integrationCode: credentials.integrationCode,
        apiUrl: credentials.apiUrl || 'auto-discovery'
      });
      throw error;
    }
  }

  /**
   * Initialize the Autotask client with credentials (single-tenant mode)
   */
  async initialize(): Promise<void> {
    try {
      const { username, secret, integrationCode, apiUrl } = this.config.autotask || {};
      
      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required Autotask credentials: username, secret, and integrationCode are required');
      }

      this.logger.info('Initializing Autotask client...');
      
      // Only include apiUrl if it's defined
      const authConfig: any = {
        username,
        secret,
        integrationCode
      };
      
      if (apiUrl) {
        authConfig.apiUrl = apiUrl;
      }

      this.client = await AutotaskClient.create(authConfig);

      this.logger.info('Autotask client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Autotask client:', error);
      throw error;
    }
  }

  /**
   * Ensure client is initialized (with lazy initialization) - single-tenant mode
   */
  private async ensureClient(): Promise<AutotaskClient> {
    if (!this.client) {
      await this.ensureInitialized();
    }
    return this.client!;
  }

  /**
   * Ensure the client is initialized, handling concurrent calls
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initializationPromise) {
      // Already initializing, wait for it to complete
      await this.initializationPromise;
      return;
    }

    if (this.client) {
      // Already initialized
      return;
    }

    // Start initialization
    this.initializationPromise = this.initialize();
    await this.initializationPromise;
  }

  // Company operations (updated to support multi-tenant)
  async getCompany(id: number, tenantContext?: TenantContext): Promise<AutotaskCompany | null> {
    const startTime = Date.now();
    
    this.logger.info('🏢 Getting company by ID', {
      companyId: id,
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      operation: 'getCompany'
    });

    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting company with ID: ${id}`, { tenant: tenantContext?.tenantId });
      const result = await client.accounts.get(id);
      
      const executionTime = Date.now() - startTime;
      this.logger.info('✅ Company retrieved successfully', {
        companyId: id,
        found: !!result.data,
        tenantId: tenantContext?.tenantId,
        executionTimeMs: executionTime
      });
      
      return result.data as AutotaskCompany || null;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logger.error(`❌ Failed to get company ${id}:`, {
        companyId: id,
        tenantId: tenantContext?.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTimeMs: executionTime
      });
      throw error;
    }
  }

  async searchCompanies(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskCompany[]> {
    const startTime = Date.now();
    
    this.logger.info('🔍 Searching companies', {
      hasTenantContext: !!tenantContext,
      tenantId: tenantContext?.tenantId,
      impersonationResourceId: tenantContext?.impersonationResourceId,
      hasFilter: !!options.filter,
      filterCount: options.filter?.length || 0,
      pageSize: options.pageSize,
      operation: 'searchCompanies'
    });

    // Log detailed API parameters
    this.logger.info('📋 API Parameters for searchCompanies', {
      tenantId: tenantContext?.tenantId,
      impersonationResourceId: tenantContext?.impersonationResourceId,
      queryOptions: {
        filter: options.filter,
        pageSize: options.pageSize,
        ...options // Include any other options
      },
      apiEndpoint: 'client.accounts.list'
    });

    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching companies with options:', options);
      
      // PAGINATION BY DEFAULT for data accuracy
      // Only limit results when user explicitly provides pageSize
      if (options.pageSize !== undefined && options.pageSize > 0) {
        // User wants limited results
        const queryOptions = {
          ...options,
          pageSize: Math.min(options.pageSize, 500) // Respect user limit, max 500 per request
        };

        this.logger.info('Single page request with user-specified limit:', queryOptions);
        
        const result = await client.accounts.list(queryOptions as any);
        const companies = (result.data as AutotaskCompany[]) || [];
        
        const executionTime = Date.now() - startTime;
        this.logger.info(`✅ Retrieved ${companies.length} companies (limited by user to ${options.pageSize})`, {
          tenantId: tenantContext?.tenantId,
          resultCount: companies.length,
          requestedPageSize: options.pageSize,
          executionTimeMs: executionTime
        });
        return companies;
        
      } else {
        // DEFAULT: Get ALL matching companies via pagination for complete accuracy
        let allCompanies: AutotaskCompany[] = [];
        const pageSize = 500; // Use max safe page size for efficiency
        let currentPage = 1;
        let hasMorePages = true;
        
        while (hasMorePages) {
          const queryOptions = {
            ...options,
            pageSize: pageSize,
            page: currentPage
          };

          this.logger.info(`Fetching companies page ${currentPage}...`, {
            tenantId: tenantContext?.tenantId,
            page: currentPage,
            pageSize
          });
          
          const result = await client.accounts.list(queryOptions as any);
          const companies = (result.data as AutotaskCompany[]) || [];
          
          if (companies.length === 0) {
            hasMorePages = false;
          } else {
            allCompanies.push(...companies);
            
            // Check if we got a full page - if not, we're done
            if (companies.length < pageSize) {
              hasMorePages = false;
            } else {
              currentPage++;
            }
          }
          
          // Safety check to prevent infinite loops
          if (currentPage > 50) {
            this.logger.warn('Company pagination safety limit reached at 50 pages (25,000 companies)', {
              tenantId: tenantContext?.tenantId,
              totalCompanies: allCompanies.length
            });
            hasMorePages = false;
          }
        }
        
        const executionTime = Date.now() - startTime;
        this.logger.info(`✅ Retrieved ${allCompanies.length} companies across ${currentPage} pages (COMPLETE dataset for accuracy)`, {
          tenantId: tenantContext?.tenantId,
          resultCount: allCompanies.length,
          pagesRetrieved: currentPage,
          executionTimeMs: executionTime
        });
        return allCompanies;
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logger.error('❌ Failed to search companies:', {
        tenantId: tenantContext?.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTimeMs: executionTime,
        options
      });
      throw error;
    }
  }

  async createCompany(company: Partial<AutotaskCompany>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('🏢 Creating company', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        operation: 'createCompany'
      });

      // Log detailed API parameters (excluding sensitive data)
      this.logger.info('📋 API Parameters for createCompany', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        companyData: {
          companyName: company.companyName,
          companyType: company.companyType,
          hasOwnerResourceID: !!company.ownerResourceID,
          hasPhone: !!company.phone,
          hasAddress: !!(company.address1 || company.address2),
          fieldCount: Object.keys(company).length
        },
        apiEndpoint: 'client.accounts.create'
      });

      const result = await client.accounts.create(company as any);
      const companyId = (result.data as any)?.id;
      this.logger.info(`Company created with ID: ${companyId}`);
      return companyId;
    } catch (error) {
      this.logger.error('Failed to create company:', error);
      throw error;
    }
  }

  async updateCompany(id: number, updates: Partial<AutotaskCompany>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating company ${id}:`, updates);
      await client.accounts.update(id, updates as any);
      this.logger.info(`Company ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update company ${id}:`, error);
      throw error;
    }
  }

  // Contact operations
  async getContact(id: number, tenantContext?: TenantContext): Promise<AutotaskContact | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting contact with ID: ${id}`);
      const result = await client.contacts.get(id);
      return result.data as AutotaskContact || null;
    } catch (error) {
      this.logger.error(`Failed to get contact ${id}:`, error);
      throw error;
    }
  }

  async searchContacts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskContact[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching contacts with options:', options);
      
      // PAGINATION BY DEFAULT for data accuracy
      // Only limit results when user explicitly provides pageSize
      if (options.pageSize !== undefined && options.pageSize > 0) {
        // User wants limited results
        const queryOptions = {
          ...options,
          pageSize: Math.min(options.pageSize, 500) // Respect user limit, max 500 per request
        };

        this.logger.info('Single page request with user-specified limit:', queryOptions);
        
        const result = await client.contacts.list(queryOptions as any);
        const contacts = (result.data as AutotaskContact[]) || [];
        
        this.logger.info(`Retrieved ${contacts.length} contacts (limited by user to ${options.pageSize})`);
        return contacts;
        
      } else {
        // DEFAULT: Get ALL matching contacts via pagination for complete accuracy
        let allContacts: AutotaskContact[] = [];
        const pageSize = 500; // Use max safe page size for efficiency
        let currentPage = 1;
        let hasMorePages = true;
        
        while (hasMorePages) {
          const queryOptions = {
            ...options,
            pageSize: pageSize,
            page: currentPage
          };

          this.logger.info(`Fetching contacts page ${currentPage}...`);
          
          const result = await client.contacts.list(queryOptions as any);
          const contacts = (result.data as AutotaskContact[]) || [];
          
          if (contacts.length === 0) {
            hasMorePages = false;
          } else {
            allContacts.push(...contacts);
            
            // Check if we got a full page - if not, we're done
            if (contacts.length < pageSize) {
              hasMorePages = false;
            } else {
              currentPage++;
            }
          }
          
          // Safety check to prevent infinite loops
          if (currentPage > 30) {
            this.logger.warn('Contact pagination safety limit reached at 30 pages (15,000 contacts)');
            hasMorePages = false;
          }
        }
        
        this.logger.info(`Retrieved ${allContacts.length} contacts across ${currentPage} pages (COMPLETE dataset for accuracy)`);
        return allContacts;
      }
    } catch (error) {
      this.logger.error('Failed to search contacts:', error);
      throw error;
    }
  }

  async createContact(contact: Partial<AutotaskContact>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating contact:', contact);
      const result = await client.contacts.create(contact as any);
      const contactId = (result.data as any)?.id;
      this.logger.info(`Contact created with ID: ${contactId}`);
      return contactId;
    } catch (error) {
      this.logger.error('Failed to create contact:', error);
      throw error;
    }
  }

  async updateContact(id: number, updates: Partial<AutotaskContact>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating contact ${id}:`, updates);
      await client.contacts.update(id, updates as any);
      this.logger.info(`Contact ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update contact ${id}:`, error);
      throw error;
    }
  }

  // Ticket operations
  async getTicket(id: number, fullDetails: boolean = false, tenantContext?: TenantContext): Promise<AutotaskTicket | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket with ID: ${id}, fullDetails: ${fullDetails}`);
      
      const result = await client.tickets.get(id);
      const ticket = result.data as AutotaskTicket;
      
      if (!ticket) {
        return null;
      }
      
      // Apply optimization unless full details requested
      return fullDetails ? ticket : this.optimizeTicketData(ticket);
    } catch (error) {
      this.logger.error(`Failed to get ticket ${id}:`, error);
      throw error;
    }
  }

  async searchTickets(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskTicket[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('🎫 Searching tickets', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        hasSearchTerm: !!options.searchTerm,
        hasStatusFilter: options.status !== undefined,
        pageSize: options.pageSize,
        operation: 'searchTickets'
      });

      // Log detailed API parameters
      this.logger.info('📋 API Parameters for searchTickets', {
        tenantId: tenantContext?.tenantId,
        impersonationResourceId: tenantContext?.impersonationResourceId,
        searchCriteria: {
          searchTerm: options.searchTerm,
          status: options.status,
          pageSize: options.pageSize,
          // Don't log the full filter array as it can be large, just summary
          filterCount: 'will be calculated'
        },
        apiEndpoint: 'client.tickets.list'
      });
      
      // Build proper filter array for Autotask API
      const filters: any[] = [];
      
      // Handle searchTerm - search in ticket number and title
      if (options.searchTerm) {
        filters.push(
          {
            op: 'beginsWith',
            field: 'ticketNumber',
            value: options.searchTerm
          }
        );
      }
      
      // Handle status filter with more accurate open ticket definition
      if (options.status !== undefined) {
        filters.push({
          op: 'eq',
          field: 'status',
          value: options.status
        });
      } else {
        // For "open" tickets, we need to be more specific about Autotask status values
        // Based on Autotask documentation, typical open statuses are:
        // 1 = New, 2 = In Progress, 8 = Waiting Customer, 9 = Waiting Vendor, etc.
        // Status 5 = Complete/Closed, so anything NOT complete should be considered open
        filters.push({
          op: 'ne',
          field: 'status',
          value: 5  // 5 = Complete in Autotask
        });
      }
      
      // Handle assignedResourceID filter or unassigned filter
      if (options.unassigned === true) {
        // Search for tickets with no assigned resource (null assignedResourceID)
        filters.push({
          op: 'eq',
          field: 'assignedResourceID',
          value: null
        });
      } else if (options.assignedResourceID !== undefined) {
        filters.push({
          op: 'eq',
          field: 'assignedResourceID',
          value: options.assignedResourceID
        });
      }
      
      // Only add company filter if explicitly provided
      if (options.companyId !== undefined) {
        filters.push({
          op: 'eq',
          field: 'companyID',
          value: options.companyId
        });
      }
      
      // PAGINATION BY DEFAULT for data accuracy
      // Only limit results when user explicitly provides pageSize
      if (options.pageSize !== undefined && options.pageSize > 0) {
        // User wants limited results
        const queryOptions = {
          filter: filters,
          pageSize: Math.min(options.pageSize, 500) // Respect user limit, max 500 per request
        };

        this.logger.info('Single page request with user-specified limit:', queryOptions);
        
        const result = await client.tickets.list(queryOptions);
        const tickets = (result.data as AutotaskTicket[]) || [];
        
        // Log API call result
        this.logger.info('📊 API Result for searchTickets', {
          tenantId: tenantContext?.tenantId,
          impersonationResourceId: tenantContext?.impersonationResourceId,
          resultCount: tickets.length,
          requestedPageSize: options.pageSize,
          actualFilterCount: filters.length,
          apiEndpoint: 'client.tickets.list',
          hasResultData: !!result.data
        });
        
        const optimizedTickets = tickets.map(ticket => this.optimizeTicketDataAggressive(ticket));
        
        this.logger.info(`✅ Retrieved ${optimizedTickets.length} tickets (limited by user to ${options.pageSize})`, {
          tenantId: tenantContext?.tenantId,
          impersonationResourceId: tenantContext?.impersonationResourceId,
          resultCount: optimizedTickets.length
        });
        return optimizedTickets;
        
      } else {
        // DEFAULT: Get ALL matching tickets via pagination for complete accuracy
        let allTickets: AutotaskTicket[] = [];
        const pageSize = 500; // Use max safe page size for efficiency
        let currentPage = 1;
        let hasMorePages = true;
        
        while (hasMorePages) {
          const queryOptions = {
            filter: filters,
            pageSize: pageSize,
            page: currentPage
          };

          this.logger.info(`Fetching page ${currentPage} with filter:`, filters);
          
          const result = await client.tickets.list(queryOptions);
          const tickets = (result.data as AutotaskTicket[]) || [];
          
          if (tickets.length === 0) {
            hasMorePages = false;
          } else {
            // Transform tickets to optimize data size
            const optimizedTickets = tickets.map(ticket => this.optimizeTicketDataAggressive(ticket));
            allTickets.push(...optimizedTickets);
            
            // Check if we got a full page - if not, we're done
            if (tickets.length < pageSize) {
              hasMorePages = false;
            } else {
              currentPage++;
            }
          }
          
          // Safety check to prevent infinite loops
          if (currentPage > 100) {
            this.logger.warn('Pagination safety limit reached at 100 pages (50,000 tickets)');
            hasMorePages = false;
          }
        }
        
        this.logger.info(`Retrieved ${allTickets.length} tickets across ${currentPage} pages (COMPLETE dataset for accuracy)`);
        return allTickets;
      }
    } catch (error) {
      this.logger.error('Failed to search tickets:', error);
      throw error;
    }
  }

  /**
   * Aggressively optimize ticket data by keeping only essential fields
   * Since the API returns all 76 fields (~2KB per ticket), we need to be very selective
   */
  private optimizeTicketDataAggressive(ticket: AutotaskTicket): AutotaskTicket {
    // Keep only the most essential fields to minimize response size
    const optimized: AutotaskTicket = {};
    
    if (ticket.id !== undefined) optimized.id = ticket.id;
    if (ticket.ticketNumber !== undefined) optimized.ticketNumber = ticket.ticketNumber;
    if (ticket.title !== undefined) optimized.title = ticket.title;
    
    // Handle description with truncation
    if (ticket.description !== undefined && ticket.description !== null) {
      optimized.description = ticket.description.length > 200
        ? ticket.description.substring(0, 200) + '... [truncated - use get_ticket_details for full text]'
        : ticket.description;
    }
    
    if (ticket.status !== undefined) optimized.status = ticket.status;
    if (ticket.priority !== undefined) optimized.priority = ticket.priority;
    if (ticket.companyID !== undefined) optimized.companyID = ticket.companyID;
    if (ticket.contactID !== undefined) optimized.contactID = ticket.contactID;
    if (ticket.assignedResourceID !== undefined) optimized.assignedResourceID = ticket.assignedResourceID;
    if (ticket.createDate !== undefined) optimized.createDate = ticket.createDate;
    if (ticket.lastActivityDate !== undefined) optimized.lastActivityDate = ticket.lastActivityDate;
    if (ticket.dueDateTime !== undefined) optimized.dueDateTime = ticket.dueDateTime;
    if (ticket.completedDate !== undefined) optimized.completedDate = ticket.completedDate;
    if (ticket.estimatedHours !== undefined) optimized.estimatedHours = ticket.estimatedHours;
    if (ticket.ticketType !== undefined) optimized.ticketType = ticket.ticketType;
    if (ticket.source !== undefined) optimized.source = ticket.source;
    if (ticket.issueType !== undefined) optimized.issueType = ticket.issueType;
    if (ticket.subIssueType !== undefined) optimized.subIssueType = ticket.subIssueType;
    
    // Handle resolution with truncation
    if (ticket.resolution !== undefined && ticket.resolution !== null) {
      optimized.resolution = ticket.resolution.length > 100
        ? ticket.resolution.substring(0, 100) + '... [truncated - use get_ticket_details for full text]'
        : ticket.resolution;
    }
    
    return optimized;
  }

  /**
   * Optimize ticket data by truncating large text fields and removing unnecessary data
   * This is the less aggressive version used by getTicket
   */
  private optimizeTicketData(ticket: AutotaskTicket): AutotaskTicket {
    const maxDescriptionLength = 500;
    const maxNotesLength = 300;

    return {
      ...ticket,
      // Truncate description if too long
      description: ticket.description && ticket.description.length > maxDescriptionLength
        ? ticket.description.substring(0, maxDescriptionLength) + '... [truncated]'
        : ticket.description,
      
      // Remove or truncate potentially large fields
      resolution: ticket.resolution && ticket.resolution.length > maxNotesLength
        ? ticket.resolution.substring(0, maxNotesLength) + '... [truncated]'
        : ticket.resolution,
        
      // Remove arrays that might contain large amounts of data
      userDefinedFields: [],
      
      // Keep only essential custom fields, truncate if present
      ...(ticket.purchaseOrderNumber && { 
        purchaseOrderNumber: ticket.purchaseOrderNumber.length > 50 
          ? ticket.purchaseOrderNumber.substring(0, 50) + '...' 
          : ticket.purchaseOrderNumber 
      })
    };
  }

  async createTicket(ticket: Partial<AutotaskTicket>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating ticket:', ticket);
      const result = await client.tickets.create(ticket as any);
      const ticketId = (result.data as any)?.id;
      this.logger.info(`Ticket created with ID: ${ticketId}`);
      return ticketId;
    } catch (error) {
      this.logger.error('Failed to create ticket:', error);
      throw error;
    }
  }

  async updateTicket(id: number, updates: Partial<AutotaskTicket>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating ticket ${id}:`, updates);
      await client.tickets.update(id, updates as any);
      this.logger.info(`Ticket ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update ticket ${id}:`, error);
      throw error;
    }
  }

  // Time entry operations
  async createTimeEntry(timeEntry: Partial<AutotaskTimeEntry>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating time entry:', timeEntry);
      const result = await client.timeEntries.create(timeEntry as any);
      const timeEntryId = (result.data as any)?.id;
      this.logger.info(`Time entry created with ID: ${timeEntryId}`);
      return timeEntryId;
    } catch (error) {
      this.logger.error('Failed to create time entry:', error);
      throw error;
    }
  }

  async getTimeEntries(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskTimeEntry[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Getting time entries with options:', options);
      
      // Prepare search body
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      if (options.pageSize) searchBody.pageSize = options.pageSize;
      
      // Set default pagination
      const pageSize = options.pageSize || 25;
      const finalPageSize = pageSize > 500 ? 500 : pageSize; // Time entries can have higher limits
      searchBody.pageSize = finalPageSize;

      this.logger.info('Making direct API call to TimeEntries/query with body:', searchBody);

      // Use the correct TimeEntries/query endpoint
      const response = await (client as any).axios.post('/TimeEntries/query', searchBody);
      
      // Extract time entries from response
      let timeEntries: AutotaskTimeEntry[] = [];
      if (response.data && response.data.items) {
        timeEntries = response.data.items;
      } else if (Array.isArray(response.data)) {
        timeEntries = response.data;
      } else {
        this.logger.warn('Unexpected response format from time entries API:', response.data);
        timeEntries = [];
      }
      
      this.logger.info(`Retrieved ${timeEntries.length} time entries`);
      return timeEntries;
    } catch (error) {
      this.logger.error('Failed to get time entries:', error);
      throw error;
    }
  }

  async getTimeEntry(id: number, tenantContext?: TenantContext): Promise<AutotaskTimeEntry | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting time entry with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Making direct API call to TimeEntries/query for single time entry:', searchBody);

      // Use the correct TimeEntries/query endpoint
      const response = await (client as any).axios.post('/TimeEntries/query', searchBody);
      
      // Extract time entry from response
      let timeEntry: AutotaskTimeEntry | null = null;
      if (response.data && response.data.items && response.data.items.length > 0) {
        timeEntry = response.data.items[0];
      } else if (Array.isArray(response.data) && response.data.length > 0) {
        timeEntry = response.data[0];
      }
      
      if (timeEntry) {
        this.logger.info(`Retrieved time entry ${id}`);
        return timeEntry;
      }
      
      this.logger.info(`Time entry ${id} not found`);
      return null;
    } catch (error) {
      this.logger.error(`Failed to get time entry ${id}:`, error);
      throw error;
    }
  }

  // Project operations
  async getProject(id: number, tenantContext?: TenantContext): Promise<AutotaskProject | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting project with ID: ${id}`);
      const result = await client.projects.get(id);
      return result.data as unknown as AutotaskProject || null;
    } catch (error) {
      this.logger.error(`Failed to get project ${id}:`, error);
      throw error;
    }
  }

  async searchProjects(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskProject[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching projects with options:', options);
      
      // WORKAROUND: The autotask-node library's projects.list() method is broken
      // It uses GET with query params instead of POST with body like the working companies endpoint
      // We'll bypass it and make the correct API call directly
      
      // Prepare search body - let API return all available fields instead of restricting them
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      if (options.pageSize) searchBody.pageSize = options.pageSize;
      
      // Set default pagination
      const pageSize = options.pageSize || 25;
      const finalPageSize = pageSize > 100 ? 100 : pageSize;
      searchBody.pageSize = finalPageSize;

      // Don't restrict fields - let the API return whatever is available
      // This avoids field availability issues across different Autotask instances

      this.logger.info('Making direct API call to Projects/query with body:', searchBody);

      // Make the API call
      const response = await (client as any).axios.post('/Projects/query', searchBody);
      
      // Extract projects from response
      let projects: AutotaskProject[] = [];
      if (response.data && response.data.items) {
        projects = response.data.items;
      } else if (Array.isArray(response.data)) {
        projects = response.data;
      } else {
        this.logger.warn('Unexpected response format from Projects/query:', response.data);
        projects = [];
      }
      
      // Transform projects to optimize data size
      const optimizedProjects = projects.map(project => this.optimizeProjectData(project));
      
      this.logger.info(`✅ Projects search successful:`, {
        resultCount: optimizedProjects.length,
        fieldsReturned: projects.length > 0 ? Object.keys(projects[0]).length : 0
      });
      
      return optimizedProjects;
    } catch (error: any) {
      // Check if it's the same 405 error pattern
      if (error.response && error.response.status === 405) {
        this.logger.warn('Projects endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.');
        return [];
      }
      this.logger.error('Failed to search projects:', error);
      throw error;
    }
  }

  /**
   * Optimize project data by truncating large text fields
   */
  private optimizeProjectData(project: AutotaskProject): AutotaskProject {
    const maxDescriptionLength = 500;

    const optimizedDescription = project.description 
      ? (project.description.length > maxDescriptionLength
          ? project.description.substring(0, maxDescriptionLength) + '... [truncated]'
          : project.description)
      : '';

    return {
      ...project,
      description: optimizedDescription,
      // Remove potentially large arrays
      userDefinedFields: []
    };
  }

  async createProject(project: Partial<AutotaskProject>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating project:', project);
      const result = await client.projects.create(project as any);
      const projectId = (result.data as any)?.id;
      this.logger.info(`Project created with ID: ${projectId}`);
      return projectId;
    } catch (error) {
      this.logger.error('Failed to create project:', error);
      throw error;
    }
  }

  async updateProject(id: number, updates: Partial<AutotaskProject>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating project ${id}:`, updates);
      await client.projects.update(id, updates as any);
      this.logger.info(`Project ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update project ${id}:`, error);
      throw error;
    }
  }

  // Resource operations
  async getResource(id: number, tenantContext?: TenantContext): Promise<AutotaskResource | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting resource with ID: ${id}`);
      const result = await client.resources.get(id);
      return result.data as AutotaskResource || null;
    } catch (error) {
      this.logger.error(`Failed to get resource ${id}:`, error);
      throw error;
    }
  }

  async searchResources(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskResource[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching resources with options:', options);
      

      // Prepare search body in the same format as working endpoints
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      if (options.pageSize) searchBody.pageSize = options.pageSize;
  

      // Set default pagination and field limits
      const pageSize = options.pageSize || 25;
      const finalPageSize = pageSize > 100 ? 100 : pageSize;
      searchBody.pageSize = finalPageSize;

      this.logger.info('Making direct API call to Resources/query with body:', {
        url: '/Resources/query',
        method: 'POST',
        requestBody: JSON.stringify(searchBody, null, 2),
        bodySize: JSON.stringify(searchBody).length
      });

      // Make the correct API call directly using the axios instance from the client
      let response: any;
      try {
        response = await (client as any).axios.post('/Resources/query', searchBody);
        
        this.logger.info('✅ Resources/query API call successful:', {
          status: response.status,
          statusText: response.statusText,
          responseDataType: typeof response.data,
          hasItems: !!(response.data && response.data.items),
          isArray: Array.isArray(response.data),
          responseKeys: response.data ? Object.keys(response.data) : [],
          responseDataSize: response.data ? JSON.stringify(response.data).length : 0,
          responseStructure: {
            hasItems: !!(response.data && response.data.items),
            itemsLength: response.data?.items?.length,
            hasPageDetails: !!(response.data && response.data.pageDetails),
            pageDetails: response.data?.pageDetails
          }
        });

        // Log a sample of the actual response data (first item if available)
        if (response.data?.items && response.data.items.length > 0) {
          this.logger.info('Sample resource from response:', {
            sampleResource: response.data.items[0],
            totalItems: response.data.items.length
          });
        }
      } catch (apiError: any) {
        this.logger.error('❌ Resources/query API call failed:', {
          error: apiError.message,
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          responseData: apiError.response?.data,
          responseHeaders: apiError.response?.headers,
          requestUrl: apiError.config?.url,
          requestMethod: apiError.config?.method,
          requestData: apiError.config?.data
        });
        throw apiError;
      }
      
      // Extract resources from response (should be in response.data.items format)
      let resources: AutotaskResource[] = [];
      if (response.data && response.data.items) {
        resources = response.data.items;
        this.logger.info(`📊 Extracted ${resources.length} resources from response.data.items`);
      } else if (Array.isArray(response.data)) {
        resources = response.data;
        this.logger.info(`📊 Extracted ${resources.length} resources from response.data (direct array)`);
      } else {
        this.logger.warn('❌ Unexpected response format from Resources/query:', {
          responseDataType: typeof response.data,
          responseData: response.data,
          hasData: !!response.data,
          dataKeys: response.data ? Object.keys(response.data) : []
        });
        resources = [];
      }
      
      this.logger.info(`Retrieved ${resources.length} resources (optimized for size)`);
      return resources;
    } catch (error: any) {
      // Check if it's the same 405 error pattern
      if (error.response && error.response.status === 405) {
        this.logger.warn('Resources endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.');
        return [];
      }
      this.logger.error('Failed to search resources:', error);
      throw error;
    }
  }

  // Opportunity operations (Note: opportunities endpoint may not be available in autotask-node)
  // async getOpportunity(id: number): Promise<AutotaskOpportunity | null> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info(`Getting opportunity with ID: ${id}`);
  //     const result = await client.opportunities.get(id);
  //     return result.data as AutotaskOpportunity || null;
  //   } catch (error) {
  //     this.logger.error(`Failed to get opportunity ${id}:`, error);
  //     throw error;
  //   }
  // }

  // async searchOpportunities(options: AutotaskQueryOptions = {}): Promise<AutotaskOpportunity[]> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info('Searching opportunities with options:', options);
  //     const result = await client.opportunities.list(options as any);
  //     return (result.data as AutotaskOpportunity[]) || [];
  //   } catch (error) {
  //     this.logger.error('Failed to search opportunities:', error);
  //     throw error;
  //   }
  // }

  // async createOpportunity(opportunity: Partial<AutotaskOpportunity>): Promise<number> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info('Creating opportunity:', opportunity);
  //     const result = await client.opportunities.create(opportunity as any);
  //     const opportunityId = (result.data as any)?.id;
  //     this.logger.info(`Opportunity created with ID: ${opportunityId}`);
  //     return opportunityId;
  //   } catch (error) {
  //     this.logger.error('Failed to create opportunity:', error);
  //     throw error;
  //   }
  // }

  // async updateOpportunity(id: number, updates: Partial<AutotaskOpportunity>): Promise<void> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info(`Updating opportunity ${id}:`, updates);
  //     await client.opportunities.update(id, updates as any);
  //     this.logger.info(`Opportunity ${id} updated successfully`);
  //   } catch (error) {
  //     this.logger.error(`Failed to update opportunity ${id}:`, error);
  //     throw error;
  //   }
  // }

  // Configuration Item operations
  async getConfigurationItem(id: number, tenantContext?: TenantContext): Promise<AutotaskConfigurationItem | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting configuration item with ID: ${id}`);
      const result = await client.configurationItems.get(id);
      return result.data as AutotaskConfigurationItem || null;
    } catch (error) {
      this.logger.error(`Failed to get configuration item ${id}:`, error);
      throw error;
    }
  }

  async searchConfigurationItems(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskConfigurationItem[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching configuration items with options:', options);
      const result = await client.configurationItems.list(options as any);
      return (result.data as AutotaskConfigurationItem[]) || [];
    } catch (error) {
      this.logger.error('Failed to search configuration items:', error);
      throw error;
    }
  }

  async createConfigurationItem(configItem: Partial<AutotaskConfigurationItem>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating configuration item:', configItem);
      const result = await client.configurationItems.create(configItem as any);
      const configItemId = (result.data as any)?.id;
      this.logger.info(`Configuration item created with ID: ${configItemId}`);
      return configItemId;
    } catch (error) {
      this.logger.error('Failed to create configuration item:', error);
      throw error;
    }
  }

  async updateConfigurationItem(id: number, updates: Partial<AutotaskConfigurationItem>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating configuration item ${id}:`, updates);
      await client.configurationItems.update(id, updates as any);
      this.logger.info(`Configuration item ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update configuration item ${id}:`, error);
      throw error;
    }
  }

  // Product operations (Note: products endpoint may not be available in autotask-node)
  // async getProduct(id: number): Promise<AutotaskProduct | null> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info(`Getting product with ID: ${id}`);
  //     const result = await client.products.get(id);
  //     return result.data as AutotaskProduct || null;
  //   } catch (error) {
  //     this.logger.error(`Failed to get product ${id}:`, error);
  //     throw error;
  //   }
  // }

  // async searchProducts(options: AutotaskQueryOptions = {}): Promise<AutotaskProduct[]> {
  //   const client = await this.ensureClient();
  //   
  //   try {
  //     this.logger.info('Searching products with options:', options);
  //     const result = await client.products.list(options as any);
  //     return (result.data as AutotaskProduct[]) || [];
  //   } catch (error) {
  //     this.logger.error('Failed to search products:', error);
  //     throw error;
  //   }
  // }

  // Contract operations (read-only for now as they're complex)
  async getContract(id: number, tenantContext?: TenantContext): Promise<AutotaskContract | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting contract with ID: ${id}`);
      const result = await client.contracts.get(id);
      return result.data as unknown as AutotaskContract || null;
    } catch (error) {
      this.logger.error(`Failed to get contract ${id}:`, error);
      throw error;
    }
  }

  async searchContracts(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskContract[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching contracts with options:', options);
      const result = await client.contracts.list(options as any);
      return (result.data as unknown as AutotaskContract[]) || [];
    } catch (error) {
      this.logger.error('Failed to search contracts:', error);
      throw error;
    }
  }

  // Invoice operations (read-only)
  async getInvoice(id: number, tenantContext?: TenantContext): Promise<AutotaskInvoice | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting invoice with ID: ${id}`);
      const result = await client.invoices.get(id);
      return result.data as AutotaskInvoice || null;
    } catch (error) {
      this.logger.error(`Failed to get invoice ${id}:`, error);
      throw error;
    }
  }

  async searchInvoices(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskInvoice[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching invoices with options:', options);
      

      // Log the options being passed to the library method
      this.logger.info('Invoice search options being passed to library:', {
        originalOptions: options,
        hasFilter: !!options.filter,
        filterType: Array.isArray(options.filter) ? 'array' : typeof options.filter,
        filterLength: Array.isArray(options.filter) ? options.filter.length : 'not array',
        pageSize: options.pageSize,
        page: options.page,
        sort: options.sort
      });

      // CORRECTED APPROACH: Use POST /Invoices/query with JSON body
      // According to https://webservices5.autotask.net/atservicesrest/swagger/ui/index#/Invoices/Invoices_Query
      // The POST version might be supported even if GET is not
      
      this.logger.info('Making direct POST API call to Invoices/query with JSON body (like Resources/Projects)');
       
      // Prepare search body in the same format as working endpoints
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      if (options.pageSize) searchBody.pageSize = options.pageSize;
       
      // Set default pagination and field limits
      const pageSize = options.pageSize || 25;
      const finalPageSize = pageSize > 100 ? 100 : pageSize;
      searchBody.pageSize = finalPageSize;

      this.logger.info('Making direct POST request to Invoices/query endpoint:', {
        url: '/Invoices/query',
        method: 'POST',
        requestBody: JSON.stringify(searchBody, null, 2),
        bodySize: JSON.stringify(searchBody).length
      });
      
      try {
        // Make direct POST request with proper timeout
        const response = await (client as any).axios.post('/Invoices/query', searchBody, {
          timeout: 15000 // 15 second timeout to prevent slowness
        });
        
        this.logger.info('✅ Direct POST /Invoices/query successful:', {
          status: response.status,
          statusText: response.statusText,
          responseDataType: typeof response.data,
          hasItems: !!(response.data && response.data.items),
          isArray: Array.isArray(response.data),
          responseKeys: response.data ? Object.keys(response.data) : [],
          responseSize: response.data ? JSON.stringify(response.data).length : 0,
          responseStructure: {
            hasItems: !!(response.data && response.data.items),
            itemsLength: response.data?.items?.length,
            hasPageDetails: !!(response.data && response.data.pageDetails),
            pageDetails: response.data?.pageDetails
          }
        });

        // Extract invoices from response
        let invoices: AutotaskInvoice[] = [];
        if (response.data && response.data.items) {
          invoices = response.data.items;
          this.logger.info(`📊 Extracted ${invoices.length} invoices from response.data.items`);
        } else if (Array.isArray(response.data)) {
          invoices = response.data;
          this.logger.info(`📊 Extracted ${invoices.length} invoices from response.data (direct array)`);
        } else {
          this.logger.warn('❌ Unexpected response format from POST /Invoices/query:', {
            responseDataType: typeof response.data,
            responseData: response.data,
            hasData: !!response.data,
            dataKeys: response.data ? Object.keys(response.data) : []
          });
          invoices = [];
        }
        
        // Log a sample invoice if available
        if (invoices.length > 0) {
          this.logger.info('Sample invoice from response:', {
            sampleInvoice: invoices[0],
            totalItems: invoices.length,
            sampleKeys: Object.keys(invoices[0] || {})
          });
        }
        
                 this.logger.info(`✅ Retrieved ${invoices.length} invoices using direct POST API call`);
        return invoices;
        
      } catch (directApiError: any) {
        this.logger.error('❌ Direct POST /Invoices/query failed:', {
          error: directApiError.message,
          name: directApiError.name,
          status: directApiError.response?.status,
          statusText: directApiError.response?.statusText,
          responseData: directApiError.response?.data,
          requestUrl: directApiError.config?.url,
          requestMethod: directApiError.config?.method,
          requestParams: directApiError.config?.params,
          timeout: directApiError.code === 'ECONNABORTED'
        });
        
        // Handle specific error cases
        if (directApiError.response && directApiError.response.status === 405) {
          this.logger.warn('Invoices endpoint may not support listing via API (405 Method Not Allowed). This is common with some Autotask configurations.');
          return [];
        }
        
        if (directApiError.code === 'ECONNABORTED') {
          this.logger.warn('Invoices request timed out after 15 seconds. The API may be overloaded or the query too complex.');
          return [];
        }
        
        throw directApiError;
      }
    } catch (error) {
      this.logger.error('Failed to search invoices:', error);
      throw error;
    }
  }

  // Task operations
  async getTask(id: number, tenantContext?: TenantContext): Promise<AutotaskTask | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting task with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Making direct API call to Tasks/query for single task:', searchBody);

      // Use the correct Tasks/query endpoint
      const response = await (client as any).axios.post('/Tasks/query', searchBody);
      
      // Extract task from response
      let task: AutotaskTask | null = null;
      if (response.data && response.data.items && response.data.items.length > 0) {
        task = response.data.items[0];
      } else if (Array.isArray(response.data) && response.data.length > 0) {
        task = response.data[0];
      }
      
      if (task) {
        this.logger.info(`Retrieved task ${id}`);
        return task;
      }
      
      this.logger.info(`Task ${id} not found`);
      return null;
    } catch (error) {
      this.logger.error(`Failed to get task ${id}:`, error);
      throw error;
    }
  }

  async searchTasks(options: AutotaskQueryOptions = {}, tenantContext?: TenantContext): Promise<AutotaskTask[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching tasks with options:', options);
      
      // Prepare search body
      const searchBody: any = {};
      
      // Ensure there's a filter - Autotask API requires a filter
      if (!options.filter || (Array.isArray(options.filter) && options.filter.length === 0) || 
          (!Array.isArray(options.filter) && Object.keys(options.filter).length === 0)) {
        searchBody.filter = [
          {
            "op": "gte",
            "field": "id",
            "value": 0
          }
        ];
      } else {
        // If filter is provided as an object, convert to array format expected by API
        if (!Array.isArray(options.filter)) {
          const filterArray = [];
          for (const [field, value] of Object.entries(options.filter)) {
            filterArray.push({
              "op": "eq",
              "field": field,
              "value": value
            });
          }
          searchBody.filter = filterArray;
        } else {
          searchBody.filter = options.filter;
        }
      }

      // Add other search parameters
      if (options.sort) searchBody.sort = options.sort;
      if (options.page) searchBody.page = options.page;
      if (options.pageSize) searchBody.pageSize = options.pageSize;
      
      // Set default pagination
      const pageSize = options.pageSize || 25;
      const finalPageSize = pageSize > 100 ? 100 : pageSize;
      searchBody.pageSize = finalPageSize;

      this.logger.info('Making direct API call to Tasks/query with body:', searchBody);

      // Use the correct Tasks/query endpoint
      const response = await (client as any).axios.post('/Tasks/query', searchBody);
      
      // Extract tasks from response
      let tasks: AutotaskTask[] = [];
      if (response.data && response.data.items) {
        tasks = response.data.items;
      } else if (Array.isArray(response.data)) {
        tasks = response.data;
      } else {
        this.logger.warn('Unexpected response format from Tasks/query:', response.data);
        tasks = [];
      }
      
      // Transform tasks to optimize data size
      const optimizedTasks = tasks.map(task => this.optimizeTaskData(task));
      
      this.logger.info(`✅ Tasks search successful:`, {
        resultCount: optimizedTasks.length,
        fieldsReturned: tasks.length > 0 ? Object.keys(tasks[0]).length : 0
      });
      
      return optimizedTasks;
    } catch (error) {
      this.logger.error('Failed to search tasks:', error);
      throw error;
    }
  }

  /**
   * Optimize task data by truncating large text fields
   */
  private optimizeTaskData(task: AutotaskTask): AutotaskTask {
    const maxDescriptionLength = 400;

    const optimizedDescription = task.description 
      ? (task.description.length > maxDescriptionLength
          ? task.description.substring(0, maxDescriptionLength) + '... [truncated]'
          : task.description)
      : '';

    return {
      ...task,
      description: optimizedDescription,
      // Remove potentially large arrays
      userDefinedFields: []
    };
  }

  async createTask(task: Partial<AutotaskTask>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating task:', task);
      const result = await client.tasks.create(task as any);
      const taskId = (result.data as any)?.id;
      this.logger.info(`Task created with ID: ${taskId}`);
      return taskId;
    } catch (error) {
      this.logger.error('Failed to create task:', error);
      throw error;
    }
  }

  async updateTask(id: number, updates: Partial<AutotaskTask>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating task ${id}:`, updates);
      await client.tasks.update(id, updates as any);
      this.logger.info(`Task ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update task ${id}:`, error);
      throw error;
    }
  }

  // Utility methods
  async testConnection(tenantContext?: TenantContext): Promise<boolean> {
    try {
      const client = await this.getClientForTenant(tenantContext);
      // Try to get account with ID 0 as a connection test
      const result = await client.accounts.get(0);
      this.logger.info('Connection test successful:', { hasData: !!result.data, resultType: typeof result });
      return true;
    } catch (error) {
      this.logger.error('Connection test failed:', error);
      return false;
    }
  }

  /**
   * Test zone information discovery for debugging API URL issues
   */
  async testZoneInformation(tenantContext?: TenantContext): Promise<any> {
    try {
      const { username, secret, integrationCode } = tenantContext?.credentials || this.config.autotask || {};
      
      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required credentials for zone information test');
      }

      this.logger.info('Testing zone information discovery...', {
        username: username ? `${username.substring(0, 8)}***` : undefined,
        integrationCode
      });

      // Try to get zone information directly from Autotask
      const zoneUrl = 'https://webservices.autotask.net/ATServicesRest/v1.0/zoneInformation';
      
      // Make direct API call to zone information endpoint
      const response = await fetch(zoneUrl, {
        method: 'GET',
        headers: {
          'ApiIntegrationcode': integrationCode,
          'UserName': username,
          'Secret': secret,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Zone information request failed: ${response.status} ${response.statusText}`);
      }

      const zoneInfo = await response.json() as any;
      
      this.logger.info('Zone information retrieved:', {
        url: zoneInfo.url,
        webUrl: zoneInfo.webUrl,
        zoneInfo
      });

      return zoneInfo;
    } catch (error) {
      this.logger.error('Zone information test failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Check if the service is running in multi-tenant mode
   */
  public isInMultiTenantMode(): boolean {
    return this.isMultiTenant;
  }

  // =====================================================
  // NEW ENTITY METHODS - Phase 1: High-Priority Entities
  // =====================================================

  // Note entities - Using the generic notes endpoint
  async getTicketNote(ticketId: number, noteId: number, tenantContext?: TenantContext): Promise<AutotaskTicketNote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket note - TicketID: ${ticketId}, NoteID: ${noteId}`);
      
      const searchBody = {
        filter: [
          { field: 'ticketID', op: 'eq', value: ticketId },
          { field: 'id', op: 'eq', value: noteId }
        ]
      };

      this.logger.info('Making direct API call to TicketNotes/query for single note:', searchBody);

      // Use the correct TicketNotes/query endpoint
      const response = await (client as any).axios.post('/TicketNotes/query', searchBody);
      const notes = response?.data?.items || [];
      return notes.length > 0 ? notes[0] as AutotaskTicketNote : null;
    } catch (error) {
      this.logger.error(`Failed to get ticket note ${noteId} for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async searchTicketNotes(ticketId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskTicketNote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching ticket notes for ticket ${ticketId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'ticketID', op: 'eq', value: ticketId }
        ],
        pageSize: options.pageSize || 25
      };

      this.logger.info('Making direct API call to TicketNotes/query with body:', searchBody);

      // Use the correct TicketNotes/query endpoint
      const response = await (client as any).axios.post('/TicketNotes/query', searchBody);
      const notes = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${notes.length} ticket notes`);
      return notes as AutotaskTicketNote[];
    } catch (error) {
      this.logger.error(`Failed to search ticket notes for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async createTicketNote(ticketId: number, note: Partial<AutotaskTicketNote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating ticket note for ticket ${ticketId}:`, note);
      const noteData = {
        ...note,
        ticketId: ticketId
      };
      const result = await client.notes.create(noteData as any);
      const noteId = (result.data as any)?.id;
      this.logger.info(`Ticket note created with ID: ${noteId}`);
      return noteId;
    } catch (error) {
      this.logger.error(`Failed to create ticket note for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async getProjectNote(projectId: number, noteId: number, tenantContext?: TenantContext): Promise<AutotaskProjectNote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting project note - ProjectID: ${projectId}, NoteID: ${noteId}`);
      
      const searchBody = {
        filter: [
          { field: 'projectID', op: 'eq', value: projectId },
          { field: 'id', op: 'eq', value: noteId }
        ]
      };

      this.logger.info('Making direct API call to ProjectNotes/query for single note:', searchBody);

      // Use the correct ProjectNotes/query endpoint
      const response = await (client as any).axios.post('/ProjectNotes/query', searchBody);
      const notes = response?.data?.items || [];
      return notes.length > 0 ? notes[0] as AutotaskProjectNote : null;
    } catch (error) {
      this.logger.error(`Failed to get project note ${noteId} for project ${projectId}:`, error);
      throw error;
    }
  }

  async searchProjectNotes(projectId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskProjectNote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching project notes for project ${projectId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'projectID', op: 'eq', value: projectId }
        ],
        pageSize: options.pageSize || 25
      };

      this.logger.info('Making direct API call to ProjectNotes/query with body:', searchBody);

      // Use the correct ProjectNotes/query endpoint
      const response = await (client as any).axios.post('/ProjectNotes/query', searchBody);
      const notes = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${notes.length} project notes`);
      return notes as AutotaskProjectNote[];
    } catch (error) {
      this.logger.error(`Failed to search project notes for project ${projectId}:`, error);
      throw error;
    }
  }

  async createProjectNote(projectId: number, note: Partial<AutotaskProjectNote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating project note for project ${projectId}:`, note);
      const noteData = {
        ...note,
        projectId: projectId
      };
      const result = await client.notes.create(noteData as any);
      const noteId = (result.data as any)?.id;
      this.logger.info(`Project note created with ID: ${noteId}`);
      return noteId;
    } catch (error) {
      this.logger.error(`Failed to create project note for project ${projectId}:`, error);
      throw error;
    }
  }

  async getCompanyNote(companyId: number, noteId: number, tenantContext?: TenantContext): Promise<AutotaskCompanyNote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting company note - CompanyID: ${companyId}, NoteID: ${noteId}`);
      
      const searchBody = {
        filter: [
          { field: 'accountID', op: 'eq', value: companyId },
          { field: 'id', op: 'eq', value: noteId }
        ]
      };

      this.logger.info('Making direct API call to CompanyNotes/query for single note:', searchBody);

      // Use the correct CompanyNotes/query endpoint
      const response = await (client as any).axios.post('/CompanyNotes/query', searchBody);
      const notes = response?.data?.items || [];
      return notes.length > 0 ? notes[0] as AutotaskCompanyNote : null;
    } catch (error) {
      this.logger.error(`Failed to get company note ${noteId} for company ${companyId}:`, error);
      throw error;
    }
  }

  async searchCompanyNotes(companyId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskCompanyNote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching company notes for company ${companyId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'companyID', op: 'eq', value: companyId }
        ],
        pageSize: options.pageSize || 25
      };

      this.logger.info('Making direct API call to CompanyNotes/query with body:', searchBody);

      // Use the correct CompanyNotes/query endpoint
      const response = await (client as any).axios.post('/CompanyNotes/query', searchBody);
      const notes = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${notes.length} company notes`);
      return notes as AutotaskCompanyNote[];
    } catch (error) {
      this.logger.error(`Failed to search company notes for company ${companyId}:`, error);
      throw error;
    }
  }

  async createCompanyNote(companyId: number, note: Partial<AutotaskCompanyNote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating company note for company ${companyId}:`, note);
      const noteData = {
        ...note,
        accountId: companyId
      };
      const result = await client.notes.create(noteData as any);
      const noteId = (result.data as any)?.id;
      this.logger.info(`Company note created with ID: ${noteId}`);
      return noteId;
    } catch (error) {
      this.logger.error(`Failed to create company note for company ${companyId}:`, error);
      throw error;
    }
  }

  // Attachment entities - Using the generic attachments endpoint
  async getTicketAttachment(ticketId: number, attachmentId: number, includeData: boolean = false, tenantContext?: TenantContext): Promise<AutotaskTicketAttachment | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting ticket attachment - TicketID: ${ticketId}, AttachmentID: ${attachmentId}, includeData: ${includeData}`);
      
      const searchBody = {
        filter: [
          { field: 'parentID', op: 'eq', value: ticketId },
          { field: 'id', op: 'eq', value: attachmentId }
        ]
      };

      this.logger.info('Making direct API call to TicketAttachments/query for single attachment:', searchBody);

      // Use the correct TicketAttachments/query endpoint
      const response = await (client as any).axios.post('/TicketAttachments/query', searchBody);
      const attachments = response?.data?.items || [];
      return attachments.length > 0 ? attachments[0] as AutotaskTicketAttachment : null;
    } catch (error) {
      this.logger.error(`Failed to get ticket attachment ${attachmentId} for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async searchTicketAttachments(ticketId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskTicketAttachment[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching ticket attachments for ticket ${ticketId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'parentID', op: 'eq', value: ticketId }
        ],
        pageSize: options.pageSize || 10
      };

      this.logger.info('Making direct API call to TicketAttachments/query with body:', searchBody);

      // Use the correct TicketAttachments/query endpoint
      const response = await (client as any).axios.post('/TicketAttachments/query', searchBody);
      const attachments = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${attachments.length} ticket attachments`);
      return attachments as AutotaskTicketAttachment[];
    } catch (error) {
      this.logger.error(`Failed to search ticket attachments for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  // Expense entities
  async getExpenseReport(id: number, tenantContext?: TenantContext): Promise<AutotaskExpenseReport | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting expense report with ID: ${id}`);
      
      const searchBody = {
        filter: [
          { field: 'id', op: 'eq', value: id }
        ]
      };

      this.logger.info('Making direct API call to ExpenseReports/query for single report:', searchBody);

      // Use the correct ExpenseReports/query endpoint
      const response = await (client as any).axios.post('/ExpenseReports/query', searchBody);
      const reports = response?.data?.items || [];
      
      if (reports.length > 0) {
        this.logger.info(`Retrieved expense report ${id}`);
        return reports[0] as AutotaskExpenseReport;
      }
      
      this.logger.info(`Expense report ${id} not found`);
      return null;
    } catch (error) {
      this.logger.error(`Failed to get expense report ${id}:`, error);
      throw error;
    }
  }

  async searchExpenseReports(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskExpenseReport[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching expense reports with options:', options);
      
      // Build filter based on provided options
      const filters = [];
      if (options.submitterId) {
        filters.push({ field: 'resourceID', op: 'eq', value: options.submitterId });
      }
      if (options.status) {
        filters.push({ field: 'status', op: 'eq', value: options.status });
      }
      
      // Ensure there's always a filter - Autotask API requires a filter
      if (filters.length === 0) {
        filters.push({ field: 'id', op: 'gte', value: 0 });
      }
      
      const searchBody = {
        filter: filters,
        pageSize: options.pageSize || 25
      };

      this.logger.info('Making direct API call to ExpenseReports/query with body:', searchBody);

      // Use the correct ExpenseReports/query endpoint
      const response = await (client as any).axios.post('/ExpenseReports/query', searchBody);
      const reports = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${reports.length} expense reports`);
      return reports as AutotaskExpenseReport[];
    } catch (error) {
      this.logger.error('Failed to search expense reports:', error);
      throw error;
    }
  }

  async createExpenseReport(report: Partial<AutotaskExpenseReport>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating expense report:', report);
      const result = await client.expenses.create(report as any);
      const reportId = (result.data as any)?.id;
      this.logger.info(`Expense report created with ID: ${reportId}`);
      return reportId;
    } catch (error) {
      this.logger.error('Failed to create expense report:', error);
      throw error;
    }
  }

  async updateExpenseReport(id: number, updates: Partial<AutotaskExpenseReport>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating expense report ${id}:`, updates);
      await client.expenses.update(id, updates as any);
      this.logger.info(`Expense report ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update expense report ${id}:`, error);
      throw error;
    }
  }

  // Expense Items - Child entities of Expense Reports (ExpenseItems → Expenses/Items)
  async getExpenseItem(expenseReportId: number, itemId: number, tenantContext?: TenantContext): Promise<AutotaskExpenseItem | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting expense item - ExpenseReportID: ${expenseReportId}, ItemID: ${itemId}`);
      
      const searchBody = {
        filter: [
          { field: 'expenseReportID', op: 'eq', value: expenseReportId },
          { field: 'id', op: 'eq', value: itemId }
        ]
      };

      this.logger.info('Making direct API call to ExpenseItems/query for single item:', searchBody);

      // Use the correct ExpenseItems/query endpoint
      const response = await (client as any).axios.post('/ExpenseItems/query', searchBody);
      const items = response?.data?.items || [];
      
      if (items.length > 0) {
        this.logger.info(`Retrieved expense item ${itemId} from expense report ${expenseReportId}`);
        return items[0] as AutotaskExpenseItem;
      }
      
      this.logger.info(`Expense item ${itemId} not found in expense report ${expenseReportId}`);
      return null;
    } catch (error: any) {
      this.logger.error(`Failed to get expense item ${itemId} from expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  async searchExpenseItems(expenseReportId: number, options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskExpenseItem[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Searching expense items for expense report ${expenseReportId}:`, options);
      
      const searchBody = {
        filter: [
          { field: 'expenseReportID', op: 'eq', value: expenseReportId }
        ],
        pageSize: options.pageSize || 25
      };

      this.logger.info('Making direct API call to ExpenseItems/query with body:', searchBody);

      // Use the correct ExpenseItems/query endpoint
      const response = await (client as any).axios.post('/ExpenseItems/query', searchBody);
      const items = response?.data?.items || [];
      
      this.logger.info(`Retrieved ${items.length} expense items for expense report ${expenseReportId}`);
      return items as AutotaskExpenseItem[];
    } catch (error: any) {
      this.logger.error(`Failed to search expense items for expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  async createExpenseItem(expenseReportId: number, item: Partial<AutotaskExpenseItem>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Creating expense item for expense report ${expenseReportId}:`, item);
      
      // Ensure the expense report ID is set in the item data
      const itemData = {
        ...item,
        expenseReportID: expenseReportId
      };
      
      // Make direct API call using parent-child creation pattern
      const response = await (client as any).axios.post(`/Expenses/${expenseReportId}/Items`, itemData);
      
      let itemId: number;
      
      if (response.data && response.data.itemId) {
        itemId = response.data.itemId;
      } else if (response.data && response.data.id) {
        itemId = response.data.id;
      } else if (response.data && typeof response.data === 'number') {
        itemId = response.data;
      } else {
        this.logger.warn('Unexpected response format from expense item creation:', response.data);
        throw new Error('Unable to determine created expense item ID from API response');
      }
      
      this.logger.info(`Expense item created with ID: ${itemId} for expense report ${expenseReportId}`);
      return itemId;
    } catch (error) {
      this.logger.error(`Failed to create expense item for expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  async updateExpenseItem(expenseReportId: number, itemId: number, updates: Partial<AutotaskExpenseItem>, tenantContext?: TenantContext): Promise<void> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Updating expense item ${itemId} in expense report ${expenseReportId}:`, updates);
      
      // Make direct API call using parent-child update pattern
      await (client as any).axios.patch(`/Expenses/${expenseReportId}/Items/${itemId}`, updates);
      
      this.logger.info(`Expense item ${itemId} updated successfully in expense report ${expenseReportId}`);
    } catch (error) {
      this.logger.error(`Failed to update expense item ${itemId} in expense report ${expenseReportId}:`, error);
      throw error;
    }
  }

  // Quote entity
  async getQuote(id: number, tenantContext?: TenantContext): Promise<AutotaskQuote | null> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info(`Getting quote with ID: ${id}`);
      const result = await client.quotes.get(id);
      return result.data as AutotaskQuote || null;
    } catch (error) {
      this.logger.error(`Failed to get quote ${id}:`, error);
      throw error;
    }
  }

  async searchQuotes(options: AutotaskQueryOptionsExtended = {}, tenantContext?: TenantContext): Promise<AutotaskQuote[]> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Searching quotes with options:', options);
      
      // Build filter based on provided options
      const filters = [];
      if (options.companyId) {
        filters.push({ field: 'accountId', op: 'eq', value: options.companyId });
      }
      if (options.contactId) {
        filters.push({ field: 'contactId', op: 'eq', value: options.contactId });
      }
      if (options.opportunityId) {
        filters.push({ field: 'opportunityId', op: 'eq', value: options.opportunityId });
      }
      if (options.searchTerm) {
        filters.push({ field: 'description', op: 'contains', value: options.searchTerm });
      }

      const queryOptions = {
        filter: filters.length > 0 ? filters : [{ field: 'id', op: 'gte', value: 0 }],
        pageSize: options.pageSize || 25
      };

      const result = await client.quotes.list(queryOptions);
      const quotes = (result.data as any[]) || [];
      
      this.logger.info(`Retrieved ${quotes.length} quotes`);
      return quotes as AutotaskQuote[];
    } catch (error) {
      this.logger.error('Failed to search quotes:', error);
      throw error;
    }
  }

  async createQuote(quote: Partial<AutotaskQuote>, tenantContext?: TenantContext): Promise<number> {
    const client = await this.getClientForTenant(tenantContext);
    
    try {
      this.logger.info('Creating quote:', quote);
      const result = await client.quotes.create(quote as any);
      const quoteId = (result.data as any)?.id;
      this.logger.info(`Quote created with ID: ${quoteId}`);
      return quoteId;
    } catch (error) {
      this.logger.error('Failed to create quote:', error);
      throw error;
    }
  }

  // BillingCode and Department entities are not directly available in autotask-node
  // These would need to be implemented via custom API calls or alternative endpoints
  async getBillingCode(_id: number, _tenantContext?: TenantContext): Promise<AutotaskBillingCode | null> {
    throw new Error('Billing codes API not directly available in autotask-node library');
  }

  async searchBillingCodes(_options: AutotaskQueryOptionsExtended = {}, _tenantContext?: TenantContext): Promise<AutotaskBillingCode[]> {
    throw new Error('Billing codes API not directly available in autotask-node library');
  }

  async getDepartment(_id: number, _tenantContext?: TenantContext): Promise<AutotaskDepartment | null> {
    throw new Error('Departments API not directly available in autotask-node library');
  }

  async searchDepartments(_options: AutotaskQueryOptionsExtended = {}, _tenantContext?: TenantContext): Promise<AutotaskDepartment[]> {
    throw new Error('Departments API not directly available in autotask-node library');
  }
} 