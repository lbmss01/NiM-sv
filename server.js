
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6
});

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
    socket.emit("joined", name);

    socket.to(room).emit("chat-message", {
      type: "system",
      text: name + " a rejoint le salon."
    });
  });

  socket.on("send-message", (data) => {
    if (!currentRoom || !data || typeof data !== "object") return;

    let message;

    if (data.type === "text" && typeof data.text === "string") {
      const text = data.text.trim().slice(0, 500);
      if (!text) return;

      message = { type: "text", text };
    } else if (
      data.type === "image" &&
      typeof data.image === "string" &&
      /^data:image\/(jpeg|png|webp);base64,/.test(data.image) &&
      data.image.length <= 800000
    ) {
      message = { type: "image", image: data.image };
    } else {
      return;
    }

    message.name = currentName;
    message.time = new Date().toISOString();

    const history = rooms.get(currentRoom);
    history.push(message);
    if (history.length > 30) history.shift();

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
