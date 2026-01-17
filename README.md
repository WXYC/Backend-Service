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

- `npm run dev` : Starts a local instance of the backend service on port `8080` by default using `nodemon` for hot reloading.
- `npm run build` : Runs `tsc` to compile our typscript code into javascript which node can actually run.
- `npm run start` : Starts the nodejs server that is compiled by the prior command.
- `npm run clean` : Removes the `dist` directory containing the artifacts of the build command.
- `npm run test` : Runs our Jest unit test suite against an instance of the backend service. This requires an environment variable `PORT` to be defined so that jest may find the backend service to run the tests against.
- `npm run db:start` : Starts and seeds a docker container running Postgresql on `localhost:5432` by default. It can be configured with the environment variable `DB_PORT`.
- `npm run db:stop` : Shuts down the aforementioned psql docker container and cleans up any volumes or networks.
- `npm run ci:env` : Spins up a sandboxed docker environment with a backend service and db.
  - Can be run in independantly of `npm run dev` or `npm run db:start`.
- `npm run ci:clean` : Shuts down and cleans up any straggling containers, volumes, and networks.
- `npm run ci:test` : Runs test suite against ci environment.
- `npm run ci:testmock` : Utilizes other ci scripts to mock steps our CI pipeline. (Set up env, run tests, and clean up with just one command)
  - Can be run in independantly of `npm run dev` or `npm run db:start`.
- `npm run drizzle:generate` : Generates SQL migration files reflecting changes to `src/db/schema.ts`. These files are generated inside of `src/db/migrations`.
- `npm run drizzle:migrate` : Applies the generated migrations to the database specified by the environment variables `DB_HOST`, `DB_NAME`, and `DB_PORT`. It also requires `DB_USERNAME` and `DB_PASSWORD`.
- `npm run drizzle:drop` : Deletes a given migration file from the migrations directory and removes it from the drizzle cache.

#### Environment Variables

Here is an example environment variable file. Create a file with these contents named `.env` in the root of your locally cloned project to ensure your dev environment works properly.

```
### Backend Service Port
PORT=8080
CI_PORT=8081

### DB Info
DB_HOST={{placeholder FQDN to RDS instance}}
DB_NAME=wxyc_db
DB_USERNAME={{placeholder}}
DB_PASSWORD={{placeholder}}
DB_PORT=5432
CI_DB_PORT=5433

### Better-Auth Configuration
# Base URL for the auth service (must end with /auth)
BETTER_AUTH_URL=http://localhost:8082/auth
# JWKS endpoint URL for JWT verification (should be ${BETTER_AUTH_URL}/jwks)
BETTER_AUTH_JWKS_URL=http://localhost:8082/auth/jwks
# JWT issuer claim (better-auth sets this to the base URL without /auth path)
BETTER_AUTH_ISSUER=http://localhost:8082
# JWT audience claim (better-auth sets this to the base URL without /auth path)
BETTER_AUTH_AUDIENCE=http://localhost:8082
# Trusted origins for CORS (comma-separated)
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000

### Password Reset Email (SES)
AWS_ACCESS_KEY_ID={{placeholder}}
AWS_SECRET_ACCESS_KEY={{placeholder}}
AWS_REGION=us-east-1
SES_FROM_EMAIL=no-reply@example.com
# Where users land after clicking the reset link
PASSWORD_RESET_REDIRECT_URL=http://localhost:3000/reset-password

### Testing Env Variables
TEST_HOST=http://localhost
AUTH_BYPASS=true  # Set to false to use real better-auth authentication in tests
AUTH_USERNAME='test_dj1'  # Username for test account (used when AUTH_BYPASS=false)
AUTH_PASSWORD={{placeholder}}  # Password for test account (used when AUTH_BYPASS=false)
# When AUTH_BYPASS=false, tests will authenticate with better-auth service
# Ensure BETTER_AUTH_URL points to accessible auth service (e.g., http://localhost:8082/auth)
```

<span style="color:crimson">\*</span>Email/slack dvd or Adrian Bruno (adrian@abruno.dev) to request access to prod placeholder values.

A couple env variables of note:

- DB_HOST: As is mentioned above this env variable should be set to the fully qualified domain name of the RDS database instance. The scripts `npm run db:start` and `npm run ci:test` overwrite this value to `localhost`.

- AUTH_BYPASS: This flag will cause the auth middleware to use mocked user data and always pass to the next middleware logic. This is only meant to be set in local testing environments. **For proper testing, set this to false to use real better-auth authentication.**

- AUTH_USERNAME:
  - When AUTH_BYPASS is active this env variable is added to the request context (res.locals) which may be used by further middleware.
  - When AUTH_BYPASS is inactive, this environment variable is used by the test suite to authenticate with better-auth service. Ensure this is set to a valid account's username that exists in the database.

- AUTH_PASSWORD: This env variable is only used in the test suite when AUTH_BYPASS is inactive. It must be a valid password for the test account specified in AUTH_USERNAME.

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
