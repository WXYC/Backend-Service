// Mock drizzle-orm for unit tests
export const eq = jest.fn((a, b) => ({ eq: [a, b] }));
export const and = jest.fn((...conditions: unknown[]) => ({ and: conditions }));
export const or = jest.fn((...conditions: unknown[]) => ({ or: conditions }));
export const sql = Object.assign(
  jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings,
    values,
  })),
  {
    raw: jest.fn((s: string) => ({ raw: s })),
  }
);
export const desc = jest.fn((col) => ({ desc: col }));
export const asc = jest.fn((col) => ({ asc: col }));
export const inArray = jest.fn((col, values) => ({ inArray: [col, values] }));
export const isNull = jest.fn((col) => ({ isNull: col }));
export const isNotNull = jest.fn((col) => ({ isNotNull: col }));
export const gte = jest.fn((a, b) => ({ gte: [a, b] }));
export const lte = jest.fn((a, b) => ({ lte: [a, b] }));
