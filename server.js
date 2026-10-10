

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const MAX_HISTORY = 30;
const MAX_TEXT_LENGTH = 500;
const MAX_MEDIA_LENGTH = 750000;

function getRoomHistory(room) {
  if (!rooms.has(room)) {
    rooms.set(room, []);
  }
  return rooms.get(room);
}

function addMessage(room, message) {
  const history = getRoomHistory(room);
  history.push(message);

  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  io.to(room).emit("chat-message", message);
}

function validMediaData(data, type) {
  if (typeof data !== "string" || data.length > MAX_MEDIA_LENGTH) {
    return false;
  }

  if (type === "image") {
    return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(data);
  }

  if (type === "audio") {
    return /^data:audio\/[a-z0-9.+-]+(?:;codecs=[a-z0-9.,-]+)?;base64,[A-Za-z0-9+/=\r\n]+$/i.test(data);
  }

  return false;
}

io.on("connection", (socket) => {
  socket.on("join-room", (data = {}) => {
    const name = String(data.name || "").trim().slice(0, 24);
    const room = String(data.room || "").trim().slice(0, 32);

    if (!name || !room) {
      socket.emit("error-message", "Entre un pseudo et un nom de salon.");
      return;
    }

    if (socket.data.room) {
      socket.leave(socket.data.room);
    }

    socket.data.name = name;
    socket.data.room = room;

    socket.join(room);

    socket.emit("history", getRoomHistory(room));
    socket.emit("joined", { name, room });

    addMessage(room, {
      type: "system",
      text: `${name} a rejoint le salon`,
      time: new Date().toISOString()
    });
  });

  socket.on("send-message", (data = {}) => {
    const name = socket.data.name;
    const room = socket.data.room;

    if (!name || !room || !data || typeof data !== "object") {
      return;
    }

    let message;

    if (data.type === "text") {
      const text = typeof data.text === "string"
        ? data.text.trim().slice(0, MAX_TEXT_LENGTH)
        : "";

      if (!text) return;

      message = {
        type: "text",
        text,
        name,
        time: new Date().toISOString()
      };
    } else if (data.type === "image") {
      if (!validMediaData(data.image, "image")) {
        socket.emit("error-message", "Image invalide ou trop volumineuse.");
        return;
      }

      message = {
        type: "image",
        image: data.image,
        name,
        time: new Date().toISOString()
      };
    } else if (data.type === "audio") {
      if (!validMediaData(data.audio, "audio")) {
        socket.emit("error-message", "Vocal invalide ou trop volumineux. Essaie un enregistrement plus court.");
        return;
      }

      message = {
        type: "audio",
        audio: data.audio,
        name,
        time: new Date().toISOString()
      };
    } else {
      return;
    }

    addMessage(room, message);
  });

  socket.on("disconnect", () => {
    const { name, room } = socket.data;

    if (name && room) {
      addMessage(room, {
        type: "system",
        text: `${name} a quitté le salon`,
        time: new Date().toISOString()
      });
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NiM Chat écoute sur le port ${PORT}`);
});
