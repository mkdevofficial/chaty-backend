import { ApiError, badRequest, payloadTooLarge } from './errors.js';

function isTooLargeError(error) {
  return (
    error &&
    (error.code === 'FST_REQ_FILE_TOO_LARGE' ||
      error.code === 'FST_FILES_LIMIT' ||
      error.name === 'RequestFileTooLargeError' ||
      /too large/i.test(error.message || ''))
  );
}

export async function parseMultipart(request, { maxFileBytes }) {
  const fields = {};
  const files = [];

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (maxFileBytes && buffer.length > maxFileBytes) {
          throw payloadTooLarge('Uploaded file is too large');
        }
        files.push({
          field: part.fieldname,
          buffer,
          filename: part.filename || 'upload',
          mimetype: part.mimetype || 'application/octet-stream',
        });
      } else if (part.type === 'field') {
        if (part.fieldname in fields) {
          const current = fields[part.fieldname];
          fields[part.fieldname] = Array.isArray(current) ? [...current, part.value] : [current, part.value];
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    }
  } catch (error) {
    if (isTooLargeError(error)) {
      request.log.warn(
        { err: error, method: request.method, url: request.url },
        'upload rejected: file exceeds the size limit',
      );
      throw payloadTooLarge('Uploaded file is too large');
    }
    if (error instanceof ApiError) {
      request.log.warn(
        { err: error, method: request.method, url: request.url, errorCode: error.code },
        'upload rejected',
      );
      throw error;
    }
    request.log.warn(
      { err: error, method: request.method, url: request.url },
      'upload rejected: invalid multipart request',
    );
    throw badRequest('Invalid multipart request');
  }

  return { fields, files };
}

export function firstFile(files) {
  return files.length ? files[0] : null;
}
