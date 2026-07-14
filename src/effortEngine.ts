import { TFile, type App } from "obsidian";
import { CHUNK_NS, chunkNote } from "./shared/engine/chunk.mjs";
import { EngineRpcError, ERROR_CODES } from "./shared/engine/protocol.mjs";
import type { EngineHost } from "./shared/engine/EngineHost";

/**
 * Effort Index's side of the engine contract (DESIGN 6.2).
 *
 * THIS CLASS DOES NOT OWN A PROCESS. It talks to whatever `EngineBroker` handed the plugin —
 * the same `EngineHost` object Prior Art and Standing Questions are holding. Spawning a second
 * sidecar because a third add-on also wanted embeddings is the exact failure the broker exists
 * to prevent: five ONNX runtimes, five copies of the index, five Defender scans, one uninstall.
 * There is no `new EngineHost` anywhere in this repo outside the vendored broker.
 *
 * The namespace is `notes` — the same one Prior Art writes — and the chunker is the VENDORED
 * `chunkNote`, byte-checked against obsidian-plugin-core by `sync-shared --check`. That is not
 * housekeeping: chunk keys are content hashes, so two add-ons that chunk identically SHARE the
 * embeddings (the sidecar skips a chunk whose key it already holds), and two that do not
 * quietly build two incoherent halves of one index. Nothing errors. It just stops finding things.
 *
 * Every method degrades to a benign value when the engine is absent, so no caller has to
 * remember to check three separate things — but "benign" here never means "an empty result that
 * reads like a finding". The callers in effortAnalysis.ts turn absence into a sentence.
 */

export interface EngineHit {
	key: string;
	note: string;
	ord: number;
	score: number;
	heading: string;
	preview: string;
}

interface QueryResponse {
	results?: Array<{ i: number; hits?: EngineHit[] }>;
}

export interface QueryOptions {
	k: number;
	minScore: number;
	exclude?: string[];
}

/** See `probeReuse`. "We could not ask" and "nothing matched" are different answers. */
export type ReuseResult =
	| { ok: true; best: EngineHit | null }
	| { ok: false; reason: "no-chunks" | "engine"; message: string };

export class EffortEngineIndex {
	private opened = false;
	private openPromise: Promise<void> | null = null;
	private lastError: string | undefined;

	/**
	 * The JSON-RPC ids of requests the engine is working on RIGHT NOW.
	 *
	 * This is the whole cancel story. `EngineHost.request()` hands the id back synchronously,
	 * before the frame is written to stdin (`onRequestId`), so an id exists from the instant the
	 * request does. When a run is superseded — the user re-ran the analysis, switched tab, or the
	 * view closed — `cancelInflight()` sends a `cancel` frame for every one of them (DESIGN 6.2,
	 * method 8). Without it, a superseded orphan scan keeps embedding and scanning inside the
	 * sidecar to completion, burning a core to compute an answer that will be thrown away — and
	 * an orphan scan is one query PER EXPENSIVE NOTE, so it is the expensive kind of wasted.
	 */
	private readonly inflight = new Set<number>();

	constructor(
		private readonly app: App,
		private readonly getHost: () => EngineHost | null
	) {}

	/** The last engine failure, for the degradation line. Cleared by a success. */
	get error(): string | undefined {
		return this.lastError;
	}

	/** True when the engine is up and this vault's index is open. */
	get ready(): boolean {
		const host = this.getHost();
		return this.opened && host !== null && host.isAlive();
	}

	/** Forget what we believe the engine holds. Called when it is removed, replaced or updated. */
	reset(): void {
		this.opened = false;
		this.openPromise = null;
		this.inflight.clear();
	}

	/**
	 * Start the engine (only if one is INSTALLED — this never downloads) and bind it to this
	 * vault's index. Idempotent and concurrency-safe: two analyses started in the same tick share
	 * one open, not two.
	 */
	async ensureOpen(): Promise<boolean> {
		const host = this.getHost();
		if (!host) return false;
		if (this.opened && host.isAlive()) return true;
		this.opened = false;
		if (!this.openPromise) {
			this.openPromise = this.open(host).finally(() => {
				this.openPromise = null;
			});
		}
		try {
			await this.openPromise;
			return this.opened;
		} catch {
			return false;
		}
	}

