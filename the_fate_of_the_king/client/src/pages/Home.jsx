import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Card from "../components/Card";
import MetricBar from "../components/MetricBar";
import { useAuth } from "../auth/AuthContext";

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

export default function Home() {
  const { token, logout, user } = useAuth();
  const navigate = useNavigate();
  const { kingId } = useParams();

  const API = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  const authHeaders = useMemo(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const [king, setKing] = useState(null);
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [gameOver, setGameOver] = useState(false);

  useEffect(() => {
    if (!kingId) return;

    (async () => {
      setLoading(true);
      setError(null);
      setCard(null);

      try {
        const res = await fetch(`${API}/kings/${kingId}`, { headers: authHeaders });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const data = await res.json();
        setKing(data);
      } catch (e) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [kingId, API, authHeaders]);

  const startGame = async () => {
    setLoading(true);
    setError(null);
    setCard(null);

    try {
      const res = await fetch(`${API}/kings/start`, {
        method: "POST",
        headers: authHeaders,
      });

      if (!res.ok) throw new Error(await readErrorMessage(res));
      const data = await res.json();

      setKing(data);
      if (data?.id != null) navigate(`/play/${data.id}`, { replace: true });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const getCard = async () => {
    if (!king?.id) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API}/kings/${king.id}/get-card`, {
        method: "POST",
        headers: authHeaders,
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
    if (!king?.id || !card) return;

    setError(null);

    try {
      const res = await fetch(`${API}/kings/${king.id}/apply-choice`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          effects: choice.effects,
          choiceIndex,
          theme: card?.planner?.theme,
          card: {
            title: card.title,
            description: card.description,
            choices: card.choices,
            arc: card.arc,
          },
        }),
      });

      if (!res.ok) throw new Error(await readErrorMessage(res));
      const data = await res.json();

      setKing((prev) => ({ ...prev, metrics: data }));

      setGameOver(data?.gameOver || false);
      console.log("Game over?", gameOver, "Server said:", data);
      await getCard();
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const redirect = () => {
    setTimeout(() => {
      window.location.href = "/kings";
    }, 1200);
  };

  const metrics = king?.metrics;

  return (
    <div className="home">
      <div className="header">
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
          <h1 style={{ margin: 0 }}>The Fate of the King</h1>
          <h2 style={{ margin: 0 }}>Home</h2>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link className="nav-link active" to="/" style={{ opacity: 0.9 }}>Home</Link>
          <Link className="nav-link" to="/kings" style={{ opacity: 0.9 }}>Kings</Link>

          {user?.role === "admin" && (
            <Link className="nav-link" to="/admin/metrics" style={{ opacity: 0.9, marginLeft: 10 }}> Metrics </Link>
          )}

          <div className="profile-link">{user?.email ? user.email : "Logged in"}</div>
          <button className="btn" onClick={logout}>Logout</button>
        </div>
      </div>

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      {!king && (
        <button className="btn" onClick={startGame} disabled={loading} style={{ marginTop: 12 }}>
          {loading ? "Генерация..." : "Начать игру"}
        </button>
      )}

      {king && (
        <div className={`card ${card ? "king-title" : "king-card"}`} style={{ marginTop: 12 }}>
          <h2 className="king-name">{king.name}</h2>
          <p className="king-age">{king.age} years old</p>

          {metrics && card && (
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
              <button className="btn" onClick={getCard} disabled={loading}>
                {loading ? "Генерация события..." : "Начать испытания"}
              </button>
            </>
          )}
        </div>
      )}

      {card && (
        <>
          {card?.planner?.mode === "arc_resolution" && (
            <p style={{ opacity: 0.8 }}>📜 Arc resolution</p>
          )}
          <Card {...card} onChoice={gameOver ? redirect : handleChoice}/>
        </>
      )}
    </div>
  );
}