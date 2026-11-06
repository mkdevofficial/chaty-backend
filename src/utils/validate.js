import { badRequest } from './errors.js';

export const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const BG_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value) {
  if (!isPlainObject(value)) throw badRequest('A JSON object body is required');
  return value;
}

export function requireString(value, field, { min = 1, max = 1000, trim = true } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} is required`);
  const result = trim ? value.trim() : value;
  if (result.length < min) throw badRequest(`${field} must be at least ${min} characters`);
  if (result.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return result;
}

export function optionalString(value, field, { max = 1000, trim = true } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const result = trim ? value.trim() : value;
  if (result.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return result;
}

export function validatePhone(value) {
  if (typeof value !== 'string') throw badRequest('phone is required');
  const phone = value.trim();
  if (!PHONE_RE.test(phone)) {
    throw badRequest('phone must be 7-15 digits with an optional leading +', 'INVALID_PHONE');
  }
  return phone;
}

export function validateUsername(value) {
  if (typeof value !== 'string') throw badRequest('username is required');
  const username = value.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw badRequest(
      'username must be 3-20 characters of lowercase letters, digits or underscore',
      'INVALID_USERNAME',
    );
  }
  return username;
}

export function validatePassword(value) {
  if (typeof value !== 'string') throw badRequest('password is required');
  if (value.length < 8) throw badRequest('password must be at least 8 characters', 'INVALID_PASSWORD');
  if (value.length > 128) throw badRequest('password must be at most 128 characters', 'INVALID_PASSWORD');
  return value;
}

export function validateDisplayName(value) {
  return requireString(value, 'display_name', { min: 1, max: 50 });
}

export function validateBio(value) {
  const bio = optionalString(value, 'bio', { max: 300 });
  return bio === undefined ? '' : bio;
}

export function parseId(value, field = 'id') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) throw badRequest(`${field} must be a positive integer`);
  return num;
}

export function parseOptionalInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return num;
}

export function validateClientId(value) {
  const id = optionalString(value, 'client_id', { max: 128 });
  return id === undefined || id === '' ? null : id;
}

export function validateBgColor(value) {
  if (value === undefined || value === null || value === '') return '#1E88E5';
  if (typeof value !== 'string' || !BG_COLOR_RE.test(value)) {
    throw badRequest('bg_color must be a hex color like #1E88E5');
  }
  return value;
}

export function validateSticker(value) {
  const sticker = isPlainObject(value) ? value : {};
  const pack = requireString(sticker.pack, 'sticker.pack', { min: 1, max: 100 });
  const id = requireString(sticker.id, 'sticker.id', { min: 1, max: 100 });
  return { pack, id };
}

export function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
