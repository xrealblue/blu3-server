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
  updatedAt: number; // server timestamp when state last changed
}

interface Room {
  code: string;
  hostId: string;
  clients: Map<string, WSClient>;
  playback: PlaybackState;
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
    });
  }
  return rooms.get(code)!;
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
