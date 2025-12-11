// Server-Sent Events Manager for Autotask MCP
// Provides real-time streaming of Autotask data and events
// Refactored with proper polling session management

import { Response } from 'express';
import { McpHttpBridge, HttpToolRequest } from './mcp-bridge.js';
import { Logger } from '../utils/logger.js';

// ============================================
// Interfaces and Types
// ============================================

export interface SseClient {
  id: string;
  response: Response;
  tenantId: string | undefined;
  lastActivity: Date;
  subscriptions: Set<string>;
  connectedAt: Date;
}

export interface SseMessage {
  id?: string;
  event?: string;
  data: any;
  retry?: number;
}

/**
 * Configuration for a polling session
 */
export interface PollingConfig {
  intervalMs: number;
  entities: ('tickets' | 'companies' | 'timeEntries')[];
  pageSize: number;
  filters?: Record<string, any>;
}

/**
 * Active polling session with health tracking
 */
export interface PollingSession {
  pollId: string;
  tenantId: string;
  config: PollingConfig;
  interval: NodeJS.Timeout;
  startedAt: Date;
  lastPollAt: Date | null;
  pollCount: number;
  errorCount: number;
  consecutiveErrors: number;
  lastError?: string;
  isHealthy: boolean;
}

/**
 * SSE Event Types - comprehensive list for real-time feedback
 */
export const SSE_EVENT_TYPES = {
  // Connection events
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  HEARTBEAT: 'heartbeat',
  
  // Data update events
  TICKETS_UPDATE: 'tickets-update',
  COMPANIES_UPDATE: 'companies-update',
  TIME_ENTRIES_UPDATE: 'time-entries-update',
  
  // Pagination events
  PAGINATION_WARNING: 'pagination-warning',
  DATA_SYNC_COMPLETE: 'data-sync-complete',
  
  // Rate limiting events  
  RATE_LIMIT_WARNING: 'rate-limit-warning',
  RATE_LIMIT_EXCEEDED: 'rate-limit-exceeded',
  
  // Polling events
  POLLING_STARTED: 'polling-started',
  POLLING_STOPPED: 'polling-stopped',
  POLLING_ERROR: 'polling-error',
  POLLING_HEALTH: 'polling-health',
  
  // Operation events
  OPERATION_COMPLETE: 'operation-complete',
  SUBSCRIPTION_UPDATED: 'subscription-updated',
} as const;

// Circuit breaker constants for polling
const POLLING_CIRCUIT_BREAKER = {
  maxConsecutiveErrors: 3,
  cooldownPeriodMs: 60000, // 1 minute cooldown
  healthCheckIntervalMs: 30000, // 30 second health checks
};

export class SseManager {
  private clients: Map<string, SseClient> = new Map();
  private bridge: McpHttpBridge;
  private logger: Logger;
  private cleanupInterval: NodeJS.Timeout;
  
  // Proper polling session management (not using `this as any`)
  private pollingSessions: Map<string, PollingSession> = new Map();
  private pollingHealthCheckInterval: NodeJS.Timeout | null = null;

