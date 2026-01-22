// Mock drizzle-orm for unit tests
export const eq = jest.fn((a, b) => ({ eq: [a, b] }));
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
