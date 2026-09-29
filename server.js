const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js'); 
const { Pool } = require('pg'); 

process.on('uncaughtException', (err) => { console.error('CRITICAL ERROR:', err); });
process.on('unhandledRejection', (reason, p) => { console.error('UNHANDLED REJECTION:', reason); });

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// የ Neon Database ማገናኛ
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_x2bqlnw8jFaK@ep-hidden-math-zaduj97x-pooler.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

const db = {
    run: (sql, params, callback) => {
        if (typeof params === 'function') { callback = params; params = []; }
        let i = 1; let pgSql = sql.replace(/\?/g, () => `$${i++}`);
        pool.query(pgSql, params || [])
            .then(res => { if(callback) callback(null); })
            .catch(err => { console.error(err); if(callback) callback(err); });
    },
    get: (sql, params, callback) => {
        if (typeof params === 'function') { callback = params; params = []; }
        let i = 1; let pgSql = sql.replace(/\?/g, () => `$${i++}`);
        pool.query(pgSql, params || [])
            .then(res => { if(callback) callback(null, res.rows[0]); })
            .catch(err => { console.error(err); if(callback) callback(err, null); });
    },
    all: (sql, params, callback) => {
        if (typeof params === 'function') { callback = params; params = []; }
        let i = 1; let pgSql = sql.replace(/\?/g, () => `$${i++}`);
        pool.query(pgSql, params || [])
            .then(res => { if(callback) callback(null, res.rows); })
            .catch(err => { console.error(err); if(callback) callback(err, []); });
    }
};

