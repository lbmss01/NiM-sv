
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

const PORT = process.env.PORT || 3000;
const histories = new Map();
const members = new Map();
const calls = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", app: "NiM" });
});

function clean(value, max = 40) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, max);
}

function addMessage(room, message) {
  if (!histories.has(room)) histories.set(room, []);
  const history = histories.get(room);
  history.push(message);
  while (history.length > 30) history.shift();
  io.to(room).emit("new-message", message);
}

function leaveCall(socket) {
  const room = socket.data.callRoom;
  if (!room) return;

  calls.get(room)?.delete(socket.id);
  socket.to("call:" + room).emit("voice-peer-left", socket.id);
  socket.leave("call:" + room);
  socket.data.callRoom = null;

  if (calls.get(room)?.size === 0) calls.delete(room);
}

io.on("connection", socket => {
  socket.on("join-room", data => {
    const name = clean(data.name, 24);
    const room = clean(data.room, 40);

    if (!name || !/^[a-zA-Z0-9_-]{1,40}$/.test(room)) {
      socket.emit("join-error", "Entre un pseudo et un salon valide.");
      return;
    }

    const old = members.get(socket.id);
    if (old) {
      leaveCall(socket);
      socket.leave(old.room);
      members.delete(socket.id);
      socket.to(old.room).emit("member-left", { name: old.name });
    }

    members.set(socket.id, { name, room });
    socket.join(room);

    if (!histories.has(room)) histories.set(room, []);

    socket.emit("history", histories.get(room));
    socket.emit("joined", { name, room });

    addMessage(room, {
      id: Date.now() + Math.random(),
      type: "system",
      text: name + " a rejoint le salon.",
      time: Date.now()
    });

    const list = [...members.values()]
      .filter(member => member.room === room)
      .map(member => member.name);

    io.to(room).emit("member-count", list.length);
  });

  socket.on("send-message", data => {
    const user = members.get(socket.id);
    if (!user || !data) return;

    const id = Date.now() + Math.random();
    let message;

    if (data.type === "text") {
      const text = String(data.text || "").trim().slice(0, 2000);
      if (!text) return;
      message = { id, type: "text", text, name: user.name, time: Date.now() };
    } else if (["image", "video", "audio"].includes(data.type)) {
      const media = data[data.type];
      if (typeof media !== "string" || media.length > 4000000) return;

      const allowed = {
        image: /^data:image\/(jpeg|jpg|png|webp);base64,/i,
        video: /^data:video\/(mp4|webm|quicktime);base64,/i,
        audio: /^data:audio\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/i
      };

      if (!allowed[data.type].test(media)) return;

      message = {
        id,
        type: data.type,
        [data.type]: media,
        name: user.name,
        time: Date.now()
      };
    } else {
      return;
    }

    addMessage(user.room, message);
  });

  // Appels audio de groupe via WebRTC
  socket.on("voice-join", () => {
    const user = members.get(socket.id);
    if (!user) return;

    leaveCall(socket);

    const room = user.room;
    if (!calls.has(room)) calls.set(room, new Set());

    const group = calls.get(room);
    const peers = [...group];

    group.add(socket.id);
    socket.data.callRoom = room;
    socket.join("call:" + room);

    socket.emit("voice-peers", peers);
    socket.to("call:" + room).emit("voice-peer-joined", socket.id);
  });

  socket.on("voice-signal", data => {
    const room = socket.data.callRoom;
    if (!room || !data?.to || !data?.signal) return;
    if (calls.get(room)?.has(data.to)) {
      io.to(data.to).emit("voice-signal", {
        from: socket.id,
        signal: data.signal
      });
    }
  });

  socket.on("voice-leave", () => leaveCall(socket));

  socket.on("disconnect", () => {
    leaveCall(socket);
    const user = members.get(socket.id);

    if (user) {
      socket.to(user.room).emit("member-left", { name: user.name });
      members.delete(socket.id);

      const count = [...members.values()]
        .filter(member => member.room === user.room).length;

      io.to(user.room).emit("member-count", count);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("NiM lancé sur le port " + PORT);
});
          
