# @braintrust/trace-pi

Braintrust tracing extension for [pi](https://github.com/mariozechner/pi-coding-agent).

This package is implemented in TypeScript, uses the official Braintrust JavaScript SDK for tracing, and is loaded directly by pi without a build step.

## What gets traced

- **Session spans**: one root span per pi session
- **Turn spans**: one span per user prompt / agent run
- **LLM spans**: one span per model response inside a turn
- **Tool spans**: one span per tool execution

Trace shape:

```text
Session (task)
├── Turn 1 (task)
│   ├── anthropic/claude-sonnet-4 (llm)
│   │   ├── read: package.json (tool)
│   │   └── bash: npm test (tool)
│   └── anthropic/claude-sonnet-4 (llm)
└── Turn 2 (task)
```

## Install

### Local development

From this repo:

```bash
pi install .
```

Or load it just for one run:

```bash
pi -e .
```

### As a package

Once published:

```bash
pi install npm:@braintrust/trace-pi
```

## Configuration

Tracing is disabled by default.

Set these environment variables:

```bash
export TRACE_TO_BRAINTRUST=true
export BRAINTRUST_API_KEY=sk-...
export BRAINTRUST_PROJECT=pi
```

Then start pi normally.

### Config file

You can also configure it with JSON:

- Global: `~/.pi/agent/braintrust.json`
- Project: `.pi/braintrust.json`

Example:

```json
{
  "trace_to_braintrust": true,
  "project": "pi",
  "debug": true,
  "additional_metadata": {
    "team": "platform"
  }
}
```

Environment variables override config files.

## Supported settings

| Config key | Env var | Default |
|---|---|---|
| `trace_to_braintrust` | `TRACE_TO_BRAINTRUST` | `false` |
| `api_key` | `BRAINTRUST_API_KEY` | unset |
| `api_url` | `BRAINTRUST_API_URL` | `https://api.braintrust.dev` |
| `app_url` | `BRAINTRUST_APP_URL` | `https://www.braintrust.dev` |
| `org_name` | `BRAINTRUST_ORG_NAME` | unset |
| `project` | `BRAINTRUST_PROJECT` | `pi` |
| `debug` | `BRAINTRUST_DEBUG` | `false` |
| `additional_metadata` | `BRAINTRUST_ADDITIONAL_METADATA` | `{}` |
| `log_file` | `BRAINTRUST_LOG_FILE` | unset |
| `state_dir` | `BRAINTRUST_STATE_DIR` | `~/.pi/agent/state/braintrust-trace-pi` |
| `parent_span_id` | `PI_PARENT_SPAN_ID` | unset |
| `root_span_id` | `PI_ROOT_SPAN_ID` | unset |

## Notes

- Project config overrides global config.
- Environment variables override both.
- Session bookkeeping is stored in `~/.pi/agent/state/braintrust-trace-pi/` by default.
- Span delivery uses the Braintrust JS SDK's built-in async/background flushing.
- If `PI_PARENT_SPAN_ID` is set, the pi session span is attached under an existing Braintrust trace.
- `PI_ROOT_SPAN_ID` can be used when the parent span is not the trace root.

## Development

This repo is set up for [Vite+](https://viteplus.dev/guide/).

Use [mise](https://mise.jdx.dev/) to install the pinned project toolchain from `mise.toml`, including `node`, `npm`, and `vite-plus` (which provides `vp`):

```bash
mise install
vp install
vp check
vp pack
npm run smoke
```

Or through package scripts:

```bash
npm run check
npm run typecheck
npm run pack
npm run smoke
```

Notes:

- `vp check` is the main formatting, linting, and type-check entrypoint.
- `npm run typecheck` now delegates to `vp check`.
- `vp pack` builds an optional library bundle in `dist/`.
- pi still loads the extension directly from `src/index.ts`, so local development does not require a build step.
