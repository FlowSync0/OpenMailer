/**
 * Service de base de données SQLite
 * Utilise le module SQLite natif de Node.js 20+
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// Créer le dossier data s'il n'existe pas
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'mailing.db');
const db = new DatabaseSync(dbPath);

function initDB() {
    db.exec(`
        -- Table des contacts
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT,
            company TEXT,
            unsubscribed INTEGER DEFAULT 0,
            unsubscribed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Table des campagnes
        CREATE TABLE IF NOT EXISTS campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_at DATETIME
        );

        -- Table des emails envoyés (avec tracking)
        CREATE TABLE IF NOT EXISTS emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            tracking_id TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'pending',
            sent_at DATETIME,
            opened_at DATETIME,
            clicked_at DATETIME,
            FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
            FOREIGN KEY (contact_id) REFERENCES contacts(id)
        );

        -- Index pour les performances
        CREATE INDEX IF NOT EXISTS idx_emails_tracking ON emails(tracking_id);
        CREATE INDEX IF NOT EXISTS idx_emails_campaign ON emails(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    `);
    
    console.log('✅ Base de données initialisée');
}

module.exports = { db, initDB };
