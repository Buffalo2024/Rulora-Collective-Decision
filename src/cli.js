#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildCompanyCase, findCompanyRecord, refreshCaseFromEvidencePacket } = require('./case-builder')
const { applyImprovementProposal, recordLabeledRun, recordUserFeedback, rollbackGeneration } = require('./evolution')
const { executeImprovementSupervisor } = require('./improvement-supervisor')
const { PopulationStore } = require('./population-store')
const { ManualAssistanceService } = require('./manual-assistance')
const { ProviderHealthMonitor, macosProviderNotifier } = require('./provider-health-monitor')
const { PublicMonitorService } = require('./monitor-service')
const { PublicSourceCollector } = require('./source-collector')
const { runCase } = require('./orchestrator')
const { projectRoot } = require('./rulora-loader')
const { buildSubmission } = require('./submission')
const { readJson, sha256, writeJsonAtomic } = require('./utils')
const { runFormalBatch } = require('./batch-runner')
const { buildDeterministicComparisonReport } = require('./competition-comparison')

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const options = parseOptions(rest)
  if (command === 'batch-run') {
    requireOption(options, 'config')
    const result = await runFormalBatch({ configPath: options.config })
    console.log(JSON.stringify({ status: result.status, production_ready_count: result.production_ready_count, submission: result.submission, source_catalog_path: result.source_catalog_path }, null, 2))
    if (result.status !== 'complete') process.exitCode = 2
    return
  }
  if (command === 'resume-paused-cases') {
    requireOption(options, 'config')
    const result = await runFormalBatch({ configPath: options.config, onlyPaused: true })
    console.log(JSON.stringify({ status: result.status, production_ready_count: result.production_ready_count, resumed_paused_only: true }, null, 2))
    return
  }
  if (command === 'run') {
    requireOption(options, 'input')
    requireOption(options, 'out-dir')
    const run = await runCase({
      inputPath: options.input,
      outputDirectory: options['out-dir'],
      allowFixture: Boolean(options.fixture),
      allowBaseline: Boolean(options.baseline),
      mode: options.mode || 'business',
      champion: options.champion ? await readJson(path.resolve(options.champion)) : null,
      reuseFrozenEvidence: Boolean(options['reuse-frozen-evidence'])
    })
    console.log(JSON.stringify({ run_id: run.run_id, probabilities: run.consensus.probabilities, action: run.consensus.action, artifacts: run.artifacts }, null, 2))
    return
  }
  if (command === 'competition-compare') {
    requireOption(options, 'champion')
    requireOption(options, 'runs')
    requireOption(options, 'out')
    const report = await buildDeterministicComparisonReport({
      championPath: options.champion,
      challengerRunPaths: String(options.runs).split(',').map(value => value.trim()).filter(Boolean),
      outputPath: options.out,
      championScore: options['champion-score'] === undefined ? null : Number(options['champion-score']),
      priorScore: options['prior-score'] === undefined ? null : Number(options['prior-score'])
    })
    console.log(JSON.stringify({ output: path.resolve(options.out), recommendation: report.recommendation, comparison_count: report.comparisons.length }, null, 2))
    return
  }
  if (command === 'collect') {
    requireOption(options, 'request')
    requireOption(options, 'out')
    const request = await readJson(path.resolve(options.request))
    const packet = await new PublicSourceCollector().collect(request)
    await writeJsonAtomic(path.resolve(options.out), packet)
    console.log(JSON.stringify({
      request_id: packet.request_id,
      status: packet.status,
      evidence_count: packet.evidence.length,
      quarantined_count: packet.quarantined.length,
      source_runs: packet.source_runs,
      packet_sha256: packet.packet_sha256,
      output: path.resolve(options.out)
    }, null, 2))
    if (packet.status === 'awaiting_manual_assistance') process.exitCode = 2
    return
  }
  if (command === 'build-case') {
    requireOption(options, 'companies')
    requireOption(options, 'company-id')
    requireOption(options, 'evidence')
    requireOption(options, 'out')
    const [companies, evidencePacket] = await Promise.all([
      readJson(path.resolve(options.companies)),
      readJson(path.resolve(options.evidence))
    ])
    const companyRecord = findCompanyRecord(companies, options['company-id'])
    const caseData = buildCompanyCase({
      companyRecord,
      evidencePacket,
      monitoringMode: options.active ? 'active' : 'passive'
    })
    await writeJsonAtomic(path.resolve(options.out), caseData)
    console.log(JSON.stringify({ case_id: caseData.case_id, evidence_count: caseData.evidence.length, output: path.resolve(options.out) }, null, 2))
    return
  }
  if (command === 'refresh-case') {
    requireOption(options, 'base')
    requireOption(options, 'evidence')
    requireOption(options, 'out')
    const [baseCase, evidencePacket] = await Promise.all([
      readJson(path.resolve(options.base)),
      readJson(path.resolve(options.evidence))
    ])
    const caseData = refreshCaseFromEvidencePacket({ baseCase, evidencePacket })
    await writeJsonAtomic(path.resolve(options.out), caseData)
    console.log(JSON.stringify({ case_id: caseData.case_id, evidence_count: caseData.evidence.length, output: path.resolve(options.out) }, null, 2))
    return
  }
  if (command === 'assist-list') {
    const service = new ManualAssistanceService({ root: projectRoot() })
    const requests = await service.list({ status: options.status === true ? undefined : options.status })
    console.log(JSON.stringify({ count: requests.length, requests: requests.map(item => ({
      assistance_id: item.assistance_id,
      source_id: item.source_id,
      company: item.company,
      as_of_date: item.as_of_date,
      status: item.status,
      updated_at: item.updated_at
    })) }, null, 2))
    return
  }
  if (command === 'assist-show') {
    requireOption(options, 'id')
    const result = await new ManualAssistanceService({ root: projectRoot() }).get(options.id)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'assist-notify') {
    requireOption(options, 'id')
    const result = await new ManualAssistanceService({ root: projectRoot() }).notify(options.id)
    console.log(JSON.stringify(result, null, 2))
    if (!result.notification_delivery.delivered) process.exitCode = 2
    return
  }
  if (command === 'assist-import') {
    requireOption(options, 'id')
    requireOption(options, 'file')
    requireOption(options, 'metadata')
    const result = await new ManualAssistanceService({ root: projectRoot() }).importEvidence({
      assistanceId: options.id,
      filePath: options.file,
      metadataPath: options.metadata
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'provider-health') {
    const root = projectRoot()
    const execution = await readJson(path.join(root, 'config', 'execution.json'))
    const monitor = new ProviderHealthMonitor({ root, config: execution.provider_connectivity })
    const profiles = await monitor.status()
    console.log(JSON.stringify({
      healthy: profiles.length > 0 && profiles.every(item => item.status === 'healthy'),
      profiles: profiles.map(item => ({
        profile_id: item.profile_id,
        model: item.model,
        status: item.status,
        consecutive_failed_calls: item.consecutive_failed_calls,
        consecutive_failed_attempts: item.consecutive_failed_attempts,
        last_failure_category: item.last_failure_category || null,
        last_failure_at: item.last_failure_at,
        last_success_at: item.last_success_at,
        alert_active: item.alert_active
      })),
      alert_log: monitor.alertLogPath
    }, null, 2))
    return
  }
  if (command === 'provider-alert-test') {
    const result = await Promise.resolve(macosProviderNotifier({ type: 'notification_test' }))
    console.log(JSON.stringify({ notification_test: result }, null, 2))
    if (!result.delivered) process.exitCode = 2
    return
  }
  if (command === 'watch-register') {
    requireOption(options, 'run')
    requireOption(options, 'runtime-dir')
    const run = await readJson(path.resolve(options.run))
    const watch = await new PublicMonitorService({ runtimeDirectory: options['runtime-dir'] }).registerFromRun(run)
    console.log(JSON.stringify({ watch_id: watch.watch_id, schedule: watch.schedule, runtime_directory: path.resolve(options['runtime-dir']) }, null, 2))
    return
  }
  if (command === 'watch-run') {
    requireOption(options, 'watch-id')
    requireOption(options, 'runtime-dir')
    const output = await new PublicMonitorService({ runtimeDirectory: options['runtime-dir'] }).run(options['watch-id'], {
      asOfDate: options['as-of-date'] || new Date().toISOString().slice(0, 10)
    })
    if (output.result.trigger_reanalysis && options['reanalyze-out-dir']) {
      output.reanalysis = await runCase({
        inputPath: output.result.reanalysis_case_path,
        outputDirectory: options['reanalyze-out-dir'],
        allowFixture: Boolean(options.fixture),
        allowBaseline: Boolean(options.baseline)
      })
      output.reanalysis = {
        run_id: output.reanalysis.run_id,
        report: output.reanalysis.artifacts.report_json,
        production_ready: output.reanalysis.report.qa.production_ready
      }
    }
    console.log(JSON.stringify(output, null, 2))
    return
  }
  if (command === 'build-submission') {
    requireOption(options, 'reports')
    requireOption(options, 'out')
    const reportPaths = String(options.reports).split(',').map(value => value.trim()).filter(Boolean)
    const expectedCompanyIds = options['expected-company-ids']
      ? String(options['expected-company-ids']).split(',').map(value => value.trim()).filter(Boolean)
      : []
    const result = await buildSubmission({ reportPaths, outputPath: options.out, expectedCompanyIds })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'evaluate') {
    requireOption(options, 'run')
    requireOption(options, 'truth')
    const root = projectRoot()
    const [roles, config, run, truth] = await Promise.all([
      readJson(path.join(root, 'config', 'agents.json')),
      readJson(path.join(root, 'config', 'evolution.json')),
      verifyRunArtifact(path.resolve(options.run)),
      readJson(path.resolve(options.truth))
    ])
    const store = new PopulationStore({ filePath: path.join(root, '.runtime', 'population.json'), roles: roles.roles })
    let result
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await store.load()
      result = recordLabeledRun(state, run, truth, config)
      if (result.evolution?.spawned) {
        const execution = await executeImprovementSupervisor({ state: result.state, evolutionEvent: result.evolution, config })
        applyImprovementProposal(result.state, result.evolution, execution.proposal, config, {
          provider_mode: execution.provider_mode,
          provider_production_ready: execution.provider_production_ready,
          degraded: execution.diagnostics.degraded
        })
      }
      try {
        await store.save(result.state)
        break
      } catch (error) {
        if (error.code !== 'CAS_CONFLICT' || attempt === 2) throw error
      }
    }
    console.log(JSON.stringify({ duplicate: result.duplicate, evaluation: result.evaluation, evolution: result.evolution }, null, 2))
    return
  }
  if (command === 'improve-check') {
    const root = projectRoot()
    const [roles, config] = await Promise.all([
      readJson(path.join(root, 'config', 'agents.json')),
      readJson(path.join(root, 'config', 'evolution.json'))
    ])
    const state = {
      active: roles.roles.filter(item => config.eligible_seat_ids.includes(item.id)).map((item, index) => ({
        slot_id: item.id,
        agent_id: item.id,
        version: 1,
        participates_in_debate: true,
        metrics: { cases: 20, direction_correct: 10 + index, advice_f1_sum: 10 + index, fitness: 0.5 + index * 0.05 }
      })),
      evaluated_case_ids: Array.from({ length: 20 }, (_, index) => `synthetic-case-${index + 1}`),
      user_feedback: []
    }
    const eligible = state.active
      .sort((left, right) => left.metrics.fitness - right.metrics.fitness || left.slot_id.localeCompare(right.slot_id))
    if (!eligible.length) throw new Error('no eligible debate seat for improvement connectivity check')
    const event = {
      checkpoint: 1,
      evaluated_cases: 20,
      spawned: { slot_id: eligible[0].slot_id, challenger_agent_id: 'connectivity-check-not-applied' }
    }
    const execution = await executeImprovementSupervisor({ state, evolutionEvent: event, config, allowFixture: Boolean(options.fixture), allowBaseline: Boolean(options.baseline) })
    console.log(JSON.stringify({ applied: false, proposal: execution.proposal, diagnostics: execution.diagnostics, provider_mode: execution.provider_mode }, null, 2))
    return
  }
  if (command === 'feedback') {
    requireOption(options, 'input')
    const root = projectRoot()
    const [roles, config, feedback] = await Promise.all([
      readJson(path.join(root, 'config', 'agents.json')),
      readJson(path.join(root, 'config', 'evolution.json')),
      readJson(path.resolve(options.input))
    ])
    const store = new PopulationStore({ filePath: path.join(root, '.runtime', 'population.json'), roles: roles.roles })
    let result
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await store.load()
      result = recordUserFeedback(state, feedback, config)
      try {
        await store.save(result.state)
        break
      } catch (error) {
        if (error.code !== 'CAS_CONFLICT' || attempt === 2) throw error
      }
    }
    console.log(JSON.stringify({ duplicate: result.duplicate, feedback_id: feedback.feedback_id }, null, 2))
    return
  }
  if (command === 'rollback') {
    const root = projectRoot()
    const roles = await readJson(path.join(root, 'config', 'agents.json'))
    const store = new PopulationStore({ filePath: path.join(root, '.runtime', 'population.json'), roles: roles.roles })
    const state = await store.load()
    const target = options.generation ? Number(options.generation) : state.generation - 1
    rollbackGeneration(state, target)
    const saved = await store.save(state)
    console.log(JSON.stringify({ generation: saved.generation, checkpoint: saved.checkpoint, rollback_target: target }, null, 2))
    return
  }
  if (command === 'status' || command === 'evolve') {
    const root = projectRoot()
    const [roles, config] = await Promise.all([
      readJson(path.join(root, 'config', 'agents.json')),
      readJson(path.join(root, 'config', 'evolution.json'))
    ])
    const store = new PopulationStore({ filePath: path.join(root, '.runtime', 'population.json'), roles: roles.roles })
    const state = await store.load()
    console.log(JSON.stringify({
      generation: state.generation,
      checkpoint: state.checkpoint,
      evaluated_cases: state.evaluated_case_ids.length,
      next_checkpoint_in: config.evaluation_batch_size - (state.evaluated_case_ids.length % config.evaluation_batch_size),
      promotion_enabled_after: config.minimum_evaluated_cases_before_promotion,
      active: state.active,
      challengers: state.challengers || [],
      latest_evolution: state.evolution_log.at(-1) || null
    }, null, 2))
    return
  }
  console.log('Usage:\n  node src/cli.js batch-run --config config/batch.json\n  node src/cli.js resume-paused-cases --config config/batch.json\n  node src/cli.js collect --request REQUEST.json --out EVIDENCE.json\n  node src/cli.js assist-list [--status awaiting_user_action]\n  node src/cli.js assist-show --id ASSISTANCE_ID\n  node src/cli.js assist-notify --id ASSISTANCE_ID\n  node src/cli.js assist-import --id ASSISTANCE_ID --file ORIGINAL_FILE --metadata RESPONSE.json\n  node src/cli.js provider-health\n  node src/cli.js provider-alert-test\n  node src/cli.js build-case --companies VALIDATION.json --company-id 002 --evidence EVIDENCE.json --out CASE.json [--active]\n  node src/cli.js refresh-case --base CASE.json --evidence EVIDENCE.json --out CASE.json\n  node src/cli.js watch-register --run RUN.json --runtime-dir DIR\n  node src/cli.js watch-run --watch-id WATCH --runtime-dir DIR [--as-of-date YYYY-MM-DD] [--reanalyze-out-dir DIR]\n  node src/cli.js run --input CASE.json --out-dir DIR [--mode competition_calibrated_v2|competition_calibrated|competition_legacy|business] [--champion CHAMPION.json] [--reuse-frozen-evidence] [--baseline|--fixture]\n  node src/cli.js competition-compare --champion CHAMPION_ROWS.json --runs RUN1.json,RUN2.json --out comparison.json\n  node src/cli.js build-submission --reports REPORT1.json,REPORT2.json --out submission.csv [--expected-company-ids 001,002]\n  node src/cli.js evaluate --run RUN.json --truth TRUTH.json\n  node src/cli.js feedback --input USER-FEEDBACK.json\n  node src/cli.js rollback [--generation N]\n  node src/cli.js status')
}

async function verifyRunArtifact(runPath) {
  if (!runPath.endsWith('.json') || runPath.endsWith('.report.json') || runPath.endsWith('.manifest.json')) throw new Error('evaluate --run must point to the committed run JSON')
  const bytes = await fs.readFile(runPath)
  const run = JSON.parse(bytes.toString('utf8'))
  const manifestPath = runPath.replace(/\.json$/, '.manifest.json')
  const manifest = await readJson(manifestPath)
  if (manifest.status !== 'committed' || manifest.production_ready !== true || manifest.run_id !== run.run_id) throw new Error('run manifest is missing, mismatched, or non-production')
  if (manifest.files?.run_json?.sha256 !== sha256(bytes)) throw new Error('run JSON hash does not match committed manifest')
  return run
}

function parseOptions(argumentsList) {
  const options = {}
  for (let index = 0; index < argumentsList.length; index += 1) {
    const item = argumentsList[index]
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`)
    const key = item.slice(2)
    const next = argumentsList[index + 1]
    if (!next || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return options
}

function requireOption(options, key) {
  if (!options[key] || options[key] === true) throw new Error(`--${key} is required`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
