# Optimization Modules

Each optimization surface has versioned experiment code here.

```
optimization/
  current/
    standards.ts        → the active generator/metric for prompt standards
    model-routing.ts    → the active model selection logic
    ...
  experiments/
    exp-standards-001/
      generator.ts      → AxLLM setup (signature, instruction)
      metric.ts         → scoring function
      config.json       → hyperparams
      results.json      → outcomes after testing
    exp-standards-002/
      ...
```

`current/` is the live code used by composePrompt and other surfaces.
`experiments/` is the lab — each directory is an isolated attempt.

On promotion, the winning experiment's files get copied to `current/`.
Scope enforcement: experiments can only write to their own directory.
