/**
 * Rate Limiter for Autotask API
 * 
 * The Autotask REST API has rate limits that must be respected.
 * This module provides a token bucket rate limiter to prevent
 * overwhelming the API with requests.
 * 
 * Default: 5 requests per second (configurable)
 */

import { Logger } from '../utils/logger.js';

// ============================================
// Rate Limiter Class
// ============================================

export interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  
  /** Time window in milliseconds */
  windowMs: number;
  
  /** Optional logger for debugging */
  logger?: Logger;
}

export class RateLimiter {
  private requests: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly logger: Logger | undefined;
  
  constructor(config: RateLimiterConfig = { maxRequests: 5, windowMs: 1000 }) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
    this.logger = config.logger;
  }
  
  /**
   * Create a rate limiter with requests per second.
   */
  static perSecond(requestsPerSecond: number, logger?: Logger): RateLimiter {
    const config: RateLimiterConfig = {
      maxRequests: requestsPerSecond,
      windowMs: 1000
    };
    if (logger !== undefined) {
      config.logger = logger;
    }
    return new RateLimiter(config);
  }
  
  /**
   * Create a rate limiter with requests per minute.
   */
  static perMinute(requestsPerMinute: number, logger?: Logger): RateLimiter {
    const config: RateLimiterConfig = {
      maxRequests: requestsPerMinute,
      windowMs: 60000
    };
    if (logger !== undefined) {
      config.logger = logger;
    }
    return new RateLimiter(config);
  }
  
  /**
   * Wait for an available slot before making a request.
   * This method blocks until it's safe to make a request.
   */
  async waitForSlot(): Promise<void> {
    const now = Date.now();
    
    // Remove requests outside the current window
    this.requests = this.requests.filter(time => now - time < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      // Calculate wait time
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      
      if (waitTime > 0) {
        this.logger?.debug(`Rate limit reached, waiting ${waitTime}ms`, {
          currentRequests: this.requests.length,
          maxRequests: this.maxRequests,
          waitTimeMs: waitTime
        });
        
        await this.sleep(waitTime);
        return this.waitForSlot(); // Recursive check after waiting
      }
    }
    
    // Record this request
    this.requests.push(now);
    
    this.logger?.debug(`Request slot acquired`, {
      currentRequests: this.requests.length,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs
    });
  }
  
  /**
   * Check if a request can be made immediately without waiting.
   */
  canMakeRequest(): boolean {
    const now = Date.now();
    const activeRequests = this.requests.filter(time => now - time < this.windowMs).length;
    return activeRequests < this.maxRequests;
  }
  
  /**
   * Get current rate limiter status.
   */
  getStatus(): {
    activeRequests: number;
    maxRequests: number;
    windowMs: number;
    canMakeRequest: boolean;
    estimatedWaitMs: number;
  } {
    const now = Date.now();
    const activeRequests = this.requests.filter(time => now - time < this.windowMs).length;
    const canMake = activeRequests < this.maxRequests;
    
    let estimatedWaitMs = 0;
    if (!canMake && this.requests.length > 0) {
      const oldestRequest = this.requests[0];
      estimatedWaitMs = Math.max(0, this.windowMs - (now - oldestRequest));
    }
    
    return {
      activeRequests,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
      canMakeRequest: canMake,
      estimatedWaitMs
    };
  }
  
  /**
   * Reset the rate limiter (useful for testing or error recovery).
   */
  reset(): void {
    this.requests = [];
    this.logger?.info('Rate limiter reset');
  }
  
  /**
   * Utility sleep function.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// Request Queue with Rate Limiting
// ============================================

export interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Request queue that automatically rate-limits API calls.
 * Use this for bulk operations that need to respect rate limits.
 */
export class RateLimitedQueue {
  private queue: QueuedRequest<any>[] = [];
  private processing = false;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger | undefined;
  
  constructor(rateLimiter: RateLimiter, logger?: Logger) {
    this.rateLimiter = rateLimiter;
    this.logger = logger;
  }
  
  /**
   * Add a request to the queue.
   * Returns a promise that resolves when the request completes.
   */
  async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ execute, resolve, reject });
      this.processQueue();
    });
  }
  
  /**
   * Process queued requests respecting rate limits.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return; // Already processing
    }
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      
      try {
        // Wait for rate limit slot
        await this.rateLimiter.waitForSlot();
        
        // Execute the request
        const result = await request.execute();
        request.resolve(result);
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    
    this.processing = false;
  }
  
  /**
   * Get queue status.
   */
  getStatus(): {
    queueLength: number;
    isProcessing: boolean;
    rateLimiterStatus: ReturnType<RateLimiter['getStatus']>;
  } {
    return {
      queueLength: this.queue.length,
      isProcessing: this.processing,
      rateLimiterStatus: this.rateLimiter.getStatus()
    };
  }
  
  /**
   * Clear the queue (pending requests will be rejected).
   */
  clear(): void {
    const error = new Error('Queue cleared - request cancelled');
    
    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      request.reject(error);
    }
    
    this.logger?.info('Request queue cleared', { cancelledRequests: this.queue.length });
  }
}

// ============================================
// Concurrent Request Limiter
// ============================================

/**
 * Limits the number of concurrent requests.
 * Useful in combination with RateLimiter for complex rate limiting scenarios.
 */
export class ConcurrencyLimiter {
  private currentConcurrency = 0;
  private readonly maxConcurrency: number;
  private waitQueue: Array<() => void> = [];
  
  constructor(maxConcurrency: number = 10) {
    this.maxConcurrency = maxConcurrency;
  }
  
  /**
   * Acquire a concurrency slot.
   * Resolves when a slot is available.
   */
  async acquire(): Promise<void> {
    if (this.currentConcurrency < this.maxConcurrency) {
      this.currentConcurrency++;
      return;
    }
    
    // Wait for a slot to become available
    return new Promise(resolve => {
      this.waitQueue.push(resolve);
    });
  }
  
  /**
   * Release a concurrency slot.
   */
  release(): void {
    if (this.waitQueue.length > 0) {
      // Give the slot to the next waiter
      const next = this.waitQueue.shift()!;
      next();
    } else {
      this.currentConcurrency--;
    }
  }
  
  /**
   * Execute a function with concurrency limiting.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  
  /**
   * Get current status.
   */
  getStatus(): {
    currentConcurrency: number;
    maxConcurrency: number;
    waitingRequests: number;
  } {
    return {
      currentConcurrency: this.currentConcurrency,
      maxConcurrency: this.maxConcurrency,
      waitingRequests: this.waitQueue.length
    };
  }
}


