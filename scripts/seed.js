import bcrypt from 'bcryptjs';
import { config, ensureDirectories } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { nowIso } from '../src/utils/time.js';

const DEMO_USERS = [
  {
    phone: '+15550000001',
    username: 'alice',
    display_name: 'Alice Demo',
    bio: 'Demo account Alice',
    password: 'password123',
  },
  {
    phone: '+15550000002',
    username: 'bob',
    display_name: 'Bob Demo',
    bio: 'Demo account Bob',
    password: 'password123',
  },
];

ensureDirectories();
const db = initDb({ resetPresence: false });

function ensureUser(user) {
  const existing = db
    .prepare('SELECT * FROM users WHERE phone = ? OR username = ?')
    .get(user.phone, user.username);
  if (existing) return { row: existing, created: false };

  const result = db
    .prepare(
      `INSERT INTO users (phone, username, display_name, bio, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.phone,
      user.username,
      user.display_name,
      user.bio,
      bcrypt.hashSync(user.password, config.bcryptRounds),
      nowIso(),
    );

  return {
    row: db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)),
    created: true,
  };
}

const tx = db.transaction(() => {
  const alice = ensureUser(DEMO_USERS[0]);
  const bob = ensureUser(DEMO_USERS[1]);

  db.prepare(
    'INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
  ).run(alice.row.id, bob.row.id, nowIso());
  db.prepare(
    'INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
  ).run(bob.row.id, alice.row.id, nowIso());

  const user1 = Math.min(alice.row.id, bob.row.id);
  const user2 = Math.max(alice.row.id, bob.row.id);
  const timestamp = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO conversations (user1_id, user2_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(user1, user2, timestamp, timestamp);

  const conversation = db
    .prepare('SELECT * FROM conversations WHERE user1_id = ? AND user2_id = ?')
    .get(user1, user2);

  const messageCount = db
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
    .get(conversation.id).count;

  if (messageCount === 0) {
    const insertMessage = db.prepare(
      `INSERT INTO messages
         (conversation_id, sender_id, client_id, type, text, status, created_at)
       VALUES (?, ?, ?, 'text', ?, 'sent', ?)`,
    );
    insertMessage.run(conversation.id, alice.row.id, 'seed-hello-bob', 'Hey Bob!', timestamp);
    insertMessage.run(conversation.id, bob.row.id, 'seed-hello-alice', 'Hey Alice!', timestamp);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
      timestamp,
      conversation.id,
    );
  }

  return { alice, bob };
});

const { alice, bob } = tx();

console.log('Seed complete.');
for (const demo of DEMO_USERS) {
  console.log(`  ${demo.username} | phone: ${demo.phone} | password: ${demo.password}`);
}
console.log(
  `  alice created: ${alice.created}, bob created: ${bob.created}. Mutual follow and demo conversation ensured.`,
);

db.close();
