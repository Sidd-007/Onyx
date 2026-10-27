/**
 * Investigations: a question, its scope, the evidence gathered and what it shows. Stored as
 * versioned JSON in Onyx's encrypted vault; connections are referenced, never embedded.
 */

export const INVESTIGATION_VERSION = 1;

/** Observed: captured directly. Derived: calculated from evidence. Hypothesis: to be tested.
 *  Unknown: needed evidence is missing. Partial: limited by sampling, caps or interruption. */
export type Certainty = "observed" | "derived" | "hypothesis" | "unknown" | "partial";

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  observed: "Observed",
  derived: "Derived",
  hypothesis: "Hypothesis",
  unknown: "Unknown",
  partial: "Partial",
};

/** A connection as evidence remembers it: enough to know where it came from, no secrets. */
export interface ConnectionRef {
  id: string;
  name: string;
  engine: string;
  environment: string;
}

export interface Evidence {
  id: string;
  kind: "result" | "context" | "comparison" | "race" | "json-diff" | "note";
  label: string;
  observedAt: number;
  connection?: ConnectionRef;
  /** The SQL or operation that produced it. */
  sql?: string;
  /** Complete, or why not (row cap, sample, cancelled…). */
  complete: boolean;
  limits?: string;
  /** Feature-specific payload (rows, a report, a diff). */
  data: unknown;
}

export interface Finding {
  id: string;
  text: string;
  certainty: Certainty;
  /** Evidence ids it rests on. */
  evidence: string[];
}

export interface Investigation {
  version: number;
  id: string;
  title: string;
  question: string;
  scope: { connections: ConnectionRef[]; notes: string };
  evidence: Evidence[];
  findings: Finding[];
  createdAt: number;
}

export const newId = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 36);

export function newInvestigation(title: string): Investigation {
  return { version: INVESTIGATION_VERSION, id: newId(), title: title.trim() || "Untitled investigation", question: "", scope: { connections: [], notes: "" }, evidence: [], findings: [], createdAt: Date.now() };
}

/** Adds evidence and keeps the scope's connection list in step. */
export function withEvidence(inv: Investigation, e: Evidence): Investigation {
  const connections = e.connection && !inv.scope.connections.some((c) => c.id === e.connection!.id) ? [...inv.scope.connections, e.connection] : inv.scope.connections;
  return { ...inv, scope: { ...inv.scope, connections }, evidence: [...inv.evidence, e] };
}

/** Opens a stored body, refusing a newer format than this app understands. */
export function parseInvestigation(text: string): Investigation {
  const raw = JSON.parse(text) as Investigation;
  if (typeof raw.version !== "number" || raw.version > INVESTIGATION_VERSION) throw new Error("This investigation was saved by a newer Onyx");
  return { ...newInvestigation(raw.title ?? ""), ...raw, scope: { connections: raw.scope?.connections ?? [], notes: raw.scope?.notes ?? "" } };
}

/**
 * An export copy. `includeData`: keep evidence payloads (rows can hold customer data);
 * without it, only labels, SQL, times and limits remain. Imports never run anything.
 */
export function exportInvestigation(inv: Investigation, includeData: boolean): string {
  const copy: Investigation = includeData ? inv : { ...inv, evidence: inv.evidence.map((e) => ({ ...e, data: null, limits: [e.limits, "data left out of the export"].filter(Boolean).join("; ") })) };
  return JSON.stringify({ ...copy, exportedAt: new Date().toISOString(), note: "Connections are references only: no credentials are included." }, null, 2);
}
