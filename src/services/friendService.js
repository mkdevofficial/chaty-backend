import { badRequest, notFound } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';
import { getUserObject, getUserObjectOrThrow } from './userService.js';

export function followUser(db, followerId, targetId) {
  if (followerId === targetId) throw badRequest('You cannot follow yourself');
  const target = getUserObjectOrThrow(db, targetId, followerId);

  db.prepare(
    'INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
  ).run(followerId, targetId, nowIso());

  return getUserObject(db, targetId, followerId);
}

export function unfollowUser(db, followerId, targetId) {
  if (followerId === targetId) throw badRequest('You cannot unfollow yourself');
  const target = getUserObject(db, targetId, followerId);
  if (!target) throw notFound('User not found');

  db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(
    followerId,
    targetId,
  );

  return getUserObject(db, targetId, followerId);
}

export function listFollowing(db, userId) {
  const rows = db
    .prepare('SELECT following_id FROM follows WHERE follower_id = ? ORDER BY created_at DESC')
    .all(userId);
  return rows.map((row) => getUserObject(db, row.following_id, userId));
}

export function listFollowers(db, userId) {
  const rows = db
    .prepare('SELECT follower_id FROM follows WHERE following_id = ? ORDER BY created_at DESC')
    .all(userId);
  return rows.map((row) => getUserObject(db, row.follower_id, userId));
}
