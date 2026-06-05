import { verify } from "hono/jwt";
import {
  getOrCreateRoom,
  addClient,
  removeClient,
  broadcast,
  sendTo,
  getRoomMembers,
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
  moveQueueTrackToEnd,
  type QueueTrack,
  type RepeatMode,
  clearQueue,
  getPlayback,
  setPlayback,
} from "./roomManager.js";
import {
  currentPosition,
  createPlaySnapshot,
  createPauseSnapshot,
  createSeekSnapshot,
} from "../lib/timeline.js";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { rooms, roomQueue } from "../db/schema.js";
import { eq, asc, sql } from "drizzle-orm";
import { pushTrackHistory } from "../db/trackHistory.js";

export type WSMessage =
  | { type: "clock_sync"; serverTime: number }
  | { type: "play"; videoId: string; source: string; seekTo: number; serverTime: number; anchorServerTime: number; id?: string; trackName?: string; artistName?: string; image?: string; duration_ms?: number; recentTracks?: any[] }
  | { type: "pause"; serverTime: number; anchorServerTime: number; positionMs: number }
  | { type: "seek"; seekTo: number; serverTime: number; anchorServerTime: number };

type IncomingMessage =
  | { type: "playback:play"; id?: string; source?: string; videoId: string; trackName?: string; artistName?: string; image?: string; currentTime?: number; duration_ms?: number }
  | { type: "playback:pause"; currentTime?: number }
  | { type: "playback:seek"; currentTime?: number }
  | { type: "playback:ended"; currentTime?: number }
  | { type: "playback:mode"; shuffle?: boolean; repeatMode?: RepeatMode }
  | { type: "playback:sync_request" }
  | { type: "chat:send"; text: string }
  | { type: "queue:add"; track: QueueTrack }
  | { type: "queue:remove"; trackId: string }
  | { type: "queue:cycle_current"; trackId: string }
  | { type: "queue:clear" };

function canControlPlayback(roomCode: string, hostId: string, userId: string) {
  const isHostActive = isHostInRoom(roomCode);
  return !isHostActive || hostId === userId;
}

const syncDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syncLocks = new Map<string, Promise<void>>();

async function syncQueueToDb(roomId: string, queue: QueueTrack[]) {
  while (syncLocks.has(roomId)) {
    try { await syncLocks.get(roomId); } catch { }
  }
  const promise = (async () => {
    try {
      await db.delete(roomQueue).where(eq(roomQueue.roomId, roomId));
      if (queue.length > 0) {
        const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
        const values = queue.map((track, index) => ({
          id: isUuid(track.id) ? track.id : crypto.randomUUID(),
          roomId,
          videoId: track.videoId,
          trackName: track.name,
          artistName: track.artists?.[0]?.name ?? "Unknown",
          image: track.image ?? "",
          durationMs: track.duration_ms ?? 0,
          position: index,
        }));
        await db.insert(roomQueue).values(values).onConflictDoUpdate({
          target: roomQueue.id,
          set: {
            videoId: sql`excluded.video_id`,
            trackName: sql`excluded.track_name`,
            artistName: sql`excluded.artist_name`,
            image: sql`excluded.image`,
            durationMs: sql`excluded.duration_ms`,
            position: sql`excluded.position`,
          },
        });
      }
    } catch (err) {
      console.error("Failed to sync queue to database:", err);
    } finally {
      syncLocks.delete(roomId);
    }
  })();
  syncLocks.set(roomId, promise);
  await promise;
}

function scheduleQueueSync(roomId: string, roomCode: string) {
  const existing = syncDebounceTimers.get(roomId);
  if (existing) clearTimeout(existing);
  syncDebounceTimers.set(roomId, setTimeout(async () => {
    syncDebounceTimers.delete(roomId);
    const q = await getQueue(roomCode);
    syncQueueToDb(roomId, q).catch(console.error);
  }, 10_000));
}

const jwtCache = new Map<string, { payload: any; expiresAt: number }>();

function getCachedJwt(token: string): any | null {
  const cached = jwtCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  jwtCache.delete(token);
  return null;
}

function setCachedJwt(token: string, payload: any) {
  const exp = (payload.exp ?? (Date.now() / 1000 + 3600)) * 1000;
  jwtCache.set(token, { payload, expiresAt: exp - 60_000 });
}

