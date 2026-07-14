import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('schema-ig.sql define ig_queue e ig_config', () => {
  const sql = readFileSync(new URL('../schema-ig.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ig_queue/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ig_config/)
})
