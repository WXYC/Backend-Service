/**
 * Shared test helper utilities for integration tests
 *
 * Provides:
 * - Authenticated request helpers
 * - Error response assertions
 * - Field validation helpers
 */

/**
 * Creates an authenticated request wrapper that automatically sets the Authorization header.
 *
 * @param {object} baseRequest - The supertest request object
 * @param {string} token - The authorization token
 * @returns {object} Object with HTTP method helpers
 *
 * @example
 * const auth = createAuthRequest(request, global.access_token);
 * const res = await auth.get('/djs/bin').query({ dj_id: 123 });
 */
const createAuthRequest = (baseRequest, token) => ({
  get: (path) => baseRequest.get(path).set('Authorization', token),
  post: (path) => baseRequest.post(path).set('Authorization', token),
  put: (path) => baseRequest.put(path).set('Authorization', token),
  patch: (path) => baseRequest.patch(path).set('Authorization', token),
  delete: (path) => baseRequest.delete(path).set('Authorization', token),
});

/**
 * Asserts that an error response contains the expected message.
 * Handles both res.body.message and res.text formats.
 *
 * @param {object} res - The supertest response object
 * @param {string} messageContains - String that should be in the error message (case-insensitive)
 *
 * @example
 * expectErrorContains(res, 'missing');
 */
const expectErrorContains = (res, messageContains) => {
  const message = res.body?.message || res.text || '';
  expect(message.toLowerCase()).toContain(messageContains.toLowerCase());
};

/**
 * Asserts that an object has all the specified properties.
 *
 * @param {object} obj - The object to check
 * @param {...string} fields - The field names that should exist
 *
 * @example
 * expectFields(res.body, 'id', 'artist_name', 'album_title');
 */
const expectFields = (obj, ...fields) => {
  fields.forEach((field) => expect(obj).toHaveProperty(field));
};

/**
 * Asserts that a response body is an array.
 *
 * @param {object} res - The supertest response object
 *
 * @example
 * expectArray(res);
 */
const expectArray = (res) => {
  expect(Array.isArray(res.body)).toBe(true);
};

module.exports = {
  createAuthRequest,
  expectErrorContains,
  expectFields,
  expectArray,
};
