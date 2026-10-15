require('dotenv').config(); 
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session); 
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js'); 
const { Pool } = require('pg'); 
const bcrypt = require('bcryptjs'); 
const xss = require('xss'); 
const rateLimit = require('express-rate-limit'); 

process.on('uncaughtException', (err) => { console.error('CRITICAL ERROR:', err); });
process.on('unhandledRejection', (reason, p) => { console.error('UNHANDLED REJECTION:', reason); });

const app = express();
app.set('trust proxy', 1); 
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
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
        await pool.query(`CREATE TABLE IF NOT EXISTS "session" (
            "sid" varchar NOT NULL COLLATE "default",
            "sess" json NOT NULL,
            "expire" timestamp(6) NOT NULL,
            CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
        )`);

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
        await pool.query(`CREATE TABLE IF NOT EXISTS academic_archives (
            id SERIAL PRIMARY KEY,
            academic_year TEXT,
            student_id TEXT,
            student_name TEXT,
            class_level TEXT,
            courses_summary TEXT,
            total_score REAL,
            archived_date TEXT
        )`);

        try { await pool.query(`ALTER TABLE sections ADD COLUMN class_monitor TEXT`); } catch(e) {}
        try { await pool.query(`ALTER TABLE notifications ADD COLUMN attachment TEXT`); } catch(e) {}
        try { await pool.query(`ALTER TABLE absence_requests ADD COLUMN attachment TEXT`); } catch(e) {}

        let tRes = await pool.query("SELECT COUNT(*) as count FROM teachers");
        if (tRes.rows[0].count == 0) {
            let hashedPass = bcrypt.hashSync('123456', 10);
            await pool.query(`INSERT INTO teachers (id, name, password, phone, assigned_sections, assigned_grades, is_proctor) VALUES 
            ('T-101', 'Dr. Teshale Kebede', $1, '0911001122', 'Grade 1 - Section A', 'Grade 1', 1)`, [hashedPass]);
        }

        let sRes = await pool.query("SELECT COUNT(*) as count FROM sections");
        if (sRes.rows[0].count == 0) {
            await pool.query(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES 
            ('Grade 1 - Section A', 'Dr. Teshale Kebede', '0912345678') ON CONFLICT (name) DO NOTHING`);
        }
    } catch (err) {
        console.error('DB init error:', err);
    }
}
initDB();

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads/')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('❌ ያልተፈቀደ የፋይል አይነት ነው!'), false);
    }
};

const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: fileFilter });

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'school-full-system-session-fix', 
    resave: false, 
    saveUninitialized: false, 
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    handler: (req, res) => {
        const lang = req.query.lang || 'am';
        res.redirect(`/?lang=${lang}&error=blocked`);
    }
});

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

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
        if (!s) { let charMatch = str.match(/\d+([a-z])/i); if (charMatch) s = charMatch[1].toLowerCase(); }
        return { n, s };
    };
    let i1 = extract(c1); let i2 = extract(c2);
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

function esc(v) { return v === null || v === undefined ? '' : String(v).replace(/"/g, '&quot;'); }

// ================= PUBLIC ROUTES =================
app.get('/', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const error = req.query.error;
    res.render('login', { lang, error });
});

app.post('/login', loginLimiter, (req, res) => {
    const lang = req.query.lang || 'am';
    const { role, username, password } = req.body;
    const uKey = username.trim();

    if (role === 'admin' && uKey === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true; return res.redirect(`/admin?lang=${lang}`);
    } else if (role === 'teacher') {
        db.get(`SELECT * FROM teachers WHERE id = ?`, [uKey.toUpperCase()], (err, t) => {
            if (t && (bcrypt.compareSync(password, t.password) || password === t.password)) {
                req.session.teacherId = t.id; return res.redirect(`/teacher-dashboard?lang=${lang}`);
            }
            res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else if (role === 'student') {
        db.get(`SELECT * FROM students WHERE student_id = ?`, [uKey.toUpperCase()], (err, s) => {
            if (s && (bcrypt.compareSync(password, s.password) || password === s.password)) {
                req.session.studentId = s.student_id; return res.redirect(`/student-dashboard?lang=${lang}`);
            }
            res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else {
        res.redirect(`/?lang=${lang}&error=invalid`);
    }
});

app.get('/forgot-password', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "Reset My Password", desc: "Enter your phone number and your mother's name exactly as you registered them.",
        ph: "Phone Number", mom: "Mother's Name", btn: "Reset Password", back: "Back to Login"
    } : {
        title: "የይለፍ ቃል ዳግም አስጀምር", desc: "በምዝገባ ጊዜ የተጠቀሙበትን ስልክ ቁጥር እና የእናትዎን ስም በትክክል ያስገቡ።",
        ph: "ስልክ ቁጥር", mom: "የእናት ስም", btn: "የይለፍ ቃል ዳግም አስጀምር", back: "ወደ መግቢያ ተመለስ"
    };

    let alertScript = '';
    if (req.query.error === 'notfound') {
        alertScript = `<script>Swal.fire({icon: 'error', title: 'Oops...', text: '${lang==='en'?'Account Not Found!':'ተመሳሳይ አካውንት አልተገኘም!'}', confirmButtonColor: '#d33'})</script>`;
    }

    res.send(`<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${t.title}</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"></head><body class="bg-gradient-to-br from-blue-50 to-gray-200 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md"><div class="text-center mb-6"><div class="inline-block p-4 bg-purple-100 rounded-full mb-4"><i class="fa-solid fa-key text-4xl text-purple-600"></i></div><h2 class="text-2xl font-extrabold text-gray-800">${t.title}</h2><p class="text-gray-500 mt-2 text-sm">${t.desc}</p></div><form action="/api/forgot-password?lang=${lang}" method="POST" class="space-y-5"><div class="relative"><i class="fa-solid fa-phone absolute left-3 top-3.5 text-gray-400"></i><input type="text" name="phone" placeholder="${t.ph}" required class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-purple-500"></div><div class="relative"><i class="fa-solid fa-person-breastfeeding absolute left-3 top-3.5 text-gray-400"></i><input type="text" name="mother_name" placeholder="${t.mom}" required class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-purple-500"></div><button type="submit" class="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 rounded-lg shadow-md">${t.btn}</button></form><div class="mt-6 text-center"><a href="/?lang=${lang}" class="text-gray-600 hover:text-purple-600 font-bold"><i class="fa-solid fa-arrow-left mr-1"></i> ${t.back}</a></div></div>${alertScript}</body></html>`);
});

