const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { normalizeImportedRecords, parseCsv, rowsToRecords } = require('../src/company-import')
const { createWebServer } = require('../src/web-server')
const { RISK_CONTROL_ADVICE_CATALOG, describeRiskControlAdvice } = require('../src/risk-control-advice')
const { STANDARD_TASK, WebJobManager, resolveCompany } = require('../src/web-job-manager')

const companies = [
  { company_id: '001', company_name: '演示企业1号', industry: '制造业' },
  { company_id: '002', company_name: '演示企业2号', industry: '家具制造业' }
]

test('risk-control advice details are a deterministic display-only lookup', () => {
  assert.equal(Object.keys(RISK_CONTROL_ADVICE_CATALOG).length, 9)
  assert.deepEqual(describeRiskControlAdvice(['2', '6']), [
    { code: '2', title: '调低信用评级', description: '根据风险信号及时下调客户信用等级，触发相应风险应对机制' },
    { code: '6', title: '增加保证担保', description: '追加实控人、股东自然人连带担保或引入第三方保证人，强化还款保障' }
  ])
  assert.throws(() => describeRiskControlAdvice(['2', '2']), /duplicate/)
  assert.throws(() => describeRiskControlAdvice(['10']), /unknown/)
})

test('resolveCompany accepts explicit ID, ID in task, and unique company name', () => {
  assert.equal(resolveCompany(companies, { task: '', companyId: '1' }).company_id, '001')
  assert.equal(resolveCompany(companies, { task: '分析002的产业链风险', companyId: '' }).company_id, '002')
  assert.equal(resolveCompany(companies, { task: '请分析演示企业2号', companyId: '' }).company_id, '002')
  assert.throws(() => resolveCompany(companies, { task: '分析一家企业', companyId: '' }), /无法唯一识别/)
})

test('company import accepts the target CSV field format and rejects duplicate IDs', () => {
  const csv = '企业编号（company_id),企业名称,所属行业,统一社会信用代码,经营范围\n3,测试企业股份有限公司,软件和信息技术服务业,DEMO-TAX-003,软件开发与技术服务\n'
  const records = normalizeImportedRecords(rowsToRecords(parseCsv(csv)))
  assert.equal(records[0].company_id, '003')
  assert.equal(records[0].company_name, '测试企业股份有限公司')
  assert.throws(() => normalizeImportedRecords([...records, ...records]), /重复企业编号/)
})

