# สมุดรายรับรายจ่าย — เวอร์ชัน Cloud (Vercel + Apps Script + Google Sheet)

เวอร์ชันนี้ไม่ต้องเปิดคอมหรือ Docker ทิ้งไว้ เปิดจากมือถือหรือเครื่องไหนก็ได้ผ่านอินเทอร์เน็ต

```
เบราว์เซอร์ ──HTTPS──> Vercel (หน้าเว็บ + ล็อกอิน + /api) ──HTTPS + รหัสลับ──> Apps Script ──> Google Sheet (ข้อมูล)
                                                                                       └──> Google Drive (รูปใบเสร็จ + OCR)
```

| ส่วน | อยู่ที่ไหน | ทำอะไร |
|---|---|---|
| หน้าเว็บ | `vercel/public/` | หน้าสมุดบัญชี, สแกนใบเสร็จ, ล็อกอิน (HTML/CSS/JS ไม่มี build step) |
| ฟังก์ชัน | `vercel/api/` + `vercel/lib/server.js` | ตรวจรหัสผ่าน, ออก session cookie, ส่งต่อคำสั่งไป Apps Script |
| หลังบ้าน | `apps-script/Code.gs`, `Parser.gs` | อ่าน/เขียน Google Sheet, เก็บไฟล์ใน Drive, OCR, หายอดจากใบเสร็จ |
| ทดลองในเครื่อง | `dev/` | จำลอง Google + Vercel ในเครื่อง ใช้กับเทสและ `npm run dev` |
| เทส | `tests/` | 60 เทส รันด้วย `npm test` (ต้องมี Node.js 22+) |

เวอร์ชัน Docker เดิม (โฟลเดอร์ `app/`) ยังอยู่ครบและใช้ได้เหมือนเดิม สองเวอร์ชันไม่ได้ใช้ข้อมูลร่วมกัน

## ลองในเครื่องก่อน (ไม่ต้องมีบัญชีอะไร)

```bash
cd cloud
npm run dev        # เปิด http://localhost:3000  รหัสผ่าน: dev-password
```

โหมดนี้ใช้ Google จำลอง: ข้อมูลอยู่ในหน่วยความจำ และ OCR คืนข้อความตัวอย่าง (ไม่ได้อ่านรูปจริง)

## ติดตั้งจริง

ต้องมี: บัญชี Google (Gmail ส่วนตัวใช้ได้), บัญชี GitHub, บัญชี Vercel (แพ็กเกจ Hobby ฟรี)

### ขั้นที่ 1 — Google Sheet + Apps Script

1. สร้าง Google Sheet ใหม่ ตั้งชื่อเช่น "สมุดรายรับรายจ่าย"
2. เมนู **Extensions (ส่วนขยาย) → Apps Script**
3. ลบโค้ดตัวอย่างใน `Code.gs` แล้ววางเนื้อหาจาก `apps-script/Code.gs`
4. กด **+** ข้าง "Files" → **Script** → ตั้งชื่อ `Parser` → วางเนื้อหาจาก `apps-script/Parser.gs`
5. กด **+** ข้าง "Services" → เลือก **Drive API** → Add (ใช้อ่านตัวอักษรจากรูป)
6. บันทึก แล้วเลือกฟังก์ชัน **`setup`** ที่แถบด้านบน → กด **Run**
   - ครั้งแรก Google จะขอสิทธิ์เข้าถึง Sheet/Drive/Docs ของคุณ ให้กดอนุญาต
     (ถ้าขึ้นว่า "Google hasn't verified this app" ให้กด Advanced → Go to (ชื่อโปรเจกต์) — เพราะเป็นสคริปต์ของคุณเอง)
7. ดู **Execution log** ด้านล่าง จะมีบรรทัด `APPS_SCRIPT_SECRET (ใส่ใน Vercel): ...` — คัดลอกค่านี้ไว้
   (ดูอีกครั้งได้ด้วยการรันฟังก์ชัน `showSecret`)
8. กด **Deploy → New deployment** → ประเภท **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - กด Deploy แล้วคัดลอก **Web app URL** (ลงท้ายด้วย `/exec`)

ชื่อเมนูด้านบนเป็นภาษาอังกฤษ ถ้าหน้าจอของคุณเป็นภาษาไทย ตำแหน่งปุ่มจะเหมือนกัน

`setup` สร้างแท็บ `categories`, `transactions`, `receipts`, `meta` และโฟลเดอร์ "รายรับรายจ่าย - ใบเสร็จ" ใน Drive ให้
แท็บเปล่าที่ติดมากับไฟล์ (เช่น "แผ่น1") ลบได้

