
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6 });

app.use(express.static("public"));
app.get("/health", (req, res) => res.json({ status: "ok", app: "NiM" }));

const users = new Map();
const rooms = new Map();
const chats = new Map();
const groupCalls = new Map();

const makeId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clean = (s, max = 30) => String(s || "").trim().replace(/[<>]/g, "").slice(0, max);
const safeRoom = s => clean(s, 30).replace(/[^a-zA-Z0-9_-]/g, "") || "general";

function history(room) {
  if (!rooms.has(room)) rooms.set(room, []);
  return rooms.get(room);
}

function members(room) {
  return [...users.entries()]
    .filter(([, u]) => u.room === room)
    .map(([id, u]) => ({ id, name: u.name }));
}

function sendUsers(room) {
  io.to(room).emit("users", members(room));
}

function validMessage(d) {
  if (!d || !["text", "image", "audio"].includes(d.type)) return null;
  const content = String(d.content || "");
  if (!content || content.length > 5_000_000) return null;
  if (d.type === "text" && content.length > 2000) return null;
  if (d.type === "image" && !content.startsWith("data:image/")) return null;
  if (d.type === "audio" && !content.startsWith("data:audio/")) return null;
  return { type: d.type, content };
}

function addMessage(list, msg) {
  list.push(msg);
  if (list.length > 50) list.shift();
}

function chatList(id) {
  return [...chats.values()]
    .filter(c => c.members.includes(id))
    .map(c => {
      const other = c.members.find(x => x !== id);
      return { id: c.id, name: c.names[other], target: other, history: c.history };
    });
}

function sendChatLists(chat) {
  for (const id of chat.members) io.to(id).emit("dm-list", chatList(id));
}

function removeFromGroupCall(socketId, room) {
  const call = groupCalls.get(room);
  if (!call) return;
  call.delete(socketId);
  io.to(`call:${room}`).emit("group-call-peer-left", { id: socketId });
  if (call.size === 0) groupCalls.delete(room);
}

io.on("connection", socket => {
  socket.on("join", data => {
    const name = clean(data?.name, 20);
    const room = safeRoom(data?.room || "general");
    if (!name) return socket.emit("error-message", "Choisis un pseudo.");

    const old = users.get(socket.id);
    if (old) {
      socket.leave(old.room);
      removeFromGroupCall(socket.id, old.room);
      sendUsers(old.room);
    }

    users.set(socket.id, { name, room });
    socket.join(room);
    socket.emit("joined", { name, room, history: history(room) });
    sendUsers(room);
    socket.emit("dm-list", chatList(socket.id));
  });

  socket.on("room-message", data => {
    const user = users.get(socket.id);
    const body = validMessage(data);
    if (!user || !body) return;
    const msg = {
      ...body, id: makeId(), sender: user.name,
      senderId: socket.id, time: Date.now()
    };
    addMessage(history(user.room), msg);
    io.to(user.room).emit("room-message", msg);
  });

  socket.on("start-dm", target => {
    if (!users.has(socket.id) || !users.has(target) || target === socket.id) return;

    let chat = [...chats.values()].find(c =>
      c.members.includes(socket.id) && c.members.includes(target)
    );

    if (!chat) {
      chat = {
        id: makeId(),
        members: [socket.id, target],
        names: {
          [socket.id]: users.get(socket.id).name,
          [target]: users.get(target).name
        },
        history: []
      };
      chats.set(chat.id, chat);
    }

    socket.emit("dm-open", {
      id: chat.id, name: chat.names[target],
      target, history: chat.history
    });
    io.to(target).emit("dm-available", {
      id: chat.id, name: chat.names[socket.id],
      target: socket.id, history: chat.history
    });
    sendChatLists(chat);
  });

  socket.on("dm-message", data => {
    const chat = chats.get(data?.id);
    const user = users.get(socket.id);
    const body = validMessage(data);
    if (!chat || !user || !body || !chat.members.includes(socket.id)) return;

    const msg = {
      ...body, id: makeId(), sender: user.name,
      senderId: socket.id, time: Date.now()
    };
    addMessage(chat.history, msg);
    chat.members.forEach(id => io.to(id).emit("dm-message", { id: chat.id, msg }));
    sendChatLists(chat);
  });

  // Signalisation des appels privés
  socket.on("call-signal", data => {
    const chat = chats.get(data?.id);
    const target = data?.target;
    if (!chat || !chat.members.includes(socket.id) || !chat.members.includes(target)) return;
    io.to(target).emit("call-signal", {
      ...data, from: socket.id,
      fromName: users.get(socket.id)?.name || "Contact"
    });
  });

  // Appels audio/vidéo de groupe dans un salon
  socket.on("group-call-join", () => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = user.room;
    if (!groupCalls.has(room)) groupCalls.set(room, new Set());
    const call = groupCalls.get(room);
    const peers = [...call].filter(id => users.has(id));

    call.add(socket.id);
    socket.join(`call:${room}`);
    socket.emit("group-call-peers", { room, peers });
    socket.to(`call:${room}`).emit("group-call-peer-joined", {
      id: socket.id,
      name: user.name
    });
  });

  socket.on("group-call-signal", data => {
    const user = users.get(socket.id);
    const target = data?.target;
    if (!user || !target) return;

    const call = groupCalls.get(user.room);
    if (!call || !call.has(socket.id) || !call.has(target)) return;

    io.to(target).emit("group-call-signal", {
      ...data,
      from: socket.id,
      fromName: user.name,
      room: user.room
    });
  });

  socket.on("group-call-leave", () => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.leave(`call:${user.room}`);
    removeFromGroupCall(socket.id, user.room);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      removeFromGroupCall(socket.id, user.room);
      users.delete(socket.id);
      sendUsers(user.room);
    }

    for (const [key, chat] of chats) {
      if (!chat.members.includes(socket.id)) continue;
      chat.members.forEach(id => {
        if (id !== socket.id) io.to(id).emit("dm-ended", { id: key });
      });
      chats.delete(key);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("NiM lancé sur le port " + PORT));
