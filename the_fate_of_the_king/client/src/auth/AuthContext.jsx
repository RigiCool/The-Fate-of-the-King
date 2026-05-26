import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/Client";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadMe() {
    if (!token) { setUser(null); setLoading(false); return; }
    try {
      const r = await api.me();
      setUser(r.user);
    } catch {
      setUser(null);
      setToken("");
      localStorage.removeItem("token");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadMe(); }, [token]);

  async function login(email, password) {
    const r = await api.login(email, password);
    localStorage.setItem("token", r.token);
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }

  async function register(email, password) {
    const r = await api.register(email, password);
    localStorage.setItem("token", r.token);
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }

  function logout() {
    localStorage.removeItem("token");
    setToken("");
    setUser(null);
  }

  const value = useMemo(() => ({
    token, user, loading,
    login, register, logout
  }), [token, user, loading]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}