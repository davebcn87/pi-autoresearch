---
name: autotrain-create
description: Set up and run an autonomous fine-tuning loop for LLM training. Detects hardware, selects framework, creates data splits, and optimizes through structured phases. Use when asked to "fine-tune a model", "train a LoRA", "optimize training", "run autotrain", or "start fine-tuning".
---

# Autotrain

Autonomous fine-tuning loop for LLM training: detect hardware, pick framework, curate data, train LoRA adapters, and optimize through structured experiment phases.

## Tools

- **`init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — runs command, times it, captures output.
- **`log_experiment`** — records result. `keep` auto-commits. `discard`/`crash`/`checks_failed` → `git checkout -- .` to revert. Always include secondary `metrics` dict. Dashboard: ctrl+x.

## Setup

Follow these steps **in order**. Do not skip steps.

### Step 0: Python Environment

If no virtual environment is active, create one with `uv venv && source .venv/bin/activate` before installing any packages.

### Step 1: Gather Requirements & Recon

Ask (or infer from context):
- **Goal** — what capability are we training? (e.g., "code completion", "medical QA", "sentiment classification")
- **Base model** — name, size, quantization (e.g., `Qwen/Qwen2.5-3B`)
- **Dataset** — source, format, size, any filtering criteria
- **Metric** — primary metric + direction (e.g., `exact_accuracy` higher is better)
- **Hardware** — will be auto-detected, but ask if ambiguous
- **Constraints** — max training time, VRAM limits, must-not-touch files

**Immediately inspect the model and dataset on the Hub:**

```bash
# Check who's logged in (needed for repo names later)
hf auth whoami

# Inspect the base model — architecture, size, tags, config
# IMPORTANT: Check pipeline_tag in the output. If it says "image-text-to-text"
# the model is a VLM (vision-language model). For text-only tasks, prefer a
# text-only model (pipeline_tag "text-generation") to avoid wasting parameters.
hf models info <model_id>

# If user is unsure about the base model, search for candidates
hf models ls --search "qwen 3b" --sort downloads --limit 10
hf models ls --search "llama" --filter text-generation --sort downloads
hf models ls --author meta-llama --sort downloads --format json

# If dataset is on the Hub, inspect it
hf datasets info <dataset_id>

# Search for datasets if user doesn't have one yet (replace with your topic)
hf datasets ls --search "code" --sort downloads --limit 10
hf datasets ls --search "code instructions" --filter task_categories:text-generation

# Explore dataset structure and size with SQL (DuckDB)
hf datasets parquet <dataset_id>  # list available parquet URLs
hf datasets sql "SELECT COUNT(*) AS rows FROM read_parquet('<parquet_url>')"

# Sample rows to understand format
hf datasets sql "SELECT * FROM read_parquet('<parquet_url>') LIMIT 5" --format json

# Check distributions for curation decisions (adapt column names to your dataset)
hf datasets sql "SELECT bucket, COUNT(*) AS n FROM (
  SELECT FLOOR(score * 10) / 10 AS bucket
  FROM read_parquet('<parquet_url>')
) GROUP BY bucket ORDER BY bucket"
```

This recon informs data curation decisions in Phase 1 — do it **before** writing any code.

### Step 2: Detect Hardware & Select Framework

```bash
# Auto-detection logic
if [[ "$(uname -m)" == "arm64" ]] && [[ "$(uname)" == "Darwin" ]]; then
  # Apple Silicon Mac → mlx-lm
  FRAMEWORK="mlx-lm"
elif nvidia-smi &>/dev/null; then
  # NVIDIA GPU → unsloth (preferred) or TRL+PEFT (fallback)
  FRAMEWORK="unsloth"
else
  echo "ERROR: No supported GPU detected. Need Apple Silicon or NVIDIA GPU."
  exit 1
