import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

export default function AdminMetrics() {
  const [kingId, setKingId] = useState("");
  const [army, setArmy] = useState("");
  const [economy, setEconomy] = useState("");
  const [diplomacy, setDiplomacy] = useState("");
  const [loyalty, setLoyalty] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function apply() {
    setErr(""); setMsg("");
    const id = Number(kingId);
    if (!Number.isFinite(id)) { setErr("Bad kingId"); return; }

    const patch = {};
    if (army !== "") patch.army = Number(army);
    if (economy !== "") patch.economy = Number(economy);
    if (diplomacy !== "") patch.diplomacy = Number(diplomacy);
    if (loyalty !== "") patch.loyalty = Number(loyalty);

    try {
      const r = await api.adminSetMetrics(id, patch);
      setMsg(`OK: ${JSON.stringify(r.metrics)}`);
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: "24px auto", padding: 12 }}>
      <div style={{ display:"flex", justifyContent:"space-between" }}>
        <h2>Admin: Metrics</h2>
        <Link to="/kings">Back</Link>
      </div>

      <div style={{ marginTop: 12 }}>
        <div>
          <label>kingId</label>
          <input value={kingId} onChange={(e)=>setKingId(e.target.value)} style={{ width:"100%" }} />
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap: 10, marginTop: 10 }}>
          <div><label>army</label><input value={army} onChange={(e)=>setArmy(e.target.value)} style={{ width:"100%" }} /></div>
          <div><label>economy</label><input value={economy} onChange={(e)=>setEconomy(e.target.value)} style={{ width:"100%" }} /></div>
          <div><label>diplomacy</label><input value={diplomacy} onChange={(e)=>setDiplomacy(e.target.value)} style={{ width:"100%" }} /></div>
          <div><label>loyalty</label><input value={loyalty} onChange={(e)=>setLoyalty(e.target.value)} style={{ width:"100%" }} /></div>
        </div>

        <button onClick={apply} style={{ marginTop: 12 }}>Apply</button>

        {err && <div style={{ color:"crimson", marginTop: 10 }}>{err}</div>}
        {msg && <div style={{ color:"green", marginTop: 10 }}>{msg}</div>}
      </div>
    </div>
  );
}