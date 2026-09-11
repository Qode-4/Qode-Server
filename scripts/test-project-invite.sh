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

if ! command -v rg >/dev/null 2>&1; then
  echo "rg is required"
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:3000}"
NOOP_LOG_FILE="${NOOP_LOG_FILE:-/tmp/qode-server.log}"

OWNER_EMAIL="${OWNER_EMAIL:-owner@test.com}"
OWNER_PASSWORD="${OWNER_PASSWORD:-123456}"
OWNER_NAME="${OWNER_NAME:-Owner}"

INVITEE_EMAIL="${INVITEE_EMAIL:-member@test.com}"
INVITEE_PASSWORD="${INVITEE_PASSWORD:-123456}"
INVITEE_NAME="${INVITEE_NAME:-Member}"

PROJECT_ID="${PROJECT_ID:-}"
PROJECT_NAME="${PROJECT_NAME:-Invite Test Project $(date +%s)}"

AUTO_SIGNUP="${AUTO_SIGNUP:-true}"
TOKEN_WAIT_SEC="${TOKEN_WAIT_SEC:-10}"

login() {
  local email="$1"
  local password="$2"
  curl -s -X POST "$BASE_URL/auth/login" \
    -H "content-type: application/json" \
    -d "{
      \"email\":\"$email\",
      \"password\":\"$password\"
    }"
}

signup_if_needed() {
  local email="$1"
  local password="$2"
  local name="$3"
  if [[ "$AUTO_SIGNUP" != "true" ]]; then
    return 0
  fi
  curl -s -X POST "$BASE_URL/auth/signup" \
    -H "content-type: application/json" \
    -d "{
      \"email\":\"$email\",
      \"password\":\"$password\",
      \"name\":\"$name\"
    }" >/dev/null || true
}

echo "[1/8] OWNER login"
OWNER_LOGIN_JSON="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
OWNER_TOKEN="$(echo "$OWNER_LOGIN_JSON" | jq -r '.token // empty')"
if [[ -z "$OWNER_TOKEN" ]]; then
  signup_if_needed "$OWNER_EMAIL" "$OWNER_PASSWORD" "$OWNER_NAME"
  OWNER_LOGIN_JSON="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
  OWNER_TOKEN="$(echo "$OWNER_LOGIN_JSON" | jq -r '.token // empty')"
fi
if [[ -z "$OWNER_TOKEN" ]]; then
  echo "OWNER login failed:"
  echo "$OWNER_LOGIN_JSON" | jq
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "[2/8] Create project"
  PROJECT_JSON="$(
    curl -s -X POST "$BASE_URL/api/projects" \
      -H "authorization: Bearer $OWNER_TOKEN" \
      -H "content-type: application/json" \
      -d "{
        \"name\":\"$PROJECT_NAME\",
        \"description\":\"invite flow test\"
      }"
  )"
  PROJECT_ID="$(echo "$PROJECT_JSON" | jq -r '.data.id // empty')"
  if [[ -z "$PROJECT_ID" ]]; then
    echo "Project creation failed:"
    echo "$PROJECT_JSON" | jq
    exit 1
  fi
else
  echo "[2/8] Reuse project: $PROJECT_ID"
fi

echo "[3/8] Create invitation"
INVITE_JSON="$(
  curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/invitations" \
    -H "authorization: Bearer $OWNER_TOKEN" \
    -H "content-type: application/json" \
    -d "{
      \"email\":\"$INVITEE_EMAIL\"
    }"
)"
INVITATION_ID="$(echo "$INVITE_JSON" | jq -r '.data.invitationId // empty')"
if [[ -z "$INVITATION_ID" ]]; then
  echo "Invitation creation failed:"
  echo "$INVITE_JSON" | jq
  exit 1
fi
echo "Invitation ID: $INVITATION_ID"

echo "[4/8] Extract invite token from noop mail log"
INVITE_TOKEN=""
for _ in $(seq 1 "$TOKEN_WAIT_SEC"); do
  if [[ -f "$NOOP_LOG_FILE" ]]; then
    INVITE_TOKEN="$(
      rg -o '\[NOOP_MAIL_PROJECT_INVITE\] \{.*\}' "$NOOP_LOG_FILE" \
      | tail -n 1 \
      | sed 's/^\[NOOP_MAIL_PROJECT_INVITE\] //' \
      | jq -r '.inviteToken // empty'
    )"
  fi

  if [[ -n "$INVITE_TOKEN" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$INVITE_TOKEN" ]]; then
  echo "Failed to extract invite token from $NOOP_LOG_FILE"
  echo "Run server with: pnpm dev | tee $NOOP_LOG_FILE"
  exit 1
fi
echo "Invite token extracted"

echo "[5/8] Get invitation public info"
INVITE_PUBLIC_JSON="$(curl -s "$BASE_URL/api/project-invitations/$INVITE_TOKEN")"
if ! echo "$INVITE_PUBLIC_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "Invitation public info failed:"
  echo "$INVITE_PUBLIC_JSON" | jq
  exit 1
fi

echo "[6/8] INVITEE login"
INVITEE_LOGIN_JSON="$(login "$INVITEE_EMAIL" "$INVITEE_PASSWORD")"
INVITEE_TOKEN="$(echo "$INVITEE_LOGIN_JSON" | jq -r '.token // empty')"
if [[ -z "$INVITEE_TOKEN" ]]; then
  signup_if_needed "$INVITEE_EMAIL" "$INVITEE_PASSWORD" "$INVITEE_NAME"
  INVITEE_LOGIN_JSON="$(login "$INVITEE_EMAIL" "$INVITEE_PASSWORD")"
  INVITEE_TOKEN="$(echo "$INVITEE_LOGIN_JSON" | jq -r '.token // empty')"
fi
if [[ -z "$INVITEE_TOKEN" ]]; then
  echo "INVITEE login failed:"
  echo "$INVITEE_LOGIN_JSON" | jq
  exit 1
fi

echo "[7/8] Accept invitation"
ACCEPT_JSON="$(
  curl -s -X POST "$BASE_URL/api/project-invitations/$INVITE_TOKEN/accept" \
    -H "authorization: Bearer $INVITEE_TOKEN" \
    -H "content-type: application/json" \
    -d '{}'
)"
if ! echo "$ACCEPT_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "Invitation accept failed:"
  echo "$ACCEPT_JSON" | jq
  exit 1
fi

echo "[8/8] Verify project member list includes invitee"
MEMBERS_JSON="$(
  curl -s "$BASE_URL/api/projects/$PROJECT_ID/members" \
    -H "authorization: Bearer $OWNER_TOKEN"
)"
if ! echo "$MEMBERS_JSON" | jq -e --arg email_name "$INVITEE_NAME" '.ok == true and (.data | length >= 2)' >/dev/null 2>&1; then
  echo "Members verification failed:"
  echo "$MEMBERS_JSON" | jq
  exit 1
fi

echo
echo "Invite flow test completed."
echo "BASE_URL=$BASE_URL"
echo "PROJECT_ID=$PROJECT_ID"
echo "INVITATION_ID=$INVITATION_ID"
echo "INVITE_TOKEN=$INVITE_TOKEN"
