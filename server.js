const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const sqlite3 = require('sqlite3').verbose();
const bwipjs = require('bwip-js'); 

process.on('uncaughtException', (err) => { console.error('CRITICAL ERROR:', err); });
process.on('unhandledRejection', (reason, p) => { console.error('UNHANDLED REJECTION:', reason); });

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const dbFile = './school_portal.db';
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database opening error: ', err.message);
    else console.log('Connected to SQLite Database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS students (
        student_id TEXT PRIMARY KEY, password TEXT, name TEXT, mother_name TEXT,
        gender TEXT, age INTEGER, phone TEXT, emergency_phone TEXT, region TEXT, zone TEXT,
        woreda TEXT, kebele TEXT, class_level TEXT, payment_type TEXT,
        bank_slip_val TEXT, photo TEXT, status TEXT, admin_message TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pending_students (
        id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, password TEXT, name TEXT, mother_name TEXT,
        gender TEXT, age INTEGER, phone TEXT, emergency_phone TEXT, region TEXT,
        zone TEXT, woreda TEXT, kebele TEXT, class_level TEXT, payment_type TEXT,
        bank_slip_val TEXT, photo TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS teachers (
        id TEXT PRIMARY KEY, name TEXT, password TEXT, phone TEXT, assigned_sections TEXT, assigned_grades TEXT, is_proctor INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS assessments (
        student_id TEXT PRIMARY KEY, quiz REAL, mid REAL, final REAL, total REAL, remark TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, reason TEXT, details TEXT, status TEXT, admin_reply TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, title TEXT, credit_hours INTEGER,
        teacher_id TEXT, teacher_name TEXT, class_level TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, proctor_name TEXT, proctor_phone TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender_role TEXT, sender_name TEXT, target_audience TEXT, message TEXT, created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS absence_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, student_name TEXT, class_level TEXT, reason TEXT, teacher_feedback TEXT, status TEXT, created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, student_name TEXT, class_level TEXT, date TEXT, status TEXT
    )`);

    db.get("SELECT COUNT(*) as count FROM teachers", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO teachers (id, name, password, phone, assigned_sections, assigned_grades, is_proctor) VALUES 
            ('T-101', 'Dr. Teshale Kebede', '123456', '0911001122', 'Grade 1 - Section A', 'Grade 1', 1)`);
        }
    });

    db.get("SELECT COUNT(*) as count FROM sections", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES 
            ('Grade 1 - Section A', 'Dr. Teshale Kebede', '0912345678')`);
        }
    });
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads/')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
    secret: 'school-full-system-session-fix', resave: false, saveUninitialized: true, cookie: { maxAge: 3600000 }
}));

const ADMIN_USER = "amanuel";
const ADMIN_PASS = "1234";

function generateStudentID() { return `ALLS-${Math.floor(1000 + Math.random() * 9000)}`; }
function generateTeacherID() { return `T-${Math.floor(100 + Math.random() * 900)}`; }
function generate4DigitPIN() { return Math.floor(1000 + Math.random() * 9000).toString(); }

function ensureSectionExists(secName) {
    db.run(`INSERT OR IGNORE INTO sections (name, proctor_name, proctor_phone) VALUES (?, '', '')`, [secName]);
}

function assignClassSection(requestedYearLevel, callback) {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
    let checkNext = (index) => {
        if (index >= letters.length) return callback(`${requestedYearLevel} - Section Overflow`);
        let secName = `${requestedYearLevel} - Section ${letters[index]}`;
        db.get(`SELECT COUNT(*) as c FROM students WHERE class_level = ?`, [secName], (err, r1) => {
            db.get(`SELECT COUNT(*) as c FROM pending_students WHERE class_level = ?`, [secName], (err, r2) => {
                let total = (r1 && r1.c ? r1.c : 0) + (r2 && r2.c ? r2.c : 0);
                if (total < 50) { ensureSectionExists(secName); callback(secName); }
                else checkNext(index + 1);
            });
        });
    };
    checkNext(0);
}

function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v).replace(/"/g, '""');
    if (s.search(/("|,|\n)/g) >= 0) s = `"${s}"`;
    return s;
}

function esc(v) { return v === null || v === undefined ? '' : String(v).replace(/"/g, '&quot;'); }

app.get('/', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "🎓 AMANUEL LIGHT AND LIFE SCHOOL", stud: "Student", teach: "Teacher", admin: "Admin/Director",
        id: "ID Number / Username", pass: "Password PIN", btn: "Log In", reg: "📝 New Student Registration",
        forgot: "Forgot your password?", forgotBtn: "🔑 Reset My Password"
    } : {
        title: "🎓 አማኑኤል ብርሃንና ሕይወት ትምህርት ቤት", stud: "ተማሪ (Student)", teach: "መምህር (Teacher)", admin: "ዳይሬክተር/አድሚን (Director/Admin)",
        id: "መታወቂያ ቁጥር (ID)", pass: "የሚስጥር ቁጥር (Password)", btn: "ግባ (Log In)", reg: "📝 አዲስ ተማሪ ምዝገባ",
        forgot: "የይለፍ ቃልዎን ረሱ?", forgotBtn: "🔑 የይለፍ ቃል ዳግም አስጀምር"
    };

    res.send(`
    <!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Amanuel Light and Life School</title>
    <style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .box{max-width:400px; margin:auto; background:white; padding:30px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1); text-align:center;} input,select,button{width:100%; padding:12px; margin-bottom:15px; border-radius:5px; border:1px solid #ccc; font-size:16px;} button{background:#1f4e79; color:white; font-weight:bold; cursor:pointer;} .reg-btn{display:block; background:#27ae60; color:white; padding:12px; text-decoration:none; border-radius:5px; font-weight:bold;}</style>
</head><body>
        <div class="box">
            <div style="text-align:right;"><a href="/?lang=am">አማርኛ</a> | <a href="/?lang=en">English</a></div>
            <img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="width: 100px; height: 100px; display: block; margin: 0 auto 15px; border-radius: 50%;">
            <h2>${t.title}</h2>
            <form action="/login?lang=${lang}" method="POST">
                <select name="role"><option value="student">${t.stud}</option><option value="teacher">${t.teach}</option><option value="admin">${t.admin}</option></select>
                <input type="text" name="username" placeholder="${t.id}" required>
                <input type="password" name="password" placeholder="${t.pass}" required>
                <button type="submit">${t.btn}</button>
            </form>
            <p style="font-size:13px; color:#666;">${t.forgot} <a href="/forgot-password?lang=${lang}">${t.forgotBtn}</a></p><hr>
            <a href="/student-register?lang=${lang}" class="reg-btn">${t.reg}</a>
        </div>
    </body></html>`);
});

app.get('/forgot-password', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "🔑 Reset My Password", desc: "Enter your phone number and your mother's name exactly as you registered them. We'll generate a new password PIN for you.",
        ph: "Phone Number", mom: "Mother's Name", btn: "Reset Password", back: "Back to Login"
    } : {
        title: "🔑 የይለፍ ቃል ዳግም አስጀምር", desc: "በምዝገባ ጊዜ የተጠቀሙበትን ስልክ ቁጥር እና የእናትዎን ስም በትክክል ያስገቡ። አዲስ የይለፍ ቁጥር እናዘጋጅልዎታለን።",
        ph: "ስልክ ቁጥር", mom: "የእናት ስም", btn: "የይለፍ ቃል ዳግም አስጀምር", back: "ወደ መግቢያ ተመለስ"
    };
    res.send(`
    <!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reset Password</title>
    <style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .box{max-width:400px; margin:auto; background:white; padding:30px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1); text-align:center;} input,button{width:100%; padding:12px; margin-bottom:15px; border-radius:5px; border:1px solid #ccc; font-size:16px;} button{background:#8e44ad; color:white; font-weight:bold; cursor:pointer; border:none;}</style>
    </head><body>
        <div class="box">
            <img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="width: 80px; height: 80px; display: block; margin: 0 auto 10px; border-radius: 50%;">
            <h2>${t.title}</h2>
            <p style="color:#666; font-size:14px;">${t.desc}</p>
            <form action="/api/forgot-password?lang=${lang}" method="POST">
                <input type="text" name="phone" placeholder="${t.ph}" required>
                <input type="text" name="mother_name" placeholder="${t.mom}" required>
                <button type="submit">${t.btn}</button>
            </form>
            <a href="/?lang=${lang}">${t.back}</a>
        </div>
    </body></html>`);
});

app.post('/api/forgot-password', (req, res) => {
    const lang = req.query.lang || 'am';
    const { phone, mother_name } = req.body;
    const t = lang === 'en' ? {
        found: "✅ Password Reset!", pinLbl: "Your new Password PIN is:", note: "Use your existing ID Number together with this new PIN to log in.",
        notFound: "❌ No matching account found.", back: "Back"
    } : {
        found: "✅ የይለፍ ቃል ዳግም ተጀምሯል!", pinLbl: "አዲሱ የይለፍ ቁጥርዎ:", note: "ነባሩን መታወቂያ ቁጥርዎን ከዚህ አዲስ ቁጥር ጋር በመጠቀም ይግቡ።",
        notFound: "❌ ተመሳሳይ አካውንት አልተገኘም።", back: "ተመለስ"
    };

    let newPin = generate4DigitPIN();
    db.get(`SELECT student_id FROM students WHERE phone = ? AND mother_name = ?`, [phone, mother_name], (err, s) => {
        if (s) {
            return db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [newPin, s.student_id], () => {
                res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;">
                    <h2 style="color:green;">${t.found}</h2><p>${t.pinLbl} <span style="color:red; font-size:24px; font-weight:bold;">${newPin}</span></p>
                    <p style="color:#666; font-size:14px;">${t.note}</p><br><a href="/?lang=${lang}">${t.back}</a></div>`);
            });
        }
        db.get(`SELECT id FROM pending_students WHERE phone = ? AND mother_name = ?`, [phone, mother_name], (err2, p) => {
            if (p) {
                return db.run(`UPDATE pending_students SET password = ? WHERE id = ?`, [newPin, p.id], () => {
                    res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;">
                        <h2 style="color:green;">${t.found}</h2><p>${t.pinLbl} <span style="color:red; font-size:24px; font-weight:bold;">${newPin}</span></p>
                        <p style="color:#666; font-size:14px;">${t.note}</p><br><a href="/?lang=${lang}">${t.back}</a></div>`);
                });
            }
            res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:red;">${t.notFound}</h3><br><a href="/forgot-password?lang=${lang}">${t.back}</a></div>`);
        });
    });
});

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "📝 Student Registration Form", name: "Full Name:", mot: "Mother's Name:",
        gen: "Gender:", m: "Male", f: "Female", age: "Age:", ph: "Phone:", eph: "Emergency:", reg: "Region:",
        zon: "Zone:", wor: "Woreda:", keb: "Kebele:", yr: "Grade Level:",
        pic: "Passport Photo:", pay: "Payment Type:", t1: "Transaction ID", t2: "Upload Slip", btn: "Submit", back: "Back",
        loading: "⏳ Loading... Please wait"
    } : {
        title: "📝 የተማሪዎች ምዝገባ ፎርም", name: "ሙሉ ስም:", mot: "የእናት ስም:",
        gen: "ጾታ:", m: "ወንድ", f: "ሴት", age: "ዕድሜ:", ph: "ስልክ:", eph: "የአደጋ ጊዜ ተጠሪ:", reg: "ክልል:",
        zon: "ዞን:", wor: "ወረዳ:", keb: "ቀበሌ:", yr: "የክፍል ደረጃ (Grade):",
        pic: "ጉርድ ፎቶ:", pay: "የክፍያ ማረጋገጫ:", t1: "የትራንዛክሽን ቁጥር", t2: "የደረሰኝ ፎቶ ያያይዙ", btn: "ምዝገባ ላክ", back: "ተመለስ",
        loading: "⏳ እባክዎ ይጠብቁ... (Loading)"
    };

    let gradeOptions = '';
    for(let i=1; i<=12; i++) {
        gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;
    }

    res.send(`
    <!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Registration</title>
    <style>body{font-family:sans-serif; background:#eef2f5; padding:15px;} .box{max-width:600px; margin:auto; background:white; padding:25px; border-radius:10px;} input,select{width:100%; padding:10px; margin:5px 0 15px; border:1px solid #ccc; border-radius:5px;} .row{display:flex; gap:10px;} .col{flex:1;} button{width:100%; padding:12px; background:#27ae60; color:white; font-weight:bold; border:none; border-radius:5px; cursor:pointer;} button:disabled {background:#95a5a6; cursor:not-allowed;}</style>
    </head><body>
        <div class="box">
            <div style="text-align:right;"><a href="/student-register?lang=am">አማርኛ</a> | <a href="/student-register?lang=en">English</a></div>
            <img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="width: 80px; height: 80px; display: block; margin: 0 auto 10px; border-radius: 50%;">
            <h2>${t.title}</h2>
            <form action="/api/register?lang=${lang}" method="POST" enctype="multipart/form-data" onsubmit="document.getElementById('subBtn').disabled=true; document.getElementById('subBtn').innerText='${t.loading}';">
                
                <div class="row"><div class="col"><label>${t.name}</label><input type="text" name="name" required></div><div class="col"><label>${t.mot}</label><input type="text" name="mother_name" required></div></div>
                <div class="row"><div class="col"><label>${t.gen}</label><select name="gender"><option value="Male">${t.m}</option><option value="Female">${t.f}</option></select></div><div class="col"><label>${t.age}</label><input type="number" name="age" required></div></div>
                <div class="row"><div class="col"><label>${t.ph}</label><input type="text" name="phone" required></div><div class="col"><label>${t.eph}</label><input type="text" name="emergency_phone" required></div></div>
                <div class="row"><div class="col"><label>${t.reg}</label><input type="text" name="region" required></div><div class="col"><label>${t.zon}</label><input type="text" name="zone" required></div></div>
                <div class="row"><div class="col"><label>${t.wor}</label><input type="text" name="woreda" required></div><div class="col"><label>${t.keb}</label><input type="text" name="kebele" required></div></div>
                <label>${t.yr}</label><select name="year_level">${gradeOptions}</select>
                <label>${t.pic}</label><input type="file" name="student_photo" accept="image/*" required>
                <label>${t.pay}</label><select name="payment_type" id="payType" onchange="document.getElementById('slipBox').style.display = this.value=='slip_file'?'block':'none'; document.getElementById('txnBox').style.display = this.value=='txn_id'?'block':'none';">
                    <option value="txn_id">${t.t1}</option><option value="slip_file">${t.t2}</option>
                </select>
                <div id="txnBox"><input type="text" name="txn_id" placeholder="Transaction ID"></div>
                <div id="slipBox" style="display:none;"><input type="file" name="bank_slip_file" accept="image/*,.pdf"></div>
                
                <button type="submit" id="subBtn">${t.btn}</button>
            </form><br><a href="/?lang=${lang}">${t.back}</a>
        </div>
    </body></html>`);
});

