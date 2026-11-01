import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

interface Language {
	plugin: string;
	filePath: string;
}

// Only bundled, pinned plugins can be selected by a fence's untrusted language label.
const languages: Record<string, Language> = Object.create(null);
for (const [aliases, plugin, extension] of [
	["js javascript mjs cjs", "typescript", "js"],
	["ts typescript mts cts", "typescript", "ts"],
	["jsx", "typescript", "jsx"],
	["tsx", "typescript", "tsx"],
	["json", "json", "json"],
	["jsonc", "json", "jsonc"],
	["py python python3", "ruff", "py"],
]) {
	for (const alias of aliases.split(" ")) languages[alias] = { plugin, filePath: `snippet.${extension}` };
}

export interface CodeFormatRequest {
	filePath: string;
	code: string;
	width: number;
}

export interface CodeFormatResponse {
	text: string;
}

export interface CodeFormatterOptions {
	maxCacheEntries?: number;
	maxCacheBytes?: number;
	maxWorkers?: number;
	maxPending?: number;
	maxSourceBytes?: number;
	timeoutMs?: number;
	idleMs?: number;
}

interface Task {
	key: string;
	plugin: string;
	request: CodeFormatRequest;
	promise: Promise<string>;
	resolve: (text: string) => void;
}

interface Runtime {
	worker: Worker;
	task?: Task;
	timer?: NodeJS.Timeout;
}

/** Formats display-only snippets in width buckets, with independent result and worker LRUs. */
export class CodeFormatter {
	private readonly options: Required<CodeFormatterOptions>;
	private readonly cache = new Map<string, { text: string; bytes: number }>();
	private cacheBytes = 0;
	private readonly pending = new Map<string, Task>();
	private readonly queue: Task[] = [];
	// Map order tracks the last dispatch; only idle workers can be evicted.
	private readonly runtimes = new Map<string, Runtime>();

	constructor(options: CodeFormatterOptions = {}) {
		this.options = {
			maxCacheEntries: 256,
			maxCacheBytes: 4 * 1024 * 1024,
			maxWorkers: 2,
			maxPending: 64,
			maxSourceBytes: 128 * 1024,
			timeoutMs: 5000,
			idleMs: 30000,
			...options,
		};
	}

	/** Returns cached output immediately, or one shared promise for an in-flight formatting. */
	format(code: string, language: string | undefined, availableWidth: number): string | Promise<string> {
		const label = language?.trim().toLowerCase().split(/\s+/, 1)[0];
		const target = label ? languages[label] : undefined;
		if (!target || !code || !Number.isFinite(availableWidth) || code.length * 2 > this.options.maxSourceBytes) {
			return code;
		}
		const width = Math.max(1, Math.floor(availableWidth / 8) * 8);
		const key = `${target.filePath}:${width}:${createHash("sha256").update(code).digest("hex")}`;
		// Always leave room to cache at least the fallback, avoiding an endless miss/repaint loop.
		if (2 * (key.length + code.length) > this.options.maxCacheBytes || this.options.maxCacheEntries < 1) {
			return code;
		}
		const cached = this.cache.get(key);
		if (cached) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached.text;
		}
		const pending = this.pending.get(key);
		if (pending) return pending.promise;
		if (this.pending.size >= this.options.maxPending || this.options.maxWorkers < 1) return code;

