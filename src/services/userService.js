import { badRequest, notFound } from '../utils/errors.js';
import { escapeLike, PHONE_RE } from '../utils/validate.js';
import { userObjectFromRow } from '../serializers.js';

const USER_SELECT = `
  SELECT u.*,
    EXISTS (
      SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id
    ) AS is_following,
    EXISTS (
      SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.following_id = ?
    ) AS is_follower
  FROM users u
`;

export function getUserRow(db, userId, viewerId) {
  return db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(viewerId, viewerId, userId);
}

export function getUserObject(db, userId, viewerId) {
  return userObjectFromRow(getUserRow(db, userId, viewerId));
}

export function getUserObjectOrThrow(db, userId, viewerId) {
  const user = getUserObject(db, userId, viewerId);
  if (!user) throw notFound('User not found');
  return user;
}

export function searchUsers(db, viewerId, rawQuery) {
  if (typeof rawQuery !== 'string') throw badRequest('q is required');
  const query = rawQuery.trim();
  if (!query) throw badRequest('q is required');
  if (query.length > 64) throw badRequest('q is too long');

  const isUsernameQuery = query.startsWith('@');
  const usernameTerm = isUsernameQuery ? query.slice(1) : query;

  let rows;
  if (!isUsernameQuery && PHONE_RE.test(query)) {
    rows = db
      .prepare(`${USER_SELECT} WHERE u.id != ? AND u.phone = ? ORDER BY u.username ASC LIMIT 30`)
      .all(viewerId, viewerId, viewerId, query);
  } else {
    if (!usernameTerm) throw badRequest('q is required');
    const prefix = `${escapeLike(usernameTerm.toLowerCase())}%`;
    rows = db
      .prepare(
        `${USER_SELECT}
         WHERE u.id != ? AND u.username LIKE ? ESCAPE '\\'
         ORDER BY u.username ASC LIMIT 30`,
      )
      .all(viewerId, viewerId, viewerId, prefix);
  }

  return rows.map(userObjectFromRow);
}
