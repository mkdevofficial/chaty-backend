import { parseId } from '../utils/validate.js';
import {
  followUser,
  listFollowers,
  listFollowing,
  unfollowUser,
} from '../services/friendService.js';

export function registerFriendRoutes(app, { db, auth }) {
  app.get('/api/friends/following', { preHandler: auth }, async (request) => ({
    following: listFollowing(db, request.user.id),
  }));

  app.get('/api/friends/followers', { preHandler: auth }, async (request) => ({
    followers: listFollowers(db, request.user.id),
  }));

  app.post('/api/friends/:userId', { preHandler: auth }, async (request) => {
    const targetId = parseId(request.params.userId, 'user id');
    return followUser(db, request.user.id, targetId);
  });

  app.delete('/api/friends/:userId', { preHandler: auth }, async (request) => {
    const targetId = parseId(request.params.userId, 'user id');
    return unfollowUser(db, request.user.id, targetId);
  });
}
