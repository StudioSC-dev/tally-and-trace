#!/usr/bin/env bash
# Posts the card installments that are due, by calling the backend job endpoint.
#
# Inputs come from the environment only (the workflow maps its secrets into
# env:, so nothing from the workflow is interpolated into this script):
#   API_URL    base URL of the backend, e.g. https://api.example.com
#   JOB_TOKEN  value for the X-Job-Token header
#   DRY_RUN    "true" or "false" (default "false")
#
# The response body is never printed on failure: the Actions logs are public.
set -euo pipefail

if [ -z "${JOB_TOKEN:-}" ]; then
  echo "JOB_TOKEN is not set" >&2
  exit 1
fi
if [ -z "${API_URL:-}" ]; then
  echo "API_URL is not set" >&2
  exit 1
fi

DRY_RUN="${DRY_RUN:-false}"
if [ "$DRY_RUN" != "true" ] && [ "$DRY_RUN" != "false" ]; then
  echo "DRY_RUN must be true or false" >&2
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# No --retry-all-errors: curl then retries only timeouts, refused connections
# (a sleeping Render instance) and 408/429/500/502/503/504, so a 401 or a 404
# fails at once.
rc=0
code="$(curl --silent --show-error --fail-with-body \
  --retry 5 --retry-connrefused --retry-delay 30 --max-time 120 \
  -o "$body" -w '%{http_code}' \
  -H "X-Job-Token: $JOB_TOKEN" \
  -X POST "$API_URL/api/v1/jobs/post-due-installments?dry_run=$DRY_RUN")" || rc=$?

if [ "$rc" -ne 0 ] || [ "$code" != "200" ]; then
  # Print the status code only, never the body.
  echo "HTTP ${code:-000}" >&2
  exit 1
fi

if ! jq -e '(.posted|type=="number") and (.skipped|type=="object")' "$body" >/dev/null; then
  echo "Unexpected response shape (HTTP $code)" >&2
  exit 1
fi

echo "posted=$(jq -r '.posted' "$body") skipped=$(jq -r '[.skipped[]] | add // 0' "$body")"
