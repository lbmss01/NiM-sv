
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.send("NiM Chat fonctionne !");
});

const rooms = new Map();

io.on("connection", (socket) => {
  let currentRoom = "";
  let currentName = "";

  socket.on("join-room", (info) => {
    if (currentRoom) return;

    const name = String(info?.name || "").trim().slice(0, 20);
    const room = String(info?.room || "").trim().toLowerCase();

    if (!name || !/^[a-z0-9_-]{4,24}$/.test(room)) {
      socket.emit("error-message", "Pseudo ou code de salon invalide.");
      return;
    }

    currentName = name;
    currentRoom = room;
    socket.join(room);

    if (!rooms.has(room)) rooms.set(room, []);
    socket.emit("history", rooms.get(room));

    socket.to(room).emit("chat-message", {
      type: "system",
      text: name + " a rejoint le salon."
    });

    socket.emit("joined", name);
  });

  socket.on("send-message", (text) => {
    if (!currentRoom || typeof text !== "string") return;

    text = text.trim().slice(0, 500);
    if (!text) return;

    const message = {
      type: "user",
      name: currentName,
      text,
      time: new Date().toISOString()
    };

    const history = rooms.get(currentRoom);
    history.push(message);
    if (history.length > 50) history.shift();

    io.to(currentRoom).emit("chat-message", message);
  });

  socket.on("disconnect", () => {
    if (currentRoom) {
      socket.to(currentRoom).emit("chat-message", {
        type: "system",
        text: currentName + " s'est déconnecté."
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("NiM Chat lancé sur le port " + PORT);
});
