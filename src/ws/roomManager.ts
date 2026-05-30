export interface WSClient {
  id: string;
  userId: string;
  name: string;
  avatar?: string;
  roomCode: string;
  ws: any;
}

export interface ChatMessage {
  id: string;
  userId: string;
  name: string;
  avatar?: string;
  text: string;
  ts: number;
}

export interface PlaybackState {
  videoId: string | null;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
}

export interface RecentTrack {
  videoId: string;
  trackName: string;
  artistName: string;
  image: string;
  playedAt: number;
}

export interface QueueTrack {
  id: string;
  videoId: string;
  name: string;
  artists: { name: string }[];
  image: string;
  duration_ms?: number;
}

export type RepeatMode = "off" | "all" | "one";

export interface PlaybackMode {
  shuffle: boolean;
  repeatMode: RepeatMode;
}

interface Room {
  code: string;
  hostId: string;
  clients: Map<string, WSClient>;
  hostConnected: boolean;
  playback: PlaybackState;
  playbackMode: PlaybackMode;
  recentTracks: RecentTrack[];
  queue: QueueTrack[];
  isQueueLoaded?: boolean;
}

const rooms = new Map<string, Room>();
const roomCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ROOM_CLEANUP_TTL_MS = 5 * 60 * 1000;

export function getOrCreateRoom(code: string, hostId: string): Room {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId,
      clients: new Map(),
      hostConnected: false,
      playback: {
        videoId: null,
        trackName: "",
        artistName: "",
        image: "",
        isPlaying: false,
        currentTime: 0,
        updatedAt: Date.now(),
      },
      playbackMode: {
        shuffle: false,
        repeatMode: "off",
      },
      recentTracks: [],
      queue: [],
      isQueueLoaded: false,
    });
  }
  return rooms.get(code)!;
}

export function pushRecentTrack(code: string, track: RecentTrack) {
  const room = rooms.get(code);
  if (!room) return;
  room.recentTracks = [
    track,
    ...room.recentTracks.filter((t) => t.videoId !== track.videoId),
  ].slice(0, 10);
}

export function getRecentTracks(code: string): RecentTrack[] {
  return rooms.get(code)?.recentTracks ?? [];
}

export function getRoom(code: string) {
  return rooms.get(code) ?? null;
}

export function addClient(client: WSClient) {
  const room = rooms.get(client.roomCode);
  if (room) {
    room.clients.set(client.id, client);
    if (client.userId === room.hostId) {
      room.hostConnected = true;
    }
    const timer = roomCleanupTimers.get(client.roomCode);
    if (timer) {
      clearTimeout(timer);
      roomCleanupTimers.delete(client.roomCode);
    }
  }
}

export function removeClient(socketId: string, roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const client = room.clients.get(socketId);
  if (client?.userId === room.hostId) {
    room.hostConnected = false;
  }
  room.clients.delete(socketId);

  if (room.clients.size === 0) {
    const existing = roomCleanupTimers.get(roomCode);
    if (existing) clearTimeout(existing);
    roomCleanupTimers.set(roomCode, setTimeout(() => {
      rooms.delete(roomCode);
      roomCleanupTimers.delete(roomCode);
    }, ROOM_CLEANUP_TTL_MS));
  }
}

export function getRoomMembers(code: string) {
  const room = rooms.get(code);
  if (!room) return [];
  return Array.from(room.clients.values()).map((c) => ({
    userId: c.userId,
    name: c.name,
    avatar: c.avatar,
  }));
}

export function isHostInRoom(code: string): boolean {
  return rooms.get(code)?.hostConnected ?? false;
}

export function setPlayback(
  code: string,
  state: Partial<PlaybackState> & { updatedAt?: number },
) {
  const room = rooms.get(code);
  if (!room) return;
  room.playback = {
    ...room.playback,
    ...state,
    updatedAt: state.updatedAt ?? Date.now(),
  };
}

export function getPlayback(code: string): PlaybackState | null {
  return rooms.get(code)?.playback ?? null;
}

export function getPlaybackMode(code: string): PlaybackMode {
  return (
    rooms.get(code)?.playbackMode ?? {
      shuffle: false,
      repeatMode: "off",
    }
  );
}

export function setPlaybackMode(code: string, mode: Partial<PlaybackMode>) {
  const room = rooms.get(code);
  if (!room) return;
  room.playbackMode = {
    ...room.playbackMode,
    ...mode,
  };
}

const WS_OPEN = 1;

export function broadcast(code: string, msg: object, excludeId?: string) {
  const room = rooms.get(code);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.clients.forEach((client) => {
    if (client.id === excludeId) return;
    if (client.ws.readyState !== WS_OPEN) return;
    try {
      client.ws.send(data);
    } catch (err) {
      console.error("Broadcast error:", err);
    }
  });
}

export function sendTo(socketId: string, roomCode: string, msg: object) {
  const room = rooms.get(roomCode);
  const client = room?.clients.get(socketId);
  if (client && client.ws.readyState === WS_OPEN) {
    try {
      client.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("SendTo error:", err);
    }
  }
}

export function getQueue(code: string): QueueTrack[] {
  return rooms.get(code)?.queue ?? [];
}

export function addToQueue(code: string, track: QueueTrack) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue.splice(1, 0, track);
}

export function removeFromQueue(code: string, trackId: string) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue = room.queue.filter((t) => t.id !== trackId);
}

export function insertQueueTop(code: string, track: QueueTrack) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue = room.queue.filter(
    (t) => t.id !== track.id && t.videoId !== track.videoId,
  );
  room.queue.unshift(track);
}

export function moveQueueTrackToEnd(code: string, trackId: string) {
  const room = rooms.get(code);
  if (!room) return;
  const track = room.queue.find((item) => item.id === trackId);
  if (!track) return;
  room.queue = room.queue.filter((item) => item.id !== trackId);
  room.queue.push(track);
}

export function clearQueue(code: string) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue = [];
}
