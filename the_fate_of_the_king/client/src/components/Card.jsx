import React, { useState } from "react";

export default function Card({ title, description, choices, onChoice, image }) {
  const [offsetX, setOffsetX] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const handleMouseMove = (e) => {
    const { currentTarget, clientX } = e;
    const rect = currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;

    const diff = clientX - centerX;
    setOffsetX(diff / 4);

    if (diff > 300) setHoveredIndex(0);
    else if (diff < -300) setHoveredIndex(1);
    else setHoveredIndex(null);
  };

  const handleMouseLeave = () => {
    setOffsetX(0);
    setHoveredIndex(null);
  };

  const handleClick = () => {
    if (hoveredIndex === 0 || hoveredIndex === 1) {
      onChoice(choices[hoveredIndex], hoveredIndex);
    }
  };

  const hoveredChoice = hoveredIndex === null ? null : choices[hoveredIndex];

  return (
    <div className="card-container" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} onClick={handleClick}>
      <div
        className="card"
        style={{
          transform: `translateX(${offsetX}px) rotate(${offsetX / 30}deg)`,
          transition: hoveredChoice ? "none" : "transform 0.3s ease"
        }}
      >
        {image ? (
          <img
            src={image}
            alt={title}
            style={{ maxWidth: "250px", maxHeight: "250px", borderRadius: "8px", marginBottom: "1rem" }}
          />
        ) : null}

        <h2>{title}</h2>
        <p>{description}</p>
      </div>

      {hoveredChoice && (
        <div className={`overlay ${hoveredIndex === 0 ? "right" : "left"}`}>
          <span className={`card-choice ${hoveredIndex === 0 ? "right" : "left"}`}>{hoveredChoice.text}</span>
        </div>
      )}
    </div>
  );
}