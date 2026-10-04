require('dotenv').config(); 
const express = require('express');
const session = require('express-session');
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
        cb(new Error('❌ ያልተፈቀደ የፋይል አይነት ነው! ፎቶ፣ ፒዲኤፍ (PDF) ወይም ወርድ (Word) ብቻ ይላኩ።'), false);
    }
};

const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: fileFilter });

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'school-full-system-session-fix', 
    resave: false, 
    saveUninitialized: true, 
    cookie: { maxAge: 3600000 }
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

// ================= PUBLIC ROUTES (TAILWIND CSS MODERNIZED) =================
app.get('/', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const t = lang === 'en' ? {
        title: "AMANUEL LIGHT AND LIFE SCHOOL", stud: "Student", teach: "Teacher", admin: "Admin/Director",
        id: "ID Number / Username", pass: "Password PIN", btn: "Log In", reg: "New Student Registration",
        forgot: "Forgot your password?", forgotBtn: "Reset Password", type: "Account Type"
    } : {
        title: "አማኑኤል ብርሃንና ሕይወት ትምህርት ቤት", stud: "ተማሪ (Student)", teach: "መምህር (Teacher)", admin: "አድሚን (Admin)",
        id: "መታወቂያ ቁጥር (ID)", pass: "ሚስጥር ቁጥር (Password)", btn: "ግባ (Log In)", reg: "አዲስ ተማሪ ምዝገባ",
        forgot: "የይለፍ ቃልዎን ረሱ?", forgotBtn: "ፓስወርድ ዳግም አስጀምር", type: "የአካውንት አይነት"
    };

    let alertScript = '';
    if (req.query.error === 'invalid') {
        alertScript = `<script>Swal.fire({icon: 'error', title: '${lang==='en'?'Oops!':'ስህተት!'}', text: '${lang==='en'?'Invalid ID or Password!':'የተሳሳተ መለያ ወይም ፓስወርድ አስገብተዋል!'}', confirmButtonColor: '#d33'})</script>`;
    } else if (req.query.error === 'blocked') {
        alertScript = `<script>Swal.fire({icon: 'warning', title: '${lang==='en'?'Blocked!':'ታግደዋል!'}', text: '${lang==='en'?'Too many attempts. Try again in 15 mins.':'በጣም ብዙ የተሳሳተ ሙከራ! እባክዎ ከ15 ደቂቃ በኋላ ይሞክሩ።'}', confirmButtonColor: '#f39c12'})</script>`;
    }

    res.send(`
    <!DOCTYPE html><html lang="${lang}">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t.title}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-gray-200 flex items-center justify-center min-h-screen p-4">
        <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md transition-all duration-300 hover:shadow-2xl">
            <div class="flex justify-end mb-2 space-x-2 text-sm">
                <a href="/?lang=am" class="text-blue-600 hover:text-blue-800 font-bold">አማርኛ</a> <span class="text-gray-400">|</span> <a href="/?lang=en" class="text-blue-600 hover:text-blue-800 font-bold">English</a>
            </div>
            <img src="/uploads/logo.jpg" onerror="this.style.display='none'" class="w-24 h-24 mx-auto rounded-full mb-4 border-4 border-blue-100 shadow-sm object-cover">
            <h2 class="text-2xl font-extrabold text-center text-gray-800 mb-6">${t.title}</h2>
            
            <form action="/login?lang=${lang}" method="POST" class="space-y-5">
                <div>
                    <label class="block text-gray-700 text-sm font-bold mb-2">${t.type}</label>
                    <div class="relative">
                        <i class="fa-solid fa-users absolute left-3 top-3.5 text-gray-400"></i>
                        <select name="role" class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-colors cursor-pointer bg-white">
                            <option value="student">${t.stud}</option>
                            <option value="teacher">${t.teach}</option>
                            <option value="admin">${t.admin}</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label class="block text-gray-700 text-sm font-bold mb-2">${t.id}</label>
                    <div class="relative">
                        <i class="fa-solid fa-id-card absolute left-3 top-3.5 text-gray-400"></i>
                        <input type="text" name="username" placeholder="${t.id}" required class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-colors">
                    </div>
                </div>
                <div>
                    <label class="block text-gray-700 text-sm font-bold mb-2">${t.pass}</label>
                    <div class="relative">
                        <i class="fa-solid fa-lock absolute left-3 top-3.5 text-gray-400"></i>
                        <input type="password" name="password" placeholder="${t.pass}" required class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-colors">
                    </div>
                </div>
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition-transform transform hover:-translate-y-1 shadow-md flex justify-center items-center">
                    <i class="fa-solid fa-right-to-bracket mr-2"></i> ${t.btn}
                </button>
            </form>
            
            <div class="mt-5 text-center text-sm text-gray-600">
                ${t.forgot} <a href="/forgot-password?lang=${lang}" class="text-blue-500 hover:text-blue-700 hover:underline font-bold">${t.forgotBtn}</a>
            </div>
            
            <div class="my-6 border-t border-gray-200 relative">
                <span class="absolute left-1/2 transform -translate-x-1/2 -top-3 bg-white px-2 text-gray-400 text-sm font-bold">OR</span>
            </div>
            
            <a href="/student-register?lang=${lang}" class="flex justify-center items-center w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-lg transition-transform transform hover:-translate-y-1 shadow-md">
                <i class="fa-solid fa-user-plus mr-2"></i> ${t.reg}
            </a>
        </div>
        ${alertScript}
    </body>
    </html>`);
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

    res.send(`
    <!DOCTYPE html><html lang="${lang}">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${t.title}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-gray-200 flex items-center justify-center min-h-screen p-4">
        <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
            <div class="text-center mb-6">
                <div class="inline-block p-4 bg-purple-100 rounded-full mb-4">
                    <i class="fa-solid fa-key text-4xl text-purple-600"></i>
                </div>
                <h2 class="text-2xl font-extrabold text-gray-800">${t.title}</h2>
                <p class="text-gray-500 mt-2 text-sm">${t.desc}</p>
            </div>
            
            <form action="/api/forgot-password?lang=${lang}" method="POST" class="space-y-5">
                <div class="relative">
                    <i class="fa-solid fa-phone absolute left-3 top-3.5 text-gray-400"></i>
                    <input type="text" name="phone" placeholder="${t.ph}" required class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200">
                </div>
                <div class="relative">
                    <i class="fa-solid fa-person-breastfeeding absolute left-3 top-3.5 text-gray-400"></i>
                    <input type="text" name="mother_name" placeholder="${t.mom}" required class="w-full pl-10 pr-3 py-3 rounded-lg border border-gray-300 focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200">
                </div>
                <button type="submit" class="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 rounded-lg transition-transform transform hover:-translate-y-1 shadow-md">
                    ${t.btn}
                </button>
            </form>
            <div class="mt-6 text-center">
                <a href="/?lang=${lang}" class="text-gray-600 hover:text-purple-600 font-bold"><i class="fa-solid fa-arrow-left mr-1"></i> ${t.back}</a>
            </div>
        </div>
        ${alertScript}
    </body></html>`);
});

