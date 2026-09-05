# Busman product roadmap

Updated September 2026. The runtime is React + Tauri/Rust + a Go Azure Service Bus worker.

## Available capabilities

Connection testing and environment tags; encrypted connection import/export; entity creation/deletion; favorites; subscription rules; message templates; count auto-refresh and trends; DLQ threshold notifications; session-aware message operations; metadata-only operation history; Body/Properties/Failure inspection; copy/find/expand; bounded loaded data; structured partial outcomes and cancellation observation.

Count auto-refresh does not automatically re-browse message bodies. Message exports do not imply message import support. The journal does not implement exactly-once transfers or automatic resume.

## Release prerequisites

Use [release validation](release-validation.md) to configure the isolated Azure test environment, run native candidate checks, configure Apple signing/notarization credentials, and verify installation and update behavior. Source configuration alone is not release evidence.

## Future opportunities, ordered by observed demand

1. Import exported messages with validation and an explicit destination/metadata preview.
2. Saved investigations and configurable columns.
3. Multiple namespace tabs after extending state isolation per workspace.
4. Microsoft Entra authentication and permission-aware actions.
5. Additional payload formats and advanced search where real examples justify them.

Implement one validated workflow at a time. Keep the current technology stack and extend the existing worker protocol rather than introducing a second broker transport.