> "Anyone" หมายถึงใครก็เรียก URL นี้ได้ แต่ทุกคำสั่งต้องมีรหัสลับ `APPS_SCRIPT_SECRET` (64 ตัวอักษรแบบสุ่ม)
> ถ้าไม่มีจะได้แค่คำตอบว่า unauthorized — อย่าเปิดเผย URL คู่กับรหัสลับนี้

ใช้ `clasp` แทนการวางโค้ดก็ได้: `clasp create --type sheets --rootDir apps-script` แล้ว `clasp push`
(ไฟล์ `appsscript.json` ตั้งค่า Drive API และเว็บแอปไว้ให้แล้ว)

### ขั้นที่ 2 — Vercel

1. push โปรเจกต์นี้ขึ้น GitHub
2. ที่ Vercel กด **Add New → Project** → เลือก repo
   - **Root Directory:** `cloud/vercel`
   - **Framework Preset:** Other (ไม่ต้องใส่ Build Command)
3. ใส่ **Environment Variables** 4 ตัว แล้วกด Deploy

| ชื่อ | ค่า |
|---|---|
| `APP_PASSWORD` | รหัสผ่านเข้าแอป อย่างน้อย 8 ตัว (แนะนำ 16 ตัวขึ้นไป แบบสุ่ม เพราะแอปเปิดจากอินเทอร์เน็ตได้) |
| `SESSION_SECRET` | ข้อความสุ่มอย่างน้อย 32 ตัว สร้างด้วย `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APPS_SCRIPT_URL` | URL เว็บแอปจากขั้นที่ 1 ข้อ 8 |
| `APPS_SCRIPT_SECRET` | ค่าจากขั้นที่ 1 ข้อ 7 |

4. เปิด URL ที่ Vercel ให้ (เช่น `https://ชื่อโปรเจกต์.vercel.app`) → ใส่รหัสผ่าน

ไม่ใช้ GitHub ก็ได้: `cd cloud/vercel && npx vercel` แล้วตั้งค่าตัวแปรด้วย `npx vercel env add`

### ย้ายข้อมูลจากเวอร์ชัน Docker

1. เวอร์ชัน Docker: **นำเข้า / สำรองข้อมูล → ดาวน์โหลด CSV ทั้งหมด**
2. เวอร์ชัน Cloud: **นำเข้า / ส่งออก → นำเข้า CSV**

ได้รายการและหมวดหมู่ครบ (นำเข้าซ้ำได้ไม่เบิ้ล) สิ่งที่ไม่ตามมา: รูปใบเสร็จ และสีของหมวดหมู่ที่สร้างเอง

## ใช้งานต่างจากเวอร์ชัน Docker ตรงไหน

- **ช้ากว่า:** ทุกคำสั่งวิ่ง Vercel → Apps Script → Sheet ใช้เวลาราว 1–3 วินาที, อ่านใบเสร็จนานกว่านั้น
- **สแกนใบเสร็จ:** เบราว์เซอร์ย่อรูปให้ไม่เกิน 2000 px / 2 MB ก่อนส่ง (ลบข้อมูลตำแหน่งในรูปไปด้วย), PDF ต้องไม่เกิน 2 MB,
  ไฟล์ HEIC ที่เบราว์เซอร์เปิดไม่ได้ต้องแปลงเป็น JPG ก่อน
- **สำรองข้อมูล:** ไม่มีไฟล์ .zip แล้ว ใช้ **ไฟล์ → ประวัติเวอร์ชัน** หรือ **ทำสำเนา** ของ Google Sheet แทน และยังดาวน์โหลด CSV ได้
- **แก้ข้อมูลใน Sheet ตรง ๆ ได้** แต่อย่าเปลี่ยนชื่อแท็บ ลำดับคอลัมน์ หรือเลขในคอลัมน์ `id`
- ออกจากระบบได้ที่ปุ่ม **ออกจากระบบ**; session อยู่ได้ 30 วัน

## อัปเดต

- **หน้าเว็บ / ฟังก์ชัน:** push ขึ้น GitHub แล้ว Vercel deploy ให้เอง
- **หลังบ้าน:** วางโค้ดใหม่ใน Apps Script → รัน `setup` อีกครั้ง (ข้อมูลเดิมอยู่ครบ) →
  **Deploy → Manage deployments → Edit → Version: New version** (URL เดิมยังใช้ได้)
  ถ้าไม่สร้างเวอร์ชันใหม่ เว็บแอปจะยังรันโค้ดเก่า

## ความปลอดภัย

