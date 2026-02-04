require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { initDB, db } = require('./services/database');
const { sendCampaignEmail, getDailyCount, sendTestEmail } = require('./services/mailer');
const { parseCSV } = require('./services/csvParser');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialiser la base de données
initDB();

// ============================================
// PAGES
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Page de confirmation de désinscription
app.get('/unsubscribed', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Désinscription confirmée</title>
            <style>
                body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f4; }
                .card { background: white; padding: 48px; border-radius: 16px; text-align: center; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #10b981; margin-bottom: 16px; }
                p { color: #57534e; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>✓ Désinscription confirmée</h1>
                <p>Vous ne recevrez plus d'emails de notre part.</p>
            </div>
        </body>
        </html>
    `);
});

// ============================================
// API - SETTINGS
// ============================================

// Store settings in a simple JSON file
const fs = require('fs');
const settingsPath = path.join(__dirname, 'data', 'settings.json');

function getSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
    } catch (e) {}
    return { dailyLimit: parseInt(process.env.DAILY_LIMIT) || 50 };
}

function saveSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

app.get('/api/settings', (req, res) => {
    res.json(getSettings());
});

app.post('/api/settings', (req, res) => {
    const { dailyLimit } = req.body;
    if (!dailyLimit || dailyLimit < 1 || dailyLimit > 500) {
        return res.status(400).json({ error: 'Limite invalide (1-500)' });
    }
    const settings = getSettings();
    settings.dailyLimit = dailyLimit;
    saveSettings(settings);
    res.json({ success: true });
});

// Helper to get current daily limit (from settings or env)
function getDailyLimit() {
    return getSettings().dailyLimit;
}

// ============================================
// API - STATS
// ============================================

app.get('/api/stats', (req, res) => {
    const stats = {
        dailySent: getDailyCount(),
        dailyLimit: getDailyLimit(),
        totalSent: db.prepare('SELECT COUNT(*) as count FROM emails WHERE status = ?').get('sent').count,
        totalOpened: db.prepare('SELECT COUNT(*) as count FROM emails WHERE opened_at IS NOT NULL').get().count,
        totalClicked: db.prepare('SELECT COUNT(*) as count FROM emails WHERE clicked_at IS NOT NULL').get().count,
        totalUnsubscribed: db.prepare('SELECT COUNT(*) as count FROM contacts WHERE unsubscribed = 1').get().count
    };
    res.json(stats);
});

// ============================================
// API - CAMPAGNES
// ============================================

app.get('/api/campaigns', (req, res) => {
    const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    res.json(campaigns);
});

app.get('/api/campaigns/:id', (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });
    res.json(campaign);
});

app.post('/api/campaigns', (req, res) => {
    const { name, subject, content } = req.body;
    const result = db.prepare('INSERT INTO campaigns (name, subject, content) VALUES (?, ?, ?)').run(name, subject, content);
    res.json({ id: result.lastInsertRowid });
});

app.get('/api/campaigns/:id/pending', (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const pending = db.prepare(`
        SELECT c.* FROM contacts c 
        WHERE c.unsubscribed = 0 
        AND c.id NOT IN (SELECT contact_id FROM emails WHERE campaign_id = ?)
    `).all(campaign.id);

    res.json({ count: pending.length, contacts: pending });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const dailyLimit = getDailyLimit();
    
    if (getDailyCount() >= dailyLimit) {
        return res.status(429).json({ error: 'Limite journalière atteinte', sent: 0 });
    }

    const newContacts = db.prepare(`
        SELECT c.* FROM contacts c 
        WHERE c.unsubscribed = 0 
        AND c.id NOT IN (SELECT contact_id FROM emails WHERE campaign_id = ?)
    `).all(campaign.id);

    let sent = 0;
    
    for (const contact of newContacts) {
        if (getDailyCount() >= dailyLimit) break;
        const success = await sendCampaignEmail(campaign, contact);
        if (success) sent++;
    }

    res.json({ sent, remaining: dailyLimit - getDailyCount(), total: newContacts.length });
});

app.get('/api/campaigns/:id/preview', (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).send('Campagne non trouvée');
    
    const Handlebars = require('handlebars');
    const template = Handlebars.compile(campaign.content);
    
    let html = template({
        name: 'Jean Dupont',
        company: 'Entreprise Example',
        email: 'exemple@email.com',
        unsubscribeUrl: '#',
        trackingLogo: '<img src="https://via.placeholder.com/120x40?text=Logo" alt="Logo" width="120">'
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Aperçu: ${campaign.subject}</title></head>
        <body style="margin: 0; padding: 20px; background: #f0f0f0;">
            <div style="max-width: 700px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <div style="background: #1c1917; color: white; padding: 15px 20px;">
                    <strong>Objet:</strong> ${campaign.subject}
                </div>
                ${html}
            </div>
        </body>
        </html>
    `);
});