app.post('/api/forgot-password', (req, res) => {
    const lang = req.query.lang || 'am';
    const { phone, mother_name } = req.body;
    db.get(`SELECT student_id FROM students WHERE phone = ? AND mother_name = ?`, [phone, mother_name], (err, s) => {
        if (s) {
            let newPin = generate4DigitPIN();
            let hashedPIN = bcrypt.hashSync(newPin, 10); 
            return db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [hashedPIN, s.student_id], () => {
                res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center"><div class="inline-block p-3 bg-green-100 rounded-full mb-4"><svg class="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></div><h2 class="text-2xl font-bold text-gray-800 mb-2">ፓስወርድ ተቀይሯል!</h2><p class="text-gray-600 mb-4">አዲሱ የይለፍ ቁጥርዎ ይህ ነው:</p><div class="text-5xl font-extrabold text-red-600 mb-6 bg-red-50 py-4 rounded-xl border border-red-200 tracking-widest shadow-inner">${newPin}</div><a href="/?lang=${lang}" class="block w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-md">ወደ መግቢያ ተመለስ</a></div></body></html>`);
            });
        }
        res.redirect(`/forgot-password?lang=${lang}&error=notfound`);
    });
});

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    let gradeOptions = '';
    for(let i=1; i<=12; i++) gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;
    res.send(`<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Student Registration</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-gray-100 py-10 px-4"><div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden"><div class="bg-green-600 py-6 px-8 text-center text-white relative"><a href="/?lang=${lang}" class="absolute left-4 top-6">⬅️</a><h2 class="text-2xl font-bold">አዲስ ተማሪ ምዝገባ</h2></div><div class="p-8"><form action="/api/register?lang=${lang}" method="POST" enctype="multipart/form-data"><div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6"><div><label class="block text-sm font-bold mb-2">ሙሉ ስም</label><input type="text" name="name" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">የእናት ስም</label><input type="text" name="mother_name" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">ጾታ</label><select name="gender" class="w-full px-3 py-2 border rounded-lg"><option value="Male">ወንድ</option><option value="Female">ሴት</option></select></div><div><label class="block text-sm font-bold mb-2">ዕድሜ</label><input type="number" name="age" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">ስልክ ቁጥር</label><input type="text" name="phone" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">የአደጋ ጊዜ ተጠሪ ስልክ</label><input type="text" name="emergency_phone" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">ክልል</label><input type="text" name="region" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">ዞን</label><input type="text" name="zone" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">ወረዳ</label><input type="text" name="woreda" required class="w-full px-3 py-2 border rounded-lg"></div><div><label class="block text-sm font-bold mb-2">ቀበሌ</label><input type="text" name="kebele" required class="w-full px-3 py-2 border rounded-lg"></div></div><div class="mb-6"><label class="block text-sm font-bold mb-2">የሚገቡበት የክፍል ደረጃ</label><select name="year_level" class="w-full px-3 py-2 border rounded-lg">${gradeOptions}</select></div><div class="mb-6"><label class="block text-sm font-bold mb-2">የጉርድ ፎቶ</label><input type="file" name="student_photo" accept="image/*" required class="w-full p-2 border border-dashed rounded-lg"></div><div class="mb-8 p-4 border rounded-lg bg-gray-50"><label class="block text-sm font-bold mb-2">የክፍያ ማረጋገጫ</label><select name="payment_type" id="payType" onchange="document.getElementById('slipBox').style.display = this.value=='slip_file'?'block':'none'; document.getElementById('txnBox').style.display = this.value=='txn_id'?'block':'none';" class="w-full px-3 py-2 border rounded-lg mb-4"><option value="txn_id">የትራንዛክሽን ቁጥር (TXN ID)</option><option value="slip_file">የደረሰኝ ፎቶ (Bank Slip)</option></select><div id="txnBox"><input type="text" name="txn_id" placeholder="Transaction ID..." class="w-full px-3 py-2 border rounded-lg"></div><div id="slipBox" style="display:none;"><input type="file" name="bank_slip_file" accept="image/*,.pdf" class="w-full p-2 border border-dashed rounded-lg bg-white"></div></div><button type="submit" class="w-full bg-green-600 text-white font-bold py-4 rounded-xl shadow-lg text-lg">ምዝገባ ላክ</button></form></div></div></body></html>`);
});

// ================= STUDENT DIGITAL ID & DASHBOARD =================
app.get('/student/digital-id', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT * FROM students WHERE student_id = ?', [req.session.studentId], (err, student) => {
        if (!student) return res.redirect('/');
        res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <title>Digital ID - ${student.name}</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #eef2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .id-card { width: 380px; background: white; border-radius: 12px; box-shadow: 0 8px 20px rgba(0,0,0,0.15); overflow: hidden; border: 2px solid #1f4e79; }
        .header { background: #1f4e79; color: white; padding: 12px 15px; display: flex; align-items: center; gap: 12px; }
        .school-logo { width: 45px; height: 45px; border-radius: 50%; object-fit: cover; background: white; border: 2px solid white; flex-shrink: 0; }
        .header-text h3 { margin: 0; font-size: 15px; font-weight: bold; }
        .header-text p { margin: 2px 0 0; font-size: 11px; letter-spacing: 0.5px; }
        .content { padding: 18px; display: flex; gap: 15px; align-items: center; border-bottom: 1px solid #eee; }
        .profile-img { width: 95px; height: 95px; border-radius: 8px; object-fit: cover; border: 2px solid #1f4e79; flex-shrink: 0; }
        .info { font-size: 13px; line-height: 1.5; color: #333; }
        .info p { margin: 3px 0; }
        .status { color: #27ae60; font-weight: bold; }
        .qr-section { padding: 12px; text-align: center; background: #fafafa; }
        .qr-code { width: 80px; height: 80px; }
        .footer { background: #f1f4f6; padding: 6px; text-align: center; font-size: 10px; color: #555; border-top: 1px solid #ddd; }
        .actions { padding: 10px; background: #fff; display: flex; gap: 10px; }
        .btn { flex: 1; padding: 10px; font-size: 14px; font-weight: bold; cursor: pointer; border: none; border-radius: 6px; text-align: center; text-decoration: none; }
        .btn-download { background: #27ae60; color: white; }
        .btn-download:hover { background: #219653; }
        .btn-back { background: #7f8c8d; color: white; }
        .btn-back:hover { background: #707b7c; }
        @media print { 
            .actions { display: none !important; } 
            body { background: white; height: auto; display: block; } 
            .id-card { box-shadow: none; border: 1px solid #000; margin: auto; } 
        }
    </style>
</head>
<body>
    <div class="id-card">
        <div class="header">
            <img src="/uploads/logo.jpg" onerror="this.onerror=null; this.src='/uploads/logo.png';" class="school-logo">
            <div class="header-text">
                <h3>AMANUEL LIGHT & LIFE SCHOOL</h3>
                <p>OFFICIAL DIGITAL STUDENT ID CARD</p>
            </div>
        </div>
        <div class="content">
            <img src="/uploads/${student.photo && student.photo.trim() !== '' ? student.photo : 'default.png'}" onerror="this.src='/uploads/logo.jpg'" class="profile-img">
            <div class="info">
                <h3 style="margin: 0 0 4px 0; color: #2c3e50; font-size: 15px;">${student.name}</h3>
                <p><b>ID No:</b> ${student.student_id}</p>
                <p><b>Class:</b> ${student.class_level}</p>
                <p><b>Phone:</b> ${student.phone || '-'}</p>
                <p><b>Status:</b> <span class="status">Approved</span></p>
            </div>
        </div>
        <div class="qr-section">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=ID-${student.student_id}-${encodeURIComponent(student.name)}" class="qr-code">
            <p style="font-size: 10px; color: #777; margin: 3px 0 0;">Scan to verify student status</p>
        </div>
        <div class="footer">
            This card is property of Amanuel Light and Life School. If found, please return to the office.
        </div>
        <div class="actions">
            <button onclick="window.print()" class="btn btn-download">📥 Download PDF</button>
            <a href="/student-dashboard" class="btn btn-back">⬅️ ተመለስ</a>
        </div>
    </div>
</body>
</html>`);
    });
});

app.post('/api/register', upload.fields([{ name: 'student_photo', maxCount: 1 }, { name: 'bank_slip_file', maxCount: 1 }]), (req, res) => {
    const lang = req.query.lang || 'am';
    try {
        let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, year_level, payment_type, txn_id } = req.body;
        name = xss(name); mother_name = xss(mother_name); phone = xss(phone);
        
        db.get(`SELECT student_id FROM students WHERE name = ? AND mother_name = ? UNION SELECT student_id FROM pending_students WHERE name = ? AND mother_name = ?`, 
        [name, mother_name, name, mother_name], (err, existingUser) => {
            if (existingUser) return res.redirect(`/student-register?lang=${lang}&error=exists`);

            let autoID = generateStudentID(); 
            let autoPIN = generate4DigitPIN();
            let hashedPIN = bcrypt.hashSync(autoPIN, 10); 

            assignClassSection(year_level, (assignedSection) => {
                let photoPath = (req.files && req.files['student_photo']) ? req.files['student_photo'][0].filename : '';
                let slipPath = payment_type === 'slip_file' && (req.files && req.files['bank_slip_file']) ? req.files['bank_slip_file'][0].filename : xss(txn_id);

                db.get(`INSERT INTO pending_students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING student_id`,
                [autoID, hashedPIN, name, mother_name || '', gender || '', age || null, phone || '', emergency_phone || '', region || '', zone || '', woreda || '', kebele || '', assignedSection, payment_type, slipPath, photoPath], function(err, row) {
                    if (err) return res.redirect(`/student-register?lang=${lang}&error=db`);
                    
                    let insertedId = row ? row.student_id : autoID;
                    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center"><h2 class="text-3xl font-bold text-gray-800 mb-6">ተሳክቷል!</h2><p class="text-gray-700"><strong>የመታወቂያ ቁጥር:</strong> ${autoID}</p><p class="text-gray-700"><strong>የይለፍ ቃል:</strong> ${autoPIN}</p><a href="/?lang=${lang}" class="block w-full bg-green-600 text-white font-bold py-3 rounded-lg mt-4">ወደ መግቢያ ተመለስ</a></div></body></html>`);
                });
            });
        });
    } catch (error) {
        res.redirect(`/student-register?lang=${lang}&error=db`);
    }
});
// ==========================================
// 📝 አዲስ ተማሪ መመዝገቢያ (ከዋናው ገጽ የሚመጣውን መቀበያ)
// ==========================================
const extraCols = ["mother_name TEXT", "region TEXT", "zone TEXT", "woreda TEXT", "kebele TEXT", "emergency_name TEXT", "emergency_phone TEXT"];
extraCols.forEach(col => {
    db.run(`ALTER TABLE students ADD COLUMN ${col}`, () => {});
    db.run(`ALTER TABLE pending_students ADD COLUMN ${col}`, () => {});
});

app.post('/register-student', upload.single('bank_slip'), (req, res) => {
    const { name, mother_name, gender, phone, class_level, region, zone, woreda, kebele, emergency_name, emergency_phone, transaction_id } = req.body;
    
    // ፎቶ ከተላከ ፎቶውን፣ የትራንዛክሽን ቁጥር ከተጻፈ ደግሞ ቁጥሩን ይይዛል
    const paymentProof = req.file ? req.file.filename : (transaction_id ? transaction_id.trim() : '');

    const autoID = generateStudentID();
    const autoPIN = generate4DigitPIN();
    const hashedPIN = bcrypt.hashSync(autoPIN, 10);

    assignClassSection(class_level, (assignedSection) => {
        const finalClass = assignedSection || class_level;
        db.run(
            `INSERT INTO pending_students (student_id, password, name, gender, phone, class_level, bank_slip_val) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [autoID, hashedPIN, name, gender, phone, finalClass, paymentProof],
            function(err) {
                if (err) {
                    console.error(err);
                    return res.redirect('/?error=db');
                }
                db.run(
                    `UPDATE pending_students SET mother_name = ?, region = ?, zone = ?, woreda = ?, kebele = ?, emergency_name = ?, emergency_phone = ? WHERE student_id = ?`,
                    [mother_name || '', region || '', zone || '', woreda || '', kebele || '', emergency_name || '', emergency_phone || '', autoID],
                    () => {
                        res.send(`
                            <!DOCTYPE html>
                            <html lang="am">
                            <head>
                                <meta charset="UTF-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                <title>Registration Successful</title>
                            </head>
                            <body style="font-family:sans-serif; background:#eef2f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0;">
                                <div style="background:white; padding:30px; border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,0.15); max-width:420px; width:90%; text-align:center; border-top:6px solid #27ae60;">
                                    <h2 style="color:#27ae60; margin-top:0;">✅ ምዝገባው ተሳክቷል!<br><span style="font-size:16px; color:#555;">Registration Submitted!</span></h2>
                                    <p style="color:#333; font-size:15px;">እባክዎ የሚከተሉትን መረጃዎች ጽፈው ይያዙ (አድሚኑ ሲያጸድቅልዎ በዚህ ይገባሉ)፦</p>
                                    <div style="background:#f8f9fa; padding:15px; border-radius:8px; border:1px solid #ddd; margin:20px 0; text-align:left; font-size:16px; line-height:1.8;">
                                        <b>👤 ስም (Name):</b> ${name}<br>
                                        <b>🆔 መታወቂያ (ID):</b> <span style="color:#2980b9; font-weight:bold;">${autoID}</span><br>
                                        <b>🔑 የይለፍ ቃል (PIN):</b> <span style="color:#e74c3c; font-weight:bold;">${autoPIN}</span><br>
                                        <b>🏫 ክፍል (Class):</b> ${finalClass}
                                    </div>
                                    <a href="/" style="display:inline-block; background:#2980b9; color:white; padding:12px 25px; text-decoration:none; border-radius:6px; font-weight:bold;">⬅️ ወደ መግቢያ ገጽ ተመለስ (Back to Login)</a>
                                </div>
                            </body>
                            </html>
                        `);
                    }
                );
            }
        );
    });
});


app.get('/download-pending-slip/:id', (req, res) => {
    function generatePDF(st, res) {
        const doc = new PDFDocument({ margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Registration-${st.student_id}.pdf`);
        doc.pipe(res);
        doc.fontSize(18).fillColor('#1f4e79').text('AMANUEL LIGHT AND LIFE SCHOOL', { align: 'center' }).moveDown();
        doc.end();
    }
    db.get(`SELECT * FROM pending_students WHERE student_id = ?`, [req.params.id], (err, st) => {
        if (!st) {
            db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.id], (err2, st2) => {
                if (!st2) return res.send('Not found');
                generatePDF(st2, res);
            });
        } else { generatePDF(st, res); }
    });
});