test('WebJobManager persists runtime progress semantics, logs, agents, and result artifacts', async () => {
  const root = await createFixtureRoot()
  let receivedTask = null
  const fakeRunCase = async ({ outputDirectory, task, onProgress }) => {
    receivedTask = task
    await fs.mkdir(outputDirectory, { recursive: true })
    const artifacts = {
      run_json: path.join(outputDirectory, 'run.json'),
      report_json: path.join(outputDirectory, 'report.json'),
      report_markdown: path.join(outputDirectory, 'report.md'),
      submission_csv: path.join(outputDirectory, 'submission.csv'),
      manifest_json: path.join(outputDirectory, 'manifest.json')
    }
    await onProgress({ type: 'run_created', run_id: 'run-test', stage: 'session_initialization', evidence_count: 8 })
    await onProgress({ type: 'agent_started', run_id: 'run-test', stage: 'group_debate', phase: 'credit_direction_initial', agent_id: 'industry_chain_analyst' })
    await onProgress({ type: 'agent_completed', run_id: 'run-test', stage: 'group_debate', phase: 'credit_direction_initial', agent_id: 'industry_chain_analyst', validation_status: 'PASS', validation_attempt: 1, validation_max_attempts: 3, recovery_mode: 'decision_block', recovery_applied: true, warnings: ['SCHEMA_NORMALIZED'] })
    await onProgress({ type: 'phase_completed', run_id: 'run-test', stage: 'group_debate', phase: 'credit_direction', result: 'risk_flat', unanimous: true })
    await onProgress({ type: 'action_calibration_completed', run_id: 'run-test', stage: 'group_debate', phase: 'credit_direction', action: 0, threshold_passed: true })
    await onProgress({ type: 'risk_calibration_completed', run_id: 'run-test', stage: 'group_debate', phase: 'risk_control_advice', candidate_count: 1, preferred_candidate_set_id: 'risk:2,6' })
    await onProgress({ type: 'reviewer_candidate_pool_created', run_id: 'run-test', stage: 'competition_calibration', phase: 'reviewer_selection', candidate_pool: { action_candidates: [{ id: 'action:0', value: 0 }], risk_candidates: [{ id: 'risk:2,6', value: ['2', '6'] }] } })
    await onProgress({ type: 'reviewer_selection_completed', run_id: 'run-test', stage: 'competition_calibration', phase: 'reviewer_selection', selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:2,6', challenge_level: 'LOW' })
    await onProgress({ type: 'champion_gate_completed', run_id: 'run-test', stage: 'competition_calibration', phase: 'champion_gate', gate: 'REVIEW', decision_finalized: true, finalization_status: 'FINALIZED_WITH_WARNING' })
    await Promise.all(Object.values(artifacts).map(file => fs.writeFile(file, '{}\n', 'utf8')))
    return {
      run_id: 'run-test',
      consensus: {
        action: 0,
        risk_label: 'risk_flat',
        risk_control_advice: ['2', '6'],
        decision_mode: 'unanimous',
        conclusion_grade: 'A',
        evidence_coverage: { cited: 8, total: 8 }
      },
      report: {
        qa: { production_ready: true },
        debate_summary: { clean_gate_satisfied: true },
        submission_row: { company_id: '001', action: '0', risk_control_advice: '2,6' }
      },
      competition_finalization: {
        finalization_status: 'FINALIZED_WITH_WARNING',
        warnings: ['SCHEMA_NORMALIZED'],
        reviewer_candidate_pool: { action_candidates: [{ id: 'action:0', value: 0 }], risk_candidates: [{ id: 'risk:2,6', value: ['2', '6'] }] },
        calibration_reviewer: { selected_action_candidate_id: 'action:0', selected_risk_candidate_id: 'risk:2,6', challenge_level: 'LOW' },
        champion_gate: { recommended_status: 'REVIEW' }
      },
      artifacts
    }
  }
  const manager = new WebJobManager({ root, runCaseImpl: fakeRunCase, concurrency: 1 })
  await manager.initialize()
  assert.equal(manager.listAgents().length, 6)
  assert.equal(manager.listAgents().filter(agent => agent.stage === 'industry_chain_planning').length, 1)
  assert.equal(manager.listAgents().filter(agent => agent.stage === 'group_debate').length, 3)
  const created = await manager.createJob({ company_id: '001', user_consent: true, consent_action: 'start_analysis' })
  const finished = await waitForJob(manager, created.job_id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(receivedTask, STANDARD_TASK)
  assert.equal(finished.progress_percent, 100)
  assert.equal(finished.result.action, '0')
  assert.deepEqual(finished.result.risk_control_advice, ['2', '6'])
  assert.equal(finished.result.risk_control_advice_details.display_only, true)
  assert.deepEqual(finished.result.risk_control_advice_details.items.map(item => item.code), ['2', '6'])
  assert.equal(finished.agent_states.industry_chain_analyst.status, 'completed')
  assert.equal(finished.agent_states.industry_chain_analyst.validation_attempt, 1)
  assert.equal(finished.v2_state.constraint.revision_completed_count, 1)
  assert.equal(finished.v2_state.recovery.count, 1)
  assert.equal(finished.v2_state.reviewer_selection.selected_risk_candidate_id, 'risk:2,6')
  assert.equal(finished.v2_state.decision_finalized, true)
  assert.equal(finished.agent_states.improvement_supervisor.status, 'not_in_case')
  const logs = await manager.getLogs(created.job_id)
  assert.match(logs.text, /agent:start/)
  assert.match(logs.text, /action=0/)
  assert.equal(await manager.getArtifact(created.job_id, 'report'), finished.result.artifacts.report_json)
  const persisted = JSON.parse(await fs.readFile(path.join(root, '.runtime', 'web-ui', 'jobs', `${created.job_id}.json`), 'utf8'))
  assert.equal(persisted.status, 'succeeded')
})

test('WebJobManager creates a bounded multi-company batch and queues every selected company once', async () => {
  const root = await createFixtureRoot()
  const fakeRunCase = async ({ outputDirectory }) => {
    await fs.mkdir(outputDirectory, { recursive: true })
    const artifacts = Object.fromEntries(['run_json', 'report_json', 'report_markdown', 'submission_csv', 'manifest_json'].map(key => [key, path.join(outputDirectory, `${key}.json`)]))
    await Promise.all(Object.values(artifacts).map(file => fs.writeFile(file, '{}\n')))
    return {
      run_id: path.basename(outputDirectory),
      consensus: { action: 0, risk_label: 'risk_flat', risk_control_advice: ['2'], decision_mode: 'majority', conclusion_grade: 'B', evidence_coverage: 1 },
      report: { qa: { production_ready: true }, debate_summary: {}, submission_row: {} },
      artifacts
    }
  }
  const manager = new WebJobManager({ root, runCaseImpl: fakeRunCase, concurrency: 1, batchLimit: 2 })
  await manager.initialize()
  const batch = await manager.createBatch({ company_ids: ['001', '002'], user_consent: true, consent_action: 'start_analysis' })
  assert.equal(batch.accepted_count, 2)
  assert.ok(batch.jobs.every(job => job.user_consent === true && job.consent_action === 'start_analysis' && job.consent_time))
  assert.equal(new Set(batch.jobs.map(job => job.company_id)).size, 2)
  await Promise.all(batch.jobs.map(job => waitForJob(manager, job.job_id)))
  await assert.rejects(() => manager.createBatch({ company_ids: ['001', '002', '003'], user_consent: true, consent_action: 'start_analysis' }), /单次最多进件2家/)
  await assert.rejects(() => manager.createBatch({ company_ids: ['001'] }), /开始进件分析/)
})

test('failed job resumes in place with the same model-call checkpoint root', async () => {
  const root = await createFixtureRoot()
  const calls = []
  const fakeRunCase = async ({ outputDirectory, modelCallCheckpointRoot }) => {
    calls.push({ outputDirectory, modelCallCheckpointRoot })
    if (calls.length === 1) {
      const error = new Error('temporary upstream failure')
      error.code = 'PAUSED_UPSTREAM'
      throw error
    }
    await fs.mkdir(outputDirectory, { recursive: true })
    const artifacts = Object.fromEntries(['run_json', 'report_json', 'report_markdown', 'submission_csv', 'manifest_json'].map(key => [key, path.join(outputDirectory, `${key}.json`)]))
    await Promise.all(Object.values(artifacts).map(file => fs.writeFile(file, '{}\n')))
    return {
      run_id: 'resumed-run',
      consensus: { action: 0, risk_label: 'risk_flat', risk_control_advice: ['2'], decision_mode: 'majority', conclusion_grade: 'B', evidence_coverage: 1 },
      report: { qa: { production_ready: true }, debate_summary: {}, submission_row: {} },
      artifacts
    }
  }
  const manager = new WebJobManager({ root, runCaseImpl: fakeRunCase, concurrency: 1 })
  await manager.initialize()
  const created = await manager.createJob({ company_id: '001', user_consent: true, consent_action: 'start_analysis' })
  const failed = await waitForJob(manager, created.job_id)
  assert.equal(failed.status, 'paused')
  const resumed = await manager.resumeJob(created.job_id)
  assert.equal(resumed.job_id, created.job_id)
  assert.equal(resumed.resume_count, 1)
  const finished = await waitForJob(manager, created.job_id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].outputDirectory, calls[1].outputDirectory)
  assert.equal(calls[0].modelCallCheckpointRoot, calls[1].modelCallCheckpointRoot)
  assert.equal(calls[0].modelCallCheckpointRoot, path.join(calls[0].outputDirectory, 'model-call-checkpoints'))
})

test('imported enterprise is stored outside the frozen source dataset and becomes selectable for automatic intake', async () => {
  const root = await createFixtureRoot()
  const manager = new WebJobManager({ root, runCaseImpl: async () => { throw new Error('not called') } })
  await manager.initialize()
  const csv = Buffer.from('company_id,company_name,industry,unified_social_credit_code,business_scope\n003,测试企业股份有限公司,软件和信息技术服务业,DEMO-TAX-003,软件开发与技术服务\n').toString('base64')
  const result = await manager.importCompanies({ filename: 'companies.csv', content_base64: csv })
  assert.equal(result.imported_count, 1)
  const imported = manager.listCompanies().find(company => company.company_id === '003')
  assert.equal(imported.imported, true)
  assert.equal(imported.intake_required, true)
  assert.equal(imported.selectable, true)
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'examples', 'companies.json'))).records.length, 2)
})

