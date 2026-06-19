import { useState } from "react";
import { PageHeader } from "@/components/Layout";
import { Check, Eye, EyeOff, Plus, Trash2, Zap, Globe, Key, CreditCard } from "lucide-react";

type Tab = "general" | "apikeys" | "billing" | "integrations";

const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "general",      label: "General",      icon: Zap },
  { id: "apikeys",      label: "API Keys",     icon: Key },
  { id: "billing",      label: "Billing",      icon: CreditCard },
  { id: "integrations", label: "Integrations", icon: Globe },
];

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors shadow-inner ${
        checked ? "bg-primary border-primary/80" : "bg-muted border-border"
      }`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
        checked ? "translate-x-[18px]" : "translate-x-[2px]"
      }`} />
    </button>
  );
}

function FormRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-border/50 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {desc && <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function GeneralTab() {
  const [vals, setVals] = useState({
    projectName: "my-swarm-prod",
    region: "us-east-1",
    livePolling: true,
    samplingRate: 100,
    retentionDays: 30,
    costAlerts: false,
  });
  const [saved, setSaved] = useState(false);
  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2000); };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-0.5">Project</h3>
        <p className="text-xs text-muted-foreground mb-4">Basic project configuration.</p>
        <FormRow label="Project Name" desc="Used as the default label in traces.">
          <input
            value={vals.projectName}
            onChange={(e) => setVals({ ...vals, projectName: e.target.value })}
            className="h-8 w-52 rounded-lg border border-border bg-muted/40 px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </FormRow>
        <FormRow label="Region" desc="Data residency for stored traces.">
          <select
            value={vals.region}
            onChange={(e) => setVals({ ...vals, region: e.target.value })}
            className="h-8 w-52 rounded-lg border border-border bg-muted/40 px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="us-east-1">US East (N. Virginia)</option>
            <option value="us-west-2">US West (Oregon)</option>
            <option value="eu-west-1">EU (Ireland)</option>
            <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
          </select>
        </FormRow>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-0.5">Collection</h3>
        <p className="text-xs text-muted-foreground mb-4">Control how traces are captured.</p>
        <FormRow label="Live polling" desc="Poll API every 3s for new traces.">
          <Toggle checked={vals.livePolling} onChange={() => setVals({ ...vals, livePolling: !vals.livePolling })} />
        </FormRow>
        <FormRow label="Sampling rate" desc="Percentage of requests to trace (1–100).">
          <div className="flex items-center gap-2">
            <input
              type="range" min={1} max={100} value={vals.samplingRate}
              onChange={(e) => setVals({ ...vals, samplingRate: +e.target.value })}
              className="w-28 accent-primary"
            />
            <span className="w-10 text-right text-xs font-mono text-muted-foreground">{vals.samplingRate}%</span>
          </div>
        </FormRow>
        <FormRow label="Retention" desc="Days to keep trace data.">
          <select
            value={vals.retentionDays}
            onChange={(e) => setVals({ ...vals, retentionDays: +e.target.value })}
            className="h-8 w-32 rounded-lg border border-border bg-muted/40 px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </FormRow>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-0.5">Preferences</h3>
        <FormRow label="Cost alerts" desc="Email alerts when daily cost exceeds threshold.">
          <Toggle checked={vals.costAlerts} onChange={() => setVals({ ...vals, costAlerts: !vals.costAlerts })} />
        </FormRow>
      </div>

      <button
        onClick={save}
        className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all shadow-sm ${
          saved
            ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
            : "bg-primary text-white hover:bg-primary/90"
        }`}
      >
        {saved && <Check className="w-4 h-4" />}
        {saved ? "Saved!" : "Save changes"}
      </button>
    </div>
  );
}

function ApiKeysTab() {
  const [keys] = useState([
    { id: "k1", name: "Production",  key: "sk-swarm-prod-abc123xyz", created: "2026-01-15", lastUsed: "just now" },
    { id: "k2", name: "Development", key: "sk-swarm-dev-def456uvw",  created: "2026-03-20", lastUsed: "2 days ago" },
  ]);
  const [visible, setVisible] = useState<string[]>([]);
  const toggle = (id: string) => setVisible((v) => v.includes(id) ? v.filter((x) => x !== id) : [...v, id]);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">API Keys</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Use these to send traces to SwarmTrace.</p>
          </div>
          <button className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors shadow-sm">
            <Plus className="w-3.5 h-3.5" />New key
          </button>
        </div>
        <div className="divide-y divide-border/40">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">{k.name}</div>
                <div className="font-mono text-xs text-muted-foreground mt-0.5">
                  {visible.includes(k.id) ? k.key : `${k.key.slice(0, 14)}${"•".repeat(16)}`}
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">Created {k.created} · Last used {k.lastUsed}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => toggle(k.id)} className="w-8 h-8 rounded-lg border border-border bg-muted/40 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                  {visible.includes(k.id) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <button className="w-8 h-8 rounded-lg border border-border bg-muted/40 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-foreground mb-2">Quick Start</h3>
        <pre className="rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-foreground overflow-x-auto">
{`import swarmtrace as st

