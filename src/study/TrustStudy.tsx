import { useEffect, useMemo, useRef, useState } from "react";
import { initJsPsych } from "jspsych";
import "jspsych/css/jspsych.css";
import { api, EventQueue, type RunDto } from "../api";
import type { FaceId, PartnerProfile, TrustSchedule } from "../shared/protocol";
import { MessagePlugin, TrustTrialPlugin } from "./plugins";

const universityLogo = new URL("../../Uni_Logo (1).png", import.meta.url).href;
const scanUnitLogo = new URL("../../csm_logo_7135bba3da (1).jpg", import.meta.url).href;

const faceAssets = import.meta.glob(
  "../../2026-09-16_Trust_Game/stimuli_main/face_*.png",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
) as Record<string, string>;
const objectAssets = import.meta.glob(
  "../../2026-09-16_Trust_Game/stimuli_main/obj_*.png",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

type Phase =
  | "check"
  | "instructions"
  | "quiz"
  | "faceInstructions"
  | "faceDemo"
  | "objectInstructions"
  | "objectDemo"
  | "ratings"
  | "tutorial"
  | "experiment"
  | "post"
  | "saving";
type Ratings = Record<string, number>;

export function TrustStudy({
  run: initialRun,
  onDone,
  deferCompletion = false,
  workflowStepId,
}: {
  run: RunDto;
  onDone: (code: string) => void;
  deferCompletion?: boolean;
  workflowStepId?: string;
}) {
  const [run, setRun] = useState(initialRun);
  const [phase, setPhase] = useState<Phase>("check");
  const [quizAttempts, setQuizAttempts] = useState(0);
  const [quiz, setQuiz] = useState(["", "", "", "", ""]);
  const [error, setError] = useState("");
  const [ratings, setRatings] = useState<Ratings>({});
  const [postRatings, setPostRatings] = useState<Ratings>({});
  const [postRatingIndex, setPostRatingIndex] = useState(0);
  const [ratingIndex, setRatingIndex] = useState(0);
  const displayRef = useRef<HTMLDivElement>(null);
  const queue = useMemo(
    () => new EventQueue(run.id, run.lastSequence),
    [run.id],
  );
  const schedule = run.schedule as TrustSchedule;
  const urls = useMemo(() => faceUrls(schedule), [schedule]);

  const diagnostics = deviceDiagnostics();
  const deviceOk =
    diagnostics.width >= 900 &&
    diagnostics.height >= 600 &&
    diagnostics.keyboardLikely;

  const doDeviceCheck = async () => {
    setError("");
    try {
      await Promise.all(
        [...Object.values(urls), ...Object.values(objectUrls())].map(preload),
      );
      queue.add("device_check", diagnostics);
      setPhase("tutorial");
    } catch {
      setError(
        "Die Bilddateien konnten nicht vollständig geladen werden. Bitte prüfen Sie Ihre Verbindung.",
      );
    }
  };

  const checkQuiz = () => {
    const correct =
      quiz[0] === "direction" &&
      quiz[1] === "strength" &&
      quiz[2] === "4" &&
      quiz[3] === "feedback" &&
      quiz[4] === "learning";
    queue.add("comprehension_attempt", {
      attempt: quizAttempts + 1,
      responses: quiz,
      correct,
    });
    if (correct) {
      setError("");
      setRatingIndex(0);
      setPhase("ratings");
      return;
    }
    const attempts = quizAttempts + 1;
    setQuizAttempts(attempts);
    if (attempts >= 3)
      setError(
        "Die Aufgabe wurde noch nicht ausreichend verstanden. Der Forschungsdurchlauf wird nicht gestartet. Bitte kontaktieren Sie das Studienteam; Ihre Grundvergütung bleibt davon unberührt.",
      );
    else
      setError(
        "Mindestens eine Antwort war nicht korrekt. Lesen Sie die Erklärung bitte erneut und versuchen Sie es noch einmal.",
      );
  };

  const startExperiment = async () => {
    setError("");
    setPhase("experiment");
    const refreshed = await api.currentRun();
    setRun(refreshed);
    await api.startRun(run.id);
    queue.add("baseline_ratings", {
      ratings,
      faceSet: schedule.faceSet,
      faceByProfile: schedule.faceByProfile,
    });
    window.setTimeout(() => void launchJsPsych(refreshed), 0);
  };

  const beginMainTask = async () => {
    setPhase("experiment");
    const refreshed = await api.currentRun();
    setRun(refreshed);
    await api.startRun(refreshed.id);
    queue.add("baseline_ratings", {
      ratings,
      faceSet: schedule.faceSet,
      faceByProfile: schedule.faceByProfile,
    });
    window.setTimeout(() => void launchJsPsych(refreshed), 0);
  };

  const launchJsPsych = async (current: RunDto) => {
    if (!displayRef.current) return;
    const completed = new Set([
      ...(current.completedTrialIds ?? []),
      ...queue.pendingTrialIds(),
    ]);
    let omissions = 0;
    let interactions = 0;
    const jsPsych = initJsPsych({
      display_element: displayRef.current,
      on_data_update(data: Record<string, any>) {
        if (data.domain === "trust" || data.domain === "risk") {
          if (data.omitted) omissions += 1;
          queue.add(
            "trial_complete",
            data as Record<string, unknown>,
            String(data.trial_id),
          );
        }
      },
      on_interaction_data_update(data: Record<string, any>) {
        interactions += 1;
        queue.add(
          "browser_interaction",
          data as unknown as Record<string, unknown>,
        );
      },
      on_finish() {
        queue.add("task_runtime_complete", { omissions, interactions });
        setPhase("post");
      },
    });
    const timeline: any[] = [];
    timeline.push({
      type: MessagePlugin,
      html: `<p class="phase-label">Trust Game</p><h1>Die Aufgabe beginnt</h1><p>Sie sehen nun nacheinander verschiedene Gesichter und Objekte.</p><p>Bewegen Sie den Marker mit <kbd>←</kbd> und <kbd>→</kbd>. Der Marker wird nach vier Sekunden automatisch gespeichert.</p><p>Bitte bleiben Sie während der Aufgabe aufmerksam und lassen Sie dieses Fenster geöffnet.</p>`,
      button: "Aufgabe starten",
    });
    for (let block = 1; block <= 6; block += 1) {
      const specs = schedule.trustTrials.filter(
        (spec) => spec.block === block && !completed.has(spec.trialId),
      );
      timeline.push(
        ...specs.map((spec) => ({
          type: TrustTrialPlugin,
          spec,
          faceUrls: urls,
          stimulusUrls: objectUrls(),
          resolveOutcome: (
            trialId: string,
            profile: string,
            investment: number,
            chosenSide?: string,
          ) => api.outcome(run.id, trialId, profile, investment, chosenSide),
        })),
      );
      if (block < 6 && specs.length)
        timeline.push({
          type: MessagePlugin,
          html: `<p class="phase-label">Kurze Pause</p><h1>Sie haben Block ${block} von 6 abgeschlossen.</h1><p>Machen Sie kurz Pause, ohne das Browserfenster zu schließen. Wenn Sie bereit sind, setzen Sie die Aufgabe fort.</p>`,
          button: "Weiter",
        });
    }
    try {
      await jsPsych.run(timeline);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("post");
    }
  };

  const finish = async () => {
    setPhase("saving");
    setError("");
    queue.add("post_task_ratings", { ratings: postRatings });
    try {
      await queue.drain();
      if (deferCompletion && workflowStepId) {
        await api.workflowStep(run.id, workflowStepId, "completed", {
          postRatingsCompleted: true,
          quizAttempts: quizAttempts + 1,
        });
        onDone("");
        return;
      }
      const result = await api.complete(run.id, {
        quizAttempts: quizAttempts + 1,
        postRatingsCompleted: true,
      });
      onDone(
        `${result.completionCode} · Bonus ${result.bonusEur.toFixed(2)} €`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("post");
    }
  };

  if (phase === "check")
    return (
      <StudyFrame>
        <section className="study-card">
          <span className="eyebrow">Technik-Check</span>
          <h1>Bevor es losgeht</h1>
          <ul className="requirements">
            <li className={deviceOk ? "ok" : "bad"}>
              einen Computer oder Laptop mit mindestens 900 × 600 Pixeln
            </li>
            <li className={diagnostics.keyboardLikely ? "ok" : "bad"}>
              eine physische Tastatur
            </li>
            <li>eine stabile Internetverbindung</li>
            <li>einen ruhigen Ort für ungefähr 30 Minuten</li>
          </ul>
          <p>
            Bitte wechseln Sie während der Aufgabe nicht in andere Fenster oder
            Tabs.
          </p>
          <button
            className="primary"
            disabled={!deviceOk}
            onClick={() => void doDeviceCheck()}
          >
            Technik-Check abschließen
          </button>
          {!deviceOk && (
            <p className="error">
              Bitte verwenden Sie einen Computer oder Laptop mit physischer
              Tastatur und vergrößern Sie das Fenster.
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </StudyFrame>
    );
  if (phase === "instructions")
    return (
      <StudyFrame>
        <section className="study-card instructions">
          <OnboardingProgress step={3} />
          <span className="eyebrow">Aufgabenerklärung</span>
          <h1>So bearbeiten Sie die Aufgaben</h1>
          {run.outcomeBankVersion?.startsWith("development") && (
            <p className="dev-warning">
              Entwicklungsmodus: Diese lokale Testversion verwendet simulierte
              Rückgaben und darf nicht zur Datenerhebung eingesetzt werden.
            </p>
          )}
          <p>In jedem Trial sehen Sie entweder zwei Personen oder zwei Objekte.</p>
          <ul className="instruction-summary-list">
            <li>Die Richtung des Markers wählt die linke oder rechte Option.</li>
            <li>Die Entfernung von der Mitte bestimmt die Stärke Ihrer Entscheidung.</li>
            <li>In Gesichter-Trials bestimmt die Entfernung den Investitionsbetrag.</li>
            <li>In Objekt-Trials zeigt die Entfernung, wie sicher Sie sich bei Ihrer Zuordnung sind.</li>
            <li>Der Marker wird nach vier Sekunden automatisch gespeichert.</li>
            <li>Sie müssen keine zusätzliche Taste drücken.</li>
          </ul>
          <p>
            Nach Gesichter-Trials sehen Sie eine Rückmeldung über Ihr Ergebnis.
            Bei Objekt-Trials nutzen Sie die Rückmeldung, um die Zuordnung
            zwischen Fakten und Objekten zu lernen.
          </p>
          <button className="primary" onClick={() => setPhase("quiz")}>
            Verständnisfragen
          </button>
        </section>
      </StudyFrame>
    );
  if (phase === "quiz")
    return (
      <StudyFrame>
        <section className="study-card">
          <OnboardingProgress step={3} />
          <span className="eyebrow">
            Verständnisprüfung · Versuch {quizAttempts + 1} von 3
          </span>
          <h1>Bitte beantworten Sie die folgenden Fragen.</h1>
          <QuizSelect
            label="Was bestimmt die Richtung Ihrer Entscheidung?"
            value={quiz[0]}
            onChange={(v) => setQuiz([v, quiz[1], quiz[2], quiz[3], quiz[4]])}
            options={[
              ["", "Bitte wählen"],
              ["direction", "Sie wählen damit die linke oder rechte Option"],
              ["amount", "Sie bestimmen damit nur die Zeit"],
              ["none", "Die Richtung spielt keine Rolle"],
            ]}
          />
          <QuizSelect
            label="Was bestimmt die Entfernung von der Mitte?"
            value={quiz[1]}
            onChange={(v) => setQuiz([quiz[0], v, quiz[2], quiz[3], quiz[4]])}
            options={[
              ["", "Bitte wählen"],
              ["strength", "Die Stärke Ihrer Entscheidung"],
              ["time", "Nur die verbleibende Zeit"],
              ["nothing", "Nichts"],
            ]}
          />
          <QuizSelect
            label="Wie lange dauert die Antwortphase eines Trials?"
            value={quiz[2]}
            onChange={(v) => setQuiz([quiz[0], quiz[1], v, quiz[3], quiz[4]])}
            options={[
              ["", "Bitte wählen"],
              ["2", "2 Sekunden"],
              ["4", "4 Sekunden"],
              ["10", "10 Sekunden"],
            ]}
          />
          <QuizSelect
            label="Was geschieht nach einem Gesichter-Trial?"
            value={quiz[3]}
            onChange={(v) => setQuiz([quiz[0], quiz[1], quiz[2], v, quiz[4]])}
            options={[
              ["", "Bitte wählen"],
              ["feedback", "Sie sehen eine Rückmeldung über Ihr Ergebnis"],
              ["nothing", "Es geschieht nichts weiter"],
              ["correctness", "Sie erhalten die richtige Antwort"],
            ]}
          />
          <QuizSelect
            label="Was sollen Sie aus den Objekt-Trials lernen?"
            value={quiz[4]}
            onChange={(v) => setQuiz([quiz[0], quiz[1], quiz[2], quiz[3], v])}
            options={[
              ["", "Bitte wählen"],
              ["learning", "Welche Fakten zu welchen Objekten passen"],
              ["money", "Wie viel Geld Sie investieren sollten"],
              ["faces", "Welche Person vertrauenswürdig ist"],
            ]}
          />
          <button
            className="primary"
            disabled={quiz.some((v) => !v) || quizAttempts >= 3}
            onClick={checkQuiz}
          >
            Antworten prüfen
          </button>
          {error && <p className="error">{error}</p>}
          {quizAttempts < 3 && error && (
            <button
              className="text-button"
              onClick={() => setPhase("instructions")}
            >
              Erklärung erneut lesen
            </button>
          )}
        </section>
      </StudyFrame>
    );
  if (phase === "faceInstructions")
    return (
      <StudyFrame>
        <section className="study-card instructions">
          <OnboardingProgress step={1} />
          <span className="eyebrow">Zwei Trialtypen · 1 von 2</span>
          <h1>Gesichter: Ihre Investitionsentscheidung</h1>
          <p>
            In diesen Trials sehen Sie zwei Personen. Ihre Aufgabe ist, zu
            entscheiden, welcher Person Sie Geld anvertrauen möchten und wie
            viel.
          </p>
          <div className="instruction-detail">
            <ol>
              <li>Ein kurzer Punkt in der Mitte kündigt den nächsten Trial an.</li>
              <li>Danach erscheinen zwei Personen links und rechts.</li>
              <li>
                Die Richtung des Reglers wählt die Person. Je weiter der Marker
                von der Mitte entfernt ist, desto größer ist Ihr Einsatz – bis
                maximal 1,00 EUR.
              </li>
              <li>
                Der Einsatz wird verdreifacht. Danach sehen Sie, wie viel die
                andere Person zurückgibt und ob Sie in dieser Runde gewonnen oder
                verloren haben.
              </li>
            </ol>
          </div>
          <p>Jetzt folgt ein ungetimter Beispiel-Trial, den Sie in Ruhe ausprobieren können.</p>
          <button autoFocus className="primary" onClick={() => setPhase("faceDemo")}>
            Beispiel-Trial ansehen
          </button>
        </section>
      </StudyFrame>
    );
  if (phase === "faceDemo")
    return (
      <DemoTrial
        kind="face"
        faceUrls={urls}
        stimulusUrls={objectUrls()}
        onContinue={() => setPhase("objectInstructions")}
      />
    );
  if (phase === "objectInstructions")
    return (
      <StudyFrame>
        <section className="study-card instructions">
          <OnboardingProgress step={2} />
          <span className="eyebrow">Zwei Trialtypen · 2 von 2</span>
          <h1>Objekte: Eine Information zuordnen</h1>
          <p>
            Die Objekt-Trials gehören zur selben Studie, unterscheiden sich aber
            von den Gesichter-Trials. Hier sehen Sie zwei Objekte und eine
            konkrete Information.
          </p>
          <p>
            Zu Beginn wissen Sie noch nicht, zu welchem Objekt die jeweilige
            Information gehört. Achten Sie deshalb auf die Rückmeldungen und
            lernen Sie im Verlauf der Aufgabe, welche Fakten zu welchen Objekten
            passen.
          </p>
          <div className="instruction-detail">
            <ol>
              <li>Lesen Sie die angezeigte Information aufmerksam.</li>
              <li>
                Bewegen Sie den Regler zu dem Objekt, auf das die Information
                zutrifft.
              </li>
              <li>
                Auch hier wählt die Richtung die Seite; die Entfernung von der
                Mitte zeigt, wie sicher Sie sich bei Ihrer Zuordnung sind.
              </li>
              <li>
                Bei diesen Trials geht es nicht um Vertrauen. Entscheiden Sie
                sich trotzdem in jeder Runde für eine Seite.
              </li>
            </ol>
          </div>
          <p>Probieren Sie nun einen ungetimten Objekt-Trial aus.</p>
          <button autoFocus className="primary" onClick={() => setPhase("objectDemo")}>
            Objekt-Beispiel ansehen
          </button>
        </section>
      </StudyFrame>
    );
  if (phase === "objectDemo")
    return (
      <DemoTrial
        kind="object"
        faceUrls={urls}
        stimulusUrls={objectUrls()}
        onContinue={() => {
          setPhase("instructions");
        }}
      />
    );
  if (phase === "ratings")
    return (
      <StudyFrame>
        <section className="study-card">
          <OnboardingProgress step={4} />
          <span className="eyebrow">
            Erster Eindruck · {ratingIndex + 1} von 3
          </span>
          <h1>Beurteilen Sie nun, wie vertrauenswürdig diese Person auf Sie wirkt.</h1>
          <p>
            Es gibt keine richtige oder falsche Antwort. Verwenden Sie die
            gesamte Skala und wählen Sie die Position, die Ihrem persönlichen
            Eindruck am besten entspricht.
          </p>
          {(() => {
            const faces = Object.entries(schedule.faceByProfile) as Array<
              [PartnerProfile, FaceId]
            >;
            const [profile, face] = faces[ratingIndex];
            return (
              <Rating
                image={urls[profile]}
                value={ratings[face] ?? 50}
                onChange={(value) => setRatings({ ...ratings, [face]: value })}
                onConfirm={() => {
                  if (ratingIndex < 2) setRatingIndex(ratingIndex + 1);
                  else void beginMainTask();
                }}
              />
            );
          })()}
          <button
            className="primary"
            onClick={() => {
              if (ratingIndex < 2) setRatingIndex(ratingIndex + 1);
              else void beginMainTask();
            }}
          >
            {ratingIndex < 2 ? "Nächste Person" : "Weiter zum Experiment"}
          </button>
        </section>
      </StudyFrame>
    );
  if (phase === "tutorial")
    return <SliderTutorial onDone={() => setPhase("faceInstructions")} />;
  if (phase === "experiment")
    return (
      <main className="experiment-host">
        <div className="experiment-progress">
          Trust Game · Bitte lassen Sie dieses Fenster geöffnet
        </div>
        <div ref={displayRef} />
      </main>
    );
  if (phase === "saving")
    return (
      <StudyFrame>
        <section className="study-card">
          <h1>Ihre Antworten werden gespeichert</h1>
          <p>Bitte schließen Sie dieses Fenster nicht. Ihre Daten werden sicher übertragen.</p>
        </section>
      </StudyFrame>
    );
  return (
    <StudyFrame>
      <section className="study-card">
        <span className="eyebrow">
          {postRatingIndex < 3 ? "Einschätzung nach der Aufgabe" : "Abschlussfragen"}
        </span>
        <h1>Einschätzung nach der Aufgabe</h1>
        {postRatingIndex < 3 ? (
          <>
            <p>Wie vertrauenswürdig war diese Person im Verlauf der Aufgabe?</p>
            {(() => {
              const [profile] = Object.entries(schedule.faceByProfile)[postRatingIndex];
              return (
                <Rating
                  image={urls[profile]}
                  value={postRatings[profile] ?? 50}
                  onChange={(value) => setPostRatings({ ...postRatings, [profile]: value })}
                  onConfirm={() => setPostRatingIndex((index) => index + 1)}
                />
              );
            })()}
            <button className="primary" autoFocus onClick={() => setPostRatingIndex((index) => index + 1)}>
              {postRatingIndex < 2 ? "Nächste Person" : "Weiter"}
            </button>
          </>
        ) : (
          <>
            <h1>Fast geschafft</h1>
            <p>Beantworten Sie bitte noch die folgenden Abschlussfragen.</p>
            <label className="field">
              Welche Strategie haben Sie während der Aufgabe verwendet?
              <textarea
                autoFocus
                onBlur={(e) =>
                  queue.add("strategy_report", { text: e.target.value.slice(0, 1000) })
                }
                maxLength={1000}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                onChange={(e) => queue.add("seriousness_check", { serious: e.target.checked })}
              />
              Ich habe die Aufgabe ernsthaft und aufmerksam bearbeitet.
            </label>
            <button className="primary" onClick={() => void finish()}>
              Antworten speichern und Studie abschließen
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </StudyFrame>
  );
}

function faceUrls(schedule: TrustSchedule) {
  return Object.fromEntries(
    (
      Object.entries(schedule.faceByProfile) as Array<[PartnerProfile, FaceId]>
    ).map(([profile, face]) => {
      const needle = `${face}_${schedule.faceSet}.png`;
      const url = Object.entries(faceAssets).find(([path]) =>
        path.endsWith(needle),
      )?.[1];
      if (!url) throw new Error(`Missing face asset ${needle}`);
      return [profile, url];
    }),
  );
}
function preload(url: string) {
  return new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });
}
function objectUrls() {
  return Object.fromEntries(
    Object.entries(objectAssets).map(([key, value]) => [
      key.split("/").pop()?.replace(".png", ""),
      value,
    ]),
  ) as Record<string, string>;
}
function DemoTrial({
  kind,
  faceUrls,
  stimulusUrls,
  onContinue,
}: {
  kind: "face" | "object";
  faceUrls: Record<string, string>;
  stimulusUrls: Record<string, string>;
  onContinue: () => void;
}) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setValue((current) =>
        Math.max(-1, Math.min(1, current + (event.key === "ArrowLeft" ? -0.03 : 0.03))),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const side = value < -0.02 ? "links" : value > 0.02 ? "rechts" : "keine Seite";
  const sideLabel = value < -0.02 ? "linke" : value > 0.02 ? "rechte" : "keine";
  const certainty = Math.abs(value) < 0.2 ? "noch keine klare Entscheidung" : Math.abs(value) < 0.6 ? "eine eher vorsichtige Entscheidung" : "eine sehr entschiedene Auswahl";
  const faces = Object.values(faceUrls);
  const objects = [stimulusUrls.obj_01, stimulusUrls.obj_02].filter(Boolean);
  return (
    <StudyFrame>
      <section className="study-card demo-card">
        <OnboardingProgress step={kind === "face" ? 1 : 2} />
        <span className="eyebrow">Beispiel-Trial · ohne Zeitlimit</span>
        <h1>{kind === "face" ? "Gesichter-Trial ausprobieren" : "Objekt-Trial ausprobieren"}</h1>
        {kind === "face" ? (
          <>
            <p>Dies ist ein ungetimtes Beispiel. Sie können den Marker beliebig oft bewegen.</p>
            <p>
              Mit <kbd>←</kbd> wählen Sie die linke Person. Mit <kbd>→</kbd>
              wählen Sie die rechte Person.
            </p>
            <p>
              Die Entfernung von der Mitte bestimmt den Betrag, den Sie
              investieren würden. Dieses Beispiel wird nicht als Studiendaten
              gespeichert.
            </p>
          </>
        ) : (
          <>
            <p>
              Dies ist ein ungetimtes Beispiel. Lesen Sie die Information und
              bewegen Sie den Marker zu dem Objekt, auf das sie Ihrer Meinung
              nach zutrifft.
            </p>
            <p>
              Sie können den Marker beliebig oft verändern. Dieses Beispiel wird
              nicht als Studiendaten gespeichert.
            </p>
          </>
        )}
        <div className="demo-stimuli">
          {(kind === "face" ? faces.slice(0, 2) : objects).map((src, index) => (
            <div className="demo-stimulus" key={src ?? index}>
              {src && <img src={src} alt={kind === "face" ? `Beispielperson ${index + 1}` : `Beispielobjekt ${index + 1}`} />}
              <span>{index === 0 ? "Linke Option" : "Rechte Option"}</span>
            </div>
          ))}
        </div>
        <p className="demo-prompt">
          {kind === "face" ? "Wem möchten Sie einen Betrag anvertrauen?" : "Welches Objekt ist aus Glas?"}
          {kind === "object" && <strong>Information: Ist aus Glas. Diese Information trifft auf eines der beiden Objekte zu.</strong>}
        </p>
        <div className="demo-slider-wrap">
          <div className="slider-track online-slider demo-slider-track" />
          <div className="demo-marker" style={{ left: `${(value + 1) * 50}%` }} />
        </div>
        <div className="demo-live-explanation" aria-live="polite">
          {side === "keine Seite" ? "Der Marker steht in der Mitte: Es ist noch keine Seite ausgewählt." : `Sie entscheiden sich für die ${sideLabel} Option.`}
          <br />
          {kind === "face" ? `Die Entfernung von der Mitte zeigt ${certainty} und bestimmt den investierten Betrag.` : `Die Entfernung von der Mitte zeigt, dass dies ${certainty} ist.`}
        </div>
        <button autoFocus className="primary" onClick={onContinue}>
          {kind === "face" ? "Weiter zur Objekt-Erklärung" : "Beispiele verstanden – weiter"}
        </button>
      </section>
    </StudyFrame>
  );
}
function SliderTutorial({ onDone }: { onDone: () => void }) {
  const zones = useMemo(() => [-0.75, -0.25, 0.25, 0.75], []);
  const [index, setIndex] = useState(0);
  const [value, setValue] = useState(0);
  const [timeLeft, setTimeLeft] = useState(1);
  const [message, setMessage] = useState(
    "In dieser Online-Aufgabe geben Sie Ihre Antworten mit einem Schieberegler ab.",
  );
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!started) return;
    const startedAt = performance.now();
    let animation = 0;
    let held: string | null = null;
    const down = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        held = e.key;
        setValue((v) =>
          Math.max(-1, Math.min(1, v + (e.key === "ArrowLeft" ? -0.02 : 0.02))),
        );
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === held) held = null;
    };
    const timer = window.setInterval(() => {
      if (held)
        setValue((v) =>
          Math.max(-1, Math.min(1, v + (held === "ArrowLeft" ? -0.01 : 0.01))),
        );
    }, 16);
    const deadline = window.setTimeout(() => {
      setStarted(false);
      setValue((current) => {
        if (current >= zone - 0.25 && current <= zone + 0.25) {
          setIndex((i) => i + 1);
          setMessage("Gut gemacht. Die nächste Übung beginnt gleich.");
          return 0;
        }
        setMessage(
          "Der Marker war beim Ablauf der Zeit noch nicht im Zielbereich. Versuchen Sie es erneut.",
        );
        return 0;
      });
    }, 4000);
    const animate = (now: number) => {
      setTimeLeft(Math.max(0, 1 - (now - startedAt) / 4000));
      if (now - startedAt < 4000) animation = requestAnimationFrame(animate);
    };
    animation = requestAnimationFrame(animate);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(deadline);
      cancelAnimationFrame(animation);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [started]);
  useEffect(() => {
    if (index >= zones.length) onDone();
  }, [index, zones.length, onDone]);
  const zone = zones[Math.min(index, zones.length - 1)];
  if (index >= zones.length) return null;
  return (
    <StudyFrame>
      <section className="study-card tutorial-card">
        <OnboardingProgress step={0} />
        <span className="eyebrow">Slider-Übung · {index + 1} von 4</span>
        <h1>{index === 0 ? "So funktioniert der Schieberegler" : "Üben Sie die Bedienung"}</h1>
        <p>{message}</p>
        {index === 0 && !started && (
          <div className="tutorial-orientation">
            <div>
              <strong>Der schwarze Marker beginnt in der Mitte.</strong>
              <p>
                Halten Sie <kbd>←</kbd> oder <kbd>→</kbd> gedrückt, um den
                Marker zu bewegen. Die Richtung zeigt, für welche Seite Sie
                sich entscheiden. Je weiter der Marker von der Mitte entfernt
                ist, desto stärker beziehungsweise sicherer ist Ihre
                Entscheidung. Bleibt der Marker in der Mitte, wurde keine Seite
                ausgewählt.
              </p>
            </div>
            <div className="tutorial-clock-explanation">
              <div
                className="circular-timer"
                aria-label="Beispiel für den Zeitkreis"
                style={{ "--timer-progress": 1 } as React.CSSProperties}
              >
                <span>4 s</span>
              </div>
              <p>Während einer Aufgabe zeigt der Kreis die verbleibende Zeit. Wenn die Zeit abgelaufen ist, wird die aktuelle Position automatisch gespeichert.</p>
            </div>
          </div>
        )}
        <div className="tutorial-track">
          {zones.map((target, targetIndex) => (
            <i
              key={target}
              className={`tutorial-zone ${targetIndex === index ? "active" : ""}`}
              aria-label={`Übungsbereich ${targetIndex + 1} von ${zones.length}`}
              style={{ left: `${(target + 1) * 50}%` }}
            />
          ))}
          <b
            className="tutorial-marker"
            style={{ left: `${(value + 1) * 50}%` }}
          />
        </div>
        <div className="tutorial-zone-labels" aria-hidden="true">
          <span>links · weit</span>
          <span>links · nahe Mitte</span>
          <span>rechts · nahe Mitte</span>
          <span>rechts · weit</span>
        </div>
        <div
          className="circular-timer"
          aria-label="Verbleibende Zeit"
          style={{ "--timer-progress": timeLeft } as React.CSSProperties}
        >
          <span>{Math.ceil(timeLeft * 4)} s</span>
        </div>
        {!started && (
          <button
            autoFocus
            className="primary"
            onClick={() => {
              setStarted(true);
              setMessage(
                "Bewegen Sie den Marker innerhalb von vier Sekunden in den grauen Zielbereich. Sie müssen dort nicht für die gesamte Zeit bleiben. Entscheidend ist, dass sich der Marker beim Ablauf der Zeit im Zielbereich befindet.",
              );
            }}
          >
            {index === 0
              ? "Übung starten"
              : "Nächste Übung starten"}
          </button>
        )}
      </section>
    </StudyFrame>
  );
}
function deviceDiagnostics(): Record<string, any> {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }>; platform?: string };
  };
  return {
    browser:
      nav.userAgentData?.brands?.map((b) => b.brand).join(",") ??
      navigator.userAgent.split(" ").slice(-2).join(" "),
    platform: nav.userAgentData?.platform ?? navigator.platform,
    width: innerWidth,
    height: innerHeight,
    pixelRatio: devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
    keyboardLikely: !/Android|iPhone|iPad/i.test(navigator.userAgent),
  };
}
function StudyFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="study-shell">
      <div className="study-top">
        <div className="study-brand-logos">
          <img src={universityLogo} alt="Universität Wien" />
          <img src={scanUnitLogo} alt="SCAN Unit" />
        </div>
        <span>Trust Game · Pseudonyme Forschungsstudie</span>
      </div>
      {children}
    </main>
  );
}
function OnboardingProgress({ step }: { step: number }) {
  const stages = [
    "Slider",
    "Gesichter",
    "Objekte",
    "Zusammenfassung",
    "Einschätzungen",
    "Experiment",
  ];
  return (
    <nav className="onboarding-progress" aria-label="Fortschritt der Einführung">
      {stages.map((stage, index) => (
        <span key={stage} className={index === step ? "active" : index < step ? "complete" : ""}>
          <i>{index < step ? "✓" : index + 1}</i>
          {stage}
        </span>
      ))}
    </nav>
  );
}
function QuizSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[][];
}) {
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
function Rating({
  image,
  value,
  onChange,
  onConfirm,
}: {
  image: string;
  value: number;
  onChange: (value: number) => void;
  onConfirm?: () => void;
}) {
  return (
    <div className="rating">
      <img src={image} alt="Partnerprofil" />
      <label>
        gar nicht vertrauenswürdig{" "}
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          autoFocus
          aria-label="Vertrauenswürdigkeit von 0 bis 100"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm?.();
            }
          }}
          onChange={(e) => onChange(Number(e.target.value))}
        />{" "}
        sehr vertrauenswürdig <output>{value}</output>
      </label>
    </div>
  );
}
