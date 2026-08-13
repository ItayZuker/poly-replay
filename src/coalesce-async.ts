/**
 * Schedule `fn` so at most one run is in flight. Extra calls while it is
 * running collapse into a single follow-up with whatever state `fn` reads then.
 */
export function createCoalescer(): (fn: () => Promise<void>) => void {
  let running = false;
  let pending = false;

  return function schedule(fn: () => Promise<void>): void {
    pending = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (pending) {
          pending = false;
          await fn();
        }
      } finally {
        running = false;
        if (pending) schedule(fn);
      }
    })();
  };
}
