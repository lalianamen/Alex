# Request Management

Web application for creating and fulfilling work requests with a role-based
access model. Built for an organization with several **sites** (addresses)
whose administrators raise requests to shared **service departments**
(e.g. Supply, Repair, Medication Supply).

## Roles

| Role | What they do |
|------|--------------|
| **System Administrator** | Manages user accounts, sites and departments; assigns roles; resets passwords. Sites and departments are deactivated (never deleted) so historical requests keep their references |
| **Owner** | Sees all requests; builds reports for a period, broken down by department and by site, with CSV export |
| **Site Administrator** | Works at one site (address); creates requests addressed to a service department of their choice; sees all requests from their site; can cancel a new request |
| **Work Supervisor** | Belongs to a department; sees requests addressed to it; accepts a request and assigns an executor, or rejects it with a reason; confirms completion and closes, or returns for rework |
| **Executor** | Belongs to a department; sees only the work assigned to them and marks it completed |

## Request lifecycle

```
New ──► In progress ──► Completed ──► Closed
 │           ▲              │
 │           └──────────────┘  (returned for rework)
 ├──► Rejected  (by a supervisor, with a reason)
 └──► Cancelled (by the site administrator)
```

A request carries the **site** it came from and the **department** it is
addressed to. Any supervisor of that department can accept it; the supervisor
who accepts it owns its later transitions.

## Deploying on Vercel

The app targets [Vercel](https://vercel.com) hosting with a PostgreSQL database
(the free [Neon](https://neon.tech) plan from the Vercel marketplace):

1. Deploy the project to Vercel (via the GitHub integration or `vercel deploy`).
2. In the project dashboard open **Storage → Create Database → Neon (Postgres)**
   and connect the database to the project.
3. Redeploy the project (**Deployments → Redeploy**) so the connection variable
   takes effect.

The app detects the Postgres connection string automatically regardless of the
environment-variable prefix chosen when connecting the database. Tables are
created — and existing databases are migrated in place — automatically on first
use. When the database is empty, a system administrator account is created:

- username: `admin`
- password: `admin123` — **change it right after the first sign-in**.

## Running locally

Requires Node.js 18+ and a connection string to any PostgreSQL database:

```bash
npm install
DATABASE_URL="postgres://user:password@host/dbname" npm start
```

The app is served at <http://localhost:3000> (the port is set by `PORT`).

## Demo data

```bash
DATABASE_URL="postgres://..." npm run seed:demo
```

Creates three sites, three departments (Supply, Repair, Medication Supply) and
these accounts (username / password):

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | System Administrator |
| `owner` | `owner123` | Owner |
| `main.admin`, `north.admin`, `west.admin` | `demo123` | Site Administrators |
| `supply.sup`, `repair.sup`, `meds.sup` | `demo123` | Work Supervisors |
| `supply.ex1`, `repair.ex1`, `meds.ex1`, … | `demo123` | Executors |

## Workflow

1. The system administrator creates sites and departments, then user accounts
   (site administrators are assigned a site; supervisors and executors a department).
2. A site administrator creates a request and addresses it to a department.
3. A supervisor of that department accepts the request and assigns an executor
   (or rejects it with a reason).
4. The executor performs the work and marks it completed.
5. The supervisor confirms completion and closes the request (or returns it for rework).
6. The owner reviews all requests and builds reports by department and by site.

## Technology

- **Backend**: Node.js, Express 5, PostgreSQL (`pg` driver)
- **Hosting**: Vercel (static assets + serverless function), database — Neon Postgres
- **Authentication**: sessions in the database, `httpOnly` cookie, scrypt password hashing
- **Frontend**: plain HTML/CSS/JavaScript, no frameworks (SPA)

## Project structure

```
api/index.js      — serverless function entry point for Vercel
src/server.js     — Express app and all API routes
src/db.js         — PostgreSQL connection, schema, in-place migrations
src/auth.js       — sessions and permission checks
src/passwords.js  — password hashing (scrypt)
public/           — index.html, app.js, styles.css (the single-page interface)
scripts/seed-demo.js — demo data
vercel.json       — routes /api/* to the serverless function
```
