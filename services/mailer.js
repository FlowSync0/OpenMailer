/**
 * Service d'envoi d'emails
 * Gère l'envoi SMTP, la vérification des emails et le tracking
 */

const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const Handlebars = require('handlebars');
const { db } = require('./database');
const dns = require('dns').promises;
const net = require('net');

// Cache des domaines vérifiés
const domainCache = new Map();

// ============================================
// VÉRIFICATION DES EMAILS
// ============================================

/**
 * Vérifie si un domaine a des enregistrements MX valides
 */
async function checkMX(domain) {
    if (domainCache.has(domain)) return domainCache.get(domain);
    
    try {
        const records = await dns.resolveMx(domain);
        const valid = records && records.length > 0;
        domainCache.set(domain, valid ? records[0].exchange : false);
        return domainCache.get(domain);
    } catch (e) {
        domainCache.set(domain, false);
        return false;
    }
}

/**
 * Vérifie si l'email existe via SMTP (RCPT TO)
 * Note: Beaucoup de serveurs bloquent cette vérification
 */
async function verifyEmailSMTP(email, mxHost) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            socket.destroy();
            resolve('unknown');
        }, 8000);
        
        const socket = net.createConnection(25, mxHost);
        let step = 0;
        
        socket.on('data', (data) => {
            const response = data.toString();
            
            if (step === 0 && response.startsWith('220')) {
                socket.write(`HELO openmailer.local\r\n`);
                step++;
            } else if (step === 1 && response.startsWith('250')) {
                socket.write(`MAIL FROM:<verify@openmailer.local>\r\n`);
                step++;
            } else if (step === 2 && response.startsWith('250')) {
                socket.write(`RCPT TO:<${email}>\r\n`);
                step++;
            } else if (step === 3) {
                clearTimeout(timeout);
                socket.write('QUIT\r\n');
                socket.end();
                
                if (response.startsWith('250') || response.startsWith('251')) {
                    resolve('valid');
                } else if (response.startsWith('550') || response.startsWith('551') || response.startsWith('553')) {
                    resolve('invalid');
                } else {
                    resolve('unknown');
                }
            }
        });
        
        socket.on('error', () => {
            clearTimeout(timeout);
            resolve('unknown');
        });
        
        socket.setTimeout(8000);
    });
}

/**
 * Vérification complète d'un email (MX + SMTP optionnel)
 */
async function verifyEmail(email) {
    const domain = email.split('@')[1];
    if (!domain) return { valid: false, reason: 'invalid_format' };
    
    const mxHost = await checkMX(domain);
    if (!mxHost) {
        return { valid: false, reason: 'no_mx_record' };
    }
    
    const smtpResult = await verifyEmailSMTP(email, mxHost);
    if (smtpResult === 'invalid') {
        return { valid: false, reason: 'smtp_rejected' };
    }
    
    return { valid: true, reason: smtpResult === 'valid' ? 'verified' : 'mx_ok' };
}

// ============================================
// COMPTEUR JOURNALIER
// ============================================

/**
 * Retourne le nombre d'emails envoyés aujourd'hui
 */
function getDailyCount() {
    const today = new Date().toISOString().split('T')[0];
    const result = db.prepare(`
        SELECT COUNT(*) as count FROM emails 
        WHERE date(sent_at) = date(?)
    `).get(today);
    return result ? result.count : 0;
}

// ============================================
// TRANSPORTEUR SMTP
// ============================================

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false, // true pour 465, false pour autres ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
    }
});

// ============================================
// ENVOI D'EMAILS
// ============================================

/**
 * Envoie un email de campagne à un contact
 */
async function sendCampaignEmail(campaign, contact) {
    // Vérifier l'email avant d'envoyer
    console.log(`🔍 Vérification ${contact.email}...`);
    const verification = await verifyEmail(contact.email);
    
    if (!verification.valid) {
        console.log(`⚠️ Email invalide: ${contact.email} (${verification.reason})`);
        db.prepare('UPDATE contacts SET unsubscribed = 1 WHERE id = ?').run(contact.id);
        return false;
    }
    
    const trackingId = uuidv4();
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';

    // Logo avec pixel de tracking intégré
    const trackingLogo = `<img src="${baseUrl}/track/open/${trackingId}" alt="" width="1" height="1" style="display:block;">`;

    // Compiler le template avec Handlebars
    const template = Handlebars.compile(campaign.content);
    const htmlContent = template({
        name: contact.name || '',
        company: contact.company || '',
        email: contact.email,
        unsubscribeUrl: `${baseUrl}/unsubscribe/${trackingId}`,
        trackingLogo: trackingLogo
    });

    const senderName = process.env.SENDER_NAME || 'OpenMailer';
    const senderEmail = process.env.SENDER_EMAIL || process.env.SMTP_USER;

    try {
        await transporter.sendMail({
            from: `"${senderName}" <${senderEmail}>`,
            to: contact.email,
            subject: campaign.subject,
            html: htmlContent,
            headers: {
                'List-Unsubscribe': `<${baseUrl}/unsubscribe/${trackingId}>`
            }
        });

        db.prepare(`
            INSERT INTO emails (campaign_id, contact_id, tracking_id, status, sent_at)
            VALUES (?, ?, ?, 'sent', CURRENT_TIMESTAMP)
        `).run(campaign.id, contact.id, trackingId);

        console.log(`✉️ Email envoyé à ${contact.email}`);
        return true;
    } catch (error) {
        console.error(`❌ Erreur envoi à ${contact.email}:`, error.message);
        return false;
    }
}

/**
 * Envoie un email de test (sans tracking ni enregistrement)
 */
async function sendTestEmail(campaign, testEmail) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    
    const template = Handlebars.compile(campaign.content);
    let htmlContent = template({
        name: 'Test User',
        company: 'Test Company',
        email: testEmail,
        unsubscribeUrl: '#',
        trackingLogo: ''
    });

    // Bandeau de test
    const testBanner = `
        <div style="background: #f97316; color: white; padding: 12px; text-align: center; font-weight: bold; font-family: sans-serif;">
            ⚠️ CECI EST UN EMAIL DE TEST
        </div>
    `;

    htmlContent = testBanner + htmlContent;

    const senderName = process.env.SENDER_NAME || 'OpenMailer';
    const senderEmail = process.env.SENDER_EMAIL || process.env.SMTP_USER;

    try {
        await transporter.sendMail({
            from: `"${senderName}" <${senderEmail}>`,
            to: testEmail,
            subject: `[TEST] ${campaign.subject}`,
            html: htmlContent
        });
        console.log(`🧪 Email de test envoyé à ${testEmail}`);
        return true;
    } catch (error) {
        console.error(`❌ Erreur envoi test:`, error.message);
        return false;
    }
}

module.exports = { 
    sendCampaignEmail, 
    getDailyCount, 
    sendTestEmail, 
    verifyEmail 
};
