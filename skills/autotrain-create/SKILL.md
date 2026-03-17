---
name: autotrain-create
description: Set up and run an autonomous model training loop. Runs on HF Jobs (cloud GPUs) by default or locally. Supports any training paradigm: SFT, DPO, GRPO, RL, pretraining, VLM fine-tuning, reward modeling, distillation. Use when asked to "train a model", "fine-tune", "run RL training", "pretrain", "distill", or "start autotrain".
---

# Autotrain

Autonomous training loop: gather requirements, prepare data or environments, train models, and optimize through structured experiment phases — running on **HF Jobs** (cloud GPUs, default) or locally on Apple Silicon / NVIDIA.

## Tools

- **`init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — runs command, times it, captures output.
- **`log_experiment`** — records result. `keep` auto-commits. `discard`/`crash`/`checks_failed` → `git checkout -- .` to revert. Always include secondary `metrics` dict. Dashboard: ctrl+x.

## Setup

Follow these steps **in order**. Do not skip steps.

### Step 0: Python Environment

**Local mode only.** If no virtual environment is active, create one with `uv venv && source .venv/bin/activate` before installing any packages.

**HF Jobs mode:** Skip this step — dependencies are declared inline in the training script (PEP 723) or via `--with` flags. The remote container handles its own environment.

### Step 1: Gather Requirements & Recon

Ask (or infer from context):
- **Training paradigm** — SFT / DPO / GRPO / RL / pretraining / VLM fine-tuning / reward modeling / distillation / other
- **Goal** — what capability are we training? (e.g., "code completion", "medical QA", "play Doom", "reward model for RLHF", "distill GPT-4 into a 3B model")
- **Model** — name, size, type (e.g., `Qwen/Qwen2.5-3B`, a policy network, or training from scratch)
- **Dataset or environment** — source, format, size, any filtering criteria. RL/games may use an environment instead of a static dataset.
- **Metric** — primary metric + direction (e.g., `exact_accuracy` higher is better, `episode_reward` higher is better)
- **Execution mode** — **HF Jobs** (default, recommended) or **local**. HF Jobs gives access to A100/H200 GPUs billed per-second, no local GPU required. Local is fine for Apple Silicon or if the user has a local NVIDIA GPU and prefers not to use cloud.
- **Constraints** — max training time, budget limits, must-not-touch files

**Immediately inspect the model and dataset on the Hub.** You must understand the model architecture before writing any training code — this prevents wasted time from wrong assumptions about chat templates, tokenizer behavior, target modules, or model type.

```bash
# Check who's logged in (needed for repo names later)
# NOTE: output contains ANSI codes — strip them when capturing:
# HF_USER=$(hf auth whoami 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' | xargs)
hf auth whoami

# Inspect the base model — architecture, size, tags, config
# CHECK THESE before writing any training code:
#   - pipeline_tag: "text-generation" vs "image-text-to-text" (VLM) vs other
#   - architecture: determines target_modules for LoRA, tokenizer behavior, chat template
#   - config: context length, hidden size, num layers (informs LoRA num_layers, max_seq_length)
# For text-only tasks, prefer a text-only model (pipeline_tag "text-generation")
# to avoid wasting parameters on unused vision components.
hf models info <model_id>

# If user is unsure about the model, search for candidates
hf models ls --search "qwen 3b" --sort downloads --limit 10
hf models ls --search "llama" --filter text-generation --sort downloads
hf models ls --author meta-llama --sort downloads --format json

# If dataset is on the Hub, inspect it
hf datasets info <dataset_id>

# Search for datasets if user doesn't have one yet (replace with your topic)
hf datasets ls --search "code" --sort downloads --limit 10
hf datasets ls --search "code instructions" --filter task_categories:text-generation

# Explore dataset structure and size with SQL (DuckDB)
# NOTE: hf datasets sql does NOT support HTTP wildcard globs (*.parquet).
# List individual shard URLs with `hf datasets parquet` and pass them as an array.
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

### Step 2: Select Execution Mode

#### HF Jobs (default)

Pick a hardware flavor based on model size. Use `hf jobs hardware` to see all options and current pricing.

| Model size | Recommended flavor | VRAM | Cost/hr |
|------------|-------------------|------|---------|
| < 1B | `t4-small` | 16 GB | ~$0.40 |
| 1–3B | `l4x1` | 24 GB | ~$0.80 |
| 3–7B | `a10g-small` | 24 GB | ~$1.00 |
| 7–13B | `a10g-large` or `a100-large` | 24–80 GB | $1.50–2.50 |
| 13B+ | `a100-large` or `h200` | 80–141 GB | $2.50–5.00 |
| Multi-GPU | `a100x4`, `h200x4`, etc. | 320+ GB | $10+ |

