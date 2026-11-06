export const MESSAGE_SELECT = `
  SELECT m.*,
    f.id AS attachment_file_id,
    f.original_name AS attachment_name,
    f.size AS attachment_size,
    f.mime AS attachment_mime,
    f.duration_ms AS attachment_duration_ms,
    f.width AS attachment_width,
    f.height AS attachment_height
  FROM messages m
  LEFT JOIN files f ON f.id = m.file_id
`;

export function getMessageRow(db, messageId) {
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(messageId);
}

export function getLastMessageRow(db, conversationId) {
  return db
    .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`)
    .get(conversationId);
}

export function getLastMessageId(db, conversationId) {
  const row = db
    .prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?')
    .get(conversationId);
  return row?.id || 0;
}

export function getUnreadCount(db, conversationId, viewerId) {
  const read = db
    .prepare(
      'SELECT last_read_message_id FROM conversation_reads WHERE conversation_id = ? AND user_id = ?',
    )
    .get(conversationId, viewerId);
  const lastRead = read?.last_read_message_id || 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE conversation_id = ? AND sender_id != ? AND id > ?`,
    )
    .get(conversationId, viewerId, lastRead);
  return row?.count || 0;
}
