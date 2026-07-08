// ============================================================
//  handouts-module.js  —  وحدة إدارة الملازم (Module مستقلة)
//  ------------------------------------------------------------
//  ✅ لا تُعدّل أي سكريبت أو دالة موجودة في النظام إطلاقاً.
//  ✅ تعتمد بالكامل على البنية التحتية الموجودة أصلاً:
//       - db.handouts        (id, title, grade, groupId, price, date)
//       - db.studentHandouts (id, studentId, handoutId, date, paid, amount)
//       - db.payments        (نفس آلية "ملزمة/مذكرة" المستخدمة أصلاً في recordQuickAction)
//     وهي جداول IndexedDB مُنشأة بالفعل داخل StorageEngine.init() فلا حاجة لأي
//     تعديل في قاعدة البيانات أو رفع رقم نسختها.
//  ✅ تتكامل تلقائياً مع الخزينة (finances ledger) والوصولات (receipts) لأن كلاهما
//     يعتمد بالفعل على db.payments بشكل عام (category: 'ملزمة/مذكرة' معروفة سلفاً).
//  ✅ لا تعتمد على أي تعديل داخل showSection أو openSmartCard — بل تُغلّفهما
//     (wrapping) من الخارج دون المساس بكودهما الأصلي.
// ============================================================

