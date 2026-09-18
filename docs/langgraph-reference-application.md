# Governed collective decisions with LangGraph

This repository is a LangGraph reference application for decisions that require independent model judgement
without giving any model unrestricted control over the final result.

## What is technically distinct

LangGraph owns node execution and state movement. Rulora adds decision controls around model calls:

1. **Recovery** repairs only an explicit JSON or Markdown carrier. It rejects prose-only answers and conditional
   trees without an explicit final choice.
2. **Adapter** maps declared aliases and deterministic primitive types. It fails closed on a missing, illegal,
   or ambiguous business value.
3. **Program freeze** assigns IDs and a hash to the candidate pool.
4. **Constrained Reviewer** selects frozen IDs. Program expands the IDs; the reviewer cannot emit a new action
   or risk set.
5. **JSON delivery** is produced from the frozen selection and recorded with an audit trail.

This is stronger than claiming that structured output is "usually stable": every accepted transformation has a
testable invariant, and ambiguous content is rejected rather than guessed.

## Five-minute deterministic example

The minimal graph uses three fictional incident-response seats and does not require an API key:

```bash
npm install
npm run example:langgraph
npm run test:minimal
```

The three model fixtures deliberately contain normal JSON, fenced JSON, and JSON with a missing comma. The
accepted Action and Risk values remain unchanged after Recovery and Adapter. A separate negative test proves
that the Reviewer cannot invent an ID outside the frozen pool.

Graph:

```text
independent seats
      -> recover and adapt
      -> freeze candidate IDs + hash
      -> constrained reviewer selects IDs
      -> Program expands IDs
      -> JSON delivery
```

## Controlled information disclosure

Information boundaries are implemented as Program allowlists in `src/role-disclosure.js`, not only as prompt
instructions:

| Role | Receives | Does not receive |
| --- | --- | --- |
| Independent seat | task, public evidence | peer outputs, candidate pool, reviewer state, raw traces |
| Broadcast seat | compact peer candidate summary | raw peer model output, credentials, internal traces |
| Constrained reviewer | evidence and frozen candidate pool | hidden chain-of-thought, mutable candidates, provider secrets |
| Delivery | final decision and audit summary | raw model responses and internal runtime state |

The full credit-risk application adds bounded broadcast, quorum, checkpoints, replay, and human adjudication.
The minimal example intentionally shows only the smallest reusable control chain.

## Evidence required before making reliability claims

The repository currently proves deterministic examples and rejection paths. Broader claims should be published
only with a versioned corpus and the following measurements:

- carrier-recovery acceptance rate;
- business-value preservation rate on accepted repairs;
- false acceptance rate for ambiguous outputs;
- forbidden reviewer-selection rejection rate;
- role-view leakage rate;
- replay equivalence across repeated runs.

Model quality and business accuracy are separate questions. These controls can preserve and govern a model
decision; they do not prove that the underlying decision is correct.