export async function handleWS(ws: any, url: URL) {
  const token = url.searchParams.get("token");
  const roomCode = url.searchParams.get("room")?.toUpperCase();

  if (!token || !roomCode) {
    ws.send(JSON.stringify({ type: "error", message: "Missing token or room" }));
    ws.close();
    return null;
  }

  let payload: any = getCachedJwt(token);
  if (!payload) {
    try {
      payload = await verify(token, process.env.JWT_SECRET!, "HS256");
      setCachedJwt(token, payload);
    } catch (err) {
      console.error("WS auth error:", err);
      ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
      ws.close();
      return null;
    }
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
  await addClient(client);

  const queueFromDb = await db
    .select()
    .from(roomQueue)
    .where(eq(roomQueue.roomId, dbRoom.id))
    .orderBy(asc(roomQueue.position));

  const loadedQueue: QueueTrack[] = queueFromDb.map((item) => ({
    id: item.id,
    source: "youtube",
    videoId: item.videoId,
    name: item.trackName,
    artists: [{ name: item.artistName }],
    image: item.image,
    duration_ms: item.durationMs,
  }));

  const existingQueue = await getQueue(roomCode);
  if (existingQueue.length === 0 && loadedQueue.length > 0) {
    for (const t of loadedQueue) await addToQueue(roomCode, t);
  }

  const serverNow = Date.now();
  ws.send(JSON.stringify({
    type: "clock_sync",
    serverTime: serverNow,
  } satisfies Extract<WSMessage, { type: "clock_sync" }>));

  const [playback, playMode, members, recent, q] = await Promise.all([
    getPlayback(roomCode),
    getPlaybackMode(roomCode),
    getRoomMembers(roomCode),
    getRecentTracks(roomCode),
    getQueue(roomCode),
  ]);

  ws.send(JSON.stringify({
    type: "room:joined",
    roomCode,
    isHost: room.hostId === payload.sub,
    isHostActive: isHostInRoom(roomCode),
    members,
    playback,
    playbackMode: playMode,
    recentTracks: recent,
    queue: q,
  }));

  if (room.hostId === payload.sub) {
    broadcast(roomCode, {
      type: "host:active_changed",
      isHostActive: true,
    });
  }

  broadcast(roomCode, {
    type: "room:member_joined",
    members: await getRoomMembers(roomCode),
    user: { userId: payload.sub, name: payload.name, avatar: payload.avatar },
  }, socketId);

  return {
    async onMessage(event: any) {
      let msg: IncomingMessage;
      try {
        const raw = typeof event.data === "string" ? event.data : event;
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      console.log(`[WS] ${payload.name}: ${msg.type}`, JSON.stringify(msg).slice(0, 200));

      const serverNow = Date.now();

      switch (msg.type) {
        case "chat:send": {
          const chatMsg: ChatMessage = {
            id: nanoid(),
            userId: payload.sub,
            name: payload.name,
            avatar: payload.avatar,
            text: String(msg.text).slice(0, 500),
            ts: serverNow,
          };
          broadcast(roomCode, { type: "chat:message", message: chatMsg });
          break;
        }
        case "playback:play": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          if (!msg.videoId) return;

          const seekTo = Math.max(0, Number(msg.currentTime ?? 0));
          const currentTl = await getPlayback(roomCode);

          if (currentTl?.videoId && currentTl.videoId !== msg.videoId) {
            if (currentTl.isPlaying) {
              pushTrackHistory(dbRoom.id, {
                videoId: currentTl.videoId,
                trackName: currentTl.trackName ?? "",
                artistName: currentTl.artistName ?? "",
                image: currentTl.image ?? "",
              }).catch(console.error);

              pushRecentTrack(roomCode, {
                videoId: currentTl.videoId,
                source: currentTl.source ?? "youtube",
                trackName: currentTl.trackName ?? "",
                artistName: currentTl.artistName ?? "",
                image: currentTl.image ?? "",
                playedAt: serverNow,
              });
            }

            const oldTrack = (await getQueue(roomCode)).find(
              (t) => t.videoId === currentTl.videoId || t.id === currentTl.videoId,
            );
            if (oldTrack) await moveQueueTrackToEnd(roomCode, oldTrack.id);
          }

          const source = "youtube";

          await setPlayback(roomCode, {
            videoId: msg.videoId,
            source,
            trackName: msg.trackName ?? "",
            artistName: msg.artistName ?? "",
            image: msg.image ?? "",
            isPlaying: true,
            currentTime: seekTo,
            updatedAt: serverNow,
          });

          scheduleQueueSync(dbRoom.id, roomCode);

          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });

          broadcast(roomCode, {
            type: "play",
            videoId: msg.videoId,
            source,
            seekTo,
            serverTime: serverNow,
            anchorServerTime: serverNow,
            id: msg.id || `room-${msg.videoId}`,
            trackName: msg.trackName ?? "",
            artistName: msg.artistName ?? "",
            image: msg.image ?? "",
            duration_ms: msg.duration_ms ?? 0,
            recentTracks: getRecentTracks(roomCode),
          });
          break;
        }
        case "playback:pause": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;

          const currentTl = await getPlayback(roomCode);
          const pauseSnapshot = createPauseSnapshot(
            {
              videoId: currentTl?.videoId ?? null,
              trackName: currentTl?.trackName ?? "",
              artistName: currentTl?.artistName ?? "",
              image: currentTl?.image ?? "",
              isPlaying: currentTl?.isPlaying ?? false,
              positionMs: currentTl?.currentTime ?? 0,
              anchorServerTime: currentTl?.updatedAt ?? serverNow,
            },
            serverNow,
          );

          await setPlayback(roomCode, {
            isPlaying: false,
            currentTime: pauseSnapshot.positionMs,
            updatedAt: pauseSnapshot.anchorServerTime,
          });

          broadcast(roomCode, {
            type: "pause",
            serverTime: serverNow,
            anchorServerTime: pauseSnapshot.anchorServerTime,
            positionMs: pauseSnapshot.positionMs,
          } satisfies Extract<WSMessage, { type: "pause" }>);
          break;
        }
        case "playback:seek": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;

          const seekTo = Math.max(0, Number(msg.currentTime ?? 0));

          await setPlayback(roomCode, {
            currentTime: seekTo,
            updatedAt: serverNow,
          });

          broadcast(roomCode, {
            type: "seek",
            seekTo,
            serverTime: serverNow,
            anchorServerTime: serverNow,
          } satisfies Extract<WSMessage, { type: "seek" }>);
          break;
        }
        case "playback:ended": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          const currentPlayback = await getPlayback(roomCode);
          if (!currentPlayback?.videoId) return;

          pushTrackHistory(dbRoom.id, {
            videoId: currentPlayback.videoId,
            trackName: currentPlayback.trackName ?? "",
            artistName: currentPlayback.artistName ?? "",
            image: currentPlayback.image ?? "",
          }).catch(console.error);

          pushRecentTrack(roomCode, {
            videoId: currentPlayback.videoId,
            source: currentPlayback.source ?? "youtube",
            trackName: currentPlayback.trackName ?? "",
            artistName: currentPlayback.artistName ?? "",
            image: currentPlayback.image ?? "",
            playedAt: serverNow,
          });

          const q = await getQueue(roomCode);
          const endedTrack = q.find(
            (t) => t.videoId === currentPlayback.videoId || t.id === currentPlayback.videoId,
          );
          if (endedTrack) await moveQueueTrackToEnd(roomCode, endedTrack.id);

          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });

          await setPlayback(roomCode, {
            isPlaying: false,
            videoId: null,
            currentTime: Math.max(0, Number(msg.currentTime ?? currentPlayback.currentTime ?? 0)),
            updatedAt: serverNow,
          });

          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "playback:mode": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          const mode = await getPlaybackMode(roomCode);
          const next = {
            ...mode,
            ...(typeof msg.shuffle === "boolean" ? { shuffle: msg.shuffle } : {}),
            ...(msg.repeatMode ? { repeatMode: msg.repeatMode } : {}),
          };
          await setPlayback(roomCode, {
            ...(next.shuffle !== undefined ? { shuffle: next.shuffle } : {}),
            ...(next.repeatMode ? { repeatMode: next.repeatMode } : {}),
          } as any);
          broadcast(roomCode, {
            type: "room:playback_mode",
            playbackMode: await getPlaybackMode(roomCode),
          });
          break;
        }
        case "playback:sync_request": {
          const pb = await getPlayback(roomCode);
          sendTo(socketId, roomCode, {
            type: "playback:sync",
            ...pb,
            playbackMode: await getPlaybackMode(roomCode),
            recentTracks: getRecentTracks(roomCode),
            queue: await getQueue(roomCode),
          });
          break;
        }
        case "queue:add": {
          await addToQueue(roomCode, msg.track);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "queue:remove": {
          await removeFromQueue(roomCode, msg.trackId);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "queue:cycle_current": {
          if (!canControlPlayback(roomCode, room.hostId, payload.sub)) return;
          await moveQueueTrackToEnd(roomCode, msg.trackId);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "queue:clear": {
          await clearQueue(roomCode);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
      }
    },

    async onClose() {
      try {
        const wasHost = room.hostId === payload.sub;
        removeClient(socketId, roomCode);
        const timer = syncDebounceTimers.get(dbRoom.id);
        if (timer) {
          clearTimeout(timer);
          syncDebounceTimers.delete(dbRoom.id);
          syncQueueToDb(dbRoom.id, await getQueue(roomCode)).catch(console.error);
        }
        broadcast(roomCode, {
          type: "room:member_left",
          members: await getRoomMembers(roomCode),
          userId: payload.sub,
        });
        if (wasHost) {
          broadcast(roomCode, {
            type: "host:active_changed",
            isHostActive: false,
          });
        }
      } catch (err) {
        console.error("[WS] onClose error:", err);
      }
    },
  };
}
