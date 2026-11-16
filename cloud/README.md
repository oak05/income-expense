# สมุดรายรับรายจ่าย — เวอร์ชัน Cloud (Vercel + Supabase + Apps Script OCR)

เปิดจากมือถือหรือเครื่องไหนก็ได้ผ่านอินเทอร์เน็ต **ใครก็สมัครใช้ได้ และแต่ละบัญชีมีสมุดของตัวเอง** คนอื่นมองไม่เห็น

```
เบราว์เซอร์ ──/api/*──> Vercel Functions ──┬─ Supabase Auth      (สมัคร / เข้าสู่ระบบ / อีเมลยืนยัน / ตั้งรหัสผ่านใหม่)
 (หน้าเว็บเดิม)        (cookie, ตรวจคำขอ)   ├─ Supabase Postgres  (ข้อมูลทั้งหมด แยกตามบัญชีด้วย row-level security)
                                           ├─ Supabase Storage   (รูป/PDF ใบเสร็จ แยกโฟลเดอร์ตามบัญชี)
                                           └─ Apps Script        (อ่านตัวอักษรจากใบเสร็จด้วย Google Drive OCR — ไม่เก็บอะไร)
```

| ส่วน | อยู่ที่ไหน | ทำอะไร |
|---|---|---|
| หน้าเว็บ | `vercel/public/` | สมุดบัญชี, สแกนใบเสร็จ, เข้าสู่ระบบ, สมัคร, ลืมรหัสผ่าน (HTML/CSS/JS ไม่มี build step) |
| ฟังก์ชัน | `vercel/api/` + `vercel/lib/` | เข้าสู่ระบบกับ Supabase, เก็บ session ใน cookie, เรียกฐานข้อมูลในนามผู้ใช้, เก็บไฟล์, เรียก OCR, หายอดจากใบเสร็จ |
| ฐานข้อมูล | `supabase/migrations/` | ตาราง, สิทธิ์แยกตามบัญชี, คำสั่งของแอป (เป็นฟังก์ชันใน Postgres ทำงานครบทั้งชุดหรือไม่ทำเลย) |
| อีเมล | `supabase/templates/` | ข้อความอีเมลยืนยันการสมัครและตั้งรหัสผ่านใหม่ (ภาษาไทย) |
| OCR | `apps-script/Ocr.gs` | รับไฟล์ → ให้ Drive อ่านตัวอักษร → ส่งข้อความกลับ → ลบไฟล์ชั่วคราว |
| ทดลองในเครื่อง | `dev/` | Supabase จำลอง (PGlite = Postgres ในเครื่อง), Apps Script จำลอง, ใช้กับเทสและ `npm run dev` |
| เทส | `tests/` | รันด้วย `npm test` (ต้องมี Node.js 22+) |

เวอร์ชันในเครื่องเดิม (โฟลเดอร์ `app/`) ยังอยู่ครบและใช้ได้เหมือนเดิม สองเวอร์ชันไม่ได้ใช้ข้อมูลร่วมกัน

## ลองในเครื่องก่อน (ไม่ต้องมีบัญชีอะไร)

```bash
cd cloud
npm install        # ครั้งแรกครั้งเดียว (ติดตั้ง PGlite สำหรับทดลอง/เทสเท่านั้น)
npm run dev        # เปิด http://localhost:3000
```

- บัญชีทดลอง: `dev@example.com` / `dev-password` และ `dev2@example.com` / `dev-password` (ลองดูว่าสองบัญชีเห็นข้อมูลแยกกัน)
- สมัครบัญชีใหม่ได้: อีเมลยืนยันและอีเมลตั้งรหัสผ่านใหม่ **จะแสดงในหน้าต่าง terminal** แทนการส่งจริง — คัดลอกลิงก์ไปเปิด
- ข้อมูลอยู่ในหน่วยความจำ ปิดโปรแกรมแล้วหาย; OCR คืนข้อความตัวอย่าง (ไม่ได้อ่านรูปจริง)

## ติดตั้งจริง

ต้องมี: บัญชี Supabase (แพ็กเกจ Free), บัญชี Google, บัญชี GitHub, บัญชี Vercel (Hobby ฟรี),
และบริการส่งอีเมล (เช่น Resend หรือ Brevo มีแพ็กเกจฟรี) — **จำเป็น** เพราะต้องส่งอีเมลให้คนที่สมัคร

### ขั้นที่ 1 — Supabase: ฐานข้อมูล

