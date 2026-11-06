import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config, ensureDirectories } from './config.js';
import { initDb } from './db/index.js';
import { registerRoutes } from './routes/index.js';
import { setupWebSocket } from './ws/index.js';
import { hub } from './ws/hub.js';
import { startCleanupJob } from './jobs/cleanup.js';
import { ApiError } from './utils/errors.js';

ensureDirectories();
const db = initDb();

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
  bodyLimit: 1024 * 1024,
  trustProxy: false,
});

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
  maxAge: 86400,
});

await app.register(multipart, {
  limits: {
    fileSize: config.maxMultipartBytes,
    files: 1,
    fields: 30,
    parts: 40,
  },
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiError) {
    const details = {
      err: error,
      statusCode: error.status,
      errorCode: error.code,
      method: request.method,
      url: request.url,
    };
    if (error.status >= 500) request.log.error(details, 'request failed');
    else request.log.warn(details, 'request rejected');
    return reply
      .code(error.status)
      .send({ error: { code: error.code, message: error.message } });
  }

  if (
    error.code === 'FST_REQ_FILE_TOO_LARGE' ||
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
    error.statusCode === 413
  ) {
    request.log.warn(
      { err: error, statusCode: 413, method: request.method, url: request.url },
      'request rejected: payload too large',
    );
    return reply.code(413).send({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
  }

  if (error.statusCode === 400) {
    request.log.warn(
      { err: error, statusCode: 400, method: request.method, url: request.url },
      'request rejected: invalid input',
    );
    return reply.code(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request body or parameters' },
    });
  }

  if (error.statusCode === 415) {
    request.log.warn(
      { err: error, statusCode: 415, method: request.method, url: request.url },
      'request rejected: unsupported media type',
    );
    return reply.code(415).send({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request content type' },
    });
  }

  if (error.statusCode === 404) {
    request.log.warn(
      { err: error, statusCode: 404, method: request.method, url: request.url },
      'request rejected: route not found',
    );
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  }

  request.log.error({ err: error }, 'unhandled request error');
  return reply.code(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
});

app.setNotFoundHandler((request, reply) => {
  request.log.warn(
    { statusCode: 404, method: request.method, url: request.url },
    'request rejected: route not found',
  );
  reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

registerRoutes(app, db);

await app.listen({ port: config.port, host: config.host });
const wss = setupWebSocket(app.server, db);
const stopCleanup = startCleanupJob(db, app.log);

app.log.info(
  {
    host: config.host,
    port: config.port,
    public_base_url: config.publicBaseUrl,
    websocket_url: `${config.publicBaseUrl.replace(/^http/, 'ws')}/ws`,
  },
  'chaty backend is listening',
);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  stopCleanup();

  const forceExit = setTimeout(() => process.exit(0), 4000);
  forceExit.unref();

  try {
    hub.closeAll();
    for (const ws of wss.clients) ws.terminate();
    try {
      wss.close();
    } catch {
      // Already closed.
    }

    await Promise.race([
      app.close(),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        timer.unref();
      }),
    ]);
    db.close();
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
  }

  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  app.log.error({ err: error }, 'uncaught exception');
  shutdown('uncaughtException');
});