		const { promise, resolve } = Promise.withResolvers<string>();
		const task: Task = {
			key,
			plugin: target.plugin,
			request: { filePath: target.filePath, code, width },
			promise,
			resolve,
		};
		this.pending.set(key, task);
		this.queue.push(task);
		this.dispatch();
		return promise;
	}

	/** Releases workers and pending requests; cached strings remain usable after a TUI restarts. */
	dispose(): void {
		for (const [plugin, runtime] of this.runtimes) this.removeRuntime(plugin, runtime);
		this.queue.length = 0;
		for (const task of this.pending.values()) task.resolve(task.request.code);
		this.pending.clear();
	}

	private dispatch(): void {
		for (let i = 0; i < this.queue.length; ) {
			const task = this.queue[i];
			let runtime = this.runtimes.get(task.plugin);
			if (runtime?.task) {
				i++;
				continue;
			}
			if (!runtime && this.runtimes.size >= this.options.maxWorkers) {
				const idle = [...this.runtimes].find(([, candidate]) => !candidate.task);
				if (!idle) {
					i++;
					continue;
				}
				this.removeRuntime(...idle);
			}
			this.queue.splice(i, 1);
			try {
				runtime ??= this.createRuntime(task.plugin);
				clearTimeout(runtime.timer);
				runtime.task = task;
				const active = runtime;
				runtime.timer = setTimeout(() => this.failRuntime(task.plugin, active), this.options.timeoutMs);
				this.runtimes.delete(task.plugin);
				this.runtimes.set(task.plugin, runtime);
				runtime.worker.ref();
				runtime.worker.postMessage(task.request);
			} catch {
				if (runtime) this.removeRuntime(task.plugin, runtime);
				this.complete(task, task.request.code);
			}
		}
	}

	private createRuntime(plugin: string): Runtime {
		const require = createRequire(import.meta.url);
		const worker = new Worker(
			new URL(
				import.meta.url.endsWith(".ts") ? "./code-formatter-worker.ts" : "./code-formatter-worker.js",
				import.meta.url,
			),
			{
				workerData: { pluginPath: require.resolve(`@dprint/${plugin}/plugin.wasm`) },
				resourceLimits: { maxOldGenerationSizeMb: 64 },
			},
		);
		const runtime: Runtime = { worker };
		worker.on("message", (response: CodeFormatResponse) => {
			if (this.runtimes.get(plugin) !== runtime || !runtime.task) return;
			clearTimeout(runtime.timer);
			const task = runtime.task;
			runtime.task = undefined;
			this.complete(task, response.text);
			runtime.worker.unref();
			runtime.timer = setTimeout(() => this.removeRuntime(plugin, runtime), this.options.idleMs);
			runtime.timer.unref();
			this.dispatch();
		});
		worker.on("error", () => this.failRuntime(plugin, runtime));
		worker.on("exit", () => this.failRuntime(plugin, runtime));
		this.runtimes.set(plugin, runtime);
		return runtime;
	}

	private failRuntime(plugin: string, runtime: Runtime): void {
		if (this.runtimes.get(plugin) !== runtime) return;
		this.removeRuntime(plugin, runtime);
		if (runtime.task) this.complete(runtime.task, runtime.task.request.code);
		this.dispatch();
	}

	private removeRuntime(plugin: string, runtime: Runtime): void {
		if (this.runtimes.get(plugin) !== runtime) return;
		this.runtimes.delete(plugin);
		clearTimeout(runtime.timer);
		// Terminating a worker frees both its WASM instance and its compiled/module caches.
		void runtime.worker.terminate();
	}

	private complete(task: Task, output: string): void {
		let text = output;
		if (2 * (task.key.length + text.length) > this.options.maxCacheBytes) text = task.request.code;
		const bytes = 2 * (task.key.length + text.length);
		while (this.cache.size >= this.options.maxCacheEntries || this.cacheBytes + bytes > this.options.maxCacheBytes) {
			const oldest = this.cache.entries().next().value;
			if (!oldest) break;
			this.cache.delete(oldest[0]);
			this.cacheBytes -= oldest[1].bytes;
		}
		this.cache.set(task.key, { text, bytes });
		this.cacheBytes += bytes;
		this.pending.delete(task.key);
		task.resolve(text);
	}
}

export const codeFormatter = new CodeFormatter();
const renderListeners = new Set<() => void>();

/** Subscribes an active terminal renderer to async Markdown formatting updates. */
export function onCodeFormatRender(listener: () => void): () => void {
	renderListeners.add(listener);
	return () => {
		renderListeners.delete(listener);
		if (renderListeners.size === 0) codeFormatter.dispose();
	};
}

/** Requests a redraw after a Markdown component has invalidated its stale layout. */
export function requestCodeFormatRender(): void {
	for (const listener of renderListeners) listener();
}