fi
```

Record the detected hardware and framework in `autotrain.md` so resuming agents don't re-detect.

### Step 3: Create Branch

```bash
git checkout -b autotrain/<goal>-<date>
```

### Step 4: Read Source Files & Download Assets

Read any existing training scripts and evaluation code **deeply** before writing anything.

**Download model and dataset if not already local:**
```bash
# Download model weights (cached, re-downloads only if needed)
hf download <model_id> --local-dir ./model

# Download dataset from the Hub
hf download <dataset_id> --repo-type dataset --local-dir ./data

# Or download specific files only
hf download <dataset_id> --repo-type dataset --include "*.parquet" --local-dir ./data
```

**Explore data with SQL before writing split code:**
```bash
# Understand schema
hf datasets sql "SELECT * FROM read_parquet('./data/train.parquet') LIMIT 1" --format json

# Check size per split
hf datasets sql "SELECT COUNT(*) FROM read_parquet('./data/train.parquet')"

# Profile data quality — look for filtering opportunities (Phase 1 prep)
hf datasets sql "SELECT
  MIN(LENGTH(text)) AS min_len,
  AVG(LENGTH(text))::INT AS avg_len,
  MAX(LENGTH(text)) AS max_len,
  COUNT(*) AS total
FROM read_parquet('./data/train.parquet')"
```

Understand the data format, tokenization, and evaluation pipeline before writing anything.

### Step 5: Create Three-Way Data Split

**Mandatory.** Every session must have three splits:

| Split | Purpose | Mutability |
|-------|---------|------------|
| **train** | Gradient updates | May be re-curated between experiments |
| **val** | Checkpoint selection (in-loop) | May be re-curated between experiments |
| **test** | Keep/discard decisions | **Fixed at session start. Never modify.** |

Additionally, prepare a **fresh validation** mechanism: a way to sample a different validation subset to catch overfitting to the test set (see Validation Protocol below).

### Step 6: Write `autotrain.md` and `autotrain.sh`

See templates below. Invest time making `autotrain.md` excellent — it's the session's living memory.

### Step 7: Commit Before Any Experiment

```bash
git add autotrain.md autotrain.sh
git commit -m "autotrain: initial session setup"
```

**This commit MUST happen before running any experiment.** Late commits lose the baseline context.

### Step 8: Start the Loop

`init_experiment` → run baseline → `log_experiment` → start looping immediately.

---

## Hardware & Framework Reference

### mlx-lm (Mac / Apple Silicon)

**When to use:** `uname -m` returns `arm64` on macOS.

**Training command:**
```bash
mlx_lm.lora \
  --model <model_name_or_path> \
  --data <data_dir> \
  --train \
  --batch-size 2 \
  --grad-accumulation-steps 8 \
  --lora-layers 16 \
  --iters <steps> \
  --learning-rate 1e-5 \
  --adapter-path ./adapters
```

**GPU note:** Apple Silicon shares the GPU between training and display. Keep `--batch-size` ≤ 4 to avoid freezing the screen. Use `--grad-accumulation-steps` to maintain effective batch size.

**Typical hyperparameter ranges:**
| Param | Range | Notes |
|-------|-------|-------|
| `--batch-size` | 1–4 | **Default 2.** Larger batches can freeze macOS display (GPU starvation). Compensate with `--grad-accumulation-steps`. |
| `--grad-accumulation-steps` | 2–16 | Effective batch = batch-size × steps. Default 8 (effective 16). |
| `--lora-layers` | 8–32 | More layers = more capacity but slower |
| `--iters` | 100–2000 | Start small, increase if undertrained |
| `--learning-rate` | 1e-6 to 1e-4 | 1e-5 is a safe default |
| `--lora-rank` | 8–64 | Default 8; increase for complex tasks |

**Evaluation:**
```bash
mlx_lm.lora --model <model> --adapter-path ./adapters --data <data_dir> --test
```

**Export:** Adapter only (safetensors). Use `mlx_lm.fuse` to merge into base model.

### unsloth (NVIDIA GPU — preferred)

**When to use:** `nvidia-smi` succeeds. Preferred over plain TRL — 2-5x faster, 50-70% less VRAM.

**Typical script structure:**
```python
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="<model>",
    max_seq_length=<length>,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,                    # LoRA rank
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
    lora_alpha=16,
    lora_dropout=0,          # MUST be 0 for unsloth fast kernels
    bias="none",             # MUST be "none" for unsloth fast kernels
)

