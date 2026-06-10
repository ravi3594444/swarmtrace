'use client'

import { useState, useEffect, useMemo } from 'react'
import React from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Plus, Search, AlertCircle } from 'lucide-react'
import { fetchAgents } from '@/lib/api'
import { SkeletonTableRow } from '@/components/skeleton'

const FALLBACK_AGENTS = [
  { id: 'ext-8829', name: 'DataExtractor_v2', status: 'RUNNING', tasks: 12, tokens: '2.4M', lastActive: '2 min ago', uptime: '14d 2h', success_rate: '99.2%', current_task: 'Extracting Q3 earnings...' },
  { id: 'agt-1024', name: 'CodeAnalyzer_Beta', status: 'RUNNING', tasks: 8, tokens: '1.8M', lastActive: '5 min ago', uptime: '5d 12h', success_rate: '98.5%', current_task: 'Processing daily news feeds' },
  { id: 'rtr-5021', name: 'LangRouter_EU', status: 'IDLE', tasks: 0, tokens: '850K', lastActive: '1 hour ago', uptime: '30d+', success_rate: '99.9%', current_task: 'Waiting for events' },
  { id: 'vec-3341', name: 'VectorIndexer_Prod', status: 'RUNNING', tasks: 15, tokens: '3.2M', lastActive: '1 min ago', uptime: '45d 3h', success_rate: '99.1%', current_task: 'Indexing embeddings' },
  { id: 'cache-2819', name: 'CacheManager_v1', status: 'RUNNING', tasks: 5, tokens: '560K', lastActive: '3 min ago', uptime: '22d 14h', success_rate: '98.8%', current_task: 'Syncing cache' },
  { id: 'gat-9102', name: 'GatewayRouter', status: 'RUNNING', tasks: 20, tokens: '4.1M', lastActive: 'Just now', uptime: '60d+', success_rate: '99.7%', current_task: 'Routing requests' },
]

const SPARKLINE_DATA = [45, 52, 48, 61, 55, 58, 62, 70, 65, 68]

export default function AgentsPage() {
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'running' | 'idle' | 'error'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    const load = async () => {
      try {
        const result = await fetchAgents()
        if (isMounted) {
          setAgents(result?.agents || FALLBACK_AGENTS)
          setError(!result)
          setLoading(false)
        }
      } catch (err) {
        if (isMounted) {
          console.error('[v0] Agents fetch failed:', err)
          setAgents(FALLBACK_AGENTS)
          setError(true)
          setLoading(false)
        }
      }
    }
    load()
    return () => {
      isMounted = false
    }
  }, [])

  const filtered = useMemo(() => {
    return agents.filter(agent => {
      const matchesSearch = agent.name.toLowerCase().includes(search.toLowerCase()) || agent.id.toLowerCase().includes(search.toLowerCase())
      const matchesFilter = filter === 'all' || agent.status.toLowerCase() === filter.toLowerCase()
      return matchesSearch && matchesFilter
    })
  }, [agents, search, filter])

  const getFilterCount = (status: string) => {
    if (status === 'all') return agents.length
    return agents.filter(a => a.status.toLowerCase() === status.toLowerCase()).length
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Agents</h1>
            <p className="text-muted-foreground">Manage and monitor your autonomous agents.</p>
          </div>
          <button className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity text-sm">
            <Plus className="w-4 h-4" />
            <span>New Agent</span>
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Search & Filter */}
        <div className="flex flex-col gap-4">
          <div className="flex-1 relative">
            <Search className="w-5 h-5 text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-full bg-surface-container-low border border-outline text-on-surface placeholder-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'all'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              All Agents ({getFilterCount('all')})
            </button>
            <button
              onClick={() => setFilter('running')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'running'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Running ({getFilterCount('running')})
            </button>
            <button
              onClick={() => setFilter('idle')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'idle'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Idle ({getFilterCount('idle')})
            </button>
            <button
              onClick={() => setFilter('error')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'error'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Error ({getFilterCount('error')})
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-surface-container border border-outline rounded-2xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline bg-surface-container-high">
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Agent Name</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Status</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Tasks</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Tokens Used</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Last Active</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(5).fill(0).map((_, i) => <tr key={i}><td colSpan={5}><SkeletonTableRow /></td></tr>)
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-on-surface-variant">
                    No agents found
                  </td>
                </tr>
              ) : (
                filtered.map((agent, idx) => (
                  <React.Fragment key={agent.id}>
                    <tr
                      onClick={() => setExpanded(expanded === agent.id ? null : agent.id)}
                      className={`cursor-pointer hover:bg-surface-container-high transition-colors ${idx !== filtered.length - 1 && !expanded ? 'border-b border-outline' : ''}`}
                    >
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-semibold text-on-surface">{agent.name}</p>
                          <p className="text-xs text-on-surface-variant">{agent.id}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                          agent.status === 'RUNNING'
                            ? 'bg-green-500/20 text-green-400'
                            : agent.status === 'IDLE'
                            ? 'bg-outline-variant text-on-surface-variant'
                            : 'bg-red-500/20 text-red-400'
                        }`}>
                          {agent.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-on-surface">{agent.tasks}</td>
                      <td className="px-6 py-4 text-on-surface">{agent.tokens}</td>
                      <td className="px-6 py-4 text-on-surface-variant text-sm">{agent.lastActive}</td>
                    </tr>
                    {expanded === agent.id && (
                      <tr className="border-b border-outline bg-surface-container-high/50">
                        <td colSpan={5} className="px-6 py-6">
                          <div className="grid grid-cols-4 gap-6">
                            <div>
                              <p className="text-xs text-on-surface-variant mb-2">CURRENT TASK</p>
                              <p className="text-sm text-on-surface">{agent.current_task}</p>
                            </div>
                            <div>
                              <p className="text-xs text-on-surface-variant mb-2">1H TOKEN USAGE</p>
                              <div className="flex gap-1">
                                {SPARKLINE_DATA.map((v, i) => (
                                  <div
                                    key={i}
                                    className="w-1 bg-primary/60 rounded-sm"
                                    style={{ height: `${(v / 70) * 20}px` }}
                                  />
                                ))}
                              </div>
                            </div>
                            <div>
                              <p className="text-xs text-on-surface-variant mb-2">UPTIME</p>
                              <p className="text-sm text-on-surface">{agent.uptime}</p>
                            </div>
                            <div>
                              <p className="text-xs text-on-surface-variant mb-2">SUCCESS RATE</p>
                              <p className="text-sm text-on-surface font-semibold">{agent.success_rate}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  )
}
