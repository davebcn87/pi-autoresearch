# HF Jobs Reference

Cloud NVIDIA GPUs billed per-second. No local GPU required. Requires HF Pro/Team/Enterprise account with pre-paid credits.

## How It Works

`hf jobs uv run` submits a self-contained Python script to run on a remote GPU. Logs stream to your terminal in real-time. The script must push results (model outputs, metrics) to the Hub before exiting — the container is **ephemeral** (all files deleted after the job ends).

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

# ... training code (agent writes this based on paradigm) ...

# Print METRIC lines (captured by run_experiment)
print(f"METRIC primary_metric={value:.4f}")
print(f"METRIC secondary_metric={value:.4f}")

# Push results to Hub before exiting — container is ephemeral
from huggingface_hub import upload_folder
upload_folder(repo_id=OUTPUT_REPO, folder_path="./output",
              commit_message=f"primary_metric={value:.4f}")
```

Add paradigm-specific dependencies to the PEP 723 header (e.g., `trl`, `peft`, `bitsandbytes`, `gymnasium`, `stable-baselines3`).

## `autotrain.sh` Jobs Wrapper

```bash
#!/bin/bash
set -euo pipefail

# Strip ANSI color codes from hf auth output
HF_USER=$(hf auth whoami 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' | xargs)
FLAVOR="${FLAVOR:-a10g-small}"

hf jobs uv run \
    --flavor "$FLAVOR" \
    --timeout "${TIMEOUT:-2h}" \
    --secrets HF_TOKEN \
    -e HF_USER="$HF_USER" \
    -e MODEL_ID="${MODEL_ID}" \
    -e DATASET_ID="${DATASET_ID}" \
    -e OUTPUT_REPO="${OUTPUT_REPO}" \
    train.py

# METRIC lines are printed by train.py and captured by run_experiment
```

`hf jobs uv run` (without `--detach`) streams the remote job's stdout to your terminal. `run_experiment` captures this output including the `METRIC` lines. When the job finishes, the command exits.

## Key Rules

- Declare all dependencies in PEP 723 header (`# /// script` / `# dependencies = [...]` / `# ///`)
- Push results to Hub before exiting — the container is ephemeral
- Print `METRIC name=value` lines to stdout for `run_experiment` to capture
- Pass config via `-e` env vars so the agent can tweak per experiment
- Set `--timeout` with 50% buffer over expected training time
- Use `--secrets HF_TOKEN` to pass authentication to the remote container

## Timeout Guidance

Set `--timeout` in the script to `training_time * 1.5`. Set `timeout_seconds` in `run_experiment` to the same value plus 60s (to account for job startup overhead).

## Monitoring

```bash
hf jobs ps                    # list running jobs
hf jobs ps -a                 # all jobs including completed
hf jobs logs -f <job_id>      # re-attach to log stream
hf jobs stats                 # live GPU utilization, memory, network
hf jobs inspect <job_id>      # full status JSON
hf jobs cancel <job_id>       # cancel a running job
```
