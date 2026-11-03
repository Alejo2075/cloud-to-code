# ADR 0003: Models propose, deterministic code decides

Status: accepted

Facts come from AWS evidence, not models. The deterministic planner produces the plan used for generation; a model-proposed or agent-proposed plan is accepted only if `verifyPlan` passes (existing resources and evidence, no fabricated decisions, ownership consistent with the user's decisions, no secrets). In standalone mode AI output is additionally labeled as hypothesis and written to a report, never applied. External model calls require consent bound to the exact data digest. This keeps the whole workflow usable offline and makes every generated property traceable.
