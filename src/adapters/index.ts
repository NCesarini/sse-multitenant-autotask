/**
 * Autotask Adapters
 * 
 * This module exports the adapter interface and implementations for
 * interacting with the Autotask REST API.
 */

// Interface and types
export * from './autotask-adapter.interface.js';

// Implementations
export { ApigrateAdapter, createApigrateAdapter, type ApigrateAdapterConfig } from './apigrate-adapter.js';

