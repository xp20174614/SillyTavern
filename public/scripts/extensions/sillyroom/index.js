// SillyRoom client extension — multi-user live chatroom over WebSocket.
// Talks to the server plugin endpoint /api/plugins/sillyroom/ws (see plugins/sillyroom/).

import { eventSource, event_types, sendMessageAsUser, Generate, isGenerating } from '../../../script.js';
import { addLocaleData, getCurrentLocale, t } from '../../i18n.js';
import { SILLYROOM_LOCALES } from './locales.js';

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
// P2-2 offline outbox: capped at the server's rate limit (15 per 5s) so a
// full flush after reconnect is never throttled or dropped.
const MAX_OUTBOX = 15;

/** @type {WebSocket|null} */
let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let intentionallyClosed = false;
let joinedRoom = null;
let selfId = null;
// P3-1a room moderation state (mirrors the server's joined/members payloads)
let roomOwner = null;
/** @type {Set<string>} clientIds muted by the owner */
let roomMuted = new Set();
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
// P2-2 offline catch-up state: messages typed while the socket is down are
// buffered here and flushed once the room is rejoined.
/** @type {Array<{room: string, text: string, nonce: string, ts: number}>} */
let outbox = [];
let unreadCount = 0;
// P2-2 gap marker: id of the last chat message seen before a disconnect, so
// the replay after rejoining can show where the offline catch-up begins.
let lastSeenMessageId = null;
let reconnectGap = null;

// P2-3: register the extension's bundled dictionary for the running locale
// (before the window is built, so data-i18n translates at insertion time).
// Keys are the Simplified Chinese source strings; locales without a bundled
// dictionary keep them unchanged. Region variants (en-gb) resolve to the base code.
function registerLocales() {
    const current = String(getCurrentLocale() ?? '').toLowerCase();
    const dict = SILLYROOM_LOCALES[current] ?? SILLYROOM_LOCALES[current.split('-')[0]];
    if (dict) {
        addLocaleData(current, dict);
    }
}

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
    return readStore(STORAGE.name) || serverSuggestedName || t`访客-${getBaseId().slice(-4)}`;
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
        container.append($('<span class="sillyroom_members_hint"></span>').text(t`未加入房间`));
        return;
    }

    $('#sillyroom_member_count').text(String(count));

    for (const [clientId, member] of members) {
        const chip = $('<span class="sillyroom_member_chip"></span>');
        chip.append($('<span class="sillyroom_member_dot"></span>').css('background-color', member.color));
        // P3-1a: crown marks the room owner, the speaker icon a mute
        if (clientId === roomOwner) {
            chip.append($('<span class="sillyroom_owner_badge"></span>').attr('title', t`房主`).text('👑'));
        }
        if (roomMuted.has(clientId)) {
            chip.append($('<span class="sillyroom_muted_badge"></span>').attr('title', t`已禁言`).text('🔇'));
        }
        chip.append($('<span></span>').text(member.name + (clientId === selfId ? t`（我）` : '')));
        if (roomOwner === selfId && clientId !== selfId) {
            chip.addClass('sillyroom_moderatable')
                .attr('title', t`点击管理成员`)
                .on('click', function () {
                    openMemberMenu(clientId, this);
                });
        }
        container.append(chip);
    }
}

// --- P3-1a: owner member management (kick / mute) ----------------------------

function closeMemberMenu() {
    $('#sillyroom_member_menu').remove();
    $(document).off('click.sillyroom_member_menu');
}

/**
 * Opens the owner's moderation menu anchored to a member chip. A no-op for
 * non-owners and for the owner's own chip (leaving is the owner's way out).
 * @param {string} clientId Target member
 * @param {HTMLElement} anchor The clicked chip element
 */
