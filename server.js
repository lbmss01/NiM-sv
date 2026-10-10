
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

const PORT = process.env.PORT || 3000;
const users = new Map();
const history = new Map();
const calls = new Map();

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "NiM" });
});

app.use(express.static("public"));

function clean(value, max = 30) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
}

function roomMembers(room) {
  return [...users.entries()]
    .filter(([, user]) => user.room === room)
    .map(([id, user]) => ({ id, name: user.name }));
}

function sendMembers(room) {
  io.to(room).emit("members", roomMembers(room));
}

function leaveCall(socket, room) {
  const participants = calls.get(room);
  if (!participants || !participants.has(socket.id)) return;

  participants.delete(socket.id);
  socket.leave("call:" + room);
  socket.to("call:" + room).emit("group-call-peer-left", {
    id: socket.id
  });

  if (participants.size === 0) calls.delete(room);
}

io.on("connection", socket => {
  socket.on("join", (data = {}) => {
    const name = clean(data.name, 20);
    const room = clean(data.room, 30).replace(/[^a-zA-Z0-9_-]/g, "");

    if (!name || !room) {
      socket.emit("join-error", "Entre un pseudo et un nom de salon valide.");
      return;
    }

    const old = users.get(socket.id);
    if (old) {
      leaveCall(socket, old.room);
      socket.leave(old.room);
      users.delete(socket.id);
      sendMembers(old.room);
    }

    users.set(socket.id, { name, room });
    socket.join(room);

    if (!history.has(room)) history.set(room, []);
    socket.emit("joined", {
      name,
      room,
      messages: history.get(room)
    });

    sendMembers(room);
    socket.to(room).emit("system-message", `${name} a rejoint le salon.`);
  });

  socket.on("room-message", data => {
    const user = users.get(socket.id);
    if (!user || !data) return;

    const type = ["text", "image", "audio"].includes(data.type)
      ? data.type : "text";
    const content = typeof data.content === "string"
      ? data.content : "";

    if (!content || content.length > 4e6) return;
    if (type === "image" && !content.startsWith("data:image/")) return;
    if (type === "audio" && !content.startsWith("data:audio/")) return;

    const message = {
      id: `${Date.now()}-${Math.random()}`,
      name: user.name,
      type,
      content: type === "text" ? clean(content, 1500) : content,
      time: new Date().toISOString()
    };

    if (!message.content) return;

    const list = history.get(user.room) || [];
    list.push(message);
    history.set(user.room, list.slice(-50));
    io.to(user.room).emit("room-message", message);
  });

  socket.on("group-call-join", () => {
    const user = users.get(socket.id);
    if (!user) return;

    if (!calls.has(user.room)) calls.set(user.room, new Set());
    const participants = calls.get(user.room);
    if (participants.has(socket.id)) return;

    const peers = [...participants].map(id => ({
      id,
      name: users.get(id)?.name || "Membre"
    }));

    participants.add(socket.id);
    socket.join("call:" + user.room);

    socket.emit("group-call-peers", peers);
    socket.to("call:" + user.room).emit("group-call-peer-joined", {
      id: socket.id,
      name: user.name
    });
  });

  socket.on("group-call-signal", data => {
    const user = users.get(socket.id);
    if (!user || !data || typeof data.to !== "string") return;

    const participants = calls.get(user.room);
    if (!participants ||
        !participants.has(socket.id) ||
        !participants.has(data.to)) return;

    io.to(data.to).emit("group-call-signal", {
      from: socket.id,
      fromName: user.name,
      signal: data.signal
    });
  });

  socket.on("group-call-leave", () => {
    const user = users.get(socket.id);
    if (user) leaveCall(socket, user.room);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;

    leaveCall(socket, user.room);
    users.delete(socket.id);
    socket.to(user.room).emit("system-message", `${user.name} a quitté le salon.`);
    sendMembers(user.room);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NiM lancé sur le port ${PORT}`);
});
    
