#!/usr/bin/env node
/**
 * run-migrations.mjs — apply supabase/migrations/*.sql to the project's
 * database, in order, with a schema_migrations ledger so re-runs are no-ops.
 *
 * WHY: the #1 production failure mode is "dashboard deployed, migrations
 * never applied" → every POST to /api/ingest 500s and no traces appear on
 * the dashboard. Applying twelve SQL files by hand in the Supabase SQL
 * editor (in the right order!) is exactly the kind of step people miss.
 * This makes it one command.
 *
 * Usage (from frontend-next/):
 *
 *   npm run db:migrate                 # apply pending migrations via psql
 *   npm run db:migrate -- --status     # show applied vs pending, apply nothing
 *   npm run db:migrate -- --print      # print pending SQL for the Supabase SQL editor
 *   npm run db:migrate -- --print --all  # print ALL files (fresh project bootstrap)
 *
 * Connection: reads SUPABASE_DB_URL (fallback DATABASE_URL) from the
 * environment or frontend-next/.env.local — the Postgres connection string
 * from Supabase Dashboard → Project Settings → Database → Connection string
 * (URI). It's never logged. Requires `psql` on PATH for the apply/status
 * modes; --print works without psql and without a connection string.
 *
 * Dependencies: none beyond Node >= 18 and psql. Deliberately does NOT add
 * a pg driver to package.json — this runs on the operator's machine, not
 * in Vercel.
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

// ── args ──────────────────────────────────────────────────────────────────
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

// ── env loading (.env.local, then process env) ────────────────────────────
// Minimal .env parser — no dotenv dependency. Handles KEY=value, quotes,
// comments, and `export ` prefixes. Existing process env wins.
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

// ── migration files ───────────────────────────────────────────────────────
function migrationFiles() {
  // Strict pattern: the filename is also interpolated into the ledger INSERT
  // (quoted), so keep it free of anything unusual beyond word characters.
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[A-Za-z0-9_]+\.sql$/.test(f))
    .sort()
}

function fail(msg, extra) {
  console.error(`error: ${msg}`)
  if (extra) console.error(extra)
  process.exit(1)
}

// ── psql helpers ──────────────────────────────────────────────────────────
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

// ── modes ─────────────────────────────────────────────────────────────────
function main() {
  const files = migrationFiles()
  if (files.length === 0) fail(`no migration files found in ${MIGRATIONS_DIR}`)

  // --print never needs psql or a DB connection.
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

  // apply / --status need psql + DB URL.
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
        // Migration file + ledger insert in ONE transaction: either both
        // happen or neither does. NOTE: psql does NOT perform :variable
        // substitution inside -c strings, so the ledger insert can't be a
        // separate -c; instead concatenate the file + insert into a temp
        // file and run it under --single-transaction. The filename regex in
        // migrationFiles() already forbids quotes; escape defensively anyway.
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
        // psql's own stderr was already printed (stdio: inherit).
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
