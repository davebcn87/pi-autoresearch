# Outside research advisor

The optional advisor uses `openai-codex/gpt-6-astra` to propose experiments or stop an exhausted search. Use a different model for the experimenter. Pi supplies the advisor model and authentication through its model registry.

Create `.auto/research.json` in the experiment directory:

```json
{
  "objective": "Reduce decoding latency while retaining label recognition",
  "constraints": ["Retain all baseline recognitions", "Avoid large memory increases"],
  "sourceFiles": ["src/decoder.ts"],
  "failureInterval": 3,
  "timeoutSeconds": 180
}
```

`objective` and `sourceFiles` are required. `constraints` defaults to an empty list. Source paths must point to production files inside the experiment directory. The advisor does not receive evaluation code.

Start the normal loop with `/autoresearch <goal>`. The advisor runs after the first kept result and after every configured number of consecutive unsuccessful experiments. Discards, crashes, and failed checks count toward this interval. `/autoresearch ideas` requests advice on demand.

Use the optional `approach` parameter on `run_experiment` to name the idea family. Approach names describe prior attempts; they do not prevent useful variants.

Each consultation starts with a fresh request containing the objective, constraints, current source, and experiment outcomes. Outcomes include the primary and secondary `METRIC` values parsed from benchmark output, check results, and failure diagnostics. Conversation messages, experiment descriptions, and agent hypotheses are excluded. Runs without captured output have unknown measurements. Context is limited to 200 KiB and individual results include at most 1,800 characters of failure diagnostics.

Astra compares the primary gain with secondary costs and source complexity. It returns one to three concrete ideas or a stop decision. Ideas are appended to `.auto/ideas.md`. Decisions and their input history are recorded in `.auto/ideation.jsonl`.

A stop decision disables experiment tools and automatic continuation. The agent can then report the accepted result. Start a new loop explicitly to resume experimentation. `/autoresearch off` cancels an active advisor request.

Advisor failures are reported and allow the normal loop to continue. Existing experiment and continuation limits remain active. The advisor does not change benchmark commands, correctness checks, keep/discard decisions, commits, or reverts.