async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS students (
            student_id TEXT PRIMARY KEY, password TEXT, name TEXT, mother_name TEXT,
            gender TEXT, age INTEGER, phone TEXT, emergency_phone TEXT, region TEXT, zone TEXT,
            woreda TEXT, kebele TEXT, class_level TEXT, payment_type TEXT,
            bank_slip_val TEXT, photo TEXT, status TEXT, admin_message TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS pending_students (
            id SERIAL PRIMARY KEY, student_id TEXT, password TEXT, name TEXT, mother_name TEXT,
            gender TEXT, age INTEGER, phone TEXT, emergency_phone TEXT, region TEXT,
            zone TEXT, woreda TEXT, kebele TEXT, class_level TEXT, payment_type TEXT,
            bank_slip_val TEXT, photo TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS teachers (
            id TEXT PRIMARY KEY, name TEXT, password TEXT, phone TEXT, assigned_sections TEXT, assigned_grades TEXT, is_proctor INTEGER DEFAULT 0
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS course_assessments (
            id SERIAL PRIMARY KEY, student_id TEXT, teacher_id TEXT, course_code TEXT, course_title TEXT, 
            quiz REAL, mid REAL, final REAL, total REAL, remark TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS withdrawals (
            id SERIAL PRIMARY KEY, student_id TEXT, reason TEXT, details TEXT, status TEXT, admin_reply TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS courses (
            id SERIAL PRIMARY KEY, code TEXT, title TEXT, credit_hours INTEGER,
            teacher_id TEXT, teacher_name TEXT, class_level TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS sections (
            id SERIAL PRIMARY KEY, name TEXT UNIQUE, proctor_name TEXT, proctor_phone TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY, sender_role TEXT, sender_name TEXT, target_audience TEXT, message TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS absence_requests (
            id SERIAL PRIMARY KEY, student_id TEXT, student_name TEXT, class_level TEXT, reason TEXT, teacher_feedback TEXT, status TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS daily_attendance (
            id SERIAL PRIMARY KEY, student_id TEXT, student_name TEXT, class_level TEXT, date TEXT, status TEXT
        )`);

        let tRes = await pool.query("SELECT COUNT(*) as count FROM teachers");
        if (tRes.rows[0].count == 0) {
            await pool.query(`INSERT INTO teachers (id, name, password, phone, assigned_sections, assigned_grades, is_proctor) VALUES 
            ('T-101', 'Dr. Teshale Kebede', '123456', '0911001122', 'Grade 1 - Section A', 'Grade 1', 1)`);
        }

        let sRes = await pool.query("SELECT COUNT(*) as count FROM sections");
        if (sRes.rows[0].count == 0) {
            await pool.query(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES 
            ('Grade 1 - Section A', 'Dr. Teshale Kebede', '0912345678') ON CONFLICT (name) DO NOTHING`);
        }
        console.log('✅ አዲሱ የ Neon Cloud Database በተሳካ ሁኔታ ተገናኝቷል! ዳታዎ አይጠፋም!');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}
initDB();

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
    db.run(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES (?, '', '') ON CONFLICT (name) DO NOTHING`, [secName]);
}

function isClassMatch(c1, c2) {
    if (!c1 || !c2) return false;
    let s1 = c1.toString().toLowerCase().trim();
    let s2 = c2.toString().toLowerCase().trim();
    if (s1 === s2) return true;

    let extract = (str) => {
        let num = str.match(/\d+/);
        let n = num ? parseInt(num[0], 10) : null;
        let secMatch = str.match(/section\s*([a-z])/i);
        let s = secMatch ? secMatch[1].toLowerCase() : '';
        if (!s) {
            let charMatch = str.match(/\d+([a-z])/i);
            if (charMatch) s = charMatch[1].toLowerCase();
        }
        return { n, s };
    };

    let i1 = extract(c1);
    let i2 = extract(c2);

    if (i1.n !== null && i2.n !== null) {
        if (i1.n !== i2.n) return false; 
        if (i1.s && i2.s) return i1.s === i2.s;
        return true; 
    }
    return s1 === s2;
}

function assignClassSection(requestedYearLevel, callback) {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
    let checkNext = (index) => {
        if (index >= letters.length) return callback(`${requestedYearLevel} - Section Overflow`);
        let secName = `${requestedYearLevel} - Section ${letters[index]}`;
        db.get(`SELECT COUNT(*) as c FROM students WHERE class_level = ?`, [secName], (err, r1) => {
            db.get(`SELECT COUNT(*) as c FROM pending_students WHERE class_level = ?`, [secName], (err, r2) => {
                let total = (r1 && r1.c ? parseInt(r1.c) : 0) + (r2 && r2.c ? parseInt(r2.c) : 0);
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

// ================= PUBLIC ROUTES =================
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
        title: "🔑 Reset My Password", desc: "Enter your phone number and your mother's name exactly as you registered them.",
        ph: "Phone Number", mom: "Mother's Name", btn: "Reset Password", back: "Back to Login"
    } : {
        title: "🔑 የይለፍ ቃል ዳግም አስጀምር", desc: "በምዝገባ ጊዜ የተጠቀሙበትን ስልክ ቁጥር እና የእናትዎን ስም በትክክል ያስገቡ።",
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
    let newPin = generate4DigitPIN();
    db.get(`SELECT student_id FROM students WHERE phone = ? AND mother_name = ?`, [phone, mother_name], (err, s) => {
        if (s) {
            return db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [newPin, s.student_id], () => {
                res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h2 style="color:green;">✅ Password Reset / የይለፍ ቃል ተቀይሯል!</h2><p>New PIN / አዲሱ የይለፍ ቁጥርዎ: <span style="color:red; font-size:24px; font-weight:bold;">${newPin}</span></p><a href="/?lang=${lang}">Back</a></div>`);
            });
        }
        res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:red;">❌ Account Not Found / ተመሳሳይ አካውንት አልተገኘም!</h3><a href="/forgot-password?lang=${lang}">Back</a></div>`);
    });
});

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "📝 Student Registration Form", name: "Full Name:", mot: "Mother's Name:",
        gen: "Gender:", m: "Male", f: "Female", age: "Age:", ph: "Phone:", eph: "Emergency Phone:", reg: "Region:",
        zon: "Zone:", wor: "Woreda:", keb: "Kebele:", yr: "Grade Level:",
        pic: "Passport Photo:", pay: "Payment Type:", t1: "Transaction ID", t2: "Upload Slip", btn: "Submit Registration", back: "Back to Login",
        loading: "⏳ Loading... Please wait", amharic: "አማርኛ", english: "English",
        accTitle: "💳 Payment Accounts", accDesc: "Please pay using the accounts below and enter the TXN ID or upload the slip.", 
        accCbe: "CBE Bank:", accTele: "Telebirr:"
    } : {
        title: "📝 የተማሪዎች ምዝገባ ፎርም", name: "ሙሉ ስም:", mot: "የእናት ስም:",
        gen: "ጾታ:", m: "ወንድ", f: "ሴት", age: "ዕድሜ:", ph: "ስልክ:", eph: "የአደጋ ጊዜ ተጠሪ:", reg: "ክልል:",
        zon: "ዞን:", wor: "ወረዳ:", keb: "ቀበሌ:", yr: "የክፍል ደረጃ (Grade):",
        pic: "ጉርድ ፎቶ:", pay: "የክፍያ ማረጋገጫ:", t1: "የትራንዛክሽን ቁጥር (TXN ID)", t2: "የደረሰኝ ፎቶ ያያይዙ", btn: "ምዝገባ ላክ (Submit)", back: "ወደ ኋላ (Back)",
        loading: "⏳ እባክዎ ይጠብቁ... (Loading)", amharic: "አማርኛ", english: "English",
        accTitle: "💳 የክፍያ አካውንቶች", accDesc: "ክፍያዎን ከታች ባሉት አካውንቶች ከፈጸሙ በኋላ የትራንዛክሽን ቁጥሩን ወይም ደረሰኙን ከታች ያስገቡ።", 
        accCbe: "CBE (ንግድ ባንክ):", accTele: "Telebirr (ቴሌብር):"
    };

    let gradeOptions = '';
    for(let i=1; i<=12; i++) gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;

    res.send(`
    <!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Registration</title>
    <style>body{font-family:sans-serif; background:#eef2f5; padding:15px;} .box{max-width:600px; margin:auto; background:white; padding:25px; border-radius:10px;} input,select{width:100%; padding:10px; margin:5px 0 15px; border:1px solid #ccc; border-radius:5px;} .row{display:flex; gap:10px;} .col{flex:1;} button{width:100%; padding:12px; background:#27ae60; color:white; font-weight:bold; border:none; border-radius:5px; cursor:pointer;} button:disabled {background:#95a5a6;}</style>
    </head><body>
        <div class="box">
            <div style="text-align:right;"><a href="/student-register?lang=am">${t.amharic}</a> | <a href="/student-register?lang=en">${t.english}</a></div>
            <img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="width: 80px; height: 80px; display: block; margin: 0 auto 10px; border-radius: 50%;">
            <h2>${t.title}</h2>
            
            <div style="background:#d4edda; padding:15px; border-radius:5px; margin-bottom:20px; border:1px solid #c3e6cb; color:#155724;">
                <h4 style="margin-top:0; margin-bottom:10px;">${t.accTitle}</h4>
                <p style="margin:5px 0; font-size:16px;"><strong>${t.accCbe}</strong> 1000185928498</p>
                <p style="margin:5px 0; font-size:16px;"><strong>${t.accTele}</strong> 0916529382</p>
                <p style="margin:8px 0 0 0; font-size:13px; color:#555;">${t.accDesc}</p>
            </div>

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
                <div id="txnBox"><input type="text" name="txn_id" placeholder="Transaction ID (የትራንዛክሽን ቁጥር)"></div>
                <div id="slipBox" style="display:none;"><input type="file" name="bank_slip_file" accept="image/*,.pdf"></div>
                <button type="submit" id="subBtn">${t.btn}</button>
            </form><br><a href="/?lang=${lang}">⬅️ ${t.back}</a>
        </div>
    </body></html>`);
});

