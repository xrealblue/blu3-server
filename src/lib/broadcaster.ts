export type BroadcastPayload = Record<string, unknown>;

export interface Broadcaster {
  broadcast(roomCode: string, msg: BroadcastPayload, excludeSocketId?: string): void;
  sendTo(socketId: string, roomCode: string, msg: BroadcastPayload): void;
  addSocket(socketId: string, roomCode: string, send: (msg: string) => void): void;
  removeSocket(socketId: string, roomCode: string): void;
  destroyRoom(roomCode: string): void;
}

type SocketEntry = { id: string; send: (msg: string) => void };

export class LocalBroadcaster implements Broadcaster {
  private rooms = new Map<string, Map<string, SocketEntry>>();

  broadcast(roomCode: string, msg: BroadcastPayload, excludeSocketId?: string): void {
    const data = JSON.stringify(msg);
    const sockets = this.rooms.get(roomCode);
    if (!sockets) return;
    for (const [id, entry] of sockets) {
      if (id === excludeSocketId) continue;
      try { entry.send(data); } catch {}
    }
  }

  sendTo(socketId: string, _roomCode: string, msg: BroadcastPayload): void {
    const data = JSON.stringify(msg);
    for (const sockets of this.rooms.values()) {
      const entry = sockets.get(socketId);
      if (entry) { try { entry.send(data); } catch {} return; }
    }
  }

  addSocket(socketId: string, roomCode: string, send: (msg: string) => void): void {
    if (!this.rooms.has(roomCode)) this.rooms.set(roomCode, new Map());
    this.rooms.get(roomCode)!.set(socketId, { id: socketId, send });
  }

  removeSocket(socketId: string, roomCode: string): void {
    this.rooms.get(roomCode)?.delete(socketId);
  }

  destroyRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }
}
