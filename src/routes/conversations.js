import { config } from '../config.js';
import { badRequest } from '../utils/errors.js';
import { parseId, requireObject } from '../utils/validate.js';
import { parseMultipart, firstFile } from '../utils/multipart.js';
import {
  getOrCreateConversation,
  listConversations,
} from '../services/conversationService.js';
import {
  createAttachmentMessage,
  createJsonMessage,
  getMessages,
  markConversationRead,
} from '../services/messageService.js';

export function registerConversationRoutes(app, { db, auth }) {
  app.get('/api/conversations', { preHandler: auth }, async (request) => ({
    conversations: listConversations(db, request.user.id),
  }));

  app.post('/api/conversations', { preHandler: auth }, async (request) => {
    const body = requireObject(request.body);
    const otherUserId = parseId(body.user_id, 'user_id');
    return getOrCreateConversation(db, request.user.id, otherUserId);
  });

  app.get('/api/conversations/:id/messages', { preHandler: auth }, async (request) => {
    const conversationId = parseId(request.params.id, 'conversation id');
    return getMessages(db, request.user.id, conversationId, {
      before: request.query.before,
      limit: request.query.limit,
    });
  });

  app.post('/api/conversations/:id/messages', { preHandler: auth }, async (request, reply) => {
    const conversationId = parseId(request.params.id, 'conversation id');

    if (request.isMultipart()) {
      const { fields, files } = await parseMultipart(request, {
        maxFileBytes: config.maxMultipartBytes,
      });
      const file = firstFile(files);
      if (!file) throw badRequest('A file is required for this message type');

      const firstValue = (value) => (Array.isArray(value) ? value[0] : value);
      let type = firstValue(fields.type);
      if (!type) {
        const declared = file.mimetype || '';
        if (declared.startsWith('image/')) type = 'image';
        else if (declared.startsWith('audio/')) type = 'audio';
        else type = 'file';
      }

      const message = await createAttachmentMessage(db, request.user.id, conversationId, {
        type,
        clientId: firstValue(fields.client_id),
        text: firstValue(fields.caption) ?? firstValue(fields.text),
        file,
        durationMs: firstValue(fields.duration_ms),
      });
      return reply.code(201).send(message);
    }

    const message = createJsonMessage(
      db,
      request.user.id,
      conversationId,
      requireObject(request.body),
    );
    return reply.code(201).send(message);
  });

  app.post('/api/conversations/:id/read', { preHandler: auth }, async (request) => {
    const conversationId = parseId(request.params.id, 'conversation id');
    return markConversationRead(db, request.user.id, conversationId);
  });
}
