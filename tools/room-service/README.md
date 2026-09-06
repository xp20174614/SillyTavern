# Room Service Prototype (Route B)

This is a minimal multi-user room service for "human players + AI NPCs".

## What It Does

- Create a room with multiple NPCs.
- Multiple human users join the same room over WebSocket.
- User messages are broadcast to all users in that room.
- NPCs auto-reply using an OpenAI-compatible endpoint.

## Start

```bash
cd "/Users/xiepeng06/Desktop/ai/SillyTavern/SillyTavern"
ROOM_PORT=8787 \
NPC_API_BASE="http://10.55.119.229:8001/v1" \
NPC_MODEL="/ssd3/models/Minimax-M2.5-BF16-MoE-AWQ-INT4-richcalib-no-w3w2" \
node tools/room-service/server.mjs
```

Optional:

- `ROOM_API_KEY`: if set, REST endpoints require header `x-room-api-key`.
- `ROOM_MAX_HISTORY`: NPC context window length (default `30` messages).

## API

### 1) Create Room

`POST /rooms`

Body example:

```json
{
  "roomId": "case-001",
  "npcs": [
    {
      "id": "forensic",
      "name": "Forensic Doctor",
      "systemPrompt": "You only know forensic evidence. Do not speculate outside your scope."
    },
    {
      "id": "guard",
      "name": "Security Guard",
      "systemPrompt": "You only know camera and entry logs."
    }
  ]
}
```

### 2) Join via WebSocket

`GET /ws?roomId=case-001&userId=u1&name=Alice`

Client can send:

```json
{
  "event": "send",
  "payload": {
    "text": "What happened at 21:30?"
  }
}
```

### 3) Send Message via REST (optional)

`POST /rooms/:roomId/messages`

```json
{
  "userId": "u2",
  "name": "Bob",
  "text": "Show me your timeline."
}
```

### 4) Room State

`GET /rooms/:roomId/state`

## Next Step to Integrate with SillyTavern

This prototype uses your OpenAI-compatible backend directly for NPC replies.

To fully integrate with SillyTavern character cards:

1. Add a mapping `npcId -> SillyTavern character card`.
2. Replace `callNpc()` with SillyTavern backend call built from that character context.
3. Persist room timeline and evidence state in a DB (Redis/Postgres).
