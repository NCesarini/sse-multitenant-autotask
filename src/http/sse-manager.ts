// Server-Sent Events Manager for Autotask MCP
// Provides real-time streaming of Autotask data and events

import { Response } from 'express';
import { McpHttpBridge, HttpToolRequest } from './mcp-bridge.js';
import { Logger } from '../utils/logger.js';

export interface SseClient {
  id: string;
  response: Response;
  tenantId: string | undefined;
  lastActivity: Date;
  subscriptions: Set<string>;
}

export interface SseMessage {
  id?: string;
  event?: string;
  data: any;
  retry?: number;
}

export class SseManager {
  private clients: Map<string, SseClient> = new Map();
  private bridge: McpHttpBridge;
  private logger: Logger;
  private cleanupInterval: NodeJS.Timeout;

  constructor(bridge: McpHttpBridge, logger: Logger) {
    this.bridge = bridge;
    this.logger = logger;
    
    // Cleanup inactive clients every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveClients();
    }, 30000);
  }

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

    const client: SseClient = {
      id: clientId,
      response,
      tenantId,
      lastActivity: new Date(),
      subscriptions: new Set()
    };

    this.clients.set(clientId, client);

    // Handle client disconnect
    response.on('close', () => {
      this.removeClient(clientId);
    });

    // Send initial connection message
    this.sendToClient(clientId, {
      event: 'connected',
      data: {
        clientId,
        tenantId,
        timestamp: new Date().toISOString(),
        message: 'Connected to Autotask SSE stream'
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
      } catch (error) {
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
      event: 'subscription-updated',
      data: {
        subscriptions: Array.from(client.subscriptions),
        timestamp: new Date().toISOString()
      }
    });

    return true;
  }

  /**
   * Start polling Autotask data for real-time updates
   */
  async startPolling(tenant: HttpToolRequest['tenant'], intervalMs: number = 30000): Promise<string> {
    if (!tenant) {
      throw new Error('Tenant credentials required for polling');
    }

    const pollId = `poll_${tenant.tenantId || 'unknown'}_${Date.now()}`;
    
    const pollInterval = setInterval(async () => {
      try {
        // Poll for recent tickets
        const ticketResult = await this.bridge.callTool('search_tickets', {
          arguments: {
            pageSize: 10,
            // You could add filters for recent tickets here
          },
          tenant
        });

        if (ticketResult.success) {
          this.broadcast({
            event: 'tickets-update',
            data: {
              tickets: ticketResult.data,
              timestamp: new Date().toISOString(),
              pollId
            }
          }, tenant.tenantId);
        }

        // Poll for companies if needed
        // const companiesResult = await this.bridge.callTool('search_companies', {
        //   arguments: { pageSize: 5 },
        //   tenant
        // });

      } catch (error) {
        this.logger.error(`Polling error for ${pollId}:`, error);
        
        this.broadcast({
          event: 'polling-error',
          data: {
            error: error instanceof Error ? error.message : 'Polling failed',
            pollId,
            timestamp: new Date().toISOString()
          }
        }, tenant.tenantId);
      }
    }, intervalMs);

    // Store the interval for cleanup (in a real implementation, you'd want a more robust system)
    (this as any)[`interval_${pollId}`] = pollInterval;

    this.logger.info(`Started polling for tenant: ${tenant.tenantId || 'unknown'}`, { pollId, intervalMs });
    return pollId;
  }

  /**
   * Stop polling
   */
  stopPolling(pollId: string): boolean {
    const interval = (this as any)[`interval_${pollId}`];
    if (interval) {
      clearInterval(interval);
      delete (this as any)[`interval_${pollId}`];
      this.logger.info(`Stopped polling: ${pollId}`);
      return true;
    }
    return false;
  }

  /**
   * Send real-time notifications when operations complete
   */
  async notifyOperationComplete(operation: string, result: any, tenantId?: string): Promise<void> {
    this.broadcast({
      event: 'operation-complete',
      data: {
        operation,
        result,
        timestamp: new Date().toISOString()
      }
    }, tenantId);
  }

  /**
   * Get client statistics
   */
  getStats() {
    const stats = {
      totalClients: this.clients.size,
      clientsByTenant: {} as Record<string, number>,
      clientsWithSubscriptions: 0
    };

    for (const client of this.clients.values()) {
      if (client.tenantId) {
        stats.clientsByTenant[client.tenantId] = (stats.clientsByTenant[client.tenantId] || 0) + 1;
      }
      if (client.subscriptions.size > 0) {
        stats.clientsWithSubscriptions++;
      }
    }

    return stats;
  }

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
   * Cleanup manager
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Close all client connections
    for (const clientId of this.clients.keys()) {
      this.removeClient(clientId);
    }
    
    // Stop all polling intervals
    Object.keys(this).forEach(key => {
      if (key.startsWith('interval_')) {
        clearInterval((this as any)[key]);
      }
    });
  }
} 