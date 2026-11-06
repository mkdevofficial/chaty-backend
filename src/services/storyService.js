import { config } from '../config.js';
import { forbidden, notFound, payloadTooLarge, badRequest } from '../utils/errors.js';
import { addHoursIso, nowIso } from '../utils/time.js';
import {
  optionalString,
  requireString,
  validateBgColor,
} from '../utils/validate.js';
import { inspectImage, sanitizeFilename } from '../utils/media.js';
import { storyObjectFromRow } from '../serializers.js';
import { hub } from '../ws/hub.js';
import { deleteFileById, saveBufferAsFile } from './fileService.js';
import { getUserObject } from './userService.js';

const STORY_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id) AS viewer_count,
    EXISTS (
      SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = ?
    ) AS seen
  FROM stories s
`;

function getStoryRow(db, storyId, viewerId) {
  return db.prepare(`${STORY_SELECT} WHERE s.id = ?`).get(viewerId, storyId);
}

function serializeForOwner(row) {
  return storyObjectFromRow({ ...row, seen: true }, { includeViewCount: true });
}

function emitNewStory(db, ownerId) {
  const followerIds = hub.followerIds(ownerId);
  if (!followerIds.length) return;
  hub.sendToUsers(followerIds, {
    event: 'story.new',
    data: getUserObject(db, ownerId, ownerId),
  });
}

export async function createImageStory(db, userId, { file, caption }) {
  if (!file || !file.buffer || !file.buffer.length) throw badRequest('An image file is required');
  if (file.buffer.length > config.maxStoryBytes) {
    throw payloadTooLarge('Story image exceeds the size limit');
  }

  const captionText = caption === undefined || caption === null || caption === ''
    ? null
    : optionalString(caption, 'caption', { max: 500 });

  const info = await inspectImage(file.buffer, file.filename, file.mimetype);
  const createdAt = nowIso();
  const expiresAt = addHoursIso(config.storyTtlHours);

  const fileRow = await saveBufferAsFile(db, {
    ownerId: userId,
    kind: 'story',
    buffer: file.buffer,
    originalName: sanitizeFilename(file.filename),
    mime: info.mime,
    extension: info.ext,
    width: info.width,
    height: info.height,
  });

  let storyId;
  try {
    const result = db
      .prepare(
        `INSERT INTO stories
           (user_id, type, file_id, caption, text, bg_color, created_at, expires_at)
         VALUES (?, 'image', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(userId, fileRow.id, captionText, createdAt, expiresAt);
    storyId = Number(result.lastInsertRowid);
  } catch (error) {
    await deleteFileById(db, fileRow.id);
    throw error;
  }

  const story = serializeForOwner(getStoryRow(db, storyId, userId));
  emitNewStory(db, userId);
  return story;
}

export function createTextStory(db, userId, body) {
  const input = body || {};
  const text = requireString(input.text, 'text', { min: 1, max: config.maxStoryText });
  const bgColor = validateBgColor(input.bg_color);
  const createdAt = nowIso();
  const expiresAt = addHoursIso(config.storyTtlHours);

  const result = db
    .prepare(
      `INSERT INTO stories
         (user_id, type, file_id, caption, text, bg_color, created_at, expires_at)
       VALUES (?, 'text', NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(userId, text, bgColor, createdAt, expiresAt);

  const storyId = Number(result.lastInsertRowid);
  const story = serializeForOwner(getStoryRow(db, storyId, userId));
  emitNewStory(db, userId);
  return story;
}

export function listStories(db, viewerId) {
  const rows = db
    .prepare(
      `${STORY_SELECT}
       WHERE s.expires_at > ?
         AND (
           s.user_id = ?
           OR s.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
         )
       ORDER BY s.created_at ASC, s.id ASC`,
    )
    .all(viewerId, nowIso(), viewerId, viewerId);

  const ownStories = rows
    .filter((row) => row.user_id === viewerId)
    .map((row) => storyObjectFromRow({ ...row, seen: true }, { includeViewCount: true }));

  const otherGroups = new Map();
  for (const row of rows) {
    if (row.user_id === viewerId) continue;
    let group = otherGroups.get(row.user_id);
    if (!group) {
      group = {
        user: getUserObject(db, row.user_id, viewerId),
        stories: [],
        latestAt: row.created_at,
      };
      otherGroups.set(row.user_id, group);
    }
    group.latestAt = row.created_at;
    group.stories.push(storyObjectFromRow(row));
  }

  const followedGroups = [...otherGroups.values()]
    .sort((a, b) => {
      const aUnseen = a.stories.some((story) => !story.seen) ? 1 : 0;
      const bUnseen = b.stories.some((story) => !story.seen) ? 1 : 0;
      if (aUnseen !== bUnseen) return bUnseen - aUnseen;
      return a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0;
    })
    .map(({ user, stories }) => ({
      user,
      has_unseen: stories.some((story) => !story.seen),
      stories,
    }));

  return [
    {
      user: getUserObject(db, viewerId, viewerId),
      has_unseen: false,
      stories: ownStories,
    },
    ...followedGroups,
  ];
}

function getAccessibleStory(db, storyId, viewerId) {
  const row = getStoryRow(db, storyId, viewerId);
  if (!row || row.expires_at <= nowIso()) throw notFound('Story not found or expired');
  if (row.user_id === viewerId) return row;
  const follows = db
    .prepare('SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ?')
    .get(viewerId, row.user_id);
  if (!follows) throw forbidden('You are not allowed to view this story');
  return row;
}

export function viewStory(db, storyId, viewerId) {
  const row = getAccessibleStory(db, storyId, viewerId);
  db.prepare(
    'INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?)',
  ).run(row.id, viewerId, nowIso());
  return { ok: true };
}

export function listStoryViewers(db, storyId, viewerId) {
  const row = getStoryRow(db, storyId, viewerId);
  if (!row) throw notFound('Story not found');
  if (row.user_id !== viewerId) throw forbidden('Only the story owner can list viewers');

  const viewers = db
    .prepare('SELECT * FROM story_views WHERE story_id = ? ORDER BY viewed_at DESC')
    .all(storyId);

  return viewers.map((view) => {
    const user = getUserObject(db, view.viewer_id, viewerId);
    return {
      user,
      viewer: user,
      viewed_at: view.viewed_at,
    };
  });
}

export async function deleteStory(db, storyId, userId) {
  const row = getStoryRow(db, storyId, userId);
  if (!row) throw notFound('Story not found');
  if (row.user_id !== userId) throw forbidden('Only the story owner can delete it');

  db.prepare('DELETE FROM stories WHERE id = ?').run(storyId);
  if (row.file_id) await deleteFileById(db, row.file_id);
  return { ok: true };
}

export async function cleanupExpiredStories(db) {
  const rows = db
    .prepare('SELECT id, file_id FROM stories WHERE expires_at <= ?')
    .all(nowIso());
  if (!rows.length) return 0;

  const deleteRow = db.prepare('DELETE FROM stories WHERE id = ?');
  const tx = db.transaction((items) => {
    for (const item of items) deleteRow.run(item.id);
  });
  tx(rows);

  for (const row of rows) {
    if (row.file_id) {
      try {
        await deleteFileById(db, row.file_id);
      } catch {
        // The database row is already gone; an orphaned blob is harmless.
      }
    }
  }
  return rows.length;
}
