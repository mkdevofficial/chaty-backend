import { config } from '../config.js';
import { parseId } from '../utils/validate.js';
import { rateLimitMiddleware } from '../utils/rateLimit.js';
import { searchUsers, getUserObjectOrThrow } from '../services/userService.js';

const searchRateLimit = rateLimitMiddleware('search', config.rateLimits.search);

export function registerUserRoutes(app, { db, auth }) {
  app.get(
    '/api/users/search',
    { preHandler: [auth, searchRateLimit] },
    async (request) => ({
      users: searchUsers(db, request.user.id, request.query.q),
    }),
  );

  app.get('/api/users/:id', { preHandler: auth }, async (request) => {
    const userId = parseId(request.params.id, 'user id');
    return getUserObjectOrThrow(db, userId, request.user.id);
  });
}
