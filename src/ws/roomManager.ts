import type { RoomStore, TimelineState, QueueTrack } from "../lib/roomStore.js";
import { MemoryRoomStore } from "../lib/roomStore.js";
import type { Broadcaster, BroadcastPayload } from "../lib/broadcaster.js";
import { LocalBroadcaster } from "../lib/broadcaster.js";
import { currentPosition } from "../lib/timeline.js";
import { maybeCompress } from "../lib/compress.js";

export type { QueueTrack };
export type RepeatMode = "off" | "all" | "one";

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
  source: string;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
  startedAt: number;
  pausedDurationMs: number;
  durationMs: number;
}

export interface RecentTrack {
  videoId: string;
  source: string;
  trackName: string;
  artistName: string;
  image: string;
  playedAt: number;
}

export interface PlaybackMode {
  shuffle: boolean;
  repeatMode: RepeatMode;
}

/* ─── RoomManager class ─────────────────────────────── */

export class RoomManager {
  private store: RoomStore;
  private broadcaster: Broadcaster;
  private clientMap = new Map<string, { client: WSClient; roomCode: string }>();
  private recentTracks = new Map<string, RecentTrack[]>();
  private hostMap = new Map<string, string>();
  private hostFallbackMap = new Map<string, { userId: string; electedAt: number }>();
  private electionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private roomIdMap = new Map<string, string>();
  private userSocketMap = new Map<string, { socketId: string; roomCode: string; ws: any }>();

  constructor(store?: RoomStore, broadcaster?: Broadcaster) {
    this.store = store ?? new MemoryRoomStore();
    this.broadcaster = broadcaster ?? new LocalBroadcaster();
  }

  getStore(): RoomStore { return this.store; }
  getBroadcaster(): Broadcaster { return this.broadcaster; }

  async initRoom(code: string, hostId: string): Promise<void> {
    this.hostMap.set(code, hostId);
  }

  setRoomId(code: string, roomId: string): void {
    this.roomIdMap.set(code, roomId);
  }

  getRoomIdByCode(code: string): string | undefined {
    return this.roomIdMap.get(code);
  }

  getRoomCodeById(roomId: string): string | undefined {
    for (const [code, id] of this.roomIdMap) {
      if (id === roomId) return code;
    }
  }

  async addClient(client: WSClient): Promise<boolean> {
    const existing = this.userSocketMap.get(client.userId);
    let isReconnect = false;
    if (existing && existing.roomCode === client.roomCode) {
      isReconnect = true;
      try { existing.ws.close(4001, "Replaced by new connection"); } catch {}
      this.broadcaster.removeSocket(existing.socketId, existing.roomCode);
      this.clientMap.delete(existing.socketId);
    }
    if (existing && existing.roomCode !== client.roomCode) {
      try { existing.ws.close(4001, "Connected to another room"); } catch {}
      this.broadcaster.removeSocket(existing.socketId, existing.roomCode);
      this.clientMap.delete(existing.socketId);
    }
    if (!existing && this.hostMap.get(client.roomCode) === client.userId && this.hostFallbackMap.has(client.roomCode)) {
      isReconnect = true;
    }
    this.userSocketMap.set(client.userId, { socketId: client.id, roomCode: client.roomCode, ws: client.ws });
    this.clientMap.set(client.id, { client, roomCode: client.roomCode });
    this.broadcaster.addSocket(client.id, client.roomCode, (data: string) => {
      if (client.ws.readyState === 1) {
        try { client.ws.send(maybeCompress(data)); } catch {}
      }
    });
    if (!isReconnect) {
      await this.store.addMember(client.roomCode, {
        userId: client.userId,
        name: client.name,
        avatar: client.avatar,
        joinedAt: Date.now(),
      });
    } else {
      const origHost = this.hostMap.get(client.roomCode);
      if (origHost === client.userId) {
        this.revokeFallback(client.roomCode, (code, msg) => this.broadcast(code, msg as BroadcastPayload));
      }
    }
    return isReconnect;
  }

  removeClient(socketId: string, _roomCode: string): void {
    const entry = this.clientMap.get(socketId);
    if (entry) {
      this.broadcaster.removeSocket(socketId, entry.roomCode);
      this.clientMap.delete(socketId);
      this.userSocketMap.delete(entry.client.userId);
      this.store.removeMember(entry.roomCode, entry.client.userId).catch(console.error);
    }
  }

  async getTimeline(code: string): Promise<TimelineState> {
    return this.store.getTimeline(code);
  }

  async setTimeline(code: string, state: Partial<TimelineState>): Promise<TimelineState> {
    return this.store.setTimeline(code, state);
  }

