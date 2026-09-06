// SillyRoom client extension — multi-user live chatroom over WebSocket.
// Talks to the server plugin endpoint /api/plugins/sillyroom/ws (see plugins/sillyroom/).

import { eventSource, event_types, sendMessageAsUser, Generate, isGenerating } from '../../../script.js';

const WS_PATH = '/api/plugins/sillyroom/ws';
const STATUS_URL = '/api/plugins/sillyroom/status';

const STORAGE = {
    baseId: 'sillyroom:baseId',
    name: 'sillyroom:name',
    room: 'sillyroom:room',
    open: 'sillyroom:windowOpen',
    inject: 'sillyroom:inject',
    aiBcast: 'sillyroom:aiBcast',
    autoRespond: 'sillyroom:autoRespond',
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TYPING_DISPLAY_MS = 4000;
const MAX_MESSAGE_LENGTH = 2000;
// P1-3 auto-respond throttling: a burst of room messages coalesces into ONE
// generation after this idle window; generations are spaced at least
// AUTO_RESPOND_COOLDOWN_MS apart no matter how many members are talking.
const AUTO_RESPOND_IDLE_MS = 3000;
const AUTO_RESPOND_COOLDOWN_MS = 15000;
const AUTO_RESPOND_BUSY_RETRIES = 2;

/** @type {WebSocket|null} */
let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let intentionallyClosed = false;
let joinedRoom = null;
let selfId = null;
/** @type {Map<string, {name: string, color: string}>} */
let members = new Map();
/** @type {Map<string, {name: string, timer: number}>} */
let typingUsers = new Map();
let typingTimer = null;
// P1-3 auto-respond state
let autoRespondTimer = null;
let autoRespondRetries = 0;
let lastAutoRespondAt = 0;
// P1-2 account integration state
let serverSuggestedName = null;
let loginRequired = false;
let connectInFlight = false;

function readStore(key, fallback = '') {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function writeStore(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable (private mode); identity just won't persist
    }
}

function getBaseId() {
    let baseId = readStore(STORAGE.baseId);
    if (!baseId) {
        baseId = 'sr-' + (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/[^a-zA-Z0-9_-]/g, '');
        writeStore(STORAGE.baseId, baseId);
    }
    return baseId;
}

// Per-connection id: stable base + random suffix so two windows of the same
// browser appear as two separate members (base id still identifies the user).
function newClientId() {
    const rand = Math.random().toString(36).slice(2, 6);
    return `${getBaseId()}-${rand}`;
}

// A locally stored (user-typed) nickname wins; otherwise fall back to the
// account's display name suggested by the server (P1-2), then to a guest name.
function getName() {
    return readStore(STORAGE.name) || serverSuggestedName || `访客-${getBaseId().slice(-4)}`;
}

function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${WS_PATH}`;
}

function setStatus(text, state) {
    $('#sillyroom_status').text(text);
    $('#sillyroom_status_dot')
        .removeClass('ok connecting error')
        .addClass(state);
}

function renderMembers() {
    const container = $('#sillyroom_members').empty();
    const count = members.size;

    if (count === 0) {
        container.append($('<span class="sillyroom_members_hint"></span>').text('未加入房间'));
        return;
    }

    $('#sillyroom_member_count').text(String(count));

    for (const [clientId, member] of members) {
        const chip = $('<span class="sillyroom_member_chip"></span>');
        chip.append($('<span class="sillyroom_member_dot"></span>').css('background-color', member.color));
        chip.append($('<span></span>').text(member.name + (clientId === selfId ? '（我）' : '')));
        container.append(chip);
    }
}

function scrollToBottom() {
    const box = $('#sillyroom_messages').get(0);
    if (box) {
        box.scrollTop = box.scrollHeight;
    }
}

function appendMessage(payload) {
    const isSelf = payload.from?.clientId === selfId;
    const isAi = payload.kind === 'ai';
    const row = $('<div class="sillyroom_msg"></div>').toggleClass('mine', isSelf).toggleClass('ai', isAi);
    const meta = $('<div class="sillyroom_msg_meta"></div>');
    const time = new Date(payload.ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isAi) {
        meta.append($('<span class="sillyroom_msg_badge"></span>').text('AI'));
    }
    meta.append($('<span class="sillyroom_msg_name"></span>').css('color', payload.from?.color || '').text(payload.from?.name ?? '???'));
    meta.append($('<span class="sillyroom_msg_time"></span>').text(time));
    row.append(meta);
    row.append($('<div class="sillyroom_msg_text"></div>').text(payload.text ?? ''));

    $('#sillyroom_messages').append(row);
    scrollToBottom();
}

function appendSystem(text) {
    $('#sillyroom_messages').append(
        $('<div class="sillyroom_system"></div>').text(text),
    );
    scrollToBottom();
}

function renderTyping() {
    const names = [...typingUsers.values()].map(t => t.name);
    const label = $('#sillyroom_typing');
    if (names.length === 0) {
        label.text('');
        return;
    }
    label.text(`${names.join('、')} 正在输入…`);
}

function markTyping(clientId, name, active) {
    if (!active) {
        typingUsers.delete(clientId);
        renderTyping();
        return;
    }

    const existing = typingUsers.get(clientId);
    if (existing) {
        clearTimeout(existing.timer);
    } else {
        typingUsers.set(clientId, { name, timer: 0 });
    }

    typingUsers.get(clientId).timer = setTimeout(() => {
        typingUsers.delete(clientId);
        renderTyping();
    }, TYPING_DISPLAY_MS);
    renderTyping();
}

function updateRoomControls() {
    const hasRoom = !!joinedRoom;
    $('#sillyroom_join').toggle(!hasRoom);
    $('#sillyroom_leave').toggle(hasRoom);
    $('#sillyroom_room_input').prop('disabled', hasRoom);
    $('#sillyroom_input').prop('disabled', !hasRoom);
    $('#sillyroom_send').prop('disabled', !hasRoom);
    $('#sillyroom_room_label').text(hasRoom ? `房间：${joinedRoom}` : '未加入房间');
    $('#sillyroom_member_count').text(hasRoom ? String(members.size) : '0');
}

function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

// --- P1-1: room <-> ST chat flow -------------------------------------------

function injectEnabled() {
    return $('#sillyroom_inject').prop('checked');
}

function aiBcastEnabled() {
    return $('#sillyroom_ai_bcast').prop('checked');
}

// Serializes injections so concurrent room messages can't interleave saves.
let injectionQueue = Promise.resolve();

/**
 * Injects a live room message from ANOTHER member into the current ST chat as
 * a user-side message attributed to the sender (compact layout). The sender
 * name rides on mes.name, which both text-completion and chat-completion
 * prompts prepend to the message, so the AI can tell speakers apart.
 * @param {object} payload Room chat message (from, text)
 */
function injectRoomMessage(payload) {
    if (!injectEnabled() || !joinedRoom) {
        return;
    }

    const from = payload?.from;
    if (!from || from.clientId === selfId) {
        return;
    }

    const text = String(payload.text ?? '').trim();
    if (!text) {
        return;
    }

    injectionQueue = injectionQueue.then(async () => {
        try {
            await sendMessageAsUser(text, null, null, true, from.name);
            scheduleAutoRespond();
        } catch (error) {
            console.warn('SillyRoom: failed to inject room message into chat', error);
        }
    });
}

// --- P1-3: auto-respond after injected room messages ------------------------

function autoRespondEnabled() {
    return $('#sillyroom_auto_respond').prop('checked');
}

/**
 * Arms the auto-respond idle timer. Called after each injected room message,
 * so a burst of messages coalesces into a single generation that sees the
 * whole burst instead of one request per message.
 */
function scheduleAutoRespond() {
    if (!autoRespondEnabled() || !joinedRoom) {
        return;
    }
    clearTimeout(autoRespondTimer);
    autoRespondRetries = 0;
    autoRespondTimer = setTimeout(autoRespondNow, AUTO_RESPOND_IDLE_MS);
}

function cancelAutoRespond() {
    clearTimeout(autoRespondTimer);
    autoRespondTimer = null;
    autoRespondRetries = 0;
}

/**
 * Triggers one AI generation ('normal') so the local AI replies to the
 * injected room messages. Storm protection:
 * - idle debounce (scheduleAutoRespond) merges bursts into one generation;
 * - global cooldown allows at most one auto generation per
 *   AUTO_RESPOND_COOLDOWN_MS regardless of how many members are talking —
 *   room owners should keep this on only on one member for strict control;
 * - never interrupts an in-flight generation (bounded retries instead);
 * - yields to a user draft in the send box (their own send triggers the AI);
 * - kind:'ai' relays are never injected (P1-1), so replies can't re-trigger.
 */
async function autoRespondNow() {
    autoRespondTimer = null;

    if (!autoRespondEnabled() || !joinedRoom) {
        return;
    }

    const sinceLast = Date.now() - lastAutoRespondAt;
    if (sinceLast < AUTO_RESPOND_COOLDOWN_MS) {
        autoRespondTimer = setTimeout(autoRespondNow, AUTO_RESPOND_COOLDOWN_MS - sinceLast);
        return;
    }

    const context = SillyTavern.getContext();
    // Group chats manage their own reply order; a character must be loaded.
    if (context.groupId || context.characterId == null || !Array.isArray(context.chat) || context.chat.length === 0) {
        return;
    }

    if (String($('#send_textarea').val() ?? '').trim()) {
        return; // user is drafting a reply; their send will trigger the AI
    }

    if (isGenerating()) {
        if (autoRespondRetries < AUTO_RESPOND_BUSY_RETRIES) {
            autoRespondRetries += 1;
            autoRespondTimer = setTimeout(autoRespondNow, AUTO_RESPOND_IDLE_MS);
        }
        return;
    }

    lastAutoRespondAt = Date.now();
    try {
        await Generate('normal');
    } catch (error) {
        console.warn('SillyRoom: auto-respond generation failed', error);
    }
}

// ---------------------------------------------------------------------------

/**
 * Broadcasts a locally generated AI reply to the room. Fired on
 * MESSAGE_RECEIVED for plain generations only — swipes, continues, impersonate
 * and quiet/background generations stay local.
 * @param {number} messageId Index into the current chat
 * @param {string|undefined} type Generation type
 */
function onMessageReceived(messageId, type) {
    if (type !== 'normal' || !aiBcastEnabled() || !joinedRoom) {
        return;
    }

    const message = SillyTavern.getContext().chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const text = String(message.mes ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text) {
        return;
    }

    sendWs({ type: 'chat', kind: 'ai', text });
}

// ---------------------------------------------------------------------------

function joinRoom(room) {
    const roomCode = String(room ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'lobby';
    writeStore(STORAGE.room, roomCode);
    sendWs({ type: 'join', room: roomCode, clientId: newClientId(), name: getName() });
}

function leaveRoom(notifyServer = true) {
    if (notifyServer) {
        sendWs({ type: 'leave' });
    }
    joinedRoom = null;
    members.clear();
    typingUsers.clear();
    cancelAutoRespond();
    renderTyping();
    renderMembers();
    updateRoomControls();
}

function scheduleReconnect() {
    if (intentionallyClosed || loginRequired || reconnectTimer) {
        return;
    }

    reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
    setStatus(`已断开，${Math.round(delay / 1000)}s 后重连…`, 'error');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function handleMessage(event) {
    let msg;
    try {
        msg = JSON.parse(String(event.data));
    } catch {
        return;
    }

    switch (msg.type) {
        case 'hello': {
            // P1-2: in multi-user mode the server suggests the account's
            // display name (default Persona name, else account name); a
            // locally customized nickname always wins over the suggestion.
            const suggested = typeof msg.identity?.suggestedName === 'string' ? msg.identity.suggestedName : null;
            if (suggested) {
                serverSuggestedName = suggested;
                if (!readStore(STORAGE.name)) {
                    $('#sillyroom_name_display').text(getName());
                }
            }
            renderRoomSuggestions(msg.rooms ?? []);
            if (readStore(STORAGE.room)) {
                joinRoom(readStore(STORAGE.room));
            }
            break;
        }
        case 'joined': {
            reconnectAttempt = 0;
            joinedRoom = msg.room;
            selfId = msg.self?.clientId ?? null;
            members = new Map((msg.members ?? []).map(m => [m.clientId, m]));
            $('#sillyroom_messages').empty();
            appendSystem(`已加入房间 ${msg.room}`);
            for (const item of msg.history ?? []) {
                appendMessage(item);
            }
            renderMembers();
            updateRoomControls();
            setStatus('已连接', 'ok');
            $('#sillyroom_input').trigger('focus');
            break;
        }
        case 'member_joined':
            members.set(msg.member?.clientId, msg.member);
            renderMembers();
            break;
        case 'member_left':
            members.delete(msg.clientId);
            renderMembers();
            break;
        case 'members':
            members = new Map((msg.members ?? []).map(m => [m.clientId, m]));
            renderMembers();
            break;
        case 'chat':
            markTyping(msg.from?.clientId, msg.from?.name, false);
            appendMessage(msg);
            // AI relays are room-window-only; never re-inject them (loop protection)
            if (msg.kind !== 'ai') {
                injectRoomMessage(msg);
            }
            break;
        case 'system':
            appendSystem(msg.text ?? '');
            break;
        case 'typing':
            markTyping(msg.clientId, msg.name, msg.active === true);
            break;
        case 'error':
            appendSystem(`[错误] ${msg.message ?? ''}`);
            break;
        case 'pong':
            break;
        default:
            break;
    }
}

function renderRoomSuggestions(roomList) {
    const container = $('#sillyroom_rooms').empty();
    if (!Array.isArray(roomList) || roomList.length === 0) {
        container.text('暂无活跃房间，输入房间码创建');
        return;
    }

    for (const room of roomList) {
        const chip = $('<a class="sillyroom_room_chip" href="javascript:void(0)"></a>')
            .text(`${room.id} (${room.members})`)
            .on('click', () => {
                $('#sillyroom_room_input').val(room.id);
                joinRoom(room.id);
            });
        container.append(chip);
    }
}

/**
 * Probes the REST status endpoint before opening the WebSocket. The endpoint
 * sits behind the same login requirement as the main app (P1-2), so a 403
 * here means "not logged in" — the WS upgrade would be rejected the same way.
 * @returns {Promise<'ok'|'login'|'down'>} Probe result
 */
async function probeServer() {
    try {
        const response = await fetch(STATUS_URL);
        if (response.status === 403) {
            return 'login';
        }
        if (!response.ok) {
            return 'down';
        }
        const data = await response.json();
        renderRoomSuggestions(data.rooms ?? []);
        return 'ok';
    } catch {
        return 'down';
    }
}

async function connect() {
    if (connectInFlight || loginRequired) {
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    connectInFlight = true;
    try {
        // Re-probe on every (re)connect so an expired session surfaces as a
        // clear "login required" state instead of an endless reconnect loop.
        const probe = await probeServer();
        if (probe === 'login') {
            loginRequired = true;
            setStatus('需要登录 SillyTavern 后才能使用聊天室', 'error');
            return;
        }

        setStatus('连接中…', 'connecting');

        try {
            ws = new WebSocket(wsUrl());
        } catch {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectAttempt = 0;
            setStatus('已连接', 'ok');
            // 'hello' from the server triggers auto-rejoin
        };

        ws.onmessage = handleMessage;

        ws.onclose = () => {
            if (joinedRoom) {
                leaveRoom(false);
            }
            setStatus('连接已断开', 'error');
            scheduleReconnect();
        };

        ws.onerror = () => {
            try {
                ws.close();
            } catch {
                // already closed
            }
        };
    } finally {
        connectInFlight = false;
    }
}

function sendCurrentInput() {
    const input = $('#sillyroom_input');
    const text = String(input.val() ?? '').trim();

    if (!text || !joinedRoom) {
        return;
    }

    if (sendWs({ type: 'chat', text })) {
        input.val('').trigger('focus');
        sendWs({ type: 'typing', active: false });
    }
}

function buildWindow() {
    const windowHtml = `
    <div id="sillyroom_window" class="sillyroom_hidden">
        <div id="sillyroom_header">
            <span id="sillyroom_title">💬 聊天室</span>
            <span id="sillyroom_status_dot" class="connecting"></span>
            <span id="sillyroom_status"></span>
            <span class="sillyroom_flex"></span>
            <a id="sillyroom_minimize" class="sillyroom_icon" href="javascript:void(0)" title="收起">—</a>
        </div>
        <div id="sillyroom_body">
            <div id="sillyroom_controls">
                <span id="sillyroom_name_display" title="点击修改昵称"></span>
                <input id="sillyroom_room_input" type="text" maxlength="32" placeholder="房间码（默认 lobby）" autocomplete="off">
                <button id="sillyroom_join" class="menu_button">加入</button>
                <button id="sillyroom_leave" class="menu_button">离开</button>
            </div>
            <div id="sillyroom_rooms"></div>
            <div id="sillyroom_toggles">
                <label class="sillyroom_toggle" title="把其他成员的房间发言注入当前聊天（用户侧消息），AI 下次生成时可见">
                    <input id="sillyroom_inject" type="checkbox"><span>注入聊天</span>
                </label>
                <label class="sillyroom_toggle" title="把本地 AI 的回复广播到房间，供其他成员查看">
                    <input id="sillyroom_ai_bcast" type="checkbox"><span>AI 回复广播</span>
                </label>
                <label class="sillyroom_toggle" title="注入真人消息后自动触发一次 AI 生成（需开启「注入聊天」）；3 秒合并连续发言、15 秒冷却节流，防止请求风暴。多人时建议只开在一台设备上">
                    <input id="sillyroom_auto_respond" type="checkbox"><span>自动回应</span>
                </label>
            </div>
            <div id="sillyroom_members_bar">
                <span id="sillyroom_room_label"></span>
                <span class="sillyroom_flex"></span>
                <span id="sillyroom_members"></span>
            </div>
            <div id="sillyroom_messages"></div>
            <div id="sillyroom_typing"></div>
            <div id="sillyroom_input_row">
                <input id="sillyroom_input" type="text" maxlength="${MAX_MESSAGE_LENGTH}" placeholder="输入消息，Enter 发送…" autocomplete="off">
                <button id="sillyroom_send" class="menu_button">发送</button>
            </div>
        </div>
    </div>`;

    $('body').append(windowHtml);

    // members container also holds the count chip when joined
    $('<span id="sillyroom_member_count" class="sillyroom_member_count"></span>').text('0').insertAfter('#sillyroom_members_bar > span:first');

    $('#sillyroom_name_display').text(getName()).on('click', function () {
        const current = getName();
        const next = window.prompt('修改昵称（最长 24 字符）：', current);
        if (next === null) {
            return;
        }
        const cleaned = next.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 24);
        if (!cleaned) {
            return;
        }
        writeStore(STORAGE.name, cleaned);
        $(this).text(cleaned);
        if (joinedRoom) {
            sendWs({ type: 'rename', name: cleaned });
        }
    });

    $('#sillyroom_room_input').val(readStore(STORAGE.room));

    // Both integrations default to ON; '0' in storage means the user opted out.
    $('#sillyroom_inject')
        .prop('checked', readStore(STORAGE.inject) !== '0')
        .on('change', function () {
            writeStore(STORAGE.inject, this.checked ? '1' : '0');
        });
    $('#sillyroom_ai_bcast')
        .prop('checked', readStore(STORAGE.aiBcast) !== '0')
        .on('change', function () {
            writeStore(STORAGE.aiBcast, this.checked ? '1' : '0');
        });
    // Auto-respond defaults to OFF: it spends API quota on its own and only
    // makes sense as an explicit opt-in (spec: 可选开关).
    $('#sillyroom_auto_respond')
        .prop('checked', readStore(STORAGE.autoRespond) === '1')
        .on('change', function () {
            writeStore(STORAGE.autoRespond, this.checked ? '1' : '0');
            if (!this.checked) {
                cancelAutoRespond();
            }
        });

    $('#sillyroom_join').on('click', () => joinRoom($('#sillyroom_room_input').val()));
    $('#sillyroom_room_input').on('keydown', event => {
        if (event.key === 'Enter') {
            joinRoom($('#sillyroom_room_input').val());
        }
    });

    $('#sillyroom_leave').on('click', () => {
        writeStore(STORAGE.room, '');
        $('#sillyroom_room_input').val('');
        leaveRoom(true);
        $('#sillyroom_messages').empty();
        $('#sillyroom_rooms').empty();
    });

    $('#sillyroom_send').on('click', sendCurrentInput);
    $('#sillyroom_input').on('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendCurrentInput();
        } else if (joinedRoom) {
            // lightweight typing signal, throttled by timer reset
            if (!typingTimer) {
                sendWs({ type: 'typing', active: true });
                typingTimer = setTimeout(() => {
                    typingTimer = null;
                }, 2000);
            }
        }
    });

    $('#sillyroom_minimize').on('click', () => setWindowVisible(false));
}

function setWindowVisible(visible) {
    const windowEl = $('#sillyroom_window');
    if (visible) {
        windowEl.removeClass('sillyroom_hidden');
        $('#sillyroom_name_display').text(getName());
        connect();
        scrollToBottom();
    } else {
        windowEl.addClass('sillyroom_hidden');
    }
    writeStore(STORAGE.open, visible ? '1' : '0');
}

export function init() {
    if ($('#sillyroom_window').length > 0) {
        return; // already initialized (extension hot reload)
    }

    buildWindow();

    // Entry in the wand (extensions) menu
    const menuItem = $('<a id="sillyroom_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="打开多人聊天室"></a>');
    menuItem.append($('<span></span>').text('💬'));
    menuItem.append($('<span></span>').text('聊天室'));
    menuItem.on('click', () => setWindowVisible($('#sillyroom_window').hasClass('sillyroom_hidden')));
    $('#extensionsMenu').append(menuItem);

    // AI reply relay: plain generations only
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    // Probe the server plugin: shows a clear hint when enableServerPlugins is
    // off, and a login hint when SillyTavern's multi-user mode requires auth.
    probeServer().then(state => {
        if (state === 'login') {
            loginRequired = true;
            setStatus('需要登录 SillyTavern 后才能使用聊天室', 'error');
            toastr.info('多人聊天室需要先登录 SillyTavern 账号', '聊天室');
        } else if (state === 'down') {
            setStatus('服务端插件未启用', 'error');
        } else {
            setStatus('就绪', 'connecting');
        }
        if (readStore(STORAGE.open) === '1') {
            setWindowVisible(true);
        }
    });

    console.log('SillyRoom: extension initialized');
}
