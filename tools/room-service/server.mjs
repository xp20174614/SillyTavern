#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.ROOM_PORT || 8787);
const API_KEY = process.env.ROOM_API_KEY || '';
const NPC_API_BASE = process.env.NPC_API_BASE || 'http://10.55.119.229:8001/v1';
const NPC_MODEL = process.env.NPC_MODEL || '/ssd3/models/Minimax-M2.5-BF16-MoE-AWQ-INT4-richcalib-no-w3w2';
const MAX_HISTORY = Number(process.env.ROOM_MAX_HISTORY || 30);

/** @typedef {{id: string, name: string, systemPrompt: string}} Npc */
/** @typedef {{id: string, role: "user"|"assistant", actorId: string, actorName: string, text: string, createdAt: number}} Msg */
/** @typedef {{id: string, createdAt: number, npcs: Npc[], participants: Map<string, {name: string, ws?: import('ws').WebSocket}>, messages: Msg[], busyNpcs: Set<string>}} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();

const app = express();
app.use(express.json({ limit: '1mb' }));

function authMiddleware(req, res, next) {
    if (!API_KEY) return next();
    const token = req.header('x-room-api-key');
    if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.use('/rooms', authMiddleware);

function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function emitRoom(room, event, payload) {
    const packet = JSON.stringify({ event, payload, roomId: room.id });
    for (const participant of room.participants.values()) {
        if (participant.ws && participant.ws.readyState === 1) {
            participant.ws.send(packet);
        }
    }
}

function getCompactHistory(room) {
    const sliced = room.messages.slice(-MAX_HISTORY);
    return sliced.map((m) => ({
        role: m.role,
        content: `${m.actorName}: ${m.text}`,
    }));
}

async function callNpc(room, npc, triggerMessage) {
    if (room.busyNpcs.has(npc.id)) return;
    room.busyNpcs.add(npc.id);

    try {
        const messages = [
            {
                role: 'system',
                content: npc.systemPrompt,
            },
            {
                role: 'system',
                content: `Room ${room.id}. Reply as ${npc.name}. Keep reply concise and in-character. React to the latest user turn from ${triggerMessage.actorName}.`,
            },
            ...getCompactHistory(room),
        ];

        const response = await fetch(`${NPC_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: NPC_MODEL,
                messages,
                max_tokens: 200,
                temperature: 0.7,
                stream: false,
            }),
        });

        if (!response.ok) {
            throw new Error(`NPC API failed (${response.status})`);
        }

        const data = await response.json();
        const text = normalizeText(data?.choices?.[0]?.message?.content);
        if (!text) return;

        /** @type {Msg} */
        const msg = {
            id: crypto.randomUUID(),
            role: 'assistant',
            actorId: npc.id,
            actorName: npc.name,
            text,
            createdAt: Date.now(),
        };
        room.messages.push(msg);
        emitRoom(room, 'message', msg);
    } catch (error) {
        emitRoom(room, 'error', {
            source: 'npc',
            npcId: npc.id,
            npcName: npc.name,
            message: String(error?.message || error),
        });
    } finally {
        room.busyNpcs.delete(npc.id);
    }
}

function createRoom(payload = {}) {
    const roomId = normalizeText(payload.roomId) || crypto.randomUUID().slice(0, 8);
    if (rooms.has(roomId)) throw new Error('Room already exists');

    const npcs = Array.isArray(payload.npcs) ? payload.npcs : [];
    const sanitizedNpcs = npcs
        .map((n, idx) => ({
            id: normalizeText(n.id) || `npc-${idx + 1}`,
            name: normalizeText(n.name) || `NPC-${idx + 1}`,
            systemPrompt: normalizeText(n.systemPrompt) || 'You are an NPC in a detective room. Answer only from your own perspective.',
        }))
        .filter((n) => n.id && n.name);

    /** @type {Room} */
    const room = {
        id: roomId,
        createdAt: Date.now(),
        npcs: sanitizedNpcs,
        participants: new Map(),
        messages: [],
        busyNpcs: new Set(),
    };

    rooms.set(roomId, room);
    return room;
}

app.post('/rooms', (req, res) => {
    try {
        const room = createRoom(req.body || {});
        return res.status(201).json({
            roomId: room.id,
            npcs: room.npcs,
            wsUrl: `/ws?roomId=${encodeURIComponent(room.id)}&userId=<user-id>&name=<display-name>`,
        });
    } catch (error) {
        return res.status(400).json({ error: String(error?.message || error) });
    }
});

app.get('/rooms/:roomId/state', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    return res.json({
        roomId: room.id,
        createdAt: room.createdAt,
        participants: [...room.participants.entries()].map(([id, p]) => ({ id, name: p.name })),
        npcs: room.npcs,
        messages: room.messages.slice(-100),
    });
});

app.post('/rooms/:roomId/messages', async (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const userId = normalizeText(req.body?.userId);
    const actorName = normalizeText(req.body?.name) || userId;
    const text = normalizeText(req.body?.text);
    if (!userId || !text) return res.status(400).json({ error: 'userId and text are required' });

    if (!room.participants.has(userId)) {
        room.participants.set(userId, { name: actorName });
    }

    /** @type {Msg} */
    const msg = {
        id: crypto.randomUUID(),
        role: 'user',
        actorId: userId,
        actorName,
        text,
        createdAt: Date.now(),
    };
    room.messages.push(msg);
    emitRoom(room, 'message', msg);

    // Fire-and-forget NPC reactions
    for (const npc of room.npcs) {
        void callNpc(room, npc, msg);
    }

    return res.status(201).json({ ok: true, messageId: msg.id });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = normalizeText(url.searchParams.get('roomId'));
    const userId = normalizeText(url.searchParams.get('userId'));
    const name = normalizeText(url.searchParams.get('name')) || userId;

    const room = rooms.get(roomId);
    if (!room || !userId) {
        ws.close(1008, 'Invalid room or user');
        return;
    }

    room.participants.set(userId, { name, ws });
    emitRoom(room, 'presence', { userId, name, online: true });

    ws.send(JSON.stringify({
        event: 'snapshot',
        roomId: room.id,
        payload: {
            npcs: room.npcs,
            participants: [...room.participants.entries()].map(([id, p]) => ({ id, name: p.name, online: !!p.ws })),
            messages: room.messages.slice(-100),
        },
    }));

    ws.on('message', async (raw) => {
        try {
            const incoming = JSON.parse(String(raw));
            if (incoming?.event !== 'send') return;
            const text = normalizeText(incoming?.payload?.text);
            if (!text) return;

            /** @type {Msg} */
            const msg = {
                id: crypto.randomUUID(),
                role: 'user',
                actorId: userId,
                actorName: name,
                text,
                createdAt: Date.now(),
            };
            room.messages.push(msg);
            emitRoom(room, 'message', msg);

            for (const npc of room.npcs) {
                void callNpc(room, npc, msg);
            }
        } catch {
            // Ignore malformed packets
        }
    });

    ws.on('close', () => {
        const participant = room.participants.get(userId);
        if (participant) {
            participant.ws = undefined;
            room.participants.set(userId, participant);
        }
        emitRoom(room, 'presence', { userId, name, online: false });
    });
});

server.listen(PORT, () => {
    console.log(`[room-service] listening on :${PORT}`);
    console.log(`[room-service] NPC API: ${NPC_API_BASE}`);
    console.log('[room-service] Create room: POST /rooms');
});