app.post('/api/register', upload.fields([{ name: 'student_photo', maxCount: 1 }, { name: 'bank_slip_file', maxCount: 1 }]), (req, res) => {
    const lang = req.query.lang || 'am';
    try {
        let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, year_level, payment_type, txn_id } = req.body;
        
        // Prevent Duplicate Registration
        db.get(`SELECT student_id FROM students WHERE name = ? AND mother_name = ? UNION SELECT student_id FROM pending_students WHERE name = ? AND mother_name = ?`, 
        [name, mother_name, name, mother_name], (err, existingUser) => {
            if (existingUser) {
                const errMsg = lang === 'en' ? "❌ You are already registered!" : "❌ አስቀድመው ተመዝግበዋል! (ተደጋጋሚ ምዝገባ አይቻልም)";
                return res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:red;">${errMsg}</h3><a href="/student-register?lang=${lang}">⬅️ Back / ተመለስ</a></div>`);
            }

            let autoID = generateStudentID(); 
            let autoPIN = generate4DigitPIN();

            assignClassSection(year_level, (assignedSection) => {
                let photoPath = (req.files && req.files['student_photo']) ? req.files['student_photo'][0].filename : '';
                let slipPath = payment_type === 'slip_file' && (req.files && req.files['bank_slip_file']) ? req.files['bank_slip_file'][0].filename : txn_id;

                db.get(`INSERT INTO pending_students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING student_id`,
                [autoID, autoPIN, name, mother_name || '', gender || '', age || null, phone || '', emergency_phone || '', region || '', zone || '', woreda || '', kebele || '', assignedSection, payment_type, slipPath, photoPath], function(err, row) {
                    if (err) return res.send(`<div style="text-align:center; padding:40px;"><h3 style="color:red;">❌ የዳታቤዝ ስህተት አጋጥሟል!</h3><p>${err.message}</p><a href="/student-register">Back</a></div>`);
                    
                    let insertedId = row ? row.student_id : autoID;
                    const msg = lang === 'en' ? "Request Sent! Sent to Admin for review." : "ጥያቄዎ ለአድሚን ገምጋሚ ተልኳል።";
                    res.send(`
                    <div style="text-align:center; padding:40px; font-family:sans-serif;">
                        <h2 style="color:green;">✅ ${lang === 'en' ? 'Success!' : 'ተሳክቷል!'}</h2>
                        <div style="background:#eef2f5; display:inline-block; padding:20px; border-radius:8px; text-align:left;">
                            <p><strong>Class:</strong> ${assignedSection}</p>
                            <p><strong>ID Number:</strong> <span style="color:red; font-size:20px;">${autoID}</span></p>
                            <p><strong>Password PIN:</strong> <span style="color:red; font-size:20px;">${autoPIN}</span></p>
                            <p style="color:#e67e22; font-size:13px;">⏳ ${msg}</p>
                            <p><a href="/download-pending-slip/${insertedId}" style="background:#e67e22; color:white; padding:10px; text-decoration:none; border-radius:5px;">📥 Download PDF</a></p>
                        </div><br><br><a href="/?lang=${lang}">Home</a>
                    </div>`);
                });
            });
        });
    } catch (error) {
        res.send(`<div style="text-align:center; padding:40px;"><h3 style="color:red;">❌ ስህተት ተከስቷል።</h3><a href="/student-register">Back</a></div>`);
    }
});

