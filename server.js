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
let io = null;
try {
    // optional realtime — only if socket.io installed
    const http = require('http');
    // will attach after listen via patch below
} catch (e) {}

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

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 25,
    handler: (req, res) => {
        res.send(`<script>alert('⚠️ የደህንነት ጥንቃቄ: እጅግ ብዙ የተሳሳተ የሎጊን ሙከራ ተደርጓል። እባክዎ ከ 15 ደቂቃ በኋላ እንደገና ይሞክሩ።'); window.location.href='/';</script>`);
    }
});

const weakPasswords = ['1234', '4321', '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '12345', '123456'];
function isWeakPassword(pass) {
    if (!pass || String(pass).trim().length < 4) return true;
    return weakPasswords.includes(String(pass).toLowerCase().trim());
}

function generateStrong4DigitPIN() {
    let pin = '1234';
    while (isWeakPassword(pin)) {
        pin = Math.floor(1000 + Math.random() * 9000).toString();
    }
    return pin;
}

function logActivity(role, name, action, details) {
    try {
        db.run(`INSERT INTO activity_log (actor_role, actor_name, action, details, created_at) VALUES (?,?,?,?,?)`,
            [role || '', name || '', action || '', details || '', getFormattedTimestamp()]);
    } catch (e) {}
}

function getFormattedTimestamp() {
    const now = new Date();
    // Exact: Weekday, Day Month Year | HH:MM:SS
    const datePart = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const timePart = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${datePart} | ${timePart}`;
}

// Safe rich-text sanitizer for notifications (allows fonts, colors, sizes, bold, italic, underline, etc.)
function sanitizeRichText(html) {
    return xss(html || '', {
        whiteList: {
            b: [], strong: [], i: [], em: [], u: [], s: [], strike: [],
            p: [], br: [], div: ['style'], span: ['style'],
            ul: [], ol: [], li: [],
            h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
            a: ['href', 'target', 'rel'],
            font: ['color', 'size', 'face'],
            blockquote: [], pre: [], code: []
        },
        stripIgnoreTag: true,
        stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed']
    });
}

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
            id SERIAL PRIMARY KEY, sender_role TEXT, sender_name TEXT, target_audience TEXT, message TEXT, created_at TEXT, attachment TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS absence_requests (
            id SERIAL PRIMARY KEY, student_id TEXT, student_name TEXT, class_level TEXT, reason TEXT, teacher_feedback TEXT, status TEXT, created_at TEXT, attachment TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS daily_attendance (
            id SERIAL PRIMARY KEY, student_id TEXT, student_name TEXT, class_level TEXT, date TEXT, status TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS grade_submissions (
            id SERIAL PRIMARY KEY,
            academic_year TEXT,
            class_level TEXT,
            course_id TEXT,
            course_code TEXT,
            course_title TEXT,
            teacher_id TEXT,
            teacher_name TEXT,
            submitted_at TEXT,
            UNIQUE(academic_year, class_level, course_code)
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS academic_archives (
            id SERIAL PRIMARY KEY, academic_year TEXT, student_id TEXT, student_name TEXT, class_level TEXT, courses_summary TEXT, total_score REAL, archived_date TEXT
        )`);

        const extraStudentCols = ["mother_name TEXT", "region TEXT", "zone TEXT", "woreda TEXT", "kebele TEXT", "emergency_name TEXT", "emergency_phone TEXT"];
        for (const col of extraStudentCols) {
            try { await pool.query(`ALTER TABLE students ADD COLUMN ${col}`); } catch (e) {}
            try { await pool.query(`ALTER TABLE pending_students ADD COLUMN ${col}`); } catch (e) {}
        }

        const extraTeacherCols = ["gender TEXT", "subject TEXT", "emergency_name TEXT", "emergency_phone TEXT", "photo TEXT", "plain_pin TEXT"];
        for (const col of extraTeacherCols) {
            try { await pool.query(`ALTER TABLE teachers ADD COLUMN ${col}`); } catch (e) {}
        }

        try { await pool.query(`ALTER TABLE sections ADD COLUMN class_monitor TEXT`); } catch(e) {}
        try { await pool.query(`ALTER TABLE notifications ADD COLUMN attachment TEXT`); } catch(e) {}
        try { await pool.query(`ALTER TABLE absence_requests ADD COLUMN attachment TEXT`); } catch(e) {}

        // Read/Unread tracking
        await pool.query(`CREATE TABLE IF NOT EXISTS notification_reads (
            id SERIAL PRIMARY KEY,
            notification_id INTEGER NOT NULL,
            reader_role TEXT NOT NULL,
            reader_id TEXT NOT NULL,
            read_at TEXT,
            UNIQUE(notification_id, reader_role, reader_id)
        )`);

        // Extra grade columns (assignment, project)
        try { await pool.query(`ALTER TABLE course_assessments ADD COLUMN assignment REAL DEFAULT 0`); } catch(e) {}
        try { await pool.query(`ALTER TABLE course_assessments ADD COLUMN project REAL DEFAULT 0`); } catch(e) {}

        // Live chat messages
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            room TEXT NOT NULL,
            sender_role TEXT,
            sender_id TEXT,
            sender_name TEXT,
            message TEXT,
            created_at TEXT
        )`);

        // SMS / WhatsApp log (stub – real send needs API key)
        await pool.query(`CREATE TABLE IF NOT EXISTS sms_logs (
            id SERIAL PRIMARY KEY,
            recipient_phone TEXT,
            recipient_name TEXT,
            message TEXT,
            channel TEXT DEFAULT 'sms',
            status TEXT DEFAULT 'queued',
            created_at TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS activity_log (
            id SERIAL PRIMARY KEY,
            actor_role TEXT,
            actor_name TEXT,
            action TEXT,
            details TEXT,
            created_at TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS homework (
            id SERIAL PRIMARY KEY, teacher_id TEXT, teacher_name TEXT, class_level TEXT,
            title TEXT, description TEXT, due_date TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS homework_submissions (
            id SERIAL PRIMARY KEY, homework_id INTEGER, student_id TEXT, student_name TEXT,
            file_path TEXT, note TEXT, status TEXT DEFAULT 'submitted', score REAL, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS library_items (
            id SERIAL PRIMARY KEY, title TEXT, category TEXT, class_level TEXT,
            file_path TEXT, uploaded_by TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS quizzes (
            id SERIAL PRIMARY KEY, teacher_id TEXT, teacher_name TEXT, class_level TEXT,
            title TEXT, questions_json TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS quiz_attempts (
            id SERIAL PRIMARY KEY, quiz_id INTEGER, student_id TEXT, student_name TEXT,
            answers_json TEXT, score REAL, total REAL, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS lesson_plans (
            id SERIAL PRIMARY KEY, teacher_id TEXT, teacher_name TEXT, class_level TEXT,
            week_label TEXT, content TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS fee_ledger (
            id SERIAL PRIMARY KEY, student_id TEXT, student_name TEXT, class_level TEXT,
            amount REAL, paid REAL DEFAULT 0, description TEXT, status TEXT DEFAULT 'unpaid',
            created_at TEXT, updated_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS timetable (
            id SERIAL PRIMARY KEY, class_level TEXT, day_of_week TEXT,
            period_no INTEGER, subject TEXT, teacher_name TEXT, room TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY, title TEXT, body TEXT, audience TEXT DEFAULT 'ALL',
            created_by TEXT, created_at TEXT
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS exam_schedule (
            id SERIAL PRIMARY KEY, class_level TEXT, subject TEXT, exam_date TEXT,
            exam_time TEXT, room TEXT, notes TEXT, created_at TEXT
        )`);



        let tRes = await pool.query("SELECT COUNT(*) as count FROM teachers");
        if (tRes.rows[0].count == 0) {
            let hashedPass = bcrypt.hashSync('5829', 10);
            await pool.query(`INSERT INTO teachers (id, name, password, phone, assigned_sections, assigned_grades, is_proctor, plain_pin) VALUES 
            ('T-101', 'Dr. Teshale Kebede', $1, '0911001122', 'Grade 1 - Section A', 'Grade 1', 1, '5829')`, [hashedPass]);
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

const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

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

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

function generateStudentID() { return `ALLS-${Math.floor(1000 + Math.random() * 9000)}`; }
function generateTeacherID() { return `T-${Math.floor(100 + Math.random() * 900)}`; }
function generate4DigitPIN() { return generateStrong4DigitPIN(); }

function csvCell(val) {
    if (val === null || val === undefined) return '""';
    return `"${String(val).replace(/"/g, '""')}"`;
}

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

app.get('/', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const error = req.query.error;
    res.render('login', { lang, error });
});

app.post('/login', loginLimiter, (req, res) => {
    const lang = req.query.lang || 'am';
    const { role, username, password } = req.body;
    let uKey = (username || '').trim();
    let pass = (password || '').trim();

    if (role === 'admin') {
        if (uKey === ADMIN_USER && pass === ADMIN_PASS) {
            req.session.isAdmin = true;
            return res.redirect(`/admin?lang=${lang}`);
        } else {
            return res.redirect(`/?lang=${lang}&error=invalid`);
        }
    } else if (role === 'teacher') {
        db.get(`SELECT * FROM teachers WHERE UPPER(id) = ?`, [uKey.toUpperCase()], (err, t) => {
            if (t && (bcrypt.compareSync(pass, t.password) || pass === t.password || pass === t.plain_pin)) {
                req.session.teacherId = t.id;
                return res.redirect(`/teacher-dashboard?lang=${lang}`);
            }
            return res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else if (role === 'student') {
        db.get(`SELECT * FROM students WHERE UPPER(student_id) = ?`, [uKey.toUpperCase()], (err, s) => {
            if (s && (bcrypt.compareSync(pass, s.password) || pass === s.password)) {
                req.session.studentId = s.student_id;
                return res.redirect(`/student-dashboard?lang=${lang}`);
            }
            return res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else if (role === 'parent') {
        // Parent login: Student ID + Parent phone (emergency_phone or student phone)
        const normPhone = (p) => String(p || '').replace(/[\s\-\(\)]/g, '').replace(/^\+251/, '0');
        db.get(`SELECT * FROM students WHERE UPPER(student_id) = ?`, [uKey.toUpperCase()], (err, s) => {
            if (!s) return res.redirect(`/?lang=${lang}&error=invalid`);
            const entered = normPhone(pass);
            const phoneMatch =
                (s.emergency_phone && normPhone(s.emergency_phone) === entered) ||
                (s.phone && normPhone(s.phone) === entered) ||
                (entered && String(s.emergency_phone || '').includes(entered)) ||
                (entered && String(s.phone || '').includes(entered));
            if (phoneMatch) {
                req.session.parentStudentId = s.student_id;
                req.session.parentName = s.emergency_name || s.mother_name || 'Parent';
                return res.redirect(`/parent-dashboard?lang=${lang}`);
            }
            return res.redirect(`/?lang=${lang}&error=invalid`);
        });
    } else {
        return res.redirect(`/?lang=${lang}&error=invalid`);
    }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ================= PARENT PORTAL (inline HTML — no ejs dependency) =================
app.get('/parent-dashboard', (req, res) => {
    if (!req.session.parentStudentId) return res.redirect('/');
    const sid = req.session.parentStudentId;
    const parentName = req.session.parentName || 'Parent';

    db.get(`SELECT * FROM students WHERE student_id = ?`, [sid], (err, student) => {
        if (err || !student) return res.redirect('/?error=invalid');

        db.all(`SELECT * FROM course_assessments WHERE student_id = ?`, [sid], (err2, grades) => {
            grades = grades || [];
            db.all(`SELECT * FROM daily_attendance WHERE student_id = ? ORDER BY id DESC LIMIT 30`, [sid], (err3, attendance) => {
                attendance = attendance || [];
                db.all(`SELECT * FROM courses ORDER BY id`, [], (err4, allCourses) => {
                    allCourses = allCourses || [];
                    let myCourses = [];
                    try {
                        myCourses = allCourses.filter(c => isClassMatch(c.class_level, student.class_level));
                    } catch (e) { myCourses = allCourses; }

                    let gradesHtml = myCourses.map(c => {
                        const asm = grades.find(a => a.course_code === c.code) || {};
                        const total = Number(asm.quiz||0) + Number(asm.assignment||0) + Number(asm.project||0) + Number(asm.mid||0) + Number(asm.final||0);
                        const letter = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 75 ? 'B+' : total >= 60 ? 'B' : total >= 50 ? 'C' : 'F';
                        return `<tr><td>${c.code||''}</td><td style="text-align:left;">${c.title||''}</td><td>${c.teacher_name||'-'}</td>
                            <td>${asm.quiz||0}</td><td>${asm.assignment||0}</td><td>${asm.project||0}</td>
                            <td>${asm.mid||0}</td><td>${asm.final||0}</td><td><b>${total}</b></td><td><b>${letter}</b></td></tr>`;
                    }).join('');
                    if (!gradesHtml) gradesHtml = '<tr><td colspan="10">No grades yet / ውጤት የለም</td></tr>';

                    let attHtml = attendance.map(a => `<tr><td>${a.date||a.created_at||'-'}</td><td>${a.status||'-'}</td></tr>`).join('');
                    if (!attHtml) attHtml = '<tr><td colspan="2">No records / መረጃ የለም</td></tr>';

                    const room = 'parent-' + sid;
                    res.send(`<!DOCTYPE html>
<html lang="am"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#1f4e79"><link rel="manifest" href="/manifest.json">
<title>Parent Portal - ALLS</title>
<style>
body{font-family:Segoe UI,sans-serif;background:#eef2f5;margin:0;padding:20px;color:#333}
.container{max-width:900px;margin:auto}
.card{background:#fff;padding:20px;border-radius:12px;margin-bottom:16px;box-shadow:0 4px 12px rgba(0,0,0,.06);border-top:4px solid #2980b9}
h2,h3{color:#1f4e79;margin-top:0}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
th,td{border:1px solid #e0e0e0;padding:8px;text-align:center}
th{background:#1f4e79;color:#fff}
#chatBox{height:220px;overflow-y:auto;background:#f8fafc;border:1px solid #e0e0e0;border-radius:8px;padding:10px;margin-bottom:8px}
.chat-msg{margin-bottom:8px;font-size:13px;border-bottom:1px solid #eee;padding-bottom:6px}
a.logout{color:#e74c3c;font-weight:bold;text-decoration:none}
</style></head>
<body>
<div class="container">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
    <h2 style="margin:0">👨‍👩‍👧 Parent Portal</h2>
    <a href="/logout" class="logout">🔒 Logout</a>
  </div>
  <div class="card">
    <h3>Student: ${student.name||''}</h3>
    <p><b>ID:</b> ${student.student_id} | <b>Class:</b> ${student.class_level||'-'} | <b>Parent:</b> ${parentName}</p>
  </div>
  <div class="card">
    <h3>📊 Grades</h3>
    <div style="overflow-x:auto"><table>
      <tr><th>Code</th><th>Course</th><th>Teacher</th><th>Quiz</th><th>Assign</th><th>Project</th><th>Mid</th><th>Final</th><th>Total</th><th>Grade</th></tr>
      ${gradesHtml}
    </table></div>
  </div>
  <div class="card">
    <h3>📅 Attendance</h3>
    <table><tr><th>Date</th><th>Status</th></tr>${attHtml}</table>
  </div>
  <div class="card">
    <h3>💬 Chat with School</h3>
    <div id="chatStatus" style="font-size:12px;color:#888">Loading...</div>
    <div id="chatBox"></div>
    <form id="chatForm" style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="chatInput" type="text" placeholder="Type message..." required style="flex:1;min-width:160px;padding:10px;border:1px solid #ccc;border-radius:6px">
      <button type="submit" style="background:#2980b9;color:#fff;border:none;padding:10px 16px;border-radius:6px;font-weight:bold;cursor:pointer">Send</button>
    </form>
  </div>
</div>
<script>
const room=${JSON.stringify(room)};
function loadChat(){
  fetch('/api/chat/'+encodeURIComponent(room),{credentials:'same-origin'})
    .then(r=>r.json()).then(d=>{
      document.getElementById('chatStatus').textContent='Online';
      const box=document.getElementById('chatBox');
      const msgs=d.messages||[];
      box.innerHTML=msgs.length?msgs.map(m=>'<div class="chat-msg"><b>'+(m.sender_name||'?')+'</b> <small style="color:#888">'+(m.created_at||'')+'</small><br>'+(m.message||'')+'</div>').join(''):'<div style="color:#888">No messages yet</div>';
      box.scrollTop=box.scrollHeight;
    }).catch(()=>{document.getElementById('chatStatus').textContent='Retrying...';});
}
loadChat(); setInterval(loadChat,5000);
document.getElementById('chatForm').addEventListener('submit',function(e){
  e.preventDefault();
  const input=document.getElementById('chatInput');
  const msg=input.value.trim(); if(!msg) return;
  fetch('/api/chat/'+encodeURIComponent(room),{
    method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:msg})
  }).then(r=>r.json()).then(d=>{ if(d.success){ input.value=''; loadChat(); } });
});
if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(()=>{}); }
</script>
</body></html>`);
                });
            });
        });
    });
});

// ================= LIVE CHAT API =================
app.get('/api/chat/:room', (req, res) => {
    const room = String(req.params.room || 'general').slice(0, 120);
    pool.query(`SELECT * FROM chat_messages WHERE room = $1 ORDER BY id DESC LIMIT 50`, [room])
        .then(r => res.json({ messages: (r.rows || []).reverse() }))
        .catch(() => res.json({ messages: [] }));
});

app.post('/api/chat/:room', (req, res) => {
    const room = String(req.params.room || 'general').slice(0, 120);
    const msg = String(req.body.message || '').trim();
    if (!msg || msg.length > 2000) return res.json({ success: false, error: 'empty' });

    let role = 'Guest', id = '', name = 'Guest';
    if (req.session.isAdmin) { role = 'Admin'; id = 'admin'; name = 'Admin'; }
    else if (req.session.teacherId) { role = 'Teacher'; id = req.session.teacherId; }
    else if (req.session.studentId) { role = 'Student'; id = req.session.studentId; }
    else if (req.session.parentStudentId) { role = 'Parent'; id = req.session.parentStudentId; name = req.session.parentName || 'Parent'; }
    else return res.status(401).json({ success: false, error: 'login required' });

    const createdAt = getFormattedTimestamp();
    const insertChat = (senderName) => {
        pool.query(
            `INSERT INTO chat_messages (room, sender_role, sender_id, sender_name, message, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
            [room, role, id, senderName, msg, createdAt]
        ).then(() => res.json({ success: true, sender_name: senderName, created_at: createdAt, message: msg }))
         .catch(e => res.json({ success: false, error: String(e.message || e) }));
    };

    if (role === 'Teacher') {
        pool.query(`SELECT name FROM teachers WHERE id = $1`, [id]).then(r => insertChat(r.rows[0] ? r.rows[0].name : id)).catch(() => insertChat(id));
    } else if (role === 'Student') {
        pool.query(`SELECT name FROM students WHERE student_id = $1`, [id]).then(r => insertChat(r.rows[0] ? r.rows[0].name : id)).catch(() => insertChat(id));
    } else {
        insertChat(name);
    }
});

// ================= SMS / WhatsApp STUB =================
// Logs message; real delivery needs Twilio / Africa's Talking API keys in env
app.post('/api/send-sms', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.json({ success: false, error: 'Unauthorized' });
    const { phone, name, message, channel } = req.body;
    if (!phone || !message) return res.json({ success: false, error: 'phone and message required' });
    const createdAt = getFormattedTimestamp();
    const ch = (channel === 'whatsapp') ? 'whatsapp' : 'sms';
    db.run(`INSERT INTO sms_logs (recipient_phone, recipient_name, message, channel, status, created_at) VALUES (?,?,?,?,?,?)`,
        [phone, name || '', message, ch, 'queued', createdAt],
        function() {
            // Optional: if process.env.TWILIO_SID set, call Twilio here
            res.json({
                success: true,
                status: 'queued',
                note: process.env.TWILIO_SID ? 'Will send via Twilio' : 'Logged only — set TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM to enable real SMS'
            });
        });
});

app.get('/api/sms-logs', (req, res) => {
    if (!req.session.isAdmin) return res.json({ logs: [] });
    db.all(`SELECT * FROM sms_logs ORDER BY id DESC LIMIT 100`, [], (err, logs = []) => res.json({ logs }));
});

// PWA manifest
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
        name: 'Amanuel Light & Life School',
        short_name: 'ALLS Portal',
        description: 'School management portal',
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#1f4e79',
        theme_color: '#1f4e79',
        icons: [
            { src: '/uploads/logo.jpg', sizes: '192x192', type: 'image/jpeg', purpose: 'any maskable' },
            { src: '/uploads/logo.jpg', sizes: '512x512', type: 'image/jpeg', purpose: 'any maskable' }
        ]
    });
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.send(`
const CACHE = 'alls-v3';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/','/manifest.json','/login']).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      if (e.request.method === 'GET' && r.ok) {
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || new Response('<!DOCTYPE html><html><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Offline</title></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#e2e8f0"><h2>📡 Offline</h2><p>ALLS Portal — reconnect to continue.</p><button onclick="location.reload()" style="padding:12px 20px;border:none;border-radius:8px;background:#2980b9;color:#fff;font-weight:bold">Retry</button></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}})))
  );
});
`);
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
            let newPin = generateStrong4DigitPIN();
            let hashedPIN = bcrypt.hashSync(newPin, 10); 
            return db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [hashedPIN, s.student_id], () => {
                res.send(`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center"><h2 class="text-2xl font-bold text-gray-800 mb-2">ፓስወርድ ተቀይሯል!</h2><p class="text-gray-600 mb-4">አዲሱ የይለፍ ቁጥርዎ ይህ ነው:</p><div class="text-5xl font-extrabold text-red-600 mb-6 bg-red-50 py-4 rounded-xl border border-red-200 tracking-widest shadow-inner">${newPin}</div><a href="/?lang=${lang}" class="block w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-md">ወደ መግቢያ ተመለስ</a></div></body></html>`);
            });
        }
        res.redirect(`/forgot-password?lang=${lang}&error=notfound`);
    });
});

app.post('/api/recover-password', (req, res) => {
    const { id, phone } = req.body;
    db.get(`SELECT * FROM students WHERE student_id = ? AND phone = ?`, [id, phone], (err, student) => {
        if (student) {
            let newPassword = generateStrong4DigitPIN(); 
            let hashedPassword = bcrypt.hashSync(newPassword, 10);
            db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [hashedPassword, id], (updateErr) => {
                if (updateErr) return res.json({ success: false });
                res.json({ success: true, newPassword: newPassword });
            });
        } else {
            db.get(`SELECT * FROM teachers WHERE id = ? AND phone = ?`, [id, phone], (err2, teacher) => {
                if (teacher) {
                    let newPassword = generateStrong4DigitPIN(); 
                    let hashedPassword = bcrypt.hashSync(newPassword, 10);
                    db.run(`UPDATE teachers SET password = ?, plain_pin = ? WHERE id = ?`, [hashedPassword, newPassword, id], (updateErr) => {
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

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    let gradeOptions = '';
    for(let i=1; i<=12; i++) gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;
    res.send(`<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Student Registration - Amanuel Light & Life School</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body.lang-am .en { display: none !important; }
        body.lang-am .am { display: inline !important; }
        body.lang-en .am { display: none !important; }
        body.lang-en .en { display: inline !important; }
    </style>
</head>
<body class="lang-${lang}" style="background:linear-gradient(135deg,#1f4e79 0%,#0d2b45 100%);min-height:100vh;padding:32px 16px;">
    <div class="max-w-3xl mx-auto">
        <div class="flex justify-between items-center mb-4 flex-wrap gap-2">
            <a href="/?lang=${lang}" class="bg-white/20 hover:bg-white/30 text-white font-bold py-2 px-4 rounded-lg backdrop-blur">
                ⬅️ <span class="am">ወደ መግቢያ ተመለስ</span><span class="en">Back to Login</span>
            </a>
            <div class="bg-white p-1.5 rounded-lg shadow flex gap-2">
                <button type="button" onclick="setRegLang('am')" id="btn-am" class="px-4 py-1.5 rounded font-bold text-sm bg-blue-700 text-white">🇪🇹 አማርኛ</button>
                <button type="button" onclick="setRegLang('en')" id="btn-en" class="px-4 py-1.5 rounded font-bold text-sm text-gray-700">🇬🇧 English</button>
            </div>
        </div>

        <div class="bg-white rounded-2xl shadow-2xl overflow-hidden border-t-8 border-amber-500">
            <div class="py-6 px-8 text-center text-white" style="background:linear-gradient(90deg,#1f4e79,#2980b9);">
                <h2 class="text-2xl font-bold">
                    🎓 <span class="am">የአዲስ ተማሪ ምዝገባ ቅጽ</span><span class="en">New Student Registration Form</span>
                </h2>
                <p class="text-sm opacity-90 mt-1">Amanuel Light &amp; Life School</p>
            </div>
            <div class="p-8">
                <form action="/api/register" method="POST" enctype="multipart/form-data">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">👤 ሙሉ ስም *</span><span class="en">👤 Full Name *</span></label>
                            <input type="text" name="name" required class="w-full px-3 py-2.5 border rounded-lg focus:outline-none focus:border-green-600">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">👩 የእናት ስም *</span><span class="en">👩 Mother's Name *</span></label>
                            <input type="text" name="mother_name" required class="w-full px-3 py-2.5 border rounded-lg focus:outline-none focus:border-green-600">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">⚧ ፆታ *</span><span class="en">⚧ Gender *</span></label>
                            <select name="gender" class="w-full px-3 py-2.5 border rounded-lg">
                                <option value="Male">ወንድ (Male)</option>
                                <option value="Female">ሴት (Female)</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">🎂 ዕድሜ *</span><span class="en">🎂 Age *</span></label>
                            <input type="number" name="age" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">📞 ስልክ ቁጥር *</span><span class="en">📞 Phone Number *</span></label>
                            <input type="text" name="phone" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">🚨 የአደጋ ጊዜ ተጠሪ ስልክ *</span><span class="en">🚨 Emergency Phone *</span></label>
                            <input type="text" name="emergency_phone" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">📍 ክልል *</span><span class="en">📍 Region *</span></label>
                            <input type="text" name="region" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">📍 ዞን *</span><span class="en">📍 Zone *</span></label>
                            <input type="text" name="zone" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">📍 ወረዳ *</span><span class="en">📍 Woreda *</span></label>
                            <input type="text" name="woreda" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-1.5"><span class="am">📍 ቀበሌ *</span><span class="en">📍 Kebele *</span></label>
                            <input type="text" name="kebele" required class="w-full px-3 py-2.5 border rounded-lg">
                        </div>
                    </div>

                    <div class="mb-6">
                        <label class="block text-sm font-bold mb-1.5"><span class="am">🏫 የሚገቡበት የክፍል ደረጃ *</span><span class="en">🏫 Grade Level *</span></label>
                        <select name="year_level" class="w-full px-3 py-2.5 border rounded-lg">${gradeOptions}</select>
                    </div>

                    <div class="mb-6">
                        <label class="block text-sm font-bold mb-1.5"><span class="am">📷 የተማሪው የጉርድ ፎቶ *</span><span class="en">📷 Student Passport Photo *</span></label>
                        <input type="file" name="student_photo" accept="image/*" required class="w-full p-2.5 border border-dashed rounded-lg bg-gray-50">
                    </div>

                    <div class="mb-8 p-5 border-2 border-blue-200 rounded-xl bg-blue-50">
                        <label class="block text-sm font-bold mb-2 text-blue-900">
                            💳 <span class="am">የክፍያ ማረጋገጫ መንገድ ይምረጡ *</span><span class="en">Select Payment Verification Method *</span>
                        </label>
                        <select name="payment_type" id="payTypeSelect" onchange="togglePaymentInput()" class="w-full px-3 py-2.5 border rounded-lg mb-4 bg-white font-semibold">
                            <option value="txn_id">🔢 የትራንዛክሽን ቁጥር (Transaction / Reference ID)</option>
                            <option value="slip_file">📄 የባንክ ደረሰኝ ፎቶ (Upload Bank Slip Photo/PDF)</option>
                        </select>

                        <div id="txnInputBox" style="display:block;">
                            <label class="block text-xs font-bold mb-1 text-gray-700">
                                <span class="am">የባንክ ትራንዛክሽን ቁጥሩን እዚህ ያስገቡ (ለምሳሌ FT24...):</span>
                                <span class="en">Enter Bank Transaction / Reference Number:</span>
                            </label>
                            <input type="text" name="txn_id" id="txnInputField" placeholder="Transaction ID (e.g. FT24105...)" class="w-full px-3 py-2.5 border rounded-lg bg-white">
                        </div>

                        <div id="slipInputBox" style="display:none;">
                            <label class="block text-xs font-bold mb-1 text-gray-700">
                                <span class="am">የከፈሉበትን ደረሰኝ ፎቶ ወይም PDF ይምረጡ:</span>
                                <span class="en">Upload Bank Slip Image or PDF:</span>
                            </label>
                            <input type="file" name="bank_slip_file" id="slipInputField" accept="image/*,.pdf" class="w-full p-2.5 border border-dashed rounded-lg bg-white">
                        </div>
                    </div>

                    <button type="submit" class="w-full text-white font-bold py-4 rounded-xl shadow-lg text-lg cursor-pointer" style="background:linear-gradient(90deg,#1f4e79,#2980b9);">
                        ✅ <span class="am">ምዝገባውን አጠናቅቅና ላክ</span><span class="en">Submit Registration</span>
                    </button>
                </form>
            </div>
        </div>
    </div>

    <script>
        function setRegLang(l) {
            const clean = (l === 'en') ? 'en' : 'am';
            document.body.className = 'lang-' + clean + ' bg-gray-100 py-8 px-4';
            const btnAm = document.getElementById('btn-am');
            const btnEn = document.getElementById('btn-en');
            if (clean === 'am') {
                btnAm.className = 'px-4 py-1.5 rounded font-bold text-sm bg-green-600 text-white';
                btnEn.className = 'px-4 py-1.5 rounded font-bold text-sm text-gray-700';
            } else {
                btnEn.className = 'px-4 py-1.5 rounded font-bold text-sm bg-blue-600 text-white';
                btnAm.className = 'px-4 py-1.5 rounded font-bold text-sm text-gray-700';
            }
        }

        function togglePaymentInput() {
            const val = document.getElementById('payTypeSelect').value;
            const txnBox = document.getElementById('txnInputBox');
            const slipBox = document.getElementById('slipInputBox');
            if (val === 'slip_file') {
                slipBox.style.display = 'block';
                txnBox.style.display = 'none';
            } else {
                txnBox.style.display = 'block';
                slipBox.style.display = 'none';
            }
        }
        togglePaymentInput();
    </script>
</body>
</html>`);
});

app.post('/api/register', upload.fields([{ name: 'student_photo', maxCount: 1 }, { name: 'bank_slip_file', maxCount: 1 }]), (req, res) => {
    const lang = req.query.lang || 'am';
    try {
        let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, year_level, payment_type, txn_id } = req.body;
        name = xss(name); mother_name = xss(mother_name); phone = xss(phone);
        // Family fields may match siblings (mother, emergency phone, etc.) — ALLOWED.
        // Each child gets unique student_id + PIN. Full form goes to admin pending.

        let autoID = generateStudentID();
        let autoPIN = generateStrong4DigitPIN();
        let hashedPIN = bcrypt.hashSync(autoPIN, 10);

        assignClassSection(year_level || 'Grade 1', (assignedSection) => {
            let photoPath = (req.files && req.files['student_photo']) ? req.files['student_photo'][0].filename : '';
            let slipPath = '';
            if (payment_type === 'slip_file' && req.files && req.files['bank_slip_file']) {
                slipPath = req.files['bank_slip_file'][0].filename;
            } else {
                slipPath = xss(txn_id || '');
            }

            db.run(`INSERT INTO pending_students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [autoID, hashedPIN, name, mother_name || '', gender || '', age || null, phone || '', emergency_phone || '', region || '', zone || '', woreda || '', kebele || '', assignedSection, payment_type, slipPath, photoPath], function(err) {
                if (err) return res.redirect(`/student-register?lang=${lang}&error=db`);
                // Only ID + PIN shown to registrant; full data is for admin
                res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gradient-to-br from-blue-900 to-slate-900 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md text-center border-t-8 border-amber-500"><h2 class="text-2xl font-bold text-green-600 mb-2">ምዝገባ ተልኳል (Pending)</h2><p class="text-gray-600 text-sm mb-2">ሙሉ መረጃ ወደ አድሚን ተልኳል። የክፍያ transaction/ደረሰኝ ዳይሬክተር ያረጋግጣል።</p><p class="text-amber-700 text-sm font-bold mb-6">⚠️ እስከ approval ድረስ Login አይችሉም። <u>ID እና PIN ብቻ</u> ይያዙ፦</p><div class="bg-slate-50 p-5 rounded-xl border-2 border-blue-100 mb-6 space-y-4"><div><div class="text-xs text-gray-500 font-bold uppercase">መታወቂያ / ID</div><div class="text-3xl font-extrabold text-blue-700 tracking-wide">${autoID}</div></div><div><div class="text-xs text-gray-500 font-bold uppercase">የይለፍ ቃል / PIN</div><div class="text-3xl font-extrabold text-red-600 tracking-widest">${autoPIN}</div></div></div><a href="/?lang=${lang}" class="block w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded-xl">⬅️ ወደ መግቢያ ተመለስ</a></div></body></html>`);
            });
        });
    } catch (error) {
        res.redirect(`/student-register?lang=${lang}&error=db`);
    }
});


app.post('/register-student', upload.single('bank_slip'), (req, res) => {
    const { name, mother_name, gender, phone, class_level, region, zone, woreda, kebele, emergency_name, emergency_phone, transaction_id, txn_id, payment_type } = req.body;
    const txVal = (transaction_id || txn_id || '').trim();
    const paymentProof = req.file ? req.file.filename : txVal;
    const finalPayType = req.file ? 'slip_file' : (payment_type || 'txn_id');

    const autoID = generateStudentID();
    const autoPIN = generateStrong4DigitPIN();
    const hashedPIN = bcrypt.hashSync(autoPIN, 10);

    assignClassSection(class_level || 'Grade 1', (assignedSection) => {
        const finalClass = assignedSection || class_level;
        db.run(
            `INSERT INTO pending_students (student_id, password, name, gender, phone, class_level, payment_type, bank_slip_val, mother_name, region, zone, woreda, kebele, emergency_name, emergency_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [autoID, hashedPIN, name, gender, phone, finalClass, finalPayType, paymentProof, mother_name || '', region || '', zone || '', woreda || '', kebele || '', emergency_name || '', emergency_phone || ''],
            function(err) {
                if (err) return res.redirect('/?error=db');
                res.send(`<!DOCTYPE html><html lang="am"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registration Successful</title></head><body style="font-family:Segoe UI,sans-serif;background:linear-gradient(135deg,#1f4e79,#0d2b45);display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;"><div style="background:white;padding:32px;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);max-width:400px;width:100%;text-align:center;border-top:6px solid #f39c12;"><h2 style="color:#27ae60;margin:0 0 8px;">ምዝገባ ተልኳል (Pending)</h2><p style="color:#555;font-size:13px;margin:0 0 8px;">የክፍያ transaction/ደረሰኝ ወደ ዳይሬክተር ተልኳል።</p><p style="color:#b45309;font-size:13px;font-weight:bold;margin:0 0 20px;">⚠️ ዳይሬክተር ክፍያ እስኪያረጋግጥ ድረስ Registered አይደሉም — Login አይችሉም። ID እና PIN ይያዙ፦</p><div style="background:#f8fafc;padding:18px;border-radius:12px;border:2px solid #dbeafe;margin-bottom:20px;"><div style="font-size:11px;color:#64748b;font-weight:bold;text-transform:uppercase;">መታወቂያ / ID</div><div style="font-size:28px;font-weight:800;color:#1d4ed8;letter-spacing:1px;margin:6px 0 14px;">${autoID}</div><div style="font-size:11px;color:#64748b;font-weight:bold;text-transform:uppercase;">የይለፍ ቃል / PIN</div><div style="font-size:28px;font-weight:800;color:#dc2626;letter-spacing:4px;margin-top:6px;">${autoPIN}</div></div><a href="/" style="display:block;background:#1f4e79;color:white;padding:12px;text-decoration:none;border-radius:10px;font-weight:bold;">⬅️ ወደ መግቢያ ገጽ ተመለስ</a></div></body></html>`);
            }
        );
    });
});

app.get('/student/digital-id', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT * FROM students WHERE student_id = ?', [req.session.studentId], (err, student) => {
        if (!student) return res.redirect('/');
        res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Digital ID - ${student.name}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #eef2f5; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .id-card { width: 380px; background: white; border-radius: 14px; box-shadow: 0 10px 25px rgba(0,0,0,0.18); overflow: hidden; border: 2px solid #1f4e79; }
        .header { background: linear-gradient(135deg, #1f4e79 0%, #0d2b45 100%) !important; color: white !important; padding: 14px 16px; display: flex; align-items: center; gap: 12px; border-bottom: 4px solid #f39c12; }
        .school-logo { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: white; border: 2px solid #f39c12; }
        .content { padding: 18px; display: flex; gap: 15px; align-items: center; border-bottom: 1px solid #eee; background: white !important; }
        .profile-img { width: 95px; height: 95px; border-radius: 10px; object-fit: cover; border: 2.5px solid #1f4e79; }
        .info { font-size: 13.5px; line-height: 1.6; color: #333; }
        .info p { margin: 3px 0; }
        .qr-section { padding: 12px; text-align: center; background: #f8fafc !important; }
        .footer { background: #1f4e79 !important; color: white !important; padding: 7px; text-align: center; font-size: 10.5px; }
        .actions { margin-top: 18px; display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
        .btn { padding: 11px 18px; font-size: 14px; font-weight: bold; cursor: pointer; border: none; border-radius: 8px; text-align: center; text-decoration: none; color: white; }
        @media print { .actions { display: none !important; } body { background: white; padding: 0; } .id-card { box-shadow: none; margin: auto; } }
    </style>
</head>
<body>
    <div id="studentIdCard" class="id-card">
        <div class="header">
            <img src="/uploads/logo.jpg" onerror="this.src='/uploads/logo.png'" class="school-logo" crossorigin="anonymous">
            <div>
                <h3 style="margin:0; font-size:15.5px;">AMANUEL LIGHT & LIFE SCHOOL</h3>
                <p style="margin:3px 0 0; font-size:11px; color:#f39c12; font-weight:bold;">OFFICIAL DIGITAL STUDENT ID CARD</p>
            </div>
        </div>
        <div class="content">
            <img src="/uploads/${student.photo || 'logo.jpg'}" onerror="this.src='/uploads/logo.jpg'" class="profile-img" crossorigin="anonymous">
            <div class="info">
                <h3 style="margin:0 0 5px 0; color:#1f4e79; font-size:16px;">${student.name}</h3>
                <p><b>ID No:</b> <span style="color:#2980b9; font-weight:bold;">${student.student_id}</span></p>
                <p><b>Class:</b> ${student.class_level}</p>
                <p><b>Gender:</b> ${student.gender || '-'}</p>
                <p><b>Phone:</b> ${student.phone || '-'}</p>
                <p><b>Status:</b> <span style="color:#27ae60; font-weight:bold;">Approved</span></p>
            </div>
        </div>
        <div class="qr-section">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${student.student_id}" style="width:82px; height:82px;" crossorigin="anonymous">
            <p style="font-size:10px; color:#64748b; margin:3px 0 0;">Scan to verify student status</p>
        </div>
        <div class="footer">Property of Amanuel Light and Life School</div>
    </div>

    <div class="actions">
        <button onclick="downloadColorID()" class="btn" style="background:#27ae60;">📥 በኦሪጅናል ከለር Download PDF</button>
        <button onclick="window.print()" class="btn" style="background:#2980b9;">🖨️ Print ID</button>
        <a href="/student-dashboard" class="btn" style="background:#7f8c8d;">⬅️ ተመለስ</a>
    </div>

    <script>
        function downloadColorID() {
            const element = document.getElementById('studentIdCard');
            html2pdf().set({
                margin: 10,
                filename: 'Student_ID_${student.student_id}.pdf',
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 3, useCORS: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(element).save();
        }
    </script>
</body>
</html>`);
    });
});

app.get('/api/student/:id', (req, res) => {
    const studentId = req.params.id.toUpperCase().trim();
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
        if (err || !student) return res.json({ success: false, message: 'Student not found' });
        res.json({ success: true, student: student });
    });
});

// ================= ADMIN DASHBOARD =================
app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const lang = req.query.lang || 'am';

    db.all(`SELECT * FROM pending_students`, [], (err, pending = []) => {
        db.all(`SELECT * FROM students ORDER BY class_level, name`, [], (err, students = []) => {
            db.all(`SELECT * FROM teachers ORDER BY name`, [], (err, teachers = []) => {
                db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections = []) => {
                    db.all(`SELECT * FROM courses ORDER BY class_level, code`, [], (err, courses = []) => {
                        db.all(`SELECT * FROM notifications ORDER BY id DESC`, [], (err, allNotifs = []) => {
                            db.all(`SELECT * FROM course_assessments`, [], (err, assessments = []) => {

                                let maleCount = students.filter(s => s.gender === 'Male').length;
                                let femaleCount = students.filter(s => s.gender === 'Female').length;
                                
                                let excellent = 0, good = 0, average = 0, poor = 0;
                                assessments.forEach(a => {
                                    if (a.total >= 90) excellent++;
                                    else if (a.total >= 75) good++;
                                    else if (a.total >= 50) average++;
                                    else poor++;
                                });

                                let pRows = pending.map(s => `<tr>
                                    <td>-</td>
                                    <td><b>${s.student_id}</b></td>
                                    <td style="text-align:left;">${s.name}</td>
                                    <td>${s.payment_type === 'slip_file' || (s.bank_slip_val && String(s.bank_slip_val).includes('.'))
                                        ? `<a href="/uploads/${s.bank_slip_val}" target="_blank" style="color:#2980b9;font-weight:bold;">📄 ደረሰኝ እይ</a>`
                                        : `<b>TXN:</b> ${s.bank_slip_val || '-'}`}</td>
                                    <td style="white-space:nowrap;">
                                        <a href="/admin/approve/${s.id}" style="background:#27ae60;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-weight:bold;margin-right:6px;">✅</a>
                                        <a href="/admin/reject/${s.id}" onclick="return confirm('ይህን አመልካች ማጥፋት ይፈልጋሉ?')" style="background:#e74c3c;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-weight:bold;">❌</a>
                                    </td>
                                </tr>`).join('');
                                let secRows = sections.map(sec => `<tr><td><a href="/class-hub/${encodeURIComponent(sec.name)}" style="color:#16a085; font-weight:bold;" target="_blank">📂 ${sec.name}</a></td><td><form action="/admin/edit-section/${sec.id}?lang=${lang}" method="POST" style="display:flex; gap:4px;"><select name="proctor_name" style="width:140px;"><option value="${sec.proctor_name || ''}">${sec.proctor_name || '-- Select --'}</option>${teachers.map(tc => `<option value="${tc.name}">${tc.name}</option>`).join('')}</select><button type="submit">Save</button></form></td><td><a href="/admin/delete-section/${sec.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑 Delete</a></td><td><a href="/attendance-sheet/${encodeURIComponent(sec.name)}" style="color:#2980b9; font-weight:bold; margin-right:10px;" target="_blank">📋 Attendance</a><a href="/admin/export-section-students/${encodeURIComponent(sec.name)}" style="background:#27ae60; color:white; padding:4px 8px; border-radius:3px; text-decoration:none; font-weight:bold;">📥 Excel</a></td></tr>`).join('');

                                let sectionOptions = sections.map(sec => `<option value="${sec.name}">${sec.name}</option>`).join('');
                                let rosterSectionButtons = sections.map(sec => `
                                    <a href="/admin/master-roster/2019%20E.C/${encodeURIComponent(sec.name)}" target="_blank"
                                       style="background:#1f4e79; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:bold; font-size:14px; display:inline-block; box-shadow:0 2px 5px rgba(0,0,0,0.15);">
                                        🏫 ${sec.name} (Master Roster & PDF)
                                    </a>
                                `).join('') || `<span style="color:#7f8c8d;">ምንም የተመዘገበ ሴክሽን የለም።</span>`;

                                let teacherOptions = teachers.map(tc => {
                                    const secs = (tc.assigned_sections || '').replace(/"/g, '');
                                    return `<option value="${tc.id}" data-sections="${secs}">${tc.name} — ${secs || 'no sections'}</option>`;
                                }).join('');
                                let gradeCheckboxes = ''; for(let i=1; i<=12; i++) gradeCheckboxes += `<label style="margin-right:8px;"><input type="checkbox" name="grades" value="Grade ${i}"> Grade ${i}</label>`;
                                let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td style="display:none;">0</td><td>${c.class_level}</td><td>${c.teacher_name||'-'}</td><td><a href="/admin/delete-course/${c.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');
                                
                                let tRows = teachers.map(tc => `
                                    <tr>
                                        <td><b>${tc.id}</b></td>
                                        <td style="text-align:left; font-weight:bold;">${tc.name}</td>
                                        <td>${tc.assigned_sections || 'None'}</td>
                                        <td><span style="color:#d35400; font-weight:bold;">${tc.plain_pin || '****'}</span></td>
                                        <td>
                                            <a href="/admin/edit-teacher/${tc.id}" style="background:#f39c12; color:white; padding:5px 10px; border-radius:4px; text-decoration:none; font-weight:bold; font-size:12px; margin-right:4px;">✏️ Edit</a>
                                            <a href="/admin/teacher-id/${tc.id}" style="background:#2980b9; color:white; padding:5px 10px; border-radius:4px; text-decoration:none; font-weight:bold; font-size:12px; margin-right:4px;">🪪 ID</a>
                                            <a href="/admin/delete-teacher/${tc.id}?lang=${lang}" onclick="return confirm('ይህ መምህር ይሰረዝ?')" style="background:#e74c3c; color:white; padding:5px 10px; border-radius:4px; text-decoration:none; font-weight:bold; font-size:12px;">🗑️</a>
                                        </td>
                                    </tr>
                                `).join('');

                                // 🎯 አድሚኑ ማስታወቂያ ሲልክ (ALL Students, ALL Teachers, Individual Search for Teachers & Students)
                                // Simple top-level options + Grades
                                let adminTargetOptions = `
                                    <option value="ALL_STUDENTS">👨‍🎓 ለሁሉም ተማሪዎች (All Students)</option>
                                    <option value="ALL_TEACHERS">👩‍🏫 ለሁሉም መምህራን (All Teachers)</option>
                                    <option value="ALL">🌍 ለሁሉም ተማሪዎች እና መምህራን (To Everyone)</option>
                                    <optgroup label="🏫 በክፍል / By Grade">
                                        ${[1,2,3,4,5,6,7,8,9,10,11,12].map(g => `<option value="GRADE:${g}">Grade ${g} (ሁሉም የGrade ${g} ተማሪዎች)</option>`).join('')}
                                    </optgroup>
                                `;

                                // Data for live search (name or ID)
                                const searchPeopleData = JSON.stringify({
                                    teachers: teachers.map(t => ({ id: t.id, name: t.name, type: 'teacher' })),
                                    students: students.map(s => ({ id: s.student_id, name: s.name, type: 'student', class: s.class_level || '' }))
                                });

                                // Show all notifications relevant to admin (including replies from teachers/students)
                                let adminNotiRows = allNotifs.filter(n => 
                                    n.sender_role === 'Admin' || 
                                    n.target_audience === 'ADMIN' || 
                                    n.target_audience === 'ALL' || 
                                    n.target_audience === 'ALL_TEACHERS' || 
                                    n.target_audience === 'ALL_STUDENTS' ||
                                    n.target_audience.startsWith('TEACHER:') ||
                                    n.target_audience.startsWith('STUDENT:') ||
                                    n.sender_role === 'Teacher' ||
                                    n.sender_role === 'Student'
                                ).map(n => `
                                    <div style="background:#fdf2e9; padding:15px; margin-bottom:15px; border-radius:8px; border:1px solid #e67e22;">
                                        <strong>🔔 ${n.sender_name} (${n.sender_role}) -> (ለ: <span style="color:#2980b9;">${n.target_audience || 'ALL'}</span> | ቀን: ${n.created_at})</strong>
                                        <div style="margin-top:10px; background:white; padding:12px; border-radius:6px; border:1px solid #ddd;">${n.message}</div>
                                        ${n.attachment ? `<div style="margin-top:8px;"><a href="/uploads/${n.attachment}" target="_blank" style="color:#2980b9; font-weight:bold;">📎 የተያያዘ ፋይል ክፈት</a></div>` : ''}
                                        <div style="margin-top:12px; border-top:1px solid #ccc; padding-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                                            <button type="button" onclick="document.getElementById('editNotif_${n.id}').style.display='block'" style="background:#f39c12; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-weight:bold;">✏️ Edit</button> 
                                            <a href="/delete-notification/${n.id}" onclick="return confirm('እርግጠኛ ነዎት ይህ ማስታወቂያ ይጠፋ?')" style="background:#e74c3c; color:white; padding:6px 14px; border-radius:4px; text-decoration:none; font-size:13px; font-weight:bold; display:inline-block;">🗑️ Delete</a>
                                            
                                            <!-- 💬 Reply Form for Admin -->
                                            <button type="button" onclick="document.getElementById('replyNotif_${n.id}').style.display='block'" style="background:#2980b9; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-weight:bold;">💬 Reply</button>
                                        </div>
                                        <form id="editNotif_${n.id}" action="/edit-notification/${n.id}" method="POST" enctype="multipart/form-data" style="display:none; margin-top:15px; background:#fff; padding:15px; border-radius:6px; border:1px solid #ccc;">
                                            <label style="font-weight:bold; font-size:13px; display:block; margin-bottom:5px;">ማስታወቂያውን ማስተካከል:</label>
                                            <textarea name="message" rows="4" style="width:100%; padding:8px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px;">${n.message}</textarea>
                                            <input type="file" name="attachment" style="display:block; margin-bottom:10px;">
                                            <button type="submit" style="background:#27ae60; color:white; border:none; padding:8px 18px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save Changes</button>
                                            <button type="button" onclick="document.getElementById('editNotif_${n.id}').style.display='none'" style="background:#7f8c8d; color:white; border:none; padding:8px 14px; border-radius:4px; cursor:pointer; margin-left:5px;">Cancel</button>
                                        </form>

                                        <!-- Reply Form -->
                                        <form id="replyNotif_${n.id}" action="/admin/send-notification" method="POST" enctype="multipart/form-data" style="display:none; margin-top:15px; background:#eef6fc; padding:15px; border-radius:6px; border:1px solid #bce8f1;">
                                            <input type="hidden" name="target_audience" value="${n.sender_role === 'Teacher' ? 'TEACHER:' + (n.sender_id || '') : (n.sender_role === 'Student' ? 'STUDENT:' + (n.sender_id || '') : 'ALL')}">
                                            <label style="font-weight:bold; font-size:13px; display:block; margin-bottom:5px; color:#1f4e79;">ምላሽ ይጻፉ (Reply):</label>
                                            <textarea name="message" rows="3" placeholder="ምላሽዎን እዚህ ይጻፉ..." style="width:100%; padding:8px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px;" required></textarea>
                                            <input type="file" name="attachment" style="display:block; margin-bottom:10px;">
                                            <button type="submit" style="background:#2980b9; color:white; border:none; padding:8px 18px; border-radius:4px; font-weight:bold; cursor:pointer;">📤 ምላሽ ላክ</button>
                                            <button type="button" onclick="document.getElementById('replyNotif_${n.id}').style.display='none'" style="background:#7f8c8d; color:white; border:none; padding:8px 14px; border-radius:4px; cursor:pointer; margin-left:5px;">Cancel</button>
                                        </form>
                                    </div>
                                `).join('');

                                res.render('admin', {
                                    lang, excellent, good, average, poor, maleCount, femaleCount,
                                    pRows, secRows, cRows, tRows, adminNotiRows, groupedStudentsHtml: '',
                                    sectionOptions, rosterSectionButtons, teacherOptions, gradeCheckboxes, adminTargetOptions,
                                    searchPeopleData
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// ================= 📢 NOTIFICATION ROUTES =================
app.post('/admin/save-notice', upload.single('attachment'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const target_audience = req.body.target_audience || 'ALL';
    const message = sanitizeRichText(req.body.message);
    const attachment = req.file ? req.file.filename : null;
    const createdAt = getFormattedTimestamp();

    db.run(
        `INSERT INTO notifications (sender_role, sender_name, target_audience, message, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ['Admin', 'School Admin', target_audience, message, attachment, createdAt],
        () => res.redirect('/admin')
    );
});

// Two-way messaging: Admin / Teacher / Student can all send & reply
app.post('/admin/send-notification', upload.single('attachment'), (req, res) => {
    const target_audience = req.body.target_audience || 'ALL';
    const message = sanitizeRichText(req.body.message);
    const attachment = req.file ? req.file.filename : null;
    const createdAt = getFormattedTimestamp();

    if (req.session.isAdmin) {
        db.run(
            `INSERT INTO notifications (sender_role, sender_name, target_audience, message, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            ['Admin', 'School Admin', target_audience, message, attachment, createdAt],
            () => res.redirect('/admin#notifications')
        );
    } else if (req.session.teacherId) {
        db.get(`SELECT name FROM teachers WHERE id = ?`, [req.session.teacherId], (err, t) => {
            if (!t) return res.redirect('/');
            db.run(
                `INSERT INTO notifications (sender_role, sender_name, target_audience, message, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                ['Teacher', t.name, target_audience, message, attachment, createdAt],
                () => res.redirect(req.query.cls ? `/teacher-dashboard?cls=${encodeURIComponent(req.query.cls)}` : '/teacher-dashboard')
            );
        });
    } else if (req.session.studentId) {
        db.get(`SELECT name FROM students WHERE student_id = ?`, [req.session.studentId], (err, s) => {
            if (!s) return res.redirect('/');
            db.run(
                `INSERT INTO notifications (sender_role, sender_name, target_audience, message, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                ['Student', s.name, target_audience, message, attachment, createdAt],
                () => res.redirect('/student-dashboard#notifications')
            );
        });
    } else {
        return res.redirect('/');
    }
});

// Only the original sender (or Admin) can delete
app.get('/delete-notification/:id', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId && !req.session.studentId) return res.redirect('/');

    db.get(`SELECT * FROM notifications WHERE id = ?`, [req.params.id], (err, n) => {
        if (!n) return res.redirect('/');

        let allowed = false;
        let backUrl = '/';

        if (req.session.isAdmin) {
            allowed = true;
            backUrl = '/admin';
        } else if (req.session.teacherId) {
            // Teacher can delete only their own messages
            db.get(`SELECT name FROM teachers WHERE id = ?`, [req.session.teacherId], (e, t) => {
                if (t && n.sender_name === t.name && n.sender_role === 'Teacher') {
                    db.run(`DELETE FROM notifications WHERE id = ?`, [req.params.id], () => res.redirect('/teacher-dashboard'));
                } else {
                    res.redirect('/teacher-dashboard');
                }
            });
            return;
        } else if (req.session.studentId) {
            // Student can delete only their own messages
            db.get(`SELECT name FROM students WHERE student_id = ?`, [req.session.studentId], (e, s) => {
                if (s && n.sender_name === s.name && n.sender_role === 'Student') {
                    db.run(`DELETE FROM notifications WHERE id = ?`, [req.params.id], () => res.redirect('/student-dashboard#notifications'));
                } else {
                    res.redirect('/student-dashboard');
                }
            });
            return;
        }

        if (allowed) {
            db.run(`DELETE FROM notifications WHERE id = ?`, [req.params.id], () => res.redirect(backUrl));
        } else {
            res.redirect(backUrl);
        }
    });
});

// Only the original sender (or Admin) can edit their own message
app.post('/edit-notification/:id', upload.single('attachment'), (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId && !req.session.studentId) return res.redirect('/');

    db.get(`SELECT * FROM notifications WHERE id = ?`, [req.params.id], (err, n) => {
        if (!n) return res.redirect('/');

        const msg = sanitizeRichText(req.body.message);
        const doUpdate = () => {
            let q = req.file ? `UPDATE notifications SET message = ?, attachment = ? WHERE id = ?` : `UPDATE notifications SET message = ? WHERE id = ?`;
            let p = req.file ? [msg, req.file.filename, req.params.id] : [msg, req.params.id];
            db.run(q, p, () => {
                if (req.session.isAdmin) return res.redirect('/admin#notifications');
                if (req.session.teacherId) return res.redirect('/teacher-dashboard#notifications');
                return res.redirect('/student-dashboard#notifications');
            });
        };

        if (req.session.isAdmin) {
            // Admin can edit any message
            return doUpdate();
        }

        if (req.session.teacherId) {
            db.get(`SELECT name FROM teachers WHERE id = ?`, [req.session.teacherId], (e, t) => {
                if (t && n.sender_name === t.name && n.sender_role === 'Teacher') {
                    doUpdate();
                } else {
                    res.redirect('/teacher-dashboard');
                }
            });
            return;
        }

        if (req.session.studentId) {
            db.get(`SELECT name FROM students WHERE student_id = ?`, [req.session.studentId], (e, s) => {
                if (s && n.sender_name === s.name && n.sender_role === 'Student') {
                    doUpdate();
                } else {
                    res.redirect('/student-dashboard');
                }
            });
            return;
        }

        res.redirect('/');
    });
});

// ================= 📖 MARK NOTIFICATION AS READ =================
app.post('/api/mark-read/:id', (req, res) => {
    const notifId = parseInt(req.params.id, 10);
    if (!notifId) return res.json({ success: false });

    let readerRole = null, readerId = null;
    if (req.session.isAdmin) { readerRole = 'Admin'; readerId = 'admin'; }
    else if (req.session.teacherId) { readerRole = 'Teacher'; readerId = req.session.teacherId; }
    else if (req.session.studentId) { readerRole = 'Student'; readerId = req.session.studentId; }
    else return res.json({ success: false });

    const readAt = getFormattedTimestamp();
    pool.query(
        `INSERT INTO notification_reads (notification_id, reader_role, reader_id, read_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (notification_id, reader_role, reader_id) DO NOTHING`,
        [notifId, readerRole, readerId, readAt]
    ).then(() => res.json({ success: true })).catch(() => res.json({ success: false }));
});

app.get('/api/unread-count', (req, res) => {
    let readerRole = null, readerId = null;
    if (req.session.isAdmin) { readerRole = 'Admin'; readerId = 'admin'; }
    else if (req.session.teacherId) { readerRole = 'Teacher'; readerId = req.session.teacherId; }
    else if (req.session.studentId) { readerRole = 'Student'; readerId = req.session.studentId; }
    else return res.json({ count: 0 });

    // Count notifications relevant to this user that they haven't read
    db.all(`SELECT id, target_audience, sender_role FROM notifications ORDER BY id DESC LIMIT 200`, [], (err, notifs = []) => {
        db.all(`SELECT notification_id FROM notification_reads WHERE reader_role = ? AND reader_id = ?`, [readerRole, readerId], (err2, reads = []) => {
            const readSet = new Set(reads.map(r => r.notification_id));
            let count = 0;
            notifs.forEach(n => {
                if (readSet.has(n.id)) return;
                // basic relevance
                if (readerRole === 'Admin') {
                    if (n.sender_role !== 'Admin' || n.target_audience === 'ADMIN') count++;
                } else if (readerRole === 'Teacher') {
                    if (n.target_audience === 'ALL' || n.target_audience === 'ALL_TEACHERS' ||
                        n.target_audience === 'TEACHER:' + readerId || n.target_audience === 'ADMIN') count++;
                } else if (readerRole === 'Student') {
                    if (n.target_audience === 'ALL' || n.target_audience === 'ALL_STUDENTS' ||
                        n.target_audience === 'STUDENT:' + readerId) count++;
                }
            });
            res.json({ count });
        });
    });
});

// ================= ✏️ EDIT STUDENT & TEACHER INFORMATION =================
app.get('/admin/edit-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.id], (err, s) => {
        if (!s) return res.send('<h3 style="text-align:center;color:red;margin-top:40px;">ተማሪው አልተገኘም!</h3>');
        db.all(`SELECT * FROM sections ORDER BY name`, [], (err2, sections = []) => {
            let sectionOptions = sections.map(sec => `<option value="${esc(sec.name)}" ${sec.name===s.class_level?'selected':''}>${sec.name}</option>`).join('');
            const field = (label, name, val, type='text') => `
                <div style="margin-bottom:12px;">
                    <label style="font-weight:bold; font-size:13.5px; color:#1f4e79; display:block; margin-bottom:4px;">${label}</label>
                    <input type="${type}" name="${name}" value="${esc(val)}" style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box;">
                </div>`;

            res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Edit Student - ${s.name}</title>
</head>
<body style="font-family:'Segoe UI',sans-serif; background:#eef2f5; padding:25px; margin:0;">
    <div style="max-width:650px; margin:auto; background:white; padding:30px; border-radius:12px; box-shadow:0 8px 25px rgba(0,0,0,0.1); border-top:6px solid #2980b9;">
        <h2 style="margin-top:0; color:#1f4e79;">✏️ የተማሪ መረጃ ማስተካከያ (Edit Student: ${s.student_id})</h2>
        <form action="/admin/edit-student/${s.student_id}" method="POST" enctype="multipart/form-data">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                ${field('👤 የተማሪ ሙሉ ስም (Full Name)', 'name', s.name)}
                ${field('👩 የእናት ስም (Mother Name)', 'mother_name', s.mother_name)}
                <div style="margin-bottom:12px;">
                    <label style="font-weight:bold; font-size:13.5px; color:#1f4e79; display:block; margin-bottom:4px;">⚧ ፆታ (Gender)</label>
                    <select name="gender" style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px;">
                        <option value="Male" ${s.gender==='Male'?'selected':''}>ወንድ (Male)</option>
                        <option value="Female" ${s.gender==='Female'?'selected':''}>ሴት (Female)</option>
                    </select>
                </div>
                ${field('🎂 ዕድሜ (Age)', 'age', s.age, 'number')}
                ${field('📞 ስልክ ቁጥር (Phone)', 'phone', s.phone)}
                ${field('🚨 የአደጋ ጊዜ ስልክ (Emergency Phone)', 'emergency_phone', s.emergency_phone)}
                ${field('📍 ክልል (Region)', 'region', s.region)}
                ${field('📍 ዞን (Zone)', 'zone', s.zone)}
                ${field('📍 ወረዳ (Woreda)', 'woreda', s.woreda)}
                ${field('📍 ቀበሌ (Kebele)', 'kebele', s.kebele)}
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-weight:bold; font-size:13.5px; color:#1f4e79; display:block; margin-bottom:4px;">🏫 ክፍል እና ሴክሽን (Grade / Section)</label>
                <select name="class_level" style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px;">
                    ${sectionOptions}
                </select>
            </div>

            <div style="margin-bottom:12px; background:#fffcf5; padding:12px; border:1px dashed #f39c12; border-radius:6px;">
                <label style="font-weight:bold; font-size:13.5px; color:#d35400; display:block; margin-bottom:4px;">🔑 አዲስ የይለፍ ቃል / PIN (መቀየር ከፈለጉ ብቻ ይጻፉ)</label>
                <input type="text" name="new_password" placeholder="ፓስወርዱን መቀየር ካልፈለጉ ባዶ ይተዉት..." style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box;">
            </div>

            <div style="margin-bottom:15px; display:flex; align-items:center; gap:15px;">
                <img src="/uploads/${s.photo || 'logo.jpg'}" style="width:60px; height:60px; border-radius:50%; object-fit:cover; border:2px solid #2980b9;">
                <div style="flex:1;">
                    <label style="font-weight:bold; font-size:13.5px; color:#1f4e79; display:block; margin-bottom:4px;">📷 አዲስ የተማሪ ፎቶ (አማራጭ - ካልቀየሩት ነባሩ ፎቶ እና ሁሉም መረጃ በጭራሽ አይጥፉም)</label>
                    <input type="file" name="student_photo" accept="image/*" style="width:100%; padding:8px; border:1px solid #cbd5e1; border-radius:6px;">
                </div>
            </div>

            <button type="submit" style="width:100%; padding:14px; background:#27ae60; color:white; border:none; border-radius:8px; font-weight:bold; font-size:16px; cursor:pointer;">
                💾 የተስተካከለውን መረጃ አስቀምጥ (Save Changes)
            </button>
        </form>
        <div style="margin-top:15px; text-align:center;">
            <a href="/admin/registered-students" style="color:#2980b9; font-weight:bold; text-decoration:none;">⬅️ ወደ ተማሪዎች ዝርዝር ተመለስ (Back)</a>
        </div>
    </div>
</body>
</html>`);
        });
    });
});

app.post('/admin/edit-student/:id', upload.single('student_photo'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const studentId = req.params.id;
    const { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, new_password } = req.body;

    if (new_password && new_password.trim() !== '' && isWeakPassword(new_password)) {
        return res.send(`<script>alert('❌ እንደ 1234 ወይም 0000 ያሉ ደካማ የይለፍ ቃሎች አይፈቀዱም!'); window.history.back();</script>`);
    }

    // Photo & data protection: only update fields that are provided; keep old photo if no new file
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, oldSt) => {
        if (!oldSt) return res.redirect('/admin/registered-students');

        // Never wipe photo unless a NEW file was uploaded
        const finalPhoto = (req.file && req.file.filename) ? req.file.filename : oldSt.photo;

        const updatePassIfNeeded = (cb) => {
            if (new_password && new_password.trim() !== '') {
                const hashed = bcrypt.hashSync(new_password.trim(), 10);
                db.run(`UPDATE students SET password = ? WHERE student_id = ?`, [hashed, studentId], () => cb());
            } else {
                cb();
            }
        };

        updatePassIfNeeded(() => {
            db.run(
                `UPDATE students SET name=?, mother_name=?, gender=?, age=?, phone=?, emergency_phone=?, region=?, zone=?, woreda=?, kebele=?, class_level=?, photo=? WHERE student_id=?`,
                [
                    name || oldSt.name,
                    mother_name !== undefined ? mother_name : oldSt.mother_name,
                    gender || oldSt.gender,
                    age || oldSt.age,
                    phone || oldSt.phone,
                    emergency_phone || oldSt.emergency_phone,
                    region || oldSt.region,
                    zone || oldSt.zone,
                    woreda || oldSt.woreda,
                    kebele || oldSt.kebele,
                    class_level || oldSt.class_level,
                    finalPhoto,
                    studentId
                ],
                () => res.redirect('/admin/registered-students')
            );
        });
    });
});

app.get('/admin/edit-teacher/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.params.id], (err, t) => {
        if (!t) return res.redirect('/admin');
        db.all(`SELECT * FROM sections ORDER BY name`, [], (err2, sections = []) => {
            const currentSecs = (t.assigned_sections || '').split(',').map(s => s.trim());
            const secCheckboxes = sections.map(sec => `
                <label style="display:flex; align-items:center; gap:6px; background:#f8fafc; padding:8px; border:1px solid #cbd5e1; border-radius:6px; cursor:pointer; font-size:13px; font-weight:bold;">
                    <input type="checkbox" name="assigned_sections" value="${esc(sec.name)}" ${currentSecs.includes(sec.name) ? 'checked' : ''}>
                    <span>${sec.name}</span>
                </label>
            `).join('');

            const field = (label, name, val) => `
                <div style="margin-bottom:12px;">
                    <label style="font-weight:bold; font-size:13.5px; color:#8e44ad; display:block; margin-bottom:4px;">${label}</label>
                    <input type="text" name="${name}" value="${esc(val)}" style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box;">
                </div>`;

            res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Edit Teacher - ${t.name}</title>
</head>
<body style="font-family:'Segoe UI',sans-serif; background:#eef2f5; padding:25px; margin:0;">
    <div style="max-width:650px; margin:auto; background:white; padding:30px; border-radius:12px; box-shadow:0 8px 25px rgba(0,0,0,0.1); border-top:6px solid #8e44ad;">
        <h2 style="margin-top:0; color:#8e44ad;">✏️ የመምህር መረጃ ማስተካከያ (Edit Teacher: ${t.id})</h2>
        <form action="/admin/edit-teacher/${t.id}" method="POST" enctype="multipart/form-data">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                ${field('👤 የመምህሩ ሙሉ ስም (Full Name)', 'name', t.name)}
                <div style="margin-bottom:12px;">
                    <label style="font-weight:bold; font-size:13.5px; color:#8e44ad; display:block; margin-bottom:4px;">⚧ ፆታ (Gender)</label>
                    <select name="gender" style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px;">
                        <option value="Male" ${t.gender==='Male'?'selected':''}>ወንድ (Male)</option>
                        <option value="Female" ${t.gender==='Female'?'selected':''}>ሴት (Female)</option>
                    </select>
                </div>
                ${field('📞 ስልክ ቁጥር (Phone)', 'phone', t.phone)}
                ${field('📘 የሚያስተምሩት ትምህርት (Subject)', 'subject', t.subject)}
                ${field('🚨 የአደጋ ጊዜ ተጠሪ ስም (Emergency Name)', 'emergency_name', t.emergency_name)}
                ${field('☎️ የአደጋ ጊዜ ተጠሪ ስልክ (Emergency Phone)', 'emergency_phone', t.emergency_phone)}
            </div>

            <div style="margin-bottom:15px;">
                <label style="font-weight:bold; font-size:13.5px; color:#8e44ad; display:block; margin-bottom:6px;">🏫 የሚያስተምሩባቸው ክፍሎች እና ሴክሽኖች (Assigned Sections)</label>
                <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; max-height:180px; overflow-y:auto; padding:10px; border:1px solid #cbd5e1; border-radius:6px;">
                    ${secCheckboxes}
                </div>
            </div>

            <div style="margin-bottom:12px; background:#fffcf5; padding:12px; border:1px dashed #f39c12; border-radius:6px;">
                <label style="font-weight:bold; font-size:13.5px; color:#d35400; display:block; margin-bottom:4px;">🔑 የይለፍ ቃል / PIN (የአሁኑ: ${t.plain_pin || '****'})</label>
                <input type="text" name="plain_pin" value="${esc(t.plain_pin)}" placeholder="አዲስ PIN ያስገቡ..." style="width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box;">
            </div>

            <div style="margin-bottom:15px; display:flex; align-items:center; gap:15px;">
                <img src="/uploads/${t.photo || 'logo.jpg'}" style="width:60px; height:60px; border-radius:50%; object-fit:cover; border:2px solid #8e44ad;">
                <div style="flex:1;">
                    <label style="font-weight:bold; font-size:13.5px; color:#8e44ad; display:block; margin-bottom:4px;">📷 አዲስ ፎቶ (አማራጭ - ካልቀየሩት ነባሩ ፎቶ እና ሁሉም መረጃ በጭራሽ አይጥፉም)</label>
                    <input type="file" name="teacher_photo" accept="image/*" style="width:100%; padding:8px; border:1px solid #cbd5e1; border-radius:6px;">
                </div>
            </div>

            <button type="submit" style="width:100%; padding:14px; background:#8e44ad; color:white; border:none; border-radius:8px; font-weight:bold; font-size:16px; cursor:pointer;">
                💾 የመምህሩን መረጃ አስቀምጥ (Save Changes)
            </button>
        </form>
        <div style="margin-top:15px; text-align:center;">
            <a href="/admin" style="color:#8e44ad; font-weight:bold; text-decoration:none;">⬅️ ወደ አድሚን ዳሽቦርድ ተመለስ (Back to Admin)</a>
        </div>
    </div>
</body>
</html>`);
        });
    });
});

app.post('/admin/edit-teacher/:id', upload.single('teacher_photo'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const teacherId = req.params.id;
    const { name, gender, phone, subject, emergency_name, emergency_phone, assigned_sections, plain_pin } = req.body;
    const sectionsStr = Array.isArray(assigned_sections) ? assigned_sections.join(', ') : (assigned_sections || '');

    if (plain_pin && plain_pin.trim() !== '' && isWeakPassword(plain_pin)) {
        return res.send(`<script>alert('❌ እንደ 1234 ወይም 0000 ያሉ ደካማ የይለፍ ቃሎች አይፈቀዱም!'); window.history.back();</script>`);
    }

    db.get(`SELECT * FROM teachers WHERE id = ?`, [teacherId], (err, t) => {
        if (!t) return res.redirect('/admin');
        const finalPin = (plain_pin && plain_pin.trim() !== '') ? plain_pin.trim() : (t.plain_pin || '5829');
        const hashedPin = (plain_pin && plain_pin.trim() !== '') ? bcrypt.hashSync(finalPin, 10) : t.password;
        const finalPhoto = req.file ? req.file.filename : t.photo;

        db.run(
            `UPDATE teachers SET name=?, gender=?, phone=?, subject=?, emergency_name=?, emergency_phone=?, assigned_sections=?, password=?, plain_pin=?, photo=? WHERE id=?`,
            [name, gender || '', phone || '', subject || '', emergency_name || '', emergency_phone || '', sectionsStr, hashedPin, finalPin, finalPhoto, teacherId],
            () => res.redirect('/admin')
        );
    });
});

// ================= OTHER ADMIN ACTIONS & TEACHER ID CARD =================
app.get('/admin/approve/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM pending_students WHERE id = ?`, [req.params.id], (err, st) => {
        if (!st) return res.redirect('/admin');
        db.run(`INSERT INTO students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [st.student_id, st.password, st.name, st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.region, st.zone, st.woreda, st.kebele, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', '🎉 Your registration is approved!'], () => {
            logActivity('Admin', 'Director', 'APPROVE_STUDENT', st.student_id + ' ' + (st.name||''));
            if (st.phone || st.emergency_phone) { db.run(`INSERT INTO sms_logs (recipient_phone, recipient_name, message, channel, status, created_at) VALUES (?,?,?,?,?,?)`, [st.emergency_phone || st.phone, st.name, 'ALLS: Registration approved. You can login now. ID: '+st.student_id, 'sms', 'queued', getFormattedTimestamp()]); }
            db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin#pending-approvals'));
        });
    });
});

// ❌ Reject pending student (delete after payment check fails)
app.get('/admin/reject/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    logActivity('Admin', 'Director', 'REJECT_STUDENT', 'pending id=' + req.params.id);
    db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin#pending-approvals'));
});

app.post('/admin/register-teacher-full', upload.single('teacher_photo'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { name, gender, phone, subject, assigned_sections, emergency_name, emergency_phone } = req.body;
    const photoFile = req.file ? req.file.filename : '';
    const teacherID = 'ALLS-T-' + Math.floor(1000 + Math.random() * 9000);
    const autoPIN = generateStrong4DigitPIN();
    const hashedPIN = bcrypt.hashSync(autoPIN, 10);
    const sectionsStr = Array.isArray(assigned_sections) ? assigned_sections.join(', ') : (assigned_sections || '');

    db.run(
        `INSERT INTO teachers (id, name, phone, password, assigned_sections, gender, subject, emergency_name, emergency_phone, photo, plain_pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [teacherID, name, phone, hashedPIN, sectionsStr, gender || '', subject || '', emergency_name || '', emergency_phone || '', photoFile, autoPIN],
        () => {
            const secList = sectionsStr.split(',').map(s => s.trim()).filter(Boolean);
            if (subject && secList.length > 0) {
                const autoCode = subject.substring(0, 3).toUpperCase() + '-' + Math.floor(10 + Math.random() * 89);
                secList.forEach(sec => {
                    db.run(`INSERT INTO courses (code, title, credit_hours, teacher_id, teacher_name, class_level) VALUES (?,?,?,?,?,?)`,
                        [autoCode, subject, 0, teacherID, name, sec], () => {});
                });
            }
            res.redirect(`/admin/teacher-id/${teacherID}?pin=${autoPIN}`);
        }
    );
});

app.get('/admin/teacher-id/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.params.id], (err, t) => {
        if (err || !t) return res.redirect('/admin');
        const displayPin = req.query.pin || t.plain_pin || '****';
        const avatarUrl = t.photo ? `/uploads/${t.photo}` : `/uploads/logo.jpg`;

        res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <title>Teacher ID Card - ${t.name}</title>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #eef2f5; margin: 0; padding: 25px; display: flex; flex-direction: column; align-items: center; }
        .top-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; justify-content: center; }
        .btn { padding: 10px 18px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; color: white; font-size: 14px; }
        .cred-box { background: #fffcf5 !important; border: 2px dashed #f39c12; border-radius: 10px; padding: 15px 25px; margin-bottom: 25px; max-width: 420px; width: 100%; text-align: center; }
        .id-card { width: 360px; background: white !important; border-radius: 16px; overflow: hidden; box-shadow: 0 15px 35px rgba(0,0,0,0.2); border: 2px solid #1f4e79; }
        .id-header { background: linear-gradient(135deg, #1f4e79 0%, #0d2b45 100%) !important; color: white !important; padding: 20px 15px 45px 15px; text-align: center; border-bottom: 5px solid #f39c12; }
        .id-header img.school-logo { width: 52px; height: 52px; border-radius: 50%; border: 2px solid #f39c12; background: white; object-fit: cover; }
        .photo-wrap { width: 105px; height: 105px; margin: -52px auto 10px auto; border-radius: 50%; border: 4px solid white; box-shadow: 0 5px 15px rgba(0,0,0,0.2); overflow: hidden; background: #fff; }
        .photo-wrap img { width: 100%; height: 100%; object-fit: cover; }
        .id-body { padding: 5px 22px 20px 22px; text-align: center; background: white !important; }
        .teacher-name { font-size: 20px; font-weight: 800; color: #1f4e79; margin: 5px 0; }
        .teacher-subject { font-size: 14px; font-weight: bold; color: #8e44ad; margin-bottom: 12px; }
        .info-table { width: 100%; text-align: left; font-size: 13.5px; border-collapse: collapse; margin-bottom: 12px; }
        .info-table td { padding: 6px 4px; border-bottom: 1px solid #f0f2f5; }
        .barcode-box { background: #f8fafc !important; padding: 8px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 5px; }
        .id-footer { background: #1f4e79 !important; color: white !important; font-size: 11.5px; padding: 8px; text-align: center; }
        @media print { .no-print { display: none !important; } body { background: white; padding: 0; } .id-card { box-shadow: none; margin: auto; } }
    </style>
</head>
<body>
    <div class="top-bar no-print">
        <a href="/admin" class="btn" style="background:#7f8c8d;">⬅️ ወደ አድሚን ተመለስ</a>
        <button onclick="downloadTeacherID()" class="btn" style="background:#27ae60;">📥 በኦሪጅናል ከለር Download PDF</button>
        <button onclick="window.print()" class="btn" style="background:#2980b9;">🖨️ ፕሪንት አድርግ</button>
    </div>
    <div class="cred-box no-print">
        <h3 style="margin:0 0 8px 0;color:#d35400;">✅ የመምህር መግቢያ መረጃ</h3>
        <div style="font-size:16px;background:white;padding:10px;border-radius:6px;border:1px solid #fad7a0;">
            <b>🆔 ID:</b> <span style="color:#2980b9;font-weight:bold;">${t.id}</span> &nbsp;|&nbsp;
            <b>🔑 PIN:</b> <span style="color:#e74c3c;font-weight:bold;font-size:18px;">${displayPin}</span>
        </div>
    </div>
    <div id="teacherIdCard" class="id-card">
        <div class="id-header">
            <img src="/uploads/logo.jpg" class="school-logo" crossorigin="anonymous">
            <h3 style="margin:8px 0 3px 0;font-size:17px;">AMANUEL LIGHT & LIFE SCHOOL</h3>
            <span style="background:#f39c12 !important;color:#fff !important;font-size:11px;font-weight:bold;padding:3px 12px;border-radius:20px;">OFFICIAL TEACHER ID CARD</span>
        </div>
        <div class="photo-wrap"><img src="${avatarUrl}" onerror="this.src='/uploads/logo.jpg'" crossorigin="anonymous"></div>
        <div class="id-body">
            <div class="teacher-name">${t.name}</div>
            <div class="teacher-subject">📘 ${t.subject || 'Teacher'}</div>
            <table class="info-table">
                <tr><td><b>ID:</b></td><td style="color:#2980b9;font-weight:bold;">${t.id}</td></tr>
                <tr><td><b>Gender:</b></td><td>${t.gender || '-'}</td></tr>
                <tr><td><b>Sections:</b></td><td>${t.assigned_sections || '-'}</td></tr>
                <tr><td><b>Phone:</b></td><td>${t.phone || '-'}</td></tr>
                <tr><td><b>Emergency:</b></td><td>${t.emergency_name || '-'} (${t.emergency_phone || '-'})</td></tr>
            </table>
            <div class="barcode-box"><svg id="barcode"></svg></div>
        </div>
        <div class="id-footer">Property of Amanuel Light and Life School</div>
    </div>
    <script>
        JsBarcode("#barcode","${t.id}",{format:"CODE128",width:1.8,height:40,displayValue:true,fontSize:13,margin:0});
        function downloadTeacherID() {
            const element = document.getElementById('teacherIdCard');
            html2pdf().set({
                margin: 10,
                filename: 'Teacher_ID_${t.id}.pdf',
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 3, useCORS: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(element).save();
        }
    </script>
</body>
</html>`);
    });
});

app.get('/api/sections-list', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.status(401).json({ rows: [] });
    db.all(`SELECT name FROM sections ORDER BY name`, [], (e, rows) => res.json({ rows: rows || [] }));
});

app.post('/admin/handover-section', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { section_name, old_teacher_id, new_teacher_id } = req.body;
    if (!section_name || !new_teacher_id) return res.redirect('/admin');

    const selectedSections = (Array.isArray(section_name) ? section_name.join(',') : section_name)
        .split(',').map(s => s.trim()).filter(Boolean);
    if (selectedSections.length === 0) return res.redirect('/admin');

    const removeOldTeacherSections = (callback) => {
        if (!old_teacher_id) return callback();
        db.get(`SELECT assigned_sections FROM teachers WHERE id = ?`, [old_teacher_id], (err, oldT) => {
            if (err || !oldT) return callback();
            let currentSecs = (oldT.assigned_sections || '').split(',').map(s => s.trim()).filter(s => s && !selectedSections.includes(s));
            db.run(`UPDATE teachers SET assigned_sections = ? WHERE id = ?`, [currentSecs.join(', '), old_teacher_id], () => callback());
        });
    };

    removeOldTeacherSections(() => {
        db.get(`SELECT name, assigned_sections FROM teachers WHERE id = ?`, [new_teacher_id], (err, newT) => {
            if (err || !newT) return res.redirect('/admin');
            let newSecs = (newT.assigned_sections || '').split(',').map(s => s.trim()).filter(Boolean);
            selectedSections.forEach(sec => { if (!newSecs.includes(sec)) newSecs.push(sec); });

            db.run(`UPDATE teachers SET assigned_sections = ? WHERE id = ?`, [newSecs.join(', '), new_teacher_id], () => {
                selectedSections.forEach(sec => {
                    db.run(`UPDATE sections SET proctor_name = ? WHERE name = ?`, [newT.name, sec], () => {});
                    if (old_teacher_id) {
                        db.run(`UPDATE courses SET teacher_id = ?, teacher_name = ? WHERE class_level = ? AND teacher_id = ?`, [new_teacher_id, newT.name, sec, old_teacher_id], () => {});
                        db.run(`UPDATE course_assessments SET teacher_id = ? WHERE teacher_id = ? AND student_id IN (SELECT student_id FROM students WHERE class_level = ?)`, [new_teacher_id, old_teacher_id, sec], () => {});
                    } else {
                        db.run(`UPDATE courses SET teacher_id = ?, teacher_name = ? WHERE class_level = ?`, [new_teacher_id, newT.name, sec], () => {});
                    }
                });
                const secList = selectedSections.join(', ');
                const ts = getFormattedTimestamp();
                // Notify incoming teacher which class/sections they received
                const msgNew = `<p><b>📚 ክፍል ተመድቦሎታል / Class assigned</b></p>
<p>የተመደቡ ክፍሎች / Sections: <b>${secList}</b></p>
<p>ሙሉ የተመደቡ ክፍሎችዎ / All your sections: <b>${newSecs.join(', ')}</b></p>
<p style="color:#64748b;font-size:12px;">${ts}</p>`;
                db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at) VALUES (?,?,?,?,?)`,
                    ['Admin', 'Director', 'TEACHER:' + new_teacher_id, msgNew, ts], () => {});
                // Notify leaving teacher if replace
                if (old_teacher_id) {
                    const msgOld = `<p><b>📤 ክፍል ተላልፏል / Sections handed over</b></p>
<p>የተላለፉ ክፍሎች / Handed over: <b>${secList}</b></p>
<p>ለ / To: <b>${newT.name}</b> (${new_teacher_id})</p>
<p style="color:#64748b;font-size:12px;">${ts}</p>`;
                    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at) VALUES (?,?,?,?,?)`,
                        ['Admin', 'Director', 'TEACHER:' + old_teacher_id, msgOld, ts], () => {});
                }
                try { logActivity('Admin', 'Director', 'TEACHER_HANDOVER', new_teacher_id + ' <= ' + secList); } catch (e) {}
                res.redirect('/admin#teachers');
            });
        });
    });
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
        [req.body.code, req.body.title, 0, req.body.teacher_id || '', t ? t.name : '', req.body.class_level], () => res.redirect('/admin'));
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
        db.run(`DELETE FROM course_assessments WHERE student_id = ?`, [req.params.id], () => res.redirect('/admin/registered-students'));
    });
});

app.get('/admin/remove-student/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM students WHERE student_id = ?`, [req.params.id], () => {
        db.run(`DELETE FROM course_assessments WHERE student_id = ?`, [req.params.id], () => res.redirect('/admin/registered-students'));
    });
});

app.get('/admin/export-section-students/:secName', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let secName = decodeURIComponent(req.params.secName);
    db.all(`SELECT student_id, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, status FROM students`, [], (err, allStudents = []) => {
        let students = allStudents.filter(s => isClassMatch(s.class_level, secName));
        let header = ['student_id','name','mother_name','gender','age','phone','emergency_phone','region','zone','woreda','kebele','class_level','payment_type','status'];
        let rows = [header.join(',')];
        students.forEach(s => rows.push(header.map(col => csvCell(s[col])).join(',')));
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=students_${secName.replace(/\s+/g, '_')}.csv`);
        res.send(rows.join('\r\n'));
    });
});

app.get('/class-hub/:className', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let className = decodeURIComponent(req.params.className);
    db.all(`SELECT student_id, name, gender, class_level FROM students`, [], (err, allStudents = []) => {
        let students = allStudents.filter(s => isClassMatch(s.class_level, className));
        db.all(`SELECT * FROM course_assessments`, [], (err, assessments = []) => {
            students.forEach(st => {
                let st_ass = assessments.filter(a => a.student_id === st.student_id);
                st.cumulative_total = st_ass.reduce((sum, a) => sum + (a.total || 0), 0);
            });
            students.sort((a, b) => b.cumulative_total - a.cumulative_total);
            db.all(`SELECT * FROM sections`, [], (err, allSections = []) => {
                let section = allSections.find(sec => isClassMatch(sec.name, className));
                db.all(`SELECT * FROM courses`, [], (err, allCourses = []) => {
                    let courses = allCourses.filter(c => isClassMatch(c.class_level, className));
                    let sRows = students.map((s, idx) => `<tr><td><b>${idx + 1}</b></td><td>${s.student_id}</td><td style="text-align:left;">${s.name}</td><td>${s.gender}</td><td>${s.cumulative_total}</td></tr>`).join('');
                    let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.teacher_name || 'N/A'}</td></tr>`).join('');
                    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Class Hub - ${className}</title><style>*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}body{font-family:sans-serif; padding:20px; background:#f4f7f6;} .card{background:white; padding:20px; border-radius:8px; margin-bottom:15px;} table{width:100%; border-collapse:collapse; margin-top:10px;} th,td{border:1px solid #ccc; padding:8px; text-align:center;} th{background:#1f4e79!important; color:white!important;}</style></head><body><a href="/admin" style="background:#7f8c8d; color:white; padding:8px 12px; text-decoration:none; border-radius:5px;">⬅️ Back to Admin Dashboard</a><h2>📂 Class Hub: ${className}</h2><div class="card"><p><strong>Proctor:</strong> ${section ? section.proctor_name : 'N/A'}</p><p><strong>Total Students:</strong> ${students.length}</p></div><div class="card"><h3>📚 Courses</h3><table><tr><th>Code</th><th>Title</th><th>Teacher</th></tr>${cRows||'<tr><td colspan="3">No courses</td></tr>'}</table></div><div class="card"><h3>🏆 Ranking</h3><table><tr><th>Rank</th><th>ID</th><th>Name</th><th>Gender</th><th>Total</th></tr>${sRows||'<tr><td colspan="5">No students</td></tr>'}</table></div></body></html>`);
                });
            });
        });
    });
});

app.get('/admin/registered-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');

    db.all(`SELECT * FROM students ORDER BY class_level ASC, name ASC`, [], (err, students = []) => {
        if (err) students = [];

        const maleCount = students.filter(s => (s.gender || '').toLowerCase() === 'male' || s.gender === 'ወንድ').length;
        const femaleCount = students.filter(s => (s.gender || '').toLowerCase() === 'female' || s.gender === 'ሴት').length;

        const grouped = {};
        students.forEach(s => {
            const cls = s.class_level || 'Unassigned';
            if (!grouped[cls]) grouped[cls] = [];
            grouped[cls].push(s);
        });

        let groupedStudentsHtml = '';
        Object.keys(grouped).sort().forEach(cls => {
            groupedStudentsHtml += `
                <h3 style="color:#1f4e79; border-bottom:2px solid #3498db; padding-bottom:5px; margin-top:25px;">🏫 ክፍል: ${cls} (${grouped[cls].length} ተማሪዎች)</h3>
                <div style="overflow-x:auto;">
                    <table style="width:100%; border-collapse:collapse; margin-bottom:15px; background:white;">
                        <tr style="background:#1f4e79; color:white;">
                            <th>ID</th>
                            <th>ስም (Name)</th>
                            <th>ፆታ</th>
                            <th>ስልክ</th>
                            <th>የእናት ስም</th>
                            <th>አድራሻ</th>
                            <th>ክፍያ / ደረሰኝ</th>
                            <th>እርምጃ</th>
                        </tr>
            `;
            grouped[cls].forEach(st => {
                const slipDisplay = st.bank_slip_val && (st.bank_slip_val.includes('.') || st.bank_slip_val.startsWith('slip'))
                    ? `<a href="/uploads/${st.bank_slip_val}" target="_blank" style="color:#27ae60; font-weight:bold;">📄 ክፈት</a>`
                    : `<span style="color:#1f4e79; font-weight:bold;">🔢 ${st.bank_slip_val || '-'}</span>`;

                groupedStudentsHtml += `
                    <tr>
                        <td><b>${st.student_id}</b></td>
                        <td>${st.name}</td>
                        <td>${st.gender}</td>
                        <td>${st.phone || '-'}</td>
                        <td>${st.mother_name || '-'}</td>
                        <td>${st.region || '-'}/${st.woreda || '-'}</td>
                        <td>${slipDisplay}</td>
                        <td>
                            <a href="/admin/edit-student/${st.student_id}" style="background:#f39c12; color:white; padding:5px 10px; border-radius:4px; font-weight:bold; margin-right:6px; text-decoration:none; font-size:12px;">✏️ አስተካክል</a>
                            <a href="/admin/delete-student/${st.student_id}" onclick="return confirm('ይህንን ተማሪ መሰረዝ ፈልገዋል?')" style="color:white; background:#e74c3c; padding:5px 10px; border-radius:4px; text-decoration:none; font-size:12px; font-weight:bold;">🗑️ ሰርዝ</a>
                        </td>
                    </tr>
                `;
            });
            groupedStudentsHtml += `</table></div>`;
        });

        if (students.length === 0) {
            groupedStudentsHtml = `<p style="text-align:center; color:#7f8c8d; padding:30px;">ምንም የተመዘገበ ተማሪ የለም።</p>`;
        }

        res.render('registered-students', {
            students,
            maleCount,
            femaleCount,
            groupedStudentsHtml
        });
    });
});

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

                    const classCounts = {};
                    students.forEach(s => {
                        const cls = s.class_level || 'Unassigned';
                        if (!classCounts[cls]) classCounts[cls] = { total: 0, male: 0, female: 0 };
                        classCounts[cls].total++;
                        if ((s.gender || '').toLowerCase() === 'male' || s.gender === 'ወንድ') classCounts[cls].male++;
                        else classCounts[cls].female++;
                    });

                    let classRowsHtml = Object.keys(classCounts).sort().map(cls => `
                        <tr>
                            <td><b>${cls}</b></td>
                            <td>${classCounts[cls].male}</td>
                            <td>${classCounts[cls].female}</td>
                            <td><b>${classCounts[cls].total}</b></td>
                        </tr>
                    `).join('');

                    if (!classRowsHtml) {
                        classRowsHtml = `<tr><td colspan="4">ምንም የተመዘገበ ተማሪ የለም</td></tr>`;
                    }

                    let teacherRowsHtml = teachers.map(t => `
                        <tr>
                            <td><b>${t.id}</b></td>
                            <td>${t.name}</td>
                            <td>${t.subject || '-'}</td>
                            <td>${t.assigned_sections || '-'}</td>
                            <td>${t.phone || '-'}</td>
                        </tr>
                    `).join('');

                    if (!teacherRowsHtml) {
                        teacherRowsHtml = `<tr><td colspan="5">ምንም የተመዘገበ መምህር የለም</td></tr>`;
                    }

                    res.render('director-report', {
                        reportType,
                        directorNote,
                        todayStr,
                        totalStudents,
                        maleCount,
                        femaleCount,
                        pendingCount: pending.length,
                        teacherCount: teachers.length,
                        sectionCount: sections.length,
                        classRowsHtml,
                        teacherRowsHtml
                    });

                });
            });
        });
    });
});

app.get('/teacher-dashboard', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    db.get('SELECT * FROM teachers WHERE id = ?', [req.session.teacherId], (err, teacher) => {
        if (!teacher) return res.redirect('/');
        let assignedClasses = teacher.assigned_sections ? teacher.assigned_sections.split(',').map(s => s.trim()).filter(Boolean) : [];
        let selectedClass = (req.query.cls || assignedClasses[0] || '').trim();

        db.all('SELECT student_id, name, class_level FROM students ORDER BY name ASC', [], (err, allStudents = []) => {
            let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, selectedClass));
            db.all('SELECT * FROM courses', [], (err, allCourses = []) => {
                let classCourses = allCourses.filter(c => (c.teacher_id === req.session.teacherId || !c.teacher_id) && isClassMatch(c.class_level, selectedClass));
                if (classCourses.length === 0) classCourses = allCourses.filter(c => isClassMatch(c.class_level, selectedClass));
                if (classCourses.length === 0) classCourses = allCourses.filter(c => c.teacher_id === req.session.teacherId);

                let selectedCourseId = req.query.course_id || (classCourses[0] ? classCourses[0].id.toString() : '');
                let selectedCourse = classCourses.find(c => c.id.toString() === selectedCourseId) || classCourses[0] || null;
                if (selectedCourse && !selectedCourseId) selectedCourseId = selectedCourse.id.toString();

                const activeCourseCode = selectedCourse ? selectedCourse.code : (teacher.subject || 'GEN-01');

                db.all('SELECT * FROM course_assessments WHERE course_code = ?', [activeCourseCode], (err, assessments = []) => {
                    db.all('SELECT * FROM absence_requests WHERE class_level = ? ORDER BY id DESC', [selectedClass], (err, classAbsences = []) => {
                        db.all('SELECT * FROM sections', [], (err, allSections = []) => {
                            let currentSection = allSections.find(sec => isClassMatch(sec.name, selectedClass));
                            let isProctor = currentSection && currentSection.proctor_name === teacher.name;

                            db.all("SELECT * FROM notifications ORDER BY id DESC", [], (err, allNotifs = []) => {
                                let mySentNotifs = allNotifs.filter(n => n.sender_name === teacher.name);
                                // Received: to this teacher, all teachers, or admin-style for them
                                let myReceivedNotifs = allNotifs.filter(n =>
                                    n.sender_name !== teacher.name && (
                                        n.target_audience === 'TEACHER:' + teacher.id ||
                                        n.target_audience === 'ALL_TEACHERS' ||
                                        n.target_audience === 'ALL' ||
                                        n.target_audience === 'ADMIN'
                                    )
                                );

                                let classOptions = assignedClasses.map(cls => `<option value="${cls}" ${cls === selectedClass ? 'selected' : ''}>${cls}</option>`).join('');
                                let courseOptions = classCourses.length > 0
                                    ? classCourses.map(c => `<option value="${c.id}" ${c.id.toString() === selectedCourseId ? 'selected' : ''}>${c.title} (${c.code})</option>`).join('')
                                    : `<option value="default">${teacher.subject || 'General Course'} (${activeCourseCode})</option>`;

                                let teacherTargetOptions = `
                                    <option value="ADMIN">👑 ለትምህርት ቤቱ አድሚን / ዲሬክተር (To Admin)</option>
                                    <option value="ALL_MY_CLASSES">🏫 ለሁሉም የምመራቸው ክፍሎች (All My Classes)</option>
                                    <optgroup label="📂 በየክፍሉ / Individual Classes">
                                        ${assignedClasses.map(c => `<option value="${c}" ${c === selectedClass ? 'selected' : ''}>🏫 ክፍል: ${c}</option>`).join('')}
                                    </optgroup>
                                    <optgroup label="👨‍🎓 ለተመረጠ ተማሪ ብቻ / Individual Students (${selectedClass})">
                                        ${studentsInClass.map(st => `<option value="STUDENT:${st.student_id}">👤 ${st.name} (${st.student_id})</option>`).join('')}
                                    </optgroup>
                                `;

                                let studentRows = studentsInClass.map((st, idx) => {
                                    let asm = assessments.find(a => a.student_id === st.student_id) || {};
                                    return `<tr>
                                        <td>${idx + 1}</td>
                                        <td><b>${st.student_id}</b></td>
                                        <td style="text-align:left;">${st.name}</td>
                                        <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="100" name="quiz" value="${asm.quiz !== undefined && asm.quiz !== null ? asm.quiz : 0}" style="width:60px; text-align:center;"></td>
                                        <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="100" name="assignment" value="${asm.assignment !== undefined && asm.assignment !== null ? asm.assignment : 0}" style="width:60px; text-align:center;"></td>
                                        <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="100" name="project" value="${asm.project !== undefined && asm.project !== null ? asm.project : 0}" style="width:60px; text-align:center;"></td>
                                        <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="100" name="mid" value="${asm.mid !== undefined && asm.mid !== null ? asm.mid : 0}" style="width:60px; text-align:center;"></td>
                                        <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="100" name="final" value="${asm.final !== undefined && asm.final !== null ? asm.final : 0}" style="width:60px; text-align:center;"></td>
                                        <td>
                                            <form id="form_${st.student_id}" class="ajax-grade-form" action="/teacher/save-grade?course_id=${encodeURIComponent(selectedCourseId || 'default')}&cls=${encodeURIComponent(selectedClass)}" method="POST">
                                                <input type="hidden" name="student_id" value="${st.student_id}">
                                                <input type="hidden" name="course_id" value="${selectedCourseId || 'default'}">
                                                <button type="submit" style="background:#27ae60; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold;">💾 Save</button>
                                            </form>
                                        </td>
                                    </tr>`;
                                }).join('');

                                let absRows = classAbsences.map(ab => {
                                    const fb = (ab.teacher_feedback || '').trim();
                                    let feedbackCell;
                                    if (fb) {
                                        feedbackCell = `<span style="color:#27ae60;font-weight:bold;">${fb.replace(/</g,'&lt;')}</span>`;
                                    } else {
                                        feedbackCell = `<form action="/teacher/absence-feedback" method="POST" style="display:flex;flex-direction:column;gap:6px;min-width:160px;">
                                                <input type="hidden" name="id" value="${ab.id}">
                                                <input type="hidden" name="cls" value="${selectedClass || ''}">
                                                <textarea name="feedback" rows="2" required placeholder="Reply / Feedback..." style="width:100%;padding:6px;border:1px solid #ccc;border-radius:6px;font-size:12px;"></textarea>
                                                <button type="submit" style="background:#27ae60;color:#fff;border:none;padding:6px 10px;border-radius:6px;font-weight:bold;cursor:pointer;font-size:12px;">💬 Reply</button>
                                            </form>`;
                                    }
                                    const delBtn = `<form action="/teacher/delete-absence" method="POST" style="margin-top:6px;" onsubmit="return confirm('Delete this request?');">
                                            <input type="hidden" name="id" value="${ab.id}">
                                            <input type="hidden" name="cls" value="${selectedClass || ''}">
                                            <button type="submit" style="background:#e74c3c;color:#fff;border:none;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">🗑️ Delete</button>
                                        </form>`;
                                    return `<tr>
                                        <td style="text-align:left;">${ab.student_name || ''}</td>
                                        <td>${ab.date || ab.created_at || ''}</td>
                                        <td style="text-align:left;">${ab.reason || ''}${ab.attachment ? `<br><a href="/uploads/${ab.attachment}" target="_blank">📎</a>` : ''}</td>
                                        <td>${feedbackCell}${delBtn}</td>
                                    </tr>`;
                                }).join('');
                                
                                let teacherNotiRows = '';
                                // Received first (with Reply)
                                teacherNotiRows += myReceivedNotifs.map(n => {
                                    const replyTarget = n.sender_role === 'Student' ? ('STUDENT:' + (n.sender_id || '')) : (n.sender_role === 'Admin' ? 'ADMIN' : 'ADMIN');
                                    return `<div style="background:#eef9ff; padding:15px; margin-bottom:12px; border-radius:8px; border-left:4px solid #2980b9;">
                                        <strong>📥 ከ: ${n.sender_name} (${n.sender_role||''}) | ${n.created_at||''}</strong>
                                        <div style="margin-top:8px; background:white; padding:10px; border-radius:6px; border:1px solid #ddd;">${n.message}</div>
                                        ${n.attachment ? `<div style="margin-top:6px;"><a href="/uploads/${n.attachment}" target="_blank" style="color:#2980b9;font-weight:bold;">📎 File</a></div>` : ''}
                                        <div style="margin-top:10px;">
                                            <button type="button" onclick="document.getElementById('tReply_${n.id}').style.display='block'" style="background:#2980b9;color:white;border:none;padding:5px 12px;border-radius:4px;font-weight:bold;font-size:12px;cursor:pointer;">💬 Reply</button>
                                        </div>
                                        <form id="tReply_${n.id}" action="/teacher/send-notification?cls=${encodeURIComponent(selectedClass)}" method="POST" style="display:none;margin-top:10px;background:#f0f9ff;padding:12px;border-radius:6px;">
                                            <input type="hidden" name="target_audience" value="${replyTarget || 'ADMIN'}">
                                            <textarea name="message" rows="2" required placeholder="Reply..." style="width:100%;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:4px;"></textarea>
                                            <button type="submit" style="background:#27ae60;color:white;border:none;padding:6px 14px;border-radius:4px;font-weight:bold;">📤 Send</button>
                                            <button type="button" onclick="document.getElementById('tReply_${n.id}').style.display='none'" style="background:#7f8c8d;color:white;border:none;padding:6px 12px;border-radius:4px;margin-left:5px;">Cancel</button>
                                        </form>
                                    </div>`;
                                }).join('');
                                // Sent (edit/delete own)
                                teacherNotiRows += mySentNotifs.map(n => `
                                    <div style="background:#fdf2e9; padding:15px; margin-bottom:12px; border-radius:8px; border:1px solid #e67e22;">
                                        <strong>📤 ለ: <span style="color:#2980b9;">${n.target_audience}</span> | ቀን: ${n.created_at || ''}</strong>
                                        <div style="margin-top:8px; background:white; padding:10px; border-radius:6px; border:1px solid #ddd;">${n.message}</div>
                                        ${n.attachment ? `<div style="margin-top:6px;"><a href="/uploads/${n.attachment}" target="_blank" style="color:#2980b9; font-weight:bold;">📎 የተያያዘ ፋይል ክፈት</a></div>` : ''}
                                        <div style="margin-top:10px; display:flex; gap:8px;">
                                            <button type="button" onclick="document.getElementById('tEditNotif_${n.id}').style.display='block'" style="background:#f39c12; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:12px;">✏️ Edit</button>
                                            <a href="/delete-notification/${n.id}" onclick="return confirm('ይህ ማስታወቂያ ይጠፋ?')" style="background:#e74c3c; color:white; padding:5px 12px; border-radius:4px; text-decoration:none; font-weight:bold; font-size:12px;">🗑️ Delete</a>
                                        </div>
                                        <form id="tEditNotif_${n.id}" action="/edit-notification/${n.id}" method="POST" enctype="multipart/form-data" style="display:none; margin-top:12px; background:white; padding:12px; border-radius:6px; border:1px solid #ccc;">
                                            <textarea name="message" rows="3" style="width:100%; padding:8px; margin-bottom:8px;">${n.message}</textarea>
                                            <input type="file" name="attachment" style="margin-bottom:8px;">
                                            <button type="submit" style="background:#27ae60; color:white; padding:6px 14px; border:none; border-radius:4px; font-weight:bold;">💾 Save</button>
                                            <button type="button" onclick="document.getElementById('tEditNotif_${n.id}').style.display='none'" style="background:#7f8c8d; color:white; padding:6px 12px; border:none; border-radius:4px; margin-left:5px;">Cancel</button>
                                        </form>
                                    </div>
                                `).join('');

                                let proctorPanel = isProctor ? `<div class="card" style="background:#f9fcf7; border:1px solid #27ae60;"><h3>🟢 የፕሮክተር ፓነል</h3><a href="/attendance-sheet/${encodeURIComponent(selectedClass)}" target="_blank" style="background:#16a085; color:white; padding:8px 15px; border-radius:5px; text-decoration:none; font-weight:bold; display:inline-block;">📋 Attendance Sheet</a></div>` : '';

                                // Students for teacher search (only from assigned classes)
                                const teacherStudentsJson = JSON.stringify(
                                    studentsInClass.map(s => ({ id: s.student_id, name: s.name }))
                                );

                                res.render('teacher', {
                                    lang: 'am', teacher, selectedClass, selectedCourseId: selectedCourseId || 'default',
                                    classOptions, courseOptions, teacherTargetOptions, studentRows, absRows, teacherNotiRows, proctorPanel,
                                    teacherStudentsJson
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
    let returnClass = req.query.cls || '';
    let chosenTarget = req.body.target_audience || returnClass || 'ALL';
    let msg = sanitizeRichText(req.body.message);
    let file = req.file ? req.file.filename : null;
    let nowStr = getFormattedTimestamp();

    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        if (!teacher) return res.redirect('/');
        if (chosenTarget === 'ALL_MY_CLASSES' && teacher.assigned_sections) {
            const secs = teacher.assigned_sections.split(',').map(s => s.trim()).filter(Boolean);
            secs.forEach(sec => {
                db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at, attachment) VALUES (?,?,?,?,?,?)`,
                    ['Teacher', teacher.name, sec, msg, nowStr, file]);
            });
            return res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(returnClass)}#notifications`);
        } else {
            db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at, attachment) VALUES (?,?,?,?,?,?)`,
                ['Teacher', teacher.name, chosenTarget, msg, nowStr, file],
                () => res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(returnClass)}#notifications`));
        }
    });
});



app.post('/teacher/delete-absence', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const id = req.body.id;
    const cls = req.body.cls || '';
    db.run(`DELETE FROM absence_requests WHERE id = ?`, [id], () => {
        res.redirect(cls ? `/teacher-dashboard?cls=${encodeURIComponent(cls)}` : '/teacher-dashboard');
    });
});

app.post('/teacher/absence-feedback', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const id = req.body.id;
    const feedback = xss(String(req.body.feedback || '').trim());
    const cls = req.body.cls || '';
    if (!id || !feedback) {
        return res.redirect(cls ? `/teacher-dashboard?cls=${encodeURIComponent(cls)}` : '/teacher-dashboard');
    }
    db.run(`UPDATE absence_requests SET teacher_feedback = ?, status = ? WHERE id = ?`,
        [feedback, 'Replied', id],
        () => {
            try { logActivity('Teacher', String(req.session.teacherId), 'ABSENCE_FEEDBACK', 'id=' + id); } catch(e) {}
            res.redirect(cls ? `/teacher-dashboard?cls=${encodeURIComponent(cls)}` : '/teacher-dashboard');
        });
});

app.post('/teacher/save-grade', (req, res) => {
    if (!req.session.teacherId) return res.json({ error: 'Unauthorized' });
    let courseId = req.body.course_id || req.query.course_id || '';
    let selectedCls = req.query.cls || '';
    let { student_id, quiz, mid, final, assignment, project } = req.body;
    
    // Teacher can set any marks they want (0–100 each)
    let q = Math.min(100, Math.max(0, parseFloat(quiz) || 0));
    let a = Math.min(100, Math.max(0, parseFloat(assignment) || 0));
    let p = Math.min(100, Math.max(0, parseFloat(project) || 0));
    let m = Math.min(100, Math.max(0, parseFloat(mid) || 0));
    let f = Math.min(100, Math.max(0, parseFloat(final) || 0));
    let total = Number((q + a + p + m + f).toFixed(2));

    const saveAssessmentRecord = (code, title) => {
        db.get(`SELECT id FROM course_assessments WHERE student_id = ? AND course_code = ?`, [student_id, code], (err, row) => {
            if (row) {
                db.run(`UPDATE course_assessments SET teacher_id=?, quiz=?, assignment=?, project=?, mid=?, final=?, total=?, remark=? WHERE id=?`, 
                [req.session.teacherId, q, a, p, m, f, total, total >= 50 ? 'Pass' : 'Fail', row.id], () => res.json({ success: true, total: total }));
            } else {
                db.run(`INSERT INTO course_assessments (student_id, teacher_id, course_code, course_title, quiz, assignment, project, mid, final, total, remark) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [student_id, req.session.teacherId, code, title, q, a, p, m, f, total, total >= 50 ? 'Pass' : 'Fail'], () => res.json({ success: true, total: total }));
            }
        });
    };

    if (courseId && courseId !== 'default' && !isNaN(Number(courseId))) {
        db.get(`SELECT * FROM courses WHERE id = ?`, [courseId], (err, course) => {
            if (course) return saveAssessmentRecord(course.code, course.title);
            fallbackFindCourse();
        });
    } else {
        fallbackFindCourse();
    }

    function fallbackFindCourse() {
        db.all(`SELECT * FROM courses`, [], (err, allCourses = []) => {
            let match = allCourses.find(c => c.teacher_id === req.session.teacherId && (!selectedCls || isClassMatch(c.class_level, selectedCls)));
            if (!match && selectedCls) match = allCourses.find(c => isClassMatch(c.class_level, selectedCls));
            if (!match) match = allCourses.find(c => c.teacher_id === req.session.teacherId);

            if (match) {
                return saveAssessmentRecord(match.code, match.title);
            }

            db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err2, t) => {
                const subjTitle = (t && t.subject) ? t.subject : 'General Subject';
                const subjCode = subjTitle.substring(0, 3).toUpperCase() + '-01';
                db.get(`SELECT class_level FROM students WHERE student_id = ?`, [student_id], (err3, st) => {
                    const clsName = selectedCls || (st ? st.class_level : 'Grade 1 - Section A');
                    db.run(`INSERT INTO courses (code, title, credit_hours, teacher_id, teacher_name, class_level) VALUES (?,?,?,?,?,?)`,
                        [subjCode, subjTitle, 0, req.session.teacherId, t ? t.name : '', clsName], () => {
                            saveAssessmentRecord(subjCode, subjTitle);
                        });
                });
            });
        });
    }
});

app.post('/teacher/submit-final-grades', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const { class_level, course_id, academic_year } = req.body;
    const yearStr = (academic_year || '2019 E.C').trim();

    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        if (!teacher) return res.redirect('/teacher-dashboard');
        db.all(`SELECT * FROM courses`, [], (err2, allCourses = []) => {
            let course = allCourses.find(c => String(c.id) === String(course_id));
            if (!course) course = allCourses.find(c => c.teacher_id === teacher.id && isClassMatch(c.class_level, class_level));
            if (!course) course = allCourses.find(c => isClassMatch(c.class_level, class_level));

            const cId = course ? String(course.id) : '0';
            const cCode = course ? course.code : ((teacher.subject || 'GEN').substring(0, 3).toUpperCase() + '-01');
            const cTitle = course ? course.title : (teacher.subject || 'General Course');
            const nowStr = new Date().toLocaleDateString('en-GB');

            pool.query(
                `INSERT INTO grade_submissions (academic_year, class_level, course_id, course_code, course_title, teacher_id, teacher_name, submitted_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (academic_year, class_level, course_code)
                 DO UPDATE SET teacher_id = EXCLUDED.teacher_id, teacher_name = EXCLUDED.teacher_name, submitted_at = EXCLUDED.submitted_at`,
                [yearStr, class_level, cId, cCode, cTitle, teacher.id, teacher.name, nowStr]
            ).then(() => {
                res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(class_level)}&course_id=${course_id}&submitted=1`);
            }).catch(e => {
                res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(class_level)}&course_id=${course_id}`);
            });
        });
    });
});

app.get('/attendance-sheet/:secName', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    let sec = decodeURIComponent(req.params.secName);
    let selectedDate = req.query.date || new Date().toISOString().split('T')[0];
    let savedAlert = req.query.saved ? `<div style="background:#d4edda; color:#155724; padding:12px; border-radius:6px; margin-bottom:15px; font-weight:bold; text-align:center;">✅ የ ${selectedDate} አቴንዳንስ በተሳካ ሁኔታ ተቀምጧል! (Attendance Saved Successfully!)</div>` : '';

    db.all(`SELECT student_id, name, gender, class_level FROM students ORDER BY name ASC`, [], (err, allStudents = []) => {
        let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, sec));
        db.all(`SELECT * FROM daily_attendance WHERE class_level = ? AND date = ?`, [sec, selectedDate], (err, records = []) => {
            let attendanceMap = {}; records.forEach(r => { attendanceMap[r.student_id] = r.status; });
            let rowsHtml = '';
            studentsInClass.forEach((st, i) => {
                const stStatus = attendanceMap[st.student_id] || 'Present';
                rowsHtml += `<tr>
                    <td><b>${i+1}</b></td>
                    <td><b>${st.student_id}</b></td>
                    <td style="text-align:left; font-weight:bold;">${st.name}</td>
                    <td>${st.gender || '-'}</td>
                    <td>
                        <label style="color:#27ae60; font-weight:bold; cursor:pointer; margin-right:15px;">
                            <input type="radio" name="status_${st.student_id}" value="Present" ${stStatus==='Present'?'checked':''}> ✅ Present (ተገኝቷል)
                        </label>
                        <label style="color:#e74c3c; font-weight:bold; cursor:pointer;">
                            <input type="radio" name="status_${st.student_id}" value="Absent" ${stStatus==='Absent'?'checked':''}> ❌ Absent (ቀርቷል)
                        </label>
                    </td>
                </tr>`;
            });

            if (!rowsHtml) {
                rowsHtml = `<tr><td colspan="5" style="padding:20px; color:#777;">በዚህ ክፍል የተመዘገበ ተማሪ የለም።</td></tr>`;
            }

            res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Attendance - ${sec}</title>
    <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        body { font-family: 'Segoe UI', sans-serif; background: #eef2f5; padding: 25px; margin: 0; }
        .box { max-width: 900px; margin: auto; background: white; padding: 25px; border-radius: 12px; box-shadow: 0 5px 20px rgba(0,0,0,0.08); border-top: 6px solid #16a085; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: center; font-size: 14px; }
        th { background: #1f4e79 !important; color: white !important; }
        tr:nth-child(even) { background: #f8fafc !important; }
    </style>
</head>
<body>
    <div class="box">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
            <h2 style="margin:0; color:#1f4e79;">📋 የዕለት አቴንዳንስ መቆጣጠሪያ (${sec})</h2>
            <form method="GET" action="/attendance-sheet/${encodeURIComponent(sec)}" style="display:flex; gap:8px; align-items:center;">
                <label style="font-weight:bold;">📅 ቀን:</label>
                <input type="date" name="date" value="${selectedDate}" onchange="this.form.submit()" style="padding:7px; border:1px solid #ccc; border-radius:5px;">
            </form>
        </div>
        ${savedAlert}
        <form action="/save-attendance" method="POST">
            <input type="hidden" name="class_level" value="${sec}">
            <input type="hidden" name="date" value="${selectedDate}">
            <table>
                <tr><th>#</th><th>መታወቂያ (ID)</th><th>የተማሪ ስም (Name)</th><th>ፆታ</th><th>ሁኔታ (Status)</th></tr>
                ${rowsHtml}
            </table>
            <button type="submit" style="width:100%; margin-top:20px; padding:14px; background:#27ae60; color:white; border:none; border-radius:8px; font-weight:bold; font-size:16px; cursor:pointer;">
                💾 የዛሬውን አቴንዳንስ አስቀምጥ (Save Attendance)
            </button>
        </form>
    </div>
</body>
</html>`);
        });
    });
});

app.post('/save-attendance', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    const { class_level, date } = req.body;
    const attDate = date || new Date().toISOString().split('T')[0];

    db.all(`SELECT student_id, name, class_level FROM students`, [], (err, allStudents = []) => {
        const studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, class_level));
        db.run(`DELETE FROM daily_attendance WHERE class_level = ? AND date = ?`, [class_level, attDate], () => {
            studentsInClass.forEach(st => {
                const statusVal = req.body[`status_${st.student_id}`];
                if (statusVal) {
                    db.run(`INSERT INTO daily_attendance (student_id, student_name, class_level, date, status) VALUES (?, ?, ?, ?, ?)`,
                        [st.student_id, st.name, class_level, attDate, statusVal]);
                }
            });
            res.redirect(`/attendance-sheet/${encodeURIComponent(class_level)}?date=${encodeURIComponent(attDate)}&saved=1`);
        });
    });
});

app.get('/student-dashboard', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT s.* FROM students s WHERE s.student_id = ?', [req.session.studentId], (err, student) => {
        if (!student) return res.redirect('/');
        db.all('SELECT * FROM courses ORDER BY id', [], (err, allCourses = []) => {
            let myCourses = allCourses.filter(c => isClassMatch(c.class_level, student.class_level));
            db.all('SELECT * FROM course_assessments WHERE student_id = ?', [student.student_id], (err, myGrades = []) => {
                db.all('SELECT * FROM notifications ORDER BY id DESC', [], (err, allNotifs = []) => {
                    let myNotifs = allNotifs.filter(n => {
                        if (n.target_audience === 'ALL' || n.target_audience === 'ALL_STUDENTS') return true;
                        if (n.target_audience === 'STUDENT:' + student.student_id) return true;
                        if (isClassMatch(n.target_audience, student.class_level)) return true;
                        if (n.target_audience && n.target_audience.startsWith('GRADE:')) {
                            const gradeNum = n.target_audience.replace('GRADE:', '').trim();
                            const stClass = (student.class_level || '').toString();
                            return stClass.includes(`Grade ${gradeNum}`) || stClass.match(new RegExp(`\\b${gradeNum}\\b`));
                        }
                        return false;
                    });

                    db.all('SELECT * FROM absence_requests WHERE student_id = ? ORDER BY id DESC', [student.student_id], (err, myAbsences = []) => {
                        db.all('SELECT * FROM sections', [], (errSec, allSections = []) => {
                            db.all('SELECT * FROM teachers', [], (errT, allTeachers = []) => {

                                // Proctor for this student's class
                                const mySection = allSections.find(sec => isClassMatch(sec.name, student.class_level));
                                const proctorName = mySection ? (mySection.proctor_name || 'N/A') : 'N/A';
                                const proctorPhone = mySection ? (mySection.proctor_phone || '') : '';

                                // Teachers who teach this student's class
                                const myTeachers = allTeachers.filter(t => {
                                    const secs = (t.assigned_sections || '').split(',').map(s => s.trim());
                                    return secs.some(s => isClassMatch(s, student.class_level));
                                });

                                // Message target options for student
                                let studentMsgOptions = `<option value="ADMIN">👑 ለአድሚን / ዲሬክተር (To Admin)</option>`;
                                if (mySection && mySection.proctor_name) {
                                    // Find proctor teacher id if possible
                                    const proctorTeacher = allTeachers.find(t => t.name === mySection.proctor_name);
                                    if (proctorTeacher) {
                                        studentMsgOptions += `<option value="TEACHER:${proctorTeacher.id}">🛡️ ተቆጣጣሪ (Proctor): ${mySection.proctor_name}</option>`;
                                    } else {
                                        studentMsgOptions += `<option value="PROCTOR:${student.class_level}">🛡️ ተቆጣጣሪ (Proctor): ${mySection.proctor_name}</option>`;
                                    }
                                }
                                myTeachers.forEach(t => {
                                    studentMsgOptions += `<option value="TEACHER:${t.id}">👩‍🏫 መምህር: ${t.name}${t.subject ? ' (' + t.subject + ')' : ''}</option>`;
                                });

                                let notiRows = myNotifs.map(n => `
                                    <div style="background:#fff; padding:15px; margin-bottom:12px; border-radius:8px; border-left:4px solid #3498db; box-shadow:0 2px 4px rgba(0,0,0,0.05);">
                                        <strong style="color:#2c3e50; font-size:15px;">🔔 ${n.sender_name} (${n.created_at || ''})</strong>
                                        <div style="margin-top:8px; color:#445; font-size:14px;">${n.message}</div>
                                        ${n.attachment ? `<div style="margin-top:10px;"><a href="/uploads/${n.attachment}" target="_blank" style="background:#e8f4fd; color:#2980b9; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px; font-weight:bold;">📎 ፋይል ክፈት</a></div>` : ''}
                                        <div style="margin-top:10px;">
                                            <button type="button" onclick="document.getElementById('sReply_${n.id}').style.display='block'" style="background:#2980b9; color:white; border:none; padding:5px 12px; border-radius:4px; font-weight:bold; font-size:12px; cursor:pointer;">💬 Reply / መልስ ስጥ</button>
                                        </div>
                                        <form id="sReply_${n.id}" action="/admin/send-notification" method="POST" enctype="multipart/form-data" style="display:none; margin-top:10px; background:#f0f9ff; padding:12px; border-radius:6px; border:1px solid #bae6fd;">
                                            <input type="hidden" name="target_audience" value="ADMIN">
                                            <textarea name="message" rows="2" placeholder="መልስ ይጻፉ..." style="width:100%; padding:6px; margin-bottom:8px; border:1px solid #ccc; border-radius:4px;" required></textarea>
                                            <button type="submit" style="background:#27ae60; color:white; border:none; padding:5px 14px; border-radius:4px; font-weight:bold;">📤 ላክ</button>
                                            <button type="button" onclick="document.getElementById('sReply_${n.id}').style.display='none'" style="background:#7f8c8d; color:white; border:none; padding:5px 10px; border-radius:4px; margin-left:5px;">Cancel</button>
                                        </form>
                                    </div>
                                `).join('');

                                let myAbsRows = myAbsences.map(ab => `<div style="background:#fdfdfd; padding:12px; margin-bottom:10px; border-radius:6px; border:1px solid #eee; border-left:4px solid ${ab.teacher_feedback ? '#27ae60' : '#f39c12'};"><strong>ቀን:</strong> ${ab.date || ab.created_at || 'N/A'}<br><strong>ምክንያት:</strong> ${ab.reason}<br><strong style="color: ${ab.teacher_feedback ? '#27ae60' : '#d35400'};">መልስ:</strong> ${ab.teacher_feedback || 'በመጠበቅ ላይ'}</div>`).join('');
                                let gradesHtml = myCourses.map(c => {
                                    let asm = myGrades.find(a => a.course_code === c.code) || {};
                                    let total = (asm.quiz || 0) + (asm.assignment || 0) + (asm.project || 0) + (asm.mid || 0) + (asm.final || 0);
                                    let gradeLetter = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 75 ? 'B+' : total >= 60 ? 'B' : total >= 50 ? 'C' : 'F';
                                    return `<tr>
                                        <td>${c.code}</td>
                                        <td style="text-align:left;"><b>${c.title}</b></td>
                                        <td style="font-size:13px;">${c.teacher_name || '-'}</td>
                                        <td>${asm.quiz || 0}</td>
                                        <td>${asm.assignment || 0}</td>
                                        <td>${asm.project || 0}</td>
                                        <td>${asm.mid || 0}</td>
                                        <td>${asm.final || 0}</td>
                                        <td><b>${total}</b></td>
                                        <td><b>${gradeLetter}</b></td>
                                    </tr>`;
                                }).join('');

                                res.render('student', {
                                    lang: 'am', student, gradesHtml, notiRows, myAbsRows,
                                    proctorName, proctorPhone, studentMsgOptions
                                });
                            });
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
        db.run('UPDATE students SET photo = ? WHERE student_id = ?', [req.file.filename, req.session.studentId], () => res.redirect('/student-dashboard#notifications'));
    } else {
        res.redirect('/student-dashboard');
    }
});

app.post('/student/absence', upload.single('attachment'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT name, class_level FROM students WHERE student_id=?', [req.session.studentId], (err, st) => {
        if(st) {
            db.run(`INSERT INTO absence_requests (student_id, student_name, class_level, reason, teacher_feedback, status, created_at, attachment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            [req.session.studentId, st.name, st.class_level, xss(req.body.reason), '', 'Pending', new Date().toLocaleString(), req.file ? req.file.filename : null], () => res.redirect('/student-dashboard#notifications'));
        }
    });
});

app.get('/api/admin/roster-summary', (req, res) => {
    if (!req.session.isAdmin) return res.json({ submissions: [], years: [], sections: [] });
    db.all(`SELECT * FROM grade_submissions ORDER BY academic_year DESC, class_level ASC`, [], (err, submissions = []) => {
        db.all(`SELECT * FROM sections ORDER BY name ASC`, [], (err2, sections = []) => {
            let years = [...new Set(submissions.map(s => s.academic_year))];
            if (!years.includes('2019 E.C')) years.unshift('2019 E.C');
            res.json({ submissions, years, sections });
        });
    });
});

app.get('/admin/student-report-card', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    // support ?name= as well as student_id
    let studentId = (req.query.student_id || '').trim().toUpperCase();
    const studentName = (req.query.name || '').trim();
    const academicYear = (req.query.year || '2019 E.C').trim();

    if (!studentId && !studentName) return res.send('<h3 style="text-align:center;color:red;margin-top:40px;">ID ወይም ስም ያስገቡ!</h3>');

    const runWithStudent = (student) => {
        if (!student) {
            return res.send(`<div style="font-family:sans-serif;text-align:center;padding:50px;">
                <h2 style="color:#e74c3c;">❌ ተማሪው አልተገኘም!</h2>
                <a href="/admin" style="background:#2980b9;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">⬅️ ወደ አድሚን ተመለስ</a>
            </div>`);
        }

        db.all(`SELECT * FROM students`, [], (err2, allStudents = []) => {
            const classmates = allStudents.filter(s => isClassMatch(s.class_level, student.class_level));
            db.all(`SELECT * FROM courses`, [], (err3, allCourses = []) => {
                const classCourses = allCourses.filter(c => isClassMatch(c.class_level, student.class_level));
                db.all(`SELECT * FROM course_assessments`, [], (err4, allAssessments = []) => {

                    const totalsMap = {};
                    classmates.forEach(cm => {
                        let sum = 0;
                        classCourses.forEach(c => {
                            const a = allAssessments.find(x => x.student_id === cm.student_id && x.course_code === c.code);
                            if (a) sum += (parseFloat(a.total) || 0);
                        });
                        totalsMap[cm.student_id] = sum;
                    });
                    const sortedTotals = Object.values(totalsMap).sort((a, b) => b - a);
                    const myGrandTotal = Number((totalsMap[student.student_id] || 0).toFixed(2));
                    const myRank = sortedTotals.indexOf(myGrandTotal) + 1;
                    const myAvg = classCourses.length > 0 ? (myGrandTotal / classCourses.length).toFixed(2) : '0.00';

                    let courseRowsHtml = classCourses.map((c, i) => {
                        const a = allAssessments.find(x => x.student_id === student.student_id && x.course_code === c.code) || {};
                        const q = a.quiz !== undefined ? a.quiz : '-';
                        const m = a.mid !== undefined ? a.mid : '-';
                        const f = a.final !== undefined ? a.final : '-';
                        const tot = a.total !== undefined ? a.total : 0;
                        const grade = tot >= 90 ? 'A+' : tot >= 85 ? 'A' : tot >= 80 ? 'A-' : tot >= 75 ? 'B+' : tot >= 70 ? 'B' : tot >= 60 ? 'C' : tot >= 50 ? 'D' : 'F';
                        const status = tot >= 50 ? '<span style="color:#27ae60 !important;font-weight:bold;">Pass<br>(አልፏል)</span>' : '<span style="color:#e74c3c !important;font-weight:bold;">Fail<br>(ወድቋል)</span>';
                        return `<tr>
                            <td>${i + 1}</td>
                            <td><b>${c.code}</b></td>
                            <td style="text-align:left;"><b>${c.title}</b></td>
                            <td>${c.teacher_name || '-'}</td>
                            <td>${q}</td>
                            <td>${m}</td>
                            <td>${f}</td>
                            <td style="font-weight:bold;font-size:15px;color:#1f4e79 !important;">${tot}</td>
                            <td><b>${grade}</b></td>
                            <td>${status}</td>
                        </tr>`;
                    }).join('') || `<tr><td colspan="10">ለዚህ ክፍል የተመዘገበ ትምህርት የለም።</td></tr>`;

                    res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <title>Student Report Card - ${student.name}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #eef2f5; margin: 0; padding: 20px; color: #1e293b; }
        .no-print { text-align: center; margin-bottom: 18px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
        .btn { padding: 11px 22px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; text-decoration: none; font-size: 14px; display: inline-block; box-shadow: 0 4px 10px rgba(0,0,0,0.12); }
        .card-page { max-width: 850px; margin: auto; background: #ffffff !important; padding: 35px 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.12); border: 3px double #1f4e79; box-sizing: border-box; }
        .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #1f4e79; padding-bottom: 15px; margin-bottom: 20px; }
        .header img { width: 80px; height: 80px; border-radius: 50%; border: 2.5px solid #f39c12; object-fit: cover; }
        .header-center { text-align: center; flex: 1; }
        .header-center h1 { margin: 0; font-size: 23px; color: #1f4e79 !important; }
        .header-center h3 { margin: 5px 0 0; font-size: 15px; color: #d35400 !important; }
        .badge-title { margin-top: 6px; display: inline-block; background: #1f4e79 !important; color: #ffffff !important; padding: 5px 18px; border-radius: 15px; font-size: 13px; font-weight: bold; }
        .student-bio { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: #f8fafc !important; padding: 15px; border-radius: 8px; border: 1px solid #cbd5e1; margin-bottom: 20px; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13.5px; }
        th, td { border: 1px solid #94a3b8; padding: 9px 8px; text-align: center; }
        th { background: #1f4e79 !important; color: #ffffff !important; font-weight: bold; }
        tr:nth-child(even) td { background: #f8fafc !important; }
        .summary-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 25px; }
        .sum-box { background: #f1f5f9 !important; border-left: 5px solid #1f4e79; padding: 12px; border-radius: 6px; text-align: center; }
        .sum-box .val { font-size: 20px; font-weight: 800; color: #1f4e79 !important; }
        .sum-box .lbl { font-size: 12px; color: #475569 !important; font-weight: bold; }
        .sig-section { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 45px; padding-top: 15px; text-align: center; font-size: 13.5px; font-weight: bold; }
        .sig-line { border-top: 1.5px solid #1e293b; margin-top: 35px; padding-top: 6px; }
        @media print {
            @page { size: A4 portrait; margin: 8mm; }
            body { background: white !important; padding: 0; }
            .no-print { display: none !important; }
            .card-page { box-shadow: none; width: 100%; max-width: 100%; padding: 20px; }
        }
    </style>
</head>
<body>
    <div class="no-print">
        <button onclick="downloadColorPDF()" class="btn" style="background:#27ae60;">📥 በኦሪጅናል ከለር Download PDF (Full Color)</button>
        <button onclick="window.print()" class="btn" style="background:#2980b9;">🖨️ ፕሪንት አድርግ (Print Color PDF)</button>
        <a href="/admin" class="btn" style="background:#7f8c8d;">⬅️ ወደ አድሚን ተመለስ</a>
    </div>

    <div id="reportCardArea" class="card-page">
        <div class="header">
            <img src="/uploads/logo.jpg" onerror="this.src='/uploads/logo.png'" alt="Logo" crossorigin="anonymous">
            <div class="header-center">
                <h1>AMANUEL LIGHT AND LIFE SCHOOL</h1>
                <h3>አማኑኤል ብርሃንና ሕይወት ትምህርት ቤት</h3>
                <div class="badge-title">
                    OFFICIAL STUDENT GRADE REPORT CARD (${academicYear})
                </div>
            </div>
            <img src="/uploads/${student.photo || 'logo.jpg'}" onerror="this.src='/uploads/logo.jpg'" alt="Student" crossorigin="anonymous">
        </div>

        <div class="student-bio">
            <div><b>👤 የተማሪ ስም (Name):</b> ${student.name}</div>
            <div><b>🆔 መታወቂያ (ID):</b> <span style="color:#2980b9 !important;font-weight:bold;">${student.student_id}</span></div>
            <div><b>⚧ ፆታ (Gender):</b> ${student.gender || '-'}</div>
            <div><b>🏫 ክፍል (Class):</b> ${student.class_level}</div>
            <div><b>📅 ዓመተ ምህረት (Year):</b> ${academicYear}</div>
            <div><b>📞 ስልክ (Phone):</b> ${student.phone || '-'}</div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>ኮድ<br>(Code)</th>
                    <th>የትምህርት ዓይነት<br>(Course Title)</th>
                    <th>መምህር<br>(Teacher)</th>
                    <th>Quiz<br>(20%)</th>
                    <th>Mid<br>(30%)</th>
                    <th>Final<br>(50%)</th>
                    <th>Total<br>(100%)</th>
                    <th>Grade</th>
                    <th>ውጤት<br>(Status)</th>
                </tr>
            </thead>
            <tbody>
                ${courseRowsHtml}
            </tbody>
        </table>

        <div class="summary-row">
            <div class="sum-box">
                <div class="val">${myGrandTotal}</div>
                <div class="lbl">ጠቅላላ ድምር (Grand Total)</div>
            </div>
            <div class="sum-box" style="border-left-color:#2980b9;">
                <div class="val">${myAvg}%</div>
                <div class="lbl">አማካይ ውጤት (Average)</div>
            </div>
            <div class="sum-box" style="border-left-color:#f39c12;">
                <div class="val">${myRank} / ${classmates.length}</div>
                <div class="lbl">ደረጃ (Class Rank)</div>
            </div>
            <div class="sum-box" style="border-left-color:#27ae60;">
                <div class="val" style="color:${parseFloat(myAvg) >= 50 ? '#27ae60' : '#e74c3c'} !important;">${parseFloat(myAvg) >= 50 ? 'Promoted' : 'Failed'}</div>
                <div class="lbl">የዓመቱ ውሳኔ (Final Remark)</div>
            </div>
        </div>

        <div class="sig-section">
            <div><div class="sig-line">የክፍል ተቆጣጣሪ መምህር ፊርማ<br><span style="font-size:11px;font-weight:normal;">Homeroom Teacher's Signature</span></div></div>
            <div><div class="sig-line">የትምህርት ቤቱ ማህተም<br><span style="font-size:11px;font-weight:normal;">Official School Stamp</span></div></div>
            <div><div class="sig-line">የዲሬክተሩ ስምና ፊርማ<br><span style="font-size:11px;font-weight:normal;">School Director's Signature</span></div></div>
        </div>
    </div>

    <script>
        function downloadColorPDF() {
            const element = document.getElementById('reportCardArea');
            html2pdf().set({
                margin: 6,
                filename: 'ReportCard_${student.student_id}_${academicYear}.pdf',
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 2.5, useCORS: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(element).save();
        }
    </script>
</body>
</html>`);
                });
            });
        });
    }; // end runWithStudent

    if (studentId) {
        db.get(`SELECT * FROM students WHERE UPPER(student_id) = ?`, [studentId], (err, student) => {
            runWithStudent(student);
        });
    } else {
        db.get(`SELECT * FROM students WHERE LOWER(name) LIKE ? LIMIT 1`, ['%' + studentName.toLowerCase() + '%'], (err, student) => {
            runWithStudent(student);
        });
    }
});

app.get('/admin/master-roster/:year/:className', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const academicYear = decodeURIComponent(req.params.year);
    const className = decodeURIComponent(req.params.className);

    db.all(`SELECT * FROM students ORDER BY name ASC`, [], (err, allStudents = []) => {
        const students = allStudents.filter(s => isClassMatch(s.class_level, className));
        db.all(`SELECT * FROM courses ORDER BY code ASC`, [], (err2, allCourses = []) => {
            const courses = allCourses.filter(c => isClassMatch(c.class_level, className));
            db.all(`SELECT * FROM course_assessments`, [], (err3, assessments = []) => {
                db.all(`SELECT * FROM sections`, [], (err4, sections = []) => {
                    const secObj = sections.find(s => isClassMatch(s.name, className)) || {};

                    const rosterData = students.map(st => {
                        let sum = 0;
                        const courseScores = courses.map(c => {
                            const a = assessments.find(x => x.student_id === st.student_id && x.course_code === c.code) || {};
                            const tot = a.total !== undefined ? parseFloat(a.total) : 0;
                            sum += tot;
                            return { code: c.code, title: c.title, quiz: a.quiz ?? '-', mid: a.mid ?? '-', final: a.final ?? '-', total: tot };
                        });
                        const avg = courses.length > 0 ? (sum / courses.length) : 0;
                        return { student: st, courseScores, grandTotal: Number(sum.toFixed(2)), average: Number(avg.toFixed(2)) };
                    });

                    const sortedScores = [...rosterData].sort((a, b) => b.grandTotal - a.grandTotal);
                    rosterData.forEach(item => {
                        item.rank = sortedScores.findIndex(x => x.grandTotal === item.grandTotal) + 1;
                    });
                    rosterData.sort((a, b) => a.rank - b.rank);

                    const courseHeaders = courses.map(c => `<th>${c.title}<br><small>(${c.code})</small></th>`).join('');
                    const rosterRows = rosterData.map((r, idx) => {
                        const scoreCells = r.courseScores.map(cs => `<td><b>${cs.total}</b><br><small style="color:#64748b;">(${cs.quiz}/${cs.mid}/${cs.final})</small></td>`).join('');
                        return `<tr>
                            <td><b>${idx + 1}</b></td>
                            <td><b>${r.student.student_id}</b></td>
                            <td style="text-align:left;font-weight:bold;">${r.student.name}</td>
                            <td>${r.student.gender || '-'}</td>
                            ${scoreCells}
                            <td style="background:#eff6ff !important;font-weight:800;color:#1e3a8a !important;">${r.grandTotal}</td>
                            <td style="background:#f0fdf4 !important;font-weight:800;color:#166534 !important;">${r.average}%</td>
                            <td style="background:#fefce8 !important;font-weight:800;color:#b45309 !important;">🏆 ${r.rank}</td>
                            <td class="no-print">
                                <a href="/admin/student-report-card?student_id=${encodeURIComponent(r.student.student_id)}&year=${encodeURIComponent(academicYear)}" target="_blank" style="background:#2980b9;color:white;padding:5px 10px;border-radius:5px;text-decoration:none;font-size:12px;font-weight:bold;">📄 ካርድ አውጣ</a>
                            </td>
                        </tr>`;
                    }).join('') || `<tr><td colspan="${courses.length + 8}">በዚህ ክፍል ምንም ተማሪ የለም።</td></tr>`;

                    const allIndividualCardsHtml = rosterData.map(r => {
                        const cRows = r.courseScores.map((cs, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td><b>${cs.code}</b></td>
                                <td style="text-align:left;">${cs.title}</td>
                                <td>${cs.quiz}</td>
                                <td>${cs.mid}</td>
                                <td>${cs.final}</td>
                                <td style="color:#1f4e79 !important;font-weight:bold;">${cs.total}</td>
                                <td style="color:${cs.total >= 50 ? '#27ae60' : '#e74c3c'} !important;font-weight:bold;">${cs.total >= 50 ? 'Pass' : 'Fail'}</td>
                            </tr>
                        `).join('');
                        return `
                        <div class="individual-card-page">
                            <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #1f4e79;padding-bottom:12px;margin-bottom:15px;">
                                <img src="/uploads/logo.jpg" onerror="this.src='/uploads/logo.png'" style="width:70px;height:70px;border-radius:50%;border:2px solid #f39c12;object-fit:cover;" crossorigin="anonymous">
                                <div style="text-align:center;flex:1;">
                                    <h2 style="margin:0;color:#1f4e79 !important;">AMANUEL LIGHT AND LIFE SCHOOL</h2>
                                    <p style="margin:4px 0;font-weight:bold;color:#d35400 !important;">አማኑኤል ብርሃንና ሕይወት ትምህርት ቤት</p>
                                    <span style="background:#1f4e79 !important;color:white !important;padding:4px 14px;border-radius:12px;font-size:12px;font-weight:bold;">OFFICIAL STUDENT REPORT CARD (${academicYear})</span>
                                </div>
                                <img src="/uploads/${r.student.photo || 'logo.jpg'}" onerror="this.src='/uploads/logo.jpg'" style="width:70px;height:70px;border-radius:50%;border:2px solid #f39c12;object-fit:cover;" crossorigin="anonymous">
                            </div>
                            <div style="display:flex;justify-content:space-between;background:#f8fafc !important;padding:12px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:14px;font-size:13.5px;">
                                <div><b>👤 Name:</b> ${r.student.name}</div>
                                <div><b>🆔 ID:</b> <span style="color:#2980b9 !important;font-weight:bold;">${r.student.student_id}</span></div>
                                <div><b>🏫 Class:</b> ${className}</div>
                                <div><b>⚧ Gender:</b> ${r.student.gender || '-'}</div>
                            </div>
                            <table>
                                <tr><th>#</th><th>Code</th><th>Course</th><th>Quiz (20%)</th><th>Mid (30%)</th><th>Final (50%)</th><th>Total (100%)</th><th>Status</th></tr>
                                ${cRows}
                            </table>
                            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:15px;">
                                <div style="background:#f1f5f9 !important;border-left:4px solid #1f4e79;padding:10px;border-radius:6px;text-align:center;"><b>${r.grandTotal}</b><br><small>Grand Total</small></div>
                                <div style="background:#f1f5f9 !important;border-left:4px solid #2980b9;padding:10px;border-radius:6px;text-align:center;"><b>${r.average}%</b><br><small>Average</small></div>
                                <div style="background:#f1f5f9 !important;border-left:4px solid #f39c12;padding:10px;border-radius:6px;text-align:center;"><b>${r.rank} / ${rosterData.length}</b><br><small>Class Rank</small></div>
                                <div style="background:#f1f5f9 !important;border-left:4px solid #27ae60;padding:10px;border-radius:6px;text-align:center;"><b style="color:${r.average >= 50 ? '#27ae60' : '#e74c3c'} !important;">${r.average >= 50 ? 'Promoted' : 'Failed'}</b><br><small>Remark</small></div>
                            </div>
                            <div style="display:flex;justify-content:space-between;margin-top:40px;font-weight:bold;font-size:13px;">
                                <div>Homeroom Teacher: ___________________</div>
                                <div>Official Stamp: _______________</div>
                                <div>Director's Signature: ___________________</div>
                            </div>
                        </div>`;
                    }).join('');

                    res.send(`<!DOCTYPE html>
<html lang="am">
<head>
    <meta charset="UTF-8">
    <title>Master Roster - ${className} (${academicYear})</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #eef2f5; margin: 0; padding: 20px; color: #1e293b; }
        .top-controls { background: white; padding: 15px; border-radius: 10px; max-width: 1200px; margin: 0 auto 20px auto; display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
        .btn { padding: 10px 18px; border: none; border-radius: 6px; color: white; font-weight: bold; cursor: pointer; text-decoration: none; font-size: 14px; }
        .roster-box { max-width: 1200px; margin: auto; background: white !important; padding: 30px; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); border-top: 8px solid #1f4e79; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px 6px; text-align: center; }
        th { background: #1f4e79 !important; color: white !important; }
        .individual-cards-wrapper { display: none; max-width: 850px; margin: 20px auto; }
        .individual-card-page { background: white !important; padding: 30px; border: 3px double #1f4e79; border-radius: 12px; margin-bottom: 25px; page-break-after: always; }
        @media print {
            body { background: white !important; padding: 0; }
            .no-print, .top-controls { display: none !important; }
            .roster-box { box-shadow: none; border: none; padding: 0; max-width: 100%; }
        }
    </style>
</head>
<body>
    <div class="top-controls no-print">
        <button onclick="downloadMasterRosterPDF()" class="btn" style="background:#16a085;">📥 ሮስተሩን በኦሪጅናል ከለር Download PDF</button>
        <button onclick="downloadAllCardsPDF()" class="btn" style="background:#8e44ad;">📥 የሁሉንም ተማሪዎች ካርድ በከለር Download PDF</button>
        <button onclick="printMode('roster')" class="btn" style="background:#1f4e79;">🖨️ Print Master Roster</button>
        <button onclick="printMode('cards')" class="btn" style="background:#27ae60;">🗂️ Print All Individual Cards</button>
        <a href="/admin" class="btn" style="background:#7f8c8d;">⬅️ ወደ አድሚን ተመለስ</a>
    </div>

    <div class="roster-box" id="masterRosterSection">
        <div style="text-align:center; border-bottom:2px solid #1f4e79; padding-bottom:12px; margin-bottom:15px;">
            <img src="/uploads/logo.jpg" onerror="this.src='/uploads/logo.png'" style="width:70px;height:70px;border-radius:50%;border:2px solid #f39c12;object-fit:cover;" crossorigin="anonymous">
            <h1 style="margin:6px 0 2px;color:#1f4e79 !important;font-size:24px;">AMANUEL LIGHT AND LIFE SCHOOL</h1>
            <h3 style="margin:0;color:#d35400 !important;">OFFICIAL CLASS MASTER ROSTER - ${academicYear}</h3>
            <p style="margin:6px 0 0;font-weight:bold;color:#334155;">
                🏫 ክፍል (Class): <span style="color:#2980b9 !important;">${className}</span> &nbsp;|&nbsp;
                👨‍🏫 የተቆጣጣሪ መምህር (Proctor): <span style="color:#27ae60 !important;">${secObj.proctor_name || 'N/A'}</span> &nbsp;|&nbsp;
                👨‍🎓 የተማሪ ብዛት (Total Students): ${rosterData.length}
            </p>
        </div>

        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>መታወቂያ (ID)</th>
                    <th>የተማሪው ሙሉ ስም (Student Name)</th>
                    <th>ፆታ</th>
                    ${courseHeaders}
                    <th>ጠቅላላ ድምር<br>(Total)</th>
                    <th>አማካይ<br>(Average)</th>
                    <th>ደረጃ<br>(Rank)</th>
                    <th class="no-print">የግል ካርድ<br>(1-Page Card)</th>
                </tr>
            </thead>
            <tbody>
                ${rosterRows}
            </tbody>
        </table>

        <div style="display:flex; justify-content:space-between; margin-top:45px; font-weight:bold; font-size:14px;">
            <div>የክፍል ተቆጣጣሪ መምህር ፊርማ፦ ________________________</div>
            <div>የዲሬክተሩ ስም፣ ፊርማ እና ማህተም፦ ________________________</div>
        </div>
    </div>

    <div class="individual-cards-wrapper" id="allCardsSection">
        ${allIndividualCardsHtml}
    </div>

    <script>
        function printMode(mode) {
            const rosterEl = document.getElementById('masterRosterSection');
            const cardsEl = document.getElementById('allCardsSection');
            if (mode === 'cards') {
                rosterEl.style.display = 'none';
                cardsEl.style.display = 'block';
                window.print();
                rosterEl.style.display = 'block';
                cardsEl.style.display = 'none';
            } else {
                rosterEl.style.display = 'block';
                cardsEl.style.display = 'none';
                window.print();
            }
        }

        function downloadMasterRosterPDF() {
            const element = document.getElementById('masterRosterSection');
            html2pdf().set({
                margin: 8,
                filename: 'Master_Roster_${className.replace(/\s+/g, '_')}_${academicYear}.pdf',
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
            }).from(element).save();
        }

        function downloadAllCardsPDF() {
            const cardsEl = document.getElementById('allCardsSection');
            cardsEl.style.display = 'block';
            html2pdf().set({
                margin: 8,
                filename: 'All_Student_Cards_${className.replace(/\s+/g, '_')}_${academicYear}.pdf',
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(cardsEl).save().then(() => {
                cardsEl.style.display = 'none';
            });
        }
    </script>
</body>
</html>`);
                });
            });
        });
    });
});

app.post('/admin/archive-year', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM course_assessments`, [], () => res.redirect('/admin'));
});

app.post('/admin/promote-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const gradeMap = {
        "Grade 1": "Grade 2", "Grade 2": "Grade 3", "Grade 3": "Grade 4",
        "Grade 4": "Grade 5", "Grade 5": "Grade 6", "Grade 6": "Grade 7",
        "Grade 7": "Grade 8", "Grade 8": "Grade 9", "Grade 9": "Grade 10",
        "Grade 10": "Grade 11", "Grade 11": "Grade 12", "Grade 12": "Graduated"
    };
    db.all(`SELECT student_id, class_level FROM students`, [], (err, students = []) => {
        students.forEach(st => {
            let match = st.class_level ? st.class_level.match(/(Grade \d+)/i) : null;
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


// ===== QR Attendance =====
app.get('/qr-scan', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Attendance</title>
<script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
<style>
body{font-family:Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px;text-align:center}
.card{background:#1e293b;border-radius:16px;padding:20px;max-width:420px;margin:0 auto 16px}
#reader{width:100%;max-width:360px;margin:0 auto;border-radius:12px;overflow:hidden}
.ok{background:#14532d;color:#bbf7d0;padding:12px;border-radius:8px;margin-top:12px;display:none}
.err{background:#7f1d1d;color:#fecaca;padding:12px;border-radius:8px;margin-top:12px;display:none}
input,button{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:none;font-size:15px;box-sizing:border-box}
button{background:#2980b9;color:#fff;font-weight:bold;cursor:pointer}
a{color:#60a5fa}
</style></head><body>
<div class="card"><h2>📷 QR Attendance</h2>
<p style="font-size:13px;color:#94a3b8">Scan student ID QR or type ID manually</p>
<div id="reader"></div>
<div id="ok" class="ok"></div><div id="err" class="err"></div>
<input id="manualId" placeholder="Or type Student ID e.g. ALLS-1234">
<button onclick="markManual()">✅ Mark Present</button>
<p style="margin-top:16px"><a href="javascript:history.back()">⬅️ Back</a></p>
</div>
<script>
function showOk(t){const e=document.getElementById('ok');e.style.display='block';e.textContent=t;document.getElementById('err').style.display='none';}
function showErr(t){const e=document.getElementById('err');e.style.display='block';e.textContent=t;document.getElementById('ok').style.display='none';}
function mark(id){
  fetch('/api/qr-attendance',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({student_id:id})})
  .then(r=>r.json()).then(d=>{ if(d.success) showOk('✅ '+d.name+' — Present ('+d.date+')'); else showErr('❌ '+(d.error||'Failed')); })
  .catch(()=>showErr('Network error'));
}
function markManual(){ const id=document.getElementById('manualId').value.trim(); if(id) mark(id); }
const scanner=new Html5Qrcode('reader');
Html5Qrcode.getCameras().then(cams=>{
  if(!cams.length){ showErr('No camera'); return; }
  const back = cams.find(c => /back|rear|environment/i.test(c.label)) || cams[cams.length-1] || cams[0];
  scanner.start(back.id,{fps:8,qrbox:220,videoConstraints:{facingMode:{ideal:'environment'}}}, (text)=>{ mark(text.trim()); }, ()=>{});
}).catch(()=>showErr('Camera permission needed — use manual ID'));
</script></body></html>`);
});

app.post('/api/qr-attendance', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.status(401).json({ success: false, error: 'login' });
    const sid = String((req.body && req.body.student_id) || '').trim();
    if (!sid) return res.json({ success: false, error: 'No student ID' });
    const today = new Date().toISOString().slice(0, 10);
    db.get(`SELECT * FROM students WHERE UPPER(student_id)=UPPER(?)`, [sid], (err, st) => {
        if (!st) return res.json({ success: false, error: 'Student not found' });
        db.get(`SELECT id FROM daily_attendance WHERE student_id=? AND date=?`, [st.student_id, today], (e2, row) => {
            const done = () => {
                logActivity(req.session.isAdmin ? 'Admin' : 'Teacher', req.session.isAdmin ? 'Director' : (req.session.teacherId||''), 'QR_ATTENDANCE', st.student_id);
                res.json({ success: true, name: st.name, date: today });
            };
            if (row) {
                db.run(`UPDATE daily_attendance SET status=? WHERE id=?`, ['Present', row.id], done);
            } else {
                db.run(`INSERT INTO daily_attendance (student_id, student_name, class_level, date, status) VALUES (?,?,?,?,?)`,
                    [st.student_id, st.name, st.class_level || '', today, 'Present'], done);
            }
        });
    });
});

app.get('/api/activity-log', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ rows: [] });
    db.all(`SELECT * FROM activity_log ORDER BY id DESC LIMIT 50`, [], (err, rows) => {
        res.json({ rows: rows || [] });
    });
});


// ================= LEARNING HUB FEATURES 1-15 =================

// 12 Announcements board
app.get('/api/announcements', (req, res) => {
    db.all(`SELECT * FROM announcements ORDER BY id DESC LIMIT 30`, [], (e, rows) => res.json({ rows: rows || [] }));
});
app.post('/admin/announcement', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { title, body, audience } = req.body;
    db.run(`INSERT INTO announcements (title, body, audience, created_by, created_at) VALUES (?,?,?,?,?)`,
        [title || '', body || '', audience || 'ALL', 'Admin', getFormattedTimestamp()],
        () => { logActivity('Admin','Director','ANNOUNCEMENT', title||''); res.redirect('/admin#announcements'); });
});

// 2 Digital library
app.post('/library/upload', upload.single('file'), (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    const { title, category, class_level } = req.body;
    const file = req.file ? req.file.filename : '';
    const by = req.session.isAdmin ? 'Admin' : (req.session.teacherId || 'Teacher');
    db.run(`INSERT INTO library_items (title, category, class_level, file_path, uploaded_by, created_at) VALUES (?,?,?,?,?,?)`,
        [title || 'Resource', category || 'General', class_level || 'ALL', file, by, getFormattedTimestamp()],
        () => res.redirect(req.get('Referer') || '/admin'));
});
app.get('/api/library', (req, res) => {
    db.all(`SELECT * FROM library_items ORDER BY id DESC LIMIT 100`, [], (e, rows) => res.json({ rows: rows || [] }));
});

// 1 Homework
app.post('/teacher/homework', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const { title, description, due_date, class_level } = req.body;
    db.get(`SELECT name FROM teachers WHERE id=?`, [req.session.teacherId], (e, t) => {
        db.run(`INSERT INTO homework (teacher_id, teacher_name, class_level, title, description, due_date, created_at) VALUES (?,?,?,?,?,?,?)`,
            [req.session.teacherId, t ? t.name : '', class_level || '', title || '', description || '', due_date || '', getFormattedTimestamp()],
            () => res.redirect('/teacher-dashboard#homework'));
    });
});
app.post('/student/homework-submit', upload.single('file'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    const { homework_id, note } = req.body;
    const file = req.file ? req.file.filename : '';
    db.get(`SELECT name FROM students WHERE student_id=?`, [req.session.studentId], (e, s) => {
        db.run(`INSERT INTO homework_submissions (homework_id, student_id, student_name, file_path, note, status, created_at) VALUES (?,?,?,?,?,?,?)`,
            [homework_id, req.session.studentId, s ? s.name : '', file, note || '', 'submitted', getFormattedTimestamp()],
            () => res.redirect('/student-dashboard#homework'));
    });
});
app.get('/api/homework', (req, res) => {
    const cls = req.query.class || '';
    db.all(`SELECT * FROM homework ORDER BY id DESC LIMIT 50`, [], (e, rows) => {
        rows = rows || [];
        if (cls) rows = rows.filter(h => !h.class_level || h.class_level === 'ALL' || String(h.class_level).includes(cls) || isClassMatch(h.class_level, cls));
        res.json({ rows });
    });
});

// 3 Online Quiz — Telegram-style (one-by-one) + formulas + answer description
app.post('/teacher/quiz', upload.any(), (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    // questions_json can be sent as JSON string from multi-question builder
    let questions = [];
    try {
        if (req.body.questions_json) {
            // Raw JSON — do NOT run xss on formulas/symbols (∫ ∑ √ ² × etc.)
            questions = JSON.parse(req.body.questions_json);
        } else {
            for (let i = 1; i <= 20; i++) {
                const q = req.body['q' + i];
                const a = req.body['a' + i];
                const d = req.body['d' + i] || '';
                if (q && String(q).trim()) {
                    questions.push({
                        q: String(q),
                        a: String(a || '').trim(),
                        desc: String(d || ''),
                        options: {
                            A: req.body['oA' + i] || '',
                            B: req.body['oB' + i] || '',
                            C: req.body['oC' + i] || '',
                            D: req.body['oD' + i] || ''
                        },
                        type: 'mcq'
                    });
                }
            }
        }
    } catch (e) { questions = []; }
    // Keep every character; only require non-empty question text
    questions = (questions || []).filter(x => x && String(x.q || '').length > 0).map(x => ({
        q: String(x.q == null ? '' : x.q),
        a: String(x.a == null ? '' : x.a).trim(),
        desc: String(x.desc == null ? '' : x.desc),
        type: x.type || (x.options ? 'mcq' : 'text'),
        options: x.options ? {
            A: String(x.options.A == null ? '' : x.options.A),
            B: String(x.options.B == null ? '' : x.options.B),
            C: String(x.options.C == null ? '' : x.options.C),
            D: String(x.options.D == null ? '' : x.options.D)
        } : null
    }));
    // Attach uploaded images to questions
    const files = req.files || [];
    const fileMap = {};
    files.forEach(f => { fileMap[f.fieldname] = f.filename; });
    questions = questions.map(q => {
        if (q.imageField && fileMap[q.imageField]) {
            q.image = fileMap[q.imageField];
        }
        delete q.imageField;
        if (q.optImageFields) {
            q.optImages = {};
            ['A','B','C','D'].forEach(L => {
                const fn = q.optImageFields[L];
                if (fn && fileMap[fn]) q.optImages[L] = fileMap[fn];
            });
            delete q.optImageFields;
        }
        return q;
    });
    if (!questions.length) return res.redirect('/teacher-dashboard#quiz');
    const title = req.body.title || 'Quiz';
    const class_level = req.body.class_level || '';
    db.get(`SELECT name FROM teachers WHERE id=?`, [req.session.teacherId], (e, t) => {
        db.run(`INSERT INTO quizzes (teacher_id, teacher_name, class_level, title, questions_json, created_at) VALUES (?,?,?,?,?,?)`,
            [req.session.teacherId, t ? t.name : '', class_level, title, JSON.stringify(questions), getFormattedTimestamp()],
            () => res.redirect('/teacher-dashboard#quiz'));
    });
});
// List quizzes (questions without answers for students)
app.get('/api/quizzes', (req, res) => {
    db.all(`SELECT id, teacher_name, class_level, title, questions_json, created_at FROM quizzes ORDER BY id DESC LIMIT 40`, [], (e, rows) => {
        res.json({
            rows: (rows || []).map(r => {
                let qs = [];
                try { qs = JSON.parse(r.questions_json || '[]'); } catch (e) {}
                return {
                    id: r.id, teacher_name: r.teacher_name, class_level: r.class_level,
                    title: r.title, created_at: r.created_at,
                    count: qs.length,
                    questions: qs.map(q => ({ q: q.q })) // no answers
                };
            })
        });
    });
});
// Full quiz for taking (student gets questions only)
app.get('/api/quiz/:id', (req, res) => {
    const qid = parseInt(req.params.id, 10) || req.params.id;
    db.get(`SELECT id, title, class_level, teacher_name, questions_json FROM quizzes WHERE id=?`, [qid], (e, quiz) => {
        if (e) {
            console.error('api/quiz error', e);
            return res.json({ success: false, error: String(e.message || e) });
        }
        if (!quiz) return res.json({ success: false, error: 'not found' });
        let qs = [];
        try {
            qs = typeof quiz.questions_json === 'string' ? JSON.parse(quiz.questions_json || '[]') : (quiz.questions_json || []);
        } catch (err) {
            console.error('questions_json parse', err);
            qs = [];
        }
        if (!Array.isArray(qs)) qs = [];
        const questions = qs.map(q => ({
            q: (q && q.q) ? String(q.q) : '',
            type: (q && q.type) || (q && q.options ? 'mcq' : 'text'),
            options: (q && q.options) || null,
            image: (q && q.image) || null,
            optImages: (q && q.optImages) || null
        }));
        res.json({
            success: true,
            id: quiz.id,
            title: quiz.title,
            class_level: quiz.class_level,
            teacher_name: quiz.teacher_name,
            questions: questions
        });
    });
});
app.post('/student/quiz-attempt', (req, res) => {
    if (!req.session.studentId && !req.session.teacherId && !req.session.isAdmin) return res.json({ success: false, error: 'login' });
    const { quiz_id, answers } = req.body;
    db.get(`SELECT * FROM quizzes WHERE id=?`, [quiz_id], (e, quiz) => {
        if (!quiz) return res.json({ success: false });
        let qs = [];
        try { qs = JSON.parse(quiz.questions_json || '[]'); } catch (e) {}
        const ans = answers || [];
        let score = 0;
        const review = qs.map((q, i) => {
            const given = String(ans[i] || '').trim();
            const correct = String(q.a || '').trim();
            const ok = given.toLowerCase() === correct.toLowerCase();
            if (ok) score++;
            let correctLabel = correct;
            if (q.options && q.options[correct]) {
                correctLabel = correct + ') ' + q.options[correct];
            }
            let yourLabel = given;
            if (q.options && q.options[given]) {
                yourLabel = given + ') ' + q.options[given];
            }
            return {
                q: q.q,
                your: yourLabel,
                correct: correctLabel,
                desc: q.desc || '',
                ok
            };
        });
        const total = qs.length || 1;
        const percent = Math.round((score / total) * 100);
        const sid = req.session.studentId || ('preview-'+(req.session.teacherId||'admin'));
        db.get(`SELECT name FROM students WHERE student_id=?`, [req.session.studentId||''], (e2, s) => {
            const sname = s ? s.name : (req.session.teacherId ? 'Teacher' : 'Admin');
            if (req.session.studentId) {
                db.run(`INSERT INTO quiz_attempts (quiz_id, student_id, student_name, answers_json, score, total, created_at) VALUES (?,?,?,?,?,?,?)`,
                    [quiz_id, sid, sname, JSON.stringify(ans), score, total, getFormattedTimestamp()],
                    () => res.json({ success: true, score, total, percent, review }));
            } else {
                res.json({ success: true, score, total, percent, review });
            }
        });
    });
});

// Telegram-style quiz page
app.get('/quiz/:id', (req, res) => {
    if (!req.session.studentId && !req.session.teacherId && !req.session.isAdmin) return res.redirect('/?error=login');
    const qid = req.params.id;
    res.send(`<!DOCTYPE html><html lang="am"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quiz</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<style>
body{font-family:Segoe UI,sans-serif;background:linear-gradient(135deg,#1f4e79,#0d2b45);min-height:100vh;margin:0;padding:16px;color:#333}
.card{background:#fff;max-width:520px;margin:20px auto;border-radius:16px;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
h2{color:#1f4e79;margin:0 0 8px;font-size:20px}
.progress{height:8px;background:#e2e8f0;border-radius:8px;overflow:hidden;margin:12px 0 18px}
.bar{height:100%;background:#27ae60;width:0%;transition:.3s}
.qbox{font-size:16px;line-height:1.6;margin-bottom:14px;min-height:50px;white-space:pre-wrap;word-break:break-word}
.opt{display:block;width:100%;text-align:left;padding:12px 14px;margin:8px 0;border:2px solid #cbd5e1;border-radius:10px;background:#f8fafc;font-size:15px;cursor:pointer;box-sizing:border-box}
.opt.selected{border-color:#2980b9;background:#e8f4fd}
.opt:hover{border-color:#94a3b8}
button{width:100%;padding:14px;margin-top:12px;border:none;border-radius:10px;font-weight:bold;font-size:16px;cursor:pointer;background:#2980b9;color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
button.sec{background:#64748b}
.meta{font-size:13px;color:#64748b}
.review{text-align:left;font-size:14px}
.ok{color:#16a34a}.bad{color:#dc2626}
.score{font-size:42px;font-weight:800;color:#1f4e79;text-align:center}
.desc{white-space:pre-wrap;background:#f1f5f9;padding:10px;border-radius:8px;margin-top:6px;font-size:13px}
</style></head><body>
<div class="card" id="app"><p class="meta">Loading quiz...</p></div>
<script>
const quizId=${JSON.stringify(String(qid))};
let questions=[], idx=0, answers=[], selected=null;
function renderMath(el){
  if(window.renderMathInElement){
    try{ renderMathInElement(el,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},{left:'\\\\(',right:'\\\\)',display:false},{left:'\\\\[',right:'\\\\]',display:true}],throwOnError:false}); }catch(e){}
  }
}
function showQ(){
  const app=document.getElementById('app');
  if(idx>=questions.length){ return finish(); }
  selected=null;
  const q=questions[idx];
  const pct=Math.round((idx/questions.length)*100);
  let optsHtml='';
  if(q.options || q.optImages){
    ['A','B','C','D'].forEach(function(L){
      const t=(q.options&&q.options[L])?q.options[L]:'';
      const im=(q.optImages&&q.optImages[L])?q.optImages[L]:'';
      if(!t && !im) return;
      optsHtml+='<button type="button" class="opt" data-val="'+L+'"><b>'+L+'.</b> <span class="opttext"></span>'+(im?'<img src="/uploads/'+im+'" style="max-width:100%;max-height:120px;display:block;margin-top:6px;border-radius:6px;">':'')+'</button>';
    });
  } else {
    optsHtml='<input type="text" id="ans" placeholder="Your answer..." style="width:100%;padding:14px;border:2px solid #cbd5e1;border-radius:10px;font-size:16px;box-sizing:border-box;">';
  }
  var imgHtml=q.image?('<img src="/uploads/'+q.image+'" style="max-width:100%;border-radius:8px;margin-bottom:10px;">'):'';
  app.innerHTML='<h2 id="title"></h2><div class="meta">Question '+(idx+1)+' / '+questions.length+'</div><div class="progress"><div class="bar" style="width:'+pct+'%"></div></div>'+imgHtml+'<div class="qbox" id="qtext"></div>'+optsHtml+'<button type="button" id="nextBtn" disabled>'+(idx===questions.length-1?'Finish ✅':'Next ➡️')+'</button><button type="button" class="sec" onclick="location.href=\\'/learning-hub\\'">Exit</button>';
  document.getElementById('title').textContent=window._quizTitle||'Quiz';
  const qt=document.getElementById('qtext');
  var qraw=q.q||'';
  if(qraw && qraw.indexOf('$')===-1 && /\\(lim|frac|sum|int|sqrt|to)/.test(qraw)){
    try{ if(window.katex){ katex.render(qraw, qt, {throwOnError:false, displayMode:true}); } else { qt.textContent=qraw; renderMath(qt); } }
    catch(e){ qt.textContent=qraw; renderMath(qt); }
  } else {
    qt.textContent=qraw;
    renderMath(qt);
  }
  if(q.options || q.optImages){
    const buttons=app.querySelectorAll('.opt');
    let oi=0;
    ['A','B','C','D'].forEach(function(L){
      const t=(q.options&&q.options[L])?q.options[L]:'';
      const im=(q.optImages&&q.optImages[L])?q.optImages[L]:'';
      if(!t && !im) return;
      const btn=buttons[oi++];
      const sp=btn.querySelector('.opttext');
      sp.textContent=t||'';
      if(t) renderMath(sp);
      btn.onclick=function(){
        buttons.forEach(b=>b.classList.remove('selected'));
        btn.classList.add('selected');
        selected=L;
        document.getElementById('nextBtn').disabled=false;
      };
    });
  } else {
    const inp=document.getElementById('ans');
    inp.oninput=function(){ document.getElementById('nextBtn').disabled=!inp.value.trim(); };
    inp.focus();
  }
  document.getElementById('nextBtn').onclick=function(){
    if(q.options){ answers[idx]=selected; }
    else { answers[idx]=document.getElementById('ans').value; }
    idx++;
    showQ();
  };
}
function finish(){
  fetch('/student/quiz-attempt',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({quiz_id:quizId,answers:answers})})
  .then(r=>r.json()).then(d=>{
    const app=document.getElementById('app');
    if(!d.success){ app.innerHTML='<p>Error submitting</p>'; return; }
    let html='<div class="score">'+d.percent+'%</div><p style="text-align:center;font-weight:bold">'+d.score+' / '+d.total+' correct</p><div class="progress"><div class="bar" style="width:'+d.percent+'%"></div></div><div class="review">';
    (d.review||[]).forEach(function(r,i){
      html+='<div style="border-top:1px solid #eee;padding:10px 0"><b>Q'+(i+1)+'.</b> <span class="qpart"></span><br>';
      html+=(r.ok?'<span class="ok">✅ Correct</span>':'<span class="bad">❌ Wrong</span>');
      html+='<br>Your: <b class="yourpart"></b><br>Answer: <b class="corrpart"></b>';
      if(r.desc) html+='<div class="desc descp"></div>';
      html+='</div>';
    });
    html+='</div><button onclick="location.href=\\'/learning-hub\\'">Back to Hub</button>';
    app.innerHTML=html;
    app.querySelectorAll('.review > div').forEach(function(div,i){
      const r=d.review[i]; if(!r) return;
      const qp=div.querySelector('.qpart'); if(qp){ qp.textContent=r.q; renderMath(qp); }
      const yp=div.querySelector('.yourpart'); if(yp){ yp.textContent=r.your||'-'; renderMath(yp); }
      const cp=div.querySelector('.corrpart'); if(cp){ cp.textContent=r.correct||'-'; renderMath(cp); }
      const dp=div.querySelector('.descp'); if(dp&&r.desc){ dp.textContent=r.desc; renderMath(dp); }
    });
  });
}
fetch('/api/quiz/'+encodeURIComponent(quizId),{credentials:'same-origin'})
.then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
.then(function(d){
  if(!d || !d.success){ document.getElementById('app').innerHTML='<p>Quiz not found or empty.</p><a href="/learning-hub" style="color:#2980b9">Back</a>'; return; }
  window._quizTitle=d.title||'Quiz';
  questions=d.questions||[];
  if(!questions.length){ document.getElementById('app').innerHTML='<p>No questions in this quiz.</p><a href="/learning-hub" style="color:#2980b9">Back</a>'; return; }
  showQ();
})
.catch(function(err){
  document.getElementById('app').innerHTML='<p>Failed to load quiz.</p><p class="meta">'+String(err)+'</p><button type="button" onclick="location.reload()">Retry</button>';
});
</script></body></html>`);
});


// 5 Lesson plan
app.post('/teacher/lesson-plan', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const { class_level, week_label, content } = req.body;
    db.get(`SELECT name FROM teachers WHERE id=?`, [req.session.teacherId], (e, t) => {
        db.run(`INSERT INTO lesson_plans (teacher_id, teacher_name, class_level, week_label, content, created_at) VALUES (?,?,?,?,?,?)`,
            [req.session.teacherId, t ? t.name : '', class_level || '', week_label || '', content || '', getFormattedTimestamp()],
            () => res.redirect('/teacher-dashboard#lesson'));
    });
});
app.get('/api/lesson-plans', (req, res) => {
    db.all(`SELECT * FROM lesson_plans ORDER BY id DESC LIMIT 40`, [], (e, rows) => res.json({ rows: rows || [] }));
});

// 6 Bulk grade import CSV: student_id,quiz,assignment,project,mid,final
app.post('/teacher/bulk-grades', upload.single('csv'), (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const courseCode = req.body.course_code || 'GEN';
    const courseTitle = req.body.course_title || 'Course';
    if (!req.file) return res.redirect('/teacher-dashboard');
    const fs = require('fs');
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let i = 0;
    const processNext = () => {
        if (i >= lines.length) return res.redirect('/teacher-dashboard#grades');
        const line = lines[i++];
        if (line.toLowerCase().startsWith('student')) return processNext();
        const p = line.split(',').map(s => s.trim());
        if (p.length < 2) return processNext();
        const student_id = p[0];
        const quiz = parseFloat(p[1]) || 0, assignment = parseFloat(p[2]) || 0, project = parseFloat(p[3]) || 0;
        const mid = parseFloat(p[4]) || 0, fin = parseFloat(p[5]) || 0;
        const total = quiz + assignment + project + mid + fin;
        db.get(`SELECT id FROM course_assessments WHERE student_id=? AND course_code=?`, [student_id, courseCode], (e, row) => {
            if (row) {
                db.run(`UPDATE course_assessments SET quiz=?,assignment=?,project=?,mid=?,final=?,total=?,teacher_id=? WHERE id=?`,
                    [quiz, assignment, project, mid, fin, total, req.session.teacherId, row.id], processNext);
            } else {
                db.run(`INSERT INTO course_assessments (student_id,teacher_id,course_code,course_title,quiz,assignment,project,mid,final,total,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                    [student_id, req.session.teacherId, courseCode, courseTitle, quiz, assignment, project, mid, fin, total, total >= 50 ? 'Pass' : 'Fail'], processNext);
            }
        });
    };
    processNext();
});

// 9 Fee ledger

app.post('/admin/replace-teacher', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const oldId = (req.body.old_teacher_id || '').trim();
    const newId = (req.body.new_teacher_id || '').trim();
    const sections = String(req.body.sections || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!oldId || !newId || !sections.length) return res.redirect('/admin#teacherAssign');
    db.get(`SELECT assigned_sections FROM teachers WHERE id = ?`, [oldId], (e1, oldT) => {
        let oldSecs = (oldT && oldT.assigned_sections ? oldT.assigned_sections : '').split(',').map(s => s.trim()).filter(s => s && !sections.includes(s));
        db.run(`UPDATE teachers SET assigned_sections = ? WHERE id = ?`, [oldSecs.join(', '), oldId], () => {
            db.get(`SELECT assigned_sections FROM teachers WHERE id = ?`, [newId], (e2, newT) => {
                let newSecs = (newT && newT.assigned_sections ? newT.assigned_sections : '').split(',').map(s => s.trim()).filter(Boolean);
                sections.forEach(s => { if (!newSecs.includes(s)) newSecs.push(s); });
                db.run(`UPDATE teachers SET assigned_sections = ? WHERE id = ?`, [newSecs.join(', '), newId], () => {
                    logActivity('Admin', 'Director', 'TEACHER_REPLACE', oldId + '->' + newId);
                    res.redirect('/admin#teacherAssign');
                });
            });
        });
    });
});

app.post('/admin/fee-delete', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM fee_ledger WHERE id = ?`, [req.body.id], () => res.redirect('/admin#fees'));
});
app.post('/admin/fee-edit', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const id = req.body.id;
    const amount = parseFloat(req.body.amount) || 0;
    const paid = parseFloat(req.body.paid) || 0;
    const description = req.body.description || '';
    const status = paid >= amount ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
    db.run(`UPDATE fee_ledger SET amount=?, paid=?, description=?, status=?, updated_at=? WHERE id=?`,
        [amount, paid, description, status, getFormattedTimestamp(), id],
        () => res.redirect('/admin#fees'));
});

app.post('/admin/fee', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { student_id, amount, paid, description } = req.body;
    db.get(`SELECT name, class_level FROM students WHERE student_id=?`, [student_id], (e, s) => {
        const amt = parseFloat(amount) || 0, pd = parseFloat(paid) || 0;
        const status = pd >= amt ? 'paid' : (pd > 0 ? 'partial' : 'unpaid');
        db.run(`INSERT INTO fee_ledger (student_id, student_name, class_level, amount, paid, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            [student_id, s ? s.name : '', s ? s.class_level : '', amt, pd, description || '', status, getFormattedTimestamp(), getFormattedTimestamp()],
            () => res.redirect('/admin#fees'));
    });
});

app.get('/api/search-students', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.status(401).json({ rows: [] });
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ rows: [], teachers: [] });
    db.all(`SELECT student_id, name, class_level FROM students ORDER BY name LIMIT 500`, [], (e, rows) => {
        rows = (rows || []).filter(s =>
            String(s.name||'').toLowerCase().includes(q) ||
            String(s.student_id||'').toLowerCase().includes(q)
        ).slice(0, 20);
        db.all(`SELECT id, name FROM teachers ORDER BY name LIMIT 200`, [], (e2, trows) => {
            trows = (trows || []).filter(t =>
                String(t.name||'').toLowerCase().includes(q) ||
                String(t.id||'').toLowerCase().includes(q)
            ).slice(0, 15);
            res.json({ rows, teachers: trows });
        });
    });
});

app.get('/api/fees', (req, res) => {
    const sid = req.query.student_id;
    if (sid) {
        db.all(`SELECT * FROM fee_ledger WHERE student_id=? ORDER BY id DESC`, [sid], (e, rows) => res.json({ rows: rows || [] }));
    } else {
        if (!req.session.isAdmin) return res.status(401).json({ rows: [] });
        db.all(`SELECT * FROM fee_ledger ORDER BY id DESC LIMIT 100`, [], (e, rows) => res.json({ rows: rows || [] }));
    }
});

// 10 Timetable — Excel-like Mon–Fri periods 1–6 (40 min) + 15 min break 4:00–4:15
// Period times: 1=8:00-8:45, 2=8:45-9:30, 3=9:30-10:15, 4=10:15-11:00, 5=11:00-11:45, 6=11:45-12:30
// Afternoon example can use same 1-6 labels; break note stored in UI
app.post('/admin/timetable', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { class_level, day_of_week, period_no, subject, teacher_name, room } = req.body;
    db.run(`INSERT INTO timetable (class_level, day_of_week, period_no, subject, teacher_name, room) VALUES (?,?,?,?,?,?)`,
        [class_level || '', day_of_week || '', parseInt(period_no) || 1, subject || '', teacher_name || '', room || ''],
        () => res.redirect('/admin#timetable'));
});
// Save full grid for one class: body.grid = { Monday: {1:{subject,teacher,room},...}, ... }
app.post('/admin/timetable-grid', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ success: false });
    const class_level = (req.body.class_level || '').trim();
    const grid = req.body.grid || {};
    if (!class_level) return res.json({ success: false, error: 'class required' });
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    db.run(`DELETE FROM timetable WHERE class_level = ?`, [class_level], () => {
        const jobs = [];
        days.forEach(day => {
            for (let p = 1; p <= 6; p++) {
                const cell = (grid[day] && grid[day][p]) ? grid[day][p] : {};
                const subject = (cell.subject || '').trim();
                if (!subject) continue;
                jobs.push([class_level, day, p, subject, cell.teacher || '', cell.room || '']);
            }
        });
        let i = 0;
        const next = () => {
            if (i >= jobs.length) return res.json({ success: true, saved: jobs.length });
            const j = jobs[i++];
            db.run(`INSERT INTO timetable (class_level, day_of_week, period_no, subject, teacher_name, room) VALUES (?,?,?,?,?,?)`, j, next);
        };
        next();
    });
});
app.get('/admin/timetable-pdf', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    const cls = (req.query.class || '').trim();
    db.all(`SELECT * FROM timetable ORDER BY day_of_week, period_no`, [], (e, rows) => {
        rows = rows || [];
        if (cls) rows = rows.filter(r => String(r.class_level||'').toLowerCase().includes(cls.toLowerCase()));
        const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
        const times = {1:'8:00-8:45',2:'8:45-9:30',3:'9:30-10:15',4:'10:15-11:00',5:'11:00-11:45',6:'11:45-12:30'};
        const map = {};
        rows.forEach(r => {
            const day = r.day_of_week || '';
            const p = String(r.period_no || '');
            if (!map[day]) map[day] = {};
            map[day][p] = { s: r.subject || '', t: r.teacher_name || '' };
        });
        let body = '';
        days.forEach(day => {
            body += `<tr><td style="font-weight:bold;background:#eef2ff">${day}</td>`;
            for (let p = 1; p <= 6; p++) {
                const c = (map[day] && map[day][p]) ? map[day][p] : { s: '', t: '' };
                body += `<td style="vertical-align:top;font-size:12px">${c.s ? '<b>'+c.s+'</b>' : '—'}${c.t ? '<br><small>'+c.t+'</small>' : ''}</td>`;
            }
            body += '</tr>';
        });
        const heads = [1,2,3,4,5,6].map(p => `<th>P${p}<br><small>${times[p]}</small></th>`).join('');
        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Timetable PDF</title>
<style>body{font-family:Segoe UI,sans-serif;padding:20px}h1{color:#1f4e79;text-align:center}table{width:100%;border-collapse:collapse}th,td{border:1px solid #94a3b8;padding:8px;text-align:center}th{background:#1f4e79;color:#fff}
@media print{.no-print{display:none}body{padding:0}}</style></head><body>
<p class="no-print" style="text-align:center"><button onclick="window.print()" style="padding:12px 18px;background:#2980b9;color:#fff;border:none;border-radius:8px;font-weight:bold">🖨️ Print / Save PDF</button></p>
<h1>Weekly Timetable ${cls ? ('— ' + cls) : ''}</h1>
<table><tr><th>Day</th>${heads}</tr>${body}</table>
</body></html>`);
    });
});

app.get('/api/timetable', (req, res) => {
    const cls = req.query.class || '';
    db.all(`SELECT * FROM timetable ORDER BY day_of_week, period_no`, [], (e, rows) => {
        rows = rows || [];
        if (cls) rows = rows.filter(r => !r.class_level || r.class_level === cls || isClassMatch(r.class_level, cls));
        // Also return grid shape for Excel UI
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
        const grid = {};
        days.forEach(d => { grid[d] = {}; for (let p = 1; p <= 6; p++) grid[d][p] = { subject: '', teacher: '', room: '' }; });
        rows.forEach(r => {
            if (grid[r.day_of_week] && r.period_no >= 1 && r.period_no <= 6) {
                grid[r.day_of_week][r.period_no] = { subject: r.subject || '', teacher: r.teacher_name || '', room: r.room || '' };
            }
        });
        const periodTimes = {
            1: '8:00–8:45', 2: '8:45–9:30', 3: '9:30–10:15',
            4: '10:15–11:00', 5: '11:00–11:45', 6: '11:45–12:30'
        };
        res.json({ rows, grid, periodTimes, breakNote: 'Break 4:00–4:15 (15 min) for afternoon sessions' });
    });
});

// 11 Report card PDF
app.get('/report-card/:studentId', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId && req.session.studentId !== req.params.studentId && req.session.parentStudentId !== req.params.studentId) {
        return res.redirect('/');
    }
    const sid = req.params.studentId;
    db.get(`SELECT * FROM students WHERE student_id=?`, [sid], (e, st) => {
        if (!st) return res.status(404).send('Not found');
        db.all(`SELECT * FROM course_assessments WHERE student_id=?`, [sid], (e2, grades) => {
            grades = grades || [];
            const doc = new PDFDocument({ margin: 50 });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=ReportCard_${sid}.pdf`);
            doc.pipe(res);
            doc.fontSize(18).text('AMANUEL LIGHT & LIFE SCHOOL', { align: 'center' });
            doc.fontSize(14).text('Student Report Card', { align: 'center' });
            doc.moveDown();
            doc.fontSize(11).text(`Name: ${st.name}`);
            doc.text(`ID: ${st.student_id}   Class: ${st.class_level || ''}`);
            doc.text(`Date: ${getFormattedTimestamp()}`);
            doc.moveDown();
            doc.fontSize(10).text('Course                          Q    A    P    Mid  Fin  Total');
            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            grades.forEach(g => {
                const line = `${(g.course_code||'').padEnd(12)} ${(g.course_title||'').substring(0,18).padEnd(18)} ${g.quiz||0}  ${g.assignment||0}  ${g.project||0}  ${g.mid||0}  ${g.final||0}  ${g.total||0}`;
                doc.text(line);
            });
            if (!grades.length) doc.text('No grades recorded yet.');
            doc.moveDown(2);
            doc.text('Director signature: ____________________', { align: 'left' });
            doc.end();
        });
    });
});

// 14 Backup export — safe per-table (missing tables skipped)
app.get('/admin/backup-export', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const out = {
        meta: {
            school: 'Amanuel Light & Life School',
            exported_at: getFormattedTimestamp(),
            version: 1
        }
    };
    const tables = [
        'students', 'pending_students', 'teachers', 'courses', 'sections',
        'course_assessments', 'notifications', 'notification_reads',
        'fee_ledger', 'timetable', 'announcements', 'homework',
        'homework_submissions', 'library_items', 'quizzes', 'quiz_attempts',
        'lesson_plans', 'absence_requests', 'daily_attendance',
        'grade_submissions', 'activity_log', 'chat_messages', 'sms_logs'
    ];
    let i = 0;
    const next = () => {
        if (i >= tables.length) {
            try {
                const body = JSON.stringify(out, null, 2);
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Disposition', 'attachment; filename="alls_backup.json"');
                res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
                return res.status(200).send(body);
            } catch (err) {
                return res.status(500).send('Backup failed: ' + (err.message || err));
            }
        }
        const t = tables[i++];
        db.all(`SELECT * FROM ${t}`, [], (e, rows) => {
            if (e) {
                out[t] = { error: String(e.message || e), rows: [] };
            } else {
                out[t] = rows || [];
            }
            next();
        });
    };
    next();
});

// 8 SMS trigger helper already exists - fire on approve
// (hook already can use logActivity; enhance approve)

// 4 Progress data API for charts
app.get('/api/student-progress/:id', (req, res) => {
    const sid = req.params.id;
    if (!req.session.isAdmin && !req.session.teacherId && req.session.studentId !== sid && req.session.parentStudentId !== sid) {
        return res.status(401).json({ labels: [], data: [] });
    }
    db.all(`SELECT course_code, total FROM course_assessments WHERE student_id=?`, [sid], (e, rows) => {
        rows = rows || [];
        res.json({ labels: rows.map(r => r.course_code || ''), data: rows.map(r => Number(r.total) || 0) });
    });
});

// Learning hub page (shared)
app.get('/learning-hub', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId && !req.session.studentId && !req.session.parentStudentId) return res.redirect('/');
    const hubSid = req.session.studentId || req.session.parentStudentId || '';
    res.send(`<!DOCTYPE html><html lang="am"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Learning Hub - ALLS</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
body{font-family:Segoe UI,sans-serif;background:#eef2f5;margin:0;padding:16px;color:#333}
.wrap{max-width:960px;margin:auto}
.card{background:#fff;border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:0 4px 12px rgba(0,0,0,.06);border-top:4px solid #2980b9}
h2{color:#1f4e79;margin-top:0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #e0e0e0;padding:8px;text-align:left}
th{background:#1f4e79;color:#fff}
input,select,textarea,button{padding:8px;margin:4px 0;border-radius:6px;border:1px solid #ccc;width:100%;box-sizing:border-box}
button{background:#2980b9;color:#fff;border:none;font-weight:bold;cursor:pointer}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.tabs button{width:auto;padding:8px 14px;background:#64748b}
.tabs button.on{background:#1f4e79}
.hidden{display:none}
a{color:#2980b9}
</style></head><body><div class="wrap">
<h2>📚 Learning Hub / የትምህርት ማዕከል</h2>
<p><a href="javascript:history.back()">⬅️ Back</a></p>
<div class="tabs">
<button type="button" class="on" data-t="ann">📢 Announcements</button>
<button type="button" data-t="lib">📖 Library</button>
<button type="button" data-t="hw">📝 Homework</button>
<button type="button" data-t="quiz">❓ Quiz</button>
<button type="button" data-t="tt">📅 Timetable</button>
<button type="button" data-t="prog">📈 Progress</button>
<button type="button" data-t="exam">📝 Exams</button>
</div>
<div class="card panel" id="ann"><h3>Announcements</h3><div id="annList">Loading...</div></div>
<div class="card panel hidden" id="lib"><h3>Digital Library</h3><div id="libList">Loading...</div></div>
<div class="card panel hidden" id="hw"><h3>Homework</h3><div id="hwList">Loading...</div></div>
<div class="card panel hidden" id="quiz"><h3>Quizzes</h3><div id="quizList">Loading...</div></div>
<div class="card panel hidden" id="tt"><h3>Timetable</h3><div id="ttList">Loading...</div></div>
<div class="card panel hidden" id="prog"><h3>Progress</h3><canvas id="progChart" height="180"></canvas></div>
<div class="card panel hidden" id="exam"><h3>Exam Schedule</h3><div id="examHubList">Loading...</div></div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
window.STUDENT_ID=${JSON.stringify(hubSid)};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden'));
  document.getElementById(b.dataset.t).classList.remove('hidden');
});
fetch('/api/announcements').then(r=>r.json()).then(d=>{
  document.getElementById('annList').innerHTML=(d.rows||[]).map(a=>'<div style="border-bottom:1px solid #eee;padding:8px 0"><b>'+a.title+'</b><br><small>'+a.created_at+'</small><p>'+a.body+'</p></div>').join('')||'No announcements';
});
fetch('/api/library').then(r=>r.json()).then(d=>{
  document.getElementById('libList').innerHTML=(d.rows||[]).map(i=>'<div style="padding:8px 0;border-bottom:1px solid #eee"><b>'+i.title+'</b> ('+(i.category||'')+') — '+(i.class_level||'')+'<br>'+(i.file_path?'<a href="/uploads/'+i.file_path+'" target="_blank">Download</a>':'')+'</div>').join('')||'Empty library';
});
fetch('/api/homework').then(r=>r.json()).then(d=>{
  document.getElementById('hwList').innerHTML=(d.rows||[]).map(h=>'<div style="padding:8px 0;border-bottom:1px solid #eee"><b>'+h.title+'</b> — '+h.class_level+'<br>'+h.description+'<br><small>Due: '+(h.due_date||'-')+' | '+h.teacher_name+'</small></div>').join('')||'No homework';
});
fetch('/api/quizzes').then(r=>r.json()).then(d=>{
  const box=document.getElementById('quizList');
  box.innerHTML=(d.rows||[]).map(q=>
    '<div style="padding:12px;border:1px solid #ddd;border-radius:8px;margin-bottom:10px"><b>'+q.title+'</b> · '+q.class_level+' · '+q.count+' questions<br><small>'+(q.teacher_name||'')+'</small><br><a href="/quiz/'+q.id+'" style="display:inline-block;margin-top:8px;background:#2980b9;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:bold;">Start Quiz ▶️</a></div>'
  ).join('')||'No quizzes';
});
fetch('/api/exam-schedule').then(r=>r.json()).then(d=>{
  document.getElementById('examHubList').innerHTML='<table><tr><th>Date</th><th>Time</th><th>Class</th><th>Subject</th><th>Notes</th></tr>'
    +(d.rows||[]).map(x=>'<tr><td>'+(x.exam_date||'')+'</td><td>'+(x.exam_time||'')+'</td><td>'+(x.class_level||'')+'</td><td>'+(x.subject||'')+'</td><td>'+(x.notes||'')+'</td></tr>').join('')+'</table>';
}).catch(()=>{});
fetch('/api/timetable').then(r=>r.json()).then(d=>{
  var days=['Monday','Tuesday','Wednesday','Thursday','Friday'];
  var times={1:'8:00-8:45',2:'8:45-9:30',3:'9:30-10:15',4:'10:15-11:00',5:'11:00-11:45',6:'11:45-12:30'};
  var map={};
  (d.rows||[]).forEach(function(r){
    var day=r.day_of_week||'';
    var p=String(r.period_no||'');
    if(!map[day]) map[day]={};
    map[day][p]={s:r.subject||'',t:r.teacher_name||'',c:r.class_level||''};
  });
  var html='<div style="overflow-x:auto"><table style="font-size:12px;min-width:640px"><tr><th>Day</th>';
  for(var p=1;p<=6;p++) html+='<th>P'+p+'<br><small>'+(times[p]||'')+'</small></th>';
  html+='</tr>';
  days.forEach(function(day){
    html+='<tr><td style="font-weight:bold;background:#eef2ff">'+day+'</td>';
    for(var p=1;p<=6;p++){
      var c=(map[day]&&map[day][p])?map[day][p]:{s:'',t:''};
      html+='<td style="vertical-align:top;min-width:90px">'+(c.s?'<b>'+c.s+'</b>':'—')+(c.t?'<br><small style="color:#64748b">'+c.t+'</small>':'')+'</td>';
    }
    html+='</tr>';
  });
  html+='</table></div>';
  document.getElementById('ttList').innerHTML=html;
}).catch(function(){ document.getElementById('ttList').innerHTML='Failed to load'; });
fetch('/api/student-progress/'+encodeURIComponent((window.STUDENT_ID||''))).then(r=>r.json()).then(d=>{
  if(!d.labels||!d.labels.length) return;
  new Chart(document.getElementById('progChart'),{type:'bar',data:{labels:d.labels,datasets:[{label:'Total',data:d.data,backgroundColor:'#2980b9'}]},options:{scales:{y:{beginAtZero:true,max:100}}}});
}).catch(()=>{});
</script></body></html>`);
});


// ===== Features: Attendance report, Homework grade, Exam schedule, Restore, Certificate, Backup cron =====

// 2 Attendance report
app.get('/admin/attendance-report', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    const cls = (req.query.class || '').trim();
    const month = (req.query.month || new Date().toISOString().slice(0, 7)).trim(); // YYYY-MM
    db.all(`SELECT * FROM daily_attendance ORDER BY date DESC LIMIT 5000`, [], (e, rows) => {
        rows = rows || [];
        if (cls) rows = rows.filter(r => isClassMatch(r.class_level, cls) || String(r.class_level||'').includes(cls));
        if (month) rows = rows.filter(r => String(r.date||'').startsWith(month) || String(r.created_at||'').includes(month));
        // aggregate by student
        const map = {};
        rows.forEach(r => {
            const id = r.student_id || r.student_name || '?';
            if (!map[id]) map[id] = { student_id: r.student_id, name: r.student_name, class_level: r.class_level, present: 0, absent: 0, total: 0 };
            map[id].total++;
            if (String(r.status||'').toLowerCase().includes('present')) map[id].present++;
            else map[id].absent++;
        });
        const list = Object.values(map).sort((a,b) => (a.name||'').localeCompare(b.name||''));
        const tr = list.map(s => `<tr><td>${s.student_id||''}</td><td>${s.name||''}</td><td>${s.class_level||''}</td><td>${s.present}</td><td>${s.absent}</td><td>${s.total}</td><td>${s.total?Math.round(s.present/s.total*100):0}%</td></tr>`).join('')
            || '<tr><td colspan="7">No attendance data</td></tr>';
        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Attendance Report</title>
<style>body{font-family:Segoe UI,sans-serif;padding:16px;background:#eef2f5}table{width:100%;border-collapse:collapse;background:#fff}th,td{border:1px solid #ddd;padding:8px;font-size:13px}th{background:#1f4e79;color:#fff}
.card{background:#fff;padding:16px;border-radius:12px;max-width:960px;margin:auto}input,button{padding:8px;margin:4px}</style></head><body>
<div class="card"><h2>📋 Attendance Report</h2>
<form method="GET" action="/admin/attendance-report" style="margin-bottom:12px;">
<input name="class" placeholder="Class e.g. Grade 5A" value="${cls}">
<input name="month" type="month" value="${month}">
<button type="submit">Filter</button>
<a href="/admin">Admin</a> | <a href="/teacher-dashboard">Teacher</a>
</form>
<table><tr><th>ID</th><th>Name</th><th>Class</th><th>Present</th><th>Absent</th><th>Total</th><th>%</th></tr>${tr}</table>
</div></body></html>`);
    });
});

// 3 Homework grade
app.post('/teacher/homework-grade', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const { id, score, status } = req.body;
    db.run(`UPDATE homework_submissions SET score = ?, status = ? WHERE id = ?`,
        [parseFloat(score) || 0, status || 'graded', id],
        () => res.redirect('/teacher-dashboard#homework'));
});
app.get('/api/homework-submissions', (req, res) => {
    if (!req.session.teacherId && !req.session.isAdmin) return res.status(401).json({ rows: [] });
    db.all(`SELECT * FROM homework_submissions ORDER BY id DESC LIMIT 100`, [], (e, rows) => res.json({ rows: rows || [] }));
});

// 4 Exam schedule
app.post('/admin/exam-delete', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM exam_schedule WHERE id = ?`, [req.body.id], () => res.redirect('/admin#examSchedule'));
});
app.post('/admin/exam-edit', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { id, class_level, subject, exam_date, exam_time, notes } = req.body;
    db.run(`UPDATE exam_schedule SET class_level=?, subject=?, exam_date=?, exam_time=?, notes=? WHERE id=?`,
        [class_level||'', subject||'', exam_date||'', exam_time||'', notes||'', id],
        () => res.redirect('/admin#examSchedule'));
});
app.post('/admin/exam-schedule', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { class_level, subject, exam_date, exam_time, room, notes } = req.body;
    db.run(`INSERT INTO exam_schedule (class_level, subject, exam_date, exam_time, room, notes, created_at) VALUES (?,?,?,?,?,?,?)`,
        [class_level||'', subject||'', exam_date||'', exam_time||'', room||'', notes||'', getFormattedTimestamp()],
        () => res.redirect('/admin#examSchedule'));
});
app.get('/admin/exam-schedule-pdf', (req, res) => {
    if (!req.session.isAdmin && !req.session.teacherId) return res.redirect('/');
    db.all(`SELECT * FROM exam_schedule ORDER BY exam_date ASC, exam_time ASC LIMIT 200`, [], (e, rows) => {
        rows = rows || [];
        const tr = rows.map(x => `<tr><td>${x.exam_date||''}</td><td>${x.exam_time||''}</td><td>${x.class_level||''}</td><td>${x.subject||''}</td><td>${x.notes||''}</td></tr>`).join('')
            || '<tr><td colspan="5">No exams</td></tr>';
        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Exam Schedule PDF</title>
<style>
body{font-family:Segoe UI,sans-serif;padding:24px;color:#111}
h1{color:#1f4e79;text-align:center;margin:0 0 8px}
.sub{text-align:center;color:#64748b;margin-bottom:20px}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #cbd5e1;padding:10px;font-size:13px;text-align:left}
th{background:#1f4e79;color:#fff}
tr:nth-child(even){background:#f8fafc}
@media print{.no-print{display:none}}
</style></head><body>
<p class="no-print" style="text-align:center"><button onclick="window.print()" style="padding:12px 20px;background:#2980b9;color:#fff;border:none;border-radius:8px;font-weight:bold;font-size:15px">🖨️ Print / Save PDF</button> <a href="/admin">Admin</a></p>
<h1>Amanuel Light & Life School</h1>
<div class="sub">Exam Schedule</div>
<table><tr><th>Date</th><th>Time</th><th>Class</th><th>Subject</th><th>Notes</th></tr>${tr}</table>
<script>/* auto hint */</script>
</body></html>`);
    });
});

app.get('/api/exam-schedule', (req, res) => {
    db.all(`SELECT * FROM exam_schedule ORDER BY exam_date ASC, exam_time ASC LIMIT 100`, [], (e, rows) => res.json({ rows: rows || [] }));
});

// 8 Restore from backup
app.post('/admin/backup-restore', upload.single('backup'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    if (!req.file) return res.send('<h3>No file</h3><a href="/admin">Back</a>');
    const fs = require('fs');
    let data;
    try {
        data = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    } catch (e) {
        return res.send('<h3>Invalid JSON backup</h3><a href="/admin">Back</a>');
    }
    const skip = new Set(['meta']);
    const tables = Object.keys(data).filter(k => !skip.has(k) && Array.isArray(data[k]));
    let ti = 0;
    const nextTable = () => {
        if (ti >= tables.length) {
            logActivity('Admin', 'Director', 'BACKUP_RESTORE', 'tables=' + tables.length);
            return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>✅ Restore finished</h2><p>${tables.length} tables processed</p><a href="/admin">Admin</a></body></html>`);
        }
        const table = tables[ti++];
        const rows = data[table] || [];
        if (!rows.length || rows.error) return nextTable();
        // Insert row by row (best-effort; skip on error)
        let ri = 0;
        const nextRow = () => {
            if (ri >= rows.length) return nextTable();
            const row = rows[ri++];
            if (!row || typeof row !== 'object') return nextRow();
            const cols = Object.keys(row).filter(c => c !== 'id');
            if (!cols.length) return nextRow();
            const placeholders = cols.map(() => '?').join(',');
            const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
            db.run(sql, cols.map(c => row[c]), () => nextRow());
        };
        nextRow();
    };
    nextTable();
});

// 10 Certificate generator
app.get('/admin/certificate', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const sid = (req.query.student_id || '').trim();
    const loadForm = (student) => {
        const name = student ? (student.name || '') : '';
        const id = student ? (student.student_id || sid) : sid;
        const cls = student ? (student.class_level || '') : '';
        const photo = student ? (student.photo || '') : '';
        const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        res.send(`<!DOCTYPE html><html lang="am"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Certificate Designer</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
<style>
*{box-sizing:border-box}body{font-family:Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px}
@page{size:A4 landscape;margin:8mm}
@media print{
  body{background:#fff!important;padding:0!important}
  .panel,.no-print{display:none!important}
  .wrap{display:block!important;max-width:none!important}
  .stage{padding:0!important;background:#fff!important}
  .cert{box-shadow:none!important;width:277mm!important;min-height:180mm!important}
}
.wrap{max-width:1200px;margin:auto;display:grid;grid-template-columns:320px 1fr;gap:16px}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.panel{background:#1e293b;border-radius:12px;padding:16px;max-height:92vh;overflow:auto}
label{display:block;font-size:12px;color:#94a3b8;margin:8px 0 4px}
input,select,textarea{width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0}
button{width:100%;padding:12px;margin-top:10px;border:none;border-radius:8px;font-weight:bold;cursor:pointer;background:#2980b9;color:#fff}
button.gold{background:linear-gradient(135deg,#c9a227,#f0d77b);color:#1f2937}
button.sec{background:#475569}
.stage{overflow:auto;padding:8px}
.cert{
  width:297mm;min-height:200mm;margin:auto;position:relative;
  background:linear-gradient(145deg,#fffef8,#fff 45%,#f8fafc);color:#1e293b;
  border:12px solid #1f4e79;box-shadow:0 20px 50px rgba(0,0,0,.4);
  padding:28px 40px;text-align:center;
}
/* 12+ modern border styles */
.cert.b-classic{border:14px solid #1f4e79;outline:6px solid #c9a227;outline-offset:6px}
.cert.b-double{border:10px double #1f4e79}
.cert.b-gold{border:12px solid #c9a227;outline:4px solid #1f4e79;outline-offset:8px}
.cert.b-ribbon{border:8px solid #7c3aed;box-shadow:inset 0 0 0 6px #e9d5ff,0 20px 50px rgba(0,0,0,.35)}
.cert.b-elegant{border:3px solid #0f172a;outline:10px solid #e2e8f0;outline-offset:4px}
.cert.b-modern{border:none;box-shadow:0 0 0 12px #0ea5e9,0 0 0 18px #fff,0 0 0 22px #0ea5e9}
.cert.b-royal{border:16px ridge #7c3aed}
.cert.b-emerald{border:12px solid #059669;outline:5px dashed #6ee7b7;outline-offset:8px}
.cert.b-rose{border:12px solid #e11d48;outline:6px solid #fecdd3;outline-offset:6px}
.cert.b-navy{border:20px solid #0f172a;border-image:linear-gradient(135deg,#1e3a8a,#c9a227) 1}
.cert.b-soft{border:10px solid #cbd5e1;border-radius:24px}
.cert.b-stamp{border:8px solid #b45309;box-shadow:inset 0 0 0 4px #fde68a,0 12px 40px rgba(0,0,0,.3)}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;min-height:90px;gap:12px}
.topbar .slot{width:110px;height:110px;border:none;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:transparent;padding:0}
.topbar .slot.empty{border:1px dashed #cbd5e1;background:#f8fafc}
.topbar .slot img{width:100%;height:100%;object-fit:contain;display:block;border:none;outline:none;box-shadow:none}
.topbar .slot span{font-size:10px;color:#94a3b8;padding:4px;text-align:center}
.ornament{font-size:18px;color:#c9a227;letter-spacing:8px}
.school{font-size:14px;letter-spacing:3px;color:#1f4e79;font-weight:800;text-transform:uppercase}
.title{font-family:Georgia,serif;font-size:36px;color:#1f4e79;margin:8px 0;font-weight:bold}
.subtitle{font-size:14px;color:#64748b}
.name{font-family:Georgia,serif;font-size:32px;color:#b45309;margin:12px 0;font-weight:bold;border-bottom:2px solid #c9a227;display:inline-block;padding:0 12px 6px}
.body{font-size:15px;line-height:1.6;color:#334155;max-width:88%;margin:8px auto}
.meta{font-size:13px;color:#475569;margin-top:6px}
.seal{display:inline-block;margin-top:10px;width:64px;height:64px;border-radius:50%;border:3px solid #c9a227;line-height:58px;font-weight:800;color:#1f4e79;font-size:12px}
.sigs{display:flex;justify-content:space-between;margin-top:28px;padding:0 40px}
.sig{width:40%;border-top:1px solid #94a3b8;padding-top:6px;font-size:12px;color:#64748b}
h1{font-size:18px;margin:0 0 8px;color:#f8fafc}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
</style></head><body>
<div class="wrap">
<div class="panel no-print">
<h1>🎓 Certificate Designer</h1>
<form method="GET" action="/admin/certificate">
<label>Load student / teacher ID</label>
<input name="student_id" value="${esc(id)}" placeholder="ID">
<label>Type</label>
<select name="person_type"><option value="student">Student</option><option value="teacher">Teacher</option></select>
<button type="submit">Load</button>
</form>
<hr style="border-color:#334155;margin:14px 0">
<label>🏫 School / Org logo (left)</label>
<input type="file" id="logoFile" accept="image/*">
<label>📷 Person photo (right)</label>
<input type="file" id="photoFile" accept="image/*">
<label>Or photo URL</label>
<input id="fPhoto" value="${esc(photo)}" oninput="sync()" placeholder="https://... or /uploads/...">
<label>School name</label>
<input id="fSchool" value="AMANUEL LIGHT & LIFE SCHOOL" oninput="sync()">
<label>Title</label>
<input id="fTitle" value="Certificate of Completion" oninput="sync()">
<label>Subtitle</label>
<input id="fSub" value="This is proudly presented to" oninput="sync()">
<label>Person type label</label>
<input id="fPersonType" value="Student" oninput="sync()">
<label>Full name</label>
<input id="fName" value="${esc(name)}" oninput="sync()">
<label>Body text</label>
<textarea id="fBody" rows="3" oninput="sync()">for successfully completing the academic requirements of class ${esc(cls)||'—'} with dedication and excellence.</textarea>
<label>Meta line</label>
<input id="fMeta" value="ID: ${esc(id)||'—'}  ·  Class: ${esc(cls)||'—'}" oninput="sync()">
<label>Date line</label>
<input id="fDate" value="${esc(getFormattedTimestamp())}" oninput="sync()">
<label>Signature left</label>
<input id="fSig1" value="Director" oninput="sync()">
<label>Signature right</label>
<input id="fSig2" value="School Seal" oninput="sync()">
<div class="row2">
<div><label>Title size</label><input id="fTitleSize" type="number" value="36" min="18" max="64" oninput="sync()"></div>
<div><label>Name size</label><input id="fNameSize" type="number" value="32" min="16" max="56" oninput="sync()"></div>
</div>
<div class="row2">
<div><label>Body size</label><input id="fBodySize" type="number" value="15" min="10" max="28" oninput="sync()"></div>
<div><label>Title color</label><input id="fTitleColor" type="color" value="#1f4e79" oninput="sync()"></div>
</div>
<div class="row2">
<div><label>Name color</label><input id="fNameColor" type="color" value="#b45309" oninput="sync()"></div>
<div><label><input id="fBoldName" type="checkbox" checked onchange="sync()"> Bold name</label></div>
</div>
<label>Font</label>
<select id="fFont" onchange="sync()">
<option value="Georgia, serif">Georgia</option>
<option value="Times New Roman, serif">Times</option>
<option value="Garamond, serif">Garamond</option>
<option value="Palatino Linotype, serif">Palatino</option>
<option value="Segoe UI, sans-serif">Segoe UI</option>
<option value="Trebuchet MS, sans-serif">Trebuchet</option>
</select>
<label>🎨 Border style (12 modern)</label>
<select id="fBorderStyle" onchange="sync()">
<option value="b-classic">1. Classic Gold Outline</option>
<option value="b-double">2. Double Line</option>
<option value="b-gold">3. Gold Frame</option>
<option value="b-ribbon">4. Purple Ribbon</option>
<option value="b-elegant">5. Elegant Grey</option>
<option value="b-modern">6. Modern Cyan</option>
<option value="b-royal">7. Royal Ridge</option>
<option value="b-emerald">8. Emerald Dash</option>
<option value="b-rose">9. Rose Accent</option>
<option value="b-navy">10. Navy Strong</option>
<option value="b-soft">11. Soft Rounded</option>
<option value="b-stamp">12. Stamp / Wax</option>
</select>
<label>Theme tint</label>
<select id="fTheme" onchange="sync()">
<option value="">Default</option>
<option value="theme-blue">Blue</option>
<option value="theme-green">Green</option>
<option value="theme-royal">Royal</option>
</select>
<button type="button" class="gold" onclick="downloadPdf()">📥 Download Full-Page PDF</button>
<button type="button" class="sec" onclick="window.print()">🖨️ Print Full Page</button>
<p style="font-size:12px;margin-top:12px"><a href="/admin" style="color:#93c5fd">← Admin</a></p>
</div>
<div class="stage">
<div class="cert b-classic" id="cert">
  <div class="topbar">
    <div class="slot empty" id="logoSlot"><span>Org Logo</span><img id="cLogo" alt="" style="display:none"></div>
    <div style="flex:1;padding:0 12px">
      <div class="ornament">✦ ◆ ✦</div>
      <div class="school" id="cSchool">AMANUEL LIGHT & LIFE SCHOOL</div>
    </div>
    <div class="slot empty" id="photoSlot"><span>Photo</span><img id="cPhoto" alt="" style="display:none"></div>
  </div>
  <div class="title" id="cTitle">Certificate of Completion</div>
  <div class="subtitle" id="cSub">This is proudly presented to</div>
  <div class="meta" id="cPersonType">Student</div>
  <div class="name" id="cName">${esc(name)||'Student Name'}</div>
  <div class="body" id="cBody">for successfully completing the academic requirements of class ${esc(cls)||'—'} with dedication and excellence.</div>
  <div class="meta" id="cMeta">ID: ${esc(id)||'—'}  ·  Class: ${esc(cls)||'—'}</div>
  <div class="seal">ALLS</div>
  <div class="meta" id="cDate">${esc(getFormattedTimestamp())}</div>
  <div class="sigs"><div class="sig"><div id="cSig1">Director</div></div><div class="sig"><div id="cSig2">School Seal</div></div></div>
</div>
</div>
</div>
<script>
function readFileTo(imgId, fileInput){
  var f=fileInput.files&&fileInput.files[0];
  if(!f) return;
  var r=new FileReader();
  r.onload=function(){
    var img=document.getElementById(imgId);
    var slot=img.parentNode;
    img.src=r.result;
    img.style.display='block';
    img.style.border='none';
    img.style.outline='none';
    var span=slot.querySelector('span');
    if(span) span.style.display='none';
    slot.classList.remove('empty');
    slot.style.border='none';
    slot.style.background='transparent';
  };
  r.readAsDataURL(f);
}
document.getElementById('logoFile').addEventListener('change', function(){ readFileTo('cLogo', this); });
document.getElementById('photoFile').addEventListener('change', function(){ readFileTo('cPhoto', this); });
function sync(){
  var c=document.getElementById('cert');
  var border=document.getElementById('fBorderStyle').value||'b-classic';
  var theme=document.getElementById('fTheme').value||'';
  c.className='cert '+border+(theme?(' '+theme):'');
  ['School','Title','Sub','Name','Body','Meta','Date','Sig1','Sig2','PersonType'].forEach(function(k){
    var f=document.getElementById('f'+k), el=document.getElementById('c'+k);
    if(f&&el) el.textContent=f.value||'';
  });
  var ph=document.getElementById('fPhoto');
  var img=document.getElementById('cPhoto');
  if(ph&&img&&ph.value&&!(document.getElementById('photoFile').files||[]).length){
    img.src=ph.value; img.style.display='block'; img.style.border='none';
    var slot=img.parentNode; slot.classList.remove('empty'); slot.style.border='none'; slot.style.background='transparent';
    var span=slot.querySelector('span'); if(span) span.style.display='none';
  }
  var font=document.getElementById('fFont');
  if(font) c.style.fontFamily=font.value;
  var ts=document.getElementById('fTitleSize');
  var ns=document.getElementById('fNameSize');
  var bs=document.getElementById('fBodySize');
  var tc=document.getElementById('fTitleColor');
  var nc=document.getElementById('fNameColor');
  var bn=document.getElementById('fBoldName');
  var cTitle=document.getElementById('cTitle');
  var cName=document.getElementById('cName');
  var cBody=document.getElementById('cBody');
  if(cTitle&&ts){ cTitle.style.fontSize=(ts.value||36)+'px'; if(tc) cTitle.style.color=tc.value; }
  if(cName&&ns){ cName.style.fontSize=(ns.value||32)+'px'; if(nc) cName.style.color=nc.value; cName.style.fontWeight=(bn&&bn.checked)?'bold':'normal'; }
  if(cBody&&bs) cBody.style.fontSize=(bs.value||15)+'px';
}
function downloadPdf(){
  var el=document.getElementById('cert');
  el.style.width='297mm'; el.style.minHeight='200mm'; el.style.maxWidth='none';
  var name=(document.getElementById('fName')&&document.getElementById('fName').value)||'student';
  html2pdf().set({
    margin:0,
    filename:'Certificate_'+String(name).replace(/\\s+/g,'_')+'.pdf',
    image:{type:'jpeg',quality:1},
    html2canvas:{scale:2,useCORS:true,backgroundColor:'#ffffff',scrollX:0,scrollY:0,width:el.scrollWidth,height:el.scrollHeight},
    jsPDF:{unit:'mm',format:'a4',orientation:'landscape'},
    pagebreak:{mode:['avoid-all']}
  }).from(el).save().catch(function(){ window.print(); });
}
sync();
</script></body></html>`);
    };
    if (!sid) return loadForm(null);
    const ptype = (req.query.person_type || 'student').toLowerCase();
    if (ptype === 'teacher') {
        db.get(`SELECT * FROM teachers WHERE UPPER(id)=UPPER(?) OR UPPER(name)=UPPER(?)`, [sid, sid], (e, t) => {
            if (t) loadForm({ name: t.name, student_id: t.id, class_level: t.subject || 'Teacher', photo: t.photo });
            else loadForm(null);
        });
    } else {
        db.get(`SELECT * FROM students WHERE UPPER(student_id)=UPPER(?)`, [sid], (e, student) => loadForm(student || null));
    }
});


// 12 Auto daily backup to folder (runs every 24h after start)
const fsBackup = require('fs');
const pathBackup = require('path');
const BACKUP_DIR = pathBackup.join(__dirname, 'backups');
try { if (!fsBackup.existsSync(BACKUP_DIR)) fsBackup.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
function runDailyBackup() {
    const tables = ['students','teachers','courses','sections','course_assessments','notifications','fee_ledger','timetable','announcements','pending_students'];
    const out = { meta: { exported_at: new Date().toISOString(), auto: true } };
    let i = 0;
    const next = () => {
        if (i >= tables.length) {
            try {
                const fname = 'auto_' + new Date().toISOString().slice(0,10) + '.json';
                fsBackup.writeFileSync(pathBackup.join(BACKUP_DIR, fname), JSON.stringify(out, null, 2));
                // keep last 14 files
                const files = fsBackup.readdirSync(BACKUP_DIR).filter(f => f.startsWith('auto_')).sort();
                while (files.length > 14) {
                    try { fsBackup.unlinkSync(pathBackup.join(BACKUP_DIR, files.shift())); } catch(e){}
                }
            } catch (e) { console.error('auto backup', e.message); }
            return;
        }
        const t = tables[i++];
        db.all(`SELECT * FROM ${t}`, [], (e, rows) => { out[t] = e ? [] : (rows||[]); next(); });
    };
    next();
}
setTimeout(runDailyBackup, 30 * 1000);
setInterval(runDailyBackup, 24 * 60 * 60 * 1000);


const httpServer = require('http').createServer(app);
try {
    const { Server } = require('socket.io');
    io = new Server(httpServer, { cors: { origin: false } });
    io.on('connection', (socket) => {
        socket.on('join', (room) => { if (room) socket.join(String(room)); });
        socket.on('chat', (msg) => {
            if (!msg || !msg.room) return;
            const payload = {
                room: String(msg.room),
                text: String(msg.text || '').slice(0, 2000),
                from: String(msg.from || 'user').slice(0, 80),
                at: new Date().toISOString()
            };
            db.run(`INSERT INTO chat_messages (room, sender_role, sender_name, message, created_at) VALUES (?,?,?,?,?)`,
                [payload.room, 'user', payload.from, payload.text, getFormattedTimestamp()], () => {
                    io.to(payload.room).emit('chat', payload);
                });
        });
    });
    console.log('Socket.io ready');
} catch (e) {
    console.log('Socket.io not installed — chat uses polling. npm i socket.io');
}

// Seed demo quiz if none exist
async function seedDemoQuiz() {
    try {
        const r = await pool.query('SELECT COUNT(*)::int AS c FROM quizzes');
        if ((r.rows[0] && r.rows[0].c) > 0) return;
        const qs = [
            { q: 'What is 2 + 2?', type: 'mcq', options: { A: '3', B: '4', C: '5', D: '6' }, a: 'B', desc: '2+2=4' },
            { q: 'What is 5 × 3?', type: 'mcq', options: { A: '8', B: '15', C: '10', D: '20' }, a: 'B', desc: '5×3=15' },
            { q: 'What is 10 − 4?', type: 'mcq', options: { A: '5', B: '6', C: '7', D: '8' }, a: 'B', desc: '10−4=6' },
            { q: 'What is 12 ÷ 3?', type: 'mcq', options: { A: '2', B: '3', C: '4', D: '6' }, a: 'C', desc: '12÷3=4' },
            { q: 'What is 7 + 8?', type: 'mcq', options: { A: '14', B: '15', C: '16', D: '13' }, a: 'B', desc: '7+8=15' }
        ];
        await pool.query(
            `INSERT INTO quizzes (teacher_id, teacher_name, class_level, title, questions_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
            ['DEMO', 'System', 'ALL', 'Demo Math Quiz (5 questions)', JSON.stringify(qs), new Date().toISOString()]
        );
        console.log('DEMO_MATH_QUIZ seeded');
        const ec = await pool.query('SELECT COUNT(*)::int AS c FROM exam_schedule');
        if ((ec.rows[0] && ec.rows[0].c) === 0) {
            const demos = [
                ['Grade 8A', 'Mathematics', '2026-11-10', '09:00', 'Mid-term'],
                ['Grade 8A', 'English', '2026-11-12', '09:00', 'Mid-term'],
                ['Grade 9B', 'Physics', '2026-11-11', '10:30', 'Mid-term'],
                ['Grade 10A', 'Chemistry', '2026-11-13', '09:00', 'Final practice']
            ];
            for (const d of demos) {
                await pool.query(
                    `INSERT INTO exam_schedule (class_level, subject, exam_date, exam_time, notes) VALUES ($1,$2,$3,$4,$5)`,
                    d
                );
            }
            console.log('DEMO_EXAM_SCHEDULE seeded');
        }
    } catch (e) { console.error('seed demo quiz', e.message); }
}

setTimeout(function(){ seedDemoQuiz(); }, 3000);
httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
