import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { unauthorized, conflict, badRequest } from '../utils/errors.js';
import { addDaysIso, isPast, nowIso } from '../utils/time.js';
import {
  validatePhone,
  validateUsername,
  validatePassword,
  validateDisplayName,
  validateBio,
} from '../utils/validate.js';
import { getUserObject } from './userService.js';

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(userId, tokenHash, nowIso(), addDaysIso(config.sessionTtlDays));
  return token;
}

export function registerUser(db, input) {
  const body = input || {};
  const phone = validatePhone(body.phone);
  const username = validateUsername(body.username);
  const displayName = validateDisplayName(body.display_name);
  const password = validatePassword(body.password);
  const bio = validateBio(body.bio);

  const existing = db
    .prepare('SELECT phone, username FROM users WHERE phone = ? OR username = ? LIMIT 1')
    .get(phone, username);
  if (existing) {
    if (existing.phone === phone) throw conflict('Phone number is already registered', 'PHONE_TAKEN');
    throw conflict('Username is already taken', 'USERNAME_TAKEN');
  }

  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  let userId;
  try {
    const result = db
      .prepare(
        `INSERT INTO users (phone, username, display_name, bio, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(phone, username, displayName, bio, passwordHash, nowIso());
    userId = Number(result.lastInsertRowid);
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw conflict('Phone number or username is already registered', 'ALREADY_EXISTS');
    }
    throw error;
  }

  const token = createSession(db, userId);
  return { token, user: getUserObject(db, userId, userId) };
}

export function loginUser(db, input) {
  const body = input || {};
  const phone = validatePhone(body.phone);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) throw badRequest('password is required');

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw unauthorized('Invalid phone number or password');
  }

  const token = createSession(db, user.id);
  return { token, user: getUserObject(db, user.id, user.id) };
}

export async function verifyGoogleToken({ idToken, accessToken }) {
  if (idToken) {
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      );
      if (res.ok) {
        const payload = await res.json();
        return {
          googleId: payload.sub,
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
        };
      }
    } catch {
      // Offline fallback
    }
  }
  if (accessToken) {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const payload = await res.json();
        return {
          googleId: payload.sub,
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
        };
      }
    } catch {
      // Offline fallback
    }
  }
  return null;
}

export async function loginOrRegisterGoogleUser(db, input) {
  const body = input || {};
  let googleId = body.google_id;
  let email = body.email;
  let displayName = body.display_name;
  let photoUrl = body.photo_url;

  if (body.id_token || body.access_token) {
    const verified = await verifyGoogleToken({
      idToken: body.id_token,
      accessToken: body.access_token,
    });
    if (verified) {
      googleId = verified.googleId || googleId;
      email = verified.email || email;
      displayName = verified.name || displayName;
      photoUrl = verified.picture || photoUrl;
    }
  }

  if (!googleId && !email) {
    throw badRequest(
      'Either a valid Google token, google_id, or email is required',
      'MISSING_GOOGLE_CREDENTIALS',
    );
  }

  // 1. Check if user already exists by google_id
  let user = null;
  if (googleId) {
    user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  }

  // 2. Check if user exists by email
  if (!user && email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user && googleId && !user.google_id) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
      user.google_id = googleId;
    }
  }

  // 3. Register user if not found
  if (!user) {
    let baseUsername = 'user';
    if (email) {
      baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_');
    } else if (displayName) {
      baseUsername = displayName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    }
    if (baseUsername.length < 3) baseUsername = `user_${baseUsername}`;
    if (baseUsername.length > 20) baseUsername = baseUsername.slice(0, 20);

    let username = baseUsername;
    let suffix = 1;
    while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      const rand = Math.floor(100 + Math.random() * 900);
      username = `${baseUsername.slice(0, 16)}_${rand}`;
      suffix++;
      if (suffix > 25) break;
    }

    const finalDisplayName = (displayName && displayName.trim()) || username;
    const finalPhone = `+google_${googleId || crypto.randomUUID().slice(0, 12)}`;
    const passwordHash = bcrypt.hashSync(crypto.randomUUID(), config.bcryptRounds);
    const now = nowIso();

    const result = db
      .prepare(
        `INSERT INTO users (phone, username, display_name, bio, password_hash, google_id, email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        finalPhone,
        username,
        finalDisplayName,
        'Joined via Google',
        passwordHash,
        googleId || null,
        email || null,
        now,
      );

    const userId = Number(result.lastInsertRowid);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  }

  const token = createSession(db, user.id);
  return { token, user: getUserObject(db, user.id, user.id) };
}

export function authenticateToken(db, token) {
  if (!token || typeof token !== 'string') throw unauthorized('Missing token');
  const tokenHash = hashToken(token);
  const session = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(tokenHash);
  if (!session) throw unauthorized('Invalid or revoked token');
  if (isPast(session.expires_at)) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    throw unauthorized('Session has expired');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    throw unauthorized('Invalid session');
  }
  return user;
}

export function logoutToken(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function tokenFromHeader(header) {
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function createAuthHook(db) {
  return async function authHook(request) {
    const token = tokenFromHeader(request.headers.authorization);
    if (!token) throw unauthorized('Authentication required');
    const user = authenticateToken(db, token);
    request.user = user;
    request.authToken = token;
    request.tokenHash = hashToken(token);
  };
}
