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

// የ Chapa Test API Key (ይህንን በ .env ፋይልዎ ውስጥ መቀየር ይችላሉ)
const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY || 'CHASECK_TEST-n1B9WlH63jK2L7PzQ8vRm4T5sY0x'; 
const REGISTRATION_FEE = '1000'; // የምዝገባ ክፍያ መጠን (በብር)

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

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, handler: (req, res) => { res.redirect(`/?lang=${req.query.lang || 'am'}&error=blocked`); } });

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
        let num = str.match(/\d+/); let n = num ? parseInt(num[0], 10) : null;
        let secMatch = str.match(/section\s*([a-z])/i); let s = secMatch ? secMatch[1].toLowerCase() : '';
        if (!s) { let charMatch = str.match(/\d+([a-z])/i); if (charMatch) s = charMatch[1].toLowerCase(); }
        return { n, s };
    };
    let i1 = extract(c1); let i2 = extract(c2);
    if (i1.n !== null && i2.n !== null) { if (i1.n !== i2.n) return false; if (i1.s && i2.s) return i1.s === i2.s; return true; }
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
    if (req.query.error === 'invalid') alertScript = `<script>Swal.fire({icon: 'error', title: 'ስህተት!', text: 'የተሳሳተ መለያ ወይም ፓስወርድ!', confirmButtonColor: '#d33'})</script>`;
    else if (req.query.error === 'blocked') alertScript = `<script>Swal.fire({icon: 'warning', title: 'ታግደዋል!', text: 'እባክዎ ከ15 ደቂቃ በኋላ ይሞክሩ።', confirmButtonColor: '#f39c12'})</script>`;

    res.send(`
    <!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${t.title}</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"></head>
    <body class="bg-gradient-to-br from-blue-50 to-gray-200 flex items-center justify-center min-h-screen p-4">
        <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md hover:shadow-2xl transition-all">
            <div class="flex justify-end mb-2 space-x-2 text-sm"><a href="/?lang=am" class="text-blue-600 font-bold">አማርኛ</a> <span class="text-gray-400">|</span> <a href="/?lang=en" class="text-blue-600 font-bold">English</a></div>
            <img src="/uploads/logo.jpg" onerror="this.style.display='none'" class="w-24 h-24 mx-auto rounded-full mb-4 object-cover">
            <h2 class="text-2xl font-extrabold text-center text-gray-800 mb-6">${t.title}</h2>
            <form action="/login?lang=${lang}" method="POST" class="space-y-5">
                <div><label class="block text-gray-700 text-sm font-bold mb-2">${t.type}</label><div class="relative"><i class="fa-solid fa-users absolute left-3 top-3.5 text-gray-400"></i><select name="role" class="w-full pl-10 pr-3 py-3 rounded-lg border focus:ring-2 focus:ring-blue-200"><option value="student">${t.stud}</option><option value="teacher">${t.teach}</option><option value="admin">${t.admin}</option></select></div></div>
                <div><label class="block text-gray-700 text-sm font-bold mb-2">${t.id}</label><div class="relative"><i class="fa-solid fa-id-card absolute left-3 top-3.5 text-gray-400"></i><input type="text" name="username" required class="w-full pl-10 pr-3 py-3 rounded-lg border focus:ring-2 focus:ring-blue-200"></div></div>
                <div><label class="block text-gray-700 text-sm font-bold mb-2">${t.pass}</label><div class="relative"><i class="fa-solid fa-lock absolute left-3 top-3.5 text-gray-400"></i><input type="password" name="password" required class="w-full pl-10 pr-3 py-3 rounded-lg border focus:ring-2 focus:ring-blue-200"></div></div>
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-md"><i class="fa-solid fa-right-to-bracket mr-2"></i> ${t.btn}</button>
            </form>
            <div class="mt-5 text-center text-sm"><a href="/forgot-password?lang=${lang}" class="text-blue-500 font-bold">${t.forgotBtn}</a></div>
            <div class="my-6 border-t border-gray-200 relative"><span class="absolute left-1/2 -translate-x-1/2 -top-3 bg-white px-2 text-gray-400 font-bold">OR</span></div>
            <a href="/student-register?lang=${lang}" class="flex justify-center items-center w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-lg shadow-md"><i class="fa-solid fa-user-plus mr-2"></i> ${t.reg}</a>
        </div>${alertScript}
    </body></html>`);
});

