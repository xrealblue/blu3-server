import { verify } from "hono/jwt";
import {
  getOrCreateRoom,
  addClient,
  removeClient,
  broadcast,
  sendTo,
  getRoomMembers,
  setPlayback,
  getPlayback,
  isHostInRoom,
  type WSClient,
  type ChatMessage,
} from "./roomManager.js";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function handleWS(ws: any, url: URL) {
  const token = url.searchParams.get("token");
  const roomCode = url.searchParams.get("room")?.toUpperCase();

  if (!token || !roomCode) {
    ws.send(
      JSON.stringify({ type: "error", message: "Missing token or room" }),
    );
    ws.close();
    return null;
  }

  let payload: any;
  try {
    payload = await verify(token, process.env.JWT_SECRET!, "HS256");
  } catch (err) {
    console.error("WS auth error:", err);
    ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
    ws.close();
    return null;
  }

  const socketId = nanoid();
  const client: WSClient = {
    id: socketId,
    userId: payload.sub,
    name: payload.name,
    avatar: payload.avatar,
    roomCode,
    ws,
  };

  const [dbRoom] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.code, roomCode))
    .limit(1);

  if (!dbRoom) {
    ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
    ws.close();
    return null;
  }

  const room = getOrCreateRoom(roomCode, dbRoom.hostId);
  addClient(client);

  ws.send(
    JSON.stringify({
      type: "room:joined",
      roomCode,
      isHost: room.hostId === payload.sub,
      members: getRoomMembers(roomCode),
      playback: getPlayback(roomCode),
    }),
  );

  broadcast(
    roomCode,
    {
      type: "room:member_joined",
      members: getRoomMembers(roomCode),
      user: { userId: payload.sub, name: payload.name, avatar: payload.avatar },
    },
    socketId,
  );

  // ← return handlers, no addEventListener
  return {
    onMessage(event: any) {
      let msg: any;
      try {
        const raw = typeof event.data === "string" ? event.data : event;
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case "chat:send": {
          const chatMsg: ChatMessage = {
            id: nanoid(),
            userId: payload.sub,
            name: payload.name,
            avatar: payload.avatar,
            text: String(msg.text).slice(0, 500),
            ts: Date.now(),
          };
          broadcast(roomCode, { type: "chat:message", message: chatMsg });
          break;
        }
        case "playback:play": {
          const isHostActive = isHostInRoom(roomCode);
          if (isHostActive && room.hostId !== payload.sub) return;
          setPlayback(roomCode, {
            videoId: msg.videoId,
            trackName: msg.trackName ?? "",
            artistName: msg.artistName ?? "",
            image: msg.image ?? "",
            isPlaying: true,
            currentTime: msg.currentTime ?? 0,
          });
          broadcast(roomCode, {
            type: "playback:play",
            ...getPlayback(roomCode),
          });
          break;
        }
        case "playback:pause": {
          const isHostActive = isHostInRoom(roomCode);
          if (isHostActive && room.hostId !== payload.sub) return;
          setPlayback(roomCode, {
            isPlaying: false,
            currentTime: msg.currentTime ?? 0,
          });
          broadcast(roomCode, {
            type: "playback:pause",
            currentTime: msg.currentTime,
          });
          break;
        }
        case "playback:seek": {
          const isHostActive = isHostInRoom(roomCode);
          if (isHostActive && room.hostId !== payload.sub) return;
          setPlayback(roomCode, { currentTime: msg.currentTime ?? 0 });
          broadcast(roomCode, {
            type: "playback:seek",
            currentTime: msg.currentTime,
          });
          break;
        }
        case "playback:sync_request": {
          sendTo(socketId, roomCode, {
            type: "playback:sync",
            ...getPlayback(roomCode),
          });
          break;
        }
      }
    },

    onClose() {
      removeClient(socketId, roomCode);
      broadcast(roomCode, {
        type: "room:member_left",
        members: getRoomMembers(roomCode),
        userId: payload.sub,
      });
      console.log(`WS closed: ${payload.name} left ${roomCode}`);
    },
  };
}
