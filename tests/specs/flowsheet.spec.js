const request = require('supertest');

// Test Suite
describe("Let's see if jest and supertest are working", () => {
  // Test case 1
  it('Should send an http request and receive a success', async () => {
    //host to test
    const host = request('https://api.wxyc.org');

    const res = await host
      .get('/flowsheet') // API endpoint
      .query({ limit: 50 })
      .send() // request body
      .expect(200); // use supertest's expect to verify that the status code is 200
  });
});
