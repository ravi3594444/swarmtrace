#!/usr/bin/env node
/**
 * Applies supabase/migrations/*.sql in order, recording each in a
 * schema_migrations ledger so re-runs are no-ops.
 *
 *   npm run db:migrate                   apply pending migrations via psql
 *   npm run db:migrate -- --status       show applied vs pending
 *   npm run db:migrate -- --print        print pending SQL for the Supabase SQL editor
 *   npm run db:migrate -- --print --all  print every file (fresh project)
 *
 * Reads SUPABASE_DB_URL (or DATABASE_URL) from the environment or
 * frontend-next/.env.local and never logs it. Apply/status need `psql` on
 * PATH; --print needs neither psql nor a connection string. No pg driver
 * dependency since this runs on the operator's machine.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = join(HERE, '..')
const MIGRATIONS_DIR = join(FRONTEND_DIR, '..', 'supabase', 'migrations')

const BOOTSTRAP_SQL =
  'CREATE TABLE IF NOT EXISTS public.schema_migrations(' +
  ' version text PRIMARY KEY,' +
  ' applied_at timestamptz NOT NULL DEFAULT now());'

const args = process.argv.slice(2)
const MODE = {
  status: args.includes('--status') || args.includes('--check'),
  print: args.includes('--print'),
  all: args.includes('--all'),
  help: args.includes('--help') || args.includes('-h'),
}

if (MODE.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0])
  process.exit(0)
}

// Minimal .env parser (KEY=value, quotes, comments, `export `); existing
// process env wins.
function loadEnvLocal(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

const fileEnv = loadEnvLocal(join(FRONTEND_DIR, '.env.local'))
function env(name) {
  return process.env[name] || fileEnv[name] || ''
}

const DB_URL = env('SUPABASE_DB_URL') || env('DATABASE_URL')

function migrationFiles() {
  // strict pattern: the filename is interpolated into the ledger INSERT
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[A-Za-z0-9_]+\.sql$/.test(f))
    .sort()
}

function fail(msg, extra) {
  console.error(`error: ${msg}`)
  if (extra) console.error(extra)
  process.exit(1)
}

function psqlExists() {
  const r = spawnSync('psql', ['--version'], { encoding: 'utf8' })
  return r.status === 0
}

function psql(psqlArgs, { input } = {}) {
  return execFileSync('psql', [...psqlArgs, DB_URL], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

function appliedVersions() {
  const out = psql([
    '-AtX', '-v', 'ON_ERROR_STOP=1',
    '-c', 'SELECT version FROM public.schema_migrations ORDER BY version;',
  ])
  return new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
}

function main() {
  const files = migrationFiles()
  if (files.length === 0) fail(`no migration files found in ${MIGRATIONS_DIR}`)

  // --print needs neither psql nor a DB connection
  if (MODE.print) {
    let pending = files
    if (!MODE.all) {
      if (!DB_URL || !psqlExists()) {
        fail(
          '--print without --all needs to know what is already applied, which needs a DB connection and psql.',
          'Either set SUPABASE_DB_URL and install psql, or use `--print --all` to emit every file ' +
          '(the migrations are idempotent — safe to paste on a partially-migrated project; expect ' +
          'harmless "already exists"-style skips, not failures).'
        )
      }
      psql(['-X', '-v', 'ON_ERROR_STOP=1', '-c', BOOTSTRAP_SQL])
      const applied = appliedVersions()
      pending = files.filter((f) => !applied.has(f))
    }
    if (pending.length === 0) {
      console.log('-- all migrations already applied; nothing to print')
      return
    }
    for (const f of pending) {
      process.stdout.write(
        `\n-- ════════════════════════════════════════════════════════════\n` +
        `-- ${f}\n` +
        `-- ════════════════════════════════════════════════════════════\n\n`,
      )
      process.stdout.write(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    }
    console.log()
    return
  }

  // apply / --status need psql and a DB URL
  if (!psqlExists()) {
    fail(
      '`psql` not found on PATH.',
      'Install the PostgreSQL client (e.g. `brew install libpq`, `apt install postgresql-client`)\n' +
      'or use `--print` to generate SQL you can paste into the Supabase SQL editor:\n' +
      '  node scripts/run-migrations.mjs --print --all | pbcopy'
    )
  }
  if (!DB_URL) {
    fail(
      'no database connection string found (SUPABASE_DB_URL or DATABASE_URL).',
      'Find it in Supabase Dashboard → Project Settings → Database → Connection string (URI),\n' +
      'e.g. postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres\n' +
      'Add it to frontend-next/.env.local as SUPABASE_DB_URL=..., or export it in your shell.\n' +
      'Note: if your network is IPv4-only and the direct (5432) host fails, use the\n' +
      'session-pooler host (...pooler.supabase.com:5432) from the same page.'
    )
  }

  psql(['-X', '-v', 'ON_ERROR_STOP=1', '-c', BOOTSTRAP_SQL])
  const applied = appliedVersions()
  const pending = files.filter((f) => !applied.has(f))

  if (MODE.status) {
    console.log(`migrations directory: ${MIGRATIONS_DIR}`)
    for (const f of files) {
      console.log(`  ${applied.has(f) ? '✓ applied' : '… PENDING'}  ${f}`)
    }
    console.log(pending.length === 0 ? 'up to date.' : `${pending.length} migration(s) pending.`)
    return
  }

  if (pending.length === 0) {
    console.log('✓ all migrations already applied — schema is up to date.')
    return
  }

  console.log(`applying ${pending.length} migration(s):`)
  const tmp = mkdtempSync(join(tmpdir(), 'swarmtrace-migrate-'))
  try {
    for (const f of pending) {
      process.stdout.write(`  → ${f} … `)
      try {
        // Migration and ledger insert run in one transaction. psql doesn't
        // substitute :variables inside -c strings, so append the insert to a
        // temp copy of the file and run it with --single-transaction. The
        // filename regex already forbids quotes; escape anyway.
        const combined =
          readFileSync(join(MIGRATIONS_DIR, f), 'utf8') +
          `\n-- ledger (appended by run-migrations.mjs)\n` +
          `INSERT INTO public.schema_migrations(version) VALUES ('${f.replace(/'/g, "''")}') ON CONFLICT DO NOTHING;\n`
        const tmpFile = join(tmp, f)
        writeFileSync(tmpFile, combined)
        psql(['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', tmpFile])
        process.stdout.write('ok\n')
      } catch {
        process.stdout.write('FAILED\n')
        // psql already printed its own stderr (stdio: inherit)
        fail(
          `migration ${f} failed; nothing from it was recorded (single transaction — rolled back). ` +
          `Fix the error above, then re-run. Completed migrations were recorded in public.schema_migrations.`,
        )
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log('✓ done. Verify with: curl <your-dashboard>/api/health/db')
}

main()
