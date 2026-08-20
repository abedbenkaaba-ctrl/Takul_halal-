const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const db = new Database("/app/data/takul.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY, city TEXT, name TEXT, cuisine TEXT, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY, restaurant_id TEXT, name TEXT, price REAL
  );
  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY, city TEXT, name TEXT, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    city TEXT, restaurant_id TEXT, restaurant_name TEXT,
    items TEXT, total REAL, address TEXT,
    status TEXT DEFAULT 'nouvelle',
    driver_id TEXT, driver_name TEXT,
    driver_lat REAL, driver_lng REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const ADMIN_KEY = process.env.ADMIN_KEY || "change-moi";
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "Non autorisé" });
  next();
}

app.post("/api/admin/restaurants", requireAdmin, (req, res) => {
  const { id, city, name, cuisine } = req.body;
  db.prepare("INSERT INTO restaurants (id, city, name, cuisine) VALUES (?,?,?,?)").run(id, city, name, cuisine);
  res.json({ ok: true });
});
app.post("/api/admin/drivers", requireAdmin, (req, res) => {
  const { id, city, name } = req.body;
  db.prepare("INSERT INTO drivers (id, city, name) VALUES (?,?,?)").run(id, city, name);
  res.json({ ok: true });
});
app.post("/api/admin/menu-items", requireAdmin, (req, res) => {
  const { id, restaurant_id, name, price } = req.body;
  db.prepare("INSERT INTO menu_items (id, restaurant_id, name, price) VALUES (?,?,?,?)").run(id, restaurant_id, name, price);
  res.json({ ok: true });
});

app.get("/api/cities/:city/restaurants", (req, res) => {
  const restos = db.prepare("SELECT * FROM restaurants WHERE city = ? AND active = 1").all(req.params.city);
  const withMenu = restos.map((r) => ({
    ...r,
    menu: db.prepare("SELECT * FROM menu_items WHERE restaurant_id = ?").all(r.id),
  }));
  res.json(withMenu);
});

app.post("/api/orders", (req, res) => {
  const { city, restaurant_id, restaurant_name, items, total, address } = req.body;
  const info = db.prepare(
    "INSERT INTO orders (city, restaurant_id, restaurant_name, items, total, address) VALUES (?,?,?,?,?,?)"
  ).run(city, restaurant_id, restaurant_name, JSON.stringify(items), total, address);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
  io.to(`restaurant:${restaurant_id}`).emit("order:new", order);
  res.json(order);
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Introuvable" });
  res.json(order);
});

app.get("/api/restaurants/:id/orders", (req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE restaurant_id = ? ORDER BY id DESC").all(req.params.id);
  res.json(orders);
});

app.patch("/api/orders/:id/status", (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  io.to(`client:${order.id}`).emit("order:updated", order);
  if (status === "prete") io.to(`pool:${order.city}`).emit("order:available", order);
  res.json(order);
});

app.get("/api/cities/:city/pool", (req, res) => {
  const pool = db.prepare("SELECT * FROM orders WHERE city = ? AND status = 'prete'").all(req.params.city);
  res.json(pool);
});

app.patch("/api/orders/:id/accept", (req, res) => {
  const { driver_id, driver_name } = req.body;
  db.prepare("UPDATE orders SET status='en_livraison', driver_id=?, driver_name=? WHERE id=?")
    .run(driver_id, driver_name, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  io.to(`client:${order.id}`).emit("order:updated", order);
  res.json(order);
});

app.post("/api/orders/:id/location", (req, res) => {
  const { lat, lng } = req.body;
  db.prepare("UPDATE orders SET driver_lat=?, driver_lng=? WHERE id=?").run(lat, lng, req.params.id);
  io.to(`client:${req.params.id}`).emit("driver:location", { lat, lng });
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("join:client", (orderId) => socket.join(`client:${orderId}`));
  socket.on("join:restaurant", (restaurantId) => socket.join(`restaurant:${restaurantId}`));
  socket.on("join:pool", (city) => socket.join(`pool:${city}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TA'KUL HALAL backend en ligne sur le port ${PORT}`));
