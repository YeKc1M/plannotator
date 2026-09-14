/**
 * Kimi CLI provider — drives a long-lived `kimi acp` subprocess over ACP
 * (Agent Client Protocol: newline-delimited JSON-RPC 2.0 on stdio).
 *
 * Why ACP replaces the old `kimi -p --output-format stream-json` transport:
 * print mode was one-shot per query, forced auto permission mode (no Allow/Deny
 * cards), flushed only at message boundaries, and could not enumerate models
 * or fork sessions. The ACP agent is a persistent process: turns stream
 * token-level chunks and thinking, tool calls arrive as interactive
 * `session/request_permission` requests answered through the existing
 * respondToPermission path, sessions fork/resume natively, and the model list
 * comes from `session/new`'s configOptions.
 *
 * The initialize handshake advertises NO client capabilities (no fs, no
 * terminal): the agent then does its own IO and routes every approval through
 * permission requests, which is exactly what the Ask AI UI wants.
 *
 * Implemented with node:child_process so a single file works under both the
 * Bun server and the Node (Pi) extension, which vendors this file. Requires a
 * kimi build with the `acp` subcommand; older CLIs fail the spawn/handshake
 * and the error says to upgrade.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { BaseSession } from "../base-session.ts";
import {
	buildEffectivePrompt,
	buildForkPreamble,
	buildSystemPrompt,
} from "../context.ts";
import type {
	AIMessage,
	AIPermissionRequestMessage,
	AIProvider,
	AIProviderCapabilities,
	AISession,
	CreateSessionOptions,
	KimiCliConfig,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
	buildWindowsCommandScriptSpawnCommand,
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";
import { guardChildStreams, writeChildLine } from "./child-io.ts";
import { classifyRpcMessage, type RpcMessage } from "./codex-app-server.ts";

const PROVIDER_NAME = "kimi-cli";
const KIMI_PROCESS_LABEL = "kimi acp";
/** Reject a JSON-RPC request that gets no response in this long. session/prompt
 *  is exempt (its response only arrives when the turn ends) — it passes 0. */
const RPC_TIMEOUT_MS = 30_000;
/** Model discovery must not gate the AI panel: a kimi that's installed but not
 *  logged in (or too old for `acp`) falls back fast instead of blocking
 *  /api/ai/capabilities for the full RPC timeout. */
const MODEL_DISCOVERY_TIMEOUT_MS = 6_000;
/** Kill an idle agent process after this long with no query. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
/** Grace window after the session/prompt response for trailing notifications
 *  (usage_update lands after the response on the wire). */
const TRAILING_UPDATE_GRACE_MS = 150;

