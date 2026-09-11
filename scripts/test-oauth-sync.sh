#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:3000}"
EMAIL="${EMAIL:-owner@test.com}"
PASSWORD="${PASSWORD:-123456}"
NAME="${NAME:-Owner}"
OWNER="${OWNER:-your-org}"
REPO="${REPO:-your-repo}"
BRANCH="${BRANCH:-main}"
FLOW_TIMEOUT_SEC="${FLOW_TIMEOUT_SEC:-180}"
FLOW_POLL_INTERVAL_SEC="${FLOW_POLL_INTERVAL_SEC:-5}"
AUTO_SIGNUP="${AUTO_SIGNUP:-true}"

echo "[1/8] Login (and optional signup)"

login() {
  curl -s -X POST "$BASE_URL/auth/login" \
    -H "content-type: application/json" \
    -d "{
      \"email\":\"$EMAIL\",
      \"password\":\"$PASSWORD\"
    }"
}

LOGIN_JSON="$(login)"
ACCESS_TOKEN="$(echo "$LOGIN_JSON" | jq -r '.token // empty')"

if [[ -z "$ACCESS_TOKEN" && "$AUTO_SIGNUP" == "true" ]]; then
  curl -s -X POST "$BASE_URL/auth/signup" \
    -H "content-type: application/json" \
    -d "{
      \"email\":\"$EMAIL\",
      \"password\":\"$PASSWORD\",
      \"name\":\"$NAME\"
    }" >/dev/null || true
  LOGIN_JSON="$(login)"
  ACCESS_TOKEN="$(echo "$LOGIN_JSON" | jq -r '.token // empty')"
fi

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Failed to login. Response:"
  echo "$LOGIN_JSON" | jq
  exit 1
fi

echo "[2/8] Start GitHub device flow"
FLOW_JSON="$(
  curl -s -X POST "$BASE_URL/api/github/oauth/device/start" \
    -H "authorization: Bearer $ACCESS_TOKEN"
)"
FLOW_ID="$(echo "$FLOW_JSON" | jq -r '.data.flowId // empty')"
USER_CODE="$(echo "$FLOW_JSON" | jq -r '.data.userCode // empty')"
VERIFY_URL="$(echo "$FLOW_JSON" | jq -r '.data.verificationUriComplete // .data.verificationUri // empty')"

if [[ -z "$FLOW_ID" || -z "$VERIFY_URL" || -z "$USER_CODE" ]]; then
  echo "Failed to start device flow. Response:"
  echo "$FLOW_JSON" | jq
  exit 1
fi

echo "Flow ID: $FLOW_ID"
echo "User Code: $USER_CODE"
echo "Open and approve GitHub OAuth:"
echo "  $VERIFY_URL"
echo "If GitHub asks for a code, enter: $USER_CODE"

echo "[3/8] Poll flow status until authorized (timeout: ${FLOW_TIMEOUT_SEC}s)"
START_TS="$(date +%s)"
FLOW_STATUS=""
while true; do
  FLOW_STATUS_JSON="$(
    curl -s "$BASE_URL/api/github/oauth/device/flows/$FLOW_ID" \
      -H "authorization: Bearer $ACCESS_TOKEN"
  )"
  FLOW_STATUS="$(echo "$FLOW_STATUS_JSON" | jq -r '.data.status // empty')"
  if [[ "$FLOW_STATUS" == "authorized" ]]; then
    break
  fi
  NOW_TS="$(date +%s)"
  ELAPSED="$((NOW_TS - START_TS))"
  if (( ELAPSED >= FLOW_TIMEOUT_SEC )); then
    echo "Flow authorization timeout. Last response:"
    echo "$FLOW_STATUS_JSON" | jq
    exit 1
  fi
  echo "Current flow status: ${FLOW_STATUS:-unknown} (elapsed ${ELAPSED}s)"
  sleep "$FLOW_POLL_INTERVAL_SEC"
done

echo "[4/8] Optional repo list check"
REPOS_JSON="$(
  curl -s "$BASE_URL/api/github/oauth/repos?flowId=$FLOW_ID" \
    -H "authorization: Bearer $ACCESS_TOKEN"
)"
if ! echo "$REPOS_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "Repo list failed:"
  echo "$REPOS_JSON" | jq
  exit 1
fi
echo "Repo list OK"

echo "[5/8] Create project with git payload"
PROJECT_JSON="$(
  curl -s -X POST "$BASE_URL/api/projects" \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    -H "content-type: application/json" \
    -d "{
      \"name\":\"OAuth Sync Project $(date +%s)\",
      \"description\":\"device flow test\",
      \"git\":{
        \"provider\":\"github_oauth\",
        \"flowId\":\"$FLOW_ID\",
        \"owner\":\"$OWNER\",
        \"repo\":\"$REPO\",
        \"defaultBranch\":\"$BRANCH\"
      }
    }"
)"

PROJECT_ID="$(echo "$PROJECT_JSON" | jq -r '.data.id // empty')"
JOB_ID="$(echo "$PROJECT_JSON" | jq -r '.data.syncJob.id // empty')"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Project creation failed:"
  echo "$PROJECT_JSON" | jq
  exit 1
fi

echo "Project ID: $PROJECT_ID"
if [[ -n "$JOB_ID" ]]; then
  echo "Initial Sync Job ID: $JOB_ID"
fi

echo "[6/8] Poll latest sync status"
while true; do
  STATUS_JSON="$(
    curl -s "$BASE_URL/api/projects/$PROJECT_ID/sync/status" \
      -H "authorization: Bearer $ACCESS_TOKEN"
  )"
  STATUS="$(echo "$STATUS_JSON" | jq -r '.data.status // empty')"
  echo "Current status: $STATUS"
  if [[ "$STATUS" == "done" ]]; then
    break
  fi
  if [[ "$STATUS" == "failed" ]]; then
    echo "Sync failed:"
    echo "$STATUS_JSON" | jq
    exit 1
  fi
  sleep 5
done

echo "[7/8] Trigger manual resync"
RESYNC_JSON="$(
  curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/sync" \
    -H "authorization: Bearer $ACCESS_TOKEN"
)"
RESYNC_JOB_ID="$(echo "$RESYNC_JSON" | jq -r '.data.id // empty')"
if [[ -z "$RESYNC_JOB_ID" ]]; then
  echo "Manual resync trigger failed:"
  echo "$RESYNC_JSON" | jq
  exit 1
fi
echo "Manual resync job: $RESYNC_JOB_ID"

echo "[8/8] Fetch resync job detail"
JOB_JSON="$(
  curl -s "$BASE_URL/api/projects/$PROJECT_ID/sync-jobs/$RESYNC_JOB_ID" \
    -H "authorization: Bearer $ACCESS_TOKEN"
)"
echo "$JOB_JSON" | jq

echo
echo "All done."
echo "BASE_URL=$BASE_URL"
echo "PROJECT_ID=$PROJECT_ID"
echo "FLOW_ID=$FLOW_ID"
echo "USER_CODE=$USER_CODE"
echo "RESYNC_JOB_ID=$RESYNC_JOB_ID"