app.get('/download-pending-slip/:id', (req, res) => {
    function generatePDF(st, res) {
        const doc = new PDFDocument({ margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Registration-${st.student_id}.pdf`);
        doc.pipe(res);

        let schoolLogo = path.join(__dirname, 'uploads', 'logo.jpg');
        if (fs.existsSync(schoolLogo)) doc.image(schoolLogo, 40, 20, { width: 40, height: 40 });

        doc.fontSize(18).fillColor('#1f4e79').text('AMANUEL LIGHT AND LIFE SCHOOL', { align: 'center' }).moveDown();
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#ccc').stroke().moveDown();

        let photoFile = path.join(__dirname, 'uploads', st.photo || '');
        if (st.photo && fs.existsSync(photoFile)) doc.image(photoFile, 420, doc.y, { width: 110, height: 130 });

        const line = (label, val) => doc.fontSize(11).fillColor('#000').text(`${label}: `, 40, doc.y, { continued: true }).fillColor('#333').text(`${val || '-'}`);

        line('ID Number', st.student_id);
        line('Password PIN', st.password);
        line('Full Name', `${st.name || ''}`);
        line('Mother Name', `${st.mother_name || ''}`);
        line('Gender', st.gender);
        line('Phone', st.phone);
        line('Grade / Section', st.class_level);
        line('Status', st.status || 'Pending Admin Approval');
        doc.end();
    }

    db.get(`SELECT * FROM pending_students WHERE student_id = ?`, [req.params.id], (err, st) => {
        if (!st) {
            db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.id], (err2, st2) => {
                if (!st2) return res.send('Not found');
                generatePDF(st2, res);
            });
        } else {
            generatePDF(st, res);
        }
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
    const lang = req.query.lang || 'am';

    db.all(`SELECT * FROM pending_students`, [], (err, pending) => {
        db.all(`SELECT student_id, name, class_level, phone, password, status FROM students ORDER BY class_level`, [], (err, students) => {
            db.all(`SELECT * FROM teachers`, [], (err, teachers) => {
                db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections) => {
                    db.all(`SELECT * FROM courses ORDER BY class_level, code`, [], (err, courses) => {

                        // Payment Details correctly displayed to Admin
                        let pRows = pending.map(s => {
                            let paymentDisplay = s.payment_type === 'slip_file' ? `<a href="/uploads/${s.bank_slip_val}" target="_blank" style="color:#2980b9; text-decoration:underline;">📄 ደረሰኝ እይ</a>` : `<b>TXN:</b> ${s.bank_slip_val}`;
                            return `<tr><td>-</td><td>${s.student_id}</td><td>${s.name}</td><td>${paymentDisplay}</td><td><a href="/admin/approve/${s.id}?lang=${lang}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`;
                        }).join('');

                        let sRows = students.map(s => `<tr>
                            <td>${s.student_id}</td><td>${s.name}</td><td><a href="/class-hub/${encodeURIComponent(s.class_level)}" style="color:#2980b9; font-weight:bold;" target="_blank">📂 ${s.class_level}</a></td><td>${s.phone}</td>
                            <td><span style="color:red; font-weight:bold;">${s.password}</span></td>
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
                            <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;"> 🔐 የዳይሬክተር / አድሚን መቆጣጠሪያ</h2>

                            <div class="card" style="background:#e8f4fd;">
                                <h3>📢 ማስታወቂያ ላክ</h3>
                                <form action="/admin/send-notification" method="POST">
                                    <textarea name="message" rows="3" placeholder="Write your notification here..." required></textarea>
                                    <button type="submit" style="background:#3498db; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Send Notification</button>
                                </form>
                            </div>

                            <div class="card">
                                <h3>📁 የዳይሬክተር ሳምንታዊ እና ወርሃዊ ሪፖርት</h3>
                                <a href="/director-report" target="_blank" style="background:#8e44ad; color:white; padding:10px 15px; text-decoration:none; border-radius:5px; font-weight:bold; display:inline-block;">📁 View Director Academic Year Report</a>
                            </div>

                            <div class="card"><h3>አዲስ ተመዝጋቢዎች (Pending)</h3><table><tr><th>Photo</th><th>ID</th><th>Name</th><th>Payment</th><th>Action</th></tr>${pRows||'<tr><td colspan="5">None</td></tr>'}</table></div>

                            <div class="card">
                                <h3>ክፍሎችን እና ተቆጣጣሪዎችን (Proctors) ማስተዳደሪያ</h3>
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
                                <h3>ሁሉንም መምህራን ማስተዳደሪያ</h3>
                                <form action="/admin/add-teacher?lang=${lang}" method="POST" style="margin-bottom:15px; background:#f9f9f9; padding:15px; border-radius:5px;">
                                    <div style="display:flex; gap:10px; margin-bottom:10px;">
                                        <input type="text" name="name" placeholder="Teacher Full Name" required style="flex:1;">
                                        <input type="text" name="phone" placeholder="Phone Number" required style="flex:1;">
                                        <input type="text" name="assigned_sections" placeholder="Assigned Sections (e.g. Grade 1 - Section A, 2A, 3B)" required style="flex:2;">
                                    </div>
                                    <label style="font-weight:bold; font-size:13px;">Assign Grades (Select 1-12):</label><br>
                                    <div style="margin:8px 0; display:flex; flex-wrap:wrap; gap:10px;">${gradeCheckboxes}</div>
                                    <button type="submit" style="background:#2980b9; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">➕ Add Teacher</button>
                                </form>
                                <table><tr><th>ID</th><th>Name</th><th>Grades (1-12)</th><th>Classes</th><th>Phone</th><th>Password</th><th>Edit</th><th>Remove</th></tr>${tRows||'<tr><td colspan="8">None</td></tr>'}</table>
                            </div>

                            <div class="card">
                                <h3>ትምህርቶችን / Courses ማስተዳደሪያ</h3>
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
                                <h3>ሁሉም ተማሪዎች</h3>
                                <table><tr><th>ID</th><th>Name</th><th>Class</th><th>Phone</th><th>Password</th><th>Edit</th><th>Reset Password</th><th>Delete</th></tr>${sRows||'<tr><td colspan="9">None</td></tr>'}</table>
                            </div>
                            <br><a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 ውጣ (Logout)</a>
                        </body></html>`);
                    });
                });
            });
        });
    });
});

app.get('/admin/approve/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM pending_students WHERE id = ?`, [req.params.id], (err, st) => {
        if (!st) return res.redirect('/admin');
        db.run(`INSERT INTO students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [st.student_id, st.password, st.name, st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.region, st.zone, st.woreda, st.kebele, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', '🎉 Your registration is approved! Download your Digital ID.'], (insertErr) => {
            if (insertErr) console.error("Approve Insert Error:", insertErr);
            db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
        });
    });
});

// ================= ADMIN ADD / EDIT / DELETE ACTIONS =================

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
    db.run(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING`,
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
        db.run(`DELETE FROM course_assessments WHERE student_id = ?`, [req.params.id], () => res.redirect('/admin'));
    });
});

