# dsh-change-control

A minimal DSH plugin that registers narrow Change tools via the portable `@deepseek-ai/dsh-tools` contract.

## Contract

**Tool-registration API:** `@deepseek-ai/dsh-tools` (published by DeepSeek AI, scoped under `@deepseek-ai`).

- **Ownership:** `@deepseek-ai/dsh-tools` is the official DeepSeek Harness tool registry; versioning and API stability are owned by the DSH project.
- **Version:** `^0.1.1-rc.2` (peer-compatible with `@deepseek-ai/cordis@^4.0.1`).
- **Host injection:** The plugin consumes `ctx.tools.register(tool)` via Cordis `inject: ['tools']`. No absolute filesystem paths are used.

## Installation

```bash
npm install
npm test
```

On a supported DSH installation, `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` resolve from npm registry or the host's shared `node_modules`.

## What this plugin does

- Registers narrow Change tools (`change_get`, `change_submit_plan`, `change_submit_proof`, `change_submit_review`, `change_submit_repair`) through the real `@deepseek-ai/dsh-tools` `defineTool` API.
- Delegates authorization to `ChangeService` and persistence to `ChangeStore`.
- Derives identity from `exec.agent.id` — never accepts session/agent IDs from payload.

## What this plugin does not change

- Change domain states, authorization rules, persistence semantics, or model-facing tool behavior beyond dependency startup/registration.
