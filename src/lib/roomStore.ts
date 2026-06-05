import { getRedis } from "./redis.js";

export interface TimelineState {
  videoId: string | null;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  positionMs: number;
  anchorServerTime: number;
  shuffle: boolean;
  repeatMode: "off" | "all" | "one";
}

export interface MemberInfo {
  userId: string;
  name: string;
  avatar?: string;
  joinedAt: number;
}

export interface QueueTrack {
  id: string;
  videoId: string;
  name: string;
  artists: { name: string }[];
  image: string;
  duration_ms?: number;
}

export const ROOM_IDLE_TTL = 600;

export function defaultTimeline(): TimelineState {
  return {
    videoId: null,
    trackName: "",
    artistName: "",
    image: "",
    isPlaying: false,
    positionMs: 0,
    anchorServerTime: Date.now(),
    shuffle: false,
    repeatMode: "off",
  };
}

export interface RoomStore {
  getTimeline(code: string): Promise<TimelineState>;
  setTimeline(code: string, state: Partial<TimelineState>): Promise<TimelineState>;

  getQueue(code: string): Promise<QueueTrack[]>;
  setQueue(code: string, queue: QueueTrack[]): Promise<void>;
  addToQueue(code: string, track: QueueTrack): Promise<void>;
  removeFromQueue(code: string, trackId: string): Promise<void>;
  clearQueue(code: string): Promise<void>;

  getMembers(code: string): Promise<MemberInfo[]>;
  addMember(code: string, member: MemberInfo): Promise<void>;
  removeMember(code: string, userId: string): Promise<void>;
  refreshMember(code: string, userId: string): Promise<void>;

  hydrateFromDb(code: string, timeline: TimelineState, queue: QueueTrack[]): Promise<void>;

  destroy(code: string): Promise<void>;
}

export class MemoryRoomStore implements RoomStore {
  private timelines = new Map<string, TimelineState>();
  private queues = new Map<string, QueueTrack[]>();
  private members = new Map<string, Map<string, MemberInfo>>();

  async getTimeline(code: string): Promise<TimelineState> {
    return this.timelines.get(code) ?? defaultTimeline();
  }

  async setTimeline(code: string, state: Partial<TimelineState>): Promise<TimelineState> {
    const existing = this.timelines.get(code) ?? defaultTimeline();
    const next = { ...existing, ...state };
    this.timelines.set(code, next);
    return next;
  }

  async getQueue(code: string): Promise<QueueTrack[]> {
    return this.queues.get(code) ?? [];
  }

  async setQueue(code: string, queue: QueueTrack[]): Promise<void> {
    this.queues.set(code, queue);
  }

  async addToQueue(code: string, track: QueueTrack): Promise<void> {
    const q = this.queues.get(code) ?? [];
    if (q.some((t) => t.videoId === track.videoId)) return;
    q.splice(1, 0, track);
    this.queues.set(code, q);
  }

  async removeFromQueue(code: string, trackId: string): Promise<void> {
    const q = this.queues.get(code) ?? [];
    this.queues.set(code, q.filter((t) => t.id !== trackId));
  }

  async clearQueue(code: string): Promise<void> {
    this.queues.set(code, []);
  }

  async getMembers(code: string): Promise<MemberInfo[]> {
    const map = this.members.get(code);
    if (!map) return [];
    return Array.from(map.values());
  }

  async addMember(code: string, member: MemberInfo): Promise<void> {
    if (!this.members.has(code)) this.members.set(code, new Map());
    this.members.get(code)!.set(member.userId, member);
  }

  async removeMember(code: string, userId: string): Promise<void> {
    this.members.get(code)?.delete(userId);
  }

  async refreshMember(code: string, userId: string): Promise<void> {
    const map = this.members.get(code);
    if (map?.has(userId)) {
      const m = map.get(userId)!;
      m.joinedAt = Date.now();
    }
  }

  async hydrateFromDb(code: string, timeline: TimelineState, queue: QueueTrack[]): Promise<void> {
    this.timelines.set(code, timeline);
    this.queues.set(code, queue);
  }

