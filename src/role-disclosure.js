const ROLE_DISCLOSURE_POLICY = Object.freeze({
  independent_seat: Object.freeze(['case_id', 'task', 'evidence']),
  broadcast_seat: Object.freeze(['case_id', 'task', 'evidence', 'peer_candidate_summary']),
  constrained_reviewer: Object.freeze(['case_id', 'task', 'evidence', 'frozen_candidate_pool']),
  delivery: Object.freeze(['case_id', 'final_decision', 'audit_summary'])
})

function projectRoleContext(source, role) {
  const allowed = ROLE_DISCLOSURE_POLICY[role]
  if (!allowed) throw new Error(`unknown disclosure role: ${role}`)
  const result = {}
  for (const key of allowed) {
    if (source?.[key] !== undefined) result[key] = structuredClone(source[key])
  }
  return result
}

function assertRoleContext(source, role) {
  const allowed = new Set(ROLE_DISCLOSURE_POLICY[role] || [])
  if (!allowed.size) throw new Error(`unknown disclosure role: ${role}`)
  const unexpected = Object.keys(source || {}).filter(key => !allowed.has(key))
  if (unexpected.length) throw new Error(`${role} received forbidden fields: ${unexpected.join(', ')}`)
  return true
}

module.exports = { ROLE_DISCLOSURE_POLICY, assertRoleContext, projectRoleContext }
