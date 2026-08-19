export function awaitWithAbort<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let result: PromiseLike<T> | T;
    try {
      result = operation();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }

    Promise.resolve(result).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