app.get('/admin/export-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT student_id, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, status FROM students ORDER BY class_level, name`, [], (err, students) => {
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
        db.run(`INSERT INTO students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [autoID, autoPIN, name, mother_name || '', gender || '', age || null, phone || '', emergency_phone || '', region || '', zone || '', woreda || '', kebele || '', class_level || 'Unassigned', 'admin_added', '-', '', 'Approved', 'Added directly by Admin.'],
        () => processRow(i + 1));
    };
    processRow(0);
});

// SINGLE CLICK CLASS HUB FOR DIRECTORS
app.get('/class-hub/:className', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let className = decodeURIComponent(req.params.className);
    
    db.all(`SELECT student_id, name, gender, class_level FROM students`, [], (err, allStudents) => {
        let students = allStudents.filter(s => isClassMatch(s.class_level, className));
        db.all(`SELECT * FROM course_assessments`, [], (err, assessments) => {
            
            students.forEach(st => {
                let st_ass = assessments.filter(a => a.student_id === st.student_id);
                st.cumulative_total = st_ass.reduce((sum, a) => sum + (a.total || 0), 0);
            });
            students.sort((a, b) => b.cumulative_total - a.cumulative_total);

            db.all(`SELECT * FROM sections`, [], (err, allSections) => {
                let section = allSections.find(sec => isClassMatch(sec.name, className));
                db.all(`SELECT * FROM courses`, [], (err, allCourses) => {
                    let courses = allCourses.filter(c => isClassMatch(c.class_level, className));
                    
                    let sRows = students.map((s, idx) => `<tr>
                        <td><b>${idx + 1}</b></td>
                        <td>${s.student_id}</td>
                        <td style="text-align:left;">${s.name}</td>
                        <td>${s.gender}</td>
                        <td>${s.cumulative_total}</td>
                    </tr>`).join('');

                    let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.teacher_name || 'N/A'}</td></tr>`).join('');

                    res.send(`
                    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Class Hub - ${className}</title>
                    <style>body{font-family:sans-serif; padding:20px; background:#f4f7f6;} .card{background:white; padding:20px; border-radius:8px; margin-bottom:15px;} table{width:100%; border-collapse:collapse; margin-top:10px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style>
                    </head><body>
                        <a href="/admin" style="background:#7f8c8d; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">⬅️ Back to Admin Dashboard</a>
                        <h2>📂 Class Hub: ${className}</h2>
                        <div class="card">
                            <p><strong>Proctor / Attendance Monitor:</strong> ${section ? section.proctor_name : 'N/A'}</p>
                            <p><strong>Total Students:</strong> ${students.length}</p>
                            <a href="/attendance-sheet/${encodeURIComponent(className)}" target="_blank" style="background:#2980b9; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">📋 Attendance Sheet</a>
                        </div>
                        <div class="card">
                            <h3>📚 Subjects / Courses for this Class</h3>
                            <table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Teacher</th></tr>${cRows||'<tr><td colspan="4">No courses</td></tr>'}</table>
                        </div>
                        <div class="card">
                            <h3>🏆 Students Ranking List (Total across all subjects) in ${className}</h3>
                            <table><tr><th>Rank</th><th>ID</th><th>Full Name</th><th>Gender</th><th>Total Score</th></tr>${sRows||'<tr><td colspan="5">No students</td></tr>'}</table>
                        </div>
                    </body></html>`);
                });
            });
        });
    });
});

