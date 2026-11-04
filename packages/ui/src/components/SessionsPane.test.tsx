import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  LiveSession,
  SessionProcess,
  SessionRecord,
  SessionResources,
} from "@helm/core";
import {
  SessionsPane,
  type SessionsPaneHost,
  type SessionsPaneProps,
} from "./SessionsPane";
import { expectOnThePane } from "./page.testkit";

function live(
  over: Partial<LiveSession> & Pick<LiveSession, "pid">,
): LiveSession {
  return {
    helmSessionId: null,
    registered: true,
    cwd: null,
    name: null,
    activity: "idle",
    waitingFor: null,
    message: null,
    statusSinceMs: null,
    version: "2.1.999",
    entrypoint: "cli",
    startedAtMs: Date.now() - 60_000,
    claudeSessionId: null,
    ...over,
  };
}

function row(id: number, name: string, cwd: string): SessionRecord {
  return {
    id,
    name,
    label: null,
    cwd,
    branch: "main",
    projectPath: cwd,
    profileId: null,
    argv: ["-n", name],
    claudeSessionId: null,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: null,
  };
}

function proc(
  pid: number,
  parentPid: number,
  name: string,
  depth: number,
  ports: number[] | null = [],
): SessionProcess {
  return { pid, parentPid, name, commandLine: `${name} --flag`, depth, ports };
}

const SHOP = live({
  helmSessionId: 1,
  pid: 4100,
  cwd: "C:\\work\\shop",
  name: "shop",
});
const DOCS = live({
  helmSessionId: 2,
  pid: 4200,
  cwd: "C:\\work\\docs",
  name: "docs",
  activity: "busy",
});
const QUIET = live({
  helmSessionId: 3,
  pid: 4300,
  cwd: "C:\\work\\quiet",
  name: "quiet",
});
const OUTSIDE = live({
  pid: 5100,
  cwd: "C:\\work\\api",
  name: "terminal session",
  activity: "waiting",
  waitingFor: "dialog open",
});

const RESOURCES: [number, SessionResources][] = [
  [
    1,
    {
      id: 1,
      rootPid: 300,
      processes: [
        proc(300, 4, "cmd.exe", 0),
        proc(301, 300, "node.exe", 1, [5173]),
      ],
      rootSeen: true,
      ports: [
        { port: 5173, pid: 301, process: "node.exe", addresses: ["127.0.0.1"] },
      ],
      opaque: 0,
      atMs: 1_000,
    },
  ],
  [
    2,
    {
      id: 2,
      rootPid: 400,
      processes: [
        proc(400, 4, "cmd.exe", 0),
        proc(401, 400, "python.exe", 1, [8000]),
      ],
      rootSeen: true,
      ports: [
        { port: 8000, pid: 401, process: "python.exe", addresses: ["0.0.0.0"] },
      ],
      opaque: 0,
      atMs: 1_000,
    },
  ],
  [
    3,
    {
      id: 3,
      rootPid: 500,
      processes: [proc(500, 4, "cmd.exe", 0)],
      rootSeen: true,
      ports: [],
      opaque: 0,
      atMs: 1_000,
    },
  ],
];

function renderPane(
  overrides: Partial<SessionsPaneProps> = {},
): SessionsPaneProps {
  const props: SessionsPaneProps = {
    sessions: [SHOP, DOCS, QUIET, OUTSIDE],
    readAtMs: Date.now(),
    records: new Map([
      [1, row(1, "shop", "C:\\work\\shop")],
      [2, row(2, "docs", "C:\\work\\docs")],
      [3, row(3, "quiet", "C:\\work\\quiet")],
    ]),
    resources: new Map(RESOURCES),
    selectedPid: null,
    onSelect: vi.fn(),
    onOpenSession: vi.fn(),
    onReveal: vi.fn(),
    ...overrides,
  };
  render(<SessionsPane {...props} />);
  return props;
}

const items = (region: HTMLElement): string[] =>
  within(region)
    .queryAllByRole("listitem")
    .map((item) => item.textContent ?? "");

