# HRGenius — HR Management System

HRGenius is a multi-workspace HRMS web app with a Node.js server and SQLite storage. Each company has private HR data and its own user accounts.

## Run locally

Requires Node.js 24 (Node 22.13 or newer also works).

1. Open this project folder in VS Code.
2. Open **Terminal → New Terminal**.
3. Start the app:

   ```powershell
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000).
5. Choose **Create a workspace** to register the first owner account. The first workspace starts empty; add your real team records in the Employee directory.

Keep the terminal open while using HRGenius. Press **Ctrl+C** to stop the server. There are no package-install or Python steps.

## Invite your colleagues

1. Sign in as the workspace owner or an admin.
2. Open **Team access → Invite teammate**.
3. Enter the colleague’s email and choose **Admin** or **HR Manager**.
4. Copy the one-time invite link and send it to them yourself. The link expires after seven days.
5. They open the link, choose a password, and join your company workspace.

All workspace data is scoped to the company account. New public signups create separate workspaces and cannot read another company’s records. Admins and HR managers have access to employee, compensation, payroll, recruiting, performance, leave and onboarding data. Only owners/admins can invite admins or remove team access.

## Included HRMS features

- Sign-up, login, logout and persistent server-side sessions.
- Company workspaces with isolated data and invite links.
- Employee directory with search, filtering, add, edit, status changes, deletion and CSV export.
- Recruitment pipeline with candidate tracking and stage progression.
- Payroll estimates and reviewable draft pay runs.
- Performance reviews and team goals.
- Leave requests with approval and decline actions.
- Onboarding checklists that can add a new starter to the employee directory when complete.
- People analytics and CSV exports.
- Settings tabs for workspace preferences, company details, notification choices and password security. Currency and date format preferences apply across the interface.
- Integrations exports for employee and payroll CSVs, an approved leave calendar (ICS), and a workspace JSON backup.
- Responsive desktop, tablet and mobile layouts.

## Deploy with Docker

For a quick local Docker run, copy `.env.example` to `.env`, then run:

```powershell
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The named Docker volume `hrgenius-data` keeps the database when the container is recreated.

For a public deployment, run the Docker image behind a reverse proxy or hosting platform that provides HTTPS. Set these environment variables in the host:

- `NODE_ENV=production` — enables secure session cookies and HSTS.
- `APP_URL=https://your-domain.example` — used to generate correct invite links.
- `DATABASE_PATH=/app/storage/hrgenius.sqlite` — point this at a persistent disk/volume.
- `HOST=0.0.0.0` and `PORT` — bind to the container interface and the port supplied by the host.
- `TRUST_PROXY=1` only when the app is reachable exclusively through a trusted proxy that sets `X-Forwarded-For`.

### Deploy on Render

The included `render.yaml` configures a single Docker web service, HTTPS-only production cookies, an HTTP health check and a 1 GB persistent disk for SQLite. Push this project to a GitHub repository, create a Render Blueprint from that repository, and apply the blueprint. This uses a paid Render web-service plan because persistent disks are not available on its free web-service plan. Keep the service at one instance while it uses SQLite; the persistent disk is attached to that one instance. Export workspace data regularly from **Settings → Integrations** and retain backups separately. For multiple application instances, move the database to managed PostgreSQL before scaling.

Keep the SQLite file on persistent storage, take regular backups, and run one app instance. SQLite is suitable for a small team on a single server; use PostgreSQL and a production identity/email service before scaling to multiple app instances or relying on automated password recovery and email verification.

## Data and security

- Database: `data/hrgenius.sqlite` during local `npm start`; use the configured persistent path in Docker/hosting.
- Passwords are stored as salted scrypt hashes. Sessions use HTTP-only, same-site cookies and CSRF protection for changes.
- API requests require a signed-in workspace member. Company IDs scope every HR record.
- New workspace data starts empty. `data/seed.json` is retained for the legacy demo workspace only.
- Invitation links are single-use bearer links. Share them privately. The app does not send email yet; administrators copy and send links through their own channel.
- Payroll is an estimate and approval tracker, not a payment processor or tax engine.
- There is no email verification, password reset, multi-factor authentication or fine-grained employee self-service access yet. Use a unique password and deploy only behind HTTPS.

## Reset local data

Stop the app, then back up or remove `data/hrgenius.sqlite` and its `-shm` / `-wal` sidecar files. Restart with `npm start` to create a fresh database. This deletes local workspaces, accounts and HR data.

## Project files

- `index.html`, `styles.css`, `auth.css`, `settings.css`, `app.js` — browser interface.
- `server.js` — authentication, workspace API, session security and SQLite storage.
- `data/seed.json` — legacy demo data.
- `Dockerfile`, `docker-compose.yml`, `.env.example`, `render.yaml` — container and Render deployment setup.
