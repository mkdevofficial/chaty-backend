import { hub } from '../ws/hub.js';

export function emitMessageStatusUpdates(rows, status) {
  if (!rows.length) return;
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.conversation_id}:${row.sender_id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sender_id: row.sender_id,
        conversation_id: row.conversation_id,
        message_ids: [],
      };
      groups.set(key, group);
    }
    group.message_ids.push(row.id);
  }

  for (const group of groups.values()) {
    for (const messageId of group.message_ids) {
      hub.sendToUser(group.sender_id, {
        event: 'message.status',
        data: {
          conversation_id: group.conversation_id,
          message_ids: group.message_ids,
          message_id: messageId,
          status,
        },
      });
    }
  }
}

function markDeliveredRows(db, rows) {
  if (!rows.length) return;
  const update = db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?");
  const tx = db.transaction((items) => {
    for (const item of items) update.run(item.id);
  });
  tx(rows);
  emitMessageStatusUpdates(rows, 'delivered');
}

export function markDeliveredForUser(db, userId) {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, sender_id
       FROM messages
       WHERE status = 'sent'
         AND sender_id != ?
         AND conversation_id IN (
           SELECT id FROM conversations WHERE user1_id = ? OR user2_id = ?
         )`,
    )
    .all(userId, userId, userId);
  markDeliveredRows(db, rows);
  return rows.length;
}

export function markDeliveredForConversation(db, conversationId, userId) {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, sender_id
       FROM messages
       WHERE conversation_id = ? AND status = 'sent' AND sender_id != ?`,
    )
    .all(conversationId, userId);
  markDeliveredRows(db, rows);
  return rows.map((row) => row.id);
}
