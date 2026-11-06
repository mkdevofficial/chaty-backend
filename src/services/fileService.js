import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { nowIso } from '../utils/time.js';

export async function saveBufferAsFile(db, {
  ownerId,
  kind,
  buffer,
  originalName,
  mime,
  extension = null,
  width = null,
  height = null,
  durationMs = null,
}) {
  const safeExtension = String(
    extension || (mime && mime.includes('/') ? mime.split('/')[1] : 'bin') || 'bin',
  ).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const storedName = `${crypto.randomUUID()}.${safeExtension || 'bin'}`;
  const filePath = path.join(config.uploadDir, storedName);
  await fs.writeFile(filePath, buffer, { flag: 'wx' });

  let result;
  try {
    result = db
      .prepare(
        `INSERT INTO files
           (owner_id, kind, stored_name, original_name, mime, size, width, height, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ownerId,
        kind,
        storedName,
        originalName || null,
        mime,
        buffer.length,
        width,
        height,
        durationMs,
        nowIso(),
      );
  } catch (error) {
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore cleanup failure; the original error is more useful.
    }
    throw error;
  }

  return db.prepare('SELECT * FROM files WHERE id = ?').get(Number(result.lastInsertRowid));
}

export function getFileRow(db, fileId) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
}

export function filePath(fileRow) {
  return path.join(config.uploadDir, fileRow.stored_name);
}

export function canAccessFile(db, fileRow, userId) {
  if (!fileRow) return false;
  if (fileRow.owner_id === userId) return true;
  if (fileRow.kind === 'avatar') return true;

  if (fileRow.kind === 'message') {
    const row = db
      .prepare(
        `SELECT 1 AS ok
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.file_id = ? AND (c.user1_id = ? OR c.user2_id = ?)
         LIMIT 1`,
      )
      .get(fileRow.id, userId, userId);
    return Boolean(row);
  }

  if (fileRow.kind === 'story') {
    const row = db
      .prepare(
        `SELECT 1 AS ok
         FROM stories s
         WHERE s.file_id = ?
           AND s.expires_at > ?
           AND (
             s.user_id = ?
             OR EXISTS (
               SELECT 1 FROM follows f
               WHERE f.follower_id = ? AND f.following_id = s.user_id
             )
           )
         LIMIT 1`,
      )
      .get(fileRow.id, nowIso(), userId, userId);
    return Boolean(row);
  }

  return false;
}

export async function deleteFileRecordAndBlob(db, fileRow) {
  if (!fileRow) return;
  try {
    await fs.unlink(filePath(fileRow));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  db.prepare('DELETE FROM files WHERE id = ?').run(fileRow.id);
}

export async function deleteFileById(db, fileId) {
  const fileRow = getFileRow(db, fileId);
  if (!fileRow) return;
  await deleteFileRecordAndBlob(db, fileRow);
}