(function () {

    // ────────────────────────────────────────────────────────
    // 0. حالة الوحدة (State) الخاصة بها فقط
    // ────────────────────────────────────────────────────────
    let _handoutEditId = null;
    let _currentHandoutIdForStudents = null;
    let _handoutPickerStudentId = null;

    // ────────────────────────────────────────────────────────
    // 1. أدوات مساعدة عامة (Helpers)
    // ────────────────────────────────────────────────────────

    /** يُطبّع قيمة الصف الدراسي بالاعتماد على grade-mapping.js إن وُجدت */
    function _normGrade(g) {
        try {
            if (typeof normalizeGrade === 'function') return normalizeGrade(g);
        } catch (e) { /* ignore */ }
        return g;
    }

    /** يُعيد الاسم العربي الكامل للصف الدراسي */
    function _gradeLabel(g) {
        try {
            if (typeof gradeLabel === 'function') return gradeLabel(g);
        } catch (e) { /* ignore */ }
        const FALLBACK = {
            prim1: 'أولى ابتدائي', prim2: 'ثانية ابتدائي', prim3: 'ثالثة ابتدائي',
            prim4: 'رابعة ابتدائي', prim5: 'خامسة ابتدائي', prim6: 'سادسة ابتدائي',
            prep1: 'أولى إعدادي', prep2: 'ثانية إعدادي', prep3: 'ثالثة إعدادي',
            '1': 'أولى ثانوي', '2': 'ثانية ثانوي', '3': 'ثالثة ثانوي',
        };
        return FALLBACK[g] || g || '---';
    }

    /** يبني <option> لكل السنوات الدراسية داخل select معيّن */
    function _populateGradeSelect(selectEl, selectedValue) {
        if (!selectEl) return;
        if (typeof buildGradeOptions === 'function') {
            selectEl.innerHTML = buildGradeOptions(selectedValue || '', false);
            return;
        }
        // Fallback بسيط في حال تعذّر تحميل grade-mapping.js لأي سبب
        const FALLBACK_LIST = [
            ['prim1', 'أولى ابتدائي'], ['prim2', 'ثانية ابتدائي'], ['prim3', 'ثالثة ابتدائي'],
            ['prim4', 'رابعة ابتدائي'], ['prim5', 'خامسة ابتدائي'], ['prim6', 'سادسة ابتدائي'],
            ['prep1', 'أولى إعدادي'], ['prep2', 'ثانية إعدادي'], ['prep3', 'ثالثة إعدادي'],
            ['1', 'أولى ثانوي'], ['2', 'ثانية ثانوي'], ['3', 'ثالثة ثانوي'],
        ];
        selectEl.innerHTML = '<option value="">اختر الصف الدراسي</option>' +
            FALLBACK_LIST.map(([code, label]) =>
                `<option value="${code}"${code === selectedValue ? ' selected' : ''}>${label}</option>`
            ).join('');
    }

    function _uid() {
        return Date.now() + Math.floor(Math.random() * 100000);
    }

    function _fmtDate(d) {
        try { return new Date(d).toLocaleDateString('ar-EG'); } catch (e) { return ''; }
    }

    /** يُعيد قائمة الطلاب التابعين لصف ملزمة معيّنة */
    function _studentsForHandout(handout) {
        if (!handout) return [];
        return (db.students || []).filter(s => _normGrade(s.grade) === handout.grade);
    }

    /** هل الطالب دافع لهذه الملزمة؟ يُعيد سجل studentHandouts إن وُجد */
    function _getStudentHandoutRecord(studentId, handoutId) {
        return (db.studentHandouts || []).find(sh =>
            sh.studentId == studentId && sh.handoutId == handoutId
        );
    }

    function _isPaidRecord(rec) {
        return !!(rec && rec.paid);
    }

    // ────────────────────────────────────────────────────────
    // 2. إحصائيات كل ملزمة
    // ────────────────────────────────────────────────────────
    function _computeHandoutStats(handout) {
        const students = _studentsForHandout(handout);
        let paidCount = 0, totalCollected = 0;
        students.forEach(s => {
            const rec = _getStudentHandoutRecord(s.id, handout.id);
            if (_isPaidRecord(rec)) {
                paidCount++;
                totalCollected += Number(rec.amount || handout.price || 0);
            }
        });
        return {
            total: students.length,
            paid: paidCount,
            unpaid: students.length - paidCount,
            collected: totalCollected,
            remaining: Math.max(0, (students.length - paidCount) * Number(handout.price || 0)),
            percent: students.length ? Math.round((paidCount / students.length) * 100) : 0,
        };
    }

    // ────────────────────────────────────────────────────────
    // 3. عرض جدول الملازم (الرئيسي)
    // ────────────────────────────────────────────────────────
    function renderHandoutsSection() {
        const tbody = document.getElementById('handouts-list');
        if (!tbody) return;

        const viewMode = (document.getElementById('handouts-archive-toggle') || {}).value || 'active';
        const list = (db.handouts || []).filter(h =>
            viewMode === 'archived' ? !!h.archived : !h.archived
        );

        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-muted);">
                ${viewMode === 'archived' ? 'لا يوجد ملازم مؤرشفة' : 'لا يوجد ملازم مضافة بعد — اضغط "إضافة ملزمة" للبدء'}
            </td></tr>`;
            return;
        }

        tbody.innerHTML = list.map(h => {
            const stats = _computeHandoutStats(h);
            const isActive = h.status !== 'inactive';
            const statusBadge = isActive
                ? '<span class="status-badge" style="background:#dcfce7; color:#166534; border:1px solid #bbf7d0;">مُفعّلة ✅</span>'
                : '<span class="status-badge" style="background:#f3f4f6; color:#4b5563; border:1px solid #e5e7eb;">متوقفة ⏸️</span>';

            const actions = viewMode === 'archived' ? `
                <button class="btn" style="background:var(--accent); color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="unarchiveHandout(${h.id})" title="استرجاع من الأرشيف">
                    <i class="fas fa-box-open"></i>
                </button>
                <button class="btn" style="background:var(--primary); color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="openHandoutStudents(${h.id})" title="عرض الطلاب">
                    <i class="fas fa-users"></i>
                </button>
            ` : `
                <button class="btn" style="background:var(--primary); color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="openHandoutStudents(${h.id})" title="عرض الطلاب">
                    <i class="fas fa-users"></i>
                </button>
                <button class="btn" style="background:var(--royal-gold); color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="openEditHandoutModal(${h.id})" title="تعديل">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn" style="background:${isActive ? '#6b7280' : 'var(--accent)'}; color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="toggleHandoutStatus(${h.id})" title="${isActive ? 'إيقاف' : 'تفعيل'}">
                    <i class="fas fa-power-off"></i>
                </button>
                <button class="btn" style="background:#0ea5e9; color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="archiveHandout(${h.id})" title="أرشفة">
                    <i class="fas fa-archive"></i>
                </button>
                <button class="btn" style="background:var(--danger); color:#fff; padding:5px 10px; font-size:0.8rem;" onclick="deleteHandout(${h.id})" title="حذف">
                    <i class="fas fa-trash"></i>
                </button>
            `;

            return `
                <tr>
                    <td><strong>${h.title}</strong></td>
                    <td>${_gradeLabel(h.grade)}</td>
                    <td>${Number(h.price || 0)} ج.م</td>
                    <td>${stats.total}</td>
                    <td style="color:var(--accent); font-weight:700;">${stats.paid}</td>
                    <td style="color:var(--danger); font-weight:700;">${stats.unpaid}</td>
                    <td style="color:var(--primary); font-weight:700;">${stats.collected} ج.م</td>
                    <td>${statusBadge}</td>
                    <td style="white-space:nowrap;">${actions}</td>
                </tr>
            `;
        }).join('');
    }

    // ────────────────────────────────────────────────────────
    // 4. إضافة / تعديل ملزمة
    // ────────────────────────────────────────────────────────
    function openAddHandoutModal() {
        _handoutEditId = null;
        document.getElementById('handout-modal-title').innerText = 'إضافة ملزمة جديدة';
        document.getElementById('handout-edit-id').value = '';
        document.getElementById('handout-title').value = '';
        document.getElementById('handout-price').value = '';
        _populateGradeSelect(document.getElementById('handout-grade'), (typeof currentGrade !== 'undefined' ? currentGrade : ''));
        toggleModal('handout-modal', true);
    }

    function openEditHandoutModal(id) {
        const h = (db.handouts || []).find(x => x.id == id);
        if (!h) return;
        _handoutEditId = h.id;
        document.getElementById('handout-modal-title').innerText = 'تعديل الملزمة';
        document.getElementById('handout-edit-id').value = h.id;
        document.getElementById('handout-title').value = h.title;
        document.getElementById('handout-price').value = h.price;
        _populateGradeSelect(document.getElementById('handout-grade'), h.grade);
        toggleModal('handout-modal', true);
    }

    async function saveHandout() {
        const title = (document.getElementById('handout-title').value || '').trim();
        const price = Number(document.getElementById('handout-price').value || 0);
        const grade = document.getElementById('handout-grade').value;

        if (!title) return showNotification('⚠️ يرجى إدخال اسم الملزمة', 'warning');
        if (!grade) return showNotification('⚠️ يرجى اختيار المجموعة (الصف الدراسي) — إجباري', 'warning');
        if (!price || price < 0) return showNotification('⚠️ يرجى إدخال سعر صحيح للملزمة', 'warning');

        db.handouts = db.handouts || [];

        if (_handoutEditId) {
            const h = db.handouts.find(x => x.id == _handoutEditId);
            if (h) {
                h.title = title;
                h.price = price;
                h.grade = grade;
            }
            showNotification('✅ تم تعديل بيانات الملزمة بنجاح', 'success');
        } else {
            db.handouts.push({
                id: _uid(),
                title,
                price,
                grade,
                groupId: null,
                status: 'active',
                archived: false,
                date: new Date().toISOString(),
            });
            showNotification('✅ تم إضافة الملزمة بنجاح', 'success');
        }

        await db.save('handouts');
        toggleModal('handout-modal', false);
        renderHandoutsSection();
        if (typeof playSound === 'function') playSound('success');
    }

    async function deleteHandout(id) {
        const h = (db.handouts || []).find(x => x.id == id);
        if (!h) return;
        if (!confirm(`هل أنت متأكد من حذف ملزمة "${h.title}"؟ سيتم حذف سجلات الدفع الخاصة بها من المتابعة (لن تُحذف المدفوعات السابقة من الخزينة).`)) return;

        db.handouts = db.handouts.filter(x => x.id != id);
        db.studentHandouts = (db.studentHandouts || []).filter(sh => sh.handoutId != id);

        await db.save('handouts');
        await db.save('studentHandouts');
        showNotification('🗑️ تم حذف الملزمة', 'success');
        renderHandoutsSection();
    }

    async function toggleHandoutStatus(id) {
        const h = (db.handouts || []).find(x => x.id == id);
        if (!h) return;
        h.status = (h.status === 'inactive') ? 'active' : 'inactive';
        await db.save('handouts');
        showNotification(h.status === 'active' ? '✅ تم تفعيل الملزمة' : '⏸️ تم إيقاف الملزمة', 'success');
        renderHandoutsSection();
    }

    async function archiveHandout(id) {
        const h = (db.handouts || []).find(x => x.id == id);
        if (!h) return;
        if (!confirm(`هل تريد أرشفة ملزمة "${h.title}"؟ لن تُفقد بياناتها ويمكن الرجوع إليها من "أرشيف الملازم".`)) return;
        h.archived = true;
        await db.save('handouts');
        showNotification('📦 تم أرشفة الملزمة بنجاح', 'success');
        renderHandoutsSection();
    }

    async function unarchiveHandout(id) {
        const h = (db.handouts || []).find(x => x.id == id);
        if (!h) return;
        h.archived = false;
        await db.save('handouts');
        showNotification('📤 تم استرجاع الملزمة من الأرشيف', 'success');
        renderHandoutsSection();
    }

    // ────────────────────────────────────────────────────────
    // 5. عرض طلاب ملزمة معيّنة + البحث + الفلاتر + الدفع
    // ────────────────────────────────────────────────────────
    function openHandoutStudents(id) {
        const h = (db.handouts || []).find(x => x.id == id);
        if (!h) return;
        _currentHandoutIdForStudents = id;
        document.getElementById('handout-students-title').innerText = `طلاب ملزمة: ${h.title} (${_gradeLabel(h.grade)})`;
        const searchEl = document.getElementById('handout-students-search');
        const filterEl = document.getElementById('handout-students-filter');
        if (searchEl) searchEl.value = '';
        if (filterEl) filterEl.value = 'all';
        renderHandoutStudentsList();
        toggleModal('handout-students-modal', true);
    }

    function renderHandoutStudentsList() {
        const h = (db.handouts || []).find(x => x.id == _currentHandoutIdForStudents);
        const tbody = document.getElementById('handout-students-list');
        if (!h || !tbody) return;

        const searchTerm = (document.getElementById('handout-students-search').value || '').trim().toLowerCase();
        const filter = document.getElementById('handout-students-filter').value || 'all';

        let students = _studentsForHandout(h);

        if (searchTerm) {
            students = students.filter(s =>
                (s.name && s.name.toLowerCase().includes(searchTerm)) ||
                (s.qrCode && String(s.qrCode).includes(searchTerm))
            );
        }

        const rows = students.map(s => {
            const rec = _getStudentHandoutRecord(s.id, h.id);
            const paid = _isPaidRecord(rec);
            return { student: s, rec, paid };
        }).filter(r => {
            if (filter === 'paid') return r.paid;
            if (filter === 'unpaid') return !r.paid;
            return true;
        });

        // تحديث التقرير السريع أعلى المودال
        const stats = _computeHandoutStats(h);
        const reportEl = document.getElementById('handout-students-report');
        if (reportEl) {
            reportEl.innerHTML = `
                <span class="status-badge" style="background:var(--bg-light);">إجمالي: ${stats.total}</span>
                <span class="status-badge" style="background:#dcfce7; color:#166534;">دفعوا: ${stats.paid}</span>
                <span class="status-badge" style="background:#fee2e2; color:#991b1b;">لم يدفعوا: ${stats.unpaid}</span>
                <span class="status-badge" style="background:#e0e7ff; color:#3730a3;">نسبة التحصيل: ${stats.percent}%</span>
                <span class="status-badge" style="background:#dbeafe; color:#1e40af;">المحصّل: ${stats.collected} ج.م</span>
                <span class="status-badge" style="background:#fef3c7; color:#92400e;">المتبقي: ${stats.remaining} ج.م</span>
            `;
        }

        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--text-muted);">لا يوجد طلاب مطابقين</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(({ student: s, rec, paid }) => `
            <tr>
                <td style="text-align:center;">
                    ${paid ? '' : `<input type="checkbox" class="handout-student-checkbox" data-student-id="${s.id}">`}
                </td>
                <td><strong>${s.name}</strong></td>
                <td style="font-family:monospace; color:var(--text-muted);">${s.qrCode || ''}</td>
                <td>${s.phone || '-'}</td>
                <td>
                    ${paid
                        ? `<span style="color:var(--accent); font-weight:700;">🟢 تم الدفع${rec && rec.date ? ` (${_fmtDate(rec.date)})` : ''}</span>`
                        : `<span style="color:var(--danger); font-weight:700;">🔴 لم يدفع</span>`
                    }
                </td>
                <td>
                    ${paid
                        ? `<button class="btn" style="background:#f3f4f6; color:#4b5563; padding:5px 12px; font-size:0.8rem;" onclick="unmarkHandoutPaid(${s.id})">إلغاء الدفع</button>`
                        : `<button class="btn" style="background:var(--accent); color:#fff; padding:5px 12px; font-size:0.8rem;" onclick="markHandoutPaid(${s.id})">تم الدفع</button>`
                    }
                </td>
            </tr>
        `).join('');
    }

    function toggleSelectAllHandoutStudents(checkbox) {
        document.querySelectorAll('.handout-student-checkbox').forEach(cb => { cb.checked = checkbox.checked; });
    }

    // ────────────────────────────────────────────────────────
    // 6. تسجيل الدفع (فردي / جماعي) — يربط بالخزينة تلقائياً
    // ────────────────────────────────────────────────────────
    async function _recordHandoutPayment(studentId, handout) {
        const now = new Date().toISOString();
        const existing = _getStudentHandoutRecord(studentId, handout.id);

        if (existing) {
            existing.paid = true;
            existing.amount = Number(handout.price || 0);
            existing.date = now;
        } else {
            db.studentHandouts = db.studentHandouts || [];
            db.studentHandouts.push({
                id: _uid(),
                studentId,
                handoutId: handout.id,
                paid: true,
                amount: Number(handout.price || 0),
                date: now,
            });
        }

        db.payments = db.payments || [];
        db.payments.push({
            id: _uid(),
            studentId,
            amount: Number(handout.price || 0),
            date: now,
            category: 'ملزمة/مذكرة',
            cycleId: db.settings.activeCycle || 'misc',
            handoutId: handout.id,
            handoutTitle: handout.title,
        });
    }

    async function markHandoutPaid(studentId) {
        const h = (db.handouts || []).find(x => x.id == _currentHandoutIdForStudents);
        if (!h) return;
        const s = db.students.find(x => x.id == studentId);
        if (!s) return;

        await _recordHandoutPayment(studentId, h);
        await db.save('studentHandouts');
        await db.save('payments');

        showNotification(`✅ تم تسجيل دفع ملزمة "${h.title}" للطالب: ${s.name}`, 'success');
        if (typeof playSound === 'function') playSound('success');

        renderHandoutStudentsList();
        renderHandoutsSection();
        if (typeof updateDashboardStats === 'function') updateDashboardStats();
        if (document.getElementById('payments-section') && document.getElementById('payments-section').style.display === 'block' && typeof renderFinances === 'function') {
            renderFinances();
        }
        if (typeof renderReceiptsList === 'function') renderReceiptsList();
    }

    async function unmarkHandoutPaid(studentId) {
        const h = (db.handouts || []).find(x => x.id == _currentHandoutIdForStudents);
        if (!h) return;
        if (!confirm('هل تريد إلغاء تسجيل دفع هذه الملزمة لهذا الطالب؟ (لن يتم حذف السجل المالي القديم من الخزينة تلقائياً)')) return;

        const rec = _getStudentHandoutRecord(studentId, h.id);
        if (rec) rec.paid = false;
        await db.save('studentHandouts');

        renderHandoutStudentsList();
        renderHandoutsSection();
        showNotification('تم إلغاء حالة الدفع', 'warning');
    }

    async function batchMarkPaidSelectedHandout() {
        const h = (db.handouts || []).find(x => x.id == _currentHandoutIdForStudents);
        if (!h) return;

        const checkboxes = document.querySelectorAll('.handout-student-checkbox:checked');
        if (!checkboxes.length) return showNotification('⚠️ يرجى تحديد طالب واحد على الأقل', 'warning');

        if (!confirm(`هل تريد تسجيل دفع ملزمة "${h.title}" لـ ${checkboxes.length} طالب دفعة واحدة؟`)) return;

        for (const cb of checkboxes) {
            const studentId = cb.getAttribute('data-student-id');
            await _recordHandoutPayment(studentId, h);
        }

        await db.save('studentHandouts');
        await db.save('payments');

        showNotification(`✅ تم تسجيل الدفع الجماعي لـ ${checkboxes.length} طالب`, 'success');
        if (typeof playSound === 'function') playSound('success');

        renderHandoutStudentsList();
        renderHandoutsSection();
        if (typeof updateDashboardStats === 'function') updateDashboardStats();
    }

    // ────────────────────────────────────────────────────────
    // 7. الطباعة — كشف الملزمة (نفس أسلوب showCycleArchive)
    // ────────────────────────────────────────────────────────
    function printHandoutSheet() {
        const h = (db.handouts || []).find(x => x.id == _currentHandoutIdForStudents);
        if (!h) return;

        const students = _studentsForHandout(h).map(s => {
            const rec = _getStudentHandoutRecord(s.id, h.id);
            return { s, paid: _isPaidRecord(rec), date: rec ? rec.date : null };
        });

        const stats = _computeHandoutStats(h);

        const rowsHtml = students.map(({ s, paid, date }) => `
            <tr>
                <td><strong>${s.name}</strong></td>
                <td style="font-family:monospace;">${s.qrCode || ''}</td>
                <td>${s.phone || '-'}</td>
                <td style="color:${paid ? '#166534' : '#991b1b'}; font-weight:bold;">${paid ? 'تم الدفع 🟢' : 'لم يدفع 🔴'}</td>
                <td>${date ? _fmtDate(date) : '-'}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" style="text-align:center; padding:2rem;">لا يوجد طلاب</td></tr>';

        const reportHtml = `
        <html dir="rtl">
        <head>
            <title>كشف ملزمة: ${h.title}</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap');
                body { font-family: 'Tajawal', sans-serif; padding: 2rem; color:#1e293b; }
                h1 { text-align:center; margin-bottom:0.5rem; }
                .sub { text-align:center; color:#64748b; margin-bottom:1.5rem; }
                .stats { display:flex; gap:1rem; justify-content:center; flex-wrap:wrap; margin-bottom:2rem; }
                .stat { background:#f5f8fc; border:1px solid #dbe5f0; border-radius:12px; padding:0.6rem 1.2rem; font-weight:700; }
                table { width:100%; border-collapse:collapse; }
                th, td { border:1px solid #dbe5f0; padding:0.6rem; text-align:right; }
                th { background:#f5f8fc; }
                @media print { .no-print { display:none; } }
            </style>
        </head>
        <body>
            <h1>كشف ملزمة: ${h.title}</h1>
            <div class="sub">المجموعة: ${_gradeLabel(h.grade)} — سعر الملزمة: ${h.price} ج.م — تاريخ الطباعة: ${new Date().toLocaleDateString('ar-EG')}</div>
            <div class="stats">
                <div class="stat">إجمالي الطلاب: ${stats.total}</div>
                <div class="stat">دفعوا: ${stats.paid}</div>
                <div class="stat">لم يدفعوا: ${stats.unpaid}</div>
                <div class="stat">نسبة التحصيل: ${stats.percent}%</div>
                <div class="stat">إجمالي المحصّل: ${stats.collected} ج.م</div>
                <div class="stat">إجمالي المتبقي: ${stats.remaining} ج.م</div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>اسم الطالب</th>
                        <th>الكود</th>
                        <th>رقم الهاتف</th>
                        <th>حالة الدفع</th>
                        <th>تاريخ الدفع</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            <div class="no-print" style="text-align:center; margin-top:2rem;">
                <button onclick="window.print()" style="padding:0.7rem 2rem; border:none; border-radius:10px; background:#2563eb; color:#fff; font-weight:700; cursor:pointer;">
                    طباعة
                </button>
            </div>
        </body>
        </html>`;

        const win = window.open('', '_blank');
        win.document.write(reportHtml);
        win.document.close();
    }

    // ────────────────────────────────────────────────────────
    // 8. الدفع من شاشة الحضور والماسح ("دفع ملزمة")
    //    نُغلّف openSmartCard الأصلية دون تعديلها لإضافة زر جديد
    // ────────────────────────────────────────────────────────
    function openHandoutPickerForStudent(studentId) {
        const s = db.students.find(x => x.id == studentId);
        if (!s) return;
        _handoutPickerStudentId = studentId;

        const studentGrade = _normGrade(s.grade);
        const availableHandouts = (db.handouts || []).filter(h =>
            !h.archived && h.status !== 'inactive' && h.grade === studentGrade
        );

        const listEl = document.getElementById('handout-picker-list');
        if (!listEl) return;

        if (!availableHandouts.length) {
            listEl.innerHTML = `<p style="text-align:center; color:var(--text-muted); padding:1rem;">
                لا توجد ملازم مضافة لمجموعة هذا الطالب (${_gradeLabel(studentGrade)}) حتى الآن.
            </p>`;
        } else {
            listEl.innerHTML = availableHandouts.map(h => {
                const rec = _getStudentHandoutRecord(studentId, h.id);
                const paid = _isPaidRecord(rec);
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:0.9rem; border:1px solid var(--border); border-radius:12px; margin-bottom:0.75rem;">
                        <div>
                            <strong>${h.title}</strong><br>
                            <small style="color:var(--text-muted);">${Number(h.price || 0)} ج.م</small>
                        </div>
                        ${paid
                            ? '<span class="status-badge" style="background:#dcfce7; color:#166534;">مدفوعة ✅</span>'
                            : `<button class="btn" style="background:var(--vibrant-orange); color:#fff; padding:6px 16px;" onclick="payHandoutFromAttendance(${h.id})">تسجيل الدفع</button>`
                        }
                    </div>
                `;
            }).join('');
        }

        toggleModal('handout-picker-modal', true);
    }

    async function payHandoutFromAttendance(handoutId) {
        const h = (db.handouts || []).find(x => x.id == handoutId);
        const s = db.students.find(x => x.id == _handoutPickerStudentId);
        if (!h || !s) return;

        await _recordHandoutPayment(s.id, h);
        await db.save('studentHandouts');
        await db.save('payments');

        showNotification(`✅ تم تسجيل دفع ملزمة "${h.title}" للطالب: ${s.name}`, 'success');
        if (typeof playSound === 'function') playSound('success');
        if (typeof updateDashboardStats === 'function') updateDashboardStats();

        toggleModal('handout-picker-modal', false);
        // تحديث البطاقة الذكية إن كانت مفتوحة
        if (typeof openSmartCard === 'function' && document.getElementById('smart-card-modal').style.display === 'flex') {
            openSmartCard(s.id);
        }
    }

    // تغليف openSmartCard لإضافة زر "دفع ملزمة" جديد دون المساس بالدالة الأصلية
    function _wrapOpenSmartCard() {
        if (typeof window.openSmartCard !== 'function' || window.openSmartCard._handoutsWrapped) return;
        const _original = window.openSmartCard;
        function wrapped(studentId) {
            _original(studentId);
            const container = document.getElementById('smart-card-content');
            if (!container) return;
            // تجنّب تكرار الزر لو اتضاف قبل كده
            if (container.querySelector('#handout-picker-trigger-btn')) return;
            const btn = document.createElement('button');
            btn.id = 'handout-picker-trigger-btn';
            btn.className = 'btn';
            btn.style.cssText = 'width:100%; height:50px; border-radius:12px; margin-top:10px; background:var(--royal-gold); color:#fff; font-weight:700;';
            btn.innerHTML = '<i class="fas fa-book"></i> دفع ملزمة (اختيار من القائمة)';
            btn.onclick = function () { openHandoutPickerForStudent(studentId); };
            container.appendChild(btn);
        }
        wrapped._handoutsWrapped = true;
        window.openSmartCard = wrapped;
    }

    // ────────────────────────────────────────────────────────
    // 9. تغليف showSection لدعم قسم 'handouts' الجديد
    //    (بدون تعديل أي سطر داخل app.js)
    // ────────────────────────────────────────────────────────
    const KNOWN_SECTIONS = [
        'dashboard-section', 'students-section', 'attendance-section',
        'absence-section', 'payments-section', 'analytics-section',
        'exams-section', 'fame-section', 'backup-section',
        'whatsapp-section', 'fast-grading-section', 'certificates-section',
        'groups-section', 'group-detail-section', 'idcards-section',
        'daily-treasury-section', 'shifts-section', 'settings-section',
        'platform-codes-section', 'receipts-section', 'platform-activation-section',
        'employee-platform-sync-section'
    ];

    function _wrapShowSection() {
        if (typeof window.showSection !== 'function' || window.showSection._handoutsWrapped) return;
        const _originalShowSection = window.showSection;

        function wrapped(sectionId, btnEl) {
            const ourSection = document.getElementById('handouts-section');

            if (sectionId === 'handouts') {
                if (typeof RBAC !== 'undefined' && !RBAC.canViewSection('handouts')) {
                    showNotification('⛔ ليس لديك صلاحية الوصول لهذا القسم.', 'error');
                    return;
                }
                if (typeof stopAllCameraScanners === 'function') stopAllCameraScanners();

                KNOWN_SECTIONS.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.style.display = 'none';
                });
                if (ourSection) ourSection.style.display = 'block';

                if (btnEl) {
                    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                    btnEl.classList.add('active');
                }
                const titleEl = document.getElementById('page-title');
                if (titleEl) titleEl.innerText = 'إدارة الملازم';

                renderHandoutsSection();
                if (typeof updateDashboardStats === 'function') updateDashboardStats();
                if (typeof updateExperienceSummary === 'function') updateExperienceSummary();
                return;
            }

            // أي قسم آخر: أخفِ قسمنا (لأن الدالة الأصلية لا "تعرف" بوجوده) ثم فوّض للدالة الأصلية
            if (ourSection) ourSection.style.display = 'none';
            return _originalShowSection(sectionId, btnEl);
        }

        wrapped._handoutsWrapped = true;
        window.showSection = wrapped;
    }

    // ────────────────────────────────────────────────────────
    // 10. التهيئة
    // ────────────────────────────────────────────────────────
    function _init() {
        _wrapShowSection();
        _wrapOpenSmartCard();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }
    // احتياطي: تأكد من التغليف حتى لو تم تعريف الدوال الأصلية بعد هذا الملف بلحظات
    window.addEventListener('load', _init);

    // ────────────────────────────────────────────────────────
    // 11. تصدير الدوال للاستخدام من onclick= داخل الـ HTML
    // ────────────────────────────────────────────────────────
    window.renderHandoutsSection = renderHandoutsSection;
    window.openAddHandoutModal = openAddHandoutModal;
    window.openEditHandoutModal = openEditHandoutModal;
    window.saveHandout = saveHandout;
    window.deleteHandout = deleteHandout;
    window.toggleHandoutStatus = toggleHandoutStatus;
    window.archiveHandout = archiveHandout;
    window.unarchiveHandout = unarchiveHandout;
    window.openHandoutStudents = openHandoutStudents;
    window.renderHandoutStudentsList = renderHandoutStudentsList;
    window.toggleSelectAllHandoutStudents = toggleSelectAllHandoutStudents;
    window.markHandoutPaid = markHandoutPaid;
    window.unmarkHandoutPaid = unmarkHandoutPaid;
    window.batchMarkPaidSelectedHandout = batchMarkPaidSelectedHandout;
    window.printHandoutSheet = printHandoutSheet;
    window.openHandoutPickerForStudent = openHandoutPickerForStudent;
    window.payHandoutFromAttendance = payHandoutFromAttendance;

})();