app.post('/admin/send-notification', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at) VALUES (?,?,?,?,?)`,
        ['Admin', 'School Admin', 'ALL', req.body.message, new Date().toLocaleString()], () => res.redirect('/admin'));
});

// TEACHER DASHBOARD - Advanced Dropdown Class & Course Selection
app.get('/teacher-dashboard', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        let assignedClasses = teacher.assigned_sections ? teacher.assigned_sections.split(',').map(s => s.trim()) : [];
        let selectedClass = (req.query.cls || assignedClasses[0] || '').trim();

        db.all(`SELECT student_id, name, class_level FROM students ORDER BY name ASC`, [], (err, allStudents) => {
            let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, selectedClass));
            
            db.all(`SELECT * FROM courses WHERE teacher_id = ?`, [req.session.teacherId], (err, courses) => {
                let classCourses = courses.filter(c => isClassMatch(c.class_level, selectedClass));
                
                let selectedCourseId = req.query.course_id;
                let selectedCourse = classCourses.find(c => c.id.toString() === (selectedCourseId || '').toString());
                
                if (!selectedCourse && classCourses.length > 0) {
                    selectedCourse = classCourses[0];
                    selectedCourseId = selectedCourse.id;
                }

                db.all(`SELECT * FROM course_assessments WHERE teacher_id = ? AND course_code = ?`, [req.session.teacherId, selectedCourse ? selectedCourse.code : ''], (err, assessments) => {
                    db.all(`SELECT * FROM absence_requests ORDER BY id DESC`, [], (err, allAbsences) => {
                        let classAbsences = allAbsences.filter(ab => isClassMatch(ab.class_level, selectedClass));

                        let classOptions = assignedClasses.map(c => `<option value="${esc(c)}" ${c === selectedClass ? 'selected' : ''}>${c}</option>`).join('');
                        let courseOptions = classCourses.map(c => `<option value="${c.id}" ${c.id.toString() === (selectedCourseId||'').toString() ? 'selected' : ''}>${c.title} (${c.code})</option>`).join('');

                        let studentRows = studentsInClass.map((st, idx) => {
                            let asm = assessments ? assessments.find(a => a.student_id === st.student_id) || {} : {};
                            return `<tr>
                            <td><b>${idx + 1}</b></td>
                            <td>${st.student_id}</td><td>${st.name}</td>
                            <form action="/teacher/save-grade?cls=${encodeURIComponent(selectedClass)}&course_id=${selectedCourseId}" method="POST">
                            <input type="hidden" name="student_id" value="${st.student_id}">
                            <td><input type="number" name="quiz" value="${asm.quiz!==undefined?asm.quiz:''}" min="0" max="20" style="width:50px;"></td>
                            <td><input type="number" name="mid" value="${asm.mid!==undefined?asm.mid:''}" min="0" max="30" style="width:50px;"></td>
                            <td><input type="number" name="final" value="${asm.final!==undefined?asm.final:''}" min="0" max="50" style="width:50px;"></td>
                            <td><strong>${asm.total||0}</strong></td>
                            <td><button type="submit" style="background:#27ae60;color:white;border:none;padding:5px 10px; border-radius:3px; cursor:pointer;">💾 Save / Update</button></td></form></tr>`;
                        }).join('');

                        let absRows = classAbsences.map(ab => `<div style="background:#fdf2e9; padding:10px; border-left:4px solid #e67e22; margin-bottom:10px;">
                            <strong>${ab.student_name} (${ab.student_id})</strong> - <em>${ab.created_at}</em><br>
                            📝 <strong>መልዕክት:</strong> ${ab.reason}<br>
                            ${ab.teacher_feedback ? `<span style="color:green; font-weight:bold;">💬 Your Feedback: ${ab.teacher_feedback}</span>` : `
                            <form action="/teacher/give-feedback?cls=${encodeURIComponent(selectedClass)}" method="POST" style="margin-top:5px; display:flex; gap:5px;">
                                <input type="hidden" name="req_id" value="${ab.id}">
                                <input type="text" name="feedback" placeholder="Reply to student..." required style="flex:1; padding:4px;">
                                <button type="submit" style="background:#16a085; color:white; border:none; padding:4px 8px; border-radius:3px;">Send</button>
                            </form>`}
                        </div>`).join('');

                        res.send(`
                        <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Teacher Dashboard</title>
                        <style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1); overflow-x:auto;} table{width:100%; border-collapse:collapse; margin-top:10px; min-width:400px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style></head>
                        <body>
                        <div style="max-width:900px; margin:auto;">
                            <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;">👨‍🏫 Teacher Portal: ${teacher.name}</h2>
                            
                            <form method="GET" action="/teacher-dashboard" style="background:#eef2f5; padding:15px; border-radius:5px; margin-bottom:15px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
                                <div style="flex:1; min-width:200px;">
                                    <label style="font-weight:bold;">1. ክፍል ምረጥ (Select Class):</label><br>
                                    <select name="cls" onchange="this.form.submit()" style="width:100%; padding:8px; border-radius:4px; margin-top:5px;">
                                        ${classOptions || '<option>No Classes Assigned</option>'}
                                    </select>
                                </div>
                                <div style="flex:1; min-width:200px;">
                                    <label style="font-weight:bold;">2. ትምህርት ምረጥ (Select Course):</label><br>
                                    <select name="course_id" onchange="this.form.submit()" style="width:100%; padding:8px; border-radius:4px; margin-top:5px;">
                                        ${courseOptions || '<option value="">No Courses Assigned for this Class</option>'}
                                    </select>
                                </div>
                            </form>

                            ${selectedClass ? `
                            <div style="margin-bottom:15px;">
                                <a href="/attendance-sheet/${encodeURIComponent(selectedClass)}" target="_blank" style="background:#2980b9; color:white; padding:10px; display:inline-block; border-radius:5px; text-decoration:none; margin-right:10px; font-weight:bold;">📋 Daily Attendance Sheet (${selectedClass})</a>
                            </div>

                            <div style="display:flex; gap:20px; flex-wrap:wrap;">
                                <div class="card" style="flex:1; min-width:300px;">
                                    <h3>📢 Send Notification to ${selectedClass}</h3>
                                    <form action="/teacher/send-notification?cls=${encodeURIComponent(selectedClass)}" method="POST">
                                        <textarea name="message" rows="3" placeholder="Write class notification here..." required style="width:100%; padding:10px; border-radius:5px; border:1px solid #ccc; margin-bottom:10px;"></textarea>
                                        <button type="submit" style="background:#3498db; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Send Notification</button>
                                    </form>
                                </div>
                                
                                <div class="card" style="flex:1; min-width:300px; max-height: 250px; overflow-y:auto; border:1px solid #ccc;">
                                    <h3>📩 Student Requests & Absences (${selectedClass})</h3>${absRows || '<p style="color:#777;">No requests.</p>'}
                                </div>
                            </div>

                            <div style="overflow-x:auto;">
                            <h3 style="background:#1f4e79; color:white; padding:10px; margin:0; border-top-left-radius:5px; border-top-right-radius:5px;">📝 የውጤት መሙያ (Grades) - ${selectedCourse ? selectedCourse.title : 'No Course Selected'}</h3>
                            <table border="1" width="100%" style="border-collapse:collapse; text-align:center; min-width:600px; background:white;">
                                <tr style="background:#eef2f5;"><th>No</th><th>ID</th><th>Name</th><th>Quiz(20)</th><th>Mid(30)</th><th>Final(50)</th><th>Total</th><th>Action</th></tr>
                                ${selectedCourse ? (studentRows || '<tr><td colspan="8">No students in this class</td></tr>') : '<tr><td colspan="8">Please select a course to enter grades.</td></tr>'}
                            </table></div>` : ''}
                            
                            <br><br><a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 Logout</a>
                        </div></body></html>`);
                    });
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

app.post('/teacher/save-grade', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    let courseId = req.query.course_id || '';
    let { student_id, quiz, mid, final } = req.body;
    
    let q = parseFloat(quiz) || 0;
    let m = parseFloat(mid) || 0;
    let f = parseFloat(final) || 0;
    let total = q + m + f;
    let remark = total >= 50 ? 'Pass' : 'Fail';

    db.get(`SELECT * FROM courses WHERE id = ?`, [courseId], (err, course) => {
        if(!course) return res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`);
        
        let courseCode = course.code;
        let courseTitle = course.title;

        db.get(`SELECT id FROM course_assessments WHERE student_id = ? AND teacher_id = ? AND course_code = ?`, [student_id, req.session.teacherId, courseCode], (err, row) => {
            if (row) {
                db.run(`UPDATE course_assessments SET quiz=?, mid=?, final=?, total=?, remark=? WHERE id=?`, 
                [quiz, mid, final, total, remark, row.id], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}&course_id=${courseId}`));
            } else {
                db.run(`INSERT INTO course_assessments (student_id, teacher_id, course_code, course_title, quiz, mid, final, total, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
                [student_id, req.session.teacherId, courseCode, courseTitle, quiz, mid, final, total, remark], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}&course_id=${courseId}`));
            }
        });
    });
});

// STUDENT DASHBOARD
app.get('/student-dashboard', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    
    db.get(`SELECT s.* FROM students s WHERE s.student_id = ?`, [req.session.studentId], (err, student) => {
        
        db.all(`SELECT * FROM courses ORDER BY id`, [], (err, allCourses) => {
            let myCourses = allCourses.filter(c => isClassMatch(c.class_level, student.class_level));
            
            db.all(`SELECT * FROM course_assessments WHERE student_id = ?`, [student.student_id], (err, myGrades) => {
                db.all(`SELECT * FROM sections`, [], (err, allSections) => {
                    let section = allSections.find(sec => isClassMatch(sec.name, student.class_level));
                    
                    db.all(`SELECT * FROM notifications ORDER BY id DESC`, [], (err, allNotifs) => {
                        db.all(`SELECT * FROM absence_requests WHERE student_id = ? ORDER BY id DESC`, [student.student_id], (err, myAbsences) => {

                            let monitor = section || { proctor_name: "N/A", proctor_phone: "-" };
                            
                            let myNotifs = allNotifs.filter(n => n.target_audience === 'ALL' || isClassMatch(n.target_audience, student.class_level));
                            let notiRows = myNotifs.map(n => `<div style="background:${n.sender_role==='Admin'?'#f8d7da':'#d1ecf1'}; color:${n.sender_role==='Admin'?'#721c24':'#0c5460'}; padding:10px; margin-bottom:10px; border-radius:5px; border-left:5px solid ${n.sender_role==='Admin'?'#f5c6cb':'#bee5eb'};">
                                <strong style="font-size:12px;">🔔 From: ${n.sender_name} (${n.created_at})</strong><br>
                                ${n.message}
                            </div>`).join('');

                            let myAbsRows = myAbsences.map(ab => `<div style="background:#f9f9f9; padding:8px; border:1px solid #ddd; margin-bottom:5px; border-radius:4px;">
                                <small>📅 ${ab.created_at}</small><br>
                                <strong>Message:</strong> ${ab.reason}<br>
                                ${ab.teacher_feedback ? `<span style="color:green; font-weight:bold;">💬 Teacher Reply: ${ab.teacher_feedback}</span>` : `<span style="color:orange;">⏳ Pending teacher response...</span>`}
                            </div>`).join('');

                            let gradesHtml = myCourses.map(c => {
                                let asm = myGrades.find(a => a.course_code === c.code) || {};
                                return `<tr>
                                    <td style="text-align:left;"><b>${c.title}</b><br><small style="color:#777;">Inst: ${c.teacher_name}</small></td>
                                    <td>${asm.quiz !== undefined ? asm.quiz : '-'}</td>
                                    <td>${asm.mid !== undefined ? asm.mid : '-'}</td>
                                    <td>${asm.final !== undefined ? asm.final : '-'}</td>
                                    <td><strong style="color:#27ae60;">${asm.total !== undefined ? asm.total : '-'}</strong></td>
                                    <td>${asm.remark || '-'}</td>
                                </tr>`;
                            }).join('');

                            let teacherOptions = myCourses.map(c => `<option value="${c.teacher_name}">ወደ: መምህር ${c.teacher_name} (${c.title})</option>`).join('');

                            res.send(`
                            <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Student Dashboard - Amanuel School</title>
                            <style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .container{max-width:800px; margin:auto;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1); overflow-x:auto;} table{width:100%; border-collapse:collapse; margin-top:10px; min-width:400px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style></head>
                            <body>
                                <div class="container">
                                    <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;">🎓 የተማሪ መቆጣጠሪያ</h2>
                                    
                                    ${myNotifs.length > 0 ? `<div class="card" style="background:#fff3cd; border:1px solid #ffeeba;"><h3>📢 ማስታወቂያዎች (Notifications)</h3>${notiRows}</div>` : ''}

                                    <div class="card" style="background:#d4edda; color:#155724;">📢 <b>የአድሚን መልዕክት:</b> ${student.admin_message}</div>

                                    <div class="card" style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
                                        <div>
                                            <img src="/uploads/${student.photo}" style="width:100px; height:120px; object-fit:cover; border-radius:5px; display:block; margin-bottom:8px;">
                                            <form action="/student/update-photo" method="POST" enctype="multipart/form-data">
                                                <input type="file" name="new_photo" accept="image/*" required style="font-size:11px; width:130px; margin-bottom:4px;"><br>
                                                <button type="submit" style="background:#2980b9; color:white; border:none; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:11px;">📷 ፎቶ ቀይር</button>
                                            </form>
                                        </div>
                                        <div style="flex:1;">
                                            <h3>${student.name} (${student.student_id})</h3>
                                            <p><b>ክፍል:</b> ${student.class_level} | <b>ተቆጣጣሪ:</b> ${monitor.proctor_name} (${monitor.proctor_phone})</p>
                                            <a href="/download-id-pdf/${student.student_id}" style="display:inline-block; padding:10px; background:#27ae60; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">📥 ዲጂታል መታወቂያ ያውርዱ</a>
                                        </div>
                                    </div>

                                    <div class="card">
                                        <h3>📊 የትምህርት ውጤቶች (Assessment & Grades)</h3>
                                        <table><tr><th>Subject & Teacher</th><th>Quiz(20)</th><th>Mid(30)</th><th>Final(50)</th><th>Total(100)</th><th>Remark</th></tr>
                                        ${gradesHtml||'<tr><td colspan="6">No courses posted yet.</td></tr>'}</table>
                                    </div>

                                    <div class="card" style="background:#fdf2e9; border: 1px solid #e67e22;">
                                        <h3 style="color:#d35400;">⚠️ መልዕክት / ፈቃድ ላክ</h3>
                                        <p style="font-size:13px; color:#555;">መልዕክት መላክ የሚፈልጉለትን መምህር ይምረጡ:</p>
                                        <form action="/student/absence" method="POST">
                                            <select name="target_teacher" required style="width:100%; padding:10px; margin-bottom:10px; border-radius:5px;">
                                                <option value="Proctor/Monitor">ወደ: የክፍል ተቆጣጣሪ (Class Monitor)</option>
                                                ${teacherOptions}
                                            </select>
                                            <textarea name="reason" placeholder="መልዕክትዎን ወይም የፈቃድ ጥያቄዎን እዚህ ይጻፉ..." style="width:100%; padding:10px; margin-bottom:10px; border-radius:5px; border:1px solid #ccc;" rows="3" required></textarea>
                                            <button type="submit" style="background:#e67e22; color:white; padding:10px; border:none; border-radius:5px; width:100%; cursor:pointer; font-weight:bold;">ጥያቄውን ላክ (Send Message)</button>
                                        </form>
                                        <hr style="margin:15px 0;">
                                        <h4>📋 የላኳቸው ጥያቄዎች እና የመምህር ምላሽ</h4>
                                        ${myAbsRows || '<p style="font-size:12px; color:#777;">No requests sent yet.</p>'}
                                    </div>
                                    <a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 ውጣ (Logout)</a>
                                </div>
                            </body></html>`);
                        });
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
            let fullReason = `[ለ: ${req.body.target_teacher}] - ${req.body.reason}`;
            db.run(`INSERT INTO absence_requests (student_id, student_name, class_level, reason, teacher_feedback, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [req.session.studentId, st.name, st.class_level, fullReason, '', 'Pending', timestamp], () => {
                res.redirect('/student-dashboard');
            });
        }
    });
});