app.post('/api/register', upload.fields([{ name: 'student_photo', maxCount: 1 }, { name: 'bank_slip_file', maxCount: 1 }]), (req, res) => {
    const lang = req.query.lang || 'am';
    
    try {
        let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, year_level, payment_type, txn_id } = req.body;
        let autoID = generateStudentID(); 
        let autoPIN = generate4DigitPIN();

        assignClassSection(year_level, (assignedSection) => {
            let photoPath = (req.files && req.files['student_photo']) ? req.files['student_photo'][0].filename : '';
            let slipPath = payment_type === 'slip_file' && (req.files && req.files['bank_slip_file']) ? req.files['bank_slip_file'][0].filename : txn_id;

            db.run(`INSERT INTO pending_students (student_id, password, name, father_name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [autoID, autoPIN, name, '', mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, assignedSection, payment_type, slipPath, photoPath], function(err) {
                
                if (err) {
                    console.error("Database Insert Error:", err);
                    return res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:red;">❌ የዳታቤዝ ስህተት አጋጥሟል። እባክዎ እንደገና ይሞክሩ!</h3><br><a href="/student-register?lang=${lang}">ወደ ኋላ ተመለስ (Back)</a></div>`);
                }

                const t = lang === 'en' ? {
                    sent: "Request Sent!", pending: "Your registration has been sent to the Admin for review. You will be able to log in once approved.",
                    cls: "Class", idL: "ID Number", pinL: "Password PIN"
                } : {
                    sent: "ጥያቄዎ ተልኳል!", pending: "ምዝገባዎ ለአድሚን ገምጋሚ ተልኳል። ሲፈቀድ መግባት ይችላሉ።",
                    cls: "ክፍል", idL: "የመታወቂያ ቁጥር", pinL: "የሚስጥር ቁጥር"
                };
                
                res.send(`
                <div style="text-align:center; padding:40px; font-family:sans-serif;">
                    <h2 style="color:green;">✅ ${t.sent}</h2>
                    <div style="background:#eef2f5; display:inline-block; padding:20px; border-radius:8px; text-align:left;">
                        <p><strong>${t.cls}:</strong> ${assignedSection}</p>
                        <p><strong>${t.idL}:</strong> <span style="color:red; font-size:20px;">${autoID}</span></p>
                        <p><strong>${t.pinL}:</strong> <span style="color:red; font-size:20px;">${autoPIN}</span></p>
                        <p style="color:#e67e22; font-size:13px;">⏳ ${t.pending}</p>
                        <p><a href="/download-pending-slip/${this.lastID}" style="background:#e67e22; color:white; padding:10px; text-decoration:none; border-radius:5px;">📥 Download Full Registration PDF</a></p>
                    </div><br><br><a href="/?lang=${lang}">Home</a>
                </div>`);
            });
        });
    } catch (error) {
        console.error("Registration Processing Error:", error);
        res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:red;">❌ ስህተት ተከስቷል። ፎርሙን በድጋሚ ይሙሉ!</h3><br><a href="/student-register?lang=${lang}">ወደ ኋላ ተመለስ (Back)</a></div>`);
    }
});

