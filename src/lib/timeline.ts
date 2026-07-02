export interface TimelineSnapshot {
  videoId: string | null;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  positionSec: number;
  anchorServerTime: number;
  startedAt: number;
  pausedDurationMs: number;
  durationMs: number;
}

export function currentPosition(timeline: TimelineSnapshot, serverNow: number): number {
  if (!timeline.isPlaying) return timeline.positionSec;
  const elapsed = (serverNow - timeline.anchorServerTime) / 1000;
  return Math.max(0, timeline.positionSec + elapsed);
}

export function snapToServerTime(
  timeline: TimelineSnapshot,
  clientPositionSec: number,
  serverNow: number,
): TimelineSnapshot {
  return {
    ...timeline,
    positionSec: clientPositionSec,
    anchorServerTime: serverNow,
  };
}

export function createPlaySnapshot(
  videoId: string,
  trackName: string,
  artistName: string,
  image: string,
  seekToSec: number,
  serverNow: number,
  durationMs = 0,
): TimelineSnapshot {
  return {
    videoId,
    trackName,
    artistName,
    image,
    isPlaying: true,
    positionSec: seekToSec,
    anchorServerTime: serverNow,
    startedAt: serverNow,
    pausedDurationMs: 0,
    durationMs,
  };
}

export function createResumeSnapshot(
  timeline: TimelineSnapshot,
  serverNow: number,
): TimelineSnapshot {
  const pauseElapsed = serverNow - timeline.anchorServerTime;
  return {
    ...timeline,
    isPlaying: true,
    anchorServerTime: serverNow,
    pausedDurationMs: timeline.pausedDurationMs + Math.max(0, pauseElapsed),
  };
}

export function createPauseSnapshot(
  timeline: TimelineSnapshot,
  serverNow: number,
): TimelineSnapshot {
  return {
    ...timeline,
    isPlaying: false,
    positionSec: currentPosition(timeline, serverNow),
    anchorServerTime: serverNow,
  };
}

export function effectiveElapsedMs(timeline: TimelineSnapshot, serverNow: number): number {
  if (!timeline.startedAt) return 0;
  const wallMs = serverNow - timeline.startedAt;
  const pausedMs = timeline.pausedDurationMs;
  if (!timeline.isPlaying) {
    // While paused, account for current pause session too
    const currentPauseMs = serverNow - timeline.anchorServerTime;
    return Math.max(0, wallMs - pausedMs - currentPauseMs);
  }
  return Math.max(0, wallMs - pausedMs);
}

export function createSeekSnapshot(
  timeline: TimelineSnapshot,
  seekToSec: number,
  serverNow: number,
): TimelineSnapshot {
  return {
    ...timeline,
    positionSec: Math.max(0, seekToSec),
    anchorServerTime: serverNow,
  };
}
