import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { notFound } from '../utils/errors.js';
import { parseId } from '../utils/validate.js';
import {
  canAccessFile,
  filePath,
  getFileRow,
} from '../services/fileService.js';

function contentDisposition(name) {
  const original = String(name || 'file');
  const safe = original
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\\r\n]/g, '_');
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(original)}`;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { invalid: true };
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return { invalid: true };

  let start;
  let end;

  if (startRaw === '') {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return { invalid: true };
    if (start >= size || end < start) return { invalid: true };
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

export function registerFileRoutes(app, { db, auth }) {
  app.get('/api/files/:fileId', { preHandler: auth }, async (request, reply) => {
    const fileId = parseId(request.params.fileId, 'file id');
    const fileRow = getFileRow(db, fileId);
    if (!fileRow) throw notFound('File not found');
    if (!canAccessFile(db, fileRow, request.user.id)) {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'You are not allowed to access this file' },
      });
    }

    const absolutePath = filePath(fileRow);
    let stat;
    try {
      stat = await fsPromises.stat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw notFound('File not found');
      throw error;
    }

    reply.header('Content-Type', fileRow.mime || 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('Content-Disposition', contentDisposition(fileRow.original_name));
    reply.header('X-Content-Type-Options', 'nosniff');

    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const range = parseRange(rangeHeader, stat.size);
      if (range.invalid) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${stat.size}`)
          .send({
            error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range is not satisfiable' },
          });
      }

      const length = range.end - range.start + 1;
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header('Content-Length', length);
      return reply.send(
        fs.createReadStream(absolutePath, { start: range.start, end: range.end }),
      );
    }

    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(absolutePath));
  });
}
