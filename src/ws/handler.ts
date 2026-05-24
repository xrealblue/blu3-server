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
  getRecentTracks,
  pushRecentTrack,
  getQueue,
  addToQueue,
  removeFromQueue,
  insertQueueTop,
  getPlaybackMode,
  setPlaybackMode,
  moveQueueTrackToEnd,
  type QueueTrack,
  type RepeatMode,
} from "./roomManager.js";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { pushTrackHistory } from "../db/trackHistory.js";

const PLAY_SCHEDULE_LEAD_MS = 1500;
const CONTROL_SCHEDULE_LEAD_MS = 350;

export type WSMessage =
  | { type: "clock_sync"; serverTime: number }
  | { type: "ping"; clientTime: number }
  | { type: "pong"; serverTime: number; rtt: number }
  | { type: "schedule_play"; videoId: string; seekTo: number; targetTime: number }
  | { type: "schedule_pause"; targetTime: number }
  | { type: "schedule_seek"; seekTo: number; targetTime: number }
  | {
      type: "playback_state";
      state: "playing" | "paused" | "buffering";
      currentTime: number;
    };

type IncomingMessage =
  | WSMessage
  | { type: "chat:send"; text: string }
  | {
      type: "playback:play";
      id?: string;
      videoId: string;
      trackName?: string;
      artistName?: string;
      image?: string;
      currentTime?: number;
      duration_ms?: number;
    }
  | { type: "playback:pause"; currentTime?: number }
  | { type: "playback:seek"; currentTime?: number }
  | { type: "playback:mode"; shuffle?: boolean; repeatMode?: RepeatMode }
  | { type: "playback:sync_request" }
  | { type: "queue:add"; track: QueueTrack }
  | { type: "queue:remove"; trackId: string }
  | { type: "queue:cycle_current"; trackId: string };

function canControlPlayback(roomCode: string, hostId: string, userId: string) {
  const isHostActive = isHostInRoom(roomCode);
  return !isHostActive || hostId === userId;
}

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
      type: "clock_sync",
      serverTime: Date.now(),
    } satisfies Extract<WSMessage, { type: "clock_sync" }>),
  );

  ws.send(
    JSON.stringify({
      type: "room:joined",
      roomCode,
      isHost: room.hostId === payload.sub,
      members: getRoomMembers(roomCode),
      playback: getPlayback(roomCode),
      playbackMode: getPlaybackMode(roomCode),
      recentTracks: getRecentTracks(roomCode),
      queue: getQueue(roomCode),
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
      let msg: IncomingMessage;
      try {
        const raw = typeof event.data === "string" ? event.data : event;
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case "ping": {
          sendTo(socketId, roomCode, {
            type: "pong",
            serverTime: Date.now(),
            rtt: 0,
          } satisfies Extract<WSMessage, { type: "pong" }>);
          break;
        }
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
        case "playback_state": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          setPlayback(roomCode, {
            isPlaying: msg.state === "playing",
            currentTime: Number(msg.currentTime ?? 0),
          });
          break;
        }
        case "playback:play": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;

          const targetTime = Date.now() + PLAY_SCHEDULE_LEAD_MS;
          const seekTo = Math.max(0, Number(msg.currentTime ?? 0));

          setPlayback(roomCode, {
            videoId: msg.videoId,
            trackName: msg.trackName ?? "",
            artistName: msg.artistName ?? "",
            image: msg.image ?? "",
            isPlaying: true,
            currentTime: seekTo,
            updatedAt: targetTime,
          });

          if (msg.videoId) {
            pushTrackHistory(dbRoom.id, {
              videoId: msg.videoId,
              trackName: msg.trackName ?? "",
              artistName: msg.artistName ?? "",
              image: msg.image ?? "",
            }).catch(console.error);

            pushRecentTrack(roomCode, {
              videoId: msg.videoId,
              trackName: msg.trackName ?? "",
              artistName: msg.artistName ?? "",
              image: msg.image ?? "",
              playedAt: Date.now(),
            });

            // Insert played track at the top of the queue
            const queueTrack = {
              id: msg.id || `room-${msg.videoId}`,
              videoId: msg.videoId,
              name: msg.trackName ?? "",
              artists: [{ name: msg.artistName ?? "" }],
              image: msg.image ?? "",
              duration_ms: msg.duration_ms ?? 0,
            };
            insertQueueTop(roomCode, queueTrack);
          }

          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
          });

          broadcast(roomCode, {
            type: "schedule_play",
            videoId: msg.videoId,
            seekTo,
            targetTime,
            id: msg.id || `room-${msg.videoId}`,
            trackName: msg.trackName ?? "",
            artistName: msg.artistName ?? "",
            image: msg.image ?? "",
            duration_ms: msg.duration_ms ?? 0,
            recentTracks: getRecentTracks(roomCode),
            queue: getQueue(roomCode),
          });
          break;
        }
        case "playback:pause": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;

          const targetTime = Date.now() + CONTROL_SCHEDULE_LEAD_MS;
          const currentPlayback = getPlayback(roomCode);
          const pauseAt =
            Math.max(0, Number(msg.currentTime ?? currentPlayback?.currentTime ?? 0)) +
            ((currentPlayback?.isPlaying ?? true)
              ? CONTROL_SCHEDULE_LEAD_MS / 1000
              : 0);

          setPlayback(roomCode, {
            isPlaying: false,
            currentTime: pauseAt,
            updatedAt: targetTime,
          });
          broadcast(roomCode, {
            type: "schedule_pause",
            targetTime,
          });
          break;
        }
        case "playback:seek": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;

          const targetTime = Date.now() + CONTROL_SCHEDULE_LEAD_MS;
          const seekTo = Math.max(0, Number(msg.currentTime ?? 0));

          setPlayback(roomCode, {
            currentTime: seekTo,
            updatedAt: targetTime,
          });
          broadcast(roomCode, {
            type: "schedule_seek",
            seekTo,
            targetTime,
          });
          break;
        }
        case "playback:mode": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          setPlaybackMode(roomCode, {
            ...(typeof msg.shuffle === "boolean"
              ? { shuffle: msg.shuffle }
              : {}),
            ...(msg.repeatMode ? { repeatMode: msg.repeatMode } : {}),
          });
          broadcast(roomCode, {
            type: "room:playback_mode",
            playbackMode: getPlaybackMode(roomCode),
          });
          break;
        }
        case "playback:sync_request": {
          sendTo(socketId, roomCode, {
            type: "playback:sync",
            ...getPlayback(roomCode),
            playbackMode: getPlaybackMode(roomCode),
            recentTracks: getRecentTracks(roomCode),
            queue: getQueue(roomCode),
          });
          break;
        }
        case "queue:add": {
          addToQueue(roomCode, msg.track);
          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
          });
          break;
        }
        case "queue:remove": {
          removeFromQueue(roomCode, msg.trackId);
          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
          });
          break;
        }
        case "queue:cycle_current": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          moveQueueTrackToEnd(roomCode, msg.trackId);
          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
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
