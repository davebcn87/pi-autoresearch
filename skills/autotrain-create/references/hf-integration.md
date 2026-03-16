# HF Integration Reference

**IMPORTANT:** Use `hf` (not deprecated `huggingface-cli`). Run `hf auth whoami` at setup to get username.

**HF Jobs note:** In Jobs mode, model upload happens **inside the remote job** via `push_to_hub()` / `upload_folder()`. The local "After Every keep" upload steps below still apply for syncing session docs and bucket logs — but the model output itself is already on the Hub when the job finishes.

## Session Setup (once, during Step 1)

```bash
# Get username for repo paths
# NOTE: hf auth whoami output contains ANSI color codes — strip them
HF_USER=$(hf auth whoami 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' | xargs)

# Create the output repo on the Hub (idempotent with --exist-ok)
hf repos create ${HF_USER}/<model>-output --exist-ok

# Optionally create a bucket for session logs
hf buckets create ${HF_USER}/autotrain-<goal>
```

## After Every `keep`

1. Update `autotrain.md` and commit (see Doc Update Discipline)
2. Upload model output to Hub:
   ```bash
   hf upload ${HF_USER}/<model>-output ./output/ . \
     --commit-message "Exp #N: <description>" \
     --commit-description "Primary: <metric>=<value>"
   ```
3. Sync session doc to the model repo:
   ```bash
   hf upload ${HF_USER}/<model>-output ./autotrain.md autotrain.md \
     --commit-message "doc: session notes after exp #N"
   ```
4. Sync session files to bucket (full history):
   ```bash
   hf buckets sync . hf://buckets/${HF_USER}/autotrain-<goal>/ \
     --include "autotrain.*" --include "autotrain.jsonl"
   ```

## On First `keep` (or when user asks)

Create a model card (`README.md` in the output directory) with:
- Training configuration (base model, framework, architecture config)
- Results table (experiment history, best metrics)
- Usage example (how to load and use the model)
- Dataset description
- Link to base model: `hf models info <base_model>` for metadata

Upload it:
```bash
hf upload ${HF_USER}/<model>-output ./output/README.md README.md \
  --commit-message "Add model card"
```

## On Session End

1. Final upload of model output + model card with updated results:
   ```bash
   hf upload ${HF_USER}/<model>-output ./output/ . \
     --commit-message "Final: <primary_metric>=<best_value> after N experiments"
   ```
2. Final bucket sync:
   ```bash
   hf buckets sync . hf://buckets/${HF_USER}/autotrain-<goal>/ \
     --include "autotrain.*" --include "autotrain.jsonl" --include "*.log"
   ```
3. Tag the final version:
   ```bash
   hf repos tag create ${HF_USER}/<model>-output final --revision main
   ```

## HF CLI Quick Reference

| Command | Use Case |
|---------|----------|
| `hf auth whoami` | Get logged-in username for repo paths |
| `hf models info MODEL_ID` | Inspect model (arch, size, config, tags) |
| `hf models ls --search "qwen" --sort downloads` | Search for candidate models |
| `hf models ls --author ORG --filter TAG` | Filter models by org and task tag |
| `hf datasets info DATASET_ID` | Inspect dataset (size, schema, splits) |
| `hf datasets ls --search "your topic" --sort downloads` | Search for datasets |
| `hf datasets parquet DATASET_ID` | Get parquet URLs for SQL queries |
| `hf datasets sql "SQL"` | Query datasets with DuckDB (explore, filter, profile) |
| `hf download REPO_ID --local-dir ./path` | Download model or dataset |
| `hf download REPO_ID --repo-type dataset` | Download a dataset specifically |
| `hf repos create REPO_ID --exist-ok` | Create output repo on Hub |
| `hf upload REPO_ID LOCAL_PATH PATH_IN_REPO` | Upload model/files to Hub |
| `hf buckets create BUCKET_ID` | Create a bucket for session logs |
| `hf buckets sync ./local hf://buckets/USER/BUCKET/` | Sync files to bucket |
| `hf repos tag create REPO_ID TAG_NAME` | Tag a version (e.g., "final", "best") |
| `hf jobs uv run --flavor X train.py` | Submit a training job to HF Jobs |
| `hf jobs ps -a` | List all jobs (running + completed) |
| `hf jobs logs -f JOB_ID` | Stream logs from a running job |
| `hf jobs stats` | Live GPU/CPU/memory metrics for running jobs |
| `hf jobs inspect JOB_ID` | Full status JSON for a job |
| `hf jobs cancel JOB_ID` | Cancel a running job |
| `hf jobs hardware` | List available hardware flavors and pricing |

**Tips:**
- Use `--format json` on `ls` commands (e.g., `hf models ls`, `hf datasets ls`) for machine-readable output. Note: `--format` does NOT work on `info` commands — use `--expand` instead for verbose output.
- Use `-q` / `--quiet` to suppress progress bars in scripts
- Use `--include` / `--exclude` glob patterns to filter uploads/downloads
- `hf datasets sql` does NOT support HTTP wildcard globs (e.g., `read_parquet('https://.../*.parquet')`). List individual shard URLs from `hf datasets parquet` and pass them as an array: `read_parquet(['url1', 'url2', ...])`
- Always quote multi-word `--search` values: `--search "japanese instruction"` (not `--search japanese instruction`)
- Run `hf <command> --help` for full options
