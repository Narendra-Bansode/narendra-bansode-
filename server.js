const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

// Serve the main HTML page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ccp.html"));
});

// Database initialization
const dbPath = path.join(__dirname, "database.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Database connection error:", err);
  } else {
    console.log("Connected to SQLite database");
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        mobile TEXT,
        city TEXT,
        address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        location TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT DEFAULT 'Normal',
        photo LONGBLOB,
        status TEXT DEFAULT 'Submitted',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL,
        old_status TEXT,
        new_status TEXT,
        changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        remarks TEXT,
        FOREIGN KEY(complaint_id) REFERENCES complaints(id)
      )
    `);

    console.log("Database tables initialized successfully");
  });
}

app.post("/api/account", (req, res) => {
  const { name, email, mobile, city, address } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, message: "Name and email are required" });
  }

  db.get("SELECT id FROM users WHERE email = ?", [email], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Database error", error: err.message });
    }

    if (row) {
      db.run(
        `UPDATE users SET name = ?, mobile = ?, city = ?, address = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`,
        [name, mobile || null, city || null, address || null, email],
        function (err) {
          if (err) {
            return res.status(500).json({ success: false, message: "Update error", error: err.message });
          }
          res.json({ success: true, message: "Account updated successfully", user_id: row.id });
        }
      );
    } else {
      db.run(
        `INSERT INTO users (name, email, mobile, city, address) VALUES (?, ?, ?, ?, ?)`,
        [name, email, mobile || null, city || null, address || null],
        function (err) {
          if (err) {
            return res.status(500).json({ success: false, message: "Insert error", error: err.message });
          }
          res.json({ success: true, message: "Account created successfully", user_id: this.lastID });
        }
      );
    }
  });
});

app.get("/api/account/:email", (req, res) => {
  const { email } = req.params;
  db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Database error", error: err.message });
    }
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, user });
  });
});

app.post("/api/complaints", (req, res) => {
  const { user_email, title, category, location, description, priority, photo } = req.body;

  if (!user_email || !title || !category || !location || !description) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  db.get("SELECT id FROM users WHERE email = ?", [user_email], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Database error", error: err.message });
    }
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found. Please create an account first." });
    }

    const complaintID = "CMP-" + Math.floor(100000 + Math.random() * 900000);
    let photoBuffer = null;
    if (photo) {
      try {
        photoBuffer = Buffer.from(photo, "base64");
      } catch (e) {
        console.error("Photo conversion error:", e);
      }
    }

    db.run(
      `INSERT INTO complaints (complaint_id, user_id, title, category, location, description, priority, photo, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
      [complaintID, user.id, title, category, location, description, priority || "Normal", photoBuffer],
      function (err) {
        if (err) {
          return res.status(500).json({ success: false, message: "Insert error", error: err.message });
        }

        db.run(
          `INSERT INTO status_history (complaint_id, new_status, remarks)
           VALUES (?, 'Submitted', 'Complaint submitted by user')`,
          [this.lastID],
          (error) => { if (error) console.error("Status history error:", error); }
        );

        res.json({ success: true, message: "Complaint submitted successfully", complaint_id: complaintID, id: this.lastID });
      }
    );
  });
});

app.get("/api/complaints/:user_email", (req, res) => {
  const { user_email } = req.params;

  db.get("SELECT id FROM users WHERE email = ?", [user_email], (err, user) => {
    if (err) return res.status(500).json({ success: false, message: "Database error", error: err.message });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    db.all(
      `SELECT id, complaint_id, title, category, location, description, priority, status, created_at
       FROM complaints WHERE user_id = ? ORDER BY created_at DESC`,
      [user.id],
      (err, complaints) => {
        if (err) return res.status(500).json({ success: false, message: "Database error", error: err.message });
        res.json({ success: true, complaints });
      }
    );
  });
});

app.get("/api/stats", (req, res) => {
  db.all(
    `SELECT 
      (SELECT COUNT(*) FROM complaints) as total_complaints,
      (SELECT COUNT(*) FROM complaints WHERE status = 'Submitted') as pending,
      (SELECT COUNT(*) FROM complaints WHERE status = 'In Progress') as in_progress,
      (SELECT COUNT(*) FROM complaints WHERE status = 'Resolved') as resolved,
      (SELECT COUNT(*) FROM users) as total_users`,
    (err, stats) => {
      if (err) return res.status(500).json({ success: false, message: "Database error", error: err.message });
      res.json({ success: true, stats: stats[0] });
    }
  );
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});

app.listen(PORT, () => {
  console.log(`Community Complaint Portal running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});

process.on("SIGINT", () => {
  db.close((err) => {
    if (err) console.error("Error closing database:", err);
    else console.log("Database closed");
    process.exit(0);
  });
});
