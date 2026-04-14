#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
prompt_file="$repo_root/docs/powershell-demo-smoke-prompt.txt"
helper="/home/choza/projects/scripts/pi-kitty-smoke.sh"
title="pi-lens-powershell-demo-sandbox"
out_dir=""
turn_timeout=300
quit_after=0
keep_dpi_shim=0
created_dpi_shim=0
existing_dpi=0
cleanup_artifact=""
tool_result_artifact=""

usage() {
	cat <<'EOF'
pi-lens-powershell-demo-smoke.sh - launch a Kitty Pi smoke session that demonstrates PowerShell support

Usage:
  pi-lens-powershell-demo-smoke.sh [options]

Options:
  --out-dir DIR         Artifact directory for Kitty/session/demo artifacts
  --turn-timeout SEC    Prompt turn timeout in seconds (default: 300)
  --quit-after          Close Pi after capturing the demo turn
  --keep-dpi-shim       Keep the temporary ~/.local/bin/dpi shim if this script creates it
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--out-dir)
			out_dir="$2"
			shift 2
			;;
		--turn-timeout)
			turn_timeout="$2"
			shift 2
			;;
		--quit-after)
			quit_after=1
			shift
			;;
		--keep-dpi-shim)
			keep_dpi_shim=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if [[ ! -f "$prompt_file" ]]; then
	echo "Prompt file not found: $prompt_file" >&2
	exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
	echo "pi CLI not found in PATH" >&2
	exit 1
fi

if [[ -z "$out_dir" ]]; then
	out_dir=$(mktemp -d "/tmp/pi-lens-powershell-demo-script-XXXXXX")
else
	mkdir -p "$out_dir"
fi
cleanup_artifact="$out_dir/summary.txt"
tool_result_artifact="$out_dir/powershell-demo-tool-result.txt"

mkdir -p "$HOME/.local/bin"
if [[ -e "$HOME/.local/bin/dpi" ]]; then
	existing_dpi=1
else
	ln -s "$(command -v pi)" "$HOME/.local/bin/dpi"
	created_dpi_shim=1
fi

cleanup() {
	if [[ "$created_dpi_shim" -eq 1 && "$keep_dpi_shim" -ne 1 ]]; then
		rm -f "$HOME/.local/bin/dpi"
	fi
	if [[ -n "$cleanup_artifact" ]]; then
		{
			echo "prompt_file=$prompt_file"
			echo "dpi_shim_created=$created_dpi_shim"
			echo "dpi_preexisted=$existing_dpi"
			echo "dpi_cleanup_performed=$(( created_dpi_shim == 1 && keep_dpi_shim == 0 ? 1 : 0 ))"
			if [[ -n "$tool_result_artifact" ]]; then
				echo "tool_result_artifact=$tool_result_artifact"
			fi
		} >> "$cleanup_artifact"
	fi
}
trap cleanup EXIT

phrase=$(cat "$prompt_file")
cmd=(
	"$helper"
	--cwd "$repo_root"
	--title "$title"
	--tools "read,grep,find,ls,write,edit,bash"
	--turn-timeout "$turn_timeout"
	--phrase "$phrase"
)

if [[ "$quit_after" -eq 1 ]]; then
	cmd+=(--quit-after)
fi

cmd+=(--out-dir "$out_dir")

"${cmd[@]}"

python3 - "$out_dir/sessions" "$tool_result_artifact" <<'PY'
import json
import sys
from pathlib import Path

session_dir = Path(sys.argv[1])
out_path = Path(sys.argv[2])
if not session_dir.exists():
    raise SystemExit(f"session dir not found: {session_dir}")

jsonl_files = sorted(session_dir.glob("*.jsonl"))
if not jsonl_files:
    raise SystemExit(f"no Pi session logs found in {session_dir}")

call_targets = {}
latest_text = None
for path in jsonl_files:
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            event = json.loads(line)
            if event.get("type") != "message":
                continue
            message = event.get("message", {})
            role = message.get("role")
            if role == "assistant":
                for item in message.get("content", []):
                    if item.get("type") != "toolCall":
                        continue
                    arguments = item.get("arguments") or {}
                    if item.get("name") == "write" and arguments.get("path") == "smoke-powershell-demo.ps1":
                        call_targets[item.get("id")] = True
            elif role == "toolResult":
                if not call_targets.get(message.get("toolCallId")):
                    continue
                parts = []
                for item in message.get("content", []):
                    if item.get("type") == "text":
                        parts.append(item.get("text", ""))
                joined = "\n".join(part for part in parts if part)
                if joined.strip():
                    latest_text = joined.strip()

if not latest_text:
    raise SystemExit("could not find toolResult text for smoke-powershell-demo.ps1")

out_path.write_text(latest_text + "\n", encoding="utf-8")
PY

printf '\nAuthoritative tool result artifact: %s\n\n' "$tool_result_artifact"
cat "$tool_result_artifact"
