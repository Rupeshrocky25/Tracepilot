# TracePilot

TracePilot is a light-only, browser-based coding workspace. Open a local project, explicitly choose whether to send the current file as context, request a code proposal, and review each diff before writing it. There is no application backend. This build is a coding workspace; it does not implement the earlier incident-investigation workflow.

## Start

```sh
npm install
npm run dev
```

`npm test` runs the automated suite. `npm run build` performs TypeScript checks and creates a production build. There is no dedicated lint script configured.

## AI providers and models

Use **Providers** in the application to add credentials with a label. Credentials are held in React memory for this tab only. They are not written to localStorage, sessionStorage, IndexedDB, cookies, environment variables, analytics, or application logs. Removing a credential clears it from the active app state; closing or refreshing the tab clears all credentials. A credential/model must pass a direct connection test before chat requests can use it. Test status is in memory and is not persisted.

The default and required Nebius runtime is **Nebius Token Factory** using its OpenAI-compatible chat completions API at `https://api.tokenfactory.nebius.com/v1/chat/completions`. The app sends the user's bearer key directly from the browser. The model catalog includes `nvidia/Nemotron-3.5-Lightning`, `nvidia/Nemotron-3-Ultra-550b-a55b`, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, and `nvidia/Nemotron-3.5-Super-VL`. Availability, account permissions, limits, and exact model IDs may change; a successful test with the user's key is the app's gate before use. Nebius documents Token Factory inference as OpenAI-compatible at [Nebius inference overview](https://docs.tokenfactory.nebius.com/ai-models-inference/overview) and publishes its current NVIDIA models at [Nebius NVIDIA Nemotron inference](https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference).

The NVIDIA API Catalog is also available as a separate direct provider adapter at `https://integrate.api.nvidia.com/v1/chat/completions`. Selecting NVIDIA does not route requests through Nebius. Providers are kept distinct, and this application does not claim Nebius eligibility merely because a model is named Nemotron or is used through another provider. The Nebius adapter is a hosted Token Factory inference API, not a Nebius AI Cloud VM deployment. The NVIDIA model card for [Nemotron 3.5 Lightning weights](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16) states the model license; Nebius's model catalog identifies the separately hosted runtime model ID.

Browser calls are direct. If a provider rejects credentials, lacks CORS support, hits a rate limit, or is unavailable, the app displays the failure and recovery guidance. It never forwards credentials through a TracePilot server. No developer key or default key is included. No live provider inference was run for this repository audit because no user key was supplied; tests use mocked fetch responses and do not establish live access.

Prompts go to the selected provider after the user sends. Source content is sent only after both the include checkbox and confirmation dialog. The prompt treats source as untrusted input. Proposed changes are constrained to the exact file explicitly supplied in that request; the app displays a diff and requires explicit approval. It does not run shell commands, tests, or uploaded code. A successful browser file write is verified by reading the exact file back; that does not verify that the code is correct.

## Local files and persistence

In browsers supporting the File System Access API, the user-initiated folder picker opens a local project. File contents are read when a file is opened. The app excludes `.git`, dependency, and build folders from browsing and limits text files to 1 MB. A read-only file chooser fallback is available when folder access is unsupported. File handles remain in memory and must be reopened after refresh.

User-created project and conversation records are stored locally in IndexedDB. API keys, project file contents, directory handles, and provider test results are not persisted. No sample incidents, conversations, fake metrics, or demo records are seeded. Clearing site data deletes local conversation records.

## Scope and security

TracePilot is a coding workspace in this repository, not a finished incident-response product. It has no incident import, deterministic incident diagnostics, source-linked incident hypotheses, incident persistence, or actual test-based incident verification. It does not label AI output as a proven root cause.

See [LICENSE](./LICENSE) for the MIT license. `.env.example` intentionally contains no provider secrets or client-side key variables.