app.post('/api/campaigns/:id/test', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });
    
    const success = await sendTestEmail(campaign, email);
    res.json(success ? { success: true } : { error: 'Échec de l\'envoi' });
});

app.get('/api/campaigns/:id/not-opened', (req, res) => {
    const contacts = db.prepare(`
        SELECT c.*, e.sent_at
        FROM emails e 
        JOIN contacts c ON e.contact_id = c.id 
        WHERE e.campaign_id = ? AND e.opened_at IS NULL AND c.unsubscribed = 0
    `).all(req.params.id);
    res.json(contacts);
});

app.post('/api/campaigns/:id/resend-unopened', async (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne non trouvée' });

    const dailyLimit = getDailyLimit();
    
    if (getDailyCount() >= dailyLimit) {
        return res.status(429).json({ error: 'Limite journalière atteinte', sent: 0 });
    }

    const notOpened = db.prepare(`
        SELECT c.* FROM emails e 
        JOIN contacts c ON e.contact_id = c.id 
        WHERE e.campaign_id = ? AND e.opened_at IS NULL AND c.unsubscribed = 0
    `).all(req.params.id);

    const deleteOld = db.prepare('DELETE FROM emails WHERE campaign_id = ? AND contact_id = ?');
    
    let sent = 0;
    for (const contact of notOpened) {
        if (getDailyCount() >= dailyLimit) break;
        deleteOld.run(campaign.id, contact.id);
        const success = await sendCampaignEmail(campaign, contact);
        if (success) sent++;
    }

    res.json({ sent, total: notOpened.length, remaining: dailyLimit - getDailyCount() });
});

// ============================================
// API - CONTACTS
// ============================================

app.get('/api/contacts', (req, res) => {
    const contacts = db.prepare('SELECT * FROM contacts WHERE unsubscribed = 0 ORDER BY created_at DESC').all();
    res.json(contacts);
});

app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
    try {
        const contacts = await parseCSV(req.file.path);
        const insert = db.prepare('INSERT OR IGNORE INTO contacts (email, name, company) VALUES (?, ?, ?)');
        let imported = 0;
        for (const contact of contacts) {
            const result = insert.run(contact.email, contact.name || '', contact.company || '');
            if (result.changes > 0) imported++;
        }
        res.json({ imported, total: contacts.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API - TRACKING
// ============================================

app.get('/api/tracking-details', (req, res) => {
    const emails = db.prepare(`
        SELECT e.*, c.email, c.name, c.company
        FROM emails e 
        JOIN contacts c ON e.contact_id = c.id 
        ORDER BY e.sent_at DESC
    `).all();
    res.json(emails);
});

// ============================================
// TRACKING ENDPOINTS
// ============================================

// Pixel d'ouverture (retourne une image 1x1 transparente)
app.get('/track/open/:trackingId', (req, res) => {
    const { trackingId } = req.params;
    
    // Enregistrer l'ouverture (seulement la première fois)
    db.prepare('UPDATE emails SET opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP) WHERE tracking_id = ?').run(trackingId);
    
    // Retourner un pixel transparent GIF 1x1
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(pixel);
});

// Tracking des clics (redirige vers l'URL cible)
app.get('/track/click/:trackingId', (req, res) => {
    const { trackingId } = req.params;
    const { url } = req.query;
    
    db.prepare('UPDATE emails SET clicked_at = COALESCE(clicked_at, CURRENT_TIMESTAMP) WHERE tracking_id = ?').run(trackingId);
    
    res.redirect(url || process.env.BASE_URL || '/');
});

// Désinscription
app.get('/unsubscribe/:trackingId', (req, res) => {
    const { trackingId } = req.params;
    const email = db.prepare('SELECT contact_id FROM emails WHERE tracking_id = ?').get(trackingId);
    
    if (email) {
        db.prepare('UPDATE contacts SET unsubscribed = 1, unsubscribed_at = CURRENT_TIMESTAMP WHERE id = ?').run(email.contact_id);
    }
    
    res.redirect('/unsubscribed');
});

// ============================================
// DÉMARRAGE
// ============================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════╗
║                                           ║
║   📧 OpenMailer v1.0.0                    ║
║                                           ║
║   → http://localhost:${PORT}                ║
║                                           ║
║   Limite journalière: ${process.env.DAILY_LIMIT || 50} emails          ║
║                                           ║
╚═══════════════════════════════════════════╝
    `);
});
