#!/usr/bin/env bash
# Pick the LLM behind the feeds "Summarize" button and rotate its API key.
#
# Runs on your Mac, talks to the VPS over ssh. Prompts for a model (or keeps
# the current one), then for the API key (typed blind, never echoed, never put
# on a command line), writes both into the container's env file with a backup,
# recreates the readest-client container so it picks the values up, and fires
# one tiny test summary to prove the new configuration works end to end.
#
# The app reads these at runtime (apps/readest-app/src/app/api/summarize/route.ts):
#   SUMMARY_API_KEY, SUMMARY_MODEL, SUMMARY_BASE_URL, SUMMARY_REASONING_EFFORT
#
# Usage:
#   fork-tools/summary-config.sh            # interactive
#   fork-tools/summary-config.sh --dry-run  # show what would be written, touch nothing
#
# Environment overrides (rarely needed):
#   READEST_VPS          ssh host alias            (default: hetzner)
#   READEST_COMPOSE_DIR  compose project dir       (default: /opt/readest-webdav)
#   READEST_ENV_FILE     env file inside that dir  (default: freshrss.env)
set -euo pipefail

HOST="${READEST_VPS:-hetzner}"
DIR="${READEST_COMPOSE_DIR:-/opt/readest-webdav}"
ENV_NAME="${READEST_ENV_FILE:-freshrss.env}"
ENV_FILE="$DIR/$ENV_NAME"
SERVICE="readest-client"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# `READEST_VPS=local` runs the remote half in a local shell instead of ssh —
# only for testing this script against a scratch env file.
run_remote() {
  if [[ "$HOST" == "local" ]]; then bash -s; else ssh "$HOST" bash -s; fi
}

GEMINI_URL='https://generativelanguage.googleapis.com/v1beta/openai'
OPENAI_URL='https://api.openai.com/v1'
ANTHROPIC_URL='https://api.anthropic.com/v1'

# id | provider | base url | reasoning effort ('' = none) | one-line note
# Cost/week assumes ~450 summaries/week of ~730-word, mostly Hebrew articles
# (your Sep 2026 reading volume); see the evaluation that shipped with this tool.
MODELS=(
  "gemini-3.1-flash-lite|Google|$GEMINI_URL||the current default · ~\$0.45/wk"
  "gemini-3.5-flash-lite|Google|$GEMINI_URL||drop-in successor, same class · ~\$0.60/wk"
  "gemini-3.8-flash|Google|$GEMINI_URL|low|best Flash, always reasons · ~\$2.1/wk now, ~\$4.3/wk from 2027 · NEEDS the pending 0.12.8 deploy"
  "gemini-2.5-flash-lite|Google|$GEMINI_URL||previous generation, cheapest Google · ~\$0.15/wk"
  "gpt-4.1-nano|OpenAI|$OPENAI_URL||non-reasoning · ~\$0.15/wk"
  "gpt-5-nano|OpenAI|$OPENAI_URL|minimal|reasoning model at minimal effort · ~\$0.20/wk · NEEDS the pending 0.12.8 deploy"
  "claude-haiku-4-5|Anthropic|$ANTHROPIC_URL||via Anthropic's OpenAI-compatible endpoint · ~\$1.6/wk"
)

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- current state
say "Reading current summary settings from $HOST:$ENV_FILE ..."
current=$(run_remote <<EOF
set -e
f='$ENV_FILE'
[ -r "\$f" ] || { echo "MISSING"; exit 0; }
grep -E '^SUMMARY_(MODEL|BASE_URL|REASONING_EFFORT|THINKING_HEADROOM)=' "\$f" || true
if grep -q '^SUMMARY_API_KEY=' "\$f"; then echo 'SUMMARY_API_KEY=(set)'; else echo 'SUMMARY_API_KEY=(missing)'; fi
EOF
)
[[ "$current" == "MISSING" ]] && die "$ENV_FILE not found on $HOST"
cur_model=$(printf '%s\n' "$current" | sed -n 's/^SUMMARY_MODEL=//p')
cur_url=$(printf '%s\n' "$current" | sed -n 's/^SUMMARY_BASE_URL=//p')
cur_effort=$(printf '%s\n' "$current" | sed -n 's/^SUMMARY_REASONING_EFFORT=//p')
say
say "Current:"
say "  model            ${cur_model:-gemini-3.1-flash-lite (app default, not set in the file)}"
say "  base url         ${cur_url:-$GEMINI_URL (app default)}"
say "  reasoning effort ${cur_effort:-(none)}"
say "  api key          $(printf '%s\n' "$current" | sed -n 's/^SUMMARY_API_KEY=//p')"
say

