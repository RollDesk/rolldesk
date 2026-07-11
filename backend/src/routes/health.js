import { Router } from 'express';
import { ping } from '../db.js';

const router = Router();
router.get('/', async (_req, res) => {
  try {
    await ping();
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});
export default router;
