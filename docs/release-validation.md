# Release validation

The release workflow waits for Verify and Packaged native smoke, builds into a draft release, then publishes the release and update channel after all build/signature checks pass. Editing these workflows does not configure repository secrets or run a release.

## Dedicated Azure environment

Create a GitHub environment named `azure-integration` with required reviewers and access restricted to trusted release branches. Configure:

- Secret `BUSMAN_AZURE_INTEGRATION_CONNECTION_STRING`: a management-capable connection to a dedicated disposable test namespace.
- Environment variable `BUSMAN_AZURE_INTEGRATION_EXPECTED_NAMESPACE`: the exact intended namespace name or fully qualified host.

Manually dispatch **Azure integration (isolated namespace)** and explicitly select the input authorizing creation/deletion of temporary test resources. No scheduled or pull-request run receives these credentials. A missing secret or expected namespace fails setup; a namespace mismatch fails before test fixtures are created. Runs are serialized rather than cancelling a run during cleanup.

The existing suite exercises queue/subscription browsing, DLQ moves, sessions, duplicate detection, and affinity. The workflow retains JSON test evidence and lists passed, failed, and skipped scenarios against the commit SHA. Inspect capability skips; a skipped partitioning scenario is not a passing partitioning test. Tests clean up temporary resources on normal completion. After infrastructure termination or runner failure, inspect the namespace for abandoned test resources before the next run.

## Native smoke checks

**Packaged native smoke** runs on macOS, Windows, and Linux. It builds a debug candidate and starts its native bootstrap with `--smoke-test <report.json>`. macOS uses the `.app`, Windows uses the packaged portable executable, and Linux uses the AppImage. Linux creates a temporary desktop/secret-service session on the runner.

The smoke entrypoint opens no application webview or saved connection. It checks the native runtime, bundled worker handshake, an isolated synthetic secure-store round trip (cleaned up afterward), and updater configuration. Its application identifier and credential service are `com.busman.smoke`; it does not use the user's connection configuration or master-key entry.

Locally, after building a debug bundle:

```sh
python3 scripts/run-native-smoke.py --report /tmp/busman-native-smoke.json
```

This is not proof of installer behavior, WebView rendering, Gatekeeper trust, or download/install/relaunch of an update. Those remain release-candidate checks. [Tauri WebDriver support differs by platform](https://v2.tauri.app/develop/tests/webdriver/); frontend fixture tests and native bootstrap checks cover different boundaries.

## Apple signing and notarization

Set repository variable `MACOS_SIGNING_ENABLED=true` only after configuring these secrets:

| Secret | Content |
|---|---|
| `APPLE_CERTIFICATE` | Base64 export of the Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Export password |
| `APPLE_SIGNING_IDENTITY` | Exact Developer ID Application identity |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID |

With signing enabled, missing values fail the macOS job. The workflow passes them to Tauri and validates the signature, stapled notarization ticket, and Gatekeeper assessment before the draft can be published. With the variable absent/false, the existing unsigned distribution path remains available; do not describe those artifacts as notarized. Updater signing keys are separate from Apple signing credentials. See the [official Tauri signing configuration](https://v2.tauri.app/distribute/sign/macos/).

## Candidate checklist

- Verify succeeds for the exact candidate commit, including dependency audits.
- Native smoke evidence is present for every supported platform.
- Run the isolated broker workflow against that commit; review failures and capability skips.
- On clean supported systems, install and open the candidate, inspect body/failure views, exercise keyboard navigation, and confirm the sidecar starts.
- For signed macOS distribution, verify download quarantine/Gatekeeper behavior on a separate machine.
- Exercise an update from the previous released build, including signature verification, download, install, relaunch, connection availability, and recovery journal. Test portable Windows separately.
- Check the release assets and updater manifest agree on version, platform, URL, and signature before announcing the release.

Account credentials, hosted workflow results, live broker tests, cross-platform installation, and actual update installation cannot be inferred from local unit tests. Record missing evidence explicitly.