# ---------------------------------------------------------------- pick a model
say "Choose the model for article summaries:"
say "  0) keep the current model"
i=1
for m in "${MODELS[@]}"; do
  IFS='|' read -r id provider _ _ note <<<"$m"
  printf '  %d) %-22s %-10s %s\n' "$i" "$id" "$provider" "$note"
  i=$((i + 1))
done
say "  $i) other (type a model id and base URL yourself)"
other=$i
while :; do
  read -r -p "Model [0-$other]: " choice
  [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 0 && choice <= other )) && break
  say "  enter a number between 0 and $other"
done

if (( choice == 0 )); then
  new_model="$cur_model"; new_url="$cur_url"; new_effort="$cur_effort"
  provider="current"
  new_provider_url="${cur_url:-$GEMINI_URL}"
elif (( choice == other )); then
  read -r -p "Model id: " new_model
  [[ -n "$new_model" ]] || die "model id is required"
  read -r -p "Base URL (OpenAI-compatible, no trailing /chat/completions) [$GEMINI_URL]: " new_url
  new_url="${new_url:-$GEMINI_URL}"
  read -r -p "Reasoning effort (blank for a non-reasoning model, else minimal|low|medium|high): " new_effort
  provider="custom"; new_provider_url="$new_url"
else
  IFS='|' read -r new_model provider new_url new_effort _ <<<"${MODELS[$((choice - 1))]}"
  new_provider_url="$new_url"
fi

# Writing the app defaults explicitly keeps the file self-describing.
[[ -z "$new_url" ]] && new_url="$GEMINI_URL"
[[ "$provider" == "current" && -z "$new_model" ]] && new_model="gemini-3.1-flash-lite"

if [[ -n "$new_effort" ]]; then
  say
  say "Note: $new_model reasons before answering. The thinking-token headroom that keeps"
  say "such models from returning empty summaries is in the fork's branch but only"
  say "reaches the server with the pending 0.12.8 deploy (git push + /opt/rebuild.sh)."
fi

# ---------------------------------------------------------------- the key
say
if [[ "$provider" != "current" && "$new_provider_url" != "${cur_url:-$GEMINI_URL}" ]]; then
  say "$new_model is served by a different provider than the current key — a new key is required."
  key_optional=0
else
  say "Paste the new API key, or press Enter to keep the one already on the server."
  key_optional=1
fi
while :; do
  read -r -s -p "API key (typed blind): " new_key
  say
  if [[ -n "$new_key" ]]; then
    read -r -s -p "Once more to confirm: " key2
    say
    [[ "$new_key" == "$key2" ]] && break
    say "  the two entries differ — try again"
  elif (( key_optional )); then
    break
  else
    say "  a key is required for this provider"
  fi
done
unset key2
[[ "$new_key" == *[[:space:]]* ]] && die "the key contains whitespace — paste it again without line breaks"

