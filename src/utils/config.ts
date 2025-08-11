// Configuration Utility
// Handles loading configuration from environment variables and MCP client arguments

import { McpServerConfig } from '../types/mcp.js';
import { LogLevel } from './logger.js';

export interface EnvironmentConfig {
  autotask: {
    username?: string;
    secret?: string;
    integrationCode?: string;
    apiUrl?: string;
  };
  server: {
    name: string;
    version: string;
  };
  logging: {
    level: LogLevel;
    format: 'json' | 'simple';
  };
  multiTenant?: {
    enabled: boolean;
    defaultApiUrl?: string;
    clientPoolSize?: number;
    sessionTimeout?: number;
  };
}

/**
 * Load configuration from environment variables
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  const autotaskConfig: { username?: string; secret?: string; integrationCode?: string; apiUrl?: string } = {};
  
  if (process.env.AUTOTASK_USERNAME) {
    autotaskConfig.username = process.env.AUTOTASK_USERNAME;
  }
  if (process.env.AUTOTASK_SECRET) {
    autotaskConfig.secret = process.env.AUTOTASK_SECRET;
  }
  if (process.env.AUTOTASK_INTEGRATION_CODE) {
    autotaskConfig.integrationCode = process.env.AUTOTASK_INTEGRATION_CODE;
  }
  if (process.env.AUTOTASK_API_URL) {
    autotaskConfig.apiUrl = process.env.AUTOTASK_API_URL;
  }

  // Multi-tenant configuration
  const isMultiTenantEnabled = process.env.MULTI_TENANT_ENABLED === 'true';
  
  const config: EnvironmentConfig = {
    autotask: autotaskConfig,
    server: {
      name: process.env.MCP_SERVER_NAME || 'autotask-mcp',
      version: process.env.MCP_SERVER_VERSION || '1.0.0'
    },
    logging: {
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      format: (process.env.LOG_FORMAT as 'json' | 'simple') || 'simple'
    }
  };

  if (isMultiTenantEnabled) {
    config.multiTenant = {
      enabled: true,
      ...(process.env.MULTI_TENANT_DEFAULT_API_URL && { defaultApiUrl: process.env.MULTI_TENANT_DEFAULT_API_URL }),
      ...(process.env.MULTI_TENANT_POOL_SIZE && { clientPoolSize: parseInt(process.env.MULTI_TENANT_POOL_SIZE, 10) }),
      ...(process.env.MULTI_TENANT_SESSION_TIMEOUT && { sessionTimeout: parseInt(process.env.MULTI_TENANT_SESSION_TIMEOUT, 10) })
    };
  }

  return config;
}

/**
 * Create multi-tenant server configuration
 */
export function createMultiTenantConfig(options?: {
  name?: string;
  version?: string;
  defaultApiUrl?: string;
  clientPoolSize?: number;
  sessionTimeout?: number;
}): McpServerConfig {
  const config: McpServerConfig = {
    name: options?.name || 'autotask-mcp-multi-tenant',
    version: options?.version || '1.0.0',
    multiTenant: {
      enabled: true,
      clientPoolSize: options?.clientPoolSize || 50,
      sessionTimeout: options?.sessionTimeout || 30 * 60 * 1000 // 30 minutes
    }
  };

  if (options?.defaultApiUrl) {
    config.multiTenant!.defaultApiUrl = options.defaultApiUrl;
  }

  return config;
}

/**
 * Merge environment config with MCP client configuration
 */
export function mergeWithMcpConfig(envConfig: EnvironmentConfig, mcpArgs?: Record<string, any>): McpServerConfig {
  // MCP client can override server configuration through arguments
  const serverConfig: McpServerConfig = {
    name: mcpArgs?.name || envConfig.server.name,
    version: mcpArgs?.version || envConfig.server.version,
    autotask: {
      username: mcpArgs?.autotask?.username || envConfig.autotask.username,
      secret: mcpArgs?.autotask?.secret || envConfig.autotask.secret,
      integrationCode: mcpArgs?.autotask?.integrationCode || envConfig.autotask.integrationCode,
      apiUrl: mcpArgs?.autotask?.apiUrl || envConfig.autotask.apiUrl
    }
  };

  if (envConfig.multiTenant) {
    serverConfig.multiTenant = envConfig.multiTenant;
  }

  return serverConfig;
}

/**
 * Validate that all required configuration is present
 */
export function validateConfig(config: McpServerConfig): string[] {
  const errors: string[] = [];

  // For multi-tenant mode, credentials are optional at startup
  if (!config.multiTenant?.enabled) {
    if (!config.autotask?.username) {
      errors.push('AUTOTASK_USERNAME is required');
    }

    if (!config.autotask?.secret) {
      errors.push('AUTOTASK_SECRET is required');
    }

    if (!config.autotask?.integrationCode) {
      errors.push('AUTOTASK_INTEGRATION_CODE is required');
    }
  }

  if (!config.name) {
    errors.push('Server name is required');
  }

  if (!config.version) {
    errors.push('Server version is required');
  }

  return errors;
}

/**
 * Get configuration help text
 */
export function getConfigHelp(): string {
  return `
Autotask MCP Server Configuration:

Single-Tenant Mode (Default):
  AUTOTASK_USERNAME         - Autotask API username (email) [REQUIRED]
  AUTOTASK_SECRET          - Autotask API secret key [REQUIRED]
  AUTOTASK_INTEGRATION_CODE - Autotask integration code [REQUIRED]

Multi-Tenant Mode:
  MULTI_TENANT_ENABLED     - Enable multi-tenant mode (true/false) [DEFAULT: false]
  MULTI_TENANT_DEFAULT_API_URL - Default API URL for tenants
  MULTI_TENANT_POOL_SIZE   - Client pool size [DEFAULT: 50]
  MULTI_TENANT_SESSION_TIMEOUT - Session timeout in ms [DEFAULT: 1800000 (30 min)]

Optional Environment Variables:
  AUTOTASK_API_URL         - Autotask API base URL (auto-detected if not provided)
  MCP_SERVER_NAME          - Server name (default: autotask-mcp)
  MCP_SERVER_VERSION       - Server version (default: 1.0.0)
  LOG_LEVEL                - Logging level: error, warn, info, debug (default: info)
  LOG_FORMAT               - Log format: simple, json (default: simple)

Multi-Tenant Example:
  MULTI_TENANT_ENABLED=true
  MULTI_TENANT_POOL_SIZE=100
  MULTI_TENANT_SESSION_TIMEOUT=3600000

Single-Tenant Example:
  AUTOTASK_USERNAME=api-user@example.com
  AUTOTASK_SECRET=your-secret-key
  AUTOTASK_INTEGRATION_CODE=your-integration-code
`.trim();
} 