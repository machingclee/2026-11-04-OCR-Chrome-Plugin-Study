import * as ort from 'onnxruntime-web/webgpu';
import {
    DEFAULT_INFERENCE_BACKEND,
    INFERENCE_BACKEND_KEY,
    INFERENCE_BACKENDS,
    type InferenceBackend,
} from '../shared/constants';
import { withTimeout } from '../shared/timing';
import { announceStage } from '../shared/progress';

/**
 * Bounded ONNX sessions.
 *
 * A GPU backend can fail by never settling: the promise from
 * `InferenceSession.create` or `session.run` stays pending, the caller waits
 * forever, and the page shows a spinner with no error. Every session and every
 * run therefore carries a deadline, and a missed deadline becomes an error that
 * names the model, the stage and the backend.
 *
 * The backend comes from `chrome.storage.local` (the popup's Inference device
 * menu) and defaults to WebGPU, which is the fast path; there is no extra probe
 * before the models load, because a probe that asks the GPU for a device can
 * itself be the call that stalls. A WebGPU load or run that fails or times out
 * downgrades this page to WASM, so one bad GPU is not retried for every model,
 * and the popup reports which device each model actually ran on and for how
 * long.
 */
if (ort.env?.wasm) ort.env.wasm.numThreads = 1;

/** A 94 MB model read from disk can be slow on a cold start, but not this slow. */
const LOAD_TIMEOUT_MS = 180_000;
/** One inference pass. The detector is the largest at 1024 square. */
const RUN_TIMEOUT_MS = 120_000;

const second = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

let providersPromise: Promise<string[]> | null = null;
/** The backend each live session was created on, so a run can name it. */
const sessionBackends = new WeakMap<ort.InferenceSession, string>();
/**
 * The live session per model. The map is the cache: dropping an entry makes the
 * next call load that model again, which is how a failed WebGPU run is replaced
 * by a WASM one on the same page.
 */
const sessions = new Map<string, Promise<ort.InferenceSession>>();

/**
 * One run at a time. A second session.run started while the first is still on
 * the GPU is the call that never comes back. The tail always settles, so one
 * failed run does not leave the queue stuck.
 */
let inferenceTail: Promise<void> = Promise.resolve();