function openMemberMenu(clientId, anchor) {
    closeMemberMenu();
    const member = members.get(clientId);
    if (!member || roomOwner !== selfId || clientId === selfId) {
        return;
    }

    const isMuted = roomMuted.has(clientId);
    const menu = $('<div id="sillyroom_member_menu"></div>');
    menu.append($('<span class="sillyroom_member_menu_name"></span>').text(member.name));
    menu.append(
        $('<button class="sillyroom_member_menu_button"></button>')
            .text(`🔇 ${isMuted ? t`解除禁言` : t`禁言`}`)
            .on('click', () => {
                sendWs({ type: 'mute', clientId, muted: !isMuted });
                closeMemberMenu();
            }),
    );
    menu.append(
        $('<button class="sillyroom_member_menu_button danger"></button>')
            .text(`🚪 ${t`移出房间`}`)
            .on('click', () => {
                sendWs({ type: 'kick', clientId });
                closeMemberMenu();
            }),
    );

    $('body').append(menu);
    const rect = anchor.getBoundingClientRect();
    const menuWidth = menu.outerWidth() ?? 160;
    menu.css({
        left: Math.max(4, Math.min(rect.left, window.innerWidth - menuWidth - 4)),
        top: Math.min(rect.bottom + 4, window.innerHeight - (menu.outerHeight() ?? 100) - 4),
    });
    // Defer so the opening click never closes the menu instantly
    setTimeout(() => {
        $(document).on('click.sillyroom_member_menu', closeMemberMenu);
    }, 0);
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

// --- P2-2: offline catch-up (outbox, gap marker, unread badge) --------------

function newNonce() {
    return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Renders the divider that marks where messages received while disconnected
 * begin in the replayed history.
 */
function appendGapSeparator() {
    $('#sillyroom_messages').append(
        $('<div class="sillyroom_gap"></div>').text(t`—— 断线期间的新消息 ——`),
    );
}

function appendPendingRow(item) {
    const row = $('<div class="sillyroom_msg pending"></div>').attr('data-nonce', item.nonce);
    row.append($('<div class="sillyroom_msg_meta"></div>').append(
        $('<span class="sillyroom_msg_time"></span>').text(t`⏳ 待发送`),
    ));
    row.append($('<div class="sillyroom_msg_text"></div>').text(item.text));
    $('#sillyroom_messages').append(row);
    scrollToBottom();
}

/**
 * Re-renders every buffered message as a pending row; called after the joined
 * replay wipes and rebuilds the message box, before the outbox is flushed.
 */
function renderOutbox() {
    for (const item of outbox) {
        appendPendingRow(item);
    }
}

/**
 * Sends all buffered messages for the current room. Items stay rendered as
 * ⏳ rows until the server echoes them back with the matching nonce
 * (consumeOutboxNonce), which swaps the pending copy for the confirmed one.
 */
function flushOutbox() {
    if (!joinedRoom || outbox.length === 0) {
        return;
    }

    for (const item of [...outbox]) {
        if (item.room !== joinedRoom) {
            outbox.splice(outbox.indexOf(item), 1);
            $(`#sillyroom_messages .sillyroom_msg[data-nonce="${item.nonce}"]`).remove();
            appendSystem(t`[错误] 一条离线消息未发送：房间已切换`);
            continue;
        }
        if (!sendWs({ type: 'chat', text: item.text, nonce: item.nonce })) {
            break; // socket dropped again — keep everything for the next reconnect
        }
        outbox.splice(outbox.indexOf(item), 1);
    }
    updateRoomControls();
}

/**
 * Matches a server echo to a buffered message: drops the pending row (the
 * confirmed copy is appended right after) and the outbox entry. The row goes
 * even when the entry is already gone — flushOutbox removes entries at send
 * time to avoid double-flushing, so the echo is the only cleanup signal left.
 */
function consumeOutboxNonce(nonce) {
    const index = outbox.findIndex(item => item.nonce === nonce);
    if (index >= 0) {
        outbox.splice(index, 1);
    }
    $(`#sillyroom_messages .sillyroom_msg[data-nonce="${nonce}"]`).remove();
    updateRoomControls();
}

function renderUnread() {
    const badge = $('#sillyroom_unread');
    if (unreadCount > 0) {
        badge.text(unreadCount > 99 ? '99+' : String(unreadCount)).addClass('visible');
    } else {
        badge.removeClass('visible').text('');
    }
}

/**
 * Counts messages received while the chatroom window is minimized. The badge
 * lives on the wand-menu entry (the only visible element while minimized);
 * one toastr notice fires when the unread burst starts.
 */
function bumpUnread() {
    if (!$('#sillyroom_window').hasClass('sillyroom_hidden')) {
        return;
    }
    unreadCount += 1;
    renderUnread();
    if (unreadCount === 1) {
        toastr.info(t`聊天室有新消息，可通过魔杖菜单「💬 聊天室」查看`, t`聊天室`);
    }
}

function renderTyping() {
    const names = [...typingUsers.values()].map(t => t.name);
    const label = $('#sillyroom_typing');
    if (names.length === 0) {
        label.text('');
        return;
    }
    label.text(`${names.join(t`、`)} ${t`正在输入…`}`);
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
    // P2-2: with a stored room an auto-rejoin is expected, so the input stays
    // usable while disconnected and sends are buffered in the outbox.
    const expectRejoin = !hasRoom && !!readStore(STORAGE.room);
    const canChat = hasRoom || expectRejoin;
    const pendingNote = outbox.length ? ` · ` + t`待补发 ${outbox.length} 条` : '';
    $('#sillyroom_join').toggle(!hasRoom);
    $('#sillyroom_leave').toggle(hasRoom);
    $('#sillyroom_room_input').prop('disabled', hasRoom);
    $('#sillyroom_input').prop('disabled', !canChat);
    $('#sillyroom_send').prop('disabled', !canChat);
    $('#sillyroom_room_label').text(
        hasRoom
            ? t`房间：${joinedRoom}` + pendingNote
            : expectRejoin
                ? t`房间：${readStore(STORAGE.room)}（等待重连）` + pendingNote
                : t`未加入房间`,
    );
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
        // Intentional leave drops the outbox with the room; an accidental
        // disconnect (notifyServer=false) keeps it for the auto-rejoin flush.
        outbox.length = 0;
        $('#sillyroom_messages .sillyroom_msg.pending').remove();
    }
    joinedRoom = null;
    members.clear();
    typingUsers.clear();
    // P3-1a: moderation state belongs to the room membership
    roomOwner = null;
    roomMuted.clear();
    closeMemberMenu();
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
    setStatus(t`已断开，${Math.round(delay / 1000)}s 后重连…`, 'error');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

// P2-3: server system/error events carry a stable key + args (added alongside
// the legacy Chinese text) so every client renders them in its own locale.
// Unknown keys fall back to the server-provided text.
function systemText(msg) {
    switch (msg?.key) {
        case 'member_joined':
            return t`${msg.args?.name ?? '?'} 加入了房间`;
        case 'member_left':
            return t`${msg.args?.name ?? '?'} 离开了房间`;
        case 'member_renamed':
            return t`${msg.args?.oldName ?? '?'} 改名为 ${msg.args?.name ?? '?'}`;
        case 'member_kicked':
            return t`${msg.args?.by ?? '?'} 将 ${msg.args?.name ?? '?'} 移出了房间`;
        case 'member_muted':
            return t`${msg.args?.by ?? '?'} 禁言了 ${msg.args?.name ?? '?'}`;
        case 'member_unmuted':
            return t`${msg.args?.by ?? '?'} 解除了 ${msg.args?.name ?? '?'} 的禁言`;
        default:
            return String(msg?.text ?? '');
    }
}

function errorText(msg) {
    switch (msg?.key) {
        case 'err_rooms_limit':
            return t`服务器房间数量已达上限，请稍后再试`;
        case 'err_room_full':
            return t`房间 ${msg.args?.room ?? '?'} 人数已满（${msg.args?.max ?? '?'} 人）`;
        case 'err_not_in_room':
            return t`请先加入房间后再发言`;
        case 'err_rate_limited':
            return t`发言太快了，请稍作休息`;
        case 'err_bad_message':
            return t`无效的消息格式`;
        case 'err_unknown_type':
            return t`未知的消息类型`;
        case 'err_not_owner':
            return t`只有房主可以执行此操作`;
        case 'err_muted':
            return t`你已被禁言，无法发言`;
        case 'err_bad_target':
            return t`目标成员不在房间中`;
        default:
            return String(msg?.message ?? '');
    }
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
            // P3-1a: moderation state rides along with the join confirmation
            roomOwner = typeof msg.owner === 'string' ? msg.owner : null;
            roomMuted = new Set(Array.isArray(msg.muted) ? msg.muted : []);
            const history = Array.isArray(msg.history) ? msg.history : [];
            $('#sillyroom_messages').empty();
            appendSystem(t`已加入房间 ${msg.room}`);
            // P2-2: locate where the offline catch-up begins in the replay —
            // right after the last message seen before the disconnect, or (if
            // that message aged out of the history window) at the first
            // message sent after the disconnect timestamp.
            let gapIndex = -1;
            if (reconnectGap) {
                const afterIdx = reconnectGap.afterId
                    ? history.findIndex(item => item?.id === reconnectGap.afterId)
                    : -1;
                if (afterIdx >= 0) {
                    gapIndex = afterIdx + 1 <= history.length - 1 ? afterIdx + 1 : -1;
                } else {
                    gapIndex = history.findIndex(item => (item?.ts ?? 0) > reconnectGap.at);
                }
            }
            history.forEach((item, index) => {
                if (index === gapIndex) {
                    appendGapSeparator();
                }
                appendMessage(item);
            });
            if (history.length) {
                lastSeenMessageId = history[history.length - 1]?.id ?? lastSeenMessageId;
            }
            reconnectGap = null;
            renderOutbox();
            flushOutbox();
            renderMembers();
            updateRoomControls();
            setStatus(t`已连接`, 'ok');
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
            // P3-1a: owner/mute changes re-badge the chips
            roomOwner = typeof msg.owner === 'string' ? msg.owner : null;
            roomMuted = new Set(Array.isArray(msg.muted) ? msg.muted : []);
            renderMembers();
            break;
        case 'kicked': {
            // P3-1a: the owner removed us from the room. Tell the user, then
            // reset like an intentional leave — and drop the stored room so
            // the next reconnect does NOT auto-rejoin (manual re-entry is
            // still possible by typing the room code).
            appendSystem(t`你已被房主移出了房间`);
            toastr.warning(t`你已被房主移出了房间`, t`聊天室`);
            writeStore(STORAGE.room, '');
            leaveRoom(false);
            outbox.length = 0;
            $('#sillyroom_messages .sillyroom_msg.pending').remove();
            updateRoomControls();
            break;
        }
        case 'chat':
            markTyping(msg.from?.clientId, msg.from?.name, false);
            // P2-2: our own flushed outbox message — drop the ⏳ pending copy,
            // the confirmed echo below replaces it
            if (msg.nonce) {
                consumeOutboxNonce(msg.nonce);
            }
            appendMessage(msg);
            if (msg.id) {
                lastSeenMessageId = msg.id;
            }
            if (msg.from?.clientId !== selfId) {
                bumpUnread();
            }
            // AI relays are room-window-only; never re-inject them (loop protection)
            if (msg.kind !== 'ai') {
                injectRoomMessage(msg);
            }
            break;
        case 'system':
            appendSystem(systemText(msg));
            break;
        case 'typing':
            markTyping(msg.clientId, msg.name, msg.active === true);
            break;
        case 'error':
            appendSystem(`[${t`错误`}] ${errorText(msg)}`);
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
        container.text(t`暂无活跃房间，输入房间码创建`);
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
            setStatus(t`需要登录 SillyTavern 后才能使用聊天室`, 'error');
            return;
        }

        setStatus(t`连接中…`, 'connecting');

        try {
            ws = new WebSocket(wsUrl());
        } catch {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectAttempt = 0;
            setStatus(t`已连接`, 'ok');
            // 'hello' from the server triggers auto-rejoin
        };

        ws.onmessage = handleMessage;

        ws.onclose = () => {
            if (joinedRoom) {
                // P2-2: remember where the replay catch-up marker should go
                reconnectGap = { afterId: lastSeenMessageId, at: Date.now() };
                leaveRoom(false);
            }
            setStatus(t`连接已断开`, 'error');
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
    // P2-2: while disconnected the stored room is where the auto-rejoin will
    // land, so sends targeting it are buffered instead of rejected.
    const expectedRoom = joinedRoom ?? (readStore(STORAGE.room) || null);

    if (!text || !expectedRoom) {
        return;
    }

    if (joinedRoom && sendWs({ type: 'chat', text })) {
        input.val('').trigger('focus');
        sendWs({ type: 'typing', active: false });
        return;
    }

    if (outbox.length >= MAX_OUTBOX) {
        appendSystem(t`[错误] 离线消息缓存已满（${MAX_OUTBOX} 条），请等待重连后再发送`);
        return;
    }

    const item = { room: expectedRoom, text, nonce: newNonce(), ts: Date.now() };
    outbox.push(item);
    appendPendingRow(item);
    input.val('').trigger('focus');
    updateRoomControls();
}

function buildWindow() {
    const windowHtml = `
    <div id="sillyroom_window" class="sillyroom_hidden">
        <div id="sillyroom_header">
            <span id="sillyroom_title" data-i18n="💬 聊天室">💬 聊天室</span>
            <span id="sillyroom_status_dot" class="connecting"></span>
            <span id="sillyroom_status"></span>
            <span class="sillyroom_flex"></span>
            <a id="sillyroom_minimize" class="sillyroom_icon" href="javascript:void(0)" title="收起" data-i18n="[title]收起">—</a>
        </div>
        <div id="sillyroom_body">
            <div id="sillyroom_controls">
                <span id="sillyroom_name_display" title="点击修改昵称" data-i18n="[title]点击修改昵称"></span>
                <input id="sillyroom_room_input" type="text" maxlength="32" placeholder="房间码（默认 lobby）" autocomplete="off" data-i18n="[placeholder]房间码（默认 lobby）">
                <button id="sillyroom_join" class="menu_button" data-i18n="加入">加入</button>
                <button id="sillyroom_leave" class="menu_button" data-i18n="离开">离开</button>
            </div>
            <div id="sillyroom_rooms"></div>
            <div id="sillyroom_toggles">
                <label class="sillyroom_toggle" title="把其他成员的房间发言注入当前聊天（用户侧消息），AI 下次生成时可见" data-i18n="[title]把其他成员的房间发言注入当前聊天（用户侧消息），AI 下次生成时可见">
                    <input id="sillyroom_inject" type="checkbox"><span data-i18n="注入聊天">注入聊天</span>
                </label>
                <label class="sillyroom_toggle" title="把本地 AI 的回复广播到房间，供其他成员查看" data-i18n="[title]把本地 AI 的回复广播到房间，供其他成员查看">
                    <input id="sillyroom_ai_bcast" type="checkbox"><span data-i18n="AI 回复广播">AI 回复广播</span>
                </label>
                <label class="sillyroom_toggle" title="注入真人消息后自动触发一次 AI 生成（需开启「注入聊天」）；3 秒合并连续发言、15 秒冷却节流，防止请求风暴。多人时建议只开在一台设备上" data-i18n="[title]注入真人消息后自动触发一次 AI 生成（需开启「注入聊天」）；3 秒合并连续发言、15 秒冷却节流，防止请求风暴。多人时建议只开在一台设备上">
                    <input id="sillyroom_auto_respond" type="checkbox"><span data-i18n="自动回应">自动回应</span>
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
                <input id="sillyroom_input" type="text" maxlength="${MAX_MESSAGE_LENGTH}" placeholder="输入消息，Enter 发送…" autocomplete="off" data-i18n="[placeholder]输入消息，Enter 发送…">
                <button id="sillyroom_send" class="menu_button" data-i18n="发送">发送</button>
            </div>
        </div>
    </div>`;

    $('body').append(windowHtml);

    // members container also holds the count chip when joined
    $('<span id="sillyroom_member_count" class="sillyroom_member_count"></span>').text('0').insertAfter('#sillyroom_members_bar > span:first');

    $('#sillyroom_name_display').text(getName()).on('click', function () {
        const current = getName();
        const next = window.prompt(t`修改昵称（最长 24 字符）：`, current);
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
        // P2-2: opening the window acknowledges everything buffered while minimized
        unreadCount = 0;
        renderUnread();
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

    // P2-3: bundle the extension dictionary before building the window, so
    // data-i18n translation at DOM-insertion time sees the entries.
    registerLocales();

    buildWindow();

    // Entry in the wand (extensions) menu
    const menuItem = $('<a id="sillyroom_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0"></a>')
        .attr('title', t`打开多人聊天室`);
    menuItem.append($('<span></span>').text('💬'));
    menuItem.append($('<span></span>').text(t`聊天室`));
    // P2-2: unread badge, shown while the chatroom window is minimized
    menuItem.append($('<span id="sillyroom_unread" class="sillyroom_unread"></span>'));
    menuItem.on('click', () => setWindowVisible($('#sillyroom_window').hasClass('sillyroom_hidden')));
    $('#extensionsMenu').append(menuItem);

    // AI reply relay: plain generations only
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    // Probe the server plugin: shows a clear hint when enableServerPlugins is
    // off, and a login hint when SillyTavern's multi-user mode requires auth.
    probeServer().then(state => {
        if (state === 'login') {
            loginRequired = true;
            setStatus(t`需要登录 SillyTavern 后才能使用聊天室`, 'error');
            toastr.info(t`多人聊天室需要先登录 SillyTavern 账号`, t`聊天室`);
        } else if (state === 'down') {
            setStatus(t`服务端插件未启用`, 'error');
        } else {
            setStatus(t`就绪`, 'connecting');
        }
        if (readStore(STORAGE.open) === '1') {
            setWindowVisible(true);
        }
    });

    console.log('SillyRoom: extension initialized');
}
