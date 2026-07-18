#!/usr/bin/env bash
# ==============================================================================
# deploy.sh — Build, push, TSS-sync, and xctl-deploy the harness agent.
#
# Usage:
#   ./deploy/agent/deploy.sh @tatanbotter09
#   ./deploy/agent/deploy.sh @tatanbotter09 --skip-build
#   ./deploy/agent/deploy.sh @tatanbotter09 --tag 20260715-abc
#
# Needs:
#   ~/.xchat/accounts/<handle>/{credentials.env,agent-config.json}
#   env: XAI_API_KEY, XCHAT_PIN  (or harness .env)
#   tools: docker|buildah, xctl, kubectl, tss, git
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
XCHAT_ROOT="${XCHAT_ROOT:-$(cd "$REPO_ROOT/../x-chat" 2>/dev/null && pwd || true)}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 @<handle> [--tag <tag>] [--skip-build] [--datacenter atla] [--namespace \$USER]"
  exit 1
fi

HANDLE="${1#@}"
shift
TAG=""
SKIP_BUILD=0
DATACENTER="atla"
NAMESPACE="${USER}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --datacenter) DATACENTER="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done

# Load harness .env for XAI / PIN / optional tokens
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

REGISTRY="docker-releases-local.artifactory.twitter.biz"
IMAGE_REPO="${REGISTRY}/users/${USER}/xchat-agent-harness"
SAFE_HANDLE="$(echo "$HANDLE" | tr '_' '-')"
WORKLOAD="xchat-agent-${SAFE_HANDLE}"
ACCOUNT_DIR="${HOME}/.xchat/accounts/${HANDLE}"
TSS_MATERIAL="xchat-agent/${HANDLE}/env"
TSS_DESTINATION="${TSS_DESTINATION:-compute-atla}"
TSS_ADMIN_GROUP="${TSS_ADMIN_GROUP:-xchat-admins}"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

image_exists() {
  local ref="$1"
  if command -v docker >/dev/null; then
    docker manifest inspect "$ref" >/dev/null 2>&1 && return 0 || return 1
  fi
  return 2
}

if [ -z "$TAG" ] && [ "$SKIP_BUILD" -eq 1 ]; then
  EXISTING_STS="$(kubectl get sts -n "$NAMESPACE" -o name 2>/dev/null \
    | grep -E "/${WORKLOAD}(--|$)" | head -1 | sed 's|statefulset.apps/||' || true)"
  [ -n "$EXISTING_STS" ] || fail "--skip-build but no sts ${WORKLOAD}* in ns ${NAMESPACE}; pass --tag"
  CURRENT_IMAGE="$(kubectl get sts "$EXISTING_STS" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="main")].image}' 2>/dev/null || true)"
  TAG="${CURRENT_IMAGE##*:}"
  [ -n "$TAG" ] && [ "$TAG" != "$CURRENT_IMAGE" ] || fail "could not parse tag from $CURRENT_IMAGE"
  say "reusing deployed tag: $TAG"
fi

if [ -z "$TAG" ]; then
  TAG="$(date +%Y%m%d-%H%M%S)-$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
fi
IMAGE="${IMAGE_REPO}:${TAG}"

say "deploy ${WORKLOAD} handle=@${HANDLE} ns=${NAMESPACE} dc=${DATACENTER} image=${IMAGE}"

[ -d "$ACCOUNT_DIR" ] || fail "missing $ACCOUNT_DIR — login with xchat-cli first"
[ -f "$ACCOUNT_DIR/credentials.env" ] || fail "missing credentials.env"
[ -f "$ACCOUNT_DIR/agent-config.json" ] || fail "missing agent-config.json"
[ -n "${XAI_API_KEY:-}" ] || fail "XAI_API_KEY not set (export or put in harness .env)"
[ -n "${XCHAT_PIN:-}" ] || fail "XCHAT_PIN not set (export or put in harness .env)"
command -v xctl >/dev/null || fail "xctl not in PATH"
command -v kubectl >/dev/null || fail "kubectl not in PATH"
command -v tss >/dev/null || fail "tss not in PATH"
[ -n "${XCHAT_ROOT:-}" ] && [ -d "$XCHAT_ROOT/packages/xchat-sdk" ] \
  || fail "XCHAT_ROOT must point at x-chat checkout with packages/xchat-sdk (got: ${XCHAT_ROOT:-empty})"

# ── Build + push ──────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  command -v docker >/dev/null || command -v buildah >/dev/null \
    || fail "need docker or buildah"

  STAGE="$(mktemp -d /tmp/harness-build.XXXXXX)"
  cleanup() { rm -rf "$STAGE"; }
  trap cleanup EXIT

  say "staging build context at $STAGE (harness + SDK copies)"
  # Copy harness without node_modules / .git noise
  rsync -a \
    --exclude node_modules \
    --exclude .git \
    --exclude 'apps/agent/logs' \
    --exclude '.env' \
    "$REPO_ROOT/" "$STAGE/"
  # Replace symlinks with real package trees
  rm -rf "$STAGE/packages/xchat-sdk" "$STAGE/packages/drone-core"
  mkdir -p "$STAGE/packages"
  rsync -a --exclude node_modules "$XCHAT_ROOT/packages/xchat-sdk/" "$STAGE/packages/xchat-sdk/"
  rsync -a --exclude node_modules "$XCHAT_ROOT/packages/drone-core/" "$STAGE/packages/drone-core/"

  say "building $IMAGE (linux/amd64)"
  if command -v buildah >/dev/null; then
    (cd "$STAGE" && buildah bud --arch amd64 --os linux \
      --tag "$IMAGE" -f deploy/agent/Dockerfile .)
    say "pushing $IMAGE"
    buildah push "$IMAGE"
  elif docker buildx version >/dev/null 2>&1; then
    (cd "$STAGE" && docker buildx build --platform linux/amd64 --push \
      --tag "$IMAGE" -f deploy/agent/Dockerfile .)
  else
    (cd "$STAGE" && DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build \
      --platform linux/amd64 --tag "$IMAGE" -f deploy/agent/Dockerfile .)
    say "pushing $IMAGE"
    docker push "$IMAGE"
  fi
  trap - EXIT
  rm -rf "$STAGE"