  async destroy(code: string): Promise<void> {
    this.timelines.delete(code);
    this.queues.delete(code);
    this.members.delete(code);
  }
}

const TL_KEY = (code: string) => `room:${code}:timeline`;
const Q_KEY = (code: string) => `room:${code}:queue`;
const MEMBER_KEY = (code: string, uid: string) => `room:${code}:member:${uid}`;
const MEMBER_SET_KEY = (code: string) => `room:${code}:members`;

const PRESENCE_TTL = 30;

export class RedisRoomStore implements RoomStore {
  private r() {
    const r = getRedis();
    if (!r) throw new Error("Redis not configured");
    return r;
  }

  async getTimeline(code: string): Promise<TimelineState> {
    const raw = await this.r().get<TimelineState>(TL_KEY(code));
    if (raw) return { ...raw, anchorServerTime: raw.anchorServerTime ?? Date.now() };
    return defaultTimeline();
  }

  async setTimeline(code: string, state: Partial<TimelineState>): Promise<TimelineState> {
    const existing = await this.getTimeline(code);
    const next = { ...existing, ...state };
    await this.r().setex(TL_KEY(code), ROOM_IDLE_TTL, JSON.stringify(next));
    return next;
  }

  async getQueue(code: string): Promise<QueueTrack[]> {
    const raw = await this.r().get<QueueTrack[]>(Q_KEY(code));
    return raw ?? [];
  }

  async setQueue(code: string, queue: QueueTrack[]): Promise<void> {
    await this.r().setex(Q_KEY(code), ROOM_IDLE_TTL, JSON.stringify(queue));
  }

  async addToQueue(code: string, track: QueueTrack): Promise<void> {
    const q = await this.getQueue(code);
    if (q.some((t) => t.videoId === track.videoId)) return;
    q.splice(1, 0, track);
    await this.setQueue(code, q);
  }

  async removeFromQueue(code: string, trackId: string): Promise<void> {
    const q = await this.getQueue(code);
    await this.setQueue(code, q.filter((t) => t.id !== trackId));
  }

  async clearQueue(code: string): Promise<void> {
    await this.setQueue(code, []);
  }

  async getMembers(code: string): Promise<MemberInfo[]> {
    const ids = await this.r().smembers(MEMBER_SET_KEY(code));
    const members: MemberInfo[] = [];
    for (const id of ids) {
      const raw = await this.r().get<MemberInfo>(MEMBER_KEY(code, id));
      if (raw) members.push(raw);
    }
    return members;
  }

  async addMember(code: string, member: MemberInfo): Promise<void> {
    await this.r().multi()
      .sadd(MEMBER_SET_KEY(code), member.userId)
      .setex(MEMBER_KEY(code, member.userId), PRESENCE_TTL, JSON.stringify(member))
      .exec();
  }

  async removeMember(code: string, userId: string): Promise<void> {
    await this.r().multi()
      .srem(MEMBER_SET_KEY(code), userId)
      .del(MEMBER_KEY(code, userId))
      .exec();
  }

  async refreshMember(code: string, userId: string): Promise<void> {
    const raw = await this.r().get<MemberInfo>(MEMBER_KEY(code, userId));
    if (raw) {
      await this.r().expire(MEMBER_KEY(code, userId), PRESENCE_TTL);
    }
  }

  async hydrateFromDb(code: string, timeline: TimelineState, queue: QueueTrack[]): Promise<void> {
    await this.r().multi()
      .setex(TL_KEY(code), ROOM_IDLE_TTL, JSON.stringify(timeline))
      .setex(Q_KEY(code), ROOM_IDLE_TTL, JSON.stringify(queue))
      .exec();
  }

  async destroy(code: string): Promise<void> {
    const memberIds = await this.r().smembers(MEMBER_SET_KEY(code));
    const keys = [TL_KEY(code), Q_KEY(code), MEMBER_SET_KEY(code), ...memberIds.map((id) => MEMBER_KEY(code, id))];
    if (keys.length > 0) await this.r().del(...keys);
  }
}
