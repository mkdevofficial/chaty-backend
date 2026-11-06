import { forbidden, notFound } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';
import { getLastMessageRow, getUnreadCount } from './messageQueries.js';
import { messageObjectFromRow } from '../serializers.js';
import { getUserObject, getUserObjectOrThrow } from './userService.js';

export function getConversationRow(db, conversationId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

export function requireParticipant(db, conversationId, userId) {
  const conversation = getConversationRow(db, conversationId);
  if (!conversation) throw notFound('Conversation not found');
  const isParticipant =
    conversation.user1_id === userId || conversation.user2_id === userId;
  if (!isParticipant) throw forbidden('You are not a participant in this conversation');
  return {
    conversation,
    otherUserId:
      conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id,
  };
}

export function buildConversationObject(db, conversation, viewerId) {
  const otherUserId =
    conversation.user1_id === viewerId ? conversation.user2_id : conversation.user1_id;
  const lastMessageRow = getLastMessageRow(db, conversation.id);

  return {
    id: conversation.id,
    peer: getUserObject(db, otherUserId, viewerId),
    last_message: messageObjectFromRow(lastMessageRow),
    unread_count: getUnreadCount(db, conversation.id, viewerId),
    updated_at: conversation.updated_at,
  };
}

export function getOrCreateConversation(db, userId, otherUserId) {
  if (userId === otherUserId) throw notFound('You cannot start a conversation with yourself');
  getUserObjectOrThrow(db, otherUserId, userId);

  const user1 = Math.min(userId, otherUserId);
  const user2 = Math.max(userId, otherUserId);
  const timestamp = nowIso();

  db.prepare(
    `INSERT OR IGNORE INTO conversations (user1_id, user2_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(user1, user2, timestamp, timestamp);

  const conversation = db
    .prepare('SELECT * FROM conversations WHERE user1_id = ? AND user2_id = ?')
    .get(user1, user2);
  return buildConversationObject(db, conversation, userId);
}

export function listConversations(db, userId) {
  const rows = db
    .prepare(
      `SELECT * FROM conversations
       WHERE user1_id = ? OR user2_id = ?
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(userId, userId);
  return rows.map((row) => buildConversationObject(db, row, userId));
}

export function touchConversation(db, conversationId, timestamp = nowIso()) {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
    timestamp,
    conversationId,
  );
}

export function otherParticipantId(conversation, userId) {
  return conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id;
}

