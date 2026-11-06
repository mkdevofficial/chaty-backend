import { config } from '../config.js';
import { badRequest, payloadTooLarge } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';
import {
  isPlainObject,
  parseOptionalInt,
  validateClientId,
  validateSticker,
} from '../utils/validate.js';
import { inspectAnyFile, inspectAudio, inspectImage, sanitizeFilename } from '../utils/media.js';
import { messageObjectFromRow } from '../serializers.js';
import { hub } from '../ws/hub.js';
import { emitMessageStatusUpdates, markDeliveredForConversation } from './statusService.js';
import { requireParticipant, touchConversation } from './conversationService.js';
import { getLastMessageId, getMessageRow, MESSAGE_SELECT } from './messageQueries.js';
import { saveBufferAsFile, deleteFileRecordAndBlob } from './fileService.js';

const MESSAGE_TYPES = new Set(['text', 'image', 'audio', 'file', 'sticker']);

function validateText(value, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest('text is required');
  }
  if (value.length > max) throw badRequest(`text must be at most ${max} characters`);
  return value;
}

function optionalCaption(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('text must be a string');
  if (value.length > config.maxMessageText) {
    throw badRequest(`text must be at most ${config.maxMessageText} characters`);
  }
  return value;
}

function findExistingByClientId(db, conversationId, senderId, clientId) {
  if (!clientId) return null;
  return db
    .prepare(
      'SELECT id FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?',
    )
    .get(conversationId, senderId, clientId);
}

