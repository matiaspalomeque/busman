# Development and validation

Busman uses React/TypeScript, a Tauri/Rust desktop bridge, and a Go Azure Service Bus worker. Keep credential ownership in Rust and broker receive/send/settlement ownership in Go.

CI pins Bun 1.3.14 and Go 1.25.13, with stable Rust (minimum declared version 1.88). Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```sh
bun install --frozen-lockfile
bun run tauri dev
```

The development command builds the worker before opening the native app. `bun run dev` alone renders the frontend and does not supply a native command bridge. Do not interpret a browser fixture as proof of broker or credential-store behavior.

Run the relevant checks before a change is considered ready:

```sh
bun run build
bun run test:frontend
bun run build-sidecar
cd src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --locked
cd worker-go
gofmt -l .
go vet ./...
go test -race ./...
```

The Go integration suite is opt-in. Leave `BUSMAN_AZURE_INTEGRATION_CONNECTION_STRING` unset during ordinary tests. See [release validation](release-validation.md) before enabling it. The shared Verify workflow additionally runs dependency audits.

`bun scripts/benchmark-message-search.ts` compares repeated body conversion against cached body searches on 5,000 synthetic messages (about 50 MiB). Report cold and warm results separately; this is a local computation benchmark, not a browser rendering or broker latency measurement.

## Source map

| Concern | Location |
|---|---|
| Native startup and command registration | `src-tauri/src/lib.rs` |
| Credentials and encrypted configuration | `src-tauri/src/store.rs` |
| Worker process, framing and pending responses | `src-tauri/src/commands/worker.rs` |
| Broker operations | `src-tauri/worker-go/handlers_*.go` |
| Operation contract and counts | `contracts/operation-outcome.json`, `operation_outcome.rs`, `operation_outcome.go`, `src/schemas/operation.ts` |
| Operation lifecycle | `src/hooks/useScript.ts`, `src/store/operationSlice.ts` |
| Bounded loaded message data | `src/store/messageSlice.ts` |
| Local journal | `src/store/operationJournal.ts` |
| Connection generation and entity counts | `src/store/appStore.ts`, `src/hooks/useEntityList.ts` |

The store remains a single Zustand store with focused operation and message slices. Use narrow subscriptions with `useShallow` for multiple fields. Async callbacks must verify their connection generation and target before changing visible data. Do not reset operation ownership when navigating to another entity.

When changing the wire contract, update all three languages and shared fixtures together. Worker protocol v2 deliberately rejects a v1 sidecar, because an older bridge could misinterpret structured failures as successful operations. Rebuild the sidecar after pulling protocol changes. Sequence numbers remain canonical decimal strings across the frontend boundary; never round them through JavaScript numbers.
