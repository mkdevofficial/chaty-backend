# chaty backend

Backend for the **chaty** mobile messaging app: Fastify HTTP API, WebSocket real-time events, SQLite storage, and disk-backed uploads.

- HTTP: `http://185.196.20.220:5050`
- WebSocket: `ws://185.196.20.220:5050/ws`
- Listen address: `0.0.0.0:5050`
- Health: `GET /api/health`

Stack: Node.js 20+ (ESM), Fastify, `ws`, SQLite via `better-sqlite3`, `bcryptjs`, `file-type`, `image-size`.

## Run

```bash
chmod +x start.sh install-service.sh
./start.sh
```

`start.sh` checks for Node.js 20+ (installing Node.js 20 from NodeSource when needed on Debian/Ubuntu), creates `data/` and `uploads/`, copies `.env.example` to `.env` when missing, installs dependencies, and starts the server on port 5050.

```bash
curl http://127.0.0.1:5050/api/health
```

Stop a foreground server with `Ctrl+C`.

## Test

```bash
npm test
```

`npm test` removes `.selftest/`, starts a fresh temporary server on port 5050, runs the complete end-to-end suite, prints the final report, and shuts the server down gracefully. It exercises:

- health, register, login, profile update, avatar upload
- empty `display_name` fallback and the database backfill migration
- phone and `@username` search
- follow/unfollow and following/followers lists
- conversation creation, full peer objects, unread counts
- text, sticker, image, m4a audio, and generic file messages
- `delivered` and `read` WebSocket status events for every message type
- authorized file downloads with exact `Content-Type`, `Content-Length`, bytes, and `Range`/`206` responses
- WebSocket presence online/offline, typing, and ping/pong
- story creation (image and text), follower listing, viewing, viewers, access revocation, and deletion
- cursor pagination and logout/token revocation

Run the suite against an already-running server:

```bash
npm run selftest
```

Set `SELFTEST_BASE_URL` to target a different address. The direct database checks run when `SELFTEST_DB_PATH` is also set.

## Deploy to the VPS

Copy the project without local runtime data or dependencies:

```bash
rsync -av \
  --exclude node_modules --exclude data --exclude uploads --exclude .env \
  ./ user@185.196.20.220:/opt/chaty/
```

Then on the VPS:

```bash
ssh user@185.196.20.220
cd /opt/chaty
chmod +x start.sh install-service.sh
./start.sh
```

Open TCP 5050 in the firewall and in the VPS provider's cloud firewall:

```bash
sudo ufw allow 5050/tcp
sudo ufw reload
```

Verify from outside:

```bash
curl http://185.196.20.220:5050/api/health
```

### Install as a systemd service

After stopping the foreground `./start.sh` process:

```bash
sudo ./install-service.sh
```

This creates `/etc/systemd/system/chaty.service`, enables it at boot, and starts it now. With `sudo` from your account, the service runs as `SUDO_USER`; as root it runs as root.

```bash
sudo systemctl status chaty
sudo journalctl -u chaty -f
sudo journalctl -u chaty --since today
```

### Update the VPS and restart

Copy the updated backend files, then reinstall dependencies only when `package.json` / `package-lock.json` changed:

```bash
rsync -av \
  --exclude node_modules --exclude data --exclude uploads --exclude .env \
  ./ user@185.196.20.220:/opt/chaty/

ssh user@185.196.20.220
cd /opt/chaty
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart chaty
sudo journalctl -u chaty -f
```

If you run the server in the foreground instead of systemd, stop it with `Ctrl+C`, then run `./start.sh` again.

Migrations run automatically at startup. Existing users, messages, conversations, stories, and uploads are preserved; no table is dropped or recreated.

### Seed demo users

```bash
npm run seed
```

| username | phone | password |
| --- | --- | --- |
| `alice` | `+15550000001` | `password123` |
| `bob` | `+15550000002` | `password123` |

The seed is idempotent and also ensures a mutual follow and a demo conversation.

## Configuration

Settings come from `.env` (created from `.env.example`).

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5050` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_BASE_URL` | `http://185.196.20.220:5050` | Public base URL |
| `DATA_DIR` | `data` | SQLite directory |
| `UPLOAD_DIR` | `uploads` | Uploaded blobs |
| `DB_PATH` | `data/chaty.db` | SQLite database path |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `MAX_IMAGE_MB` | `10` | Image message limit |
| `MAX_AUDIO_MB` | `10` | Audio message limit |
| `MAX_FILE_MB` | `25` | Generic file limit |
| `MAX_AVATAR_MB` | `10` | Avatar limit |
| `MAX_STORY_MB` | `10` | Story image limit |
| `MAX_MESSAGE_TEXT` | `5000` | Text message max length |
| `MAX_STORY_TEXT` | `500` | Text story max length |
| `STORY_TTL_HOURS` | `24` | Story lifetime |
| `CLEANUP_INTERVAL_MINUTES` | `5` | Expired story/session cleanup interval |
| `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_MINUTES` | `20` / `15` | Login limit per IP |
| `REGISTER_RATE_MAX` / `REGISTER_RATE_WINDOW_MINUTES` | `10` / `60` | Register limit per IP |
| `SEARCH_RATE_MAX` / `SEARCH_RATE_WINDOW_MINUTES` | `60` / `1` | Search limit per IP |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Every 4xx/5xx response is logged with method, path, status, error code, and message. Rejected multipart uploads log the rejection reason. Authorization headers are redacted.

