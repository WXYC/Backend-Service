/**
 * Shared state for the mock API server.
 *
 * Tracks all incoming requests and manages error simulation rules.
 */

export interface RecordedRequest {
  service: 'lml' | 'slack' | 'tubafrenzy';
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  timestamp: string;
}

export interface ErrorRule {
  service: string;
  endpoint: string;
  status: number;
  body?: unknown;
  count?: number; // fail N times then succeed; omit for permanent
  remaining?: number;
}

const requests: RecordedRequest[] = [];
const errorRules: ErrorRule[] = [];

export function recordRequest(req: RecordedRequest): void {
  requests.push(req);
}

export function getRequests(service?: string): RecordedRequest[] {
  if (service) return requests.filter((r) => r.service === service);
  return [...requests];
}

export function addErrorRule(rule: ErrorRule): void {
  errorRules.push({ ...rule, remaining: rule.count });
}

/**
 * Check if an error rule matches the given service and endpoint.
 * If a matching rule exists, decrements its counter (for count-limited rules)
 * and returns the error details. Returns null if no rule matches.
 */
export function checkErrorRule(service: string, endpoint: string): { status: number; body?: unknown } | null {
  for (let i = 0; i < errorRules.length; i++) {
    const rule = errorRules[i];
    if (rule.service !== service) continue;
    if (!endpoint.startsWith(rule.endpoint)) continue;

    // Permanent error (no count)
    if (rule.remaining === undefined) {
      return { status: rule.status, body: rule.body };
    }

    // Count-limited error
    if (rule.remaining > 0) {
      rule.remaining--;
      return { status: rule.status, body: rule.body };
    }

    // Count exhausted — remove rule, allow request through
    errorRules.splice(i, 1);
    return null;
  }
  return null;
}

export function resetState(): void {
  requests.length = 0;
  errorRules.length = 0;
}

export function clearErrorRules(): void {
  errorRules.length = 0;
}
