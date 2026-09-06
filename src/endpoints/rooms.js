import path from 'node:path';
import fs from 'node:fs';
import storage from 'node-persist';
import express from 'express';
import { randomUUID } from 'node:crypto';

import { parse as parseCharacterCard } from '../character-card-parser.js';
import { getConfigValue } from '../util.js';
import { KEY_PREFIX, getUserDirectories } from '../users.js';

/**
 * @typedef {{ id: string, name: string, ownerHandle?: string, avatar: string, systemPrompt: string, autoReply: boolean }} RoomNpc
 * @typedef {{ id: string, role: 'user'|'assistant', actorId: string, actorName: string, text: string, createdAt: number }} RoomMessage
 * @typedef {'invite'|'public'} RoomVisibility
 * @typedef {{ id: string, name: string, createdAt: number, ownerHandle: string, visibility: RoomVisibility, users: Set<string>, npcs: RoomNpc[], messages: RoomMessage[] }} RoomState
 */

const NPC_API_BASE = getConfigValue('roomService.npcApiBase', 'http://10.55.119.229:8001/v1', 'string');
const NPC_MODEL = getConfigValue('roomService.npcModel', '/ssd3/models/Minimax-M2.5-BF16-MoE-AWQ-INT4-richcalib-no-w3w2', 'string');
const MAX_HISTORY = getConfigValue('roomService.maxHistory', 24, 'number');
const MAX_MESSAGES = getConfigValue('roomService.maxMessages', 400, 'number');
const ALLOW_CROSS_USER_NPC = getConfigValue('roomService.allowCrossUserNpc', true, 'boolean');

/** @type {Map<string, RoomState>} */
const rooms = new Map();
/** @type {Set<string>} */
const roomNpcBusy = new Set();

export const router = express.Router();

function normalizeText(value) {
    return String(value ?? '').trim();
}

function makeRoomId() {
    return randomUUID().split('-')[0];
}

function toView(room) {
    return {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        ownerHandle: room.ownerHandle,
        visibility: room.visibility,
        users: [...room.users],
        npcs: room.npcs,
        messages: room.messages.slice(-100),
    };
}

async function userExists(handle) {
    const user = await storage.getItem(toKey(handle));
    return !!(user && user.enabled);
}

async function listEnabledUsers() {
    const result = [];
    const users = await storage.values((x) => x.key.startsWith(KEY_PREFIX));
    for (const user of users) {
        if (!user?.enabled || !user?.handle) continue;
        result.push({
            handle: user.handle,
            name: normalizeText(user.name) || user.handle,
            created: user.created,
            avatar: user.avatar,
            admin: !!user.admin,
        });
    }
    return result;
}

function toKey(handle) {
    return `${KEY_PREFIX}${handle}`;
}

async function loadNpcFromCharacter(avatar, ownerHandle, fallbackName = '') {
    const directories = getUserDirectories(ownerHandle);
    const cardPath = path.join(directories.characters, avatar);
    const cardRaw = await parseCharacterCard(cardPath, 'png');
    const card = JSON.parse(cardRaw);
    const data = card.data || {};
    const npcName = normalizeText(data.name || card.name || fallbackName || avatar.replace(/\.png$/i, '')) || 'NPC';
    const promptParts = [
        `You are ${npcName}.`,
        normalizeText(data.description),
        normalizeText(data.personality),
        normalizeText(data.scenario),
        normalizeText(data.first_mes) ? `First message style: ${normalizeText(data.first_mes)}` : '',
        normalizeText(data.mes_example) ? `Dialogue style examples: ${normalizeText(data.mes_example)}` : '',
        normalizeText(data.system_prompt),
        normalizeText(data.post_history_instructions),
        'Only answer from this character perspective.',
        'If unknown, say you do not know.',
    ].filter(Boolean).join('\n');

    return {
        id: randomUUID(),
        name: npcName,
        ownerHandle,
        avatar,
        systemPrompt: promptParts,
        autoReply: true,
    };
}

function getRoomOr404(roomId, response) {
    const room = rooms.get(roomId);
    if (!room) {
        response.status(404).json({ error: 'Room not found' });
        return null;
    }
    return room;
}