from trl import SFTTrainer
from transformers import TrainingArguments

trainer = SFTTrainer(
    model=model,
    train_dataset=train_dataset,
    eval_dataset=val_dataset,
    args=TrainingArguments(
        per_device_train_batch_size=4,
        num_train_epochs=1,
        learning_rate=2e-4,
        output_dir="./outputs",
        eval_strategy="steps",
        eval_steps=50,
        logging_steps=10,
    ),
)
trainer.train()
```

**Critical requirements for fast kernels:**
- `lora_dropout=0` — non-zero disables fast path
- `bias="none"` — non-none disables fast path

**Export options:**
- LoRA adapter only: `model.save_pretrained("lora_adapter")`
- Merged 16-bit: `model.save_pretrained_merged("merged", tokenizer)`
- GGUF: `model.save_pretrained_gguf("gguf", tokenizer, quantization_method="q4_k_m")` (30+ quant methods)

### TRL + PEFT (NVIDIA GPU — fallback)

**When to use:** When unsloth doesn't support the model architecture.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from peft import LoraConfig
from trl import SFTTrainer

model = AutoModelForCausalLM.from_pretrained("<model>", torch_dtype="auto", device_map="auto")
tokenizer = AutoTokenizer.from_pretrained("<model>")

peft_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)

trainer = SFTTrainer(
    model=model,
    train_dataset=train_dataset,
    eval_dataset=val_dataset,
    peft_config=peft_config,
    args=TrainingArguments(
        per_device_train_batch_size=4,
        num_train_epochs=1,
        learning_rate=2e-4,
        output_dir="./outputs",
    ),
)
trainer.train()
```

---

## `autotrain.md` Template

This is the session's living memory. A fresh agent with no context should be able to read this file and continue effectively.

```markdown
# Autotrain: <goal>

## Objective
<What capability are we training? What does success look like?>

## Hardware & Framework
- **Hardware**: <e.g., Apple M2 Max 64GB / NVIDIA RTX 4090 24GB>
- **Framework**: <mlx-lm / unsloth / TRL+PEFT>
- **Detection**: <how it was detected, so resuming agents don't re-detect>

## Base Model
- **Name**: <e.g., Qwen/Qwen2.5-3B>
- **Size**: <parameters>
- **Quantization**: <4-bit / 16-bit / none>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, <name>, ...
- **Track val_loss alongside accuracy** — divergence between them signals overfitting

## Dataset Splits
- **Source**: <dataset name/path>
- **Train**: <N examples, filters applied>
- **Val**: <N examples, filters applied>
- **Test**: <N examples — FIXED at session start, never modified>
- **Fresh validation**: <method for sampling different val subsets>

## How to Run
`./autotrain.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Constraints
<Hard rules: VRAM limits, max training time, etc.>

## Experiment Priority Order
Follow this order. Do NOT jump to Phase 4 before exhausting Phases 1-2.

1. **Phase 1: Data Quality** — volume, curation, filtering, dedup (HIGHEST leverage)
2. **Phase 2: Prompt & Output Format** — instruction template, chat format, target length
3. **Phase 3: LoRA Architecture** — rank, target_modules, alpha
4. **Phase 4: Training Hyperparameters** — LR, steps, batch size, scheduler
5. **Phase 5: Regularization** — only if overfitting is visible (val_loss rising while train_loss falls)

## Anti-Thrash Rules
1. 5+ consecutive discards → stop, write notes, pivot to a different phase
2. Same metric +/-noise for 8+ experiments → change something structural
3. All current ideas are Phase 4 but Phase 1-3 not exhausted → go back up
4. 20+ min without improvement → run fresh validation, accept or fundamentally pivot

## What's Been Tried

