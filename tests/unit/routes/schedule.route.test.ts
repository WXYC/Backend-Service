import express from 'express';
import request from 'supertest';
import { schedule_route } from '../../../apps/backend/routes/schedule.route';

const app = express();
app.use(express.json());
app.use('/schedule', schedule_route);

describe('schedule route', () => {
  it('POST /schedule requires authentication', async () => {
    const response = await request(app).post('/schedule').send({});
    expect(response.status).toBe(401);
  });

  it('GET /schedule is publicly accessible', async () => {
    const response = await request(app).get('/schedule');
    expect(response.status).toBe(200);
  });
});
