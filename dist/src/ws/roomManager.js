const rooms = new Map();
export function getOrCreateRoom(code, hostId) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            code,
            hostId,
            clients: new Map(),
            playback: {
                videoId: null,
                trackName: "",
                artistName: "",
                image: "",
                isPlaying: false,
                currentTime: 0,
                updatedAt: Date.now(),
            },
            playbackMode: {
                shuffle: false,
                repeatMode: "off",
            },
            recentTracks: [],
            queue: [],
        });
    }
    return rooms.get(code);
}
export function pushRecentTrack(code, track) {
    const room = rooms.get(code);
    if (!room)
        return;
    room.recentTracks = [
        track,
        ...room.recentTracks.filter((t) => t.videoId !== track.videoId),
    ].slice(0, 10);
}
export function getRecentTracks(code) {
    return rooms.get(code)?.recentTracks ?? [];
}
export function getRoom(code) {
    return rooms.get(code) ?? null;
}
export function addClient(client) {
    const room = rooms.get(client.roomCode);
    if (room)
        room.clients.set(client.id, client);
}
export function removeClient(socketId, roomCode) {
    const room = rooms.get(roomCode);
    if (!room)
        return;
    room.clients.delete(socketId);
}
export function getRoomMembers(code) {
    const room = rooms.get(code);
    if (!room)
        return [];
    return Array.from(room.clients.values()).map((c) => ({
        userId: c.userId,
        name: c.name,
        avatar: c.avatar,
    }));
}
export function isHostInRoom(code) {
    const room = rooms.get(code);
    if (!room)
        return false;
    for (const client of room.clients.values()) {
        if (client.userId === room.hostId)
            return true;
    }
    return false;
}
export function setPlayback(code, state) {
    const room = rooms.get(code);
    if (!room)
        return;
    room.playback = {
        ...room.playback,
        ...state,
        updatedAt: state.updatedAt ?? Date.now(),
    };
}
export function getPlayback(code) {
    return rooms.get(code)?.playback ?? null;
}
export function getPlaybackMode(code) {
    return (rooms.get(code)?.playbackMode ?? {
        shuffle: false,
        repeatMode: "off",
    });
}
export function setPlaybackMode(code, mode) {
    const room = rooms.get(code);
    if (!room)
        return;
    room.playbackMode = {
        ...room.playbackMode,
        ...mode,
    };
}
export function broadcast(code, msg, excludeId) {
    const room = rooms.get(code);
    if (!room)
        return;
    const data = JSON.stringify(msg);
    room.clients.forEach((client) => {
        if (client.id === excludeId)
            return;
        try {
            client.ws.send(data); // Hono WSContext.send() takes string directly
        }
        catch (err) {
            console.error("Broadcast error:", err);
        }
    });
}
export function sendTo(socketId, roomCode, msg) {
    const room = rooms.get(roomCode);
    const client = room?.clients.get(socketId);
    if (client) {
        try {
            client.ws.send(JSON.stringify(msg));
        }
        catch (err) {
            console.error("SendTo error:", err);
        }
    }
}
export function getQueue(code) {
    return rooms.get(code)?.queue ?? [];
}
export function addToQueue(code, track) {
    const room = rooms.get(code);
    if (!room)
        return;
    room.queue.push(track);
}
export function removeFromQueue(code, trackId) {
    const room = rooms.get(code);
    if (!room)
        return;
    room.queue = room.queue.filter((t) => t.id !== trackId);
}
export function insertQueueTop(code, track) {
    const room = rooms.get(code);
    if (!room)
        return;
    // Deduplicate: remove any other instance of this track
    room.queue = room.queue.filter((t) => t.id !== track.id && t.videoId !== track.videoId);
    // Add to index 0
    room.queue.unshift(track);
}
export function moveQueueTrackToEnd(code, trackId) {
    const room = rooms.get(code);
    if (!room)
        return;
    const track = room.queue.find((item) => item.id === trackId);
    if (!track)
        return;
    room.queue = room.queue.filter((item) => item.id !== trackId);
    room.queue.push(track);
}
export function clearQueue(code) {
    const room = rooms.get(code);
    if (!room)
        return;
    room.queue = [];
}