### Key Wins
<Experiments that improved the metric, with brief explanation of why.>

### Dead Ends
<Approaches that didn't work, so future agents don't repeat them.>

### Observations
<Patterns noticed, hypotheses, things to investigate.>
```

Update `autotrain.md` after every `keep` — especially the "What's Been Tried" section.

---

## `autotrain.sh` Template

```bash
#!/bin/bash
set -euo pipefail

# Pre-check: fast syntax/import validation (<1s)
python -m compileall -q src/ || { echo "Syntax error"; exit 1; }

# Training
# <framework-specific training command here>

# Evaluation on TEST split (fixed holdout)
# <evaluation command here>

# Output metrics — one METRIC line per metric
# METRIC accuracy=0.847
# METRIC val_loss=1.234
# METRIC f1=0.812
```

**Timeout guidance:** Set `timeout_seconds` in `run_experiment` to `training_time * 1.5`. If a typical run takes 5 minutes, set timeout to 450 seconds.

---

## `autotrain.checks.sh` (optional)

Bash script for backpressure/correctness checks. **Only create when the user's constraints require correctness validation.**

When this file exists:
- Runs automatically after every **passing** benchmark in `run_experiment`.
- If checks fail, `run_experiment` reports it — log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `checks_timeout_seconds`).

---

## Experiment Priority Order

This is the most important section. **Follow these phases in order.**

### Phase 1: Data Quality (HIGHEST LEVERAGE)

Data changes almost always have more impact than hyperparameter changes. Explore these first:
- **Volume**: More data? Less (higher quality) data?
- **Curation**: Filter by quality signals (rating, length, complexity)
- **Deduplication**: Remove near-duplicates that waste training compute
- **Balancing**: Ensure good distribution across difficulty levels
- **Cleaning**: Fix formatting issues, remove corrupted examples

**Use `hf datasets sql` to inform curation decisions:**
```bash
# Distribution analysis — find the best filter thresholds
hf datasets sql "SELECT
  FLOOR(quality_score * 10) / 10 AS bucket,
  COUNT(*) AS n
FROM read_parquet('./data/train.parquet')
GROUP BY bucket ORDER BY bucket"

# Find duplicates
hf datasets sql "SELECT input, COUNT(*) AS dupes
FROM read_parquet('./data/train.parquet')
GROUP BY input HAVING dupes > 1
ORDER BY dupes DESC LIMIT 10"

