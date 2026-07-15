# Deploy tatanbot to k8s

Same shape as zw_bot: **StatefulSet in your namespace**, secrets via **TSS**, image in **artifactory**, egress via **envoy sidecar**.

## One-time prep

1. **Local bot profile works** (you already have this):
   ```bash
   ls ~/.xchat/accounts/tatanbotter09/{credentials.env,agent-config.json}
   ```

2. **Env for deploy** (harness `.env` is fine):
   ```bash
   XAI_API_KEY=...
   XCHAT_PIN=1407
   # optional but recommended in TSS:
   LINEAR_API_KEY=...
   SOURCEGRAPH_TOKEN=...
   BRAIN_GIT_TOKEN=...   # if brain remote should push from pod
   ```

3. **Tools**: `docker` (or buildah), `xctl`, `kubectl`, `tss`, `git`, `rsync`, artifactory docker login.

4. **Sibling SDK**: `../x-chat` with `packages/xchat-sdk` + `packages/drone-core`.

5. **Kube**: deploy uses your **current** kubectl context for post-checks. After `xctl deploy`, find the real cluster:
   ```bash
   xctl workload pods -d atla -n "$USER" -w xchat-agent-tatanbotter09
   # CLUSTER column → kubectl --context <that>
   ```

## Deploy

```bash
cd ~/Documents/Programming/xchat-agent-harness

# full: stage SDK → build linux/amd64 → push → TSS → xctl
export XCHAT_PIN=1407   # if not in .env
./deploy/agent/deploy.sh @tatanbotter09

# later: config/creds only, reuse image
./deploy/agent/deploy.sh @tatanbotter09 --skip-build
```

What it does:

| Step | Detail |
|------|--------|
| Stage | Copies harness + **real** x-chat packages (symlinks don't work in Docker) |
| Image | `docker-releases-local.artifactory.twitter.biz/users/$USER/xchat-agent-harness:<tag>` |
| TSS | `xchat-agent/tatanbotter09/env` → DM_*, XAI_*, PIN, config b64, optional Linear/SG/brain |
| Workload | `xchat-agent-tatanbotter09` StatefulSet, ns=`$USER`, dc=`atla` |
| Egress | labels envoy sidecar for outbound HTTPS |

## Day-2

```bash
W=xchat-agent-tatanbotter09
xctl workload pods -d atla -n "$USER" -w $W
CTX=<cluster from above>

kubectl --context $CTX logs -f $(kubectl --context $CTX get pods -n "$USER" -o name | grep $W) -n "$USER" -c main
kubectl --context $CTX rollout restart sts/$(kubectl --context $CTX get sts -n "$USER" -o name | grep $W | sed 's|.*/||') -n "$USER"

# wipe
xctl workload delete -d atla -n "$USER" -w $W --force
```

Cold-start (~20s): Juicebox recover via `XCHAT_PIN`, seed config from `XCHAT_AGENT_CONFIG_B64`, WS connect. `/data` is emptyDir — pod replace re-recovers keys.

## Local vs k8s

| | Local | k8s |
|--|-------|-----|
| Code | harness git + `restart.sh` | new image build/push |
| Secrets | `.env` + `~/.xchat/...` | TSS material only |
| Self-update | `restart_agent` git pull | needs image rebuild (or later: pull-in-pod if you add it) |

Bot `restart_agent` on the **pod** still runs `scripts/restart.sh` (git pull). That only helps if the image has git + credentials to pull harness main and network allows github — **image rebuild is the reliable k8s path** for code changes.

## Navigator

After deploy:

`https://ui.navigator.prod.svc.kube.int-x.ai/<you>/<you>/xchat-agent-tatanbotter09?datacenter=atla&appEnv=prod&api=workload.scheduler.x.com%2Fv1beta1`
