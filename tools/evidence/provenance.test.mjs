import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectSourceProvenance, verifySourceProvenance } from './provenance.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'strikefall-evidence-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'Cargo.lock'), 'locked\n')
  await writeFile(join(root, 'src', 'a.rs'), 'pub fn a() {}\n')
  return root
}

test('source provenance is deterministic and verifies the full inventory', async () => {
  const root = await fixture()
  try {
    const first = await collectSourceProvenance(root, ['src', 'Cargo.lock'])
    const second = await collectSourceProvenance(root, ['Cargo.lock', 'src'])
    assert.equal(first.treeSha256, second.treeSha256)
    assert.equal(first.fileCount, 2)
    await verifySourceProvenance(root, first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verification detects changed bytes and newly added source files', async () => {
  const root = await fixture()
  try {
    const retained = await collectSourceProvenance(root, ['Cargo.lock', 'src'])
    await writeFile(join(root, 'src', 'a.rs'), 'pub fn changed() {}\n')
    await assert.rejects(verifySourceProvenance(root, retained), /source tree digest mismatch/)

    await writeFile(join(root, 'src', 'a.rs'), 'pub fn a() {}\n')
    await writeFile(join(root, 'src', 'new.rs'), 'pub fn new() {}\n')
    await assert.rejects(verifySourceProvenance(root, retained), /source tree digest mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('source roots cannot escape the repository or traverse symbolic links', async () => {
  const root = await fixture()
  try {
    await assert.rejects(collectSourceProvenance(root, ['../outside']), /escapes the repository/)
    await symlink(join(root, 'Cargo.lock'), join(root, 'src', 'linked-lock'))
    await assert.rejects(collectSourceProvenance(root, ['src']), /symbolic links/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
