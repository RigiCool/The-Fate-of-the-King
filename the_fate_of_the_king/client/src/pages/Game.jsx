import { useState } from "react";

function Game() {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);

  async function fetchCard() {
    setLoading(true);
    try {
      const res = await fetch("http://localhost:3000/get-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      setCard(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  function handleChoice(choice) {
    console.log("Выбор пользователя:", choice);

    fetchCard();
  }

  return (
    <div>
      {!card && <button onClick={fetchCard}>Начать игру</button>}
      {loading && <p>Загрузка...</p>}
      {card && (
        <div className="card">
          <h2>{card.title}</h2>
          <p>{card.description}</p>
          <div>
            {card.choices.map((c, idx) => (
              <button key={idx} onClick={() => handleChoice(c)}>
                {c.text}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Game;
