const socket = io();

// Listen for the initial game state
socket.on("gameState", (state) => {
  console.log("Game state:", state);
});

// Listen for guess results
socket.on("guessResult", (result) => {
  const resultsDiv = document.getElementById("results");
  const msg = result.error
    ? `Error: ${result.error}`
    : `Guess "${result.guess}" has similarity: ${result.similarity.toFixed(
        2
      )}` + (result.correct ? " (Correct!)" : "");

  // Create a progress bar for the similarity
  const progressBar = document.createElement("div");
  progressBar.className = "progress-bar";
  progressBar.style.width = `${result.similarity * 100}%`;
  resultsDiv.appendChild(progressBar);

  // Add the result message
  const p = document.createElement("p");
  p.textContent = msg;
  resultsDiv.appendChild(p);
});

// Send a guess to the server when the button is clicked
document.getElementById("guessBtn").addEventListener("click", () => {
  const guess = document.getElementById("guessInput").value.trim();
  if (guess) {
    socket.emit("guess", guess);
    document.getElementById("guessInput").value = "";
  }
});