app.get('/download-pending-slip/:id', (req, res) => {
    db.get(`SELECT * FROM pending_students WHERE id = ? UNION SELECT * FROM students WHERE student_id = ?`, [req.params.id, req.params.id], (err, st) => {
        if (!st) return res.send('Not found');
        const doc = new PDFDocument({ margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Registration-${st.student_id}.pdf`);
        doc.pipe(res);

        let schoolLogo = path.join(__dirname, 'uploads', 'logo.jpg');
        if (fs.existsSync(schoolLogo)) doc.image(schoolLogo, 40, 20, { width: 40, height: 40 });

        doc.fontSize(18).fillColor('#1f4e79').text('AMANUEL LIGHT AND LIFE SCHOOL', { align: 'center' });
        doc.fontSize(13).fillColor('#333').text('Student Registration Summary', { align: 'center' }).moveDown();
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#ccc').stroke().moveDown();

        let photoFile = path.join(__dirname, 'uploads', st.photo || '');
        let textStartX = 40;
        if (st.photo && fs.existsSync(photoFile)) doc.image(photoFile, 420, doc.y, { width: 110, height: 130 });

        const line = (label, val) => doc.fontSize(11).fillColor('#000').text(`${label}: `, textStartX, doc.y, { continued: true }).fillColor('#333').text(`${val || '-'}`);

        line('ID Number', st.student_id);
        line('Password PIN', st.password);
        line('Full Name', `${st.name || ''}`);
        line('Mother Name', `${st.mother_name || ''}`);
        line('Gender', st.gender);
        line('Age', st.age);
        line('Phone', st.phone);
        line('Emergency Contact', st.emergency_phone);
        line('Region / Zone', `${st.region || ''} / ${st.zone || ''}`);
        line('Woreda / Kebele', `${st.woreda || ''} / ${st.kebele || ''}`);
        line('Grade / Section', st.class_level);
        line('Payment Type', st.payment_type);
        line('Payment Reference', st.bank_slip_val);
        line('Status', st.status || 'Pending Admin Approval');
        doc.moveDown(2);
        doc.fontSize(9).fillColor('#999').text('This document is auto-generated by the Amanuel Light and Life School Digital Portal.', { align: 'center' });
        doc.end();
    });
});

app.post('/login', (req, res) => {
    const lang = req.query.lang || 'am';
    const { role, username, password } = req.body;
    const uKey = username.trim();

    if (role === 'admin' && uKey === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true; return res.redirect(`/admin?lang=${lang}`);
    } else if (role === 'teacher') {
        db.get(`SELECT * FROM teachers WHERE id = ? AND password = ?`, [uKey.toUpperCase(), password], (err, t) => {
            if (t) { req.session.teacherId = t.id; return res.redirect(`/teacher-dashboard?lang=${lang}`); }
            res.send(`<h3 style="color:red; text-align:center; margin-top:50px;">❌ Invalid <a href="/?lang=${lang}">Back</a></h3>`);
        });
    } else if (role === 'student') {
        db.get(`SELECT * FROM students WHERE student_id = ? AND password = ?`, [uKey.toUpperCase(), password], (err, s) => {
            if (s) { req.session.studentId = s.student_id; return res.redirect(`/student-dashboard?lang=${lang}`); }
            res.send(`<h3 style="color:red; text-align:center; margin-top:50px;">❌ Invalid or not approved. <a href="/?lang=${lang}">Back</a></h3>`);
        });
    }
});

// ================= DIRECTOR / ADMIN DASHBOARD =================
app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "Director / Admin Dashboard", sec: "Manage Sections & Class Proctors", pend: "Pending Registrations",
        teach: "Manage All Teachers (Add / Remove / Assign Grades 1-12 & Classes)", courses: "Manage Courses", stud: "All Students",
        noti: "Broadcast Notification", logout: "Logout",
        directorReport: "📁 Director Weekly/Monthly Reports (Sept-May Attendance)"
    } : {
        title: "የዳይሬክተር / አድሚን መቆጣጠሪያ", sec: "ክፍሎችን እና የክፍል ተቆጣጣሪዎችን (Proctors) ማስተዳደሪያ", pend: "አዲስ ተመዝጋቢዎች",
        teach: "ሁሉንም መምህራን ማስተዳደሪያ (Add/Remove/ከ Grade 1-12 መደብ)", courses: "ትምህርቶችን ማስተዳደሪያ", stud: "ሁሉም ተማሪዎች",
        noti: "ማስታወቂያ ላክ", logout: "ውጣ",
        directorReport: "📁 የዳይሬክተር ሳምንታዊ እና ወርሃዊ ሪፖርት (ከሴፕቴምበር እስከ መይ)"
    };

    db.all(`SELECT * FROM pending_students`, [], (err, pending) => {
        db.all(`SELECT * FROM students ORDER BY class_level`, [], (err, students) => {
            db.all(`SELECT * FROM teachers`, [], (err, teachers) => {
                db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections) => {
                    db.all(`SELECT * FROM courses ORDER BY class_level, code`, [], (err, courses) => {

                        let pRows = pending.map(s => `<tr><td><img src="/uploads/${s.photo}" width="30"></td><td>${s.student_id}</td><td>${s.name}</td><td>${s.payment_type}: ${s.bank_slip_val}</td><td><a href="/admin/approve/${s.id}?lang=${lang}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`).join('');

                        let sRows = students.map(s => `<tr>
                            <td>${s.student_id}</td><td>${s.name}</td><td><a href="/class-hub/${encodeURIComponent(s.class_level)}" style="color:#2980b9; font-weight:bold;" target="_blank">📂 ${s.class_level}</a></td><td>${s.phone}</td>
                            <td><span style="color:red; font-weight:bold;">${s.password}</span></td>
                            <td>${s.status || ''}</td>
                            <td><a href="/admin/edit-student/${s.student_id}?lang=${lang}" style="color:#2980b9; font-weight:bold;">✏️ Edit</a></td>
                            <td><form action="/admin/update-pass?lang=${lang}" method="POST" style="display:flex; gap:4px;"><input type="hidden" name="type" value="student"><input type="hidden" name="id" value="${s.student_id}"><input type="text" name="new_pass" placeholder="New PIN" style="width:70px;"><button type="submit">Reset</button></form></td>
                            <td><a href="/admin/delete-student/${s.student_id}?lang=${lang}" onclick="return confirm('Delete this student permanently?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td>
                            </tr>`).join('');

                        let tRows = teachers.map(tc => `<tr>
                            <td>${tc.id}</td><td>${tc.name}</td><td>${tc.assigned_grades || 'None'}</td><td>${tc.assigned_sections || 'None'}</td><td>${tc.phone}</td>
                            <td><span style="color:red; font-weight:bold;">${tc.password}</span></td>
                            <td><a href="/admin/edit-teacher/${tc.id}?lang=${lang}" style="color:#2980b9; font-weight:bold;">✏️ Edit</a></td>
                            <td><a href="/admin/delete-teacher/${tc.id}?lang=${lang}" onclick="return confirm('Remove this teacher permanently?')" style="color:red; font-weight:bold;">🗑️ Remove</a></td>
                            </tr>`).join('');

                        let secRows = sections.map(sec => `<tr>
                            <td><a href="/class-hub/${encodeURIComponent(sec.name)}" style="color:#16a085; font-weight:bold;" target="_blank">📂 ${sec.name}</a></td>
                            <td><form action="/admin/edit-section/${sec.id}?lang=${lang}" method="POST" style="display:flex; gap:4px;">
                                <select name="proctor_name" style="width:140px;">
                                    <option value="${esc(sec.proctor_name)}">${sec.proctor_name || '-- Select Proctor --'}</option>
                                    ${teachers.map(tc => `<option value="${esc(tc.name)}">${tc.name}</option>`).join('')}
                                </select>
                                <button type="submit">Save</button></form></td>
                            <td><a href="/admin/delete-section/${sec.id}?lang=${lang}" onclick="return confirm('Delete this section?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td>
                            <td>
                                <a href="/attendance-sheet/${encodeURIComponent(sec.name)}" style="color:#2980b9; font-weight:bold; margin-right:10px;" target="_blank">📋 Attendance Sheet</a>
                                <a href="/view-excel/${encodeURIComponent(sec.name)}" style="color:#27ae60; font-weight:bold;" target="_blank">📊 Excel Grades</a>
                            </td>
                            </tr>`).join('');

                        let sectionOptions = sections.map(sec => `<option value="${esc(sec.name)}">${sec.name}</option>`).join('');
                        let teacherOptions = teachers.map(tc => `<option value="${tc.id}">${tc.name}</option>`).join('');

                        let gradeCheckboxes = '';
                        for(let i=1; i<=12; i++) {
                            gradeCheckboxes += `<label style="margin-right:8px;"><input type="checkbox" name="grades" value="Grade ${i}"> Grade ${i}</label>`;
                        }

                        let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.class_level}</td><td>${c.teacher_name||'-'}</td>
                            <td><a href="/admin/delete-course/${c.id}?lang=${lang}" onclick="return confirm('Delete this course?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');

                        res.send(`
                        <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Director Hub - Amanuel School</title>
                        <style>body{font-family:sans-serif; background:#eef2f5; padding:20px;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; overflow-x:auto;} table{width:100%; border-collapse:collapse; min-width:600px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#2c3e50; color:white;} .btn{display:inline-block; padding:10px 14px; background:#16a085; color:white; text-decoration:none; border-radius:5px; font-weight:bold; margin-right:10px;} input,select{padding:6px;} textarea{width:100%; padding:10px; border-radius:5px; border:1px solid #ccc; margin-bottom:10px;}</style></head>
                        <body>
                            <div style="text-align:right;"><a href="/admin?lang=am">አማርኛ</a> | <a href="/admin?lang=en">English</a></div>
                            <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;"> 🔐 ${t.title}</h2>

                            <div class="card" style="background:#e8f4fd;">
                                <h3>📢 ${t.noti}</h3>
                                <form action="/admin/send-notification" method="POST">
                                    <textarea name="message" rows="3" placeholder="Write your notification here..." required></textarea>
                                    <button type="submit" style="background:#3498db; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Send Notification</button>
                                </form>
                            </div>

                            <div class="card">
                                <h3>${t.directorReport}</h3>
                                <p style="font-size:13px; color:#555;">ከሴፕቴምበር እስከ መይ (September - May) ያለው የተማሪዎች መገኘት ሪፖርት ለዳይሬክተር ከዚህ በታች ይመልከቱ:</p>
                                <a href="/director-report" target="_blank" style="background:#8e44ad; color:white; padding:10px 15px; text-decoration:none; border-radius:5px; font-weight:bold; display:inline-block;">📁 View Director Academic Year Report (Sept-May)</a>
                            </div>

                            <div class="card"><h3>${t.pend}</h3><table><tr><th>Photo</th><th>ID</th><th>Name</th><th>Payment</th><th>Action</th></tr>${pRows||'<tr><td colspan="5">None</td></tr>'}</table></div>

                            <div class="card">
                                <h3>${t.sec}</h3>
                                <form action="/admin/add-section?lang=${lang}" method="POST" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
                                    <input type="text" name="name" placeholder="Class Name (e.g. Grade 1 - Section A)" required style="flex:2;">
                                    <select name="proctor_name" style="flex:1;">
                                        <option value="">-- Select Proctor Teacher --</option>
                                        ${teachers.map(tc => `<option value="${esc(tc.name)}">${tc.name}</option>`).join('')}
                                    </select>
                                    <button type="submit" style="background:#2980b9; color:white; border:none; padding:8px 14px; border-radius:5px;">➕ Add Section</button>
                                </form>
                                <table><tr><th>Section Name</th><th>Proctor Name (Teacher)</th><th>Delete</th><th>Sheets & Portals</th></tr>${secRows||'<tr><td colspan="4">None</td></tr>'}</table>
                            </div>

                            <div class="card">
                                <h3>${t.teach}</h3>
                                <form action="/admin/add-teacher?lang=${lang}" method="POST" style="margin-bottom:15px; background:#f9f9f9; padding:15px; border-radius:5px;">
                                    <div style="display:flex; gap:10px; margin-bottom:10px;">
                                        <input type="text" name="name" placeholder="Teacher Full Name" required style="flex:1;">
                                        <input type="text" name="phone" placeholder="Phone Number" required style="flex:1;">
                                        <input type="text" name="assigned_sections" placeholder="Assigned Sections (e.g. Grade 1 - Section A)" required style="flex:2;">
                                    </div>
                                    <label style="font-weight:bold; font-size:13px;">Assign Grades (Select 1-12):</label><br>
                                    <div style="margin:8px 0; display:flex; flex-wrap:wrap; gap:10px;">${gradeCheckboxes}</div>
                                    <button type="submit" style="background:#2980b9; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">➕ Add Teacher</button>
                                </form>
                                <table><tr><th>ID</th><th>Name</th><th>Grades (1-12)</th><th>Classes</th><th>Phone</th><th>Password</th><th>Edit</th><th>Remove</th></tr>${tRows||'<tr><td colspan="8">None</td></tr>'}</table>
                            </div>

                            <div class="card">
                                <h3>${t.courses}</h3>
                                <form action="/admin/add-course?lang=${lang}" method="POST" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
                                    <input type="text" name="code" placeholder="Course Code" required>
                                    <input type="text" name="title" placeholder="Course Title" required>
                                    <input type="number" name="credit_hours" placeholder="Cr.Hr" required style="width:80px;">
                                    <select name="class_level">${sectionOptions}</select>
                                    <select name="teacher_id"><option value="">-- No Teacher --</option>${teacherOptions}</select>
                                    <button type="submit" style="background:#2980b9; color:white; border:none; padding:8px 14px; border-radius:5px;">➕ Add Course</button>
                                </form>
                                <table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Section</th><th>Teacher</th><th>Delete</th></tr>${cRows||'<tr><td colspan="6">None</td></tr>'}</table>
                            </div>

                            <div class="card">
                                <h3>${t.stud}</h3>
                                <p><a class="btn" href="/admin/export-students">📊 Export All Students to Excel (CSV)</a></p>
                                <form action="/admin/import-students?lang=${lang}" method="POST" enctype="multipart/form-data" style="margin-bottom:15px;">
                                    <label style="font-weight:bold;">➕ Add Students from Excel/CSV file:</label><br>
                                    <input type="file" name="csv_file" accept=".csv" required style="margin:8px 0;">
                                    <button type="submit" style="padding:8px 14px; background:#2980b9; color:white; border:none; border-radius:5px;">Upload & Add</button>
                                    <p style="font-size:12px; color:#888;">Columns (in order, no header): name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level</p>
                                </form>
                                <table><tr><th>ID</th><th>Name</th><th>Class</th><th>Phone</th><th>Password</th><th>Status</th><th>Edit</th><th>Reset Password</th><th>Delete</th></tr>${sRows||'<tr><td colspan="9">None</td></tr>'}</table>
                            </div>

                            <br><a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 ${t.logout}</a>
                        </body></html>`);
                    });
                });
            });
        });
    });
});

