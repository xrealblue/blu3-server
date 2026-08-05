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
