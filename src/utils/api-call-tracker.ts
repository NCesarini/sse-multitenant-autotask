/**
 * API Call Tracker
 * Tracks all API calls (both cache hits and actual API calls) during tool execution.
 * Provides detailed logging and summary information for debugging and transparency.
 */

import { Logger } from './logger.js';

/**
 * Record of a single API call or cache lookup
 */
export interface ApiCallRecord {
  /** Timestamp when the call was initiated */
  timestamp: number;
  /** Entity being accessed (e.g., "Companies", "Tickets", "Resources") */
  entity: string;
  /** Operation type (e.g., "query", "get", "create", "update", "count") */
  operation: string;
  /** Whether this was an actual API call or a cache hit */
  source: 'api' | 'cache';
  /** Duration of the call in milliseconds (only for actual API calls) */
  durationMs?: number;
  /** Additional context about the call */
  details?: Record<string, any>;
}

/**
 * Summary of all API calls made during a tool execution
 */
export interface ApiCallSummary {
  /** Total number of operations (API + cache) */
  totalCalls: number;
  /** Number of actual API calls made */
  apiCalls: number;
  /** Number of cache hits (avoided API calls) */
  cacheHits: number;
  /** Total time spent on API calls in milliseconds */
  totalDurationMs: number;
  /** Detailed list of all calls made */
  calls: ApiCallRecord[];
}

/**
 * Tracks API calls during tool execution.
 * Create one instance per tool call to track all underlying API operations.
 */
export class ApiCallTracker {
  private calls: ApiCallRecord[] = [];
  private logger: Logger | undefined;
  private toolName: string;
  private toolCallId: string;

  constructor(toolName: string, toolCallId: string, logger?: Logger) {
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.logger = logger;
  }

  /**
   * Record an actual API call
   * @param entity The entity being accessed (e.g., "Companies")
   * @param operation The operation type (e.g., "query", "get")
   * @param durationMs How long the call took
   * @param details Additional context (filter info, IDs, etc.)
   */
  recordApiCall(
    entity: string,
    operation: string,
    durationMs: number,
    details?: Record<string, any>
  ): void {
    const record: ApiCallRecord = {
      timestamp: Date.now(),
      entity,
      operation,
      source: 'api',
      durationMs,
      ...(details !== undefined && { details })
    };
    this.calls.push(record);

    this.logger?.debug(`📡 API Call: ${entity}.${operation}`, {
      toolCallId: this.toolCallId,
      ...record
    });
  }

  /**
   * Record a cache hit (avoided API call)
   * @param entity The entity type (e.g., "Companies", "Resources")
   * @param operation The operation that was cached (e.g., "get", "getName")
   * @param details Additional context (cached ID, etc.)
   */
  recordCacheHit(
    entity: string,
    operation: string,
    details?: Record<string, any>
  ): void {
    const record: ApiCallRecord = {
      timestamp: Date.now(),
      entity,
      operation,
      source: 'cache',
      ...(details !== undefined && { details })
    };
    this.calls.push(record);

    this.logger?.debug(`💾 Cache Hit: ${entity}.${operation}`, {
      toolCallId: this.toolCallId,
      ...record
    });
  }

  /**
   * Get a summary of all tracked calls
   */
  getSummary(): ApiCallSummary {
    const apiCalls = this.calls.filter(c => c.source === 'api');
    const cacheHits = this.calls.filter(c => c.source === 'cache');
    const totalDurationMs = apiCalls.reduce((sum, c) => sum + (c.durationMs || 0), 0);

    return {
      totalCalls: this.calls.length,
      apiCalls: apiCalls.length,
      cacheHits: cacheHits.length,
      totalDurationMs,
      calls: this.calls
    };
  }

  /**
   * Log the summary to the logger
   */
  logSummary(): void {
    const summary = this.getSummary();
    
    this.logger?.info(`📊 API Call Summary for ${this.toolName}`, {
      toolCallId: this.toolCallId,
      totalCalls: summary.totalCalls,
      apiCalls: summary.apiCalls,
      cacheHits: summary.cacheHits,
      totalDurationMs: summary.totalDurationMs,
      cacheHitRate: summary.totalCalls > 0 
        ? `${((summary.cacheHits / summary.totalCalls) * 100).toFixed(1)}%` 
        : 'N/A'
    });

    // Log individual calls at debug level
    if (this.calls.length > 0) {
      this.logger?.debug(`📋 Detailed API calls for ${this.toolName}:`, {
        toolCallId: this.toolCallId,
        calls: this.calls.map(c => ({
          entity: c.entity,
          operation: c.operation,
          source: c.source,
          durationMs: c.durationMs
        }))
      });
    }
  }

  /**
   * Get the number of calls recorded
   */
  get callCount(): number {
    return this.calls.length;
  }

  /**
   * Check if any calls have been recorded
   */
  get hasCalls(): boolean {
    return this.calls.length > 0;
  }
}


