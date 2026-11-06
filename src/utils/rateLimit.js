import { tooManyRequests } from './errors.js';

const buckets = new Map();

function take(key, windowMs, max) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let timestamps = buckets.get(key);
  if (!timestamps) {
    timestamps = [];
    buckets.set(key, timestamps);
  }
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
  if (timestamps.length >= max) return false;
  timestamps.push(now);
  return true;
}

export function rateLimitMiddleware(name, { max, windowMs }) {
  return async function rateLimit(request) {
    const key = `${name}:${request.ip}`;
    if (!take(key, windowMs, max)) {
      throw tooManyRequests('Too many requests, please try again later');
    }
  };
}

export function sweepRateLimits() {
  const now = Date.now();
  const longest = 60 * 60 * 1000;
  for (const [key, timestamps] of buckets.entries()) {
    const last = timestamps[timestamps.length - 1] || 0;
    if (now - last > longest) buckets.delete(key);
  }
}
