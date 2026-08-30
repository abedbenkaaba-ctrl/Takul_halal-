// ============================================================
// NA'KUL HALAL — Serveur backend
// Connecte en temps réel les 3 apps : Client / Restaurant / Livreur
// v2 : pourboire livreur + cagnotte solidaire
// ============================================================
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
    items TEXT, items_total REAL DEFAULT 0, delivery_fee REAL DEFAULT 2.5,
    tip REAL DEFAULT 0, donation REAL DEFAULT 0,
    total REAL, address TEXT,
    status TEXT DEFAULT 'nouvelle',
    driver_id TEXT, driver_name TEXT,
    driver_lat REAL, driver_lng REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cagnotte_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    order_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Ajout de colonnes sur une base déjà existante (ne casse rien si elles existent déjà)
function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); } catch (e) { /* déjà présente */ }
}
safeAddColumn("orders", "items_total REAL DEFAULT 0");
safeAddColumn("orders", "delivery_fee REAL DEFAULT 2.5");
safeAddColumn("orders", "tip REAL DEFAULT 0");
safeAddColumn("orders", "donation REAL DEFAULT 0");

const ADMIN_KEY = process.env.ADMIN_KEY || "change-moi";
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "Non autorisé" });
  next();
}

// ============ ADMIN : gestion des villes / restaurants / livreurs ============
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

// ============ ADMIN : cagnotte solidaire ============
app.post("/api/admin/cagnotte/distribute", requireAdmin, (req, res) => {
  const { amount, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });
  db.prepare("INSERT INTO cagnotte_ledger (type, amount, note) VALUES ('distribution', ?, ?)").run(amount, note || "");
  res.json({ ok: true });
});

// ============ PUBLIC : cagnotte (transparence) ============
app.get("/api/cagnotte", (req, res) => {
  const contrib = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM cagnotte_ledger WHERE type='contribution'").get().s;
  const dist = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM cagnotte_ledger WHERE type='distribution'").get().s;
  res.json({ balance: contrib - dist, total_collected: contrib, total_distributed: dist });
});
app.get("/api/cagnotte/ledger", (req, res) => {
  const rows = db.prepare("SELECT type, amount, note, created_at FROM cagnotte_ledger ORDER BY id DESC LIMIT 20").all();
  res.json(rows);
});

// ============ PUBLIC : lecture pour l'app Client ============
app.get("/api/cities/:city/restaurants", (req, res) => {
  const restos = db.prepare("SELECT * FROM restaurants WHERE city = ? AND active = 1").all(req.params.city);
  const withMenu = restos.map((r) => ({
    ...r,
    menu: db.prepare("SELECT * FROM menu_items WHERE restaurant_id = ?").all(r.id),
  }));
  res.json(withMenu);
});

// ============ CLIENT : créer une commande ============
app.post("/api/orders", (req, res) => {
  const {
    city, restaurant_id, restaurant_name, items,
    items_total = 0, delivery_fee = 2.5, tip = 0, donation = 0,
    address,
  } = req.body;
  const total = Number(items_total) + Number(delivery_fee) + Number(tip) + Number(donation);
  const info = db.prepare(
    `INSERT INTO orders (city, restaurant_id, restaurant_name, items, items_total, delivery_fee, tip, donation, total, address)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(city, restaurant_id, restaurant_name, JSON.stringify(items), items_total, delivery_fee, tip, donation, total, address);

  if (Number(donation) > 0) {
    db.prepare("INSERT INTO cagnotte_ledger (type, amount, note, order_id) VALUES ('contribution', ?, ?, ?)")
      .run(donation, `Aumône via commande #${info.lastInsertRowid}`, info.lastInsertRowid);
  }

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
  io.to(`restaurant:${restaurant_id}`).emit("order:new", order);
  res.json(order);
});

// ============ CLIENT : suivre sa commande ============
app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Introuvable" });
  res.json(order);
});

// ============ RESTAURANT : voir ses commandes ============
app.get("/api/restaurants/:id/orders", (req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE restaurant_id = ? ORDER BY id DESC").all(req.params.id);
  res.json(orders);
});

// ============ RESTAURANT : faire avancer le statut ============
app.patch("/api/orders/:id/status", (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  io.to(`client:${order.id}`).emit("order:updated", order);
  if (status === "prete") io.to(`pool:${order.city}`).emit("order:available", order);
  res.json(order);
});

// ============ LIVREUR : voir le pool de sa ville ============
app.get("/api/cities/:city/pool", (req, res) => {
  const pool = db.prepare("SELECT * FROM orders WHERE city = ? AND status = 'prete'").all(req.params.city);
  res.json(pool);
});

// ============ LIVREUR : accepter une commande ============
app.patch("/api/orders/:id/accept", (req, res) => {
  const { driver_id, driver_name } = req.body;
  db.prepare("UPDATE orders SET status='en_livraison', driver_id=?, driver_name=? WHERE id=?")
    .run(driver_id, driver_name, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  io.to(`client:${order.id}`).emit("order:updated", order);
  res.json(order);
});

// ============ LIVREUR : ses livraisons effectuées (gains réels) ============
app.get("/api/drivers/:name/deliveries", (req, res) => {
  const rows = db.prepare("SELECT * FROM orders WHERE driver_name = ? AND status = 'livree' ORDER BY id DESC").all(req.params.name);
  res.json(rows);
});

// ============ LIVREUR : envoyer sa position GPS en direct ============
app.post("/api/orders/:id/location", (req, res) => {
  const { lat, lng } = req.body;
  db.prepare("UPDATE orders SET driver_lat=?, driver_lng=? WHERE id=?").run(lat, lng, req.params.id);
  io.to(`client:${req.params.id}`).emit("driver:location", { lat, lng });
  res.json({ ok: true });
});

// ---------- Salons temps réel (Socket.io) ----------
io.on("connection", (socket) => {
  socket.on("join:client", (orderId) => socket.join(`client:${orderId}`));
  socket.on("join:restaurant", (restaurantId) => socket.join(`restaurant:${restaurantId}`));
  socket.on("join:pool", (city) => socket.join(`pool:${city}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NA'KUL HALAL backend en ligne sur le port ${PORT}`));
