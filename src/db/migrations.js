import { nowIso } from '../utils/time.js';

const migrations = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          bio TEXT NOT NULL DEFAULT '',
          password_hash TEXT NOT NULL,
          avatar_file_id INTEGER,
          online INTEGER NOT NULL DEFAULT 0,
          last_seen TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          stored_name TEXT NOT NULL UNIQUE,
          original_name TEXT,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          duration_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_files_owner ON files(owner_id);

        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE follows (
          follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (follower_id, following_id)
        );
        CREATE INDEX idx_follows_following ON follows(following_id);

        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user1_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user2_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (user1_id, user2_id),
          CHECK (user1_id < user2_id)
        );
        CREATE INDEX idx_conversations_user1 ON conversations(user1_id);
        CREATE INDEX idx_conversations_user2 ON conversations(user2_id);
        CREATE INDEX idx_conversations_updated ON conversations(updated_at);

        CREATE TABLE conversation_reads (
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_read_message_id INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, user_id)
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_id TEXT,
          type TEXT NOT NULL,
          text TEXT,
          file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
          sticker_pack TEXT,
          sticker_id TEXT,
          status TEXT NOT NULL DEFAULT 'sent',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_messages_conv_id ON messages(conversation_id, id);
        CREATE INDEX idx_messages_status ON messages(conversation_id, status);
        CREATE UNIQUE INDEX idx_messages_client
          ON messages(conversation_id, sender_id, client_id)
          WHERE client_id IS NOT NULL;

        CREATE TABLE stories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
          caption TEXT,
          text TEXT,
          bg_color TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_stories_user ON stories(user_id, created_at);
        CREATE INDEX idx_stories_expires ON stories(expires_at);

        CREATE TABLE story_views (
          story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
          viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          viewed_at TEXT NOT NULL,
          PRIMARY KEY (story_id, viewer_id)
        );
      `);
    },
  },
  {
    version: 2,
    name: 'backfill-empty-display-names',
    up(db) {
      db.prepare(
        "UPDATE users SET display_name = username WHERE display_name IS NULL OR TRIM(display_name) = ''",
      ).run();
    },
  },
  {
    version: 3,
    name: 'add-google-auth-columns',
    up(db) {
      const columns = db.prepare("PRAGMA table_info(users)").all();
      const colNames = new Set(columns.map((c) => c.name));
      if (!colNames.has('google_id')) {
        db.exec('ALTER TABLE users ADD COLUMN google_id TEXT;');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;');
      }
      if (!colNames.has('email')) {
        db.exec('ALTER TABLE users ADD COLUMN email TEXT;');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;');
      }
    },
  },
];

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
  );

  const apply = db.transaction((migration) => {
    migration.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      migration.version,
      migration.name,
      nowIso(),
    );
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
}
