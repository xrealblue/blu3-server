export interface TimelineState {
  videoId: string | null;
  source: string;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  positionSec: number;
  anchorServerTime: number;
  startedAt: number;
  pausedDurationMs: number;
  durationMs: number;
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
  source: string;
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
    source: "youtube",
    trackName: "",
    artistName: "",
    image: "",
    isPlaying: false,
    positionSec: 0,
    anchorServerTime: Date.now(),
    startedAt: 0,
    pausedDurationMs: 0,
    durationMs: 0,
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
    const existingIdx = q.findIndex((t) => t.videoId === track.videoId);
    if (existingIdx !== -1) q.splice(existingIdx, 1);
    if (q.length === 0) {
      q.push(track);
    } else {
      q.splice(1, 0, track);
    }
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
