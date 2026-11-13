import type { TrustSchedule } from "./shared/protocol";

export type HostMode = "portal" | "jatos" | "pavlovia" | "github-pages";

let hostedSessionToken: string | null = null;
let hostMode: HostMode = (import.meta as any).env?.VITE_HOST_MODE === "github-pages" ? "github-pages" : "portal";
let apiOrigin = (import.meta as any).env?.VITE_API_ORIGIN?.replace(/\/$/, "") ?? "";
let hostSessionId: string | null = null;
let deploymentId: string | null = null;
let clientVersion: string | null = null;

export function configureHostedApi(options: {
  host: Exclude<HostMode, "portal">;
  apiOrigin: string;
  sessionToken?: string | null;
  hostSessionId?: string | null;
  deploymentId?: string | null;
  clientVersion?: string | null;
}) {
  hostMode = options.host;
  apiOrigin = options.apiOrigin.replace(/\/$/, "");
  hostedSessionToken = options.sessionToken ?? null;
  hostSessionId = options.hostSessionId ?? null;
  deploymentId = options.deploymentId ?? null;
  clientVersion = options.clientVersion ?? null;
}

export function setHostedSessionToken(token: string | null) {
  hostedSessionToken = token;
}

export function configureProlificSession(token: string) {
  hostMode = "github-pages";
  hostedSessionToken = token;
}

