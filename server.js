const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const cors = require("cors");

const app = express();

// Security headers
app.use(helmet());
app.use(limiter);

// CORS
app.use(cors({
    origin: "https://librarymanagement-yzxy.onrender.com", // or your frontend URL
    credentials: true
}));

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const rateLimit = require("express-rate-limit");

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // Maximum 100 requests
});


app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// Session
app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === "production",
            httpOnly: true,
            sameSite: "lax",
            maxAge: 24 * 60 * 60 * 1000
        }
    })
);
// =======================================
// DATABASE CONNECTION
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
const promiseDb = db.promise();

// Borrowing rules
const MIN_LOAN_DAYS = 1;   // earliest a member can choose is tomorrow
const MAX_LOAN_DAYS = 30;  // latest a member can choose is 30 days out
const DEFAULT_LOAN_DAYS = 14;

const bcrypt = require("bcrypt");




// BOOTSTRAP — create tables & seed admin
// =======================================
async function bootstrap() {
    try {
        await promiseDb.execute(`
            CREATE TABLE IF NOT EXISTS members (
                id                VARCHAR(20)  PRIMARY KEY,
                name              VARCHAR(150) NOT NULL,
                email             VARCHAR(150) UNIQUE,
                phone             VARCHAR(30),
                type              ENUM('Student','Faculty','Public','Staff') DEFAULT 'Student',
                membership_expiry DATE,
                created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await promiseDb.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id         INT          AUTO_INCREMENT PRIMARY KEY,
                username   VARCHAR(80)  UNIQUE NOT NULL,
                password   VARCHAR(255) NOT NULL,
                name       VARCHAR(150) NOT NULL,
                role       ENUM('admin','student','teacher') DEFAULT 'student',
                member_id  VARCHAR(20)  NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
            )
        `);

        await promiseDb.execute(`
            CREATE TABLE IF NOT EXISTS books (
                id         INT          AUTO_INCREMENT PRIMARY KEY,
                title      VARCHAR(255) NOT NULL,
                author     VARCHAR(150) NOT NULL,
                genre      VARCHAR(80)  DEFAULT 'Other',
                copies     INT          DEFAULT 1,
                available  INT          DEFAULT 1,
                created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await promiseDb.execute(`
            CREATE TABLE IF NOT EXISTS issued_books (
                id          INT         AUTO_INCREMENT PRIMARY KEY,
                book_id     INT         NOT NULL,
                member_id   VARCHAR(20) NOT NULL,
                issue_date  DATE        NOT NULL,
                return_date DATE        NOT NULL,
                status      ENUM('issued','returned') DEFAULT 'issued',
                created_at  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (book_id)   REFERENCES books(id)   ON DELETE CASCADE,
                FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
            )
        `);

        await promiseDb.execute(`
            CREATE TABLE IF NOT EXISTS borrow_requests (
                id                 INT         AUTO_INCREMENT PRIMARY KEY,
                book_id            INT         NOT NULL,
                member_id          VARCHAR(20) NOT NULL,
                user_id            INT         NOT NULL,
                status             ENUM('pending','approved','rejected') DEFAULT 'pending',
                preferred_due_date DATE        NULL,
                requested_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
                resolved_at        TIMESTAMP   NULL,
                note               VARCHAR(255) NULL,
                FOREIGN KEY (book_id)   REFERENCES books(id)   ON DELETE CASCADE,
                FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
            )
        `);

        // Safety net: add preferred_due_date to pre-existing borrow_requests tables
        // created before this column existed.
        try {
            await promiseDb.execute(
                `ALTER TABLE borrow_requests ADD COLUMN preferred_due_date DATE NULL AFTER status`
            );
            console.log("✅  Added preferred_due_date column to borrow_requests.");
        } catch (alterErr) {
            if (alterErr.code !== "ER_DUP_FIELDNAME") {
                console.error("Column check error:", alterErr.message);
            }
        }

        // Activity history — feeds the "Activity History" panel on the admin dashboard
        await promiseDb.execute(`
            CREATE TABLE IF NOT EXISTS history (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                action_type ENUM('issue','return','request','approve','reject') NOT NULL,
                book_id     INT          NOT NULL,
                book_title  VARCHAR(255) NOT NULL,
                member_id   VARCHAR(20)  NOT NULL,
                member_name VARCHAR(150) NOT NULL,
                member_role ENUM('admin','student','teacher') NULL,
                due_date    DATE         NULL,
                return_date DATE         NULL,
                fine_amount DECIMAL(10,2) NULL,
                note        VARCHAR(255) NULL,
                action_date TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Seed default admin account (plain-text password for demo)
        const [[{ cnt }]] = await promiseDb.execute(
            "SELECT COUNT(*) AS cnt FROM users WHERE username = 'admin'"
        );
        if (cnt === 0) {
            await promiseDb.execute(
                "INSERT INTO users (username, password, name, role, member_id) VALUES ('admin', 'admin123', 'Administrator', 'admin', NULL)"
            );
            console.log("✅  Admin seeded: admin / admin123");
        }

        console.log("✅  Database tables ready.");
    } catch (err) {
        console.error("❌  Bootstrap error:", err.message);
        process.exit(1);
    }
}

db.getConnection((err, connection) => {
    if (err) {
        console.error("❌  Database connection failed:", err.message);
        process.exit(1);
    }
    console.log("✅  MySQL connected");
    connection.release();
    bootstrap();
});

// =======================================
// AUTH MIDDLEWARE
// =======================================
function checkLogin(req, res, next) {
    if (!req.session.userId)
        return res.status(401).json({ success: false, message: "Login required" });
    next();
}

function checkAdmin(req, res, next) {
    if (!req.session.userId)
        return res.status(401).json({ success: false, message: "Login required" });
    if (req.session.role !== "admin")
        return res.status(403).json({ success: false, message: "Admin access required" });
    next();
}

// =======================================
// HISTORY LOGGING HELPER
// =======================================
async function logHistory({
    actionType,
    bookId,
    bookTitle,
    memberId,
    memberName,
    memberRole = null,
    dueDate    = null,
    returnDate = null,
    fineAmount = null,
    note       = null
}) {
    try {
        await promiseDb.execute(
            `INSERT INTO history
                (action_type, book_id, book_title, member_id, member_name, member_role, due_date, return_date, fine_amount, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [actionType, bookId, bookTitle, memberId, memberName, memberRole, dueDate, returnDate, fineAmount, note]
        );
    } catch (err) {
        // History logging must never break the primary action
        console.error("History log error:", err.message);
    }
}

// Small date helper: "YYYY-MM-DD" string, n days from today
function isoDatePlusDays(n) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d.toISOString().split("T")[0];
}

// =======================================
// SIGNUP  (student / teacher only)
// =======================================
app.post("/api/signup", async (req, res) => {
    const { username, password, name, role, email, phone } = req.body;

    if (!username || !password || !name)
        return res.status(400).json({ success: false, message: "Name, username and password are required" });
    if (password.length < 4)
        return res.status(400).json({ success: false, message: "Password must be at least 4 characters" });

    // Only student / teacher roles allowed via self-signup
    const allowedRoles = ["student", "teacher"];
    const finalRole    = allowedRoles.includes(role) ? role : "student";
    const memberType   = finalRole === "teacher" ? "Faculty" : "Student";

    const conn = await promiseDb.getConnection();
    try {
        await conn.beginTransaction();

        const memberId  = "LIB" + Date.now().toString().slice(-6);
        const expiry    = new Date();
        expiry.setFullYear(expiry.getFullYear() + 1);
        const expiryStr = expiry.toISOString().split("T")[0];

        await conn.execute(
            "INSERT INTO members (id, name, email, phone, type, membership_expiry) VALUES (?, ?, ?, ?, ?, ?)",
            [memberId, name, email || null, phone || null, memberType, expiryStr]
        );
        await conn.execute(
            "INSERT INTO users (username, password, name, role, member_id) VALUES (?, ?, ?, ?, ?)",
            [username, password, name, finalRole, memberId]
        );

        await conn.commit();
        res.json({ success: true, memberId, role: finalRole });
    } catch (err) {
        await conn.rollback();
        if (err.code === "ER_DUP_ENTRY")
            return res.status(409).json({ success: false, message: "Username already exists. Please choose another." });
        console.error("Signup error:", err);
        res.status(500).json({ success: false, message: "Signup failed. Please try again." });
    } finally {
        conn.release();
    }
});

// =======================================
// LOGIN  — returns role so frontend can
//          redirect correctly and guard
//          against wrong-tab logins
// =======================================
("/api/login", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password)
        return res.status(400).json({ success: false, message: "Username and password are required" });

    try {
        const [result] = await promiseDb.execute(
            "SELECT * FROM users WHERE username = ? AND password = ?",
            [username, password]
        );

        if (result.length === 0)
            return res.status(401).json({ success: false, message: "Invalid username or password" });

        const user = result[0];

        // Save session
        req.session.userId   = user.id;
        req.session.role     = user.role;
        req.session.username = user.username;
        req.session.name     = user.name;
        req.session.memberId = user.member_id || null;

        res.json({ success: true, role: user.role, name: user.name });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ success: false, message: "Login failed" });
    }
});

// =======================================
// GET CURRENT USER
// =======================================
app.get("/api/me", checkLogin, async (req, res) => {
    try {
        const [rows] = await promiseDb.execute(
            "SELECT id, username, name, role, member_id FROM users WHERE id = ?",
            [req.session.userId]
        );
        if (rows.length === 0)
            return res.status(404).json({ success: false, message: "User not found" });

        const user = rows[0];
        let membership = null;

        if (user.member_id) {
            const [memberRows] = await promiseDb.execute(
                "SELECT id, type, membership_expiry FROM members WHERE id = ?",
                [user.member_id]
            );
            if (memberRows.length) membership = memberRows[0];
        }

        res.json({
            id:        user.id,
            username:  user.username,
            name:      user.name,
            role:      user.role,
            memberId:  user.member_id,
            membership
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Could not fetch user" });
    }
});

// =======================================
// LOGOUT
// =======================================
app.post("/api/logout", checkLogin, (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ success: false, message: "Logout failed" });
        res.clearCookie("connect.sid");
        res.json({ success: true, message: "Logged out successfully" });
    });
});

// =======================================
// BOOKS
// =======================================
app.get("/api/books", checkLogin, async (req, res) => {
    try {
        const [books] = await promiseDb.execute("SELECT * FROM books ORDER BY title");
        res.json(books);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch books" });
    }
});

app.post("/api/books", checkAdmin, async (req, res) => {
    const { title, author, genre, copies } = req.body;
    if (!title || !author)
        return res.status(400).json({ success: false, message: "Title and author are required" });

    const copiesNum = Math.max(1, parseInt(copies) || 1);
    try {
        const [result] = await promiseDb.execute(
            "INSERT INTO books (title, author, genre, copies, available) VALUES (?, ?, ?, ?, ?)",
            [title, author, genre || "Other", copiesNum, copiesNum]
        );
        res.json({ success: true, bookId: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, message: "Unable to add book" });
    }
});

// Delete book — admin only
app.delete("/api/books/:id", checkAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        await promiseDb.execute("DELETE FROM books WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Unable to delete book" });
    }
});

// =======================================
// MEMBERS
// =======================================
app.get("/api/members", checkAdmin, async (req, res) => {
    try {
        const [members] = await promiseDb.execute("SELECT * FROM members ORDER BY name");
        res.json(members);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch members" });
    }
});

app.post("/api/members", checkAdmin, async (req, res) => {
    const { name, email, phone, type, expiry } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "Member name is required" });

    const memberId = "LIB" + Date.now().toString().slice(-6);
    try {
        await promiseDb.execute(
            "INSERT INTO members (id, name, email, phone, type, membership_expiry) VALUES (?, ?, ?, ?, ?, ?)",
            [memberId, name, email || null, phone || null, type || "Public", expiry || null]
        );
        res.json({ success: true, memberId });
    } catch (err) {
        res.status(500).json({ success: false, message: "Unable to add member" });
    }
});

// =======================================
// ISSUED BOOKS — admin: all / user: mine
// =======================================
app.get("/api/issued", checkAdmin, async (req, res) => {
    try {
        const [rows] = await promiseDb.execute(`
            SELECT
                ib.id,
                b.id        AS book_id,
                b.title     AS book_title,
                m.id        AS member_id,
                m.name      AS member_name,
                u.username  AS member_username,
                u.role      AS member_role,
                ib.issue_date,
                ib.return_date AS due_date,
                ib.status
            FROM issued_books ib
            JOIN books   b ON ib.book_id   = b.id
            JOIN members m ON ib.member_id = m.id
            LEFT JOIN users u ON u.member_id = m.id
            WHERE ib.status = 'issued'
            ORDER BY ib.return_date ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch issued books" });
    }
});

// =======================================
// MY MEMBERSHIP
// =======================================
app.get("/api/my-membership", checkLogin, async (req, res) => {
    if (!req.session.memberId) return res.json(null);
    try {
        const [rows] = await promiseDb.execute(
            "SELECT * FROM members WHERE id = ?",
            [req.session.memberId]
        );
        res.json(rows[0] || null);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch membership" });
    }
});

// =======================================
// MY ISSUED BOOKS (student / teacher)
// =======================================
app.get("/api/my-issued", checkLogin, async (req, res) => {
    if (!req.session.memberId) return res.json([]);
    try {
        const [rows] = await promiseDb.execute(`
            SELECT
                ib.id,
                b.id     AS book_id,
                b.title  AS book_title,
                b.author AS book_author,
                ib.issue_date,
                ib.return_date AS due_date,
                ib.status
            FROM issued_books ib
            JOIN books b ON ib.book_id = b.id
            WHERE ib.member_id = ? AND ib.status = 'issued'
            ORDER BY ib.return_date ASC
        `, [req.session.memberId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch your issued books" });
    }
});

// =======================================
// ISSUE BOOK — admin only (direct issue)
// =======================================
app.post("/api/issue", checkAdmin, async (req, res) => {
    const { bookId, memberId, issueDate, dueDate } = req.body;
    if (!bookId || !memberId)
        return res.status(400).json({ success: false, message: "Book and member are required" });

    try {
        const [[book]] = await promiseDb.execute("SELECT title, available FROM books WHERE id = ?", [bookId]);
        if (!book || book.available <= 0)
            return res.status(400).json({ success: false, message: "Book is not available" });

        const [[member]] = await promiseDb.execute("SELECT name FROM members WHERE id = ?", [memberId]);
        const [userRows] = await promiseDb.execute("SELECT role FROM users WHERE member_id = ? LIMIT 1", [memberId]);
        const userRow = userRows[0] || null;

        await promiseDb.execute(
            "INSERT INTO issued_books (book_id, member_id, issue_date, return_date, status) VALUES (?, ?, ?, ?, 'issued')",
            [bookId, memberId, issueDate, dueDate]
        );
        await promiseDb.execute("UPDATE books SET available = available - 1 WHERE id = ?", [bookId]);

        await logHistory({
            actionType: "issue",
            bookId,
            bookTitle: book.title,
            memberId,
            memberName: member ? member.name : memberId,
            memberRole: userRow ? userRow.role : null,
            dueDate: dueDate
        });

        res.json({ success: true, message: "Book issued successfully" });
    } catch (err) {
        console.error("Issue error:", err);
        res.status(500).json({ success: false, message: "Unable to issue book" });
    }
});

// =======================================
// RETURN BOOK — admin only
// =======================================
app.post("/api/return/:id", checkAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const returnDateInput = req.body.returnDate || new Date().toISOString().split("T")[0];

    try {
        const [rows] = await promiseDb.execute(`
            SELECT ib.*, b.title AS book_title, m.name AS member_name
            FROM issued_books ib
            JOIN books   b ON ib.book_id   = b.id
            JOIN members m ON ib.member_id = m.id
            WHERE ib.id = ? AND ib.status = 'issued'
        `, [id]);

        if (rows.length === 0)
            return res.status(404).json({ success: false, message: "Record not found" });

        const record = rows[0];
        const bookId = record.book_id;

        // Fine: ₹2/day overdue, based on the due date stored on the issued_books record
        const dueDate    = new Date(record.return_date);
        const actualDate = new Date(returnDateInput);
        const daysLate   = Math.max(0, Math.ceil((actualDate - dueDate) / 86400000));
        const fineAmount = daysLate * 2;

        const [userRows] = await promiseDb.execute(
            "SELECT role FROM users WHERE member_id = ? LIMIT 1", [record.member_id]
        );
        const memberRole = userRows.length ? userRows[0].role : null;

        await promiseDb.execute("UPDATE issued_books SET status = 'returned' WHERE id = ?", [id]);
        await promiseDb.execute("UPDATE books SET available = available + 1 WHERE id = ?", [bookId]);

        await logHistory({
            actionType: "return",
            bookId,
            bookTitle: record.book_title,
            memberId: record.member_id,
            memberName: record.member_name,
            memberRole,
            dueDate: record.return_date,
            returnDate: returnDateInput,
            fineAmount,
            note: "Returned via librarian desk"
        });

        res.json({ success: true, message: "Book returned successfully", fine: fineAmount });
    } catch (err) {
        console.error("Return error:", err);
        res.status(500).json({ success: false, message: "Unable to return book" });
    }
});

// =======================================
// SELF-SERVICE RETURN — student / teacher
// Lets a member return their own borrowed
// book straight from their dashboard. The
// record disappears from "My Borrowed
// Books" and shows up immediately in the
// admin's Activity History / stats.
// =======================================
app.post("/api/my-return/:id", checkLogin, async (req, res) => {
    if (req.session.role === "admin")
        return res.status(403).json({ success: false, message: "Admins return books from the librarian desk." });

    const id       = parseInt(req.params.id);
    const memberId = req.session.memberId;
    if (!memberId)
        return res.status(400).json({ success: false, message: "No membership found for your account" });

    try {
        const [rows] = await promiseDb.execute(`
            SELECT ib.*, b.title AS book_title
            FROM issued_books ib
            JOIN books b ON ib.book_id = b.id
            WHERE ib.id = ? AND ib.member_id = ? AND ib.status = 'issued'
        `, [id, memberId]);

        if (rows.length === 0)
            return res.status(404).json({ success: false, message: "This book isn't in your borrowed list" });

        const record = rows[0];
        const bookId = record.book_id;
        const returnDateInput = new Date().toISOString().split("T")[0];

        const dueDate    = new Date(record.return_date);
        const actualDate = new Date(returnDateInput);
        const daysLate   = Math.max(0, Math.ceil((actualDate - dueDate) / 86400000));
        const fineAmount = daysLate * 2;

        await promiseDb.execute("UPDATE issued_books SET status = 'returned' WHERE id = ?", [id]);
        await promiseDb.execute("UPDATE books SET available = available + 1 WHERE id = ?", [bookId]);

        await logHistory({
            actionType: "return",
            bookId,
            bookTitle: record.book_title,
            memberId,
            memberName: req.session.name,
            memberRole: req.session.role,
            dueDate: record.return_date,
            returnDate: returnDateInput,
            fineAmount,
            note: "Self-returned by member"
        });

        res.json({ success: true, message: "Thanks! Your return has been recorded.", fine: fineAmount });
    } catch (err) {
        console.error("Self-return error:", err);
        res.status(500).json({ success: false, message: "Unable to return book" });
    }
});

// =======================================
// BORROW REQUEST — student / teacher
// Member picks their own preferred due
// date (within MIN_LOAN_DAYS..MAX_LOAN_DAYS).
// The librarian still approves the request;
// on approval the preferred date is used
// as the due date unless the admin overrides it.
// =======================================
app.post("/api/borrow-request", checkLogin, async (req, res) => {
    if (req.session.role === "admin")
        return res.status(403).json({ success: false, message: "Admins issue books directly." });

    const { bookId, dueDate } = req.body;
    const memberId = req.session.memberId;
    const userId   = req.session.userId;

    if (!bookId)    return res.status(400).json({ success: false, message: "Book ID is required" });
    if (!memberId)  return res.status(400).json({ success: false, message: "No membership found for your account" });

    // Validate the member's preferred return date, if supplied
    let preferredDueDate = null;
    if (dueDate) {
        const earliest = isoDatePlusDays(MIN_LOAN_DAYS);
        const latest   = isoDatePlusDays(MAX_LOAN_DAYS);
        if (dueDate < earliest || dueDate > latest) {
            return res.status(400).json({
                success: false,
                message: `Please choose a return date between ${earliest} and ${latest}.`
            });
        }
        preferredDueDate = dueDate;
    } else {
        preferredDueDate = isoDatePlusDays(DEFAULT_LOAN_DAYS);
    }

    try {
        const [[book]] = await promiseDb.execute("SELECT * FROM books WHERE id = ?", [bookId]);
        if (!book)               return res.status(404).json({ success: false, message: "Book not found" });
        if (book.available <= 0) return res.status(400).json({ success: false, message: "This book is currently not available" });

        const [existing] = await promiseDb.execute(
            "SELECT id FROM borrow_requests WHERE book_id = ? AND member_id = ? AND status = 'pending'",
            [bookId, memberId]
        );
        if (existing.length > 0)
            return res.status(409).json({ success: false, message: "You already have a pending request for this book" });

        await promiseDb.execute(
            "INSERT INTO borrow_requests (book_id, member_id, user_id, status, preferred_due_date) VALUES (?, ?, ?, 'pending', ?)",
            [bookId, memberId, userId, preferredDueDate]
        );

        await logHistory({
            actionType: "request",
            bookId,
            bookTitle: book.title,
            memberId,
            memberName: req.session.name,
            memberRole: req.session.role,
            dueDate: preferredDueDate,
            note: `Requested return by ${preferredDueDate}`
        });

        res.json({ success: true, message: "Borrow request submitted! The librarian will review it shortly." });
    } catch (err) {
        console.error("Borrow request error:", err);
        res.status(500).json({ success: false, message: "Failed to submit request" });
    }
});

// =======================================
// MY BORROW REQUESTS — student / teacher
// =======================================
app.get("/api/my-borrow-requests", checkLogin, async (req, res) => {
    if (!req.session.memberId) return res.json([]);
    try {
        const [rows] = await promiseDb.execute(`
            SELECT
                br.id,
                b.id     AS book_id,
                b.title  AS book_title,
                b.author AS book_author,
                br.status,
                br.preferred_due_date,
                br.requested_at,
                br.resolved_at,
                br.note
            FROM borrow_requests br
            JOIN books b ON br.book_id = b.id
            WHERE br.member_id = ?
            ORDER BY br.requested_at DESC
            LIMIT 20
        `, [req.session.memberId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch borrow requests" });
    }
});

// =======================================
// ALL BORROW REQUESTS — admin
// =======================================
app.get("/api/borrow-requests", checkAdmin, async (req, res) => {
    try {
        const [rows] = await promiseDb.execute(`
            SELECT
                br.id,
                b.id        AS book_id,
                b.title     AS book_title,
                b.author    AS book_author,
                b.available AS book_available,
                m.id        AS member_id,
                m.name      AS member_name,
                m.type      AS member_type,
                u.username  AS member_username,
                u.role      AS member_role,
                br.status,
                br.preferred_due_date,
                br.requested_at,
                br.resolved_at,
                br.note
            FROM borrow_requests br
            JOIN books   b ON br.book_id   = b.id
            JOIN members m ON br.member_id = m.id
            JOIN users   u ON br.user_id   = u.id
            ORDER BY
                CASE br.status WHEN 'pending' THEN 0 ELSE 1 END,
                br.requested_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Unable to fetch borrow requests" });
    }
});

// =======================================
// APPROVE BORROW REQUEST — admin
// Defaults the issued book's due date to
// whatever the member originally requested;
// the admin can still override via dueDate.
// =======================================
app.post("/api/borrow-requests/:id/approve", checkAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { dueDate } = req.body;

    const conn = await promiseDb.getConnection();
    try {
        await conn.beginTransaction();

        const [[request]] = await conn.execute(
            "SELECT * FROM borrow_requests WHERE id = ? AND status = 'pending'", [id]
        );
        if (!request) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: "Request not found or already resolved" });
        }

        const [[book]] = await conn.execute("SELECT title, available FROM books WHERE id = ?", [request.book_id]);
        if (!book || book.available <= 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, message: "Book is no longer available" });
        }

        const [[member]] = await conn.execute("SELECT name FROM members WHERE id = ?", [request.member_id]);
        const [[userRow]] = await conn.execute("SELECT role FROM users WHERE id = ?", [request.user_id]);

        const today = new Date().toISOString().split("T")[0];
        const due   = dueDate || request.preferred_due_date || isoDatePlusDays(DEFAULT_LOAN_DAYS);

        await conn.execute(
            "INSERT INTO issued_books (book_id, member_id, issue_date, return_date, status) VALUES (?, ?, ?, ?, 'issued')",
            [request.book_id, request.member_id, today, due]
        );
        await conn.execute("UPDATE books SET available = available - 1 WHERE id = ?", [request.book_id]);
        await conn.execute(
            "UPDATE borrow_requests SET status = 'approved', resolved_at = NOW() WHERE id = ?", [id]
        );

        await conn.commit();

        await logHistory({
            actionType: "approve",
            bookId: request.book_id,
            bookTitle: book.title,
            memberId: request.member_id,
            memberName: member ? member.name : request.member_id,
            memberRole: userRow ? userRow.role : null,
            dueDate: due
        });

        res.json({ success: true, message: "Request approved and book issued." });
    } catch (err) {
        await conn.rollback();
        console.error("Approve error:", err);
        res.status(500).json({ success: false, message: "Failed to approve request" });
    } finally {
        conn.release();
    }
});

// =======================================
// REJECT BORROW REQUEST — admin
// =======================================
app.post("/api/borrow-requests/:id/reject", checkAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { note } = req.body;
    try {
        const [rows] = await promiseDb.execute(
            "SELECT * FROM borrow_requests WHERE id = ? AND status = 'pending'", [id]
        );
        if (rows.length === 0)
            return res.status(404).json({ success: false, message: "Request not found or already resolved" });

        const request = rows[0];

        const [[book]]   = await promiseDb.execute("SELECT title FROM books WHERE id = ?", [request.book_id]);
        const [[member]] = await promiseDb.execute("SELECT name FROM members WHERE id = ?", [request.member_id]);
        const [[userRow]] = await promiseDb.execute("SELECT role FROM users WHERE id = ?", [request.user_id]);

        await promiseDb.execute(
            "UPDATE borrow_requests SET status = 'rejected', resolved_at = NOW(), note = ? WHERE id = ?",
            [note || null, id]
        );

        await logHistory({
            actionType: "reject",
            bookId: request.book_id,
            bookTitle: book ? book.title : "Unknown",
            memberId: request.member_id,
            memberName: member ? member.name : request.member_id,
            memberRole: userRow ? userRow.role : null,
            note: note || null
        });

        res.json({ success: true, message: "Request rejected." });
    } catch (err) {
        console.error("Reject error:", err);
        res.status(500).json({ success: false, message: "Failed to reject request" });
    }
});

// =======================================
// ACTIVITY HISTORY — admin
// =======================================
app.get("/api/history", checkAdmin, async (req, res) => {
    try {
        const [rows] = await promiseDb.execute(`
            SELECT
                id,
                action_type,
                book_id,
                book_title,
                member_id,
                member_name,
                member_role,
                due_date,
                return_date,
                fine_amount,
                note,
                action_date
            FROM history
            ORDER BY action_date DESC
            LIMIT 500
        `);
        res.json(rows);
    } catch (err) {
        console.error("History fetch error:", err);
        res.status(500).json({ error: "Unable to fetch history" });
    }
});

// =======================================
// SEARCH (login required)
// =======================================
app.get("/api/search", checkLogin, async (req, res) => {
    try {
        const q = "%" + (req.query.q || "") + "%";
        const [books] = await promiseDb.execute(
            "SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY title", [q, q]
        );
        res.json(books);
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

// =======================================
// STATS
// =======================================
app.get("/api/stats", checkLogin, async (req, res) => {
    try {
        const [[books]]   = await promiseDb.execute(
            "SELECT COUNT(*) AS totalBooks, COALESCE(SUM(available),0) AS availableBooks FROM books"
        );
        const [[members]] = await promiseDb.execute("SELECT COUNT(*) AS totalMembers FROM members");
        const [[issued]]  = await promiseDb.execute("SELECT COUNT(*) AS issuedBooks FROM issued_books WHERE status = 'issued'");
        const [[pending]] = await promiseDb.execute("SELECT COUNT(*) AS pendingRequests FROM borrow_requests WHERE status = 'pending'");

        res.json({
            totalBooks:      books.totalBooks      || 0,
            availableBooks:  books.availableBooks  || 0,
            totalMembers:    members.totalMembers  || 0,
            issuedBooks:     issued.issuedBooks    || 0,
            pendingRequests: pending.pendingRequests || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =======================================
// STATIC FILES
// =======================================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =======================================
// START
// =======================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀  Server → http://localhost:${PORT}`);
    console.log(`    Admin: admin / admin123\n`);
});
