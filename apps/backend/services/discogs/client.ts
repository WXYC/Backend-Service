/**
 * Shared Discogs API HTTP client with rate limiting.
 *
 * Implements a token bucket rate limiter (60 requests/minute) to comply
 * with Discogs API limits and prevent 429 errors. Used by DiscogsService
 * and available for direct use by other services (e.g., metadata service).
 *
 * Test mode: When USE_MOCK_SERVICES=true, API calls return mock responses
 * without hitting the real Discogs API.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { getConfig } from '../requestLine/config.js';

const DISCOGS_API_BASE = 'https://api.discogs.com';
const USER_AGENT = 'WXYCBackendService/1.0';

/**
 * Check if mock services are enabled (for testing).
 */
function isMockMode(): boolean {
  return process.env.USE_MOCK_SERVICES === 'true';
}

/**
 * Token bucket rate limiter.
 *
 * Allows bursts of requests up to the bucket capacity, then throttles
 * to maintain the target rate over time.
 */
class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond

  constructor(requestsPerMinute: number) {
    this.capacity = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
    // Convert requests/minute to tokens/millisecond
    this.refillRate = requestsPerMinute / 60000;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Acquire a token, waiting if necessary.
   * Returns a promise that resolves when a token is available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time until a token is available
    const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
    console.log(`[Discogs Rate Limiter] Throttled, waiting ${waitTime}ms for token`);
    await this.sleep(waitTime);

    // Refill and take token
    this.refill();
    this.tokens -= 1;
    console.log(`[Discogs Rate Limiter] Token acquired after wait (${Math.floor(this.tokens)} remaining)`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current token count (for debugging/monitoring).
   */
  getTokenCount(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reset the rate limiter to full capacity.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

/**
 * Discogs API client configuration.
 */
export interface DiscogsClientConfig {
  apiKey: string;
  apiSecret: string;
  requestsPerMinute?: number;
}

/**
 * Shared Discogs HTTP client with built-in rate limiting.
 */
class DiscogsClient {
  private axiosInstance: AxiosInstance | null = null;
  private rateLimiter: TokenBucketRateLimiter | null = null;
  private currentApiKey: string | null = null;
  private currentApiSecret: string | null = null;
  private requestsPerMinute: number = 60;

  /**
   * Initialize or reinitialize the client with credentials.
   */
  private ensureClient(): AxiosInstance {
    const config = getConfig();

    if (!config.discogsApiKey || !config.discogsApiSecret) {
      throw new Error('DISCOGS_API_KEY and DISCOGS_API_SECRET are required');
    }

    // Reinitialize if credentials changed
    if (
      !this.axiosInstance ||
      this.currentApiKey !== config.discogsApiKey ||
      this.currentApiSecret !== config.discogsApiSecret
    ) {
      this.currentApiKey = config.discogsApiKey;
      this.currentApiSecret = config.discogsApiSecret;

      this.axiosInstance = axios.create({
        baseURL: DISCOGS_API_BASE,
        timeout: 10000,
        headers: {
          Authorization: `Discogs key=${config.discogsApiKey}, secret=${config.discogsApiSecret}`,
          'User-Agent': USER_AGENT,
        },
      });

      // Initialize rate limiter if not already done
      if (!this.rateLimiter) {
        this.rateLimiter = new TokenBucketRateLimiter(this.requestsPerMinute);
      }

      console.log('[Discogs Client] Initialized with rate limiter');
    }

    return this.axiosInstance;
  }

  /**
   * Make a rate-limited GET request to the Discogs API.
   *
   * In mock mode (USE_MOCK_SERVICES=true), returns empty mock responses
   * without hitting the real API.
   */
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // Mock mode for testing
    if (isMockMode()) {
      console.log(`[Discogs Client] Mock mode - would request: ${url}`);
      return {
        data: this.getMockResponse<T>(url),
        status: 200,
        statusText: 'OK',
        headers: {},
        config: config as AxiosRequestConfig,
      } as AxiosResponse<T>;
    }

    const client = this.ensureClient();

    // Acquire rate limit token before making request
    await this.rateLimiter!.acquire();

    return client.get<T>(url, config);
  }

  /**
   * Generate mock responses based on the URL pattern.
   */
  private getMockResponse<T>(url: string): T {
    if (url.startsWith('/releases/')) {
      return {
        id: 123,
        title: 'Mock Release',
        artists: [{ id: 1, name: 'Mock Artist' }],
        year: 2024,
        genres: ['Electronic'],
        styles: ['Ambient'],
        tracklist: [],
        images: [],
      } as T;
    }
    if (url.startsWith('/masters/')) {
      return {
        id: 456,
        title: 'Mock Master',
        artists: [{ id: 1, name: 'Mock Artist' }],
        year: 2024,
      } as T;
    }
    if (url.startsWith('/artists/')) {
      return {
        id: 1,
        name: 'Mock Artist',
        profile: 'A mock artist for testing',
      } as T;
    }
    if (url.includes('/database/search')) {
      return {
        results: [],
        pagination: { page: 1, pages: 0, per_page: 50, items: 0 },
      } as T;
    }
    return {} as T;
  }

  /**
   * Get the underlying Axios instance (for advanced use cases).
   * Note: Direct use bypasses rate limiting.
   */
  getAxiosInstance(): AxiosInstance {
    return this.ensureClient();
  }

  /**
   * Check if the client is configured and ready.
   */
  isConfigured(): boolean {
    const config = getConfig();
    return !!(config.discogsApiKey && config.discogsApiSecret);
  }

  /**
   * Get current rate limiter token count (for monitoring).
   */
  getRateLimitTokens(): number {
    return this.rateLimiter?.getTokenCount() ?? 0;
  }

  /**
   * Reset the client state. Call in beforeEach/afterEach for clean test state.
   */
  reset(): void {
    this.axiosInstance = null;
    this.rateLimiter = null;
    this.currentApiKey = null;
    this.currentApiSecret = null;
  }
}

/**
 * Shared Discogs client singleton.
 */
export const discogsClient = new DiscogsClient();

/**
 * Reset the Discogs client. Only intended for use in tests.
 * Call this in beforeEach/afterEach to get a clean slate.
 */
export function resetDiscogsClient(): void {
  discogsClient.reset();
}

/**
 * Parse Discogs title format 'Artist - Album' into components.
 * Exported as a shared utility.
 */
export function parseTitle(title: string): { artist: string; album: string } {
  if (title.includes(' - ')) {
    const parts = title.split(' - ');
    return {
      artist: parts[0].trim(),
      album: parts.slice(1).join(' - ').trim(),
    };
  }
  return { artist: '', album: title };
}
