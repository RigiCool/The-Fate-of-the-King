import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api/client";

export default function History() {
  const { kingId } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await api.history(kingId);
        setData(r);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, [kingId]);

  return (
    <div style={{ maxWidth: 820, margin: "24px auto", padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h2>History</h2>
        <div style={{ display: "flex", gap: 12 }}>
          <Link to="/kings">Back</Link>
          <Link to={`/game/${kingId}`}>Continue</Link>
        </div>
      </div>

      {err && <div style={{ color: "crimson" }}>{err}</div>}

      {data && (
        <>
          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, marginTop: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {data.king.name} #{data.king.id}
            </div>
            <div style={{ opacity: 0.9, marginTop: 6, whiteSpace: "pre-wrap" }}>
              {data.king.description}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <h3>Arc outcomes</h3>
            {(data.arcOutcomes || []).map((x, i) => (
              <div key={i} style={{ padding: 10, border: "1px solid #eee", borderRadius: 10, marginTop: 8 }}>
                <div style={{ fontWeight: 600 }}>turn {x.turn}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{x.text}</div>
              </div>
            ))}
            {(data.arcOutcomes || []).length === 0 && <div style={{ opacity: 0.8 }}>No outcomes yet.</div>}
          </div>

          <div style={{ marginTop: 14 }}>
            <h3>Last events</h3>
            {(data.lastEvents || []).map((e, i) => (
              <div key={i} style={{ padding: 10, border: "1px solid #eee", borderRadius: 10, marginTop: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  turn {e.turn}: {e.title}
                </div>
                <div style={{ opacity: 0.9 }}>
                  Choice: {e.choiceText} (#{e.choiceIndex})
                </div>
              </div>
            ))}
            {(data.lastEvents || []).length === 0 && <div style={{ opacity: 0.8 }}>No events yet.</div>}
          </div>
        </>
      )}
    </div>
  );
}