# Troubleshooting

| Symptom | Next action |
|---|---|
| Worker unavailable or protocol mismatch | Rebuild the sidecar with `bun run build-sidecar` for development, or reinstall a complete matching package. App and sidecar must both use protocol v2. |
| Count warning beside an entity | Open its actions, inspect the refresh error/time, and refresh. Last known values stay visible while marked stale. |
| Move dialog says the connection changed | Close and reopen Move from the intended connection/source. |
| Stop failed or worker updates stopped | Keep the operation context, export history, and follow [operation recovery](operations.md). Do not assume cancellation removed nothing. |
| Unknown operation blocks new work | Verify source and destination, then acknowledge review in Event Log. The journal does not automatically resend. |
| History cannot be saved | Export the current history before closing. Check available application storage; do not clear connection files to fix a journal problem. |
| Loaded-data limit reached | Export or clear the current results before browsing again. Filters affect the local view only. |
| Secure-store failure on Linux | Ensure a Secret Service provider such as GNOME Keyring or KWallet is running and unlocked in the desktop session. |
| Secure-store prompt on macOS | Verify the requesting Busman build and allow access only when expected. A native smoke run uses a separate synthetic credential entry. |
| Installer/update problem | Record OS, app version, exact failure and release asset; preserve current connection configuration and consult the candidate checklist. |

For a useful bug report, include reproduction steps, the source mode and entity type, version/platform, sanitized error text, and an exported operation journal if relevant. Remove any sensitive namespace/entity metadata before sharing it. Do not attach connection strings, access keys, or message bodies unless deliberately sanitized.