  async getPlayback(code: string): Promise<PlaybackState | null> {
    const tl = await this.store.getTimeline(code);
    return {
      videoId: tl.videoId,
      source: tl.source,
      trackName: tl.trackName,
      artistName: tl.artistName,
      image: tl.image,
      isPlaying: tl.isPlaying,
      currentTime: currentPosition(tl, Date.now()),
      updatedAt: Date.now(),
      startedAt: tl.startedAt,
      pausedDurationMs: tl.pausedDurationMs,
      durationMs: tl.durationMs,
    };
  }

  async getPlaybackMode(code: string): Promise<PlaybackMode> {
    const tl = await this.store.getTimeline(code);
    return { shuffle: tl.shuffle, repeatMode: tl.repeatMode };
  }

  getHostId(code: string): string | undefined {
    return this.hostMap.get(code);
  }

  isHostInRoom(code: string): boolean {
    for (const { client, roomCode } of this.clientMap.values()) {
      if (roomCode === code && client.userId === this.hostMap.get(code)) return true;
    }
    return false;
  }

  canControlPlayback(code: string, userId: string): boolean {
    const hostId = this.hostMap.get(code);
    if (!hostId) return true;
    if (this.isHostInRoom(code)) return hostId === userId;
    const fallback = this.hostFallbackMap.get(code);
    if (fallback) return fallback.userId === userId;
    return true;
  }

  getFallbackHost(code: string): string | undefined {
    return this.hostFallbackMap.get(code)?.userId;
  }

  getActiveHostId(code: string): string {
    return this.hostFallbackMap.get(code)?.userId ?? this.hostMap.get(code) ?? "";
  }

  isFallbackActive(code: string): boolean {
    return this.hostFallbackMap.has(code);
  }

