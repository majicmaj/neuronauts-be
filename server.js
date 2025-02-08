const express = require("express");
const http = require("http");
const path = require("path");
const socketIo = require("socket.io");
const Game = require("./game");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// Enable CORS for all HTTP requests
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://semantle.netlify.app",
      "https://semantle.netlify.app",
    ],
    methods: ["GET", "POST"],
  })
);

// Enable CORS for WebSockets
const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://semantle.netlify.app",
      "https://semantle.netlify.app",
    ],
    methods: ["GET", "POST"],
  },
});

// Serve static files (HTML, client.js, etc.)
app.use(express.static(path.join(__dirname, "public")));

// Maintain a mapping of lobby IDs to Game instances
const lobbies = {};

// Utility function to generate a random lobby ID
function generateLobbyId(length = 6) {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Create a new lobby when the client requests it.
  socket.on("createLobby", () => {
    const lobbyId = generateLobbyId();
    socket.join(lobbyId);

    // Create a new Game instance for this lobby.
    const game = new Game();
    lobbies[lobbyId] = game;
    console.log("Lobby created:", lobbyId);

    // Listen for when the game is ready (embeddings loaded) and notify the lobby.
    game.on("ready", (gameState) => {
      io.to(lobbyId).emit("gameReady", gameState);
    });

    // Send the lobby ID and initial game state to the creator.
    socket.emit("lobbyCreated", {
      lobbyId,
      gameState: game.getGameState(),
    });
  });

  // Join an existing lobby by lobby ID.
  socket.on("joinLobby", (lobbyId) => {
    if (lobbies[lobbyId]) {
      socket.join(lobbyId);
      socket.emit("lobbyJoined", {
        lobbyId,
        gameState: lobbies[lobbyId].getGameState(),
      });
      // Optionally, notify others in the lobby that a new player has joined.
      socket.to(lobbyId).emit("playerJoined", { socketId: socket.id });
      console.log(`Socket ${socket.id} joined lobby ${lobbyId}`);
    } else {
      socket.emit("error", "Lobby does not exist.");
    }
  });

  // Handle guesses. Clients now send an object containing the lobbyId and the guess.
  socket.on("guess", (data) => {
    const { lobbyId, guess } = data;
    if (lobbies[lobbyId]) {
      const result = lobbies[lobbyId].handleGuess(guess);
      // Broadcast the guess result only to clients in this lobby.
      io.to(lobbyId).emit("guessResult", result);
    } else {
      socket.emit("error", "Lobby not found.");
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // Optionally: Clean up empty lobbies or remove this client from lobby tracking.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
