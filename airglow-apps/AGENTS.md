# Rules for Coding Agents to Develop Airglow Apps

You build Airglow apps in this workspace. Each direct subdirectory with a `manifest.json` is one app.

## Bootstrap (run this at the start of EACH session)

Before any other work in this workspace, you **must**:

1. Check if `node_modules/` is missing. If so, run `pnpm install`.
2. Run `pnpm airglow dev` in the background.
   - The command is idempotent: if a dev server is already up it exits 0 immediately.
   - If the port is taken by a non-airglow process, **stop and ask the user** what to do. Never kill processes on your own. If the user chooses to change the port, you can pass `--port N` to `pnpm airglow dev`, but the matching dev-port update in the extension dashboard must be done by the user manually — ask them to do it.
   - Keep the server running for the rest of the session.

## Docs

@docs/app-developer-guide.md — manifest, each app part, runtime contract
@docs/sdk-reference.md — the `airglow.*` SDK
@docs/browser-debugging.md — dev browser, logs, CDP

## Development structure

- **One app per directory.** Each app lives in its own directory at the workspace root. `manifest.id` is an opaque stable runtime id and must be unique; `manifest.slug` is the human-readable directory/app slug and may collide. Apps shouldn't import from each other — shared code goes in `shared/`.

- **`airglow.*` SDK only.** All app code talks to the extension through the SDK. There is no `chrome.*` access.

- **Secrets in `.env`.** `CLIENT_*` keys are exposed to browser code through `airglow.storage`; unprefixed keys are server-only, available as `process.env.FOO` inside `server/*.ts`. A per-app `<app-directory>/.env` overrides the workspace one.

## Best practices

- **Test end-to-end against a real browser.** Treat untested code as not done. `pnpm chrome` launches an instrumented Chrome with CDP on `:9222`; drive it via `docs/browser-debugging.md`. If you can't test some part, notify the user at the end of your response.

- **Verify the underlying API before wiring it in.** Call it directly first — via script, `curl`, or CLI — to confirm the request and response shape. If it lives behind a server function, `curl` the RPC next. Only then exercise the full app in the browser.

- **Never hardcode secrets.** API keys, OAuth tokens, and other credentials go in `.env`. Browser code reads via `airglow.storage`; server code reads via `process.env`. If a required key is missing, the app should show a setup message — not crash. For one-off shell commands, inject `.env` vars via `env $(cat .env | grep -v '^#' | xargs) <command>` rather than pasting keys into the command line.

- **Use the shared theme.** `shared/theme/tokens.css` defines the color palette and typography that you can start with.

- **Make React UIs CDP-testable.** Put `data-testid` on every interactive element. `button.click()` works (React picks it up via root delegation), but `input.value = x` does NOT update React state — expose a `window.__test` object for inputs and selects:
  ```tsx
  useEffect(() => {
    (window as any).__test = {
      selectGroup: (id: string) => setSelectedId(id),
      runCompare: () => handleCompare(),
    };
  }, []);
  ```

- **Use Composio for third-party APIs.** Only call `@composio/core` from `server/*.ts` — its API key is server-only. Before calling an unfamiliar tool, look up its parameter schema:
  ```bash
  pnpm composio <toolkit>                # list tools
  pnpm composio <toolkit> <TOOL_SLUG>    # parameter schema for one tool
  ```

## Verify before handoff

- **Confirm the dev server is running.** Run `curl -sf http://127.0.0.1:3001/api/healthz` and verify it returns `{"ok":true,"service":"airglow-dev",...}`. 
  - If it doesn't respond, restart it with `pnpm airglow dev` in the background — the user expects the app to be loadable in the browser the moment you hand off. 
  - If server is still down, **immediately notify the user, do not report success**.
- **Confirm the manifests endpoint works.** Run `curl -sf http://127.0.0.1:3001/api/apps/manifests` and verify your app appears in the response. If it doesn't, **its a failure**.
- `manifest.json` is valid; `id` is stable and unique; every referenced file exists.
- Every `airglow.rpc('foo', ...)` has a matching default export in `server/foo.ts`.
- No API keys or tokens are hardcoded in `userscripts/` or `ui/`.
- The app has been tested in the real browser, not just through `curl`.