describe("SessionsPane", () => {
  it("shows a session whose program reports an error, with its message, and a reported block's kind", () => {
    const failing = live({
      helmSessionId: 1,
      pid: 4100,
      cwd: "C:\\work\\shop",
      name: "shop",
      registered: false,
      activity: "error",
      message: "build failed: 3 errors",
    });
    const asking = live({
      helmSessionId: 2,
      pid: 4200,
      cwd: "C:\\work\\docs",
      name: "docs",
      registered: false,
      activity: "waiting",
      waitingFor: "question",
    });
    renderPane({
      sessions: [failing, asking],
      selectedPid: failing.pid,
    });
    const inHelm = screen.getByRole("region", { name: "In Helm" });
    const [shop, docs] = within(inHelm).getAllByRole("button");
    expect(shop?.textContent).toContain("build failed: 3 errors");
    expect(
      within(shop as HTMLElement).getByTitle("Error: build failed: 3 errors"),
    ).toBeDefined();
    expect(
      shop?.querySelector("[data-session-dot]")?.classList.contains("bg-danger"),
    ).toBe(true);
    expect(within(docs as HTMLElement).getByTitle("Waiting: question")).toBeDefined();

    const chip = document.querySelector('[data-session-state-chip="error"]');
    expect(chip?.textContent).toBe("reports an error");
    expect(chip?.getAttribute("title")).toBe("Error: build failed: 3 errors");
  });

  it("lists Helm’s sessions and everything else on the machine apart, each with its own folder", async () => {
    const props = renderPane();
    const inHelm = screen.getByRole("region", { name: "In Helm" });
    const elsewhere = screen.getByRole("region", {
      name: "Elsewhere on this machine",
    });

    const hosted = within(inHelm).getAllByRole("button");
    expect(hosted).toHaveLength(3);
    for (const [i, session] of [SHOP, DOCS, QUIET].entries()) {
      expect(hosted[i]?.textContent).toContain(session.name);
      expect(hosted[i]?.textContent).toContain(session.cwd);
    }

    const outside = within(elsewhere).getByRole("button", {
      name: /^terminal session/,
    });
    expect(outside.textContent).toContain("C:\\work\\api");
    expect(
      within(inHelm).queryByRole("button", { name: /^terminal session/ }),
    ).toBeNull();

    await userEvent.click(outside);
    expect(props.onSelect).toHaveBeenCalledWith(OUTSIDE);
  });

  it("shows a hosted session’s own children and ports, and nothing of another session’s", async () => {
    const props = renderPane({ selectedPid: SHOP.pid });
    expect(
      screen.getByRole("heading", { level: 2, name: "shop" }),
    ).toBeDefined();

    const tree = screen.getByRole("region", { name: "Process tree" });
    expect(items(tree)).toEqual([
      expect.stringMatching(/^cmd\.exe300/),
      expect.stringMatching(/^node\.exe301:5173/),
    ]);
    const ports = screen.getByRole("region", { name: "Listening ports" });
    expect(items(ports)).toHaveLength(1);
    expect(items(ports)[0]).toContain("5173");
    expect(items(ports)[0]).toContain("loopback");
    for (const text of [...items(tree), ...items(ports)]) {
      expect(text).not.toContain("python.exe");
      expect(text).not.toContain("8000");
    }

    await userEvent.click(
      screen.getByRole("button", { name: "Show the terminal" }),
    );
    expect(props.onOpenSession).toHaveBeenCalledWith(1);
  });

  it("says a session with no children is running nothing but itself, and draws no tree rows", () => {
    renderPane({ selectedPid: QUIET.pid });
    const tree = screen.getByRole("region", { name: "Process tree" });
    expect(items(tree)).toEqual([]);
    expect(tree.textContent).toContain(
      "Nothing but the session itself was running",
    );
  });

  it("says unknown for both the tree and the ports when the machine could not be asked, never nothing", () => {
    const [, shop] = RESOURCES[0] as [number, SessionResources];
    renderPane({
      selectedPid: SHOP.pid,
      resources: new Map([
        [1, { ...shop, processes: null, rootSeen: false, ports: null }],
      ]),
    });
    const tree = screen.getByRole("region", { name: "Process tree" });
    const ports = screen.getByRole("region", { name: "Listening ports" });
    expect(tree.textContent).toContain("Unknown");
    expect(tree.textContent).not.toContain("Nothing but the session itself");
    expect(ports.textContent).toContain("Unknown");
    expect(ports.textContent).not.toContain("is listening");
  });

  it("says unknown for the ports alone when only the socket query failed", () => {
    const [, shop] = RESOURCES[0] as [number, SessionResources];
    renderPane({
      selectedPid: SHOP.pid,
      resources: new Map([
        [
          1,
          {
            ...shop,
            ports: null,
            processes: (shop.processes ?? []).map((p) => ({
              ...p,
              ports: null,
            })),
          },
        ],
      ]),
    });
    const tree = screen.getByRole("region", { name: "Process tree" });
    const ports = screen.getByRole("region", { name: "Listening ports" });
    expect(items(tree)).toHaveLength(2);
    expect(tree.textContent).not.toContain("Unknown");
    expect(ports.textContent).toContain("Unknown");
    expect(items(ports)).toEqual([]);
  });

  it("says what is knowable about a session Helm did not start, and no more", () => {
    renderPane({ selectedPid: OUTSIDE.pid });
    expect(
      screen.getByRole("heading", { level: 2, name: "terminal session" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "C:\\work\\api" })).toBeDefined();
    expect(
      screen.getByRole("region", { name: "What Helm knows" }).textContent,
    ).toContain("Helm did not start this session");
    expect(screen.queryByRole("region", { name: "Process tree" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Listening ports" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show the terminal" }),
    ).toBeNull();
  });
});

