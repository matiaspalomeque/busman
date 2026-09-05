"""Run the packaged bootstrap check with a timeout and retain its JSON evidence."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--executable", type=Path)
parser.add_argument("--report", type=Path, default=Path(tempfile.gettempdir()) / "busman-native-smoke.json")
args = parser.parse_args()
system = platform.system()
patterns = {
    "Darwin": "src-tauri/target/debug/bundle/macos/Busman.app/Contents/MacOS/busman",
    "Windows": "src-tauri/target/debug/busman.exe",
    "Linux": "src-tauri/target/debug/bundle/appimage/*.AppImage",
}
matches = [args.executable] if args.executable else list(Path.cwd().glob(patterns[system]))
if len(matches) != 1:
    raise SystemExit(f"Expected one packaged executable, found {len(matches)}")
command = [str(matches[0].resolve())]
if system == "Linux" and command[0].endswith(".AppImage"):
    command.append("--appimage-extract-and-run")
args.report = args.report.resolve()
args.report.parent.mkdir(parents=True, exist_ok=True)
if args.report.exists():
    args.report.unlink()
command += ["--smoke-test", str(args.report)]
try:
    result = subprocess.run(command, timeout=90, env=os.environ.copy(), check=False)
except subprocess.TimeoutExpired:
    raise SystemExit("Native smoke check timed out; inspect credential-store availability")
if not args.report.exists():
    raise SystemExit(f"No native smoke report was produced (exit {result.returncode})")
report = json.loads(args.report.read_text())
print(json.dumps(report, indent=2))
if result.returncode != 0 or not all(report["checks"].values()):
    raise SystemExit("Native smoke check failed")
