import { useEffect, useState } from "react";
import { currentResearcherToken, signInResearcher, signOutResearcher } from "./firebaseAuth";

const apiBase = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");

const universityLogo = new URL("../../Uni_Logo (1).png", import.meta.url).href;
const scanUnitLogo = new URL("../../csm_logo_7135bba3da (1).jpg", import.meta.url).href;

type Grant = {
  id: string;
  study_type: "investor" | "trustee" | "workflow";
  status: string;
  expires_at: string;
  recruitment_source?: string;
  prolific_pid?: string | null;
  prolific_study_id?: string | null;
  prolific_session_id?: string | null;
  run_id?: string | null;
  run_status?: string | null;
  firebase_export_status?: string | null;
  workflow_progress?: Array<{ stepId: string; moduleId: string; status: string }>;
  participant_sex?: "male" | "female" | null;
  counterbalance_group?: "CB1" | "CB2" | "CB3" | null;
};
type WorkflowModule = { id: string; title: string; kind: string; enabled: boolean; description: string };
type WorkflowRecord = { id: string; name: string; version: number; status: string; steps: Array<{id:string;moduleId:string;required:boolean}>; content_hash: string; prolific_study_id?: string | null; prolific_active?: boolean | null; completion_url?: string | null };
type Policy = {
  id: string;
  returns_by_investment: number[];
  quality_passed: boolean;
  decision_count: number;
  average_rt_ms: string | null;
};

