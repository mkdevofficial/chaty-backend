import { createAuthHook } from '../services/authService.js';
import { registerAuthRoutes } from './auth.js';
import { registerUserRoutes } from './users.js';
import { registerFriendRoutes } from './friends.js';
import { registerConversationRoutes } from './conversations.js';
import { registerFileRoutes } from './files.js';
import { registerStoryRoutes } from './stories.js';
import { registerHealthRoutes } from './health.js';

export function registerRoutes(app, db) {
  const auth = createAuthHook(db);
  const ctx = { db, auth };

  registerHealthRoutes(app);
  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerFriendRoutes(app, ctx);
  registerConversationRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerStoryRoutes(app, ctx);
}
