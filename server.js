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
function generate4DigitPIN() { return Math.floor(1000 + Math.random() * 9000).toString(); }

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

// ================= PUBLIC ROUTES =================
app.get('/', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'am';
    const error = req.query.error;
    res.render('login', { lang, error });
});

app.post('/login', (req, res) => {
    const lang = req.query.lang || 'am';
    const { role, username, password } = req.body;
    const uKey = (username || '').trim();

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

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ================= ADMIN DASHBOARD =================
app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const lang = req.query.lang || 'am';

    db.all(`SELECT * FROM pending_students`, [], (err, pending = []) => {
        db.all(`SELECT student_id, name, class_level, phone, password, status, gender FROM students ORDER BY class_level, name`, [], (err, students = []) => {
            db.all(`SELECT * FROM teachers`, [], (err, teachers = []) => {
                db.all(`SELECT * FROM sections ORDER BY name`, [], (err, sections = []) => {
                    db.all(`SELECT * FROM courses ORDER BY class_level, code`, [], (err, courses = []) => {
                        db.all(`SELECT * FROM notifications WHERE sender_role = 'Admin' ORDER BY id DESC`, [], (err, adminNotifs = []) => {

                            let pRows = pending.map(s => `<tr><td>-</td><td>${s.student_id}</td><td>${s.name}</td><td>${s.payment_type === 'slip_file' || (s.bank_slip_val && s.bank_slip_val.includes('.')) ? `<a href="/uploads/${s.bank_slip_val}" target="_blank" style="color:#2980b9;">📄 እይ</a>` : `<b>TXN:</b> ${s.bank_slip_val || '-'}`}</td><td><a href="/admin/approve/${s.id}?lang=${lang}" style="color:green; font-weight:bold;">✅ Approve</a></td></tr>`).join('');
                            let secRows = sections.map(sec => `<tr><td>${sec.name}</td><td>${sec.proctor_name || '-'}</td><td><a href="/admin/delete-section/${sec.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑 Delete</a></td><td><a href="/attendance-sheet/${encodeURIComponent(sec.name)}" style="color:#2980b9; font-weight:bold;" target="_blank">📋 Attendance</a></td></tr>`).join('');

                            let sectionOptions = sections.map(sec => `<option value="${sec.name}">${sec.name}</option>`).join('');
                            let teacherOptions = teachers.map(tc => `<option value="${tc.id}">${tc.name}</option>`).join('');
                            let cRows = courses.map(c => `<tr><td>${c.code}</td><td>${c.title}</td><td>${c.class_level}</td><td>${c.teacher_name||'-'}</td><td><a href="/admin/delete-course/${c.id}?lang=${lang}" onclick="return confirm('Delete?')" style="color:red; font-weight:bold;">🗑️ Delete</a></td></tr>`).join('');
                            let tRows = teachers.map(tc => `<tr><td>${tc.id}</td><td style="text-align:left;">${tc.name}</td><td>${tc.assigned_sections || 'None'}</td><td><span style="color:#d35400; font-weight:bold;">${tc.plain_pin || '[Hashed]'}</span></td><td><a href="/admin/delete-teacher/${tc.id}?lang=${lang}" onclick="return confirm('Remove?')" style="color:red; font-weight:bold;">🗑️ Remove</a></td></tr>`).join('');
                            let adminNotiRows = adminNotifs.map(n => `<div style="background:#fdf2e9; padding:15px; margin-bottom:15px; border-radius:8px; border:1px solid #e67e22;"><strong>🔔 ${n.sender_name} (${n.created_at})</strong><br><div style="margin-top:10px;">${n.message}</div>${n.attachment ? `<br><a href="/uploads/${n.attachment}" target="_blank" style="color:blue; font-weight:bold;">📎 ፋይል ክፈት</a>` : ''}</div>`).join('');

                            res.render('admin', {
                                lang, pRows, secRows, cRows, tRows, adminNotiRows, sectionOptions, teacherOptions
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

app.post('/admin/register-teacher-full', upload.single('teacher_photo'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    const { name, gender, phone, subject, assigned_sections, emergency_name, emergency_phone } = req.body;
    const photoFile = req.file ? req.file.filename : '';
    const teacherID = 'ALLS-T-' + Math.floor(1000 + Math.random() * 9000);
    const autoPIN = Math.floor(1000 + Math.random() * 9000).toString();
    const hashedPIN = bcrypt.hashSync(autoPIN, 10);
    const sectionsStr = Array.isArray(assigned_sections) ? assigned_sections.join(', ') : (assigned_sections || '');

    db.run(
        `INSERT INTO teachers (id, name, phone, password, assigned_sections) VALUES (?, ?, ?, ?, ?)`,
        [teacherID, name, phone, hashedPIN, sectionsStr],
        function(err) {
            db.run(
                `UPDATE teachers SET gender = ?, subject = ?, emergency_name = ?, emergency_phone = ?, photo = ?, plain_pin = ? WHERE id = ?`,
                [gender || '', subject || '', emergency_name || '', emergency_phone || '', photoFile, autoPIN, teacherID],
                () => res.redirect(`/admin/teacher-id/${teacherID}?pin=${autoPIN}`)
            );
        }
    );
});

app.get('/admin/teacher-id/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.params.id], (err, t) => {
        if (!t) return res.redirect('/admin');
        const displayPin = req.query.pin || t.plain_pin || '****';
        res.send(`<!DOCTYPE html><html><head><title>Teacher ID</title></head><body style="text-align:center;padding:40px;font-family:sans-serif;"><h2>✅ መምህር ተመዝግቧል!</h2><p><b>ID:</b> ${t.id} | <b>PIN:</b> <span style="color:red;font-size:20px;">${displayPin}</span></p><a href="/admin">ወደ አድሚን ተመለስ</a></body></html>`);
    });
});

app.post('/admin/add-section', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT INTO sections (name, proctor_name, proctor_phone) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING`, [req.body.name, '', ''], () => res.redirect('/admin'));
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

// ================= TEACHER DASHBOARD & GRADES =================
app.get('/teacher-dashboard', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    db.get('SELECT * FROM teachers WHERE id = ?', [req.session.teacherId], (err, teacher) => {
        if (!teacher) return res.redirect('/');
        let assignedClasses = teacher.assigned_sections ? teacher.assigned_sections.split(',').map(s => s.trim()).filter(Boolean) : [];
        let selectedClass = (req.query.cls || assignedClasses[0] || '').trim();

        db.all('SELECT student_id, name, class_level FROM students ORDER BY name ASC', [], (err, allStudents = []) => {
            let studentsInClass = allStudents.filter(s => isClassMatch(s.class_level, selectedClass));
            db.all('SELECT * FROM courses WHERE teacher_id = ?', [req.session.teacherId], (err, courses = []) => {
                let classCourses = courses.filter(c => isClassMatch(c.class_level, selectedClass));
                let selectedCourseId = req.query.course_id || (classCourses[0] ? classCourses[0].id.toString() : '');
                let selectedCourse = classCourses.find(c => c.id.toString() === selectedCourseId) || '';

                db.all('SELECT * FROM course_assessments WHERE course_code = ?', [selectedCourse ? selectedCourse.code : ''], (err, assessments = []) => {
                    db.all('SELECT * FROM absence_requests WHERE class_level = ? ORDER BY id DESC', [selectedClass], (err, classAbsences = []) => {
                        db.all("SELECT * FROM notifications WHERE sender_name = ? ORDER BY id DESC", [teacher.name], (err, mySentNotifs = []) => {
                            let classOptions = assignedClasses.map(cls => `<option value="${cls}" ${cls === selectedClass ? 'selected' : ''}>${cls}</option>`).join('');
                            let courseOptions = classCourses.map(c => `<option value="${c.id}" ${c.id.toString() === selectedCourseId ? 'selected' : ''}>${c.title} (${c.code})</option>`).join('');

                            let studentRows = studentsInClass.map((st, idx) => {
                                let asm = assessments.find(a => a.student_id === st.student_id) || {};
                                return `<tr>
                                    <td>${idx + 1}</td>
                                    <td><b>${st.student_id}</b></td>
                                    <td style="text-align:left;">${st.name}</td>
                                    <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="20" name="quiz" value="${asm.quiz !== undefined ? asm.quiz : 0}" style="width:65px; text-align:center;"></td>
                                    <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="30" name="mid" value="${asm.mid !== undefined ? asm.mid : 0}" style="width:65px; text-align:center;"></td>
                                    <td><input form="form_${st.student_id}" type="number" step="any" min="0" max="50" name="final" value="${asm.final !== undefined ? asm.final : 0}" style="width:65px; text-align:center;"></td>
                                    <td>
                                        <form id="form_${st.student_id}" class="ajax-grade-form" action="/teacher/save-grade?course_id=${selectedCourseId}" method="POST">
                                            <input type="hidden" name="student_id" value="${st.student_id}">
                                            <input type="hidden" name="course_id" value="${selectedCourseId}">
                                            <button type="submit" style="background:#27ae60; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold;">💾 Save</button>
                                        </form>
                                    </td>
                                </tr>`;
                            }).join('');

                            let absRows = classAbsences.map(ab => `<tr><td>${ab.student_name}</td><td>${ab.date || ''}</td><td>${ab.reason}</td><td>${ab.teacher_feedback || 'Pending'}</td></tr>`).join('');
                            let teacherNotiRows = mySentNotifs.map(n => `<div style="background:#fdf2e9; padding:10px; margin-bottom:10px;">${n.message}</div>`).join('');

                            res.render('teacher', {
                                lang: 'am', teacher, selectedClass, selectedCourseId, classOptions, courseOptions, studentRows, absRows, teacherNotiRows, proctorPanel: ''
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/teacher/save-grade', (req, res) => {
    if (!req.session.teacherId) return res.json({ error: 'Unauthorized' });
    let courseId = req.body.course_id || req.query.course_id || '';
    let { student_id, quiz, mid, final } = req.body;
    
    let q = Math.min(20, Math.max(0, parseFloat(quiz) || 0));
    let m = Math.min(30, Math.max(0, parseFloat(mid) || 0));
    let f = Math.min(50, Math.max(0, parseFloat(final) || 0));
    let total = Number((q + m + f).toFixed(2));

    const saveAssessment = (course) => {
        if (!course) return res.json({ error: 'Course not found' });
        db.get(`SELECT id FROM course_assessments WHERE student_id = ? AND course_code = ?`, [student_id, course.code], (err, row) => {
            if (row) {
                db.run(`UPDATE course_assessments SET teacher_id=?, quiz=?, mid=?, final=?, total=?, remark=? WHERE id=?`, 
                [req.session.teacherId, q, m, f, total, total >= 50 ? 'Pass' : 'Fail', row.id], () => res.json({ success: true, total: total }));
            } else {
                db.run(`INSERT INTO course_assessments (student_id, teacher_id, course_code, course_title, quiz, mid, final, total, remark) VALUES (?,?,?,?,?,?,?,?,?)`,
                [student_id, req.session.teacherId, course.code, course.title, q, m, f, total, total >= 50 ? 'Pass' : 'Fail'], () => res.json({ success: true, total: total }));
            }
        });
    };

    if (courseId) {
        db.get(`SELECT * FROM courses WHERE id = ?`, [courseId], (err, course) => saveAssessment(course));
    } else {
        db.get(`SELECT * FROM courses WHERE teacher_id = ? LIMIT 1`, [req.session.teacherId], (err, course) => saveAssessment(course));
    }
});

app.post('/teacher/submit-final-grades', (req, res) => {
    if (!req.session.teacherId) return res.redirect('/');
    const { class_level, course_id, academic_year } = req.body;
    const yearStr = (academic_year || '2019 E.C').trim();

    db.get(`SELECT * FROM teachers WHERE id = ?`, [req.session.teacherId], (err, teacher) => {
        db.get(`SELECT * FROM courses WHERE id = ?`, [course_id], (err2, course) => {
            if (!teacher || !course) return res.redirect('/teacher-dashboard');
            const nowStr = new Date().toLocaleDateString('en-GB');
            pool.query(
                `INSERT INTO grade_submissions (academic_year, class_level, course_id, course_code, course_title, teacher_id, teacher_name, submitted_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (academic_year, class_level, course_code)
                 DO UPDATE SET teacher_id = EXCLUDED.teacher_id, teacher_name = EXCLUDED.teacher_name, submitted_at = EXCLUDED.submitted_at`,
                [yearStr, class_level, String(course.id), course.code, course.title, teacher.id, teacher.name, nowStr]
            ).then(() => {
                res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(class_level)}&course_id=${course_id}&submitted=1`);
            }).catch(e => {
                res.redirect(`/teacher-dashboard?cls=${encodeURIComponent(class_level)}&course_id=${course_id}`);
            });
        });
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
    const studentId = (req.query.student_id || '').trim().toUpperCase();
    const academicYear = (req.query.year || '2019 E.C').trim();

    db.get(`SELECT * FROM students WHERE UPPER(student_id) = ?`, [studentId], (err, student) => {
        if (!student) return res.send('<h3 style="text-align:center;color:red;margin-top:40px;">ተማሪው አልተገኘም!</h3>');

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
                        const tot = a.total !== undefined ? a.total : 0;
                        return `<tr><td>${i+1}</td><td><b>${c.code}</b></td><td style="text-align:left;"><b>${c.title}</b></td><td>${a.quiz??'-'}</td><td>${a.mid??'-'}</td><td>${a.final??'-'}</td><td><b>${tot}</b></td><td>${tot>=50?'Pass':'Fail'}</td></tr>`;
                    }).join('');

                    res.send(`<!DOCTYPE html><html><head><title>Report Card</title><style>body{font-family:sans-serif;padding:30px;background:#f4f7f6;}.card{background:white;padding:30px;border-radius:10px;max-width:700px;margin:auto;}table{width:100%;border-collapse:collapse;margin-top:15px;}th,td{border:1px solid #ccc;padding:8px;text-align:center;}th{background:#1f4e79;color:white;}</style></head><body><div class="card"><h2>AMANUEL LIGHT & LIFE SCHOOL</h2><h3>Report Card: ${student.name} (${student.student_id})</h3><p><b>Class:</b> ${student.class_level} | <b>Total:</b> ${myGrandTotal} | <b>Average:</b> ${myAvg}% | <b>Rank:</b> ${myRank}/${classmates.length}</p><table><tr><th>#</th><th>Code</th><th>Course</th><th>Quiz</th><th>Mid</th><th>Final</th><th>Total</th><th>Status</th></tr>${courseRowsHtml}</table><br><button onclick="window.print()" style="background:#27ae60;color:white;padding:10px 20px;border:none;border-radius:5px;font-weight:bold;">🖨️ Print</button></div></body></html>`);
                });
            });
        });
    });
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
                
                const rosterData = students.map(st => {
                    let sum = 0;
                    const courseScores = courses.map(c => {
                        const a = assessments.find(x => x.student_id === st.student_id && x.course_code === c.code) || {};
                        let tot = a.total !== undefined ? parseFloat(a.total) : 0;
                        sum += tot;
                        return { code: c.code, title: c.title, total: tot };
                    });
                    const avg = courses.length > 0 ? (sum / courses.length) : 0;
                    return { student: st, courseScores, grandTotal: Number(sum.toFixed(2)), average: Number(avg.toFixed(2)) };
                });

                const courseHeaders = courses.map(c => `<th>${c.title}</th>`).join('');
                const rosterRows = rosterData.map((r, idx) => {
                    const scoreCells = r.courseScores.map(cs => `<td><b>${cs.total}</b></td>`).join('');
                    return `<tr><td>${idx+1}</td><td>${r.student.student_id}</td><td style="text-align:left;">${r.student.name}</td>${scoreCells}<td><b>${r.grandTotal}</b></td><td><b>${r.average}%</b></td></tr>`;
                }).join('');

                res.send(`<!DOCTYPE html><html><head><title>Master Roster - ${className}</title><style>body{font-family:sans-serif;padding:20px;background:#f4f7f6;}table{width:100%;border-collapse:collapse;margin-top:15px;background:white;}th,td{border:1px solid #ccc;padding:8px;text-align:center;}th{background:#1f4e79;color:white;}</style></head><body><h2>Master Roster: ${className} (${academicYear})</h2><table><tr><th>#</th><th>ID</th><th>Name</th>${courseHeaders}<th>Total</th><th>Avg</th></tr>${rosterRows}</table><br><button onclick="window.print()" style="background:#2980b9;color:white;padding:10px 20px;border:none;border-radius:5px;font-weight:bold;">🖨️ Print</button></body></html>`);
            });
        });
    });
});