function insertMessageRow(db, {
  conversationId,
  senderId,
  clientId,
  type,
  text,
  fileId,
  stickerPack,
  stickerId,
}) {
  const createdAt = nowIso();
  const result = db
    .prepare(
      `INSERT INTO messages
         (conversation_id, sender_id, client_id, type, text, file_id, sticker_pack, sticker_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
    )
    .run(
      conversationId,
      senderId,
      clientId,
      type,
      text,
      fileId,
      stickerPack,
      stickerId,
      createdAt,
    );
  touchConversation(db, conversationId, createdAt);
  return getMessageRow(db, Number(result.lastInsertRowid));
}

function emitNewMessage(db, row, senderId, otherUserId) {
  let message = messageObjectFromRow(row);
  let becameDelivered = false;

  if (hub.isOnline(otherUserId) && message.status === 'sent') {
    db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?").run(message.id);
    message = { ...message, status: 'delivered' };
    becameDelivered = true;
  }

  const payload = { event: 'message.new', data: message };
  hub.sendToUser(otherUserId, payload);
  hub.sendToUser(senderId, payload);

  if (becameDelivered) {
    emitMessageStatusUpdates(
      [
        {
          id: message.id,
          conversation_id: message.conversation_id,
          sender_id: senderId,
        },
      ],
      'delivered',
    );
  }

  return message;
}

export function createJsonMessage(db, userId, conversationId, body) {
  const input = body || {};
  const { otherUserId } = requireParticipant(db, conversationId, userId);

  const type = String(input.type || 'text').toLowerCase();
  if (!MESSAGE_TYPES.has(type)) throw badRequest('Invalid message type');
  if (!['text', 'sticker'].includes(type)) {
    throw badRequest('Use multipart upload for image, audio or file messages');
  }

  const clientId = validateClientId(input.client_id);
  const existing = findExistingByClientId(db, conversationId, userId, clientId);
  if (existing) return messageObjectFromRow(getMessageRow(db, existing.id));

  let text = null;
  let stickerPack = null;
  let stickerId = null;

  if (type === 'text') {
    text = validateText(input.text, config.maxMessageText);
  } else {
    const stickerValue = isPlainObject(input.sticker)
      ? input.sticker
      : { pack: input.pack ?? input.sticker_pack, id: input.id ?? input.sticker_id };
    const sticker = validateSticker(stickerValue);
    stickerPack = sticker.pack;
    stickerId = sticker.id;
  }

  const row = insertMessageRow(db, {
    conversationId,
    senderId: userId,
    clientId,
    type,
    text,
    fileId: null,
    stickerPack,
    stickerId,
  });

  return emitNewMessage(db, row, userId, otherUserId);
}

export async function createAttachmentMessage(db, userId, conversationId, {
  type,
  clientId,
  text,
  file,
  durationMs,
}) {
  const { otherUserId } = requireParticipant(db, conversationId, userId);

  const normalizedType = String(type || '').toLowerCase();
  if (!['image', 'audio', 'file'].includes(normalizedType)) {
    throw badRequest('type must be image, audio or file for multipart messages');
  }
  if (!file || !file.buffer || !file.buffer.length) throw badRequest('A file is required');

  const normalizedClientId = validateClientId(clientId);
  const existing = findExistingByClientId(db, conversationId, userId, normalizedClientId);
  if (existing) return messageObjectFromRow(getMessageRow(db, existing.id));

  const caption = optionalCaption(text);

  let limit;
  let info;
  if (normalizedType === 'image') {
    limit = config.maxImageBytes;
    if (file.buffer.length > limit) throw payloadTooLarge('Image exceeds the size limit');
    info = await inspectImage(file.buffer, file.filename, file.mimetype);
  } else if (normalizedType === 'audio') {
    limit = config.maxAudioBytes;
    if (file.buffer.length > limit) throw payloadTooLarge('Audio exceeds the size limit');
    info = await inspectAudio(file.buffer, file.filename, file.mimetype);
  } else {
    limit = config.maxFileBytes;
    if (file.buffer.length > limit) throw payloadTooLarge('File exceeds the size limit');
    info = await inspectAnyFile(file.buffer, file.filename, file.mimetype);
  }

  const parsedDuration =
    normalizedType === 'audio'
      ? parseOptionalInt(durationMs, 'duration_ms', { min: 0, max: 24 * 60 * 60 * 1000 }) || 0
      : null;

  const fileRow = await saveBufferAsFile(db, {
    ownerId: userId,
    kind: 'message',
    buffer: file.buffer,
    originalName: sanitizeFilename(file.filename),
    mime: info.mime,
    extension: info.ext,
    width: info.width,
    height: info.height,
    durationMs: parsedDuration,
  });

  let row;
  try {
    row = insertMessageRow(db, {
      conversationId,
      senderId: userId,
      clientId: normalizedClientId,
      type: normalizedType,
      text: caption,
      fileId: fileRow.id,
      stickerPack: null,
      stickerId: null,
    });
  } catch (error) {
    await deleteFileRecordAndBlob(db, fileRow);
    throw error;
  }

  return emitNewMessage(db, row, userId, otherUserId);
}

export function getMessages(db, userId, conversationId, { before, limit } = {}) {
  requireParticipant(db, conversationId, userId);
  markDeliveredForConversation(db, conversationId, userId);

  const parsedBefore = before === undefined || before === null || before === '' ? null : Number(before);
  if (parsedBefore !== null && (!Number.isInteger(parsedBefore) || parsedBefore <= 0)) {
    throw badRequest('before must be a positive message id');
  }

  let parsedLimit = limit === undefined || limit === null || limit === '' ? 50 : Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    throw badRequest('limit must be a positive integer');
  }
  parsedLimit = Math.min(parsedLimit, 100);

  const rows = parsedBefore
    ? db
        .prepare(
          `${MESSAGE_SELECT}
           WHERE m.conversation_id = ? AND m.id < ?
           ORDER BY m.id DESC LIMIT ?`,
        )
        .all(conversationId, parsedBefore, parsedLimit + 1)
    : db
        .prepare(
          `${MESSAGE_SELECT}
           WHERE m.conversation_id = ?
           ORDER BY m.id DESC LIMIT ?`,
        )
        .all(conversationId, parsedLimit + 1);

  const hasMore = rows.length > parsedLimit;
  const pageRows = hasMore ? rows.slice(0, parsedLimit) : rows;
  pageRows.reverse();
  const messages = pageRows.map(messageObjectFromRow);

  return { messages, has_more: hasMore };
}

export function markConversationRead(db, userId, conversationId) {
  requireParticipant(db, conversationId, userId);

  const latestId = getLastMessageId(db, conversationId);
  const readRow = db
    .prepare(
      'SELECT last_read_message_id FROM conversation_reads WHERE conversation_id = ? AND user_id = ?',
    )
    .get(conversationId, userId);
  const previousRead = readRow?.last_read_message_id || 0;

  const pending = db
    .prepare(
      `SELECT id, conversation_id, sender_id FROM messages
       WHERE conversation_id = ? AND sender_id != ? AND status != 'read' AND id > ?`,
    )
    .all(conversationId, userId, previousRead);

  const timestamp = nowIso();
  const updateMessage = db.prepare("UPDATE messages SET status = 'read' WHERE id = ?");
  const updateRead = db.prepare(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id)
     DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at`,
  );

  const tx = db.transaction(() => {
    for (const item of pending) updateMessage.run(item.id);
    updateRead.run(conversationId, userId, Math.max(previousRead, latestId), timestamp);
  });
  tx();

  emitMessageStatusUpdates(pending, 'read');

  return { ok: true };
}
