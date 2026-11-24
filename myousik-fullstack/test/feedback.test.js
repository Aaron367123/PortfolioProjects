import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const valid = { name: 'Jane Listener', email: 'Jane@Example.com', rating: 3, comments: 'The lo-fi stream sounds great!' };

describe('feedback', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { FEEDBACK_MAX_PER_HOUR: '4' } }); });
  after(() => srv.close());

  it('reports every missing field (the v1 form only checked some)', async () => {
    const res = await srv.client().post('/api/feedback', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['comments', 'email', 'name', 'rating']);
  });

  it('validates email shape, rating range and comment length', async () => {
    const res = await srv.client().post('/api/feedback', { ...valid, email: 'not-an-email', rating: 4, comments: 'meh' });
    assert.equal(res.status, 400);
    const { fields } = res.body.error;
    assert.equal(fields.email, 'Email must be a valid email address.');
    assert.equal(fields.rating, 'Please rate the audio quality from 1 to 3.');
    assert.equal(fields.comments, 'Please enter your feedback (5–2000 characters).');
    assert.equal(fields.name, undefined);
  });

  it('accepts a valid submission without logging in', async () => {
    const res = await srv.client().post('/api/feedback', valid);
    assert.equal(res.status, 201);
    assert.equal(res.body.feedback.email, 'jane@example.com', 'emails are normalised');
    assert.ok(res.body.feedback.id);
  });

  it('only lets logged-in users read feedback', async () => {
    assert.equal((await srv.client().get('/api/feedback')).status, 401);
    const c = srv.client();
    await c.register('moderator');
    const res = await c.get('/api/feedback');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((f) => f.name === 'Jane Listener'));
  });

  it('rate-limits submissions per IP', async () => {
    const c = srv.client();
    let last;
    for (let i = 0; i < 5; i += 1) last = await c.post('/api/feedback', valid);
    assert.equal(last.status, 429);
  });
});