  constructor(bridge: McpHttpBridge, logger: Logger) {
    this.bridge = bridge;
    this.logger = logger;
    
    // Cleanup inactive clients every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveClients();
    }, 30000);
    
    // Start polling health check
    this.startPollingHealthCheck();
  }

  // ============================================
  // Client Management
  // ============================================

  /**
   * Add a new SSE client
   */
  addClient(clientId: string, response: Response, tenantId?: string): SseClient {
    // Set SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const now = new Date();
    const client: SseClient = {
      id: clientId,
      response,
      tenantId,
      lastActivity: now,
      connectedAt: now,
      subscriptions: new Set()
    };

    this.clients.set(clientId, client);

    // Handle client disconnect
    response.on('close', () => {
      this.removeClient(clientId);
    });

    // Send initial connection message
    this.sendToClient(clientId, {
      event: SSE_EVENT_TYPES.CONNECTED,
      data: {
        clientId,
        tenantId,
        timestamp: now.toISOString(),
        message: 'Connected to Autotask SSE stream',
        availableEvents: Object.values(SSE_EVENT_TYPES)
      }
    });

    this.logger.info(`SSE client connected: ${clientId}`, { tenantId });
    return client;
  }

  /**
   * Remove a client
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.response.end();
      } catch {
        // Client may already be disconnected
      }
      this.clients.delete(clientId);
      this.logger.info(`SSE client disconnected: ${clientId}`, { tenantId: client.tenantId });
    }
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId: string, message: SseMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }

    try {
      const sseData = this.formatSseMessage(message);
      client.response.write(sseData);
      client.lastActivity = new Date();
      return true;
    } catch (error) {
      this.logger.error(`Failed to send SSE message to client ${clientId}:`, error);
      this.removeClient(clientId);
      return false;
    }
  }

  /**
   * Broadcast message to all clients or filtered by tenant
   */
  broadcast(message: SseMessage, tenantId?: string): number {
    let sentCount = 0;
    
    for (const [clientId, client] of this.clients) {
      // Filter by tenant if specified
      if (tenantId && client.tenantId !== tenantId) {
        continue;
      }

      if (this.sendToClient(clientId, message)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Subscribe client to specific event types
   */
  subscribe(clientId: string, eventTypes: string[]): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }

    eventTypes.forEach(eventType => {
      client.subscriptions.add(eventType);
    });

    this.sendToClient(clientId, {
      event: SSE_EVENT_TYPES.SUBSCRIPTION_UPDATED,
      data: {
        subscriptions: Array.from(client.subscriptions),
        timestamp: new Date().toISOString()
      }
    });

    return true;
  }

  // ============================================
  // Polling Session Management
  // ============================================

  /**
   * Start polling Autotask data for real-time updates
   * Returns pollId for session management
   */
  async startPolling(
    tenant: HttpToolRequest['tenant'], 
    intervalMs: number = 30000,
    config?: Partial<PollingConfig>
  ): Promise<string> {
    if (!tenant) {
      throw new Error('Tenant credentials required for polling');
    }

    const tenantId = tenant.tenantId || 'unknown';
    const pollId = `poll_${tenantId}_${Date.now()}`;
    
    const pollingConfig: PollingConfig = {
      intervalMs,
      entities: config?.entities || ['tickets'],
      pageSize: config?.pageSize || 10,
      ...(config?.filters && { filters: config.filters })
    };

    // Create polling session
    const session: PollingSession = {
      pollId,
      tenantId,
      config: pollingConfig,
      interval: null as any, // Will be set below
      startedAt: new Date(),
      lastPollAt: null,
      pollCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      isHealthy: true
    };

    // Create the polling interval
    const pollInterval = setInterval(async () => {
      await this.executePoll(pollId, tenant);
    }, intervalMs);

    session.interval = pollInterval;
    this.pollingSessions.set(pollId, session);

    // Notify clients about polling start
    this.broadcast({
      event: SSE_EVENT_TYPES.POLLING_STARTED,
      data: {
        pollId,
        tenantId,
        intervalMs,
        entities: pollingConfig.entities,
        timestamp: new Date().toISOString()
      }
    }, tenantId);

    this.logger.info(`Started polling session: ${pollId}`, { 
      tenantId, 
      intervalMs,
      entities: pollingConfig.entities 
    });
    
    return pollId;
  }

  /**
   * Execute a single poll cycle
   */
  private async executePoll(pollId: string, tenant: HttpToolRequest['tenant']): Promise<void> {
    const session = this.pollingSessions.get(pollId);
    if (!session || !tenant) {
      return;
    }

    // Check circuit breaker
    if (!session.isHealthy) {
      const cooldownElapsed = session.lastPollAt && 
        (Date.now() - session.lastPollAt.getTime() > POLLING_CIRCUIT_BREAKER.cooldownPeriodMs);
      
      if (!cooldownElapsed) {
        return; // Still in cooldown
      }
      
      // Try to recover
      session.isHealthy = true;
      session.consecutiveErrors = 0;
      this.logger.info(`Polling session ${pollId} attempting recovery from circuit breaker`);
    }

    try {
      session.pollCount++;
      session.lastPollAt = new Date();

      // Poll for tickets
      if (session.config.entities.includes('tickets')) {
        const ticketResult = await this.bridge.callTool('search_tickets', {
          arguments: {
            pageSize: session.config.pageSize,
            ...session.config.filters
          },
          tenant
        });

        if (ticketResult.success) {
          this.broadcast({
            event: SSE_EVENT_TYPES.TICKETS_UPDATE,
            data: {
              tickets: ticketResult.data,
              pollId,
              pollCount: session.pollCount,
              timestamp: new Date().toISOString()
            }
          }, session.tenantId);
        }
      }

      // Poll for time entries if configured
      if (session.config.entities.includes('timeEntries')) {
        const timeResult = await this.bridge.callTool('search_time_entries', {
          arguments: {
            pageSize: session.config.pageSize,
            ...session.config.filters
          },
          tenant
        });

        if (timeResult.success) {
          this.broadcast({
            event: SSE_EVENT_TYPES.TIME_ENTRIES_UPDATE,
            data: {
              timeEntries: timeResult.data,
              pollId,
              pollCount: session.pollCount,
              timestamp: new Date().toISOString()
            }
          }, session.tenantId);
        }
      }

      // Reset error counters on success
      session.consecutiveErrors = 0;
      session.isHealthy = true;

    } catch (error) {
      session.errorCount++;
      session.consecutiveErrors++;
      session.lastError = error instanceof Error ? error.message : 'Unknown error';
      
      this.logger.error(`Polling error for ${pollId}:`, {
        error: session.lastError,
        consecutiveErrors: session.consecutiveErrors,
        totalErrors: session.errorCount
      });

      // Trip circuit breaker if too many consecutive errors
      if (session.consecutiveErrors >= POLLING_CIRCUIT_BREAKER.maxConsecutiveErrors) {
        session.isHealthy = false;
        this.logger.warn(`Circuit breaker OPEN for polling session ${pollId}`);
        
        this.broadcast({
          event: SSE_EVENT_TYPES.POLLING_ERROR,
          data: {
            pollId,
            error: session.lastError,
            consecutiveErrors: session.consecutiveErrors,
            circuitBreakerOpen: true,
            cooldownMs: POLLING_CIRCUIT_BREAKER.cooldownPeriodMs,
            timestamp: new Date().toISOString()
          }
        }, session.tenantId);
      } else {
        this.broadcast({
          event: SSE_EVENT_TYPES.POLLING_ERROR,
          data: {
            pollId,
            error: session.lastError,
            consecutiveErrors: session.consecutiveErrors,
            timestamp: new Date().toISOString()
          }
        }, session.tenantId);
      }
    }
  }

  /**
   * Stop polling session
   */
  stopPolling(pollId: string): boolean {
    const session = this.pollingSessions.get(pollId);
    if (!session) {
      return false;
    }

    clearInterval(session.interval);
    this.pollingSessions.delete(pollId);

    // Notify clients
    this.broadcast({
      event: SSE_EVENT_TYPES.POLLING_STOPPED,
      data: {
        pollId,
        totalPolls: session.pollCount,
        totalErrors: session.errorCount,
        duration: Date.now() - session.startedAt.getTime(),
        timestamp: new Date().toISOString()
      }
    }, session.tenantId);

    this.logger.info(`Stopped polling session: ${pollId}`, {
      totalPolls: session.pollCount,
      totalErrors: session.errorCount
    });
    
    return true;
  }

  /**
   * Get polling session info
   */
  getPollingSession(pollId: string): PollingSession | undefined {
    return this.pollingSessions.get(pollId);
  }

  /**
   * Get all active polling sessions for a tenant
   */
  getPollingSessionsForTenant(tenantId: string): PollingSession[] {
    const sessions: PollingSession[] = [];
    for (const session of this.pollingSessions.values()) {
      if (session.tenantId === tenantId) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /**
   * Start periodic health check for all polling sessions
   */
  private startPollingHealthCheck(): void {
    this.pollingHealthCheckInterval = setInterval(() => {
      for (const [pollId, session] of this.pollingSessions) {
        this.broadcast({
          event: SSE_EVENT_TYPES.POLLING_HEALTH,
          data: {
            pollId,
            isHealthy: session.isHealthy,
            pollCount: session.pollCount,
            errorCount: session.errorCount,
            consecutiveErrors: session.consecutiveErrors,
            lastPollAt: session.lastPollAt?.toISOString(),
            uptime: Date.now() - session.startedAt.getTime(),
            timestamp: new Date().toISOString()
          }
        }, session.tenantId);
      }
    }, POLLING_CIRCUIT_BREAKER.healthCheckIntervalMs);
  }

  // ============================================
  // Event Helpers
  // ============================================

  /**
   * Send pagination warning event
   */
  sendPaginationWarning(tenantId: string, details: {
    entity: string;
    showing: number;
    total: number;
    percentComplete: number;
  }): void {
    this.broadcast({
      event: SSE_EVENT_TYPES.PAGINATION_WARNING,
      data: {
        ...details,
        message: `INCOMPLETE DATA: Showing ${details.showing} of ${details.total} ${details.entity} (${details.percentComplete}%)`,
        timestamp: new Date().toISOString()
      }
    }, tenantId);
  }

  /**
   * Send rate limit warning event
   */
  sendRateLimitWarning(tenantId: string, currentCount: number, limit: number): void {
    const percentUsed = Math.round((currentCount / limit) * 100);
    
    this.broadcast({
      event: SSE_EVENT_TYPES.RATE_LIMIT_WARNING,
      data: {
        currentCount,
        limit,
        percentUsed,
        remaining: limit - currentCount,
        message: `API rate limit warning: ${currentCount}/${limit} requests used (${percentUsed}%)`,
        timestamp: new Date().toISOString()
      }
    }, tenantId);
  }

  /**
   * Send real-time notifications when operations complete
   */
  async notifyOperationComplete(operation: string, result: any, tenantId?: string): Promise<void> {
    this.broadcast({
      event: SSE_EVENT_TYPES.OPERATION_COMPLETE,
      data: {
        operation,
        result,
        timestamp: new Date().toISOString()
      }
    }, tenantId);
  }

  // ============================================
  // Statistics and Monitoring
  // ============================================

  /**
   * Get comprehensive statistics
   */
  getStats() {
    const pollingSessions: any[] = [];
    for (const session of this.pollingSessions.values()) {
      pollingSessions.push({
        pollId: session.pollId,
        tenantId: session.tenantId,
        isHealthy: session.isHealthy,
        pollCount: session.pollCount,
        errorCount: session.errorCount,
        uptime: Date.now() - session.startedAt.getTime()
      });
    }

    const clientStats = {
      totalClients: this.clients.size,
      clientsByTenant: {} as Record<string, number>,
      clientsWithSubscriptions: 0
    };

    for (const client of this.clients.values()) {
      if (client.tenantId) {
        clientStats.clientsByTenant[client.tenantId] = 
          (clientStats.clientsByTenant[client.tenantId] || 0) + 1;
      }
      if (client.subscriptions.size > 0) {
        clientStats.clientsWithSubscriptions++;
      }
    }

    return {
      clients: clientStats,
      pollingSessions,
      totalPollingSessions: this.pollingSessions.size
    };
  }

  // ============================================
  // Internal Helpers
  // ============================================

  /**
   * Format message for SSE protocol
   */
  private formatSseMessage(message: SseMessage): string {
    let formatted = '';
    
    if (message.id) {
      formatted += `id: ${message.id}\n`;
    }
    
    if (message.event) {
      formatted += `event: ${message.event}\n`;
    }
    
    if (message.retry) {
      formatted += `retry: ${message.retry}\n`;
    }
    
    // Handle multi-line data
    const dataString = typeof message.data === 'string' 
      ? message.data 
      : JSON.stringify(message.data);
    
    dataString.split('\n').forEach(line => {
      formatted += `data: ${line}\n`;
    });
    
    formatted += '\n'; // End with double newline
    return formatted;
  }

  /**
   * Cleanup inactive clients
   */
  private cleanupInactiveClients(): void {
    const now = new Date();
    const maxInactiveTime = 5 * 60 * 1000; // 5 minutes
    const clientsToRemove: string[] = [];

    for (const [clientId, client] of this.clients) {
      const inactiveTime = now.getTime() - client.lastActivity.getTime();
      if (inactiveTime > maxInactiveTime) {
        clientsToRemove.push(clientId);
      }
    }

    clientsToRemove.forEach(clientId => {
      this.logger.debug(`Cleaning up inactive SSE client: ${clientId}`);
      this.removeClient(clientId);
    });

    if (clientsToRemove.length > 0) {
      this.logger.info(`Cleaned up ${clientsToRemove.length} inactive SSE clients`);
    }
  }

  /**
   * Cleanup manager - call on shutdown
   */
  destroy(): void {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Stop health check interval
    if (this.pollingHealthCheckInterval) {
      clearInterval(this.pollingHealthCheckInterval);
    }
    
    // Stop all polling sessions
    for (const pollId of this.pollingSessions.keys()) {
      this.stopPolling(pollId);
    }
    
    // Close all client connections
    for (const clientId of this.clients.keys()) {
      this.removeClient(clientId);
    }
    
    this.logger.info('SSE Manager destroyed');
  }
}
