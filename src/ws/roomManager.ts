import type { RoomStore, TimelineState, QueueTrack } from "../lib/roomStore.js";
import { MemoryRoomStore } from "../lib/roomStore.js";
import type { Broadcaster, BroadcastPayload } from "../lib/broadcaster.js";
import { LocalBroadcaster } from "../lib/broadcaster.js";
import { currentPosition } from "../lib/timeline.js";

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

  constructor(store?: RoomStore, broadcaster?: Broadcaster) {
    this.store = store ?? new MemoryRoomStore();
    this.broadcaster = broadcaster ?? new LocalBroadcaster();
  }

  getStore(): RoomStore { return this.store; }
  getBroadcaster(): Broadcaster { return this.broadcaster; }

  async initRoom(code: string, hostId: string): Promise<void> {
    this.hostMap.set(code, hostId);
  }

  async addClient(client: WSClient): Promise<void> {
    this.clientMap.set(client.id, { client, roomCode: client.roomCode });
    this.broadcaster.addSocket(client.id, client.roomCode, (data: string) => {
      if (client.ws.readyState === 1) {
        try { client.ws.send(data); } catch {}
      }
    });
  }

  removeClient(socketId: string, _roomCode: string): void {
    const entry = this.clientMap.get(socketId);
    if (entry) {
      this.broadcaster.removeSocket(socketId, entry.roomCode);
      this.clientMap.delete(socketId);
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
      trackName: tl.trackName,
      artistName: tl.artistName,
      image: tl.image,
      isPlaying: tl.isPlaying,
      currentTime: currentPosition(tl, Date.now()),
      updatedAt: Date.now(),
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
    return !this.isHostInRoom(code) || hostId === userId;
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

export function broadcast(code: string, msg: object, excludeSocketId?: string) {
  legacyManager.broadcast(code, msg as BroadcastPayload, excludeSocketId);
}

export function sendTo(socketId: string, roomCode: string, msg: object) {
  legacyManager.sendTo(socketId, roomCode, msg as BroadcastPayload);
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
  if (state.trackName !== undefined) next.trackName = state.trackName;
  if (state.artistName !== undefined) next.artistName = state.artistName;
  if (state.image !== undefined) next.image = state.image;
  if (state.isPlaying !== undefined) next.isPlaying = state.isPlaying;
  if (state.currentTime !== undefined) next.positionMs = state.currentTime;
  if (state.updatedAt !== undefined) next.anchorServerTime = state.updatedAt;
  if (next.isPlaying !== undefined || next.positionMs !== undefined || next.anchorServerTime !== undefined) {
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
