import { lazy, Suspense, useEffect, useState } from "react";
import { api, configureProlificSession, setHostedSessionToken, type RunDto } from "../api";
import { completeHostedRuntime } from "../host/runtime";

const TrustStudy = lazy(() => import("../study/TrustStudy").then((module) => ({ default: module.TrustStudy })));
const TrusteeStudy = lazy(() => import("../study/TrusteeStudy").then((module) => ({ default: module.TrusteeStudy })));
const WorkflowRunner = lazy(() => import("../study/WorkflowRunner").then((module) => ({ default: module.WorkflowRunner })));
const Admin = lazy(() => import("./Admin").then((module) => ({ default: module.Admin })));

const universityLogo = new URL("../../Uni_Logo (1).png", import.meta.url).href;
const scanUnitLogo = new URL("../../csm_logo_7135bba3da (1).jpg", import.meta.url).href;

type Screen = "loading" | "login" | "consent" | "faceSet" | "dashboard" | "study" | "done" | "entryError";
type WorkflowDto = {
  id: string;
  name: string;
  version: number;
  steps: Array<{ id: string; moduleId: string; required: boolean }>;
  contentHash: string;
};

export function App() {
  const isAdminRoute = location.pathname === "/admin" || location.hash === "#/admin";
  const [screen, setScreen] = useState<Screen>(
    isAdminRoute ? "dashboard" : "loading",
  );
  const [studyType, setStudyType] = useState<"investor" | "trustee">(
    "investor",
  );
  const [recruitmentSource, setRecruitmentSource] = useState<"manual" | "prolific">("manual");
  const [workflow, setWorkflow] = useState<WorkflowDto | null>(null);
  const [completionUrl, setCompletionUrl] = useState<string | null>(null);
  const [entryError, setEntryError] = useState("");
  const [run, setRun] = useState<RunDto | null>(null);
  const [completion, setCompletion] = useState("");

  useEffect(() => {
    const restore = async () => {
      if (isAdminRoute) return;
      try {
        const params = new URLSearchParams(window.location.search);
        const prolificPid = params.get("PROLIFIC_PID");
        const studyId = params.get("STUDY_ID");
        const sessionId = params.get("SESSION_ID");
        const hasProlificArgs = prolificPid !== null || studyId !== null || sessionId !== null;
        const existingToken = sessionStorage.getItem("prolific-session-token");
        if (prolificPid && studyId && sessionId) {
          const entry = await api.prolificEntry({ prolificPid, studyId, sessionId });
          sessionStorage.setItem("prolific-session-token", entry.sessionToken);
          configureProlificSession(entry.sessionToken);
          setWorkflow(entry.workflow);
          setRecruitmentSource("prolific");
          window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
        } else if (hasProlificArgs) {
          throw new Error("Der Prolific-Aufruf enthält nicht alle erforderlichen Sitzungsdaten. Bitte öffnen Sie den Studienlink erneut.");
        } else if (existingToken) {
          configureProlificSession(existingToken);
          setRecruitmentSource("prolific");
        }
        const status = await api.status();
        setStudyType(status.studyType === "trustee" ? "trustee" : "investor");
        if (status.recruitmentSource === "prolific") setRecruitmentSource("prolific");
        if (status.workflow) setWorkflow(status.workflow);
        setCompletionUrl(status.completionRedirectUrl ?? null);
        if (status.run?.status === "completed") {
          if (status.recruitmentSource === "prolific" && status.completionRedirectUrl) {
            window.location.assign(status.completionRedirectUrl);
            return;
          }
          setCompletion(status.run.completion_code ?? "");
          setScreen("done");
        } else if (!status.consented) {
          setScreen("consent");
        } else if (status.recruitmentSource === "prolific" && !status.hasFaceSetSelection && status.workflow?.steps.some((step) => step.moduleId === "trust-game")) {
          setScreen("faceSet");
        } else {
          setScreen("dashboard");
        }
      } catch (error) {
        if (sessionStorage.getItem("prolific-session-token") || new URLSearchParams(location.search).has("PROLIFIC_PID")) {
          setEntryError(error instanceof Error ? error.message : String(error));
          setScreen("entryError");
        } else setScreen("login");
      }
    };
    void restore();
  }, []);

  if (isAdminRoute) return <Suspense fallback={<Centered><p>Verwaltung wird geladen …</p></Centered>}><Admin /></Suspense>;

  const start = async () => {
    const created = await api.createRun();
    await api.startRun(created.id);
    const next = await api.currentRun();
    setRun(next);
    setScreen("study");
  };

  if (screen === "loading")
    return (
      <Centered>
        <p>Laden …</p>
      </Centered>
    );
  if (screen === "login")
    return (
      <Login
        onSuccess={(result) => {
          if (result.sessionToken) setHostedSessionToken(result.sessionToken);
          if (result.studyType === "admin") {
            window.location.assign(import.meta.env.MODE === "github-pages" ? `${import.meta.env.BASE_URL}index.html#/admin` : "/admin");
            return;
          }
          setStudyType(result.studyType === "trustee" ? "trustee" : "investor");
          setScreen("consent");
        }}
      />
    );
  if (screen === "consent")
    return (
      <Consent
        prolific={recruitmentSource === "prolific"}
        onAccept={async () => {
          await api.consent(true, recruitmentSource === "prolific" ? "consent-prolific-de-v1" : "consent-de-v2");
          if (recruitmentSource === "prolific" && workflow?.steps.some((step) => step.moduleId === "trust-game")) setScreen("faceSet");
          else setScreen("dashboard");
        }}
      />
    );
  if (screen === "faceSet")
    return <FaceSetSelection onSubmit={async (identity, preference) => {
      await api.faceSet(identity, preference);
      setScreen("dashboard");
    }} />;
  if (screen === "study" && run && recruitmentSource === "prolific" && workflow) {
    return <Suspense fallback={<Centered><p>Aufgabe wird vorbereitet …</p></Centered>}><WorkflowRunner run={run} workflow={workflow} onDone={(code, redirect) => {
      setCompletion(code);
      if (redirect) window.location.assign(redirect);
      else setScreen("done");
    }} /></Suspense>;
  }
  if (screen === "study" && run) {
    const onDone = (code: string) => {
      void completeHostedRuntime({ completionCode: code });
      setCompletion(code);
      setScreen("done");
    };
    return <Suspense fallback={<Centered><p>Aufgabe wird vorbereitet …</p></Centered>}>{run.studyType === "trustee" ? (
      <TrusteeStudy run={run} onDone={onDone} />
    ) : (
      <TrustStudy run={run} onDone={onDone} />
    )}</Suspense>;
  }
  if (screen === "done")
    return (
      <Centered>
        <section className="card completion">
          <span className="eyebrow">Abgeschlossen</span>
          <h1>Vielen Dank für Ihre Teilnahme.</h1>
          <p>Ihre Antworten wurden erfolgreich gespeichert.</p>
          <p>
            Ihr Abschlusscode bestätigt, dass Sie die Studie abgeschlossen
            haben. Bewahren Sie ihn bitte auf und geben Sie ihn entsprechend
            den Informationen des Studienteams weiter.
          </p>
          <p className="completion-code">
            Abschlusscode: <strong>{completion}</strong>
          </p>
          <p className="fine-print">
            Sie können dieses Fenster jetzt schließen.
          </p>
        </section>
      </Centered>
    );
  if (studyType === "trustee") return <Dashboard trustee onStart={start} />;
  if (screen === "entryError") return <Centered><section className="card"><h1>Verbindung zur Studie nicht möglich</h1><p role="alert">{entryError}</p><p>Bitte öffnen Sie den ursprünglichen Studienlink erneut oder wenden Sie sich an das Studienteam.</p></section></Centered>;
  return <Dashboard workflow={workflow} onStart={start} />;
}