# Sample from a specific quality range to eyeball it
hf datasets sql "SELECT * FROM read_parquet('./data/train.parquet')
WHERE quality_score > 0.8 LIMIT 5" --format json
```

### Phase 2: Prompt & Output Format

How you format the input/output matters enormously:
- **Instruction template**: System prompt, few-shot examples
- **Chat template**: Match the base model's expected format exactly
- **Target format**: JSON vs plain text, structured vs free-form, etc.
- **Target length**: Shorter outputs are easier to learn (if they retain information)
- **Special tokens**: Proper use of BOS/EOS/pad tokens

### Phase 3: LoRA Architecture

- **Rank** (`r`): 8 → 16 → 32 → 64. Higher = more capacity but diminishing returns.
- **Target modules**: Start with attention (`q_proj`, `v_proj`), expand to all linear layers
- **Alpha**: Usually `alpha = rank` or `alpha = 2 * rank`
- **Layers**: More LoRA layers vs fewer (framework-dependent)

### Phase 4: Training Hyperparameters

Only tune these after Phases 1-3 are reasonably explored:
- **Learning rate**: Most impactful HP. Sweep 1e-6 to 1e-3 in log scale.
- **Steps/epochs**: Watch val_loss to find the sweet spot before overfitting.
- **Batch size**: Larger = smoother gradients but fewer updates per epoch.
- **Scheduler**: Cosine, linear decay, constant with warmup.
- **Warmup**: 5-10% of total steps.

### Phase 5: Regularization

Only if overfitting is visible (val_loss rising while train_loss falling):
- **Weight decay**: 0.01–0.1
- **Dropout**: Only for TRL+PEFT (unsloth requires `lora_dropout=0`)
- **Early stopping**: Monitor val_loss, stop when it starts rising
- **Data augmentation**: If applicable to the task

**RULE: Do NOT jump to Phase 4 before exhausting Phases 1-2.** Data and format changes are almost always higher leverage than hyperparameter tuning.

---

## Validation Protocol

### Three-Way Split (Mandatory)

| Split | Used For | When |
|-------|----------|------|
| **train** | Gradient updates | Every training run |
| **val** | Checkpoint selection | In-loop, during training |
| **test** | Keep/discard decisions | After training, fixed at session start |

The test split is **sacred**. Never modify it, never train on it, never use it for checkpoint selection.

### Fresh Validation

**Every 10 experiments OR after every `keep`:** evaluate on a DIFFERENT random sample from the validation pool (not the fixed test set). This catches overfitting to the test set.

How to implement:
- Keep a larger validation pool and sample from it
- Or use k-fold style rotation
- Compare fresh validation accuracy to test accuracy — large divergence means the test set is being overfit

### Minimum Test Set Size Guidance

| Size | Reliability | Recommendation |
|------|-------------|----------------|
| <200 examples | Noisy | Treat ±3% changes as ties |
| 200–1000 | Reasonable | Can trust ±1.5% changes |
| >1000 | Good | Can trust ±1% changes |

When the test set is small, require larger improvements before calling a `keep`.

---

## Anti-Thrash Rules

These rules prevent wasted compute from unproductive experiment cycles:

1. **5+ consecutive discards** → Stop. Write detailed notes about what you've tried. Pivot to a different phase entirely.
2. **Same metric ±noise for 8+ experiments** → The current approach is exhausted. Change something structural (different phase, different data strategy, different architecture).
3. **All current ideas are Phase 4 but Phases 1-3 not exhausted** → Go back up. You're micro-optimizing when macro changes are still available.
4. **20+ minutes without improvement** → Run fresh validation to check if recent "improvements" were noise. Either accept current state or make a fundamental pivot.
5. **Track val_loss alongside accuracy** → If val_loss is rising while accuracy improves, you're overfitting. Stop and investigate.

---

## Doc Update Discipline

**After every `keep`:**
1. Update "What's Been Tried" in `autotrain.md` with what worked and why
2. Commit the update: `git add autotrain.md && git commit -m "doc: update session notes"`

**Every 10 experiments (regardless of status):**
1. Update `autotrain.md` with observations, dead ends, and current hypotheses
2. Commit: `git add autotrain.md && git commit -m "doc: update session notes"`

**NEVER let doc updates accumulate uncommitted.** The doc is the session's memory — if it's lost, the next agent starts blind.

---

## HF Integration (Full Auto)

**IMPORTANT:** Use `hf` (not deprecated `huggingface-cli`). Run `hf auth whoami` at setup to get username.

### Session Setup (once, during Step 1)

```bash
# Get username for repo paths
HF_USER=$(hf auth whoami 2>/dev/null | head -1)

# Create the adapter repo on the Hub (idempotent with --exist-ok)
hf repos create ${HF_USER}/<model>-lora --exist-ok

# Optionally create a bucket for session logs
hf buckets create ${HF_USER}/autotrain-<goal>
```

### After Every `keep`

1. Update `autotrain.md` and commit (see Doc Update Discipline)
2. Upload adapter to Hub:
   ```bash
   hf upload ${HF_USER}/<model>-lora ./adapters/ . \
     --commit-message "Exp #N: <description>" \
     --commit-description "Primary: <metric>=<value>"
   ```
3. Sync session doc to the model repo:
   ```bash
   hf upload ${HF_USER}/<model>-lora ./autotrain.md autotrain.md \
     --commit-message "doc: session notes after exp #N"
   ```
4. Sync session files to bucket (full history):
   ```bash
   hf buckets sync . hf://buckets/${HF_USER}/autotrain-<goal>/ \
     --include "autotrain.*" --include "autotrain.jsonl"
   ```

### On First `keep` (or when user asks)

Create a model card (`README.md` in the adapter directory) with:
- Training configuration (base model, framework, LoRA config)
- Results table (experiment history, best metrics)
- Usage example (how to load and use the adapter)
- Dataset description
- Link to base model: `hf models info <base_model>` for metadata

Upload it:
```bash
hf upload ${HF_USER}/<model>-lora ./adapters/README.md README.md \
  --commit-message "Add model card"
