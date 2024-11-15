# Backend-Service

#### This is an API that supports wxyc applications with features for dj, flowsheet, and library access/management.

## API reference

TODO. Add table outlining the behavior of each endpoint

## Contributing

Thank you for your interest in contributing to this project! In this section we give you all of the info you may need to get up and running.

#### Dependencies

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
- `npm run ci:test` : Spins up a sandboxed docker environment with a backend service and db and automatically runs the test suite against this environment. Can be run in independantly of `npm run dev` or `npm run db:start`.
- `npm run ci:clean` : Shuts down and cleans up any straggling containers, volumes, and networks.
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

### Cognito Auth Info for Starting Backend Service Auth
COGNITO_USERPOOL_ID={{placeholder}}
DJ_APP_CLIENT_ID={{placeholder}}

### Testing Env Variables
TEST_HOST=http://localhost
AUTH_BYPASS=true
AUTH_USERNAME='test_dj1'
AUTH_PASSWORD={{placeholder}}
```

<span style="color:crimson">\*</span>Email/slack dvd or Adrian Bruno (adrian@abruno.dev) to request access to prod placeholder values.

A couple env variables of note:

- DB_HOST: As is mentioned above this env variable should be set to the fully qualified domain name of the RDS database instance. The scripts `npm run db:start` and `npm run ci:test` overwrite this value to `localhost`.

- AUTH_BYPASS: This flag will cause the cognito auth middleware to use mocked user data and always pass to the next middleware logic. This is only meant to be set in local testing environments.

- AUTH_USERNAME:

  - When AUTH_BYPASS is active this env variable is added to the request context (res.locals) which may be used by further middleware.
  - When AUTH_BYPASS is inactive, this environment variable is used by the test suite to fetch an access token when integrating with cognito auth. So when running an integration test with cognito, ensure this is set to a valid account's username.

- AUTH_PASSWORD: This env variable is only used in the test suite when AUTH_BYPASS is inactive. Similarly to above it must be a valid account's password.

#### Git Workflow

1. Create a branch to implement your change.
2. After completing your change pull down any new changes into your local `main` branch.
3. Rebase with `git rebase -i develop` and feel free to squash or rephrase any commits you've made. Resolve any merge conflicts as well.
4. For initial push `git push -u origin {{branch}}` and for following pushes use `git push --force`
5. Create a pull request and assign AyBruno, JacksonMeade, dvdokkum, and jakebromberg as reviewers. Upon approval, merge and delete the remote branch on github.
6. We have a github actions workflow setup to deploy the current version of `main` to our EC2 instance. For now it must be triggered manually by going to the `Actions` tab, clicking `CI/CD Pipeline`, and click `Run Workflow`. Upon successful completion your changes will be deployed to prod.

Naming conventions:

- feature/{{minimal description}}
- feature/issue-{{issue number}}
- task/{{minimal description}}
- bugfix/{{minimal description}}
- bugfix/issue-{issue number} <br>
  <sub><span style="color:crimson">\*</span> Minimal description should be in `snake-case-like-this`. Keep it short!</sub>
