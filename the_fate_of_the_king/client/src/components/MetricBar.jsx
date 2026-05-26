import React from "react";

function MetricBar({ label, value, max = 300 }) {
  const percentage = Math.min((value / max) * 100, 100);

  return (
    <div className="metric-bar-container">
      <div className="metric-bar-bg">
        <div
          className="metric-bar-fill"
          style={{
            width: `${percentage}%`,
            background: "linear-gradient(to right, #ffb347, #ffcc33)"
          }}
        />
      </div>
    </div>
  );
}

export default MetricBar;
