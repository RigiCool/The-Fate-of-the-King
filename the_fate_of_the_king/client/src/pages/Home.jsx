// src/pages/Home.jsx
import React, { useState } from "react";
import Card from "../components/Card";
import MetricBar from "../components/MetricBar";

function stringifyErrorPayload(payload) {
  if (!payload) return "Unknown error";
  if (typeof payload === "string") return payload;
  if (payload.details) return typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details);
  if (payload.error) return typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error);
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

async function readJsonSafe(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
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

      const payload = await readJsonSafe(res);

      if (!res.ok) {
        throw new Error(stringifyErrorPayload(payload) || `HTTP ${res.status}`);
      }

      setKing(payload);
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

      const payload = await readJsonSafe(res);

      if (!res.ok) {
        throw new Error(stringifyErrorPayload(payload) || `HTTP ${res.status}`);
      }

      setCard(payload);
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

      const payload = await readJsonSafe(res);

      if (!res.ok) {
        throw new Error(stringifyErrorPayload(payload) || `HTTP ${res.status}`);
      }

      setKing((prev) => ({ ...prev, metrics: payload }));
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

      {card && <Card {...card} onChoice={handleChoice} />}
    </div>
  );
}

export default Home;