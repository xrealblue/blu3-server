export interface WSClient {
  id: string; // socket id
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

interface Room {
  code: string;
  hostId: string;
  clients: Map<string, WSClient>;
  playback: PlaybackState;
  recentTracks: RecentTrack[];
  queue: any[];
}

const rooms = new Map<string, Room>();

export function getOrCreateRoom(code: string, hostId: string): Room {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId,
      clients: new Map(),
      playback: {
        videoId: null,
        trackName: "",
        artistName: "",
        image: "",
        isPlaying: false,
        currentTime: 0,
        updatedAt: Date.now(),
      },
      recentTracks: [],
      queue: [],
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
  if (room) room.clients.set(client.id, client);
}

export function removeClient(socketId: string, roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.clients.delete(socketId);
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
  const room = rooms.get(code);
  if (!room) return false;
  for (const client of room.clients.values()) {
    if (client.userId === room.hostId) return true;
  }
  return false;
}

export function setPlayback(code: string, state: Partial<PlaybackState>) {
  const room = rooms.get(code);
  if (!room) return;
  room.playback = { ...room.playback, ...state, updatedAt: Date.now() };
}

export function getPlayback(code: string): PlaybackState | null {
  return rooms.get(code)?.playback ?? null;
}

export function broadcast(code: string, msg: object, excludeId?: string) {
  const room = rooms.get(code);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.clients.forEach((client) => {
    if (client.id === excludeId) return;
    try {
      client.ws.send(data); // Hono WSContext.send() takes string directly
    } catch (err) {
      console.error("Broadcast error:", err);
    }
  });
}

export function sendTo(socketId: string, roomCode: string, msg: object) {
  const room = rooms.get(roomCode);
  const client = room?.clients.get(socketId);
  if (client) {
    try {
      client.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("SendTo error:", err);
    }
  }
}

export interface QueueTrack {
  id: string;
  videoId: string;
  name: string;
  artists: { name: string }[];
  image: string;
  duration_ms?: number;
}

export function getQueue(code: string): QueueTrack[] {
  return rooms.get(code)?.queue ?? [];
}

export function addToQueue(code: string, track: QueueTrack) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue.push(track);
}

export function removeFromQueue(code: string, trackId: string) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue = room.queue.filter((t) => t.id !== trackId);
}

export function insertQueueTop(code: string, track: QueueTrack) {
  const room = rooms.get(code);
  if (!room) return;
  // Deduplicate: remove any other instance of this track
  room.queue = room.queue.filter(
    (t) => t.id !== track.id && t.videoId !== track.videoId,
  );
  // Add to index 0
  room.queue.unshift(track);
}

export function clearQueue(code: string) {
  const room = rooms.get(code);
  if (!room) return;
  room.queue = [];
}
