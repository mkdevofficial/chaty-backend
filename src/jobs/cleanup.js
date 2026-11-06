import { config } from '../config.js';
import { nowIso } from '../utils/time.js';
import { sweepRateLimits } from '../utils/rateLimit.js';
import { cleanupExpiredStories } from '../services/storyService.js';

export function startCleanupJob(db, logger) {
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      const stories = await cleanupExpiredStories(db);
      const sessions = db
        .prepare('DELETE FROM sessions WHERE expires_at <= ?')
        .run(nowIso()).changes;
      sweepRateLimits();
      if (stories || sessions) {
        logger.info({ stories, sessions }, 'cleanup finished');
      }
    } catch (error) {
      logger.error({ err: error }, 'cleanup failed');
    } finally {
      running = false;
    }
  }

  run();
  const intervalMs = Math.max(1, config.cleanupIntervalMinutes) * 60 * 1000;
  const timer = setInterval(run, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
