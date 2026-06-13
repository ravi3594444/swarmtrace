'use client'

import { useState, useEffect, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Bell, Save, Check, Copy, Trash2, AlertCircle, Key, CreditCard, Puzzle, Settings2, Terminal, BookOpen } from 'lucide-react'
import { fetchApiKeys, createApiKey, revokeApiKey, fetchIntegrations, fetchBillingInfo } from '@/lib/api'
import { SkeletonCard } from '@/components/skeleton'

// ─── Types ────────────────────────────────────────────────────────────────────
interface ApiKey { id: string; name: string; created: string; last_used?: string | null; prefix: string }
interface Integration { id: string; name: string; description: string; connected: boolean }
interface BillingInfo {
  plan?: string
  price?: number
  // API returns these field names:
  traces_used?: number
  traces_limit?: number
  cost_this_month?: number
  next_billing?: string
  // Fallback fields:
  nextBilling?: string
  paymentMethod?: string
}

// ─── Billing Page ─────────────────────────────────────────────────────────────
function BillingTab() {
  const plans = [
    {
      name: 'Hobby',
      price: 0,
      period: 'Free forever',
      description: 'For personal projects and experimentation.',
      features: ['10,000 traces / month', '1 API key', '7-day retention', 'Community support'],
      cta: 'Current Plan',
      current: true,
      highlight: false,
    },
    {
      name: 'Pro',
      price: 19,
      period: 'per month',
      description: 'For teams shipping AI to production.',
      features: ['1,000,000 traces / month', 'Unlimited API keys', '90-day retention', 'Realtime dashboard', 'CSV & PDF export', 'Email support'],
      cta: 'Upgrade to Pro',
      current: false,
      highlight: true,
    },
    {
      name: 'Enterprise',
      price: null,
      period: 'Custom pricing',
      description: 'For large-scale deployments with custom needs.',
      features: ['Unlimited traces', 'Custom retention', 'SSO / SAML', 'SLA guarantee', 'Dedicated support', 'On-prem option'],
      cta: 'Contact Us',
      current: false,
      highlight: false,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Current usage summary */}
      <div className="bg-surface-container border border-outline rounded-2xl p-6">
        <h2 className="text-xl font-semibold text-on-surface mb-1">Current Usage</h2>
        <p className="text-sm text-on-surface-variant mb-5">You are on the <span className="text-primary font-semibold">Hobby</span> plan.</p>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Traces this month', value: '—', max: '10,000' },
            { label: 'API Keys', value: '—', max: '1' },
            { label: 'Data retention', value: '7 days', max: null },
          ].map(({ label, value, max }) => (
            <div key={label} className="bg-surface-container-low border border-outline/50 rounded-xl p-4">
              <p className="text-xs text-on-surface-variant mb-1">{label}</p>
              <p className="text-lg font-bold text-on-surface">
                {value}
                {max && <span className="text-sm font-normal text-on-surface-variant"> / {max}</span>}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`relative border rounded-2xl p-6 flex flex-col gap-4 transition-all ${
              plan.highlight
                ? 'border-primary/60 bg-primary/5 shadow-sm shadow-primary/10'
                : 'border-outline bg-surface-container'
            }`}
          >
            {plan.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1 rounded-full">
                Most Popular
              </span>
            )}
            <div>
              <h3 className="text-lg font-bold text-on-surface">{plan.name}</h3>
              <p className="text-sm text-on-surface-variant mt-0.5">{plan.description}</p>
            </div>
            <div>
              {plan.price !== null
                ? <span className="text-3xl font-bold text-on-surface">${plan.price}<span className="text-sm font-normal text-on-surface-variant"> /{plan.period}</span></span>
                : <span className="text-2xl font-bold text-on-surface">{plan.period}</span>
              }
            </div>
            <ul className="space-y-2 flex-1">
              {plan.features.map(f => (
                <li key={f} className="flex items-center gap-2 text-sm text-on-surface-variant">
                  <span className="w-4 h-4 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 text-xs font-bold">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <button
              disabled={plan.current}
              onClick={() => {
                if (plan.name === 'Enterprise') window.open('mailto:hello@swarmtrace.ai?subject=Enterprise Plan', '_blank')
              }}
              className={`w-full py-2.5 rounded-full text-sm font-semibold transition-all ${
                plan.current
                  ? 'bg-surface-container-high text-on-surface-variant cursor-default border border-outline'
                  : plan.highlight
                  ? 'bg-primary text-primary-foreground hover:opacity-90'
                  : 'border border-outline text-on-surface hover:bg-surface-container-high'
              }`}
            >
              {plan.cta}
            </button>
          </div>
        ))}
      </div>

      {/* FAQ */}
      <div className="bg-surface-container border border-outline rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-on-surface mb-4">Billing FAQ</h2>
        <div className="space-y-4">
          {[
            { q: 'When will Pro billing be available?', a: 'Pro plan payments are coming soon via Stripe. You will be notified by email when available.' },
            { q: 'What counts as a trace?', a: 'Each @observe decorated function call that is successfully ingested counts as one trace.' },
            { q: 'What happens if I exceed the free limit?', a: 'New traces will be rejected with a 429 response. Your existing data is never deleted.' },
            { q: 'Can I export my data?', a: 'Yes — use the CSV or PDF export on the Metrics page at any time.' },
          ].map(({ q, a }) => (
            <div key={q} className="border-b border-outline/50 pb-4 last:border-0 last:pb-0">
              <p className="text-sm font-semibold text-on-surface mb-1">{q}</p>
              <p className="text-sm text-on-surface-variant">{a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Quick Setup Card ─────────────────────────────────────────────────────────
const ENDPOINT = typeof window !== 'undefined'
  ? `${window.location.origin}/api`
  : 'https://your-swarmtrace-url.vercel.app/api'

function CopyLine({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-on-surface-variant w-28 shrink-0">{label}</span>
      <code className={`flex-1 px-3 py-1.5 bg-surface-container-low border border-outline rounded-lg text-xs text-on-surface truncate ${mono ? 'font-mono' : ''}`}>
        {value}
      </code>
      <button
        onClick={copy}
        className="p-1.5 rounded-lg hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-on-surface shrink-0"
        title="Copy"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

function QuickSetup({ apiKeyPlaceholder }: { apiKeyPlaceholder?: string }) {
  const [copiedSnippet, setCopiedSnippet] = useState(false)
  const keyDisplay = apiKeyPlaceholder || 'st_your_key_here'
  const endpoint = typeof window !== 'undefined' ? `${window.location.origin}/api` : 'https://your-swarmtrace-url.vercel.app/api'

  const snippet = `import os
from tracely import observe

os.environ["SWARMTRACE_API_KEY"]  = "${keyDisplay}"
os.environ["SWARMTRACE_ENDPOINT"] = "${endpoint}"

@observe
def my_agent(prompt: str) -> str:
    # your LLM call here — every call is traced automatically
    ...`

  const copySnippet = async () => {
    await navigator.clipboard.writeText(snippet)
    setCopiedSnippet(true)
    setTimeout(() => setCopiedSnippet(false), 2000)
  }

  return (
    <div className="bg-surface-container border border-outline rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-outline bg-surface-container-high">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Terminal className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Quick setup</h2>
          <p className="text-xs text-on-surface-variant">Two env vars and one decorator — that&apos;s all</p>
        </div>
        <a
          href="https://github.com/ravi3594444/swarmtrace#readme"
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <BookOpen className="w-3.5 h-3.5" />
          Docs
        </a>
      </div>

      <div className="p-6 space-y-5">
        {/* Step 1: install */}
        <div>
          <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">1 · Install</p>
          <CopyLine label="pip install" value="pip install swarmtrace" />
        </div>

        {/* Step 2: env vars */}
        <div>
          <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">2 · Set env vars</p>
          <div className="space-y-2">
            <CopyLine label="SWARMTRACE_API_KEY" value={keyDisplay} />
            <CopyLine label="SWARMTRACE_ENDPOINT" value={endpoint} />
          </div>
        </div>

        {/* Step 3: code snippet */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">3 · Use in your code</p>
            <button
              onClick={copySnippet}
              className="flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface transition-colors"
            >
              {copiedSnippet ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedSnippet ? 'Copied!' : 'Copy all'}
            </button>
          </div>
          <pre className="bg-surface-container-low border border-outline rounded-xl p-4 text-xs font-mono text-on-surface overflow-x-auto leading-relaxed whitespace-pre">
{`import os
from tracely import observe

os.environ[`}<span className="text-primary">{`"SWARMTRACE_API_KEY"`}</span>{`]  = `}<span className="text-green-600 dark:text-green-400">{`"${keyDisplay}"`}</span>{`
os.environ[`}<span className="text-primary">{`"SWARMTRACE_ENDPOINT"`}</span>{`] = `}<span className="text-green-600 dark:text-green-400">{`"${endpoint}"`}</span>{`

`}<span className="text-primary">{`@observe`}</span>{`
def my_agent(prompt: str) -> str:
    `}<span className="text-on-surface-variant">{`# every call traced automatically`}</span>{`
    ...`}
          </pre>
        </div>

        {/* What gets tracked */}
        <div className="flex flex-wrap gap-2 pt-1">
          {['Latency', 'Token usage', 'Cost (USD)', 'Errors', 'Parent–child nesting', 'Async support'].map(f => (
            <span key={f} className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
              {f}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general')
  const [profile, setProfile] = useState({ fullName: 'Admin User', email: 'admin@swarmtrace.ai' })
  const [preferences, setPreferences] = useState({ emailNotifications: true, darkMode: false, weeklyReports: false })
  const [saved, setSaved] = useState(false)

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loadingApiKeys, setLoadingApiKeys] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<{ key: string } | null>(null)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [creatingKey, setCreatingKey] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  // Integrations state
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)

  // Load API keys when tab changes
  const loadApiKeys = useCallback(async () => {
    setLoadingApiKeys(true)
    setApiKeyError(null)
    try {
      const result = await fetchApiKeys()
      if (result?.keys) {
        setApiKeys(result.keys)
      } else {
        setApiKeys([])
        setApiKeyError('Could not load API keys. Check your connection.')
      }
    } catch {
      setApiKeyError('Failed to load API keys.')
    } finally {
      setLoadingApiKeys(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'api') loadApiKeys()
  }, [activeTab, loadApiKeys])

  useEffect(() => {
    if (activeTab === 'integrations') {
      const load = async () => {
        setLoadingIntegrations(true)
        const result = await fetchIntegrations()
        setIntegrations(result?.integrations || [
          { id: 'slack', name: 'Slack', description: 'Send notifications to Slack', connected: true },
          { id: 'pagerduty', name: 'PagerDuty', description: 'Alert escalation', connected: false },
          { id: 'datadog', name: 'Datadog', description: 'Metrics and monitoring', connected: true },
        ])
        setLoadingIntegrations(false)
      }
      load()
    }
  }, [activeTab])

  // Create API key with full error feedback
  const handleCreateApiKey = async () => {
    if (!newKeyName.trim()) {
      setApiKeyError('Please enter a name for your API key.')
      return
    }
    setCreatingKey(true)
    setApiKeyError(null)
    setCreatedKey(null)
    try {
      const result = await createApiKey(newKeyName.trim())
      if (result?.key) {
        setCreatedKey(result)
        setNewKeyName('')
        // Refresh list
        const list = await fetchApiKeys()
        if (list?.keys) setApiKeys(list.keys)
      } else {
        setApiKeyError('Failed to create API key. The API may be unavailable — check your backend connection.')
      }
    } catch (err: any) {
      setApiKeyError(`Error creating key: ${err?.message || 'Unknown error'}`)
    } finally {
      setCreatingKey(false)
    }
  }

  const handleCopyKey = async () => {
    if (!createdKey?.key) return
    await navigator.clipboard.writeText(createdKey.key)
    setCopiedKey(true)
    setTimeout(() => setCopiedKey(false), 2000)
  }

  const handleRevokeKey = async (id: string) => {
    setRevokingId(id)
    try {
      const success = await revokeApiKey(id)
      if (success) {
        setApiKeys(prev => prev.filter(k => k.id !== id))
      } else {
        setApiKeyError('Failed to revoke key.')
      }
    } catch {
      setApiKeyError('Failed to revoke key.')
    } finally {
      setRevokingId(null)
    }
  }

  const handleProfileChange = (field: string, value: string) => {
    setProfile(prev => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  const handlePreferenceChange = (field: string) => {
    setPreferences(prev => ({ ...prev, [field]: !prev[field as keyof typeof preferences] }))
    setSaved(false)
  }

  const handleSave = () => {
    setSaved(true)
    const timer = setTimeout(() => setSaved(false), 3000)
    return () => clearTimeout(timer)
  }

  const navItems = [
    { id: 'general', label: 'General', icon: Settings2 },
    { id: 'api', label: 'API Keys', icon: Key },
    { id: 'billing', label: 'Billing', icon: CreditCard },
    { id: 'integrations', label: 'Integrations', icon: Puzzle },
  ]

  return (
    <DashboardLayout>
      <div className="p-6 space-y-8">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Settings</h1>
            <p className="text-on-surface-variant">Manage your account and preferences.</p>
          </div>
          <button className="p-2 rounded-full hover:bg-surface-container-high transition-colors">
            <Bell className="w-5 h-5 text-on-surface-variant" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Sidebar Nav */}
          <div className="lg:col-span-1">
            <nav className="space-y-1">
              {navItems.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-full font-medium text-sm transition-colors ${
                    activeTab === id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="lg:col-span-3 space-y-6">

            {/* ── General ─────────────────────────────────────────────── */}
            {activeTab === 'general' && (
              <>
                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-6">Profile Information</h2>
                  <div className="space-y-5">
                    <div>
                      <label className="block text-sm font-medium text-on-surface mb-2">Full Name</label>
                      <input
                        type="text"
                        value={profile.fullName}
                        onChange={(e) => handleProfileChange('fullName', e.target.value)}
                        className="w-full px-4 py-2.5 rounded-full bg-surface-container-low border border-outline text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-on-surface mb-2">Email</label>
                      <input
                        type="email"
                        value={profile.email}
                        onChange={(e) => handleProfileChange('email', e.target.value)}
                        className="w-full px-4 py-2.5 rounded-full bg-surface-container-low border border-outline text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-colors"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-6">Preferences</h2>
                  <div className="space-y-3">
                    {[
                      { field: 'emailNotifications', label: 'Email Notifications', desc: 'Receive alerts and updates' },
                      { field: 'weeklyReports', label: 'Weekly Reports', desc: 'Get weekly performance summaries' },
                    ].map(({ field, label, desc }) => (
                      <div key={field} className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline/50 hover:border-outline transition-colors">
                        <div>
                          <p className="text-sm font-medium text-on-surface">{label}</p>
                          <p className="text-xs text-on-surface-variant">{desc}</p>
                        </div>
                        <button
                          onClick={() => handlePreferenceChange(field)}
                          className={`relative w-11 h-6 rounded-full transition-colors ${preferences[field as keyof typeof preferences] ? 'bg-primary' : 'bg-outline-variant'}`}
                        >
                          <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${preferences[field as keyof typeof preferences] ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-4">Danger Zone</h2>
                  <button className="px-6 py-2 rounded-full bg-red-500/10 text-red-500 font-medium text-sm border border-red-500/30 hover:bg-red-500/20 transition-colors">
                    Delete Account
                  </button>
                </div>

                <div className="flex justify-end gap-3">
                  {saved && (
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/20 text-green-600 border border-green-500/30 text-sm font-medium">
                      <Check className="w-4 h-4" />
                      Changes saved
                    </div>
                  )}
                  <button
                    onClick={handleSave}
                    className="flex items-center gap-2 px-6 py-2 rounded-full bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity"
                  >
                    <Save className="w-4 h-4" />
                    Save Changes
                  </button>
                </div>
              </>
            )}

            {/* ── API Keys ─────────────────────────────────────────────── */}
            {activeTab === 'api' && (
              <div className="space-y-6">
                {/* Quick Setup */}
                <QuickSetup apiKeyPlaceholder={createdKey?.key || apiKeys[0]?.prefix?.replace('...', '') + '…'} />

                {/* Error banner */}
                {apiKeyError && (
                  <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{apiKeyError}</span>
                  </div>
                )}

                {/* Created key reveal */}
                {createdKey && (
                  <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-6">
                    <p className="text-sm text-green-600 font-semibold mb-3">✓ API Key Created Successfully</p>
                    <div className="flex items-center gap-2 mb-3">
                      <code className="flex-1 px-3 py-2 bg-surface-container border border-outline rounded-xl text-on-surface text-xs break-all font-mono">
                        {createdKey.key}
                      </code>
                      <button
                        onClick={handleCopyKey}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-green-500/20 border border-green-500/30 text-green-600 hover:bg-green-500/30 transition-colors text-xs font-medium"
                      >
                        {copiedKey ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copiedKey ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-on-surface-variant">⚠ Save this key now. You won&apos;t be able to see it again.</p>
                    <button onClick={() => setCreatedKey(null)} className="mt-3 text-xs text-on-surface-variant underline underline-offset-2">Dismiss</button>
                  </div>
                )}

                {/* Create new key */}
                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-2">Create New API Key</h2>
                  <p className="text-sm text-on-surface-variant mb-5">Use API keys to authenticate requests from your agent code.</p>
                  <div className="flex gap-3">
                    <input
                      type="text"
                      placeholder="Key name (e.g., Production, Staging)"
                      value={newKeyName}
                      onChange={(e) => { setNewKeyName(e.target.value); setApiKeyError(null) }}
                      onKeyDown={(e) => e.key === 'Enter' && !creatingKey && handleCreateApiKey()}
                      className="flex-1 px-4 py-2.5 rounded-full bg-surface-container-low border border-outline text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-colors"
                    />
                    <button
                      onClick={handleCreateApiKey}
                      disabled={creatingKey || !newKeyName.trim()}
                      className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-2"
                    >
                      {creatingKey ? (
                        <>
                          <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                          Creating…
                        </>
                      ) : 'Create Key'}
                    </button>
                  </div>
                </div>

                {/* Existing keys */}
                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-5">
                    <h3 className="text-lg font-semibold text-on-surface">Your API Keys</h3>
                    <button onClick={loadApiKeys} className="text-xs text-on-surface-variant hover:text-on-surface transition-colors underline underline-offset-2">
                      Refresh
                    </button>
                  </div>
                  {loadingApiKeys ? (
                    <SkeletonCard />
                  ) : apiKeys.length === 0 ? (
                    <div className="text-center py-8">
                      <Key className="w-10 h-10 text-on-surface-variant/40 mx-auto mb-3" />
                      <p className="text-sm text-on-surface-variant">No API keys yet. Create one above.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {apiKeys.map((key) => (
                        <div key={key.id} className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-on-surface">{key.name}</p>
                            <p className="text-xs text-on-surface-variant font-mono mt-0.5">{key.prefix}</p>
                            <p className="text-xs text-on-surface-variant mt-1">
                              Created {new Date(key.created).toLocaleDateString()}
                              {key.last_used && ` · Last used ${new Date(key.last_used).toLocaleDateString()}`}
                            </p>
                          </div>
                          <button
                            onClick={() => handleRevokeKey(key.id)}
                            disabled={revokingId === key.id}
                            className="ml-4 p-2 hover:bg-red-500/10 rounded-lg text-red-500/60 hover:text-red-500 transition-colors disabled:opacity-50"
                            title="Revoke key"
                          >
                            {revokingId === key.id
                              ? <div className="w-4 h-4 border-2 border-red-500/30 border-t-red-500 rounded-full animate-spin" />
                              : <Trash2 className="w-4 h-4" />
                            }
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Billing ──────────────────────────────────────────────── */}
            {activeTab === 'billing' && <BillingTab />}

            {/* ── Integrations ─────────────────────────────────────────── */}
            {activeTab === 'integrations' && (
              <div className="space-y-6">
                {loadingIntegrations ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array(3).fill(0).map((_, i) => <SkeletonCard key={i} />)}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {integrations.map((integration) => (
                      <div key={integration.id} className="bg-surface-container border border-outline rounded-2xl p-6 hover:border-primary/50 transition-colors">
                        <div className="flex items-start justify-between mb-3">
                          <h3 className="font-semibold text-on-surface">{integration.name}</h3>
                          <span className={`w-2.5 h-2.5 mt-1 rounded-full shrink-0 ${integration.connected ? 'bg-green-500' : 'bg-outline-variant'}`} />
                        </div>
                        <p className="text-sm text-on-surface-variant mb-5 leading-relaxed">{integration.description}</p>
                        <button className={`w-full px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                          integration.connected
                            ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20'
                            : 'bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20'
                        }`}>
                          {integration.connected ? 'Disconnect' : 'Connect'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
