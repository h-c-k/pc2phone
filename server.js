import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8765;

// Room = { pc: WebSocket | null, phone: WebSocket | null }
const rooms = new Map();

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`[Relay] Listening on port ${PORT}`);
});

wss.on("connection", (ws) => {
  let role = null; // "pc" or "phone"
  let roomCode = null;

  ws.on("message", (data) => {
    const text = data.toString();

    // First message must be a registration
    if (!role) {
      try {
        const msg = JSON.parse(text);

        if (msg.type === "register_pc") {
          const pairId = msg.pair_id?.toUpperCase();
          if (!pairId) {
            ws.send(JSON.stringify({ type: "error", message: "pair_id required" }));
            ws.close();
            return;
          }

          let room = rooms.get(pairId);
          if (room) {
            // Room exists — update PC socket, close old one if stale
            if (room.pc && room.pc !== ws && room.pc.readyState === 1) {
              try { room.pc.close(); } catch {}
            }
            room.pc = ws;
          } else {
            room = { pc: ws, phone: null };
            rooms.set(pairId, room);
          }

          role = "pc";
          roomCode = pairId;
          ws.send(JSON.stringify({ type: "room_code", code: pairId }));
          console.log(`[Relay] PC registered, pair_id: ${pairId}`);

          // If phone was already waiting in this room
          if (room.phone?.readyState === 1) {
            room.phone.send(JSON.stringify({ type: "joined", code: pairId }));
            ws.send(JSON.stringify({ type: "phone_connected" }));
          }
          return;
        }

        if (msg.type === "join_room") {
          const code = msg.code?.toUpperCase();
          if (!code) {
            ws.send(JSON.stringify({ type: "error", message: "code required" }));
            ws.close();
            return;
          }

          let room = rooms.get(code);

          if (!room) {
            // No room yet — create a waiting room (phone waits for PC)
            room = { pc: null, phone: ws };
            rooms.set(code, room);
            role = "phone";
            roomCode = code;
            ws.send(JSON.stringify({ type: "waiting", code }));
            console.log(`[Relay] Phone waiting in room: ${code}`);
            return;
          }

          // Room exists — replace any stale phone connection
          if (room.phone && room.phone !== ws && room.phone.readyState === 1) {
            try { room.phone.close(); } catch {}
          }
          room.phone = ws;
          role = "phone";
          roomCode = code;

          if (room.pc?.readyState === 1) {
            // PC is here — pair immediately
            ws.send(JSON.stringify({ type: "joined", code }));
            room.pc.send(JSON.stringify({ type: "phone_connected" }));
          } else {
            // PC not connected yet — wait
            ws.send(JSON.stringify({ type: "waiting", code }));
          }
          console.log(`[Relay] Phone joined room: ${code}`);
          return;
        }
      } catch {
        // Not JSON, ignore
      }
      ws.send(JSON.stringify({ type: "error", message: "Send register_pc or join_room first" }));
      return;
    }

    // Already registered — forward messages to the other peer
    const room = rooms.get(roomCode);
    if (!room) return;

    const peer = role === "pc" ? room.phone : room.pc;
    if (peer?.readyState === 1) {
      peer.send(text);
    }
  });

  ws.on("close", () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    console.log(`[Relay] ${role} disconnected from room ${roomCode}`);

    if (role === "pc") {
      room.pc = null;
      // Notify phone that PC left
      if (room.phone?.readyState === 1) {
        room.phone.send(JSON.stringify({ type: "peer_disconnected" }));
      }
      // Delete room only if both are gone
      if (!room.phone || room.phone.readyState !== 1) {
        rooms.delete(roomCode);
        console.log(`[Relay] Room ${roomCode} deleted (empty)`);
      }
    } else if (role === "phone") {
      room.phone = null;
      // Notify PC that phone left
      if (room.pc?.readyState === 1) {
        room.pc.send(JSON.stringify({ type: "peer_disconnected" }));
      }
      // Delete room only if both are gone
      if (!room.pc || room.pc.readyState !== 1) {
        rooms.delete(roomCode);
        console.log(`[Relay] Room ${roomCode} deleted (empty)`);
      }
    }
  });

  ws.on("error", () => {
    ws.close();
  });
});
