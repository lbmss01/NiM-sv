
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "NiM V7" });
});

const users = new Map();
const roomHistory = new Map();
const privateChats = new Map();
const userChats = new Map();

function makeId() {
  return Math.random().toString(36).slice(2, 10)
    + Date.now().toString(36);
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 20);
}

function cleanRoom(value) {
  return String(value || "general")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32) || "general";
}

function addHistory(list, message) {
  list.push(message);
  if (list.length > 50) list.shift();
}

function onlineUsers(room) {
  return [...users.entries()]
    .filter(([id, user]) => user.room === room)
    .map(([id, user]) => ({
      id,
      name: user.name
    }));
}

function updateUsers(room) {
  io.to(room).emit("room-users", onlineUsers(room));
}

function sendChatList(socketId) {
  const ids = userChats.get(socketId) || new Set();

  const chats = [...ids]
    .map(id => {
      const chat = privateChats.get(id);
      if (!chat) return null;

      const index = chat.members.findIndex(
        member => member !== socketId
      );

      return {
        id,
        name: chat.names[index < 0 ? 0 : index],
        history: chat.history
      };
    })
    .filter(Boolean);

  io.to(socketId).emit("dm-list", chats);
}

function leaveRoom(socket) {
  const user = users.get(socket.id);
  if (!user) return;

  socket.leave(user.room);
  users.delete(socket.id);
  updateUsers(user.room);
}

function validMessage(data) {
  const type = ["text", "image", "video", "audio"]
    .includes(data?.type) ? data.type : "text";

  const content = String(data?.content || "");

  if (!content) return null;
  if (type === "text" && content.length > 2000) return null;
  if (type !== "text" && content.length > 4000000) return null;

  if (
    type !== "text" &&
    !new RegExp("^data:" + type + "/").test(content)
  ) return null;

  return { type, content };
}

io.on("connection", socket => {
  socket.on("join", data => {
    const name = cleanName(data?.name);
    const room = cleanRoom(data?.room);

    if (!name) {
      socket.emit("error-message", "Choisis un pseudo.");
      return;
    }

    leaveRoom(socket);

    users.set(socket.id, { name, room });
    socket.join(room);

    if (!userChats.has(socket.id)) {
      userChats.set(socket.id, new Set());
    }

    socket.emit("joined", {
      name,
      room,
      history: roomHistory.get(room) || []
    });

    updateUsers(room);
    sendChatList(socket.id);
  });

  socket.on("send-room-message", data => {
    const user = users.get(socket.id);
    const message = validMessage(data);
    if (!user || !message) return;

    const msg = {
      id: makeId(),
      sender: user.name,
      senderId: socket.id,
      ...message,
      time: Date.now()
    };

    const history = roomHistory.get(user.room) || [];
    addHistory(history, msg);
    roomHistory.set(user.room, history);

    io.to(user.room).emit("room-message", msg);
  });

  socket.on("start-dm", targetId => {
    const otherId = String(targetId || "");
    const me = users.get(socket.id);
    const other = users.get(otherId);

    if (!me || !other || socket.id === otherId) return;

    // Reprendre la conversation si elle existe déjà.
    for (const [id, chat] of privateChats) {
      if (
        chat.members.includes(socket.id) &&
        chat.members.includes(otherId)
      ) {
        socket.join(id);
        socket.emit("dm-opened", {
          id,
          name: other.name,
          history: chat.history
        });
        return;
      }
    }

    const id = "dm_" + makeId();

    privateChats.set(id, {
      members: [socket.id, otherId],
      names: [me.name, other.name],
      history: []
    });

    userChats.get(socket.id).add(id);

    if (!userChats.has(otherId)) {
      userChats.set(otherId, new Set());
    }
    userChats.get(otherId).add(id);

    socket.join(id);
    io.sockets.sockets.get(otherId)?.join(id);

    socket.emit("dm-opened", {
      id,
      name: other.name,
      history: []
    });

    io.to(otherId).emit("dm-available", {
      id,
      name: me.name,
      history: []
    });

    sendChatList(socket.id);
    sendChatList(otherId);
  });

  socket.on("send-dm-message", data => {
    const id = String(data?.id || "");
    const chat = privateChats.get(id);
    const user = users.get(socket.id);
    const message = validMessage(data);

    if (
      !chat ||
      !user ||
      !message ||
      !chat.members.includes(socket.id)
    ) return;

    const msg = {
      id: makeId(),
      sender: user.name,
      senderId: socket.id,
      ...message,
      time: Date.now(),
      status: "Envoyé"
    };

    addHistory(chat.history, msg);
    io.to(id).emit("dm-message", { id, msg });

    for (const member of chat.members) {
      if (member !== socket.id) {
        io.to(member).emit("dm-message-status", {
          id,
          messageId: msg.id,
          status: "Reçu"
        });
      }
    }
  });

  socket.on("dm-read", data => {
    const id = String(data?.id || "");
    const chat = privateChats.get(id);

    if (!chat || !chat.members.includes(socket.id)) return;

    for (const msg of chat.history) {
      if (msg.senderId !== socket.id) {
        msg.status = "Lu";
        io.to(msg.senderId).emit("dm-message-status", {
          id,
          messageId: msg.id,
          status: "Lu"
        });
      }
    }
  });

  // Signalisation des appels audio et vidéo privés.
  socket.on("call-signal", data => {
    const id = String(data?.dmId || "");
    const target = String(data?.target || "");
    const chat = privateChats.get(id);

    if (
      !chat ||
      !chat.members.includes(socket.id) ||
      !chat.members.includes(target) ||
      !data?.kind
    ) return;

    io.to(target).emit("call-signal", {
      ...data,
      from: socket.id,
      fromName: users.get(socket.id)?.name || "Contact"
    });
  });

  socket.on("leave-room", () => leaveRoom(socket));

  socket.on("disconnect", () => {
    const user = users.get(socket.id);

    if (user) {
      users.delete(socket.id);
      updateUsers(user.room);
    }

    userChats.delete(socket.id);

    for (const [id, chat] of privateChats) {
      if (!chat.members.includes(socket.id)) continue;

      for (const member of chat.members) {
        if (member === socket.id) continue;

        userChats.get(member)?.delete(id);

        io.to(member).emit("dm-ended", {
          id,
          message: "Contact déconnecté."
        });

        sendChatList(member);
      }

      privateChats.delete(id);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("NiM V7 lancé sur le port " + PORT);
});
  

          
