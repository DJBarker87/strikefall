import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const SOURCE_PROVENANCE_SCHEMA = 1

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedRelative(root, candidate) {
  const normalized = relative(root, candidate).split(sep).join('/')
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`evidence input escapes the repository: ${candidate}`)
  }
  return normalized
}

async function filesBelow(root, input) {
  const absolute = resolve(root, input)
  normalizedRelative(root, absolute)
  const metadata = await lstat(absolute)
  if (metadata.isSymbolicLink()) {
    throw new Error(`evidence inputs must not be symbolic links: ${input}`)
  }
  if (metadata.isFile()) return [absolute]
  if (!metadata.isDirectory()) throw new Error(`unsupported evidence input: ${input}`)

  const children = await readdir(absolute, { withFileTypes: true })
  const collected = []
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = resolve(absolute, child.name)
    if (child.isSymbolicLink()) {
      throw new Error(`evidence inputs must not contain symbolic links: ${normalizedRelative(root, childPath)}`)
    }
    if (child.isDirectory()) collected.push(...await filesBelow(root, normalizedRelative(root, childPath)))
    else if (child.isFile()) collected.push(childPath)
  }
  return collected
}

/**
 * Hashes a declared, repository-relative source set. The aggregate includes
 * every normalized path, byte count, and file digest, so renames and empty-file
 * substitutions cannot preserve the tree digest.
 */
export async function collectSourceProvenance(rootDirectory, declaredRoots) {
  const root = resolve(rootDirectory)
  if (!Array.isArray(declaredRoots) || declaredRoots.length === 0) {
    throw new Error('at least one evidence source root is required')
  }
  const roots = [...new Set(declaredRoots)].sort()
  if (roots.length !== declaredRoots.length) throw new Error('evidence source roots must be unique')

  const absoluteFiles = []
  for (const input of roots) absoluteFiles.push(...await filesBelow(root, input))
  const paths = [...new Set(absoluteFiles.map((file) => normalizedRelative(root, file)))].sort()
  const files = {}
  const tree = createHash('sha256')
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path))
    const digest = sha256(bytes)
    files[path] = { bytes: bytes.byteLength, sha256: digest }
    tree.update(path)
    tree.update('\0')
    tree.update(String(bytes.byteLength))
    tree.update('\0')
    tree.update(digest)
    tree.update('\n')
  }
  return {
    schemaVersion: SOURCE_PROVENANCE_SCHEMA,
    algorithm: 'sha256',
    roots,
    fileCount: paths.length,
    treeSha256: tree.digest('hex'),
    files,
  }
}

export async function verifySourceProvenance(rootDirectory, expected) {
  if (expected?.schemaVersion !== SOURCE_PROVENANCE_SCHEMA) {
    throw new Error(`unsupported source provenance schema: ${expected?.schemaVersion}`)
  }
  if (expected.algorithm !== 'sha256') throw new Error('source provenance must use sha256')
  const actual = await collectSourceProvenance(rootDirectory, expected.roots)
  if (actual.treeSha256 !== expected.treeSha256) {
    throw new Error(`source tree digest mismatch: report=${expected.treeSha256} current=${actual.treeSha256}`)
  }
  if (actual.fileCount !== expected.fileCount) {
    throw new Error(`source file count mismatch: report=${expected.fileCount} current=${actual.fileCount}`)
  }
  const expectedPaths = Object.keys(expected.files ?? {}).sort()
  const actualPaths = Object.keys(actual.files)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('source file inventory does not match the report')
  }
  for (const path of actualPaths) {
    const retained = expected.files[path]
    const current = actual.files[path]
    if (retained?.sha256 !== current.sha256 || retained?.bytes !== current.bytes) {
      throw new Error(`source input mismatch: ${path}`)
    }
  }
  return actual
}

function optionalCommand(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** Records release identity honestly even in a new/uncommitted worktree. */
export function gitProvenance(rootDirectory, sourceRoots) {
  const root = resolve(rootDirectory)
  const commit = optionalCommand('git', ['rev-parse', '--verify', 'HEAD'], root)
  const status = optionalCommand(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...sourceRoots],
    root,
  )
  return {
    commit: commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null,
    worktree: status === null ? 'unavailable' : status.length === 0 ? 'clean' : 'dirty',
    statusSha256: status === null ? null : sha256(status),
  }
}