Verify the user is logged in and has credits:
```bash
hf auth whoami
```

Record the chosen flavor in `autotrain.md` so resuming agents reuse it. For HF Jobs specifics (script pattern, wrapper template, monitoring commands), see `references/hf-jobs.md`.

#### Local (alternative)

Auto-detect hardware and record it in `autotrain.md`. For hardware detection logic, framework-specific configs (mlx-lm, unsloth, TRL+PEFT), and **known gotchas** (e.g., mlx-lm Abort trap with combined train+test, eval-only baseline crashes, data format requirements), see `references/local.md`. Read it before writing any training code.

### Step 3: Create Branch

```bash
git checkout -b autotrain/<goal>-<date>
```

### Step 4: Read Source Files & Understand Model Architecture

Read any existing training scripts and evaluation code **deeply** before writing anything.

**Understand the model before writing training code.** After downloading or inspecting the model:
- Check the **tokenizer chat template** — your data formatting must match it exactly (e.g., Qwen uses `<|im_start|>`/`<|im_end|>`, Llama uses `[INST]`/`[/INST]`)
- Check **model architecture class** — determines LoRA target modules (e.g., `q_proj`, `v_proj` for most LLMs, but varies by architecture)
- Check **config.json** — `max_position_embeddings` (context length), `hidden_size`, `num_hidden_layers` inform training parameters
- If using a local framework, check what **data format** it expects (e.g., mlx-lm needs `{"messages": [...]}` JSONL — see `references/local.md`)

**HF Jobs mode:** Model and dataset are loaded from the Hub **inside the remote job** at runtime (via `load_dataset()` / `from_pretrained()`). No need to download locally — but you still need to explore the data locally with SQL before writing code.

**Local mode — download model and dataset:**
```bash
# Download model weights (cached, re-downloads only if needed)
hf download <model_id> --local-dir ./model

# Download dataset from the Hub
hf download <dataset_id> --repo-type dataset --local-dir ./data

# Or download specific files only
hf download <dataset_id> --repo-type dataset --include "*.parquet" --local-dir ./data
```

**Explore data with SQL before writing code (both modes):**
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

### Step 5: Define Evaluation Strategy

Choose the evaluation approach based on your training paradigm:

**Dataset-based** (SFT, DPO, reward modeling): Classic three-way split.

| Split | Purpose | Mutability |
|-------|---------|------------|
| **train** | Gradient updates | May be re-curated between experiments |
| **val** | Checkpoint selection (in-loop) | May be re-curated between experiments |
| **test** | Keep/discard decisions | **Fixed at session start. Never modify.** |

**Rollout-based** (RL, games, robotics): Fixed evaluation environment/seed, held-out episode set. Define the eval protocol (number of episodes, seeds, success criteria) and keep it fixed.

**Hybrid** (RLHF with reward model + environment): Both a held-out preference dataset and a fixed eval environment.

Additionally, prepare a **fresh validation** mechanism: a way to sample a different validation subset (or run different eval episodes) to catch overfitting to the test set.

**HF Jobs mode — upload splits to Hub:**
```bash
# Push splits to a private dataset on the Hub
# The training script loads them with load_dataset("${HF_USER}/autotrain-<goal>-data")
hf repos create ${HF_USER}/autotrain-<goal>-data --type dataset --exist-ok
hf upload ${HF_USER}/autotrain-<goal>-data ./splits/ . --repo-type dataset \
  --commit-message "Upload train/val/test splits"
```

### Step 6: Write `autotrain.md`, `autotrain.sh`, and training script

See templates below. Invest time making `autotrain.md` excellent — it's the session's living memory.

The agent writes the training code from scratch based on the paradigm. The skill does not prescribe what training code to write — only the structure around it. For execution-mode specifics, read the relevant reference file:
- HF Jobs: `references/hf-jobs.md` (script pattern, wrapper, monitoring)
- Local: `references/local.md` (framework configs, hardware gotchas)
- Hub integration: `references/hf-integration.md` (uploads, model cards, CLI reference)

### Step 7: Commit Before Any Experiment

```bash
git add autotrain.md autotrain.sh
git commit -m "autotrain: initial session setup"
```

**This commit MUST happen before running any experiment.** Late commits lose the baseline context.

### Step 8: Start the Loop

`init_experiment` → run baseline → `log_experiment` → start looping immediately.

---

## `autotrain.md` Template

This is the session's living memory. A fresh agent with no context should be able to read this file and continue effectively.