// SINGLE CLICK CLASS HUB FOR DIRECTORS & ADMINS WITH RANKING
app.get('/class-hub/:className', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let className = decodeURIComponent(req.params.className);
    
    db.all(`SELECT s.*, a.total FROM students s LEFT JOIN assessments a ON s.student_id = a.student_id WHERE s.class_level = ? ORDER BY a.total DESC`, [className], (err, students) => {
        db.get(`SELECT * FROM sections WHERE name = ?`, [className], (err, section) => {
            db.all(`SELECT * FROM courses WHERE class_level = ?`, [className], (err, courses) => {
                
                let sRows = students.map((s, idx) => `<tr>
                    <td><b>${idx + 1}</b></td>
                    <td>${s.student_id}</td>
                    <td style="text-align:left;">${s.name}</td>
                    <td>${s.gender}</td>
                    <td>${s.total !== null ? s.total : 'Not Graded'}</td>
                </tr>`).join('');

                let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.teacher_name || 'N/A'}</td></tr>`).join('');

                res.send(`
                <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Class Hub - ${className}</title>
                <style>body{font-family:sans-serif; padding:20px; background:#f4f7f6;} .card{background:white; padding:20px; border-radius:8px; margin-bottom:15px;} table{width:100%; border-collapse:collapse; margin-top:10px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style>
                </head><body>
                    <a href="/admin" style="background:#7f8c8d; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">⬅️ Back to Admin / Director Dashboard</a>
                    <h2>📂 Class Hub: ${className}</h2>
                    <div class="card">
                        <p><strong>Proctor / Attendance Monitor:</strong> ${section ? section.proctor_name : 'N/A'} (${section ? section.proctor_phone : ''})</p>
                        <p><strong>Total Students:</strong> ${students.length}</p>
                        <a href="/attendance-sheet/${encodeURIComponent(className)}" target="_blank" style="background:#2980b9; color:white; padding:8px 12px; text-decoration:none; border-radius:5px; margin-right:10px;">📋 Attendance Sheet</a>
                        <a href="/view-excel/${encodeURIComponent(className)}" target="_blank" style="background:#107c41; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">📊 Excel Grades View</a>
                    </div>
                    <div class="card">
                        <h3>📚 Subjects / Courses for this Class</h3>
                        <table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Teacher</th></tr>${cRows||'<tr><td colspan="4">No courses</td></tr>'}</table>
                    </div>
                    <div class="card">
                        <h3>🏆 Students Ranking List in ${className}</h3>
                        <table><tr><th>Rank</th><th>ID</th><th>Full Name</th><th>Gender</th><th>Total Score</th></tr>${sRows||'<tr><td colspan="5">No students</td></tr>'}</table>
                    </div>
                </body></html>`);
            });
        });
    });
});

app.post('/admin/send-notification', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at) VALUES (?,?,?,?,?)`,
        ['Admin', 'School Admin', 'ALL', req.body.message, new Date().toLocaleString()], () => res.redirect('/admin'));
});

// DAILY ATTENDANCE (MONDAY - FRIDAY) WITH SAVE FUNCTIONALITY
app.get('/attendance-sheet/:secName', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let sec = decodeURIComponent(req.params.secName);
    let selectedDate = req.query.date || new Date().toISOString().split('T')[0];

    db.all(`SELECT * FROM students WHERE class_level = ? ORDER BY name`, [sec], (err, students) => {
        db.all(`SELECT * FROM daily_attendance WHERE class_level = ? AND date = ?`, [sec, selectedDate], (err, records) => {
            
            let attendanceMap = {};
            records.forEach(r => { attendanceMap[r.student_id] = r.status; });

            let rowsHtml = '';
            let totalRows = 50; 
            
            for (let i = 0; i < totalRows; i++) {
                let st = students[i];
                let num = i + 1;
                if (st) {
                    let currentStatus = attendanceMap[st.student_id] || '';
                    rowsHtml += `<tr>
                        <td>${num}</td>
                        <td>${st.student_id}</td>
                        <td style="text-align:left;">${st.name}</td>
                        <td>${st.gender}</td>
                        <td>
                            <label><input type="radio" name="status_${st.student_id}" value="Present" ${currentStatus==='Present'?'checked':''}> ✅ Present</label> &nbsp;
                            <label><input type="radio" name="status_${st.student_id}" value="Absent" ${currentStatus==='Absent'?'checked':''}> ❌ Absent</label>
                        </td>
                    </tr>`;
                } else {
                    rowsHtml += `<tr>
                        <td>${num}</td>
                        <td>&nbsp;</td>
                        <td>&nbsp;</td>
                        <td>&nbsp;</td>
                        <td>-</td>
                    </tr>`;
                }
            }

            res.send(`
            <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Attendance Sheet - ${sec}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background: #fff; }
                .sheet-table { width: 100%; border-collapse: collapse; font-size:13px; }
                .sheet-table th, .sheet-table td { border: 1px solid #000; padding: 6px 10px; text-align: center; height: 25px; }
                .sheet-table th { background: #d9d9d9; color: #000; }
                .header-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px; }
                button { background: #107c41; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight:bold; }
                .save-btn { background: #2980b9; padding: 10px 20px; font-size: 15px; }
                @media print { button, .no-print { display: none; } }
            </style>
            </head><body>
                <div class="header-bar">
                    <div>
                        <h2>AMANUEL LIGHT AND LIFE SCHOOL</h2>
                        <h3>📋 Daily Attendance Sheet (Monday - Friday) - Class: ${sec}</h3>
                    </div>
                    <div class="no-print">
                        <form method="GET" action="/attendance-sheet/${encodeURIComponent(sec)}" style="display:inline-block; margin-right:10px;">
                            <label><b>Select Date:</b></label>
                            <input type="date" name="date" value="${selectedDate}" onchange="this.form.submit()" style="padding:5px;">
                        </form>
                        <button onclick="window.print()">🖨️ Print Sheet</button> <button onclick="window.close()">❌ Close</button>
                    </div>
                </div>

                <form action="/save-attendance" method="POST">
                    <input type="hidden" name="class_level" value="${sec}">
                    <input type="hidden" name="date" value="${selectedDate}">
                    <table class="sheet-table">
                        <tr>
                            <th>No.</th>
                            <th>Student ID</th>
                            <th>Student Full Name</th>
                            <th>Gender</th>
                            <th>Daily Status (✅ Present / ❌ Absent)</th>
                        </tr>
                        ${rowsHtml}
                    </table>
                    <br class="no-print">
                    <div class="no-print" style="text-align:center;">
                        <button type="submit" class="save-btn">💾 Save Attendance</button>
                    </div>
                </form>

                <br><br>
                <div style="display:flex; justify-content:space-between; font-weight:bold;">
                    <p>Teacher's Signature: ______________________</p>
                    <p>Director's Signature (Friday Submit): ______________________</p>
                </div>
            </body></html>`);
        });
    });
});

app.post('/save-attendance', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let { class_level, date } = req.body;

    db.all(`SELECT * FROM students WHERE class_level = ?`, [class_level], (err, students) => {
        if(err) return res.redirect('/teacher-dashboard');

        db.run(`DELETE FROM daily_attendance WHERE class_level = ? AND date = ?`, [class_level, date], () => {
            let stmt = db.prepare(`INSERT INTO daily_attendance (student_id, student_name, class_level, date, status) VALUES (?, ?, ?, ?, ?)`);
            students.forEach(st => {
                let status = req.body[`status_${st.student_id}`] || 'Absent';
                stmt.run(st.student_id, st.name, class_level, date, status);
            });
            stmt.finalize(() => {
                res.send(`<script>alert('Attendance saved successfully!'); window.location.href='/teacher-dashboard';</script>`);
            });
        });
    });
});

app.get('/director-report', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections) => {
        db.all(`SELECT * FROM students ORDER BY class_level`, [], (err, students) => {
            db.all(`SELECT * FROM daily_attendance ORDER BY date DESC`, [], (err, attendanceRecords) => {
                
                const months = ["September", "October", "November", "December", "January", "February", "March", "April", "May"];
                
                let monthSections = months.map(m => {
                    let sectionContent = sections.map(sec => {
                        let classStudents = students.filter(s => s.class_level === sec.name);
                        let studentList = classStudents.map((s, idx) => {
                            let rec = attendanceRecords.find(r => r.student_id === s.student_id);
                            let statusBadge = rec ? (rec.status === 'Present' ? '✅ Present' : '❌ Absent') : 'Not Recorded';
                            return `<tr><td>${idx+1}</td><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td><b>${statusBadge}</b></td></tr>`;
                        }).join('');
                        
                        return `<div style="margin-bottom:20px;">
                            <h4 style="background:#34495e; color:white; padding:6px; margin:0;">Class: ${sec.name}</h4>
                            <table border="1" width="100%" style="border-collapse:collapse; text-align:center; font-size:12px;">
                                <tr style="background:#f2f2f2;"><th>No</th><th>ID</th><th>Full Name</th><th>Attendance Status</th></tr>
                                ${studentList || '<tr><td colspan="4">No students</td></tr>'}
                            </table>
                        </div>`;
                    }).join('');

                    return `<div style="margin-bottom:40px; page-break-after: always;">
                        <h2 style="background:#2c3e50; color:white; padding:10px; text-align:center;">📅 Academic Period / Month: ${m} (September - May)</h2>
                        ${sectionContent}
                    </div>`;
                }).join('');

                res.send(`
                <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Director Academic Year Report (Sept-May)</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; background: white; }
                    table th, table td { border: 1px solid #ccc; padding: 5px; }
                    .header { text-align: center; margin-bottom: 20px; }
                    button { background: #8e44ad; color: white; border: none; padding: 10px 20px; border-radius: 5px; font-weight: bold; cursor: pointer; }
                    @media print { button { display: none; } }
                </style>
                </head><body>
                    <div class="header">
                        <h2>AMANUEL LIGHT AND LIFE SCHOOL</h2>
                        <h3>📁 Director Comprehensive Attendance Report (September to May)</h3>
                        <button onclick="window.print()">🖨️ Print Full Report for Director</button>
                    </div>
                    ${monthSections}
                    <br><br>
                    <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:40px;">
                        <p>Prepared by Registrar / Admin: ___________________</p>
                        <p>Approved & Signed by Director: ___________________</p>
                    </div>
                </body></html>`);
            });
        });
    });
});