## API conventions

- JSON UTF-8, integer ids, ISO 8601 UTC timestamps.
- All endpoints require `Authorization: Bearer <token>` except register, login, and health.
- Errors use the HTTP status and:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "phone is required" } }
```

Every list endpoint wraps its array in an object:

| Endpoint | Response wrapper |
| --- | --- |
| `GET /api/users/search` | `{ "users": [...] }` |
| `GET /api/friends/following` | `{ "following": [...] }` |
| `GET /api/friends/followers` | `{ "followers": [...] }` |
| `GET /api/conversations` | `{ "conversations": [...] }` |
| `GET /api/conversations/{id}/messages` | `{ "messages": [...], "has_more": bool }` |
| `GET /api/stories` | `{ "stories": [...] }` (StoryGroup list) |
| `GET /api/stories/{id}/viewers` | `{ "viewers": [...] }` |

### User

```json
{
  "id": 1,
  "username": "alice",
  "display_name": "Alice Demo",
  "bio": "Demo account Alice",
  "avatar_file_id": null,
  "is_following": false,
  "is_follower": false,
  "online": false,
  "last_seen": null
}
```

`display_name` is never empty. If legacy data contains an empty value, the startup migration fills it with the username and the serializer also falls back to the username.

### Auth and profile

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` | `{phone, username, display_name, password}` → 201 `{token, user}` |
| POST | `/api/auth/login` | `{phone, password}` → `{token, user}` |
| POST | `/api/auth/logout` | Revokes the bearer token and closes its WebSockets → `{ok:true}` |
| GET | `/api/me` | User |
| PATCH | `/api/me` | `{display_name?, bio?, username?}` → user |
| POST | `/api/me/avatar` | multipart part `file` → user |

Phone: optional `+` plus 7-15 digits. Username: 3-20 lowercase letters, digits, underscore. Password: 8-128 characters. Display name: 1-50. Bio: up to 300.

### Users and friends

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/users/search?q=` | `{users}`; excludes caller, max 30 |
| GET | `/api/users/{id}` | User |
| POST | `/api/friends/{userId}` | Idempotent follow → updated target user |
| DELETE | `/api/friends/{userId}` | Idempotent unfollow → updated target user |
| GET | `/api/friends/following` | `{following}` |
| GET | `/api/friends/followers` | `{followers}` |

Search treats a phone number as an exact phone match and `@name` as a username prefix. A non-phone query without `@` is also treated as a username prefix as a convenience.

### Conversations and messages

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/conversations` | `{conversations}`, newest `updated_at` first |
| POST | `/api/conversations` | `{user_id}` get-or-create → conversation |
| GET | `/api/conversations/{id}/messages?before={messageId}&limit=` | `{messages, has_more}` oldest-first page |
| POST | `/api/conversations/{id}/messages` | JSON for text/sticker, multipart for media → 201 message |
| POST | `/api/conversations/{id}/read` | Marks unread messages read → `{ok:true}` |

Conversation:

```json
{
  "id": 1,
  "peer": { "...full user object of the other participant..." },
  "last_message": { "...message object or null..." },
  "unread_count": 0,
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

Message:

```json
{
  "id": 10,
  "conversation_id": 1,
  "sender_id": 1,
  "client_id": "abc",
  "type": "image",
  "text": null,
  "attachment": {
    "file_id": 3,
    "name": "photo.png",
    "size": 1024,
    "mime": "image/png",
    "width": 640,
    "height": 480
  },
  "sticker": null,
  "status": "delivered",
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

`type` is `text`, `image`, `audio`, `file`, or `sticker`. `attachment` is null for text/sticker. Audio attachments include `duration_ms`; image attachments include `width` and `height`.

Text JSON:

```json
{ "type": "text", "text": "Hello", "client_id": "optional" }
```

Sticker JSON accepts either nested or flat sticker fields:

```json
{ "type": "sticker", "sticker": { "pack": "pack-id", "id": "sticker-id" }, "client_id": "optional" }
{ "type": "sticker", "sticker_pack": "pack-id", "sticker_id": "sticker-id", "client_id": "optional" }
```

Media multipart fields:

- `type`: `image`, `audio`, or `file`
- `client_id`: optional deduplication id
- `duration_ms`: audio duration
- `caption` or `text`: optional caption
- `file`: file part

If the same sender reuses a `client_id` in one conversation, the existing message is returned.

Status is `sent` → `delivered` → `read` for every message type. A message becomes `delivered` when the recipient has an active WebSocket or fetches the conversation, and `read` when `/read` is called. Read updates are sent to the sender as grouped WebSocket events.

Messages are returned oldest-first within each page. Use the oldest returned id as the next `before` cursor. Default limit is 50, maximum 100.

### Files

`GET /api/files/{fileId}` serves the bytes with the detected content type, exact `Content-Length`, private cache headers, and single-range support (`206`, `Content-Range`, `Accept-Ranges`).

Authorization:

- Avatars: any authenticated user.
- Message attachments: only conversation participants.
- Story images: the owner and followers while the story is active.

Content is detected from magic bytes, not the declared MIME type. Accepted images include JPEG, PNG, WebP, GIF, and HEIC. Accepted audio includes m4a/AAC (MP4-family audio), OGG/Opus, WebM, WAV, and MP3. Other files are stored up to the configured limits. Wrong or generic client-declared MIME types are tolerated.

### Stories

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/stories` | Image multipart (`file`, optional `caption`) or text JSON → 201 Story |
| GET | `/api/stories` | `{stories}` StoryGroup list |
| POST | `/api/stories/{id}/view` | Mark seen → `{ok:true}` |
| GET | `/api/stories/{id}/viewers` | Owner only → `{viewers}`, each `{user, viewed_at}` |
| DELETE | `/api/stories/{id}` | Owner only → `{ok:true}` |

Text story:

```json
{ "type": "text", "text": "Hello world", "bg_color": "#1E88E5" }
```

Story:

```json
{
  "id": 1,
  "user_id": 1,
  "type": "image",
  "caption": "Hello",
  "text": null,
  "bg_color": null,
  "file_id": 4,
  "created_at": "2026-01-01T00:00:00.000Z",
  "expires_at": "2026-01-02T00:00:00.000Z",
  "seen": false,
  "view_count": 3
}
```

`view_count` is present only for the owner. StoryGroup:

```json
{
  "user": { "...user..." },
  "has_unseen": true,
  "stories": [ "...oldest first..." ]
}
```

The caller's own group is always first, even when empty. Followed users with active stories follow, unseen groups first. Stories expire after 24 hours by default; cleanup removes expired rows and image blobs.

### Health

`GET /api/health` (no auth):

```json
{ "ok": true, "status": "ok", "time": "2026-01-01T00:00:00.000Z", "uptime_seconds": 12 }
```

## WebSocket

Connect to `ws://185.196.20.220:5050/ws?token=<session-token>`. Missing or invalid tokens are rejected with HTTP 401 during the upgrade. A protocol-level heartbeat runs every 30 seconds.

Every server frame is `{ "event": "...", "data": {...} }`:

```json
{ "event": "message.new", "data": { "...message..." } }
{ "event": "message.status", "data": { "conversation_id": 1, "message_ids": [10], "message_id": 10, "status": "read" } }
{ "event": "typing", "data": { "conversation_id": 1, "user_id": 2, "is_typing": true } }
{ "event": "presence", "data": { "user_id": 2, "online": true, "last_seen": null } }
{ "event": "story.new", "data": { "...user..." } }
{ "event": "pong", "data": { "time": "..." } }
{ "event": "error", "data": { "code": "...", "message": "..." } }
```

Client frames use the same envelope:

```json
{ "event": "typing", "data": { "conversation_id": 1, "is_typing": true } }
{ "event": "ping" }
```

`message.new` goes to both participants. `message.status` goes to the message sender with `message_ids` for the grouped update (`message_id` is also included for older clients). Presence goes to followers, followed users, and conversation peers; a newly connected client also receives the current online state of those peers. `story.new` goes to the owner's followers.

## Project structure

```
src/
  server.js              Fastify app, logging, graceful shutdown
  config.js              .env configuration
  serializers.js         API object shapes
  db/
    index.js             SQLite open + pragmas
    migrations.js        automatic schema migrations
  routes/                auth, users, friends, conversations, files, stories, health
  services/              business logic, status events, file handling
  ws/                    upgrade/auth, per-user hub, presence
  jobs/cleanup.js        expired stories/sessions cleanup
  utils/                 validation, errors, rate limits, multipart, media detection
scripts/
  seed.js                demo users
  selftest.js            end-to-end test suite
  run-selftest.js        fresh server + test runner
data/                    SQLite database (runtime)
uploads/                 uploaded blobs (runtime, never served statically)
```

## Security notes

- Passwords use bcrypt (`bcryptjs`, cost 12).
- Session tokens are 256-bit random values; only SHA-256 hashes are stored. Logout deletes the token and closes its WebSockets.
- All SQL uses prepared statements.
- Login, register, and search are rate limited in memory per IP.
- Uploads are validated from content magic bytes; SVG is not accepted as an image.
- Stored filenames are random UUIDs; original names are metadata only.
- Files are only served through the authenticated `/api/files/{id}` endpoint.
