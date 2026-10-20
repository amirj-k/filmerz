'use strict';

/**
 * Minimal in-memory fixed-window rate limiter (per key: route + ip).
 * Good enough for a single-process deployment; swap for a shared store
 * if you ever scale horizontally.
 */
function rateLimiter({ windowMs = 60000, max = 60, name = 'limiter' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  return function check(req, res, next) {
    const now = Date.now();
    sweep(now);
    const ip = (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
    const key = `${name}:${ip}`;
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
    }
    next();
  };
}

module.exports = { rateLimiter };
