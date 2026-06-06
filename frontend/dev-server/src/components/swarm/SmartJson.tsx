import { useState } from "react";

function tryParse(raw: string): unknown | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Python-ish dict: replace single quotes / True / False / None
    try {
      const swapped = trimmed
        .replace(/'/g, '"')
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/\bNone\b/g, "null");
      return JSON.parse(swapped);
    } catch {
      return undefined;
    }
  }
}

export function SmartJson({ raw, maxHeight }: { raw: string; maxHeight?: string }) {
  const parsed = tryParse(raw);
  if (parsed === undefined) {
    return (
      <pre
        className="overflow-auto rounded border border-border bg-background p-3 font-mono text-xs text-foreground"
        style={{ maxHeight }}
      >
        {raw || "(empty)"}
      </pre>
    );
  }
  return (
    <div
      className="overflow-auto rounded border border-border bg-background p-3 font-mono text-xs"
      style={{ maxHeight }}
    >
      <JsonNode value={parsed} depth={0} keyName={null} />
    </div>
  );
}

function JsonNode({
  value,
  depth,
  keyName,
}: {
  value: unknown;
  depth: number;
  keyName: string | null;
}) {
  const [open, setOpen] = useState(depth < 2);

  const renderKey = keyName !== null && (
    <span className="text-[oklch(0.75_0.15_230)]">"{keyName}"</span>
  );

  if (value === null) return <Line keyEl={renderKey}><span className="text-muted-foreground">null</span></Line>;
  if (typeof value === "boolean")
    return <Line keyEl={renderKey}><span className="text-primary">{String(value)}</span></Line>;
  if (typeof value === "number")
    return <Line keyEl={renderKey}><span className="text-[oklch(0.8_0.18_85)]">{value}</span></Line>;
  if (typeof value === "string")
    return (
      <Line keyEl={renderKey}>
        <span className="break-all text-[oklch(0.86_0.21_155)]">"{value}"</span>
      </Line>
    );

  const isArr = Array.isArray(value);
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const open_c = isArr ? "[" : "{";
  const close_c = isArr ? "]" : "}";

  if (entries.length === 0) {
    return (
      <Line keyEl={renderKey}>
        <span className="text-muted-foreground">{open_c}{close_c}</span>
      </Line>
    );
  }

  return (
    <div>
      <div className="flex items-start gap-1">
        <button
          onClick={() => setOpen(!open)}
          className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? "▾" : "▸"}
        </button>
        <div className="flex-1">
          {renderKey}
          {renderKey && <span className="text-muted-foreground">: </span>}
          <span className="text-muted-foreground">
            {open_c}
            {!open && (
              <span className="text-muted-foreground/70">
                {" "}…{entries.length}{" "}
              </span>
            )}
            {!open && close_c}
          </span>
          {open && (
            <div className="ml-3 border-l border-border pl-2">
              {entries.map(([k, v]) => (
                <JsonNode key={k} value={v} depth={depth + 1} keyName={isArr ? null : k} />
              ))}
            </div>
          )}
          {open && <div className="text-muted-foreground">{close_c}</div>}
        </div>
      </div>
    </div>
  );
}

function Line({ keyEl, children }: { keyEl: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="pl-4">
      {keyEl}
      {keyEl && <span className="text-muted-foreground">: </span>}
      {children}
    </div>
  );
}
