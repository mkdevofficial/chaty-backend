import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../utils/time.js';
import { config } from '../config.js';

export function registerHealthRoutes(app) {
  app.get('/api/health', async () => ({
    ok: true,
    status: 'ok',
    time: nowIso(),
    uptime_seconds: Math.floor(process.uptime()),
  }));

  const serveZip = async (request, reply) => {
    const candidates = [
      path.resolve(config.rootDir, 'chaty-backend.zip'),
      path.resolve(config.rootDir, '..', 'chaty-backend.zip'),
      path.resolve(config.rootDir, '..', 'chaty-bk.zip'),
      path.resolve(config.dataDir, 'chaty-backend.zip'),
    ];

    for (const zipPath of candidates) {
      if (fs.existsSync(zipPath)) {
        const stat = fs.statSync(zipPath);
        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', 'attachment; filename="chaty-backend.zip"')
          .header('Content-Length', stat.size)
          .send(fs.createReadStream(zipPath));
      }
    }
    return reply.code(404).send({ error: 'chaty-backend.zip not found' });
  };

  app.get('/download', serveZip);
  app.get('/download/chaty-backend.zip', serveZip);
  app.get('/api/download', serveZip);
}
