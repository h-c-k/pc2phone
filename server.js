import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8765;

// Room = { pc: WebSocket, phone: WebSocket }
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code.slice(0, 3) + "-" + code.slice(3);
}

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
          // PC wants a new room
          const code = generateCode();
          rooms.set(code, { pc: ws, phone: null });
          role = "pc";
          roomCode = code;
          ws.send(JSON.stringify({ type: "room_code", code }));
          console.log(`[Relay] PC registered, room: ${code}`);
          return;
        }

        if (msg.type === "join_room") {
          // Phone wants to join a room
          const code = msg.code?.toUpperCase();
          const room = rooms.get(code);
          if (!room) {
            ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
            ws.close();
            return;
          }
          if (room.phone) {
            ws.send(JSON.stringify({ type: "error", message: "Room already has a phone" }));
            ws.close();
            return;
          }
          room.phone = ws;
          role = "phone";
          roomCode = code;
          ws.send(JSON.stringify({ type: "joined", code }));
          // Notify PC that phone connected
          if (room.pc?.readyState === 1) {
            room.pc.send(JSON.stringify({ type: "phone_connected" }));
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

    // Notify the other peer
    const peer = role === "pc" ? room.phone : room.pc;
    if (peer?.readyState === 1) {
      peer.send(JSON.stringify({ type: "peer_disconnected" }));
      peer.close();
    }

    // Clean up room
    rooms.delete(roomCode);
  });

  ws.on("error", () => {
    ws.close();
  });
});
