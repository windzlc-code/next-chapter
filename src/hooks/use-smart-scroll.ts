import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface UseSmartScrollOptions {
  containerRef: RefObject<HTMLElement | null>;
  endRef: RefObject<HTMLElement | null>;
  active?: boolean;
  dependency?: unknown;
  forceBottomDependency?: unknown;
  followTargetSelector?: string;
  followTargetOffsetRatio?: number;
  resetKey?: unknown;
  showUnreadOnBlocked?: boolean;
  preferPhysicalBottomWhenLocked?: boolean;
  threshold?: number;
  smooth?: boolean;
}

const USER_IDLE_MS = 900;
const DEFAULT_FOLLOW_TARGET_OFFSET_RATIO = 0.36;
const FOLLOW_EASING = 0.24;
const FOLLOW_EPSILON_PX = 0.75;
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function maxScrollTop(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function clampScrollTop(element: HTMLElement, scrollTop: number) {
  return Math.min(Math.max(0, scrollTop), maxScrollTop(element));
}

export function useSmartScroll({
  containerRef,
  endRef,
  active = true,
  dependency,
  forceBottomDependency,
  followTargetSelector,
  followTargetOffsetRatio = DEFAULT_FOLLOW_TARGET_OFFSET_RATIO,
  resetKey,
  showUnreadOnBlocked = false,
  preferPhysicalBottomWhenLocked = false,
  threshold = 180,
  smooth = true,
}: UseSmartScrollOptions) {
  const lockedRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const physicalBottomRafRef = useRef<number | null>(null);
  const lastUserIntentAtRef = useRef(0);
  const resetKeyRef = useRef<unknown>(resetKey);
  const skipNextDependencyRef = useRef(false);
  const scrollPositionsRef = useRef(new Map<unknown, number>());
  const scrollLocksRef = useRef(new Map<unknown, boolean>());
  const didApplyInitialPositionRef = useRef(false);
  const [hasUnreadMessage, setHasUnreadMessage] = useState(false);

  const findFollowTarget = useCallback(() => {
    if (!followTargetSelector) return null;
    const root = endRef.current?.parentElement;
    if (!root) return null;
    const matches = root.querySelectorAll<HTMLElement>(followTargetSelector);
    return matches[matches.length - 1] ?? null;
  }, [endRef, followTargetSelector]);

  const resolveFollowScrollTop = useCallback(
    (element: HTMLElement) => {
      const target = findFollowTarget();
      if (!target) return maxScrollTop(element);

      const containerRect = element.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTop = targetRect.top - containerRect.top + element.scrollTop;
      const offset = element.clientHeight * followTargetOffsetRatio;
      return clampScrollTop(element, targetTop - offset);
    },
    [findFollowTarget, followTargetOffsetRatio],
  );

  const resolveLockedScrollTop = useCallback(
    (element: HTMLElement) => (forceBottomDependency == null ? resolveFollowScrollTop(element) : maxScrollTop(element)),
    [forceBottomDependency, resolveFollowScrollTop],
  );

  const isNearBottom = useCallback(() => {
    const element = containerRef.current;
    return !element || Math.abs(resolveLockedScrollTop(element) - element.scrollTop) <= threshold;
  }, [containerRef, resolveLockedScrollTop, threshold]);

  const cancelScroll = useCallback(() => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const cancelPhysicalBottomScroll = useCallback(() => {
    if (physicalBottomRafRef.current !== null) {
      window.cancelAnimationFrame(physicalBottomRafRef.current);
      physicalBottomRafRef.current = null;
    }
  }, []);

  const isUserIdle = useCallback(() => Date.now() - lastUserIntentAtRef.current > USER_IDLE_MS, []);

  const savePosition = useCallback(
    (key = resetKeyRef.current, locked = lockedRef.current) => {
      const element = containerRef.current;
      if (element && key != null) {
        scrollPositionsRef.current.set(key, element.scrollTop);
        scrollLocksRef.current.set(key, locked);
      }
    },
    [containerRef],
  );

  const scrollToPhysicalBottom = useCallback(
    (force = false) => {
      const element = containerRef.current;
      if (!active || !element || (!force && !lockedRef.current)) return;

      lockedRef.current = true;
      cancelScroll();
      element.scrollTop = maxScrollTop(element);
      savePosition(resetKeyRef.current, true);
      setHasUnreadMessage(false);
    },
    [active, cancelScroll, containerRef, savePosition],
  );

  const scheduleScrollToPhysicalBottom = useCallback(
    (force = false) => {
      const element = containerRef.current;
      if (!active || !element || (!force && !lockedRef.current)) return;
      if (physicalBottomRafRef.current !== null) return;

      physicalBottomRafRef.current = window.requestAnimationFrame(() => {
        physicalBottomRafRef.current = null;
        scrollToPhysicalBottom(force);
      });
    },
    [active, containerRef, scrollToPhysicalBottom],
  );

  const scrollToBottom = useCallback(
    (force = false) => {
      const element = containerRef.current;
      if (!active || !element || (!force && !lockedRef.current)) return;

      lockedRef.current = true;
      if (rafRef.current !== null) return;
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!smooth || prefersReducedMotion) {
        element.scrollTop = resolveFollowScrollTop(element);
        savePosition(resetKeyRef.current, true);
        return;
      }

      const tick = () => {
        const current = containerRef.current;
        if (!current || !active || (!force && !lockedRef.current)) {
          rafRef.current = null;
          return;
        }

        const targetTop = resolveFollowScrollTop(current);
        const delta = targetTop - current.scrollTop;
        if (Math.abs(delta) <= FOLLOW_EPSILON_PX) {
          current.scrollTop = targetTop;
          savePosition(resetKeyRef.current, true);
          rafRef.current = null;
          return;
        }

        current.scrollTop += delta * FOLLOW_EASING;
        savePosition(resetKeyRef.current, true);
        rafRef.current = window.requestAnimationFrame(tick);
      };

      rafRef.current = window.requestAnimationFrame(tick);
    },
    [active, containerRef, resolveFollowScrollTop, savePosition, smooth],
  );

  useEffect(() => {
    if (!active) {
      cancelScroll();
      return;
    }

    const element = containerRef.current;
    if (!element) return;

    const updateLock = () => {
      if (rafRef.current !== null) return;
      const locked = isNearBottom();
      lockedRef.current = locked;
      savePosition(resetKeyRef.current, locked);
      if (lockedRef.current) setHasUnreadMessage(false);
    };
    const interruptAutoScroll = () => {
      lastUserIntentAtRef.current = Date.now();
      lockedRef.current = false;
      savePosition(resetKeyRef.current, false);
      cancelScroll();
      cancelPhysicalBottomScroll();
    };
    const unlockOnWheel = (event: WheelEvent) => {
      lastUserIntentAtRef.current = Date.now();
      if (event.deltaY !== 0 || event.deltaX !== 0) interruptAutoScroll();
    };
    let lastTouchY: number | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      lastUserIntentAtRef.current = Date.now();
      lastTouchY = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      lastUserIntentAtRef.current = Date.now();
      const nextY = event.touches[0]?.clientY ?? null;
      if (lastTouchY !== null && nextY !== null && nextY !== lastTouchY) {
        interruptAutoScroll();
      }
      lastTouchY = nextY;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End", " "].includes(event.key)) return;
      lastUserIntentAtRef.current = Date.now();
      interruptAutoScroll();
    };

    updateLock();
    element.addEventListener("scroll", updateLock, { passive: true });
    element.addEventListener("wheel", unlockOnWheel, { passive: true });
    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      savePosition();
      element.removeEventListener("scroll", updateLock);
      element.removeEventListener("wheel", unlockOnWheel);
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, cancelPhysicalBottomScroll, cancelScroll, containerRef, isNearBottom, savePosition]);

  useIsomorphicLayoutEffect(() => {
    if (!active) return;

    const resetChanged = !Object.is(resetKeyRef.current, resetKey);
    if (!resetChanged && didApplyInitialPositionRef.current) return;

    didApplyInitialPositionRef.current = true;
    if (resetChanged) resetKeyRef.current = resetKey;
    skipNextDependencyRef.current = true;
    cancelScroll();
    setHasUnreadMessage(false);

    const element = containerRef.current;
    if (!element) return;

    const savedTop = resetKey != null ? scrollPositionsRef.current.get(resetKey) : undefined;
    const savedLock = resetKey != null ? scrollLocksRef.current.get(resetKey) : undefined;
    if (savedTop === undefined || savedLock) {
      element.scrollTop = resolveLockedScrollTop(element);
      lockedRef.current = true;
      savePosition(resetKey, true);
      return;
    }

    element.scrollTop = Math.min(savedTop, maxScrollTop(element));
    lockedRef.current = isNearBottom();
    savePosition(resetKey, lockedRef.current);
  }, [
    active,
    cancelScroll,
    containerRef,
    isNearBottom,
    resetKey,
    resolveLockedScrollTop,
    savePosition,
  ]);

  useEffect(() => {
    if (!active) return;
    if (skipNextDependencyRef.current) {
      skipNextDependencyRef.current = false;
      return;
    }

    const canFollowMessage = lockedRef.current && isUserIdle();
    if (!canFollowMessage) {
      if (showUnreadOnBlocked) setHasUnreadMessage(true);
      return;
    }

    setHasUnreadMessage(false);
    if (preferPhysicalBottomWhenLocked) {
      scheduleScrollToPhysicalBottom(false);
      return;
    }
    scrollToBottom(true);
  }, [
    active,
    dependency,
    isUserIdle,
    preferPhysicalBottomWhenLocked,
    scheduleScrollToPhysicalBottom,
    scrollToBottom,
    showUnreadOnBlocked,
  ]);

  useEffect(() => {
    if (!active || forceBottomDependency == null) return;
    scheduleScrollToPhysicalBottom(true);
  }, [active, forceBottomDependency, scheduleScrollToPhysicalBottom]);

  useEffect(() => {
    const target = active ? endRef.current?.parentElement : null;
    if (!target || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        if (!lockedRef.current) return;
        if (forceBottomDependency != null || preferPhysicalBottomWhenLocked) {
          scheduleScrollToPhysicalBottom(true);
          return;
        }
        scrollToBottom(true);
      });
    });
    observer.observe(target);

    return () => {
      observer.disconnect();
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [
    active,
    endRef,
    forceBottomDependency,
    preferPhysicalBottomWhenLocked,
    scheduleScrollToPhysicalBottom,
    scrollToBottom,
  ]);

  useEffect(
    () => () => {
      cancelScroll();
      cancelPhysicalBottomScroll();
    },
    [cancelPhysicalBottomScroll, cancelScroll],
  );

  return { scrollToBottom, scrollToPhysicalBottom, isNearBottom, hasUnreadMessage };
}
