/**
 * Message bundle for SwarmTrace UI strings.
 *
 * Centralizes all user-facing copy so it can be translated without touching
 * component code. This is the first step toward full i18n — the `t()`
 * function is a simple key lookup today, but can be swapped for `next-intl`
 * or `react-i18next` later without changing call sites.
 *
 * Usage:
 *   import { t } from '@/lib/messages'
 *   <h1>{t('nav.overview')}</h1>
 *
 * Missing keys fall back to the key itself (so missing translations are
 * visible during development rather than silently empty).
 *
 * To add a language: add a `fr` (etc.) object alongside `en`, and update
 * `t()` to pick the bundle based on a locale prop (wired through context
 * or next-intl's locale negotiation).
 */

const en = {
  // Navigation
  'nav.overview': 'Overview',
  'nav.agents': 'Agents',
  'nav.network': 'Network',
  'nav.traces': 'Traces',
  'nav.threads': 'Threads',
  'nav.metrics': 'Metrics',
  'nav.compare': 'Compare',
  'nav.failures': 'Failures',
  'nav.settings': 'Settings',

  // Page descriptions
  'page.overview.description': 'Live swarm health and execution summary',
  'page.agents.description': 'Registered swarm agents and their health',
  'page.network.description': 'Drawing agent collaboration graph',
  'page.traces.description': 'Click any row to inspect',
  'page.threads.description': 'Multi-turn agent conversations',
  'page.metrics.description': 'Latency, token, and cost trends over time',
  'page.compare.description': 'Side-by-side trace comparison',
  'page.failures.description': 'Clustered errors from your agents',

  // Common actions
  'action.refresh': 'Refresh now',
  'action.search': 'Open search',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.save': 'Save Changes',
  'action.saving': 'Saving…',
  'action.saved': 'Saved',
  'action.copy': 'Copy',
  'action.copied': 'Copied',

  // Empty states
  'empty.traces.title': 'No traces to display',
  'empty.traces.description': 'Traces will appear here once your agents run.',
  'empty.tokens.title': 'No token data',
  'empty.tokens.description': 'Token usage will appear here once traces flow in.',
  'empty.waterfall.title': 'No traces to plot',
  'empty.waterfall.description': 'Traces will appear here once your agents run.',

  // Status
  'status.live': 'LIVE',
  'status.paused': 'PAUSED',
  'status.offline': 'OFFLINE',
  'status.connecting': 'connecting…',
  'status.listening': 'listening',

  // Command palette
  'palette.placeholder': 'Search pages, agents, actions…',
  'palette.noResults': 'No results for "{query}"',
  'palette.hint.page': 'Page',
  'palette.hint.action': 'Action',
  'palette.hint.settings': 'Settings',
  'palette.hint.agent': 'Agent',

  // Onboarding
  'onboarding.welcome.title': 'Welcome to SwarmTrace',
  'onboarding.welcome.subtitle': 'Your dashboard is ready. Get your first trace on screen in under 60 seconds — three steps, no credit card.',
  'onboarding.step1.title': 'Install the SDK',
  'onboarding.step2.title': 'Get your API key',
  'onboarding.step3.title': 'Decorate one function',
  'onboarding.tour': 'Watch the tour',
  'onboarding.docs': 'Full docs',

  // Settings
  'settings.profile': 'Profile Information',
  'settings.notifications': 'Notifications',
  'settings.notifications.comingSoon': 'Coming soon',
  'settings.dangerZone': 'Danger Zone',
  'settings.apiKeys': 'API Keys',
  'settings.billing': 'Billing',
  'settings.integrations': 'Integrations',
} as const

export type MessageKey = keyof typeof en

/**
 * Translate a message key. Returns the English string for the key, or the
 * key itself if not found (so missing keys are visible during development).
 *
 * Placeholders: use {name} in the message string and pass a `params`
 * object — e.g. t('palette.noResults', { query: 'foo' }) → 'No results for "foo"'.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let msg: string = en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(`{${k}}`, String(v))
    }
  }
  return msg
}
