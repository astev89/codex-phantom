export type TimeoutFetchOptions = RequestInit & {
  timeoutMs: number;
};

export async function fetchWithTimeout(url: string, options: TimeoutFetchOptions): Promise<Response> {
  const { timeoutMs, signal, ...requestInit } = options;
  const controller = new AbortController();
  const combinedSignal = signal ? anySignal([signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...requestInit,
      signal: combinedSignal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  const abort = (signal: AbortSignal): void => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(signal.reason ?? new Error("Request aborted"));
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}
