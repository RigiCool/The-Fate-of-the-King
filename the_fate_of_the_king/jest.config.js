module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testPathIgnorePatterns: ['<rootDir>/tests/llm.contract.test.js', '<rootDir>/tests/game.simulation.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  silent: true,
  collectCoverage: true,
  collectCoverageFrom: [
    'db.js',
    'auth.js',
    'validator/**/*.js',
    'world/**/*.js',
    'planner/**/*.js',
    '!**/node_modules/**',
    '!**/client/**'
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  moduleFileExtensions: ['js', 'jsx', 'json'],
};