function Login({
  onSuccess,
}: {
  onSuccess: (result: {
    studyType: "investor" | "trustee" | "workflow" | "admin";
    sessionToken?: string;
  }) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.login(code);
      if (result.studyType === "admin")
        sessionStorage.setItem("admin-token", code);
      onSuccess(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="portal-shell">
      <header className="brand">
        <span className="brand-mark">Ψ</span>
        <span>Online-Studienportal</span>
      </header>
      <main className="login-layout">
        <section className="login-copy">
          <span className="eyebrow">Kognitive Neurowissenschaft</span>
          <h1>Willkommen zu unserer Online-Studie.</h1>
          <p>
            Bearbeiten Sie die Studie in einer ruhigen Umgebung an einem
            Computer oder Laptop. Ihre Antworten werden unter einem
            pseudonymen Zugangscode gespeichert.
          </p>
        </section>
        <form className="card login-card" onSubmit={submit}>
          <label htmlFor="access-code">Persönlicher Zugangscode</label>
          <input
            id="access-code"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX"
          />
          <button className="primary" disabled={busy || code.trim().length < 8}>
            {busy ? "Prüfen …" : "Weiter"}
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="fine-print">
            Dieser Code enthält keine Namen oder E-Mail-Adressen oder sonstige
            Informationen, mit denen auf Sie als Person zurückgeschlossen
            werden kann.
          </p>
        </form>
      </main>
    </div>
  );
}

function Consent({ onAccept, prolific = false }: { onAccept: () => Promise<void>; prolific?: boolean }) {
  const [checks, setChecks] = useState([false, false, false]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const all = checks.every(Boolean);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onAccept();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <section className="card consent">
        <span className="eyebrow">Einwilligung · Version {prolific ? "consent-prolific-de-v1" : "consent-de-v2"}</span>
        <h1>Information und Einwilligung</h1>
        <div className="consent-text">
          <p>Sehr geehrte Teilnehmerin, sehr geehrter Teilnehmer,</p>
          <p>
            herzlich Willkommen und vielen Dank für Ihr Interesse an dieser
            Studie! Mit Ihrer Teilnahme unterstützen Sie unsere Forschung zu
            Entscheidungsprozessen, sozialer Wahrnehmung und risikobezogenem
            Verhalten – wir freuen uns sehr, dass Sie sich dafür Zeit nehmen.
          </p>
          <p>
            Die Studie wurde von der Ethikkommission der Universität Wien
            genehmigt und Ihre Teilnahme ist vollkommen freiwillig. Sie können
            Ihre Einwilligung jederzeit und ohne Angabe von Gründen widerrufen.
            Eine Verweigerung der Teilnahme oder ein vorzeitiger Abbruch der
            Studie hat für Sie keinerlei negative Konsequenzen.
          </p>
          <p>Bitte bestätigen Sie Ihre Einwilligung nur, wenn</p>
          <ul>
            <li>Sie Art und Ablauf der Studie verstanden haben,</li>
            <li>Sie mit der Teilnahme einverstanden sind und</li>
            <li>
              Sie sich Ihrer Rechte als Studienteilnehmerin bzw. Studienteilnehmer
              bewusst sind.
            </li>
          </ul>
          <h2>Was ist das Ziel dieser Studie?</h2>
          <p>
            Diese Studie untersucht Unterschiede in Entscheidungsprozessen,
            sozialer Wahrnehmung und risikobezogenen Verhaltensweisen und
            überprüft dabei die Validität neu entwickelter experimenteller
            Aufgaben zur Messung dieser Konzepte.
          </p>
          <h2>Wie läuft die Studie ab, und wer kann teilnehmen?</h2>
          <p>
            Die Studie besteht aus einer Online-Aufgabe, die Sie direkt
            bearbeiten können. Dies nimmt etwa 30 Minuten in Anspruch. Es gibt
            dabei keine richtigen oder falschen Antworten - uns interessiert
            einfach Ihre persönliche Einschätzung.
          </p>
          <p>
            Voraussetzung für die Teilnahme ist ein Mindestalter von 18 Jahren.
            Die für die Durchführung und wissenschaftliche Auswertung
            erforderlichen Angaben werden digital verarbeitet und auf
            zugriffsgeschützten Systemen gespeichert.
          </p>
          <h2>Wie werden die erhobenen Daten verwendet?</h2>
          {prolific ? <>
          <p>
            Wenn Sie über Prolific teilnehmen, speichern wir Ihre Prolific-
            Teilnehmerkennung sowie Study- und Session-ID zusammen mit einem
            internen Studiencode und Ihren Antworten. Dadurch kann das
            Forschungsteam Ihre Teilnahme in Prolific zuordnen und den Abschluss
            Ihrer Studie prüfen. Diese Kennungen enthalten nicht direkt Ihren
            Namen oder Ihre E-Mail-Adresse, sind aber pseudonyme Kennungen und
            werden daher nicht als vollständig anonym behandelt.
          </p>
          <p>
            Die Forschungsdaten werden auf den Servern des Studienteams und in
            einem zugriffsgeschützten Cloud-Speicher verarbeitet. Die statische
            Studienseite wird über GitHub Pages ausgeliefert; GitHub protokolliert
            dabei aus Sicherheitsgründen die IP-Adresse beim Seitenaufruf. Das
            Forschungsteam erhält diese GitHub-Protokolle nicht über diese
            Studienanwendung.
          </p>
          </> : <p>
            Alle im Rahmen dieser Studie erhobenen Daten werden pseudonymisiert
            und in strikter Übereinstimmung mit den gesetzlichen
            Datenschutzbestimmungen gespeichert. Der Zugang ist ausschließlich
            dem Forschungsteam vorbehalten, die Auswertung erfolgt vollständig
            anonym, und alle Angaben werden streng vertraulich behandelt. Die
            Daten werden ausschließlich zu wissenschaftlichen Zwecken verwendet
            und enthalten keinerlei Informationen, die Rückschlüsse auf Ihre
            Person zulassen.
          </p>}
          <p>
            Bei Fragen oder Unklarheiten wenden Sie sich gerne an
            alexandra.heinz@univie.ac.at und tobias.reimann@univie.ac.at.
          </p>
          <p>
            Wir bedanken uns herzlich für Ihre Zeit und Ihren wertvollen Beitrag
            zu unserer Forschung!
          </p>
        </div>
        {[
          "Ich bin mindestens 18 Jahre alt und habe die Studieninformation gelesen.",
          "Ich nehme freiwillig teil und weiß, dass ich jederzeit abbrechen kann.",
          "Ich stimme der beschriebenen Verarbeitung meiner Forschungsdaten zu.",
        ].map((label, i) => (
          <label className="check" key={label}>
            <input
              type="checkbox"
              checked={checks[i]}
              onChange={(e) =>
                setChecks(
                  checks.map((v, j) => (j === i ? e.target.checked : v)),
                )
              }
            />
            {label}
          </label>
        ))}
        <button
          className="primary"
          disabled={!all || busy}
          onClick={() => void submit()}
        >
          {busy ? "Wird verarbeitet …" : "Einwilligen und fortfahren"}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </Centered>
  );
}

function Dashboard({
  trustee = false,
  workflow = null,
  onStart,
}: {
  trustee?: boolean;
  workflow?: WorkflowDto | null;
  onStart: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="portal-shell">
      <header className="brand">
        <div className="brand-logos">
          <img src={universityLogo} alt="Universität Wien" />
          <img src={scanUnitLogo} alt="SCAN Unit" />
        </div>
        <span className="brand-title">Online-Studienportal</span>
        <span className="secure-pill">Sichere Sitzung</span>
      </header>
      <main className="dashboard">
        <span className="eyebrow">Ihre Studie</span>
        <h1>{workflow ? workflow.name : trustee ? "Entscheidungsstudie" : "Aufgabenübersicht"}</h1>
        <p className="lead">
          {workflow
            ? `Dieser Ablauf umfasst ${workflow.steps.length} Schritt${workflow.steps.length === 1 ? "" : "e"}. Ihre Antworten werden mit Ihrer Prolific-Teilnahme verknüpft.`
            : "Bitte planen Sie etwa 30 Minuten ohne Unterbrechung ein."}
        </p>
        {workflow ? <section className="card workflow-overview">
          <h2>Ihr Studienablauf</h2>
          <ol>{workflow.steps.map((step) => <li key={step.id}>{step.moduleId === "trust-game" ? "Trust Game" : step.moduleId}</li>)}</ol>
          <button className="primary" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try { await onStart(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
          }}>{busy ? "Wird vorbereitet …" : "Studie beginnen"}</button>
        </section> : <div className="task-grid">
          <TaskCard
            title={trustee ? "Rückgabeentscheidungen" : "Trust Game"}
            description={
              trustee
                ? "Treffen Sie Entscheidungen aus der Perspektive einer empfangenden Person."
                : "In dieser Aufgabe treffen Sie Entscheidungen über Personen und Objekte. Sie verwenden einen Schieberegler, um eine Seite auszuwählen und Ihre Entscheidung beziehungsweise Ihren Investitionsbetrag anzugeben. Die Bearbeitung dauert ungefähr 30 Minuten."
            }
            meta="Verfügbar · ca. 30 Minuten"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onStart();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
            busy={busy}
          />
          {!trustee && (
            <>
              <TaskCard
                title="Hariri Face Matching"
                description="Emotions- und Formvergleich"
                meta="Noch nicht verfügbar"
                disabled
              />
              <TaskCard
                title="Mausland"
                description="Risiko- und Belohnungslernen"
                meta="Noch nicht verfügbar"
                disabled
              />
            </>
          )}
        </div>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}

function TaskCard({
  title,
  description,
  meta,
  disabled,
  busy,
  onClick,
}: {
  title: string;
  description: string;
  meta: string;
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  return (
    <article className={`card task-card ${disabled ? "disabled" : ""}`}>
      <span className="task-status">{disabled ? "Gesperrt" : "Bereit"}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      <small>{meta}</small>
      <button
        className={disabled ? "secondary" : "primary"}
        disabled={disabled || busy}
        onClick={onClick}
      >
        {disabled ? "Später verfügbar" : busy ? "Starten …" : "Aufgabe öffnen"}
      </button>
    </article>
  );
}

function FaceSetSelection({ onSubmit }: {
  onSubmit: (identity: "man" | "woman" | "nonbinary" | "self_described" | "prefer_not_to_say", preference?: "male" | "female" | "random") => Promise<void>;
}) {
  const [identity, setIdentity] = useState<"man" | "woman" | "nonbinary" | "self_described" | "prefer_not_to_say" | "">("");
  const [preference, setPreference] = useState<"male" | "female" | "random">("random");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsPreference = identity !== "" && identity !== "man" && identity !== "woman";
  const submit = async () => {
    if (!identity) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(identity, needsPreference ? preference : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <Centered><section className="card consent">
    <span className="eyebrow">Vorbereitung · eine kurze Frage</span>
    <h1>Wie beschreiben Sie Ihre Geschlechtsidentität?</h1>
    <p>Wir verwenden Ihre Antwort ausschließlich, um die passende Bildauswahl für diese Aufgabe festzulegen. Wenn Sie keine Angabe zu Ihrer Geschlechtsidentität machen möchten, wählen Sie bitte „Ich möchte dazu keine Angabe machen“. In diesem Fall können Sie anschließend eine Bildauswahl wählen oder eine zufällige Auswahl verwenden.</p>
    <div className="field">
      <label htmlFor="gender-identity">Bitte wählen Sie eine Antwort</label>
      <select id="gender-identity" value={identity} onChange={(event) => setIdentity(event.target.value as typeof identity)}>
        <option value="">Bitte auswählen</option>
        <option value="man">Mann</option>
        <option value="woman">Frau</option>
        <option value="nonbinary">Nicht-binär</option>
        <option value="self_described">Ich beschreibe mich anders</option>
        <option value="prefer_not_to_say">Ich möchte dazu keine Angabe machen</option>
      </select>
    </div>
    {needsPreference && <div className="field">
      <label htmlFor="face-set">Welche Bildauswahl möchten Sie sehen?</label>
      <select id="face-set" value={preference} onChange={(event) => setPreference(event.target.value as typeof preference)}>
        <option value="male">Männlich gelesene Gesichter</option>
        <option value="female">Weiblich gelesene Gesichter</option>
        <option value="random">Keine Präferenz (zufällige Auswahl)</option>
      </select>
    </div>}
    <button className="primary" disabled={!identity || busy} onClick={() => void submit()}>{busy ? "Wird gespeichert …" : "Weiter"}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </section></Centered>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}
