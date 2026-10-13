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
        await pool.query(`CREATE TABLE IF NOT EXISTS calendar_events (
            id SERIAL PRIMARY KEY, title TEXT, event_date TEXT, description TEXT
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

app.get('/student-register', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    let gradeOptions = '';
    for(let i=1; i<=12; i++) gradeOptions += `<option value="Grade ${i}">Grade ${i}</option>`;
    res.send(`<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><title>Student Registration</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 py-10 px-4"><div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl p-8"><h2 class="text-2xl font-bold text-center mb-6">አዲስ ተማሪ ምዝገባ</h2><form action="/api/register?lang=${lang}" method="POST" enctype="multipart/form-data" class="space-y-4"><input type="text" name="name" placeholder="ሙሉ ስም" required class="w-full p-2 border rounded"><input type="text" name="mother_name" placeholder="የእናት ስም" required class="w-full p-2 border rounded"><select name="gender" class="w-full p-2 border rounded"><option value="Male">ወንድ</option><option value="Female">ሴት</option></select><input type="number" name="age" placeholder="ዕድሜ" required class="w-full p-2 border rounded"><input type="text" name="phone" placeholder="ስልክ ቁጥር" required class="w-full p-2 border rounded"><input type="text" name="emergency_phone" placeholder="የአደጋ ጊዜ ስልክ" required class="w-full p-2 border rounded"><input type="text" name="region" placeholder="ክልል" required class="w-full p-2 border rounded"><input type="text" name="zone" placeholder="ዞን" required class="w-full p-2 border rounded"><input type="text" name="woreda" placeholder="ወረዳ" required class="w-full p-2 border rounded"><input type="text" name="kebele" placeholder="ቀበሌ" required class="w-full p-2 border rounded"><select name="year_level" class="w-full p-2 border rounded">${gradeOptions}</select><input type="file" name="student_photo" accept="image/*" required class="w-full p-2 border rounded"><input type="text" name="txn_id" placeholder="Transaction ID" class="w-full p-2 border rounded"><button type="submit" class="w-full bg-green-600 text-white font-bold p-3 rounded">ምዝገባ ላክ</button></form></div></body></html>`);
});

app.post('/api/register', upload.fields([{ name: 'student_photo', maxCount: 1 }]), (req, res) => {
    const lang = req.query.lang || 'am';
    let { name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, year_level, txn_id } = req.body;
    let autoID = generateStudentID();
    let autoPIN = generate4DigitPIN();
    let hashedPIN = bcrypt.hashSync(autoPIN, 10);
    assignClassSection(year_level, (assignedSection) => {
        let photoPath = (req.files && req.files['student_photo']) ? req.files['student_photo'][0].filename : '';
        db.run(`INSERT INTO pending_students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [autoID, hashedPIN, xss(name), xss(mother_name), gender, age, phone, emergency_phone, region, zone, woreda, kebele, assignedSection, 'txn_id', xss(txn_id || ''), photoPath], () => {
            res.send(`<script>alert('ተሳክቷል! ID: ${autoID} | PIN: ${autoPIN}'); window.location.href='/';</script>`);
        });
    });
});