app.get('/view-excel/:secName', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let sec = decodeURIComponent(req.params.secName);
    db.all(`SELECT s.*, a.quiz, a.mid, a.final, a.total FROM students s LEFT JOIN assessments a ON s.student_id = a.student_id WHERE s.class_level = ? ORDER BY a.total DESC`, [sec], (err, students) => {
        let sRows = students.map((s, index) => `
            <tr>
                <td><b>${index + 1}</b></td>
                <td>${s.student_id}</td>
                <td style="text-align:left;">${s.name}</td>
                <td>${s.gender}</td>
                <td>${s.age}</td>
                <td>${s.phone}</td>
                <td>${s.quiz||''}</td><td>${s.mid||''}</td><td>${s.final||''}</td><td><b>${s.total||''}</b></td>
            </tr>
        `).join('');

        res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Excel View - ${sec}</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background: #f9f9f9; }
            .excel-table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.2); font-size:14px; }
            .excel-table th, .excel-table td { border: 1px solid #d4d4d4; padding: 6px 10px; text-align: center; }
            .excel-table th { background: #107c41; color: white; position: sticky; top: 0; }
            .excel-table tr:nth-child(even) { background: #f3f2f1; }
            .header-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; }
            button { background: #107c41; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight:bold; }
        </style>
        </head><body>
            <div class="header-bar">
                <h2>📊 Class Grades & Ranking: ${sec} (Total: ${students.length})</h2>
                <div><button onclick="window.print()">🖨️ Print / Save PDF</button> <button onclick="window.close()">❌ Close</button></div>
            </div>
            <table class="excel-table">
                <tr><th>Rank</th><th>Student ID</th><th>Full Name</th><th>Gender</th><th>Age</th><th>Phone Number</th><th>Quiz</th><th>Mid</th><th>Final</th><th>Total</th></tr>
                ${sRows||'<tr><td colspan="10">No students found in this class.</td></tr>'}
            </table>
        </body></html>`);
    });
});

app.get('/admin/approve/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM pending_students WHERE id = ?`, [req.params.id], (err, st) => {
        db.run(`INSERT INTO students (student_id, password, name, father_name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [st.student_id, st.password, st.name, '', st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.region, st.zone, st.woreda, st.kebele, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', '🎉 Your registration is approved! Download your Digital ID.'], () => {
            db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
        });
    });
});

app.post('/admin/update-pass', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { type, id, new_pass } = req.body;
    let table = type === 'student' ? 'students' : 'teachers';
    let idCol = type === 'student' ? 'student_id' : 'id';
    db.run(`UPDATE ${table} SET password = ? WHERE ${idCol} = ?`, [new_pass, id], () => res.redirect('/admin'));
});

app.get('/admin/edit-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.id], (err, s) => {
        if (!s) return res.send('Not found');
        db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections) => {
            let sectionOptions = sections.map(sec => `<option value="${esc(sec.name)}" ${sec.name===s.class_level?'selected':''}>${sec.name}</option>`).join('');
            const field = (label, name, val, type='text') => `<label>${label}</label><input type="${type}" name="${name}" value="${esc(val)}" style="width:100%; padding:8px; margin-bottom:10px;">`;
            res.send(`
            <div style="font-family:sans-serif; padding:20px; max-width:600px; margin:auto; background:white; border-radius:10px;">
                <h2>✏️ Edit Student: ${s.student_id}</h2>
                <form action="/admin/edit-student/${s.student_id}" method="POST">
                    ${field('Password (PIN)','password',s.password)}
                    ${field('Full Name','name',s.name)}
                    ${field("Mother's Name",'mother_name',s.mother_name)}
                    <label>Gender</label><select name="gender" style="width:100%; padding:8px; margin-bottom:10px;"><option ${s.gender==='Male'?'selected':''}>Male</option><option ${s.gender==='Female'?'selected':''}>Female</option></select>
                    ${field('Age','age',s.age,'number')}
                    ${field('Phone','phone',s.phone)}
                    ${field('Emergency Phone','emergency_phone',s.emergency_phone)}
                    ${field('Region','region',s.region)}
                    ${field('Zone','zone',s.zone)}
                    ${field('Woreda','woreda',s.woreda)}
                    ${field('Kebele','kebele',s.kebele)}
                    <label>Grade / Section</label><select name="class_level" style="width:100%; padding:8px; margin-bottom:10px;">${sectionOptions}</select>
                    ${field('Status','status',s.status)}
                    ${field('Admin Message','admin_message',s.admin_message)}
                    <button type="submit" style="width:100%; padding:12px; background:#27ae60; color:white; border:none; border-radius:5px; font-weight:bold;">💾 Save Changes</button>
                </form><br><a href="/admin">⬅️ Back to Admin</a>
            </div>`);
        });
    });
});

app.post('/admin/edit-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, status, admin_message, password } = req.body;
    db.run(`UPDATE students SET name=?, father_name='', mother_name=?, gender=?, age=?, phone=?, emergency_phone=?, region=?, zone=?, woreda=?, kebele=?, class_level=?, status=?, admin_message=?, password=? WHERE student_id=?`,
    [name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, status, admin_message, password, req.params.id], () => res.redirect('/admin'));
});

app.get('/admin/delete-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM students WHERE student_id = ?`, [req.params.id], () => {
        db.run(`DELETE FROM assessments WHERE student_id = ?`, [req.params.id], () => res.redirect('/admin'));
    });
});

// Teachers Management by Director (Add, Remove, Assign Grades/Classes)
app.post('/admin/add-teacher', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { name, phone, assigned_sections } = req.body;
    let gradesArr = req.body.grades ? (Array.isArray(req.body.grades) ? req.body.grades.join(', ') : req.body.grades) : '';
    db.run(`INSERT INTO teachers (id, name, password, phone, assigned_sections, assigned_grades, is_proctor) VALUES (?,?,?,?,?,?,?)`,
    [generateTeacherID(), name, generate4DigitPIN(), phone, assigned_sections || '', gradesArr, 0], () => res.redirect('/admin'));
});

app.get('/admin/edit-teacher/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.params.id], (err, t) => {
        if (!t) return res.send('Not found');
        
        let gradeCheckboxes = '';
        for(let i=1; i<=12; i++) {
            let gName = `Grade ${i}`;
            let isChecked = t.assigned_grades && t.assigned_grades.includes(gName) ? 'checked' : '';
            gradeCheckboxes += `<label style="margin-right:8px;"><input type="checkbox" name="grades" value="${gName}" ${isChecked}> ${gName}</label>`;
        }

        res.send(`
        <div style="font-family:sans-serif; padding:20px; max-width:500px; margin:auto; background:white; border-radius:10px;">
            <h2>✏️ Edit Teacher: ${t.id}</h2>
            <form action="/admin/edit-teacher/${t.id}" method="POST">
                <label>Password</label><input type="text" name="password" value="${esc(t.password)}" style="width:100%; padding:8px; margin-bottom:10px;">
                <label>Full Name</label><input type="text" name="name" value="${esc(t.name)}" style="width:100%; padding:8px; margin-bottom:10px;">
                <label>Phone</label><input type="text" name="phone" value="${esc(t.phone)}" style="width:100%; padding:8px; margin-bottom:10px;">
                <label>Assigned Classes (Comma separated)</label><input type="text" name="assigned_sections" value="${esc(t.assigned_sections)}" style="width:100%; padding:8px; margin-bottom:10px;">
                <label style="font-weight:bold; font-size:13px;">Assigned Grades (1-12):</label><br>
                <div style="margin:8px 0; display:flex; flex-wrap:wrap; gap:10px;">${gradeCheckboxes}</div><br>
                <button type="submit" style="width:100%; padding:12px; background:#27ae60; color:white; border:none; border-radius:5px; font-weight:bold;">💾 Save Changes</button>
            </form>
        </div>`);
    });
});