describe("SessionsPane sessions not open here", () => {
  it("lists a session running in the host with no tab on this device as not open here, once, with Open and End", async () => {
    const onEndSession = vi.fn();
    const props = renderPane({
      notOpenHere: [row(2, "docs", "C:\\work\\docs")],
      onEndSession,
    });
    const notHere = screen.getByRole("region", { name: "Not open here" });
    expect(notHere.textContent).toContain("docs");
    expect(notHere.textContent).toContain("C:\\work\\docs");
    // Its dot is the registry's word on it, as on every other row.
    expect(notHere.querySelector("[data-session-dot]")?.className).toContain(
      "bg-accent",
    );

    const inHelm = screen.getByRole("region", { name: "In Helm" });
    expect(
      within(inHelm)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      expect.stringContaining("shop"),
      expect.stringContaining("quiet"),
    ]);

    await userEvent.click(
      within(notHere).getByRole("button", { name: "Open docs" }),
    );
    expect(props.onOpenSession).toHaveBeenCalledWith(2);
    await userEvent.click(
      within(notHere).getByRole("button", { name: "End docs" }),
    );
    expect(onEndSession).toHaveBeenCalledWith(2);
  });

  it("lists a session not open here before Claude Code has written its record, rather than saying nothing runs", () => {
    renderPane({
      sessions: [],
      notOpenHere: [row(4, "api", "C:\\work\\api")],
      onEndSession: vi.fn(),
    });
    expect(
      screen.getByRole("region", { name: "Not open here" }).textContent,
    ).toContain("api");
    expect(screen.queryByText("Nothing running")).toBeNull();
    expect(screen.getByText("No session is open here.")).toBeDefined();
  });

  it("draws no not-open-here heading when every session has a tab here, as with sessions in Helm itself", () => {
    renderPane();
    expect(screen.queryByRole("region", { name: "Not open here" })).toBeNull();
  });
});

describe("SessionsPane on its pane", () => {
  it("draws no island of its own, and its bar repeats no title the tab already says", () => {
    renderPane();
    expectOnThePane(document.body, "sessions");
    // Nothing picked is a real empty state, not a paragraph.
    expect(
      document.querySelector('[data-empty-state="sessions-detail"]'),
    ).not.toBeNull();
  });
});

