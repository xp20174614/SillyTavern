import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import cookieSession from 'cookie-session';
import storage from 'node-persist';
import { WebSocketServer } from 'ws';

// P1-2: reuse the main app's session building blocks so WebSocket upgrades can
// be authenticated against the very same signed session cookie. These modules
// are already loaded by the server, so importing them adds no side effects.
import { SETTINGS_FILE } from '../../src/constants.js';
import { getConfigValue } from '../../src/util.js';
import { getCookieSecret, getCookieSessionName, getUserDirectories, toKey } from '../../src/users.js';

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

// P3-2: operational limits are parameterized via SILLYROOM_* environment
// variables so deployments can tune them without code changes. Values are
// clamped to sane bounds; missing or invalid input falls back to the default.
function envLimit(name, defaultValue, min, max) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') {
        return defaultValue;
    }

    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed)) {
        console.warn(`SillyRoom: invalid ${name}="${raw}", falling back to default ${defaultValue}`);
        return defaultValue;
    }

    return Math.min(max, Math.max(min, parsed));
}

const MAX_MESSAGE_LENGTH = envLimit('SILLYROOM_MAX_MESSAGE_CHARS', 2000, 100, 20000);
const MAX_NAME_LENGTH = envLimit('SILLYROOM_MAX_NAME_CHARS', 24, 1, 64);
const MAX_ROOM_ID_LENGTH = 32; // format contract shared with the persisted-file naming, kept fixed
const MAX_MEMBERS_PER_ROOM = envLimit('SILLYROOM_MAX_MEMBERS', 32, 2, 256);
const MAX_ROOMS = envLimit('SILLYROOM_MAX_ROOMS', 100, 1, 1000);
const HISTORY_LIMIT = envLimit('SILLYROOM_HISTORY_LIMIT', 50, 1, 500);
// P2-1: room history persists to <DATA_ROOT>/sillyroom/rooms/<roomId>.json so
// chat survives restarts. Rooms are account-agnostic shared entities, so the
// history lives in a shared folder rather than any per-user directory.
const HISTORY_FLUSH_DEBOUNCE_MS = 1500;
const RATE_WINDOW_MS = envLimit('SILLYROOM_RATE_LIMIT_WINDOW_MS', 5000, 1000, 600000);
const RATE_MAX_MESSAGES = envLimit('SILLYROOM_RATE_LIMIT_MAX', 15, 1, 1000);
const HEARTBEAT_INTERVAL_MS = envLimit('SILLYROOM_HEARTBEAT_INTERVAL_MS', 30000, 5000, 600000);
const MAX_FRAME_BYTES = envLimit('SILLYROOM_MAX_FRAME_BYTES', 64 * 1024, 4096, 1024 * 1024);

// P3-2: cross-site WebSocket hijacking guard. Browsers always attach an Origin
// header to WebSocket handshakes; a malicious page must not be able to open a
// socket to this endpoint riding on the visitor's cookies. Non-browser clients
// (curl, integration tests, custom tools) send no Origin and stay unaffected.
// SILLYROOM_ALLOWED_ORIGINS (comma-separated) adds exceptions for reverse-proxy
// deployments where the externally visible origin differs from the internal
// Host header; "*" allows everything (discouraged, logged as such at startup).
const ALLOWED_ORIGINS = String(process.env.SILLYROOM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);

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

/** @type {Map<string, NodeJS.Timeout>} P2-1 pending debounced history writes, keyed by room id */
const roomFlushTimers = new Map();

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
 * @property {string|null} ownerClientId P3-1a first joiner owns the room; on leave it passes to the earliest remaining member. Memory-only (not persisted)
 * @property {Set<string>} muted P3-1a clientIds muted by the owner; cleared when the member leaves or the room unloads. Memory-only
 * @property {Map<any, Member>} members Keyed by the socket owning the membership
 * @property {Array<object>} history Recent chat messages
 */

