const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildCollectionRequest } = require('./batch-runner')
const { buildCompanyCase } = require('./case-builder')
const { parseCompanyImport } = require('./company-import')
const { applyIndustryPlanToCollectionRequest, createIndustryPlan, runCase } = require('./orchestrator')
const { projectRoot } = require('./rulora-loader')
const { RISK_CONTROL_ADVICE_DEFINITION_VERSION, describeRiskControlAdvice } = require('./risk-control-advice')
const { PublicSourceCollector } = require('./source-collector')
const { UserSourceConfigStore } = require('./user-source-config')
const { readJson, writeJsonAtomic } = require('./utils')

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'paused'])
const ARTIFACT_KEYS = Object.freeze({
  run: 'run_json',
  report: 'report_json',
  markdown: 'report_markdown',
  submission: 'submission_csv',
  manifest: 'manifest_json'
})
const PHASE_PROGRESS = Object.freeze({
  queued: 0,
  session_initialization: 4,
  industry_chain_planning: 10,
  evidence_intake: 20,
  public_information_monitoring: 30,
  joint_independent_decision: 43,
  competition_joint_decision_initial: 43,
  competition_joint_decision_self_review: 62,
  competition_joint_decision: 68,
  single_pass_calibration: 82,
  competition_calibration: 82,
  credit_direction_initial: 43,
  credit_direction_self_review: 55,
  credit_direction: 58,
  action_calibration: 61,
  risk_control_advice_initial: 68,
  risk_control_advice_self_review: 78,
  risk_control_advice: 82,
  risk_calibration: 84,
  reviewer_selection: 87,
  champion_gate: 89,
  shadow_validation: 85,
  aggregate_and_render: 90,
  persist_artifacts: 96,
  complete: 100
})
const STANDARD_TASK = '基于目标企业冻结的已发布公开信息，执行产业链风险传导分析，形成授信调整方向与风控建议。'