// ================= DASHBOARDS =================
app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const lang = req.query.lang || 'am';

    db.all(`SELECT * FROM pending_students`, [], (err, pending) => {
        db.all(`SELECT student_id, name, class_level, phone, password, status, gender FROM students ORDER BY class_level, name`, [], (err, students) => {
            db.all(`SELECT * FROM teachers`, [], (err, teachers) => {
                db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections) => {
                    db.all(`SELECT * FROM courses ORDER BY class_level, code`, [], (err, courses) => {
                        db.all(`SELECT * FROM notifications WHERE sender_role = 'Admin' ORDER BY id DESC`, [], (err, adminNotifs) => {
                            db.all(`SELECT * FROM course_assessments`, [], (err, assessments) => {

                                let maleCount = students.filter(s => s.gender === 'Male').length;
                                let femaleCount = students.filter(s => s.gender === 'Female').length;
                                
                                let excellent = 0, good = 0, average = 0, poor = 0;
                                assessments.forEach(a => {
                                    if (a.total >= 90) excellent++;
                                    else if (a.total >= 75) good++;
                                    else if (a.total >= 50) average++;
                                    else poor++;
                                });

                                let pRows = pending.map(s => `<tr><td>-</td><td>${s.student_id}</td><td>${s.name}</td><td>${s.payment_type === 'slip_file' ? `<a href="/uploads/${s.bank_slip_val}" target="_blank" style="color:#2980b9;">📄 እይ</a>` : `<b>TXN:</b> ${s.bank_slip_val}`}</td><td><a href="/admin/approve/${s.id}?lang=${lang}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`).join('');
                                let secRows = sections.map(sec => `<tr><td><a href="/class-hub/${encodeURIComponent(sec.name)}" style="color:#16a085; font-weight:bold;" target="_blank">📂 ${sec.name}</a></td><td><form action="/admin/edit-section/${sec.id}?lang=${lang}" method="POST" style="display:flex; gap:4px;"><select name="proctor_name" style="width:140px;"><option value="${sec.proctor_name || ''}">${sec.proctor_name || '-- Select --'}</option>${teachers.map(tc => `<option value="${tc.name}">${tc.name}</option>`).join('')}</select><button type="submit">Save</button></form></td><td><a href="/admin/delete-section/${sec.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑 Delete</a></td><td><a href="/attendance-sheet/${encodeURIComponent(sec.name)}" style="color:#2980b9; font-weight:bold; margin-right:10px;" target="_blank">📋 Attendance</a><a href="/admin/export-section-students/${encodeURIComponent(sec.name)}" style="background:#27ae60; color:white; padding:4px 8px; border-radius:3px; text-decoration:none; font-weight:bold;">📥 Excel</a></td></tr>`).join('');

                                let sectionOptions = sections.map(sec => `<option value="${sec.name}">${sec.name}</option>`).join('');
                                let teacherOptions = teachers.map(tc => `<option value="${tc.id}">${tc.name}</option>`).join('');
                                let gradeCheckboxes = ''; for(let i=1; i<=12; i++) gradeCheckboxes += `<label style="margin-right:8px;"><input type="checkbox" name="grades" value="Grade ${i}"> Grade ${i}</label>`;
                                let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.class_level}</td><td>${c.teacher_name||'-'}</td><td><a href="/admin/delete-course/${c.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');
                                let tRows = teachers.map(tc => `<tr><td>${tc.id}</td><td style="text-align:left;">${tc.name}</td><td>${tc.assigned_grades || 'None'}</td><td>${tc.assigned_sections || 'None'}</td><td>${tc.phone}</td><td><span style="color:red; font-weight:bold;">[Hashed]</span></td><td><a href="/admin/edit-teacher/${tc.id}?lang=${lang}" style="color:#2980b9; font-weight:bold;">✏️ Edit</a></td><td><a href="/admin/delete-teacher/${tc.id}?lang=${lang}" onclick="return confirm('Remove?')" style="color:red; font-weight:bold;">🗑️ Remove</a></td></tr>`).join('');
                                let adminNotiRows = adminNotifs.map(n => `<div style="background:#fdf2e9; padding:15px; margin-bottom:15px; border-radius:8px; border:1px solid #e67e22;"><strong>🔔 ${n.sender_name} (${n.created_at})</strong><br><div style="margin-top:10px;">${n.message}</div>${n.attachment ? `<br><a href="/uploads/${n.attachment}" target="_blank" style="color:blue; font-weight:bold;">📎 ፋይል ክፈት</a>` : ''}<div style="margin-top:15px; border-top:1px solid #ccc; padding-top:10px;"><button onclick="document.getElementById('editNotif_${n.id}').style.display='block'" style="background:orange; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; font-weight:bold;">✏️ Edit</button> <a href="/delete-notification/${n.id}" onclick="return confirm('እርግጠኛ ነዎት ይህ ማስታወቂያ ይጠፋ?')" style="background:red; color:white; padding:6px 10px; border-radius:4px; text-decoration:none; font-size:13px; margin-left:5px; font-weight:bold;">🗑️ Delete</a><form id="editNotif_${n.id}" action="/edit-notification/${n.id}" method="POST" enctype="multipart/form-data" style="display:none; margin-top:15px; background:#fff; padding:15px; border-radius:5px; border:1px solid #ccc;"><textarea name="message" rows="3" style="width:100%; padding:8px; margin-bottom:10px;">${n.message.replace(/<[^>]+>/g, '')}</textarea><input type="file" name="attachment" style="display:block; margin-bottom:10px;"><button type="submit" style="background:green; color:white; border:none; padding:6px 15px; border-radius:4px; font-weight:bold;">💾 Save Changes</button></form></div></div>`).join('');

                                let groupedStudentsHtml = '';
                                let uniqueClasses = [...new Set(students.map(s => s.class_level))];
                                if (uniqueClasses.length === 0) groupedStudentsHtml = '<p style="text-align:center; color:#777;">No students registered yet.</p>';
                                uniqueClasses.forEach(cls => {
                                    let clsStudents = students.filter(s => s.class_level === cls);
                                    let rows = clsStudents.map(s => `<tr><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td>${s.phone}</td><td><span style="color:red; font-weight:bold;">[Hashed]</span></td><td><a href="/admin/edit-student/${s.student_id}?lang=${lang}" style="color:#2980b9; font-weight:bold;">✏️ Edit</a></td><td><form action="/admin/update-pass?lang=${lang}" method="POST" style="display:flex; justify-content:center; gap:4px;"><input type="hidden" name="type" value="student"><input type="hidden" name="id" value="${s.student_id}"><input type="text" name="new_pass" placeholder="New PIN" style="width:70px; padding:4px;"><button type="submit" style="padding:4px; font-size:12px;">Reset</button></form></td><td><a href="/admin/delete-student/${s.student_id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');
                                    groupedStudentsHtml += `<div style="margin-bottom:30px; border:1px solid #ddd; padding:15px; border-radius:8px; background:#fdfdfd;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;"><h4 style="color:#2c3e50; margin:0;">📂 ${cls} (Total: ${clsStudents.length})</h4><a href="/admin/export-section-students/${encodeURIComponent(cls)}" style="background:#27ae60; color:white; padding:5px 10px; border-radius:3px; text-decoration:none; font-size:12px; font-weight:bold;">📥 Excel</a></div><div style="overflow-x:auto;"><table style="width:100%; min-width:600px; border-collapse:collapse; text-align:center; font-size:14px;"><tr style="background:#1f4e79; color:white;"><th>ID</th><th>Name</th><th>Phone</th><th>Password</th><th>Edit</th><th>Reset Pass</th><th>Delete</th></tr>${rows}</table></div></div>`;
                                });

                                res.render('admin', {
                                    lang, excellent, good, average, poor, maleCount, femaleCount,
                                    pRows, secRows, cRows, tRows, adminNotiRows, groupedStudentsHtml,
                                    sectionOptions, teacherOptions, gradeCheckboxes
                                });

                            });
                        });
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
        [st.student_id, st.password, st.name, st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.region, st.zone, st.woreda, st.kebele, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', '🎉 Your registration is approved!'], () => {
            db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
        });
    });
});

app.post('/admin/add-teacher', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let gradesArr = req.body.grades ? (Array.isArray(req.body.grades) ? req.body.grades.join(', ') : req.body.grades) : '';
    db.run(`INSERT INTO teachers (id, name, password, phone, assigned_sections, assigned_grades, is_proctor) VALUES (?,?,?,?,?,?,?)`,
    [generateTeacherID(), req.body.name, bcrypt.hashSync(generate4DigitPIN(), 10), req.body.phone, req.body.assigned_sections || '', gradesArr, 0], () => res.redirect('/admin'));
});

app.post('/admin/update-pass', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`UPDATE ${req.body.type === 'student' ? 'students' : 'teachers'} SET password = ? WHERE ${req.body.type === 'student' ? 'student_id' : 'id'} = ?`, [bcrypt.hashSync(req.body.new_pass, 10), req.body.id], () => res.redirect('/admin'));
});

app.post('/admin/add-section', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING`, [req.body.name, req.body.proctor_name || '', ''], () => res.redirect('/admin'));
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
    db.get(`SELECT name FROM teachers WHERE id = ?`, [req.body.teacher_id], (err, t) => {
        db.run(`INSERT INTO courses (code, title, credit_hours, teacher_id, teacher_name, class_level) VALUES (?,?,?,?,?,?)`,
        [req.body.code, req.body.title, req.body.credit_hours, req.body.teacher_id || '', t ? t.name : '', req.body.class_level], () => res.redirect('/admin'));
    });
});

app.get('/admin/delete-course/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM courses WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
});

app.get('/admin/delete-teacher/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM teachers WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
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
        res.setHeader('Content-Disposition', 'attachment; filename=all_students.csv');
        res.send(rows.join('\r\n'));
    });
});

app.get('/admin/export-teachers', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT id, name, phone, assigned_sections, assigned_grades FROM teachers ORDER BY name`, [], (err, teachers) => {
        let header = ['Teacher ID','Full Name','Phone','Assigned Sections','Assigned Grades'];
        let rows = [header.join(',')];
        teachers.forEach(t => rows.push([csvCell(t.id), csvCell(t.name), csvCell(t.phone), csvCell(t.assigned_sections), csvCell(t.assigned_grades)].join(',')));
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=all_teachers.csv');
        res.send(rows.join('\r\n'));
    });
});

app.get('/admin/export-section-students/:secName', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let secName = decodeURIComponent(req.params.secName);
    db.all(`SELECT student_id, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, status FROM students`, [], (err, allStudents) => {
        let students = allStudents.filter(s => isClassMatch(s.class_level, secName));
        let header = ['student_id','name','mother_name','gender','age','phone','emergency_phone','region','zone','woreda','kebele','class_level','payment_type','status'];
        let rows = [header.join(',')];
        students.forEach(s => rows.push(header.map(col => csvCell(s[col])).join(',')));
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=students_${secName.replace(/\s+/g, '_')}.csv`);
        res.send(rows.join('\r\n'));
    });
});

app.get('/admin/edit-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.id], (err, s) => {
        if (!s) return res.send('Not found');
        db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections) => {
            let sectionOptions = sections.map(sec => `<option value="${esc(sec.name)}" ${sec.name===s.class_level?'selected':''}>${sec.name}</option>`).join('');
            const field = (label, name, val, type='text') => `<label>${label}</label><input type="${type}" name="${name}" value="${esc(val)}" style="width:100%; padding:8px; margin-bottom:10px;">`;
            res.send(`<div style="font-family:sans-serif; padding:20px; max-width:600px; margin:auto; background:white; border-radius:10px;"><h2>✏️ Edit Student: ${s.student_id}</h2><form action="/admin/edit-student/${s.student_id}" method="POST">${field('Full Name','name',s.name)}${field("Mother's Name",'mother_name',s.mother_name)}<label>Gender</label><select name="gender" style="width:100%; padding:8px; margin-bottom:10px;"><option ${s.gender==='Male'?'selected':''}>Male</option><option ${s.gender==='Female'?'selected':''}>Female</option></select>${field('Age','age',s.age,'number')}${field('Phone','phone',s.phone)}${field('Emergency Phone','emergency_phone',s.emergency_phone)}${field('Region','region',s.region)}${field('Zone','zone',s.zone)}${field('Woreda','woreda',s.woreda)}${field('Kebele','kebele',s.kebele)}<label>Grade / Section</label><select name="class_level" style="width:100%; padding:8px; margin-bottom:10px;">${sectionOptions}</select>${field('Status','status',s.status)}${field('Admin Message','admin_message',s.admin_message)}<button type="submit" style="width:100%; padding:12px; background:#27ae60; color:white; border:none; border-radius:5px; font-weight:bold;">💾 Save Changes</button></form><br><a href="/admin">⬅️ Back to Admin</a></div>`);
        });
    });
});

