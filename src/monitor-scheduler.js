const PgBoss = require('pg-boss')

const ACTIVE_QUEUE = 'active-public-monitor-dispatch'
const PASSIVE_QUEUE = 'passive-public-evidence-collection'

class MonitorScheduler {
  constructor({ connectionString, schema = 'risk_agents' }) {
    if (!connectionString) throw new Error('PostgreSQL connectionString is required')
    this.boss = new PgBoss({ connectionString, schema })
    this.started = false
  }

  async start() {
    await this.boss.start()
    await this.boss.createQueue(ACTIVE_QUEUE, { policy: 'singleton', retryLimit: 3, expireInMinutes: 30 })
    await this.boss.createQueue(PASSIVE_QUEUE, { policy: 'standard', retryLimit: 2, expireInMinutes: 30 })
    this.started = true
  }

  async registerHandlers({ runActiveDispatch, runPassiveCollection }) {
    this.assertStarted()
    if (typeof runActiveDispatch !== 'function' || typeof runPassiveCollection !== 'function') {
      throw new Error('both active and passive handlers are required')
    }
    await this.boss.work(ACTIVE_QUEUE, async ([job]) => runActiveDispatch(job.data))
    await this.boss.work(PASSIVE_QUEUE, async ([job]) => runPassiveCollection(job.data))
  }

  async scheduleActiveDispatch(cron, { timezone = 'Asia/Shanghai' } = {}) {
    this.assertStarted()
    await this.boss.schedule(ACTIVE_QUEUE, cron, { public_information_only: true }, { tz: timezone })
  }

  async enqueuePassiveCollection(request) {
    this.assertStarted()
    if (!request?.case_id || !request?.as_of_date) throw new Error('passive request requires case_id and as_of_date')
    return this.boss.send(PASSIVE_QUEUE, {
      ...request,
      public_information_only: true
    }, {
      singletonKey: `${request.case_id}:${request.as_of_date}`,
      retryLimit: 2
    })
  }

  async stop() {
    if (this.started) await this.boss.stop()
    this.started = false
  }

  assertStarted() {
    if (!this.started) throw new Error('monitor scheduler has not started')
  }
}

module.exports = { ACTIVE_QUEUE, PASSIVE_QUEUE, MonitorScheduler }
