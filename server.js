const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "NiM" });
});

const users = new Map();
const rooms = new Map();
const chats = new Map();

function id() {
  return Math.random().toString(36).slice(2, 10)
    + Date.now().toString(36);
}

function clean(value, max = 30) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, max);
}

function sendUsers(room) {
  io.to(room).emit(
    "users",
    [...users.entries()]
      .filter(([, u]) => u.room === room)
      .map(([socketId, u]) => ({
        id: socketId,
        name: u.name
      }))
  );
}

function roomHistory(room) {
  if (!rooms.has(room)) rooms.set(room, []);
  return rooms.get(room);
}

function chatList(socketId) {
  return [...chats.values()]
    .filter(c => c.members.includes(socketId))
    .map(c => {
      const other = c.members.find(x => x !== socketId);
      return {
        id: c.id,
        name: c.names[other],
        target: other,
        history: c.history
      };
    });
}

function sendChatLists(chat) {
  chat.members.forEach(member => {
    io.to(member).emit("dm-list", chatList(member));
  });
}

function validateMessage(data) {
  const type = data?.type;
  const content = String(data?.content || "");

  if (!["text", "image", "audio"].includes(type)) return null;
  if (!content) return null;

  if (type === "text" && content.length > 2000) return null;
  if (type !== "text" && content.length > 3800000) return null;

  if (type === "image" && !content.startsWith("data:image/")) return null;
  if (type === "audio" && !content.startsWith("data:audio/")) return null;

  return { type, content };
}

function addMessage(list, message) {
  list.push(message);
  if (list.length > 50) list.shift();
}

io.on("connection", socket => {
  socket.on("join", data => {
    const name = clean(data?.name, 20);
    const room = clean(data?.room || "general", 30)
      .replace(/[^a-zA-Z0-9_-]/g, "") || "general";

    if (!name) {
      socket.emit("error-message", "Choisis un pseudo.");
      return;
    }

    const previous = users.get(socket.id);
    if (previous) {
      socket.leave(previous.room);
      sendUsers(previous.room);
    }

    users.set(socket.id, { name, room });
    socket.join(room);

    socket.emit("joined", {
      name,
      room,
      history: roomHistory(room)
    });

    sendUsers(room);
    socket.emit("dm-list", chatList(socket.id));
  });

  socket.on("room-message", data => {
    const user = users.get(socket.id);
    const message = validateMessage(data);
    if (!user || !message) return;

    const msg = {
      ...message,
      id: id(),
      sender: user.name,
      senderId: socket.id,
      time: Date.now()
    };

    addMessage(roomHistory(user.room), msg);
    io.to(user.room).emit("room-message", msg);
  });

  socket.on("start-dm", target => {
    if (!users.has(socket.id) || !users.has(target) || target === socket.id) return;

    let chat = [...chats.values()].find(c =>
      c.members.includes(socket.id) && c.members.includes(target)
    );

    if (!chat) {
      chat = {
        id: id(),
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
      id: chat.id,
      name: chat.names[target],
      target,
      history: chat.history
    });

    io.to(target).emit("dm-available", {
      id: chat.id,
      name: chat.names[socket.id],
      target: socket.id,
      history: chat.history
    });

    sendChatLists(chat);
  });

  socket.on("dm-message", data => {
    const chat = chats.get(data?.id);
    const message = validateMessage(data);
    const user = users.get(socket.id);

    if (!chat || !message || !user ||
        !chat.members.includes(socket.id)) return;

    const msg = {
      ...message,
      id: id(),
      sender: user.name,
      senderId: socket.id,
      time: Date.now()
    };

    addMessage(chat.history, msg);
    chat.members.forEach(member => {
      io.to(member).emit("dm-message", {
        id: chat.id,
        msg
      });
    });

    sendChatLists(chat);
  });

  socket.on("call-signal", data => {
    const chat = chats.get(data?.id);
    const target = data?.target;

    if (!chat || !chat.members.includes(socket.id) ||
        !chat.members.includes(target)) return;

    io.to(target).emit("call-signal", {
      ...data,
      from: socket.id,
      fromName: users.get(socket.id)?.name || "Contact"
    });
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      sendUsers(user.room);
    }

    for (const [key, chat] of chats) {
      if (!chat.members.includes(socket.id)) continue;

      chat.members.forEach(member => {
        if (member !== socket.id) {
          io.to(member).emit("dm-ended", { id: key });
        }
      });

      chats.delete(key);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("NiM lancé sur le port " + PORT);
});

  

          
