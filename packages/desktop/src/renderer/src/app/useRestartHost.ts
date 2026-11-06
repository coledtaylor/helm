import { useCallback, useState } from "react";
import type { LocalHostRestartOffer } from "@helm/core/types";

/** The two calls Restart host to update makes of main. */
export interface RestartHostDeps {
  /** What a restart would end, asked of this PC's host. */
  ask: () => Promise<LocalHostRestartOffer>;
  /** Restarts this PC's host on the floti this Helm carries. */
  restart: () => Promise<void>;
  /** Says a call that failed, in the window's own error toast. */
  onError: (message: string) => void;
}

export interface RestartHost {
  /** The offer the question shows, or null while none is asked. */
  offer: LocalHostRestartOffer | null;
  /** On the user's click: asks the host what a restart ends, then shows the question. */
  ask: () => void;
  /** The user agreed to what the question said: restarts the host. */
  confirm: () => void;
  /** The user cancelled: the question goes away and nothing else happens. */
  cancel: () => void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Restart host to update, on the user's click only: what it ends is asked of
 * the host first and said in the question, Cancel changes nothing, and only
 * the confirm restarts it. Helm never restarts the host on its own.
 */
export function useRestartHost(deps: RestartHostDeps): RestartHost {
  const { ask: askHost, restart, onError } = deps;
  const [offer, setOffer] = useState<LocalHostRestartOffer | null>(null);
  const ask = useCallback(() => {
    askHost().then(setOffer, (error: unknown) => onError(messageOf(error)));
  }, [askHost, onError]);
  const confirm = useCallback(() => {
    setOffer(null);
    restart().catch((error: unknown) => onError(messageOf(error)));
  }, [restart, onError]);
  const cancel = useCallback(() => setOffer(null), []);
  return { offer, ask, confirm, cancel };
}
