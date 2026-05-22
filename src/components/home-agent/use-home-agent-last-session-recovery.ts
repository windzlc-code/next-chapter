import { useCallback, useEffect, useRef } from "react";
import {
  hasSessionResetMarkerForProject,
  readLastSessionFromFile,
  writeStudioSession,
} from "@/lib/home-agent/session-store";

export function useHomeAgentLastSessionRecovery(params: {
  hasSeedSession: boolean;
  openProject: (projectId: string) => Promise<void> | void;
}) {
  const { hasSeedSession, openProject } = params;
  const attemptedRef = useRef(hasSeedSession);
  const suppressedRef = useRef(false);

  const suppressAutoRestore = useCallback(() => {
    suppressedRef.current = true;
  }, []);

  useEffect(() => {
    if (hasSeedSession) {
      attemptedRef.current = true;
      return;
    }
    if (attemptedRef.current) return;

    attemptedRef.current = true;
    let cancelled = false;

    void (async () => {
      const fileSession = await readLastSessionFromFile();
      if (cancelled || suppressedRef.current || !fileSession?.projectId) return;
      if (hasSessionResetMarkerForProject(fileSession.projectId)) return;

      writeStudioSession(fileSession);
      if (cancelled || suppressedRef.current) return;

      void openProject(fileSession.projectId);
    })();

    return () => {
      cancelled = true;
    };
  }, [hasSeedSession, openProject]);

  return { suppressAutoRestore };
}
