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

## Repository

- `packages/cli` — the [@marina-cloud/cli](https://www.npmjs.com/package/@marina-cloud/cli) npm package
- `skills` — skills for coding agents

## License

Apache-2.0. See [LICENSE](LICENSE).
