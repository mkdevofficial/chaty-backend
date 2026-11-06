import { config } from '../config.js';
import { badRequest, conflict, payloadTooLarge } from '../utils/errors.js';
import { rateLimitMiddleware } from '../utils/rateLimit.js';
import { parseMultipart, firstFile } from '../utils/multipart.js';
import { inspectImage, sanitizeFilename } from '../utils/media.js';
import {
  validateBio,
  validateDisplayName,
  validateUsername,
  requireObject,
} from '../utils/validate.js';
import {
  loginUser,
  logoutToken,
  registerUser,
  loginOrRegisterGoogleUser,
} from '../services/authService.js';
import { hub } from '../ws/hub.js';
import { getUserObject } from '../services/userService.js';
import {
  deleteFileById,
  saveBufferAsFile,
} from '../services/fileService.js';

const loginRateLimit = rateLimitMiddleware('login', config.rateLimits.login);
const registerRateLimit = rateLimitMiddleware('register', config.rateLimits.register);

export function registerAuthRoutes(app, { db, auth }) {
  app.post(
    '/api/auth/register',
    { preHandler: registerRateLimit },
    async (request, reply) => {
      const result = registerUser(db, requireObject(request.body));
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/api/auth/login',
    { preHandler: loginRateLimit },
    async (request) => loginUser(db, requireObject(request.body)),
  );

  app.post(
    '/api/auth/google',
    { preHandler: loginRateLimit },
    async (request) => loginOrRegisterGoogleUser(db, requireObject(request.body)),
  );

  app.post('/api/auth/logout', { preHandler: auth }, async (request) => {
    logoutToken(db, request.authToken);
    hub.closeToken(request.user.id, request.tokenHash);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: auth }, async (request) =>
    getUserObject(db, request.user.id, request.user.id),
  );

  app.patch('/api/me', { preHandler: auth }, async (request) => {
    const body = requireObject(request.body);
    const updates = {};
    let hasUpdate = false;

    if (body.display_name !== undefined) {
      updates.display_name = validateDisplayName(body.display_name);
      hasUpdate = true;
    }
    if (body.bio !== undefined) {
      updates.bio = validateBio(body.bio);
      hasUpdate = true;
    }
    if (body.username !== undefined) {
      updates.username = validateUsername(body.username);
      hasUpdate = true;
    }

    if (hasUpdate) {
      if (updates.username) {
        const existing = db
          .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
          .get(updates.username, request.user.id);
        if (existing) throw conflict('Username is already taken', 'USERNAME_TAKEN');
      }

      const fields = Object.keys(updates);
      const assignments = fields.map((field) => `${field} = ?`).join(', ');
      try {
        db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`).run(
          ...fields.map((field) => updates[field]),
          request.user.id,
        );
      } catch (error) {
        if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
          throw conflict('Username is already taken', 'USERNAME_TAKEN');
        }
        throw error;
      }
    }

    return getUserObject(db, request.user.id, request.user.id);
  });

  app.post('/api/me/avatar', { preHandler: auth }, async (request) => {
    if (!request.isMultipart()) {
      throw badRequest('Avatar upload must be multipart/form-data');
    }

    const { files } = await parseMultipart(request, {
      maxFileBytes: config.maxAvatarBytes,
    });
    const file = firstFile(files);
    if (!file) throw badRequest('An avatar image is required');
    if (file.buffer.length > config.maxAvatarBytes) {
      throw payloadTooLarge('Avatar exceeds the size limit');
    }

    const info = await inspectImage(file.buffer, file.filename, file.mimetype);
    const fileRow = await saveBufferAsFile(db, {
      ownerId: request.user.id,
      kind: 'avatar',
      buffer: file.buffer,
      originalName: sanitizeFilename(file.filename),
      mime: info.mime,
      extension: info.ext,
      width: info.width,
      height: info.height,
    });

    const oldAvatar = request.user.avatar_file_id;
    try {
      db.prepare('UPDATE users SET avatar_file_id = ? WHERE id = ?').run(
        fileRow.id,
        request.user.id,
      );
    } catch (error) {
      await deleteFileById(db, fileRow.id);
      throw error;
    }

    if (oldAvatar) {
      try {
        await deleteFileById(db, oldAvatar);
      } catch {
        // The new avatar is already active; a stale blob is harmless.
      }
    }

    return getUserObject(db, request.user.id, request.user.id);
  });
}
