'use strict'

const $ = selector => document.querySelector(selector)
const presentationPrivacy = window.RuloraPresentationPrivacy.createController({ storage: window.localStorage })
const state = {
  companies: [], jobs: [], agents: [], selectedCompanyIds: new Set(),
  sourceSettings: { built_in_sources: [], search_backend: { type: 'searxng', enabled: false, endpoint: '' }, websites: [] },
  selectedJobId: null, selectedJob: null, batchLimit: 5, concurrency: 2,
  pollTimer: null, clockTimer: null, currentLogs: { text: '', truncated: false }, acknowledgedExceptions: new Set(), exceptionJob: null, exceptionIncidentToken: null
}
const STATUS_LABELS = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', paused: '已暂停' }
const AGENT_STATUS_LABELS = { idle: '待执行', queued: '等待任务', running: '运行中', standby: '周期待命', completed: '已完成', revise_required: '需要修订', paused: '已暂停', failed: '失败', not_in_case: '不参与单案' }
const AGENT_LAYERS = [
  { stage: 'industry_chain_planning', number: '01', label: '前置研究规划层', note: '先定义要验证的产业链与证据需求' },
  { stage: 'information_collection_monitoring', number: '02', label: '公开证据层', note: '按规划采集、去重、存证和监控，不投票' },
  { stage: 'group_debate', number: '03', label: '三席独立决策层', note: '基于同一冻结证据完成授信方向与风控建议' },
  { stage: 'competition_calibration', number: '04', label: '单次校准审查层', note: '只从冻结候选中执行授信门槛与完整方案审查' },
  { stage: 'periodic_improvement', number: '05', label: '周期改善层', note: '只读取外部结果与用户反馈，不改当次结论' }
]
const PHASE_LABELS = {
  queued: '等待调度', session_initialization: '初始化运行', industry_chain_planning: '产业链前置规划',
  evidence_intake: '统一公开证据建案', public_information_monitoring: '公开信息监控',
  joint_independent_decision: '联合决策 · 三席独立首轮', competition_joint_decision_initial: '联合决策 · 三席独立首轮',
  competition_joint_decision_self_review: '联合决策 · 差异广播与一次修订', competition_joint_decision: '三席结果冻结',
  single_pass_calibration: '程序校准与单次复核', competition_calibration: '程序校准与单次复核',
  credit_direction_initial: '授信方向 · 三席初始判断', credit_direction_self_review: '授信方向 · 差异自审',
  credit_direction: '授信方向校准与冻结', action_calibration: '授信方向校准', risk_control_advice_initial: '风控建议 · 三席初始判断',
  risk_control_advice_self_review: '风控建议 · 差异自审', risk_control_advice: '风控建议冻结',
  risk_calibration: '完整方案冻结', reviewer_selection: '复核已有候选', champion_gate: '交付门禁',
  shadow_validation: '影子候选验证', aggregate_and_render: '聚合结论与报告QA',
  persist_artifacts: '产物落盘', complete: '任务完成'
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents()
  syncPresentationPrivacyControls()
  await Promise.allSettled([loadSystem(), loadCompanies(), loadJobs(), loadAgents(), loadSources()])
  state.pollTimer = window.setInterval(poll, 1300)
  state.clockTimer = window.setInterval(renderElapsed, 1000)
})

