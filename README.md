# สมุดรายรับรายจ่าย (สำหรับ Windows)

เว็บแอปบันทึกรายรับรายจ่ายส่วนตัว รันตรงบน Windows ในเครื่องของคุณเอง — ไม่ต้องมี Docker (จะใช้ Docker ก็ได้)
ข้อมูลเก็บในเครื่อง ไม่ส่งออกไปที่ไหน ใช้งานผ่านเบราว์เซอร์ที่ `http://localhost:8080`

## ภาพรวม

```
income-expense-app/
├── start.bat            ← ดับเบิลคลิกเพื่อเปิดแอป (ครั้งแรกติดตั้งให้เอง + เปิดเบราว์เซอร์)
├── stop.bat             ← ปิดแอป (ข้อมูลยังอยู่)
├── backup.bat           ← สำรองข้อมูล + รูปใบเสร็จ ลงโฟลเดอร์ backups\
├── logs.bat             ← ดู log เวลามีปัญหา (ไฟล์ logs\app.log)
├── setup.bat            ← ติดตั้ง Python, Tesseract, ภาษาไทย (start.bat เรียกให้เองเมื่อจำเป็น)
├── docker-start.bat     ← (ทางเลือก) เปิดแอปด้วย Docker Desktop
├── docker-stop.bat      ← (ทางเลือก) ปิดแอปที่รันด้วย Docker
├── docker-logs.bat      ← (ทางเลือก) ดู log ของ Docker
├── data\                ← ข้อมูลของคุณ (finance.db + รูปใบเสร็จ)
├── .env                 ← ตั้งค่าพอร์ต / รหัสผ่าน / เปิดให้มือถือเข้า
├── docker-compose.yml
├── Dockerfile
├── requirements.txt     ← ไลบรารีที่แอปใช้ (requirements-dev.txt = เครื่องมือทดสอบ)
├── .github/workflows/   ← CI/CD: lint, test, smoke test, push image ขึ้น GHCR
├── tests/               ← pytest (API, migrations, ตัวอ่านใบเสร็จ)
└── app/
    ├── main.py          ← API (FastAPI)
    ├── receipts.py      ← อ่านใบเสร็จ: OCR (Tesseract ไทย+อังกฤษ) และหายอดรวม/วันที่/ร้าน
    ├── db.py            ← เชื่อมต่อ SQLite + หมวดเริ่มต้น
    ├── migrate.py       ← ตัวรัน migration
    ├── migrations/      ← schema ทีละเวอร์ชัน (0001_initial.sql, 0002_receipts.sql, ...)
    └── static/          ← หน้าเว็บ (HTML/CSS/JS, ฟอนต์และ Chart.js อยู่ในเครื่อง ใช้งานออฟไลน์ได้)
```

**ทำอะไรได้บ้าง**

- จดรายรับ/รายจ่าย เลือกหมวดหมู่ วันที่ หมายเหตุ — ช่องจำนวนเงินพิมพ์ `45+60` ได้
- หน้า **สมุดบัญชี** แสดงแบบสมุดบัญชีธนาคาร มียอดยกมาและยอดคงเหลือทุกบรรทัด คลิกแถวเพื่อแก้ไขหรือลบ
- ค้นหา / กรองตามประเภทและหมวดหมู่
- หน้า **สรุปเดือนนี้** กราฟรายจ่ายแยกหมวด และรายจ่ายรายวัน
- หน้า **ทั้งปี** กราฟรายรับ–รายจ่าย 12 เดือน และหมวดที่ใช้จ่ายมากที่สุด
- หน้า **สแกนใบเสร็จ** อัปโหลดรูป/PDF หลายใบพร้อมกัน ระบบอ่านยอดรวม วันที่ ร้าน และเดาหมวดหมู่ให้
  แล้วรวมยอดอัตโนมัติ ตรวจแก้ได้ก่อนกดบันทึกเป็นรายจ่ายทีเดียว รูปใบเสร็จแนบไว้กับรายการในสมุดบัญชี
