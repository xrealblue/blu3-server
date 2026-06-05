import type { RoomStore, MemberInfo } from "../lib/roomStore.js";
import type { Broadcaster } from "../lib/broadcaster.js";

const HEARTBEAT_INTERVAL = 10_000;
const PRESENCE_TTL_MS = 30_000;

export class PresenceManager {
  private store: RoomStore;
  private broadcaster: Broadcaster;
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  constructor(store: RoomStore, broadcaster: Broadcaster) {
    this.store = store;
    this.broadcaster = broadcaster;
  }

  async join(
    roomCode: string,
    userId: string,
    name: string,
    avatar: string | undefined,
    socketId: string,
  ): Promise<void> {
    await this.store.addMember(roomCode, {
      userId,
      name,
      avatar,
      joinedAt: Date.now(),
    });

    const members = await this.store.getMembers(roomCode);
    this.broadcaster.broadcast(roomCode, {
      type: "room:member_joined",
      members,
      user: { userId, name, avatar },
    }, socketId);

    this.startHeartbeat(roomCode, userId);
  }

  async leave(roomCode: string, userId: string): Promise<void> {
    this.stopHeartbeat(roomCode, userId);
    await this.store.removeMember(roomCode, userId);
  }

  async refresh(roomCode: string, userId: string): Promise<void> {
    await this.store.refreshMember(roomCode, userId);
  }

  startHeartbeat(roomCode: string, userId: string): void {
    this.stopHeartbeat(roomCode, userId);
    const interval = setInterval(async () => {
      try {
        await this.store.refreshMember(roomCode, userId);
      } catch (err) {
        console.error("[Presence] heartbeat error:", err);
      }
    }, HEARTBEAT_INTERVAL);
    this.heartbeats.set(`${roomCode}:${userId}`, interval);
  }

  stopHeartbeat(roomCode: string, userId: string): void {
    const key = `${roomCode}:${userId}`;
    const existing = this.heartbeats.get(key);
    if (existing) {
      clearInterval(existing);
      this.heartbeats.delete(key);
    }
  }

  stopAll(): void {
    for (const interval of this.heartbeats.values()) {
      clearInterval(interval);
    }
    this.heartbeats.clear();
  }
}
