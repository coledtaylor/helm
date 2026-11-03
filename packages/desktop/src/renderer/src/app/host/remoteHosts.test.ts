import type * as P from "../../../../shared/host/protocol";
import { describe, expect, it } from "vitest";
import {
  FakeConnection,
  reconnectingReach,
} from "../../../../../test/fake-connection";
import type { RemoteHostStates } from "../../../../shared/ipc";
import { createRemoteHosts, type RemoteHostsDeps } from "./remoteHosts";

function record(
  id: number,
  name: string,
  cwd: string,
  status: P.SessionRecord["status"] = "running",
): P.SessionRecord {
  return {
    id,
    name,
    label: null,
    cwd,
    branch: null,
    projectPath: null,
    profileId: null,
    argv: [],
    conversationId: null,
    backend: "claude-code",
    status,
    startedAt: "2026-11-03T09:00:00.000Z",
    endedAt: null,
    durationMs: null,
    exitCode: null,
  };
}

/** A host that lists `rows` as its sessions. */
function hostListing(rows: P.SessionRecord[]): FakeConnection {
  return new FakeConnection().answer("session:list", () => rows);
}

/**
 * The window's view of every remote host, with main played by the test: it
 * says where each host stands, and each host's page link is a fake the test
 * connects and loses.
 */
