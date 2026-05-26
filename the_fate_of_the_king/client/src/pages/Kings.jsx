import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

export default function Kings() {
  const { token, logout, user } = useAuth();
  const navigate = useNavigate();

  const API = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  const authHeaders = useMemo(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const [kings, setKings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function loadKings() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/kings`, { headers: authHeaders });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const data = await res.json();
      const arr = Array.isArray(data?.kings) ? data.kings : [];
      setKings(arr.filter(Boolean));
    } catch (e) {
      setError(e?.message || String(e));
      setKings([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadKings();
  }, []);
  console.log(kings);
  const resume = (kingId) => {
    if (!kingId) return;
    navigate(`/play/${kingId}`);
  };

  return (
    <div className="home">
      <div className="header">
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
          <h1 style={{ margin: 0 }}>The Fate of the King</h1>
          <h2 style={{ margin: 0 }}>Kings</h2>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link className="nav-link" to="/" style={{ opacity: 0.9 }}>Home</Link>
          <Link className="nav-link active" to="/kings" style={{ opacity: 0.9 }}>Kings</Link>

          {user?.role === "admin" && (
            <Link className="nav-link" to="/admin/metrics" style={{ opacity: 0.9, marginLeft: 10 }}> Metrics </Link>
          )}
          
          <div className="profile-link">{user?.email ? user.email : "Logged in"}</div>
          <button className="btn" onClick={logout}>Logout</button>
        </div>
      </div>



      <div className="king-list">
        <div className="king-refresh-btn">
          <button className="btn" onClick={loadKings} disabled={loading}>
            {loading ? "Loading..." : "Refresh list"}
          </button>
        </div>

        {error && <p style={{ color: "red" }}>Ошибка: {error}</p>}
        {loading && <p>Loading kings…</p>}

        {!loading && kings.length === 0 && (
          <p style={{ opacity: 0.85 }}>
            There are no saved kings yet. Create a new one on this page. <b>Home</b>.
          </p>
        )}

        {!loading && kings.length > 0 && (
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {kings.map((k, idx) => {
              const id = k?.kingId;
              const key = id != null ? `king-${id}` : `king-idx-${idx}`;

              return (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    padding: 8,
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {k?.name || (id ? `King #${id}` : "King")}
                    </div>
                    <div style={{ opacity: 0.8, fontSize: 13 }}>
                      id: {id ?? "—"}
                      {Number.isFinite(k?.turn) ? ` • turn ${k.turn}` : ""}
                      {k?.activeArc?.title ? ` • arc: ${k.activeArc.title}` : ""}
                    </div>
                  </div>

                  {id && !k?.reign_ended ? (
                    <button className="btn" onClick={() => resume(id)} title="Resume">
                      Resume
                    </button>
                  ) : (
                    <span style={{ color: "orange", fontSize: 12, paddingRight: 15 }}>Reign ended</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
