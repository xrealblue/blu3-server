import { describe, it, expect, beforeEach, jest } from "bun:test";
import { RoomManager } from "./roomManager.js";

function makeClient(userId: string, roomCode: string, id = userId) {
  const ws = { readyState: 1, send: jest.fn(), close: jest.fn() } as any;
  return { id, userId, name: `user-${userId}`, roomCode, ws };
}

describe("RoomManager", () => {
  let mgr: RoomManager;

  beforeEach(() => {
    mgr = new RoomManager();
  });

  it("adds a client and registers them as a member", async () => {
    await mgr.initRoom("abc", "alice");
    const client = makeClient("alice", "abc");
    const res = await mgr.addClient(client);
    expect(res).toBe(false);
    const members = await mgr.getMembers("abc");
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe("alice");
  });

  it("detects reconnection by same user in same room", async () => {
    await mgr.initRoom("abc", "alice");
    const c1 = makeClient("alice", "abc", "sock1");
    await mgr.addClient(c1);
    const c2 = makeClient("alice", "abc", "sock2");
    const res = await mgr.addClient(c2);
    expect(res).toBe(true);
    expect(c1.ws.close).toHaveBeenCalledWith(4001, "Replaced by new connection");
  });

  it("removes a client on disconnect", async () => {
    await mgr.initRoom("abc", "alice");
    const c1 = makeClient("alice", "abc", "sock1");
    await mgr.addClient(c1);
    mgr.removeClient("sock1", "abc");
    const members = await mgr.getMembers("abc");
    expect(members).toHaveLength(0);
  });

  it("prevents duplicate connection to different room", async () => {
    await mgr.initRoom("abc", "alice");
    const c1 = makeClient("alice", "abc", "sock1");
    await mgr.addClient(c1);
    const c2 = makeClient("alice", "xyz", "sock2");
    const res = await mgr.addClient(c2);
    expect(res).toBe(false);
    expect(c1.ws.close).toHaveBeenCalledWith(4001, "Connected to another room");
  });

  it("tracks host via initRoom", async () => {
    await mgr.initRoom("abc", "host1");
    expect(mgr.getHostId("abc")).toBe("host1");
    expect(mgr.isHostInRoom("abc")).toBe(false);
    const client = makeClient("host1", "abc", "hostsock");
    await mgr.addClient(client);
    expect(mgr.isHostInRoom("abc")).toBe(true);
  });

  it("allows playback control when host absent", async () => {
    await mgr.initRoom("abc", "host1");
    expect(mgr.canControlPlayback("abc", "anyone")).toBe(true);
  });

  it("restricts playback control to host when host present", async () => {
    await mgr.initRoom("abc", "host1");
    const h = makeClient("host1", "abc");
    await mgr.addClient(h);
    expect(mgr.canControlPlayback("abc", "host1")).toBe(true);
    expect(mgr.canControlPlayback("abc", "other")).toBe(false);
  });

  it("revokes fallback when original host reconnects", async () => {
    await mgr.initRoom("abc", "host1");
    const h = makeClient("host1", "abc", "hsock");
    await mgr.addClient(h);
    mgr.removeClient("hsock", "abc");
    const broadcastFn = jest.fn();
    (mgr as any).hostFallbackMap.set("abc", { userId: "member1", electedAt: Date.now() });
    (mgr as any).electionTimers.set("abc", setTimeout(() => {}, 1000));
    const h2 = makeClient("host1", "abc", "hsock2");
    const res = await mgr.addClient(h2);
    expect(res).toBe(true);
    expect(mgr.isFallbackActive("abc")).toBe(false);
  });

  it("updates canControlPlayback for fallback host", async () => {
    await mgr.initRoom("abc", "host1");
    const h = makeClient("host1", "abc", "hsock");
    await mgr.addClient(h);
    mgr.removeClient("hsock", "abc");
    (mgr as any).hostFallbackMap.set("abc", { userId: "fallback1", electedAt: Date.now() });
    expect(mgr.canControlPlayback("abc", "fallback1")).toBe(true);
    expect(mgr.canControlPlayback("abc", "stranger")).toBe(false);
  });

  it("broadcasts messages to room clients", async () => {
    await mgr.initRoom("abc", "alice");
    const c1 = makeClient("alice", "abc", "sock1");
    await mgr.addClient(c1);
    mgr.broadcast("abc", { type: "test", data: "hello" } as any);
    expect(c1.ws.send).toHaveBeenCalled();
    const sent = c1.ws.send.mock.calls[0][0];
    expect(typeof sent).toBe("string");
  });

  it("can add, get, and remove queue tracks", async () => {
    await mgr.initRoom("abc", "alice");
    const track = { id: "t1", source: "youtube" as const, videoId: "vid1", name: "Test", artists: [{ name: "Artist" }], image: "", duration_ms: 1000 };
    await mgr.addToQueue("abc", track);
    const q = await mgr.getQueue("abc");
    expect(q).toHaveLength(1);
    expect(q[0].videoId).toBe("vid1");
    await mgr.removeFromQueue("abc", "t1");
    const q2 = await mgr.getQueue("abc");
    expect(q2).toHaveLength(0);
  });
});
