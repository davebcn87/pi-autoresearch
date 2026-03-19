# HF Jobs Reference

Cloud NVIDIA GPUs billed per-second. No local GPU required. Requires HF Pro/Team/Enterprise account with pre-paid credits.

## How It Works

`hf jobs uv run` submits a self-contained Python script to run on a remote GPU. The script must push results (model outputs, metrics) to the Hub before exiting — the container is **ephemeral** (all files deleted after the job ends).

## Detached Mode (Required)

ALWAYS use detached mode (`-d`) for training jobs. Attached mode (the default) drops the connection on long-running jobs, losing output and orphaning the job (which keeps running and costing money).

- **`-d` / `--detach`** — submits the job, prints the job ID, exits immediately
- You then poll for completion with `check_jobs`

The output of `hf jobs uv run -d` is two lines:
```
<24-char hex job ID>
View at: https://huggingface.co/jobs/<user>/<job_id>
```

The extension parses the job ID automatically via `/[0-9a-f]{24}/`.

## Training Script Pattern

```python
# /// script
# dependencies = ["torch", "transformers", "datasets", "accelerate"]
# ///
import os, json

# Read config from env vars (set by autotrain.sh via -e flags)
HF_USER = os.environ["HF_USER"]
MODEL_ID = os.environ.get("MODEL_ID", "...")
DATASET_ID = os.environ.get("DATASET_ID", f"{HF_USER}/autotrain-data")
OUTPUT_REPO = os.environ.get("OUTPUT_REPO", f"{HF_USER}/my-model-output")

# Smoke mode: run only 10 steps for validation
AUTOTRAIN_STAGE = os.environ.get("AUTOTRAIN_STAGE", "full")
if AUTOTRAIN_STAGE == "smoke":
    MAX_STEPS = 10
    LOGGING_STEPS = 1
    EVAL_STEPS = 10
else:
    MAX_STEPS = int(os.environ.get("MAX_STEPS", "1000"))
    LOGGING_STEPS = int(os.environ.get("LOGGING_STEPS", "10"))
    EVAL_STEPS = int(os.environ.get("EVAL_STEPS", "100"))

# ... training code (agent writes this based on paradigm) ...

# Print METRIC lines (captured by check_jobs from job logs)
print(f"METRIC primary_metric={value:.4f}")
print(f"METRIC secondary_metric={value:.4f}")

# Push results to Hub before exiting — container is ephemeral
from huggingface_hub import upload_folder
upload_folder(repo_id=OUTPUT_REPO, folder_path="./output",
              commit_message=f"primary_metric={value:.4f}")
```

Add paradigm-specific dependencies to the PEP 723 header (e.g., `trl`, `peft`, `bitsandbytes`, `gymnasium`, `stable-baselines3`).

## GPU Compatibility

- **Ampere GPUs (A10G, A100, L40S)**: Use `bf16=True`. Do NOT use `fp16=True` — it causes AMP unscale errors with QLoRA/bitsandbytes 4-bit quantization.
- **Older GPUs (T4)**: Use `fp16=True` (T4 does not support bf16).
- When using `bitsandbytes` with `load_in_4bit=True`, set `bnb_4bit_compute_dtype=torch.bfloat16` on Ampere GPUs.

## `autotrain.sh` Jobs Wrapper

The script **must exit in seconds**. It submits the job in detached mode and prints the job ID. `submit_job` parses the ID and returns immediately. Polling happens via `check_jobs`, not in the script.

```bash
#!/bin/bash
set -euo pipefail

HF_USER=$(hf auth whoami 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' | xargs)
FLAVOR="${FLAVOR:-a10g-small}"

# Stage awareness: pass AUTOTRAIN_STAGE to the remote script
STAGE="${AUTOTRAIN_STAGE:-smoke}"

# Submit in detached mode — script exits in seconds
OUTPUT=$(hf jobs uv run -d \
    --flavor "$FLAVOR" \
    --timeout "${TIMEOUT:-2h}" \
    --secrets HF_TOKEN \
    -e HF_USER="$HF_USER" \
    -e MODEL_ID="${MODEL_ID}" \
    -e DATASET_ID="${DATASET_ID}" \
    -e OUTPUT_REPO="${OUTPUT_REPO}" \
    -e AUTOTRAIN_STAGE="$STAGE" \
    train.py 2>&1)

JOB_ID=$(echo "$OUTPUT" | grep -Eo '[0-9a-f]{24}' | head -n 1)
if [ -z "$JOB_ID" ]; then
    echo "ERROR: Failed to parse job ID from: $OUTPUT" >&2
    exit 1
fi

# Print job ID for submit_job to parse — then EXIT immediately
echo "$JOB_ID"
```

**Do NOT add a polling loop to this script.** The extension's `check_jobs` tool handles all polling, log fetching, and METRIC parsing.

## Key Rules

- ALWAYS use detached mode (`-d`) — attached mode drops on long jobs
- The script must **exit in seconds** — `submit_job` blocks until it does
- Use `bf16=True` on Ampere GPUs (A10G, A100, L40S), `fp16=True` only on T4
- Declare all dependencies in PEP 723 header (`# /// script` / `# dependencies = [...]` / `# ///`)
- Push results to Hub before exiting — the container is ephemeral
- Print `METRIC name=value` lines to stdout for `check_jobs` to capture
- Pass config via `-e` env vars so the agent can tweak per experiment
- Set `--timeout` with 50% buffer over expected training time
- Use `--secrets HF_TOKEN` to pass authentication to the remote container

## Timeout Guidance

Set `--timeout` in the script to `training_time * 1.5`. Set `timeout_seconds` in `submit_job` to 120s (script exits in seconds — this is just for safety).

## Monitoring

```bash
hf jobs ps                    # list running jobs
hf jobs ps -a                 # all jobs including completed
hf jobs logs <job_id>         # fetch logs (after completion)
hf jobs logs -f <job_id>      # follow logs in real-time
hf jobs stats <job_id>        # GPU utilization, memory, network
hf jobs inspect <job_id>      # full status JSON
hf jobs cancel <job_id>       # cancel a running job
```
