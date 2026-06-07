'use client'

import { useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Bell, Save, Check, Copy, Trash2, AlertCircle } from 'lucide-react'
import { fetchApiKeys, createApiKey, revokeApiKey, fetchIntegrations, fetchBillingInfo } from '@/lib/api'
import { SkeletonCard } from '@/components/skeleton'

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general')
  const [profile, setProfile] = useState({
    fullName: 'Admin User',
    email: 'admin@swarmtrace.ai',
  })
  const [preferences, setPreferences] = useState({
    emailNotifications: true,
    darkMode: true,
    weeklyReports: false,
  })
  const [saved, setSaved] = useState(false)

  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [loadingApiKeys, setLoadingApiKeys] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<any>(null)
  const [apiError, setApiError] = useState(false)

  const [integrations, setIntegrations] = useState<any[]>([])
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const [integrationError, setIntegrationError] = useState(false)

  const [billing, setBilling] = useState<any>(null)
  const [loadingBilling, setLoadingBilling] = useState(false)
  const [billingError, setBillingError] = useState(false)

  useEffect(() => {
    if (activeTab === 'api') {
      const load = async () => {
        setLoadingApiKeys(true)
        const result = await fetchApiKeys()
        setApiKeys(result?.keys || [
          { id: 'key_1', prefix: 'sk_live_abc123', name: 'Production', created: '2024-01-10T10:30:00Z' },
        ])
        setApiError(!result)
        setLoadingApiKeys(false)
      }
      load()
    }
  }, [activeTab])

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
        setIntegrationError(!result)
        setLoadingIntegrations(false)
      }
      load()
    }
  }, [activeTab])

  useEffect(() => {
    if (activeTab === 'billing') {
      const load = async () => {
        setLoadingBilling(true)
        const result = await fetchBillingInfo()
        setBilling(result || {
          plan: 'Pro',
          price: 99,
          nextBilling: '2024-02-15',
          paymentMethod: '****4242',
        })
        setBillingError(!result)
        setLoadingBilling(false)
      }
      load()
    }
  }, [activeTab])

  const handleCreateApiKey = async () => {
    if (!newKeyName.trim()) return
    try {
      const result = await createApiKey(newKeyName)
      if (result) {
        setCreatedKey(result)
        setNewKeyName('')
        const list = await fetchApiKeys()
        setApiKeys(list?.keys || apiKeys)
      }
    } catch (err) {
      console.error('[v0] API key creation failed:', err)
    }
  }

  const handleRevokeKey = async (id: string) => {
    try {
      const success = await revokeApiKey(id)
      if (success) {
        setApiKeys(apiKeys.filter(k => k.id !== id))
      }
    } catch (err) {
      console.error('[v0] API key revocation failed:', err)
    }
  }

  const handleProfileChange = (field: string, value: string) => {
    setProfile(prev => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  const handlePreferenceChange = (field: string) => {
    setPreferences(prev => ({ ...prev, [field]: !prev[field] }))
    setSaved(false)
  }

  const handleSave = () => {
    localStorage.setItem('userProfile', JSON.stringify(profile))
    localStorage.setItem('userPreferences', JSON.stringify(preferences))
    setSaved(true)
    const timer = setTimeout(() => setSaved(false), 3000)
    return () => clearTimeout(timer)
  }

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
          {/* Settings Menu */}
          <div className="lg:col-span-1">
            <nav className="space-y-2">
              <button
                onClick={() => setActiveTab('general')}
                className={`w-full text-left px-4 py-3 rounded-full font-medium text-sm transition-colors ${
                  activeTab === 'general'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                }`}
              >
                General
              </button>
              <button
                onClick={() => setActiveTab('api')}
                className={`w-full text-left px-4 py-3 rounded-full font-medium text-sm transition-colors ${
                  activeTab === 'api'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                }`}
              >
                API Keys
              </button>
              <button
                onClick={() => setActiveTab('billing')}
                className={`w-full text-left px-4 py-3 rounded-full font-medium text-sm transition-colors ${
                  activeTab === 'billing'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                }`}
              >
                Billing
              </button>
              <button
                onClick={() => setActiveTab('integrations')}
                className={`w-full text-left px-4 py-3 rounded-full font-medium text-sm transition-colors ${
                  activeTab === 'integrations'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                }`}
              >
                Integrations
              </button>
            </nav>
          </div>

          {/* Settings Content */}
          <div className="lg:col-span-3 space-y-8">
            {activeTab === 'general' && (
              <>
                {/* Profile Information */}
                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-6">Profile Information</h2>
                  <div className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-on-surface mb-2">Full Name</label>
                      <input
                        type="text"
                        value={profile.fullName}
                        onChange={(e) => handleProfileChange('fullName', e.target.value)}
                        className="w-full px-4 py-2 rounded-full bg-surface-container-low border border-outline text-on-surface placeholder-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-on-surface mb-2">Email</label>
                      <input
                        type="email"
                        value={profile.email}
                        onChange={(e) => handleProfileChange('email', e.target.value)}
                        className="w-full px-4 py-2 rounded-full bg-surface-container-low border border-outline text-on-surface placeholder-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50"
                      />
                    </div>
                  </div>
                </div>

                {/* Preferences */}
                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-6">Preferences</h2>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline/50 hover:border-outline transition-colors">
                      <div>
                        <p className="text-sm font-medium text-on-surface">Email Notifications</p>
                        <p className="text-xs text-on-surface-variant">Receive alerts and updates</p>
                      </div>
                      <button
                        onClick={() => handlePreferenceChange('emailNotifications')}
                        className={`w-10 h-6 rounded-full transition-colors ${preferences.emailNotifications ? 'bg-primary' : 'bg-outline-variant'}`}
                      >
                        <div className={`w-5 h-5 rounded-full bg-surface-container transition-transform ${preferences.emailNotifications ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline/50 hover:border-outline transition-colors">
                      <div>
                        <p className="text-sm font-medium text-on-surface">Weekly Reports</p>
                        <p className="text-xs text-on-surface-variant">Get weekly performance summaries</p>
                      </div>
                      <button
                        onClick={() => handlePreferenceChange('weeklyReports')}
                        className={`w-10 h-6 rounded-full transition-colors ${preferences.weeklyReports ? 'bg-primary' : 'bg-outline-variant'}`}
                      >
                        <div className={`w-5 h-5 rounded-full bg-surface-container transition-transform ${preferences.weeklyReports ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Danger Zone */}
                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-6">Danger Zone</h2>
                  <button className="px-6 py-2 rounded-full bg-red-500/20 text-red-400 font-medium text-sm border border-red-500/30 hover:bg-red-500/30 transition-colors">
                    Delete Account
                  </button>
                </div>

                {/* Save Button */}
                <div className="flex justify-end gap-3">
                  {saved && (
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
                      <Check className="w-4 h-4" />
                      <span className="text-sm font-medium">Changes saved</span>
                    </div>
                  )}
                  <button
                    onClick={handleSave}
                    className="flex items-center gap-2 px-6 py-2 rounded-full bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity"
                  >
                    <Save className="w-4 h-4" />
                    <span>Save Changes</span>
                  </button>
                </div>
              </>
            )}

            {activeTab === 'api' && (
              <div className="space-y-6">
                {apiError && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>API unavailable — showing cached data</span>
                  </div>
                )}

                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h2 className="text-xl font-semibold text-on-surface mb-6">Create New API Key</h2>
                  <div className="flex gap-3">
                    <input
                      type="text"
                      placeholder="Key name (e.g., Production)"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      className="flex-1 px-4 py-2 rounded-full bg-surface-container-low border border-outline text-on-surface placeholder-on-surface-variant focus:outline-none focus:border-primary"
                    />
                    <button
                      onClick={handleCreateApiKey}
                      className="px-6 py-2 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:opacity-90"
                    >
                      Create
                    </button>
                  </div>
                </div>

                {createdKey && (
                  <div className="bg-green-500/20 border border-green-500/30 rounded-2xl p-6">
                    <p className="text-sm text-green-400 font-semibold mb-3">API Key Created Successfully</p>
                    <div className="flex items-center gap-2 mb-4">
                      <code className="flex-1 px-3 py-2 bg-surface-container border border-outline rounded text-on-surface text-xs break-all font-mono">
                        {createdKey.key}
                      </code>
                      <button
                        onClick={() => navigator.clipboard.writeText(createdKey.key)}
                        className="p-2 hover:bg-surface-container-high rounded"
                      >
                        <Copy className="w-4 h-4 text-green-400" />
                      </button>
                    </div>
                    <p className="text-xs text-on-surface-variant">Save this key in a secure location. You won&apos;t be able to see it again.</p>
                  </div>
                )}

                <div className="bg-surface-container border border-outline rounded-2xl p-6">
                  <h3 className="text-lg font-semibold text-on-surface mb-4">Existing Keys</h3>
                  {loadingApiKeys ? (
                    <SkeletonCard />
                  ) : apiKeys.length === 0 ? (
                    <p className="text-on-surface-variant">No API keys yet</p>
                  ) : (
                    <div className="space-y-3">
                      {apiKeys.map((key) => (
                        <div key={key.id} className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline">
                          <div>
                            <p className="text-sm font-semibold text-on-surface">{key.name}</p>
                            <p className="text-xs text-on-surface-variant font-mono">{key.prefix}...</p>
                            <p className="text-xs text-on-surface-variant mt-1">Created {new Date(key.created).toLocaleDateString()}</p>
                          </div>
                          <button
                            onClick={() => handleRevokeKey(key.id)}
                            className="p-2 hover:bg-red-500/20 rounded text-red-400 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'billing' && (
              <div className="space-y-6">
                {billingError && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>API unavailable — showing cached data</span>
                  </div>
                )}

                {loadingBilling ? (
                  <SkeletonCard />
                ) : (
                  <>
                    <div className="bg-surface-container border border-outline rounded-2xl p-6">
                      <h2 className="text-xl font-semibold text-on-surface mb-6">Billing Summary</h2>
                      <div className="space-y-4">
                        <div className="flex justify-between items-start pb-4 border-b border-outline">
                          <div>
                            <p className="text-sm font-medium text-on-surface">Current Plan</p>
                            <p className="text-xs text-on-surface-variant">{billing?.plan} Tier</p>
                          </div>
                          <p className="text-lg font-bold text-on-surface">${billing?.price}/mo</p>
                        </div>
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="text-sm font-medium text-on-surface">Next Billing Date</p>
                            <p className="text-xs text-on-surface-variant">{new Date(billing?.nextBilling).toLocaleDateString()}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-surface-container border border-outline rounded-2xl p-6">
                      <h3 className="text-lg font-semibold text-on-surface mb-4">Payment Method</h3>
                      <div className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl border border-outline">
                        <div>
                          <p className="text-sm text-on-surface">Visa ending in {billing?.paymentMethod.slice(-4)}</p>
                        </div>
                        <button className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors">
                          Update
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeTab === 'integrations' && (
              <div className="space-y-6">
                {integrationError && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>API unavailable — showing cached data</span>
                  </div>
                )}

                {loadingIntegrations ? (
                  <div className="grid grid-cols-3 gap-6">
                    {Array(3).fill(0).map((_, i) => <SkeletonCard key={i} />)}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-6">
                    {integrations.map((integration) => (
                      <div key={integration.id} className="bg-surface-container border border-outline rounded-2xl p-6 hover:border-primary/50 transition-colors cursor-pointer">
                        <div className="flex items-start justify-between mb-4">
                          <h3 className="font-semibold text-on-surface">{integration.name}</h3>
                          <div className={`w-3 h-3 rounded-full ${integration.connected ? 'bg-green-500' : 'bg-outline-variant'}`} />
                        </div>
                        <p className="text-sm text-on-surface-variant mb-4">{integration.description}</p>
                        <button className={`w-full px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                          integration.connected
                            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                            : 'bg-primary/20 text-primary hover:bg-primary/30'
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
