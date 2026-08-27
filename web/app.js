'use strict'

const $ = selector => document.querySelector(selector)
const state = {
  companies: [], jobs: [], agents: [], selectedCompanyIds: new Set(),
  sourceSettings: { built_in_sources: [], search_backend: { type: 'searxng', enabled: false, endpoint: '' }, websites: [] },
  selectedJobId: null, selectedJob: null, batchLimit: 5, concurrency: 2,
  pollTimer: null, clockTimer: null
}
const STATUS_LABELS = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', paused: '已暂停' }
const AGENT_STATUS_LABELS = { idle: '待执行', queued: '等待任务', running: '运行中', standby: '周期待命', completed: '已完成', revise_required: '需要修订', paused: '已暂停', failed: '失败', not_in_case: '不参与单案' }
const AGENT_LAYERS = [
  { stage: 'industry_chain_planning', number: '01', label: '前置研究规划层', note: '先定义要验证的产业链与证据需求' },
  { stage: 'information_collection_monitoring', number: '02', label: '公开证据层', note: '按规划采集、去重、存证和监控，不投票' },
  { stage: 'group_debate', number: '03', label: '三席独立决策层', note: '基于同一冻结证据完成授信方向与风控建议' },
  { stage: 'competition_calibration', number: '04', label: '单次校准审查层', note: '只从冻结候选中执行Action门槛与Risk exact-set审查' },
  { stage: 'periodic_improvement', number: '05', label: '周期改善层', note: '只读取外部结果与用户反馈，不改当次结论' }
]
const PHASE_LABELS = {
  queued: '等待调度', session_initialization: '初始化运行', industry_chain_planning: '产业链前置规划',
  evidence_intake: '统一公开证据建案', public_information_monitoring: '公开信息监控',
  joint_independent_decision: '联合决策 · 三席独立首轮', competition_joint_decision_initial: '联合决策 · 三席独立首轮',
  competition_joint_decision_self_review: '联合决策 · 差异广播与一次修订', competition_joint_decision: '三席结果冻结',
  single_pass_calibration: 'Program校准与单次Reviewer', competition_calibration: 'Program校准与单次Reviewer',
  credit_direction_initial: '授信方向 · 三席初始判断', credit_direction_self_review: '授信方向 · 差异自审',
  credit_direction: 'Action Calibration · 授信方向冻结', action_calibration: 'Action Calibration', risk_control_advice_initial: '风控建议 · 三席初始判断',
  risk_control_advice_self_review: '风控建议 · 差异自审', risk_control_advice: '风控建议冻结',
  risk_calibration: 'Risk Calibration', reviewer_selection: 'Reviewer Candidate Selection', champion_gate: 'Champion Gate',
  shadow_validation: '影子候选验证', aggregate_and_render: '聚合结论与报告QA',
  persist_artifacts: '产物落盘', complete: '任务完成'
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents()
  await Promise.allSettled([loadSystem(), loadCompanies(), loadJobs(), loadAgents(), loadSources()])
  state.pollTimer = window.setInterval(poll, 1300)
  state.clockTimer = window.setInterval(renderElapsed, 1000)
})

function bindEvents() {
  $('#company-search').addEventListener('input', renderCompanyChecklist)
  $('#intake-form').addEventListener('submit', submitBatch)
  $('#refresh-jobs').addEventListener('click', () => Promise.allSettled([loadJobs(), loadAgents()]))
  $('#source-form').addEventListener('submit', saveSources)
  $('#add-source').addEventListener('click', addSourceWebsite)
  $('#add-api-source').addEventListener('click', addSourceApi)
}

