import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api/client";

function Game() {
  const { kingId } = useParams();

  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function fetchCard() {
    setErr("");
    setLoading(true);
    try {
      const data = await api.getCard(kingId);
      setCard(data);
    } catch (e) {
      setErr(e?.message || String(e));
    }
    setLoading(false);
  }

  useEffect(() => {

    fetchCard();

  }, [kingId]);

  async function handleChoice(choice, idx) {
    if (!card) return;

    setErr("");
    setBusy(true);

    try {

      await api.applyChoice(kingId, {
        effects: choice.effects,
        choiceIndex: idx,
        card,
        theme: card?.planner?.theme || "event",
      });

      await fetchCard();
    } catch (e) {
      setErr(e?.message || String(e));
    }

    setBusy(false);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <Link to="/kings">Back</Link>
        <Link to={`/history/${kingId}`}>History</Link>
        <span style={{ opacity: 0.7 }}>King #{kingId}</span>
      </div>

      {!card && (
        <button onClick={fetchCard} disabled={loading || busy}>
          Начать игру
        </button>
      )}

      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {loading && <p>Загрузка...</p>}

      {card && (
        <div className="card">
          <h2>
            {card.title} {card.turn != null ? <span> (ход {card.turn})</span> : null}
          </h2>

          <p style={{ whiteSpace: "pre-wrap" }}>{card.description}</p>

          {card.image ? (
            <div>
              <img src={card.image} alt="card" style={{ maxWidth: "100%" }} />
            </div>
          ) : null}

          <div>
            {card.choices.map((c, idx) => (
              <button
                key={idx}
                onClick={() => handleChoice(c, idx)}
                disabled={loading || busy}
              >
                {c.text}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Game;