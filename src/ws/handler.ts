import { getSessionFromRequest } from "../lib/auth.js";
import { decodeJwt } from "jose";
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
  type PlaybackState,
  clearQueue,
  getPlayback,
  setPlayback,
  getTimeline,
} from "./roomManager.js";
import { createPauseSnapshot, createResumeSnapshot, effectiveElapsedMs, currentPosition } from "../lib/timeline.js";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { rooms, roomQueue } from "../db/schema.js";
import { eq, asc, sql } from "drizzle-orm";
import { pushTrackHistory } from "../db/trackHistory.js";
import { getYouTubeAudioUrl } from "../lib/ytAudio.js";
import { resolveJioSaavn } from "../lib/jiosaavnAudio.js";

const MAX_SEEK_SEC = 3600;
function clampTime(v: number | undefined | null, max = MAX_SEEK_SEC): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0;
}

// ── Server-side auto-advance timers ──────────────────────
const advanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTrackEnd(roomCode: string) {
  const existing = advanceTimers.get(roomCode);
  if (existing) {
    clearTimeout(existing);
    advanceTimers.delete(roomCode);
  }
}

async function handleTrackEnd(roomCode: string) {
  advanceTimers.delete(roomCode);
  const tl = await getTimeline(roomCode);
  if (!tl.isPlaying || !tl.videoId) return;

  const serverNow = Date.now();

  // Verify the track has actually elapsed enough — the timer may have fired
  // early if the user paused between scheduling and now.
  if (tl.durationMs > 0) {
    const elapsedMs = effectiveElapsedMs(tl, serverNow);
    const remainingMs = Math.max(1000, tl.durationMs - elapsedMs);
    if (remainingMs < 86400000) {
      scheduleTrackEnd(roomCode, remainingMs);
      return;
    }
  }

  const [roomRow] = await db.select().from(rooms).where(eq(rooms.code, roomCode)).limit(1);
  if (!roomRow) return;

  await pushTrackHistory(roomRow.id, {
    videoId: tl.videoId,
    trackName: tl.trackName ?? "",
    artistName: tl.artistName ?? "",
    image: tl.image ?? "",
  }).catch(console.error);

  pushRecentTrack(roomCode, {
    videoId: tl.videoId,
    source: tl.source ?? "youtube",
    trackName: tl.trackName ?? "",
    artistName: tl.artistName ?? "",
    image: tl.image ?? "",
    playedAt: serverNow,
  });

  const q = await getQueue(roomCode);
  const endedTrack = q.find((t) => t.videoId === tl.videoId || t.id === tl.videoId);
  if (endedTrack) await moveQueueTrackToEnd(roomCode, endedTrack.id);

  const nextTrack = q.length > 1 ? q[1] ?? q[0] : q[0];
  if (nextTrack && nextTrack.videoId) {
    await setPlayback(roomCode, {
      videoId: nextTrack.videoId,
      source: nextTrack.source ?? "youtube",
      trackName: nextTrack.name ?? "",
      artistName: nextTrack.artists?.[0]?.name ?? "",
      image: nextTrack.image ?? "",
      isPlaying: true,
      currentTime: 0,
      startedAt: serverNow,
      pausedDurationMs: 0,
      durationMs: nextTrack.duration_ms ?? 0,
      updatedAt: serverNow,
    });

    const nextDurMs = nextTrack.duration_ms ?? 0;
    if (nextDurMs > 0) {
      scheduleTrackEnd(roomCode, nextDurMs);
    }

    broadcast(roomCode, {
      type: "play",
      videoId: nextTrack.videoId,
      source: nextTrack.source ?? "youtube",
      seekTo: 0,
      serverTime: serverNow,
      anchorServerTime: serverNow,
      id: nextTrack.id || `room-${nextTrack.videoId}`,
      trackName: nextTrack.name ?? "",
      artistName: nextTrack.artists?.[0]?.name ?? "",
      image: nextTrack.image ?? "",
      duration_ms: nextDurMs,
      recentTracks: getRecentTracks(roomCode),
    });

    // Pre-resolve next-next track
    const allQ = await getQueue(roomCode);
    const nextNextTrack = allQ.length > 2 ? allQ[2] ?? allQ[1] : null;
    if (nextNextTrack?.videoId) {
      const nt = nextNextTrack;
      (async () => {
        let url: string | null = null;
        if (nt.source !== "youtube" && nt.name?.trim()) {
          const jr = await resolveJioSaavn(nt.videoId, nt.name, nt.artists?.[0]?.name, nt.duration_ms).catch(() => null);
          if (jr?.url) url = `/api/audio/${nt.videoId}`;
        }
        if (!url && /^[a-zA-Z0-9_-]{11}$/.test(nt.videoId)) {
          const yt = await getYouTubeAudioUrl(nt.videoId).catch(() => null);
          if (yt) url = `/api/audio/${nt.videoId}`;
        }
        if (url) broadcast(roomCode, { type: "track:preresolved", videoId: nt.videoId, audioUrl: url });
      })();
    }
  } else {
    await setPlayback(roomCode, { isPlaying: false, updatedAt: serverNow });
  }

  broadcast(roomCode, {
    type: "room:queue_update",
    queue: await getQueue(roomCode),
    recentTracks: getRecentTracks(roomCode),
  });
  scheduleQueueSync(roomRow.id, roomCode);
}

