export interface TimelineSnapshot {
  videoId: string | null;
  trackName: string;
  artistName: string;
  image: string;
  isPlaying: boolean;
  positionSec: number;
  anchorServerTime: number;
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
): TimelineSnapshot {
  return {
    videoId,
    trackName,
    artistName,
    image,
    isPlaying: true,
    positionSec: seekToSec,
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
    positionSec: currentPosition(timeline, serverNow),
    anchorServerTime: serverNow,
  };
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