- ข้อมูลอยู่ใน Google Sheet และ Drive ของบัญชีคุณ ไม่มีสำเนาที่ Vercel (Vercel เก็บแค่โค้ดและตัวแปร 4 ตัว)
- เบราว์เซอร์ไม่เคยเห็น URL หรือรหัสลับของ Apps Script — คุยกับ `/api` ของ Vercel เท่านั้น
- Cookie เป็น `HttpOnly; Secure; SameSite=Strict` ลงลายเซ็นด้วย HMAC; เปลี่ยน `APP_PASSWORD` หรือ `SESSION_SECRET` = ทุกเครื่องหลุดจากระบบ
- คำสั่งแก้ไขข้อมูลต้องมาจากหน้าเว็บของแอปเอง (ตรวจ `Origin`, `Sec-Fetch-Site`, header `X-Requested-With`)
- ใส่รหัสผ่านผิด 8 ครั้งจากที่อยู่เดียวกัน = รอ 15 นาที
- หน้าเว็บมี Content-Security-Policy (รันได้เฉพาะสคริปต์ของแอปเอง) และห้ามฝังใน iframe
- ข้อความที่ขึ้นต้นด้วย `=` `+` `-` `@` ถูกเก็บเป็นข้อความเสมอ ทั้งใน Sheet และไฟล์ CSV (กันสูตรแฝง)
- ถ้ารหัสลับหลุด: รัน `rotateSecret` ใน Apps Script แล้วแก้ `APPS_SCRIPT_SECRET` ใน Vercel และ redeploy

## แก้ปัญหา

| ข้อความ | สาเหตุ / วิธีแก้ |
|---|---|
| ยังตั้งค่าไม่ครบ: เพิ่ม … ใน Environment Variables | ใส่ตัวแปรที่ระบุใน Vercel แล้ว **Redeploy** |
| หลังบ้านตอบกลับผิดรูปแบบ — ตรวจ APPS_SCRIPT_URL … | URL ผิด (ต้องลงท้าย `/exec`) หรือ Who has access ไม่ใช่ "Anyone" |
| หลังบ้านไม่ยอมรับรหัสลับ | `APPS_SCRIPT_SECRET` ไม่ตรง รัน `showSecret` แล้วคัดลอกใหม่ |
| ไม่พบแผ่นงาน … / ยังไม่ได้ตั้งค่าหลังบ้าน | รัน `setup` ใน Apps Script |
| ติดต่อหลังบ้านไม่ได้หรือใช้เวลานานเกินไป | ลองใหม่; ถ้าเป็นบ่อยดูเมนู **Executions** ในหน้า Apps Script |
| แก้โค้ด Apps Script แล้วไม่เห็นผล | ยังไม่ได้สร้าง **New version** ของ deployment |
| อ่านยอดใบเสร็จผิด | กดเลือกจาก "ยอดอื่นที่พบ" หรือพิมพ์เอง; ดู "ข้อความที่อ่านได้" ว่า Drive อ่านตัวอักษรออกมาอย่างไร |

## ข้อจำกัดที่ควรรู้

- Google Sheet ไม่มี transaction แบบฐานข้อมูล: แอปตรวจข้อมูลครบก่อนเขียนและล็อกทีละคำสั่ง
  แต่ถ้า Google ขัดข้องกลางคำสั่งที่เขียนหลายแถว (เช่นบันทึกใบเสร็จหลายใบ) อาจเขียนได้ไม่ครบ
- เหมาะกับข้อมูลระดับหลักพัน–หมื่นรายการ; ทุกคำสั่งอ่านทั้งแท็บ ยิ่งเยอะยิ่งช้า
- Apps Script มีโควตารายวันของบัญชี Google (เวลารันรวมและจำนวนครั้งที่เรียก Drive) การใช้งานส่วนตัวปกติไม่ถึง

## API ภายใน (สำหรับนักพัฒนา)

`POST /api/rpc` รับ `{action, params}` จากหน้าเว็บที่ล็อกอินแล้ว แล้วส่งต่อเป็น `{secret, action, params}` ไปที่ Apps Script

| action | ทำอะไร |
|---|---|
| `month.get {month}` | ยอดรวม, เทียบเดือนก่อน, ยอดสะสม, แยกหมวด, รายวัน และรายการของเดือน (ครั้งเดียวได้ครบ) |
| `yearly.get {year}` | 12 เดือน + หมวดรายจ่ายสูงสุด |
| `transactions.create / update / delete / list / import` | รายการ |
| `categories.list / create / update / delete` | หมวดหมู่ |
| `receipts.upload / list / update / delete / commit` | ใบเสร็จ (ไฟล์ส่งเป็น base64) |
| `info` | ลิงก์ไป Google Sheet และโฟลเดอร์ใบเสร็จ |

`GET /api/file?id=` ส่งรูป/PDF ใบเสร็จจาก Drive, `POST /api/login`, `POST /api/logout`, `GET /api/session`