function world(hosts: Record<string, FakeConnection>) {
  let changed: (states: RemoteHostStates) => void = () => undefined;
  const links = new Map<string, ReturnType<typeof reconnectingReach>>();
  const opened: string[] = [];
  // The page's clock, stepped by the test: nothing here waits on time.
  let clock = 0;
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const deps: RemoteHostsDeps = {
    now: () => clock,
    setInterval: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { run, ms });
      return id;
    },
    clearInterval: (timer) => void timers.delete(timer as number),
    bridge: {
      invoke: (() =>
        Promise.resolve({})) as unknown as RemoteHostsDeps["bridge"]["invoke"],
      send: () => undefined,
      on: ((channel: string, listener: (states: RemoteHostStates) => void) => {
        if (channel === "remoteHosts:changed") changed = listener;
        return () => undefined;
      }) as RemoteHostsDeps["bridge"]["on"],
    },
    log: () => undefined,
    pageLink: (id) => {
      const first = hosts[id];
      if (first === undefined) throw new Error(`no host ${id} in this test`);
      const link = reconnectingReach(first);
      const connection = link.connection.bind(link);
      link.connection = () => {
        opened.push(id);
        return connection();
      };
      links.set(id, link);
      return link;
    },
  };
  const store = createRemoteHosts(deps);
  let renders = 0;
  store.subscribe(() => (renders += 1));
  return {
    store,
    opened,
    link: (id: string) => {
      const link = links.get(id);
      if (link === undefined) throw new Error(`no link to ${id}`);
      return link;
    },
    tell: (states: RemoteHostStates) => changed(states),
    renders: () => renders,
    /** Moves the page's clock on by `ms`. */
    step: (ms: number) => void (clock += ms),
    /** Every repeating timer running now, by how often it repeats. */
    timers: () => [...timers.values()],
    /** Runs every repeating timer once, as each comes due. */
    tick: () => {
      for (const timer of [...timers.values()]) timer.run();
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("the window’s view of hosts on other computers", () => {
  it("S8: lists each connected host’s running sessions under it, and a host that cannot be reached holds up none", async () => {
    const build = hostListing([
      record(4, "deploy", "/srv/app"),
      record(5, "old", "/srv/app", "exited"),
    ]);
    const lab = hostListing([record(4, "notebook", "/home/me/lab")]);
    const w = world({ "h-build": build, "h-lab": lab });

    w.tell({
      "h-build": { state: "connected" },
      "h-far": { state: "retrying" },
      "h-lab": { state: "connected" },
      "h-new": { state: "keyChanged" },
    });
    await settle();

    // Only the connected hosts are reached; the window never asks main to try the others.
    expect(w.opened.sort()).toEqual(["h-build", "h-lab"]);
    const view = w.store.get();
    expect(view["h-build"]?.sessions).toEqual([
      { key: "h-build:4", name: "deploy", cwd: "/srv/app", state: "running" },
    ]);
    // Ids repeat across hosts; the keys never do.
    expect(view["h-lab"]?.sessions).toEqual([
      {
        key: "h-lab:4",
        name: "notebook",
        cwd: "/home/me/lab",
        state: "running",
      },
    ]);
    expect(view["h-far"]).toEqual({
      connection: { state: "retrying" },
      sessions: [],
      roundTripMs: null,
      resources: new Map(),
    });
    expect(view["h-new"]?.connection).toEqual({ state: "keyChanged" });

    // Activity there changes a row's state; a session ended there leaves the list.
    build.snapshot("session:activity", [
      { id: 4, activity: "waiting" },
    ] as never);
    await settle();
    expect(w.store.get()["h-build"]?.sessions[0]?.state).toBe("waiting");
    build.answer("session:list", () => [
      record(4, "deploy", "/srv/app", "exited"),
    ]);
    build.push("session:exit", { id: 4 } as never);
    await settle();
    expect(w.store.get()["h-build"]?.sessions).toEqual([]);
  });

  it("S9: a host that drops keeps its rows as not connected, and they come back live once it is reachable again", async () => {
    const first = hostListing([record(4, "deploy", "/srv/app")]);
    const w = world({ "h-build": first });
    w.tell({ "h-build": { state: "connected" } });
    await settle();
    expect(w.store.get()["h-build"]?.sessions).toHaveLength(1);

    // The ssh process ends: main says the host is retrying, and the window's connection ends with it.
    w.link("h-build").lose({ planned: false, restarts: false });
    w.tell({ "h-build": { state: "retrying" } });
    await settle();
    const dropped = w.store.get()["h-build"];
    expect(dropped?.connection).toEqual({ state: "retrying" });
    // Still running there: kept, for the pane to dim, never shown as stopped or lost.
    expect(dropped?.sessions).toEqual([
      { key: "h-build:4", name: "deploy", cwd: "/srv/app", state: "running" },
    ]);
    expect(dropped?.roundTripMs).toBeNull();

    // Main reaches it again: the window connects again and lists what runs there now.
    const second = hostListing([
      record(4, "deploy", "/srv/app"),
      record(6, "tests", "/srv/app"),
    ]);
    w.tell({ "h-build": { state: "connected" } });
    await w.link("h-build").reconnect(second);
    await settle();
    expect(w.store.get()["h-build"]?.sessions.map((row) => row.key)).toEqual([
      "h-build:4",
      "h-build:6",
    ]);
    // Nothing the window did asked a session to end, on either connection: it listed and timed.
    for (const connection of [first, second]) {
      expect(
        [...new Set(connection.sent.map((request) => request.channel))].sort(),
      ).toEqual(["host:ping", "session:list"]);
    }
  });

  it("S8: Reconnect now asks main to try that host at once and the window’s own link to drop its wait, and asks the host nothing", async () => {
    const invoked: Array<{ channel: string; payload: unknown }> = [];
    const build = hostListing([record(4, "deploy", "/srv/app")]);
    let changed: (states: RemoteHostStates) => void = () => undefined;
    const reconnects: string[] = [];
    const store = createRemoteHosts({
      bridge: {
        invoke: ((channel: string, payload: unknown) => {
          invoked.push({ channel, payload });
          return Promise.resolve(
            channel === "remoteHosts:read" ? {} : undefined,
          );
        }) as unknown as RemoteHostsDeps["bridge"]["invoke"],
        send: () => undefined,
        on: ((
          channel: string,
          listener: (states: RemoteHostStates) => void,
        ) => {
          if (channel === "remoteHosts:changed") changed = listener;
          return () => undefined;
        }) as RemoteHostsDeps["bridge"]["on"],
      },
      log: () => undefined,
      pageLink: (id) => ({
        ...reconnectingReach(build),
        reconnectNow: () => reconnects.push(id),
      }),
    });
    store.subscribe(() => undefined);
    changed({ "h-build": { state: "connected" } });
    await settle();
    const sentBefore = build.sent.length;
    changed({
      "h-build": {
        state: "failed",
        lastLine:
          "ssh: connect to host build-box port 22: Connection timed out",
      },
    });

    store.reconnect("h-build");
    await settle();
    expect(
      invoked.filter((call) => call.channel === "remoteHosts:reconnect"),
    ).toEqual([
      { channel: "remoteHosts:reconnect", payload: { id: "h-build" } },
    ]);
    expect(reconnects).toEqual(["h-build"]);
    expect(build.sent.length).toBe(sentBefore);
  });

  it("S11: times the window's connection to each connected host at once and every five seconds, one ping at a time, and has none while it is not connected", async () => {
    const build = hostListing([]);
    let answer: () => void = () => undefined;
    build.answer("host:ping", () => null);
    const w = world({ "h-build": build });
    // Each ping is answered when the test says, as the host's reply arrives.
    const request = build.request.bind(build);
    build.request = ((channel: string, payload: unknown) => {
      if (channel !== "host:ping")
        return request(channel as never, payload as never);
      build.sent.push({ channel, payload });
      return new Promise((done) => (answer = () => done(null as never)));
    }) as typeof build.request;

    w.tell({ "h-build": { state: "connected" } });
    await settle();
    expect(w.timers().map((timer) => timer.ms)).toEqual([5_000]);
    expect(build.payloads("host:ping")).toHaveLength(1);
    expect(w.store.get()["h-build"]?.roundTripMs).toBeNull();

    w.step(42);
    answer();
    await settle();
    expect(w.store.get()["h-build"]?.roundTripMs).toBe(42);

    // Every five seconds again; one still waiting is not asked a second time.
    w.tick();
    w.tick();
    expect(build.payloads("host:ping")).toHaveLength(2);
    w.step(7);
    answer();
    await settle();
    expect(w.store.get()["h-build"]?.roundTripMs).toBe(7);

    // Dropped: no round trip, and no more pings.
    w.link("h-build").lose({ planned: false, restarts: false });
    w.tell({ "h-build": { state: "retrying" } });
    await settle();
    expect(w.store.get()["h-build"]?.roundTripMs).toBeNull();
    expect(w.timers()).toEqual([]);
  });

  it("S1: a connected host's processes and ports reach the window from its own pass, while the sessions pane looks", async () => {
    const build = hostListing([record(4, "deploy", "/srv/app")]);
    const w = world({ "h-build": build });
    w.tell({ "h-build": { state: "connected" } });
    await settle();
    expect(build.payloads("sessions:watch")).toEqual([]);

    w.store.watch(true);
    await settle();
    expect(build.payloads("sessions:watch")).toEqual([{ watching: true }]);
    build.snapshot("sessions:resources", [
      {
        id: 4,
        rootPid: 10,
        processes: [],
        rootSeen: true,
        ports: [
          { port: 5173, pid: 11, process: "node", addresses: ["127.0.0.1"] },
        ],
        opaque: 0,
        atMs: 1,
      },
    ]);
    await settle();
    expect(w.store.get()["h-build"]?.resources.get(4)?.ports).toEqual([
      { port: 5173, pid: 11, process: "node", addresses: ["127.0.0.1"] },
    ]);

    w.store.watch(false);
    await settle();
    expect(build.payloads("sessions:watch")).toEqual([
      { watching: true },
      { watching: false },
    ]);
  });
});
