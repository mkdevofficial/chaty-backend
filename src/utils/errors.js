export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'VALIDATION_ERROR') =>
  new ApiError(400, code, message);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You are not allowed to do that') =>
  new ApiError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found') =>
  new ApiError(404, 'NOT_FOUND', message);

export const conflict = (message, code = 'CONFLICT') =>
  new ApiError(409, code, message);

export const payloadTooLarge = (message = 'Uploaded file is too large') =>
  new ApiError(413, 'PAYLOAD_TOO_LARGE', message);

export const unsupportedMedia = (message = 'Unsupported file type') =>
  new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', message);

export const tooManyRequests = (message = 'Too many requests, please try again later') =>
  new ApiError(429, 'RATE_LIMITED', message);
