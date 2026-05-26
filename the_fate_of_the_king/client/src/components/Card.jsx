import React, { useState } from "react";

export default function Card({ title, description, choices, onChoice, image }) {
  const [offsetX, setOffsetX] = useState(0);
  const [hoveredChoice, setHoveredChoice] = useState(null);

  const handleMouseMove = (e) => {
    const { currentTarget, clientX } = e;
    const rect = currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;

    const diff = clientX - centerX;
    setOffsetX(diff / 4);

    if (diff > 300) {
      setHoveredChoice(choices[0]);
    } else if (diff < -300) {
      setHoveredChoice(choices[1]);
    } else {
      setHoveredChoice(null);
    }
  };

  const handleMouseLeave = () => {
    setOffsetX(0);
    setHoveredChoice(null);
  };

  const handleClick = () => {
    if (hoveredChoice) {
      onChoice(hoveredChoice);
    }
  };

  return (
    <div
      className="card-container"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    >
      <div
        className="card"
        style={{
          transform: `translateX(${offsetX}px) rotate(${offsetX / 30}deg)`,
          transition: hoveredChoice ? "none" : "transform 0.3s ease",
        }}
      >
        {image && (
          <img
            src={image}
            alt={title}
            style={{
              maxWidth: "250px",
              maxHeight: "250px",
              borderRadius: "8px",
              marginBottom: "1rem",
            }}
          />
        )}
        <h2>{title}</h2>
        <p>{description}</p>
      </div>

      {hoveredChoice && (
        <div
          className={`overlay ${hoveredChoice === choices[0] ? "right" : "left"}`}
        >
          <span className={`card-choice ${hoveredChoice === choices[0] ? "right" : "left"}`}>{hoveredChoice.text}</span>
        </div>
      )}
    </div>
  );
}
