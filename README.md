# Marina

Marina is a cloud built for the small apps that people and coding agents build every day. This repository
contains Marina's public developer tools and agent skills.

## CLI

Install [@marina-cloud/cli](https://www.npmjs.com/package/@marina-cloud/cli) and sign in through your browser:

```sh
npm install -g @marina-cloud/cli
marina setup
```

Or set up the CLI, install the deployment skill, and deploy Hello Marina in one command:

```sh
npm install -g @marina-cloud/cli && marina setup --skills --deploy-demo --json
```

Install Marina's deployment skill only when you want it:

```sh
marina skills install
```

Deploy the current directory:

```sh
marina deploy
```

Coding agents can request stable, machine-readable output from every command:

```sh
marina deploy --json
```

To deploy the bundled Hello Marina collage app, run:

```sh
marina deploy demo --json
```

Set an app's portable identity in `marina.json`:

```json
{
  "schema": 1,
  "name": "Hello Marina",
  "icon": "⛵",
  "type": "static"
}
```

Dynamic apps can opt into managed secrets and outbound HTTPS in the same
manifest:

```json
{
  "schema": 1,
  "entrypoint": "src/worker.ts",
  "runtime": { "secrets": ["API_KEY"] },
  "egress": { "hosts": ["api.example.com"] }
}
```

Set a value with `marina secrets set API_KEY --app my-app`, read it in app code
with `await marina.secrets.get("API_KEY")`, and call allowed hosts with the
standard Web `fetch()` API. Egress is denied when `egress.hosts` is empty or
omitted; `["*"]` allows public HTTPS while private networks and Marina endpoints
remain blocked. Marina records destination hostnames and outcomes in runtime
logs without request content or secret values. See the
[CLI documentation](packages/cli/README.md#use-managed-secrets-and-outbound-https).

## Repository

- `packages/cli` — the [@marina-cloud/cli](https://www.npmjs.com/package/@marina-cloud/cli) npm package
- `skills` — skills for coding agents

## License

Apache-2.0. See [LICENSE](LICENSE).
