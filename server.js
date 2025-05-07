// server.js - Checkpoint 5 v2: Handles Leave Room Message
// Manages WebSocket connections, rooms (with instruments), serves HTML/Sounds,
// broadcasts sound events, and handles explicit leave_room messages.

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
const MAX_CLIENTS_PER_ROOM = 4;
const CLIENT_HTML_FILE = path.join(__dirname, "index.html");
const SOUNDS_DIR = path.join(__dirname, "sounds");
const AVAILABLE_INSTRUMENTS = ["Drums", "Keyboard", "Bass", "Guitar"];

// --- Data Structures ---
// RoomData: { id: string, clients: Map<clientId, ClientData>, maxClients: number }
// ClientData: { ws: WebSocket, instrument: string | null }
const rooms = new Map();

// --- State ---
let isShuttingDown = false;

// --- MIME Type Helper ---
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

// --- HTTP Server Setup ---
// Create the HTTP server instance (Declared only ONCE here)
const httpServer = http.createServer((req, res) => {
  const requestUrl = url.parse(req.url).pathname;
  console.log(`HTTP Request: ${req.method} ${requestUrl}`);

  // Route 1: Serve index.html for the root path
  if (req.method === "GET" && requestUrl === "/") {
    fs.readFile(CLIENT_HTML_FILE, (err, data) => {
      if (err) {
        console.error(`Error reading ${CLIENT_HTML_FILE}:`, err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      }
    });
  }
  // Route 2: Serve files from the /sounds/ directory
  else if (req.method === "GET" && requestUrl.startsWith("/sounds/")) {
    const requestedSound = decodeURIComponent(
      requestUrl.substring("/sounds/".length)
    );
    if (requestedSound.includes("..")) {
      console.warn(`Blocked path traversal attempt: ${requestUrl}`);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const filePath = path.join(SOUNDS_DIR, requestedSound);

    fs.access(filePath, fs.constants.R_OK, (err) => {
      if (err) {
        console.error(
          `Sound file not found or not readable: ${filePath}`,
          err.code
        );
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Sound file not found");
      } else {
        const mimeType = getMimeType(filePath);
        res.writeHead(200, { "Content-Type": mimeType });
        fs.createReadStream(filePath).pipe(res);
        // console.log(`Serving sound file: ${filePath} as ${mimeType}`); // Keep console cleaner
      }
    });
  }
  // Route 3: Handle other requests (404)
  else {
    // Ignore requests for favicon.ico or other assets for now
    if (requestUrl !== "/favicon.ico") {
      console.log(`Unhandled request: ${requestUrl}`);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

// --- WebSocket Server Setup ---
const wss = new WebSocket.Server({ server: httpServer });
console.log(`WebSocket functionality attached to HTTP server.`);

// --- Helper Functions ---

/** Generates a unique room code */
function generateRoomCode() {
  let code;
  const l = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  do {
    code = "";
    for (let i = 0; i < 4; i++)
      code += l.charAt(Math.floor(Math.random() * l.length));
  } while (rooms.has(code));
  return code;
}

/** Broadcasts the current room state */
function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const os = [];
  room.clients.forEach((cd, cid) => {
    os.push({ clientId: cid, instrument: cd.instrument });
  });
  const msg = {
    type: "room_state_update",
    payload: { roomId: roomId, occupants: os },
  };
  const ms = JSON.stringify(msg);
  console.log(`Broadcasting state for room ${roomId}:`, os);
  room.clients.forEach((cd) => {
    const cw = cd.ws;
    if (cw.readyState === WebSocket.OPEN) {
      try {
        cw.send(ms);
      } catch (e) {
        console.error(`Error sending state to ${cw.clientId}:`, e);
      }
    }
  });
}

/** Sends a message directly to a client */
function sendMessage(clientWs, message) {
  if (clientWs && clientWs.readyState === WebSocket.OPEN) {
    try {
      clientWs.send(JSON.stringify(message));
    } catch (e) {
      console.error(`Error sending message to client ${clientWs.clientId}:`, e);
    }
  }
}

/** Removes a client from their room and broadcasts state */
function leaveRoom(ws) {
  const clientId = ws.clientId;
  const roomId = ws.roomId;

  if (!roomId || !rooms.has(roomId)) {
    // console.log(`Client ${clientId} tried to leave but wasn't in a known room.`);
    return;
  }

  const room = rooms.get(roomId);

  // Clear room ID from client's ws object state *first*
  ws.roomId = null;

  // Remove client from room's client map
  if (room.clients.delete(clientId)) {
    console.log(
      `Client ${clientId} left/removed from room ${roomId}. Room size: ${room.clients.size}`
    );
  } else {
    // console.warn(`Client ${clientId} not found in room ${roomId} map during leave attempt.`);
  }

  // Clean up empty room or broadcast state
  if (room.clients.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} is empty and has been deleted.`);
  } else {
    broadcastRoomState(roomId); // Notify remaining members
  }
}

/** Broadcasts a message to all clients in a specific room, optionally excluding the sender. */
function broadcastToRoom(roomId, message, senderWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  const messageString = JSON.stringify(message);
  room.clients.forEach((clientData) => {
    const clientWs = clientData.ws;
    if (clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.send(messageString);
      } catch (error) {
        console.error(
          `Error sending message to client ${clientWs.clientId} in room ${roomId}:`,
          error
        );
      }
    }
  });
}

// --- WebSocket Server Event Listeners ---

wss.on("connection", (ws, req) => {
  ws.clientId = uuidv4();
  ws.roomId = null;
  const clientIp = req.socket.remoteAddress;
  console.log(`Client connected: ${ws.clientId} from ${clientIp}`);

  sendMessage(ws, {
    type: "connection_ack",
    payload: {
      clientId: ws.clientId,
      message: "Welcome! Create or join a room.",
    },
  });

  ws.on("message", (message) => {
    if (isShuttingDown) return;
    let parsedMessage;
    try {
      parsedMessage = JSON.parse(message);
      const currentRoomId = ws.roomId; // Get room ID *before* potential leave

      switch (parsedMessage.type) {
        case "create_room":
          if (ws.roomId) {
            sendMessage(ws, {
              type: "error",
              payload: { message: "You are already in a room." },
            });
            return;
          }
          const newRoomId = generateRoomCode();
          const newRoom = {
            id: newRoomId,
            clients: new Map(),
            maxClients: MAX_CLIENTS_PER_ROOM,
          };
          newRoom.clients.set(ws.clientId, { ws: ws, instrument: null });
          rooms.set(newRoomId, newRoom);
          ws.roomId = newRoomId;
          console.log(`Client ${ws.clientId} created room ${newRoomId}`);
          broadcastRoomState(newRoomId);
          break;

        case "join_room":
          if (ws.roomId) {
            sendMessage(ws, {
              type: "error",
              payload: { message: "You are already in a room." },
            });
            return;
          }
          const { roomCode } = parsedMessage.payload;
          const roomToJoin = rooms.get(roomCode?.toUpperCase());
          if (!roomToJoin) {
            sendMessage(ws, {
              type: "error",
              payload: { message: `Room "${roomCode}" not found.` },
            });
            return;
          }
          if (roomToJoin.clients.size >= roomToJoin.maxClients) {
            sendMessage(ws, {
              type: "error",
              payload: { message: `Room "${roomCode}" is full.` },
            });
            return;
          }
          const joinedRoomId = roomCode.toUpperCase();
          ws.roomId = joinedRoomId;
          roomToJoin.clients.set(ws.clientId, { ws: ws, instrument: null });
          console.log(`Client ${ws.clientId} joined room ${joinedRoomId}`);
          broadcastRoomState(joinedRoomId);
          break;

        case "select_instrument":
          if (!currentRoomId || !rooms.has(currentRoomId)) {
            sendMessage(ws, {
              type: "error",
              payload: { message: "You are not in a valid room." },
            });
            return;
          }
          const { instrument } = parsedMessage.payload;
          if (!instrument || !AVAILABLE_INSTRUMENTS.includes(instrument)) {
            sendMessage(ws, {
              type: "error",
              payload: {
                message: `Invalid instrument selected: ${instrument}`,
              },
            });
            return;
          }
          const room = rooms.get(currentRoomId);
          const clientData = room.clients.get(ws.clientId);
          if (clientData) {
            clientData.instrument = instrument;
            console.log(
              `Client ${ws.clientId} in room ${currentRoomId} selected instrument: ${instrument}`
            );
            broadcastRoomState(currentRoomId);
          } else {
            console.error(`Client data not found for ${ws.clientId}`);
            sendMessage(ws, {
              type: "error",
              payload: { message: "Internal server error." },
            });
          }
          break;

        case "play_sound":
          if (!currentRoomId || !rooms.has(currentRoomId)) {
            return;
          }
          const soundPayload = parsedMessage.payload;
          if (
            !soundPayload ||
            !soundPayload.instrument ||
            !soundPayload.sound
          ) {
            sendMessage(ws, {
              type: "error",
              payload: { message: "Invalid play_sound payload." },
            });
            return;
          }
          console.log(
            `Room ${currentRoomId}: Client ${ws.clientId} played sound: ${soundPayload.instrument} - ${soundPayload.sound}`
          );
          broadcastToRoom(
            currentRoomId,
            {
              type: "sound_played",
              payload: {
                senderId: ws.clientId,
                instrument: soundPayload.instrument,
                sound: soundPayload.sound,
              },
            },
            ws
          );
          break;

        case "leave_room":
          console.log(
            `Client ${ws.clientId} requested to leave room ${currentRoomId}`
          );
          leaveRoom(ws); // Call the leave logic
          break;

        default:
          sendMessage(ws, {
            type: "error",
            payload: { message: `Unknown message type: ${parsedMessage.type}` },
          });
      }
    } catch (error) {
      console.error(
        `Failed to parse message or handle data from ${ws.clientId}:`,
        error
      );
      sendMessage(ws, {
        type: "error",
        payload: { message: "Invalid message format." },
      });
    }
  });

  ws.on("close", () => {
    console.log(`Connection closed for client: ${ws.clientId}`);
    if (!isShuttingDown) leaveRoom(ws);
  });
  ws.onerror = (error) => {
    console.error(`WebSocket error for client ${ws.clientId}:`, error);
    if (!isShuttingDown) leaveRoom(ws);
  };
}); // End of wss.on('connection', ...)

// --- Server Startup ---
httpServer.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on http://${HOST}:${PORT}`);
  console.log(`Accessible locally via http://localhost:${PORT}`);
  console.log(`Accessible on your network via http://<your-local-ip>:${PORT}`);
});

// --- Graceful Shutdown ---
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("Server shutting down...");
  const sm = JSON.stringify({
    type: "server_shutdown",
    payload: { message: "Server is shutting down." },
  });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try {
        c.send(sm);
        c.close(1000, "Server shutting down");
      } catch (err) {
        try {
          c.terminate();
        } catch (e) {}
      }
    }
  });
  httpServer.close(() => {
    console.log("HTTP server closed.");
    console.log("Exiting process.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 5000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
