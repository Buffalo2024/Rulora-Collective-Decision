#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const { createWebServer } = require('../src/web-server')

async function main() {
  const { server } = await createWebServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/api/companies`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(Array.isArray(body.companies))
    assert.equal(body.companies.filter(company => company.selectable).length, 25)
    assert.deepEqual(body.companies.slice(0, 25).map(company => Number(company.company_id)), Array.from({ length: 25 }, (_, index) => index + 1))
    const suffix = Date.now()
    const importedRecord = {
      company_name: `前端导入测试企业${suffix}`,
      taxpayer_id: `TEST-TAX-${suffix}`,
      industry: '软件和信息技术服务',
      business_scope: '软件开发、信息系统集成与技术服务'
    }
    const importResponse = await fetch(`http://127.0.0.1:${address.port}/api/companies/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'web-smoke-company.json',
        content_base64: Buffer.from(JSON.stringify({ records: [importedRecord] })).toString('base64')
      })
    })
    assert.equal(importResponse.status, 200)
    const imported = (await importResponse.json()).result.companies[0]
    assert.ok(Number(imported.company_id) > 25)
    assert.equal(imported.selectable, true)
    assert.equal(imported.intake_required, true)
    process.stdout.write('Web smoke check passed with demo companies 1 through 25 and one imported company ready for intake.\n')
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