app.post('/login', loginLimiter, (req, res) => {
    const lang = req.query.lang || 'am';
    const { role, username, password } = req.body;
    const uKey = username.trim();

    if (role === 'admin' && uKey === ADMIN_USER && password === ADMIN_PASS) { req.session.isAdmin = true; return res.redirect(`/admin?lang=${lang}`); } 
    else if (role === 'teacher') {
        db.get(`SELECT * FROM teachers WHERE id = ?`, [uKey.toUpperCase()], (err, t) => {
            if (t && (bcrypt.compareSync(password, t.password) || password === t.password)) { req.session.teacherId = t.id; return res.redirect(`/teacher-dashboard?lang=${lang}`); }
            res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else if (role === 'student') {
        db.get(`SELECT * FROM students WHERE student_id = ?`, [uKey.toUpperCase()], (err, s) => {
            if (s && (bcrypt.compareSync(password, s.password) || password === s.password)) { req.session.studentId = s.student_id; return res.redirect(`/student-dashboard?lang=${lang}`); }
            res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else { res.redirect(`/?lang=${lang}&error=invalid`); }
});

app.get('/forgot-password', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen"><div class="bg-white p-8 rounded-lg shadow-xl w-full max-w-md text-center"><h2>Forgot Password Logic Here</h2><a href="/" class="text-blue-500">Back</a></div></body></html>`);
});

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    let gradeOptions = ''; for(let i=1; i<=12; i++) gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;

    let alertScript = '';
    if (req.query.error === 'exists') alertScript = `<script>Swal.fire({icon: 'error', title: 'Oops...', text: 'አስቀድመው ተመዝግበዋል!', confirmButtonColor: '#d33'})</script>`;
    
    res.send(`
    <!DOCTYPE html><html lang="${lang}">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Student Registration</title>
        <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-gray-100 py-10 px-4">
        <div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
            <div class="bg-green-600 py-6 px-8 text-center text-white relative">
                <a href="/?lang=${lang}" class="absolute left-4 top-6 hover:text-green-200"><i class="fa-solid fa-arrow-left text-xl"></i></a>
                <h2 class="text-2xl font-bold"><i class="fa-solid fa-user-graduate mr-2"></i> አዲስ ተማሪ ምዝገባ</h2>
            </div>
            <div class="p-8">
                <form action="/api/register?lang=${lang}" method="POST" enctype="multipart/form-data" onsubmit="document.getElementById('subBtn').disabled=true; document.getElementById('subBtn').innerHTML='<i class=\\'fa-solid fa-spinner fa-spin mr-2\\'></i> እባክዎ ይጠብቁ...';">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ሙሉ ስም</label><input type="text" name="name" required class="w-full px-3 py-2 border rounded-lg"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">የእናት ስም</label><input type="text" name="mother_name" required class="w-full px-3 py-2 border rounded-lg"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ጾታ</label><select name="gender" class="w-full px-3 py-2 border rounded-lg"><option value="Male">ወንድ</option><option value="Female">ሴት</option></select></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ዕድሜ</label><input type="number" name="age" required class="w-full px-3 py-2 border rounded-lg"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">ስልክ ቁጥር</label><input type="text" name="phone" required class="w-full px-3 py-2 border rounded-lg"></div>
                        <div><label class="block text-gray-700 text-sm font-bold mb-2">የአደጋ ጊዜ ተጠሪ ስልክ</label><input type="text" name="emergency_phone" required class="w-full px-3 py-2 border rounded-lg"></div>
                    </div>
                    
                    <div class="mb-6"><label class="block text-gray-700 text-sm font-bold mb-2">የክፍል ደረጃ</label><select name="year_level" class="w-full px-3 py-2 border rounded-lg">${gradeOptions}</select></div>
                    <div class="mb-6"><label class="block text-gray-700 text-sm font-bold mb-2">የጉርድ ፎቶ</label><input type="file" name="student_photo" accept="image/*" required class="w-full p-2 border border-dashed rounded-lg"></div>

                    <!-- አዲሱ የክፍያ አማራጭ እዚህ ጋር ነው -->
                    <div class="mb-8 p-4 border border-blue-200 rounded-lg bg-blue-50">
                        <label class="block text-blue-900 text-sm font-bold mb-2">ክፍያ (Registration Fee: ${REGISTRATION_FEE} ETB)</label>
                        <select name="payment_type" id="payType" onchange="document.getElementById('slipBox').style.display = this.value=='slip_file'?'block':'none'; document.getElementById('txnBox').style.display = this.value=='txn_id'?'block':'none';" class="w-full px-3 py-2 border rounded-lg mb-4">
                            <option value="chapa">🌐 በኦንላይን አሁኑኑ ይክፈሉ (Telebirr, CBE, Awash...)</option>
                            <option value="txn_id">የትራንዛክሽን ቁጥር (TXN ID) ማስገቢያ (Manual)</option>
                            <option value="slip_file">የደረሰኝ ፎቶ (Bank Slip) ማያያዣ (Manual)</option>
                        </select>
                        <div id="txnBox" style="display:none;"><input type="text" name="txn_id" placeholder="Transaction ID ያስገቡ..." class="w-full px-3 py-2 border rounded-lg"></div>
                        <div id="slipBox" style="display:none;"><input type="file" name="bank_slip_file" accept="image/*,.pdf" class="w-full p-2 border border-dashed rounded-lg bg-white"></div>
                        <p class="text-xs text-blue-700 mt-2"><i class="fa-solid fa-shield-halved"></i> ደህንነቱ የተረጋገጠ የ Chapa ክፍያ ስርአት</p>
                    </div>

                    <button type="submit" id="subBtn" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl shadow-lg">ምዝገባ ላክ (Submit)</button>
                </form>
            </div>
        </div>
        ${alertScript}
    </body></html>`);
});

app.post('/api/register', upload.fields([{ name: 'student_photo', maxCount: 1 }, { name: 'bank_slip_file', maxCount: 1 }]), (req, res) => {
    const lang = req.query.lang || 'am';
    let { name, mother_name, gender, age, phone, emergency_phone, year_level, payment_type, txn_id } = req.body;
    name = xss(name); mother_name = xss(mother_name); phone = xss(phone);
    
    db.get(`SELECT student_id FROM students WHERE name = ? AND phone = ? UNION SELECT student_id FROM pending_students WHERE name = ? AND phone = ?`, 
    [name, phone, name, phone], (err, existingUser) => {
        if (existingUser) return res.redirect(`/student-register?lang=${lang}&error=exists`);

        let autoID = generateStudentID(); 
        let autoPIN = generate4DigitPIN();
        let hashedPIN = bcrypt.hashSync(autoPIN, 10); 
        let tx_ref = 'ALLS-' + Date.now();

        assignClassSection(year_level, (assignedSection) => {
            let photoPath = (req.files && req.files['student_photo']) ? req.files['student_photo'][0].filename : '';
            let slipPath = '';
            
            if (payment_type === 'chapa') {
                slipPath = `Awaiting Chapa Payment: ${tx_ref}`;
            } else {
                slipPath = payment_type === 'slip_file' && (req.files && req.files['bank_slip_file']) ? req.files['bank_slip_file'][0].filename : xss(txn_id);
            }

            db.get(`INSERT INTO pending_students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, class_level, payment_type, bank_slip_val, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
            [autoID, hashedPIN, name, mother_name || '', gender || '', age || null, phone || '', emergency_phone || '', assignedSection, payment_type, slipPath, photoPath], function(err, row) {
                if (err) return res.redirect(`/student-register?lang=${lang}&error=db`);
                
                let insertedId = row ? row.id : (this.lastID || autoID);

                // *********** CHAPA PAYMENT INTEGRATION ***********
                if (payment_type === 'chapa') {
                    const chapaPayload = {
                        amount: REGISTRATION_FEE,
                        currency: 'ETB',
                        email: 'student@alls.edu.et',
                        first_name: name.split(' ')[0] || 'Student',
                        last_name: name.split(' ')[1] || 'ALLS',
                        phone_number: phone,
                        tx_ref: tx_ref,
                        return_url: `${req.protocol}://${req.get('host')}/payment-verify/${tx_ref}/${autoID}?lang=${lang}`,
                        customization: { title: 'ALLS Registration Fee', description: 'School Registration Payment' }
                    };

                    fetch('https://api.chapa.co/v1/transaction/initialize', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${CHAPA_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(chapaPayload)
                    })
                    .then(r => r.json())
                    .then(data => {
                        if(data.status === 'success') {
                            // Redirect user to Chapa Checkout
                            res.redirect(data.data.checkout_url);
                        } else {
                            res.send('Chapa initialization failed. Please contact admin.');
                        }
                    })
                    .catch(e => {
                        console.error("Chapa Error: ", e);
                        res.send('Payment system error. Ensure you are connected to internet.');
                    });

                } else {
                    // Normal Manual Payment Success Page
                    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center"><h2 class="text-3xl font-bold text-gray-800 mb-6">ተሳክቷል! (Success)</h2><div class="bg-gray-50 p-6 rounded-xl border mb-6 text-left"><p><strong>ID:</strong> <span class="text-blue-600 font-bold">${autoID}</span></p><p><strong>PIN:</strong> <span class="text-red-600 font-extrabold text-2xl">${autoPIN}</span></p></div><a href="/download-pending-slip/${autoID}" class="block w-full bg-gray-800 text-white font-bold py-3 rounded-lg mb-3">📥 Download PDF</a><a href="/" class="block w-full bg-green-600 text-white font-bold py-3 rounded-lg">ወደ መግቢያ ተመለስ</a></div></body></html>`);
                }
            });
        });
    });
});

