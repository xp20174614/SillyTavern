import crypto from 'node:crypto';

import { WebSocketServer } from 'ws';

/**
 * SillyRoom — multi-user live chatroom server plugin.
 *
 * Provides a WebSocket endpoint (same port as SillyTavern) at:
 *   ws(s)://<host>:<port>/api/plugins/sillyroom/ws
 *
 * and a REST status endpoint at:
 *   GET /api/plugins/sillyroom/status
 *
 * All room state is kept in memory of the single server process.
 */

export const info = {
    id: 'sillyroom',
    name: 'SillyRoom',
    description: 'Multi-user live chatroom over WebSocket (rooms, broadcast, presence)',
};

const WS_PATH = '/api/plugins/sillyroom/ws';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_NAME_LENGTH = 24;
const MAX_ROOM_ID_LENGTH = 32;
const MAX_MEMBERS_PER_ROOM = 32;
const MAX_ROOMS = 100;
const HISTORY_LIMIT = 50;
const RATE_WINDOW_MS = 5000;
const RATE_MAX_MESSAGES = 15;
const HEARTBEAT_INTERVAL_MS = 30000;

const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const NAME_COLORS = ['#e5424d', '#e58c3d', '#d3b53c', '#4fb04f', '#3db9ad', '#4d9de5', '#7a6de5', '#c85fd6'];

/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {WebSocketServer|null} */
let wss = null;
let heartbeatTimer = null;
let messageIdCounter = 0;
const upgradeListeners = [];

/**
 * @typedef {object} Member
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {number} joinedAt
 */

/**
 * @typedef {object} Room
 * @property {string} id
 * @property {number} createdAt
 * @property {Map<any, Member>} members Keyed by the socket owning the membership
 * @property {Array<object>} history Recent chat messages
 */

function createRoom(id) {
    return {
        id,
        createdAt: Date.now(),
        members: new Map(),
        history: [],
    };
}

function newMessageId() {
    messageIdCounter += 1;
    return `${Date.now().toString(36)}-${messageIdCounter.toString(36)}`;
}

/**
 * Strips control characters and enforces a maximum length.
 * @param {unknown} value Value to sanitize
 * @param {number} maxLength Maximum allowed length
 * @returns {string|null} Cleaned string or null when empty/invalid
 */
function sanitizeText(value, maxLength) {
    if (typeof value !== 'string') {
        return null;
    }

    const cleaned = value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();

    return cleaned ? cleaned.slice(0, maxLength) : null;
}

function sanitizeClientId(value) {
    return typeof value === 'string' && CLIENT_ID_PATTERN.test(value) ? value : null;
}

function sanitizeRoomId(value) {
    return typeof value === 'string' && ROOM_ID_PATTERN.test(value) ? value.slice(0, MAX_ROOM_ID_LENGTH) : null;
}

function sanitizeColor(value, fallbackSeed) {
    if (typeof value === 'string' && COLOR_PATTERN.test(value)) {
        return value.toLowerCase();
    }

    const seed = typeof fallbackSeed === 'string' ? fallbackSeed : String(fallbackSeed ?? '');
    let hash = 0;
    for (const char of seed) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return NAME_COLORS[hash % NAME_COLORS.length];
}

function send(ws, payload) {
    if (ws && ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify(payload));
        } catch {
            // socket died mid-send; the close handler will clean it up
        }
    }
}

function broadcast(room, payload, { except = null } = {}) {
    for (const socket of room.members.keys()) {
        if (socket !== except) {
            send(socket, payload);
        }
    }
}

function membersList(room) {
    return [...room.members.values()].map(member => ({
        clientId: member.clientId,
        name: member.name,
        color: member.color,
        joinedAt: member.joinedAt,
    }));
}

function listRooms() {
    return [...rooms.values()].map(room => ({
        id: room.id,
        createdAt: room.createdAt,
        members: room.members.size,
    }));
}

/**
 * Removes a socket from its current room, notifying remaining members.
 * @param {any} ws The socket leaving its room
 * @returns {void}
 */
