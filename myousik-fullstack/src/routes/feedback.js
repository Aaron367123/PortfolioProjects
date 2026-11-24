/**
 * /api/feedback — the v1 feedback form, now actually stored.
 * Anyone may submit (rate-limited per IP); only logged-in users can read.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { check, schemas } from '../validation.js';

export function feedbackRouter({ db, config }) {
  const router = Router();
  const limiter = createRateLimiter(config.rateLimits.feedback);

  const insert = db.prepare(`
    INSERT INTO feedback (name, email, rating, comments) VALUES (:name, :email, :rating, :comments)
    RETURNING id, created_at`);
  const latest = db.prepare('SELECT id, name, email, rating, comments, created_at FROM feedback ORDER BY id DESC LIMIT 100');

  router.post('/', (req, res) => {
    const entry = check(req.body, schemas.feedback); // validate first: typos shouldn't use up the allowance
    limiter.assertAllowed(req.ip);
    limiter.hit(req.ip);
    const saved = insert.get(entry);
    res.status(201).json({ feedback: { ...entry, ...saved } });
  });

  router.get('/', requireAuth, (_req, res) => {
    res.json({ data: latest.all() });
  });

  return router;
}