async function api(endpoint, options = {}) {
  const response = await fetch(endpoint, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`)
  return body
}

async function loadCompanies() {
  const { companies } = await api('/api/companies')
  state.companies = companies
  const valid = new Set(companies.filter(company => company.selectable).map(company => company.company_id))
  state.selectedCompanyIds = new Set([...state.selectedCompanyIds].filter(id => valid.has(id)))
  renderCompanyChecklist()
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs')
    state.jobs = jobs
    renderJobList()
    if (!state.selectedJobId && jobs[0]) await selectJob(jobs[0].job_id)
  } catch (error) { showMessage(error.message, 'error') }
}

async function loadAgents() {
  try {
    const { agents } = await api('/api/agents')
    state.agents = agents
    renderAgents()
  } catch {
    $('#agent-grid').innerHTML = '<p class="empty-state">Agent状态读取失败。</p>'
  }
}

async function loadSystem() {
  try {
    const { system, providers } = await api('/api/system')
    state.batchLimit = Number(system.batch_limit) || 5
    state.concurrency = Number(system.concurrency) || 2
    const healthyCount = (providers.profiles || []).filter(profile => profile.configured && !profile.alert_active).length
    const total = (providers.profiles || []).length
    const node = $('#system-health')
    const level = providers.healthy && providers.live_ready ? 'good' : providers.healthy ? 'warn' : 'bad'
    const readiness = providers.live_ready ? '实测凭证有效' : '实测凭证待刷新'
    node.innerHTML = `<span class="pulse ${level}"></span><span>逻辑角色 ${state.agents.length || '—'} · 模型通路 ${healthyCount}/${total} · ${readiness} · 运行 ${system.running_jobs}/${system.concurrency}</span>`
    node.title = [...(providers.profiles || []).map(profile => `${profile.profile_id}: ${profile.model} · ${profile.status}`), `readiness: ${providers.readiness_reason || (providers.live_ready ? 'ready' : 'unknown')}`].join('\n')
    $('#batch-notice').textContent = `单次最多进件${state.batchLimit}家；系统同时运行${state.concurrency}家，其余自动排队。完成后自动进入分析与报告落盘。`
    updateSelectionCount()
  } catch {
    $('#system-health').innerHTML = '<span class="pulse bad"></span><span>系统状态读取失败</span>'
  }
}

async function loadSources() {
  try {
    const { sources } = await api('/api/sources')
    state.sourceSettings = sources
    $('#searxng-endpoint').value = sources.search_backend?.endpoint || ''
    $('#searxng-enabled').checked = sources.search_backend?.enabled === true
    renderSources()
  } catch (error) {
    $('#built-in-sources').innerHTML = `<p class="form-message error">${escapeHtml(error.message)}</p>`
  }
}

function renderSources() {
  const builtIn = state.sourceSettings.built_in_sources || []
  $('#built-in-sources').innerHTML = builtIn.length ? builtIn.map(source => `
    <div class="source-item"><span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.source_type)} · ${escapeHtml(source.access_mode)}</small></span><span class="source-status">自动可用</span></div>`).join('') : '<p class="empty-state">暂无自动来源。</p>'
  const websites = state.sourceSettings.websites || []
  $('#user-sources').innerHTML = websites.length ? websites.map((source, index) => `
    <div class="source-item"><span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.connection_type === 'json_api' ? source.api?.endpoint : source.base_url)} · ${escapeHtml(source.source_type)} · ${source.connection_type === 'json_api' ? 'JSON API' : '网页检索'}</small></span><button type="button" data-remove-source="${index}">移除</button></div>`).join('') : '<p class="empty-state">尚未添加自定义网站或API。</p>'
  $('#user-sources').querySelectorAll('[data-remove-source]').forEach(button => button.addEventListener('click', () => {
    state.sourceSettings.websites.splice(Number(button.dataset.removeSource), 1)
    renderSources()
  }))
}

function addSourceWebsite() {
  const label = $('#source-label').value.trim()
  const baseUrl = $('#source-url').value.trim()
  const sourceType = $('#source-type').value
  if (!label || !baseUrl) { showSourceMessage('请填写网站名称和HTTPS网址。', 'error'); return }
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:') throw new Error('来源网站必须使用HTTPS。')
    if ((state.sourceSettings.websites || []).some(source => source.connection_type !== 'json_api' && new URL(source.base_url).hostname === parsed.hostname)) throw new Error('该网站已经存在。')
    state.sourceSettings.websites ||= []
    state.sourceSettings.websites.push({ label, base_url: parsed.origin, source_type: sourceType, data_category: sourceType, connection_type: 'web_search', enabled: true })
    $('#source-label').value = ''
    $('#source-url').value = ''
    renderSources()
    showSourceMessage('已加入草稿，请点击保存来源配置。')
  } catch (error) { showSourceMessage(error.message, 'error') }
}

function addSourceApi() {
  const label = $('#api-label').value.trim()
  const endpoint = $('#api-endpoint').value.trim()
  const sourceType = $('#api-source-type').value
  if (!label || !endpoint) { showSourceMessage('请填写API名称和HTTPS端点。', 'error'); return }
  try {
    const parsed = new URL(endpoint)
    if (parsed.protocol !== 'https:') throw new Error('来源API必须使用HTTPS。')
    if ((state.sourceSettings.websites || []).some(source => source.connection_type === 'json_api' && source.api?.endpoint === parsed.href)) throw new Error('该API已经存在。')
    const staticParameters = JSON.parse($('#api-static-parameters').value.trim() || '{}')
    state.sourceSettings.websites ||= []
    state.sourceSettings.websites.push({
      label,
      base_url: parsed.origin,
      source_type: sourceType,
      data_category: sourceType,
      connection_type: 'json_api',
      enabled: true,
      api: {
        endpoint: parsed.href,
        query_parameter: $('#api-query-parameter').value.trim() || 'q',
        static_parameters: staticParameters,
        mapping: {
          items_path: $('#api-items-path').value.trim() || 'data',
          title_field: $('#api-title-field').value.trim() || 'title',
          summary_field: $('#api-summary-field').value.trim() || 'summary',
          published_at_field: $('#api-date-field').value.trim() || 'published_at',
          url_field: $('#api-url-field').value.trim() || 'url'
        }
      }
    })
    $('#api-label').value = ''
    $('#api-endpoint').value = ''
    renderSources()
    showSourceMessage('API已加入草稿，请点击保存来源配置。')
  } catch (error) { showSourceMessage(error instanceof SyntaxError ? '固定参数必须是合法JSON对象。' : error.message, 'error') }
}

async function saveSources(event) {
  event.preventDefault()
  const endpoint = $('#searxng-endpoint').value.trim()
  const enabled = $('#searxng-enabled').checked
  if (enabled && !endpoint) { showSourceMessage('启用检索前请填写SearXNG地址。', 'error'); return }
  $('#save-sources').disabled = true
  try {
    const { sources } = await api('/api/sources', {
      method: 'PUT',
      body: JSON.stringify({
        contract_version: '1.0.0',
        search_backend: { type: 'searxng', enabled, endpoint },
        websites: state.sourceSettings.websites || []
      })
    })
    state.sourceSettings = sources
    renderSources()
    showSourceMessage(`已保存${sources.websites.length}个自定义网站。`, 'success')
  } catch (error) { showSourceMessage(error.message, 'error') } finally { $('#save-sources').disabled = false }
}

function showSourceMessage(message, type = '') {
  const node = $('#source-message')
  node.textContent = message || ''
  node.className = `form-message ${type}`
}

async function importCompanies() {
  const input = $('#company-file')
  const button = $('#import-button')
  const file = input.files?.[0]
  if (!file) { showImportMessage('请选择企业文件。', 'error'); return }
  button.disabled = true
  showImportMessage('正在校验并导入企业信息…')
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { result } = await api('/api/companies/import', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, content_base64: bytesToBase64(bytes) })
    })
    await loadCompanies()
    const importedIds = (result.companies || []).filter(company => company.selectable).map(company => company.company_id)
    for (const id of importedIds) {
      if (state.selectedCompanyIds.size >= state.batchLimit) break
      state.selectedCompanyIds.add(id)
    }
    renderCompanyChecklist()
    showImportMessage(`已导入${result.imported_count}家企业；可勾选后自动进件。`, 'success')
    input.value = ''
  } catch (error) { showImportMessage(error.message, 'error') } finally { button.disabled = false }
}

async function submitBatch(event) {
  event.preventDefault()
  const companyIds = [...state.selectedCompanyIds]
  if (!companyIds.length) { showMessage('请至少勾选一家企业。', 'error'); return }
  if (companyIds.length > state.batchLimit) { showMessage(`单次最多进件${state.batchLimit}家企业。`, 'error'); return }
  const button = $('#submit-button')
  button.disabled = true
  showMessage(`正在自动进件${companyIds.length}家企业…`)
  try {
    const { batch } = await api('/api/jobs/batch', {
      method: 'POST',
      body: JSON.stringify({ company_ids: companyIds, user_consent: true, consent_action: 'start_analysis' })
    })
    state.selectedCompanyIds.clear()
    renderCompanyChecklist()
    showMessage(`已进件${batch.accepted_count}家；${Math.min(batch.accepted_count, state.concurrency)}家开始运行，其余排队。`, 'success')
    state.selectedJobId = batch.jobs[0]?.job_id || null
    await Promise.all([loadJobs(), loadAgents()])
    if (state.selectedJobId) await selectJob(state.selectedJobId)
  } catch (error) { showMessage(error.message, 'error') } finally { button.disabled = false }
}

function renderCompanyChecklist() {
  const checklist = $('#company-checklist')
  const search = String($('#company-search')?.value || '').trim().toLowerCase()
  const companies = state.companies.filter(company => !search || `${company.company_id} ${company.company_name} ${company.industry}`.toLowerCase().includes(search))
  if (!companies.length) { checklist.innerHTML = '<p class="empty-state">没有匹配企业。</p>'; updateSelectionCount(); return }
  checklist.innerHTML = companies.map(company => {
    const checked = state.selectedCompanyIds.has(company.company_id)
    const disabled = !company.selectable
    const tag = company.case_available ? '<span class="company-tag">可直接分析</span>' : company.intake_required ? '<span class="company-tag intake">自动采集建案</span>' : '<span class="company-tag intake">缺少案例</span>'
    return `<label class="company-option ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}">
      <input type="checkbox" value="${escapeHtml(company.company_id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span><strong>${escapeHtml(company.company_id)} · ${escapeHtml(company.company_name)}</strong><small>${escapeHtml(company.industry || '行业未标注')}</small></span>${tag}
    </label>`
  }).join('')
  checklist.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener('change', () => toggleCompany(input.value, input.checked)))
  updateSelectionCount()
}

function toggleCompany(companyId, checked) {
  if (checked && state.selectedCompanyIds.size >= state.batchLimit) {
    showMessage(`单次最多进件${state.batchLimit}家企业。`, 'error')
    renderCompanyChecklist()
    return
  }
  if (checked) state.selectedCompanyIds.add(companyId)
  else state.selectedCompanyIds.delete(companyId)
  renderCompanyChecklist()
}

function updateSelectionCount() {
  $('#selection-count').textContent = `已选 ${state.selectedCompanyIds.size} / ${state.batchLimit}`
  $('#submit-button').disabled = state.selectedCompanyIds.size === 0
}

function showImportMessage(message, type = '') {
  const node = $('#import-message')
  node.textContent = message
  node.className = `field-hint ${type}`
}

function showMessage(message, type = '') {
  const node = $('#form-message')
  node.textContent = message || ''
  node.className = `form-message ${type}`
}

async function selectJob(jobId) {
  state.selectedJobId = jobId
  renderJobList()
  await refreshSelectedJob()
}

async function refreshSelectedJob() {
  if (!state.selectedJobId) return
  try {
    const [{ job }, logs] = await Promise.all([api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}`), api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/logs`)])
    state.selectedJob = job
    renderSelectedJob()
    renderLogs(logs)
  } catch (error) { $('#log-output').textContent = `状态读取失败：${error.message}` }
}

async function poll() {
  await Promise.allSettled([loadJobs(), loadSystem(), loadAgents(), refreshSelectedJob()])
}

function renderJobList() {
  const list = $('#job-list')
  if (!state.jobs.length) { list.innerHTML = '<p class="empty-state">暂无进件记录。</p>'; return }
  list.innerHTML = state.jobs.map(job => `
    <button type="button" class="job-card ${job.job_id === state.selectedJobId ? 'active' : ''}" data-job-id="${escapeHtml(job.job_id)}">
      <div class="job-card-top"><strong>${escapeHtml(job.company_id)} · ${escapeHtml(job.company_name)}</strong><span class="mini-status ${escapeHtml(job.status)}">${STATUS_LABELS[job.status] || job.status}</span></div>
      <p>${escapeHtml(PHASE_LABELS[job.phase] || (job.intake_required ? '等待公开证据建案' : '等待分析'))}</p>
    </button>`).join('')
  list.querySelectorAll('[data-job-id]').forEach(button => button.addEventListener('click', () => selectJob(button.dataset.jobId)))
}

function renderSelectedJob() {
  const job = state.selectedJob
  if (!job) return
  $('#job-status').textContent = STATUS_LABELS[job.status] || job.status
  $('#job-status').className = `status-badge ${job.status}`
  $('#job-title').textContent = `${job.company_id} · ${job.company_name}`
  $('#job-subtitle').textContent = job.intake_required ? '正在自动完成产业链规划、公开证据建案与分析。' : '使用已冻结企业案例执行标准授信分析。'
  $('#progress-fill').style.width = `${Math.max(0, Math.min(100, job.progress_percent || 0))}%`
  $('#progress-label').textContent = `${job.progress_percent || 0}%`
  $('#stage-label').textContent = PHASE_LABELS[job.phase] || job.phase || '等待调度'
  renderElapsed()
  renderPipeline(job)
  renderAgents()
  renderResult(job)
}

function renderElapsed() {
  const job = state.selectedJob
  if (!job?.started_at) { $('#elapsed-time').textContent = '—'; return }
  const end = job.completed_at ? Date.parse(job.completed_at) : Date.now()
  const seconds = Math.max(0, Math.floor((end - Date.parse(job.started_at)) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  $('#elapsed-time').textContent = hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

function renderPipeline(job) {
  const stateByStep = job.v2_state?.stages || {}
  const map = { evidence: 'evidence_collection', 'action-decision': 'action_decision', 'action-calibration': 'action_calibration', 'risk-decision': 'risk_decision', 'risk-calibration': 'risk_calibration', reviewer: 'reviewer_selection', 'champion-gate': 'champion_gate', finalization: 'finalization' }
  document.querySelectorAll('.pipeline-step').forEach(step => {
    const stage = stateByStep[map[step.dataset.step]]
    let status = stage?.status || 'pending'
    if (status === 'pending') status = 'waiting'
    if (job.status === 'succeeded') status = 'completed'
    step.className = `pipeline-step ${status === 'waiting' ? '' : status}`
    step.querySelector('.step-state').textContent = { waiting: '等待', running: '执行中', completed: '已通过', failed: '失败', paused: '已暂停' }[status] || status
  })
  const constraint = job.v2_state?.constraint || { status: 'pending', attempt: 0, max_attempts: 3 }
  const recovery = job.v2_state?.recovery || { count: 0, last_mode: null }
  $('#runtime-diagnostics').innerHTML = `
    <div><span>Constraint Check</span><strong>${escapeHtml(constraint.status === 'pending' ? '等待' : constraint.status)}</strong><small>Attempt ${escapeHtml(constraint.attempt || 0)}/${escapeHtml(constraint.max_attempts || 3)}</small></div>
    <div><span>Output Recovery</span><strong>${recovery.count ? `${escapeHtml(recovery.count)}次` : '未触发'}</strong><small>${escapeHtml(recoveryLabel(recovery.last_mode))}</small></div>`
}

function renderAgents() {
  const selectedStates = state.selectedJob?.agent_states || {}
  const displayedAgents = state.agents.map(agent => selectedStates[agent.agent_id] ? { ...agent, ...selectedStates[agent.agent_id] } : agent)
  const active = displayedAgents.filter(agent => agent.status === 'running')
  $('#active-agent-label').textContent = active.length ? `正在运行：${active.map(agent => agent.label).join('、')}` : '当前无Agent运行'
  if (!state.agents.length) { $('#agent-grid').innerHTML = '<p class="empty-state">尚未载入Agent配置。</p>'; return }
  const layers = AGENT_LAYERS.map(layer => ({ ...layer, agents: displayedAgents.filter(agent => agent.stage === layer.stage) })).filter(layer => layer.agents.length)
  $('#agent-grid').innerHTML = layers.map((layer, index) => `<section class="agent-layer agent-layer-${escapeHtml(layer.stage)}">
    <header class="agent-layer-head"><b>${layer.number}</b><div><h3>${layer.label}</h3><p>${layer.note}</p></div></header>
    <div class="agent-layer-cards">${layer.agents.map(agent => {
      const work = agent.phase ? PHASE_LABELS[agent.phase] || agent.phase : (agent.current_companies || []).map(item => `${item.company_id} · ${PHASE_LABELS[item.phase] || item.phase}`).join('；')
      const constraint = agent.validation_status ? `Constraint ${agent.validation_status} · Attempt ${agent.validation_attempt || 0}/${agent.validation_max_attempts || 3}` : ''
      const recovery = agent.recovery_applied ? recoveryLabel(agent.recovery_mode) : ''
      return `<article class="agent-card ${escapeHtml(agent.status)}">
      <div class="agent-card-head"><span class="agent-dot"></span><span class="agent-status">${AGENT_STATUS_LABELS[agent.status] || agent.status}</span></div>
      <h3>${escapeHtml(agent.label || agent.agent_id)}</h3>
      <p>${escapeHtml(agent.model_profile || '无模型配置')}</p>
      <p>${escapeHtml(work || (agent.status === 'standby' ? '只在周期改善时运行' : '当前没有执行任务'))}</p>
      ${constraint ? `<p>${escapeHtml(constraint)}</p>` : ''}
      ${recovery ? `<p>${escapeHtml(recovery)}</p>` : ''}
    </article>`
    }).join('')}</div>
  </section>${index < layers.length - 1 ? '<div class="agent-layer-arrow" aria-hidden="true">↓</div>' : ''}`).join('')
}

function renderResult(job) {
  const container = $('#result-content')
  if (job.status === 'failed' || job.status === 'interrupted') {
    const failure = job.failure || {}
    const assistance = (job.manual_assistance_requests || []).length ? `<br><br>需要人工协助：${escapeHtml(job.manual_assistance_requests.map(item => item.source_id || item.id).join('、'))}` : ''
    container.innerHTML = `<div class="failure-box"><strong>${escapeHtml(failure.code || 'RUN_FAILED')}</strong><br>${escapeHtml(failure.message || '任务未完成。')}${assistance}</div>`
    return
  }
  if (!job.result) { container.innerHTML = '<p class="empty-state">进件完成后在此显示正式结论。</p>'; return }
  const result = job.result
  const adviceDetails = result.risk_control_advice_details?.items || []
  const pool = result.reviewer_candidate_pool
  const selection = result.reviewer_selection
  container.innerHTML = `
    <div class="result-hero">
      <div class="metric-card"><span>授信调整方向</span><strong>action = ${escapeHtml(result.action)}</strong></div>
      <div class="metric-card"><span>信用风险方向</span><strong>${escapeHtml(result.risk_label || '—')}</strong></div>
      <div class="metric-card wide"><span>风控建议码</span><div class="advice-chips">${(result.risk_control_advice || []).map(item => `<b class="advice-chip">${escapeHtml(item)}</b>`).join('') || '—'}</div></div>
      <div class="metric-card"><span>正式可用</span><strong>${result.production_ready ? '是' : '否'}</strong></div>
      <div class="metric-card"><span>结论等级</span><strong>${escapeHtml(result.conclusion_grade || '—')}</strong></div>
      <div class="metric-card wide metric-card-technical"><span>运行模式</span><strong>${escapeHtml(result.decision_mode || '—')}</strong></div>
      <div class="metric-card wide metric-card-technical"><span>终态</span><strong>${escapeHtml(result.finalization_status || '—')}</strong></div>
    </div>
    ${(result.warnings || []).length ? `<div class="failure-box warning-box"><strong>协议告警（不阻断结论）</strong><br>${escapeHtml(result.warnings.join('、'))}</div>` : ''}
    ${pool ? `<section class="advice-detail-panel"><div class="advice-detail-heading"><strong>Reviewer Candidate Selection</strong><span>Reviewer只选择，Program展开真实值</span></div>
      <div class="candidate-grid"><div><b>Action Candidates</b>${(pool.action_candidates || []).map(item => `<p>${escapeHtml(item.id)} → ${escapeHtml(item.value)}</p>`).join('') || '<p>—</p>'}</div>
      <div><b>Risk Candidates</b>${(pool.risk_candidates || []).map(item => `<p>${escapeHtml(item.id)} → [${escapeHtml((item.value || []).join(','))}]</p>`).join('') || '<p>—</p>'}</div></div>
      <p class="selection-line">已选：${escapeHtml(selection?.selected_action_candidate_id || '—')} · ${escapeHtml(selection?.selected_risk_candidate_id || '—')} · Gate ${escapeHtml(result.champion_gate?.recommended_status || result.conclusion_grade || '—')}</p>
    </section>` : ''}
    <section class="advice-detail-panel" aria-label="风控建议详解">
      <div class="advice-detail-heading"><strong>风控建议详解</strong><span>结论码冻结后确定性查表，不参与模型推理</span></div>
      ${adviceDetails.length ? `<div class="advice-detail-list">${adviceDetails.map(item => `<article class="advice-detail-item">
        <b>${escapeHtml(item.code)} · ${escapeHtml(item.title)}</b>
        <p>${escapeHtml(item.description)}</p>
      </article>`).join('')}</div>` : '<p class="empty-state">无风控建议详解。</p>'}
    </section>
    <div class="artifact-links">
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/report" target="_blank" rel="noopener">报告 JSON</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/markdown" target="_blank" rel="noopener">Markdown</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/submission" target="_blank" rel="noopener">提交 CSV</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/manifest" target="_blank" rel="noopener">Manifest</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/run" target="_blank" rel="noopener">完整 Run</a>
    </div>`
}

function renderLogs(logs) {
  const output = $('#log-output')
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30
  output.textContent = logs.text || '日志尚未产生。'
  if ($('#auto-scroll').checked && (atBottom || state.selectedJob?.status === 'running')) output.scrollTop = output.scrollHeight
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return btoa(binary)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}
function pad(value) { return String(value).padStart(2, '0') }
function recoveryLabel(mode) {
  if (mode === 'decision_block') return 'Decision block extracted'
  if (mode === 'markdown') return 'Markdown decision extracted'
  if (mode === 'json_repair') return 'Output normalized'
  return mode ? `Output normalized · ${mode}` : '确定性规范化未触发'
}
