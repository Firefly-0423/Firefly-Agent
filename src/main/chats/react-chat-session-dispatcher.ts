/** Last requested session wins while the React chat document is loading. */
export interface ReactChatSessionDispatcher {
  markLoading(): void; markReady(): string | null;
  queueOrTake(sessionId: string): string | null;
  reset(): void; isReady(): boolean; getPending(): string | null;
}

export function createReactChatSessionDispatcher(): ReactChatSessionDispatcher {
  let available = false;
  let waitingSession: string | null = null;
  const takeWaiting = (): string | null => {
    const delivery = waitingSession;
    waitingSession = null;
    return delivery;
  };
  const becomeReady = (): string | null => {
    available = true;
    return takeWaiting();
  };
  const acceptSession = (sessionId: string): string | null => {
    if (available) return sessionId;
    waitingSession = sessionId;
    return null;
  };
  return {
    markLoading() { available = false; },
    markReady: becomeReady,
    queueOrTake: acceptSession,
    reset() { available = false; waitingSession = null; },
    isReady() { return available; },
    getPending() { return waitingSession; },
  };
}