```markdown
# Autotrain: <goal>

## Objective
<What capability are we training? What does success look like?>

## Training Paradigm
<SFT / DPO / GRPO / RL / pretraining / VLM / reward modeling / distillation / other>

## Execution Mode
- **Mode**: <HF Jobs / local>
- **Hardware**: <e.g., HF Jobs a10g-small / Apple M2 Max 64GB / NVIDIA RTX 4090 24GB>
- **HF Jobs flavor**: <flavor name, if using Jobs>

## Model
- **Name**: <e.g., Qwen/Qwen2.5-3B, or "from scratch">
- **Type**: <pretrained LLM / policy network / reward model / etc.>
- **Size**: <parameters>

## Model Configuration
<Paradigm-dependent. Examples:>
<- SFT/DPO: LoRA rank/alpha, target modules, quantization>
<- RL: policy architecture, value head config>
<- VLM: which layers to unfreeze, vision encoder config>
<- Pretraining: full model, no adapter>
<- Reward modeling: reward head config>
<- Distillation: student model choice, distillation method (logit-based vs data-based), temperature>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, <name>, ...
- **Track secondary metrics for overfitting signal** — divergence between train and eval metrics signals overfitting

## Evaluation Strategy
- **Type**: <dataset-based / rollout-based / hybrid>
- **Source**: <dataset name/path or environment description>
- **Train**: <N examples / episodes, filters applied>
- **Val**: <N examples / episodes, filters applied>
- **Test**: <N examples / episodes — FIXED at session start, never modified>
- **Fresh validation**: <method for sampling different val subsets or eval episodes>

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
2. **Phase 2: Input & Output Format** — instruction template, chat format, reward signal design
3. **Phase 3: Model & Architecture Config** — LoRA rank, reward head, policy arch, layer unfreezing
4. **Phase 4: Training Hyperparameters** — LR, steps, batch size, scheduler
5. **Phase 5: Regularization** — only if overfitting is visible

## Anti-Thrash Rules
1. 5+ consecutive discards → stop, write notes, pivot to a different phase
2. Same metric +/-noise for 8+ experiments → change something structural
3. All current ideas are Phase 4 but Phase 1-3 not exhausted → go back up
4. 20+ min without improvement → run fresh validation, accept or fundamentally pivot
5. Track secondary metrics for overfitting signal — if eval metrics diverge from train metrics, stop and investigate

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

### HF Jobs mode

See `references/hf-jobs.md` for the full wrapper pattern. The wrapper submits `train.py` via `hf jobs uv run -d` (detached mode) with env vars for config, then polls for completion. NEVER use attached mode — it drops the connection on long jobs.

### Local mode

```bash
#!/bin/bash
set -euo pipefail

# Pre-check: fast syntax/import validation (<1s)
python -m compileall -q src/ || { echo "Syntax error"; exit 1; }

# Training
# <agent writes training command based on paradigm and framework>

# Evaluation on TEST split / eval environment (fixed holdout)
# <evaluation command here>

# Output metrics — one METRIC line per metric
# METRIC accuracy=0.847
# METRIC val_loss=1.234
# METRIC episode_reward=312.5
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

For RL/games: environment design, reward shaping, curriculum ordering.

For distillation: teacher model selection, generation of synthetic training data from the teacher, temperature/top-p for teacher outputs, filtering teacher outputs by quality.

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

### Phase 2: Input & Output Format

How you format the input/output matters enormously:
- **Instruction template**: System prompt, few-shot examples
- **Chat template**: Match the base model's expected format exactly
- **Target format**: JSON vs plain text, structured vs free-form
- **Target length**: Shorter outputs are easier to learn (if they retain information)
- **Special tokens**: Proper use of BOS/EOS/pad tokens
- **Reward signal design** (RL/DPO/GRPO): reward function, preference format, KL penalty weight
- **Teacher output format** (distillation): how to present teacher-generated data to the student — chain-of-thought, direct answers, or both

### Phase 3: Model & Architecture Config

Structural model decisions — same position in the sequence, scope depends on paradigm:
- **SFT/DPO**: LoRA rank (`r`: 8 → 16 → 32 → 64), target modules, alpha, layers
- **Distillation**: Student model size, whether to use logit-based (KL divergence from teacher) or data-based (train on teacher-generated text) distillation, intermediate layer matching
- **Reward modeling**: Reward head architecture, pooling strategy
- **RL**: Policy network architecture, value head config, shared vs separate networks
- **VLM**: Which layers to unfreeze, vision encoder config, projection layer
- **Pretraining**: Model size, architecture choices (usually fixed — skip this phase)

