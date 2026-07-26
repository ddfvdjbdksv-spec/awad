// ============================================================
//  firebase-sync.js  —  محرك المزامنة السحابية (Offline + Online)
//  ------------------------------------------------------------
//  الهدف: يفضل النظام يعمل Offline بالكامل زي ما هو تمامًا (لا
//  تغيير في أي منطق قديم)، وبالإضافة لذلك:
//
//   • أي تعديل محلي (إضافة/تعديل/حذف) يتزامن تلقائيًا مع Firestore
//     بمجرد توفر الإنترنت — بدون أي زر أو تدخل من المستخدم.
//   • أي تحديث يحصل من جهاز تاني (بنفس قاعدة البيانات) بيوصل هنا
//     تلقائيًا ويتحدّث في الجهاز الحالي فور توفر الإنترنت.
//   • البيانات المُحمَّلة من Firestore تتخزن محليًا (IndexedDB) زي
//     العادة، فتفضل موجودة حتى لو اتقفل الإنترنت تاني.
//
//  آلية العمل:
//   1. كل جداول db (الطلاب، المدفوعات، ...) بتتزامن كمستندات
//      مستقلة داخل مجموعات Firestore بنفس اسم الجدول، ومعرّف كل
//      مستند = نفس الـ id المحلي.
//   2. db._settings (فيها كلمات المرور، المستخدمون، الإعدادات
//      العامة) بتتزامن كمستند واحد في meta/settings.
//   3. الاعتماد على "hash" خفيف لكل سجل لتحديد التغييرات فقط
//      بدل رفع كل البيانات في كل مرة (كفاءة أعلى، Firestore أرخص).
//   4. الاعتماد على Firestore Offline Persistence نفسها كـ "صندوق
//      الرسائل الصادرة" (Outbox) — يعني أي كتابة بنعملها بتتسجل
//      محليًا فورًا وتتبعت لـ Firestore تلقائيًا لما النت يرجع،
//      حتى لو قفلنا التطبيق قبل رجوع النت (تمامًا زي واتساب).
// ============================================================

