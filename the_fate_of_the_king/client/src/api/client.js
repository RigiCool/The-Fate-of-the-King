const API = "http://localhost:3000";

function getToken() {
  return localStorage.getItem("token") || "";
}

async function readError(res) {
  const text = await res.text().catch(() => "");
  try {
    const obj = JSON.parse(text);
    return obj.details || obj.error || obj.message || text || `HTTP ${res.status}`;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`
    },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` }
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`
    },
    body: JSON.stringify(body || {})
  });

  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export const api = {
  register: (email, password) => post("/auth/register", { email, password }),
  login: (email, password) => post("/auth/login", { email, password }),
  me: () => get("/me"),

  listKings: () => get("/kings"),

  startGame: () => post("/start-game", {}),
  getCard: (kingId) => post("/get-card", { kingId: Number(kingId) }),
  applyChoice: (kingId, payload) => post("/apply-choice", { kingId: Number(kingId), ...payload }),

  adminSetMetrics: (kingId, metrics) => patch(`/admin/kings/${Number(kingId)}/metrics`, metrics)
};
