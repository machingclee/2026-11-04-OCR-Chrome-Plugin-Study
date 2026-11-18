/**
 * Deadlines, shared by the page bundle, the offscreen document and the service
 * worker. Kept apart from the ONNX wrapper so importing it does not pull the
 * inference runtime into the worker.
 */

/** A promise that rejects with `message` when `work` has not settled in `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    // The losing promise keeps running after a deadline. Mark it as handled so a
    // late rejection is not reported as an unhandled promise in the console.
    void work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([work, limit]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}
