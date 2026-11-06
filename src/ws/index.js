import { WebSocketServer } from 'ws';
import { authenticateToken, hashToken, tokenFromHeader } from '../services/authService.js';
import { nowIso } from '../utils/time.js';
import { hub } from './hub.js';
import { markDeliveredForUser } from '../services/statusService.js';

function httpReject(socket, status, message) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    // Socket may already be gone.
  }
  socket.destroy();
}

function sendError(ws, code, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ event: 'error', data: { code, message } }));
  }
}

function handleClientMessage(db, ws, userId, raw) {
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    sendError(ws, 'INVALID_JSON', 'WebSocket messages must be JSON');
    return;
  }

  const event = payload && typeof payload === 'object' ? payload.event ?? payload.type : null;
  if (!payload || typeof payload !== 'object' || typeof event !== 'string') {
    sendError(ws, 'INVALID_MESSAGE', 'A message event is required');
    return;
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  if (event === 'ping') {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'pong', data: { time: nowIso() } }));
    }
    return;
  }

  if (event === 'typing') {
    const conversationId = Number(data.conversation_id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      sendError(ws, 'INVALID_CONVERSATION', 'conversation_id must be a positive integer');
      return;
    }

    const conversation = db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId);
    if (
      !conversation ||
      (conversation.user1_id !== userId && conversation.user2_id !== userId)
    ) {
      sendError(ws, 'FORBIDDEN', 'You are not a participant in this conversation');
      return;
    }

    const otherUserId =
      conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id;
    const isTyping = data.is_typing === undefined ? true : Boolean(data.is_typing);

    hub.sendToUser(otherUserId, {
      event: 'typing',
      data: {
        conversation_id: conversationId,
        user_id: userId,
        is_typing: isTyping,
      },
    });
    return;
  }

  sendError(ws, 'UNKNOWN_EVENT', `Unknown event: ${event}`);
}

export function setupWebSocket(server, db) {
  hub.init(db);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      httpReject(socket, 400, 'Bad Request');
      return;
    }

    if (url.pathname.replace(/\/+$/, '') !== '/ws') {
      httpReject(socket, 404, 'Not Found');
      return;
    }

    const token =
      url.searchParams.get('token') || tokenFromHeader(request.headers.authorization);
    let user;
    try {
      user = authenticateToken(db, token);
    } catch {
      httpReject(socket, 401, 'Unauthorized');
      return;
    }
    const authTokenHash = hashToken(token);

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.authTokenHash = authTokenHash;
      wss.emit('connection', ws, request, user);
    });
  });

  wss.on('connection', (ws, request, user) => {
    ws.isAlive = true;
    hub.add(user.id, ws);
    hub.sendPresenceSnapshot(user.id, ws);
    try {
      markDeliveredForUser(db, user.id);
    } catch {
      sendError(ws, 'INTERNAL_ERROR', 'Could not update message delivery status');
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        handleClientMessage(db, ws, user.id, raw);
      } catch {
        sendError(ws, 'INTERNAL_ERROR', 'Could not process the WebSocket message');
      }
    });

    ws.on('close', () => {
      hub.remove(user.id, ws);
    });

    ws.on('error', () => {
      hub.remove(user.id, ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 30_000);
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