async function adminRequest<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const bearer = import.meta.env.DEV ? token : (await currentResearcherToken()) ?? token;
  const response = await fetch(`${apiBase}${url}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function Admin() {
  const isDevelopment = import.meta.env.DEV;
  const normingEnabled = import.meta.env.VITE_ENABLE_NORMING_ADMIN === "true";
  const [token, setToken] = useState(
    isDevelopment ? sessionStorage.getItem("admin-token") ?? "" : "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [message, setMessage] = useState("");
  const [count, setCount] = useState(10);
  const [studyType, setStudyType] = useState<"investor" | "trustee">(
    "investor",
  );
  const [sex, setSex] = useState<"male" | "female">("male");
  const [counterbalanceGroup, setCounterbalanceGroup] = useState("auto");
  const [workflowModules, setWorkflowModules] = useState<WorkflowModule[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [workflowName, setWorkflowName] = useState("Prolific Trust Study");
  const [selectedModules, setSelectedModules] = useState<string[]>(["trust-game"]);
  const [prolificStudyId, setProlificStudyId] = useState("");
  const [prolificWorkflowId, setProlificWorkflowId] = useState("");
  const [completionUrl, setCompletionUrl] = useState("");
  const [prolificActive, setProlificActive] = useState(false);

  const load = async (providedToken = token) => {
    if (isDevelopment) sessionStorage.setItem("admin-token", providedToken);
    try {
      const [nextSummary, nextGrants, nextPolicies, nextModules, nextWorkflows] = await Promise.all([
        adminRequest<any>("/api/admin/summary", providedToken),
        adminRequest<{ grants: Grant[] }>("/api/admin/codes", providedToken),
        adminRequest<{ policies: Policy[] }>(
          "/api/admin/trustee-policies",
          providedToken,
        ),
        adminRequest<{ modules: WorkflowModule[] }>("/api/admin/workflow-modules", providedToken),
        adminRequest<{ workflows: WorkflowRecord[] }>("/api/admin/workflows", providedToken),
      ]);
      setSummary(nextSummary);
      setGrants(nextGrants.grants);
      setPolicies(nextPolicies.policies);
      setWorkflowModules(nextModules.modules);
      setWorkflows(nextWorkflows.workflows);
      setProlificWorkflowId((current) => current || nextWorkflows.workflows.find((w) => w.status === "published")?.id || "");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const createWorkflowDraft = async () => {
    try {
      const result = await adminRequest<{workflow: WorkflowRecord}>("/api/admin/workflows", token, {
        method: "POST",
        body: JSON.stringify({
          name: workflowName,
          steps: selectedModules.map((moduleId, i) => ({ id: `${moduleId.replace(/[^a-z0-9]/gi, "-")}-${i + 1}`, moduleId, required: true })),
        }),
      });
      setMessage(`Entwurf v${result.workflow.version} angelegt. Bitte prüfen und veröffentlichen.`);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const publishWorkflow = async (id: string) => {
    try {
      await adminRequest(`/api/admin/workflows/${id}/publish`, token, { method: "POST" });
      setProlificWorkflowId(id);
      setMessage("Workflow veröffentlicht. Veröffentlichte Versionen sind unveränderlich.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const saveProlificMapping = async () => {
    try {
      await adminRequest("/api/admin/prolific-studies", token, {
        method: "POST",
        body: JSON.stringify({ prolificStudyId, workflowDefinitionId: prolificWorkflowId, completionUrl, active: prolificActive }),
      });
      setMessage(prolificActive ? "Prolific-Zuordnung gespeichert und aktiviert." : "Prolific-Zuordnung gespeichert, aber noch inaktiv.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const moveWorkflowModule = (index: number, direction: -1 | 1) => {
    setSelectedModules((current) => {
      const next = current.slice();
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  useEffect(() => {
    if (isDevelopment && token) void load(token);
    if (!isDevelopment) void currentResearcherToken().then((idToken) => { if (idToken) { setToken(idToken); void load(idToken); } });
  }, []);

  const connectResearcher = async () => {
    if (isDevelopment) return void load(token);
    try {
      const idToken = await signInResearcher(email, password, totp);
      setToken(idToken);
      setPassword("");
      setTotp("");
      setMfaRequired(false);
      await load(idToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Authenticator-Code")) setMfaRequired(true);
      setMessage(message);
    }
  };

  const generate = async () => {
    try {
      const result = await adminRequest<{ codes: string[] }>(
        "/api/admin/codes",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            count,
            studyType,
            sex: studyType === "investor" ? sex : undefined,
            counterbalanceGroup:
              studyType === "investor" && counterbalanceGroup !== "auto"
                ? counterbalanceGroup
                : undefined,
            validDays: 30,
          }),
        },
      );
      download(
        "access_code,study_type\n" +
          result.codes.map((code) => `${code},${studyType}`).join("\n"),
        `invitation-codes-${studyType}.csv`,
        "text/csv",
      );
      setMessage(
        `${result.codes.length} Codes wurden erzeugt. Die Klartext-Codes werden nicht erneut angezeigt.`,
      );
      void load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const revoke = async (id: string) => {
    try {
      await adminRequest(`/api/admin/codes/${id}/revoke`, token, {
        method: "POST",
      });
      setMessage("Code widerrufen.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const reviewPolicy = async (id: string, passed: boolean) => {
    try {
      await adminRequest(`/api/admin/trustee-policies/${id}/quality`, token, {
        method: "POST",
        body: JSON.stringify({ passed }),
      });
      setMessage(
        passed
          ? "Trustee-Profil akzeptiert."
          : "Trustee-Profil ausgeschlossen.",
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const buildBank = async () => {
    const version = `recorded-${new Date().toISOString().slice(0, 10)}-${Date.now().toString().slice(-5)}`;
    try {
      const result = await adminRequest<any>(
        "/api/admin/outcome-bank/build",
        token,
        { method: "POST", body: JSON.stringify({ version }) },
      );
      setMessage(
        `Outcome-Bank ${result.version} aktiviert (${result.hash.slice(0, 12)}…).`,
      );
      void load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const fetchExport = async (grantId?: string) =>
    adminRequest<any>(
      grantId ? `/api/admin/export/${grantId}` : "/api/admin/export",
      token,
    );

  const downloadTrialTsv = (data: any, filename: string) => {
    if (!Array.isArray(data.trialRows) || !data.trialRows.length) return false;
    const columns = Array.from(
      new Set(
        data.trialRows.flatMap((row: Record<string, unknown>) =>
          Object.keys(row),
        ),
      ),
    ) as string[];
    const quote = (value: unknown) =>
      JSON.stringify(value === null || value === undefined ? "" : value);
    const tsv = [
      columns.join("\t"),
      ...data.trialRows.map((row: Record<string, unknown>) =>
        columns.map((column) => quote(row[column])).join("\t"),
      ),
    ].join("\n");
    download(tsv, filename, "text/tab-separated-values");
    return true;
  };

  const exportJson = async () => {
    try {
      const data = await fetchExport();
      download(
        JSON.stringify(data, null, 2),
        "pseudonymous-research-export.json",
        "application/json",
      );
      setMessage("JSON-Export heruntergeladen.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const exportTsv = async () => {
    try {
      const data = await fetchExport();
      if (!downloadTrialTsv(data, "trust-game-trials.tsv")) {
        setMessage("Noch keine abgeschlossenen Trial-Daten für den TSV-Export vorhanden.");
        return;
      }
      setMessage("TSV-Trial-Export heruntergeladen.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const exportGrant = async (grantId: string, format: "json" | "tsv") => {
    try {
      const bearer = isDevelopment ? token : (await currentResearcherToken()) ?? token;
      const response = await fetch(`${apiBase}/api/admin/export/${grantId}/file?format=${format}`, { headers: { Authorization: `Bearer ${bearer}` } });
      if (!response.ok) throw new Error(`Export fehlgeschlagen (HTTP ${response.status})`);
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `participant-${grantId.slice(0, 8)}.${format}`;
      link.click();
      URL.revokeObjectURL(link.href);
      setMessage(`${format.toUpperCase()}-Export für interne ID ${grantId.slice(0, 8)}… heruntergeladen.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="portal-shell">
      <header className="brand">
        <div className="brand-logos admin-brand-logos">
          <img src={universityLogo} alt="Universität Wien" />
          <img src={scanUnitLogo} alt="SCAN Unit" />
        </div>
        <div className="admin-brand-title">
          <strong>Research Administration</strong>
          <span>Online Trust Game</span>
        </div>
        <a className="admin-participant-link" href={import.meta.env.MODE === "github-pages" ? `${import.meta.env.BASE_URL}index.html?participant=1` : "/"}>Teilnehmeransicht →</a>
      </header>
      <main className="admin">
        <div className="admin-hero">
          <div>
            <span className="eyebrow">Research operations · Development</span>
            <h1>Studienverwaltung</h1>
            <p className="lead">
              Zugangscodes ausstellen, Teilnahmen überwachen und pseudonyme
              Forschungsdaten exportieren.
            </p>
          </div>
          <span className="secure-pill">Geschützter Bereich</span>
        </div>
        <section className="card admin-auth">
          <div>
            <span className="section-kicker">Zugang</span>
            <h2>Mit Verwaltung verbinden</h2>
            <p>{isDevelopment ? "Lokaler Development-Token." : "Persönliches Forschungskonto mit verpflichtendem Authenticator-Zweitfaktor."}</p>
          </div>
          <div className="admin-auth-controls">
            {isDevelopment ? <label>
              Development token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token eingeben" />
            </label> : <>
              <label>E-Mail-Adresse<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label>Passwort<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              {mfaRequired && <label>Authenticator-Code<input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} /></label>}
            </>}
            <button className="secondary" onClick={() => void connectResearcher()}>{isDevelopment ? "Verbinden" : mfaRequired ? "Zweitfaktor bestätigen" : "Anmelden"}</button>
            {!isDevelopment && token && <button className="text-button" onClick={() => { void signOutResearcher(); setToken(""); setSummary(null); setGrants([]); }}>Abmelden</button>}
          </div>
        </section>
        {message && <p className="notice">{message}</p>}
        {summary && (
          <>
            <div className="metrics admin-metrics">
              <article className="card" hidden={!normingEnabled}>
                <small>Normierungsprofile</small>
                <strong>
                  {summary.trusteePolicies.passed} /{" "}
                  {summary.trusteePolicies.count}
                </strong>
                <span>Qualität bestanden</span>
              </article>
              <article className="card" hidden={!normingEnabled}>
                <small>Aktive Outcome-Bank</small>
                <strong>{summary.activeBank?.source ?? "Keine"}</strong>
                <span>{summary.activeBank?.version ?? "Nicht aktiviert"}</span>
              </article>
              <article className="card">
                <small>Aktives Protokoll</small>
                <strong>{summary.protocolVersion ?? "–"}</strong>
                <span>Versionierter Ablauf</span>
              </article>
              <article className="card">
                <small>Zugänge / Teilnahmen</small>
                <strong>
                  {(summary.grants ?? []).reduce(
                    (total: number, row: { count: number }) => total + Number(row.count),
                    0,
                  )}
                </strong>
                <span>Ausgestellt oder verwendet</span>
              </article>
            </div>
            <section className="card admin-panel">
              <div className="admin-section-heading">
                <div>
                  <span className="section-kicker">Teilnehmendenverwaltung</span>
                  <h2>Zugänge und Teilnahmen</h2>
                  <p>Erzeugen Sie manuelle Codes oder prüfen Sie Prolific-Sitzungen mit Stimulusauswahl, Counterbalancing, Workflow-Status und Export.</p>
                </div>
                <span className="section-count">max. 500 pro Ausgabe</span>
              </div>
              <div className="form-row">
                <label>
                  Anzahl
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  />
                </label>
                <label>
                  Studie
                  <select
                    value={studyType}
                    onChange={(e) =>
                      setStudyType(e.target.value as "investor" | "trustee")
                    }
                  >
                    <option value="investor">Trust Game</option>
                    {normingEnabled && (
                      <option value="trustee">Trustee-Normierung</option>
                    )}
                  </select>
                </label>
                {studyType === "investor" && (
                  <>
                    <label>
                      Stimulus-Geschlecht
                      <select value={sex} onChange={(e) => setSex(e.target.value as "male" | "female")}>
                        <option value="male">Männlich (M)</option>
                        <option value="female">Weiblich (W)</option>
                      </select>
                    </label>
                    <label>
                      Counterbalancing
                      <select value={counterbalanceGroup} onChange={(e) => setCounterbalanceGroup(e.target.value)}>
                        <option value="auto">Automatisch ausbalancieren</option>
                        <option value="CB1">CB1</option>
                        <option value="CB2">CB2</option>
                        <option value="CB3">CB3</option>
                      </select>
                    </label>
                  </>
                )}
                <button className="primary" onClick={() => void generate()}>
                  Codes als CSV erzeugen
                </button>
              </div>
              <h3>Letzte Zugänge</h3>
              <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Interne ID</th>
                    <th>Studie</th>
                    <th>Rekrutierung / Prolific-IDs</th>
                    <th>Status</th>
                    <th>Archiv</th>
                    <th>Gültig bis</th>
                    <th></th>
                    <th>Teilnehmerexport</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.slice(0, 20).map((grant) => (
                    <tr key={grant.id}>
                      <td>{grant.id.slice(0, 8)}…</td>
                      <td>{grant.study_type}</td>
                      <td>{grant.recruitment_source === "prolific" ? <><small>PID {grant.prolific_pid || "–"}</small><br/><small>Study {grant.prolific_study_id || "–"} · Session {grant.prolific_session_id || "–"}</small></> : grant.recruitment_source || "manual"}</td>
                      <td>{grant.status}</td>
                      <td>{grant.run_status || "–"}<br/><small>{grant.workflow_progress?.map((step) => `${step.moduleId}: ${step.status}`).join(" · ") || "Kein Workflow-Fortschritt"}<br/>Firebase: {grant.firebase_export_status || "–"}</small></td>
                      <td>
                        {new Date(grant.expires_at).toLocaleDateString("de-DE")}
                      </td>
                     <td>
                       {!["completed", "revoked"].includes(grant.status) && (
                         <button
                           className="text-button"
                           onClick={() => void revoke(grant.id)}
                         >
                           Widerrufen
                         </button>
                       )}
                     </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => void exportGrant(grant.id, "json")}
                        >
                          JSON
                        </button>{" "}
                        <button
                          className="text-button"
                          onClick={() => void exportGrant(grant.id, "tsv")}
                        >
                          TSV
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
            <section className="card admin-panel">
              <div className="admin-section-heading"><div><span className="section-kicker">Ablauf-Konfiguration</span><h2>Workflow erstellen und veröffentlichen</h2><p>Ein Workflow ist eine unveränderliche, versionierte Reihenfolge aus freigegebenen Aufgaben und Fragebögen.</p></div></div>
              <div className="form-row">
                <label>Name des Workflows<input value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} maxLength={100}/></label>
                <fieldset className="field"><legend>Module in Reihenfolge</legend>
                  {workflowModules.map((module) => <label className="check" key={module.id}><input type="checkbox" disabled={!module.enabled} checked={selectedModules.includes(module.id)} onChange={(e) => setSelectedModules((current) => e.target.checked ? [...current, module.id] : current.filter((id) => id !== module.id))}/>{module.title}{!module.enabled ? " (noch nicht freigegeben)" : ""}</label>)}
                </fieldset>
                {selectedModules.length > 0 && <ol className="workflow-order">{selectedModules.map((moduleId, index) => <li key={`${moduleId}-${index}`}><span>{workflowModules.find((module) => module.id === moduleId)?.title ?? moduleId}</span><button type="button" className="text-button" disabled={index === 0} onClick={() => moveWorkflowModule(index, -1)} aria-label="Schritt nach oben">↑</button><button type="button" className="text-button" disabled={index === selectedModules.length - 1} onClick={() => moveWorkflowModule(index, 1)} aria-label="Schritt nach unten">↓</button></li>)}</ol>}
                <button className="primary" disabled={!workflowName.trim() || selectedModules.length === 0} onClick={() => void createWorkflowDraft()}>Entwurf erstellen</button>
              </div>
              <h3>Versionen</h3>
              {workflows.length === 0 ? <p>Noch keine Workflows vorhanden.</p> : <div className="admin-table-wrap"><table><thead><tr><th>Name</th><th>Version</th><th>Status</th><th>Inhalt</th><th>Aktion</th></tr></thead><tbody>{workflows.map((workflow) => <tr key={workflow.id}><td>{workflow.name}</td><td>{workflow.version}</td><td>{workflow.status}</td><td>{workflow.steps.map((step) => step.moduleId).join(" → ")}</td><td>{workflow.status === "draft" && <button className="text-button" onClick={() => void publishWorkflow(workflow.id)}>Veröffentlichen</button>}</td></tr>)}</tbody></table></div>}
            </section>
            <section className="card admin-panel">
              <div className="admin-section-heading"><div><span className="section-kicker">Rekrutierung</span><h2>Prolific-Studie zuordnen</h2><p>Erst aktivieren, nachdem Preview/Test abgeschlossen, API-Origin und Completion-URL verifiziert sowie Einwilligung und Datenschutz geprüft wurden.</p></div></div>
              <div className="form-row">
                <label>Prolific Study ID<input value={prolificStudyId} onChange={(e) => setProlificStudyId(e.target.value)} placeholder="z. B. study ID"/></label>
                <label>Veröffentlichter Workflow<select value={prolificWorkflowId} onChange={(e) => setProlificWorkflowId(e.target.value)}><option value="">Workflow auswählen</option>{workflows.filter((w) => w.status === "published").map((w) => <option key={w.id} value={w.id}>{w.name} · v{w.version}</option>)}</select></label>
                <label>Prolific Completion URL<input value={completionUrl} onChange={(e) => setCompletionUrl(e.target.value)} placeholder="https://app.prolific.com/submissions/complete?cc=…"/></label>
                <label className="check"><input type="checkbox" checked={prolificActive} onChange={(e) => setProlificActive(e.target.checked)}/> Zuordnung aktivieren</label>
                <button className="primary" disabled={!prolificStudyId || !prolificWorkflowId || !completionUrl} onClick={() => void saveProlificMapping()}>Zuordnung speichern</button>
              </div>
              {workflows.some((w) => w.prolific_study_id) && <div className="admin-table-wrap"><table><thead><tr><th>Study ID</th><th>Workflow</th><th>Status</th><th>Completion</th></tr></thead><tbody>{workflows.filter((w) => w.prolific_study_id).map((w) => <tr key={w.id}><td>{w.prolific_study_id}</td><td>{w.name} v{w.version}</td><td>{w.prolific_active ? "Aktiv" : "Inaktiv"}</td><td><code>{w.completion_url}</code></td></tr>)}</tbody></table></div>}
            </section>
            <section className="card admin-panel" hidden={!normingEnabled}>
              <h2>Trustee-Qualitätsprüfung</h2>
              <p>
                Profile werden erst nach manueller Prüfung für die Outcome-Bank
                freigegeben.
              </p>
              {policies.length === 0 ? (
                <p>Noch keine Profile eingereicht.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Profil</th>
                      <th>Rückgaben bei Einsatz 0–10</th>
                      <th>Qualitätsdaten</th>
                      <th>Status</th>
                      <th>Prüfung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((policy) => (
                      <tr key={policy.id}>
                        <td>{policy.id.slice(0, 8)}…</td>
                        <td>{policy.returns_by_investment.join(" · ")}</td>
                        <td>
                          {policy.decision_count}/11 Entscheidungen
                          <br />Ø {policy.average_rt_ms ?? "–"} ms
                        </td>
                        <td>
                          {policy.quality_passed
                            ? "akzeptiert"
                            : "nicht freigegeben"}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => void reviewPolicy(policy.id, true)}
                          >
                            Akzeptieren
                          </button>{" "}
                          <button
                            className="text-button"
                            onClick={() => void reviewPolicy(policy.id, false)}
                          >
                            Ausschließen
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="card admin-panel" hidden={!normingEnabled}>
              <h2>Outcome-Bank</h2>
              <p>
                Mindestens neun qualitätsgeprüfte Trustee-Profile sind
                erforderlich. Die Aktivierung erzeugt eine unveränderliche,
                versionierte Bank aus aufgezeichneten Entscheidungen.
              </p>
              <button
                className="secondary"
                disabled={Number(summary.trusteePolicies.passed) < 9}
                onClick={() => void buildBank()}
              >
                Neue Recorded-Human-Bank bauen
              </button>
            </section>
            <section className="card admin-panel">
              <div className="admin-section-heading">
                <div>
                  <span className="section-kicker">Datenzugriff</span>
                  <h2>Pseudonymer Forschungs-Export</h2>
                </div>
                <span className="section-count">JSON · TSV</span>
              </div>
              <p>
                Prolific-Exporte enthalten PID, Study-ID und Session-ID neben
                der internen ID, damit Teilnahmen zugeordnet werden können.
                Sie enthalten keine Einladungscodes oder E-Mail-Adressen, sind
                wegen dieser Verknüpfung aber pseudonym und nicht anonym. Eine
                automatische Löschung der Verknüpfung ist derzeit nicht
                implementiert; Zugriff und Aufbewahrung müssen nach dem
                genehmigten Datenschutzplan verwaltet werden.
              </p>
              <div className="form-row export-actions">
                <button className="secondary" onClick={() => void exportJson()}>
                  JSON-Export herunterladen
                </button>
                <button className="secondary" onClick={() => void exportTsv()}>
                  Trial-TSV herunterladen
                </button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function download(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
