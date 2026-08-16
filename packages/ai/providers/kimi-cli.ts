/**
 * Kimi CLI provider — bridges Plannotator's AI layer with Kimi Code CLI's
 * headless mode.
 *
 * Each query spawns a one-shot `kimi -p "<prompt>" --output-format
 * stream-json` process and parses its JSONL stdout. Multi-turn continuation
 * passes `--session <id>` once the first run reports its session id via the
 * trailing `session.resume_hint` meta line. Print mode forces auto permission
 * mode, so runs are unattended-safe and no permission cards appear.
 *
 * Implemented with node:child_process so a single file works under Bun and
 * Node.js (the Pi extension vendors this file). The user must have the `kimi`
 * CLI installed and logged in.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	KimiCliConfig,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
	buildWindowsCommandScriptSpawnCommand,
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";

const PROVIDER_NAME = "kimi-cli";

/** Tail of stderr included in error messages when a run fails. */
const STDERR_TAIL_CHARS = 500;

// ---------------------------------------------------------------------------
// Stream-JSON line mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Map one line of `kimi -p --output-format stream-json` stdout to AIMessage[].
 *
 * Line shapes (see kimi-code `cli/prompt-render.ts`):
 *   {"role":"meta","type":"system.version",...}              — ignored
 *   {"role":"assistant","content"?:string,"tool_calls"?:[…]} — text_delta + tool_use
 *   {"role":"tool","tool_call_id":...,"content":...}         — tool_result
 *   {"role":"meta","type":"turn.step.retrying",...}          — ignored
 *   {"role":"meta","type":"session.resume_hint","session_id":...} — ignored here;
 *     the session layer captures the id itself.
 *
 * Kimi's stream-json flushes at message boundaries, so `text_delta` carries a
 * whole message, not a token-level delta.
 */
export function mapKimiStreamJsonLine(line: string): AIMessage[] {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];

	switch (parsed.role) {
		case "assistant": {
			const messages: AIMessage[] = [];
			if (typeof parsed.content === "string" && parsed.content) {
				messages.push({ type: "text_delta", delta: parsed.content });
			}
			const toolCalls = parsed.tool_calls;
			if (Array.isArray(toolCalls)) {
				for (const call of toolCalls) {
					if (!call || typeof call !== "object") continue;
					const fn = (call as Record<string, unknown>).function as
						| Record<string, unknown>
						| undefined;
					if (!fn || typeof fn.name !== "string") continue;
					let toolInput: Record<string, unknown> = {};
					if (typeof fn.arguments === "string") {
						try {
							const args = JSON.parse(fn.arguments);
							if (args && typeof args === "object" && !Array.isArray(args)) {
								toolInput = args as Record<string, unknown>;
							}
						} catch {
							// Malformed arguments JSON — pass through as raw text.
							toolInput = { arguments: fn.arguments };
						}
					}
					messages.push({
						type: "tool_use",
						toolName: fn.name,
						toolInput,
						toolUseId:
							typeof (call as Record<string, unknown>).id === "string"
								? ((call as Record<string, unknown>).id as string)
								: crypto.randomUUID(),
					});
				}
			}
			return messages;
		}

		case "tool": {
			const content = parsed.content;
			return [
				{
					type: "tool_result",
					...(typeof parsed.tool_call_id === "string" && {
						toolUseId: parsed.tool_call_id,
					}),
					result:
						typeof content === "string"
							? content
							: content == null
								? ""
								: JSON.stringify(content),
				},
			];
		}

		default:
			return [];
	}
}