	private async open(host: EngineHost): Promise<void> {
		const health = await host.ensureStarted();
		if (!health) {
			throw new EngineRpcError(ERROR_CODES.UNSUPPORTED, "The semantic engine is not installed.");
		}
		// `dim` comes from the RUNNING engine, not from our pinned constant: the fallback model is
		// 256-dim where the default is 384, and the sidecar refuses `open` outright when the index
		// on disk was built by a different model (DESIGN 6.5). Surface its refusal; do not pre-empt it.
		await host.request("open", { vaultKey: host.vaultKey(), dim: health.dim });
		this.opened = true;
		this.lastError = undefined;
	}

	/**
	 * One request, with its id registered for cancellation for exactly as long as it is in flight.
	 * Every RPC in this class goes through here — an id that is not tracked is an id that cannot
	 * be cancelled, which is how the cancel path silently rotted in a sibling add-on.
	 */
	private async send<T>(method: string, params: unknown): Promise<T> {
		const host = this.getHost();
		if (!host) throw new EngineRpcError(ERROR_CODES.UNSUPPORTED, "The semantic engine is not available.");
		let id: number | null = null;
		try {
			return await host.request<T>(method, params, {
				onRequestId: (requestId) => {
					id = requestId;
					this.inflight.add(requestId);
				},
			});
		} finally {
			if (id !== null) this.inflight.delete(id);
		}
	}

	/**
	 * Kill every request the engine is still working on for us. Safe to call at any time,
	 * including when nothing is in flight and when there is no engine.
	 */
	cancelInflight(): void {
		const host = this.getHost();
		if (!host) {
			this.inflight.clear();
			return;
		}
		for (const id of [...this.inflight]) void host.cancel(id);
		this.inflight.clear();
	}

	/** How many requests are open right now. Diagnostics and tests. */
	inflightCount(): number {
		return this.inflight.size;
	}

	/* ------------------------------------------------------------------ index */

