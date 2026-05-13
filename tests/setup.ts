// Jest Setup File
// Configure test environment and global settings

try {
  // Optional: load .env when dotenv is installed (dev convenience)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config();
} catch {
  // dotenv not installed — skip
}

// Set test timeout for longer-running API tests
jest.setTimeout(30000);

// Global test setup
beforeAll(() => {
  // Suppress console.log during tests unless explicitly testing logging
  if (process.env.NODE_ENV === 'test' && !process.env.VERBOSE_TESTS) {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  }
});

// Global test cleanup
afterAll(() => {
  // Any cleanup operations
});
