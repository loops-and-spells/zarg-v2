# ROMA (Sentient) — folding lessons for zarg RLMs

Repo inspected: `sentient-agi/ROMA` @ `a6e3bb4` (2026-02-17), package `src/roma_dspy`. Paper: *ROMA: Recursive Open Meta-Agent Framework for Long-Horizon Multi-Agent Systems*, arXiv:2602.01848 (Feb 2026). File refs are `path:line` at that commit. **[F]** = fact (cited), **[I]** = my inference.

## 1. Core loop

- **[F]** There are five DSPy agent types: Atomizer, Planner, Executor, Aggregator and Verifier (`core/signatures/signatures.py:7-93`). Only the first four run in the solve state machine (`core/engine/solve.py:944-1005`). The Verifier is registered in the factory and config (`core/factory/agent_factory.py:46,55`), but nothing in `core/engine/` calls it. The paper also uses verifiers only for prompt optimization (GEPA+), not at runtime (arXiv html, GEPA+ section).
- **[F]** The state machine works like this. If `depth >= max_depth`, the node is force-executed (`solve.py:949-951`, `task_node.py:494-501`). Otherwise the Atomizer sets `node_type ∈ {PLAN, EXECUTE}`. An EXECUTE node runs the Executor. A PLAN node runs the Planner, then solves the subgraph, then runs the Aggregator (`solve.py:954-1003`, `runtime.py:521-527, 732-742`).
- **[F]** Depth defaults vary: `max_depth=2` in the `solve()` helpers (`solve.py:1286`), 5 in `config/defaults/config.yaml:49`, and 6 in `config/profiles/general.yaml:103`.
- **[F]** Plans are DAGs. The Planner emits `subtasks: List[SubTask]` plus `dependencies_graph: Dict[str, List[str]]` keyed by index (`signatures.py:22-41`). A `SubTask` has `goal, task_type, dependencies, result, context_input` (`base_models/subtask.py:6-21`). Invalid dependency indices and self-edges are **silently dropped** (`runtime.py:945-970`). Task types are `RETRIEVE | WRITE | THINK | CODE_INTERPRET | IMAGE_GENERATION` (`types/task_type.py:21-30`).
- **[F]** Parallelism works in waves. Each wave takes all ready nodes (every dependency completed) and runs them with `asyncio.gather` (`runtime.py:744-760, 1023-1047`). The event-driven path uses a worker pool with `max_concurrency` (default 5) (`engine/scheduler.py:179-186`, `config/schemas/base.py:186`). If no node is ready, the loop just `break`s (`runtime.py:754`), with no error.

## 2. What flows between levels

- **[F]** Every agent gets an XML `<context>` containing `overall_objective` (the root goal), the time, recursion info `{current_depth, max_depth, at_limit}` and the tool list (`core/context/manager.py:84-112, 338-367`).
- **[F]** Beyond that, each role gets different extra context (`runtime.py:428-443`):
  - The Executor gets the goals and full outputs of its dependency tasks, plus artifact references (`manager.py:171-215`).
  - The Planner gets its parent's result and the results of completed siblings (`manager.py:217-295`).
  - The Atomizer and Verifier get only the basic context.
- **[F]** A child returns a plain string. For the Executor that is `output: str, sources` (`signatures.py:55-58`). For the Aggregator it is `synthesized_result: str` (`signatures.py:75`). The Aggregator receives the child `SubTask`s with the full `result` strings and the dependency context (`runtime.py:1000-1021`).
- **[F]** No summarization or truncation step exists in the code. Results pass through as raw strings (`runtime.py:158-172`). The paper claims the Aggregator does "relevance-preserving compression" into the parent's target form (arXiv html §method). **[I]** In practice, that compression is just the Aggregator's LLM output.
- **[F]** Large intermediates go to an artifact store and are passed by reference. `ArtifactInjectionMode` can be `NONE | DEPENDENCIES (default) | SUBTASK | FULL`, and the code documents it as a way "to control scope and prevent context bloat" (`types/artifact_injection.py:11-35`).
- **[F]** The paper's cost table shows the Aggregator as the largest consumer: 33,476 input tokens per EQ-Bench chapter, against 3,554 for the Executor (Table 5).

