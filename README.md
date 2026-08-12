# Request Management

Web application for creating and fulfilling work requests, organized as
**Company → Division → Position → Employee** with per-position permissions.

## Model

- **Company** — top level. You can have several. Deactivated or (when unused) deleted.
- **Division** — belongs to a company (e.g. a location or a service unit like Supply).
  Deactivated, never deleted, so request history is preserved.
- **Position** — the admin-created *role*: it belongs to a division and carries a set
  of permission checkboxes. Permanent (deactivated, never deleted); the person
  filling it changes over time.
- **Employee** — one account, attached to one position. All of an employee's abilities
  come from that position's permissions.

Besides employees there are two special account roles: **System Administrator**
(manages companies, divisions, positions and employees) and **Owner** (sees every
request and builds reports across all companies).

## Position permissions

| Permission | What it allows |
|------------|----------------|
| Create requests | Raise a new request addressed to a division |
| View all division requests | See every request from the employee's division (not only their own) |
| Cancel requests | Cancel a new request from their division |
| View division reports | See reports scoped to their division |
| Accept & assign requests | Accept requests sent to their division, assign a performer, reject, close, reopen |
| Perform assigned work | Be assigned as the performer and mark work completed |

## Request flow

A request is created by an employee (with *Create*) and **sent to a target
division**. In that division, an employee with *Accept & assign* accepts it and
assigns it to an employee with *Perform assigned work*; the performer marks it
completed; the accepter confirms and closes it (or returns it for rework).

```
New ──► In progress ──► Completed ──► Closed
 │           ▲              │
 │           └──────────────┘  (returned for rework)
 ├──► Rejected  (by the accepter, with a reason)
 └──► Cancelled (by the sender)
```

Each request stores the sending division, the target division, the creator's
position and a snapshot of the creator's name, so history and reports survive
even if the employee is later deleted.

## Setup order

1. **Companies** — add your company (or companies).
2. **Divisions** — add divisions under a company.
3. **Positions** — create positions on each division and tick their permissions.
4. **Employees** — create people and attach each to a position.

## Deploying on Vercel

Hosted on [Vercel](https://vercel.com) with a PostgreSQL database (the free
[Neon](https://neon.tech) plan from the Vercel marketplace):

1. Deploy the project (GitHub integration or `vercel deploy`).
2. **Storage → Create Database → Neon**, connect it to the project.
3. **Deployments → Redeploy** so the connection variable takes effect.

The connection string is detected automatically regardless of its variable
prefix. Tables are created — and existing databases migrated in place —
automatically on first use. An empty database creates a system administrator:

- username: `admin`
- password: `admin123` — **change it right after the first sign-in**.

## Running locally

```bash
npm install
DATABASE_URL="postgres://user:password@host/dbname" npm start
```

Served at <http://localhost:3000> (port set by `PORT`).

## Demo data

```bash
DATABASE_URL="postgres://..." npm run seed:demo
```

Creates a company, five divisions, positions with different permissions and
these accounts (username / password): `admin`/`admin123`, `owner`/`owner123`,
and several `demo123` employees (site managers, an intake clerk, division leads
and workers).

## Passwords

Creating an employee without a password (or resetting one to blank) puts the
account into a "set password at first sign-in" state: the person signs in with
their username alone and is prompted to choose a password.

## Technology

- **Backend**: Node.js, Express 5, PostgreSQL (`pg`)
- **Hosting**: Vercel (static + serverless function), Neon Postgres
- **Auth**: DB sessions, `httpOnly` cookie, scrypt password hashing
- **Frontend**: plain HTML/CSS/JS (single-page app)

## Project structure

```
api/index.js      — serverless entry point for Vercel
src/server.js     — Express app and all API routes
src/db.js         — PostgreSQL connection, schema, in-place migrations
src/auth.js       — sessions and the signed-in user's permissions
src/passwords.js  — scrypt password hashing
public/           — index.html, app.js, styles.css
scripts/seed-demo.js — demo data
vercel.json       — routes /api/* to the serverless function
```