export type RunDto = {
  id: string;
  studyType: "investor" | "trustee" | "workflow";
  protocolVersion: string;
  schemaVersion: string;
  scheduleHash: string;
  outcomeBankVersion: string | null;
  schedule: TrustSchedule | { protocolVersion: string; investments?: number[]; trustTrials?: unknown[]; riskTrials?: unknown[] };
  recruitmentSource?: "manual" | "prolific" | "test";
  workflowDefinitionId?: string | null;
  status: "created" | "running" | "completed";
  lastSequence?: number;
  completedTrialIds?: string[];
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  if (hostMode !== "portal") headers.set("X-Study-Host", hostMode);
  if (hostSessionId) headers.set("X-Study-Session-Id", hostSessionId);
  if (deploymentId) headers.set("X-Study-Deployment-Id", deploymentId);
  if (clientVersion) headers.set("X-Study-Client-Version", clientVersion);
  if (hostedSessionToken) headers.set("Authorization", `Bearer ${hostedSessionToken}`);
  const response = await fetch(`${apiOrigin}${url}`, {
    ...init,
    credentials: hostMode === "portal" ? "same-origin" : "omit",
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error ?? `Serverfehler (${response.status})`);
  return body as T;
}

export const api = {
  prolificEntry: (data: { prolificPid: string; studyId: string; sessionId: string }) =>
    request<{
      sessionToken: string;
      recruitmentSource: "prolific";
      status: string;
      workflow: { id: string; name: string; version: number; steps: Array<{ id: string; moduleId: string; required: boolean }>; contentHash: string };
    }>("/api/prolific/entry", { method: "POST", body: JSON.stringify(data) }),
  login: (code: string) =>
    request<{
      studyType: "investor" | "trustee" | "workflow" | "admin";
      sessionToken?: string;
      host?: HostMode;
    }>("/api/auth/code", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  status: () =>
    request<{
      studyType: "investor" | "trustee" | "workflow";
      status: string;
      consented: boolean;
      run: null | {
        id: string;
        status: string;
        completion_code?: string;
        bonus_eur?: number;
      };
      recruitmentSource?: "manual" | "prolific" | "test";
      hasFaceSetSelection?: boolean;
      workflow?: {
        id: string;
        name: string;
        version: number;
        steps: Array<{ id: string; moduleId: string; required: boolean }>;
        contentHash: string;
        progress: Array<{ stepId: string; moduleId: string; status: string; startedAt: string | null; completedAt: string | null }>;
      } | null;
      completionRedirectUrl?: string | null;
    }>("/api/participant/status"),
  consent: (accepted: boolean, documentVersion = "consent-de-v2") =>
    request("/api/participant/consent", {
      method: "POST",
      body: JSON.stringify({ accepted, documentVersion }),
    }),
  faceSet: (genderIdentity: "man" | "woman" | "nonbinary" | "self_described" | "prefer_not_to_say", faceSetPreference?: "male" | "female" | "random") =>
    request<{ ok: boolean; faceSetPreference: string }>("/api/participant/face-set", {
      method: "POST",
      body: JSON.stringify({ genderIdentity, faceSetPreference }),
    }),
  createRun: () => request<RunDto>("/api/runs", { method: "POST" }),
  currentRun: () => request<RunDto>("/api/runs/current"),
  startRun: (runId: string) =>
    request(`/api/runs/${runId}/start`, { method: "POST" }),
  outcome: (
    runId: string,
    trialId: string,
    profile: string,
    investment: number,
    chosenSide?: string,
  ) =>
    request<{
      policyId: string;
      invested: number;
      tripled: number;
      returned: number;
      payoff: number;
      net: number;
      outcomeType: "win" | "lose" | "break_even";
      condition: "reward" | "punishment" | "learning";
      probability: number;
      randomDraw: number | null;
    }>(`/api/runs/${runId}/outcome`, {
      method: "POST",
      body: JSON.stringify({ trialId, profile, investment, chosenSide }),
    }),
  riskOutcome: (runId: string, trialId: string, choice: "sure" | "gamble") =>
    request<{ choice: string; realizedTokens: number; randomDraw: number }>(
      `/api/runs/${runId}/risk-outcome`,
      {
        method: "POST",
        body: JSON.stringify({ trialId, choice }),
      },
    ),
  trusteePolicy: (runId: string, returnsByInvestment: number[]) =>
    request(`/api/runs/${runId}/trustee-policy`, {
      method: "POST",
      body: JSON.stringify({ returnsByInvestment }),
    }),
  complete: (runId: string, summary: Record<string, unknown>) =>
    request<{ completionCode: string; bonusEur: number; completionRedirectUrl?: string | null }>(
      `/api/runs/${runId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ summary }),
      },
    ),
  workflowStep: (runId: string, stepId: string, action: "started" | "completed" | "failed", response?: Record<string, unknown>) =>
    request<{ ok: boolean; status: string }>(`/api/runs/${runId}/workflow-step`, {
      method: "POST",
      body: JSON.stringify({ stepId, action, response }),
    }),
};

export type ResearchEvent = {
  sequence: number;
  eventId: string;
  eventType: string;
  trialId?: string | null;
  clientTimeMs: number;
  payload: Record<string, unknown>;
};

export class EventQueue {
  private pending: ResearchEvent[] = [];
  private sequence = 0;
  private flushing: Promise<void> | null = null;
  private readonly key: string;

  constructor(
    private runId: string,
    lastSequence = -1,
  ) {
    this.key = `research-events:${runId}`;
    const stored = localStorage.getItem(this.key);
    if (stored) {
      try {
        this.pending = JSON.parse(stored);
      } catch {
        this.pending = [];
      }
    }
    this.sequence = Math.max(
      lastSequence + 1,
      ...this.pending.map((event) => event.sequence + 1),
      0,
    );
    window.addEventListener("online", () => void this.flush());
    void this.flush();
  }

  pendingTrialIds() {
    return this.pending
      .filter((event) => event.eventType === "trial_complete" && event.trialId)
      .map((event) => event.trialId as string);
  }

  add(
    eventType: string,
    payload: Record<string, unknown>,
    trialId?: string | null,
  ) {
    this.pending.push({
      sequence: this.sequence++,
      eventId: crypto.randomUUID(),
      eventType,
      trialId,
      clientTimeMs: performance.now(),
      payload,
    });
    this.persist();
    void this.flush();
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushLoop() {
    while (this.pending.length) {
      const batch = this.pending.slice(0, 50);
      try {
        await request(`/api/runs/${this.runId}/events`, {
          method: "POST",
          body: JSON.stringify({ events: batch }),
        });
        this.pending.splice(0, batch.length);
        this.persist();
      } catch {
        return;
      }
    }
  }

  async drain() {
    await this.flush();
    if (this.pending.length)
      throw new Error(
        "Nicht alle Daten konnten übertragen werden. Bitte prüfen Sie Ihre Internetverbindung.",
      );
  }

  private persist() {
    localStorage.setItem(this.key, JSON.stringify(this.pending));
  }
}
