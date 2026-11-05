import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LocalHostRestartOffer } from "@helm/core/types";
import { useRestartHost, type RestartHostDeps } from "./useRestartHost";

/** Main's two restart calls, recorded, answering `offer` to the ask. */
function fakeMain(offer: LocalHostRestartOffer): RestartHostDeps & {
  calls: string[];
  errors: string[];
} {
  const calls: string[] = [];
  const errors: string[] = [];
  return {
    calls,
    errors,
    ask: () => {
      calls.push("windowSessions:restartAsk");
      return Promise.resolve(offer);
    },
    restart: () => {
      calls.push("windowSessions:restartHost");
      return Promise.resolve();
    },
    onError: (message) => errors.push(message),
  };
}

const ending: LocalHostRestartOffer = {
  hostVersion: "2.4.0",
  sessions: 3,
  ends: 3,
};

describe("useRestartHost", () => {
  it("S13: Cancel on the question that names how many sessions end changes nothing", async () => {
    const main = fakeMain(ending);
    const { result } = renderHook(() => useRestartHost(main));
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.offer).toEqual(ending));
    act(() => result.current.cancel());
    expect(result.current.offer).toBeNull();
    expect(main.calls).toEqual(["windowSessions:restartAsk"]);
    expect(main.errors).toEqual([]);
  });

  it("S13: confirming restarts the host once, and the question goes away", async () => {
    const main = fakeMain(ending);
    const { result } = renderHook(() => useRestartHost(main));
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.offer).toEqual(ending));
    act(() => result.current.confirm());
    expect(result.current.offer).toBeNull();
    expect(main.calls).toEqual([
      "windowSessions:restartAsk",
      "windowSessions:restartHost",
    ]);
  });

  it("S11: nothing restarts the host until the user asks and confirms", () => {
    const main = fakeMain(ending);
    const { result, rerender } = renderHook(() => useRestartHost(main));
    rerender();
    expect(result.current.offer).toBeNull();
    expect(main.calls).toEqual([]);
  });

  it("says an ask the host could not answer, and shows no question", async () => {
    const main = fakeMain(ending);
    main.ask = () => Promise.reject(new Error("This PC’s host is not answering."));
    const { result } = renderHook(() => useRestartHost(main));
    act(() => result.current.ask());
    await waitFor(() =>
      expect(main.errors).toEqual(["This PC’s host is not answering."]),
    );
    expect(result.current.offer).toBeNull();
  });
});
