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
    assert.ok(body.companies.some(company => company.company_id === '001' && company.selectable === true))
    process.stdout.write('Web smoke check passed with the bundled fictional company.\n')
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
