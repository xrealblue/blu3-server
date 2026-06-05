export interface TimelineSnapshot {
  videoId: string | null;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  positionMs: number;
  anchorServerTime: number;
}

export function currentPosition(timeline: TimelineSnapshot, serverNow: number): number {
  if (!timeline.isPlaying) return timeline.positionMs;
  const elapsed = serverNow - timeline.anchorServerTime;
  return Math.max(0, timeline.positionMs + elapsed);
}

export function snapToServerTime(
  timeline: TimelineSnapshot,
  clientPositionMs: number,
  serverNow: number,
): TimelineSnapshot {
  return {
    ...timeline,
    positionMs: clientPositionMs,
    anchorServerTime: serverNow,
  };
}

export function createPlaySnapshot(
  videoId: string,
  trackName: string,
  artistName: string,
  image: string,
  seekToMs: number,
  serverNow: number,
): TimelineSnapshot {
  return {
    videoId,
    trackName,
    artistName,
    image,
    isPlaying: true,
    positionMs: seekToMs,
    anchorServerTime: serverNow,
  };
}

export function createPauseSnapshot(
  timeline: TimelineSnapshot,
  serverNow: number,
): TimelineSnapshot {
  return {
    ...timeline,
    isPlaying: false,
    positionMs: currentPosition(timeline, serverNow),
    anchorServerTime: serverNow,
  };
}

export function createSeekSnapshot(
  timeline: TimelineSnapshot,
  seekToMs: number,
  serverNow: number,
): TimelineSnapshot {
  return {
    ...timeline,
    positionMs: Math.max(0, seekToMs),
    anchorServerTime: serverNow,
  };
}
