//--------------------------------------------------Version: 7.0.0--------------------------------------------------
// auth.js
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role || "user" },
    JWT_SECRET,
    { expiresIn: "14d" }
  );
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const [, token] = h.split(" ");
  if (!token) return res.status(401).json({ error: "Нет токена (Authorization: Bearer ...)" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Невалидный/просроченный токен" });
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Требуется роль admin" });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  authRequired,
  adminRequired
};
//--------------------------------------------------Version: 7.0.0--------------------------------------------------