class WebJobManager {
  constructor({
    root = projectRoot(),
    runCaseImpl = runCase,
    concurrency = Number(process.env.RISK_AGENTS_WEB_CONCURRENCY || 2),
    batchLimit = Number(process.env.RISK_AGENTS_WEB_BATCH_LIMIT || 5)
  } = {}) {
    this.root = path.resolve(root)
    this.runCaseImpl = runCaseImpl
    this.concurrency = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 4) : 2
    this.batchLimit = Number.isInteger(batchLimit) && batchLimit > 0 ? Math.min(batchLimit, 10) : 5
    this.runtimeDirectory = path.join(this.root, '.runtime', 'web-ui')
    this.jobsDirectory = path.join(this.runtimeDirectory, 'jobs')
    this.logsDirectory = path.join(this.runtimeDirectory, 'logs')
    this.outputsDirectory = path.join(this.runtimeDirectory, 'outputs')
    this.intakeDirectory = path.join(this.runtimeDirectory, 'intake')
    this.importCatalogPath = path.join(this.runtimeDirectory, 'imported-companies.json')
    this.sourceConfigStore = new UserSourceConfigStore({ filePath: path.join(this.runtimeDirectory, 'user-public-sources.json') })
    this.jobs = new Map()
    this.active = new Set()
    this.writeChains = new Map()
    this.companies = []
    this.baseCompanies = []
    this.importedCompanyIds = new Set()
    this.agents = []
    this.caseCatalog = new Map()
    this.userSourceConfig = null
    this.builtInSources = []
    this.initialized = false
  }

  async initialize() {
    if (this.initialized) return this
    await Promise.all([
      fs.mkdir(this.jobsDirectory, { recursive: true }),
      fs.mkdir(this.logsDirectory, { recursive: true }),
      fs.mkdir(this.outputsDirectory, { recursive: true }),
      fs.mkdir(this.intakeDirectory, { recursive: true })
    ])
    const [companyData, agentConfig, sourceConfig, userSourceConfig] = await Promise.all([
      readJson(path.join(this.root, 'examples', 'companies.json')),
      readJson(path.join(this.root, 'config', 'agents.json')),
      readJson(path.join(this.root, 'config', 'public-sources.json')),
      this.sourceConfigStore.load()
    ])
    this.builtInSources = (sourceConfig.sources || []).filter(source => source.production_ingest_enabled === true && Boolean(source.adapter)).map(source => ({
      id: source.id, label: source.label, source_type: source.source_type, access_mode: source.access_mode, automatic: true
    }))
    this.userSourceConfig = userSourceConfig
    this.baseCompanies = normalizeCompanyRecords(companyData)
    const imported = await this.loadImportedCompanies()
    this.importedCompanyIds = new Set(imported.map(item => item.company_id))
    this.companies = mergeCompanyRecords(this.baseCompanies, imported)
    this.agents = (agentConfig.roles || []).map(agent => ({
      agent_id: agent.id,
      label: agent.label,
      stage: agent.stage,
      model_profile: agent.model_profile,
      participates_in_debate: agent.participates_in_debate === true
    }))
    await this.refreshCaseCatalog()
    const entries = await fs.readdir(this.jobsDirectory, { withFileTypes: true })
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
      try {
        const job = await readJson(path.join(this.jobsDirectory, entry.name))
        job.v2_state ||= createV2State()
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'interrupted'
          job.stage = 'interrupted'
          job.phase = null
          job.active_agents = []
          job.updated_at = new Date().toISOString()
          job.failure = { code: 'WEB_SERVER_RESTARTED', message: '本地Web服务重启，旧任务未自动续跑。请重新提交任务。' }
          await writeJsonAtomic(path.join(this.jobsDirectory, entry.name), job)
        }
        this.jobs.set(job.job_id, job)
      } catch {
        // A malformed historical UI record is isolated instead of blocking startup.
      }
    }
    this.initialized = true
    return this
  }

  async refreshCaseCatalog() {
    this.caseCatalog = await discoverCases(this.root, this.companies.map(item => item.company_id))
    for (const company of this.companies) {
      const candidate = path.join(this.intakeDirectory, company.company_id, 'case.json')
      try {
        const stat = await fs.stat(candidate)
        const current = this.caseCatalog.get(company.company_id)
        if (!current || stat.mtimeMs > Date.parse(current.updated_at)) {
          this.caseCatalog.set(company.company_id, { case_path: candidate, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return this.caseCatalog
  }

  async loadImportedCompanies() {
    try {
      const payload = await readJson(this.importCatalogPath)
      return normalizeCompanyRecords(payload)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  async importCompanies({ filename, content_base64: contentBase64 }) {
    await this.initialize()
    const parsed = await parseCompanyImport({ filename, contentBase64 })
    const existing = new Map(this.companies.map(company => [company.company_id, company]))
    for (const record of parsed.records) {
      const current = existing.get(record.company_id)
      if (current && normalizeCompanyName(current.company_name) !== normalizeCompanyName(record.company_name)) {
        throw badRequest(`company_id ${record.company_id} 已属于“${current.company_name}”，不能导入“${record.company_name}”。`)
      }
      if (current?.unified_social_credit_code && record.unified_social_credit_code && current.unified_social_credit_code !== record.unified_social_credit_code) {
        throw badRequest(`企业${record.company_id}的统一社会信用代码与现有记录不一致。`)
      }
    }
    const priorImported = await this.loadImportedCompanies()
    const mergedImported = mergeCompanyRecords(priorImported, parsed.records)
    await writeJsonAtomic(this.importCatalogPath, {
      contract_version: '1.0.0',
      dataset_id: 'web-imported-companies',
      source_file: parsed.filename,
      source_sha256: parsed.content_sha256,
      record_count: mergedImported.length,
      imported_at: new Date().toISOString(),
      records: mergedImported
    })
    this.importedCompanyIds = new Set(mergedImported.map(item => item.company_id))
    this.companies = mergeCompanyRecords(this.baseCompanies, mergedImported)
    await this.refreshCaseCatalog()
    const imported = parsed.records.map(record => this.listCompanies().find(item => item.company_id === record.company_id))
    return { filename: parsed.filename, imported_count: parsed.records.length, catalog_count: this.companies.length, companies: imported }
  }

  listCompanies() {
    return this.companies.map(company => {
      const available = this.caseCatalog.get(company.company_id)
      return {
        company_id: company.company_id,
        company_name: company.company_name,
        industry: company.industry,
        case_available: Boolean(available),
        case_updated_at: available?.updated_at || null,
        imported: this.importedCompanyIds.has(company.company_id),
        intake_required: !available && this.importedCompanyIds.has(company.company_id),
        selectable: Boolean(available) || this.importedCompanyIds.has(company.company_id)
      }
    })
  }

  listAgents() {
    return this.agents.map(agent => {
      const running = [...this.jobs.values()].filter(job => job.status === 'running' && job.agent_states?.[agent.agent_id]?.status === 'running')
      const queued = [...this.jobs.values()].filter(job => job.status === 'queued')
      return {
        ...agent,
        status: running.length ? 'running' : agent.stage === 'periodic_improvement' ? 'standby' : queued.length ? 'queued' : 'idle',
        current_companies: running.map(job => ({ company_id: job.company_id, company_name: job.company_name, phase: job.phase })),
        running_job_count: running.length
      }
    })
  }

  sourceSettings() {
    return {
      built_in_sources: structuredClone(this.builtInSources),
      search_backend: structuredClone(this.userSourceConfig?.search_backend || { type: 'searxng', enabled: false, endpoint: '' }),
      websites: structuredClone(this.userSourceConfig?.websites || []),
      notes: [
        '默认列表只包含当前真实自动接通的公开来源。',
        '自定义网站通过用户自托管SearXNG发现公开页面；正文仍由本系统抓取、校验发布日期并固化快照。',
        '公开JSON API可配置查询参数和字段路径；当前仅允许无需密钥的HTTPS GET接口。',
        '不绕过登录、验证码、WAF或网站访问控制。'
      ]
    }
  }

  async updateSourceSettings(value) {
    await this.initialize()
    this.userSourceConfig = await this.sourceConfigStore.save(value)
    return this.sourceSettings()
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(job => publicJob(job))
  }

  async getJob(jobId) {
    await this.waitForPendingWrite(jobId)
    const job = this.jobs.get(jobId)
    if (!job) throw notFound(`任务不存在：${jobId}`)
    return publicJob(job)
  }

  async getLogs(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) throw notFound(`任务不存在：${jobId}`)
    let text = ''
    try {
      text = await fs.readFile(job.log_path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const maximum = 200000
    return { text: text.length > maximum ? text.slice(-maximum) : text, truncated: text.length > maximum }
  }

  async createBatch({ company_ids: companyIds, user_consent: userConsent, consent_action: consentAction }) {
    await this.initialize()
    assertStartAnalysisConsent(userConsent, consentAction)
    if (!Array.isArray(companyIds)) throw badRequest('company_ids必须是企业编号数组。')
    const ids = [...new Set(companyIds.map(value => String(value).trim().padStart(3, '0')))]
    if (!ids.length) throw badRequest('请至少勾选一家企业。')
    if (ids.length > this.batchLimit) throw badRequest(`单次最多进件${this.batchLimit}家企业。`)
    for (const companyId of ids) {
      const company = this.companies.find(item => item.company_id === companyId)
      if (!company) throw badRequest(`未找到企业编号：${companyId}`)
      const duplicate = [...this.jobs.values()].find(job => job.company_id === companyId && ['queued', 'running'].includes(job.status))
      if (duplicate) throw badRequest(`企业${companyId}已有排队或运行中的任务。`)
      if (!this.caseCatalog.has(companyId) && !this.importedCompanyIds.has(companyId)) throw badRequest(`企业${companyId}没有可用案例，也不是本次导入企业。`)
    }
    const jobs = []
    const consentTime = new Date().toISOString()
    for (const companyId of ids) jobs.push(await this.createJob({
      company_id: companyId,
      deferPump: true,
      user_consent: true,
      consent_action: 'start_analysis',
      consent_time: consentTime
    }))
    this.pump()
    return { batch_limit: this.batchLimit, accepted_count: jobs.length, jobs }
  }

  async createJob({ company_id: requestedCompanyId, deferPump = false, user_consent: userConsent, consent_action: consentAction, consent_time: consentTime = null }) {
    await this.initialize()
    assertStartAnalysisConsent(userConsent, consentAction)
    await this.refreshCaseCatalog()
    const company = resolveCompany(this.companies, { task: '', companyId: requestedCompanyId })
    const caseRecord = this.caseCatalog.get(company.company_id)
    if (!caseRecord && !this.importedCompanyIds.has(company.company_id)) throw badRequest(`企业${company.company_id}尚无可运行case.json，请先导入企业并完成公开证据建案。`)
    const now = new Date().toISOString()
    const jobId = `web-${company.company_id}-${now.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
    const outputDirectory = path.join(this.outputsDirectory, jobId)
    const agentStates = Object.fromEntries(this.agents.map(agent => [agent.agent_id, {
      ...agent,
      status: agent.stage === 'periodic_improvement' ? 'not_in_case' : 'idle',
      phase: null,
      operation: null,
      started_at: null,
      completed_at: null,
      error_code: null
    }]))
    const job = {
      contract_version: '1.0.0',
      job_id: jobId,
      task: STANDARD_TASK,
      user_consent: true,
      consent_time: consentTime || now,
      consent_action: 'start_analysis',
      company_id: company.company_id,
      company_name: company.company_name,
      case_path: caseRecord?.case_path || null,
      case_updated_at: caseRecord?.updated_at || null,
      intake_required: !caseRecord,
      output_directory: outputDirectory,
      log_path: path.join(this.logsDirectory, `${jobId}.log`),
      status: 'queued',
      stage: 'queued',
      phase: 'queued',
      progress_percent: 0,
      run_id: null,
      evidence_count: null,
      active_agents: [],
      agent_states: agentStates,
      events: [],
      result: null,
      failure: null,
      v2_state: createV2State(),
      created_at: now,
      started_at: null,
      completed_at: null,
      updated_at: now
    }
    this.jobs.set(jobId, job)
    await this.persistJob(job)
    await fs.appendFile(job.log_path, `${now} [queued] 已自动进件：${company.company_id} · ${company.company_name}\n`, 'utf8')
    if (!deferPump) this.pump()
    return publicJob(job)
  }

  async getArtifact(jobId, kind) {
    const job = this.jobs.get(jobId)
    if (!job) throw notFound(`任务不存在：${jobId}`)
    const artifactKey = ARTIFACT_KEYS[kind]
    if (!artifactKey) throw notFound(`未知产物类型：${kind}`)
    const filePath = job.result?.artifacts?.[artifactKey]
    if (!filePath) throw notFound('该产物尚未生成。')
    const resolved = path.resolve(filePath)
    if (!isPathInside(path.resolve(job.output_directory), resolved)) throw badRequest('产物路径超出任务输出目录。')
    await fs.access(resolved)
    return resolved
  }

  systemSnapshot() {
    return {
      initialized: this.initialized,
      concurrency: this.concurrency,
      batch_limit: this.batchLimit,
      running_jobs: this.active.size,
      queued_jobs: [...this.jobs.values()].filter(job => job.status === 'queued').length,
      total_jobs: this.jobs.size
    }
  }

  pump() {
    while (this.active.size < this.concurrency) {
      const next = [...this.jobs.values()]
        .filter(job => job.status === 'queued' && !this.active.has(job.job_id))
        .sort((left, right) => left.created_at.localeCompare(right.created_at))[0]
      if (!next) return
      this.active.add(next.job_id)
      void this.execute(next.job_id)
    }
  }

  async execute(jobId) {
    const authorized = this.jobs.get(jobId)
    if (authorized?.user_consent !== true || authorized?.consent_action !== 'start_analysis') {
      throw badRequest('任务缺少“开始进件分析”授权，不能运行。')
    }
    const startedAt = new Date().toISOString()
    await this.mutateJob(jobId, async job => {
      job.status = 'running'
      job.stage = 'session_initialization'
      job.phase = 'session_initialization'
      job.progress_percent = PHASE_PROGRESS.session_initialization
      job.started_at = startedAt
      await this.appendLog(job, '[running] 开始执行真实多Agent分析。')
    })
    try {
      let job = this.jobs.get(jobId)
      if (!job.case_path) {
        await this.prepareImportedCase(jobId)
        job = this.jobs.get(jobId)
      }
      const run = await this.runCaseImpl({
        inputPath: job.case_path,
        outputDirectory: job.output_directory,
        task: job.task,
        mode: 'competition_calibrated_v2',
        reuseFrozenEvidence: true,
        onProgress: event => this.recordProgress(jobId, event)
      })
      await this.mutateJob(jobId, async current => {
        current.status = 'succeeded'
        current.stage = 'committed'
        current.phase = 'complete'
        current.progress_percent = 100
        current.active_agents = []
        current.completed_at = new Date().toISOString()
        current.run_id = run.run_id
        current.result = summarizeRun(run)
        await this.appendLog(current, `[succeeded] 完成。action=${current.result.action}，风控建议=${current.result.risk_control_advice.join(',')}。`)
      })
    } catch (error) {
      await this.mutateJob(jobId, async job => {
        job.status = error.code === 'PAUSED_SEAT_FAILURE' ? 'paused' : 'failed'
        job.active_agents = []
        job.completed_at = new Date().toISOString()
        job.failure = { code: error.code || 'RUN_FAILED', message: String(error.message || error) }
        for (const state of Object.values(job.agent_states)) if (state.status === 'running') state.status = 'failed'
        await this.appendLog(job, `[failed] ${job.failure.code}: ${job.failure.message}`)
      })
    } finally {
      this.active.delete(jobId)
      this.pump()
    }
  }

  async prepareImportedCase(jobId) {
    const current = this.jobs.get(jobId)
    const company = this.companies.find(item => item.company_id === current.company_id)
    if (!company || !this.importedCompanyIds.has(company.company_id)) throw badRequest('只有已导入企业可以自动完成公开证据建案。')
    const companyRoot = path.join(this.intakeDirectory, company.company_id)
    const snapshotRoot = path.join(companyRoot, 'evidence-snapshots')
    const asOfDate = shanghaiCalendarDate()
    const planningCase = buildPlanningCase(company, asOfDate)
    const planningAgent = this.agents.find(agent => agent.agent_id === 'industry_research_planner')
    const monitorAgent = this.agents.find(agent => agent.agent_id === 'public_evidence_monitor')
    if (!planningAgent || !monitorAgent) throw new Error('前置产业链规划员或公开信息采集监控员缺失。')
    await fs.mkdir(companyRoot, { recursive: true })
    await this.recordProgress(jobId, {
      type: 'agent_started', stage: 'company_intake', phase: 'industry_chain_planning', operation: 'plan_imported_company',
      agent_id: planningAgent.agent_id, agent_label: planningAgent.label, model_profile: planningAgent.model_profile
    })
    let planning
    try {
      planning = await createIndustryPlan({ caseData: planningCase })
      await writeJsonAtomic(path.join(companyRoot, 'industry-plan.json'), planning)
      await this.recordProgress(jobId, {
        type: 'agent_completed', stage: 'company_intake', phase: 'industry_chain_planning', operation: 'plan_imported_company',
        agent_id: planningAgent.agent_id, agent_label: planningAgent.label, model_profile: planningAgent.model_profile
      })
    } catch (error) {
      await this.recordProgress(jobId, {
        type: 'agent_failed', stage: 'company_intake', phase: 'industry_chain_planning', operation: 'plan_imported_company',
        agent_id: planningAgent.agent_id, agent_label: planningAgent.label, model_profile: planningAgent.model_profile,
        error_code: error.code || 'INDUSTRY_PLANNING_FAILED'
      })
      throw error
    }
    await this.recordProgress(jobId, {
      type: 'agent_started', stage: 'company_intake', phase: 'evidence_intake', operation: 'collect_public_evidence',
      agent_id: monitorAgent.agent_id, agent_label: monitorAgent.label, model_profile: monitorAgent.model_profile
    })
    try {
      const request = applyIndustryPlanToCollectionRequest({
        request: buildCollectionRequest(company, asOfDate),
        industryPlan: planning.industry_plan,
        company: planningCase.company,
        configuredSources: this.userSourceConfig?.websites || []
      })
      await writeJsonAtomic(path.join(companyRoot, 'collection-request.json'), request)
      const packet = await new PublicSourceCollector({ snapshotDirectory: snapshotRoot, userSourceConfig: this.userSourceConfig }).collect(request)
      await writeJsonAtomic(path.join(companyRoot, 'evidence-packet.json'), packet)
      if (packet.status !== 'complete') {
        const error = new Error(`公开证据建案未完成：${(packet.required_failures || []).map(item => item.code || item.source_id).join(', ') || '需要人工协助'}`)
        error.code = 'EVIDENCE_INCOMPLETE'
        error.manual_assistance_requests = packet.manual_assistance_requests || []
        await this.mutateJob(jobId, async job => { job.manual_assistance_requests = error.manual_assistance_requests })
        throw error
      }
      const caseData = buildCompanyCase({ companyRecord: company, evidencePacket: packet, monitoringMode: 'active' })
      caseData.industry_plan = structuredClone(planning.industry_plan)
      caseData.industry_plan_degraded = planning.diagnostics?.degraded === true || planning.provider_production_ready !== true
      const casePath = path.join(companyRoot, 'case.json')
      await writeJsonAtomic(casePath, caseData)
      const stat = await fs.stat(casePath)
      this.caseCatalog.set(company.company_id, { case_path: casePath, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
      await this.mutateJob(jobId, async job => {
        job.case_path = casePath
        job.case_updated_at = stat.mtime.toISOString()
        job.intake_required = false
        job.evidence_count = packet.evidence.length
      })
      await this.recordProgress(jobId, {
        type: 'agent_completed', stage: 'company_intake', phase: 'evidence_intake', operation: 'collect_public_evidence',
        agent_id: monitorAgent.agent_id, agent_label: monitorAgent.label, model_profile: monitorAgent.model_profile,
        evidence_count: packet.evidence.length
      })
    } catch (error) {
      await this.recordProgress(jobId, {
        type: 'agent_failed', stage: 'company_intake', phase: 'evidence_intake', operation: 'collect_public_evidence',
        agent_id: monitorAgent.agent_id, agent_label: monitorAgent.label, model_profile: monitorAgent.model_profile,
        error_code: error.code || 'EVIDENCE_COLLECTION_FAILED'
      })
      throw error
    }
  }

  async recordProgress(jobId, event) {
    await this.mutateJob(jobId, async job => {
      job.run_id = event.run_id || job.run_id
      if (event.stage) job.stage = event.stage
      if (event.phase) job.phase = event.phase
      if (Number.isInteger(event.evidence_count)) job.evidence_count = event.evidence_count
      job.progress_percent = Math.max(job.progress_percent, progressFor(event))
      updateAgentStates(job, event)
      updateV2State(job, event)
      job.events.push(safeProgressEvent(event))
      if (job.events.length > 240) job.events = job.events.slice(-240)
      await this.appendLog(job, formatProgressLog(event))
    })
  }

  async mutateJob(jobId, mutator) {
    const previous = this.writeChains.get(jobId) || Promise.resolve()
    const next = previous.then(async () => {
      const job = this.jobs.get(jobId)
      if (!job) throw notFound(`任务不存在：${jobId}`)
      await mutator(job)
      job.updated_at = new Date().toISOString()
      await this.persistJob(job)
      return job
    })
    this.writeChains.set(jobId, next.catch(() => {}))
    return next
  }

  async waitForPendingWrite(jobId) {
    const pending = this.writeChains.get(jobId)
    if (pending) await pending
  }

  async persistJob(job) {
    await writeJsonAtomic(path.join(this.jobsDirectory, `${job.job_id}.json`), job)
  }

  async appendLog(job, message) {
    await fs.appendFile(job.log_path, `${new Date().toISOString()} ${message}\n`, 'utf8')
  }
}

async function discoverCases(root, companyIds) {
  const catalog = new Map()
  const runtimeRoot = path.join(root, '.runtime')
  let entries = []
  try {
    entries = await fs.readdir(runtimeRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const batchDirectories = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('formal-batch-'))
    .map(entry => path.join(runtimeRoot, entry.name))
  for (const companyId of companyIds) {
    const candidates = []
    const bundledExample = path.join(root, 'examples', 'company-case.json')
    if (companyId === '001') {
      try {
        const stat = await fs.stat(bundledExample)
        candidates.push({ case_path: bundledExample, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    for (const batchDirectory of batchDirectories) {
      const candidate = path.join(batchDirectory, 'companies', companyId, 'case.json')
      try {
        const stat = await fs.stat(candidate)
        candidates.push({ case_path: candidate, updated_at: stat.mtime.toISOString(), mtime: stat.mtimeMs })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    candidates.sort((left, right) => right.mtime - left.mtime)
    if (candidates[0]) catalog.set(companyId, candidates[0])
  }
  return catalog
}

function normalizeCompanyRecords(data) {
  const records = Array.isArray(data) ? data : data.records
  if (!Array.isArray(records)) throw new Error('Company catalog does not contain records')
  return records.map(record => ({
    ...structuredClone(record),
    company_id: String(record.company_id || '').padStart(3, '0'),
    company_name: String(record.company_name || '').trim(),
    industry: String(record.industry || '').trim()
  })).filter(record => /^\d{3}$/.test(record.company_id) && record.company_name)
}

function mergeCompanyRecords(baseRecords, overlayRecords) {
  const records = new Map(normalizeCompanyRecords(baseRecords).map(record => [record.company_id, record]))
  for (const overlay of normalizeCompanyRecords(overlayRecords)) {
    const current = records.get(overlay.company_id) || {}
    records.set(overlay.company_id, Object.fromEntries(Object.entries({ ...current, ...overlay }).filter(([, value]) => value !== '')))
  }
  return [...records.values()].sort((left, right) => left.company_id.localeCompare(right.company_id))
}

function normalizeCompanyName(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[（）()]/g, '').toLowerCase()
}

function buildPlanningCase(record, asOfDate) {
  const id = String(record.company_id).padStart(3, '0')
  return {
    contract_version: '1.0.0',
    case_id: `web-import-${id}-${asOfDate}`,
    as_of_date: asOfDate,
    competition_cutoff: asOfDate,
    company: {
      id,
      name: record.company_name,
      industry: record.industry,
      province: record.province || '',
      city: record.city || '',
      enterprise_type: record.enterprise_type || '',
      unified_social_credit_code: record.unified_social_credit_code || '',
      website: record.website || '',
      business_scope: record.business_scope || ''
    },
    evidence: []
  }
}

function shanghaiCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const values = Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function resolveCompany(companies, { task, companyId }) {
  const requested = String(companyId || '').trim()
  if (requested) {
    const normalized = requested.padStart(3, '0')
    const match = companies.find(company => company.company_id === normalized)
    if (!match) throw badRequest(`未找到企业编号：${requested}`)
    return match
  }
  const text = String(task || '').trim()
  const idMatches = [...text.matchAll(/(?:^|\D)(\d{1,3})(?=\D|$)/g)]
    .map(match => match[1].padStart(3, '0'))
    .filter(id => companies.some(company => company.company_id === id))
  if (new Set(idMatches).size === 1) return companies.find(company => company.company_id === idMatches[0])
  const nameMatches = companies.filter(company => text.includes(company.company_name) || text.includes(shortCompanyName(company.company_name)))
  if (nameMatches.length === 1) return nameMatches[0]
  throw badRequest('无法唯一识别目标企业，请从企业列表选择一家。')
}

function shortCompanyName(name) {
  return String(name).replace(/股份有限公司|集团有限公司|有限公司/g, '')
}

function summarizeRun(run) {
  const adviceCodes = [...run.consensus.risk_control_advice].map(String)
  return {
    run_id: run.run_id,
    action: String(run.consensus.action),
    risk_label: run.consensus.risk_label,
    risk_control_advice: adviceCodes,
    risk_control_advice_details: {
      definition_version: RISK_CONTROL_ADVICE_DEFINITION_VERSION,
      source_field: 'risk_control_advice',
      display_only: true,
      items: describeRiskControlAdvice(adviceCodes)
    },
    decision_mode: run.consensus.decision_mode,
    conclusion_grade: run.consensus.conclusion_grade,
    finalization_status: run.competition_finalization?.finalization_status || null,
    warnings: structuredClone(run.competition_finalization?.warnings || []),
    reviewer_candidate_pool: structuredClone(run.competition_finalization?.reviewer_candidate_pool || null),
    reviewer_selection: structuredClone(run.competition_finalization?.calibration_reviewer ? {
      selected_action_candidate_id: run.competition_finalization.calibration_reviewer.selected_action_candidate_id || null,
      selected_risk_candidate_id: run.competition_finalization.calibration_reviewer.selected_risk_candidate_id || null,
      challenge_level: run.competition_finalization.calibration_reviewer.challenge_level || run.competition_finalization.calibration_reviewer.challenge_strength || null
    } : null),
    champion_gate: structuredClone(run.competition_finalization?.champion_gate || null),
    execution_diagnostics: {
      logical_model_calls: run.execution_diagnostics?.logical_model_calls ?? null,
      transport_attempts: run.execution_diagnostics?.transport_attempts ?? null,
      transport_retries: run.execution_diagnostics?.transport_retries ?? null,
      normalization_applied: structuredClone(run.execution_diagnostics?.normalization_applied || [])
    },
    production_ready: run.report.qa.production_ready === true,
    evidence_coverage: run.consensus.evidence_coverage,
    debate_summary: run.report.debate_summary,
    submission_row: run.report.submission_row,
    artifacts: structuredClone(run.artifacts)
  }
}

function updateAgentStates(job, event) {
  const mark = (agentId, status, details = {}) => {
    const state = job.agent_states[agentId]
    if (!state) return
    state.status = status
    state.phase = event.phase || state.phase
    state.operation = event.operation || state.operation
    if (status === 'running') state.started_at = event.at || new Date().toISOString()
    if (status === 'completed' || status === 'failed') state.completed_at = event.at || new Date().toISOString()
    if (details.error_code) state.error_code = details.error_code
    if (event.validation_status) state.validation_status = event.validation_status
    if (Number.isInteger(event.validation_attempt)) state.validation_attempt = event.validation_attempt
    if (Number.isInteger(event.validation_max_attempts)) state.validation_max_attempts = event.validation_max_attempts
    if (event.recovery_mode) state.recovery_mode = event.recovery_mode
    if (event.recovery_applied === true) state.recovery_applied = true
    if (Array.isArray(event.warnings)) state.warnings = [...new Set([...(state.warnings || []), ...event.warnings])]
  }
  if (event.type === 'agent_started') mark(event.agent_id, 'running')
  if (event.type === 'agent_completed') mark(event.agent_id, 'completed')
  if (event.type === 'agent_failed') mark(event.agent_id, 'failed', event)
  if (event.type === 'agent_group_started') for (const agent of event.agents || []) mark(agent.agent_id, 'running')
  if (event.type === 'agent_group_completed') for (const agentId of event.agent_ids || []) mark(agentId, 'completed')
  if (event.type === 'agent_group_failed') for (const agentId of event.agent_ids || []) mark(agentId, 'failed', event)
  job.active_agents = Object.values(job.agent_states).filter(state => state.status === 'running').map(state => state.agent_id)
}

function createV2State() {
  return {
    contract_version: '1.0.0',
    stages: Object.fromEntries(['evidence_collection', 'action_decision', 'action_calibration', 'risk_decision', 'risk_calibration', 'reviewer_selection', 'champion_gate', 'finalization'].map(id => [id, { status: 'pending' }])),
    constraint: { status: 'pending', attempt: 0, max_attempts: 3, revise_required_count: 0, revision_completed_count: 0 },
    recovery: { count: 0, last_mode: null, events: [] },
    reviewer_candidate_pool: null,
    reviewer_selection: null,
    gate: null,
    decision_finalized: false,
    finalization_status: null
  }
}

function updateV2State(job, event) {
  job.v2_state ||= createV2State()
  const state = job.v2_state
  const stageId = displayStageForEvent(event)
  if (event.type === 'stage_started' || event.type === 'phase_started' || event.type === 'agent_started' || event.type === 'agent_group_started') {
    if (stageId) state.stages[stageId].status = 'running'
  }
  if (event.type === 'stage_completed' || event.type === 'phase_completed' || ['action_calibration_completed', 'risk_calibration_completed', 'reviewer_selection_completed', 'champion_gate_completed'].includes(event.type)) {
    if (stageId) state.stages[stageId].status = 'completed'
  }
  if (event.type === 'action_calibration_completed') state.stages.action_decision.status = 'completed'
  if (event.type === 'risk_calibration_completed') state.stages.risk_decision.status = 'completed'
  if (event.type === 'agent_failed' || event.type === 'agent_group_failed') {
    if (stageId) state.stages[stageId].status = event.error_code === 'PAUSED_SEAT_FAILURE' ? 'paused' : 'failed'
  }
  if (event.validation_status) {
    state.constraint.status = event.validation_status
    state.constraint.attempt = Number(event.validation_attempt || 0)
    state.constraint.max_attempts = Number(event.validation_max_attempts || 3)
    if (event.validation_status === 'REVISE_REQUIRED') state.constraint.revise_required_count += 1
    if (event.validation_status === 'PASS' && Number(event.validation_attempt || 0) > 0) state.constraint.revision_completed_count += 1
  }
  if (event.recovery_applied === true) {
    state.recovery.count += 1
    state.recovery.last_mode = event.recovery_mode || 'normalized'
    state.recovery.events.push({ at: event.at || new Date().toISOString(), agent_id: event.agent_id || null, phase: event.phase || null, mode: event.recovery_mode || 'normalized' })
  }
  if (event.type === 'reviewer_candidate_pool_created') state.reviewer_candidate_pool = structuredClone(event.candidate_pool || null)
  if (event.type === 'reviewer_selection_completed') state.reviewer_selection = {
    selected_action_candidate_id: event.selected_action_candidate_id || null,
    selected_risk_candidate_id: event.selected_risk_candidate_id || null,
    challenge_level: event.challenge_level || null
  }
  if (event.type === 'champion_gate_completed') {
    state.gate = event.gate || null
    state.decision_finalized = event.decision_finalized === true
    state.finalization_status = event.finalization_status || null
  }
  if (event.type === 'run_completed') state.stages.finalization.status = 'completed'
  if (event.type === 'run_failed') state.stages.finalization.status = event.error_code === 'PAUSED_SEAT_FAILURE' ? 'paused' : 'failed'
}

function displayStageForEvent(event) {
  if (event.type === 'action_calibration_completed' || event.phase === 'credit_direction') return 'action_calibration'
  if (event.type === 'risk_calibration_completed' || event.phase === 'risk_control_advice') return 'risk_calibration'
  if (event.type === 'reviewer_candidate_pool_created' || event.type === 'reviewer_selection_completed' || ['reviewer_selection', 'single_pass_calibration', 'competition_joint_calibration'].includes(event.phase)) return 'reviewer_selection'
  if (event.type === 'champion_gate_completed' || event.phase === 'champion_gate') return 'champion_gate'
  if (['aggregate_and_render', 'persist_artifacts', 'complete'].includes(event.phase) || ['conclusion_output', 'artifact_commit'].includes(event.stage)) return 'finalization'
  if (String(event.phase || '').startsWith('credit_direction_')) return 'action_decision'
  if (String(event.phase || '').startsWith('risk_control_advice_')) return 'risk_decision'
  if (['evidence_intake', 'public_information_monitoring', 'industry_chain_planning'].includes(event.phase) || ['public_evidence_planning_and_intake', 'information_collection_monitoring'].includes(event.stage)) return 'evidence_collection'
  return null
}

function safeProgressEvent(event) {
  return {
    type: event.type,
    at: event.at,
    run_id: event.run_id || null,
    stage: event.stage || null,
    phase: event.phase || null,
    operation: event.operation || null,
    agent_id: event.agent_id || null,
    agent_ids: event.agent_ids || null,
    result: event.result ?? null,
    unanimous: event.unanimous ?? null,
    error_code: event.error_code || null
    ,validation_status: event.validation_status || null
    ,validation_attempt: Number.isInteger(event.validation_attempt) ? event.validation_attempt : null
    ,validation_max_attempts: Number.isInteger(event.validation_max_attempts) ? event.validation_max_attempts : null
    ,recovery_mode: event.recovery_mode || null
    ,recovery_applied: event.recovery_applied === true
    ,warnings: Array.isArray(event.warnings) ? structuredClone(event.warnings) : []
    ,candidate_pool: event.candidate_pool ? structuredClone(event.candidate_pool) : null
    ,selected_action_candidate_id: event.selected_action_candidate_id || null
    ,selected_risk_candidate_id: event.selected_risk_candidate_id || null
    ,challenge_level: event.challenge_level || null
    ,gate: event.gate || null
    ,decision_finalized: event.decision_finalized ?? null
    ,finalization_status: event.finalization_status || null
  }
}

function formatProgressLog(event) {
  const location = [event.stage, event.phase].filter(Boolean).join(' / ')
  if (event.type === 'agent_started') return `[agent:start] ${event.agent_label || event.agent_id} · ${location}`
  if (event.type === 'agent_completed') {
    const loop = Number(event.validation_attempt || 0) > 0 ? ` · Program约束修订完成 ${event.validation_attempt}/${event.validation_max_attempts || 3}` : ''
    const recovery = event.recovery_applied ? ` · ${event.recovery_mode === 'decision_block' ? 'Decision block extracted' : 'Output normalized'}` : ''
    return `[agent:done] ${event.agent_label || event.agent_id} · ${location}${loop}${recovery}`
  }
  if (event.type === 'agent_failed') return `[agent:failed] ${event.agent_label || event.agent_id} · ${event.error_code || 'AGENT_FAILED'}`
  if (event.type === 'phase_completed') return `[phase:done] ${location} · 结果=${JSON.stringify(event.result)} · 一致=${Boolean(event.unanimous)}`
  if (event.type === 'stage_started') return `[stage:start] ${location}`
  if (event.type === 'stage_completed') return `[stage:done] ${location}`
  if (event.type === 'action_calibration_completed') return `[program:action] Action门槛完成 · action=${event.action} · threshold=${Boolean(event.threshold_passed)}`
  if (event.type === 'risk_calibration_completed') return `[program:risk] Risk exact-set候选已冻结 · candidates=${event.candidate_count}`
  if (event.type === 'reviewer_candidate_pool_created') return `[reviewer:pool] 候选池已生成 · Action=${event.candidate_pool?.action_candidates?.length || 0} · Risk=${event.candidate_pool?.risk_candidates?.length || 0}`
  if (event.type === 'reviewer_selection_completed') return `[reviewer:selected] Action=${event.selected_action_candidate_id || '—'} · Risk=${event.selected_risk_candidate_id || '—'}`
  if (event.type === 'champion_gate_completed') return `[program:gate] Champion Gate=${event.gate || '—'} · finalized=${Boolean(event.decision_finalized)}`
  if (event.type === 'run_created') return `[run] ${event.run_id} · 证据=${event.evidence_count}`
  if (event.type === 'run_completed') return `[run:done] production_ready=${Boolean(event.production_ready)}`
  if (event.type === 'run_failed') return `[run:failed] ${event.error_code || 'RUN_FAILED'} · ${event.message || ''}`
  return `[${event.type || 'progress'}] ${location}`
}

function progressFor(event) {
  return PHASE_PROGRESS[event.phase] ?? PHASE_PROGRESS[event.stage] ?? 0
}

function publicJob(job) {
  return structuredClone(job)
}

function assertStartAnalysisConsent(userConsent, consentAction) {
  if (userConsent !== true || consentAction !== 'start_analysis') {
    throw badRequest('请点击“开始进件分析”授权并创建任务。')
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function notFound(message) {
  const error = new Error(message)
  error.statusCode = 404
  return error
}

module.exports = {
  ARTIFACT_KEYS,
  PHASE_PROGRESS,
  STANDARD_TASK,
  WebJobManager,
  discoverCases,
  mergeCompanyRecords,
  normalizeCompanyRecords,
  resolveCompany,
  shanghaiCalendarDate,
  summarizeRun
}
