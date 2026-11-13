import { useRef, useState } from "react";
import { api, EventQueue, type RunDto } from "../api";

type Phase = "intro" | "quiz" | "task" | "saving";

export function TrusteeStudy({
  run,
  onDone,
}: {
  run: RunDto;
  onDone: (code: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [investment, setInvestment] = useState(0);
  const [returns, setReturns] = useState<number[]>(Array(11).fill(0));
  const [quiz, setQuiz] = useState(["", ""]);
  const [error, setError] = useState("");
  const queue = useState(() => new EventQueue(run.id, run.lastSequence))[0];
  const decisionStart = useRef(performance.now());
  const inputChanges = useRef(0);

  const checkQuiz = () => {
    const correct = quiz[0] === "12" && quiz[1] === "kept";
    queue.add("comprehension_attempt", { responses: quiz, correct });
    if (!correct) {
      setError(
        "Mindestens eine Antwort war nicht richtig. Bitte lesen Sie die Erklärung noch einmal.",
      );
      return;
    }
    setError("");
    decisionStart.current = performance.now();
    setPhase("task");
  };

  const next = () => {
    queue.add(
      "trustee_decision",
      {
        investment,
        tripled: investment * 3,
        returned: returns[investment],
        rt_ms: performance.now() - decisionStart.current,
        input_changes: inputChanges.current,
      },
      `trustee-${investment}`,
    );
    decisionStart.current = performance.now();
    inputChanges.current = 0;
    if (investment < 10) setInvestment(investment + 1);
    else void finish();
  };

  const finish = async () => {
    setPhase("saving");
    setError("");
    try {
      await api.trusteePolicy(run.id, returns);
      await queue.drain();
      const complete = await api.complete(run.id, { decisions: 11 });
      onDone(
        `${complete.completionCode} · Bonus ${complete.bonusEur.toFixed(2)} €`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("task");
    }
  };

  if (phase === "intro")
    return (
      <StudyFrame>
        <section className="study-card">
          <span className="eyebrow">Normierungsstudie</span>
          <h1>Ihre Rückgabeentscheidungen</h1>
          <p>
            Stellen Sie sich vor, eine andere Person erhält in jeder Runde 10
            Punkte und kann Ihnen einen Teil davon anvertrauen. Der anvertraute
            Betrag wird verdreifacht. Sie entscheiden, wie viele dieser Punkte
            Sie zurückgeben.
          </p>
          <div className="worked-example">
            <strong>Beispiel</strong>
            <span>Die andere Person sendet 4 Punkte.</span>
            <span>
              Sie erhalten 12 Punkte und entscheiden, wie viele davon
              zurückgehen.
            </span>
          </div>
          <p>
            Nach Abschluss wird eine der zehn Entscheidungen mit einem positiven
            Einsatz zufällig ausgewählt. Die Punkte, die Sie in dieser
            Entscheidung behalten, bestimmen Ihren Bonus. Ihre aufgezeichneten
            Rückgaben können außerdem die Auszahlung einer später teilnehmenden
            Person beeinflussen. Ihre Entscheidungen haben damit reale
            finanzielle Folgen.
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
          <span className="eyebrow">Verständnisprüfung</span>
          <h1>Bitte prüfen Sie die Spielregeln.</h1>
          <label className="field">
            Wenn die andere Person 4 Punkte sendet, wie viele Punkte erhalten
            Sie?
            <select
              value={quiz[0]}
              onChange={(e) => setQuiz([e.target.value, quiz[1]])}
            >
              <option value="">Bitte wählen</option>
              <option value="4">4</option>
              <option value="8">8</option>
              <option value="12">12</option>
            </select>
          </label>
          <label className="field">
            Was bestimmt Ihren Bonus?
            <select
              value={quiz[1]}
              onChange={(e) => setQuiz([quiz[0], e.target.value])}
            >
              <option value="">Bitte wählen</option>
              <option value="sent">Der gesendete Betrag</option>
              <option value="kept">
                Die Punkte, die ich in der ausgelosten Entscheidung behalte
              </option>
              <option value="speed">Meine Antwortgeschwindigkeit</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={quiz.some((answer) => !answer)}
            onClick={checkQuiz}
          >
            Antworten prüfen
          </button>
          {error && (
            <>
              <p className="error">{error}</p>
              <button className="text-button" onClick={() => setPhase("intro")}>
                Erklärung erneut lesen
              </button>
            </>
          )}
        </section>
      </StudyFrame>
    );

  if (phase === "saving")
    return (
      <StudyFrame>
        <section className="study-card">
          <h1>Daten werden sicher übertragen …</h1>
        </section>
      </StudyFrame>
    );

  const max = investment * 3;
  return (
    <StudyFrame>
      <section className="study-card decision-card">
        <span className="trial-count">
          Entscheidung {investment + 1} von 11
        </span>
        <h2>
          Die andere Person sendet Ihnen <strong>{investment}</strong> Punkte.
        </h2>
        <div className="money-flow">
          <span>Verdreifacht</span>
          <strong>{max} Punkte</strong>
        </div>
        <label className="range-label">
          Wie viele Punkte geben Sie zurück?
          <output>{returns[investment]}</output>
          <input
            type="range"
            min="0"
            max={max}
            step="1"
            value={returns[investment]}
            onChange={(e) => {
              inputChanges.current += 1;
              setReturns(
                returns.map((value, index) =>
                  index === investment ? Number(e.target.value) : value,
                ),
              );
            }}
          />
        </label>
        <div className="split">
          <span>
            Sie behalten: <strong>{max - returns[investment]}</strong>
          </span>
          <span>
            Zurück: <strong>{returns[investment]}</strong>
          </span>
        </div>
        <button className="primary" onClick={next}>
          Entscheidung bestätigen
        </button>
        {error && <p className="error">{error}</p>}
      </section>
    </StudyFrame>
  );
}

function StudyFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="study-shell">
      <div className="study-top">
        <span>Entscheidungsstudie</span>
        <span>Pseudonyme Forschungsstudie</span>
      </div>
      {children}
    </main>
  );
}