### Phase 4: Training Hyperparameters

Only tune these after Phases 1-3 are reasonably explored:
- **Learning rate**: Most impactful HP. Sweep 1e-6 to 1e-3 in log scale.
- **Steps/epochs**: Watch eval metrics to find the sweet spot before overfitting.
- **Batch size**: Larger = smoother gradients but fewer updates per epoch.
- **Scheduler**: Cosine, linear decay, constant with warmup.
- **Warmup**: 5-10% of total steps.

### Phase 5: Regularization

Only if overfitting is visible (eval metrics diverging from train metrics):
- **Weight decay**: 0.01-0.1
- **Dropout**: Where supported by the framework
- **Early stopping**: Monitor eval metrics, stop when they start degrading
- **Data augmentation**: If applicable to the task

**RULE: Do NOT jump to Phase 4 before exhausting Phases 1-2.** Data and format changes are almost always higher leverage than hyperparameter tuning.

---

## Validation Protocol

### Three-Way Split (dataset-based, mandatory for SFT/DPO/RM)

| Split | Used For | When |
|-------|----------|------|
| **train** | Gradient updates | Every training run |
| **val** | Checkpoint selection | In-loop, during training |
| **test** | Keep/discard decisions | After training, fixed at session start |

The test split is **sacred**. Never modify it, never train on it, never use it for checkpoint selection.

### Rollout-Based Evaluation (RL/games/robotics)

Fixed evaluation protocol: same seeds, same environment config, same number of episodes. The eval environment is sacred — never change it mid-session.

### Fresh Validation

**Every 10 experiments OR after every `keep`:** evaluate on a DIFFERENT random sample from the validation pool (or run different eval episodes). This catches overfitting to the test set.

How to implement:
- Keep a larger validation pool and sample from it
- Or use k-fold style rotation
- For RL: vary eval seeds while keeping the environment fixed
- Compare fresh validation results to test results — large divergence means the test set is being overfit

### Minimum Test Set Size Guidance

| Size | Reliability | Recommendation |
|------|-------------|----------------|
| <200 examples | Noisy | Treat +/-3% changes as ties |
| 200-1000 | Reasonable | Can trust +/-1.5% changes |
| >1000 | Good | Can trust +/-1% changes |

When the test set is small, require larger improvements before calling a `keep`.

---

## Anti-Thrash Rules

These rules prevent wasted compute from unproductive experiment cycles:

1. **5+ consecutive discards** → Stop. Write detailed notes about what you've tried. Pivot to a different phase entirely.
2. **Same metric +/-noise for 8+ experiments** → The current approach is exhausted. Change something structural (different phase, different data strategy, different architecture).
3. **All current ideas are Phase 4 but Phases 1-3 not exhausted** → Go back up. You're micro-optimizing when macro changes are still available.
4. **20+ minutes without improvement** → Run fresh validation to check if recent "improvements" were noise. Either accept current state or make a fundamental pivot.
5. **Track secondary metrics for overfitting signal** → If eval metrics diverge from train metrics (e.g., val_loss rising while accuracy improves, episode reward variance increasing), you're overfitting. Stop and investigate.

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

## HF Integration

For full HF Hub integration details (session setup, uploads after every `keep`, model cards, session end, CLI reference), see `references/hf-integration.md`.

---

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Follow the phase order.** Data quality first, hyperparameters later. See Experiment Priority Order.
- **Simpler is better.** Removing complexity for equal performance = keep.
- **Don't thrash.** See Anti-Thrash Rules. Monitor your own pattern of results.
- **Track secondary metrics.** Always include secondary metrics (val_loss, episode reward variance, eval-train gap). Divergence = overfitting.
- **Crashes:** fix if trivial, otherwise log and move on.
- **Think longer when stuck.** Re-read the data, study the model's errors, reason about what the model is actually learning. The best ideas come from understanding failure modes.
- **Doc discipline.** Update and commit `autotrain.md` after every keep and every 10 experiments.
- **Fresh validation.** Every 10 experiments or after every keep, run a fresh validation check.
- **HF integration.** After every `keep`, upload model output and sync session docs. See `references/hf-integration.md`.
- **Resuming:** if `autotrain.md` exists, read it + git log, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## Ideas Backlog

When you discover complex but promising ideas that you won't pursue right now, **append them as bullets to `autotrain.ideas.md`**. Tag each with its phase (P1/P2/P3/P4/P5). Don't let good ideas get lost.

On resume (context limit, crash), check `autotrain.ideas.md` — prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `run_experiment` + `log_experiment` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
