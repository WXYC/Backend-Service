import { jest } from '@jest/globals';

jest.setTimeout(10000);

beforeEach(() => {
  jest.clearAllMocks();
});