st.init(api_key="sk-swarm-prod-abc123xyz")

@st.trace
def my_agent_function(query: str):
    # Your agent code here
    return result`}
        </pre>
      </div>
    </div>
  );
}

function BillingTab() {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Current Plan</h3>
            <p className="text-xs text-muted-foreground mt-0.5">You're on the Free plan.</p>
          </div>
          <span className="rounded-full border border-border bg-muted/60 px-3 py-1 text-xs font-bold text-muted-foreground uppercase tracking-wide">Free</span>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: "Traces / mo", used: "452",    max: "10,000" },
            { label: "Retention",   used: "7 days", max: "7 days" },
            { label: "Agents",      used: "7",      max: "10" },
          ].map((u) => (
            <div key={u.label} className="rounded-xl border border-border bg-muted/30 p-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">{u.label}</div>
              <div className="font-mono text-xs font-bold text-foreground">{u.used} <span className="font-normal text-muted-foreground">/ {u.max}</span></div>
            </div>
          ))}
        </div>
        <button className="w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-white hover:bg-primary/90 transition-colors shadow-sm">
          Upgrade to Pro — $29/mo
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="border-b border-border bg-muted/30 px-5 py-4">
          <h3 className="text-sm font-semibold text-foreground">Pro Plan Features</h3>
        </div>
        <div className="p-5 space-y-2.5">
          {["Unlimited traces", "30-day retention", "Real-time alerting", "Team collaboration (up to 10)", "Priority support", "CSV & PDF exports"].map((f) => (
            <div key={f} className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <span className="w-4 h-4 rounded-full bg-emerald-100 border border-emerald-200 flex items-center justify-center shrink-0">
                <Check className="w-2.5 h-2.5 text-emerald-600" />
              </span>
              {f}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const integrations = [
    { name: "OpenAI",     desc: "Auto-trace GPT-4o / GPT-4 calls",  connected: true,  logo: "🤖" },
    { name: "Anthropic",  desc: "Auto-trace Claude 3.x calls",       connected: true,  logo: "🧠" },
    { name: "Langchain",  desc: "Trace Langchain agent runs",         connected: false, logo: "🔗" },
    { name: "LlamaIndex", desc: "Trace LlamaIndex pipelines",         connected: false, logo: "🦙" },
    { name: "Slack",      desc: "Get failure alerts in Slack",         connected: false, logo: "💬" },
    { name: "PagerDuty",  desc: "On-call alerting for errors",         connected: false, logo: "🚨" },
    { name: "Datadog",    desc: "Forward metrics to Datadog",          connected: false, logo: "📊" },
    { name: "Grafana",    desc: "Forward metrics to Grafana",          connected: false, logo: "📈" },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">Connect SwarmTrace to your tools and frameworks.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {integrations.map((i) => (
          <div key={i.name} className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm hover:shadow-md transition-shadow">
            <div className="w-10 h-10 rounded-xl border border-border bg-muted/40 flex items-center justify-center text-xl shrink-0">{i.logo}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground">{i.name}</div>
              <div className="text-xs text-muted-foreground">{i.desc}</div>
            </div>
            <button className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors shrink-0 ${
              i.connected
                ? "border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
                : "border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/80"
            }`}>
              {i.connected ? "✓ Connected" : "Connect"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");

  return (
    <>
      <PageHeader title="Settings" description="Configure your SwarmTrace workspace" />
      <div className="p-6">
        <div className="flex flex-col gap-6 xl:flex-row">
          <nav className="xl:w-48 shrink-0">
            <div className="rounded-xl border border-border bg-card p-1.5 shadow-sm space-y-0.5">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    tab === id
                      ? "bg-primary/8 text-primary"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                  style={tab === id ? { background: "hsl(250 84% 54% / 0.08)" } : {}}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          </nav>
          <div className="flex-1 min-w-0">
            {tab === "general"      && <GeneralTab />}
            {tab === "apikeys"      && <ApiKeysTab />}
            {tab === "billing"      && <BillingTab />}
            {tab === "integrations" && <IntegrationsTab />}
          </div>
        </div>
      </div>
    </>
  );
}