function bindEvents() {
  $('#presentation-privacy-toggle').addEventListener('change', event => {
    presentationPrivacy.setEnabled(event.target.checked)
    rerenderPresentationSurface()
  })
  $('#company-search').addEventListener('input', renderCompanyChecklist)
  $('#intake-form').addEventListener('submit', submitBatch)
  $('#company-import-form').addEventListener('submit', importCompanyRecord)
  $('#import-button').addEventListener('click', importCompanies)
  $('#company-file').addEventListener('change', event => { $('#company-file-name').textContent = event.target.files?.[0]?.name || '支持 CSV、Excel、JSON' })
  $('#refresh-jobs').addEventListener('click', () => Promise.allSettled([loadJobs(), loadAgents()]))
  $('#source-form').addEventListener('submit', saveSources)
  $('#add-source').addEventListener('click', addSourceWebsite)
  $('#add-api-source').addEventListener('click', addSourceApi)
  $('#exception-confirm').addEventListener('click', acknowledgeCurrentException)
  $('#exception-dialog').addEventListener('close', acknowledgeCurrentException)
  $('#exception-command-form').addEventListener('submit', submitExceptionCommand)
  document.querySelectorAll('[data-exception-command]').forEach(button => button.addEventListener('click', () => handleExceptionCommand(button.dataset.exceptionCommand)))
  document.querySelectorAll('[data-action-resolution]').forEach(button => button.addEventListener('click', () => resolveActionDisagreement(button.dataset.actionResolution)))
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
  presentationPrivacy.registerCompanies(companies)
  const valid = new Set(companies.filter(company => company.selectable).map(company => company.company_id))
  state.selectedCompanyIds = new Set([...state.selectedCompanyIds].filter(id => valid.has(id)))
  renderCompanyChecklist()
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs')
    state.jobs = jobs
    presentationPrivacy.registerJobs(jobs)
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
    node.title = displayText([...(providers.profiles || []).map(profile => `${profile.profile_id}: ${profile.model} · ${profile.status}`), `readiness: ${providers.readiness_reason || (providers.live_ready ? 'ready' : 'unknown')}`].join('\n'))
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
    $('#built-in-sources').innerHTML = `<p class="form-message error">${displayHtml(error.message)}</p>`
  }
}