app.post('/admin/edit-teacher/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let gradesArr = req.body.grades ? (Array.isArray(req.body.grades) ? req.body.grades.join(', ') : req.body.grades) : '';
    db.run(`UPDATE teachers SET name=?, phone=?, assigned_sections=?, assigned_grades=?, password=? WHERE id=?`,
    [req.body.name, req.body.phone, req.body.assigned_sections, gradesArr, req.body.password, req.params.id], () => res.redirect('/admin'));
});

app.get('/admin/delete-teacher/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM teachers WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
});

app.post('/admin/add-section', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT OR IGNORE INTO sections (name, proctor_name, proctor_phone) VALUES (?,?,?)`,
    [req.body.name, req.body.proctor_name || '', ''], () => res.redirect('/admin'));
});
app.post('/admin/edit-section/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`UPDATE sections SET proctor_name=? WHERE id=?`, [req.body.proctor_name, req.params.id], () => res.redirect('/admin'));
});
app.get('/admin/delete-section/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM sections WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
});

app.post('/admin/add-course', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { code, title, credit_hours, class_level, teacher_id } = req.body;
    db.get(`SELECT name FROM teachers WHERE id = ?`, [teacher_id], (err, t) => {
        db.run(`INSERT INTO courses (code, title, credit_hours, teacher_id, teacher_name, class_level) VALUES (?,?,?,?,?,?)`,
        [code, title, credit_hours, teacher_id || '', t ? t.name : '', class_level], () => res.redirect('/admin'));
    });
});
app.get('/admin/delete-course/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM courses WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
});

app.get('/admin/export-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT * FROM students ORDER BY class_level, name`, [], (err, students) => {
        let header = ['student_id','name','mother_name','gender','age','phone','emergency_phone','region','zone','woreda','kebele','class_level','payment_type','status'];
        let rows = [header.join(',')];
        students.forEach(s => rows.push(header.map(col => csvCell(s[col])).join(',')));
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=alls_students.csv');
        res.send(rows.join('\r\n'));
    });
});