// ==========================================
// ✏️ የተማሪ መረጃ ማስተካከያ (Edit Student)
// ==========================================
app.post('/admin/edit-student/:id', upload.single('bank_slip'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    
    const studentId = req.params.id;
    const { name, gender, phone, class_level } = req.body;
    
    if (req.file) {
        // 1. አዲስ ፎቶ (ፋይል) ከተመረጠ ፎቶውንም አብሮ ይቀይራል
        db.run(`UPDATE students SET name = ?, gender = ?, phone = ?, class_level = ?, bank_slip_val = ? WHERE student_id = ?`, 
        [name, gender, phone, class_level, req.file.filename, studentId], (err) => {
            res.redirect('/admin/registered-students');
        });
    } else {
        // 2. አዲስ ፎቶ ካልተመረጠ፣ የድሮውን ፎቶ ሳይነካ ሌላውን መረጃ ብቻ ይቀይራል
        db.run(`UPDATE students SET name = ?, gender = ?, phone = ?, class_level = ? WHERE student_id = ?`, 
        [name, gender, phone, class_level, studentId], (err) => {
            res.redirect('/admin/registered-students');
        });
    }
});


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
                    let sRows = students.map((s, idx) => `<tr><td><b>${idx + 1}</b></td><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td>${s.gender}</td><td>${s.cumulative_total}</td></tr>`).join('');
                    let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.teacher_name || 'N/A'}</td></tr>`).join('');
                    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Class Hub - ${className}</title><style>body{font-family:sans-serif; padding:20px; background:#f4f7f6;} .card{background:white; padding:20px; border-radius:8px; margin-bottom:15px;} table{width:100%; border-collapse:collapse; margin-top:10px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style></head><body><a href="/admin" style="background:#7f8c8d; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">⬅️ Back to Admin Dashboard</a><h2>📂 Class Hub: ${className}</h2><div class="card"><p><strong>Proctor:</strong> ${section ? section.proctor_name : 'N/A'}</p><p><strong>Total Students:</strong> ${students.length}</p></div><div class="card"><h3>📚 Courses</h3><table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Teacher</th></tr>${cRows||'<tr><td colspan="4">No courses</td></tr>'}</table></div><div class="card"><h3>🏆 Ranking</h3><table><tr><th>Rank</th><th>ID</th><th>Name</th><th>Gender</th><th>Total</th></tr>${sRows||'<tr><td colspan="5">No students</td></tr>'}</table></div></body></html>`);
                });
            });
        });
    });
});