function canAccessRoom(room, handle) {
    return room.users.has(handle);
}

function canDiscoverRoom(room, handle) {
    return room.visibility === 'public' || room.users.has(handle);
}

function canJoinRoom(room, handle) {
    if (room.users.has(handle)) return true;
    return room.visibility === 'public';
}

function canManageRoom(room, handle) {
    return room.users.has(handle);
}

function listCharacterCardsByUser(handle) {
    const directories = getUserDirectories(handle);
    let entries = [];
    try {
        entries = fs.readdirSync(directories.characters, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
        .map((entry) => ({
            ownerHandle: handle,
            avatar: entry.name,
            name: entry.name.replace(/\.png$/i, ''),
        }));
}

function pushMessage(room, msg) {
    room.messages.push(msg);
    if (room.messages.length > MAX_MESSAGES) {
        room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    }
}

function cleanNpcOutput(text) {
    const raw = normalizeText(text);
    if (!raw) return '';
    return raw
        .replace(/^\[[^\]\n]*actorId=[^\]\n]*\]:?\s*/gim, '')
        .replace(/^Speaker\([^\)\n]*actorId=[^\)\n]*\):?\s*/gim, '')
        .trim();
}

async function runNpcReply(room, npc, triggerMessage) {
    const busyKey = `${room.id}:${npc.id}`;
    if (roomNpcBusy.has(busyKey)) return;
    roomNpcBusy.add(busyKey);
    try {
        const memberProfiles = [...room.users].map((handle) => `- handle=${handle}`).join('\n');
        const context = room.messages.slice(-MAX_HISTORY).map((m) => ({
            role: m.role,
            content: `Speaker(role=${m.role}, actorId=${m.actorId}, actorName=${m.actorName}): ${m.text}`,
        }));
        const response = await fetch(`${NPC_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: NPC_MODEL,
                messages: [
                    { role: 'system', content: npc.systemPrompt },
                    {
                        role: 'system',
                        content: [
                            `Room ${room.id}.`,
                            'Identity policy:',
                            '- Distinguish participants by actorId/handle, not display name.',
                            '- If multiple users have similar names, rely on actorId.',
                            '- Keep replies concise and context-aware.',
                            '- Never output metadata prefixes such as actorId/role tags.',
                            '- Reply with natural dialogue only.',
                            'Known room user handles:',
                            memberProfiles || '- none',
                            `Latest trigger from actorId=${triggerMessage.actorId}, actorName=${triggerMessage.actorName}.`,
                        ].join('\n'),
                    },
                    ...context,
                ],
                max_tokens: 220,
                temperature: 0.7,
                stream: false,
            }),
        });
        if (!response.ok) return;
        const data = await response.json();
        const text = cleanNpcOutput(data?.choices?.[0]?.message?.content);
        if (!text) return;
        pushMessage(room, {
            id: randomUUID(),
            role: 'assistant',
            actorId: npc.id,
            actorName: npc.name,
            text,
            createdAt: Date.now(),
        });
    } catch {
        // Ignore NPC errors in MVP flow.
    } finally {
        roomNpcBusy.delete(busyKey);
    }
}

router.post('/create', async (request, response) => {
    try {
        const ownerHandle = request.user.profile.handle;
        const roomId = normalizeText(request.body?.roomId) || makeRoomId();
        if (rooms.has(roomId)) {
            return response.status(409).json({ error: 'Room already exists' });
        }

        const name = normalizeText(request.body?.name) || `Room-${roomId}`;
        /** @type {RoomVisibility} */
        const visibility = normalizeText(request.body?.visibility).toLowerCase() === 'public' ? 'public' : 'invite';
        /** @type {Set<string>} */
        const users = new Set([ownerHandle]);
        const invited = Array.isArray(request.body?.userHandles) ? request.body.userHandles : [];
        for (const rawHandle of invited) {
            const handle = normalizeText(rawHandle);
            if (!handle) continue;
            if (await userExists(handle)) users.add(handle);
        }

        /** @type {RoomNpc[]} */
        const npcs = [];
        const npcCards = Array.isArray(request.body?.npcCards) ? request.body.npcCards : [];
        for (const raw of npcCards) {
            const avatar = normalizeText(raw?.avatar);
            if (!avatar) continue;
            const owner = normalizeText(raw?.ownerHandle) || ownerHandle;
            try {
                const npc = await loadNpcFromCharacter(avatar, owner, raw?.name);
                npcs.push(npc);
            } catch {
                // Skip invalid cards in MVP flow.
            }
        }

        /** @type {RoomState} */
        const room = {
            id: roomId,
            name,
            createdAt: Date.now(),
            ownerHandle,
            visibility,
            users,
            npcs,
            messages: [],
        };

        rooms.set(roomId, room);
        return response.status(201).json(toView(room));
    } catch (error) {
        console.error('Room create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/list', async (request, response) => {
    const handle = request.user.profile.handle;
    const result = [...rooms.values()]
        .filter((room) => canDiscoverRoom(room, handle))
        .map((room) => ({
            id: room.id,
            name: room.name,
            ownerHandle: room.ownerHandle,
            visibility: room.visibility,
            users: [...room.users],
            npcCount: room.npcs.length,
            joined: room.users.has(handle),
            messageCount: room.messages.length,
            lastMessageId: room.messages.length ? room.messages[room.messages.length - 1].id : '',
            lastMessageAt: room.messages.length ? room.messages[room.messages.length - 1].createdAt : 0,
        }));
    return response.json(result);
});

router.post('/join', async (request, response) => {
    const roomId = normalizeText(request.body?.roomId);
    const room = getRoomOr404(roomId, response);
    if (!room) return;
    const handle = request.user.profile.handle;
    if (!canJoinRoom(room, handle)) {
        return response.status(403).json({ error: 'Room is invite-only' });
    }
    room.users.add(handle);
    return response.json(toView(room));
});

router.post('/get', async (request, response) => {
    const roomId = normalizeText(request.body?.roomId);
    const room = getRoomOr404(roomId, response);
    if (!room) return;
    const handle = request.user.profile.handle;
    if (!canAccessRoom(room, handle)) {
        return response.status(403).json({ error: 'Not a room member' });
    }
    return response.json(toView(room));
});

router.post('/invite-users', async (request, response) => {
    try {
        const roomId = normalizeText(request.body?.roomId);
        const room = getRoomOr404(roomId, response);
        if (!room) return;
        const handle = request.user.profile.handle;
        if (!canManageRoom(room, handle)) {
            return response.status(403).json({ error: 'Only room members can invite users' });
        }
        const userHandles = Array.isArray(request.body?.userHandles) ? request.body.userHandles : [];
        for (const raw of userHandles) {
            const userHandle = normalizeText(raw);
            if (!userHandle) continue;
            if (await userExists(userHandle)) {
                room.users.add(userHandle);
            }
        }
        return response.json(toView(room));
    } catch (error) {
        console.error('Room invite failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/add-npcs', async (request, response) => {
    try {
        const roomId = normalizeText(request.body?.roomId);
        const room = getRoomOr404(roomId, response);
        if (!room) return;
        const handle = request.user.profile.handle;
        if (!canManageRoom(room, handle)) {
            return response.status(403).json({ error: 'Only room members can add NPCs' });
        }

        const npcCards = Array.isArray(request.body?.npcCards) ? request.body.npcCards : [];
        for (const raw of npcCards) {
            const avatar = normalizeText(raw?.avatar);
            if (!avatar) continue;
            const owner = normalizeText(raw?.ownerHandle) || handle;
            if (!ALLOW_CROSS_USER_NPC && owner !== handle) continue;
            // eslint-disable-next-line no-await-in-loop
            if (!(await userExists(owner))) continue;
            try {
                const npc = await loadNpcFromCharacter(avatar, owner, raw?.name);
                room.npcs.push(npc);
            } catch {
                // Skip invalid card
            }
        }
        return response.json(toView(room));
    } catch (error) {
        console.error('Add NPC failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/set-npc-auto-reply', async (request, response) => {
    try {
        const roomId = normalizeText(request.body?.roomId);
        const npcId = normalizeText(request.body?.npcId);
        const autoReply = Boolean(request.body?.autoReply);
        if (!roomId || !npcId) {
            return response.status(400).json({ error: 'roomId and npcId are required' });
        }
        const room = getRoomOr404(roomId, response);
        if (!room) return;

        const handle = request.user.profile.handle;
        if (!canAccessRoom(room, handle)) {
            return response.status(403).json({ error: 'Not a room member' });
        }

        const npc = room.npcs.find((item) => item.id === npcId);
        if (!npc) {
            return response.status(404).json({ error: 'NPC not found in room' });
        }

        npc.autoReply = autoReply;
        return response.json(toView(room));
    } catch (error) {
        console.error('Set NPC auto reply failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/send', async (request, response) => {
    try {
        const roomId = normalizeText(request.body?.roomId);
        const text = normalizeText(request.body?.text);
        if (!roomId || !text) {
            return response.status(400).json({ error: 'roomId and text are required' });
        }
        const room = getRoomOr404(roomId, response);
        if (!room) return;
        const handle = request.user.profile.handle;
        if (!canAccessRoom(room, handle)) {
            return response.status(403).json({ error: 'Not a room member' });
        }

        const userMessage = {
            id: randomUUID(),
            role: 'user',
            actorId: handle,
            actorName: request.user.profile.name || handle,
            text,
            createdAt: Date.now(),
        };
        pushMessage(room, userMessage);

        const npcOrder = request.body?.npcId
            ? room.npcs.filter((npc) => npc.id === request.body.npcId)
            : room.npcs.filter((npc) => npc.autoReply !== false);
        for (const npc of npcOrder) {
            // eslint-disable-next-line no-await-in-loop
            await runNpcReply(room, npc, userMessage);
        }

        return response.status(201).json({ ok: true, messages: room.messages.slice(-1 - room.npcs.length) });
    } catch (error) {
        console.error('Room send failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/nudge-npc', async (request, response) => {
    try {
        const roomId = normalizeText(request.body?.roomId);
        const npcId = normalizeText(request.body?.npcId);
        if (!roomId || !npcId) {
            return response.status(400).json({ error: 'roomId and npcId are required' });
        }

        const room = getRoomOr404(roomId, response);
        if (!room) return;
        const handle = request.user.profile.handle;
        if (!canAccessRoom(room, handle)) {
            return response.status(403).json({ error: 'Not a room member' });
        }

        const npc = room.npcs.find((item) => item.id === npcId);
        if (!npc) {
            return response.status(404).json({ error: 'NPC not found in room' });
        }

        const latest = room.messages[room.messages.length - 1];
        const triggerMessage = {
            actorId: handle,
            actorName: request.user.profile.name || handle,
            text: latest?.text || 'Continue the scene naturally.',
        };

        await runNpcReply(room, npc, triggerMessage);
        return response.status(201).json({ ok: true, messages: room.messages.slice(-3) });
    } catch (error) {
        console.error('Nudge NPC failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/discover-users', async (request, response) => {
    try {
        const users = await listEnabledUsers();
        return response.json(users);
    } catch (error) {
        console.error('Discover users failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/discover-npcs', async (request, response) => {
    try {
        const requester = request.user.profile.handle;
        const scope = normalizeText(request.body?.scope).toLowerCase();
        const query = normalizeText(request.body?.query).toLowerCase();

        /** @type {string[]} */
        let handles = [];
        if (scope === 'all') {
            const users = await listEnabledUsers();
            handles = users.map((user) => user.handle);
        } else if (Array.isArray(request.body?.userHandles) && request.body.userHandles.length > 0) {
            handles = request.body.userHandles.map((handle) => normalizeText(handle)).filter(Boolean);
        } else {
            handles = [requester];
        }

        if (!ALLOW_CROSS_USER_NPC) {
            handles = handles.filter((handle) => handle === requester);
        }

        const uniqueHandles = [...new Set(handles)];
        const allCards = uniqueHandles.flatMap((handle) => listCharacterCardsByUser(handle));
        const cards = query
            ? allCards.filter((card) => card.name.toLowerCase().includes(query) || card.avatar.toLowerCase().includes(query))
            : allCards;
        return response.json(cards.slice(0, 500));
    } catch (error) {
        console.error('Discover NPCs failed:', error);
        return response.sendStatus(500);
    }
});