test('web server exposes same-origin task APIs with security headers', async t => {
  const now = new Date().toISOString()
  const job = { job_id: 'web-001-test', company_id: '001', company_name: companies[0].company_name, status: 'queued', created_at: now }
  const manager = {
    initialize: async () => manager,
    listCompanies: () => companies.map(company => ({ ...company, case_available: true })),
    listAgents: () => [],
    sourceSettings: () => ({ built_in_sources: [], search_backend: { type: 'searxng', enabled: false, endpoint: '' }, websites: [] }),
    updateSourceSettings: async body => ({ built_in_sources: [], ...body }),
    listJobs: () => [job],
    createJob: async () => ({ ...job, task: STANDARD_TASK }),
    createBatch: async body => ({ accepted_count: body.company_ids.length, jobs: [job] }),
    resumeJob: async jobId => ({ ...job, job_id: jobId, status: 'queued', resume_count: 1 }),
    importCompanies: async () => ({ imported_count: 1, companies: [] }),
    getJob: async () => job,
    getLogs: async () => ({ text: 'ok\n', truncated: false }),
    systemSnapshot: () => ({ concurrency: 2, batch_limit: 5, running_jobs: 0, queued_jobs: 1, total_jobs: 1 })
  }
  const root = path.resolve(__dirname, '..')
  const { server } = await createWebServer({ root, manager })
  await listen(server)
  t.after(() => server.close())
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${base}/api/companies`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal((await response.json()).companies.length, 2)
  const privacyScript = await fetch(`${base}/presentation-privacy.js`)
  assert.equal(privacyScript.status, 200)
  assert.match(await privacyScript.text(), /RuloraPresentationPrivacy/)
  const created = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_id: '001', user_consent: true, consent_action: 'start_analysis' })
  })
  assert.equal(created.status, 202)
  assert.equal((await created.json()).job.task, STANDARD_TASK)
  const agentResponse = await fetch(`${base}/api/agents`)
  assert.equal(agentResponse.status, 200)
  const sourceResponse = await fetch(`${base}/api/sources`)
  assert.equal(sourceResponse.status, 200)
  const sourceUpdate = await fetch(`${base}/api/sources`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search_backend: { type: 'searxng', enabled: false, endpoint: '' }, websites: [] })
  })
  assert.equal(sourceUpdate.status, 200)
  const batchResponse = await fetch(`${base}/api/jobs/batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_ids: ['001'], user_consent: true, consent_action: 'start_analysis' })
  })
  assert.equal(batchResponse.status, 202)
  const resumeResponse = await fetch(`${base}/api/jobs/${job.job_id}/resume`, { method: 'POST' })
  assert.equal(resumeResponse.status, 202)
  assert.equal((await resumeResponse.json()).job.job_id, job.job_id)
})