# ---------------------------------------------------------------- summary
say
say "Will write to $HOST:$ENV_FILE:"
say "  SUMMARY_MODEL=$new_model"
say "  SUMMARY_BASE_URL=$new_url"
if [[ -n "$new_effort" ]]; then say "  SUMMARY_REASONING_EFFORT=$new_effort"; else say "  SUMMARY_REASONING_EFFORT   (removed — non-reasoning model)"; fi
if [[ -n "$new_key" ]]; then say "  SUMMARY_API_KEY=${new_key:0:4}…${new_key: -4} (${#new_key} chars)"; else say "  SUMMARY_API_KEY            (unchanged)"; fi
say "then recreate the $SERVICE container and run one test summary."
if (( DRY_RUN )); then say; say "--dry-run: nothing written."; exit 0; fi
read -r -p "Proceed? [y/N] " ok
[[ "$ok" =~ ^[Yy]$ ]] || { say "aborted, nothing changed"; exit 0; }

# ---------------------------------------------------------------- write + restart + test
# Values cross the wire base64-encoded on the remote shell's stdin: no quoting
# hazards, and the key never appears in a process list or shell history.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
run_remote <<EOF
set -euo pipefail
f='$ENV_FILE'
dec() { printf '%s' "\$1" | base64 -d; }
model=\$(dec '$(b64 "$new_model")')
url=\$(dec '$(b64 "$new_url")')
effort=\$(dec '$(b64 "$new_effort")')
key=\$(dec '$(b64 "$new_key")')

backup="\$f.bak.\$(date +%Y%m%d-%H%M%S).\$\$"
cp -p "\$f" "\$backup"
chmod 600 "\$backup"

# Rewrite: drop the managed keys, keep every other line verbatim, append the new values.
tmp=\$(mktemp "\$f.XXXXXX")
grep -vE '^SUMMARY_(MODEL|BASE_URL|REASONING_EFFORT|API_KEY)=' "\$f" > "\$tmp" || true
[ -s "\$tmp" ] && [ -n "\$(tail -c1 "\$tmp")" ] && printf '\n' >> "\$tmp"
if [ -z "\$key" ]; then
  # keep the existing key line as-is
  grep -E '^SUMMARY_API_KEY=' "\$f" >> "\$tmp" || true
else
  printf 'SUMMARY_API_KEY=%s\n' "\$key" >> "\$tmp"
fi
printf 'SUMMARY_MODEL=%s\n' "\$model" >> "\$tmp"
printf 'SUMMARY_BASE_URL=%s\n' "\$url" >> "\$tmp"
[ -n "\$effort" ] && printf 'SUMMARY_REASONING_EFFORT=%s\n' "\$effort" >> "\$tmp"
chmod --reference="\$f" "\$tmp" 2>/dev/null || chmod 600 "\$tmp"
chown --reference="\$f" "\$tmp" 2>/dev/null || true
mv -f "\$tmp" "\$f"
echo "env written (backup: \$backup)"

if [ "\${SUMMARY_SKIP_RESTART:-0}" = "1" ]; then echo "restart skipped"; exit 0; fi
cd '$DIR'
docker compose up -d --force-recreate '$SERVICE' >/dev/null 2>&1 || docker-compose up -d --force-recreate '$SERVICE'
for i in \$(seq 1 40); do
  docker exec '$SERVICE' node -e 'fetch("http://127.0.0.1:3000/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null && break
  sleep 1
done
echo "container recreated and answering after \${i}s"
docker exec '$SERVICE' node -e '
const text = Array(4).fill("The city council approved a new bicycle lane network covering twelve kilometres of downtown streets after a study found protected lanes cut cyclist injuries by a third while leaving car travel times unchanged; construction starts in spring, funded by a federal grant.").join(" ");
fetch("http://127.0.0.1:3000/api/summarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, blurb: "" }) })
  .then(async r => { const b = await r.text(); console.log("test summary -> HTTP " + r.status); console.log(b.slice(0, 300)); process.exit(r.ok ? 0 : 2); })
  .catch(e => { console.log("test summary -> request failed: " + e); process.exit(2); });
' || { echo; echo "The test summary FAILED. The env file is written; check the key/model above or restore \$backup."; exit 2; }
EOF
say
say "Done. Summaries now use $new_model."
