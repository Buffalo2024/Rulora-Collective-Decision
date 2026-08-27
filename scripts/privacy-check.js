'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const skipped = new Set(['.git', 'node_modules', '.runtime', 'output'])
const binary = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.pptx', '.zip'])
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['local absolute path', /\/Users\/Jeff\//],
  ['Chinese mobile number', /\b1[3-9]\d{9}\b/],
  ['Chinese citizen id', /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[0-9Xx]\b/]
]
const forbiddenNames = ['广州市' + '浩洋', '索菲亚' + '家居', 'validation-' + 'companies', 'real-' + 'company']
const findings = []
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) visit(file)
    else if (!binary.has(path.extname(entry.name))) {
      const value = fs.readFileSync(file, 'utf8')
      for (const [label, pattern] of rules) if (pattern.test(value)) findings.push(`${path.relative(root, file)}: ${label}`)
      for (const name of forbiddenNames) if (value.includes(name)) findings.push(`${path.relative(root, file)}: forbidden real-data marker`)
    }
  }
}
visit(root)
const sourceConfig = JSON.parse(fs.readFileSync(path.join(root, 'config/public-sources.json'), 'utf8'))
for (const source of sourceConfig.sources) if (source.production_ingest_enabled) findings.push(`config/public-sources.json: ${source.id} is enabled`)
if (findings.length) { console.error(findings.join('\n')); process.exit(1) }
console.log('Privacy check passed: no secret, PII, real-data marker, local path, or enabled public collector found.')
