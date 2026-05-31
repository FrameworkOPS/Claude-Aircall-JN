/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  clearMocks: true,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // Tests import from src directly; relax rootDir for test compilation.
        tsconfig: { rootDir: '.' },
      },
    ],
  },
};
