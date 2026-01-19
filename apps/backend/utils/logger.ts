/**
 * Structured logging utility for request tracing and timing.
 * Provides consistent log format across controllers.
 */

export interface RequestContext {
  requestId: string;
  startTime: number;
}

/**
 * Generates a unique request ID for tracing
 */
export const generateRequestId = (prefix: string = 'req'): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Creates a request context for logging
 */
export const createRequestContext = (prefix?: string): RequestContext => {
  return {
    requestId: generateRequestId(prefix),
    startTime: Date.now(),
  };
};

/**
 * Calculates elapsed time from request start
 */
export const getElapsedMs = (ctx: RequestContext): string => {
  return `${Date.now() - ctx.startTime}ms`;
};

/**
 * Logs an info message with request context
 */
export const logInfo = (ctx: RequestContext, message: string, data?: Record<string, unknown>): void => {
  if (data) {
    console.log(`[${ctx.requestId}] ${message}`, data);
  } else {
    console.log(`[${ctx.requestId}] ${message}`);
  }
};

/**
 * Logs an error message with request context
 */
export const logError = (ctx: RequestContext, message: string, error?: Error | unknown, data?: Record<string, unknown>): void => {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  console.error(`[${ctx.requestId}] ${message}`, {
    ...data,
    error: errorObj.message,
    stack: errorObj.stack,
    responseTime: getElapsedMs(ctx),
  });
};

/**
 * Logs request completion (success or failure)
 */
export const logRequestComplete = (
  ctx: RequestContext,
  statusCode: number,
  data?: Record<string, unknown>
): void => {
  const level = statusCode >= 400 ? 'error' : 'log';
  console[level](`[${ctx.requestId}] Request completed:`, {
    statusCode,
    responseTime: getElapsedMs(ctx),
    ...data,
  });
};