function createRoom(id) {
    return {
        id,
        createdAt: Date.now(),
        ownerClientId: null,
        muted: new Set(),
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

/**
 * P2-2: opaque delivery-correlation token echoed back with the broadcast so a
 * client can match its own offline-queued sends to the confirmed copy.
 */
function sanitizeNonce(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return cleaned || null;
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
 * @param {{by: string}|null} kickInfo P3-1a: when set, the removal is a owner
 * kick and the room is told so (system key member_kicked) instead of a plain leave
 * @returns {void}
 */
function leaveRoom(ws, kickInfo = null) {
    const room = ws.room;
    if (!room || !ws.member) {
        return;
    }

    const { clientId, name } = ws.member;
    room.members.delete(ws);
    // P3-1a: a departed member's mute no longer applies to them
    room.muted.delete(clientId);

    // P3-1a: ownership passes to the earliest remaining member (null when empty)
    if (room.ownerClientId === clientId) {
        const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        room.ownerClientId = next?.clientId ?? null;
    }

    broadcast(room, { type: 'member_left', room: room.id, clientId });
    // P2-3: key+args let clients localize the event in their own UI language;
    // text (Chinese) stays as the legacy/fallback rendering.
    const system = kickInfo
        ? { key: 'member_kicked', args: { name, by: kickInfo.by }, text: `${kickInfo.by} 将 ${name} 移出了房间` }
        : { key: 'member_left', args: { name }, text: `${name} 离开了房间` };
    broadcast(room, { type: 'system', room: room.id, ...system, ts: Date.now() });
    pushMembers(room);

    ws.room = null;
    ws.member = null;

    if (room.members.size === 0) {
        // P2-1: the room leaves memory here — flush its history right away
        // instead of waiting out the debounce window.
        cancelRoomFlush(room.id);
        void flushRoomNow(room);
        rooms.delete(room.id);
    }
}

/**
 * Sends the current room roster to everyone in the room. P3-1a: the payload
 * also carries the owner and the muted set so clients can badge chips.
 * @param {Room} room Target room
 * @returns {void}
 */
function pushMembers(room) {
    broadcast(room, {
        type: 'members',
        room: room.id,
        owner: room.ownerClientId,
        muted: [...room.muted],
        members: membersList(room),
    });
}

/**
 * P3-1a: finds a room member by clientId.
 * @param {Room} room Target room
 * @param {string|null} clientId Client id to look up
 * @returns {{socket: any, member: Member}|null}
 */
function findMember(room, clientId) {
    if (!clientId) {
        return null;
    }
    for (const [socket, member] of room.members) {
        if (member.clientId === clientId) {
            return { socket, member };
        }
    }
    return null;
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

// --- P2-1: room history persistence -----------------------------------------

function roomsDir() {
    return path.join(globalThis.DATA_ROOT ?? 'data', 'sillyroom', 'rooms');
}

function roomFilePath(roomId) {
    // roomId matches ROOM_ID_PATTERN, so it is safe to embed in a filename
    return path.join(roomsDir(), `${roomId}.json`);
}

function roomSnapshot(room) {
    return JSON.stringify({ id: room.id, savedAt: Date.now(), messages: room.history });
}

/**
 * Validates a message loaded from disk with the same rules as live messages;
 * anything malformed is dropped instead of poisoning the replay.
 */
function sanitizePersistedMessage(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : null;
    const text = typeof raw.text === 'string' && raw.text ? raw.text.slice(0, MAX_MESSAGE_LENGTH) : null;
    const from = raw.from && typeof raw.from === 'object' ? raw.from : null;

    if (!id || !text || !from) {
        return null;
    }

    return {
        id,
        from: {
            clientId: sanitizeClientId(from.clientId) ?? 'unknown',
            name: sanitizeText(from.name, MAX_NAME_LENGTH) ?? '???',
            color: sanitizeColor(from.color, from.clientId ?? ''),
        },
        ...(raw.kind === 'ai' ? { kind: 'ai' } : {}),
        text,
        ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    };
}

/**
 * Preloads persisted history when a room is (re)created in memory. Sync and
 * capped; a missing or corrupt file just means an empty history.
 * @param {Room} room Freshly created room object
 */
function loadRoomHistory(room) {
    try {
        const data = JSON.parse(fs.readFileSync(roomFilePath(room.id), 'utf8'));
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        room.history = messages
            .map(sanitizePersistedMessage)
            .filter(Boolean)
            .slice(-HISTORY_LIMIT);
        for (const message of room.history) {
            message.room = room.id;
        }
    } catch {
        // no file yet or unreadable; start with an empty history
    }
}

/**
 * Writes a room's history to disk atomically (tmp file + rename). Rooms with
 * no messages are skipped — there is nothing worth restoring.
 * @param {Room} room Room to persist
 * @returns {Promise<void>}
 */
async function flushRoomNow(room) {
    roomFlushTimers.delete(room.id);

    if (!room.history.length) {
        return;
    }

    try {
        const filePath = roomFilePath(room.id);
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, roomSnapshot(room), 'utf8');
        await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
        console.error('SillyRoom: failed to persist room history', error);
    }
}

/**
 * Debounces history writes so a message burst hits the disk once.
 * @param {Room} room Room that just received a message
 */
function scheduleRoomFlush(room) {
    if (roomFlushTimers.has(room.id)) {
        return;
    }

    const timer = setTimeout(() => {
        roomFlushTimers.delete(room.id);
        void flushRoomNow(room);
    }, HISTORY_FLUSH_DEBOUNCE_MS);
    timer.unref?.();
    roomFlushTimers.set(room.id, timer);
}

function cancelRoomFlush(roomId) {
    const timer = roomFlushTimers.get(roomId);
    if (timer) {
        clearTimeout(timer);
        roomFlushTimers.delete(roomId);
    }
}

/**
 * P2-1 shutdown path: flush every occupied room's history synchronously so a
 * server stop cannot lose the last debounce window of messages.
 */
function persistRoomsSync() {
    for (const room of rooms.values()) {
        if (!room.history.length) {
            continue;
        }
        try {
            const filePath = roomFilePath(room.id);
            const tmpPath = `${filePath}.tmp`;
            fs.writeFileSync(tmpPath, roomSnapshot(room), 'utf8');
            fs.renameSync(tmpPath, filePath);
        } catch (error) {
            console.error('SillyRoom: failed to persist room history on exit', error);
        }
    }
}

function handleJoin(ws, payload) {
    const roomId = sanitizeRoomId(payload?.room) ?? 'lobby';

    if (ws.room && ws.room.id === roomId) {
        return;
    }

    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
        send(ws, { type: 'error', key: 'err_rooms_limit', message: '服务器房间数量已达上限，请稍后再试' });
        return;
    }

    let room = rooms.get(roomId);
    if (!room) {
        room = createRoom(roomId);
        // P2-1: a room unknown to this process may still have persisted history
        // from a previous run — reload it so the join replay includes it.
        loadRoomHistory(room);
    }

    if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
        send(ws, { type: 'error', key: 'err_room_full', args: { room: roomId, max: MAX_MEMBERS_PER_ROOM }, message: `房间 ${roomId} 人数已满（${MAX_MEMBERS_PER_ROOM} 人）` });
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

    // P3-1a: the first member of a (re)created room becomes its owner; later
    // joiners never steal ownership while the owner is present
    if (!room.ownerClientId) {
        room.ownerClientId = clientId;
    }

    send(ws, {
        type: 'joined',
        room: room.id,
        self: { clientId, name, color },
        owner: room.ownerClientId,
        muted: [...room.muted],
        members: membersList(room),
        history: room.history.slice(-HISTORY_LIMIT),
    });

    broadcast(room, { type: 'member_joined', room: room.id, member: { clientId, name, color } }, { except: ws });
    broadcast(room, { type: 'system', room: room.id, key: 'member_joined', args: { name }, text: `${name} 加入了房间`, ts: Date.now() }, { except: ws });
    pushMembers(room);
}

function handleChat(ws, payload) {
    if (!ws.room || !ws.member) {
        send(ws, { type: 'error', key: 'err_not_in_room', message: '请先加入房间后再发言' });
        return;
    }

    // P3-1a: muted members may lurk and type but their messages are refused
    if (ws.room.muted.has(ws.member.clientId)) {
        send(ws, { type: 'error', key: 'err_muted', message: '你已被禁言，无法发言' });
        return;
    }

    if (isRateLimited(ws)) {
        send(ws, { type: 'error', key: 'err_rate_limited', message: '发言太快了，请稍作休息' });
        return;
    }

    const text = sanitizeText(payload?.text, MAX_MESSAGE_LENGTH);
    if (!text) {
        return;
    }

    // P2-2: echo the caller's nonce so offline-queued messages can be matched
    // to their server confirmation (delivery acknowledgment, not security)
    const nonce = sanitizeNonce(payload?.nonce);

    const message = {
        id: newMessageId(),
        room: ws.room.id,
        from: {
            clientId: ws.member.clientId,
            name: ws.member.name,
            color: ws.member.color,
        },
        // kind 'ai' marks an AI reply relayed by a member; clients must not
        // inject it back into their own ST chat (loop protection)
        ...(payload?.kind === 'ai' ? { kind: 'ai' } : {}),
        ...(nonce ? { nonce } : {}),
        text,
        ts: Date.now(),
    };

    ws.room.history.push(message);
    if (ws.room.history.length > HISTORY_LIMIT) {
        ws.room.history.splice(0, ws.room.history.length - HISTORY_LIMIT);
    }

    // P2-1: persist the new message (debounced so bursts write once)
    scheduleRoomFlush(ws.room);

    broadcast(ws.room, { type: 'chat', ...message });
}

function handleRename(ws, payload) {
    if (!ws.room || !ws.member) {
        send(ws, { type: 'error', key: 'err_not_in_room', message: '请先加入房间' });
        return;
    }

    const name = sanitizeText(payload?.name, MAX_NAME_LENGTH);
    if (!name || name === ws.member.name) {
        return;
    }

    const oldName = ws.member.name;
    ws.member.name = name;
    broadcast(ws.room, { type: 'system', room: ws.room.id, key: 'member_renamed', args: { oldName, name }, text: `${oldName} 改名为 ${name}`, ts: Date.now() });
    pushMembers(ws.room);
}

/**
 * P3-1a: room-owner moderation. Only the owner may kick; the owner cannot
 * target themselves (leaving is the owner's own way out). The kicked socket is
 * told first (type 'kicked'), then removed like any leaver — the room sees a
 * member_kicked system event instead of a plain member_left.
 * @param {any} ws The owner's socket
 * @param {object} payload {clientId}
 * @returns {void}
 */
function handleKick(ws, payload) {
    const room = ws.room;
    if (!room || !ws.member) {
        return;
    }

    if (room.ownerClientId !== ws.member.clientId) {
        send(ws, { type: 'error', key: 'err_not_owner', message: '只有房主可以移出成员' });
        return;
    }

    const target = findMember(room, sanitizeClientId(payload?.clientId));
    if (!target || target.member.clientId === ws.member.clientId) {
        send(ws, { type: 'error', key: 'err_bad_target', message: '目标成员不在房间中' });
        return;
    }

    send(target.socket, { type: 'kicked', room: room.id, by: ws.member.name });
    leaveRoom(target.socket, { by: ws.member.name });
}

/**
 * P3-1a: toggles a member's mute. Mutes are room-scoped and memory-only; they
 * end when the member leaves, the owner lifts them, or the room unloads.
 * @param {any} ws The owner's socket
 * @param {object} payload {clientId, muted}
 * @returns {void}
 */
function handleMute(ws, payload) {
    const room = ws.room;
    if (!room || !ws.member) {
        return;
    }

    if (room.ownerClientId !== ws.member.clientId) {
        send(ws, { type: 'error', key: 'err_not_owner', message: '只有房主可以禁言成员' });
        return;
    }

    const target = findMember(room, sanitizeClientId(payload?.clientId));
    const muted = payload?.muted === true;
    if (!target || target.member.clientId === ws.member.clientId) {
        send(ws, { type: 'error', key: 'err_bad_target', message: '目标成员不在房间中' });
        return;
    }

    if (muted) {
        room.muted.add(target.member.clientId);
    } else {
        room.muted.delete(target.member.clientId);
    }

    const key = muted ? 'member_muted' : 'member_unmuted';
    const text = muted
        ? `${ws.member.name} 禁言了 ${target.member.name}`
        : `${ws.member.name} 解除了 ${target.member.name} 的禁言`;
    broadcast(room, { type: 'system', room: room.id, key, args: { name: target.member.name, by: ws.member.name }, text, ts: Date.now() });
    pushMembers(room);
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

/**
 * P1-2: best-effort display name for the logged-in account — the default
 * Persona's name when one is set, else the account's own name. Sent to the
 * client as a suggestion only; a locally customized nickname still wins.
 * @param {object} user User account record from storage
 * @param {object} directories User directory listing
 * @returns {string|null} Suggested nickname or null when nothing usable
 */
function resolveAccountDisplayName(user, directories) {
    try {
        const settingsPath = path.join(directories.root, SETTINGS_FILE);
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const powerUser = settings?.power_user;
            const personaName = powerUser?.default_persona
                ? powerUser?.personas?.[powerUser.default_persona]
                : null;
            if (typeof personaName === 'string' && personaName.trim()) {
                return sanitizeText(personaName, MAX_NAME_LENGTH);
            }
        }
    } catch {
        // unreadable settings.json; fall back to the account name
    }

    return sanitizeText(user?.name, MAX_NAME_LENGTH);
}

function originHostKey(hostname, port, defaultPort) {
    const normalizedPort = port === '' ? defaultPort : Number(port);
    return `${String(hostname).toLowerCase()}:${normalizedPort}`;
}

/**
 * P3-2: decides whether an upgrade request's Origin is acceptable — the guard
 * against cross-site WebSocket hijacking (a hostile page opening a socket with
 * the visitor's browser and cookies). Allowed when any of:
 *   1. no Origin header (non-browser client),
 *   2. allowlist contains "*",
 *   3. Origin hits SILLYROOM_ALLOWED_ORIGINS (exact origins or bare host[:port];
 *      a bare host matches any port on that host),
 *   4. Origin is same-origin with the request's Host header. Comparison is on
 *      host:port with protocol default ports implied (http→80, https→443). A
 *      Host header without a port means the request arrived via a default-port
 *      path (direct :80/:443 or a TLS-terminating proxy), so either default is
 *      accepted in that case.
 * @param {import('node:http').IncomingMessage} request The HTTP upgrade request
 * @returns {{allowed: boolean, reason: string}} Rejection reasons are stable identifiers for the log
 */
function isOriginAllowed(request) {
    const originHeader = String(request.headers.origin ?? '').trim();
    if (!originHeader) {
        return { allowed: true, reason: 'no-origin' };
    }

    if (ALLOWED_ORIGINS.includes('*')) {
        return { allowed: true, reason: 'allow-all' };
    }

    let originKey = null;
    try {
        const url = new URL(originHeader);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return { allowed: false, reason: 'unsupported-origin-scheme' };
        }
        originKey = originHostKey(url.hostname, url.port, url.protocol === 'https:' ? 443 : 80);
    } catch {
        return { allowed: false, reason: 'malformed-origin' };
    }

    for (const entry of ALLOWED_ORIGINS) {
        try {
            // Bare-host entries (no scheme) match any port on that host;
            // entries with a scheme pin the port (default per scheme when omitted)
            const hasScheme = entry.includes('://');
            const url = new URL(hasScheme ? entry : `http://${entry}`);
            if (!url.hostname) {
                continue;
            }
            if (!hasScheme && url.port === '') {
                if (originKey.startsWith(`${url.hostname.toLowerCase()}:`)) {
                    return { allowed: true, reason: 'allowlisted' };
                }
            } else if (originHostKey(url.hostname, url.port, url.protocol === 'https:' ? 443 : 80) === originKey) {
                return { allowed: true, reason: 'allowlisted' };
            }
        } catch {
            // malformed allowlist entry; ignore it
        }
    }

    const hostHeader = String(request.headers.host ?? '').trim();
    if (!hostHeader) {
        return { allowed: false, reason: 'missing-host-header' };
    }

    try {
        // Parsed via URL for IPv6-literal Host headers; scheme is irrelevant
        // (browsers cannot mix ws/wss across schemes due to mixed-content rules)
        const hostUrl = new URL(`http://${hostHeader}`);
        if (hostUrl.hostname && hostUrl.port === '') {
            const [originHost, originPort] = originKey.split(':');
            const matchesDefaultPortPath = originHost === hostUrl.hostname.toLowerCase() && (originPort === '80' || originPort === '443');
            return matchesDefaultPortPath
                ? { allowed: true, reason: 'same-origin' }
                : { allowed: false, reason: 'cross-origin' };
        }

        return originHostKey(hostUrl.hostname, hostUrl.port, 80) === originKey
            ? { allowed: true, reason: 'same-origin' }
            : { allowed: false, reason: 'cross-origin' };
    } catch {
        return { allowed: false, reason: 'malformed-host-header' };
    }
}

/**
 * P1-2: verifies that an upgrade request carries a valid SillyTavern login
 * session. Runs the same cookie-session middleware as the main app against a
 * stub response (verification only — nothing is ever written back), then
 * mirrors setUserDataMiddleware's checks: session handle → account exists →
 * account enabled.
 * @param {import('node:http').IncomingMessage} request The HTTP upgrade request
 * @param {Function} middleware cookie-session middleware built in initSocket
 * @returns {Promise<{ok: boolean, reason?: string, handle?: string, suggestedName?: string|null}>}
 */
function authenticateUpgrade(request, middleware) {
    return new Promise(resolve => {
        // on-headers only wraps response.writeHead and the commit callback
        // fires solely when headers are written; a bare stub never commits.
        const stubResponse = {
            writeHead() { },
            setHeader() { },
            getHeader() { return undefined; },
            appendHeader() { },
            end() { },
        };

        let settled = false;
        const finish = result => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                resolve(result);
            }
        };

        // Safety net: never leave an upgrade hanging on a stalled storage read
        const timeout = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 5000);
        timeout.unref?.();

        try {
            middleware(request, stubResponse, async () => {
                try {
                    const handle = request.session?.handle;
                    if (typeof handle !== 'string' || !handle) {
                        return finish({ ok: false, reason: 'not-logged-in' });
                    }

                    const user = await storage.getItem(toKey(handle));
                    if (!user || user.enabled === false) {
                        return finish({ ok: false, reason: 'unknown-or-disabled-account' });
                    }

                    finish({
                        ok: true,
                        handle,
                        suggestedName: resolveAccountDisplayName(user, getUserDirectories(handle)),
                    });
                } catch {
                    finish({ ok: false, reason: 'session-lookup-failed' });
                }
            });
        } catch {
            finish({ ok: false, reason: 'session-parse-failed' });
        }
    });
}