app.post('/admin/import-students', csvUpload.single('csv_file'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    if (!req.file) return res.redirect('/admin');
    let lines = req.file.buffer.toString('utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length && lines[0].toLowerCase().startsWith('name,')) lines.shift();

    let processRow = (i) => {
        if (i >= lines.length) return res.redirect('/admin');
        let cols = lines[i].split(',').map(c => c.trim());
        let [name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level] = cols;
        if (!name) return processRow(i + 1);

        let autoID = generateStudentID(); let autoPIN = generate4DigitPIN();
        ensureSectionExists(class_level || 'Unassigned');
        db.run(`INSERT INTO students (student_id, password, name, father_name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [autoID, autoPIN, name, '', mother_name || '', gender || '', age || null, phone || '', emergency_phone || '', region || '', zone || '', woreda || '', kebele || '', class_level || 'Unassigned', 'admin_added', '-', '', 'Approved', 'Added directly by Admin.'],
        () => processRow(i + 1));
    };
    processRow(0);
});

// TEACHER DASHBOARD
app.get('/teacher-dashboard', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        let assignedClasses = teacher.assigned_sections ? teacher.assigned_sections.split(',').map(s => s.trim()) : [];
        let selectedClass = req.query.cls || assignedClasses[0] || '';

        db.all(`SELECT s.*, a.quiz, a.mid, a.final, a.total, a.remark FROM students s LEFT JOIN assessments a ON s.student_id = a.student_id WHERE s.class_level = ? ORDER BY a.total DESC`, [selectedClass], (err, rows) => {
            db.all(`SELECT * FROM courses WHERE class_level = ? ORDER BY id DESC`, [selectedClass], (err, courses) => {
                db.all(`SELECT * FROM absence_requests WHERE class_level = ? ORDER BY id DESC`, [selectedClass], (err, absences) => {

                    let classTabs = assignedClasses.map(c => `<a href="/teacher-dashboard?cls=${encodeURIComponent(c)}" style="padding:8px 15px; background:${c===selectedClass?'#1f4e79':'#ccc'}; color:white; text-decoration:none; border-radius:4px; font-weight:bold; margin-right:5px;">${c}</a>`).join('');

                    let studentRows = rows.map((st, idx) => `
                        <tr>
                        <td><b>${idx + 1}</b></td>
                        <td>${st.student_id}</td><td>${st.name}</td>
                        <form action="/teacher/save-grade?lang=${lang}&cls=${encodeURIComponent(selectedClass)}" method="POST"><input type="hidden" name="student_id" value="${st.student_id}">
                        <td><input type="number" name="quiz" value="${st.quiz||0}" min="0" max="20" style="width:50px;"></td>
                        <td><input type="number" name="mid" value="${st.mid||0}" min="0" max="30" style="width:50px;"></td>
                        <td><input type="number" name="final" value="${st.final||0}" min="0" max="50" style="width:50px;"></td>
                        <td><strong>${st.total||0}</strong></td>
                        <td><button type="submit" style="background:#27ae60;color:white;border:none;padding:5px 10px; border-radius:3px; cursor:pointer;">💾 Save/Update</button></td></form></tr>`).join('');

                    let courseRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td></tr>`).join('');
                    
                    let absRows = absences.map(ab => `<div style="background:#fdf2e9; padding:10px; border-left:4px solid #e67e22; margin-bottom:10px;">
                        <strong>${ab.student_name} (${ab.student_id})</strong> - <em>${ab.created_at}</em><br>
                        📝 <strong>Reason/ችግር:</strong> ${ab.reason}<br>
                        ${ab.teacher_feedback ? `<span style="color:green; font-weight:bold;">💬 Feedback/ምክር: ${ab.teacher_feedback}</span>` : `
                        <form action="/teacher/give-feedback?cls=${encodeURIComponent(selectedClass)}" method="POST" style="margin-top:5px; display:flex; gap:5px;">
                            <input type="hidden" name="req_id" value="${ab.id}">
                            <input type="text" name="feedback" placeholder="Reply/Feedback to student..." required style="flex:1; padding:4px;">
                            <button type="submit" style="background:#16a085; color:white; border:none; padding:4px 8px; border-radius:3px;">Send</button>
                        </form>`}
                    </div>`).join('');

                    res.send(`
                    <div style="font-family:sans-serif; padding:20px; max-width:900px; margin:auto;">
                        <div style="text-align:right;"><a href="/teacher-dashboard?cls=${encodeURIComponent(selectedClass)}&lang=am">አማርኛ</a> | <a href="/teacher-dashboard?cls=${encodeURIComponent(selectedClass)}&lang=en">English</a></div>
                        <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;">👨‍🏫 Teacher Portal: ${teacher.name}</h2>
                        
                        <div style="margin:15px 0; background:#eef2f5; padding:10px; border-radius:5px;">
                            <strong>Select Class to Manage:</strong><br><br>
                            ${classTabs || '<p>No classes assigned.</p>'}
                        </div>

                        ${selectedClass ? `
                        <div style="margin-bottom:15px;">
                            <a href="/attendance-sheet/${encodeURIComponent(selectedClass)}" target="_blank" style="background:#2980b9; color:white; padding:10px; display:inline-block; border-radius:5px; text-decoration:none; margin-right:10px; font-weight:bold;">📋 Daily Attendance Sheet (${selectedClass})</a>
                            <a href="/view-excel/${encodeURIComponent(selectedClass)}" target="_blank" style="background:#107c41; color:white; padding:10px; display:inline-block; border-radius:5px; text-decoration:none; font-weight:bold;">📊 View Grades & Ranking (${selectedClass})</a>
                        </div>

                        <div style="display:flex; gap:20px; flex-wrap:wrap;">
                            <div style="background:#e8f4fd; padding:15px; border-radius:8px; margin-bottom:20px; flex:1; min-width:300px;">
                                <h3>📢 Send Notification to ${selectedClass}</h3>
                                <form action="/teacher/send-notification?cls=${encodeURIComponent(selectedClass)}" method="POST">
                                    <textarea name="message" rows="3" placeholder="Write class notification here..." required style="width:100%; padding:10px; border-radius:5px; border:1px solid #ccc; margin-bottom:10px;"></textarea>
                                    <button type="submit" style="background:#3498db; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Send Notification</button>
                                </form>
                            </div>
                            
                            <div style="background:white; padding:15px; border-radius:8px; margin-bottom:20px; flex:1; min-width:300px; max-height: 250px; overflow-y:auto; border:1px solid #ccc;">
                                <h3>📩 Absence Requests (${selectedClass})</h3>${absRows || '<p style="color:#777;">No absence requests.</p>'}
                            </div>
                        </div>

                        <div style="background:white; padding:15px; border-radius:8px; margin-bottom:20px;">
                            <h3>📚 Courses for ${selectedClass}</h3>
                            <table border="1" style="border-collapse:collapse; width:100%; text-align:center; margin-bottom:15px;">
                                <tr style="background:#1f4e79; color:white;"><th>Code</th><th>Title</th><th>Credit Hours</th></tr>
                                ${courseRows || '<tr><td colspan="3">No courses added yet</td></tr>'}
                            </table>
                            <form action="/teacher/add-course?cls=${encodeURIComponent(selectedClass)}&lang=${lang}" method="POST" style="display:flex; gap:8px; flex-wrap:wrap;">
                                <input type="text" name="code" placeholder="Course Code" required style="flex:1; padding:8px;">
                                <input type="text" name="title" placeholder="Course Title" required style="flex:2; padding:8px;">
                                <input type="number" name="credit_hours" placeholder="Cr.Hr" required style="width:80px; padding:8px;">
                                <button type="submit" style="background:#2980b9; color:white; border:none; padding:8px 14px; border-radius:5px;">➕ Add Course</button>
                            </form>
                        </div>

                        <div style="overflow-x:auto;">
                        <h3 style="background:#1f4e79; color:white; padding:10px; margin:0; border-top-left-radius:5px; border-top-right-radius:5px;">📝 Grades & Ranking Assessment for ${selectedClass}</h3>
                        <table border="1" width="100%" style="border-collapse:collapse; text-align:center; min-width:600px; background:white;">
                            <tr style="background:#eef2f5;"><th>Rank</th><th>ID</th><th>Name</th><th>Quiz(20)</th><th>Mid(30)</th><th>Final(50)</th><th>Total</th><th>Action</th></tr>
                            ${studentRows||'<tr><td colspan="8">No students in this class</td></tr>'}
                        </table></div>` : ''}
                        
                        <br><a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 Logout</a>
                    </div>`);
                });
            });
        });
    });
});

