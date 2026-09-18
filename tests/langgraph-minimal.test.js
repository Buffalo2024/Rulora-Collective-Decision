const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, runMinimalExample } = require('../examples/langgraph-governed-minimal')
const { adaptCompetitionReviewerOutput } = require('../src/competition-output-adapter')
const { projectRoleContext } = require('../src/role-disclosure')

test('minimal LangGraph example preserves decisions across deterministic carrier repair', async () => {
  const result = await runMinimalExample(fixture)
  assert.deepEqual(result.final_decision, {
    action: -1,
    risk_control_advice: ['3'],
    source: 'program_expansion_of_frozen_candidate_ids'
  })
  assert.deepEqual(result.normalized_seats.map(item => item.action), [-1, -1, 0])
  assert.deepEqual(result.normalized_seats.map(item => item.risk_control_advice), [['3'], ['3'], ['6']])
  assert.ok(result.normalized_seats.some(item => item.recovery.repair_applied === true))
})

test('constrained reviewer cannot invent a decision outside frozen IDs', async () => {
  const result = await runMinimalExample(fixture)
  assert.throws(() => adaptCompetitionReviewerOutput({
    selected_action_candidate_id: 'candidate:invented:action',
    selected_risk_candidate_id: 'candidate:invented:risk',
    challenge_intent: true,
    evidence_strength: 'strong'
  }, { reviewCandidatePool: result.frozen_candidate_pool }), /outside the frozen candidate pool/)
})

test('role disclosure is an allowlist projection, not a prompt convention', () => {
  const source = {
    case_id: 'x', task: 'y', evidence: [], raw_seat_outputs: ['secret'],
    peer_candidate_summary: [{ candidate: 1 }], frozen_candidate_pool: { candidates: [] },
    internal_trace: { token: 'secret' }
  }
  assert.deepEqual(Object.keys(projectRoleContext(source, 'independent_seat')), ['case_id', 'task', 'evidence'])
  assert.deepEqual(Object.keys(projectRoleContext(source, 'constrained_reviewer')), ['case_id', 'task', 'evidence', 'frozen_candidate_pool'])
})