// DAILY ATTENDANCE (MONDAY - FRIDAY) WITH SAVE FUNCTIONALITY
app.get('/attendance-sheet/:secName', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let sec = decodeURIComponent(req.params.secName);
    let selectedDate = req.query.date || new Date().toISOString().split('T')[0];

    db.all(`SELECT student_id, name, gender, class_level FROM students ORDER BY name ASC`, [], (err, allStudents) => {
        let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, sec));
        
        db.all(`SELECT * FROM daily_attendance WHERE class_level = ? AND date = ?`, [sec, selectedDate], (err, records) => {
            
            let attendanceMap = {};
            records.forEach(r => { attendanceMap[r.student_id] = r.status; });

            let rowsHtml = '';
            let totalRows = 50; 
            
            for (let i = 0; i < totalRows; i++) {
                let st = studentsInClass[i];
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

app.post('/save-attendance', async (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let { class_level, date } = req.body;

    db.all(`SELECT student_id, name, class_level FROM students`, [], async (err, allStudents) => {
        if(err) return res.redirect('/teacher-dashboard');
        let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, class_level));

        db.run(`DELETE FROM daily_attendance WHERE class_level = ? AND date = ?`, [class_level, date], async () => {
            try {
                for(let st of studentsInClass) {
                    let status = req.body[`status_${st.student_id}`] || 'Absent';
                    await pool.query(`INSERT INTO daily_attendance (student_id, student_name, class_level, date, status) VALUES ($1, $2, $3, $4, $5)`, [st.student_id, st.name, class_level, date, status]);
                }
                res.send(`<script>alert('Attendance saved successfully!'); window.location.href='/teacher-dashboard';</script>`);
            } catch(e) {
                res.redirect('/teacher-dashboard');
            }
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
                        let classStudents = students.filter(s => isClassMatch(s.class_level, sec.name));
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
    
    db.all(`SELECT * FROM students`, [], (err, allStudents) => {
        let students = allStudents.filter(s => isClassMatch(s.class_level, sec));
        
        db.all(`SELECT * FROM course_assessments`, [], (err, assessments) => {
            
            students.forEach(st => {
                let st_ass = assessments.filter(a => a.student_id === st.student_id);
                st.cumulative_total = st_ass.reduce((sum, a) => sum + (a.total || 0), 0);
            });
            students.sort((a, b) => b.cumulative_total - a.cumulative_total);

            let sRows = students.map((s, index) => `
                <tr>
                    <td><b>${index + 1}</b></td>
                    <td>${s.student_id}</td>
                    <td style="text-align:left;">${s.name}</td>
                    <td>${s.gender}</td>
                    <td>${s.age}</td>
                    <td>${s.phone}</td>
                    <td><b>${s.cumulative_total}</b></td>
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
                    <tr><th>Rank</th><th>Student ID</th><th>Full Name</th><th>Gender</th><th>Age</th><th>Phone Number</th><th>Cumulative Total Score</th></tr>
                    ${sRows||'<tr><td colspan="7">No students found in this class.</td></tr>'}
                </table>
            </body></html>`);
        });
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
