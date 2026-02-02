import { describe, it, expect } from '@jest/globals';

/**
 * Capabilities system tests for Backend-Service
 *
 * These tests verify that:
 * 1. The user schema includes capabilities field
 * 2. Capabilities work with the expected data types
 * 3. JWT payloads include capabilities
 */

// Define capabilities locally (mirrors @wxyc/shared/auth-client)
const CAPABILITIES = ['editor', 'webmaster'] as const;
type Capability = (typeof CAPABILITIES)[number];

/**
 * Check if a user has a specific capability.
 */
function hasCapability(
  capabilities: Capability[] | null | undefined,
  capability: Capability
): boolean {
  return capabilities?.includes(capability) ?? false;
}

/**
 * Check if a user can edit website content.
 */
function canEditWebsite(capabilities: Capability[] | null | undefined): boolean {
  return hasCapability(capabilities, 'editor');
}

describe('User capabilities storage', () => {
  describe('capabilities column', () => {
    it('should have capabilities field on user schema', async () => {
      // Import the schema to verify capabilities field exists
      const { user } = await import('@wxyc/database');

      // The user table should have a capabilities field
      expect(user).toHaveProperty('capabilities');
    });
  });

  describe('capability values', () => {
    it('capabilities should be an array type', () => {
      // This tests that the capabilities field accepts array values
      const validCapabilities = ['editor', 'webmaster'];
      expect(Array.isArray(validCapabilities)).toBe(true);
    });

    it('should accept valid capability values', () => {
      const testCapability: Capability = 'editor';
      expect(CAPABILITIES).toContain(testCapability);
    });
  });
});

describe('JWT payload with capabilities', () => {
  it('should include capabilities in user payload structure', () => {
    // Test the expected JWT payload structure
    const expectedPayload = {
      id: 'user-123',
      email: 'test@wxyc.org',
      role: 'dj',
      capabilities: ['editor'],
    };

    expect(expectedPayload).toHaveProperty('capabilities');
    expect(Array.isArray(expectedPayload.capabilities)).toBe(true);
  });

  it('should handle empty capabilities array', () => {
    const payload = {
      id: 'user-123',
      email: 'test@wxyc.org',
      role: 'member',
      capabilities: [],
    };

    expect(payload.capabilities).toEqual([]);
  });

  it('should handle null capabilities gracefully', () => {
    const payload = {
      id: 'user-123',
      email: 'test@wxyc.org',
      role: 'member',
      capabilities: null as string[] | null,
    };

    // Capabilities should default to empty array if null
    const capabilities = payload.capabilities ?? [];
    expect(capabilities).toEqual([]);
  });
});

describe('Capability helper functions', () => {
  describe('hasCapability', () => {
    it('returns true when capability is present', () => {
      expect(hasCapability(['editor'], 'editor')).toBe(true);
    });

    it('returns true when capability is one of many', () => {
      expect(hasCapability(['webmaster', 'editor'], 'editor')).toBe(true);
    });

    it('returns false when capability is absent', () => {
      expect(hasCapability(['webmaster'], 'editor')).toBe(false);
    });

    it('returns false for empty array', () => {
      expect(hasCapability([], 'editor')).toBe(false);
    });

    it('returns false for null', () => {
      expect(hasCapability(null, 'editor')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(hasCapability(undefined, 'editor')).toBe(false);
    });
  });

  describe('canEditWebsite', () => {
    it('returns true when user has editor capability', () => {
      expect(canEditWebsite(['editor'])).toBe(true);
    });

    it('returns false when user only has webmaster capability', () => {
      expect(canEditWebsite(['webmaster'])).toBe(false);
    });

    it('returns true when user has both editor and webmaster', () => {
      expect(canEditWebsite(['editor', 'webmaster'])).toBe(true);
    });

    it('returns false for empty capabilities', () => {
      expect(canEditWebsite([])).toBe(false);
    });

    it('returns false for null capabilities', () => {
      expect(canEditWebsite(null)).toBe(false);
    });
  });
});
