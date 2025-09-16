/**
 * Shared threshold constants for large response management
 * Used across service layer and handler layer to maintain consistency
 */

export const LARGE_RESPONSE_THRESHOLDS = {
  tickets: 100,        // Double from 50
  companies: 200,      // Double from 100
  contacts: 200,       // Double from 100
  projects: 100,       // Double from 50
  resources: 200,      // Double from 100
  tasks: 100,          // Double from 50
  timeentries: 200,    // Time entries threshold (matches maxrecords limit)
  default: 300,        // Increased default
  responseSizeKB: 200  // Double from 100KB
};

export type ThresholdType = keyof typeof LARGE_RESPONSE_THRESHOLDS; 