// ------------------------------------------------------ //
// ---------- Authorization and authentication ---------- //
// ------------------------------------------------------ //



// ---------------------------------------------------------------- //
// ---------- Authorization and authentication constants ---------- //
// ---------------------------------------------------------------- //
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";



// ---------------------------------------------------------------- //
// ---------- Authorization and authentication functions ---------- //
// ---------------------------------------------------------------- //
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
  const headers = req.headers.authorization || "";
  const [, token] = headers.split(" ");
  if (!token) return res.status(401).json({ error: "No token provided (Authorization: Bearer ...)" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin role is required" });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  authRequired,
  adminRequired
};