app.post('/teacher/send-notification', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at) VALUES (?,?,?,?,?)`,
            ['Teacher', teacher.name, targetClass, req.body.message, new Date().toLocaleString()], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
    });
});

app.post('/teacher/give-feedback', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    let { req_id, feedback } = req.body;
    db.run(`UPDATE absence_requests SET teacher_feedback = ? WHERE id = ?`, [feedback, req_id], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
});

app.post('/teacher/add-course', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        db.run(`INSERT INTO courses (code, title, credit_hours, teacher_id, teacher_name, class_level) VALUES (?,?,?,?,?,?)`,
        [req.body.code, req.body.title, req.body.credit_hours, teacher.id, teacher.name, targetClass], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
    });
});

app.post('/teacher/save-grade', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    let { student_id, quiz, mid, final } = req.body;
    let total = (parseFloat(quiz)||0) + (parseFloat(mid)||0) + (parseFloat(final)||0);
    db.run(`INSERT INTO assessments (student_id, quiz, mid, final, total, remark) VALUES (?,?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET quiz=?, mid=?, final=?, total=?, remark=?`,
    [student_id, quiz, mid, final, total, total>=50?'Pass':'Fail', quiz, mid, final, total, total>=50?'Pass':'Fail'], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
});

// STUDENT DASHBOARD
app.get('/student-dashboard', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    
    const t = lang === 'en' ? {
        dash: "🎓 Student Dashboard", msg: "Admin Message",
        cls: "Class", mon: "Monitor", idbtn: "📥 Download Digital ID",
        crs: "Registered Courses", asm: "Assessment & Grades",
        abs: "⚠️ Request Absence (Notify Teacher)", absDesc: "Send this form if you are sick or have a problem.", absBtn: "Send Request",
        updatePhoto: "📷 Update Profile Photo", myAbs: "📋 My Absence Requests & Teacher Feedback"
    } : {
        dash: "🎓 የተማሪ መቆጣጠሪያ", msg: "የአድሚን መልዕክት",
        cls: "ክፍል", mon: "ተቆጣጣሪ", idbtn: "📥 ዲጂታል መታወቂያ ያውርዱ",
        crs: "የተመዘገቡ ትምህርቶች", asm: "ውጤቶች",
        abs: "⚠️ የቀሪነት/ፈቃድ ጥያቄ (ለመምህር ማሳወቂያ)", absDesc: "ካመመዎት ወይም ችግር ካጋጠመዎት ይህንን ቅጽ ይሙሉ::", absBtn: "ጥያቄውን ላክ",
        updatePhoto: "📷 የፕሮፋይል ፎቶ ቀይር", myAbs: "📋 የላኳቸው የፈቃድ ጥያቄዎች እና የመምህር ምላሽ"
    };

    db.get(`SELECT s.*, a.quiz, a.mid, a.final, a.total, a.remark FROM students s LEFT JOIN assessments a ON s.student_id = a.student_id WHERE s.student_id = ?`, [req.session.studentId], (err, student) => {
        db.all(`SELECT * FROM courses WHERE class_level = ? ORDER BY id`, [student.class_level], (err, courses) => {
            db.get(`SELECT * FROM sections WHERE name = ?`, [student.class_level], (err, section) => {
                db.all(`SELECT * FROM notifications WHERE target_audience = 'ALL' OR target_audience = ? ORDER BY id DESC`, [student.class_level], (err, notifications) => {
                    db.all(`SELECT * FROM absence_requests WHERE student_id = ? ORDER BY id DESC`, [student.student_id], (err, myAbsences) => {

                        let monitor = section || { proctor_name: "N/A", proctor_phone: "-" };
                        let courseRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.teacher_name}</td></tr>`).join('');
                        
                        let notiRows = notifications.map(n => `<div style="background:${n.sender_role==='Admin'?'#f8d7da':'#d1ecf1'}; color:${n.sender_role==='Admin'?'#721c24':'#0c5460'}; padding:10px; margin-bottom:10px; border-radius:5px; border-left:5px solid ${n.sender_role==='Admin'?'#f5c6cb':'#bee5eb'};">
                            <strong style="font-size:12px;">🔔 From: ${n.sender_name} (${n.created_at})</strong><br>
                            ${n.message}
                        </div>`).join('');

                        let myAbsRows = myAbsences.map(ab => `<div style="background:#f9f9f9; padding:8px; border:1px solid #ddd; margin-bottom:5px; border-radius:4px;">
                            <small>📅 ${ab.created_at}</small><br>
                            <strong>Reason:</strong> ${ab.reason}<br>
                            ${ab.teacher_feedback ? `<span style="color:green; font-weight:bold;">💬 Teacher Feedback/ምክር: ${ab.teacher_feedback}</span>` : `<span style="color:orange;">⏳ Pending teacher response...</span>`}
                        </div>`).join('');

                        res.send(`
                        <!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><title>Student Dashboard - Amanuel School</title>
                        <style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .container{max-width:800px; margin:auto;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1); overflow-x:auto;} table{width:100%; border-collapse:collapse; margin-top:10px; min-width:400px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style></head>
                        <body>
                            <div class="container">
                                <div style="text-align:right;"><a href="/student-dashboard?lang=am">አማርኛ</a> | <a href="/student-dashboard?lang=en">English</a></div>
                                <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;">${t.dash}</h2>
                                
                                ${notifications.length > 0 ? `<div class="card" style="background:#fff3cd; border:1px solid #ffeeba;"><h3>📢 Notifications (ማስታወቂያዎች)</h3>${notiRows}</div>` : ''}

                                <div class="card" style="background:#d4edda; color:#155724;">📢 <b>${t.msg}:</b> ${student.admin_message}</div>

                                <div class="card" style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
                                    <div>
                                        <img src="/uploads/${student.photo}" style="width:100px; height:120px; object-fit:cover; border-radius:5px; display:block; margin-bottom:8px;">
                                        <form action="/student/update-photo" method="POST" enctype="multipart/form-data">
                                            <input type="file" name="new_photo" accept="image/*" required style="font-size:11px; width:130px; margin-bottom:4px;"><br>
                                            <button type="submit" style="background:#2980b9; color:white; border:none; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:11px;">${t.updatePhoto}</button>
                                        </form>
                                    </div>
                                    <div style="flex:1;">
                                        <h3>${student.name} (${student.student_id})</h3>
                                        <p><b>${t.cls}:</b> ${student.class_level} | <b>${t.mon}:</b> ${monitor.proctor_name} (${monitor.proctor_phone})</p>
                                        <a href="/download-id-pdf/${student.student_id}" style="display:inline-block; padding:10px; background:#27ae60; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">${t.idbtn}</a>
                                    </div>
                                </div>

                                <div class="card">
                                    <h3>📚 ${t.crs}</h3>
                                    <table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Instructor</th></tr>${courseRows||'<tr><td colspan="4">No courses</td></tr>'}</table>
                                </div>

                                <div class="card">
                                    <h3>📊 ${t.asm}</h3>
                                    <table><tr><th>Quiz(20)</th><th>Mid(30)</th><th>Final(50)</th><th>Total(100)</th><th>Remark</th></tr>
                                    <tr><td>${student.quiz||'-'}</td><td>${student.mid||'-'}</td><td>${student.final||'-'}</td><td><strong>${student.total||'-'}</strong></td><td>${student.remark||'N/A'}</td></tr></table>
                                </div>

                                <div class="card" style="background:#fdf2e9; border: 1px solid #e67e22;">
                                    <h3 style="color:#d35400;">${t.abs}</h3>
                                    <p style="font-size:13px; color:#555;">${t.absDesc}</p>
                                    <form action="/student/absence" method="POST">
                                        <textarea name="reason" placeholder="Write your problem/reason here... (ችግርዎን እዚህ ይጻፉ...)" style="width:100%; padding:10px; margin-bottom:10px; border-radius:5px; border:1px solid #ccc;" rows="3" required></textarea>
                                        <button type="submit" style="background:#e67e22; color:white; padding:10px; border:none; border-radius:5px; width:100%; cursor:pointer; font-weight:bold;">${t.absBtn}</button>
                                    </form>
                                    <hr style="margin:15px 0;">
                                    <h4>${t.myAbs}</h4>
                                    ${myAbsRows || '<p style="font-size:12px; color:#777;">No requests sent yet.</p>'}
                                </div>
                                <a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 Logout</a>
                            </div>
                        </body></html>`);
                    });
                });
            });
        });
    });
});

app.post('/student/update-photo', upload.single('new_photo'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    if (req.file) {
        let newPhotoFilename = req.file.filename;
        db.run(`UPDATE students SET photo = ? WHERE student_id = ?`, [newPhotoFilename, req.session.studentId], () => {
            res.redirect('/student-dashboard');
        });
    } else {
        res.redirect('/student-dashboard');
    }
});

app.post('/student/absence', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT name, class_level FROM students WHERE student_id=?', [req.session.studentId], (err, st) => {
        if(st) {
            let timestamp = new Date().toLocaleString(); 
            db.run(`INSERT INTO absence_requests (student_id, student_name, class_level, reason, teacher_feedback, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [req.session.studentId, st.name, st.class_level, req.body.reason, '', 'Pending', timestamp], () => res.redirect('/student-dashboard'));
        }
    });
});

app.get('/download-id-pdf/:id', (req, res) => {
    db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.id], (err, student) => {
        if (!student) return res.send('Student not found');

        const doc = new PDFDocument({ size: [400, 260], margin: 0 });
        res.setHeader('Content-Type', 'application/pdf'); 
        res.setHeader('Content-Disposition', `attachment; filename=ID-${student.student_id}.pdf`);
        doc.pipe(res);

        doc.rect(0, 0, 400, 260).fill('#fdfefe');
        doc.rect(4, 4, 392, 252).lineWidth(1.5).strokeColor('#1f4e79').stroke();
        doc.rect(4, 4, 392, 46).fill('#1f4e79');
        
        let schoolLogo = path.join(__dirname, 'uploads', 'logo.jpg');
        if (fs.existsSync(schoolLogo)) {
            doc.image(schoolLogo, 10, 8, { width: 38, height: 38 });
        } else {
            doc.circle(30, 27, 16).fill('#ffffff');
            doc.fontSize(12).fillColor('#1f4e79').text('ALLS', 14, 20);
        }

        doc.fontSize(12).fillColor('#ffffff').text('AMANUEL LIGHT AND LIFE SCHOOL', 55, 12, { width: 300 });
        doc.fontSize(8.5).fillColor('#f4d03f').text('OFFICIAL DIGITAL STUDENT ID CARD', 55, 30, { width: 300 });

        let photoFile = path.join(__dirname, 'uploads', student.photo || '');
        doc.rect(18, 60, 84, 100).lineWidth(1).strokeColor('#1f4e79').stroke();
        if (student.photo && fs.existsSync(photoFile)) doc.image(photoFile, 20, 62, { width: 80, height: 96 });

        doc.fontSize(10).fillColor('#000');
        doc.font('Helvetica-Bold').text(`${student.name}`, 115, 62, { width: 260 });
        doc.font('Helvetica').fontSize(9);
        doc.text(`ID No: ${student.student_id}`, 115, 80);
        doc.text(`Class: ${student.class_level}`, 115, 96);
        doc.text(`Phone: ${student.phone}`, 115, 112);
        doc.fillColor('#27ae60').font('Helvetica-Bold').text(`Status: ${student.status || 'Approved'}`, 115, 128);

        doc.rect(4, 170, 392, 20).fill('#eef2f5');
        doc.fontSize(7.5).fillColor('#555').text('This card is property of Amanuel Light and Life School. If found, please return to the office.', 12, 176, { width: 376, align: 'center' });

        let qrData = `Name: ${student.name}\nID: ${student.student_id}\nGender: ${student.gender}\nClass: ${student.class_level}\nPhone: ${student.phone}`;

        bwipjs.toBuffer({ bcid: 'qrcode', text: qrData, scale: 3 }, function (err, png) {
            if (!err) doc.image(png, 172.5, 195, { width: 55, height: 55 });
            doc.end();
        });
    });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
