
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const MAX_MEDIA_LENGTH = 750_000;
const MAX_TEXT_LENGTH = 2000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "NiM V4" });
});

// Messages gardés en mémoire : ils disparaissent si le serveur redémarre.
const histories = new Map();

// Suivi des appels audio en cours.
const voiceRooms = new Map();
const voiceSocketRooms = new Map();
const socketInfo = new Map();

function clean(value, maxLength = 40) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, maxLength);
}

function validRoom(room) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(room);
}

function validDataUrl(data, type) {
  if (typeof data !== "string") return false;
  if (data.length > MAX_MEDIA_LENGTH) return false;

  if (type === "image") {
    return /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(data);
  }

  if (type === "audio") {
    return /^data:audio\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/i.test(data);
  }

  return false;
}

function systemMessage(room, text) {
  const msg = {
    id: `${Date.now()}-${Math.random()}`,
    type: "system",
    text,
    time: Date.now()
  };

  io.to(room).emit("new-message", msg);
}

function leaveVoice(socket) {
  const room = voiceSocketRooms.get(socket.id);
  if (!room) return;

  const members = voiceRooms.get(room);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) voiceRooms.delete(room);
  }

  voiceSocketRooms.delete(socket.id);
  socket.leave(`voice:${room}`);
  socket.to(`voice:${room}`).emit("voice-peer-left", socket.id);
}

io.on("connection", (socket) => {
  socket.on("join-room", (payload = {}) => {
    const name = clean(payload.name, 24);
    const room = clean(payload.room, 40);

    if (!name || !validRoom(room)) {
      socket.emit("join-error", "Entre un pseudo et un salon valide.");
      return;
    }

    const oldInfo = socketInfo.get(socket.id);
    if (oldInfo && oldInfo.room === room && oldInfo.name === name) {
      socket.emit("joined", { name, room });
      socket.emit("history", histories.get(room) || []);
      return;
    }

    if (oldInfo) {
      leaveVoice(socket);
      socket.leave(oldInfo.room);
    }

    socketInfo.set(socket.id, { name, room });
    socket.join(room);

    if (!histories.has(room)) histories.set(room, []);
    socket.emit("history", histories.get(room));
    socket.emit("joined", { name, room });

    systemMessage(room, `${name} a rejoint le salon.`);
  });

  socket.on("send-message", (payload = {}) => {
    const info = socketInfo.get(socket.id);
    if (!info) return;

    let msg;

    if (payload.type === "text") {
      const text = String(payload.text || "").trim().slice(0, MAX_TEXT_LENGTH);
      if (!text) return;

      msg = {
        id: `${Date.now()}-${Math.random()}`,
        type: "text",
        text,
        name: info.name,
        time: Date.now()
      };
    } else if (
      payload.type === "image" &&
      validDataUrl(payload.image, "image")
    ) {
      msg = {
        id: `${Date.now()}-${Math.random()}`,
        type: "image",
        image: payload.image,
        name: info.name,
        time: Date.now()
      };
    } else if (
      payload.type === "audio" &&
      validDataUrl(payload.audio, "audio")
    ) {
      msg = {
        id: `${Date.now()}-${Math.random()}`,
        type: "audio",
        audio: payload.audio,
        name: info.name,
        time: Date.now()
      };
    } else {
      return;
    }

    const history = histories.get(info.room) || [];
    history.push(msg);
    while (history.length > 30) history.shift();
    histories.set(info.room, history);

    io.to(info.room).emit("new-message", msg);
  });

  // Rejoindre l'appel audio du salon.
  socket.on("voice-join", () => {
    const info = socketInfo.get(socket.id);
    if (!info) return;

    leaveVoice(socket);

    const room = info.room;
    if (!voiceRooms.has(room)) voiceRooms.set(room, new Set());

    const members = voiceRooms.get(room);
    const peers = [...members];

    members.add(socket.id);
    voiceSocketRooms.set(socket.id, room);
    socket.join(`voice:${room}`);

    socket.emit("voice-peers", peers);
    socket.to(`voice:${room}`).emit("voice-peer-joined", socket.id);
  });

  // Relais des offres, réponses et candidats WebRTC.
  socket.on("voice-signal", (payload = {}) => {
    const room = voiceSocketRooms.get(socket.id);
    if (!room || !payload.to) return;

    const targetRoom = voiceSocketRooms.get(payload.to);
    if (targetRoom !== room) return;

    socket.to(payload.to).emit("voice-signal", {
      from: socket.id,
      signal: payload.signal
    });
  });

  socket.on("voice-leave", () => {
    leaveVoice(socket);
  });

  socket.on("disconnect", () => {
    leaveVoice(socket);

    const info = socketInfo.get(socket.id);
    if (info) {
      socket.to(info.room).emit("member-left", {
        name: info.name
      });
    }

    socketInfo.delete(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NiM V4 démarré sur le port ${PORT}`);
});
  

