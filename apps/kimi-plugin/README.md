# Plannotator for Kimi Code CLI

Interactive plan review for [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code): when the agent calls `ExitPlanMode`, this plugin opens Plannotator's visual review UI in your browser instead of the built-in approval prompt. Annotate the plan inline, approve it, or send structured feedback back to the agent.

## Prerequisites

The `plannotator` binary must be on your `PATH`:

```sh
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

Kimi Code's hook permission decisions are experimental — enable the flag either via environment variable:

```sh
export KIMI_CODE_EXPERIMENTAL_HOOK_PERMISSION_DECISIONS=1
```

or in `~/.kimi-code/config.toml`:

```toml
[experimental]
hook_permission_decisions = true
```

Without the flag, the plugin stays dormant and Kimi Code falls back to its built-in approval panel.

## Installation

In the Kimi Code TUI:

```
/plugins install <path-to-this-directory-or-GitHub-URL>
```

## Usage

1. Put Kimi Code into plan mode and let the agent draft a plan.
2. When the agent calls `ExitPlanMode`, a browser tab opens with the rendered plan.
3. Approve, or annotate passages and send feedback — the agent receives your annotations as a deny reason and revises the plan.

## Ask AI

The review UI's Ask AI panel gains a **Kimi** provider automatically when the `kimi` CLI is on your `PATH` (you already have it, since you run Kimi Code) — it wraps `kimi -p` headless mode and reuses your existing Kimi login, no API key configuration needed. Kimi-origin sessions prefer this provider; `claude`, `codex`, `pi`, and `opencode` are still detected the same way. If no supported CLI is available, the panel is hidden and everything else works unchanged.

Known limitations of the Kimi provider (inherent to `kimi -p` today):

- **Message-level streaming**: answers appear at message boundaries, not token by token.
- **No permission cards**: print mode forces auto permission mode, so tools run without Allow/Deny prompts.
- **No model selector**: the CLI's `-m` aliases can't be enumerated; the provider uses your configured default model.
- **No fork**: Ask AI can't inherit the host Kimi session's history (same as the Pi/Codex providers).
- **No cost/turn stats and no thinking display**: the stream-json output carries no such metadata.

## How it works

`kimi.plugin.json` registers a `PermissionRequest` hook matched on `ExitPlanMode`. Kimi Code pipes the hook event JSON (the plan markdown lives in `display.plan`) to `plannotator kimi-plan` on stdin; the command serves the review UI, blocks until you decide, then prints the decision on stdout:

- Approve → `{"hookSpecificOutput":{"permissionDecision":"allow"}}`
- Request changes → `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"<feedback markdown>"}}`

---

## 中文说明

前置条件：`plannotator` 二进制在 `PATH` 上（安装命令见上），并开启实验 flag（`KIMI_CODE_EXPERIMENTAL_HOOK_PERMISSION_DECISIONS=1` 或 `config.toml` 里 `[experimental] hook_permission_decisions = true`）。在 Kimi Code TUI 中用 `/plugins install <本目录路径或 GitHub URL>` 安装本插件。之后 agent 调用 `ExitPlanMode` 时会自动打开浏览器里的可视化 plan 评审界面：可以直接批准，也可以批注后打回，反馈会作为 deny 原因返回给 agent。评审界面里的 Ask AI 面板在检测到 `PATH` 上的 `kimi` CLI 时会自动出现 Kimi provider（包装 `kimi -p` headless 模式，复用已有登录态，无需配置 API key；已知限制：消息级流式、无权限卡片、无模型选择、无 fork、无费用统计）；`claude`/`codex`/`pi`/`opencode` 照旧检测，都没有时面板不显示。flag 未开启时回退到内置审批面板。
