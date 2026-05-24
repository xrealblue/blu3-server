import { verify } from "hono/jwt";
import { getOrCreateRoom, addClient, removeClient, broadcast, sendTo, getRoomMembers, setPlayback, getPlayback, } from "./roomManager.js";
import { nanoid } from "nanoid";
export async function handleWS(ws, url) {
    const token = url.searchParams.get("token");
    const roomCode = url.searchParams.get("room")?.toUpperCase();
    if (!token || !roomCode) {
        ws.send(JSON.stringify({ type: "error", message: "Missing token or room" }));
        ws.close();
        return;
    }
    let payload;
    try {
        payload = await verify(token, process.env.JWT_SECRET, "HS256");
    }
    catch (err) {
        console.error("WS auth error:", err);
        ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
        ws.close();
        return;
    }
    const socketId = nanoid();
    const client = {
        id: socketId,
        userId: payload.sub,
        name: payload.name,
        avatar: payload.avatar,
        roomCode,
        ws,
    };
    const room = getOrCreateRoom(roomCode, payload.sub);
    addClient(client);
    // Send initial state
    ws.send(JSON.stringify({
        type: "room:joined",
        roomCode,
        isHost: room.hostId === payload.sub,
        members: getRoomMembers(roomCode),
        playback: getPlayback(roomCode),
    }));
    broadcast(roomCode, {
        type: "room:member_joined",
        members: getRoomMembers(roomCode),
        user: { userId: payload.sub, name: payload.name, avatar: payload.avatar },
    }, socketId);
    // Return handlers — caller uses these
    return {
        onMessage(event) {
            let msg;
            try {
                msg = JSON.parse(event.data ?? event);
            }
            catch {
                return;
            }
            switch (msg.type) {
                case "chat:send": {
                    const chatMsg = {
                        id: nanoid(),
                        userId: payload.sub,
                        name: payload.name,
                        avatar: payload.avatar,
                        text: String(msg.text).slice(0, 500),
                        ts: Date.now(),
                    };
                    broadcast(roomCode, { type: "chat:message", message: chatMsg });
                    break;
                }
                case "playback:play": {
                    if (room.hostId !== payload.sub)
                        return;
                    setPlayback(roomCode, {
                        videoId: msg.videoId,
                        trackName: msg.trackName ?? "",
                        artistName: msg.artistName ?? "",
                        image: msg.image ?? "",
                        isPlaying: true,
                        currentTime: msg.currentTime ?? 0,
                    });
                    broadcast(roomCode, {
                        type: "playback:play",
                        ...getPlayback(roomCode),
                    });
                    break;
                }
                case "playback:pause": {
                    if (room.hostId !== payload.sub)
                        return;
                    setPlayback(roomCode, {
                        isPlaying: false,
                        currentTime: msg.currentTime ?? 0,
                    });
                    broadcast(roomCode, {
                        type: "playback:pause",
                        currentTime: msg.currentTime,
                    });
                    break;
                }
                case "playback:seek": {
                    if (room.hostId !== payload.sub)
                        return;
                    setPlayback(roomCode, { currentTime: msg.currentTime ?? 0 });
                    broadcast(roomCode, {
                        type: "playback:seek",
                        currentTime: msg.currentTime,
                    });
                    break;
                }
                case "playback:sync_request": {
                    sendTo(socketId, roomCode, {
                        type: "playback:sync",
                        ...getPlayback(roomCode),
                    });
                    break;
                }
            }
        },
        onClose() {
            removeClient(socketId, roomCode);
            broadcast(roomCode, {
                type: "room:member_left",
                members: getRoomMembers(roomCode),
                userId: payload.sub,
            });
        },
    };
}