- จัดการหมวดหมู่ (เพิ่ม/เปลี่ยนชื่อ/เปลี่ยนสี/ลบโดยย้ายรายการไปหมวดอื่น)
- ส่งออก/นำเข้า CSV (เปิดใน Excel ได้ ภาษาไทยไม่เพี้ยน รองรับวันที่ พ.ศ.)
- ดาวน์โหลด/กู้คืนไฟล์สำรอง (.zip รวมรูปใบเสร็จ)
- รองรับมือถือและโหมดมืด, ตั้งรหัสผ่านได้

## สิ่งที่ต้องมี

- Windows 10 หรือ 11 (มี winget — มาพร้อม Windows อยู่แล้ว)
- อินเทอร์เน็ตตอนเปิดครั้งแรก (ดาวน์โหลด Python และโปรแกรมอ่านใบเสร็จ)
- **ไม่ต้องมี Docker** และไม่ต้องเปิด Hyper-V / virtualization

## เริ่มใช้งาน

1. แตกไฟล์ zip ไว้ที่ไหนก็ได้ เช่น `C:\Apps\income-expense-app`
2. ดับเบิลคลิก **`start.bat`**
   - ครั้งแรกจะติดตั้งให้เองประมาณ 2–5 นาที: uv (ตัวจัดการ Python), Tesseract OCR,
     ภาษาไทยสำหรับอ่านใบเสร็จ (โฟลเดอร์ `tessdata\`) และ Python 3.13 แยกเฉพาะแอปนี้ (โฟลเดอร์ `.venv\`)
     ถ้า Windows ถามสิทธิ์ตอนติดตั้ง Tesseract ให้กด **Yes**
   - เสร็จแล้วเบราว์เซอร์จะเปิด `http://localhost:8080` ให้อัตโนมัติ
3. แอปรันในหน้าต่างย่อ "Income-Expense server" — ปิดแอปด้วย **`stop.bat`** หรือปิดหน้าต่างนั้น

รัน `start.bat` ซ้ำได้เสมอ: ถ้าแอปเปิดอยู่แล้วจะรีสตาร์ทให้เพื่อใช้ค่าใหม่ใน `.env`
อยากให้แอปเปิดเองตอนเข้า Windows: กด `Win+R` พิมพ์ `shell:startup` แล้ววาง shortcut ของ `start.bat` ไว้ในโฟลเดอร์นั้น

### ใช้กับ Docker แทน (ทางเลือก)

ถ้ามี [Docker Desktop](https://www.docker.com/products/docker-desktop/) ใช้ `docker-start.bat` / `docker-stop.bat` / `docker-logs.bat` แทน
หรือใช้คำสั่งเอง: `docker compose up -d --build` (เปิด), `docker compose down` (ปิด), `docker compose logs -f` (ดู log)
โหมด Docker เก็บข้อมูลแยกไว้ใน Docker volume `income-expense-data` ไม่ใช่โฟลเดอร์ `data\` —
ย้ายข้อมูลระหว่างสองแบบด้วยการสำรองเป็น .zip แล้วกู้คืนในอีกแบบ

## สแกนใบเสร็จ

เปิดจากเมนู **สแกนใบเสร็จ** (แถบเมนูด้านซ้ายบนคอม หรือแถบล่างบนมือถือ) หรือ `http://localhost:8080/receipts.html`

1. ลากไฟล์มาวาง กด **เลือกไฟล์** หรือกด `Ctrl+V` วางรูปที่คัดลอกไว้ — บนมือถือกดปุ่ม **กล้อง** ตรงกลางแถบล่างเพื่อถ่ายรูปใบเสร็จ
2. ระบบอ่านทีละใบ (ประมาณ 1–3 วินาทีต่อใบ) แล้วเติม **ยอดรวม วันที่ ชื่อร้าน หมวดหมู่** ให้
3. ตรวจแต่ละใบ แก้ได้ทุกช่อง ถ้ายอดผิดให้กดเลือกจาก **ยอดอื่นที่พบ** หรือพิมพ์เอง
   ใบที่ระบบไม่มั่นใจจะมีแถบสีเหลืองเตือน
4. ด้านขวาเป็น **ยอดรวมใบเสร็จ** บวกให้อัตโนมัติ พร้อมแยกตามหมวดหมู่ เอาเครื่องหมาย “รวมยอด” ออกถ้าไม่ต้องการนับใบนั้น
5. กด **บันทึก N ใบเป็นรายจ่าย** — ลงสมุดบัญชีตามวันที่บนใบเสร็จ รายการที่มาจากใบเสร็จจะมีไอคอนคลิปหนีบกระดาษ กดเพื่อดูรูป

ใบที่ยังไม่บันทึกจะค้างอยู่ในหน้านี้ ปิดเบราว์เซอร์แล้วกลับมาทำต่อได้

**เคล็ดลับให้อ่านแม่น:** ถ่ายตรง ๆ ให้ใบเสร็จเต็มเฟรม แสงพอ ไม่ยับ — PDF ใบเสร็จอิเล็กทรอนิกส์ (เช่น Shopee, Lazada, e-Tax) อ่านได้แม่นที่สุด
การอ่านทำในเครื่องของคุณทั้งหมดด้วย Tesseract OCR ไม่ส่งรูปออกอินเทอร์เน็ต

## ตั้งค่า (.env)

เปิดไฟล์ `.env` ด้วย Notepad แก้แล้วรัน `start.bat` ใหม่

| ค่า | ความหมาย |
|---|---|
| `APP_IMAGE=` | (เฉพาะโหมด Docker) ว่าง = build เอง; ใส่ `ghcr.io/<ชื่อ GitHub>/income-expense-app:latest` = ดาวน์โหลด image ที่ CI สร้างไว้ |
| `APP_PORT=8080` | พอร์ตที่ใช้เปิดในเบราว์เซอร์ ถ้า 8080 ถูกใช้อยู่ให้เปลี่ยนเป็น 8090 ฯลฯ |
| `BIND_ADDRESS=127.0.0.1` | ใช้ได้เฉพาะเครื่องนี้ เปลี่ยนเป็น `0.0.0.0` ถ้าอยากเปิดจากมือถือ |
| `APP_USER` / `APP_PASSWORD` | ใส่รหัสผ่านเพื่อล็อกแอป เบราว์เซอร์จะถามชื่อผู้ใช้/รหัสผ่าน |
| `ALLOWED_HOSTS` | ชื่อเครื่องเพิ่มเติมที่ใช้เปิดแอป เช่น `mypc.local` — localhost และเลข IP ใช้ได้เสมอ |

### เปิดจากมือถือ (Wi-Fi เดียวกัน)

1. ใน `.env` ตั้ง `BIND_ADDRESS=0.0.0.0` และ **ตั้ง `APP_PASSWORD`** ด้วย
2. รัน `start.bat` ใหม่ — หน้าต่างจะแสดงที่อยู่สำหรับเปิดจากมือถือ เช่น `http://192.168.1.25:8080`
3. เปิดที่อยู่นั้นในมือถือ แล้วใส่ชื่อผู้ใช้/รหัสผ่าน
4. ถ้าเข้าไม่ได้ ให้อนุญาต Python ใน Windows Firewall (Private network) และตั้ง Wi-Fi ของคอมเป็น Private

**เปิดจากมือถือนอกบ้าน (ฟรี):** ติดตั้ง [Tailscale](https://tailscale.com) ทั้งในคอมและมือถือ (ล็อกอินบัญชีเดียวกัน)
แล้วเปิด `http://<IP Tailscale ของคอม 100.x.x.x>:8080` ในมือถือ (คอมต้องเปิดและรันแอปอยู่)
อย่าเปิดพอร์ตบนเราเตอร์ให้ทั้งอินเทอร์เน็ตเข้าได้ — รหัสผ่านส่งแบบไม่เข้ารหัส (HTTP)

## ข้อมูลเก็บที่ไหน / สำรองข้อมูล

ข้อมูลอยู่ในโฟลเดอร์ **`data\`** ข้างไฟล์ `start.bat` (ไฟล์ `finance.db` และโฟลเดอร์ `receipts\`)
ปิดแอป อัปเดตแอป หรือรีสตาร์ทเครื่อง ข้อมูลไม่หาย (โหมด Docker เก็บใน volume `income-expense-data` แทน)

> ⚠️ อย่าลบโฟลเดอร์ `data\` (หรือใช้ `docker compose down -v` ในโหมด Docker) — ข้อมูลจะหายทั้งหมด

วิธีสำรอง เลือกได้ 3 แบบ:

- **ในแอป:** เมนู *นำเข้า / สำรองข้อมูล* (แถบด้านซ้าย หรือปุ่ม ⋯ มุมขวาบนบนมือถือ) → *ดาวน์โหลดไฟล์สำรอง* (.zip รวมรูปใบเสร็จ) หรือ *ดาวน์โหลด CSV ทั้งหมด*
- **backup.bat:** ดับเบิลคลิก ไฟล์จะไปอยู่ที่ `backups\finance-ปีเดือนวัน-เวลา.zip`
- **อัตโนมัติ:** ตั้ง Windows Task Scheduler ให้รัน `backup.bat /quiet` ทุกวัน

**กู้คืน:** ในแอป → *นำเข้า / สำรองข้อมูล* → *กู้คืนจากไฟล์สำรอง* แล้วเลือกไฟล์ .zip (หรือ .db จากเวอร์ชันแรก)
(ระบบจะเก็บสำเนาข้อมูลเดิมไว้ใน `data\` เป็นไฟล์ `before-restore-*.db` ก่อนแทนที่)

**ย้ายเครื่อง:** สำรองเป็น .zip จากเครื่องเก่า → ติดตั้งแอปที่เครื่องใหม่ → กู้คืนจากไฟล์นั้น

### รูปแบบไฟล์ CSV สำหรับนำเข้า

หัวตาราง (แถวแรก) ใช้ภาษาไทยหรืออังกฤษก็ได้:

```csv
วันที่,ประเภท,หมวดหมู่,จำนวนเงิน,หมายเหตุ
2026-11-01,รายรับ,เงินเดือน,28000,เงินเดือน
10/11/2569,รายจ่าย,อาหารและเครื่องดื่ม,"1,250.00",เลี้ยงข้าวทีม
```

- วันที่: `YYYY-MM-DD` หรือ `วัน/เดือน/ปี` (ปี พ.ศ. หรือ ค.ศ. ก็ได้)
- ประเภท: `รายรับ` / `รายจ่าย` (หรือ `income` / `expense`) — ถ้าเว้นว่าง ยอดติดลบ = รายจ่าย
- หมวดหมู่ที่ยังไม่มีจะถูกสร้างให้อัตโนมัติ
- รายการที่ซ้ำกับที่มีอยู่แล้วจะถูกข้าม นำเข้าไฟล์เดิมซ้ำได้ไม่เบิ้ล
- รองรับไฟล์ที่ Excel บันทึกเป็น UTF-8 หรือ ANSI (Windows-874)

## อัปเดตแอป

แทนที่ไฟล์ในโฟลเดอร์ (หรือ `git pull`) โดยไม่ต้องแตะ `.env` และ `data\` แล้วรัน `start.bat` —
ถ้า `requirements.txt` เปลี่ยน มันจะติดตั้งไลบรารีใหม่ให้เอง ข้อมูลยังอยู่
(โหมด Docker: รัน `docker-start.bat` — build หรือดาวน์โหลด image ใหม่ให้)

## สำหรับนักพัฒนา

### รันและทดสอบในเครื่อง (ไม่ผ่าน Docker)

```bash
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
# OCR: Ubuntu `sudo apt install tesseract-ocr tesseract-ocr-tha` | macOS `brew install tesseract tesseract-lang`
DATA_DIR=./data uvicorn app.main:app --reload       # http://localhost:8000
ruff check .                                        # lint
pytest                                              # 69 tests; ข้ามเทส OCR จริงถ้าไม่มี Tesseract
node --test tests/js/common.test.mjs                # เทส JavaScript ฝั่งหน้าเว็บ
```

### เปลี่ยน schema ฐานข้อมูล (migrations)

1. เพิ่มไฟล์ใหม่ใน `app/migrations/` เลขถัดไป เช่น `0003_add_accounts.sql`
2. ห้ามแก้ไฟล์ที่ปล่อยไปแล้ว และไม่ต้องใส่ `BEGIN`/`COMMIT` — ตัวรันครอบให้ทีละไฟล์ (สำเร็จทั้งไฟล์หรือไม่เปลี่ยนอะไรเลย)
3. เพิ่มเทสใน `tests/test_migrations.py` แล้วรัน `pytest`
4. แอปจะ migrate เองตอนเริ่ม ดูสถานะได้ด้วย `set DATA_DIR=data&& .venv\Scripts\python -m app.migrate status`
   (โหมด Docker: `docker compose exec app python -m app.migrate status`)

ฐานข้อมูลจากเวอร์ชัน 1.0/1.1 (ก่อนมีระบบ migration) จะถูกตรวจและบันทึกเป็นเวอร์ชันที่ตรงกันให้อัตโนมัติ
ไฟล์สำรองจากแอปเวอร์ชันใหม่กว่าจะกู้คืนไม่ได้ (กันข้อมูลเสีย) — อัปเดตแอปก่อน

### CI/CD (GitHub Actions)

push โค้ดขึ้น GitHub แล้ว workflow `.github/workflows/ci.yml` จะ:

1. **Lint and test** — ruff + pytest บน Python 3.13 พร้อม Tesseract ภาษาไทย และเทส JavaScript ด้วย `node --test`
2. **Smoke test** — build image จริงจาก Dockerfile, รัน container, เช็ก `/api/health`, OCR ใบเสร็จตัวอย่าง 2 ใบ, เช็กว่าเว็บอื่นสั่งแก้ข้อมูลไม่ได้, เช็กว่าไม่ได้รันเป็น root
3. **Publish** — build `linux/amd64` + `linux/arm64` แล้ว push ไป `ghcr.io/<owner>/income-expense-app`
   (pull request: build อย่างเดียว ไม่ push)

| เหตุการณ์ | tag ของ image |
|---|---|
| push เข้า `main` | `latest`, `sha-xxxxxxx` |
| push tag `v1.2.0` | `1.2.0`, `1.2`, `sha-xxxxxxx` |

ใช้ image สำเร็จรูปบน Windows (โหมด Docker): ตั้ง `APP_IMAGE=ghcr.io/<ชื่อ GitHub>/income-expense-app:latest` ใน `.env` แล้วรัน `docker-start.bat`
(จะ `docker compose pull` แทนการ build) — package บน GHCR เป็น private โดยค่าเริ่มต้น:
ตั้งเป็น public ในหน้า package บน GitHub หรือรัน `docker login ghcr.io` ครั้งเดียวด้วย Personal Access Token ที่มีสิทธิ์ `read:packages`

## ถอนการติดตั้ง

รัน `stop.bat` แล้วลบทั้งโฟลเดอร์ (โฟลเดอร์ `data\` คือข้อมูลของคุณ — สำรองก่อน!)
ถ้าไม่ใช้แล้ว ถอน Tesseract OCR และ uv ได้จาก *Settings → Apps*

โหมด Docker:

```powershell
docker compose down
docker image rm income-expense-app:latest
docker volume rm income-expense-data   # ลบข้อมูลถาวร — สำรองก่อน!
```

## แก้ปัญหา

| อาการ | วิธีแก้ |
|---|---|
| `winget is missing` | ติดตั้ง "App Installer" จาก Microsoft Store แล้วรัน `start.bat` ใหม่ |
| `The app did not start` / port ถูกใช้อยู่ | เปลี่ยน `APP_PORT` ใน `.env` แล้วรัน `start.bat` |
| เปิดหน้าเว็บไม่ขึ้น | รัน `logs.bat` ดูข้อความผิดพลาด |
| มือถือเข้าไม่ได้ | `BIND_ADDRESS=0.0.0.0` ใน `.env`, อนุญาต Python ใน Windows Firewall, Wi-Fi ของคอมเป็น Private |
| `Docker Desktop is not running` (docker-start.bat) | เปิด Docker Desktop รอ Engine running แล้วรันใหม่ |
| ลืมรหัสผ่าน | ดูหรือแก้ `APP_PASSWORD` ใน `.env` แล้วรัน `start.bat` |
| backup.bat บอกว่าไม่สำเร็จ | ต้องเปิดแอปอยู่ (รัน `start.bat` ก่อน) |
| หน้าสแกนบอกว่าไม่พบโปรแกรมอ่านตัวอักษร | รัน `setup.bat` ใหม่ (โหมด Docker: `docker-start.bat` ให้ build image ล่าสุด) |
| อ่านยอดผิดบ่อย | ถ่ายให้ชัดและตรงขึ้น หรือกดเลือกจาก “ยอดอื่นที่พบ” แล้วแก้ก่อนบันทึก |

## ความปลอดภัย

- แอปรับคำสั่งแก้ไขข้อมูลเฉพาะจากหน้าเว็บของตัวเอง: เว็บไซต์อื่นที่เปิดอยู่ในเบราว์เซอร์เดียวกันสั่งลบ/นำเข้า/กู้คืนข้อมูลไม่ได้
  (ตรวจ `Origin`, `Sec-Fetch-Site` และต้องมี header `X-Requested-With`)
- ตอบเฉพาะชื่อโฮสต์ที่อนุญาต (localhost, เลข IP, และ `ALLOWED_HOSTS`) เพื่อกันการโจมตีแบบ DNS rebinding
- จำกัดขนาดไฟล์อัปโหลดแบบไม่โหลดทั้งก้อนเข้าหน่วยความจำ และตรวจขนาดไฟล์ใน .zip ก่อนกู้คืน (กัน zip bomb)
- เรียก API เองด้วยสคริปต์: คำสั่งที่แก้ข้อมูล (POST/PUT/DELETE) ต้องใส่ `-H "X-Requested-With: fetch"`
  ส่วนปุ่ม "Try it out" ใน `/docs` ใช้ได้เฉพาะคำสั่งอ่านข้อมูล

## รายละเอียดทางเทคนิค

- Python 3.13 + FastAPI + Uvicorn, ฐานข้อมูล SQLite (เก็บเงินเป็นหน่วยสตางค์ ไม่มีปัญหาทศนิยมเพี้ยน)
- ใบเสร็จ: Tesseract OCR 5 (`tha+eng`), Pillow (+HEIC), pypdfium2 สำหรับ PDF — ทดสอบได้ด้วย `python tests/test_receipts.py`
- Container รันด้วย user ธรรมดา (ไม่ใช่ root) และมี healthcheck
- API: `GET /api/transactions`, `POST /api/transactions`, `GET /api/summary?month=YYYY-MM`,
  `GET /api/yearly?year=YYYY`, `POST /api/receipts`, `POST /api/receipts/commit`, `GET /api/backup.zip` ฯลฯ
  ดูทั้งหมดได้ที่ `http://localhost:8080/docs`
- ฟอนต์ IBM Plex Sans Thai / IBM Plex Mono (SIL OFL) และ Chart.js (MIT) รวมมาในแอปแล้ว