app.get('/teacher-dashboard', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    db.get('SELECT * FROM teachers WHERE id = ?', [req.session.teacherId], (err, teacher) => {
        let assignedClasses = teacher.assigned_sections ? teacher.assigned_sections.split(',').map(s => s.trim()) : [];
        let selectedClass = (req.query.cls || assignedClasses[0] || '').trim();

        db.all('SELECT student_id, name, class_level FROM students ORDER BY name ASC', [], (err, allStudents) => {
            let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, selectedClass));
            db.all('SELECT * FROM courses WHERE teacher_id = ?', [req.session.teacherId], (err, courses) => {
                let classCourses = courses.filter(c => isClassMatch(c.class_level, selectedClass));
                let selectedCourseId = req.query.course_id || (classCourses[0] ? classCourses[0].id.toString() : '');
                let selectedCourse = classCourses.find(c => c.id.toString() === selectedCourseId) || '';

                db.all('SELECT * FROM course_assessments WHERE teacher_id = ? AND course_code = ?', [req.session.teacherId, selectedCourse ? selectedCourse.code : ''], (err, assessments) => {
                    db.all('SELECT * FROM absence_requests WHERE class_level = ? ORDER BY id DESC', [selectedClass], (err, classAbsences) => {
                        db.all('SELECT * FROM sections', [], (err, allSections) => {
                            let currentSection = allSections.find(sec => isClassMatch(sec.name, selectedClass));
                            let isProctor = currentSection && currentSection.proctor_name === teacher.name;

                            db.all("SELECT * FROM notifications WHERE sender_name = ? ORDER BY id DESC", [teacher.name], (err, mySentNotifs) => {
                                let classOptions = assignedClasses.map(cls => `<option value="${cls}" ${cls === selectedClass ? 'selected' : ''}>${cls}</option>`).join('');
                                let courseOptions = classCourses.map(c => `<option value="${c.id}" ${c.id.toString() === selectedCourseId ? 'selected' : ''}>${c.title} (${c.code})</option>`).join('');

                                let studentRows = studentsInClass.map((st, idx) => {
                                    let asm = assessments.find(a => a.student_id === st.student_id) || {};
                                    return `<tr><td>${idx + 1}</td><td>${st.student_id}</td><td style="text-align:left;">${st.name}</td><td><input form="form_${st.student_id}" type="number" name="quiz" value="${asm.quiz || 0}" style="width:60px;"></td><td><input form="form_${st.student_id}" type="number" name="mid" value="${asm.mid || 0}" style="width:60px;"></td><td><input form="form_${st.student_id}" type="number" name="final" value="${asm.final || 0}" style="width:60px;"></td><td><form id="form_${st.student_id}" class="ajax-grade-form" action="/teacher/save-grade" method="POST"><input type="hidden" name="student_id" value="${st.student_id}"><button type="submit" style="background:#27ae60; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold;">💾 Save</button></form></td></tr>`;
                                }).join('');

                                let absRows = classAbsences.map(ab => `<div style="background:#fdf2e9; padding:10px; margin-bottom:10px; border-radius:5px;"><strong>${ab.student_name}</strong> (${ab.date})<br><div>${ab.reason}</div></div>`).join('');
                                let teacherNotiRows = mySentNotifs.map(n => `<div style="background:#fdf2e9; padding:10px; margin-bottom:10px; border-radius:5px;"><div>${n.message}</div></div>`).join('');
                                let proctorPanel = isProctor ? `<div class="card" style="background:#f9fcf7; border:1px solid #27ae60;"><h3>🟢 የፕሮክተር ፓነል</h3><a href="/attendance-sheet/${encodeURIComponent(selectedClass)}" target="_blank" style="background:#16a085; color:white; padding:8px 15px; border-radius:5px; text-decoration:none; font-weight:bold; display:inline-block;">📋 Attendance Sheet</a></div>` : '';

                                res.render('teacher', {
                                    lang: 'am', teacher, selectedClass, selectedCourseId, classOptions, courseOptions, studentRows, absRows, teacherNotiRows, proctorPanel
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/teacher/send-notification', upload.single('attachment'), (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at, attachment) VALUES (?,?,?,?,?,?)`,
            ['Teacher', teacher.name, targetClass, xss(req.body.message), new Date().toLocaleString(), req.file ? req.file.filename : null], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
    });
});

app.post('/admin/save-notice', upload.single('attachment'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { title, message, target_audience } = req.body;
    let attachment = req.file ? req.file.filename : null;
    let createdAt = new Date().toISOString().split('T')[0];

    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ['Admin', 'School Admin', target_audience || 'ALL', message, attachment, createdAt], (err) => {
            res.redirect('/admin');
        });
});

app.post('/admin/send-notification', upload.single('attachment'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at, attachment) VALUES (?,?,?,?,?,?)`,
        ['Admin', 'School Admin', 'ALL', xss(req.body.message), new Date().toLocaleString(), req.file ? req.file.filename : null], () => res.redirect('/admin'));
});

app.get('/delete-notification/:id', (req, res) => { db.run(`DELETE FROM notifications WHERE id = ?`, [req.params.id], () => res.redirect('back')); });
app.get('/delete-request/:id', (req, res) => { db.run(`DELETE FROM absence_requests WHERE id = ?`, [req.params.id], () => res.redirect('back')); });

app.post('/edit-notification/:id', upload.single('attachment'), (req, res) => {
    let q = req.file ? `UPDATE notifications SET message = ?, attachment = ? WHERE id = ?` : `UPDATE notifications SET message = ? WHERE id = ?`;
    let p = req.file ? [xss(req.body.message), req.file.filename, req.params.id] : [xss(req.body.message), req.params.id];
    db.run(q, p, () => res.redirect('back'));
});

app.post('/teacher/give-feedback', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    db.run(`UPDATE absence_requests SET teacher_feedback = ? WHERE id = ?`, [xss(req.body.feedback), req.body.req_id], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
});

app.post('/teacher/save-grade', (req, res) => {
    if (!req.session.teacherId) return res.json({ error: 'Unauthorized' });
    let courseId = req.query.course_id || '';
    let { student_id, quiz, mid, final } = req.body;
    let total = (parseFloat(quiz) || 0) + (parseFloat(mid) || 0) + (parseFloat(final) || 0);
    
    db.get(`SELECT * FROM courses WHERE id = ?`, [courseId], (err, course) => {
        if(!course) return res.json({ error: 'Course not found' });
        db.get(`SELECT id FROM course_assessments WHERE student_id = ? AND teacher_id = ? AND course_code = ?`, [student_id, req.session.teacherId, course.code], (err, row) => {
            if (row) {
                db.run(`UPDATE course_assessments SET quiz=?, mid=?, final=?, total=?, remark=? WHERE id=?`, 
                [quiz, mid, final, total, total >= 50 ? 'Pass' : 'Fail', row.id], () => res.json({ success: true, total: total }));
            } else {
                db.run(`INSERT INTO course_assessments (student_id, teacher_id, course_code, course_title, quiz, mid, final, total, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
                [student_id, req.session.teacherId, course.code, course.title, quiz, mid, final, total, total >= 50 ? 'Pass' : 'Fail'], () => res.json({ success: true, total: total }));
            }
        });
    });
});

app.get('/student-dashboard', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT s.* FROM students s WHERE s.student_id = ?', [req.session.studentId], (err, student) => {
        db.all('SELECT * FROM courses ORDER BY id', [], (err, allCourses) => {
            let myCourses = allCourses.filter(c => isClassMatch(c.class_level, student.class_level));
            db.all('SELECT * FROM course_assessments WHERE student_id = ?', [student.student_id], (err, myGrades) => {
                db.all('SELECT * FROM notifications ORDER BY id DESC', [], (err, allNotifs) => {
                    let myNotifs = allNotifs.filter(n => n.target_audience === 'ALL' || isClassMatch(n.target_audience, student.class_level));
                    db.all('SELECT * FROM absence_requests WHERE student_id = ? ORDER BY id DESC', [student.student_id], (err, myAbsences) => {
                        
                        let notiRows = myNotifs.map(n => `<div style="background:#fff; padding:15px; margin-bottom:12px; border-radius:8px; border-left:4px solid #3498db; box-shadow:0 2px 4px rgba(0,0,0,0.05);"><strong style="color:#2c3e50; font-size:15px;">🔔 ${n.sender_name}</strong><div style="margin-top:8px; color:#445; font-size:14px;">${n.message}</div>${n.attachment ? `<div style="margin-top:10px;"><a href="/uploads/${n.attachment}" target="_blank" style="background:#e8f4fd; color:#2980b9; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px; font-weight:bold;">📎 ፋይል ክፈት</a></div>` : ''}</div>`).join('');
                        let myAbsRows = myAbsences.map(ab => `<div style="background:#fdfdfd; padding:12px; margin-bottom:10px; border-radius:6px; border:1px solid #eee; border-left:4px solid ${ab.teacher_feedback ? '#27ae60' : '#f39c12'};"><strong>ቀን:</strong> ${ab.date || 'N/A'}<br><strong>ምክንያት:</strong> ${ab.reason}<br><strong style="color: ${ab.teacher_feedback ? '#27ae60' : '#d35400'};">መልስ:</strong> ${ab.teacher_feedback || 'በመጠበቅ ላይ'}</div>`).join('');
                        let gradesHtml = myCourses.map(c => {
                            let asm = myGrades.find(a => a.course_code === c.code) || {};
                            let total = (asm.quiz || 0) + (asm.mid || 0) + (asm.final || 0);
                            let gradeLetter = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 75 ? 'B+' : total >= 60 ? 'B' : total >= 50 ? 'C' : 'F';
                            return `<tr><td>${c.code}</td><td style="text-align:left;"><b>${c.title}</b></td><td>${c.credit_hours}</td><td>${asm.quiz || 0}</td><td>${asm.mid || 0}</td><td>${asm.final || 0}</td><td><b>${total}</b></td><td><b>${gradeLetter}</b></td></tr>`;
                        }).join('');

                        res.render('student', { lang: 'am', student, gradesHtml, notiRows, myAbsRows });
                    });
                });
            });
        });
    });
});
// ================= ACADEMIC YEAR-END REPORT ROUTE =================
app.get('/admin/export-year-end-report', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    
    db.all(`SELECT s.*, c.code, c.title, ca.quiz, ca.mid, ca.final, ca.total, ca.remark 
            FROM students s 
            LEFT JOIN course_assessments ca ON s.student_id = ca.student_id 
            LEFT JOIN courses c ON ca.course_code = c.code 
            ORDER BY s.class_level, s.name`, [], (err, rows) => {
        
        const doc = new PDFDocument({ margin: 30, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=Amanuel_School_Year_End_Report.pdf');
        doc.pipe(res);

        // Header Styling
        doc.rect(0, 0, 612, 80).fill('#1f4e79');
        doc.fontSize(20).fillColor('#ffffff').text('AMANUEL LIGHT AND LIFE SCHOOL', 40, 20, { align: 'center' });
        doc.fontSize(12).fillColor('#f4d03f').text('Official Academic Year-End Comprehensive Report', 40, 48, { align: 'center' });
        
        doc.moveDown(3);
        doc.fontSize(14).fillColor('#333333').text('Student Performance & Grade Archive Summary', { underline: true });
        doc.moveDown(1);

        rows.forEach((r, index) => {
            if (doc.y > 700) doc.addPage();
            doc.fontSize(10).fillColor('#000000')
               .text(`${index + 1}. ID: ${r.student_id} | Name: ${r.name} | Class: ${r.class_level} | Course: ${r.title || 'N/A'} | Total: ${r.total || 0} | Status: ${r.remark || 'N/A'}`);
        });

        doc.end();
    });
});

app.post('/student/update-photo', upload.single('new_photo'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    if (req.file) {
        db.run('UPDATE students SET photo = ? WHERE student_id = ?', [req.file.filename, req.session.studentId], () => res.redirect('/student-dashboard'));
    } else {
        res.redirect('/student-dashboard');
    }
});

app.post('/student/absence', upload.single('attachment'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT name, class_level FROM students WHERE student_id=?', [req.session.studentId], (err, st) => {
        if(st) {
            db.run(`INSERT INTO absence_requests (student_id, student_name, class_level, reason, teacher_feedback, status, created_at, attachment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            [req.session.studentId, st.name, st.class_level, xss(req.body.reason), '', 'Pending', new Date().toLocaleString(), req.file ? req.file.filename : null], () => res.redirect('/student-dashboard'));
        }
    });
});

app.get('/attendance-sheet/:secName', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let sec = decodeURIComponent(req.params.secName);
    let selectedDate = req.query.date || new Date().toISOString().split('T')[0];

    db.all(`SELECT student_id, name, gender, class_level FROM students ORDER BY name ASC`, [], (err, allStudents) => {
        let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, sec));
        db.all(`SELECT * FROM daily_attendance WHERE class_level = ? AND date = ?`, [sec, selectedDate], (err, records) => {
            let attendanceMap = {}; records.forEach(r => { attendanceMap[r.student_id] = r.status; });
            let rowsHtml = '';
            for (let i = 0; i < 50; i++) {
                let st = studentsInClass[i];
                if (st) {
                    rowsHtml += `<tr><td>${i+1}</td><td>${st.student_id}</td><td style="text-align:left;">${st.name}</td><td>${st.gender}</td><td><label><input type="radio" name="status_${st.student_id}" value="Present" ${attendanceMap[st.student_id]==='Present'?'checked':''}> Present</label> &nbsp; <label><input type="radio" name="status_${st.student_id}" value="Absent" ${attendanceMap[st.student_id]==='Absent'?'checked':''}> Absent</label></td></tr>`;
                } else { rowsHtml += `<tr><td>${i+1}</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>-</td></tr>`; }
            }
            res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Attendance</title></head><body><h2>Attendance - ${sec}</h2><form action="/save-attendance" method="POST"><input type="hidden" name="class_level" value="${sec}"><input type="hidden" name="date" value="${selectedDate}"><table border="1"><tr><th>No</th><th>ID</th><th>Name</th><th>Gender</th><th>Status</th></tr>${rowsHtml}</table><button type="submit">Save</button></form></body></html>`);
        });
    });
});
app.post('/admin/promote-year', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    // ለምሳሌ አድሚኑ ከፍ ያለ ክፍል እንዲመርጥ በማድረግ ወይም አውቶማቲክ ማሻሻያ ማድረግ ይቻላል
    res.redirect('/admin');
});
// የተመዘገቡ ተማሪዎችን በሌላ ገጽ ለማሳየት የተፈጠረ ራውት
app.get('/admin/registered-students', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    
    db.all(`SELECT * FROM students ORDER BY class_level ASC, name ASC`, [], (err, allStudents) => {
        let maleCount = allStudents.filter(s => s.gender === 'Male').length;
        let femaleCount = allStudents.filter(s => s.gender === 'Female').length;
        
        let studentsByClass = {};
        allStudents.forEach(st => {
            if (!studentsByClass[st.class_level]) studentsByClass[st.class_level] = [];
            studentsByClass[st.class_level].push(st);
        });

        let groupedStudentsHtml = Object.keys(studentsByClass).map(className => {
            let trs = studentsByClass[className].map(st => `
                <tr>
                    <td style="font-weight:bold; color:#2980b9;">${st.student_id}</td>
                    <td>${st.name}</td>
                    <td><span class="am">${st.gender === 'Male' ? 'ወንድ' : 'ሴት'}</span><span class="en">${st.gender}</span></td>
                    <td>${st.phone || '-'}</td>
                    <td><a href="/uploads/${st.bank_slip_val}" target="_blank" style="color:#27ae60; font-weight:bold;">📄 <span class="am">ክፈት</span><span class="en">Open</span></a></td>
                    <td><a href="/admin/edit-student/${st.student_id}" style="color:orange;">✏️ Edit</a> | 
                        <a href="/admin/remove-student/${st.student_id}" onclick="return confirm('Are you sure? / እርግጠኛ ነዎት?')" style="color:red;">🗑️ Del</a>
                    </td>
                </tr>
            `).join('');
            return `<div style="margin-top:20px;"><h4 style="background:#1f4e79; color:white; padding:10px; border-radius:5px;">🏫 ${className} (${studentsByClass[className].length} <span class="am">ተማሪዎች</span><span class="en">Students</span>)</h4>
                    <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;">
                    <tr style="background:#f2f2f2;">
                        <th><span class="am">መታወቂያ</span><span class="en">ID</span></th>
                        <th><span class="am">ስም</span><span class="en">Name</span></th>
                        <th><span class="am">ፆታ</span><span class="en">Gender</span></th>
                        <th><span class="am">ስልክ</span><span class="en">Phone</span></th>
                        <th><span class="am">ደረሰኝ</span><span class="en">Slip</span></th>
                        <th><span class="am">ተግባር</span><span class="en">Action</span></th>
                    </tr>
                    ${trs}</table></div></div>`;
        }).join('');

        res.render('registered-students', { groupedStudentsHtml, maleCount, femaleCount });
    });
});