else
  say "skipping build, tag=$TAG"
  if image_exists "$IMAGE"; then
    say "✓ image in registry"
  else
    rc=$?
    [ "$rc" -eq 2 ] && say "⚠ cannot verify image existence" \
      || fail "image $IMAGE not in registry — drop --skip-build"
  fi
fi

# ── TSS material ──────────────────────────────────────────────────────
say "syncing TSS material $TSS_MATERIAL"
TSS_ENV_FILE="$(mktemp)"; chmod 600 "$TSS_ENV_FILE"
trap 'rm -f "$TSS_ENV_FILE"' EXIT
{
  printf 'XAI_API_KEY=%s\n' "$XAI_API_KEY"
  printf 'XCHAT_PIN=%s\n' "$XCHAT_PIN"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    printf '%s\n' "$line"
  done < "$ACCOUNT_DIR/credentials.env"
  printf 'XCHAT_AGENT_CONFIG_B64=%s\n' \
    "$(base64 < "$ACCOUNT_DIR/agent-config.json" | tr -d '\n')"
  # Optional extras from harness .env
  for k in LINEAR_API_KEY SOURCEGRAPH_TOKEN SOURCEGRAPH_URL BRAIN_GIT_TOKEN GH_TOKEN PHABRICATOR_CONDUIT_TOKEN PHABRICATOR_URL; do
    eval "val=\${$k:-}"
    [ -n "$val" ] && printf '%s=%s\n' "$k" "$val"
  done
} > "$TSS_ENV_FILE"

if tss material describe "$TSS_MATERIAL" >/dev/null 2>&1; then
  tss material create --no-content-validation -y -f "$TSS_ENV_FILE" "$TSS_MATERIAL"
else
  tss material create \
    -o user "$USER" -a group "$TSS_ADMIN_GROUP" \
    -d kubernetes "$TSS_DESTINATION" -n "$NAMESPACE" \
    --no-content-validation -y -f "$TSS_ENV_FILE" "$TSS_MATERIAL"
fi
rm -f "$TSS_ENV_FILE"; trap - EXIT
say "TSS pushed (cluster delivery can lag ~minutes)"

# ── xctl deploy ───────────────────────────────────────────────────────
say "xctl workload deploy $WORKLOAD"
(
  cd "$REPO_ROOT"
  xctl workload deploy \
    -d "$DATACENTER" \
    --namespace "$NAMESPACE" \
    --workload "$WORKLOAD" \
    --workload-spec-file deploy/agent/spec.yaml \
    --set "handle=${HANDLE}" \
    --set "safeHandle=${SAFE_HANDLE}" \
    --image "$IMAGE" \
    --replicas 1 \
    --watch --yes
)

# ── Discover STS / label egress / wait ────────────────────────────────
say "locating StatefulSet"
STS="$(kubectl get sts -n "$NAMESPACE" -o name 2>/dev/null \
  | grep -E "/${WORKLOAD}(--|$)" | head -1 | sed 's|statefulset.apps/||' || true)"
[ -n "$STS" ] || fail "no StatefulSet matching ${WORKLOAD}* — check kube context (xctl workload pods -d $DATACENTER -n $NAMESPACE -w $WORKLOAD)"
POD="${STS}-0"
say "sts=$STS pod=$POD"

if [ "$(kubectl get sts "$STS" -n "$NAMESPACE" \
      -o jsonpath='{.metadata.labels.x\.com/envoy-egress-sidecar-inject}' 2>/dev/null)" != "true" ]; then
  say "labeling envoy egress sidecar"
  kubectl label statefulset "$STS" -n "$NAMESPACE" \
    x.com/envoy-egress-sidecar-inject=true --overwrite
  kubectl delete pod "$POD" -n "$NAMESPACE" --wait=false 2>/dev/null || true
fi

say "waiting for Ready"
kubectl wait pod/"$POD" -n "$NAMESPACE" --for=condition=Ready --timeout=180s \
  || fail "pod not Ready — try: kubectl --context <cluster> logs $POD -n $NAMESPACE -c main"

sleep 3
logs="$(kubectl logs "$POD" -n "$NAMESPACE" -c main --tail 80 2>/dev/null || true)"
echo "$logs" | grep -q "seeded agent-config\|starting harness agent\|websocket" \
  && say "✓ agent log looks alive" || say "⚠ check logs manually"

cat <<EOF

✓ Deployed ${WORKLOAD}
  image: ${IMAGE}
  sts:   ${STS}
  pod:   ${POD}

Navigator:
  https://ui.navigator.prod.svc.kube.int-x.ai/${USER}/${USER}/${WORKLOAD}?datacenter=${DATACENTER}&appEnv=prod&api=workload.scheduler.x.com%2Fv1beta1

Ops:
  # find cluster if logs fail:
  xctl workload pods -d ${DATACENTER} -n ${NAMESPACE} -w ${WORKLOAD}
  kubectl --context <CLUSTER> logs -f ${POD} -n ${NAMESPACE} -c main
  kubectl --context <CLUSTER> rollout restart sts/${STS} -n ${NAMESPACE}
  # config-only redeploy:
  ./deploy/agent/deploy.sh @${HANDLE} --skip-build

EOF
