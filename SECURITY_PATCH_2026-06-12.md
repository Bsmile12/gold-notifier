# 🔐 Security Patch — gold-notifier (2026-06-12)

**ที่มา:** Audit ของ Mila bot v1.2.1 (ดู `XAU_project/AUDIT_REPORT_v1.2.1.md` ข้อ F-3) พบว่า endpoint ฝั่ง "เขียน" ของ notifier เปิดรับทุกคนโดยไม่มี authentication — บุคคลที่สามสามารถตั้ง alert ปลอม (= สัญญาณราคาปลอมเข้า Telegram), แก้ settings (รวมถึงสลับ Telegram token/chat id), push ราคาปลอม และล้างประวัติได้
**สถานะเดิมของโฟลเดอร์นี้:** ห้ามแก้ — **เจ้าของอนุมัติให้แก้เมื่อ 2026-06-12** เฉพาะงาน security patch นี้

---

## สิ่งที่แก้

### 1) `server.js` — เพิ่ม Write-API Auth

- เพิ่ม env ใหม่: **`API_SECRET`** (ไม่ตั้ง = โหมดเดิม เปิดหมด + มี warning ตอนสตาร์ท — ตั้งใจให้ deploy ได้ก่อนแล้วค่อยตั้งค่า ไม่มีทางพังกลางคัน)
- เพิ่ม middleware `apiAuth` — ผ่านได้ 2 ทาง:
  - `Authorization: Bearer <API_SECRET>` → สำหรับบอท Mila (ฝั่งบอทส่ง header นี้อยู่แล้วตั้งแต่ v1.2 ผ่าน env `TELEGRAM_ALERT_SECRET`)
  - `x-admin-token` header หรือ `?token=` ที่ตรงกับ `ADMIN_PASSWORD` → สำหรับแอดมิน
- บล็อกแล้ว log เป็น type `error` พร้อม IP เมื่อมีคนยิงไม่ผ่าน auth (เห็นใน admin panel)

**Endpoint ที่ถูกล็อก (เขียนทั้งหมด 6 ตัว):**

| Endpoint | เดิม | ใหม่ |
|---|---|---|
| `POST /api/alerts` | เปิด | 🔒 apiAuth |
| `DELETE /api/alerts/:id` | เปิด | 🔒 apiAuth |
| `POST /api/settings` | เปิด (แก้ Telegram token ได้!) | 🔒 apiAuth |
| `POST /api/price/push` | เปิด (ปลอมราคา → trigger alert ได้!) | 🔒 apiAuth |
| `POST /api/test-telegram` | เปิด | 🔒 apiAuth |
| `POST /api/history/clear` | เปิด | 🔒 apiAuth |

**Endpoint อ่านอย่างเดียว — ไม่เปลี่ยน:** `GET /api/price`, `GET /api/alerts`, `GET /api/history`, `GET /api/settings` (token ถูก mask อยู่แล้ว) และ `/admin/*` ใช้ adminAuth เดิม

### 2) `public/app.js` — หน้าเว็บ dashboard ส่ง secret อัตโนมัติ

- เพิ่ม `apiFetch()` wrapper: แนบ `Authorization: Bearer` จาก `localStorage('apiSecret')` ให้ทุก write call
- ครั้งแรกที่โดน 401 → เด้ง prompt ถาม secret หนึ่งครั้ง แล้วจำใน localStorage (ลบได้ด้วย `localStorage.removeItem('apiSecret')` ใน console)
- เปลี่ยน write call ทั้ง 6 จุด (save settings, toggle alerts, test telegram, create alert, delete alert, clear history) จาก `fetch` → `apiFetch` — ส่วนอ่าน (ราคา/รายการ/ประวัติ) ใช้ `fetch` เดิม ไม่ต้อง auth

---

## ผลการทดสอบ (รันจริงบนเครื่อง — ใช้ db.json สำเนาชั่วคราว ไม่แตะของจริง)

| เคส | คาดหวัง | ผล |
|---|---|---|
| POST /api/alerts ไม่มี auth | 401 | ✅ 401 |
| POST /api/alerts Bearer ผิด | 401 | ✅ 401 |
| POST /api/alerts Bearer ถูก | 200 + สร้าง alert | ✅ 200 |
| POST /api/settings ด้วย x-admin-token | 200 | ✅ 200 |
| GET /api/price ไม่มี auth | 200 (อ่านได้ปกติ) | ✅ 200 |
| DELETE /api/alerts ไม่มี auth | 401 | ✅ 401 |
| ไม่ตั้ง API_SECRET → POST เปิดเหมือนเดิม | 200 (backward-compat) | ✅ 200 |
| `node --check` server.js + app.js | ผ่าน | ✅ |

---

## ขั้นตอน Deploy (ต้องทำเองนอก patch นี้)

1. **Railway:** เพิ่ม env `API_SECRET=<สุ่มยาวๆ เช่น 32+ ตัวอักษร>` (และตรวจว่า `ADMIN_PASSWORD` ไม่ใช่ default `admin1234`)
2. **ฝั่งบอท Mila (.env):** ตั้ง `TELEGRAM_ALERT_SECRET=<ค่าเดียวกัน>`
3. push/deploy โค้ดชุดนี้ขึ้น Railway
4. เปิดหน้า dashboard ครั้งแรกหลัง deploy → ทำ action เขียนอะไรสักอย่าง → กรอก secret ตอน prompt หนึ่งครั้ง
5. ทดสอบ: `curl -X POST <url>/api/alerts -H "Content-Type: application/json" -d '{"targetPrice":1,"condition":"below"}'` → ต้องได้ 401

## ⚠️ พบเพิ่มระหว่างแก้ (ยังไม่ได้แก้ — รอตัดสินใจ)

- **`db.json` ไม่อยู่ใน `.gitignore`** และมี `telegramToken` จริงอยู่ข้างใน → token อยู่ใน git history ของ repo นี้ ถ้า repo เป็น public/เคย public ควร **revoke token ที่ @BotFather แล้วออกใหม่** และเพิ่ม `db.json` ใน .gitignore (ต้องย้าย settings ไป env หรือ seed file แยก เพราะ Railway ใช้ DATA_DIR)
- มีงานแก้ค้างใน working tree ก่อน patch นี้ (masked-token fix ใน `/api/test-telegram`) — ยังไม่ commit, ผมไม่ได้แตะ