function leaveRoom(ws) {
    const room = ws.room;
    if (!room || !ws.member) {
        return;
    }

    room.members.delete(ws);
    broadcast(room, { type: 'member_left', room: room.id, clientId: ws.member.clientId });
    broadcast(room, { type: 'system', room: room.id, text: `${ws.member.name} 离开了房间`, ts: Date.now() });
    broadcast(room, { type: 'members', room: room.id, members: membersList(room) });

    ws.room = null;
    ws.member = null;

    if (room.members.size === 0) {
        rooms.delete(room.id);
    }
}

/**
 * Sends the current room roster to everyone in the room.
 * @param {Room} room Target room
 * @returns {void}
 */
function pushMembers(room) {
    broadcast(room, { type: 'members', room: room.id, members: membersList(room) });
}

function removeConnection(ws) {
    leaveRoom(ws);
}

/**
 * Enforces a simple sliding-window rate limit per connection.
 * @param {any} ws The socket sending messages
 * @returns {boolean} True when the message is allowed
 */
function isRateLimited(ws) {
    const now = Date.now();
    ws.rateTokens = (ws.rateTokens ?? []).filter(ts => now - ts < RATE_WINDOW_MS);

    if (ws.rateTokens.length >= RATE_MAX_MESSAGES) {
        return true;
    }

    ws.rateTokens.push(now);
    return false;
}

function handleJoin(ws, payload) {
    const roomId = sanitizeRoomId(payload?.room) ?? 'lobby';

    if (ws.room && ws.room.id === roomId) {
        return;
    }

    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
        send(ws, { type: 'error', message: '服务器房间数量已达上限，请稍后再试' });
        return;
    }

    const room = rooms.get(roomId) ?? createRoom(roomId);

    if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
        send(ws, { type: 'error', message: `房间 ${roomId} 人数已满（${MAX_MEMBERS_PER_ROOM} 人）` });
        return;
    }

    const clientId = sanitizeClientId(payload?.clientId) ?? crypto.randomUUID();
    const name = sanitizeText(payload?.name, MAX_NAME_LENGTH) ?? `访客-${clientId.slice(0, 4)}`;
    const color = sanitizeColor(payload?.color, clientId);

    leaveRoom(ws);

    rooms.set(roomId, room);
    ws.room = room;
    ws.member = { clientId, name, color, joinedAt: Date.now() };
    room.members.set(ws, ws.member);

    send(ws, {
        type: 'joined',
        room: room.id,
        self: { clientId, name, color },
        members: membersList(room),
        history: room.history.slice(-HISTORY_LIMIT),
    });

    broadcast(room, { type: 'member_joined', room: room.id, member: { clientId, name, color } }, { except: ws });
    broadcast(room, { type: 'system', room: room.id, text: `${name} 加入了房间`, ts: Date.now() }, { except: ws });
    pushMembers(room);
}

function handleChat(ws, payload) {
    if (!ws.room || !ws.member) {
        send(ws, { type: 'error', message: '请先加入房间后再发言' });
        return;
    }

    if (isRateLimited(ws)) {
        send(ws, { type: 'error', message: '发言太快了，请稍作休息' });
        return;
    }

    const text = sanitizeText(payload?.text, MAX_MESSAGE_LENGTH);
    if (!text) {
        return;
    }

    const message = {
        id: newMessageId(),
        room: ws.room.id,
        from: {
            clientId: ws.member.clientId,
            name: ws.member.name,
            color: ws.member.color,
        },
        text,
        ts: Date.now(),
    };

    ws.room.history.push(message);
    if (ws.room.history.length > HISTORY_LIMIT) {
        ws.room.history.splice(0, ws.room.history.length - HISTORY_LIMIT);
    }

    broadcast(ws.room, { type: 'chat', ...message });
}

function handleRename(ws, payload) {
    if (!ws.room || !ws.member) {
        send(ws, { type: 'error', message: '请先加入房间' });
        return;
    }

    const name = sanitizeText(payload?.name, MAX_NAME_LENGTH);
    if (!name || name === ws.member.name) {
        return;
    }

    const oldName = ws.member.name;
    ws.member.name = name;
    broadcast(ws.room, { type: 'system', room: ws.room.id, text: `${oldName} 改名为 ${name}`, ts: Date.now() });
    pushMembers(ws.room);
}

