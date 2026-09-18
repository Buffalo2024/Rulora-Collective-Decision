<p align="center">
  <img src="assets/brand/rulora-logo-256.png" width="128" alt="Rulora Logo">
</p>

# Rulora Collective Decision

A sanitized multi-agent control example for credit-risk research. It retains independent seats,
candidate pools, quorum, constrained reviewer selection, bounded loops, checkpoints, replay, and a local UI.
Real company data, competition datasets, credentials, local model configuration, and runtime traces are excluded.

It is an independent scenario repository for [Rulora](https://github.com/Buffalo2024/Rulora), alongside
[Report Agent](https://github.com/Buffalo2024/Rulora-Report-Agent) and
[AGTI](https://github.com/Buffalo2024/Rulora-AGTI).

This example remains under active research and development. Reproducible technical review and independently
evaluated improvements are welcome.

## Research limitation

The current direction and risk-advice accuracy is not high because the project lacks sufficient labeled
training and independent evaluation data. It must not be used for real credit approval, denial, pricing,
or any automated decision affecting a person or business.

## Numeric decision contract

- `action = -1`: risk increases; tighten credit direction;
- `action = 0`: risk remains broadly stable;
- `action = 1`: risk decreases; loosening may be evaluated;
- `risk_control_advice = ["1".."9"]`: deterministic catalog codes expanded by Program lookup.

These values are protocol codes, not subjective scores.

## Core boundaries

The LLM interprets evidence and proposes independent candidates. Program owns state, validation, statistics,
candidate pools, gates, and final results. Recovery repairs carriers only. Adapter never changes conclusions.
Reviewer selects frozen IDs only. Network, constraint, and broadcast loops are independently bounded.
Checkpoints resume failed nodes only. Improvement affects a future version, never the active run.

```bash
npm install
npm test
npm run example
npm run web
```

Public-source connectors are disabled by default. The included company case is fictional.

The local console includes 25 fictional demo companies, validated company import, progress views,
an exception dialogue, and a presentation-only privacy toggle. Each job owns an isolated model-call
checkpoint directory and can resume in place after failure or local-server restart without rerunning
successful nodes. If the three seats cannot freeze an Action direction, the workflow pauses before Risk
analysis and requires explicit human adjudication or a fresh three-seat analysis. Presentation privacy
changes visible browser labels only; it never changes backend records, model input, or delivery artifacts.

Contact: `zzjeff1993.agent@gmail.com`. The repository also includes a WeChat QR code at
`assets/contact/wechat-qr.jpg`; please mention `Collective Decision`. License: Apache-2.0.
