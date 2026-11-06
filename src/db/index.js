import Database from 'better-sqlite3';
import { config } from '../config.js';
import { runMigrations } from './migrations.js';

export function initDb({ resetPresence = true } = {}) {
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  if (resetPresence) db.prepare('UPDATE users SET online = 0').run();
  return db;
}
