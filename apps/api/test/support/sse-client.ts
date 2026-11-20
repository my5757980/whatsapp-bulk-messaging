// Minimal Server-Sent Events reader for integration tests: opens a stream with fetch and parses
// frames as they arrive (id, event, data and ": comment" lines).

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

export interface SseStream {
  status: number;
  frames: SseFrame[];
  /** Resolves with the first frame (already received or future) that matches. */
  waitFor(match: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const frames: SseFrame[] = [];
  const waiters: Array<{ match: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }> = [];

  const push = (frame: SseFrame) => {
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  };

  if (res.ok && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const frame: SseFrame = {};
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) frame.comment = line.slice(1).trim();
              else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
              else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
              else if (line.startsWith('data:')) frame.data = (frame.data ? `${frame.data}\n` : '') + line.slice(5).trim();
            }
            push(frame);
          }
        }
      } catch {
        // aborted by close()
      }
    })();
  }

  return {
    status: res.status,
    frames,
    waitFor(match, timeoutMs = 5_000) {
      const hit = frames.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise<SseFrame>((resolve, reject) => {
        const waiter = { match, resolve: (f: SseFrame) => (clearTimeout(timer), resolve(f)) };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`no matching SSE frame within ${timeoutMs} ms; got ${JSON.stringify(frames.slice(-5))}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close: () => controller.abort(),
  };
}

/** Polls until the check passes (or fails after the timeout). */
export async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 5_000, everyMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
