# LogLens (LabTrace) — Full Stack

**CYBERHACK — BUILD. BREAK. DEFEND.**

Evidence-first access alerts for shared labs.  
*Explain every alert. Blame no one. Block nothing.*

---

## Quick Start (localhost)

```bash
cd loglens
npm install
npm start
```

Open **http://localhost:3000**

### Login

| Username | Password        | Role      |
|----------|-----------------|-----------|
| `admin`  | `LabTrace@2025` | supervisor |
| `analyst`| `Analyst@2025`  | analyst   |

---

## What you get

- **Login page** — session auth, bcrypt passwords, rate-limited
- **Dashboard** — metrics, incident queue, evidence panel, human check actions
- **Rule engine** — R1 (failure burst → success), R2 (after-hours)
- **Live controls** — N, W, lab hours + Replay
- **Demo data** — one-click synthetic CSV (30 events, 5 cases)
- **CSV upload** — parse, store, detect
- **SQLite database** — users, events, cases, audit log, settings
- **Security** — Helmet, httpOnly session cookie, rate limits, parameterized SQL, audit trail

---

## Project structure

```
loglens/
├── server.js          # Express app + API
├── db.js              # SQLite schema + seed users
├── engine.js          # R1 / R2 detection
├── package.json
├── data/
│   ├── sample_lab_logs.csv
│   └── loglens.db     # created on first run
├── public/
│   ├── login.html
│   ├── dashboard.html
│   ├── css/app.css
│   └── js/dashboard.js
└── README.md
```

---

## API (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login` | Login |
| POST | `/api/logout` | Logout |
| GET  | `/api/me` | Current user |
| GET  | `/api/dashboard` | Metrics + cases |
| GET  | `/api/cases/:id` | Case detail + events |
| POST | `/api/cases/:id/review` | Confirm / dismiss |
| POST | `/api/upload` | CSV multipart upload |
| POST | `/api/demo` | Load built-in demo |
| POST | `/api/replay` | Re-run detection with new N/W/hours |
| GET  | `/api/settings` | Lab settings |
| PUT  | `/api/settings` | Update settings |

---

## Security notes

- Passwords hashed with **bcrypt** (cost 12)
- **express-session** with httpOnly, sameSite cookie
- **Helmet** security headers + CSP
- Login **rate limit** (20 / 15 min)
- API rate limit
- SQLite with parameterized queries
- Audit log for login, upload, review, settings
- No external services — fully offline capable after `npm install`

---

## Demo expected results (defaults N=3, W=5, 08:30–17:30)

| Case | Label | Why |
|------|-------|-----|
| x.user · PC-01 | **PRIORITY** | 4 failures → success at ~02:15 + after hours |
| guest_lab · PC-PRG-07 | **REVIEW** | 3 failures → success within window |
| a.raj | ROUTINE | Only 2 failures |
| v.hari | ROUTINE | Failures spread over hours |
| r.devi | ROUTINE | Single failure then success |

---

**LogLens** — Evidence-first. Human in control.
