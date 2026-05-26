//--------------------------------------------------Version: 6.0.0--------------------------------------------------
// import React from 'react';
// import Home from './pages/Home';

// function App() {
//   return <Home />;
// }

// export default App;
//--------------------------------------------------Version: 6.0.0--------------------------------------------------


//--------------------------------------------------Version: 7.0.0--------------------------------------------------
// src/App.jsx
import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute, AdminRoute } from "./routes/ProtectedRoute";

import Login from "./pages/Login";
import Register from "./pages/Register";
import Home from "./pages/Home";
import Kings from "./pages/Kings";
import AdminMetrics from "./pages/AdminMetrics";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />

          <Route
            path="/kings"
            element={
              <ProtectedRoute>
                <Kings />
              </ProtectedRoute>
            }
          />

          <Route
            path="/play/:kingId"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />

          <Route
            path="/admin/metrics"
            element={
              <AdminRoute>
                <AdminMetrics />
              </AdminRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}


//--------------------------------------------------Version: 7.0.0--------------------------------------------------