```

### On Session End

1. Final upload of adapter + model card with updated results:
   ```bash
   hf upload ${HF_USER}/<model>-lora ./adapters/ . \
     --commit-message "Final: <primary_metric>=<best_value> after N experiments"
   ```
2. Final bucket sync:
   ```bash
   hf buckets sync . hf://buckets/${HF_USER}/autotrain-<goal>/ \
     --include "autotrain.*" --include "autotrain.jsonl" --include "*.log"
   ```
3. Tag the final version:
   ```bash
   hf repos tag ${HF_USER}/<model>-lora final --revision main
   ```

---

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Follow the phase order.** Data quality first, hyperparameters later. See Experiment Priority Order.
- **Simpler is better.** Removing complexity for equal performance = keep.
- **Don't thrash.** See Anti-Thrash Rules. Monitor your own pattern of results.
- **Track val_loss.** Always include val_loss as a secondary metric. Divergence from accuracy = overfitting.
- **Crashes:** fix if trivial, otherwise log and move on.
- **Think longer when stuck.** Re-read the data, study the model's errors, reason about what the model is actually learning. The best ideas come from understanding failure modes.
- **Doc discipline.** Update and commit `autotrain.md` after every keep and every 10 experiments.
- **Fresh validation.** Every 10 experiments or after every keep, run a fresh validation check.
- **Resuming:** if `autotrain.md` exists, read it + git log, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## HF CLI Quick Reference

The `hf` command (not deprecated `huggingface-cli`) is available. Key commands for fine-tuning:

| Command | Use Case |
|---------|----------|
| `hf auth whoami` | Get logged-in username for repo paths |
| `hf models info MODEL_ID` | Inspect base model (arch, size, config, tags) |
| `hf models ls --search "qwen" --sort downloads` | Search for candidate base models |
| `hf models ls --author ORG --filter TAG` | Filter models by org and task tag |
| `hf datasets info DATASET_ID` | Inspect dataset (size, schema, splits) |
| `hf datasets ls --search "your topic" --sort downloads` | Search for training datasets |
| `hf datasets parquet DATASET_ID` | Get parquet URLs for SQL queries |
| `hf datasets sql "SQL"` | Query datasets with DuckDB (explore, filter, profile) |
| `hf download REPO_ID --local-dir ./path` | Download model or dataset |
| `hf download REPO_ID --repo-type dataset` | Download a dataset specifically |
| `hf repos create REPO_ID --exist-ok` | Create adapter repo on Hub |
| `hf upload REPO_ID LOCAL_PATH PATH_IN_REPO` | Upload adapter/files to Hub |
| `hf buckets create BUCKET_ID` | Create a bucket for session logs |
| `hf buckets sync ./local hf://buckets/USER/BUCKET/` | Sync files to bucket |
| `hf repos tag REPO_ID TAG_NAME` | Tag a version (e.g., "final", "best") |

**Tips:**
- Use `--format json` on list/info commands for machine-readable output
- Use `-q` / `--quiet` to suppress progress bars in scripts
- Use `--include` / `--exclude` glob patterns to filter uploads/downloads
- Run `hf <command> --help` for full options

## Ideas Backlog

When you discover complex but promising ideas that you won't pursue right now, **append them as bullets to `autotrain.ideas.md`**. Tag each with its phase (P1/P2/P3/P4/P5). Don't let good ideas get lost.

On resume (context limit, crash), check `autotrain.ideas.md` — prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `run_experiment` + `log_experiment` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