// 1. የዓመቱን ውጤት ፒዲኤፍ ማውረድ (Year-End PDF)
app.get('/admin/export-year-end-pdf/:className', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let className = decodeURIComponent(req.params.className);

    db.all(`SELECT * FROM students WHERE class_level = ?`, [className], (err, students) => {
        db.all(`SELECT * FROM courses WHERE class_level = ?`, [className], (err, courses) => {
            db.all(`SELECT * FROM course_assessments`, [], (err, assessments) => {
                
                const doc = new PDFDocument({ margin: 30, size: 'A4' });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=Year-End-Report-${className.replace(/\s+/g, '_')}.pdf`);
                doc.pipe(res);

                doc.fontSize(20).fillColor('#1f4e79').text('AMANUEL LIGHT AND LIFE SCHOOL', { align: 'center' });
                doc.fontSize(12).fillColor('#27ae60').text(`Official Year-End Academic Report & Grade Summary - ${className}`, { align: 'center' });
                doc.moveDown();

                students.forEach((st, idx) => {
                    doc.fontSize(12).fillColor('#000').font('Helvetica-Bold').text(`${idx + 1}. Student Name: ${st.name} (ID: ${st.student_id})`);
                    doc.font('Helvetica').fontSize(10);
                    
                    let stAssessments = assessments.filter(a => a.student_id === st.student_id);
                    let totalSum = 0;

                    courses.forEach(c => {
                        let asm = stAssessments.find(a => a.course_code === c.code) || {};
                        let tot = (asm.quiz || 0) + (asm.mid || 0) + (asm.final || 0);
                        totalSum += tot;
                        doc.text(`   - ${c.title} (${c.code}): Quiz=${asm.quiz||0}, Mid=${asm.mid||0}, Final=${asm.final||0} | Total = ${tot}`);
                    });

                    doc.fillColor('#8e44ad').text(`   * Cumulative Total Score: ${totalSum}`, { bold: true });
                    doc.moveDown(0.5);
                });

                doc.end();
            });
        });
    });
});

// 2. የዓመቱን ውጤት በማህደር ማስቀመጥ (Archive Year)
app.post('/admin/archive-year', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let currentYear = new Date().getFullYear(); 
    let archiveDate = new Date().toISOString().split('T')[0];

    db.all(`SELECT * FROM students`, [], (err, students) => {
        db.all(`SELECT * FROM course_assessments`, [], (err, assessments) => {
            students.forEach(st => {
                let stAss = assessments.filter(a => a.student_id === st.student_id);
                let totalScore = 0;
                let summary = stAss.map(a => {
                    let tot = (a.quiz || 0) + (a.mid || 0) + (a.final || 0);
                    totalScore += tot;
                    return `${a.course_code}: ${tot}`;
                }).join(' | ');

                if (totalScore > 0) { 
                    db.run(`INSERT INTO academic_archives (academic_year, student_id, student_name, class_level, courses_summary, total_score, archived_date) VALUES (?,?,?,?,?,?,?)`,
                    [currentYear.toString(), st.student_id, st.name, st.class_level, summary, totalScore, archiveDate]);
                }
            });
            
            // በማህደር ከተቀመጠ በኋላ የአሁኑን ውጤት ማጽዳት (ለአዲሱ ዓመት)
            db.run(`DELETE FROM course_assessments`, [], () => {
                db.run(`DELETE FROM daily_attendance`, [], () => res.redirect('/admin'));
            });
        });
    });
});

// 3. ተማሪዎችን ወደ ቀጣይ ክፍል ማሳደግ (Bulk Promotion)
app.post('/admin/promote-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    
    const gradeMap = {
        "Grade 1": "Grade 2", "Grade 2": "Grade 3", "Grade 3": "Grade 4",
        "Grade 4": "Grade 5", "Grade 5": "Grade 6", "Grade 6": "Grade 7",
        "Grade 7": "Grade 8", "Grade 8": "Grade 9", "Grade 9": "Grade 10",
        "Grade 10": "Grade 11", "Grade 11": "Grade 12", "Grade 12": "Graduated"
    };

    db.all(`SELECT student_id, class_level FROM students`, [], (err, students) => {
        students.forEach(st => {
            let match = st.class_level.match(/(Grade \d+)/i);
            if (match && gradeMap[match[0]]) {
                let newGrade = gradeMap[match[0]];
                let newClassLevel = st.class_level.replace(match[0], newGrade);
                
                if (newGrade === "Graduated") {
                    db.run(`UPDATE students SET status = 'Graduated' WHERE student_id = ?`, [st.student_id]);
                } else {
                    db.run(`UPDATE students SET class_level = ? WHERE student_id = ?`, [newClassLevel, st.student_id]);
                }
            }
        });
        res.redirect('/admin');
    });
});
// ==========================================
// 🚨 FORGOT PASSWORD API (Password Recovery)
// ==========================================
app.post('/api/recover-password', (req, res) => {
    const { id, phone } = req.body;
    
    // መጀመሪያ የተማሪዎችን ዳታቤዝ ይፈልጋል
    db.get(`SELECT * FROM students WHERE student_id = ? AND phone = ?`, [id, phone], (err, student) => {
        if (student) {
            // ተማሪው ከተገኘ 4 ዲጂት አዲስ ፓስወርድ ይፈጥራል
            let newPassword = Math.floor(1000 + Math.random() * 9000).toString(); 
            let hashedPassword = bcrypt.hashSync(newPassword, 10);
            
            // ፓስወርዱን ዳታቤዝ ላይ ያሳድሳል
            db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [hashedPassword, id], (updateErr) => {
                if (updateErr) return res.json({ success: false });
                res.json({ success: true, newPassword: newPassword });
            });
        } else {
            // ተማሪው ካልተገኘ ደግሞ ለመምህራን ይፈልጋል
            db.get(`SELECT * FROM teachers WHERE id = ? AND phone = ?`, [id, phone], (err2, teacher) => {
                if (teacher) {
                    let newPassword = Math.floor(1000 + Math.random() * 9000).toString(); 
                    let hashedPassword = bcrypt.hashSync(newPassword, 10);
                    
                    db.run(`UPDATE teachers SET password = ? WHERE id = ?`, [hashedPassword, id], (updateErr) => {
                        if (updateErr) return res.json({ success: false });
                        res.json({ success: true, newPassword: newPassword });
                    });
                } else {
                    res.json({ success: false });
                }
            });
        }
    });
});
// ==========================================
// 📷 BARCODE SCANNER API (Get Student Info)
// ==========================================
app.get('/api/student/:id', (req, res) => {
    const studentId = req.params.id.toUpperCase().trim();
    
    // የተማሪውን መረጃ ከዳታቤዝ ይፈልጋል
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
        if (err || !student) {
            return res.json({ success: false, message: 'Student not found' });
        }
        res.json({ success: true, student: student });
    });
});
// ==========================================
// 🗄️ አዲሶቹን የተማሪ መረጃ አምዶች (Columns) ወደ ዳታቤዝ መጨመሪያ
// ==========================================
const newStudentCols = [
    "mother_name TEXT",
    "region TEXT",
    "zone TEXT",
    "woreda TEXT",
    "kebele TEXT",
    "emergency_name TEXT",
    "emergency_phone TEXT"
];
newStudentCols.forEach(col => {
    db.run(`ALTER TABLE students ADD COLUMN ${col}`, () => {});
    db.run(`ALTER TABLE pending_students ADD COLUMN ${col}`, () => {});
});
// ==========================================
// 👩‍🏫 የመምህራን ሙሉ ምዝገባ፣ ፓስወርድ እና ዲጂታል መታወቂያ (Teacher ID System)
// ==========================================
const teacherExtraCols = [
    "gender TEXT",
    "subject TEXT",
    "emergency_name TEXT",
    "emergency_phone TEXT",
    "photo TEXT",
    "plain_pin TEXT"
];
teacherExtraCols.forEach(col => {
    db.run(`ALTER TABLE teachers ADD COLUMN ${col}`, () => {});
});

app.post('/admin/register-teacher-full', upload.single('teacher_photo'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');

    const { name, gender, phone, subject, assigned_sections, emergency_name, emergency_phone } = req.body;
    const photoFile = req.file ? req.file.filename : '';

    // አውቶማቲክ የመምህር መታወቂያ (ምሳሌ: ALLS-T-4821) እና ባለ 4 ዲጂት ፓስወርድ መፍጠሪያ
    const teacherID = 'ALLS-T-' + Math.floor(1000 + Math.random() * 9000);
    const autoPIN = Math.floor(1000 + Math.random() * 9000).toString();
    const hashedPIN = bcrypt.hashSync(autoPIN, 10);

    db.run(
        `INSERT INTO teachers (id, name, phone, password, assigned_sections) VALUES (?, ?, ?, ?, ?)`,
        [teacherID, name, phone, hashedPIN, assigned_sections || ''],
        function(err) {
            if (err) {
                console.error(err);
                return res.redirect('/admin');
            }
            db.run(
                `UPDATE teachers SET gender = ?, subject = ?, emergency_name = ?, emergency_phone = ?, photo = ?, plain_pin = ? WHERE id = ?`,
                [gender || '', subject || '', emergency_name || '', emergency_phone || '', photoFile, autoPIN, teacherID],
                () => {
                    res.redirect(`/admin/teacher-id/${teacherID}?pin=${autoPIN}`);
                }
            );
        }
    );
});

// 🪪 የመምህሩን መታወቂያ ካርድ (ID Card) እና ፓስወርድ ማሳያ ገጽ
app.get('/admin/teacher-id/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');

    const teacherID = req.params.id;
    db.get(`SELECT * FROM teachers WHERE id = ?`, [teacherID], (err, t) => {
        if (err || !t) return res.redirect('/admin');

        const displayPin = req.query.pin || t.plain_pin || '****';
        const avatarUrl = t.photo ? `/uploads/${t.photo}` : `/uploads/logo.jpg`;

        res.send(`
<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Teacher ID Card - ${t.name}</title>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
    <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #eef2f5; margin: 0; padding: 25px; display: flex; flex-direction: column; align-items: center; }
        body.lang-am .en { display: none !important; }
        body.lang-en .am { display: none !important; }

        .top-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; justify-content: center; }
        .btn { padding: 10px 18px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; color: white; font-size: 14px; }
        .btn-back { background: #7f8c8d; }
        .btn-print { background: #2980b9; }

        /* 🔑 የፓስወርድ ማሳያ ሳጥን */
        .cred-box { background: #fffcf5; border: 2px dashed #f39c12; border-radius: 10px; padding: 15px 25px; margin-bottom: 25px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05); box-sizing: border-box; }
        
        /* 🪪 ዘመናዊ የመምህር መታወቂያ ካርድ ዲዛይን */
        .id-card { width: 360px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 15px 35px rgba(0,0,0,0.2); border: 1px solid #d0d7de; position: relative; }
        .id-header { background: linear-gradient(135deg, #1f4e79 0%, #0d2b45 100%); color: white; padding: 20px 15px 45px 15px; text-align: center; border-bottom: 5px solid #f39c12; }
        .id-header img.school-logo { width: 52px; height: 52px; border-radius: 50%; border: 2px solid #f39c12; background: white; object-fit: cover; }
        .id-header h3 { margin: 8px 0 3px 0; font-size: 17px; letter-spacing: 0.5px; }
        .id-badge { display: inline-block; background: #f39c12; color: #fff; font-size: 11px; font-weight: bold; padding: 3px 12px; border-radius: 20px; text-transform: uppercase; margin-top: 4px; }

        .photo-wrap { width: 105px; height: 105px; margin: -52px auto 10px auto; border-radius: 50%; border: 4px solid white; box-shadow: 0 5px 15px rgba(0,0,0,0.2); overflow: hidden; background: #fff; }
        .photo-wrap img { width: 100%; height: 100%; object-fit: cover; }

        .id-body { padding: 5px 22px 20px 22px; text-align: center; }
        .teacher-name { font-size: 20px; font-weight: 800; color: #1f4e79; margin: 5px 0; }
        .teacher-subject { font-size: 14px; font-weight: bold; color: #8e44ad; margin-bottom: 12px; }

        .info-table { width: 100%; text-align: left; font-size: 13.5px; border-collapse: collapse; margin-bottom: 12px; }
        .info-table td { padding: 6px 4px; border-bottom: 1px solid #f0f2f5; }
        .info-table td.lbl { font-weight: bold; color: #555; width: 42%; }
        .info-table td.val { font-weight: 600; color: #2c3e50; }

        .barcode-box { background: #f8fafc; padding: 8px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 5px; }
        .id-footer { background: #1f4e79; color: white; font-size: 11.5px; padding: 8px; text-align: center; }

        @media print {
            body { background: white; padding: 0; }
            .no-print { display: none !important; }
            .id-card { box-shadow: none; border: 2px solid #1f4e79; margin: 0 auto; }
        }
    </style>
</head>
<body class="lang-am">

    <!-- 🔘 ከላይ ያሉ መቆጣጠሪያዎች (ፕሪንት ሲደረግ አይወጡም) -->
    <div class="top-bar no-print">
        <a href="/admin" class="btn btn-back">⬅️ <span class="am">ወደ አድሚን ተመለስ</span><span class="en">Back to Admin</span></a>
        <button onclick="window.print()" class="btn btn-print">🖨️ <span class="am">መታወቂያውን ፕሪንት አድርግ</span><span class="en">Print ID Card</span></button>
        <button onclick="setLang('am')" class="btn" style="background:#27ae60;">🇪🇹 አማርኛ</button>
        <button onclick="setLang('en')" class="btn" style="background:#34495e;">🇬🇧 English</button>
    </div>

    <!-- 🔑 የመምህሩ መግቢያ ሚስጥር ቁጥር (Login Credentials) -->
    <div class="cred-box no-print">
        <h3 style="margin:0 0 8px 0; color:#d35400;">
            ✅ <span class="am">መምህሩ በተሳካ ሁኔታ ተመዝግቧል!</span><span class="en">Teacher Registered Successfully!</span>
        </h3>
        <p style="font-size:13.5px; color:#555; margin:0 0 10px 0;">
            <span class="am">መምህሩ ወደ ፖርታሉ የሚገቡበት መታወቂያ እና ፓስወርድ፦</span>
            <span class="en">Teacher Login ID & Password:</span>
        </p>
        <div style="font-size:16px; background:white; padding:10px; border-radius:6px; border:1px solid #fad7a0;">
            <b>🆔 ID:</b> <span style="color:#2980b9; font-weight:bold;">${t.id}</span> &nbsp;|&nbsp;
            <b>🔑 PIN:</b> <span style="color:#e74c3c; font-weight:bold; font-size:18px;">${displayPin}</span>
        </div>
    </div>

    <!-- 🪪 የመምህሩ መታወቂያ ካርድ (Teacher ID Card) -->
    <div class="id-card">
        <div class="id-header">
            <img src="/uploads/logo.jpg" class="school-logo" alt="Logo">
            <h3>AMANUEL LIGHT & LIFE SCHOOL</h3>
            <span class="id-badge">
                <span class="am">የመምህር መታወቂያ ካርድ</span><span class="en">OFFICIAL TEACHER ID CARD</span>
            </span>
        </div>

        <div class="photo-wrap">
            <img src="${avatarUrl}" alt="Teacher Photo">
        </div>

        <div class="id-body">
            <div class="teacher-name">${t.name}</div>
            <div class="teacher-subject">📘 ${t.subject || 'Teacher'}</div>

            <table class="info-table">
                <tr>
                    <td class="lbl"><span class="am">መታወቂያ (ID):</span><span class="en">Teacher ID:</span></td>
                    <td class="val" style="color:#2980b9; font-weight:bold;">${t.id}</td>
                </tr>
                <tr>
                    <td class="lbl"><span class="am">ፆታ (Gender):</span><span class="en">Gender:</span></td>
                    <td class="val">${t.gender || '-'}</td>
                </tr>
                <tr>
                    <td class="lbl"><span class="am">ክፍል (Sections):</span><span class="en">Sections:</span></td>
                    <td class="val">${t.assigned_sections || '-'}</td>
                </tr>
                <tr>
                    <td class="lbl"><span class="am">ስልክ (Phone):</span><span class="en">Phone:</span></td>
                    <td class="val">${t.phone || '-'}</td>
                </tr>
                <tr>
                    <td class="lbl"><span class="am">የአደጋ ጊዜ ተጠሪ:</span><span class="en">Emergency:</span></td>
                    <td class="val">${t.emergency_name || '-'} (${t.emergency_phone || '-'})</td>
                </tr>
            </table>

            <div class="barcode-box">
                <svg id="barcode"></svg>
            </div>
        </div>

        <div class="id-footer">
            <span class="am">ይህ መታወቂያ የትምህርት ቤቱ ንብረት ነው</span>
            <span class="en">Property of Amanuel Light and Life School</span>
        </div>
    </div>

    <script>
        JsBarcode("#barcode", "${t.id}", {
            format: "CODE128",
            width: 1.8,
            height: 40,
            displayValue: true,
            fontSize: 13,
            margin: 0
        });

        function setLang(lang) {
            document.body.className = 'lang-' + lang;
        }
    </script>
</body>
</html>
        `);
    });
});
// ==========================================
// 🔄 ለአንድ መምህር ብዙ ክፍሎች መመደቢያ እና መምህር በመምህር መተኪያ (ውጤት ሳይጠፋ)
// ==========================================
app.post('/admin/handover-section', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');

    const { section_name, old_teacher_id, new_teacher_id } = req.body;
    if (!section_name || !new_teacher_id) return res.redirect('/admin');

    // የተመረጡትን ብዙ ክፍሎች/ሴክሽኖች መለየት
    const selectedSections = (Array.isArray(section_name) ? section_name.join(',') : section_name)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    if (selectedSections.length === 0) return res.redirect('/admin');

    // 1. የሚለቀው መምህር ተመርጦ ከሆነ የተመረጡትን ክፍሎች ከእሱ ላይ ያነሳል
    const removeOldTeacherSections = (callback) => {
        if (!old_teacher_id) return callback();
        
        db.get(`SELECT assigned_sections FROM teachers WHERE id = ?`, [old_teacher_id], (err, oldT) => {
            if (err || !oldT) return callback();
            
            let currentSecs = (oldT.assigned_sections || '')
                .split(',')
                .map(s => s.trim())
                .filter(s => s && !selectedSections.includes(s));
                
            db.run(`UPDATE teachers SET assigned_sections = ? WHERE id = ?`, [currentSecs.join(', '), old_teacher_id], () => {
                callback();
            });
        });
    };

    // 2. የተመረጡትን ብዙ ክፍሎች ለአዲሱ/ለተመረጠው መምህር ይመድባል (ውጤቶች ሳይጠፉ)
    removeOldTeacherSections(() => {
        db.get(`SELECT name, assigned_sections FROM teachers WHERE id = ?`, [new_teacher_id], (err, newT) => {
            if (err || !newT) return res.redirect('/admin');

            let newSecs = (newT.assigned_sections || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);

            selectedSections.forEach(sec => {
                if (!newSecs.includes(sec)) newSecs.push(sec);
            });

            db.run(`UPDATE teachers SET assigned_sections = ? WHERE id = ?`, [newSecs.join(', '), new_teacher_id], () => {
                selectedSections.forEach(sec => {
                    db.run(`UPDATE sections SET proctor = ? WHERE name = ?`, [newT.name, sec], () => {});
                });
                res.redirect('/admin');
            });
        });
    });
});

// ==========================================
// 📊 የዲሬክተር ሳምንታዊ እና ወርሃዊ ሪፖርት ማውጫ (Director Weekly & Monthly Report)
// ==========================================
app.get('/admin/director-report', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');

    const reportType = req.query.type === 'monthly' ? 'monthly' : 'weekly';
    const directorNote = req.query.note || '';
    const todayStr = new Date().toLocaleDateString('en-GB');

    db.all(`SELECT * FROM students`, [], (err, students = []) => {
        db.all(`SELECT * FROM pending_students`, [], (err2, pending = []) => {
            db.all(`SELECT * FROM teachers`, [], (err3, teachers = []) => {
                db.all(`SELECT * FROM sections`, [], (err4, sections = []) => {

                    const totalStudents = students.length;
                    const maleCount = students.filter(s => (s.gender || '').toLowerCase() === 'male' || s.gender === 'ወንድ').length;
                    const femaleCount = students.filter(s => (s.gender || '').toLowerCase() === 'female' || s.gender === 'ሴት').length;

                    // በየክፍሉ ያሉ ተማሪዎች ብዛት ማስያ
                    const classCounts = {};
                    students.forEach(s => {
                        const cls = s.class_level || 'Unassigned';
                        if (!classCounts[cls]) classCounts[cls] = { total: 0, male: 0, female: 0 };
                        classCounts[cls].total++;
                        if ((s.gender || '').toLowerCase() === 'male' || s.gender === 'ወንድ') classCounts[cls].male++;
                        else classCounts[cls].female++;
                    });

                    const classRowsHtml = Object.keys(classCounts).sort().map(cls => `
                        <tr>
                            <td><b>${cls}</b></td>
                            <td>${classCounts[cls].male}</td>
                            <td>${classCounts[cls].female}</td>
                            <td><b>${classCounts[cls].total}</b></td>
                        </tr>
                    `).join('') || `<tr><td colspan="4">ምንም የተመዘገበ ተማሪ የለም</td></tr>`;

                    const teacherRowsHtml = teachers.map(t => `
                        <tr>
                            <td><b>${t.id}</b></td>
                            <td>${t.name}</td>
                            <td>${t.subject || '-'}</td>
                            <td>${t.assigned_sections || '-'}</td>
                            <td>${t.phone || '-'}</td>
                        </tr>
                    `).join('') || `<tr><td colspan="5">ምንም የተመዘገበ መምህር የለም</td></tr>`;

                    res.send(`
<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <title>Director Report - Amanuel Light and Life School</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #eef2f5; margin: 0; padding: 25px; color: #2c3e50; }
        .report-page { max-width: 900px; margin: auto; background: white; padding: 35px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.1); border-top: 8px solid #1f4e79; }
        .header { text-align: center; border-bottom: 2px solid #1f4e79; padding-bottom: 15px; margin-bottom: 25px; }
        .header img { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 3px solid #1f4e79; }
        .header h1 { margin: 8px 0 4px 0; color: #1f4e79; font-size: 24px; }
        .badge { display: inline-block; background: #16a085; color: white; padding: 6px 18px; border-radius: 20px; font-weight: bold; font-size: 15px; margin-top: 5px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 25px; }
        .stat-card { background: #f8fafc; border: 1px solid #cbd5e1; border-left: 5px solid #2980b9; padding: 15px; border-radius: 8px; text-align: center; }
        .stat-card .num { font-size: 26px; font-weight: 800; color: #1f4e79; }
        .stat-card .lbl { font-size: 13px; color: #555; font-weight: bold; }
        h3 { color: #1f4e79; border-left: 4px solid #f39c12; padding-left: 10px; margin-top: 25px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
        th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: center; }
        th { background: #1f4e79; color: white; }
        .note-box { background: #fffdf5; border: 1px solid #f39c12; padding: 15px; border-radius: 8px; margin-top: 20px; }
        .sig-row { display: flex; justify-content: space-between; margin-top: 50px; padding-top: 20px; font-weight: bold; }
        .no-print { text-align: center; margin-bottom: 20px; }
        .btn { padding: 10px 20px; border: none; border-radius: 6px; color: white; font-weight: bold; cursor: pointer; text-decoration: none; margin: 0 5px; }
        @media print { body { background: white; padding: 0; } .no-print { display: none; } .report-page { box-shadow: none; border: none; } }
    </style>
</head>
<body>
    <div class="no-print">
        <button onclick="window.print()" class="btn" style="background:#2980b9;">🖨️ ፕሪንት አድርግ / Save PDF</button>
        <a href="/admin" class="btn" style="background:#7f8c8d;">⬅️ ወደ አድሚን ተመለስ</a>
    </div>

    <div class="report-page">
        <div class="header">
            <img src="/uploads/logo.jpg" alt="School Logo">
            <h1>AMANUEL LIGHT AND LIFE SCHOOL</h1>
            <div class="badge">
                ${reportType === 'monthly' ? '🗓️ የዲሬክተር ወርሃዊ ሪፖርት (Monthly Director Report)' : '📆 የዲሬክተር ሳምንታዊ ሪፖርት (Weekly Director Report)'}
            </div>
            <p style="margin:8px 0 0 0; font-size:13.5px; color:#555;">ቀን / Date: <b>${todayStr}</b></p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="num">${totalStudents}</div>
                <div class="lbl">ጠቅላላ ተማሪዎች (ወ: ${maleCount} | ሴ: ${femaleCount})</div>
            </div>
            <div class="stat-card" style="border-left-color:#e67e22;">
                <div class="num">${pending.length}</div>
                <div class="lbl">አዲስ አመልካቾች (Pending)</div>
            </div>
            <div class="stat-card" style="border-left-color:#8e44ad;">
                <div class="num">${teachers.length}</div>
                <div class="lbl">ጠቅላላ መምህራን (Teachers)</div>
            </div>
            <div class="stat-card" style="border-left-color:#27ae60;">
                <div class="num">${sections.length}</div>
                <div class="lbl">ጠቅላላ ሴክሽኖች (Sections)</div>
            </div>
        </div>

        <h3>1. የተማሪዎች ብዛት በየክፍሉ እና በፆታ (Student Enrollment by Class & Gender)</h3>
        <table>
            <tr>
                <th>ክፍል እና ሴክሽን (Class / Section)</th>
                <th>ወንድ (Male)</th>
                <th>ሴት (Female)</th>
                <th>ድምር (Total)</th>
            </tr>
            ${classRowsHtml}
        </table>

        <h3>2. የመምህራን እና የክፍል ምደባ ዝርዝር (Teachers & Assigned Sections)</h3>
        <table>
            <tr>
                <th>መታወቂያ (ID)</th>
                <th>የመምህሩ ስም (Name)</th>
                <th>ትምህርት (Subject)</th>
                <th>የተመደቡባቸው ክፍሎች (Sections)</th>
                <th>ስልክ (Phone)</th>
            </tr>
            ${teacherRowsHtml}
        </table>

        <div class="note-box">
            <b>✍️ የዲሬክተሩ ማጠቃለያ ማስታወሻ (Director's Summary Note):</b>
            <p style="margin:8px 0 0 0; line-height:1.6;">${directorNote || 'በዚህ ሳምንት/ወር የመማር ማስተማር ሂደቱ በሰላም እና በተሳካ ሁኔታ ተከናውኗል።'}</p>
        </div>

        <div class="sig-row">
            <div>የዲሬክተሩ ስምና ፊርማ፦ ________________________</div>
            <div>የትምህርት ቤቱ ማህተም፦ ________________________</div>
        </div>
    </div>
</body>
</html>
                    `);
                });
            });
        });
    });
});


app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