type ProviderModel = {
	id: string;
	label: string;
	default?: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** A JSON-RPC error response, keeping the code/data the wire carried. */
export class AcpRpcError extends Error {
	readonly code: number | undefined;
	readonly data: unknown;

	constructor(message: string, code?: number, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

/** Translate an ACP failure into something actionable in the Ask AI UI. */
export function describeAcpError(err: unknown): string {
	if (err instanceof AcpRpcError) {
		if (err.code === -32000) {
			return "Kimi CLI is not authenticated. Run `kimi login` and try again.";
		}
		const data = err.data as RpcMessage | undefined;
		if (err.code === -32600 && data?.code === "turn.agent_busy") {
			return "Kimi is still working on a previous turn. Wait for it to finish or abort it first.";
		}
		if (err.code === -32602) {
			return "Kimi no longer recognizes this session. Start a new Ask AI conversation.";
		}
		return err.message;
	}
	return err instanceof Error ? err.message : String(err);
}

function textOf(content: unknown): string {
	if (!content || typeof content !== "object") return "";
	const text = (content as RpcMessage).text;
	return typeof text === "string" ? text : "";
}

function rawInputOf(update: RpcMessage): Record<string, unknown> {
	const raw = update.rawInput;
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {};
}

/**
 * Map the `update` payload of a `session/update` notification to AIMessages.
 * `sessionId` mirrors mapCodexAppServerEvent's signature; the kimi turn's
 * terminal result comes from the session/prompt response, not this mapper.
 */
export function mapAcpSessionUpdate(
	update: unknown,
	sessionId: string,
): AIMessage[] {
	void sessionId;
	if (!update || typeof update !== "object") return [];
	const u = update as RpcMessage;

	switch (u.sessionUpdate) {
		case "agent_message_chunk": {
			const text = textOf(u.content);
			return text ? [{ type: "text_delta", delta: text }] : [];
		}

		case "agent_thought_chunk": {
			const text = textOf(u.content);
			return text ? [{ type: "thinking_delta", delta: text }] : [];
		}

		case "tool_call": {
			const title = typeof u.title === "string" && u.title ? u.title : null;
			const kind = typeof u.kind === "string" && u.kind ? u.kind : null;
			return [
				{
					type: "tool_use",
					toolName: title ?? kind ?? "tool",
					toolInput: rawInputOf(u),
					toolUseId: typeof u.toolCallId === "string" ? u.toolCallId : "",
				},
			];
		}

		case "tool_call_update": {
			// Only terminal updates carry a result worth showing; pending /
			// in_progress duplicates what tool_call already rendered.
			const status = u.status as string | undefined;
			if (status !== "completed" && status !== "failed") return [];
			const out = u.rawOutput;
			const result =
				typeof out === "string"
					? out
					: out == null
						? ""
						: JSON.stringify(out);
			return [
				{
					type: "tool_result",
					toolUseId: typeof u.toolCallId === "string" ? u.toolCallId : "",
					result: status === "failed" ? `[Error] ${result}` : result,
				},
			];
		}

		case "usage_update": {
			return [
				{
					type: "usage",
					usedTokens: typeof u.used === "number" ? u.used : 0,
					contextSize: typeof u.size === "number" ? u.size : 0,
				},
			];
		}

		// Informational variants the Ask AI transcript doesn't render.
		case "plan":
		case "available_commands_update":
		case "config_option_update":
		case "current_mode_update":
		case "session_info_update":
		case "user_message_chunk":
			return [];

		default:
			return [{ type: "unknown", raw: u }];
	}
}

/**
 * Map an inbound `session/request_permission` request to a
 * `permission_request` AIMessage so the existing PermissionCard renders it.
 * `requestId` correlates the user's decision back to the JSON-RPC request id.
 */
export function mapAcpPermissionRequest(
	params: unknown,
	requestId: string,
): AIPermissionRequestMessage {
	const p = (params ?? {}) as RpcMessage;
	const toolCall = (p.toolCall ?? {}) as RpcMessage;
	const title =
		typeof toolCall.title === "string" && toolCall.title
			? toolCall.title
			: undefined;
	const kind =
		typeof toolCall.kind === "string" && toolCall.kind
			? toolCall.kind.replace(/_/g, " ")
			: undefined;
	return {
		type: "permission_request",
		requestId,
		toolName: title ?? kind ?? "Tool",
		toolInput: rawInputOf(toolCall),
		...(title ? { title } : {}),
		toolUseId:
			typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : requestId,
	};
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (bidirectional: responses, notifications, server requests)
// ---------------------------------------------------------------------------

type NotificationListener = (notification: {
	method: string;
	params: RpcMessage;
}) => void;
type RequestHandler = (
	method: string,
	id: string | number,
	params: RpcMessage,
) => void;

export class KimiAcpProcess {
	private proc: ChildProcess | null = null;
	private listeners: NotificationListener[] = [];
	private requestHandlers: RequestHandler[] = [];
	private pendingRequests = new Map<
		string,
		{ resolve: (data: RpcMessage) => void; reject: (err: Error) => void }
	>();
	private nextId = 0;
	private buffer = "";
	// Streaming decoder: a multi-byte UTF-8 char can split across stdout chunks;
	// decoding per-chunk with toString() would corrupt the boundary into U+FFFD.
	private decoder = new TextDecoder();
	private _alive = false;
	private startPromise: Promise<void> | null = null;

	/** Spawn + ACP initialize handshake, once. `initTimeoutMs` bounds the
	 *  initialize wait (model discovery passes a short value so it can't hang). */
	start(kimiPath: string, cwd: string, initTimeoutMs?: number): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.doStart(kimiPath, cwd, initTimeoutMs).catch(
				(err) => {
					this.startPromise = null;
					throw err;
				},
			);
		}
		return this.startPromise;
	}

	private async doStart(
		kimiPath: string,
		cwd: string,
		initTimeoutMs?: number,
	): Promise<void> {
		const commandPath = resolveWindowsCommandShim(kimiPath);
		const command = buildWindowsCommandScriptSpawnCommand(commandPath, [
			"acp",
		]) ?? [commandPath, "acp"];

		let proc: ChildProcess;
		try {
			const [file, ...args] = command;
			// stderr is "ignore", not "pipe": we never read it, and an un-drained
			// stderr pipe deadlocks the child once its buffer fills.
			proc = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.handleProcessEnd(error);
			throw error;
		}

		this.proc = proc;
		// Cover every pipe BEFORE the spawn handshake: an `error` event on a child
		// stream with no listener becomes an uncaughtException and kills the host
		// process, not just this provider (#1378).
		guardChildStreams(proc, KIMI_PROCESS_LABEL, (error) =>
			this.failProcess(error),
		);
		proc.once("exit", () => {
			this.handleProcessEnd(new Error("kimi acp exited unexpectedly"));
		});

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				proc.off("spawn", onSpawn);
				proc.off("error", onError);
			};
			const onSpawn = () => {
				cleanup();
				this._alive = true;
				this.readStream();
				resolve();
			};
			const onError = (err: Error) => {
				cleanup();
				this.handleProcessEnd(err);
				reject(err);
			};
			proc.once("spawn", onSpawn);
			proc.once("error", onError);
		});

		// ACP handshake. Advertising no clientCapabilities makes the agent fall
		// back to local IO and route questions through permission requests.
		// If initialize fails, the OS process may still be alive but is never
		// usable; kill it so `_alive` flips back and the next query re-spawns.
		try {
			await this.sendAndWait(
				{
					method: "initialize",
					params: { protocolVersion: 1, clientCapabilities: {} },
				},
				initTimeoutMs,
			);
		} catch (err) {
			this.kill();
			if (err instanceof AcpRpcError) throw err;
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(
				`${reason} — the installed kimi may predate the ACP transport; ` +
					"upgrade the Kimi Code CLI.",
			);
		}
	}

	/**
	 * A pipe to the child broke: resolve it as a provider failure and reap the
	 * child, leaving `alive` false so the next query re-spawns (#1378).
	 */
	private failProcess(error: Error): void {
		const proc = this.proc;
		this.startPromise = null;
		this.handleProcessEnd(error);
		if (proc) {
			try {
				if (!killWindowsProcessTree(proc.pid)) proc.kill();
			} catch {
				// Already gone.
			}
		}
	}

	private handleProcessEnd(error: Error): void {
		if (!this.proc && this.pendingRequests.size === 0) return;
		this._alive = false;
		this.proc = null;
		for (const [, pending] of this.pendingRequests) pending.reject(error);
		this.pendingRequests.clear();
		for (const listener of this.listeners) {
			listener({ method: "process_exited", params: {} });
		}
	}

	private readStream(): void {
		if (!this.proc?.stdout) return;
		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer += this.decoder.decode(chunk, { stream: true });
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.replace(/\r$/, "");
				if (!trimmed) continue;
				try {
					this.routeMessage(JSON.parse(trimmed));
				} catch {
					// Ignore malformed lines.
				}
			}
		});
	}

	private routeMessage(msg: RpcMessage): void {
		const classified = classifyRpcMessage(msg);
		switch (classified.kind) {
			case "response": {
				const pending = this.pendingRequests.get(String(classified.id));
				if (!pending) return;
				this.pendingRequests.delete(String(classified.id));
				if (msg.error) {
					const err = msg.error as RpcMessage;
					pending.reject(
						new AcpRpcError(
							(err.message as string) ?? "RPC error",
							err.code as number | undefined,
							err.data,
						),
					);
				} else {
					pending.resolve((msg.result as RpcMessage) ?? {});
				}
				return;
			}
			case "request": {
				for (const handler of this.requestHandlers) {
					handler(classified.method, classified.id, classified.params);
				}
				return;
			}
			case "notification": {
				for (const listener of this.listeners) {
					listener({ method: classified.method, params: classified.params });
				}
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Send a JSON-RPC message without waiting for a response.
	 *
	 * A closed or broken stdin is a provider failure, never a throw at the
	 * caller and never an unhandled stream error: both the synchronous throw
	 * and the asynchronous `error`/write-callback paths land in failProcess,
	 * which rejects anything in flight.
	 */
	send(message: RpcMessage): void {
		// The ACP SDK schema-validates incoming messages and requires the
		// jsonrpc field — without it our permission responses are dropped and
		// the server resolves the tool call as rejected.
		const error = writeChildLine(
			this.proc,
			`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
			KIMI_PROCESS_LABEL,
			(err) => this.failProcess(err),
		);
		if (error) this.failProcess(error);
	}

	/** timeoutMs <= 0 waits forever — session/prompt's response only arrives
	 *  when the whole turn ends, which no fixed timeout can bound. */
	sendAndWait(
		message: RpcMessage,
		timeoutMs = RPC_TIMEOUT_MS,
	): Promise<RpcMessage> {
		const id = ++this.nextId;
		const key = String(id);
		return new Promise((resolve, reject) => {
			// Guard against a process that's alive but unresponsive (e.g. stalled
			// on auth) — without a timer the request would hang forever.
			let timer: ReturnType<typeof setTimeout> | null = null;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					if (this.pendingRequests.delete(key)) {
						reject(
							new Error(
								`kimi acp did not respond to ${String(message.method)} in ${timeoutMs}ms`,
							),
						);
					}
				}, timeoutMs);
				(timer as { unref?: () => void }).unref?.();
			}
			this.pendingRequests.set(key, {
				resolve: (data) => {
					if (timer) clearTimeout(timer);
					resolve(data);
				},
				reject: (err) => {
					if (timer) clearTimeout(timer);
					reject(err);
				},
			});
			this.send({ ...message, id });
		});
	}

	/** Answer an inbound server request with a JSON-RPC result. */
	respond(id: string | number, result: RpcMessage): void {
		this.send({ id, result });
	}

	/** Answer an inbound server request with a JSON-RPC error. */
	respondError(id: string | number, message: string): void {
		this.send({ id, error: { code: -32601, message } });
	}

	onEvent(listener: NotificationListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	onRequest(handler: RequestHandler): () => void {
		this.requestHandlers.push(handler);
		return () => {
			const idx = this.requestHandlers.indexOf(handler);
			if (idx >= 0) this.requestHandlers.splice(idx, 1);
		};
	}

	get alive(): boolean {
		return this._alive;
	}

	kill(): void {
		this._alive = false;
		this.startPromise = null;
		const proc = this.proc;
		this.proc = null;
		if (proc) {
			if (!killWindowsProcessTree(proc.pid)) proc.kill();
		}
		this.listeners.length = 0;
		this.requestHandlers.length = 0;
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Process killed"));
		}
		this.pendingRequests.clear();
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class KimiCliProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: true,
		resume: true,
		streaming: true,
		tools: true,
	};
	// Empty until fetchModels() populates it from session/new's configOptions;
	// the UI hides the model picker while the list is empty.
	models: ProviderModel[] = [];

	private config: KimiCliConfig;
	private sessions = new Set<KimiSession>();
	private modelsLoaded = false;

	constructor(config: KimiCliConfig) {
		this.config = config;
	}

	/**
	 * Populate `models` from `session/new`'s `model` config option — kimi's real
	 * model list. Spawns a throwaway agent (like the Codex provider's
	 * fetchModels). Keeps the empty fallback on any failure.
	 */
	async fetchModels(): Promise<void> {
		if (this.modelsLoaded) return;
		const proc = new KimiAcpProcess();
		try {
			await proc.start(
				this.config.kimiExecutablePath ?? "kimi",
				this.config.cwd ?? process.cwd(),
				MODEL_DISCOVERY_TIMEOUT_MS,
			);
			const res = await proc.sendAndWait(
				{
					method: "session/new",
					params: { cwd: this.config.cwd ?? process.cwd(), mcpServers: [] },
				},
				MODEL_DISCOVERY_TIMEOUT_MS,
			);
			const configOptions = (res.configOptions as RpcMessage[] | undefined) ?? [];
			const modelOption = configOptions.find((o) => o.id === "model");
			const models: ProviderModel[] = (
				((modelOption?.options as RpcMessage[] | undefined) ?? [])
			)
				.filter((o) => typeof o.value === "string")
				.map((o) => ({
					id: o.value as string,
					label: (o.name as string) || (o.value as string),
					...(o.value === modelOption?.currentValue
						? { default: true as const }
						: {}),
				}));
			if (models.length) this.models = models;
			this.modelsLoaded = true;
		} catch {
			// Keep the empty fallback list.
		} finally {
			proc.kill();
		}
	}

	async createSession(options: CreateSessionOptions): Promise<AISession> {
		const session = new KimiSession({
			preamble: buildSystemPrompt(options.context),
			cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			kimiExecutablePath: this.config.kimiExecutablePath ?? "kimi",
			model: options.model ?? this.config.model,
			resumeId: null,
			forkFromId: null,
			onClosed: (s) => this.sessions.delete(s),
		});
		this.sessions.add(session);
		return session;
	}

	async forkSession(options: CreateSessionOptions): Promise<AISession> {
		const parent = options.context.parent;
		if (!parent) {
			throw new Error(
				"Cannot fork: no parent session provided in context. " +
					"Use createSession() for standalone sessions.",
			);
		}
		const session = new KimiSession({
			preamble: buildForkPreamble(options.context),
			cwd: parent.cwd ?? options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: parent.sessionId,
			kimiExecutablePath: this.config.kimiExecutablePath ?? "kimi",
			model: options.model ?? this.config.model,
			resumeId: null,
			forkFromId: parent.sessionId,
			onClosed: (s) => this.sessions.delete(s),
		});
		this.sessions.add(session);
		return session;
	}

	async resumeSession(sessionId: string): Promise<AISession> {
		const session = new KimiSession({
			preamble: null, // resumed session already carries its context
			cwd: this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			kimiExecutablePath: this.config.kimiExecutablePath ?? "kimi",
			model: this.config.model,
			resumeId: sessionId,
			forkFromId: null,
			onClosed: (s) => this.sessions.delete(s),
		});
		this.sessions.add(session);
		return session;
	}

	dispose(): void {
		for (const session of this.sessions) session.dispose();
		this.sessions.clear();
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
	/** Prepended to the first query; null for resumed sessions. */
	preamble: string | null;
	cwd: string;
	parentSessionId: string | null;
	kimiExecutablePath: string;
	model?: string;
	/** Pre-resolved agent session id for resumed sessions. */
	resumeId: string | null;
	/** Agent session id to `session/fork` from on first start. */
	forkFromId: string | null;
	onClosed: (session: KimiSession) => void;
}

class KimiSession extends BaseSession {
	private config: SessionConfig;
	private process: KimiAcpProcess | null = null;
	private sessionStarted = false;
	/**
	 * The session id used on the wire. Usually equal to the client-facing `id`,
	 * but decoupled so a resume/fork failure can fall back to a fresh session
	 * without breaking the client's session id.
	 */
	private liveSessionId: string | null = null;
	/** requestId → inbound JSON-RPC request id awaiting a decision. */
	private pendingApprovals = new Map<string, string | number>();
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: SessionConfig) {
		super({
			parentSessionId: config.parentSessionId,
			...(config.resumeId ? { initialId: config.resumeId } : {}),
		});
		this.config = config;
		if (config.resumeId) this._resolvedId = config.resumeId;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen, signal } = started;
		this.clearIdleTimer();

		try {
			yield* this.runTurn(prompt, gen, signal);
		} catch (err) {
			yield {
				type: "error",
				error: describeAcpError(err),
				code: "provider_error",
			};
		} finally {
			this.endQuery(gen);
			this.scheduleIdleTimer();
		}
	}

	private async *runTurn(
		prompt: string,
		gen: number,
		signal: AbortSignal,
	): AsyncIterable<AIMessage> {
		try {
			await this.ensureSession();
		} catch (err) {
			yield {
				type: "error",
				error: describeAcpError(err),
				code: "kimi_startup_error",
			};
			return;
		}
		// Aborted during startup — bail before prompting so kimi doesn't run a
		// turn in the background.
		if (signal.aborted) return;

		const proc = this.process;
		const wireSessionId = this.liveSessionId;
		if (!proc || !proc.alive || !wireSessionId) {
			yield {
				type: "error",
				error:
					"kimi acp exited during startup. Check that kimi is installed, " +
					"recent enough to provide `kimi acp`, and authenticated (`kimi login`).",
				code: "kimi_startup_error",
			};
			return;
		}

		const effectivePrompt = buildEffectivePrompt(
			prompt,
			this.config.preamble,
			this._firstQuerySent,
		);

		const queue: AIMessage[] = [];
		let resolve: (() => void) | null = null;
		let done = false;
		const push = (msg: AIMessage) => {
			queue.push(msg);
			resolve?.();
		};
		const finish = () => {
			done = true;
			resolve?.();
		};

		// Generation guard: once a newer query starts (or this one is aborted and
		// superseded), this turn's listeners must not push to its queue, end the
		// wrong turn, or mutate shared session state.
		const isCurrent = () => this._queryGen === gen;

		let sawExit = false;
		const unsubEvents = proc.onEvent((notif) => {
			if (!isCurrent()) return;
			if (notif.method === "session/update") {
				const sid = notif.params.sessionId as string | undefined;
				if (sid && sid !== wireSessionId) return;
				for (const msg of mapAcpSessionUpdate(notif.params.update, this.id)) {
					push(msg);
				}
				return;
			}
			if (notif.method === "process_exited") {
				sawExit = true;
				push({
					type: "error",
					error: "kimi acp process exited unexpectedly.",
					code: "provider_error",
				});
				finish();
			}
		});
		const unsubRequests = proc.onRequest((method, id, params) => {
			if (method !== "session/request_permission") {
				proc.respondError(id, `Unsupported request: ${method}`);
				return;
			}
			// Cancel approvals from a superseded generation or another session
			// instead of surfacing them to this UI.
			const sid = params.sessionId as string | undefined;
			if (!isCurrent() || (sid && sid !== wireSessionId)) {
				proc.respond(id, { outcome: { outcome: "cancelled" } });
				return;
			}
			const requestId = String(id);
			this.pendingApprovals.set(requestId, id);
			push(mapAcpPermissionRequest(params, requestId));
		});

		// End the drain loop promptly on abort instead of waiting for the prompt
		// response (which may never arrive if startup was interrupted).
		const onAbort = () => finish();
		signal.addEventListener("abort", onAbort);

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (trailTimer) clearTimeout(trailTimer);
			unsubEvents();
			unsubRequests();
			// Only the current turn owns the shared session state; a superseded
			// turn must not wipe the live turn's approvals.
			if (isCurrent()) {
				this.pendingApprovals.clear();
			}
		};

		// The prompt response ends the turn, so it must race the drain loop
		// rather than be awaited before it — awaiting first would buffer the
		// whole turn and streaming would be lost.
		let stopReason: string | null = null;
		let promptError: unknown = null;
		// usage_update / session_info_update trail the prompt response on the
		// wire (verified against kimi 0.42.0), so give them a short grace window
		// instead of ending the turn the moment the response lands.
		let trailTimer: ReturnType<typeof setTimeout> | null = null;
		proc
			.sendAndWait(
				{
					method: "session/prompt",
					params: {
						sessionId: wireSessionId,
						prompt: [{ type: "text", text: effectivePrompt }],
					},
				},
				0,
			)
			.then(
				(res) => {
					stopReason = (res.stopReason as string) ?? "end_turn";
					trailTimer = setTimeout(finish, TRAILING_UPDATE_GRACE_MS);
					trailTimer.unref?.();
				},
				(err) => {
					promptError = err;
					finish();
				},
			);
		this._firstQuerySent = true;

		// Aborted while the prompt request was being sent — cancel the turn
		// instead of streaming output the user cancelled.
		if (signal.aborted) {
			this.cancelActiveTurn();
			cleanup();
			return;
		}

		try {
			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise<void>((r) => {
						resolve = r;
					});
					resolve = null;
				}
			}
		} finally {
			cleanup();
		}

		if (signal.aborted) return;
		// process_exited already reported the failure; don't pile a second
		// error (the rejected prompt request) on top of it.
		if (promptError) {
			if (!sawExit) {
				yield {
					type: "error",
					error: describeAcpError(promptError),
					code: "kimi_prompt_error",
				};
			}
			return;
		}
		if (stopReason === "refusal") {
			yield {
				type: "error",
				error: "Kimi refused to answer this prompt.",
				code: "kimi_refusal",
			};
			return;
		}
		yield { type: "result", sessionId: this.id, success: true };
	}

	/** Ensure a live process + an active agent session (new, fork, or resume). */
	private async ensureSession(): Promise<void> {
		if (this.process?.alive && this.sessionStarted) return;

		if (!this.process || !this.process.alive) {
			this.process = new KimiAcpProcess();
			await this.process.start(this.config.kimiExecutablePath, this.config.cwd);
			this.sessionStarted = false;
		}
		if (this.sessionStarted) return;

		if (this.config.forkFromId && !this.liveSessionId) {
			try {
				const res = await this.process.sendAndWait({
					method: "session/fork",
					params: { sessionId: this.config.forkFromId, cwd: this.config.cwd, mcpServers: [] },
				});
				const forked = res.sessionId as string | undefined;
				if (!forked) throw new Error("session/fork returned no session id");
				this.resolveId(forked);
				this.liveSessionId = forked;
				this.config.forkFromId = null;
			} catch {
				// The parent session is unavailable — start a fresh session on the
				// wire (history is lost, but the chat keeps working).
				await this.startFreshSession();
			}
		} else {
			const resumeTarget = this.liveSessionId ?? this._resolvedId;
			if (resumeTarget) {
				// Resume an existing session (explicit resume, or after an idle
				// restart). resume reattaches without replaying history.
				try {
					await this.process.sendAndWait({
						method: "session/resume",
						params: { sessionId: resumeTarget, cwd: this.config.cwd },
					});
					this.liveSessionId = resumeTarget;
				} catch {
					// The stored session is unavailable — start a fresh session on the
					// wire but keep the client-facing session id stable.
					await this.startFreshSession();
				}
			} else {
				await this.startFreshSession();
			}
		}

		if (this.config.model && this.liveSessionId) {
			await this.process
				.sendAndWait({
					method: "session/set_config_option",
					params: {
						sessionId: this.liveSessionId,
						configId: "model",
						value: this.config.model,
					},
				})
				.catch(() => {});
		}
		this.sessionStarted = true;
	}

	private async startFreshSession(): Promise<void> {
		const res = await this.process!.sendAndWait({
			method: "session/new",
			params: { cwd: this.config.cwd, mcpServers: [] },
		});
		const sessionId = res.sessionId as string | undefined;
		if (!sessionId) throw new Error("kimi acp returned no session id");
		if (this._resolvedId) {
			this.liveSessionId = sessionId;
		} else {
			this.resolveId(sessionId);
			this.liveSessionId = sessionId;
		}
	}

	respondToPermission(requestId: string, allow: boolean): void {
		const id = this.pendingApprovals.get(requestId);
		if (id === undefined || !this.process) return;
		this.pendingApprovals.delete(requestId);
		this.process.respond(id, {
			outcome: {
				outcome: "selected",
				optionId: allow ? "approve_once" : "reject",
			},
		});
	}

	/** Tell kimi to cancel the in-flight turn (no-op if none is running). */
	private cancelActiveTurn(): void {
		const sessionId = this.liveSessionId ?? this._resolvedId;
		if (this.process?.alive && sessionId) {
			this.process.send({
				method: "session/cancel",
				params: { sessionId },
			});
		}
	}

	abort(): void {
		// Tear down the turn cleanly: cancel outstanding approvals so kimi
		// doesn't hang, cancel the active turn, keep the process alive.
		if (this.process) {
			for (const [, id] of this.pendingApprovals) {
				this.process.respond(id, { outcome: { outcome: "cancelled" } });
			}
			this.pendingApprovals.clear();
			this.cancelActiveTurn();
		}
		super.abort();
	}

	/** Kill the process and release the session (idle timeout, evict, dispose). */
	dispose(): void {
		this.clearIdleTimer();
		this.process?.kill();
		this.process = null;
		this.sessionStarted = false;
		this.pendingApprovals.clear();
		this.config.onClosed(this);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private scheduleIdleTimer(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			// Kill the idle process but keep the session resumable: the next query
			// re-spawns and `session/resume`s the persisted session id.
			this.process?.kill();
			this.process = null;
			this.sessionStarted = false;
		}, IDLE_TIMEOUT_MS);
		// Don't keep the event loop alive solely for the idle timer.
		(this.idleTimer as { unref?: () => void })?.unref?.();
	}
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new KimiCliProvider(config as KimiCliConfig),
);
