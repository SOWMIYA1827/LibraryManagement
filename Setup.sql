-- ============================================
-- Central Library — MySQL Setup Script
-- Run this once before starting the server
-- ============================================

-- Create the database
CREATE DATABASE IF NOT EXISTS library CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE library;

-- members table
CREATE TABLE IF NOT EXISTS members (
    id                VARCHAR(20)  PRIMARY KEY,
    name              VARCHAR(150) NOT NULL,
    email             VARCHAR(150) UNIQUE,
    phone             VARCHAR(30),
    type              ENUM('Student','Faculty','Public','Staff') DEFAULT 'Student',
    membership_expiry DATE,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- users table (admin has member_id = NULL)
CREATE TABLE IF NOT EXISTS users (
    id         INT          AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(80)  UNIQUE NOT NULL,
    password   VARCHAR(255) NOT NULL,
    name       VARCHAR(150) NOT NULL,
    role       ENUM('admin','student','teacher') DEFAULT 'student',
    member_id  VARCHAR(20)  NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
);

-- books table
CREATE TABLE IF NOT EXISTS books (
    id         INT          AUTO_INCREMENT PRIMARY KEY,
    title      VARCHAR(255) NOT NULL,
    author     VARCHAR(150) NOT NULL,
    genre      VARCHAR(80)  DEFAULT 'Other',
    copies     INT          DEFAULT 1,
    available  INT          DEFAULT 1,
    created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- issued_books table
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
);

-- Seed admin user (password: admin123)
-- The server.js bootstrap() will also do this automatically,
-- but you can run it manually here too.
INSERT IGNORE INTO users (username, password, name, role, member_id)
VALUES ('admin', 'admin123', 'Administrator', 'admin', NULL);

SELECT 'Database setup complete!' AS status;