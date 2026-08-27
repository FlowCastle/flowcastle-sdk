module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j)sx?$': 'ts-jest' },
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@flowcastle/sdk-runtime$': '<rootDir>/../sdk-runtime/src/index.ts',
  },
  roots: ['<rootDir>/src'],
};
