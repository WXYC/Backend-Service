export class APIError extends Error {
  statusCode: number;
  body?: { message?: string; code?: string; [key: string]: unknown };

  constructor(
    status: number | string = 500,
    body?: { message?: string; code?: string; [key: string]: unknown },
    _headers?: unknown,
    statusCode?: number
  ) {
    super(body?.message ?? 'API Error');
    this.name = 'APIError';
    this.body = body;
    this.statusCode = statusCode ?? (typeof status === 'number' ? status : 500);
  }
}