/** Extract the session id from a `session.resume_hint` meta line, if any. */
function extractResumeHintSessionId(line: string): string | null {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		if (
			parsed?.role === "meta" &&
			parsed.type === "session.resume_hint" &&
			typeof parsed.session_id === "string"
		) {
			return parsed.session_id;
		}
	} catch {
		// Not JSON — no hint.
	}
	return null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class KimiCliProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: false,
		resume: true,
		streaming: true,
		tools: true,
	};
	// No models list: `kimi -m` takes user-config aliases that cannot be
	// enumerated from outside, so the UI shows no model selector.

	private config: KimiCliConfig;
	private sessions = new Map<string, KimiSession>();

	constructor(config: KimiCliConfig) {
		this.config = config;
	}

	async createSession(options: CreateSessionOptions): Promise<KimiSession> {
		const session = new KimiSession({
			preamble: buildSystemPrompt(options.context),
			cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			kimiExecutablePath: this.config.kimiExecutablePath ?? "kimi",
			model: options.model ?? this.config.model,
			resumeId: null,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(): Promise<never> {
		throw new Error(
			"Kimi CLI does not support session forking. " +
				"The endpoint layer should fall back to createSession().",
		);
	}

	async resumeSession(sessionId: string): Promise<KimiSession> {
		const session = new KimiSession({
			preamble: null,
			cwd: this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			kimiExecutablePath: this.config.kimiExecutablePath ?? "kimi",
			model: this.config.model,
			resumeId: sessionId,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			session.killProcess();
		}
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
	/** Pre-resolved CLI session id for resumed sessions. */
	resumeId: string | null;
}

class KimiSession extends BaseSession {
	private config: SessionConfig;
	private proc: ChildProcess | null = null;

	constructor(config: SessionConfig) {
		super({
			parentSessionId: config.parentSessionId,
			...(config.resumeId ? { initialId: config.resumeId } : {}),
		});
		this.config = config;
		// A resumed session's id is already the real one — mark it resolved so
		// the first query passes --session and no remap fires.
		if (config.resumeId) {
			this._resolvedId = config.resumeId;
		}
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen, signal } = started;

		try {
			const effectivePrompt = buildEffectivePrompt(
				prompt,
				this.config.preamble,
				this._firstQuerySent,
			);
			const args = ["-p", effectivePrompt, "--output-format", "stream-json"];
			if (this._resolvedId) {
				args.push("--session", this._resolvedId);
			}
			if (this.config.model) {
				args.push("-m", this.config.model);
			}

			const commandPath = resolveWindowsCommandShim(
				this.config.kimiExecutablePath,
			);
			const command =
				buildWindowsCommandScriptSpawnCommand(commandPath, args) ?? [
					commandPath,
					...args,
				];

			let proc: ChildProcess;
			try {
				const [file, ...rest] = command;
				proc = spawn(file, rest, {
					cwd: this.config.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (err) {
				yield {
					type: "error",
					error: `Failed to spawn kimi CLI: ${err instanceof Error ? err.message : String(err)}`,
					code: "kimi_spawn_error",
				};
				return;
			}
			this.proc = proc;
			this._firstQuerySent = true;

			const queue: AIMessage[] = [];
			let wake: (() => void) | null = null;
			let exitCode: number | null = null;
			let exited = false;
			let processError = false;
			const stderrChunks: Buffer[] = [];

			const push = (msg: AIMessage) => {
				queue.push(msg);
				wake?.();
			};

			let buffer = "";
			const decoder = new TextDecoder();
			proc.stdout?.on("data", (chunk: Buffer) => {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.replace(/\r$/, "");
					if (!trimmed) continue;
					const resumeId = extractResumeHintSessionId(trimmed);
					if (resumeId) this.resolveId(resumeId);
					for (const msg of mapKimiStreamJsonLine(trimmed)) {
						push(msg);
					}
				}
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});
			proc.on("error", (err) => {
				processError = true;
				push({
					type: "error",
					error: `kimi CLI process error: ${err.message}`,
					code: "kimi_process_error",
				});
			});
			proc.on("exit", (code) => {
				exitCode = code;
			});
			// 'close' (not 'exit') is the reliable wakeup: after an async spawn
			// failure (ENOENT) 'exit' may never fire, but 'close' always does.
			proc.on("close", () => {
				exited = true;
				wake?.();
			});

			try {
				while (true) {
					while (queue.length > 0) {
						yield queue.shift()!;
					}
					if (exited) break;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = null;
				}
			} finally {
				this.proc = null;
				if (proc.exitCode === null && !proc.killed) {
					if (!killWindowsProcessTree(proc.pid)) {
						proc.kill();
					}
				}
			}

			if (signal.aborted || processError) {
				return;
			}
			if (exitCode === 0) {
				yield { type: "result", sessionId: this.id, success: true };
			} else {
				const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
				const tail = stderr.slice(-STDERR_TAIL_CHARS);
				yield {
					type: "error",
					error:
						`kimi CLI exited with code ${exitCode ?? "unknown"}.` +
						(tail ? ` ${tail}` : ""),
					code: "kimi_exit_error",
				};
			}
		} catch (err) {
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
				code: "provider_error",
			};
		} finally {
			this.endQuery(gen);
		}
	}

	abort(): void {
		this.killProcess();
		super.abort();
	}

	/** Kill the in-flight query process, if any. */
	killProcess(): void {
		const proc = this.proc;
		this.proc = null;
		if (proc && proc.exitCode === null && !proc.killed) {
			if (!killWindowsProcessTree(proc.pid)) {
				proc.kill();
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new KimiCliProvider(config as KimiCliConfig),
);
