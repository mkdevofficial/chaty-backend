import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function envString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

const dataDir = resolveFromRoot(envString('DATA_DIR', 'data'));
const uploadDir = resolveFromRoot(envString('UPLOAD_DIR', 'uploads'));
const dbPath = resolveFromRoot(envString('DB_PATH', path.join(dataDir, 'chaty.db')));

const mb = (value) => value * 1024 * 1024;

export const config = {
  rootDir,
  port: envInt('PORT', 5050),
  host: envString('HOST', '0.0.0.0'),
  publicBaseUrl: envString('PUBLIC_BASE_URL', 'http://185.196.20.220:5050'),

  dataDir,
  uploadDir,
  dbPath,

  sessionTtlDays: envInt('SESSION_TTL_DAYS', 30),
  bcryptRounds: envInt('BCRYPT_ROUNDS', 12),

  maxImageBytes: mb(envFloat('MAX_IMAGE_MB', 10)),
  maxAudioBytes: mb(envFloat('MAX_AUDIO_MB', 10)),
  maxFileBytes: mb(envFloat('MAX_FILE_MB', 25)),
  maxAvatarBytes: mb(envFloat('MAX_AVATAR_MB', 10)),
  maxStoryBytes: mb(envFloat('MAX_STORY_MB', 10)),

  maxMessageText: envInt('MAX_MESSAGE_TEXT', 5000),
  maxStoryText: envInt('MAX_STORY_TEXT', 500),
  storyTtlHours: envInt('STORY_TTL_HOURS', 24),
  cleanupIntervalMinutes: envFloat('CLEANUP_INTERVAL_MINUTES', 5),

  rateLimits: {
    login: {
      max: envInt('LOGIN_RATE_MAX', 20),
      windowMs: envInt('LOGIN_RATE_WINDOW_MINUTES', 15) * 60 * 1000,
    },
    register: {
      max: envInt('REGISTER_RATE_MAX', 10),
      windowMs: envInt('REGISTER_RATE_WINDOW_MINUTES', 60) * 60 * 1000,
    },
    search: {
      max: envInt('SEARCH_RATE_MAX', 60),
      windowMs: envInt('SEARCH_RATE_WINDOW_MINUTES', 1) * 60 * 1000,
    },
  },

  logLevel: envString('LOG_LEVEL', 'info'),
};

config.maxMultipartBytes = Math.max(
  config.maxImageBytes,
  config.maxAudioBytes,
  config.maxFileBytes,
  config.maxAvatarBytes,
  config.maxStoryBytes,
);

export function ensureDirectories() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}
