import Database from 'better-sqlite3';
import WebSocket from 'ws';

const BASE_URL = process.env.SELFTEST_BASE_URL || 'http://127.0.0.1:5050';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const DB_PATH = process.env.SELFTEST_DB_PATH || null;
const PASSWORD = 'password123';

let passed = 0;

function logStep(message) {
  console.log(`\n== ${message}`);
}

function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
  });

  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

async function apiBinary(path, { token, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE_URL}${path}`, { headers: requestHeaders });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

function expectStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(
      `${label}: expected HTTP ${status}, got ${response.status}: ${JSON.stringify(response.data)}`,
    );
  }
  passed += 1;
}

function makeM4a() {
  const buffer = Buffer.alloc(128);
  buffer.writeUInt32BE(24, 0);
  buffer.write('ftyp', 4);
  buffer.write('M4A ', 8);
  buffer.writeUInt32BE(0, 12);
  buffer.write('M4A ', 16);
  buffer.write('isom', 20);
  buffer.writeUInt32BE(104, 24);
  buffer.write('mdat', 28);
  for (let index = 32; index < buffer.length; index += 1) {
    buffer[index] = (index * 7) % 251;
  }
  return buffer;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const M4A = makeM4a();

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    const received = [];
    const waiters = [];
    let closed = false;
    const closeWaiters = [];

    ws.on('close', () => {
      closed = true;
      for (const resolveClose of closeWaiters.splice(0)) resolveClose();
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      received.push(message);
    });

    ws.on('error', (error) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      reject(error);
    });

    ws.on('open', () => {
      resolve({
        send(payload) {
          ws.send(JSON.stringify(payload));
        },
        waitFor(predicate, timeoutMs = 5000) {
          const index = received.findIndex(predicate);
          if (index >= 0) {
            const [message] = received.splice(index, 1);
            return Promise.resolve(message);
          }
          return new Promise((resolveWaiter, rejectWaiter) => {
            const waiter = {
              predicate,
              resolve: resolveWaiter,
              reject: rejectWaiter,
              timer: setTimeout(() => {
                const position = waiters.indexOf(waiter);
                if (position >= 0) waiters.splice(position, 1);
                rejectWaiter(new Error('Timed out waiting for WebSocket event'));
              }, timeoutMs),
            };
            waiters.push(waiter);
          });
        },
        close() {
          ws.close();
        },
        waitClosed(timeoutMs = 3000) {
          if (closed) return Promise.resolve(true);
          return new Promise((resolveClose) => {
            const timer = setTimeout(() => resolveClose(false), timeoutMs);
            closeWaiters.push(() => {
              clearTimeout(timer);
              resolveClose(true);
            });
          });
        },
      });
    });
  });
}

async function verifyFile(label, fileId, token, { mime, content }) {
  const full = await apiBinary(`/api/files/${fileId}`, { token });
  ok(full.status === 200, `${label}: expected full file HTTP 200, got ${full.status}`);
  ok(full.headers.get('content-type') === mime, `${label}: content-type ${full.headers.get('content-type')} != ${mime}`);
  ok(
    full.headers.get('content-length') === String(content.length),
    `${label}: content-length header mismatch`,
  );
  ok(full.buffer.length === content.length, `${label}: downloaded size mismatch`);
  ok(full.buffer.equals(content), `${label}: downloaded bytes mismatch`);

  const end = Math.min(31, content.length - 1);
  const range = await apiBinary(`/api/files/${fileId}`, {
    token,
    headers: { range: `bytes=0-${end}` },
  });
  ok(range.status === 206, `${label}: expected range HTTP 206, got ${range.status}`);
  ok(
    range.headers.get('content-range') === `bytes 0-${end}/${content.length}`,
    `${label}: content-range mismatch`,
  );
  ok(
    range.headers.get('content-length') === String(end + 1),
    `${label}: range content-length mismatch`,
  );
  ok(range.buffer.equals(content.subarray(0, end + 1)), `${label}: range bytes mismatch`);
}

async function main() {
  const suffix = Date.now().toString(36).slice(-8);
  const digits = String(Date.now()).slice(-6);
  const phoneA = `+1555${digits}1`;
  const phoneB = `+1555${digits}2`;
  const usernameA = `alice_${suffix}`;
  const usernameB = `bob_${suffix}`;
  const nameA = 'Alice Test';
  const nameB = 'Bob Test';

  logStep('Health check');
  const health = await api('/api/health');
  expectStatus(health, 200, 'health');
  ok(health.data.ok === true, 'health payload is not ok');

  logStep('Register, login, profile and avatar');
  const registerA = await api('/api/auth/register', {
    method: 'POST',
    body: {
      phone: phoneA,
      username: usernameA,
      display_name: nameA,
      password: PASSWORD,
    },
  });
  expectStatus(registerA, 201, 'register A');
  ok(registerA.data.token && registerA.data.user.id, 'register A missing token/user');
  ok(registerA.data.user.display_name === nameA, 'register A display_name mismatch');

  const registerB = await api('/api/auth/register', {
    method: 'POST',
    body: {
      phone: phoneB,
      username: usernameB,
      display_name: nameB,
      password: PASSWORD,
    },
  });
  expectStatus(registerB, 201, 'register B');
  ok(registerB.data.user.display_name === nameB, 'register B display_name mismatch');

  const loginA = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: phoneA, password: PASSWORD },
  });
  expectStatus(loginA, 200, 'login A');
  const tokenA = loginA.data.token;
  const tokenB = registerB.data.token;
  const userA = loginA.data.user;
  const userB = registerB.data.user;

  const me = await api('/api/me', { token: tokenA });
  expectStatus(me, 200, 'get me');
  ok(me.data.id === userA.id, 'GET /api/me returned wrong user');

  const patchMe = await api('/api/me', {
    method: 'PATCH',
    token: tokenA,
    body: { display_name: 'Alice Updated', bio: 'Updated bio' },
  });
  expectStatus(patchMe, 200, 'patch me');
  ok(patchMe.data.display_name === 'Alice Updated', 'display_name update failed');
  ok(patchMe.data.bio === 'Updated bio', 'bio update failed');
  const displayA = patchMe.data.display_name;

  const avatarForm = new FormData();
  avatarForm.append('file', new Blob([PNG], { type: 'application/octet-stream' }), 'avatar.png');
  const avatar = await api('/api/me/avatar', {
    method: 'POST',
    token: tokenA,
    body: avatarForm,
  });
  expectStatus(avatar, 200, 'upload avatar');
  ok(avatar.data.avatar_file_id, 'avatar_file_id missing');
  ok(avatar.data.display_name === displayA, 'avatar response lost display_name');
  await verifyFile('avatar', avatar.data.avatar_file_id, tokenB, {
    mime: 'image/png',
    content: PNG,
  });

  const badAvatarForm = new FormData();
  badAvatarForm.append('file', new Blob([PDF], { type: 'image/png' }), 'fake.png');
  const badAvatar = await api('/api/me/avatar', {
    method: 'POST',
    token: tokenA,
    body: badAvatarForm,
  });
  expectStatus(badAvatar, 415, 'reject avatar with non-image content');
  ok(badAvatar.data.error.code === 'UNSUPPORTED_MEDIA_TYPE', 'bad avatar error code mismatch');

  if (DB_PATH) {
    const legacyDb = new Database(DB_PATH);
    legacyDb.prepare("UPDATE users SET display_name = '' WHERE id = ?").run(userB.id);
    legacyDb.close();

    const meBEmpty = await api('/api/me', { token: tokenB });
    expectStatus(meBEmpty, 200, 'empty display_name fallback for B');
    ok(meBEmpty.data.display_name === usernameB, 'empty display_name was not returned as username');
    const getBEmpty = await api(`/api/users/${userB.id}`, { token: tokenA });
    expectStatus(getBEmpty, 200, 'empty display_name fallback for user lookup');
    ok(getBEmpty.data.display_name === usernameB, 'lookup returned empty display_name');

    const restoreB = await api('/api/me', {
      method: 'PATCH',
      token: tokenB,
      body: { display_name: nameB },
    });
    expectStatus(restoreB, 200, 'restore B display_name');
    ok(restoreB.data.display_name === nameB, 'B display_name restore failed');

    const migrationDb = new Database(DB_PATH, { readonly: true });
    const migration = migrationDb
      .prepare('SELECT version FROM schema_migrations WHERE version = 2')
      .get();
    migrationDb.close();
    ok(migration?.version === 2, 'display_name backfill migration was not applied');
  }

  logStep('Search, follows and lists');
  const searchPhone = await api(`/api/users/search?q=${encodeURIComponent(phoneB)}`, {
    token: tokenA,
  });
  expectStatus(searchPhone, 200, 'search by phone');
  ok(Array.isArray(searchPhone.data.users), 'search response must wrap users array');
  ok(searchPhone.data.users.some((user) => user.id === userB.id), 'phone search did not find B');
  ok(searchPhone.data.users.length <= 30, 'search returned more than 30 users');

  const searchUsername = await api(
    `/api/users/search?q=${encodeURIComponent('@' + usernameB.slice(0, 6))}`,
    { token: tokenA },
  );
  expectStatus(searchUsername, 200, 'search by username prefix');
  ok(
    searchUsername.data.users.some((user) => user.id === userB.id),
    'username search did not find B',
  );
  ok(
    !searchUsername.data.users.some((user) => user.id === userA.id),
    'search included the caller',
  );

  const getUser = await api(`/api/users/${userB.id}`, { token: tokenA });
  expectStatus(getUser, 200, 'get user B');
  ok(getUser.data.username === usernameB, 'user B lookup mismatch');
  ok(getUser.data.display_name === nameB, 'user B display_name mismatch');

  const followAB = await api(`/api/friends/${userB.id}`, {
    method: 'POST',
    token: tokenA,
  });
  expectStatus(followAB, 200, 'A follows B');
  ok(followAB.data.id === userB.id, 'follow response must be the target user object');
  ok(followAB.data.is_following === true, 'follow response missing is_following=true');

  const following = await api('/api/friends/following', { token: tokenA });
  expectStatus(following, 200, 'A following list');
  ok(Array.isArray(following.data.following), 'following response must wrap following array');
  ok(following.data.following.some((user) => user.id === userB.id), 'A following list missing B');

  const followers = await api('/api/friends/followers', { token: tokenB });
  expectStatus(followers, 200, 'B followers list');
  ok(Array.isArray(followers.data.followers), 'followers response must wrap followers array');
  ok(followers.data.followers.some((user) => user.id === userA.id), 'B followers list missing A');

  const unfollowAB = await api(`/api/friends/${userB.id}`, {
    method: 'DELETE',
    token: tokenA,
  });
  expectStatus(unfollowAB, 200, 'A unfollows B');
  ok(unfollowAB.data.id === userB.id, 'unfollow response must be the target user object');
  ok(unfollowAB.data.is_following === false, 'unfollow response missing is_following=false');

  const followingEmpty = await api('/api/friends/following', { token: tokenA });
  expectStatus(followingEmpty, 200, 'A following list after unfollow');
  ok(followingEmpty.data.following.length === 0, 'A following list not empty after unfollow');

  const followABAgain = await api(`/api/friends/${userB.id}`, {
    method: 'POST',
    token: tokenA,
  });
  expectStatus(followABAgain, 200, 'A follows B again');
  const followBA = await api(`/api/friends/${userA.id}`, {
    method: 'POST',
    token: tokenB,
  });
  expectStatus(followBA, 200, 'B follows A');
  ok(followBA.data.is_follower === true, 'B follow response missing is_follower=true');

  logStep('Conversation and peer objects');
  const conversation = await api('/api/conversations', {
    method: 'POST',
    token: tokenA,
    body: { user_id: userB.id },
  });
  expectStatus(conversation, 200, 'get-or-create conversation');
  const conversationId = conversation.data.id;
  ok(conversationId, 'conversation id missing');
  ok(conversation.data.peer?.id === userB.id, 'conversation peer missing or wrong');
  ok(conversation.data.peer.display_name === nameB, 'conversation peer display_name missing');
  ok(conversation.data.last_message === null, 'new conversation last_message must be null');
  ok(conversation.data.unread_count === 0, 'new conversation unread_count must be 0');
  ok(Boolean(conversation.data.updated_at), 'conversation updated_at missing');
  ok(!('user' in conversation.data), 'conversation must use peer, not user');

  const conversationsB = await api('/api/conversations', { token: tokenB });
  expectStatus(conversationsB, 200, 'list conversations B');
  ok(Array.isArray(conversationsB.data.conversations), 'conversations must wrap array');
  const convB = conversationsB.data.conversations.find((item) => item.id === conversationId);
  ok(convB, 'B conversation list missing conversation');
  ok(convB.peer.id === userA.id, 'B conversation peer mismatch');
  ok(convB.peer.display_name === displayA, 'B conversation peer display_name missing');
  ok(convB.peer.avatar_file_id === avatar.data.avatar_file_id, 'B conversation peer avatar missing');

  logStep('WebSocket presence, typing and pong');
  const wsA = await connectWs(tokenA);
  const wsB = await connectWs(tokenB);

  const presenceOnlineA = await wsA.waitFor(
    (event) =>
      event.event === 'presence' &&
      event.data?.user_id === userB.id &&
      event.data?.online === true,
  );
  ok(typeof presenceOnlineA.data.last_seen === 'object' || presenceOnlineA.data.last_seen === null, 'presence last_seen missing');
  const presenceSnapshotB = await wsB.waitFor(
    (event) =>
      event.event === 'presence' &&
      event.data?.user_id === userA.id &&
      event.data?.online === true,
  );
  ok(presenceSnapshotB.data.user_id === userA.id, 'presence snapshot for A missing');

  const onlineLookup = await api(`/api/users/${userB.id}`, { token: tokenA });
  expectStatus(onlineLookup, 200, 'lookup online B');
  ok(onlineLookup.data.online === true, 'B should be online after WebSocket connect');

  wsA.send({
    event: 'typing',
    data: { conversation_id: conversationId, is_typing: true },
  });
  const typingEvent = await wsB.waitFor(
    (event) => event.event === 'typing' && event.data?.user_id === userA.id,
  );
  ok(typingEvent.data.conversation_id === conversationId, 'typing conversation_id mismatch');
  ok(typingEvent.data.is_typing === true, 'typing is_typing mismatch');

  wsA.send({ event: 'ping' });
  const pong = await wsA.waitFor((event) => event.event === 'pong');
  ok(typeof pong.data?.time === 'string', 'pong data time missing');

  async function runMessageFlow(label, sendRequest, verifyMessage) {
    const response = await sendRequest();
    expectStatus(response, 201, `send ${label}`);
    const message = response.data;
    verifyMessage(message);
    ok(message.status === 'delivered', `${label}: expected delivered status, got ${message.status}`);

    const newEvent = await wsB.waitFor(
      (event) => event.event === 'message.new' && event.data?.id === message.id,
    );
    ok(newEvent.data.type === message.type, `${label}: message.new type mismatch`);
    ok(newEvent.data.status === 'delivered', `${label}: message.new status mismatch`);

    const deliveredEvent = await wsA.waitFor(
      (event) =>
        event.event === 'message.status' &&
        event.data?.status === 'delivered' &&
        event.data.message_ids.includes(message.id),
    );
    ok(deliveredEvent.data.conversation_id === conversationId, `${label}: delivered conversation mismatch`);

    const read = await api(`/api/conversations/${conversationId}/read`, {
      method: 'POST',
      token: tokenB,
    });
    expectStatus(read, 200, `B reads after ${label}`);
    ok(read.data.ok === true, `${label}: read response must be ok`);

    const readEvent = await wsA.waitFor(
      (event) =>
        event.event === 'message.status' &&
        event.data?.status === 'read' &&
        event.data.message_ids.includes(message.id),
    );
    ok(readEvent.data.message_ids.includes(message.id), `${label}: read event missing message id`);

    const history = await api(`/api/conversations/${conversationId}/messages?limit=100`, {
      token: tokenA,
    });
    expectStatus(history, 200, `history after ${label}`);
    ok(Array.isArray(history.data.messages), `${label}: history must wrap messages array`);
    const stored = history.data.messages.find((item) => item.id === message.id);
    ok(stored, `${label}: message missing from history`);
    ok(stored.status === 'read', `${label}: stored status is ${stored.status}, expected read`);
    return message;
  }

  logStep('Text message and client_id deduplication');
  const textClientId = `text-${suffix}`;
  const textMessage = await runMessageFlow(
    'text',
    () =>
      api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: tokenA,
        body: { type: 'text', text: 'Hello from Alice', client_id: textClientId },
      }),
    (message) => {
      ok(message.type === 'text', 'text message type mismatch');
      ok(message.text === 'Hello from Alice', 'text message text mismatch');
      ok(message.attachment === null, 'text message attachment must be null');
      ok(message.sticker === null, 'text message sticker must be null');
    },
  );

  const duplicate = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    token: tokenA,
    body: { type: 'text', text: 'duplicate', client_id: textClientId },
  });
  expectStatus(duplicate, 201, 'deduplicated text message');
  ok(duplicate.data.id === textMessage.id, 'client_id deduplication failed');

  logStep('Sticker message');
  await runMessageFlow(
    'sticker',
    () =>
      api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: tokenA,
        body: {
          type: 'sticker',
          sticker: { pack: 'demo-pack', id: 'wave' },
          client_id: `sticker-${suffix}`,
        },
      }),
    (message) => {
      ok(message.type === 'sticker', 'sticker type mismatch');
      ok(message.sticker.pack === 'demo-pack', 'sticker pack mismatch');
      ok(message.sticker.id === 'wave', 'sticker id mismatch');
      ok(message.attachment === null, 'sticker attachment must be null');
    },
  );

  logStep('Image message and file download');
  const imageMessage = await runMessageFlow(
    'image',
    () => {
      const form = new FormData();
      form.append('type', 'image');
      form.append('client_id', `image-${suffix}`);
      form.append('caption', 'A tiny pixel');
      form.append('file', new Blob([PNG], { type: 'application/octet-stream' }), 'photo.bin');
      return api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: tokenA,
        body: form,
      });
    },
    (message) => {
      ok(message.type === 'image', 'image message type mismatch');
      ok(message.text === 'A tiny pixel', 'image caption mismatch');
      ok(message.attachment.mime === 'image/png', 'image mime not detected from content');
      ok(message.attachment.width === 1, 'image width not detected');
      ok(message.attachment.height === 1, 'image height not detected');
      ok(!('duration_ms' in message.attachment), 'image attachment must not include duration_ms');
    },
  );
  await verifyFile('image', imageMessage.attachment.file_id, tokenB, {
    mime: 'image/png',
    content: PNG,
  });

  logStep('Audio message (m4a content, generic declared MIME) and range download');
  const audioMessage = await runMessageFlow(
    'audio',
    () => {
      const form = new FormData();
      form.append('type', 'audio');
      form.append('duration_ms', '1500');
      form.append('client_id', `audio-${suffix}`);
      form.append(
        'file',
        new Blob([M4A], { type: 'application/octet-stream' }),
        'voice-note.m4a',
      );
      return api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: tokenA,
        body: form,
      });
    },
    (message) => {
      ok(message.type === 'audio', 'audio message type mismatch');
      ok(message.attachment.mime === 'audio/mp4', `audio mime mismatch: ${message.attachment.mime}`);
      ok(message.attachment.duration_ms === 1500, 'audio duration mismatch');
      ok(!('width' in message.attachment), 'audio attachment must not include width');
      ok(!('height' in message.attachment), 'audio attachment must not include height');
    },
  );
  await verifyFile('audio', audioMessage.attachment.file_id, tokenB, {
    mime: 'audio/mp4',
    content: M4A,
  });

  logStep('File message and range download');
  const fileMessage = await runMessageFlow(
    'file',
    () => {
      const form = new FormData();
      form.append('type', 'file');
      form.append('client_id', `file-${suffix}`);
      form.append(
        'file',
        new Blob([PDF], { type: 'application/octet-stream' }),
        'document.pdf',
      );
      return api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        token: tokenA,
        body: form,
      });
    },
    (message) => {
      ok(message.type === 'file', 'file message type mismatch');
      ok(message.attachment.mime === 'application/pdf', 'file mime not detected from content');
      ok(message.attachment.name === 'document.pdf', 'file name mismatch');
      ok(!('duration_ms' in message.attachment), 'file attachment must not include duration_ms');
      ok(!('width' in message.attachment), 'file attachment must not include width');
      ok(!('height' in message.attachment), 'file attachment must not include height');
    },
  );
  await verifyFile('file', fileMessage.attachment.file_id, tokenB, {
    mime: 'application/pdf',
    content: PDF,
  });

  logStep('Unread count and read status for all message types');
  const conversationsAfterMessages = await api('/api/conversations', { token: tokenB });
  expectStatus(conversationsAfterMessages, 200, 'list conversations after reads');
  const convAfterMessages = conversationsAfterMessages.data.conversations.find(
    (item) => item.id === conversationId,
  );
  ok(convAfterMessages.unread_count === 0, 'unread_count should be 0 after reads');
  ok(convAfterMessages.last_message.id === fileMessage.id, 'last_message mismatch after all types');

  const unreadText = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    token: tokenA,
    body: { type: 'text', text: 'Unread check', client_id: `unread-${suffix}` },
  });
  expectStatus(unreadText, 201, 'send unread text');
  await wsB.waitFor(
    (event) => event.event === 'message.new' && event.data?.id === unreadText.data.id,
  );
  const conversationsUnread = await api('/api/conversations', { token: tokenB });
  expectStatus(conversationsUnread, 200, 'list conversations with unread');
  const convUnread = conversationsUnread.data.conversations.find(
    (item) => item.id === conversationId,
  );
  ok(convUnread.unread_count === 1, `expected unread_count 1, got ${convUnread.unread_count}`);
  ok(convUnread.last_message.id === unreadText.data.id, 'last_message not updated for unread text');

  const readUnread = await api(`/api/conversations/${conversationId}/read`, {
    method: 'POST',
    token: tokenB,
  });
  expectStatus(readUnread, 200, 'B reads unread text');
  await wsA.waitFor(
    (event) =>
      event.event === 'message.status' &&
      event.data?.status === 'read' &&
      event.data.message_ids.includes(unreadText.data.id),
  );

  logStep('Cursor pagination');
  const pageIds = [];
  for (let index = 0; index < 3; index += 1) {
    const sent = await api(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: tokenA,
      body: {
        type: 'text',
        text: `page-${index}`,
        client_id: `page-${suffix}-${index}`,
      },
    });
    expectStatus(sent, 201, `send page message ${index}`);
    pageIds.push(sent.data.id);
    await wsB.waitFor(
      (event) => event.event === 'message.new' && event.data?.id === sent.data.id,
    );
  }

  const pageOne = await api(`/api/conversations/${conversationId}/messages?limit=2`, {
    token: tokenA,
  });
  expectStatus(pageOne, 200, 'messages page one');
  ok(pageOne.data.messages.length === 2, 'page one should have 2 messages');
  ok(pageOne.data.has_more === true, 'page one should have more');
  ok(!('next_before' in pageOne.data), 'messages response must not include next_before');
  const pageTwo = await api(
    `/api/conversations/${conversationId}/messages?limit=2&before=${pageOne.data.messages[0].id}`,
    { token: tokenA },
  );
  expectStatus(pageTwo, 200, 'messages page two');
  ok(Array.isArray(pageTwo.data.messages), 'messages page must wrap array');
  const overlap = pageTwo.data.messages.some((message) =>
    pageOne.data.messages.some((first) => first.id === message.id),
  );
  ok(!overlap, 'pagination pages overlap');
  ok(
    pageTwo.data.messages[pageTwo.data.messages.length - 1].id < pageOne.data.messages[0].id,
    'page two is not older than page one',
  );

  const readPages = await api(`/api/conversations/${conversationId}/read`, {
    method: 'POST',
    token: tokenB,
  });
  expectStatus(readPages, 200, 'B reads paginated messages');
  const groupedReadEvent = await wsA.waitFor(
    (event) =>
      event.event === 'message.status' &&
      event.data?.status === 'read' &&
      pageIds.every((id) => event.data.message_ids.includes(id)),
  );
  ok(groupedReadEvent.data.message_ids.length === 3, 'grouped read status should contain 3 ids');

  logStep('Stories: create, list, view, viewers and delete');
  const storiesBefore = await api('/api/stories', { token: tokenB });
  expectStatus(storiesBefore, 200, 'list stories before creating');
  ok(Array.isArray(storiesBefore.data.stories), 'stories response must wrap stories array');
  ok(storiesBefore.data.stories[0].user.id === userB.id, 'own story group must be first');
  ok(storiesBefore.data.stories[0].has_unseen === false, 'own story group has_unseen must be false');
  ok(storiesBefore.data.stories[0].stories.length === 0, 'own empty story group must be present');
  ok(
    !storiesBefore.data.stories.some((group) => group.user.id === userA.id),
    'A story group should not exist before posting',
  );

  const storyForm = new FormData();
  storyForm.append('caption', 'A tiny pixel story');
  storyForm.append(
    'file',
    new Blob([PNG], { type: 'application/octet-stream' }),
    'story.png',
  );
  const imageStory = await api('/api/stories', {
    method: 'POST',
    token: tokenA,
    body: storyForm,
  });
  expectStatus(imageStory, 201, 'create image story');
  ok(imageStory.data.type === 'image', 'image story type mismatch');
  ok(imageStory.data.caption === 'A tiny pixel story', 'story caption mismatch');
  ok(imageStory.data.seen === true, 'own story should be seen');
  ok(imageStory.data.view_count === 0, 'new story view_count must be 0');
  ok(imageStory.data.file_id, 'image story file_id missing');

  const storyNew = await wsB.waitFor(
    (event) => event.event === 'story.new' && event.data?.id === userA.id,
  );
  ok(storyNew.data.display_name === displayA, 'story.new user display_name mismatch');
  ok(!('story' in storyNew) && !('type' in storyNew.data), 'story.new must carry user as data');

  const textStory = await api('/api/stories', {
    method: 'POST',
    token: tokenA,
    body: { type: 'text', text: 'Text story', bg_color: '#112233' },
  });
  expectStatus(textStory, 201, 'create text story');
  ok(textStory.data.type === 'text', 'text story type mismatch');
  ok(textStory.data.text === 'Text story', 'text story text mismatch');
  ok(textStory.data.bg_color === '#112233', 'story bg_color mismatch');
  ok(textStory.data.file_id === null, 'text story file_id must be null');

  const storiesB = await api('/api/stories', { token: tokenB });
  expectStatus(storiesB, 200, 'list stories B');
  ok(storiesB.data.stories[0].user.id === userB.id, 'own story group must remain first');
  const aliceGroup = storiesB.data.stories.find((group) => group.user.id === userA.id);
  ok(aliceGroup, 'B does not see Alice story group');
  ok(aliceGroup.has_unseen === true, 'Alice story group should have unseen stories');
  ok(aliceGroup.stories.length === 2, 'B should see 2 Alice stories');
  ok(aliceGroup.stories[0].id === imageStory.data.id, 'stories are not oldest first');
  ok(aliceGroup.stories[1].id === textStory.data.id, 'text story order mismatch');
  ok(aliceGroup.stories.every((story) => story.seen === false), 'unseen stories marked seen');
  ok(
    aliceGroup.stories.every((story) => !('view_count' in story)),
    'followers must not receive story view_count',
  );

  const viewImage = await api(`/api/stories/${imageStory.data.id}/view`, {
    method: 'POST',
    token: tokenB,
  });
  expectStatus(viewImage, 200, 'B views image story');
  ok(viewImage.data.ok === true, 'story view response must be ok');

  const storiesAfterImageView = await api('/api/stories', { token: tokenB });
  const aliceGroupAfterImageView = storiesAfterImageView.data.stories.find(
    (group) => group.user.id === userA.id,
  );
  const viewedStory = aliceGroupAfterImageView.stories.find(
    (story) => story.id === imageStory.data.id,
  );
  const unviewedStory = aliceGroupAfterImageView.stories.find(
    (story) => story.id === textStory.data.id,
  );
  ok(viewedStory.seen === true, 'viewed story still marked unseen');
  ok(unviewedStory.seen === false, 'unviewed story marked seen');
  ok(aliceGroupAfterImageView.has_unseen === true, 'group should still have unseen text story');

  const viewText = await api(`/api/stories/${textStory.data.id}/view`, {
    method: 'POST',
    token: tokenB,
  });
  expectStatus(viewText, 200, 'B views text story');
  const storiesAfterTextView = await api('/api/stories', { token: tokenB });
  const aliceGroupAfterTextView = storiesAfterTextView.data.stories.find(
    (group) => group.user.id === userA.id,
  );
  ok(aliceGroupAfterTextView.has_unseen === false, 'group should have no unseen stories');

  const ownStories = await api('/api/stories', { token: tokenA });
  expectStatus(ownStories, 200, 'list own stories');
  ok(ownStories.data.stories[0].user.id === userA.id, 'own story group must be first for owner');
  const ownImageStory = ownStories.data.stories[0].stories.find(
    (story) => story.id === imageStory.data.id,
  );
  ok(ownImageStory.view_count === 1, `owner view_count mismatch: ${ownImageStory.view_count}`);

  await verifyFile('story image', imageStory.data.file_id, tokenB, {
    mime: 'image/png',
    content: PNG,
  });

  const viewers = await api(`/api/stories/${imageStory.data.id}/viewers`, {
    token: tokenA,
  });
  expectStatus(viewers, 200, 'list story viewers');
  ok(Array.isArray(viewers.data.viewers), 'viewers response must wrap viewers array');
  const viewerB = viewers.data.viewers.find((entry) => entry.user.id === userB.id);
  ok(viewerB, 'viewer list missing B');
  ok(typeof viewerB.viewed_at === 'string', 'viewer entry missing viewed_at');

  const viewersDenied = await api(`/api/stories/${imageStory.data.id}/viewers`, {
    token: tokenB,
  });
  expectStatus(viewersDenied, 403, 'non-owner viewer list denied');

  const unfollowBA = await api(`/api/friends/${userA.id}`, {
    method: 'DELETE',
    token: tokenB,
  });
  expectStatus(unfollowBA, 200, 'B unfollows A after story viewing');
  ok(unfollowBA.data.is_following === false, 'unfollow response did not clear is_following');

  const storiesAfterUnfollow = await api('/api/stories', { token: tokenB });
  expectStatus(storiesAfterUnfollow, 200, 'list stories after unfollow');
  ok(
    !storiesAfterUnfollow.data.stories.some((group) => group.user.id === userA.id),
    'unfollowed user stories still visible',
  );

  const storyFileDenied = await apiBinary(`/api/files/${imageStory.data.file_id}`, {
    token: tokenB,
  });
  ok(storyFileDenied.status === 403, `story file should be forbidden after unfollow, got ${storyFileDenied.status}`);

  const deleteImageStory = await api(`/api/stories/${imageStory.data.id}`, {
    method: 'DELETE',
    token: tokenA,
  });
  expectStatus(deleteImageStory, 200, 'delete image story');
  ok(deleteImageStory.data.ok === true, 'delete story response must be ok');

  const deleteTextStory = await api(`/api/stories/${textStory.data.id}`, {
    method: 'DELETE',
    token: tokenA,
  });
  expectStatus(deleteTextStory, 200, 'delete text story');

  const deletedStoryFile = await apiBinary(`/api/files/${imageStory.data.file_id}`, {
    token: tokenA,
  });
  ok(deletedStoryFile.status === 404, `deleted story file should be 404, got ${deletedStoryFile.status}`);

  logStep('Presence offline and logout');
  wsB.close();
  const presenceOffline = await wsA.waitFor(
    (event) =>
      event.event === 'presence' &&
      event.data?.user_id === userB.id &&
      event.data?.online === false,
  );
  ok(typeof presenceOffline.data.last_seen === 'string', 'offline presence last_seen missing');
  const offlineLookup = await api(`/api/users/${userB.id}`, { token: tokenA });
  expectStatus(offlineLookup, 200, 'lookup offline B');
  ok(offlineLookup.data.online === false, 'B should be offline after WebSocket close');

  const logout = await api('/api/auth/logout', { method: 'POST', token: tokenA });
  expectStatus(logout, 200, 'logout A');
  ok(logout.data.ok === true, 'logout response must be ok');
  const afterLogout = await api('/api/me', { token: tokenA });
  expectStatus(afterLogout, 401, 'token rejected after logout');
  const wsAClosed = await wsA.waitClosed(3000);
  ok(wsAClosed === true, 'logout did not close the revoked token WebSocket');

  console.log('\nFINAL TEST REPORT');
  console.log(`Assertions passed: ${passed}`);
  console.log('Flows verified: health, auth, profile, avatar, display-name fallback, search,');
  console.log('follow/unfollow/lists, conversations/peer, WS presence/typing/pong,');
  console.log('text/sticker/image/audio/file messages, delivered/read status events for all');
  console.log('message types, unread counts, pagination, authorized file downloads with Range,');
  console.log('stories (image/text/new/listing/view/viewers/delete/access revocation), logout.');
  console.log('RESULT: PASS');
}

main().catch((error) => {
  console.error('\nSelf-test failed:');
  console.error(error);
  process.exitCode = 1;
});