function handleTyping(ws, payload) {
    if (!ws.room || !ws.member) {
        return;
    }

    broadcast(ws.room, {
        type: 'typing',
        room: ws.room.id,
        clientId: ws.member.clientId,
        name: ws.member.name,
        active: payload?.active === true,
    }, { except: ws });
}

function onMessage(ws, raw) {
    let payload;
    try {
        payload = JSON.parse(String(raw));
    } catch {
        send(ws, { type: 'error', message: '无效的消息格式' });
        return;
    }

    switch (payload?.type) {
        case 'join':
            handleJoin(ws, payload);
            break;
        case 'chat':
            handleChat(ws, payload);
            break;
        case 'rename':
            handleRename(ws, payload);
            break;
        case 'typing':
            handleTyping(ws, payload);
            break;
        case 'ping':
            send(ws, { type: 'pong', ts: Date.now() });
            break;
        case 'leave':
            leaveRoom(ws);
            break;
        default:
            send(ws, { type: 'error', message: '未知的消息类型' });
    }
}

function handleConnection(ws) {
    ws.isAlive = true;
    ws.room = null;
    ws.member = null;

    ws.on('pong', () => {
        ws.isAlive = true;
    });
    ws.on('message', raw => {
        try {
            onMessage(ws, raw);
        } catch (error) {
            console.error('SillyRoom: failed to handle message', error);
        }
    });
    ws.on('close', () => {
        try {
            removeConnection(ws);
        } catch (error) {
            console.error('SillyRoom: failed to clean up connection', error);
        }
    });
    ws.on('error', () => {
        try {
            ws.terminate();
        } catch {
            // already gone
        }
    });

    send(ws, { type: 'hello', rooms: listRooms(), limits: { maxMessageLength: MAX_MESSAGE_LENGTH, maxMembersPerRoom: MAX_MEMBERS_PER_ROOM } });
}

function heartbeat() {
    if (!wss) {
        return;
    }

    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch {
            // ignore
        }
    }
}

/**
 * Plugin entry: registers REST routes under /api/plugins/sillyroom.
 * @param {import('express').Router} router Express router mounted by the plugin loader
 * @returns {void}
 */
export function init(router) {
    router.get('/status', (_request, response) => {
        response.json({
            ok: true,
            plugin: info.id,
            rooms: listRooms(),
            connections: wss ? wss.clients.size : 0,
        });
    });
}

/**
 * Socket entry (called by plugin-loader's initPluginSockets once the HTTP servers listen).
 * Attaches the WebSocket upgrade handler to every listening server.
 * @param {import('node:http').Server[]} servers Listening HTTP(S) servers
 * @returns {void}
 */
export function initSocket(servers) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    wss.on('connection', handleConnection);

    for (const server of servers) {
        const listener = (request, socket, head) => {
            let pathname = '/';
            try {
                pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
            } catch {
                // malformed request URL; fall through to destroy
            }

            if (pathname === WS_PATH) {
                wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
            } else if (server.listenerCount('upgrade') <= 1) {
                // Nobody else is going to handle this upgrade request
                socket.destroy();
            }
        };

        server.on('upgrade', listener);
        upgradeListeners.push({ server, listener });
    }

    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    console.log(`SillyRoom: WebSocket endpoint ready at ${WS_PATH}`);
}

/**
 * Plugin exit hook: stop the heartbeat, detach listeners, close all sockets.
 * @returns {void}
 */
export function exit() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    for (const { server, listener } of upgradeListeners) {
        server.removeListener('upgrade', listener);
    }
    upgradeListeners.length = 0;

    if (wss) {
        for (const ws of wss.clients) {
            try {
                ws.close(1001, 'server shutting down');
            } catch {
                ws.terminate();
            }
        }
        wss.close();
        wss = null;
    }

    rooms.clear();
}