function scheduleTrackEnd(roomCode: string, delayMs: number) {
  cancelTrackEnd(roomCode);
  if (delayMs <= 0 || delayMs > 86400000) return;
  advanceTimers.set(roomCode, setTimeout(() => {
    handleTrackEnd(roomCode);
  }, delayMs));
}

export type WSMessage =
  | { type: "clock_sync"; serverTime: number }
  | { type: "play"; videoId: string; source: string; seekTo: number; serverTime: number; anchorServerTime: number; id?: string; trackName?: string; artistName?: string; image?: string; duration_ms?: number; recentTracks?: any[] }
  | { type: "pause"; serverTime: number; anchorServerTime: number; positionSec: number }
  | { type: "seek"; seekTo: number; serverTime: number; anchorServerTime: number };

type IncomingMessage =
  | { type: "playback:play"; id?: string; source?: string; videoId: string; trackName?: string; artistName?: string; image?: string; currentTime?: number; duration_ms?: number }
  | { type: "playback:pause"; currentTime?: number }
  | { type: "playback:seek"; currentTime?: number }
  | { type: "playback:ended"; currentTime?: number }
  | { type: "playback:mode"; shuffle?: boolean; repeatMode?: RepeatMode }
  | { type: "playback:sync_request" }
  | { type: "clock_sync_request" }
  | { type: "chat:send"; text: string }
  | { type: "queue:add"; track: QueueTrack }
  | { type: "queue:remove"; trackId: string }
  | { type: "queue:cycle_current"; trackId: string }
  | { type: "queue:clear" };

