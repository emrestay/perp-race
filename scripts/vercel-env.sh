#!/bin/bash
# Copies the stored credentials from the macOS Keychain (service "perp-race") into the linked Vercel
# project. Values are never printed and never written to a file. Each value is handed to the Vercel CLI
# as an argument, so it is visible to this user's own processes for an instant, nothing more.
#   bash scripts/vercel-env.sh            -> Preview environment (default)
#   bash scripts/vercel-env.sh production -> Production environment
cd "$(dirname "$0")/.." || exit 1
TARGET="${1:-preview}"
# The Vercel CLI lives under nvm, which a plain bash script does not load. Find it and put its folder
# (which also holds node) on PATH.
if ! command -v vercel >/dev/null 2>&1; then
  VC=$(ls "$HOME"/.nvm/versions/node/*/bin/vercel 2>/dev/null | tail -1)
  [ -n "$VC" ] && export PATH="$(dirname "$VC"):$PATH"
fi
command -v vercel >/dev/null 2>&1 || { echo "Vercel CLI not found. Install it with: npm i -g vercel"; exit 1; }
vercel whoami >/dev/null 2>&1 || { echo "Vercel CLI is not logged in. Run: vercel login"; exit 1; }
for n in DREAMDEX_KEY HL_AGENT_KEY ARCUS_API_SECRET ARCUS_ADDRESS ARCUS_ACCOUNT_INDEX LIGHTER_API_PRIVATE_KEY LIGHTER_ACCOUNT_INDEX LIGHTER_API_KEY_INDEX ASTER_SIGNER_KEY RISEX_ACCOUNT RISEX_SIGNER_KEY PERPL_API_KEY PERPL_API_KEY_SECRET; do
  v=$(security find-generic-password -s perp-race -a "$n" -w 2>/dev/null) || { echo "skip    $n (not in Keychain)"; continue; }
  vercel env rm "$n" "$TARGET" --yes >/dev/null 2>&1
  # Preview needs an explicit empty Git branch argument, which means "all preview branches".
  if [ "$TARGET" = "preview" ]; then out=$(vercel env add "$n" preview "" --value "$v" --yes 2>&1); rc=$?
  else out=$(vercel env add "$n" "$TARGET" --value "$v" --yes 2>&1); rc=$?; fi
  if [ $rc -eq 0 ]; then echo "added   $n"
  else echo "FAILED  $n (exit $rc)"; printf '%s\n' "${out//$v/[value hidden]}" | tail -6 | sed 's/^/        /'; fi
done
echo "done. Names now on Vercel ($TARGET):"
vercel env ls "$TARGET" 2>/dev/null | awk '$1 ~ /^(DREAMDEX|HL_|ARCUS|LIGHTER|ASTER|RISEX|PERPL)/ {print "  " $1 "  " $2}'
