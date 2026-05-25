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
  clearQueue,
} from "./roomManager.js";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { rooms, roomQueue } from "../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { pushTrackHistory } from "../db/trackHistory.js";

const DEFAULT_PLAY_SCHEDULE_LEAD_MS = 400;
const MIN_PLAY_SCHEDULE_LEAD_MS = 250;
const MAX_PLAY_SCHEDULE_LEAD_MS = 800;
const DEFAULT_CONTROL_SCHEDULE_LEAD_MS = 180;
const MIN_CONTROL_SCHEDULE_LEAD_MS = 120;
const MAX_CONTROL_SCHEDULE_LEAD_MS = 350;

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
      leadMs?: number;
    }
  | { type: "playback:pause"; currentTime?: number; leadMs?: number }
  | { type: "playback:seek"; currentTime?: number; leadMs?: number }
  | { type: "playback:ended"; currentTime?: number }
  | { type: "playback:mode"; shuffle?: boolean; repeatMode?: RepeatMode }
  | { type: "playback:sync_request" }
  | { type: "queue:add"; track: QueueTrack }
  | { type: "queue:remove"; trackId: string }
  | { type: "queue:cycle_current"; trackId: string }
  | { type: "queue:clear" };

function clampLeadMs(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
) {
  const next = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(Math.max(next, min), max);
}

function canControlPlayback(roomCode: string, hostId: string, userId: string) {
  const isHostActive = isHostInRoom(roomCode);
  return !isHostActive || hostId === userId;
}

async function syncQueueToDb(roomId: string, queue: QueueTrack[]) {
  try {
    // 1. Delete all existing queue tracks for the room
    await db.delete(roomQueue).where(eq(roomQueue.roomId, roomId));

    // 2. Insert all current tracks with their position indices
    if (queue.length > 0) {
      await db.insert(roomQueue).values(
        queue.map((track, index) => {
          const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(track.id);
          return {
            id: isValidUuid ? track.id : undefined,
            roomId,
            videoId: track.videoId,
            trackName: track.name,
            artistName: track.artists?.[0]?.name ?? "Unknown",
            image: track.image ?? "",
            durationMs: track.duration_ms ?? 0,
            position: index,
          };
        })
      );
    }
  } catch (err) {
    console.error("Failed to sync queue to database:", err);
  }
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

  if (!room.isQueueLoaded) {
    try {
      const dbQueue = await db
        .select()
        .from(roomQueue)
        .where(eq(roomQueue.roomId, dbRoom.id))
        .orderBy(asc(roomQueue.position));

      room.queue = dbQueue.map((item) => ({
        id: item.id,
        videoId: item.videoId,
        name: item.trackName,
        artists: [{ name: item.artistName }],
        image: item.image,
        duration_ms: item.durationMs,
      }));
      room.isQueueLoaded = true;
    } catch (err) {
      console.error("Failed to load queue from database:", err);
    }
  }

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
    async onMessage(event: any) {
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

          const leadMs = clampLeadMs(
            msg.leadMs,
            MIN_PLAY_SCHEDULE_LEAD_MS,
            MAX_PLAY_SCHEDULE_LEAD_MS,
            DEFAULT_PLAY_SCHEDULE_LEAD_MS,
          );
          const targetTime = Date.now() + leadMs;
          const seekTo = Math.max(0, Number(msg.currentTime ?? 0));

          const currentPlayback = getPlayback(roomCode);
          if (
            currentPlayback?.videoId &&
            currentPlayback.videoId !== msg.videoId
          ) {
            // Push old song to persistent database history
            pushTrackHistory(dbRoom.id, {
              videoId: currentPlayback.videoId,
              trackName: currentPlayback.trackName ?? "",
              artistName: currentPlayback.artistName ?? "",
              image: currentPlayback.image ?? "",
            }).catch(console.error);

            // Push old song to in-memory recent tracks
            pushRecentTrack(roomCode, {
              videoId: currentPlayback.videoId,
              trackName: currentPlayback.trackName ?? "",
              artistName: currentPlayback.artistName ?? "",
              image: currentPlayback.image ?? "",
              playedAt: Date.now(),
            });

            // Move old song to bottom of queue
            const roomObj = getOrCreateRoom(roomCode, dbRoom.hostId);
            if (roomObj) {
              const currentTrackIndex = roomObj.queue.findIndex(t => t.videoId === currentPlayback.videoId);
              if (currentTrackIndex !== -1) {
                const track = roomObj.queue[currentTrackIndex];
                roomObj.queue.splice(currentTrackIndex, 1);
                roomObj.queue.push(track);
              }
            }
          }

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

          await syncQueueToDb(dbRoom.id, getQueue(roomCode)).catch(console.error);

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

          const leadMs = clampLeadMs(
            msg.leadMs,
            MIN_CONTROL_SCHEDULE_LEAD_MS,
            MAX_CONTROL_SCHEDULE_LEAD_MS,
            DEFAULT_CONTROL_SCHEDULE_LEAD_MS,
          );
          const targetTime = Date.now() + leadMs;
          const currentPlayback = getPlayback(roomCode);
          const pauseAt =
            Math.max(0, Number(msg.currentTime ?? currentPlayback?.currentTime ?? 0)) +
            ((currentPlayback?.isPlaying ?? true)
              ? leadMs / 1000
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

          const leadMs = clampLeadMs(
            msg.leadMs,
            MIN_CONTROL_SCHEDULE_LEAD_MS,
            MAX_CONTROL_SCHEDULE_LEAD_MS,
            DEFAULT_CONTROL_SCHEDULE_LEAD_MS,
          );
          const targetTime = Date.now() + leadMs;
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
        case "playback:ended": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          const currentPlayback = getPlayback(roomCode);
          if (!currentPlayback?.videoId) return;

          setPlayback(roomCode, {
            isPlaying: false,
            currentTime: Math.max(
              0,
              Number(msg.currentTime ?? currentPlayback.currentTime ?? 0),
            ),
          });

          pushTrackHistory(dbRoom.id, {
            videoId: currentPlayback.videoId,
            trackName: currentPlayback.trackName ?? "",
            artistName: currentPlayback.artistName ?? "",
            image: currentPlayback.image ?? "",
          }).catch(console.error);

          pushRecentTrack(roomCode, {
            videoId: currentPlayback.videoId,
            trackName: currentPlayback.trackName ?? "",
            artistName: currentPlayback.artistName ?? "",
            image: currentPlayback.image ?? "",
            playedAt: Date.now(),
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
          await syncQueueToDb(dbRoom.id, getQueue(roomCode)).catch(console.error);
          break;
        }
        case "queue:remove": {
          removeFromQueue(roomCode, msg.trackId);
          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
          });
          await syncQueueToDb(dbRoom.id, getQueue(roomCode)).catch(console.error);
          break;
        }
        case "queue:cycle_current": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          moveQueueTrackToEnd(roomCode, msg.trackId);
          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
          });
          await syncQueueToDb(dbRoom.id, getQueue(roomCode)).catch(console.error);
          break;
        }
        case "queue:clear": {
          clearQueue(roomCode);
          broadcast(roomCode, {
            type: "room:queue_update",
            queue: getQueue(roomCode),
          });
          await syncQueueToDb(dbRoom.id, getQueue(roomCode)).catch(console.error);
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