app.post('/api/forgot-password', (req, res) => {
    const lang = req.query.lang || 'am';
    const { phone, mother_name } = req.body;
    
    db.get(`SELECT student_id FROM students WHERE phone = ? AND mother_name = ?`, [phone, mother_name], (err, s) => {
        if (s) {
            let newPin = generate4DigitPIN();
            let hashedPIN = bcrypt.hashSync(newPin, 10); 
            return db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [hashedPIN, s.student_id], () => {
                res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center"><div class="inline-block p-3 bg-green-100 rounded-full mb-4"><svg class="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></div><h2 class="text-2xl font-bold text-gray-800 mb-2">ፓስወርድ ተቀይሯል!</h2><p class="text-gray-600 mb-4">አዲሱ የይለፍ ቁጥርዎ ይህ ነው (እንዳይረሱት ይፃፉት):</p><div class="text-5xl font-extrabold text-red-600 mb-6 bg-red-50 py-4 rounded-xl border border-red-200 tracking-widest shadow-inner">${newPin}</div><a href="/?lang=${lang}" class="block w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-md transition-transform hover:-translate-y-1">ወደ መግቢያ ተመለስ</a></div><script>Swal.fire({icon:'success', title:'Success', text:'Password has been reset', showConfirmButton:false, timer:1500})</script></body></html>`);
            });
        }
        res.redirect(`/forgot-password?lang=${lang}&error=notfound`);
    });
});

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    let gradeOptions = '';
    for(let i=1; i<=12; i++) gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;

    let alertScript = '';
    if (req.query.error === 'exists') {
        alertScript = `<script>Swal.fire({icon: 'error', title: 'Oops...', text: 'አስቀድመው ተመዝግበዋል! (ተደጋጋሚ ምዝገባ አይቻልም)', confirmButtonColor: '#d33'})</script>`;
    } else if (req.query.error === 'db') {
        alertScript = `<script>Swal.fire({icon: 'error', title: 'Database Error', text: 'ችግር አጋጥሟል እባክዎ እንደገና ይሞክሩ', confirmButtonColor: '#d33'})</script>`;
    }

    res.send(`
    <!DOCTYPE html><html lang="${lang}">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Student Registration</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-gray-100 py-10 px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
            <div class="bg-green-600 py-6 px-8 text-center text-white relative">
                <a href="/?lang=${lang}" class="absolute left-4 top-6 hover:text-green-200"><i class="fa-solid fa-arrow-left text-xl"></i></a>
                <h2 class="text-2xl font-bold"><i class="fa-solid fa-user-graduate mr-2"></i> አዲስ ተማሪ ምዝገባ (Registration)</h2>
            </div>
            
            <div class="p-8">
                <div class="bg-green-50 border-l-4 border-green-500 p-4 mb-8 rounded-r-lg">
                    <h4 class="text-green-800 font-bold mb-2"><i class="fa-solid fa-money-bill-wave mr-2"></i> የክፍያ አካውንቶች (Payment Accounts)</h4>
                    <p class="text-sm text-green-700"><strong>CBE (ንግድ ባንክ):</strong> 1000185928498</p>
                    <p class="text-sm text-green-700"><strong>Telebirr (ቴሌብር):</strong> 0916529382</p>
                </div>

                <form action="/api/register?lang=${lang}" method="POST" enctype="multipart/form-data" onsubmit="document.getElementById('subBtn').disabled=true; document.getElementById('subBtn').innerHTML='<i class=\\'fa-solid fa-spinner fa-spin mr-2\\'></i> እባክዎ ይጠብቁ...';">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ሙሉ ስም</label><input type="text" name="name" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">የእናት ስም</label><input type="text" name="mother_name" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ጾታ</label><select name="gender" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"><option value="Male">ወንድ (Male)</option><option value="Female">ሴት (Female)</option></select></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ዕድሜ</label><input type="number" name="age" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ስልክ ቁጥር</label><input type="text" name="phone" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">የአደጋ ጊዜ ተጠሪ ስልክ</label><input type="text" name="emergency_phone" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ክልል</label><input type="text" name="region" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ዞን / ክፍለ ከተማ</label><input type="text" name="zone" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ወረዳ</label><input type="text" name="woreda" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ቀበሌ</label><input type="text" name="kebele" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                    </div>
                    
                    <div class="mb-6">
                        <label class="block text-gray-700 text-sm font-bold mb-2">የሚገቡበት የክፍል ደረጃ</label>
                        <select name="year_level" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none">${gradeOptions}</select>
                    </div>

                    <div class="mb-6">
                        <label class="block text-gray-700 text-sm font-bold mb-2"><i class="fa-solid fa-camera mr-1"></i> የጉርድ ፎቶ (Passport Photo)</label>
                        <input type="file" name="student_photo" accept="image/*" required class="w-full p-2 border border-gray-300 border-dashed rounded-lg bg-gray-50">
                    </div>

                    <div class="mb-8 p-4 border border-gray-200 rounded-lg bg-gray-50">
                        <label class="block text-gray-700 text-sm font-bold mb-2">የክፍያ ማረጋገጫ (Payment Proof)</label>
                        <select name="payment_type" id="payType" onchange="document.getElementById('slipBox').style.display = this.value=='slip_file'?'block':'none'; document.getElementById('txnBox').style.display = this.value=='txn_id'?'block':'none';" class="w-full px-3 py-2 border border-gray-300 rounded-lg mb-4 focus:ring-2 focus:ring-green-500 focus:outline-none">
                            <option value="txn_id">የትራንዛክሽን ቁጥር (TXN ID) ማስገቢያ</option>
                            <option value="slip_file">የደረሰኝ ፎቶ (Bank Slip) ማያያዣ</option>
                        </select>
                        <div id="txnBox"><input type="text" name="txn_id" placeholder="Transaction ID ያስገቡ..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none"></div>
                        <div id="slipBox" style="display:none;"><input type="file" name="bank_slip_file" accept="image/*,.pdf" class="w-full p-2 border border-gray-300 border-dashed rounded-lg bg-white"></div>
                    </div>

                    <button type="submit" id="subBtn" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl transition-transform transform hover:-translate-y-1 shadow-lg text-lg">
                        ምዝገባ ላክ (Submit Registration)
                    </button>
                </form>
            </div>
        </div>
        ${alertScript}
    </body></html>`);
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
                    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center"><div class="inline-block p-4 bg-green-100 rounded-full mb-4"><svg class="w-16 h-16 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></div><h2 class="text-3xl font-bold text-gray-800 mb-6">ተሳክቷል! (Success)</h2><div class="bg-gray-50 p-6 rounded-xl border border-gray-200 text-left mb-6 space-y-3"><p class="text-gray-700"><strong>የተመደቡበት ክፍል:</strong> ${assignedSection}</p><p class="text-gray-700"><strong>የመታወቂያ ቁጥር:</strong> <span class="text-blue-600 font-bold text-xl">${autoID}</span></p><p class="text-gray-700"><strong>የይለፍ ቃል (PIN):</strong> <span class="text-red-600 font-extrabold text-2xl">${autoPIN}</span></p></div><p class="text-orange-500 font-bold mb-6 text-sm"><i class="fa-solid fa-clock mr-1"></i> ጥያቄዎ ለአድሚን ገምጋሚ ተልኳል፤ እስኪፀድቅ ይጠብቁ።</p><a href="/download-pending-slip/${insertedId}" class="block w-full bg-gray-800 hover:bg-gray-900 text-white font-bold py-3 rounded-lg shadow-md mb-3">📥 ፒዲኤፍ አውርድ (Download PDF)</a><a href="/?lang=${lang}" class="block w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg shadow-md">ወደ መግቢያ ተመለስ</a></div><script>Swal.fire({icon:'success', title:'Success', text:'Application submitted!', showConfirmButton:false, timer:2000})</script></body></html>`);
                });
            });
        });
    } catch (error) {
        res.redirect(`/student-register?lang=${lang}&error=db`);
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

                        // --- Data processing for charts ---
                        let maleCount = students.filter(s => s.gender === 'Male').length;
                        let femaleCount = students.filter(s => s.gender === 'Female').length;
                        
                        let excellent = 0, good = 0, average = 0, poor = 0;
                        assessments.forEach(a => {
                            if (a.total >= 90) excellent++;
                            else if (a.total >= 75) good++;
                            else if (a.total >= 50) average++;
                            else poor++;
                        });

                        // -----------------------------------

                        let pRows = pending.map(s => `<tr><td>-</td><td>${s.student_id}</td><td>${s.name}</td><td>${s.payment_type === 'slip_file' ? `<a href="/uploads/${s.bank_slip_val}" target="_blank" style="color:#2980b9;">📄 እይ</a>` : `<b>TXN:</b> ${s.bank_slip_val}`}</td><td><a href="/admin/approve/${s.id}?lang=${lang}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`).join('');

                        let secRows = sections.map(sec => `<tr><td><a href="/class-hub/${encodeURIComponent(sec.name)}" style="color:#16a085; font-weight:bold;" target="_blank">📂 ${sec.name}</a></td><td><form action="/admin/edit-section/${sec.id}?lang=${lang}" method="POST" style="display:flex; gap:4px;"><select name="proctor_name" style="width:140px;"><option value="${esc(sec.proctor_name)}">${sec.proctor_name || '-- Select --'}</option>${teachers.map(tc => `<option value="${esc(tc.name)}">${tc.name}</option>`).join('')}</select><button type="submit">Save</button></form></td><td><a href="/admin/delete-section/${sec.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td><td><a href="/attendance-sheet/${encodeURIComponent(sec.name)}" style="color:#2980b9; font-weight:bold; margin-right:10px;" target="_blank">📋 Attendance</a><a href="/admin/export-section-students/${encodeURIComponent(sec.name)}" style="background:#27ae60; color:white; padding:4px 8px; border-radius:3px; text-decoration:none; font-weight:bold;">📥 Excel</a></td></tr>`).join('');

                        let sectionOptions = sections.map(sec => `<option value="${esc(sec.name)}">${sec.name}</option>`).join('');
                        let teacherOptions = teachers.map(tc => `<option value="${tc.id}">${tc.name}</option>`).join('');
                        let gradeCheckboxes = ''; for(let i=1; i<=12; i++) gradeCheckboxes += `<label style="margin-right:8px;"><input type="checkbox" name="grades" value="Grade ${i}"> Grade ${i}</label>`;
                        let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.credit_hours}</td><td>${c.class_level}</td><td>${c.teacher_name||'-'}</td><td><a href="/admin/delete-course/${c.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');
                        let tRows = teachers.map(tc => `<tr><td>${tc.id}</td><td style="text-align:left;">${tc.name}</td><td>${tc.assigned_grades || 'None'}</td><td>${tc.assigned_sections || 'None'}</td><td>${tc.phone}</td><td><span style="color:red; font-weight:bold;">[Hashed]</span></td><td><a href="/admin/edit-teacher/${tc.id}?lang=${lang}" style="color:#2980b9; font-weight:bold;">✏️ Edit</a></td><td><a href="/admin/delete-teacher/${tc.id}?lang=${lang}" onclick="return confirm('Remove?')" style="color:red; font-weight:bold;">🗑️ Remove</a></td></tr>`).join('');

                        let adminNotiRows = adminNotifs.map(n => `<div style="background:#fdf2e9; padding:10px; margin-bottom:10px; border-radius:5px;"><strong>🔔 ${n.sender_name} (${n.created_at})</strong><br><div>${n.message}</div>${n.attachment ? `<br><a href="/uploads/${n.attachment}" target="_blank" style="color:blue; font-weight:bold;">📎 ፋይል ክፈት</a>` : ''}<div style="margin-top:10px; border-top:1px solid #ccc; padding-top:5px;"><button onclick="document.getElementById('editNotif_${n.id}').style.display='block'" style="background:orange; color:white; border:none; padding:3px 8px; border-radius:3px; cursor:pointer;">✏️ Edit</button> <a href="/delete-notification/${n.id}" onclick="return confirm('እርግጠኛ ነዎት ይጠፋ?')" style="background:red; color:white; padding:4px 8px; border-radius:3px; text-decoration:none; font-size:13px;">🗑️ Delete</a><form id="editNotif_${n.id}" action="/edit-notification/${n.id}" method="POST" enctype="multipart/form-data" style="display:none; margin-top:10px;"><textarea name="message" rows="3" style="width:100%;">${n.message.replace(/<[^>]+>/g, '')}</textarea><input type="file" name="attachment" style="margin-top:5px;"><button type="submit" style="background:green; color:white; border:none; padding:4px 8px; margin-top:5px;">💾 Save</button></form></div></div>`).join('');

                        let groupedStudentsHtml = '';
                        let uniqueClasses = [...new Set(students.map(s => s.class_level))];
                        if (uniqueClasses.length === 0) groupedStudentsHtml = '<p style="text-align:center; color:#777;">No students registered yet.</p>';
                        uniqueClasses.forEach(cls => {
                            let clsStudents = students.filter(s => s.class_level === cls);
                            let rows = clsStudents.map(s => `<tr><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td>${s.phone}</td><td><span style="color:red; font-weight:bold;">[Hashed]</span></td><td><a href="/admin/edit-student/${s.student_id}?lang=${lang}" style="color:#2980b9; font-weight:bold;">✏️ Edit</a></td><td><form action="/admin/update-pass?lang=${lang}" method="POST" style="display:flex; justify-content:center; gap:4px;"><input type="hidden" name="type" value="student"><input type="hidden" name="id" value="${s.student_id}"><input type="text" name="new_pass" placeholder="New PIN" style="width:70px; padding:4px;"><button type="submit" style="padding:4px; font-size:12px;">Reset</button></form></td><td><a href="/admin/delete-student/${s.student_id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');
                            groupedStudentsHtml += `<div style="margin-bottom:30px; border:1px solid #ddd; padding:15px; border-radius:8px; background:#fdfdfd;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;"><h4 style="color:#2c3e50; margin:0;">📂 ${cls} (Total: ${clsStudents.length})</h4><a href="/admin/export-section-students/${encodeURIComponent(cls)}" style="background:#27ae60; color:white; padding:5px 10px; border-radius:3px; text-decoration:none; font-size:12px; font-weight:bold;">📥 Excel</a></div><div style="overflow-x:auto;"><table style="width:100%; min-width:600px; border-collapse:collapse; text-align:center; font-size:14px;"><tr style="background:#1f4e79; color:white;"><th>ID</th><th>Name</th><th>Phone</th><th>Password</th><th>Edit</th><th>Reset Pass</th><th>Delete</th></tr>${rows}</table></div></div>`;
                        });

                        res.send(`
                        <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Director Hub</title>
                        <style>body{font-family:sans-serif; background:#eef2f5; padding:20px;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; overflow-x:auto; box-shadow: 0 2px 4px rgba(0,0,0,0.05);} table{width:100%; border-collapse:collapse; min-width:600px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#2c3e50; color:white;} input,select{padding:6px;} .toggle-btn { background:#2c3e50; color:white; padding:15px 30px; font-size:16px; border:none; border-radius:8px; cursor:pointer; font-weight:bold; width:100%; max-width:400px; margin: 10px auto; display:block;} .charts-container { display: flex; flex-wrap: wrap; gap: 20px; } .chart-box { flex: 1; min-width: 300px; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }</style>
                        <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
                        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
                        <script>function toggleSection(id) { var el = document.getElementById(id); el.style.display = el.style.display === 'none' ? 'block' : 'none'; }</script>
                        </head>
                        <body>
                            <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;"> 🔐 የዳይሬክተር / አድሚን መቆጣጠሪያ</h2>
                            
                            <!-- Charts Section -->
                            <div class="charts-container mb-20">
                                <div class="chart-box">
                                    <h3 style="text-align:center; color:#2c3e50;">የተማሪዎች ውጤት ስርጭት</h3>
                                    <canvas id="performanceChart"></canvas>
                                </div>
                                <div class="chart-box">
                                    <h3 style="text-align:center; color:#2c3e50;">የተማሪዎች የስርዓተ-ፆታ ስብጥር</h3>
                                    <canvas id="genderChart"></canvas>
                                </div>
                            </div>
                            <!-- End Charts Section -->

                            <div class="card" style="background:#e8f4fd;"><h3 style="color:#2980b9;">📢 አዲስ ማስታወቂያ ላክ</h3><form action="/admin/send-notification" method="POST" enctype="multipart/form-data" id="notifForm"><div id="editor" style="height: 120px; background: white; margin-bottom: 10px;"></div><input type="hidden" name="message" id="hiddenMessage" required><label style="font-size: 13px; font-weight:bold; display:block; margin: 10px 0;">📎 ፎቶ ወይም ፋይል አያይዝ (አማራጭ):</label><input type="file" name="attachment" accept="image/*,.pdf,.doc,.docx" style="margin-bottom:10px;"><br><button type="submit" style="background:#3498db; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Send Notification</button></form><hr style="margin:20px 0;"><h3 style="color:#555;">📋 የላኳቸው ማስታወቂያዎች</h3>${adminNotiRows || '<p style="color:#777;">ምንም መልዕክት አልተላከም</p>'}</div>
                            <div class="card"><h3>📁 የዳይሬክተር ሳምንታዊ እና ወርሃዊ ሪፖርት</h3><a href="/director-report" target="_blank" style="background:#8e44ad; color:white; padding:10px 15px; text-decoration:none; border-radius:5px; font-weight:bold; display:inline-block;">📁 View Director Academic Year Report</a></div>
                            <div class="card"><h3>አዲስ ተመዝጋቢዎች (Pending)</h3><table><tr><th>Photo</th><th>ID</th><th>Name</th><th>Payment</th><th>Action</th></tr>${pRows||'<tr><td colspan="5">None</td></tr>'}</table></div>
                            <div class="card"><h3>ክፍሎችን እና ተቆጣጣሪዎችን (Proctors) ማስተዳደሪያ</h3><form action="/admin/add-section?lang=${lang}" method="POST" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;"><input type="text" name="name" placeholder="Class Name (e.g. Grade 1 - Section A)" required style="flex:2;"><select name="proctor_name" style="flex:1;"><option value="">-- Select Proctor Teacher --</option>${teachers.map(tc => `<option value="${esc(tc.name)}">${tc.name}</option>`).join('')}</select><button type="submit" style="background:#2980b9; color:white; border:none; padding:8px 14px; border-radius:5px;">➕ Add Section</button></form><table><tr><th>Section Name</th><th>Proctor Name (Teacher)</th><th>Delete</th><th>Sheets & Excel</th></tr>${secRows||'<tr><td colspan="4">None</td></tr>'}</table></div>
                            <div class="card"><h3>አዲስ መምህር ማካተቻ</h3><form action="/admin/add-teacher?lang=${lang}" method="POST" style="margin-bottom:15px; background:#f9f9f9; padding:15px; border-radius:5px;"><div style="display:flex; gap:10px; margin-bottom:10px;"><input type="text" name="name" placeholder="Teacher Full Name" required style="flex:1;"><input type="text" name="phone" placeholder="Phone Number" required style="flex:1;"><input type="text" name="assigned_sections" placeholder="Assigned Sections" required style="flex:2;"></div><label style="font-weight:bold; font-size:13px;">Assign Grades:</label><br><div style="margin:8px 0; display:flex; flex-wrap:wrap; gap:10px;">${gradeCheckboxes}</div><button type="submit" style="background:#2980b9; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">➕ Add Teacher</button></form></div>
                            <div class="card"><h3>ትምህርቶችን / Courses ማስተዳደሪያ</h3><form action="/admin/add-course?lang=${lang}" method="POST" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;"><input type="text" name="code" placeholder="Course Code" required><input type="text" name="title" placeholder="Course Title" required><input type="number" name="credit_hours" placeholder="Cr.Hr" required style="width:80px;"><select name="class_level">${sectionOptions}</select><select name="teacher_id"><option value="">-- No Teacher --</option>${teacherOptions}</select><button type="submit" style="background:#2980b9; color:white; border:none; padding:8px 14px; border-radius:5px;">➕ Add Course</button></form><table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Section</th><th>Teacher</th><th>Delete</th></tr>${cRows||'<tr><td colspan="6">None</td></tr>'}</table></div>
                            <div style="text-align:center; padding: 40px 0; border-top: 2px dashed #ccc; margin-top:30px;"><h3 style="color:#555;">የተማሪዎች እና መምህራን ዝርዝር መረጃ</h3><button onclick="toggleSection('teachersList')" class="toggle-btn" style="background:#8e44ad;">👨‍🏫 ሁሉንም መምህራን አሳይ</button><button onclick="toggleSection('studentsList')" class="toggle-btn" style="background:#27ae60;">🎓 ሁሉንም ተማሪዎች አሳይ</button></div>
                            <div id="teachersList" class="card" style="display:none; border:2px solid #8e44ad;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;"><h3 style="color:#8e44ad; margin:0;">👨‍🏫 የሁሉም መምህራን ዝርዝር</h3><a href="/admin/export-teachers" style="background:#8e44ad; color:white; padding:8px 15px; border-radius:5px; text-decoration:none; font-weight:bold;">📊 Total Teachers (Excel)</a></div><table><tr><th>ID</th><th>Name</th><th>Grades</th><th>Classes</th><th>Phone</th><th>Password</th><th>Edit</th><th>Remove</th></tr>${tRows||'<tr><td colspan="8">None</td></tr>'}</table></div>
                            <div id="studentsList" class="card" style="display:none; border:2px solid #27ae60;"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;"><h3 style="color:#27ae60; margin:0;">🎓 የሁሉም ተማሪዎች ዝርዝር (በየክፍሉ)</h3><a href="/admin/export-students" style="background:#27ae60; color:white; padding:8px 15px; border-radius:5px; text-decoration:none; font-weight:bold;">📊 Total Students (Excel)</a></div>${groupedStudentsHtml}</div>
                            <br><div style="text-align:center;"><a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 ውጣ (Logout)</a></div><br><br>
                            <script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
                            <script>
                                var quill = new Quill('#editor', { theme: 'snow', modules: { toolbar: [ [{ 'font': [] }, { 'size': [] }], ['bold', 'italic', 'underline', 'strike'], [{ 'color': [] }, { 'background': [] }], [{ 'align': [] }], ['link', 'image'] ] }}); 
                                document.getElementById('notifForm').onsubmit = function() { document.getElementById('hiddenMessage').value = quill.root.innerHTML; };
                                
                                // Chart.js Initialization
                                const perfCtx = document.getElementById('performanceChart').getContext('2d');
                                new Chart(perfCtx, {
                                    type: 'bar',
                                    data: {
                                        labels: ['Excellent (>=90)', 'Good (75-89)', 'Average (50-74)', 'Poor (<50)'],
                                        datasets: [{
                                            label: 'Students Count',
                                            data: [${excellent}, ${good}, ${average}, ${poor}],
                                            backgroundColor: [
                                                'rgba(39, 174, 96, 0.7)',
                                                'rgba(41, 128, 185, 0.7)',
                                                'rgba(241, 196, 15, 0.7)',
                                                'rgba(231, 76, 60, 0.7)'
                                            ],
                                            borderColor: [
                                                'rgb(39, 174, 96)',
                                                'rgb(41, 128, 185)',
                                                'rgb(241, 196, 15)',
                                                'rgb(231, 76, 60)'
                                            ],
                                            borderWidth: 1
                                        }]
                                    },
                                    options: { responsive: true, scales: { y: { beginAtZero: true } } }
                                });

                                const genderCtx = document.getElementById('genderChart').getContext('2d');
                                new Chart(genderCtx, {
                                    type: 'pie',
                                    data: {
                                        labels: ['Male', 'Female'],
                                        datasets: [{
                                            data: [${maleCount}, ${femaleCount}],
                                            backgroundColor: [
                                                'rgba(52, 152, 219, 0.8)',
                                                'rgba(233, 30, 99, 0.8)'
                                            ]
                                        }]
                                    },
                                    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
                                });
                            </script>
                        </body></html>`);
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
        [st.student_id, st.password, st.name, st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.region, st.zone, st.woreda, st.kebele, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', '🎉 Your registration is approved! Download your Digital ID.'], () => {
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

app.post('/admin/edit-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, status, admin_message } = req.body;
    db.run(`UPDATE students SET name=?, mother_name=?, gender=?, age=?, phone=?, emergency_phone=?, region=?, zone=?, woreda=?, kebele=?, class_level=?, status=?, admin_message=? WHERE student_id=?`,
    [name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, status, admin_message, req.params.id], () => res.redirect('/admin'));
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
                    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Class Hub - ${className}</title><style>body{font-family:sans-serif; padding:20px; background:#f4f7f6;} .card{background:white; padding:20px; border-radius:8px; margin-bottom:15px;} table{width:100%; border-collapse:collapse; margin-top:10px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style></head><body><a href="/admin" style="background:#7f8c8d; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">⬅️ Back to Admin Dashboard</a><h2>📂 Class Hub: ${className}</h2><div class="card"><p><strong>Proctor / Attendance Monitor:</strong> ${section ? section.proctor_name : 'N/A'}</p><p><strong>Total Students:</strong> ${students.length}</p><a href="/attendance-sheet/${encodeURIComponent(className)}" target="_blank" style="background:#2980b9; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">📋 Attendance Sheet</a></div><div class="card"><h3>📚 Subjects / Courses for this Class</h3><table><tr><th>Code</th><th>Title</th><th>Cr.Hr</th><th>Teacher</th></tr>${cRows||'<tr><td colspan="4">No courses</td></tr>'}</table></div><div class="card"><h3>🏆 Students Ranking List in ${className}</h3><table><tr><th>Rank</th><th>ID</th><th>Full Name</th><th>Gender</th><th>Total Score</th></tr>${sRows||'<tr><td colspan="5">No students</td></tr>'}</table></div></body></html>`);
                });
            });
        });
    });
});

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
                if (!selectedCourse && classCourses.length > 0) { selectedCourse = classCourses[0]; selectedCourseId = selectedCourse.id; }

                db.all(`SELECT * FROM course_assessments WHERE teacher_id = ? AND course_code = ?`, [req.session.teacherId, selectedCourse ? selectedCourse.code : ''], (err, assessments) => {
                    db.all(`SELECT * FROM absence_requests ORDER BY id DESC`, [], (err, allAbsences) => {
                        let classAbsences = allAbsences.filter(ab => isClassMatch(ab.class_level, selectedClass));
                        db.all(`SELECT * FROM sections`, [], (err, allSections) => {
                            let currentSection = allSections.find(sec => isClassMatch(sec.name, selectedClass)) || {};
                            let isProctor = currentSection.proctor_name === teacher.name;

                            db.all(`SELECT * FROM notifications WHERE sender_name = ? ORDER BY id DESC`, [teacher.name], (err, mySentNotifs) => {
                                let classOptions = assignedClasses.map(c => `<option value="${esc(c)}" ${c === selectedClass ? 'selected' : ''}>${c}</option>`).join('');
                                let courseOptions = classCourses.map(c => `<option value="${c.id}" ${c.id.toString() === (selectedCourseId||'').toString() ? 'selected' : ''}>${c.title} (${c.code})</option>`).join('');

                                let studentRows = studentsInClass.map((st, idx) => {
                                    let asm = assessments ? assessments.find(a => a.student_id === st.student_id) || {} : {};
                                    return `<tr><td><b>${idx + 1}</b></td><td>${st.student_id}</td><td>${st.name}</td><form action="/teacher/save-grade?cls=${encodeURIComponent(selectedClass)}&course_id=${selectedCourseId}" method="POST"><input type="hidden" name="student_id" value="${st.student_id}"><td><input type="number" name="quiz" value="${asm.quiz!==undefined?asm.quiz:''}" min="0" max="20" style="width:50px;"></td><td><input type="number" name="mid" value="${asm.mid!==undefined?asm.mid:''}" min="0" max="30" style="width:50px;"></td><td><input type="number" name="final" value="${asm.final!==undefined?asm.final:''}" min="0" max="50" style="width:50px;"></td><td><strong>${asm.total||0}</strong></td><td><button type="submit" style="background:#27ae60;color:white;border:none;padding:5px 10px; border-radius:3px; cursor:pointer;">💾 Save</button></td></form></tr>`;
                                }).join('');

                                let absRows = classAbsences.map(ab => `<div style="background:#fdf2e9; padding:10px; border-left:4px solid #e67e22; margin-bottom:10px;"><strong>${ab.student_name} (${ab.student_id})</strong> - <em>${ab.created_at}</em><br>📝 <strong>መልዕክት:</strong> ${ab.reason}<br>${ab.attachment ? `<a href="/uploads/${ab.attachment}" target="_blank" style="color:blue;">📎 ፋይል/ማስረጃ ክፈት</a><br>` : ''}${ab.teacher_feedback ? `<span style="color:green; font-weight:bold;">💬 Your Feedback: ${ab.teacher_feedback}</span>` : `<form action="/teacher/give-feedback?cls=${encodeURIComponent(selectedClass)}" method="POST" style="margin-top:5px; display:flex; gap:5px;"><input type="hidden" name="req_id" value="${ab.id}"><input type="text" name="feedback" placeholder="Reply..." required style="flex:1; padding:4px;"><button type="submit" style="background:#16a085; color:white; border:none; padding:4px 8px; border-radius:3px;">Send</button></form>`}</div>`).join('');

                                let teacherNotiRows = mySentNotifs.map(n => `<div style="background:#e8f4fd; padding:10px; margin-bottom:10px; border-radius:5px;"><strong>🔔 ወደ ${n.target_audience} የተላከ (${n.created_at})</strong><br><div>${n.message}</div>${n.attachment ? `<br><a href="/uploads/${n.attachment}" target="_blank" style="color:blue; font-weight:bold;">📎 ፋይል ክፈት</a>` : ''}<div style="margin-top:10px; border-top:1px solid #ccc; padding-top:5px;"><button onclick="document.getElementById('editNotif_${n.id}').style.display='block'" style="background:orange; color:white; border:none; padding:3px 8px; border-radius:3px; cursor:pointer;">✏️ Edit</button> <a href="/delete-notification/${n.id}" onclick="return confirm('እርግጠኛ ነዎት ይጠፋ?')" style="background:red; color:white; padding:4px 8px; border-radius:3px; text-decoration:none; font-size:13px;">🗑️ Delete</a><form id="editNotif_${n.id}" action="/edit-notification/${n.id}" method="POST" enctype="multipart/form-data" style="display:none; margin-top:10px;"><textarea name="message" rows="3" style="width:100%;">${n.message.replace(/<[^>]+>/g, '')}</textarea><input type="file" name="attachment" style="margin-top:5px;"><button type="submit" style="background:green; color:white; border:none; padding:4px 8px; margin-top:5px;">💾 Save Edit</button></form></div></div>`).join('');

                                let proctorPanel = isProctor ? `<div class="card" style="background:#f9fcf7; border: 1px solid #c3e6cb;"><h3 style="color:#27ae60; margin-top:0;">👑 የክፍል ተቆጣጣሪ (Proctor)</h3><p><b>የአሁኑ የክፍል ተጠሪ (Monitor):</b> ${currentSection.class_monitor || '<span style="color:red;">ያልተመደበ (None)</span>'}</p><form action="/teacher/assign-monitor?cls=${encodeURIComponent(selectedClass)}" method="POST" style="display:flex; gap:10px; max-width:400px; margin-top:10px;"><select name="monitor_name" style="flex:1; padding:8px; border-radius:4px;"><option value="">-- የክፍል ተጠሪ (Monitor) ይምረጡ --</option>${studentsInClass.map(s => `<option value="${esc(s.name)}">${s.name}</option>`).join('')}</select><button type="submit" style="background:#27ae60; color:white; border:none; padding:8px 15px; border-radius:4px; font-weight:bold;">መድብ (Assign)</button></form></div>` : '';

                                res.send(`
                                <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Teacher Dashboard</title>
                                <style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1); overflow-x:auto;} table{width:100%; border-collapse:collapse; margin-top:10px; min-width:400px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style>
                                <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
                                </head>
                                <body>
                                <div style="max-width:900px; margin:auto;">
                                    <h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;">👨‍🏫 Teacher Portal: ${teacher.name}</h2>
                                    <form method="GET" action="/teacher-dashboard" style="background:#eef2f5; padding:15px; border-radius:5px; margin-bottom:15px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;"><div style="flex:1; min-width:200px;"><label style="font-weight:bold;">1. ክፍል ምረጥ (Select Class):</label><br><select name="cls" onchange="this.form.submit()" style="width:100%; padding:8px; border-radius:4px; margin-top:5px;">${classOptions || '<option>No Classes Assigned</option>'}</select></div><div style="flex:1; min-width:200px;"><label style="font-weight:bold;">2. ትምህርት ምረጥ (Select Course):</label><br><select name="course_id" onchange="this.form.submit()" style="width:100%; padding:8px; border-radius:4px; margin-top:5px;">${courseOptions || '<option value="">No Courses Assigned for this Class</option>'}</select></div></form>
                                    ${proctorPanel}
                                    ${selectedClass ? `<div style="margin-bottom:15px;"><a href="/attendance-sheet/${encodeURIComponent(selectedClass)}" target="_blank" style="background:#2980b9; color:white; padding:10px; display:inline-block; border-radius:5px; text-decoration:none; margin-right:10px; font-weight:bold;">📋 Daily Attendance Sheet (${selectedClass})</a></div><div style="display:flex; gap:20px; flex-wrap:wrap;"><div class="card" style="flex:1; min-width:300px;"><h3 style="color:#2980b9;">📢 ማስታወቂያ ላክ ወደ ${selectedClass}</h3><form action="/teacher/send-notification?cls=${encodeURIComponent(selectedClass)}" method="POST" enctype="multipart/form-data" id="teacherNotifForm"><div id="editorTeacher" style="height: 100px; background: white; margin-bottom: 10px;"></div><input type="hidden" name="message" id="hiddenMessageTeacher" required><label style="font-size: 13px; font-weight:bold; display:block; margin:10px 0;">📎 ፎቶ ወይም ፋይል አያይዝ:</label><input type="file" name="attachment" accept="image/*,.pdf,.doc,.docx" style="margin-bottom:10px; width:100%;"><button type="submit" style="background:#3498db; color:white; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Send Notification</button></form><hr style="margin:20px 0;"><h3 style="color:#555;">📋 እርስዎ የላኳቸው ማስታወቂያዎች</h3>${teacherNotiRows || '<p style="color:#777;">ምንም መልዕክት አልተላከም</p>'}</div><div class="card" style="flex:1; min-width:300px; max-height: 400px; overflow-y:auto; border:1px solid #ccc;"><h3>📩 Student Requests (${selectedClass})</h3>${absRows || '<p style="color:#777;">No requests.</p>'}</div></div><div style="overflow-x:auto;"><h3 style="background:#1f4e79; color:white; padding:10px; margin:0; border-top-left-radius:5px; border-top-right-radius:5px;">📝 የውጤት መሙያ (Grades) - ${selectedCourse ? selectedCourse.title : 'No Course Selected'}</h3><table border="1" width="100%" style="border-collapse:collapse; text-align:center; min-width:600px; background:white;"><tr style="background:#eef2f5;"><th>No</th><th>ID</th><th>Name</th><th>Quiz(20)</th><th>Mid(30)</th><th>Final(50)</th><th>Total</th><th>Action</th></tr>${selectedCourse ? (studentRows || '<tr><td colspan="8">No students in this class</td></tr>') : '<tr><td colspan="8">Please select a course to enter grades.</td></tr>'}</table></div>` : ''}
                                    <br><br><a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 Logout</a>
                                </div>
                                <script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
                                <script>var quill = new Quill('#editorTeacher', { theme: 'snow', modules: { toolbar: [ [{ 'font': [] }, { 'size': [] }], ['bold', 'italic', 'underline', 'strike'], [{ 'color': [] }, { 'background': [] }], [{ 'align': [] }], ['link', 'image'] ] }}); var form = document.getElementById('teacherNotifForm'); if(form) { form.onsubmit = function() { document.getElementById('hiddenMessageTeacher').value = quill.root.innerHTML; }; }</script>
                                </body></html>`);
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/teacher/assign-monitor', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        db.all(`SELECT * FROM sections`, [], (err, sections) => {
            let section = sections.find(sec => isClassMatch(sec.name, targetClass));
            if(section && section.proctor_name === teacher.name) {
                db.run(`UPDATE sections SET class_monitor = ? WHERE id = ?`, [req.body.monitor_name, section.id], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
            } else { res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`); }
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

app.post('/edit-request/:id', upload.single('attachment'), (req, res) => {
    let q = req.file ? `UPDATE absence_requests SET reason = ?, attachment = ? WHERE id = ?` : `UPDATE absence_requests SET reason = ? WHERE id = ?`;
    let p = req.file ? [xss(req.body.reason), req.file.filename, req.params.id] : [xss(req.body.reason), req.params.id];
    db.run(q, p, () => res.redirect('back'));
});

app.post('/teacher/give-feedback', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    db.run(`UPDATE absence_requests SET teacher_feedback = ? WHERE id = ?`, [xss(req.body.feedback), req.body.req_id], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`));
});

app.post('/teacher/save-grade', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    let targetClass = req.query.cls || '';
    let courseId = req.query.course_id || '';
    let { student_id, quiz, mid, final } = req.body;
    let total = (parseFloat(quiz) || 0) + (parseFloat(mid) || 0) + (parseFloat(final) || 0);
    
    db.get(`SELECT * FROM courses WHERE id = ?`, [courseId], (err, course) => {
        if(!course) return res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}`);
        db.get(`SELECT id FROM course_assessments WHERE student_id = ? AND teacher_id = ? AND course_code = ?`, [student_id, req.session.teacherId, course.code], (err, row) => {
            if (row) {
                db.run(`UPDATE course_assessments SET quiz=?, mid=?, final=?, total=?, remark=? WHERE id=?`, 
                [quiz, mid, final, total, total >= 50 ? 'Pass' : 'Fail', row.id], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}&course_id=${courseId}`));
            } else {
                db.run(`INSERT INTO course_assessments (student_id, teacher_id, course_code, course_title, quiz, mid, final, total, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
                [student_id, req.session.teacherId, course.code, course.title, quiz, mid, final, total, total >= 50 ? 'Pass' : 'Fail'], () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(targetClass)}&course_id=${courseId}`));
            }
        });
    });
});

app.get('/student-dashboard', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get(`SELECT s.* FROM students s WHERE s.student_id = ?`, [req.session.studentId], (err, student) => {
        db.all(`SELECT * FROM courses ORDER BY id`, [], (err, allCourses) => {
            let myCourses = allCourses.filter(c => isClassMatch(c.class_level, student.class_level));
            db.all(`SELECT * FROM course_assessments WHERE student_id = ?`, [student.student_id], (err, myGrades) => {
                db.all(`SELECT * FROM sections`, [], (err, allSections) => {
                    let section = allSections.find(sec => isClassMatch(sec.name, student.class_level)) || { proctor_name: "N/A", proctor_phone: "-", class_monitor: "ያልተመደበ" };
                    db.all(`SELECT * FROM notifications ORDER BY id DESC`, [], (err, allNotifs) => {
                        db.all(`SELECT * FROM absence_requests WHERE student_id = ? ORDER BY id DESC`, [student.student_id], (err, myAbsences) => {
                            let myNotifs = allNotifs.filter(n => n.target_audience === 'ALL' || isClassMatch(n.target_audience, student.class_level));
                            let notiRows = myNotifs.map(n => `<div style="background:${n.sender_role==='Admin'?'#f8d7da':'#d1ecf1'}; color:${n.sender_role==='Admin'?'#721c24':'#0c5460'}; padding:10px; margin-bottom:10px; border-radius:5px; border-left:5px solid ${n.sender_role==='Admin'?'#f5c6cb':'#bee5eb'};"><strong style="font-size:12px;">🔔 From: ${n.sender_name} (${n.created_at})</strong><br><div style="margin-top:5px;">${n.message}</div>${n.attachment ? `<br><a href="/uploads/${n.attachment}" target="_blank" style="color:blue; font-weight:bold; display:inline-block; margin-top:5px;">📎 ፋይል ክፈት</a>` : ''}</div>`).join('');

                            let myAbsRows = myAbsences.map(ab => {
                                let actionBtns = !ab.teacher_feedback ? `<div style="margin-top:10px;"><a href="/delete-request/${ab.id}" onclick="return confirm('መልዕክቱ ይጠፋል፣ እርግጠኛ ነዎት?')" style="color:red; font-size:13px; font-weight:bold; margin-right:15px;">🗑️ ሰርዝ (Delete)</a><button onclick="document.getElementById('editReq_${ab.id}').style.display='block'" style="background:transparent; border:none; color:orange; font-weight:bold; cursor:pointer;">✏️ አስተካክል (Edit)</button><form id="editReq_${ab.id}" action="/edit-request/${ab.id}" method="POST" enctype="multipart/form-data" style="display:none; margin-top:5px;"><textarea name="reason" style="width:100%; padding:5px;">${ab.reason.replace(/\[ለ: .*?\] - /, '')}</textarea><input type="file" name="attachment" style="margin-top:5px; font-size:12px;"><button type="submit" style="background:green; color:white; padding:5px; border:none; border-radius:3px;">አድስ (Save)</button></form></div>` : `<div style="margin-top:5px;"><span style="font-size:12px; color:gray;">(መምህሩ ምላሽ ስለሰጠ Edit አይቻልም)</span></div>`;
                                return `<div style="background:#f9f9f9; padding:10px; border:1px solid #ddd; margin-bottom:8px; border-radius:4px;"><small>📅 ${ab.created_at}</small><br><strong>መልዕክት:</strong> ${ab.reason}${ab.attachment ? `<br><a href="/uploads/${ab.attachment}" target="_blank" style="color:#2980b9;">📎 ፋይል እይ</a>` : ''}<div style="margin-top:8px;">${ab.teacher_feedback ? `<span style="color:green; font-weight:bold;">💬 Teacher Reply: ${ab.teacher_feedback}</span>` : `<span style="color:orange;">⏳ Pending response...</span>`}</div>${actionBtns}</div>`;
                            }).join('');

                            let gradesHtml = myCourses.map(c => {
                                let asm = myGrades.find(a => a.course_code === c.code) || {};
                                return `<tr><td style="text-align:left;"><b>${c.title}</b><br><small style="color:#777;">Inst: ${c.teacher_name}</small></td><td>${asm.quiz !== undefined ? asm.quiz : '-'}</td><td>${asm.mid !== undefined ? asm.mid : '-'}</td><td>${asm.final !== undefined ? asm.final : '-'}</td><td><strong style="color:#27ae60;">${asm.total !== undefined ? asm.total : '-'}</strong></td><td>${asm.remark || '-'}</td></tr>`;
                            }).join('');

                            let teacherOptions = myCourses.map(c => `<option value="${c.teacher_name}">ወደ: መምህር ${c.teacher_name} (${c.title})</option>`).join('');

                            res.send(`
                            <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Student Dashboard</title><style>body{font-family:sans-serif; background:#f4f7f6; padding:20px;} .container{max-width:800px; margin:auto;} .card{background:white; padding:20px; border-radius:10px; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1); overflow-x:auto;} table{width:100%; border-collapse:collapse; margin-top:10px; min-width:400px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79; color:white;}</style></head>
                            <body><div class="container"><h2><img src="/uploads/logo.jpg" onerror="this.style.display='none'" style="height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 10px;">🎓 የተማሪ መቆጣጠሪያ</h2>
                                ${myNotifs.length > 0 ? `<div class="card" style="background:#fff3cd; border:1px solid #ffeeba;"><h3>📢 ማስታወቂያዎች (Notifications)</h3>${notiRows}</div>` : ''}
                                <div class="card" style="background:#d4edda; color:#155724;">📢 <b>የአድሚን መልዕክት:</b> ${student.admin_message}</div>
                                <div class="card" style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;"><div><img src="/uploads/${student.photo}" style="width:100px; height:120px; object-fit:cover; border-radius:5px; display:block; margin-bottom:8px;"><form action="/student/update-photo" method="POST" enctype="multipart/form-data"><input type="file" name="new_photo" accept="image/*" required style="font-size:11px; width:130px; margin-bottom:4px;"><br><button type="submit" style="background:#2980b9; color:white; border:none; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:11px;">📷 ፎቶ ቀይር</button></form></div><div style="flex:1;"><h3 style="margin-top:0;">${student.name} (${student.student_id})</h3><p style="margin:5px 0;"><b>ክፍል:</b> ${student.class_level}</p><p style="margin:5px 0;"><b>የክፍል ተቆጣጣሪ (Proctor):</b> ${section.proctor_name} (${section.proctor_phone})</p><p style="margin:5px 0; color:#27ae60;"><b>የክፍል ተጠሪ (Monitor):</b> ${section.class_monitor || 'ያልተመደበ'}</p><br><a href="/download-id-pdf/${student.student_id}" style="display:inline-block; padding:10px; background:#27ae60; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">📥 ዲጂታል መታወቂያ ያውርዱ</a></div></div>
                                <div class="card"><h3>📊 የትምህርት ውጤቶች (Assessment & Grades)</h3><table><tr><th>Subject & Teacher</th><th>Quiz(20)</th><th>Mid(30)</th><th>Final(50)</th><th>Total(100)</th><th>Remark</th></tr>${gradesHtml||'<tr><td colspan="6">No courses posted yet.</td></tr>'}</table></div>
                                <div class="card" style="background:#fdf2e9; border: 1px solid #e67e22;"><h3 style="color:#d35400;">⚠️ መልዕክት / ፈቃድ ላክ</h3><form action="/student/absence" method="POST" enctype="multipart/form-data"><select name="target_teacher" required style="width:100%; padding:10px; margin-bottom:10px; border-radius:5px;"><option value="Proctor/Monitor">ወደ: የክፍል ተቆጣጣሪ (Class Proctor)</option>${teacherOptions}</select><textarea name="reason" placeholder="መልዕክትዎን..." style="width:100%; padding:10px; border-radius:5px; border:1px solid #ccc;" rows="3" required></textarea><label style="font-size:13px; display:block; margin: 10px 0; font-weight:bold;">📎 የህክምና ማስረጃ ወይም ፎቶ ያያይዙ:</label><input type="file" name="attachment" accept="image/*,.pdf,.doc,.docx" style="margin-bottom:15px; width:100%;"><button type="submit" style="background:#e67e22; color:white; padding:10px; border:none; border-radius:5px; width:100%; cursor:pointer; font-weight:bold;">ጥያቄውን ላክ (Send Message)</button></form><hr style="margin:20px 0;"><h4>📋 የላኳቸው ጥያቄዎች እና የመምህር ምላሽ</h4>${myAbsRows || '<p style="font-size:12px; color:#777;">ምንም ጥያቄ አልላኩም</p>'}</div>
                                <a href="/logout" style="color:red; font-weight:bold; font-size:18px;">🔒 ውጣ (Logout)</a>
                            </div></body></html>`);
                        });
                    });
                });
            });
        });
    });
});

app.post('/student/update-photo', upload.single('new_photo'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    if (req.file) { db.run(`UPDATE students SET photo = ? WHERE student_id = ?`, [req.file.filename, req.session.studentId], () => res.redirect('/student-dashboard')); } 
    else { res.redirect('/student-dashboard'); }
});

app.post('/student/absence', upload.single('attachment'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT name, class_level FROM students WHERE student_id=?', [req.session.studentId], (err, st) => {
        if(st) {
            db.run(`INSERT INTO absence_requests (student_id, student_name, class_level, reason, teacher_feedback, status, created_at, attachment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            [req.session.studentId, st.name, st.class_level, `[ለ: ${req.body.target_teacher}] - ${xss(req.body.reason)}`, '', 'Pending', new Date().toLocaleString(), req.file ? req.file.filename : null], () => res.redirect('/student-dashboard'));
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
                    rowsHtml += `<tr><td>${i+1}</td><td>${st.student_id}</td><td style="text-align:left;">${st.name}</td><td>${st.gender}</td><td><label><input type="radio" name="status_${st.student_id}" value="Present" ${attendanceMap[st.student_id]==='Present'?'checked':''}> ✅ Present</label> &nbsp; <label><input type="radio" name="status_${st.student_id}" value="Absent" ${attendanceMap[st.student_id]==='Absent'?'checked':''}> ❌ Absent</label></td></tr>`;
                } else { rowsHtml += `<tr><td>${i+1}</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>-</td></tr>`; }
            }

            res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Attendance Sheet - ${sec}</title><style>body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background: #fff; } .sheet-table { width: 100%; border-collapse: collapse; font-size:13px; } .sheet-table th, .sheet-table td { border: 1px solid #000; padding: 6px 10px; text-align: center; height: 25px; } .sheet-table th { background: #d9d9d9; color: #000; } .header-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px; } button { background: #107c41; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight:bold; } .save-btn { background: #2980b9; padding: 10px 20px; font-size: 15px; } @media print { button, .no-print { display: none; } }</style></head><body><div class="header-bar"><div><h2>AMANUEL LIGHT AND LIFE SCHOOL</h2><h3>📋 Daily Attendance Sheet - Class: ${sec}</h3></div><div class="no-print"><form method="GET" action="/attendance-sheet/${encodeURIComponent(sec)}" style="display:inline-block; margin-right:10px;"><label><b>Select Date:</b></label><input type="date" name="date" value="${selectedDate}" onchange="this.form.submit()" style="padding:5px;"></form><button onclick="window.print()">🖨️️ Print Sheet</button> <button onclick="window.close()">❌ Close</button></div></div><form action="/save-attendance" method="POST"><input type="hidden" name="class_level" value="${sec}"><input type="hidden" name="date" value="${selectedDate}"><table class="sheet-table"><tr><th>No.</th><th>Student ID</th><th>Student Full Name</th><th>Gender</th><th>Daily Status</th></tr>${rowsHtml}</table><br class="no-print"><div class="no-print" style="text-align:center;"><button type="submit" class="save-btn">💾 Save Attendance</button></div></form><br><br><div style="display:flex; justify-content:space-between; font-weight:bold;"><p>Teacher's Signature: ______________________</p><p>Director's Signature: ______________________</p></div></body></html>`);
        });
    });
});

app.post('/save-attendance', async (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    db.all(`SELECT student_id, name, class_level FROM students`, [], async (err, allStudents) => {
        let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, req.body.class_level));
        db.run(`DELETE FROM daily_attendance WHERE class_level = ? AND date = ?`, [req.body.class_level, req.body.date], async () => {
            try {
                for(let st of studentsInClass) {
                    await pool.query(`INSERT INTO daily_attendance (student_id, student_name, class_level, date, status) VALUES ($1, $2, $3, $4, $5)`, [st.student_id, st.name, req.body.class_level, req.body.date, req.body[`status_${st.student_id}`] || 'Absent']);
                }
                res.send(`<script>alert('Attendance saved successfully!'); window.location.href='/teacher-dashboard';</script>`);
            } catch(e) { res.redirect('/teacher-dashboard'); }
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
                            return `<tr><td>${idx+1}</td><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td><b>${rec ? (rec.status === 'Present' ? '✅ Present' : '❌ Absent') : 'Not Recorded'}</b></td></tr>`;
                        }).join('');
                        return `<div style="margin-bottom:20px;"><h4 style="background:#34495e; color:white; padding:6px; margin:0;">Class: ${sec.name}</h4><table border="1" width="100%" style="border-collapse:collapse; text-align:center; font-size:12px;"><tr style="background:#f2f2f2;"><th>No</th><th>ID</th><th>Full Name</th><th>Attendance Status</th></tr>${studentList || '<tr><td colspan="4">No students</td></tr>'}</table></div>`;
                    }).join('');
                    return `<div style="margin-bottom:40px; page-break-after: always;"><h2 style="background:#2c3e50; color:white; padding:10px; text-align:center;">📅 Academic Period / Month: ${m}</h2>${sectionContent}</div>`;
                }).join('');
                res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Director Academic Year Report</title><style>body { font-family: sans-serif; padding: 20px; background: white; } table th, table td { border: 1px solid #ccc; padding: 5px; } .header { text-align: center; margin-bottom: 20px; } button { background: #8e44ad; color: white; border: none; padding: 10px 20px; border-radius: 5px; font-weight: bold; cursor: pointer; } @media print { button { display: none; } }</style></head><body><div class="header"><h2>AMANUEL LIGHT AND LIFE SCHOOL</h2><h3>📁 Director Comprehensive Attendance Report</h3><button onclick="window.print()">🖨️ Print Full Report</button></div>${monthSections}<br><br><div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:40px;"><p>Prepared by Registrar / Admin: ___________________</p><p>Approved & Signed by Director: ___________________</p></div></body></html>`);
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
            let sRows = students.map((s, index) => `<tr><td><b>${index + 1}</b></td><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td>${s.gender}</td><td>${s.age}</td><td>${s.phone}</td><td><b>${s.cumulative_total}</b></td></tr>`).join('');
            res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Excel View - ${sec}</title><style>body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background: #f9f9f9; } .excel-table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.2); font-size:14px; } .excel-table th, .excel-table td { border: 1px solid #d4d4d4; padding: 6px 10px; text-align: center; } .excel-table th { background: #107c41; color: white; position: sticky; top: 0; } .excel-table tr:nth-child(even) { background: #f3f2f1; } .header-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; } button { background: #107c41; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight:bold; }</style></head><body><div class="header-bar"><h2>📊 Class Grades & Ranking: ${sec} (Total: ${students.length})</h2><div><button onclick="window.print()">🖨️ Print / Save PDF</button> <button onclick="window.close()">❌ Close</button></div></div><table class="excel-table"><tr><th>Rank</th><th>Student ID</th><th>Full Name</th><th>Gender</th><th>Age</th><th>Phone Number</th><th>Cumulative Total Score</th></tr>${sRows||'<tr><td colspan="7">No students found.</td></tr>'}</table></body></html>`);
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
        if (fs.existsSync(schoolLogo)) { doc.image(schoolLogo, 10, 8, { width: 38, height: 38 }); } else { doc.circle(30, 27, 16).fill('#ffffff'); doc.fontSize(12).fillColor('#1f4e79').text('ALLS', 14, 20); }

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

        bwipjs.toBuffer({ bcid: 'qrcode', text: `Name: ${student.name}\nID: ${student.student_id}`, scale: 3 }, function (err, png) {
            if (!err) doc.image(png, 172.5, 195, { width: 55, height: 55 });
            doc.end();
        });
    });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.listen(PORT, () => console.log(`🚀 Modernized Server running on port ${PORT}`));