1. ที่ [supabase.com](https://supabase.com) กด **New project** — Region เลือก **Southeast Asia (Singapore)** ตั้งรหัสผ่านฐานข้อมูลแล้วเก็บไว้
2. เมนู **SQL Editor** → **New query** → วางเนื้อหาไฟล์ใน `supabase/migrations/` **ทีละไฟล์ตามลำดับเลข** (`0001` → `0006`) แล้วกด **Run** ทุกไฟล์
   - หรือใช้ Supabase CLI: `cd cloud && npx supabase link --project-ref <ref>` แล้ว `npx supabase db push`
3. เมนู **Project Settings → API Keys** คัดลอก 3 ค่าไว้ใช้ในขั้นที่ 4:
   - **Project URL** (เช่น `https://abcd.supabase.co`)
   - **Publishable key** (`sb_publishable_…`) หรือ anon key แบบเดิม (`eyJ…`)
   - **Secret key** (`sb_secret_…`) หรือ service_role key แบบเดิม — **ห้ามเปิดเผย** แอปใช้คีย์นี้แค่นับการใส่รหัสผ่านผิดเท่านั้น

### ขั้นที่ 2 — Supabase: การสมัครและอีเมล

1. **Authentication → Sign In / Providers → Email**: เปิด **Enable Email provider**, เปิด **Confirm email**,
   เปิด **Allow new users to sign up**, ตั้ง **Minimum password length = 8**
2. **Authentication → URL Configuration**: **Site URL** = URL ของแอปบน Vercel (เช่น `https://ชื่อโปรเจกต์.vercel.app`)
   — ยังไม่มี URL ให้กลับมาตั้งหลังขั้นที่ 4 (อีเมลจะลิงก์ผิดจนกว่าจะตั้ง)
3. **ตั้งบริการส่งอีเมล (SMTP)** — อีเมลในตัวของ Supabase ส่งได้เฉพาะอีเมลของทีมโปรเจกต์ และจำกัดจำนวนมาก
   คนอื่นที่สมัครจะไม่ได้รับอีเมล ตัวอย่างกับ **Resend**:
   1. สมัคร [resend.com](https://resend.com) → **Domains → Add Domain** ใส่โดเมนที่คุณมี แล้วเพิ่ม DNS record ตามที่บอกจน Verified
   2. **API Keys → Create API Key** (สิทธิ์ Sending access) คัดลอกไว้
   3. ที่ Supabase **Authentication → Emails → SMTP Settings** เปิด **Enable Custom SMTP** แล้วใส่
      Host `smtp.resend.com`, Port `465`, Username `resend`, Password = API key ข้อ 2,
      Sender email = `no-reply@โดเมนของคุณ`, Sender name = `สมุดรายรับรายจ่าย`
   - ไม่มีโดเมน: ใช้ Brevo ได้ (ยืนยันอีเมลผู้ส่งทีละอีเมลแทนโดเมน) — ค่า SMTP ดูในหน้า SMTP & API ของ Brevo
   - **ไม่ตั้งบริการส่งอีเมลเลย** (เหมาะกับใช้กันเองไม่กี่คน): ที่ **Authentication → Sign In / Providers → Email** ปิด **Confirm email**
     สมัครแล้วเข้าใช้ได้ทันทีโดยไม่ต้องยืนยันอีเมล แอปปรับตามเอง ข้อเสีย: "ลืมรหัสผ่าน" ใช้ได้เฉพาะอีเมลของทีมโปรเจกต์ Supabase
     (คนอื่นจะเห็นข้อความให้ติดต่อผู้ดูแล — ตั้งรหัสใหม่ให้ได้ที่ **Authentication → Users**), ไม่มีการตรวจว่าอีเมลเป็นของผู้สมัครจริง
     และหน้าสมัครจะบอกได้ว่าอีเมลไหนมีบัญชีแล้ว — จะเปิดอีเมลภายหลังก็แค่ตั้ง SMTP แล้วเปิด Confirm email กลับ
4. **Authentication → Emails → Templates**:
   - **Confirm signup**: Subject `ยืนยันอีเมล — สมุดรายรับรายจ่าย`, Body = เนื้อหา `supabase/templates/confirm-signup.html`
   - **Reset password**: Subject `ตั้งรหัสผ่านใหม่ — สมุดรายรับรายจ่าย`, Body = เนื้อหา `supabase/templates/reset-password.html`
   - ลิงก์ในเทมเพลตพาไปหน้า `confirm.html` ของแอปเอง ที่ต้องกดปุ่มอีกครั้ง (กันโปรแกรมสแกนลิงก์ในอีเมลใช้ลิงก์ไปก่อน) — อย่าเปลี่ยนเป็น `{{ .ConfirmationURL }}`
5. **Authentication → Rate Limits**: ค่า "sign-ups and sign-ins" นับต่อที่อยู่ IP แต่ทุกคำขอมาจากเซิร์ฟเวอร์ Vercel
   ถ้าผู้ใช้หลายคนเข้าสู่ระบบพร้อมกันแล้วเจอ "ระบบบัญชีผู้ใช้ทำงานไม่สำเร็จ" ให้เพิ่มค่านี้
   (แอปมีตัวจำกัดของตัวเองต่อผู้ใช้จริงอยู่แล้ว ดูหัวข้อความปลอดภัย)

### ขั้นที่ 3 — Google Apps Script: อ่านใบเสร็จ

1. ไปที่ [script.google.com](https://script.google.com) → **New project** ตั้งชื่อเช่น "OCR ใบเสร็จ"
2. ลบโค้ดตัวอย่างใน `Code.gs` แล้ววางเนื้อหาจาก `apps-script/Ocr.gs`
3. กด **+** ข้าง "Services" → เลือก **Drive API** → Add
4. บันทึก แล้วเลือกฟังก์ชัน **`setup`** → กด **Run** (ครั้งแรก Google ขอสิทธิ์ Drive/Docs ให้กดอนุญาต
   ถ้าขึ้นว่า "Google hasn't verified this app" ให้กด Advanced → Go to … เพราะเป็นสคริปต์ของคุณเอง)
5. ดู **Execution log** จะมีบรรทัด `APPS_SCRIPT_SECRET (ใส่ใน Vercel): …` — คัดลอกไว้ (ดูอีกครั้งได้ด้วย `showSecret`)
6. **Deploy → New deployment** → ประเภท **Web app**, Execute as **Me**, Who has access **Anyone** → Deploy → คัดลอก **Web app URL** (ลงท้าย `/exec`)
7. ทดสอบ: เลือกฟังก์ชัน **`testOcr`** → **Run** ต้องขึ้น `อ่านใบเสร็จได้ปกติ` (ถ้า Google ขอสิทธิ์ Drive ให้กดอนุญาต แล้วรันอีกครั้ง)
   — แก้โค้ดภายหลังให้ใช้ **Deploy → Manage deployments → ✏️ → Version: New version** (URL เดิม ไม่ต้องแก้ Vercel)

สคริปต์นี้ไม่มีข้อมูลของใคร: รับไฟล์ อ่านตัวอักษร แล้วลบไฟล์ชั่วคราวทันที ทุกคำขอต้องมีรหัสลับ

### ขั้นที่ 4 — Vercel

1. push โปรเจกต์ขึ้น GitHub
2. ที่ Vercel กด **Add New → Project** → เลือก repo → **Root Directory:** `cloud/vercel`, **Framework Preset:** Other
3. ใส่ **Environment Variables** 5 ตัว แล้วกด Deploy

| ชื่อ | ค่า |
|---|---|
| `SUPABASE_URL` | Project URL จากขั้นที่ 1 ข้อ 3 |
| `SUPABASE_ANON_KEY` | Publishable key (หรือ anon key) |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key (หรือ service_role key) |
| `APPS_SCRIPT_URL` | Web app URL จากขั้นที่ 3 ข้อ 6 |
| `APPS_SCRIPT_SECRET` | ค่าจากขั้นที่ 3 ข้อ 5 |

4. นำ URL ที่ Vercel ให้ไปใส่ **Site URL** ใน Supabase (ขั้นที่ 2 ข้อ 2)
5. เปิด URL → **สมัครสมาชิก** → เปิดลิงก์ในอีเมล → กดยืนยัน → เริ่มใช้งาน

### ตรวจหลังติดตั้ง (ทำครั้งเดียวกับระบบจริง)

เทสในเครื่องใช้ Supabase จำลอง จึงควรลองกับของจริงหนึ่งรอบ:

- [ ] สมัครด้วยอีเมลจริง ได้อีเมลภาษาไทย กดลิงก์แล้วกดปุ่ม → เข้าสู่ระบบได้ เห็นหมวดหมู่เริ่มต้น 15 หมวด
- [ ] จดรายการ, ดูภาพรวมเดือน, ตั้งงบประมาณหมวด
- [ ] สแกนใบเสร็จ 1 ใบ → อ่านยอดได้ → บันทึก → กดดูรูปใบเสร็จจากรายการได้
- [ ] สมัครอีกบัญชี (อีกอีเมล) → ไม่เห็นข้อมูลของบัญชีแรก
- [ ] ออกจากระบบ → ลืมรหัสผ่าน → ได้อีเมล → ตั้งรหัสใหม่ → เข้าด้วยรหัสใหม่ได้ รหัสเก่าใช้ไม่ได้
- [ ] ลบบัญชีที่สองจากเมนู → เข้าสู่ระบบด้วยบัญชีนั้นไม่ได้อีก และใน Storage ไม่มีโฟลเดอร์ของบัญชีนั้น

## ย้ายข้อมูลจากเวอร์ชัน Google Sheet หรือ Docker

1. เวอร์ชันเดิม: **นำเข้า / ส่งออก → ดาวน์โหลด CSV ทั้งหมด** (ทำ **ก่อน** เปลี่ยนโค้ด Apps Script)
2. เวอร์ชันนี้: สมัคร → เข้าสู่ระบบ → **นำเข้า / ส่งออก → นำเข้า CSV**

ได้รายการและหมวดหมู่ครบ (นำเข้าซ้ำได้ไม่เบิ้ล) สิ่งที่ไม่ตามมา: รูปใบเสร็จ, สีของหมวดที่สร้างเอง และงบประมาณ (ตั้งใหม่ในเมนูหมวดหมู่)
Google Sheet เดิมไม่ถูกลบ เก็บไว้เป็นสำเนาได้; ถ้าใช้โปรเจกต์ Apps Script เดิมสำหรับ OCR ให้แทนที่ `Code.gs` + `Parser.gs` ด้วย `Ocr.gs` แล้ว deploy เวอร์ชันใหม่

## ใช้งานต่างจากเวอร์ชัน Google Sheet ตรงไหน

- **หลายคนใช้ได้** แต่ละบัญชีมีสมุด หมวดหมู่ และใบเสร็จของตัวเอง
- **เร็วกว่า:** ไม่ต้องผ่าน Apps Script ทุกคำสั่ง (ยกเว้นตอนอ่านใบเสร็จ)
- **บันทึกครบหรือไม่บันทึกเลย:** บันทึกใบเสร็จหลายใบ, นำเข้า CSV, ลบหมวดแล้วย้ายรายการ — ถ้าผิดพลาดกลางทาง จะไม่มีอะไรถูกเขียน
- **สำรองข้อมูล:** ดาวน์โหลด CSV ได้ทุกเมื่อ; Supabase แพ็กเกจฟรีไม่มีสำรองอัตโนมัติให้ดาวน์โหลด
- เมนูบัญชี (แถบด้านซ้าย หรือเมนู ⋯ บนมือถือ): **เปลี่ยนรหัสผ่าน**, **ลบบัญชี** (ลบข้อมูลและรูปใบเสร็จทั้งหมด ย้อนกลับไม่ได้), **ออกจากระบบ**
- รูปใบเสร็จรวมกันได้ไม่เกิน **100 MB ต่อบัญชี** (ลบใบเสร็จเก่าเพื่อเพิ่มที่)

## ข้อจำกัดของ Supabase แพ็กเกจฟรี

- **โปรเจกต์หยุดชั่วคราวเมื่อไม่มีการใช้งานราว 1 สัปดาห์** — แอปจะขึ้น "ติดต่อ Supabase ไม่ได้"
  ให้เข้า Supabase Dashboard แล้วกด **Restore project** (ข้อมูลอยู่ครบ) ใช้งานทุกสัปดาห์จะไม่โดน
- ฐานข้อมูล 500 MB, Storage 1 GB รวมทุกบัญชี — ใช้ส่วนตัว/ครอบครัวไม่ถึง
- ถ้ามีคนสมัครมากหรือต้องการสำรองข้อมูลอัตโนมัติ ให้พิจารณาแพ็กเกจ Pro

## อัปเดต

- **หน้าเว็บ / ฟังก์ชัน:** push ขึ้น GitHub แล้ว Vercel deploy ให้เอง
- **ฐานข้อมูล:** ถ้ามีไฟล์ใหม่ใน `supabase/migrations/` ให้รันเฉพาะไฟล์ใหม่ตามลำดับ (ไฟล์เดิมรันซ้ำไม่ได้)
- **OCR:** วางโค้ด `Ocr.gs` ใหม่ → **Deploy → Manage deployments → Edit → Version: New version** (URL เดิมยังใช้ได้)

## ความปลอดภัย

- **แยกข้อมูลตามบัญชีที่ฐานข้อมูล:** ทุกตารางมี row-level security — บัญชีหนึ่งอ่าน/แก้แถวของอีกบัญชีไม่ได้
  แม้โค้ด Vercel ผิดพลาด เพราะ Vercel เรียกฐานข้อมูลด้วย token ของผู้ใช้คนนั้นเอง; ไฟล์ใน Storage ก็จำกัดตามโฟลเดอร์ของบัญชี
- **คีย์ลับไม่ถึงเบราว์เซอร์:** เบราว์เซอร์คุยกับ `/api` ของ Vercel เท่านั้น ไม่เห็น URL หรือคีย์ของ Supabase/Apps Script
  Secret key ของ Supabase ใช้แค่นับการใส่รหัสผ่านผิด ไม่เคยใช้อ่านหรือเขียนข้อมูลของใคร
- **Session:** token ของ Supabase อยู่ใน cookie `HttpOnly; Secure; SameSite=Strict` (สคริปต์ในหน้าเว็บอ่านไม่ได้) อยู่ได้ 30 วัน
  ต่ออายุอัตโนมัติ; ออกจากระบบ = ยกเลิก session ที่ Supabase ด้วย
- **จำกัดการเดา/สแปม:** ใส่รหัสผ่านผิด 8 ครั้ง (ต่ออีเมลต่อที่อยู่) = รอ 15 นาที; สมัคร / ขอลิงก์ตั้งรหัสใหม่ / ขออีเมลยืนยันซ้ำ
  ได้อย่างละ 5 ครั้งต่อชั่วโมงต่อที่อยู่ — นับที่ Vercel เพราะ Supabase เห็นทุกคำขอมาจาก Vercel
- **ไม่บอกว่าใครมีบัญชี:** สมัครด้วยอีเมลที่มีอยู่แล้ว หรือขอลิงก์ตั้งรหัสใหม่ให้อีเมลที่ไม่มี — หน้าเว็บตอบเหมือนกัน
- **ลิงก์ในอีเมลใช้ได้ครั้งเดียว** และต้องกดปุ่มในหน้าเว็บก่อน (โปรแกรมสแกนลิงก์ในอีเมลจึงใช้แทนไม่ได้)
- คำสั่งแก้ไขข้อมูลต้องมาจากหน้าเว็บของแอปเอง (ตรวจ `Origin`, `Sec-Fetch-Site`, header `X-Requested-With`)
- หน้าเว็บมี Content-Security-Policy (รันได้เฉพาะสคริปต์ของแอป, เชื่อมต่อได้เฉพาะเว็บตัวเอง) และห้ามฝังใน iframe
- **ลบบัญชีได้เอง** ข้อมูลและไฟล์ทั้งหมดของบัญชีถูกลบทันที
- ถ้ารหัสลับ Apps Script หลุด: รัน `rotateSecret` แล้วแก้ `APPS_SCRIPT_SECRET` ใน Vercel และ redeploy;
  ถ้า Secret key ของ Supabase หลุด: สร้างใหม่ใน Project Settings → API Keys แล้วแก้ใน Vercel

## แก้ปัญหา

| ข้อความ | สาเหตุ / วิธีแก้ |
|---|---|
| ยังตั้งค่าไม่ครบ: เพิ่ม … ใน Environment Variables | ใส่ตัวแปรที่ระบุใน Vercel แล้ว **Redeploy** |
| Supabase ไม่ยอมรับ SUPABASE_ANON_KEY | คัดลอก Publishable/anon key ใหม่ (ระวังช่องว่างหัวท้าย) |
| ตรวจสิทธิ์เข้าสู่ระบบไม่สำเร็จ — ตรวจ SUPABASE_SERVICE_ROLE_KEY | Secret key ผิด หรือยังไม่ได้รัน `0005_auth.sql` |
| ฐานข้อมูลยังไม่ได้ตั้งค่า — รันไฟล์ใน cloud/supabase/migrations | รัน migration ให้ครบ 6 ไฟล์ตามลำดับ |
| ติดต่อ Supabase ไม่ได้ | โปรเจกต์ถูกหยุดชั่วคราว (ไม่มีการใช้งาน ~1 สัปดาห์) → Restore project; หรือ `SUPABASE_URL` ผิด |
| สมัครแล้วไม่ได้อีเมล | ยังไม่ได้ตั้ง Custom SMTP (ขั้นที่ 2 ข้อ 3) หรืออีเมลไปอยู่ในสแปม; ดู **Authentication → Logs** |
| ระบบนี้ยังส่งอีเมลไม่ได้ — ติดต่อผู้ดูแล… | ไม่ได้ตั้ง SMTP: ตั้งรหัสใหม่ให้ผู้ใช้ที่ **Authentication → Users** หรือตั้ง SMTP (ขั้นที่ 2 ข้อ 3) |
| ลิงก์ในอีเมลพาไปเว็บผิด / localhost | ตั้ง **Site URL** ให้เป็น URL ของ Vercel |
| ยังไม่ได้ยืนยันอีเมล | เปิดลิงก์ในอีเมล หรือกด "ส่งอีเมลยืนยันอีกครั้ง" ในหน้าเข้าสู่ระบบ |
| ลิงก์นี้ใช้แล้วหรือหมดอายุ | ลิงก์ใช้ได้ครั้งเดียว ภายใน 1 ชั่วโมง — ขอลิงก์ใหม่ |
| ระบบบัญชีผู้ใช้ (Supabase) ทำงานไม่สำเร็จ | มักเป็น rate limit ของ Supabase (ขั้นที่ 2 ข้อ 5) ดู **Authentication → Logs** |
| สแกนแล้วขึ้น "อ่านตัวอักษรจากไฟล์ไม่สำเร็จ" ทุกใบ | ตรวจ `APPS_SCRIPT_URL` (ลงท้าย `/exec`, Who has access = Anyone) และ `APPS_SCRIPT_SECRET`; ดู log ใน Vercel |
| ยังไม่ได้เพิ่มบริการ Drive API ใน Apps Script | Services → + → Drive API แล้ว deploy เวอร์ชันใหม่ |
| อ่านตัวอักษรจากไฟล์ไม่สำเร็จ ใส่ยอดเองได้ (ทุกใบ) | รัน `testOcr` ใน Apps Script จะเห็นสาเหตุจริง (มักเป็นยังไม่ได้อนุญาตสิทธิ์ Drive); สาเหตุยังอยู่ใน Vercel → Logs บรรทัด `ocr failed in Apps Script` |
| พื้นที่เก็บใบเสร็จของบัญชีนี้เต็มแล้ว (100 MB) | ลบใบเสร็จหรือรายการเก่าที่มีรูปแนบ |

## API ภายใน (สำหรับนักพัฒนา)

`POST /api/rpc` รับ `{action, params}` จากหน้าเว็บที่เข้าสู่ระบบแล้ว แต่ละ action คือฟังก์ชัน `public.api_<action>` ใน Postgres
(เช่น `month.get` → `api_month_get`) เรียกผ่าน PostgREST ด้วย token ของผู้ใช้

| action | ทำอะไร |
|---|---|
| `month.get {month}` | ยอดรวม, เทียบเดือนก่อน, ยอดสะสม, แยกหมวด, รายวัน และรายการของเดือน |
| `yearly.get {year}` | 12 เดือน + หมวดรายจ่ายสูงสุด |
| `transactions.create / update / delete / list / import` | รายการ |
| `categories.list / create / update / delete` | หมวดหมู่ (`update` รับ `budget`: ไม่ส่ง = คงเดิม, `null`/`0` = ไม่มีงบ, เฉพาะหมวดรายจ่าย) |
| `receipts.upload / list / update / delete / commit` | ใบเสร็จ (`upload` ส่งไฟล์เป็น base64; Vercel เก็บไฟล์ อ่าน OCR แล้วสร้างร่าง) |
| `info` | `{version, email}` |

อื่น ๆ: `POST /api/login {email, password}`, `POST /api/logout`, `GET /api/session` → `{authenticated, email}`,
`POST /api/signup {email, password}`, `POST /api/recover {email}`, `POST /api/resend {email}`,
`POST /api/verify {token_hash, type}`, `POST /api/password {password}`, `POST /api/account {action: "delete", email}`,
`GET /api/file?id=` (รูป/PDF ใบเสร็จจาก Storage)