app.get('/admin/registered-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.all(`SELECT * FROM students ORDER BY class_level ASC, name ASC`, [], (err, students = []) => {
        let groupedStudentsHtml = '';
        const grouped = {};
        students.forEach(s => {
            const cls = s.class_level || 'Unassigned';
            if (!grouped[cls]) grouped[cls] = [];
            grouped[cls].push(s);
        });
        Object.keys(grouped).sort().forEach(cls => {
            groupedStudentsHtml += `<h3>${cls}</h3><ul>`;
            grouped[cls].forEach(st => { groupedStudentsHtml += `<li>${st.student_id} - ${st.name}</li>`; });
            groupedStudentsHtml += `</ul>`;
        });
        res.render('registered-students', { students, groupedStudentsHtml });
    });
});

app.post('/admin/archive-year', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`DELETE FROM course_assessments`, [], () => res.redirect('/admin'));
});

app.post('/admin/promote-students', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    res.redirect('/admin');
});

app.post('/admin/save-notice', upload.single('attachment'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    db.run(`INSERT INTO notifications (sender_role, sender_name, target_audience, message, created_at, attachment) VALUES (?,?,?,?,?,?)`,
        ['Admin', 'School Admin', req.body.target_audience || 'ALL', req.body.message, new Date().toLocaleString(), req.file ? req.file.filename : null], () => res.redirect('/admin'));
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