function canControlPlayback(roomCode: string, hostId: string, userId: string, userRole?: string) {
  if (userRole === "admin") return true;
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

const sessionCache = new Map<string, { user: any; expiresAt: number }>();

export async function handleWS(ws: any, url: URL) {
  const token = url.searchParams.get("token");
  const roomCode = url.searchParams.get("room")?.toUpperCase();

  if (!token || !roomCode) {
    ws.send(JSON.stringify({ type: "error", message: "Missing token or room" }));
    ws.close();
    return null;
  }

  let user: any = null;
  const cached = sessionCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    user = cached.user;
  } else {
    try {
      const session = await getSessionFromRequest(
        new Headers({ Authorization: `Bearer ${token}` }),
      );
      if (!session?.user) throw new Error("No session");
      user = session.user;
    } catch {
      try {
        const payload = decodeJwt(token);
        if (!payload.sub || !payload.email) throw new Error("Invalid JWT payload");
        user = {
          id: payload.sub as string,
          name: (payload.name as string) ?? (payload.email as string),
          email: payload.email as string,
          image: (payload.avatar as string) ?? null,
          role: "user",
        };
      } catch (jwtErr) {
        console.error("WS auth error:", jwtErr);
        ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
        ws.close();
        return null;
      }
    }
    sessionCache.set(token, { user, expiresAt: Date.now() + 5 * 60 * 1000 });
  }

  const socketId = nanoid();
  const client: WSClient = {
    id: socketId,
    userId: user.id,
    name: user.name,
    avatar: user.image,
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
  console.log(`ws. ${(user.email ?? user.name ?? user.id).split("@")[0]} connected`);

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
    isHost: room.hostId === user.id,
    isHostActive: isHostInRoom(roomCode),
    members,
    playback,
    playbackMode: playMode,
    recentTracks: recent,
    queue: q,
  }));

  if (room.hostId === user.id) {
    broadcast(roomCode, {
      type: "host:active_changed",
      isHostActive: true,
    });
  }

  broadcast(roomCode, {
    type: "room:member_joined",
    members: await getRoomMembers(roomCode),
    user: { userId: user.id, name: user.name, avatar: user.image },
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

      const serverNow = Date.now();

      switch (msg.type) {
        case "clock_sync_request": {
          ws.send(JSON.stringify({
            type: "clock_sync",
            serverTime: Date.now(),
          }));
          break;
        }
        case "chat:send": {
          const chatMsg: ChatMessage = {
            id: nanoid(),
            userId: user.id,
            name: user.name,
            avatar: user.image,
            text: String(msg.text).slice(0, 500),
            ts: serverNow,
          };
          broadcast(roomCode, { type: "chat:message", message: chatMsg });
          break;
        }
        case "playback:play": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;
          if (!msg.videoId) return;

          const currentTl = await getPlayback(roomCode);
          const isResume = currentTl?.videoId === msg.videoId && !currentTl?.isPlaying;

          // Resume from pause: the server has the authoritative position
          let seekTo = isResume
            ? currentTl!.currentTime
            : clampTime(msg.currentTime);

          if (currentTl?.videoId && currentTl.videoId !== msg.videoId && currentTl.isPlaying) {
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

            const oldTrack = (await getQueue(roomCode)).find(
              (t) => t.videoId === currentTl.videoId || t.id === currentTl.videoId,
            );
            if (oldTrack) await moveQueueTrackToEnd(roomCode, oldTrack.id);
          }

          const isNewTrack = !currentTl?.videoId || currentTl.videoId !== msg.videoId;
          const source = "youtube";

          // Cancel old advance timer — will reschedule below
          cancelTrackEnd(roomCode);

          const setState: Partial<PlaybackState> & { updatedAt?: number } = {
            videoId: msg.videoId,
            source,
            trackName: msg.trackName ?? "",
            artistName: msg.artistName ?? "",
            image: msg.image ?? "",
            isPlaying: true,
            currentTime: seekTo,
            durationMs: msg.duration_ms ?? 0,
            updatedAt: serverNow,
          };

          if (isNewTrack) {
            setState.startedAt = serverNow;
            setState.pausedDurationMs = 0;
          } else {
            // Resume: keep original startedAt, accumulate pause duration
            const resumeSnapshot = createResumeSnapshot(
              {
                videoId: currentTl!.videoId,
                trackName: currentTl!.trackName ?? "",
                artistName: currentTl!.artistName ?? "",
                image: currentTl!.image ?? "",
                isPlaying: false,
                positionSec: currentTl!.currentTime,
                anchorServerTime: currentTl!.updatedAt,
                startedAt: currentTl!.startedAt,
                pausedDurationMs: currentTl!.pausedDurationMs,
                durationMs: currentTl!.durationMs,
              },
              serverNow,
            );
            setState.startedAt = resumeSnapshot.startedAt;
            setState.pausedDurationMs = resumeSnapshot.pausedDurationMs;
          }

          await setPlayback(roomCode, setState);

          // Server-side auto-advance: schedule a check when this track should end.
          // The timeout fires at the expected end time; the callback verifies the
          // same track is still playing before advancing.
          const durMs = msg.duration_ms ?? 0;
          const remainingMs = Math.max(1000, durMs - seekTo * 1000);
          if (durMs > 0 && remainingMs < 86400000) {
            scheduleTrackEnd(roomCode, remainingMs);
          }

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
            duration_ms: durMs,
            recentTracks: getRecentTracks(roomCode),
          });

          // Pre-resolve next track (Layer 3: server pre-push)
          getQueue(roomCode).then(q => {
            const nextTrack = q.length > 1 ? q[1] ?? q[0] : q[0];
            if (!nextTrack?.videoId) return;
            const nt = nextTrack;
            (async () => {
              let url: string | null = null;
              if (nt.source !== "youtube" && nt.name?.trim()) {
                const jr = await resolveJioSaavn(nt.videoId, nt.name, nt.artists?.[0]?.name, nt.duration_ms).catch(() => null);
                if (jr?.url) url = `/api/audio/${nt.videoId}`;
              }
              if (!url && /^[a-zA-Z0-9_-]{11}$/.test(nt.videoId)) {
                const yt = await getYouTubeAudioUrl(nt.videoId).catch(() => null);
                if (yt) url = `/api/audio/${nt.videoId}`;
              }
              if (url) broadcast(roomCode, { type: "track:preresolved", videoId: nt.videoId, audioUrl: url });
            })();
          }).catch(() => {});
          break;
        }
        case "playback:pause": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;

          cancelTrackEnd(roomCode);

          const currentTl = await getPlayback(roomCode);
          const pauseSnapshot = createPauseSnapshot(
            {
              videoId: currentTl?.videoId ?? null,
              trackName: currentTl?.trackName ?? "",
              artistName: currentTl?.artistName ?? "",
              image: currentTl?.image ?? "",
              isPlaying: currentTl?.isPlaying ?? false,
              positionSec: currentTl?.currentTime ?? 0,
              anchorServerTime: currentTl?.updatedAt ?? serverNow,
              startedAt: currentTl?.startedAt ?? 0,
              pausedDurationMs: currentTl?.pausedDurationMs ?? 0,
              durationMs: currentTl?.durationMs ?? 0,
            },
            serverNow,
          );

          await setPlayback(roomCode, {
            isPlaying: false,
            currentTime: pauseSnapshot.positionSec,
            updatedAt: pauseSnapshot.anchorServerTime,
          });

          broadcast(roomCode, {
            type: "pause",
            serverTime: serverNow,
            anchorServerTime: pauseSnapshot.anchorServerTime,
            positionSec: pauseSnapshot.positionSec,
          } satisfies Extract<WSMessage, { type: "pause" }>);
          break;
        }
        case "playback:seek": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;

          cancelTrackEnd(roomCode);

          const seekTo = clampTime(msg.currentTime);

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
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;

          cancelTrackEnd(roomCode);

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

          await setPlayback(roomCode, {
            isPlaying: false,
            currentTime: clampTime(msg.currentTime ?? currentPlayback.currentTime),
            updatedAt: serverNow,
          });

          broadcast(roomCode, {
            type: "room:queue_update",
            queue: await getQueue(roomCode),
            recentTracks: getRecentTracks(roomCode),
          });

          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "playback:mode": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;
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
          // Reschedule track-end timer using stored timeline's actual position
          const tl = await getTimeline(roomCode);
          if (tl.isPlaying && tl.videoId && tl.durationMs > 0) {
            const remainingMs = Math.max(1000, tl.durationMs - currentPosition(tl, Date.now()) * 1000);
            if (remainingMs < 86400000) {
              scheduleTrackEnd(roomCode, remainingMs);
            }
          }
          break;
        }
        case "queue:add": {
          await addToQueue(roomCode, msg.track);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "queue:remove": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;
          await removeFromQueue(roomCode, msg.trackId);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "queue:cycle_current": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;
          await moveQueueTrackToEnd(roomCode, msg.trackId);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
        case "queue:clear": {
          if (!canControlPlayback(roomCode, room.hostId, user.id, user.role)) return;
          await clearQueue(roomCode);
          broadcast(roomCode, { type: "room:queue_update", queue: await getQueue(roomCode) });
          scheduleQueueSync(dbRoom.id, roomCode);
          break;
        }
      }
    },

    async onClose() {
      try {
        const wasHost = room.hostId === user.id;
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
          userId: user.id,
        });
        if (wasHost) {
          broadcast(roomCode, {
            type: "host:active_changed",
            isHostActive: false,
          });
        }
        console.log(`ws. ${(user.email ?? user.name ?? user.id).split("@")[0]} disconnected`);
      } catch (err) {
        console.error("[WS] onClose error:", err);
      }
    },
  };
}
