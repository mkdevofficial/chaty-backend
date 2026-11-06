import { config } from '../config.js';
import { badRequest } from '../utils/errors.js';
import { parseId, requireObject } from '../utils/validate.js';
import { parseMultipart, firstFile } from '../utils/multipart.js';
import {
  createImageStory,
  createTextStory,
  deleteStory,
  listStories,
  listStoryViewers,
  viewStory,
} from '../services/storyService.js';

export function registerStoryRoutes(app, { db, auth }) {
  app.post('/api/stories', { preHandler: auth }, async (request, reply) => {
    if (request.isMultipart()) {
      const { fields, files } = await parseMultipart(request, {
        maxFileBytes: config.maxStoryBytes,
      });
      const file = firstFile(files);
      if (!file) throw badRequest('An image file is required for an image story');

      let caption = fields.caption;
      if (Array.isArray(caption)) caption = caption[0];

      const story = await createImageStory(db, request.user.id, { file, caption });
      return reply.code(201).send(story);
    }

    const body = requireObject(request.body);
    if (body.type && String(body.type).toLowerCase() !== 'text') {
      throw badRequest('JSON stories must be type text; use multipart for image stories');
    }
    const story = createTextStory(db, request.user.id, body);
    return reply.code(201).send(story);
  });

  app.get('/api/stories', { preHandler: auth }, async (request) => ({
    stories: listStories(db, request.user.id),
  }));

  app.post('/api/stories/:id/view', { preHandler: auth }, async (request) => {
    const storyId = parseId(request.params.id, 'story id');
    return viewStory(db, storyId, request.user.id);
  });

  app.get('/api/stories/:id/viewers', { preHandler: auth }, async (request) => {
    const storyId = parseId(request.params.id, 'story id');
    return { viewers: listStoryViewers(db, storyId, request.user.id) };
  });

  app.delete('/api/stories/:id', { preHandler: auth }, async (request) => {
    const storyId = parseId(request.params.id, 'story id');
    return deleteStory(db, storyId, request.user.id);
  });
}
