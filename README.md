# Backend-Service

#### This is an API that supports wxyc applications with features for dj, flowsheet, and library access/management.

## API reference

TODO. Add table outlining the behavior of each endpoint

## Contributing

Thank you for your interest in contributing to this project! In this section we give you all of the info you may need to get up and running.

### Dependencies

**Development Platform:** If you are using Windows, please consider WSL to run `node/npm` scripts for compatibility

Before you can start interacting with this codebase you will need to install the following dependencies.

- `node & npm`:
  This application is based on the Node.js Javascript runtime so in order to get things running locally it will need to be installed.

  Please navigate to the [Node.js installation documentation](https://nodejs.org/en/download/package-manager) and use your preferred method to install the current LTS version of the runtime (e.g. nvm, brew, chocolatey, graphical installer, etc). The linked page will walk you through it step-by-step.

- `docker`: Docker is used extensively from the local and ci tests to our full on deployments.
  - macOS / Windows: Docker doesn't run natively on either of these operating systems and requires the `Docker Desktop` application to be installed in order to run properly (under the hood this application spins up a linux vm to actually run docker within). Docker Desktop can be installed here.
    - [macOS installation instructions](https://docs.docker.com/desktop/setup/install/mac-install/)
    - [Windows installation instructions](https://docs.docker.com/desktop/setup/install/windows-install/)
  - Linux: On linux you may directly install the docker engine. Please visit the [linux installation instructions](https://docs.docker.com/engine/install/) and follow the instructions for your distro. You may also install docker desktop if you prefer to have a GUI as well

#### Getting Started

- Clone this repo locally:

```bash
$ git clone git@github.com:WXYC/Backend-Service.git
```

- Navigate to the cloned repo and install npm dependencies (this may take a while):

```bash
$ cd Backend-Service && npm install # adjust this to represent whatever directory you've cloned the repo into
```

- Install PostgreSQL such that you have access to the `psql` shell command.

  - MacOS:

  ```
  brew install postgresql
  ```

  - Linux/WSL (debian based) Instructions:

  ```
  sudo apt update && sudo apt install postgresql
  ```

  [Graphical installer instructions](https://www.postgresql.org/download/) if you prefer that.

You now have everything you need installed to get started!

#### Project scripts

The dev experience makes extensive use of Node.js project scripts. Here's a rundown:

**Development Commands:**
- `npm run dev` : Starts the full development stack with Docker, Traefik, database, auth service, and backend service.
  - **Auth Service**: `http://localhost/api/auth/*`
  - **Backend API**: `http://localhost/api/*` (auto-strips `/api` prefix)
  - **Traefik Dashboard**: `http://localhost:8080`
- `npm run dev:local` : Starts auth and backend services locally (without Docker) for faster iteration during development.
  - Auth on port `8082`, Backend on port `8080`
- `npm run dev:down` : Stops all development containers.
- `npm run dev:clean` : Stops all development containers and removes volumes/networks.
- `npm run logs` : View logs from all services.
- `npm run logs:auth` : View logs from auth service only.
- `npm run logs:backend` : View logs from backend service only.

**Build & Start Commands:**
- `npm run build` : Runs build script for all workspace packages.
- `npm run build:auth` : Builds the auth service.
- `npm run build:backend` : Builds the backend service.
- `npm run start:auth` : Starts the auth service (after building).
- `npm run start:backend` : Starts the backend service (after building).
- `npm run clean` : Removes build artifacts from all workspaces.

**Testing Commands:**
- `npm run test` : Runs Jest unit test suite for all workspaces.
- `npm run ci:env` : Spins up isolated CI environment with backend service and database.
- `npm run ci:test` : Runs test suite against CI environment.
- `npm run ci:clean` : Shuts down CI environment and cleans up containers/volumes.
- `npm run ci:full` : Complete CI flow: setup, test, cleanup (one command).

**Database Commands:**
- `npm run drizzle:generate` : Generates SQL migration files from schema changes in `packages/database/schema.ts`.
- `npm run drizzle:migrate` : Applies pending migrations to the database.
- `npm run drizzle:drop` : Removes a migration file from the migrations directory.

**Database Initialization Flow:**
The database is automatically initialized when you run `npm run dev`:
1. PostgreSQL starts and installs extensions (`pg_trgm`)
2. `db-init` service runs Drizzle migrations (creates schema & tables)
3. `db-init` checks if data exists; if not, runs seed SQL
4. Auth and Backend services start only after initialization completes

This ensures your database is always properly set up with the latest schema and test data (on first run only).

#### Environment Variables

Here is an example environment variable file. Create a file with these contents named `.env` in the root of your locally cloned project to ensure your dev environment works properly.

```bash
### Service Ports
PORT=8080
CI_PORT=8081

### Database Configuration
DB_HOST=localhost
DB_NAME=wxyc_db
DB_USERNAME={{placeholder}}
DB_PASSWORD={{placeholder}}
DB_PORT=5432
CI_DB_PORT=5433

### Auth Service Configuration
BETTER_AUTH_URL=http://localhost/api/auth
FRONTEND_SOURCE=http://localhost:3000  # Your frontend URL (used for CORS)
AUTH_ADMIN_USERNAME={{placeholder}}
AUTH_ADMIN_PASSWORD={{placeholder}}

### Testing Environment Variables
TEST_HOST=http://localhost
AUTH_BYPASS=true
AUTH_USERNAME='test_dj1'
```

<span style="color:crimson">\*</span>Email/slack dvd or Adrian Bruno (adrian@abruno.dev) to request access to prod placeholder values.

**Key Environment Variables:**

- `DB_HOST`: Set to `localhost` for local development. In production, use the FQDN of the RDS instance.

- `BETTER_AUTH_URL`: The publicly accessible URL for the auth service. In Docker dev mode with Traefik, this is `http://localhost/api/auth`.

- `FRONTEND_SOURCE`: The URL of your frontend application. Used for CORS configuration. Default: `http://localhost:3000`.

- `AUTH_BYPASS`: When `true`, bypasses actual authentication and uses mock user data. Only use in local testing environments.

- `AUTH_USERNAME`: When `AUTH_BYPASS` is active, this username is added to the request context for testing purposes.

**Important:** The `FRONTEND_SOURCE` environment variable is critical for CORS. Traefik uses this to allow requests from your frontend. If your frontend runs on a different port or domain, update this value accordingly.

#### Frontend Configuration

When developing your frontend, use these URLs to connect to the backend:

**With Docker (recommended):**
```javascript
AUTH_URL=http://localhost/api/auth
API_URL=http://localhost/api
```

**With Local Development (faster iteration):**
```javascript
AUTH_URL=http://localhost:8082/api/auth
API_URL=http://localhost:8080
```

#### Git Workflow

1. Create a branch to implement your change.
2. After completing your change pull down any new changes into your local `main` branch.
3. Rebase with `git rebase -i develop` and feel free to squash or rephrase any commits you've made. Resolve any merge conflicts as well.
4. For initial push `git push -u origin {{branch}}` and for following pushes use `git push` (`git push --force` when squashing local commits)
5. Create a pull request and assign AyBruno, JacksonMeade, dvdokkum, and jakebromberg as reviewers. Upon approval, merge and delete the remote branch on github.
6. We have a github actions workflow setup to deploy the current version of `main` to our EC2 instance. For now it must be triggered manually by going to the `Actions` tab, clicking `CI/CD Pipeline`, and click `Run Workflow`. Upon successful completion your changes will be deployed to prod.

Naming conventions:

- feature/{{minimal description}}
- feature/issue-{{issue number}}
- task/{{minimal description}}
- bugfix/{{minimal description}}
- bugfix/issue-{issue number} <br>
  <sub><span style="color:crimson">\*</span> Minimal description should be in `snake-case-like-this`. Keep it short!</sub>
