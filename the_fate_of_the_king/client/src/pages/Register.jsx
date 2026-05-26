import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      await register(email, password);
      nav("/kings");
    } catch (e2) {
      setErr(e2.message || "Register failed");
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <h2>Register</h2>
      <form onSubmit={onSubmit}>
        <div>
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} />
        </div>
        <div style={{ marginTop: 10 }}>
          <label>Password (&gt;= 6)</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%" }} />
        </div>
        {err && <div style={{ color: "crimson", marginTop: 10 }}>{err}</div>}
        <button style={{ marginTop: 14 }}>Create account</button>
      </form>
      <div style={{ marginTop: 12 }}>
        Already have account? <Link to="/login">Login</Link>
      </div>
    </div>
  );
}