	/**
	 * Embed one note. Chunks the sidecar already holds are skipped without re-embedding, so
	 * re-indexing a vault Prior Art has already indexed costs a round trip per note and no model
	 * time at all — that is the payoff for chunking identically.
	 */
	async upsert(file: TFile): Promise<boolean> {
		if (!(await this.ensureOpen())) return false;
		try {
			const markdown = await this.app.vault.cachedRead(file);
			const chunks = chunkNote(markdown);
			if (chunks.length === 0) {
				await this.remove([file.path]);
				return false;
			}
			await this.send("upsert", {
				ns: CHUNK_NS.NOTES,
				note: file.path,
				mtime: file.stat.mtime,
				chunks,
			});
			this.lastError = undefined;
			return true;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}

	async remove(paths: string[]): Promise<void> {
		if (!this.ready || paths.length === 0) return;
		try {
			await this.send("delete", { ns: CHUNK_NS.NOTES, notes: paths });
		} catch (error) {
			this.fail(error);
		}
	}

	/** Metadata only — chunk keys are content hashes, so a rename moves no vectors. */
	async rename(from: string, to: string): Promise<void> {
		if (!this.ready) return;
		try {
			await this.send("rename", { ns: CHUNK_NS.NOTES, from, to });
		} catch (error) {
			this.fail(error);
		}
	}

	/**
	 * Index (or re-index) the whole vault, one note at a time.
	 *
	 * SERIAL ON PURPOSE. The sidecar embeds on one thread; pipelining N notes into it would not
	 * make it finish sooner, it would only make the progress line and the stop button lie about
	 * what is still queued. `shouldStop` is checked between notes, so a cancelled index leaves a
	 * partial — which is fine, because the next run diffs against what the sidecar already holds.
	 */
	async indexVault(
		onProgress: (done: number, total: number) => void,
		shouldStop: () => boolean = () => false
	): Promise<{ done: number; total: number; stopped: boolean }> {
		if (!(await this.ensureOpen())) {
			throw new EngineRpcError(ERROR_CODES.UNSUPPORTED, this.lastError ?? "The semantic engine is not running.");
		}
		const files = this.app.vault.getMarkdownFiles();
		let done = 0;
		for (const file of files) {
			if (shouldStop()) return { done, total: files.length, stopped: true };
			await this.upsert(file);
			done += 1;
			onProgress(done, files.length);
		}
		return { done, total: files.length, stopped: false };
	}

	/* ------------------------------------------------------------------ query */

	/**
	 * The note's own chunks, queried against the REST of the vault (`exclude: [self]`).
	 *
	 * THE RETURN TYPE IS A DISCRIMINATED UNION AND THAT IS THE WHOLE POINT. Three outcomes look
	 * identical if you flatten them, and conflating any two of them puts a false accusation in
	 * front of the user:
	 *
	 *   { ok: true, best: hit }  — the vault's closest thing to this note. Real evidence.
	 *   { ok: true, best: null } — the engine answered, and NOTHING in the vault resembles it.
	 *                              That is a similarity of zero, and it is a finding.
	 *   { ok: false, ... }       — we could not ask (no chunks, engine died, superseded). That is
	 *                              NOT a similarity of zero. A note we failed to look at must never
	 *                              be reported as "nobody ever reused this".
	 *
	 * `minScore: 0` for the same reason. Everywhere else in the suite a floor is a filter; here it
	 * would be a lie — the question is "what is the BEST thing out there?", and a floor of 0.45
	 * would return nothing for exactly the notes we are hunting and make them indistinguishable
	 * from the ones we never managed to probe.
	 */
	async probeReuse(file: TFile, k: number): Promise<ReuseResult> {
		if (!(await this.ensureOpen())) {
			return { ok: false, reason: "engine", message: this.lastError ?? "The semantic engine is not running." };
		}
		try {
			const markdown = await this.app.vault.cachedRead(file);
			const chunks = chunkNote(markdown);
			if (chunks.length === 0) {
				return { ok: false, reason: "no-chunks", message: "The note has no indexable text." };
			}

			const response = await this.send<QueryResponse>("query", {
				ns: CHUNK_NS.NOTES,
				texts: chunks.map((chunk) => chunk.text),
				k,
				minScore: 0,
				exclude: [file.path],
			});
			this.lastError = undefined;

			// The note's similarity to the vault is its BEST chunk's best hit: one paragraph picked
			// up elsewhere is enough for the idea to have travelled.
			let best: EngineHit | null = null;
			for (const result of response?.results ?? []) {
				for (const hit of result?.hits ?? []) {
					if (hit.note === file.path) continue; // belt and braces; the engine already excluded it
					if (!best || hit.score > best.score) best = hit;
				}
			}
			return { ok: true, best };
		} catch (error) {
			this.fail(error);
			return {
				ok: false,
				reason: "engine",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * The nearest notes to this one, for clustering. `undefined` (not `[]`) when the engine could
	 * not answer, so the caller can tell a failed probe from a genuinely isolated note.
	 */
	async neighbours(file: TFile, options: QueryOptions): Promise<EngineHit[] | undefined> {
		if (!(await this.ensureOpen())) return undefined;
		try {
			const markdown = await this.app.vault.cachedRead(file);
			const chunks = chunkNote(markdown);
			if (chunks.length === 0) return [];

			const response = await this.send<QueryResponse>("query", {
				ns: CHUNK_NS.NOTES,
				texts: chunks.map((chunk) => chunk.text),
				k: options.k,
				minScore: options.minScore,
				exclude: options.exclude ?? [file.path],
			});
			this.lastError = undefined;

			// N chunks in, N hit-lists out; fold them into the best score per neighbouring NOTE.
			const best = new Map<string, EngineHit>();
			for (const result of response?.results ?? []) {
				for (const hit of result?.hits ?? []) {
					if (hit.note === file.path) continue;
					const prior = best.get(hit.note);
					if (!prior || hit.score > prior.score) best.set(hit.note, hit);
				}
			}
			return [...best.values()].sort((a, b) => b.score - a.score);
		} catch (error) {
			this.fail(error);
			return undefined;
		}
	}

	/**
	 * The engine went away (killed, crashed, quarantined) — the next call reopens it.
	 *
	 * A CANCELLED request is not a failure and must not be recorded as one: we superseded it on
	 * purpose, and painting "Superseded." into the settings tab as the engine's last error would
	 * be both wrong and alarming.
	 */
	private fail(error: unknown): void {
		const code = error instanceof EngineRpcError ? error.code : "";
		if (code === ERROR_CODES.CANCELLED) return;
		if (code === ERROR_CODES.IO_ERROR || code === ERROR_CODES.UNSUPPORTED || code === ERROR_CODES.NOT_OPEN) {
			this.opened = false;
		}
		this.lastError = error instanceof Error ? error.message : String(error);
	}
}

/** Narrow a vault entry to a markdown file. The vault hands back folders and attachments too. */
export function isMarkdown(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