// *********** CHAPA VERIFICATION ROUTE ***********
app.get('/payment-verify/:tx_ref/:student_id', (req, res) => {
    const tx_ref = req.params.tx_ref;
    const student_id = req.params.student_id;

    fetch(`https://api.chapa.co/v1/transaction/verify/${tx_ref}`, {
        headers: { 'Authorization': `Bearer ${CHAPA_SECRET_KEY}` }
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === 'success' && data.data.status === 'success') {
            // Payment verified! Update database
            db.run(`UPDATE pending_students SET bank_slip_val = ? WHERE student_id = ?`, [`✅ PAID ONLINE (${tx_ref})`, student_id], () => {
                db.get(`SELECT password FROM pending_students WHERE student_id = ?`, [student_id], (err, st) => {
                    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center">
                        <div class="text-green-500 text-6xl mb-4">✅</div>
                        <h2 class="text-2xl font-bold text-gray-800 mb-2">ክፍያዎ ተረጋግጧል!</h2>
                        <p class="text-gray-600 mb-6">የምዝገባ ክፍያ በተሳካ ሁኔታ ተፈፅሟል። የትምህርት ቤቱ አድሚን በቅርቡ ያፀድቀዋል።</p>
                        <div class="bg-green-50 border border-green-200 p-4 rounded-lg mb-6 text-left">
                            <p><strong>የመታወቂያ ቁጥር (ID):</strong> <span class="text-blue-600 font-bold">${student_id}</span></p>
                            <p class="text-xs text-gray-500 mt-2">የይለፍ ቃልዎን (PIN) ማስታወሻ መያዝዎን አይርሱ!</p>
                        </div>
                        <a href="/download-pending-slip/${student_id}" class="block w-full bg-gray-800 text-white font-bold py-3 rounded-lg shadow-md mb-3">📥 የደረሰኝ ፒዲኤፍ አውርድ</a>
                        <a href="/" class="block w-full bg-green-600 text-white font-bold py-3 rounded-lg shadow-md">ወደ መግቢያ ተመለስ</a>
                    </div></body></html>`);
                });
            });
        } else {
            res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen"><div class="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center"><h2 class="text-red-500 text-2xl font-bold">❌ ክፍያ አልተሳካም!</h2><p class="mt-4">እባክዎ እንደገና ይሞክሩ።</p><a href="/" class="text-blue-500 mt-4 block">ወደ መግቢያ ተመለስ</a></div></body></html>`);
        }
    })
    .catch(e => {
        console.error("Verification Error:", e);
        res.send("ክፍያውን ማረጋገጥ አልተቻለም።");
    });
});
// ===============================================

// ... (የቀረው የ Admin, Teacher, እና Student Dashboard ኮድ ምንም ሳይቀየር ከበፊቱ ጋር ተመሳሳይ ነው) ...
app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT * FROM pending_students`, [], (err, pending) => {
        let pRows = pending.map(s => `<tr><td>-</td><td>${s.student_id}</td><td>${s.name}</td><td style="color:${s.bank_slip_val.includes('PAID ONLINE') ? 'green' : 'black'}; font-weight:bold;">${s.bank_slip_val}</td><td><a href="/admin/approve/${s.id}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`).join('');
        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Director Hub</title><style>body{font-family:sans-serif; padding:20px;} table{width:100%; border-collapse:collapse; margin-top:20px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;}</style></head><body><h2>የዳይሬክተር መቆጣጠሪያ</h2><h3>አዲስ ተመዝጋቢዎች (Pending)</h3><table><tr><th>Photo</th><th>ID</th><th>Name</th><th>Payment Status</th><th>Action</th></tr>${pRows||'<tr><td colspan="5">None</td></tr>'}</table><br><a href="/logout">Logout</a></body></html>`);
    });
});

app.get('/admin/approve/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM pending_students WHERE id = ?`, [req.params.id], (err, st) => {
        if (!st) return res.redirect('/admin');
        db.run(`INSERT INTO students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [st.student_id, st.password, st.name, st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', '🎉 Your registration is approved!'], () => {
            db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
        });
    });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.listen(PORT, () => console.log(`🚀 Modernized Server with Chapa Payment API running on port ${PORT}`));