function onMessage(ws, raw) {
    let payload;
    try {
        payload = JSON.parse(String(raw));
    } catch {
        send(ws, { type: 'error', key: 'err_bad_message', message: '无效的消息格式' });
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
        case 'kick':
            handleKick(ws, payload);
            break;
        case 'mute':
            handleMute(ws, payload);
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
            send(ws, { type: 'error', key: 'err_unknown_type', message: '未知的消息类型' });
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

    // P1-2: account identity hint for multi-user mode (client uses
    // suggestedName as the default nickname unless a custom one is stored)
    const identity = ws.auth
        ? { authenticated: true, handle: ws.auth.handle, suggestedName: ws.auth.suggestedName }
        : { authenticated: false };

    send(ws, { type: 'hello', rooms: listRooms(), limits: { maxMessageLength: MAX_MESSAGE_LENGTH, maxMembersPerRoom: MAX_MEMBERS_PER_ROOM }, identity });
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
    // P2-1: make sure the history storage directory exists before any write
    try {
        fs.mkdirSync(roomsDir(), { recursive: true });
    } catch (error) {
        console.error('SillyRoom: failed to create history directory', error);
    }

    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    wss.on('connection', handleConnection);

    // P1-2: build a session verifier identical to the main app's. Verification
    // only reads the signed cookie, so the name + secret suffice; maxAge and
    // sameSite only matter when writing, which never happens on a stub.
    let sessionMiddleware = null;
    if (getConfigValue('enableUserAccounts', false, 'boolean')) {
        sessionMiddleware = cookieSession({
            name: getCookieSessionName(),
            secret: getCookieSecret(globalThis.DATA_ROOT),
        });
    }

    for (const server of servers) {
        const listener = (request, socket, head) => {
            let pathname = '/';
            try {
                pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
            } catch {
                // malformed request URL; fall through to destroy
            }

            if (pathname === WS_PATH) {
                // P3-2: origin check runs before anything else — it is cheap
                // and must gate even the session-authenticated path
                const originCheck = isOriginAllowed(request);
                if (!originCheck.allowed) {
                    console.log(`SillyRoom: rejected WebSocket upgrade (${originCheck.reason}) origin="${String(request.headers.origin ?? '').slice(0, 200)}"`);
                    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                    socket.destroy();
                    return;
                }

                if (!sessionMiddleware) {
                    // Single-user mode: no login requirement, behave as before
                    wss.handleUpgrade(request, socket, head, ws => {
                        ws.auth = null;
                        wss.emit('connection', ws, request);
                    });
                    return;
                }

                authenticateUpgrade(request, sessionMiddleware).then(auth => {
                    if (!auth.ok) {
                        console.log(`SillyRoom: rejected WebSocket upgrade (${auth.reason ?? 'unauthenticated'})`);
                        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    wss.handleUpgrade(request, socket, head, ws => {
                        ws.auth = auth;
                        wss.emit('connection', ws, request);
                    });
                });
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

    const authMode = sessionMiddleware ? 'session authentication enforced' : 'no authentication (single-user mode)';
    const originPolicy = ALLOWED_ORIGINS.includes('*')
        ? 'origins: allow-all (*)'
        : ALLOWED_ORIGINS.length
            ? `origins: same-origin + ${ALLOWED_ORIGINS.length} allowlisted`
            : 'origins: same-origin only';
    console.log(`SillyRoom: WebSocket endpoint ready at ${WS_PATH} (${authMode}, ${originPolicy}), history persisted in ${roomsDir()}`);
    console.log(`SillyRoom: limits — messages ${RATE_MAX_MESSAGES}/${Math.round(RATE_WINDOW_MS / 1000)}s, ${MAX_MESSAGE_LENGTH} chars/msg, ${MAX_MEMBERS_PER_ROOM} members/room, ${MAX_ROOMS} rooms, history ${HISTORY_LIMIT}, frame ${MAX_FRAME_BYTES} B`);
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

    // P2-1: drop pending debounces and flush occupied rooms synchronously —
    // after this point the process may be gone, so nothing async is safe.
    for (const timer of roomFlushTimers.values()) {
        clearTimeout(timer);
    }
    roomFlushTimers.clear();
    persistRoomsSync();

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