function enqueueRun<T>(task: () => Promise<T>): Promise<T> {
    const run = inferenceTail.then(task);
    inferenceTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

/** What each model cost, so the popup can say which device ran it and for how long. */
export type ModelTiming = { label: string; backend: string; loadMs: number; runMs: number };
const modelTimings = new Map<string, ModelTiming>();

export function inferenceTimings(): ModelTiming[] {
    return [...modelTimings.values()].map((entry) => ({ ...entry }));
}

async function storedBackend(): Promise<InferenceBackend> {
    try {
        const stored = await chrome.storage.local.get(INFERENCE_BACKEND_KEY);
        const value = stored[INFERENCE_BACKEND_KEY];
        return INFERENCE_BACKENDS.find((backend) => backend === value) ?? DEFAULT_INFERENCE_BACKEND;
    } catch {
        // The Node harness has no chrome.storage: there is no popup setting there.
        return DEFAULT_INFERENCE_BACKEND;
    }
}

async function resolveProviders(): Promise<string[]> {
    const backend = await storedBackend();
    if (backend === 'webgpu' && typeof navigator !== 'undefined' && 'gpu' in navigator) {
        console.info('[inference] backend: webgpu (wasm fallback)');
        return ['webgpu', 'wasm'];
    }
    if (backend === 'webgpu') console.info('[inference] navigator.gpu is missing; using wasm');
    else console.info('[inference] backend: wasm');
    return ['wasm'];
}

/** The execution providers this page uses. Resolved once, then cached. */
export function currentProviders(): Promise<string[]> {
    if (!providersPromise) {
        providersPromise = resolveProviders().catch((cause) => {
            providersPromise = null;
            throw cause;
        });
    }
    return providersPromise;
}

/** Stop trying WebGPU for this page: a load or a run has failed or timed out. */
function downgradeToWasm(): void {
    providersPromise = Promise.resolve(['wasm']);
    // Every cached session was built on the old provider order. Drop them so
    // the next use of each model loads it on WASM instead of reusing a GPU
    // session that has already failed.
    sessions.clear();
}

/**
 * The session for one model, loaded on first use and shared afterwards. A load
 * that rejects is not cached, so a later pick retries instead of reusing the
 * failure.
 */
export function sessionFor(key: string, url: string, label: string): Promise<ort.InferenceSession> {
    const existing = sessions.get(key);
    if (existing) return existing;
    const created = createSession(url, label).then(
        (session) => {
            // A load that fell back to another provider clears the map while it
            // is running. Put the session back: without this, every later line
            // reloaded the model, which is minutes of work on a 76 MB file.
            sessions.set(key, Promise.resolve(session));
            return session;
        },
        (cause: unknown) => {
            sessions.delete(key);
            throw cause;
        },
    );
    sessions.set(key, created);
    return created;
}

/** Whether a model has been loaded (or is loading) in this context. */
export function hasSession(key: string): boolean {
    return sessions.has(key);
}

/**
 * Load one model as its own session, on one provider.
 *
 * WebGPU is tried alone. If that creation throws, a separate WASM session is
 * created. The two providers are never listed on the same session: a split
 * session accepts the graph and then the run does not return.
 */
export async function createSession(
    url: string,
    label: string,
    timeoutMs: number = LOAD_TIMEOUT_MS,
): Promise<ort.InferenceSession> {
    const providers = await currentProviders();
    const load = (executionProviders: string[]) => withTimeout(
        ort.InferenceSession.create(url, {
            executionProviders,
            graphOptimizationLevel: 'all',
        }),
        timeoutMs,
        `The ${label} model did not load within ${second(timeoutMs)}.`,
    );

    const started = performance.now();
    announceStage(`loading the ${label} model`);
    let session: ort.InferenceSession;
    let backend = 'wasm';
    if (providers[0] === 'webgpu') {
        try {
            session = await load(['webgpu']);
            backend = 'webgpu';
        } catch (cause) {
            console.warn(`[inference] ${label} cannot run on webgpu; using wasm.`, cause);
            session = await load(['wasm']);
            backend = 'wasm';
        }
    } else {
        session = await load(['wasm']);
    }
    sessionBackends.set(session, backend);
    const loadMs = Math.round(performance.now() - started);
    modelTimings.set(label, { label, backend, loadMs, runMs: 0 });
    console.info(`[inference] ${label} loaded in ${second(loadMs)} on ${backend}`);
    return session;
}

/**
 * One inference pass with a deadline. A timeout or any other WebGPU failure
 * downgrades the page to WASM, so the next attempt is not sent to a stuck GPU.
 */
export async function runSession(
    session: ort.InferenceSession,
    feeds: Record<string, ort.Tensor>,
    label: string,
    timeoutMs: number = RUN_TIMEOUT_MS,
    note?: string,
): Promise<Record<string, ort.Tensor>> {
    const backend = sessionBackends.get(session) ?? 'wasm';
    const suffix = note ? ` · ${note}` : '';
    const started = performance.now();
    announceStage(`${label} inference${suffix}`);
    try {
        // The queue follows session.run itself. A deadline that fired first
        // must not start the next run while this one is still on the GPU.
        const outputs = await withTimeout(
            enqueueRun(() => session.run(feeds)),
            timeoutMs,
            `${label} did not answer within ${second(timeoutMs)} (${backend}).`,
        );
        const runMs = Math.round(performance.now() - started);
        const entry = modelTimings.get(label);
        if (entry) {
            entry.runMs = runMs;
            entry.backend = backend;
        }
        // The per-call cost is the one number that separates a model on the GPU
        // from the same model on the CPU, and it is visible without devtools.
        announceStage(`${label} inference: ${runMs} ms${suffix}`);
        console.info(`[inference] ${label} ran in ${second(runMs)} on ${backend}`);
        return outputs as unknown as Record<string, ort.Tensor>;
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (backend !== 'wasm' && !message.includes('did not answer')) {
            console.warn(`[inference] ${label} failed on ${backend}; switching this page to wasm.`, cause);
            downgradeToWasm();
        }
        throw cause;
    }
}

/**
 * The popup writes the device while the offscreen document is alive, so a
 * change has to drop the resolved provider order and the sessions built on it;
 * otherwise the new setting would only apply after the next extension reload.
 */
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !(INFERENCE_BACKEND_KEY in changes)) return;
        providersPromise = null;
        sessions.clear();
        console.info('[inference] device changed; models reload on the next pass');
    });
}