async function createFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'risk-web-manager-'))
  const paths = [
    path.join(root, 'examples'),
    path.join(root, 'config'),
    path.join(root, '.runtime', 'formal-batch-test', 'companies', '001'),
    path.join(root, '.runtime', 'formal-batch-test', 'companies', '002')
  ]
  await Promise.all(paths.map(directory => fs.mkdir(directory, { recursive: true })))
  await fs.writeFile(path.join(root, 'examples', 'companies.json'), JSON.stringify({ records: companies }), 'utf8')
  await fs.writeFile(path.join(root, 'examples', 'company-case.json'), JSON.stringify({
    contract_version: '1.0.0', case_id: 'demo-template', as_of_date: '2026-01-01',
    company: { id: '001', company_id: '001', name: '演示企业', industry: '制造业', region: '示例地区' },
    evidence: []
  }), 'utf8')
  await fs.writeFile(path.join(root, 'config', 'agents.json'), JSON.stringify({ roles: [
    { id: 'industry_research_planner', label: '前置产业链研究规划员', stage: 'industry_chain_planning', model_profile: 'chain_reasoner' },
    { id: 'public_evidence_monitor', label: '公开信息采集与监控员', stage: 'information_collection_monitoring', model_profile: 'monitor_extractor' },
    { id: 'industry_chain_analyst', label: '产业链传导辩证分析师', stage: 'group_debate', model_profile: 'chain_reasoner', participates_in_debate: true },
    { id: 'risk_factor_analyst', label: '风险因子分析师', stage: 'group_debate', model_profile: 'factor_reasoner', participates_in_debate: true },
    { id: 'adversarial_reviewer', label: '辩论红队与证伪审计员', stage: 'group_debate', model_profile: 'red_team_reasoner', participates_in_debate: true },
    { id: 'improvement_supervisor', label: '专职改善席', stage: 'periodic_improvement', model_profile: 'credit_reasoner' }
  ] }), 'utf8')
  await fs.writeFile(path.join(root, 'config', 'public-sources.json'), JSON.stringify({ contract_version: '1.0.0', policy: {}, sources: [
    { id: 'cninfo', label: '巨潮资讯网', source_type: 'company_disclosure', adapter: 'cninfo', production_ingest_enabled: true, access_mode: 'public_json_api' },
    { id: 'manual', label: '人工来源', source_type: 'government_credit', adapter: null, production_ingest_enabled: false, access_mode: 'manual' }
  ] }), 'utf8')
  await fs.writeFile(path.join(root, '.runtime', 'formal-batch-test', 'companies', '001', 'case.json'), '{}\n', 'utf8')
  await fs.writeFile(path.join(root, '.runtime', 'formal-batch-test', 'companies', '002', 'case.json'), '{}\n', 'utf8')
  return root
}

async function waitForJob(manager, jobId) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const job = await manager.getJob(jobId)
    if (['succeeded', 'failed', 'interrupted', 'paused'].includes(job.status)) return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job did not finish')
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

test('exception dialog keeps manual adjudication actions hidden outside unresolved Action cases', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'web', 'index.html'), 'utf8')
  const css = await fs.readFile(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8')
  const app = await fs.readFile(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')
  assert.match(html, /id="exception-action-resolution" hidden/)
  assert.match(css, /\.exception-quick-actions\[hidden\]\s*\{\s*display:none!important\s*\}/)
  assert.match(app, /job\.failure\?\.code === 'PAUSED_ACTION_UNRESOLVED'/)
  assert.match(app, /exception-action-resolution'\)\.hidden = !unresolved/)
})