  scheduleFallbackElection(code: string, broadcastFn: (code: string, msg: object) => void): void {
    if (this.electionTimers.has(code)) clearTimeout(this.electionTimers.get(code)!);
    this.electionTimers.set(code, setTimeout(async () => {
      this.electionTimers.delete(code);
      if (this.isHostInRoom(code)) return;
      const members = await this.store.getMembers(code);
      const hostUserId = this.hostMap.get(code);
      const candidates = members.filter(m => m.userId !== hostUserId);
      if (candidates.length === 0) return;
      const now = Date.now();
      const sorted = candidates.toSorted((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
      const fallback = sorted[0];
      this.hostFallbackMap.set(code, { userId: fallback.userId, electedAt: now });
      broadcastFn(code, {
        type: "host:fallback_elected",
        userId: fallback.userId,
        name: fallback.name,
      });
    }, 30000));
  }

  cancelFallbackElection(code: string): void {
    const timer = this.electionTimers.get(code);
    if (timer) { clearTimeout(timer); this.electionTimers.delete(code); }
  }

  revokeFallback(code: string, broadcastFn: (code: string, msg: object) => void): void {
    this.cancelFallbackElection(code);
    if (this.hostFallbackMap.has(code)) {
      this.hostFallbackMap.delete(code);
      broadcastFn(code, { type: "host:fallback_revoked" });
    }
  }

  async getMembers(code: string) {
    return this.store.getMembers(code);
  }

  async getQueue(code: string): Promise<QueueTrack[]> {
    return this.store.getQueue(code);
  }

  async addToQueue(code: string, track: QueueTrack): Promise<void> {
    await this.store.addToQueue(code, track);
  }

  async removeFromQueue(code: string, trackId: string): Promise<void> {
    await this.store.removeFromQueue(code, trackId);
  }

  async insertQueueTop(code: string, track: QueueTrack): Promise<void> {
    const q = await this.store.getQueue(code);
    const filtered = q.filter((t) => t.id !== track.id || t.videoId !== track.videoId);
    filtered.unshift(track);
    await this.store.setQueue(code, filtered);
  }

  async moveQueueTrackToEnd(code: string, trackId: string): Promise<void> {
    const q = await this.store.getQueue(code);
    const track = q.find((t) => t.id === trackId);
    if (!track) return;
    const filtered = q.filter((t) => t.id !== trackId);
    filtered.push(track);
    await this.store.setQueue(code, filtered);
  }

  async clearQueue(code: string): Promise<void> {
    await this.store.clearQueue(code);
  }

  pushRecentTrack(code: string, track: RecentTrack): void {
    const existing = this.recentTracks.get(code) ?? [];
    this.recentTracks.set(code, [
      track,
      ...existing.filter((t) => t.videoId !== track.videoId),
    ].slice(0, 10));
  }

  getRecentTracks(code: string): RecentTrack[] {
    return this.recentTracks.get(code) ?? [];
  }

  broadcast(code: string, msg: BroadcastPayload, excludeSocketId?: string): void {
    this.broadcaster.broadcast(code, msg, excludeSocketId);
  }

  sendTo(socketId: string, code: string, msg: BroadcastPayload): void {
    this.broadcaster.sendTo(socketId, code, msg);
  }
}

/* ─── Singleton + legacy function exports ───────────── */

const legacyManager = new RoomManager();

export function getOrCreateRoom(code: string, hostId: string) {
  legacyManager.initRoom(code, hostId);
  return { code, hostId };
}

export async function addClient(client: WSClient) {
  await legacyManager.addClient(client);
}

export function removeClient(socketId: string, roomCode: string) {
  legacyManager.removeClient(socketId, roomCode);
}

export { legacyManager };

export function setRoomId(code: string, roomId: string) {
  legacyManager.setRoomId(code, roomId);
}

export function getRoomCodeById(roomId: string): string | undefined {
  return legacyManager.getRoomCodeById(roomId);
}

export function broadcast(code: string, msg: object, excludeSocketId?: string) {
  legacyManager.broadcast(code, msg as BroadcastPayload, excludeSocketId);
}

export function sendTo(socketId: string, roomCode: string, msg: object) {
  legacyManager.sendTo(socketId, roomCode, msg as BroadcastPayload);
}

export function getFallbackHost(code: string): string | undefined {
  return legacyManager.getFallbackHost(code);
}

export function getActiveHostId(code: string): string {
  return legacyManager.getActiveHostId(code);
}

export function isFallbackActive(code: string): boolean {
  return legacyManager.isFallbackActive(code);
}

export function scheduleFallbackElection(code: string, broadcastFn: (code: string, msg: object) => void): void {
  legacyManager.scheduleFallbackElection(code, broadcastFn);
}

export function revokeFallback(code: string, broadcastFn: (code: string, msg: object) => void): void {
  legacyManager.revokeFallback(code, broadcastFn);
}

export async function getRoomMembers(code: string) {
  return legacyManager.getMembers(code);
}

export function isHostInRoom(code: string): boolean {
  return legacyManager.isHostInRoom(code);
}

export async function setPlayback(code: string, state: Partial<PlaybackState> & { updatedAt?: number }) {
  const tl = await legacyManager.getTimeline(code);
  const next: Partial<TimelineState> = {};
  if (state.videoId !== undefined) next.videoId = state.videoId;
  if (state.source !== undefined) next.source = state.source;
  if (state.trackName !== undefined) next.trackName = state.trackName;
  if (state.artistName !== undefined) next.artistName = state.artistName;
  if (state.image !== undefined) next.image = state.image;
  if (state.isPlaying !== undefined) next.isPlaying = state.isPlaying;
  if (state.currentTime !== undefined) next.positionSec = state.currentTime;
  if (state.updatedAt !== undefined) next.anchorServerTime = state.updatedAt;
  if (state.startedAt !== undefined) next.startedAt = state.startedAt;
  if (state.pausedDurationMs !== undefined) next.pausedDurationMs = state.pausedDurationMs;
  if (state.durationMs !== undefined) next.durationMs = state.durationMs;
  if (next.isPlaying !== undefined || next.positionSec !== undefined || next.anchorServerTime !== undefined) {
    next.anchorServerTime = state.updatedAt ?? Date.now();
  }
  await legacyManager.setTimeline(code, next);
}

export async function getPlayback(code: string): Promise<PlaybackState | null> {
  return legacyManager.getPlayback(code);
}

export async function getPlaybackMode(code: string): Promise<PlaybackMode> {
  return legacyManager.getPlaybackMode(code);
}

export async function setPlaybackMode(code: string, mode: Partial<PlaybackMode>) {
  const updates: Partial<TimelineState> = {};
  if (mode.shuffle !== undefined) updates.shuffle = mode.shuffle;
  if (mode.repeatMode !== undefined) updates.repeatMode = mode.repeatMode;
  await legacyManager.setTimeline(code, updates);
}

export async function getQueue(code: string): Promise<QueueTrack[]> {
  return legacyManager.getQueue(code);
}

export async function addToQueue(code: string, track: QueueTrack) {
  await legacyManager.addToQueue(code, track);
}

export async function removeFromQueue(code: string, trackId: string) {
  await legacyManager.removeFromQueue(code, trackId);
}

export async function insertQueueTop(code: string, track: QueueTrack) {
  await legacyManager.insertQueueTop(code, track);
}

export async function moveQueueTrackToEnd(code: string, trackId: string) {
  await legacyManager.moveQueueTrackToEnd(code, trackId);
}

export async function clearQueue(code: string) {
  await legacyManager.clearQueue(code);
}

export function pushRecentTrack(code: string, track: RecentTrack) {
  legacyManager.pushRecentTrack(code, track);
}

export function getRecentTracks(code: string): RecentTrack[] {
  return legacyManager.getRecentTracks(code);
}

export async function getTimeline(code: string): Promise<TimelineState> {
  return legacyManager.getTimeline(code);
}