function renderSources() {
  const builtIn = state.sourceSettings.built_in_sources || []
  const sourceCard = source => `<div class="source-item"><span><strong>${displayHtml(source.label)}</strong><small>${displayHtml(sourceTypeLabel(source.source_type))} · ${displayHtml((source.claims || []).join('、') || '按来源规则访问')}</small></span><span class="source-status ${source.automatic ? '' : 'pending'}">${source.automatic ? '已接通' : '已预设'}</span></div>`
  const connected = builtIn.filter(source => source.automatic)
  const preset = builtIn.filter(source => !source.automatic)
  $('#built-in-sources').innerHTML = `${connected.length ? `<div class="source-group-label">已接通来源</div>${connected.map(sourceCard).join('')}` : ''}${preset.length ? `<details class="preset-source-group"><summary>已预设来源 <span>${preset.length}项</span></summary><div class="source-list">${preset.map(sourceCard).join('')}</div></details>` : ''}` || '<p class="empty-state">暂无预设来源。</p>'
  const websites = state.sourceSettings.websites || []
  $('#user-sources').innerHTML = websites.length ? websites.map((source, index) => `
    <div class="source-item"><span><strong>${displayHtml(source.label)}</strong><small>${displayHtml(source.connection_type === 'json_api' ? source.api?.endpoint : source.base_url)} · ${displayHtml(source.source_type)} · ${source.connection_type === 'json_api' ? 'JSON API' : '网页检索'}</small></span><button type="button" data-remove-source="${index}">移除</button></div>`).join('') : '<p class="empty-state">尚未添加自定义网站或API。</p>'
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
  node.textContent = displayText(message || '')
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

async function importCompanyRecord(event) {
  event.preventDefault()
  const button = $('#import-record-button')
  const record = { company_name: $('#import-company-name').value.trim(), taxpayer_id: $('#import-taxpayer-id').value.trim(), industry: $('#import-industry').value.trim(), business_scope: $('#import-business-scope').value.trim() }
  button.disabled = true
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ records: [record] }))
    const { result } = await api('/api/companies/import', { method: 'POST', body: JSON.stringify({ filename: 'web-company-import.json', content_base64: bytesToBase64(bytes) }) })
    const imported = result.companies?.[0]
    await loadCompanies(); if (imported?.company_id && state.selectedCompanyIds.size < state.batchLimit) state.selectedCompanyIds.add(imported.company_id)
    renderCompanyChecklist(); $('#company-import-form').reset(); showImportMessage(`企业已导入，系统编号为 ${Number(imported?.company_id)}；已加入待分析列表。`, 'success')
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
  const companies = state.companies.filter(company => !search || presentationPrivacy.visibleSearchText(company).toLowerCase().includes(search))
  if (!companies.length) { checklist.innerHTML = '<p class="empty-state">没有匹配企业。</p>'; updateSelectionCount(); return }
  checklist.innerHTML = companies.map(company => {
    const checked = state.selectedCompanyIds.has(company.company_id)
    const disabled = !company.selectable
    const tag = company.case_available ? '<span class="company-tag">可直接分析</span>' : company.intake_required ? '<span class="company-tag intake">自动采集建案</span>' : '<span class="company-tag intake">缺少案例</span>'
    return `<label class="company-option ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}">
      <input type="checkbox" value="${escapeHtml(company.company_id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span><strong>${displayHtml(displayCompanyLabel(company))}</strong><small>${displayHtml(company.industry || '行业未标注')}</small></span>${tag}
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
  node.textContent = displayText(message)
  node.className = `field-hint ${type}`
}

function showMessage(message, type = '') {
  const node = $('#form-message')
  node.textContent = displayText(message || '')
  node.className = `form-message ${type}`
}

async function selectJob(jobId, { forceExceptionDialog = false } = {}) {
  state.selectedJobId = jobId
  renderJobList()
  await refreshSelectedJob({ forceExceptionDialog })
}

async function refreshSelectedJob({ forceExceptionDialog = false } = {}) {
  if (!state.selectedJobId) return
  try {
    const [{ job }, logs] = await Promise.all([api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}`), api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/logs`)])
    state.selectedJob = job
    presentationPrivacy.registerJobs([job])
    state.currentLogs = logs
    renderSelectedJob({ forceExceptionDialog })
    renderLogs(logs)
  } catch (error) { $('#log-output').textContent = displayText(`状态读取失败：${error.message}`) }
}

async function poll() {
  await Promise.allSettled([loadJobs(), loadSystem(), loadAgents(), refreshSelectedJob()])
}

function renderJobList() {
  const list = $('#job-list')
  if (!state.jobs.length) { list.innerHTML = '<p class="empty-state">暂无进件记录。</p>'; return }
  list.innerHTML = state.jobs.map(job => `
    <button type="button" class="job-card ${job.job_id === state.selectedJobId ? 'active' : ''}" data-job-id="${escapeHtml(job.job_id)}">
      <div class="job-card-top"><strong>${displayHtml(displayCompanyLabel(job))}</strong><span class="mini-status ${escapeHtml(job.status)}">${displayHtml(STATUS_LABELS[job.status] || job.status)}</span></div>
      <p>${displayHtml(PHASE_LABELS[job.phase] || (job.intake_required ? '等待公开证据建案' : '等待分析'))}</p>
    </button>`).join('')
  list.querySelectorAll('[data-job-id]').forEach(button => button.addEventListener('click', () => selectJob(button.dataset.jobId, { forceExceptionDialog: true })))
}

function renderSelectedJob({ forceExceptionDialog = false } = {}) {
  const job = state.selectedJob
  if (!job) return
  $('#job-status').textContent = displayText(STATUS_LABELS[job.status] || job.status)
  $('#job-status').className = `status-badge ${job.status}`
  $('#job-title').textContent = displayCompanyLabel(job)
  $('#job-subtitle').textContent = job.intake_required ? '正在自动完成产业链规划、公开证据建案与分析。' : '使用已冻结企业案例执行标准授信分析。'
  $('#progress-fill').style.width = `${Math.max(0, Math.min(100, job.progress_percent || 0))}%`
  $('#progress-label').textContent = `${job.progress_percent || 0}%`
  $('#stage-label').textContent = PHASE_LABELS[job.phase] || job.phase || '等待调度'
  renderElapsed()
  renderPipeline(job)
  renderAgents()
  renderResult(job)
  showExceptionDialog(job, { force: forceExceptionDialog })
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
    <div><span>约束检查</span><strong>${escapeHtml(constraint.status === 'pending' ? '等待' : constraint.status)}</strong><small>第 ${escapeHtml(constraint.attempt || 0)}/${escapeHtml(constraint.max_attempts || 3)} 次</small></div>
    <div><span>格式恢复</span><strong>${recovery.count ? `${escapeHtml(recovery.count)}次` : '未触发'}</strong><small>${escapeHtml(recoveryLabel(recovery.last_mode))}</small></div>`
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
      const work = agent.phase ? PHASE_LABELS[agent.phase] || agent.phase : (agent.current_companies || []).map(item => `${displayCompanyLabel(item)} · ${PHASE_LABELS[item.phase] || item.phase}`).join('；')
      const constraint = agent.validation_status ? `约束检查 ${agent.validation_status} · 第 ${agent.validation_attempt || 0}/${agent.validation_max_attempts || 3} 次` : ''
      const recovery = agent.recovery_applied ? recoveryLabel(agent.recovery_mode) : ''
      return `<article class="agent-card ${escapeHtml(agent.status)}">
      <div class="agent-card-head"><span class="agent-dot"></span><span class="agent-status">${AGENT_STATUS_LABELS[agent.status] || agent.status}</span></div>
      <h3>${displayHtml(agent.label || agent.agent_id)}</h3>
      <p>${displayHtml(agent.model_profile || '无模型配置')}</p>
      <p>${displayHtml(work || (agent.status === 'standby' ? '只在周期改善时运行' : '当前没有执行任务'))}</p>
      ${constraint ? `<p>${displayHtml(constraint)}</p>` : ''}
      ${recovery ? `<p>${displayHtml(recovery)}</p>` : ''}
    </article>`
    }).join('')}</div>
  </section>${index < layers.length - 1 ? '<div class="agent-layer-arrow" aria-hidden="true">↓</div>' : ''}`).join('')
}

function exceptionIncidentToken(job) {
  if (!job?.job_id) return null
  const failure = job.failure || {}
  return [job.job_id, job.status, job.completed_at || job.updated_at || '', job.resume_count || 0, failure.code || '', failure.message || ''].join('|')
}
function acknowledgeCurrentException() {
  if (state.exceptionIncidentToken) state.acknowledgedExceptions.add(state.exceptionIncidentToken)
}
function showExceptionDialog(job, { force = false } = {}) {
  if (!['failed', 'paused', 'interrupted'].includes(job?.status)) return
  const incidentToken = exceptionIncidentToken(job)
  if (!force && state.acknowledgedExceptions.has(incidentToken)) return
  const dialog = $('#exception-dialog')
  if (!dialog) return
  // Polling refreshes the selected job frequently. Keep an open conversation
  // intact for the same incident instead of clearing its messages every poll.
  if (dialog.open && state.exceptionIncidentToken === incidentToken && !force) return
  const issue = exceptionExplanation(job)
  state.exceptionJob = job
  state.exceptionIncidentToken = incidentToken
  $('#exception-chat').innerHTML = ''
  appendExceptionMessage('agent', `我是运行协调Agent。当前问题：${issue.message}`)
  $('#exception-company').textContent = displayCompanyLabel(job)
  $('#exception-title').textContent = issue.title
  $('#exception-message').textContent = issue.message
  $('#exception-guidance').textContent = issue.guidance
  const unresolved = job.failure?.code === 'PAUSED_ACTION_UNRESOLVED'
  $('#exception-default-actions').hidden = unresolved
  $('#exception-action-resolution').hidden = !unresolved
  if (!dialog.open) dialog.showModal()
}
function appendExceptionMessage(role, message) {
  const chat = $('#exception-chat')
  const node = document.createElement('div')
  node.className = `exception-message ${role}`
  node.innerHTML = `<b>${role === 'user' ? '你' : '运行协调Agent'}</b><p>${escapeHtml(message)}</p>`
  chat.appendChild(node); chat.scrollTop = chat.scrollHeight
}
function submitExceptionCommand(event) { event.preventDefault(); const input = $('#exception-command'); const value = input.value.trim(); if (!value) return; input.value = ''; handleExceptionCommand(value) }
async function handleExceptionCommand(command) {
  const job = state.exceptionJob
  if (!job) return
  appendExceptionMessage('user', command)
  if (/断点|恢复|重试|继续|重新|再运行/.test(command)) {
    if (state.resumeRequestPending) { appendExceptionMessage('agent', '恢复请求已经提交，请等待当前操作完成。'); return }
    state.resumeRequestPending = true
    document.querySelectorAll('[data-exception-command]').forEach(button => { button.disabled = true })
    appendExceptionMessage('agent', '收到。我会沿用原任务断点；已经完成的节点不重复调用，只执行失败和未完成节点。')
    try {
      const { job: resumed } = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume`, { method:'POST' })
      acknowledgeCurrentException()
      state.exceptionJob = resumed
      state.selectedJobId = resumed.job_id
      appendExceptionMessage('agent', `已从断点恢复：${displayCompanyLabel(resumed)}。任务编号保持不变，可查看继续运行的进度。`)
      await Promise.all([loadJobs(), loadAgents()])
    } catch (error) { appendExceptionMessage('agent', `未能从断点恢复：${error.message}`) }
    finally { state.resumeRequestPending = false; document.querySelectorAll('[data-exception-command]').forEach(button => { button.disabled = false }) }
    return
  }
  if (/原因|为什么|解释|详情/.test(command)) { const issue=exceptionExplanation(job); appendExceptionMessage('agent', issue.detail || `${issue.title}。${issue.message} ${issue.guidance}`); return }
  if (/暂不|关闭|稍后|忽略/.test(command)) { acknowledgeCurrentException(); appendExceptionMessage('agent', '已记录为暂不处理。本次结果不会进入正式交付。'); return }
  appendExceptionMessage('agent', '我可以执行“从断点继续”、说明“失败原因”，或将任务标记为“暂不处理”。请明确选择一种处理方式。')
}