## 3. Prompts (seed prompts, `prompt_optimization/prompts/seed_prompts/`)

- **Atomizer** (`atomizer_seed.py:9-52`). A task is ATOMIC "iff ALL are true":
  1. "Single deliverable"
  2. "Single executor suffices"
  3. "No inter-step dependencies … including implicit multi-hop reasoning"
  4. "No multi-output packaging"
  5. "No external coordination"

  The tie-breaker reads: "If a single executor can reasonably deliver the end result in one pass, choose EXECUTE; otherwise PLAN." The output must be exactly `{is_atomic, node_type}`.
- **Planner** (`planner_seed.py:20-78`). Key instructions:
  - "minimal, parallelizable subtasks with a precise, acyclic dependency graph"
  - "Minimality: Decompose only as much as necessary"
  - "MECE"
  - "prefer 3–8 total subtasks"
  - "clear, verifiable completion condition"
  - "If the goal is already atomic, return the minimal valid plan (often 1–3 subtasks)"
- **Aggregator** (`aggregator_seed.py:7-52`). Key instructions:
  - "Do not re-plan or re-execute"
  - "Use only provided child `result` content; do not invent facts"
  - explicit conflict-resolution order
  - "Missing or partial child results: produce the best faithful synthesis"
- **Verifier** (`verifier_seed.py`): `verdict: bool` plus `feedback`, with "ALL requirements must be met for true".
- **[I]** These map directly onto the Decisions service. The Atomizer is a yes/no with five named criteria. Planner task typing is a choice among 3–5 labels. Verifier output is a yes/no plus feedback. ROMA asks for none of these with probabilities or confidence.

## 4. Configuration (≈ presets / layers)

- **[F]** Model and toolkits are set per role. In the defaults, the Atomizer, Planner, Aggregator and Verifier run on Gemini 2.5 Flash, and the Executor runs on Claude Sonnet 4.5 (`config/defaults/config.yaml:9-43`). The `general` profile gives the Planner only WebSearch. The Executor gets E2B, WebSearch, File and Calculator tools and runs as `react` with `max_executions: 10` (`general.yaml:17-79`).
- **[F]** Executors can be chosen by task type through `agent_mapping.executors.{RETRIEVE,…}`, and the registry keys agents by `(AgentType, TaskType)` with a default fallback (`core/registry/agent_registry.py:121-159`, `config/examples/advanced/task_aware_mapping.yaml`).
- **[F]** `max_subtasks` is configured (`general.yaml:27`, `config/schemas/agents.py:236`), but no code outside the schema reads it, so it looks **unenforced**. It only works if the prompt honors it. There is no token or cost budget per node. The only limits are timeouts, retries, circuit breakers and depth (`general.yaml:101-122`).

## 5. Evaluation evidence (all self-reported; I did not reproduce any of it)

| Benchmark | ROMA | Backbone alone | Best other baseline cited |
|---|---|---|---|
| SEAL-0 | 45.9% (GLM-4.6) | 14.5% | Kimi-Researcher 36.0% |
| FRAMES | 82.3% | 71.2% | Kimi-Researcher 78.8% |
| SimpleQA | 93.9% | 91.9% | Perplexity DR 93.9% |
| EQ-Bench | 79.8 (DeepSeek-V3.1 + GEPA+) | 71.9 | Claude Sonnet 4.5 79.8 |
| AbGen | 4.93 (DeepSeek-V3.2-Exp) | — | deepseek-reasoner 4.90 |

Sources are arXiv Tables 1–4 and 6. The blog gives 45.6% for SEAL-0, which does not match the paper. The EQ-Bench row with 71.9 is ambiguous in my extraction: it is either the backbone or ROMA before optimization.

- **[F]** The paper contains **no ablation** that removes recursion, varies depth, or removes the Aggregator. The only ablation-like comparison is GEPA+ against no optimization and against GEPA.
- **[I]** Some of the "backbone alone" gap probably comes from search tool access rather than decomposition. I could not confirm whether the bare-model baselines had search.