const CloudSync = (() => {

    // ⚠️ هذا الكونفيج عام (client-side) وليس سرًا، لكن تأكد أن Firestore
    // Security Rules عندك محكمة قبل الإطلاق الفعلي للمستخدمين.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyDI3iXCmMr5L8hAg9E3Dsiv2vOFKmVqLs8",
        authDomain: "abdalla-awad.firebaseapp.com",
        projectId: "abdalla-awad",
        storageBucket: "abdalla-awad.firebasestorage.app",
        messagingSenderId: "523701275801",
        appId: "1:523701275801:web:2b56a23f8afd5a515c3c08",
        measurementId: "G-J4DJQWQ8HP"
    };

    const TENANT_STORAGE_KEY = 'cloud_sync_tenant_id_' + FIREBASE_CONFIG.projectId;
    let tenantId = null;
    let tenantRoot = null;

    // نفس قائمة الجداول المستخدمة في IndexedDB (StorageEngine) بالضبط
    const SYNC_TABLES = [
        'students', 'attendance', 'exams', 'scores', 'expenses',
        'handouts', 'studentHandouts', 'materials', 'quizzes', 'rewards',
        'payments', 'waQueue', 'groups', 'cycles', 'absenceSessions',
        'dailyTreasuryArchives', 'staff', 'shifts', 'courseCodes',
        'platformCourses', 'platformSubscriptions'
    ];

    let HASH_STORAGE_KEY = 'cloud_sync_hashes_' + FIREBASE_CONFIG.projectId;
    let LAST_SYNC_KEY = 'cloud_sync_last_time_' + FIREBASE_CONFIG.projectId;

    let fsDB = null;
    let ready = false;
    let applyingRemote = false;   // true أثناء تطبيق تحديث قادم من Firestore (لمنع حلقة رفع/سحب)
    let hashes = {};              // { table: { id: hash } , __settings: hash }
    let rerenderTimer = null;
    let statusEl = null;

    let isFreshSync = false;

    // ── تخزين/قراءة الطابع الزمني والـ hashes من localStorage ───
    function getLastSyncTime() {
        try {
            const val = localStorage.getItem(LAST_SYNC_KEY);
            return val ? parseInt(val, 10) : 0;
        } catch (e) { return 0; }
    }
    function updateLastSyncTime(ts) {
        try {
            const now = ts || Date.now();
            localStorage.setItem(LAST_SYNC_KEY, String(now));
        } catch (e) { }
    }

    function loadHashes() {
        try {
            const stored = localStorage.getItem(HASH_STORAGE_KEY);
            if (stored === null) {
                isFreshSync = true;
            }
            hashes = JSON.parse(stored) || {};
        }
        catch (e) { hashes = {}; }
    }
    function saveHashes() {
        try { localStorage.setItem(HASH_STORAGE_KEY, JSON.stringify(hashes)); }
        catch (e) { /* ignore quota errors */ }
    }
    function hashOf(record) {
        const str = JSON.stringify(record);
        let h = 0;
        for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
        return h + '_' + str.length;
    }
    // Firestore بيرفض قيم undefined — لازم ننضّف الكائن قبل الإرسال
    function slugifyTenantPart(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80);
    }

    function resolveTenantId() {
        const initialData = window.edu_initial_data || {};
        const settings = (typeof db !== 'undefined' && db && db._settings) ? db._settings : {};
        const profile = settings.appProfile || initialData.appProfile || (initialData.settings && initialData.settings.appProfile) || {};
        const explicit = window.CLOUD_SYNC_TENANT_ID || initialData.cloudSyncTenantId || initialData.tenantId || settings.cloudSyncTenantId;
        const fromProfile = [
            profile.centerName,
            profile.teacherName,
            profile.specialization
        ].map(slugifyTenantPart).filter(Boolean).join('-');
        const fallback = slugifyTenantPart(location.hostname + '-' + location.pathname.replace(/\/[^/]*$/, '')) || 'default';
        const resolved = slugifyTenantPart(explicit) || fromProfile || fallback;
        try { localStorage.setItem(TENANT_STORAGE_KEY, resolved); } catch (e) { }
        return resolved;
    }

    function configureTenant() {
        tenantId = resolveTenantId();
        HASH_STORAGE_KEY = 'cloud_sync_hashes_' + FIREBASE_CONFIG.projectId + '_' + tenantId;
        LAST_SYNC_KEY = 'cloud_sync_last_time_' + FIREBASE_CONFIG.projectId + '_' + tenantId;
        tenantRoot = fsDB ? fsDB.collection('_tenants').doc(tenantId) : null;
    }

    function tableCollection(table) {
        return tenantRoot.collection(table);
    }

    function legacyTableCollection(table) {
        return fsDB.collection(table);
    }

    function deletionsCollection() {
        return tenantRoot.collection('_deletions');
    }

    function settingsDocRef() {
        return tenantRoot.collection('meta').doc('settings');
    }

    function legacySettingsDocRef() {
        return fsDB.collection('meta').doc('settings');
    }

    function sanitize(obj) {
        const out = {};
        Object.keys(obj || {}).forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
        return out;
    }

    const UPLOAD_COL_MAP = {
        students: { id: 'id', name: 'nm', grade: 'gr', groupId: 'gid', qrCode: 'qr', phone: 'ph', parentPhone: 'pp', points: 'pt', notes: 'no', joinDate: 'jd', centerCode: 'cc', platformCode: 'pc', gender: 'gn', isExempt: 'ex' },
        attendance: { id: 'id', studentId: 'sid', date: 'd', status: 's', sessionId: 'ssid', grade: 'gr', groupId: 'gid' },
        payments: { id: 'id', studentId: 'sid', date: 'd', amount: 'am', category: 'cat', cycleId: 'cid', month: 'mo', year: 'yr', isExemption: 'xm', discount: 'dc', platformFee: 'pf', notes: 'no', groupId: 'gid', grade: 'gr' },
        expenses: { id: 'id', date: 'd', amount: 'am', description: 'ds', grade: 'gr', groupId: 'gid', category: 'cat' },
        exams: { id: 'id', title: 'ti', grade: 'gr', groupId: 'gid', maxMarks: 'mx', date: 'd' },
        scores: { id: 'id', examId: 'eid', studentId: 'sid', mark: 'mk', date: 'd' },
        absenceSessions: { id: 'id', date: 'd', grade: 'gr', groupId: 'gid', name: 'nm', presentIds: 'pid', absentIds: 'aid', note: 'no' },
        dailyTreasuryArchives: { id: 'id', date: 'd', grade: 'gr', groupId: 'gid', sessionName: 'sn', totalSub: 'ts', totalMisc: 'tm', totalExp: 'te', total: 'tt', payments: 'py', expenses: 'ex' },
        cycles: { id: 'id', title: 'ti', grade: 'gr', groupId: 'gid', startDate: 'sd', endDate: 'ed', isActive: 'ia', monthlyFee: 'mf' },
        groups: { id: 'id', name: 'nm', grade: 'gr', time: 'ti', days: 'dy', capacity: 'cp', color: 'cl' },
        handouts: { id: 'id', title: 'ti', grade: 'gr', groupId: 'gid', price: 'pr', date: 'd' },
        studentHandouts: { id: 'id', studentId: 'sid', handoutId: 'hid', date: 'd', paid: 'pd', amount: 'am' },
        rewards: { id: 'id', title: 'ti', grade: 'gr', pointsCost: 'pc', stock: 'st', icon: 'ic' },
        quizzes: { id: 'id', title: 'ti', grade: 'gr', groupId: 'gid', questions: 'q', date: 'd' },
        staff: { id: 'id', name: 'nm', role: 'ro', pin: 'pi', phone: 'ph', joinDate: 'jd', isActive: 'ia' },
        shifts: { id: 'id', staffId: 'sid', date: 'd', type: 'tp', note: 'no' },
        materials: { id: 'id', title: 'ti', grade: 'gr', groupId: 'gid', type: 'tp', url: 'ur', date: 'd' },
        waQueue: { id: 'id', studentId: 'sid', message: 'ms', type: 'tp', date: 'd', status: 'st', phone: 'ph' },
        platformCourses: { id: 'id', title: 'ti', grade: 'gr', price: 'pr', isActive: 'ia', platformCode: 'pc' },
        platformSubscriptions: { id: 'id', studentId: 'sid', courseId: 'cid', date: 'd', expiryDate: 'ed', status: 'st', amount: 'am' },
        courseCodes: { id: 'id', code: 'co', grade: 'gr', groupId: 'gid', used: 'us', usedBy: 'ub', date: 'd' },
    };

    function resolveUploadDict(v, dict) {
        if (typeof v === 'string' && v.startsWith('~')) {
            const idx = parseInt(v.slice(1), 10);
            return dict[idx] !== undefined ? dict[idx] : v;
        }
        if (Array.isArray(v)) return v.map(x => resolveUploadDict(x, dict));
        if (v && typeof v === 'object') {
            const out = {};
            Object.entries(v).forEach(([k, val]) => { out[k] = resolveUploadDict(val, dict); });
            return out;
        }
        return v;
    }

    function decompressUploadTable(tableName, compressed) {
        if (!compressed || !compressed._c) return Array.isArray(compressed) ? compressed : [];
        const { cols, n } = compressed;
        if (!n || !cols) return [];
        const map = UPLOAD_COL_MAP[tableName] || {};
        const rev = {};
        Object.entries(map).forEach(([longKey, shortKey]) => { rev[shortKey] = longKey; });
        const rows = [];
        for (let i = 0; i < n; i++) {
            const row = {};
            Object.entries(cols).forEach(([shortKey, values]) => {
                const longKey = rev[shortKey] || shortKey;
                const v = Array.isArray(values) ? values[i] : undefined;
                if (v !== null && v !== undefined) row[longKey] = v;
            });
            rows.push(row);
        }
        return rows;
    }

    function normalizeUploadData(data) {
        const source = data || {};
        const normalized = {};

        if (source.__version__ === 3 && source.tables) {
            const dict = source.__dict__ || [];
            Object.entries(source.tables).forEach(([tableName, compressed]) => {
                const withDict = dict.length ? resolveUploadDict(compressed, dict) : compressed;
                normalized[tableName] = decompressUploadTable(tableName, withDict);
            });
        }

        SYNC_TABLES.forEach(table => {
            if (!Array.isArray(normalized[table])) {
                normalized[table] =
                    (Array.isArray(source[table]) ? source[table] : null) ||
                    (Array.isArray(source[`edu_${table}`]) ? source[`edu_${table}`] : null) ||
                    (table === 'dailyTreasuryArchives' && Array.isArray(source.dailyTreasury) ? source.dailyTreasury : null) ||
                    (table === 'payments' && Array.isArray(source.studentPayments) ? source.studentPayments : null) ||
                    [];
            }
        });

        normalized._settings = source._settings || source.settings || source.edu_master_settings || null;
        return normalized;
    }

    // ── مؤشر الحالة الصغير في الواجهة (متصل / غير متصل / مزامنة) ──
    function ensureStatusBadge() {
        if (statusEl) return statusEl;
        statusEl = document.createElement('div');
        statusEl.id = 'cloud-sync-badge';
        statusEl.style.cssText = 'position:fixed; bottom:14px; left:14px; z-index:9999; padding:.4rem .8rem; border-radius:20px; font-size:.75rem; font-weight:700; font-family:inherit; box-shadow:0 4px 14px rgba(0,0,0,.15); transition:.3s; display:flex; align-items:center; gap:.4rem; direction:rtl;';
        document.body.appendChild(statusEl);
        return statusEl;
    }
    function setStatus(mode) {
        const el = ensureStatusBadge();
        const map = {
            offline: { bg: '#f59e0b', text: 'غير متصل — العمل محلي', icon: 'fa-wifi-slash' },
            syncing: { bg: '#3b82f6', text: 'جارِ المزامنة...', icon: 'fa-sync fa-spin' },
            online: { bg: '#16a34a', text: 'متصل ومتزامن', icon: 'fa-cloud' },
            error: { bg: '#dc2626', text: 'تعذّرت المزامنة (سيُعاد المحاولة)', icon: 'fa-exclamation-triangle' },
        };
        const cfg = map[mode] || map.offline;
        el.style.background = cfg.bg;
        el.style.color = '#fff';
        el.innerHTML = `<i class="fas ${cfg.icon}"></i> ${cfg.text}`;
    }

    const TABLE_UI_REFRESH_MAP = {
        students: [
            () => { if (typeof window.renderStudents === 'function') window.renderStudents(); },
            () => { if (typeof window.renderGroupStudents === 'function') window.renderGroupStudents(); },
            () => { if (typeof window.updateDashboardStats === 'function') window.updateDashboardStats(); }
        ],
        groups: [
            () => { if (typeof window.renderGroups === 'function') window.renderGroups(); },
            () => { if (typeof window.refreshGroupContexts === 'function') window.refreshGroupContexts(); },
            () => {
                if (typeof window.currentGrade !== 'undefined' && window.currentGrade) {
                    if (typeof window.renderPortalGroups === 'function') window.renderPortalGroups(window.currentGrade);
                    if (typeof window.renderGroupSelection === 'function') window.renderGroupSelection(window.currentGrade);
                }
            }
        ],
        attendance: [
            () => { if (typeof window.renderPortalAttendance === 'function') window.renderPortalAttendance(); },
            () => { if (typeof window.renderSessionTable === 'function') window.renderSessionTable(); },
            () => { if (typeof window.renderHistoryByDate === 'function') window.renderHistoryByDate(); },
            () => { if (typeof window.updateDashboardStats === 'function') window.updateDashboardStats(); }
        ],
        absenceSessions: [
            () => { if (typeof window.renderHistoryByDate === 'function') window.renderHistoryByDate(); }
        ],
        payments: [
            () => { if (typeof window.renderFinances === 'function') window.renderFinances(); },
            () => { if (typeof window.renderReceiptsList === 'function') window.renderReceiptsList(); },
            () => { if (typeof window.updateDashboardStats === 'function') window.updateDashboardStats(); }
        ],
        expenses: [
            () => { if (typeof window.renderFinances === 'function') window.renderFinances(); },
            () => { if (typeof window.renderReceiptsList === 'function') window.renderReceiptsList(); },
            () => { if (typeof window.updateDashboardStats === 'function') window.updateDashboardStats(); }
        ],
        dailyTreasuryArchives: [
            () => { if (typeof window.renderDailyTreasury === 'function') window.renderDailyTreasury(); },
            () => { if (typeof window.renderDailyTreasuryArchives === 'function') window.renderDailyTreasuryArchives(); }
        ],
        exams: [
            () => { if (typeof window.renderExams === 'function') window.renderExams(); }
        ],
        scores: [
            () => { if (typeof window.renderExams === 'function') window.renderExams(); }
        ],
        shifts: [
            () => { if (typeof window.renderShifts === 'function') window.renderShifts(); }
        ],
        staff: [
            () => { if (typeof window.renderShifts === 'function') window.renderShifts(); },
            () => { if (typeof window.renderEmployeeManagementList === 'function') window.renderEmployeeManagementList(); }
        ]
    };

    let pendingTableRefreshes = new Set();
    function queueTableUIRefresh(table) {
        if (table) pendingTableRefreshes.add(table);
        clearTimeout(rerenderTimer);
        rerenderTimer = setTimeout(() => {
            const globals = ['syncUIWithContext', 'renderMonthlySubscriptionTables', 'renderSubscriptionTracker', 'updateDashboardStats'];
            globals.forEach(fn => { try { if (typeof window[fn] === 'function') window[fn](); } catch (e) { } });

            pendingTableRefreshes.forEach(t => {
                const fns = TABLE_UI_REFRESH_MAP[t];
                if (Array.isArray(fns)) {
                    fns.forEach(fn => { try { fn(); } catch (e) { } });
                }
            });

            try {
                const activeNav = document.querySelector('.nav-item.active');
                const sectionId = activeNav ? activeNav.dataset.section : null;
                if (sectionId) {
                    if (sectionId === 'students' && typeof window.renderStudents === 'function') window.renderStudents();
                    if (sectionId === 'groups' && typeof window.renderGroups === 'function') window.renderGroups();
                    if (sectionId === 'payments' && typeof window.renderFinances === 'function') window.renderFinances();
                    if (sectionId === 'attendance' && typeof window.renderPortalAttendance === 'function') window.renderPortalAttendance();
                    if (sectionId === 'exams' && typeof window.renderExams === 'function') window.renderExams();
                    if (sectionId === 'settings' && typeof window.renderProgramSettings === 'function') window.renderProgramSettings();
                }
            } catch (e) { }

            pendingTableRefreshes.clear();
        }, 50);
    }

    function populateHashesFromLocal() {
        SYNC_TABLES.forEach(table => {
            if (!hashes[table]) hashes[table] = {};
            const arr = (typeof db !== 'undefined' && db) ? db[table] : null;
            if (Array.isArray(arr)) {
                arr.forEach(rec => {
                    if (rec && rec.id !== undefined && rec.id !== null) {
                        const id = String(rec.id);
                        if (!hashes[table][id]) {
                            hashes[table][id] = hashOf(rec);
                        }
                    }
                });
            }
        });
        saveHashes();
    }

    async function deleteRecord(table, id) {
        if (!table || id === undefined || id === null) return;
        const strId = String(id);

        if (typeof db !== 'undefined' && db && Array.isArray(db[table])) {
            const idx = db[table].findIndex(r => String(r?.id) === strId);
            if (idx > -1) db[table].splice(idx, 1);
        }

        if (hashes[table]) {
            delete hashes[table][strId];
            saveHashes();
        }

        if (applyingRemote) return;
        if (!ready || !fsDB) return;

        try {
            await tableCollection(table).doc(strId).delete();
            const delDocId = `${table}_${strId}`;
            await deletionsCollection().doc(delDocId).set({
                table, id: strId, _syncedAt: Date.now()
            }).catch(() => {});
            console.log(`[CloudSync] ✅ Document ${strId} deleted from ${table}`);
        } catch (err) {
            console.warn(`[CloudSync] ⚠️ Failed to delete document ${strId} from ${table}:`, err);
        }
    }

    // ============================================================
    //  الدفع للسحابة (Push) — يُستدعى تلقائياً من داخل db.save()
    // ============================================================

    async function pushTableDiff(table) {
        if (!ready || applyingRemote) return 0;
        const arr = db[table];
        if (!Array.isArray(arr)) return 0;

        if (!hashes[table]) hashes[table] = {};
        const tableHashes = hashes[table];
        const currentIds = new Set();
        const ops = []; // { type, id, data, newHash }

        arr.forEach(rec => {
            if (rec == null || rec.id === undefined || rec.id === null) return;
            const id = String(rec.id);
            currentIds.add(id);
            const h = hashOf(rec);
            if (tableHashes[id] !== h) {
                ops.push({ type: 'set', id, data: rec, newHash: h });
            }
        });

        // الحذف: أي id كان موجود قبل كده وبقى مش موجود دلوقتي
        // ⚠️ حماية: لا نحذف من Firestore لو كانت هذه أول مزامنة (isFreshSync)
        if (!isFreshSync) {
            Object.keys(tableHashes).forEach(id => {
                if (!currentIds.has(id)) {
                    ops.push({ type: 'delete', id });
                }
            });
        }

        if (!ops.length) return 0;
        await flushOps(table, ops); // الـ hash بيتحدّث جوه flushOps بعد نجاح الكتابة فعليًا فقط
        return ops.length;
    }

    async function pushSettings() {
        if (!ready || applyingRemote) return false;
        if (!db._settings) return false;
        const h = hashOf(db._settings);
        if (hashes.__settings === h) return false;

        setStatus('syncing');
        try {
            await settingsDocRef().set({ ...sanitize(db._settings), _syncedAt: Date.now() }, { merge: true });
            hashes.__settings = h; // نحدّث الهاش بعد التأكد من نجاح الكتابة فقط
            saveHashes();
            setStatus(navigator.onLine ? 'online' : 'offline');
            return true;
        } catch (err) {
            console.warn('[CloudSync] settings push failed', err);
            setStatus('error');
            return false;
        }
    }

    async function flushOps(table, ops) {
        setStatus('syncing');
        const col = tableCollection(table);
        const CHUNK = 400; // أقل من حد الـ 500 لكل batch في Firestore
        const tableHashes = hashes[table] || (hashes[table] = {});

        for (let i = 0; i < ops.length; i += CHUNK) {
            const chunk = ops.slice(i, i + CHUNK);
            const batch = fsDB.batch();
            chunk.forEach(op => {
                const ref = col.doc(op.id);
                if (op.type === 'delete') batch.delete(ref);
                else batch.set(ref, { ...sanitize(op.data), _syncedAt: Date.now() }, { merge: true });
            });
            try {
                await batch.commit();
                chunk.forEach(op => {
                    if (op.type === 'delete') delete tableHashes[op.id];
                    else tableHashes[op.id] = op.newHash;
                });
                saveHashes();
                console.log(`[CloudSync] ✅ ${table}: تمت مزامنة ${chunk.length} سجل`);
            } catch (err) {
                console.error(`[CloudSync] ❌ فشلت مزامنة ${table} (${chunk.length} سجل):`, err);
                setStatus('error');
                throw err;
            }
        }
        setStatus(navigator.onLine ? 'online' : 'offline');
    }

    function pushAllTables() {
        SYNC_TABLES.forEach(t => pushTableDiff(t).catch(e => console.error(`[CloudSync] push ${t} failed`, e)));
        pushSettings().catch(e => console.error('[CloudSync] push settings failed', e));
    }

    // ☁️ رفع كامل وانتظار انتهائه — يُستخدم بعد استعادة نسخة احتياطية
    // parsedData اختياري: لو اتبعتت، بيرفع منها مباشرة بدون ما يعتمد على db في الذاكرة
    async function forceFullUpload(parsedData) {
        if (!ready) throw new Error('CloudSync not ready');

        // لو اتبعت بيانات مباشرة (من ملف استعادة) — ارفعها فوراً بدون db
        if (parsedData && typeof parsedData === 'object') {
            console.log('[CloudSync] 🚀 forceFullUpload من بيانات مباشرة...');
            return _pushRawData(parsedData);
        }

        console.log('[CloudSync] 🚀 forceFullUpload من الذاكرة...');
        const snapshot = {};
        SYNC_TABLES.forEach(table => {
            snapshot[table] = Array.isArray(db[table]) ? db[table] : [];
        });
        snapshot._settings = db._settings || {};
        return _pushRawData(snapshot);
    }

    // رفع بيانات خام من كائن parsed مباشرة لـ Firestore (لا يعتمد على db في الذاكرة)
    async function _pushRawData(data) {
        if (!ready || !fsDB) throw new Error('CloudSync not ready');
        const uploadData = normalizeUploadData(data);
        const CHUNK = 400;
        let totalUploaded = 0;
        let totalFailed = 0;

        for (const table of SYNC_TABLES) {
            const arr = Array.isArray(uploadData[table]) ? uploadData[table] : [];
            if (arr.length === 0) continue;
            const col = tableCollection(table);
            console.log(`[CloudSync] 📤 رفع ${arr.length} سجل من جدول ${table}...`);
            for (let i = 0; i < arr.length; i += CHUNK) {
                const chunk = arr.slice(i, i + CHUNK);
                const batch = fsDB.batch();
                chunk.forEach(rec => {
                    if (rec == null || rec.id === undefined) return;
                    const ref = col.doc(String(rec.id));
                    batch.set(ref, { ...sanitize(rec), _syncedAt: Date.now() }, { merge: true });
                });
                try {
                    await batch.commit();
                    totalUploaded += chunk.length;
                    console.log(`[CloudSync] ✅ ${table}: تم رفع ${chunk.length} سجل`);
                } catch (err) {
                    totalFailed += chunk.length;
                    console.error(`[CloudSync] ❌ فشل رفع ${table}:`, err);
                }
            }
        }

        // رفع الإعدادات لو موجودة
        if (uploadData._settings) {
            try {
                await settingsDocRef().set({ ...sanitize(uploadData._settings), _syncedAt: Date.now() }, { merge: true });
                console.log('[CloudSync] ✅ الإعدادات تم رفعها');
            } catch (err) {
                console.warn('[CloudSync] ❌ فشل رفع الإعدادات:', err);
            }
        }

        // بعد الرفع: أعد تصفير الـ hashes عشان بعد الريلود يتزامن صح
        hashes = {};
        saveHashes();

        console.log(`[CloudSync] 🎉 _pushRawData انتهى — ${totalUploaded} سجل تم رفعه، ${totalFailed} فشل`);
        return { total: totalUploaded + totalFailed, uploaded: totalUploaded, failed: totalFailed };
    }

    async function syncTableNow(table) {
        if (!ready || !SYNC_TABLES.includes(table)) {
            throw new Error('CloudSync is not ready for table: ' + table);
        }
        return pushTableDiff(table);
    }

    // ── رفع يدوي بزر — يرجع تقرير واضح بعدد السجلات المرفوعة فعليًا ──
    async function manualPushToCloud() {
        if (!ready) {
            alert('⚠️ الاتصال بـ Firebase غير جاهز حالياً.\nافتح Console (F12) وشوف رسائل [CloudSync] لمعرفة السبب.');
            return;
        }
        const btn = document.getElementById('manual-push-btn');
        const originalHTML = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارِ الرفع...'; }

        setStatus('syncing');
        const report = {};
        for (const table of SYNC_TABLES) {
            try { report[table] = await pushTableDiff(table); }
            catch (e) { report[table] = 'خطأ: ' + (e.message || e); }
        }
        const settingsSynced = await pushSettings();
        setStatus(navigator.onLine ? 'online' : 'offline');

        if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }

        const lines = Object.entries(report)
            .filter(([, v]) => v !== 0)
            .map(([t, v]) => `• ${t}: ${v}`);
        alert(
            '✅ انتهى الرفع للسحابة.\n\n' +
            (lines.length ? lines.join('\n') : 'لا يوجد بيانات جديدة — كل شيء متزامن بالفعل.') +
            (settingsSynced ? '\n• الإعدادات/المستخدمون: تم التحديث' : '')
        );
    }

    // ── دمج ذكي وآمن للبيانات القادمة من السحابة مع البيانات المحلية ──
    // ⚠️ حماية مطلقة: لا يتم مسح أو حذف أي سجلات محليّة إطلاقاً أثناء التحديث أو المزامنة!
    async function mergeRemoteTable(table, remoteArr) {
        if (!Array.isArray(db[table])) db[table] = [];
        const localArr = db[table];
        if (!hashes[table]) hashes[table] = {};
        const tableHashes = hashes[table];
        let changed = false;

        for (const remoteRec of remoteArr) {
            if (remoteRec == null || remoteRec.id === undefined || remoteRec.id === null) continue;
            const id = String(remoteRec.id);
            const idx = localArr.findIndex(r => String(r.id) === id);

            if (idx > -1) {
                const localRec = localArr[idx];
                const localHash = hashOf(localRec);

                if (localHash !== hashOf(remoteRec)) {
                    localArr[idx] = remoteRec;
                    await StorageEngine.save(table, remoteRec).catch(() => { });
                    tableHashes[id] = hashOf(remoteRec);
                    changed = true;
                }
            } else {
                localArr.push(remoteRec);
                await StorageEngine.save(table, remoteRec).catch(() => { });
                tableHashes[id] = hashOf(remoteRec);
                changed = true;
            }
        }

        hashes[table] = tableHashes;
        saveHashes();
        return changed;
    }

    // ── جلب يدوي بزر — دمج البيانات المحلية مع بيانات السحابة دون مسح التعديلات المحلية ──
    async function manualPullFromCloud() {
        if (!ready) {
            alert('⚠️ الاتصال بـ Firebase غير جاهز حالياً.\nافتح Console (F12) وشوف رسائل [CloudSync] لمعرفة السبب.');
            return;
        }
        if (!confirm('سيتم دمج البيانات المحلية مع السحابة (تنزيل الجديد وتحديث القديم).\nهل أنت متأكد؟')) return;

        const btn = document.getElementById('manual-pull-btn');
        const originalHTML = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارِ الدمج...'; }

        setStatus('syncing');
        applyingRemote = true;
        const report = {};
        try {
            for (const table of SYNC_TABLES) {
                const snap = await tableCollection(table).get({ source: 'server' });
                const remoteArr = [];
                snap.forEach(doc => {
                    const rawId = doc.id;
                    const numericId = isNaN(Number(rawId)) ? rawId : Number(rawId);
                    const data = { ...doc.data(), id: numericId };
                    delete data._syncedAt;
                    remoteArr.push(data);
                });

                const changed = await mergeRemoteTable(table, remoteArr);
                report[table] = remoteArr.length + (changed ? ' (تم التحديث/الدمج)' : ' (متطابقة)');
            }

            const settingsDoc = await settingsDocRef().get({ source: 'server' });
            if (settingsDoc.exists) {
                const remoteSettings = { ...settingsDoc.data() };
                delete remoteSettings._syncedAt;

                db._settings = { ...db._settings, ...remoteSettings };
                localStorage.setItem('edu_master_settings', JSON.stringify(db._settings));
                hashes.__settings = hashOf(db._settings);
                report['الإعدادات'] = 'تم التحديث';
            } else {
                report['الإعدادات'] = 'لا يوجد إعدادات على السحابة';
            }
            saveHashes();
            isFreshSync = false;
        } catch (err) {
            console.error('[CloudSync] ❌ فشل جلب ودمج البيانات', err);
            applyingRemote = false;
            setStatus('error');
            if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
            alert('❌ فشل دمج البيانات من السحابة:\n' + (err.message || err) + '\n\nافتح Console (F12) لمزيد من التفاصيل.');
            return;
        }
        applyingRemote = false;
        setStatus(navigator.onLine ? 'online' : 'offline');
        queueTableUIRefresh(null);
        if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }

        const lines = Object.entries(report).map(([t, v]) => `• ${t}: ${v}`);
        alert('✅ انتهى الدمج والجلب من السحابة بنجاح:\n\n' + lines.join('\n'));
    }

    // يُستدعى من نهاية db.save() الأصلية في app.js
    function onLocalSave(modifiedTable) {
        if (!ready) return;
        if (applyingRemote) return;
        if (modifiedTable && SYNC_TABLES.includes(modifiedTable)) {
            pushTableDiff(modifiedTable);
        } else if (!modifiedTable) {
            SYNC_TABLES.forEach(pushTableDiff);
        }
        pushSettings();
    }

    // ============================================================
    //  الاستقبال من السحابة (Pull) — Real-time listeners
    // ============================================================

    async function applyRemoteDocChange(table, change) {
        const arr = db[table];
        if (!Array.isArray(arr)) return false;

        const rawId = change.doc.id;
        const numericId = isNaN(Number(rawId)) ? rawId : Number(rawId);
        const strId = String(numericId);

        if (change.type === 'removed') {
            const idx = arr.findIndex(r => String(r.id) === strId);
            if (idx > -1) {
                arr.splice(idx, 1);
            }
            await StorageEngine.delete(table, numericId).catch(() => { });
            if (hashes[table]) delete hashes[table][strId];
            return true;
        }

        const data = { ...change.doc.data(), id: numericId };
        delete data._syncedAt;

        const idx = arr.findIndex(r => String(r.id) === strId);
        if (idx > -1) {
            if (hashOf(arr[idx]) === hashOf(data)) return false;
            arr[idx] = data;
        } else {
            arr.push(data);
        }
        await StorageEngine.save(table, [data]).catch(() => { });

        if (!hashes[table]) hashes[table] = {};
        hashes[table][strId] = hashOf(data);
        return true;
    }

    function attachTableListener(table) {
        const col = tableCollection(table);
        const lastSync = getLastSyncTime();
        let query = col;

        // ── تفعيل المزامنة بالفروقات (Delta Sync) ──
        // إذا سبق المزامنة، نستمع فقط للتعديلات التي حدثت بعد وقت آخر مزامنة ناجهة (مع هامش دقيقتين)
        if (lastSync > 0 && !isFreshSync) {
            const safetyMargin = Math.max(0, lastSync - 1800000); // هامش 30 دقيقة لعدم تفويت أي تعديلات أوفلاين
            query = col.where('_syncedAt', '>=', safetyMargin);
        }

        query.onSnapshot(async snapshot => {
            let changed = false;
            applyingRemote = true;
            for (const change of snapshot.docChanges()) {
                if (change.doc.metadata.hasPendingWrites) continue;
                if (await applyRemoteDocChange(table, change)) changed = true;
            }
            applyingRemote = false;
            if (changed) {
                saveHashes();
                queueTableUIRefresh(table);
                setStatus('online');
            }
            updateLastSyncTime();
        }, err => {
            console.warn(`[CloudSync] listener error on ${table}`, err);
        });
    }

    function attachDeletionsListener() {
        const lastSync = getLastSyncTime();
        let query = deletionsCollection();
        if (lastSync > 0 && !isFreshSync) {
            const safetyMargin = Math.max(0, lastSync - 1800000);
            query = query.where('_syncedAt', '>=', safetyMargin);
        }
        query.onSnapshot(async snapshot => {
            let changedTables = new Set();
            applyingRemote = true;
            for (const change of snapshot.docChanges()) {
                if (change.doc.metadata.hasPendingWrites) continue;
                const data = change.doc.data();
                if (data && data.table && data.id) {
                    const table = data.table;
                    const strId = String(data.id);
                    const numericId = isNaN(Number(strId)) ? strId : Number(strId);
                    const arr = db[table];
                    if (Array.isArray(arr)) {
                        const idx = arr.findIndex(r => String(r.id) === strId);
                        if (idx > -1) arr.splice(idx, 1);
                    }
                    await StorageEngine.delete(table, numericId).catch(() => {});
                    if (hashes[table]) delete hashes[table][strId];
                    changedTables.add(table);
                }
            }
            applyingRemote = false;
            if (changedTables.size > 0) {
                saveHashes();
                changedTables.forEach(t => queueTableUIRefresh(t));
            }
            updateLastSyncTime();
        }, err => console.warn('[CloudSync] deletions listener error', err));
    }

    function attachSettingsListener() {
        settingsDocRef().onSnapshot(doc => {
            if (!doc.exists) return;
            if (doc.metadata.hasPendingWrites) return;

            const data = { ...doc.data() };
            delete data._syncedAt;

            applyingRemote = true;
            db._settings = { ...db._settings, ...data };
            applyingRemote = false;

            hashes.__settings = hashOf(db._settings);
            saveHashes();

            try { localStorage.setItem('edu_master_settings', JSON.stringify(db._settings)); } catch (e) { }
            try {
                if (db._settings.globalPasswords) {
                    localStorage.setItem('_fallback_passwords', JSON.stringify(db._settings.globalPasswords));
                }
            } catch (e) { }

            try { if (typeof window.applyProgramProfile === 'function') window.applyProgramProfile(); } catch (e) { }
            queueTableUIRefresh(null);
            updateLastSyncTime();
        }, err => console.warn('[CloudSync] settings listener error', err));
    }

    function attachAllListeners() {
        SYNC_TABLES.forEach(attachTableListener);
        attachSettingsListener();
        attachDeletionsListener();
    }

    function legacyImportStorageKey() {
        return 'cloud_sync_legacy_root_imported_v2_' + FIREBASE_CONFIG.projectId + '_' + tenantId;
    }

    function mergeSettingsWithoutOverwritingCurrent(legacySettings) {
        if (!legacySettings || typeof legacySettings !== 'object') return false;
        const current = db._settings || {};
        db._settings = { ...legacySettings, ...current };
        if (legacySettings.appProfile || current.appProfile) {
            db._settings.appProfile = {
                ...(legacySettings.appProfile || {}),
                ...(current.appProfile || {})
            };
        }
        try { localStorage.setItem('edu_master_settings', JSON.stringify(db._settings)); } catch (e) {}
        hashes.__settings = hashOf(db._settings);
        return true;
    }

    async function writeLegacyRecordsToTenant(table, records) {
        if (!records.length) return 0;
        const CHUNK = 400;
        let written = 0;
        for (let i = 0; i < records.length; i += CHUNK) {
            const chunk = records.slice(i, i + CHUNK);
            const batch = fsDB.batch();
            chunk.forEach(rec => {
                if (!rec || rec.id === undefined || rec.id === null) return;
                batch.set(tableCollection(table).doc(String(rec.id)), { ...sanitize(rec), _syncedAt: Date.now() }, { merge: true });
            });
            await batch.commit();
            written += chunk.length;
        }
        return written;
    }

    async function writeLegacySettingsToTenant() {
        if (!db._settings) return false;
        await settingsDocRef().set({ ...sanitize(db._settings), _syncedAt: Date.now() }, { merge: true });
        hashes.__settings = hashOf(db._settings);
        return true;
    }

    async function importLegacyRootDataOnce(force = false) {
        if (!force) {
            try {
                if (localStorage.getItem(legacyImportStorageKey()) === 'true') return false;
            } catch (e) { }
        }

        let importedRecords = 0;
        let writtenRecords = 0;
        let importedSettings = false;
        console.log('[CloudSync] 🔎 دمج بيانات الجذر القديم مع قاعدة المدرس الجديدة...');

        for (const table of SYNC_TABLES) {
            const tenantSnap = await tableCollection(table).get({ source: 'server' });
            const tenantIds = new Set();
            tenantSnap.forEach(doc => tenantIds.add(String(doc.id)));

            const snap = await legacyTableCollection(table).get({ source: 'server' });
            const localArr = Array.isArray(db[table]) ? db[table] : (db[table] = []);
            const existingIds = new Set(localArr.map(r => String(r?.id)));
            const missingArr = [];
            const writeArr = [];
            snap.forEach(doc => {
                const rawId = doc.id;
                const numericId = isNaN(Number(rawId)) ? rawId : Number(rawId);
                const data = { ...doc.data(), id: numericId };
                delete data._syncedAt;
                if (!tenantIds.has(String(rawId))) writeArr.push(data);
                if (!existingIds.has(String(numericId))) missingArr.push(data);
            });

            if (writeArr.length > 0) {
                writtenRecords += await writeLegacyRecordsToTenant(table, writeArr);
            }
            if (missingArr.length > 0) {
                importedRecords += missingArr.length;
                await mergeRemoteTable(table, missingArr);
            }
        }

        const legacySettingsDoc = await legacySettingsDocRef().get({ source: 'server' });
        if (legacySettingsDoc.exists) {
            const legacySettings = { ...legacySettingsDoc.data() };
            delete legacySettings._syncedAt;
            importedSettings = mergeSettingsWithoutOverwritingCurrent(legacySettings);
            if (importedSettings) await writeLegacySettingsToTenant();
        }

        try { localStorage.setItem(legacyImportStorageKey(), 'true'); } catch (e) { }

        if (importedRecords > 0 || writtenRecords > 0 || importedSettings) {
            saveHashes();
            console.log(`[CloudSync] ✅ تم دمج ${importedRecords} سجل محلياً وكتابة ${writtenRecords} سجل من النظام القديم داخل قاعدة المدرس الجديدة`);
            return true;
        }

        return false;
    }

    async function importLegacyRootDataManual() {
        if (!ready || !fsDB) throw new Error('CloudSync not ready');
        setStatus('syncing');
        applyingRemote = true;
        try {
            const imported = await importLegacyRootDataOnce(true);
            saveHashes();
            queueTableUIRefresh(null);
            return imported;
        } finally {
            applyingRemote = false;
            pushAllTables();
            setStatus(navigator.onLine ? 'online' : 'offline');
        }
    }

    async function pullAllFromCloudInitial() {
        applyingRemote = true;
        try {
            const lastSync = getLastSyncTime();
            await importLegacyRootDataOnce(false);
            let tenantRecordCount = 0;
            for (const table of SYNC_TABLES) {
                let colQuery = tableCollection(table);
                if (lastSync > 0 && !isFreshSync) {
                    const safetyMargin = Math.max(0, lastSync - 1800000);
                    colQuery = colQuery.where('_syncedAt', '>=', safetyMargin);
                }
                const snap = await colQuery.get();
                const remoteArr = [];
                snap.forEach(doc => {
                    const rawId = doc.id;
                    const numericId = isNaN(Number(rawId)) ? rawId : Number(rawId);
                    const data = { ...doc.data(), id: numericId };
                    delete data._syncedAt;
                    remoteArr.push(data);
                });
                tenantRecordCount += remoteArr.length;

                if (remoteArr.length > 0) {
                    await mergeRemoteTable(table, remoteArr);
                }
            }

            const settingsDoc = await settingsDocRef().get();
            const tenantHasSettings = settingsDoc.exists;
            if (settingsDoc.exists) {
                const remoteSettings = { ...settingsDoc.data() };
                delete remoteSettings._syncedAt;
                db._settings = isFreshSync ? remoteSettings : { ...db._settings, ...remoteSettings };
                try { localStorage.setItem('edu_master_settings', JSON.stringify(db._settings)); } catch (e) {}
                hashes.__settings = hashOf(db._settings);
            }
            saveHashes();
            updateLastSyncTime();
            isFreshSync = false;

            // ✅ حماية مهمة: بعد الدمج، نضمن رفع أي بيانات محلية غير موجودة على السحابة
            applyingRemote = false;
            pushAllTables();
        } catch (e) {
            console.warn('[CloudSync] pullAllFromCloudInitial warning:', e);
        } finally {
            applyingRemote = false;
            queueTableUIRefresh(null);
        }
    }

    // ============================================================
    //  التهيئة
    // ============================================================

    async function init() {
        if (typeof firebase === 'undefined' || typeof firebase.firestore !== 'function') {
            console.error('[CloudSync] ❌ مكتبة Firebase لم تُحمَّل — لن تعمل المزامنة. تأكد من وجود ملفات firebase-app-compat.js و firebase-firestore-compat.js بجانب index.html');
            setStatus('offline');
            return;
        }

        console.log('[CloudSync] بدء التهيئة لمشروع:', FIREBASE_CONFIG.projectId);

        try {
            firebase.initializeApp(FIREBASE_CONFIG);
            fsDB = firebase.firestore();
            configureTenant();
            loadHashes();
            populateHashesFromLocal();

            // تفعيل الـ Persistence الخاصة بـ Firestore نفسها
            try {
                await fsDB.enablePersistence({ synchronizeTabs: true });
                console.log('[CloudSync] ✅ Offline persistence مُفعَّلة');
            } catch (e) {
                console.warn('[CloudSync] ⚠️ Firestore persistence لم تُفعَّل:', e.code || e.message);
            }

            ready = true;
            window._firestoreDB = fsDB;
            console.log('[CloudSync] ✅ الاتصال جاهز، مشروع Firebase:', FIREBASE_CONFIG.projectId);
            setStatus(navigator.onLine ? 'syncing' : 'offline');

            window.addEventListener('online', () => { console.log('[CloudSync] رجع النت — إعادة مزامنة'); setStatus('syncing'); pushAllTables(); });
            window.addEventListener('offline', () => setStatus('offline'));

            // عند الاتصال بمشروع جديد أو أول تشغيل: جلب ودمج كامل لجميع سجلات مشروع Firebase أولاً
            if (isFreshSync) {
                console.log('[CloudSync] 🔄 اتصال بمشروع جديد (' + FIREBASE_CONFIG.projectId + ') — تنزيل ودمج كل بيانات السحابة...');
                await pullAllFromCloudInitial();
            } else {
                pushAllTables();
            }
            attachAllListeners();

            setTimeout(() => setStatus(navigator.onLine ? 'online' : 'offline'), 2500);
        } catch (err) {
            console.error('[CloudSync] ❌ فشلت التهيئة:', err);
            setStatus('error');
        }
    }

    // للاختبار اليدوي من الـ console: CloudSync.debugInfo()
    function debugInfo() {
        const info = {
            ready,
            projectId: FIREBASE_CONFIG.projectId,
            tenantId,
            online: navigator.onLine,
            tablesTracked: Object.keys(hashes).filter(k => k !== '__settings'),
            recordCountsPerTable: {},
        };
        SYNC_TABLES.forEach(t => { info.recordCountsPerTable[t] = Array.isArray(db[t]) ? db[t].length : 'N/A'; });
        console.table(info.recordCountsPerTable);
        console.log('[CloudSync] الحالة:', info);
        return info;
    }

    return {
        init, onLocalSave, pushAllTables, isReady: () => ready, debugInfo,
        forceSync: pushAllTables,
        forceFullUpload,
        syncTableNow, deleteRecord, importLegacyRootData: importLegacyRootDataManual,
        manualPushToCloud, manualPullFromCloud,
        getFirestoreDB: () => fsDB
    };
})();

window.CloudSync = CloudSync;
window.manualPushToCloud = () => CloudSync.manualPushToCloud();
window.manualPullFromCloud = () => CloudSync.manualPullFromCloud();
