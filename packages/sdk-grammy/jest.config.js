module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@flowcastle/sdk-runtime$': '<rootDir>/../sdk-runtime/src/index.ts',
  },
  roots: ['<rootDir>/src'],
};
