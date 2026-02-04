/**
 * Service de parsing CSV
 * Importe les contacts depuis un fichier CSV
 */

const fs = require('fs');
const csv = require('csv-parser');

/**
 * Parse un fichier CSV et retourne les contacts
 * Reconnaît automatiquement différents noms de colonnes
 */
function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                // Chercher la colonne email (flexible sur le nom)
                const email = row.email || row.Email || row.EMAIL || 
                              row.mail || row.Mail || row.MAIL ||
                              row.e_mail || row['e-mail'] || row['E-mail'];
                
                if (email && email.includes('@')) {
                    results.push({
                        email: email.trim().toLowerCase(),
                        name: row.name || row.Name || row.NAME ||
                              row.nom || row.Nom || row.NOM ||
                              row.prenom || row.Prenom || row.PRENOM ||
                              row.firstname || row.Firstname ||
                              '',
                        company: row.company || row.Company || row.COMPANY ||
                                 row.entreprise || row.Entreprise || row.ENTREPRISE ||
                                 row.societe || row.Societe || row.SOCIETE ||
                                 row.organization || row.Organisation ||
                                 ''
                    });
                }
            })
            .on('end', () => {
                // Supprimer le fichier temporaire
                fs.unlinkSync(filePath);
                resolve(results);
            })
            .on('error', reject);
    });
}

module.exports = { parseCSV };
