import type { LucideIcon } from 'lucide-react'
import {
  Sparkles, LayoutGrid, Users, ActivitySquare, MessagesSquare,
  BarChart3, GitCompareArrows, AlertTriangle, Settings, Search, Rocket,
} from 'lucide-react'

/**
 * A single step in the new-user onboarding tour.
 *
 * `target` is a CSS selector for the element to spotlight. When it is
 * undefined the step is rendered as a centred modal (used for the welcome
 * and finish steps). `route` navigates the dashboard to that page before the
 * step is shown so the user sees the real feature while reading about it.
 */
export type TourStep = {
  id: string
  title: string
  body: string
  icon: LucideIcon
  target?: string
  route?: string
  placement?: 'right' | 'left' | 'top' | 'bottom'
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to SwarmTrace',
    body:
      "SwarmTrace gives you real-time observability for your AI agents — every " +
      "LLM call, tool call, latency, token and cost, traced automatically. " +
      "This quick tour walks through each part of the dashboard one by one. " +
      "You can skip anytime and replay it later from the sidebar.",
    icon: Sparkles,
  },
  {
    id: 'overview',
    title: 'Overview',
    body:
      "Your home base. See a live summary across all agents — total calls, " +
      "tokens, cost and error rate — plus a real-time activity feed and token " +
      "usage over time. Start here to know your swarm's health at a glance.",
    icon: LayoutGrid,
    target: '[data-tour="nav-overview"]',
    route: '/overview',
    placement: 'right',
  },
  {
    id: 'agents',
    title: 'Agents',
    body:
      "Every function you wrap with @observe shows up here as one agent card. " +
      "Nested LLM and tool calls fold into their parent agent, so you get one " +
      "clean card per agent with rolled-up tokens, cost and error counts.",
    icon: Users,
    target: '[data-tour="nav-agents"]',
    route: '/agents',
    placement: 'right',
  },
  {
    id: 'traces',
    title: 'Traces',
    body:
      "The full record of every traced call. Drill into any run to see its " +
      "call tree and waterfall — exactly which LLM and tool calls ran, in " +
      "what order, how long each took, and the inputs and outputs.",
    icon: ActivitySquare,
    target: '[data-tour="nav-traces"]',
    route: '/traces',
    placement: 'right',
  },
  {
    id: 'threads',
    title: 'Threads',
    body:
      "Related calls grouped into conversations. When your agents run in a " +
      "multi-turn session, Threads stitches the calls together so you can " +
      "follow the whole exchange instead of isolated traces.",
    icon: MessagesSquare,
    target: '[data-tour="nav-threads"]',
    route: '/threads',
    placement: 'right',
  },
  {
    id: 'metrics',
    title: 'Metrics',
    body:
      "Charts and trends over time — latency, token usage, cost and volume. " +
      "Use this to spot regressions, cost spikes or slowdowns before they " +
      "become a problem in production.",
    icon: BarChart3,
    target: '[data-tour="nav-metrics"]',
    route: '/metrics',
    placement: 'right',
  },
  {
    id: 'compare',
    title: 'Compare',
    body:
      "Put two agents or runs side by side to see what changed — latency, " +
      "cost, tokens and outputs. Perfect for evaluating a prompt tweak or a " +
      "model swap against your baseline.",
    icon: GitCompareArrows,
    target: '[data-tour="nav-compare"]',
    route: '/compare',
    placement: 'right',
  },
  {
    id: 'failures',
    title: 'Failures',
    body:
      "All your errors in one place, automatically clustered by similarity so " +
      "recurring problems surface together. Jump straight to the failing " +
      "trace to debug the root cause fast.",
    icon: AlertTriangle,
    target: '[data-tour="nav-failures"]',
    route: '/failures',
    placement: 'right',
  },
  {
    id: 'settings',
    title: 'Settings',
    body:
      "Manage your API keys, integrations, team and billing here. Grab an API " +
      "key from this page — you'll need it to start sending traces from your " +
      "code.",
    icon: Settings,
    target: '[data-tour="nav-settings"]',
    route: '/settings',
    placement: 'right',
  },
  {
    id: 'search',
    title: 'Quick search',
    body:
      "Press Ctrl+K (or ⌘K) anywhere to open the command palette and jump to " +
      "any page, agent or trace instantly — no clicking around required.",
    icon: Search,
    target: '[data-tour="global-search"]',
    placement: 'bottom',
  },
  {
    id: 'finish',
    title: "You're all set",
    body:
      "Install the SDK with `pip install swarmtrace`, add `@observe` to your " +
      "agent, and drop in your API key from Settings. Traces will start " +
      "flowing in automatically. Need this tour again? Hit \u201cTake a " +
      "tour\u201d in the sidebar anytime.",
    icon: Rocket,
  },
]
