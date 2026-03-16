# Local Training Reference

## Hardware Auto-Detection

```bash
if [[ "$(uname -m)" == "arm64" ]] && [[ "$(uname)" == "Darwin" ]]; then
  # Apple Silicon Mac → mlx-lm (for SFT/LoRA) or native PyTorch (for other paradigms)
  HW="apple-silicon"
elif nvidia-smi &>/dev/null; then
  # NVIDIA GPU → unsloth (SFT, preferred), TRL+PEFT (fallback), or native PyTorch
  HW="nvidia"
else
  echo "ERROR: No supported local GPU. Use HF Jobs instead."
  exit 1
fi
```

Record the detected hardware in `autotrain.md` so resuming agents don't re-detect.

---

## mlx-lm (Apple Silicon)

**When to use:** `uname -m` returns `arm64` on macOS. Best for SFT/LoRA fine-tuning on Mac.

**Training command:**
```bash
mlx_lm.lora \
  --model <model_name_or_path> \
  --data <data_dir> \
  --train \
  --batch-size 2 \
  --num-layers 16 \
  --iters <steps> \
  --learning-rate 1e-5 \
  --adapter-path ./adapters
```

**GPU note:** Apple Silicon shares the GPU between training and display. Keep `--batch-size` <= 4 to avoid freezing the screen.

**LoRA rank:** Not a CLI flag — configure via YAML config file passed with `-c config.yaml` (e.g., `lora_parameters: {rank: 16}`).

**Typical hyperparameter ranges:**

| Param | Range | Notes |
|-------|-------|-------|
| `--batch-size` | 1-4 | **Default 2.** Larger batches can freeze macOS display (GPU starvation). |
| `--num-layers` | 8-32 | Number of layers to fine-tune. More = more capacity but slower. Use -1 for all. |
| `--iters` | 100-2000 | Start small, increase if undertrained |
| `--learning-rate` | 1e-6 to 1e-4 | 1e-5 is a safe default |

**Evaluation:**
```bash
mlx_lm.lora --model <model> --adapter-path ./adapters --data <data_dir> --test
```

**Export:** Adapter only (safetensors). Use `mlx_lm.fuse` to merge into base model.

### mlx-lm Gotchas (from real sessions)

**Separate train and eval invocations.** Running `--train` and `--test` in a single `mlx_lm.lora` call can trigger `Abort trap: 6` (SIGABRT) due to memory accumulation across validation passes. Peak memory grows with each eval pass and can hit system limits. The fix:
```bash
# Train only
mlx_lm.lora --model "$MODEL" --data ./data --train --adapter-path ./adapters ...

# Evaluate separately
mlx_lm.lora --model "$MODEL" --data ./data --test --adapter-path ./adapters ...
```

**Eval-only baseline (no adapter yet).** `mlx_lm.lora --test` tries to load adapters from `--adapter-path` (default `./adapters`). If no adapter exists yet, it crashes with a missing `adapter_config.json` error. For baseline eval without any adapter, pass `--adapter-path ""` explicitly.

**Data directory format.** mlx-lm expects `train.jsonl`, `valid.jsonl`, `test.jsonl` in `--data <dir>`. Each line must be a JSON object with a `"messages"` key containing a chat-format array:
```json
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```
The chat format must match the model's tokenizer chat template (e.g., Qwen uses `<|im_start|>`/`<|im_end|>` markers).

**`generate()` API.** The `temp=` kwarg was removed from `generate()`. Use `sampler=make_sampler(temp=0.0)` from `mlx_lm.sample_utils` instead.

**Invocation.** Use `mlx_lm.lora` (not `python -m mlx_lm.lora` which is deprecated). Alternatively: `python -m mlx_lm lora` (with a space, not a dot).

---

## unsloth (NVIDIA GPU)

**When to use:** `nvidia-smi` succeeds. Preferred over plain TRL for SFT — 2-5x faster, 50-70% less VRAM.

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
    lora_dropout=0,          # Required for fast kernels (non-zero falls back to slower path)
    bias="none",             # Required for fast kernels (other values fall back to slower path)
)
```

**Critical requirements for fast kernels:**
- `lora_dropout=0` — non-zero disables fast path
- `bias="none"` — non-none disables fast path

**Export options:**
- LoRA adapter only: `model.save_pretrained("lora_adapter")`
- Merged 16-bit: `model.save_pretrained_merged("merged", tokenizer)`
- GGUF: `model.save_pretrained_gguf("gguf", tokenizer, quantization_method="q4_k_m")` (30+ quant methods)

---

## TRL + PEFT (NVIDIA GPU, fallback)

**When to use:** When unsloth doesn't support the model architecture.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTConfig, SFTTrainer

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
    args=SFTConfig(
        per_device_train_batch_size=4,
        num_train_epochs=1,
        learning_rate=2e-4,
        output_dir="./outputs",
    ),
)
trainer.train()
```