## 6. Failure modes

- **[F] Paper §6:**
  - "Atomization and MECE planning can fail … redundant subtrees, missing subgoals."
  - The aggregator "may omit critical evidence or over-compress."
  - Parallelism "may increase total compute cost" and raises problems with tool budgets, rate limits and recovery.
  - It "does not eliminate long-context failure modes."
  - The blog cites compounding step error.
- **[F/I] Visible in the code:**
  - The Verifier is not in the loop, so nothing checks a result before it goes up.
  - Failed or partial children are absorbed silently by the Aggregator prompt ("best faithful synthesis").
  - Malformed DAG edges are dropped silently.
  - A deadlocked subgraph `break`s silently.
  - `max_subtasks` is unenforced.
  - Results are free-form strings, so nothing checks their structure.
  - The only depth control is a hard cap that forces execution.

## 7. Recommendations for zarg RLM folding [I unless cited]

1. **Separate the atomic-vs-decompose decision from planning.** Make it a Decisions yes/no over ROMA's five atomicity criteria (§3), each scored separately so their probabilities are visible. Route low-confidence cases to the preset's default instead of an LLM planner call. ROMA pays about 17.7k input tokens per Atomizer call (Table 5); a small local JEV model is much cheaper.
2. **Make the spawn graph the planner's type system.** ROMA's `task_type` routes to a per-type executor with its own model and tools (§4). In zarg the equivalent is: the planner may only emit child specs whose preset is an allowed edge in the spawn graph, and that edge fixes the child's layer (services, tools). The Planner/Executor tool split is the same idea as a planner layer having read-only or search services while an executor layer gets write access.
3. **Use a result Schema instead of strings.** ROMA's weakest link is `output: str`, which is aggregated by an LLM that "may omit critical evidence". Require every `Rlm.exec` to decode against the child's result Schema. A decode failure is an explicit error value the parent must handle. It must never be "best faithful synthesis".
4. **Keep the aggregator step but make it typed and optional.** When children return Schema values, the parent cell can often merge them in TypeScript deterministically. Spend an aggregation LLM turn only when the parent's Schema requires synthesis. The Aggregator is ROMA's biggest token cost (Table 5).
5. **Scope is stronger than ROMA's context control.** ROMA narrows context with artifact-injection modes and dependency-only results (§2). zarg's scope (graph subgraph, path globs) is stricter and can be enforced. Pass dependency results as decoded values, and pass large intermediates as artifact references, not inline text.
6. **Real budgets, not depth caps.** ROMA has only `max_depth` and an unenforced `max_subtasks`. Give each child a budget carved from the parent's budget, which bounds the fan-out cost of parallel spawns. Keep depth as a backstop, and forcing execution at the limit is sensible. Show `{depth, max_depth, budget_left}` in the child's context, as ROMA's `RecursionContext` does.
7. **Put verification in the loop, based on evidence.** Wire a check of each child's result before it folds into the parent: tests or a typecheck for code (the checks GEPA+ uses offline), and otherwise a Decisions yes/no plus confidence. If the check fails, retry or replan once, then surface the failure.
8. **Things not to copy:**
   - silent edge dropping and silent deadlock `break`
   - config knobs that nothing enforces
   - root-goal-only `overall_objective` as the sole alignment signal (pass a scope-limited brief instead)
   - claiming "IQ gain" without ablations
9. **Measure the gain yourselves.** ROMA gives no evidence that recursion helps. Run zarg's own ablation on a fixed task set: flat versus folded, depth 1/2/3, and aggregator on/off. Report cost with each result.

## Sources

- https://github.com/sentient-agi/ROMA (commit a6e3bb4; files cited above)
- https://arxiv.org/abs/2602.01848
- https://arxiv.org/html/2602.01848 (Tables 1–6, §6 Limitations)
- https://www.sentient.xyz/blog/recursive-open-meta-agent
- https://arxiv.org/abs/2503.08275 (WriteHERE, the heterogeneous recursive planning work ROMA builds on, per README)
