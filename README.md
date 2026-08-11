# Request Management

Web application for creating and fulfilling work requests with a role-based
access model: departments, work supervisors, executors, and reports for the owner.

## Features

| Role | What they do |
|------|--------------|
| **System Administrator** | Creates, edits, disables and restores user accounts, assigns roles and departments, resets passwords, maintains the list of departments |
| **Owner** | Sees all departments and all requests, builds reports for a period (breakdown by department, average completion time, CSV export) |
| **Department Administrator** | Creates requests for the work supervisors of their department, sees only their department's requests, can cancel a new request |
| **Work Supervisor** | Accepts a request and assigns an executor, can reject a request (with a reason), reassign the executor, return work for rework, confirm and close a completed request |
| **Executor** | Sees only the work assigned to them and marks it completed |

## Request lifecycle

```
New ──► In progress ──► Completed ──► Closed
 │           ▲              │
 │           └──────────────┘  (returned for rework)
 ├──► Rejected  (by the supervisor, with a reason)
 └──► Cancelled (by the department administrator)
```

## Deploying on Vercel

The app targets [Vercel](https://vercel.com) hosting with a PostgreSQL database
(the free [Neon](https://neon.tech) plan from the Vercel marketplace):

1. Deploy the project to Vercel (via the GitHub integration or `vercel deploy`).
2. In the project dashboard open **Storage → Create Database → Neon (Postgres)**
   and connect the database to the project. Vercel injects the connection string
   as an environment variable automatically.
3. Redeploy the project (**Deployments → Redeploy**) so the variable takes effect.

The app detects the Postgres connection string automatically regardless of the
environment-variable prefix chosen when connecting the database.

Tables are created automatically on first use. When the database is empty, a
system administrator account is created:

- username: `admin`
- password: `admin123` — **change it right after the first sign-in**.

## Running locally

Requires Node.js 18+ and a connection string to any PostgreSQL database
(the same free Neon database works fine):

```bash
npm install
DATABASE_URL="postgres://user:password@host/dbname" npm start
```

The app is served at <http://localhost:3000> (the port is set by `PORT`).

## Demo data

For a demonstration you can load sample departments, users and requests:

```bash
DATABASE_URL="postgres://..." npm run seed:demo
```

The following accounts are created (username / password):

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | System Administrator |
| `owner` | `owner123` | Owner |
| `it.admin` | `demo123` | IT Department Administrator |
| `it.manager` | `demo123` | Work Supervisor (IT Department) |
| `it.exec1`, `it.exec2` | `demo123` | Executors (IT Department) |
| `fac.admin` | `demo123` | Facilities Department Administrator |
| `fac.manager` | `demo123` | Work Supervisor (Facilities Department) |
| `fac.exec1` | `demo123` | Executor (Facilities Department) |

## Workflow

1. The system administrator creates departments and user accounts
   (each department administrator, supervisor and executor is assigned a department).
2. A department administrator creates a request and addresses it to a work supervisor.
3. The supervisor accepts the request and assigns an executor
   (or rejects it with a reason).
4. The executor performs the work and marks it completed.
5. The supervisor confirms completion and closes the request
   (or returns it for rework).
6. The owner reviews all requests and builds reports for a period.

## Technology

- **Backend**: Node.js, Express 5, PostgreSQL (`pg` driver)
- **Hosting**: Vercel (static assets + serverless function), database — Neon Postgres
- **Authentication**: sessions in the database, `httpOnly` cookie, scrypt password hashing
- **Frontend**: plain HTML/CSS/JavaScript, no frameworks (SPA)

## Project structure

```
api/
  index.js      — serverless function entry point for Vercel
src/
  server.js     — Express app and all API routes
  db.js         — PostgreSQL connection, schema, initialization
  auth.js       — sessions and permission checks
  passwords.js  — password hashing (scrypt)
public/
  index.html    — interface markup
  app.js        — client logic (role-based screens)
  styles.css    — styling
scripts/
  seed-demo.js  — demo data
vercel.json     — routes /api/* to the serverless function
```
