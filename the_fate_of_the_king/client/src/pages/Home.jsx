import React, { useState } from "react";
import Card from "../components/Card";
import MetricBar from "../components/MetricBar";

async function readErrorMessage(res) {
  const text = await res.text().catch(() => "");
  if (!text) return `HTTP ${res.status}`;
  try {
    const obj = JSON.parse(text);
    return obj.details || obj.error?.message || obj.error || obj.message || JSON.stringify(obj);
  } catch {
    return text.slice(0, 600);
  }
}

function Home() {
  const [king, setKing] = useState(null);
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const startGame = async () => {
    setLoading(true);
    setError(null);
    setCard(null);

    try {
      const res = await fetch("http://localhost:3000/start-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) throw new Error(await readErrorMessage(res));
      const data = await res.json();

      setKing(data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const getCard = async () => {
    if (!king) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("http://localhost:3000/get-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kingId: king.id })
      });

      if (!res.ok) throw new Error(await readErrorMessage(res));
      const data = await res.json();

      setCard(data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleChoice = async (choice, choiceIndex) => {
    if (!king || !card) return;

    setError(null);

    try {
      const res = await fetch("http://localhost:3000/apply-choice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kingId: king.id,
          effects: choice.effects,
          choiceIndex,
          theme: card?.planner?.theme,
          card: {
            title: card.title,
            description: card.description,
            choices: card.choices,
            arc: card.arc
          }
        })
      });

      if (!res.ok) throw new Error(await readErrorMessage(res));
      const updatedMetrics = await res.json();

      setKing((prev) => ({ ...prev, metrics: updatedMetrics }));

      await getCard();
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const metrics = king?.metrics;

  return (
    <div className="home">
      <h1>The Fate of the King</h1>

      {!king && (
        <button onClick={startGame} disabled={loading}>
          {loading ? "Генерация..." : "Начать игру"}
        </button>
      )}

      {error && <p style={{ color: "red" }}>Ошибка: {error}</p>}

      {king && (
        <div className={`card ${card ? "king-title" : "king-card"}`}>
          <h2 className="king-name">{king.name}</h2>
          <p className="king-age">{king.age} years old</p>

          {metrics && (
            <div className="metrics">
              <div className="metric">⚔<MetricBar label="Army" value={metrics.army} /></div>
              <div className="metric">💰<MetricBar label="Economy" value={metrics.economy} /></div>
              <div className="metric">🕊<MetricBar label="Diplomacy" value={metrics.diplomacy} /></div>
              <div className="metric">👑<MetricBar label="Loyalty" value={metrics.loyalty} /></div>
            </div>
          )}

          {!card && (
            <>
              <p>{king.description}</p>
              <button onClick={getCard} disabled={loading}>
                {loading ? "Генерация события..." : "Начать испытания"}
              </button>
            </>
          )}
        </div>
      )}

      {card && (
        <>
          {card?.planner?.mode === "arc_resolution" && (
            <p style={{ opacity: 0.8 }}>📜 Развязка сюжетной арки</p>
          )}
          <Card {...card} onChoice={handleChoice} />
        </>
      )}
    </div>
  );
}

export default Home;