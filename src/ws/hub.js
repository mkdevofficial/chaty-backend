import { WebSocket } from 'ws';
import { nowIso } from '../utils/time.js';

class RealtimeHub {
  constructor() {
    this.db = null;
    this.sockets = new Map();
  }

  init(db) {
    this.db = db;
  }

  isOnline(userId) {
    const set = this.sockets.get(userId);
    return Boolean(set && set.size > 0);
  }

  add(userId, socket) {
    let set = this.sockets.get(userId);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socket);

    if (wasOffline && this.db) {
      this.db.prepare('UPDATE users SET online = 1 WHERE id = ?').run(userId);
      this.broadcastPresence(userId, true);
    }
  }

  remove(userId, socket) {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.sockets.delete(userId);
      if (this.db) {
        const lastSeen = nowIso();
        this.db.prepare('UPDATE users SET online = 0, last_seen = ? WHERE id = ?').run(lastSeen, userId);
        this.broadcastPresence(userId, false, lastSeen);
      }
    }
  }

  sendToUser(userId, payload) {
    const set = this.sockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }

  sendToUsers(userIds, payload) {
    for (const userId of userIds) this.sendToUser(userId, payload);
  }

  broadcastAll(payload, { excludeUserId = null } = {}) {
    const data = JSON.stringify(payload);
    for (const [userId, set] of this.sockets.entries()) {
      if (userId === excludeUserId) continue;
      for (const socket of set) {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      }
    }
  }

  presenceAudience(userId) {
    if (!this.db) return [userId];
    const rows = this.db
      .prepare(
        `SELECT follower_id AS id FROM follows WHERE following_id = ?
         UNION
         SELECT following_id AS id FROM follows WHERE follower_id = ?
         UNION
         SELECT CASE WHEN user1_id = ? THEN user2_id ELSE user1_id END
           FROM conversations WHERE user1_id = ? OR user2_id = ?
         UNION
         SELECT ? AS id`,
      )
      .all(userId, userId, userId, userId, userId, userId);
    return rows.map((row) => row.id);
  }

  followerIds(userId) {
    if (!this.db) return [];
    return this.db
      .prepare('SELECT follower_id AS id FROM follows WHERE following_id = ?')
      .all(userId)
      .map((row) => row.id);
  }

  broadcastPresence(userId, online, lastSeen) {
    if (!this.db) return;
    const row = lastSeen
      ? { last_seen: lastSeen }
      : this.db.prepare('SELECT last_seen FROM users WHERE id = ?').get(userId);
    const payload = {
      event: 'presence',
      data: {
        user_id: userId,
        online,
        last_seen: row?.last_seen ?? null,
      },
    };
    this.sendToUsers(this.presenceAudience(userId), payload);
  }

  sendPresenceSnapshot(userId, socket) {
    if (!this.db || socket.readyState !== WebSocket.OPEN) return;
    const audience = new Set(this.presenceAudience(userId));
    const rows = this.db
      .prepare('SELECT id, last_seen FROM users WHERE online = 1')
      .all();
    for (const row of rows) {
      if (row.id === userId || !audience.has(row.id)) continue;
      socket.send(
        JSON.stringify({
          event: 'presence',
          data: { user_id: row.id, online: true, last_seen: row.last_seen ?? null },
        }),
      );
    }
  }

  closeToken(userId, tokenHash) {
    const set = this.sockets.get(userId);
    if (!set) return;
    for (const socket of [...set]) {
      if (socket.authTokenHash === tokenHash) {
        try {
          socket.close(4001, 'Logged out');
        } catch {
          socket.terminate();
        }
      }
    }
  }

  closeAll() {
    for (const set of this.sockets.values()) {
      for (const socket of set) {
        try {
          socket.close(1001, 'Server shutting down');
        } catch {
          socket.terminate();
        }
      }
    }
    this.sockets.clear();
  }
}

export const hub = new RealtimeHub();