describe("SessionsPane: every host under its name", () => {
  const BUILD: SessionsPaneHost = {
    id: "h-build",
    name: "build-box",
    connected: true,
    sessions: [
      { key: "h-build:7", name: "deploy", cwd: "/srv/infra", state: "busy" },
    ],
  };
  const LAB: SessionsPaneHost = {
    id: "h-lab",
    name: "lab",
    connected: false,
    sessions: [
      { key: "h-lab:3", name: "logs", cwd: "/home/me/logs", state: "idle" },
    ],
  };

  it("lists this PC first with everything it ran before, then each remote host with its own running sessions", () => {
    renderPane({ remoteHosts: [BUILD, LAB] });
    const hosts = [...document.querySelectorAll("[data-sessions-host]")].map(
      (host) => host.getAttribute("aria-label"),
    );
    expect(hosts).toEqual(["This PC", "build-box", "lab"]);

    const local = screen.getByRole("region", { name: "This PC" });
    expect(within(local).getByRole("region", { name: "In Helm" })).toBeTruthy();
    expect(
      within(local).getByRole("region", { name: "Elsewhere on this machine" }),
    ).toBeTruthy();

    const build = screen.getByRole("region", { name: "build-box" });
    expect(build.textContent).toContain("deploy");
    expect(build.textContent).toContain("/srv/infra");
    expect(build.textContent).not.toContain("logs");
    expect(build.textContent).not.toContain("not connected");
  });

  it("dims a host that is not connected and says it is retrying, keeping its sessions listed", () => {
    renderPane({ remoteHosts: [BUILD, LAB] });
    const lab = screen.getByRole("region", { name: "lab" });
    expect(lab.getAttribute("data-sessions-host-connected")).toBe("false");
    expect(lab.textContent).toContain("not connected, retrying");
    const row = lab.querySelector('[data-remote-session="h-lab:3"]');
    expect(row?.textContent).toContain("logs");
    expect(row?.parentElement?.className).toContain("opacity-50");
    // The connected one is not dimmed.
    const build = screen.getByRole("region", { name: "build-box" });
    expect(
      build.querySelector("[data-remote-session]")?.parentElement?.className,
    ).not.toContain("opacity-50");
  });

  it("S18, S19: says a host’s floti is too old with Update floti, or newer with Update Helm on this PC, naming both protocols", async () => {
    const onUpdateFloti = vi.fn();
    renderPane({
      remoteHosts: [
        {
          ...LAB,
          floti: { verdict: "tooOld", host: "0.9", client: "1.0" },
          onUpdateFloti,
        },
        {
          ...BUILD,
          id: "h-far",
          name: "far",
          connected: false,
          floti: { verdict: "newer", host: "2.0", client: "1.0" },
        },
      ],
    });
    const lab = screen.getByRole("region", { name: "lab" });
    expect(lab.querySelector("[data-sessions-host-floti]")?.textContent).toBe(
      "floti too old",
    );
    expect(lab.textContent).toContain(
      "Its floti speaks protocol 0.9; this Helm speaks 1.0.",
    );
    await userEvent.click(
      within(lab).getByRole("button", { name: "Update floti" }),
    );
    expect(onUpdateFloti).toHaveBeenCalledTimes(1);

    const far = screen.getByRole("region", { name: "far" });
    expect(far.querySelector("[data-sessions-host-floti]")?.textContent).toBe(
      "newer floti",
    );
    expect(far.textContent).toContain(
      "It speaks protocol 2.0; this Helm speaks 1.0. Update Helm on this PC.",
    );
    expect(
      within(far).queryByRole("button", { name: "Update floti" }),
    ).toBeNull();
  });

  it("lists a build-box session with no tab here as not open here, with Open and End through build-box", async () => {
    const onOpenSession = vi.fn();
    const onEndSession = vi.fn();
    renderPane({
      remoteHosts: [
        {
          ...BUILD,
          sessions: [
            {
              key: "h-build:7",
              name: "deploy",
              cwd: "/srv/infra",
              state: "busy",
              openHere: false,
            },
            {
              key: "h-build:8",
              name: "watch",
              cwd: "/srv/infra",
              state: "idle",
              openHere: true,
            },
          ],
          onOpenSession,
          onEndSession,
        },
      ],
    });
    const build = screen.getByRole("region", { name: "build-box" });
    const row = build.querySelector<HTMLElement>(
      '[data-not-open-here="h-build:7"]',
    )!;
    expect(row.textContent).toContain("not open here");
    await userEvent.click(
      within(row).getByRole("button", { name: "Open deploy" }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("h-build:7");
    await userEvent.click(
      within(row).getByRole("button", { name: "End deploy" }),
    );
    expect(onEndSession).toHaveBeenCalledWith("h-build:7");
    // The one with a tab here offers neither.
    expect(
      within(build).queryByRole("button", { name: "Open watch" }),
    ).toBeNull();
    expect(build.querySelector('[data-not-open-here="h-build:8"]')).toBeNull();
  });

  it("S1, S4: lists each port a build-box session listens on with Open in browser, which asks for that port, and says where it is forwarded while it is", async () => {
    const onOpenPort = vi.fn();
    renderPane({
      remoteHosts: [
        {
          ...BUILD,
          sessions: [
            {
              key: "h-build:7",
              name: "deploy",
              cwd: "/srv/infra",
              state: "busy",
              ports: [
                {
                  port: 5173,
                  pid: 11,
                  process: "node",
                  addresses: ["127.0.0.1"],
                },
                { port: 8080, pid: 12, process: "api", addresses: ["0.0.0.0"] },
              ],
              forwarded: new Map([[8080, 49152]]),
            },
          ],
          onOpenPort,
        },
      ],
    });
    const build = screen.getByRole("region", { name: "build-box" });
    const vite = build.querySelector<HTMLElement>(
      '[data-remote-port="h-build:7:5173"]',
    )!;
    expect(vite.textContent).toContain("5173");
    expect(vite.textContent).toContain("node");
    expect(vite.textContent).not.toContain("forwarded");
    await userEvent.click(
      within(vite).getByRole("button", { name: "Open in browser" }),
    );
    expect(onOpenPort).toHaveBeenCalledWith("h-build:7", 5173);

    const api = build.querySelector<HTMLElement>(
      '[data-remote-port="h-build:7:8080"]',
    )!;
    expect(api.querySelector("[data-port-forwarded]")?.textContent).toBe(
      "forwarded to localhost:49152",
    );
    await userEvent.click(
      within(api).getByRole("button", { name: "Open in browser" }),
    );
    expect(onOpenPort).toHaveBeenLastCalledWith("h-build:7", 8080);
  });

  it("says why a port could not be opened, and lists none for a session it has no ports for", () => {
    renderPane({
      remoteHosts: [
        {
          ...BUILD,
          sessions: [
            {
              key: "h-build:7",
              name: "deploy",
              cwd: "/srv/infra",
              state: "busy",
              ports: [
                {
                  port: 5173,
                  pid: 11,
                  process: "node",
                  addresses: ["127.0.0.1"],
                },
              ],
              portProblem:
                "That host is not connected; its port is forwarded once it is.",
            },
            {
              key: "h-build:8",
              name: "watch",
              cwd: "/srv/infra",
              state: "idle",
              ports: [],
            },
          ],
          onOpenPort: vi.fn(),
        },
      ],
    });
    const build = screen.getByRole("region", { name: "build-box" });
    expect(
      build.querySelector('[data-remote-port-problem="h-build:7"]')
        ?.textContent,
    ).toBe("That host is not connected; its port is forwarded once it is.");
    expect(
      build.querySelectorAll('[data-remote-port^="h-build:8:"]'),
    ).toHaveLength(0);
  });

  it("draws the list as it was while this PC is the only host", () => {
    renderPane({ remoteHosts: [] });
    expect(document.querySelectorAll("[data-sessions-host]")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "In Helm" })).toBeTruthy();
  });
});