async function resolveActionDisagreement(selection) {
  const job = state.exceptionJob
  if (!job || state.resumeRequestPending) return
  const labels = { tighten:'收紧授信', maintain:'维持授信', increase:'增加授信', reanalyze:'重新进行三席分析' }
  appendExceptionMessage('user', labels[selection] || selection)
  state.resumeRequestPending = true
  document.querySelectorAll('[data-action-resolution]').forEach(button => { button.disabled = true })
  try {
    const body = selection === 'reanalyze' ? { mode:'reanalyze' } : { mode:'adjudicate', direction:selection }
    const { job: resumed } = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/action-resolution`, { method:'POST', body:JSON.stringify(body) })
    state.exceptionJob = resumed; state.selectedJobId = resumed.job_id
    appendExceptionMessage('agent', selection === 'reanalyze' ? '已保留原记录，并重新启动三席独立分析。' : `已记录人工裁决“${labels[selection]}”。三席原意见保持不变，程序将基于该方向继续。`)
    acknowledgeCurrentException(); await Promise.all([loadJobs(), loadAgents()])
  } catch (error) { appendExceptionMessage('agent', `处理失败：${error.message}`) }
  finally { state.resumeRequestPending = false; document.querySelectorAll('[data-action-resolution]').forEach(button => { button.disabled = false }) }
}

function exceptionExplanation(job = {}) {
  const failure = job.failure || {}
  const text = String(failure.message || '')
  const phase = PHASE_LABELS[job.phase] || job.phase || '当前阶段'
  const failedAgents = Object.values(job.agent_states || {}).filter(agent => agent.status === 'failed')
  const agentNames = failedAgents.map(agent => agent.label || agent.agent_id).join('、') || '当前执行Agent'
  const retained = Number(job.progress_percent || 0) > 0 ? `任务已完成到${job.progress_percent}%，成功节点和冻结数据仍然保留。` : '本次尚未形成可交付结果。'
  if (failure.code === 'PAUSED_ACTION_UNRESOLVED') {
    return {
      title:'三席授信方向未达成一致',
      message:'三席分别给出风险上升、风险持平和风险下降，没有任何方向达到冻结条件。',
      guidance:'程序已在风控措施分析前暂停，避免在授信方向未确定时继续推演。',
      detail:'失败发生在授信方向冻结环节。三席交流后仍各自保持不同判断，没有方向获得至少两席支持，因此程序不能选择默认答案，也不能进入依赖授信方向的风控措施阶段。这属于需要宿主原则或人工指令处理的真实分歧，不是模型格式错误。'
    }
  }
  if (failure.code === 'EVIDENCE_INCOMPLETE') {
    const rawMissing = text.includes('：') ? text.split('：').slice(1).join('：').split(',').map(value => value.trim()).filter(Boolean) : []
    const sourceNames = { cninfo:'巨潮资讯企业披露', government_policy:'政府政策', gdelt:'公开媒体', tianyancha:'企业登记', credit_china:'政府信用' }
    const missing = rawMissing.map(value => sourceNames[value] || value).join('、') || '必需公开来源'
    return {
      title:'公开证据不足',
      message:`${agentNames}在${phase}停止：${missing}没有达到建案门槛。`,
      guidance:'分析席尚未开始。需要先修正来源适用性、恢复来源连接或补足证据，再从断点继续。',
      detail:`失败发生在${phase}，执行角色是${agentNames}。系统要求的${missing}没有达到最低数量或来源接口未正常返回，因此证据包没有通过门禁，后续分析没有启动。这不是分析结论失败，也不是模型判断企业有风险；它表示当前公开证据不足以建立合格案例。修正来源或补足证据后，可以沿用原任务断点继续。`
    }
  }
  if (failure.code === 'SCHEMA_FAILURE' || /JSON gate|recoverable Competition|schema/i.test(text)) {
    return {
      title:'模型返回格式不完整',
      message:`${agentNames}在${phase}没有返回系统要求的完整结构化结果。`,
      guidance:'已有分析与候选方案仍保留；从断点继续时只重新执行这个未完成节点。',
      detail:`失败发生在${phase}，执行角色是${agentNames}。模型返回了分析过程文本，但没有形成必需的JSON字段，程序无法确认它最终选择了哪个授信方向候选和哪个完整风控方案。为避免程序从过程文本猜答案，门禁拒绝了本次输出。${retained}从断点继续只会重新执行该格式失败节点。`
    }
  }
  if (failure.code === 'PAUSED_UPSTREAM' && /timed out|timeout/i.test(text)) {
    return {
      title:'模型服务响应超时',
      message:`${agentNames}在${phase}调用模型时，等待超过本次允许时间。`,
      guidance:'企业资料和已经完成的Agent结果均已保留；可从断点继续，只重试超时节点。',
      detail:`失败发生在${phase}，受影响角色是${agentNames}。模型请求已经发出，但在规定时间内没有完成返回。这是上游响应超时，不是503错误，也不代表三席已经形成无法收敛的结论。${retained}从断点继续只重试超时节点。`
    }
  }
  if (failure.code === 'PAUSED_UPSTREAM' || /503|Service temporarily unavailable/i.test(text)) {
    return {
      title:'模型服务临时不可用',
      message:`${agentNames}在${phase}调用模型时，服务端返回503临时不可用。`,
      guidance:'企业资料和已经完成的Agent结果没有问题；可从断点继续，只重试失败节点。',
      detail:`失败发生在${phase}，受影响角色是${agentNames}。模型接入服务明确返回503 Service temporarily unavailable，表示当时上游服务短暂不可用或负载过高，不代表企业数据错误，也不代表Agent得出了失败结论。${retained}从断点继续只重试失败及未完成节点。`
    }
  }
  if (/timed out/i.test(text)) {
    return {
      title:'模型响应超时',
      message:`${agentNames}在${phase}超过等待时间，没有返回完整结果。`,
      guidance:'已完成步骤仍然保留；可从断点继续，只重试未完成节点。',
      detail:`失败发生在${phase}，受影响角色是${agentNames}。系统在规定时间内没有收到完整响应，所以停止等待并保留断点。${retained}这不是企业数据错误，从断点继续只重试未完成节点。`
    }
  }
  if (/lock timeout/i.test(text) || failedAgents.some(agent => agent.error_code === 'LOCK_TIMEOUT')) return {
    title:'任务执行发生冲突',
    message:`${agentNames}在${phase}等待同一任务的执行锁超时。`,
    guidance:'这是重复恢复或旧进程占用造成的运行冲突；确认当前没有同一任务正在运行后，可从断点继续。',
    detail:`失败发生在${phase}。同一任务曾被重复启动，多个进程同时争用相同检查点，程序为避免覆盖结果而停止。企业资料与已完成节点仍然保留。当前任务互斥机制已启用，从断点继续会沿用同一任务并防止再次重复提交。`
  }
  if (/forbidden loop|data refresh/.test(text)) return {
    title:'复核请求超出权限',
    message:`${agentNames}在${phase}提出了复核权限之外的操作。`,
    guidance:'系统已停止交付，避免复核改变既有分析。',
    detail:`失败发生在${phase}。复核只能校对或从冻结候选中选择，不能要求重新分析、重新广播或刷新证据；本次输出越过了这个边界，因此程序拒绝交付。已有候选和过程记录仍保留。`
  }
  if (failure.code === 'WEB_SERVER_RESTARTED') return {
    title:'服务重启导致中断',
    message:`任务在${phase}运行时，本地服务被重启。`,
    guidance:'原任务断点仍然保留，可以确认后继续。',
    detail:`任务不是业务失败，而是在${phase}运行期间遇到本地服务重启。${retained}从断点继续会沿用原任务，不会重新进件。`
  }
  return {
    title:'任务未完成',
    message:`任务在${phase}停止：${friendlyFailureMessage(failure)}`,
    guidance:'可查看实时日志，或从断点继续。',
    detail:`任务在${phase}停止，相关角色为${agentNames}。系统记录的直接原因是：${friendlyFailureMessage(failure)} ${retained}`
  }
}

function renderResult(job) {
  const container = $('#result-content')
  if (job.status === 'failed' || job.status === 'interrupted') {
    const failure = job.failure || {}
    const assistance = (job.manual_assistance_requests || []).length ? `<br><br>需要人工协助：${displayHtml(job.manual_assistance_requests.map(item => item.source_id || item.id).join('、'))}` : ''
    container.innerHTML = `<div class="failure-box"><strong>任务未完成</strong><br>${displayHtml(friendlyFailureMessage(failure))}${assistance}</div>`
    return
  }
  if (!job.result) { container.innerHTML = '<p class="empty-state">进件完成后在此显示正式结论。</p>'; return }
  const result = job.result
  const adviceDetails = result.risk_control_advice_details?.items || []
  const pool = result.reviewer_candidate_pool
  const selection = result.reviewer_selection
  const actionCandidates = pool?.action_candidates || []
  const riskCandidates = pool?.risk_candidates || []
  const selectedActionIndex = actionCandidates.findIndex(item => item.id === selection?.selected_action_candidate_id)
  const selectedRiskIndex = riskCandidates.findIndex(item => item.id === selection?.selected_risk_candidate_id)
  container.innerHTML = `
    <div class="result-hero">
      <div class="metric-card"><span>授信调整方向</span><strong>${displayHtml(actionLabel(result.action))}</strong></div>
      <div class="metric-card"><span>信用风险方向</span><strong>${displayHtml(riskDirectionLabel(result.risk_label))}</strong></div>
      <div class="metric-card wide"><span>风控建议码</span><div class="advice-chips">${(result.risk_control_advice || []).map(item => `<b class="advice-chip">${displayHtml(item)}</b>`).join('') || '—'}</div></div>
      <div class="metric-card"><span>交付状态</span><strong>${result.production_ready ? '可正式交付' : '需要复核'}</strong></div>
      <div class="metric-card"><span>结论状态</span><strong>${displayHtml(conclusionLabel(result.conclusion_grade))}</strong></div>
      <div class="metric-card wide"><span>流程状态</span><strong>${displayHtml(finalizationLabel(result.finalization_status))}</strong></div>
    </div>
    ${pool ? `<section class="advice-detail-panel"><div class="advice-detail-heading"><strong>复核候选选择</strong><span>复核只选择已有候选，程序负责还原完整内容</span></div>
      <div class="candidate-grid"><div><b>授信方向候选</b>${actionCandidates.map((item, index) => `<p>方案${index + 1}：${displayHtml(actionLabel(item.value))}</p>`).join('') || '<p>—</p>'}</div>
      <div><b>风控措施候选</b>${riskCandidates.map((item, index) => `<p>方案${index + 1}：${displayHtml(adviceSetLabel(item.value))}</p>`).join('') || '<p>—</p>'}</div></div>
      <p class="selection-line">最终选择：授信方向方案${selectedActionIndex >= 0 ? selectedActionIndex + 1 : '—'}；风控措施方案${selectedRiskIndex >= 0 ? selectedRiskIndex + 1 : '—'}；复核状态：${displayHtml(conclusionLabel(result.champion_gate?.recommended_status || result.conclusion_grade))}</p>
    </section>` : ''}
    <section class="advice-detail-panel" aria-label="风控建议详解">
      <div class="advice-detail-heading"><strong>风控建议详解</strong><span>结论码冻结后确定性查表，不参与模型推理</span></div>
      ${adviceDetails.length ? `<div class="advice-detail-list">${adviceDetails.map(item => `<article class="advice-detail-item">
        <b>${displayHtml(item.code)} · ${displayHtml(item.title)}</b>
        <p>${displayHtml(item.description)}</p>
      </article>`).join('')}</div>` : '<p class="empty-state">无风控建议详解。</p>'}
    </section>
    ${presentationPrivacy.modeState().enabled ? `<div class="artifact-links privacy-artifact-note"><span>原始产物入口已在演示脱敏模式下收起</span></div>` : `<div class="artifact-links">
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/report" target="_blank" rel="noopener">结构化报告</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/markdown" target="_blank" rel="noopener">完整报告</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/submission" target="_blank" rel="noopener">提交表</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/manifest" target="_blank" rel="noopener">校验清单</a>
      <a href="/api/jobs/${encodeURIComponent(job.job_id)}/artifacts/run" target="_blank" rel="noopener">完整运行记录</a>
    </div>`}`
}

function renderLogs(logs) {
  const output = $('#log-output')
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30
  state.currentLogs = logs || { text: '', truncated: false }
  output.textContent = displayText(logs.text || '日志尚未产生。')
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
function actionLabel(value) { return ({ '-1':'收紧授信', '0':'维持授信', '1':'增加授信' })[String(value)] || '尚未确定' }
function riskDirectionLabel(value) { return ({ risk_up:'风险上升', risk_flat:'风险持平', risk_down:'风险下降' })[String(value)] || '尚未确定' }
function conclusionLabel(value) { return ({ A:'可直接采用', B:'建议复核', REVIEW:'需要复核', PASS:'已通过', CHALLENGE_HIGH:'高风险复核', CHALLENGE_MEDIUM:'中风险复核', CHALLENGE_LOW:'低风险复核' })[String(value)] || (value ? '需要复核' : '尚未形成') }
function finalizationLabel(value) { return ({ FINALIZED:'已完成', FINALIZED_WITH_WARNING:'已完成，含提示', REJECTED:'未通过', PENDING:'等待处理' })[String(value)] || (value ? '已完成' : '尚未完成') }
function adviceSetLabel(values) { const items = Array.isArray(values) ? values : []; return items.length ? `风控建议 ${items.join('、')}` : '不增加风控措施' }
function displayCompanyLabel(record) { if (presentationPrivacy.modeState().enabled) return presentationPrivacy.companyLabel(record); const id = /^\d+$/.test(String(record?.company_id || '')) ? String(Number(record.company_id)) : record?.company_id; return [id, record?.company_name].filter(Boolean).join(' · ') }
function displayText(value) { return presentationPrivacy.sanitizeText(value) }
function displayHtml(value) { return escapeHtml(displayText(value)) }
function syncPresentationPrivacyControls() {
  const mode = presentationPrivacy.modeState()
  $('#presentation-privacy-toggle').checked = mode.enabled
  $('#presentation-privacy-toggle').setAttribute('aria-checked', String(mode.enabled))
  $('#presentation-privacy-badge').hidden = !mode.enabled
  $('#company-search').placeholder = mode.enabled ? '搜索演示企业代号或行业' : '搜索编号、企业名称或行业'
  document.documentElement.dataset.presentationPrivacy = mode.enabled ? 'on' : 'off'
}
function rerenderPresentationSurface() {
  presentationPrivacy.registerCompanies(state.companies)
  presentationPrivacy.registerJobs(state.jobs)
  if (state.selectedJob) presentationPrivacy.registerJobs([state.selectedJob])
  syncPresentationPrivacyControls()
  renderCompanyChecklist()
  renderJobList()
  if (state.selectedJob) renderSelectedJob()
  else renderAgents()
  renderLogs(state.currentLogs)
}
function pad(value) { return String(value).padStart(2, '0') }
function readableWarnings(values) {
  const labels = { FULL_SCHEMA_MISMATCH:'部分补充说明格式不完整，不影响核心结论。', AUDIT_FIELD_MISSING:'部分追溯说明未返回，不影响核心结论。', MISSING_EVIDENCE_REF:'部分说明未附证据编号，建议结合报告原文查看。', OPTIONAL_FIELD_INVALID:'部分可选说明未采用标准格式，系统已忽略。' }
  return [...new Set((values || []).map(value => labels[String(value).split(':')[0].trim()]).filter(Boolean))]
}
function friendlyFailureMessage(failure) {
  const labels = { WEB_SERVER_RESTARTED:'服务重启导致任务中断，请重新提交。', MODEL_NOT_READY:'模型服务暂不可用，请稍后重试。', RUN_FAILED:'任务运行未完成，请查看运行日志。' }
  return labels[failure?.code] || (String(failure?.message || '').match(/[一-鿿]/) ? failure.message : '任务运行未完成，请查看运行日志。')
}
function sourceTypeLabel(value) { return ({ government_policy:'政府政策', government_statistics:'政府统计', government_credit:'政府信用', company_disclosure:'企业披露', official_market_data:'官方市场数据', enterprise_registry:'企业登记', reputable_media:'可靠媒体', social_media:'公开研究线索' })[value] || '其他公开来源' }
function recoveryLabel(mode) {
  if (mode === 'decision_block') return '已提取明确决策区块'
  if (mode === 'markdown') return '已从文本提取决策'
  if (mode === 'json_repair') return '已规范输出格式'
  return mode ? `已规范输出格式 · ${mode}` : '未触发格式恢复'
}