// ================= DASHBOARDS =================
app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT * FROM pending_students`, [], (err, pending) => {
        db.all(`SELECT * FROM students`, [], (err, students) => {
            db.all(`SELECT * FROM teachers`, [], (err, teachers) => {
                db.all(`SELECT * FROM sections`, [], (err, sections) => {
                    db.all(`SELECT * FROM notifications WHERE sender_role = 'Admin' ORDER BY id DESC`, [], (err, adminNotifs) => {
                        let pRows = pending.map(s => `<tr><td>${s.student_id}</td><td>${s.name}</td><td><a href="/admin/approve/${s.id}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`).join('');
                        let adminNotiRows = adminNotifs.map(n => `<div style="background:#fdf2e9; padding:10px; margin-bottom:10px; border-radius:5px;"><strong>🔔 ${n.sender_name} (${n.created_at})</strong><br><div>${n.message}</div></div>`).join('');
                        
                        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Dashboard</title><style>body{font-family:sans-serif; padding:20px; background:#f4f7f6;}.card{background:white; padding:20px; border-radius:8px; margin-bottom:20px;}</style></head><body>
                        <h2>👑 የአድሚን መቆጣጠሪያ ፓነል</h2><a href="/logout" style="color:red; font-weight:bold;">ውጣ (Logout)</a>
                        
                        <div class="card" style="background: #f9fbfd; border: 1px solid #cbd5e1;">
                            <h3 style="color: #1f4e79; margin-top: 0;">📢 አዲስ ማስታወቂያ መለጠፊያ</h3>
                            <form action="/admin/save-notice" method="POST" enctype="multipart/form-data">
                                <label>ለማን ይድረስ?</label>
                                <select name="target_audience" style="width:100%; padding:8px; margin-bottom:10px;"><option value="ALL">ለሁሉም</option><option value="Grade 1"> Grade 1</option></select>
                                <label>መልዕክት:</label>
                                <textarea name="message" rows="3" required style="width:100%; padding:8px; margin-bottom:10px;"></textarea>
                                <label>ፋይል ማያያዥ (ካለ):</label>
                                <input type="file" name="attachment" style="margin-bottom:10px; display:block;">
                                <button type="submit" style="background:#27ae60; color:white; border:none; padding:8px 15px; border-radius:5px; font-weight:bold; cursor:pointer;">ማስታወቂያ ለቀቅ</button>
                            </form>
                        </div>

                        <div class="card"><h3>⏳ የሚጠባበቁ ምዝገባዎች</h3><table border="1" width="100%" style="border-collapse:collapse; text-align:center;"><tr><th>ID</th><th>ስም</th><th>እርምጃ</th></tr>${pRows||'<tr><td colspan="3">ምንም የለም</td></tr>'}</table></div>
                        <div class="card"><h3>📢 የተለቀቁ ማስታወቂያዎች</h3>${adminNotiRows||'<p>ምንም ማስታወቂያ የለም</p>'}</div>
                        </body></html>`);
                    });
                });
            });
        });
    });
});

app.post('/admin/save-notice', upload.single('attachment'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    let { message, target_audience } = req.body;
    let attachment = req.file ? req.file.filename : null;
    let createdAt = new Date().toISOString().split('T')[0];
    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ['Admin', 'School Admin', target_audience || 'ALL', message, attachment, createdAt], () => res.redirect('/admin'));
});

app.get('/admin/approve/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM pending_students WHERE id = ?`, [req.params.id], (err, st) => {
        if (!st) return res.redirect('/admin');
        db.run(`INSERT INTO students (student_id, password, name, mother_name, gender, age, phone, emergency_phone, region, zone, woreda, kebele, class_level, payment_type, bank_slip_val, photo, status, admin_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [st.student_id, st.password, st.name, st.mother_name, st.gender, st.age, st.phone, st.emergency_phone, st.region, st.zone, st.woreda, st.kebele, st.class_level, st.payment_type, st.bank_slip_val, st.photo, 'Approved', 'Approved'], () => {
            db.run(`DELETE FROM pending_students WHERE id = ?`, [req.params.id], () => res.redirect('/admin'));
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
                    let notiRows = myNotifs.map(n => `<div style="background:#fff; padding:15px; margin-bottom:12px; border-radius:8px; border-left:4px solid #3498db;"><strong>🔔 ${n.sender_name}</strong><br>${n.message}${n.attachment ? `<br><a href="/uploads/${n.attachment}" target="_blank">📎 ፋይል ክፈት</a>` : ''}</div>`).join('');
                    
                    let gradesHtml = myCourses.map(c => {
                        let asm = myGrades.find(a => a.course_code === c.code) || {};
                        let total = (asm.quiz || 0) + (asm.mid || 0) + (asm.final || 0);
                        return `<tr><td>${c.code}</td><td>${c.title}</td><td>${total}</td></tr>`;
                    }).join('');

                    res.render('student', { lang: 'am', student, gradesHtml, notiRows, myAbsRows: '' });
                });
            });
        });
    });
});

app.get('/student/digital-id', (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    db.get('SELECT * FROM students WHERE student_id = ?', [req.session.studentId], (err, student) => {
        if (!student) return res.redirect('/');
        res.send(`<!DOCTYPE html><html lang="am"><head><meta charset="UTF-8"><title>Digital ID</title><style>body{font-family:sans-serif; background:#eef2f5; display:flex; justify-content:center; align-items:center; height:100vh;}.id-card{width:380px; background:white; border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,0.15); overflow:hidden; border:2px solid #1f4e79;}.header{background:#1f4e79; color:white; padding:12px; display:flex; align-items:center; gap:10px;}.content{padding:18px; display:flex; gap:15px; align-items:center;}.profile-img{width:95px; height:95px; border-radius:8px; object-fit:cover;}.btn{display:block; width:100%; background:#27ae60; color:white; border:none; padding:10px; font-weight:bold; cursor:pointer; text-align:center; text-decoration:none;}@media print{.actions{display:none;}}</style></head><body><div class="id-card"><div class="header"><h3>AMANUEL SCHOOL</h3></div><div class="content"><img src="/uploads/${student.photo || 'default.png'}" onerror="this.src='/uploads/logo.jpg'" class="profile-img"><div><h3>${student.name}</h3><p>ID: ${student.student_id}</p><p>Class: ${student.class_level}</p></div></div><div class="actions"><button onclick="window.print()" class="btn">📥 Download PDF</button></div></div></body></html>`);
    });
});

app.post('/student/update-photo', upload.single('new_photo'), (req, res) => {
    if (!req.session.studentId) return res.redirect('/');
    if (req.file) {
        db.run('UPDATE students SET photo = ? WHERE student_id = ?', [req.file.filename, req.session.studentId], () => res.redirect('/student-dashboard'));
    } else { res.redirect('/student-dashboard'); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
